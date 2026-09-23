import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, realpathSync, rmSync } from "node:fs";
import { delimiter } from "node:path";
import { setHerdrCommandRunner } from "../../src/mux/herdr.ts";
import { resolveWindowsPosixInterpreter } from "../../src/mux/staged-shell.ts";
import { launchBackgroundSubagent } from "../../src/launch/background.ts";
import { launchInteractiveSubagent } from "../../src/launch/interactive.ts";
import {
	ASSISTANT_MSG,
	assert,
	createSessionFile,
	createTestDir,
	afterEach,
	describe,
	enforceAgentFrontmatterForTest,
	existsSync,
	it,
	join,
	loadAgentDefaults,
	MODEL_CHANGE,
	mkdirSync,
	readFileSync,
	readSubagentLaunchMetadataForTest,
	SESSION_HEADER,
	sleep,
	USER_MSG,
	writeExecutable,
	writeFileSync,
} from "../support/index.ts";

// Every test in this file installs the fake runner; none of them wants the real
// binary left in place for whatever runs next.
afterEach(() => setHerdrCommandRunner(null));

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The staged script is POSIX, and so are the fake binaries it runs. Windows has no
// /bin/sh, so use the same interpreter production resolves for a PowerShell pane.
function posixShellPath(): string {
	if (process.platform !== "win32") return "/bin/sh";
	const bash = resolveWindowsPosixInterpreter();
	if (!bash) throw new Error("No POSIX interpreter found; set PI_SUBAGENT_WIN_BASH to run this test");
	return bash;
}

function clearMuxRuntimeEnv(): void {
	delete process.env.CMUX_SOCKET_PATH;
	delete process.env.CMUX_SURFACE_ID;
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
	delete process.env.WEZTERM_PANE;
	delete process.env.WEZTERM_UNIX_SOCKET;
	delete process.env.ZELLIJ;
	delete process.env.ZELLIJ_SESSION_NAME;
	delete process.env.HERDR_PANE_ID;
	delete process.env.HERDR_TAB_ID;
	delete process.env.HERDR_WORKSPACE_ID;
	delete process.env.PI_SUBAGENT_MUX;
	delete process.env.PI_SUBAGENT_HERDR_PLACEMENT;
	delete process.env.PI_SUBAGENT_HERDR_MIN_COLUMNS;
	delete process.env.PI_SUBAGENT_HERDR_MIN_ROWS;
	delete process.env.PI_SUBAGENT_PI_COMMAND;
	delete process.env.PI_SUBAGENT_NAME;
	delete process.env.PI_SUBAGENT_SESSION;
	delete process.env.PI_SUBAGENT_SURFACE;
}

// Canned herdr CLI responses, keyed by the leading argument words. Previously this
// was a #!/bin/sh script dropped on PATH, which cannot run on Windows: CreateProcess
// executes only .exe/.com and Node refuses .cmd/.bat without a shell, so spawnSync
// failed with ENOENT and every test here died at mux detection. The runner seam
// replaces the binary directly instead, so the same fake works on every platform.
const FAKE_HERDR_RESPONSES: { match: string[]; stdout?: string }[] = [
	{
		match: ["status", "server", "--json"],
		stdout: '{"status":"running","running":true,"compatible":true,"protocol":17,"version":"0.7.5"}',
	},
	{
		match: ["pane", "current", "--current"],
		stdout:
			'{"id":"cli:pane:current","result":{"type":"pane_current","pane":{"pane_id":"w1:p1","tab_id":"w1:t1","workspace_id":"w1","cwd":"/parent","foreground_cwd":"/parent","focused":true}}}',
	},
	{
		match: ["pane", "layout"],
		stdout:
			'{"id":"cli:pane:layout","result":{"type":"pane_layout","layout":{"area":{"height":52,"width":120,"x":0,"y":0},"focused_pane_id":"w1:p1","panes":[{"focused":true,"pane_id":"w1:p1","rect":{"height":52,"width":120,"x":0,"y":0}}],"splits":[],"tab_id":"w1:t1","workspace_id":"w1","zoomed":false}}}',
	},
	{
		match: ["pane", "split"],
		stdout:
			'{"id":"cli:pane:split","result":{"type":"pane_split","pane":{"pane_id":"w1:p2","tab_id":"w1:t1","workspace_id":"w1","cwd":"/child","focused":false}}}',
	},
	{ match: ["pane", "rename"], stdout: '{"id":"cli:pane:rename","result":{"type":"pane_renamed"}}' },
	{ match: ["pane", "close"], stdout: '{"id":"cli:pane:close","result":{"type":"pane_closed"}}' },
	{
		match: ["tab", "create"],
		stdout:
			'{"id":"cli:tab:create","result":{"type":"tab_created","tab":{"tab_id":"w1:t2","workspace_id":"w1","label":"Child","focused":false,"pane_count":1},"root_pane":{"pane_id":"w1:p2","tab_id":"w1:t2","workspace_id":"w1","cwd":"/child","focused":false}}}',
	},
	{
		match: ["tab", "list"],
		stdout:
			'{"id":"cli:tab:list","result":{"type":"tab_list","tabs":[{"tab_id":"w1:t1","workspace_id":"w1","label":"Parent","focused":true,"pane_count":1},{"tab_id":"w1:t2","workspace_id":"w1","label":"Child","focused":false,"pane_count":1}]}}',
	},
	{ match: ["tab", "rename"], stdout: '{"id":"cli:tab:rename","result":{"type":"tab_renamed"}}' },
	{ match: ["tab", "close"], stdout: '{"id":"cli:tab:close","result":{"type":"tab_closed"}}' },
	{ match: ["pane", "run"] },
	{ match: ["pane", "send-text"] },
	{ match: ["pane", "send-keys"] },
];

const UNKNOWN_FAKE_HERDR_COMMAND = '{"error":{"code":"unknown_command","message":"unsupported fake herdr command"}}';

function fakeHerdrResponse(args: string[]): { stdout: string; status: number } {
	for (const candidate of FAKE_HERDR_RESPONSES) {
		if (candidate.match.every((word, index) => args[index] === word)) {
			return { stdout: candidate.stdout ? `${candidate.stdout}\n` : "", status: 0 };
		}
	}
	return { stdout: `${UNKNOWN_FAKE_HERDR_COMMAND}\n`, status: 1 };
}

// The log keeps the old shape - one space-joined argv line per invocation - so the
// existing assertions against it are unchanged.
function installFakeHerdr(logFile: string): void {
	writeFileSync(logFile, "");
	const record = (args: string[]) => appendFileSync(logFile, `${args.join(" ")}\n`);
	setHerdrCommandRunner({
		runSync: (args) => {
			record(args);
			const { stdout, status } = fakeHerdrResponse(args);
			return { status, stdout, stderr: "", pid: 0, output: [null, stdout, ""], signal: null } as ReturnType<typeof spawnSync>;
		},
		runAsync: async (args) => {
			record(args);
			const { stdout, status } = fakeHerdrResponse(args);
			if (status !== 0) {
				const error = new Error(`fake herdr exited with ${status}`) as Error & { code?: number; stdout?: string; stderr?: string };
				error.code = status;
				error.stdout = stdout;
				error.stderr = "";
				throw error;
			}
			return { stdout };
		},
	});
}

function useFakeHerdr(): { dir: string; logFile: string } {
	const dir = createTestDir();
	const logFile = join(dir, "herdr.log");
	installFakeHerdr(logFile);
	clearMuxRuntimeEnv();
	process.env.PATH = dir;
	return { dir, logFile };
}

function writeParentSession(dir: string): string {
	return createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
}

async function readEventually(
	path: string,
	isReady: (text: string) => boolean = (text) => text.trim().length > 0,
): Promise<string> {
	let lastText = "";
	for (let attempt = 0; attempt < 50; attempt++) {
		if (existsSync(path)) {
			lastText = readFileSync(path, "utf8");
			if (isReady(lastText)) return lastText;
		}
		await sleep(10);
	}
	throw new Error(`Timed out waiting for ${path}; last content: ${lastText}`);
}

function extractCapsulePath(commandText: string): string {
	const match = commandText.match(/run-child\.mjs' '([^']+)'/);
	if (!match?.[1]) throw new Error("Expected Herdr launch command to invoke the capsule launcher");
	return match[1];
}

function readLaunchCapsule(launchScript: string): {
	args: string[];
	overrides: Record<string, string>;
	parentEnv: Record<string, string>;
	cwd?: string;
} {
	return JSON.parse(readFileSync(extractCapsulePath(launchScript), "utf8"));
}

// The staged line differs per pane shell: POSIX types the script path directly,
// while a PowerShell pane gets `& '<bash>' '<script>'`. Both quote the staged
// script, and only the script ends in .sh, so match on that rather than on
// position.
function extractHerdrRunScriptPath(log: string): string {
	const match = log.match(/pane run w1:p2 .*?'([^']+\.sh)'/);
	if (!match?.[1]) throw new Error("Expected Herdr launch command to run a staged shell script");
	return match[1];
}

function readHerdrRunScript(log: string): string {
	return readFileSync(extractHerdrRunScriptPath(log), "utf8");
}

describe("Herdr interactive launch parity", () => {
	it("records child exit status through a direct sentinel before staged Herdr scripts exit", async () => {
		const originalPath = process.env.PATH;
		const { dir, logFile } = useFakeHerdr();
		const originalPiCommand = process.env.PI_SUBAGENT_PI_COMMAND;
		const originalShell = process.env.SHELL;
		process.env.PATH = `${dir}${delimiter}${originalPath ?? ""}`;
		process.env.SHELL = "/bin/sh";
		try {
			const cwd = createTestDir();
			process.env.PI_ARTIFACT_PROJECT_ROOT = join(cwd, "artifacts");
			mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
			writeFileSync(
				join(cwd, ".pi", "agents", "sentinel-child.md"),
				["---", "name: sentinel-child", "auto-exit: true", "---", "Exit immediately for sentinel verification."].join(
					"\n",
				),
			);
			const fakePi = writeExecutable(dir, "fake-pi", "#!/bin/sh\nexit 42\n");
			process.env.PI_SUBAGENT_PI_COMMAND = fakePi;
			const parentSession = writeParentSession(cwd);

			const running = await launchInteractiveSubagent(
				{
					name: "sentinel-launch-child",
					title: "Sentinel launch child",
					task: "Check staged sentinel status.",
					agent: "sentinel-child",
				},
				{
					cwd,
					sessionManager: {
						getSessionFile: () => parentSession,
						getSessionId: () => "parent-session-id",
						getLeafId: () => "asst-001",
					},
				},
				{
					getContextWindow: () => undefined,
					getShellReadyDelayMs: () => 0,
				},
			);

			const log = readFileSync(logFile, "utf8");
			const launchScriptPath = extractHerdrRunScriptPath(log);
			const launchScript = readFileSync(launchScriptPath, "utf8");
			const command = launchScript.split("\n").slice(1).join("\n").trim();

			const shell = spawn(posixShellPath(), [], {
				stdio: ["pipe", "ignore", "ignore"],
			});
			try {
				shell.stdin.write(`${command}\n`);
				const sentinel = await readEventually(running.doneSentinelFile!, (text) => /__SUBAGENT_DONE_42__/.test(text));
				assert.match(sentinel, /__SUBAGENT_DONE_42__/);
			} finally {
				shell.stdin.end("exit\n");
			}

			rmSync(running.doneSentinelFile!, { force: true });
			assert.equal(existsSync(extractCapsulePath(launchScript)), false, "capsule must be consumed after one run");
			const result = spawnSync(posixShellPath(), [launchScriptPath], { encoding: "utf8" });
			assert.equal(result.error, undefined);
			// The capsule is one-shot: a re-run still records a sentinel status, not a stale 42.
			assert.match(readFileSync(running.doneSentinelFile!, "utf8"), /__SUBAGENT_DONE_\d+__/);
		} finally {
			if (originalPiCommand === undefined) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = originalPiCommand;
			if (originalShell === undefined) delete process.env.SHELL;
			else process.env.SHELL = originalShell;
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
		}
	});

	it("launches interactive Herdr children with resolved cwd, session, approval, and surface facts", async () => {
		const { logFile } = useFakeHerdr();
		const cwd = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = join(cwd, "artifacts");
		const childCwd = join(cwd, "child-workspace");
		mkdirSync(childCwd, { recursive: true });
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "path-session.md"),
			[
				"---",
				"name: path-session",
				"session-mode: fork",
				"no-session: true",
				"trust-project: true",
				"cwd: child-workspace",
				"env: |",
				"  CUSTOM_ENV=from-agent",
				"flags: --alpha 'two words'",
				"---",
				"Preserve resolved runtime facts.",
			].join("\n"),
		);
		const parentSession = writeParentSession(cwd);

		const running = await launchInteractiveSubagent(
			{
				name: "path-session-child",
				title: "Path session child",
				task: "Check launch parity.",
				agent: "path-session",
			},
			{
				cwd,
				sessionManager: {
					getSessionFile: () => parentSession,
					getSessionId: () => "parent-session-id",
					getLeafId: () => "asst-001",
				},
			},
			{
				getContextWindow: () => 4096,
				getShellReadyDelayMs: () => 0,
			},
		);

		assert.equal(running.mode, "interactive");
		assert.equal(running.surface, "w1:p2");
		assert.equal(running.noSession, true);
		assert.equal(running.modelContextWindow, 4096);

		const metadata = readSubagentLaunchMetadataForTest(running.sessionFile);
		assert.equal(metadata?.mode, "interactive");
		assert.equal(metadata?.sessionMode, "fork");
		assert.equal(metadata?.noSession, true);
		assert.equal(metadata?.trustProject, true);
		assert.equal(metadata?.cwd, childCwd);
		assert.equal(metadata?.env, "CUSTOM_ENV=from-agent");
		assert.equal(metadata?.flags, "--alpha 'two words'");

		const log = readFileSync(logFile, "utf8");
		assert.match(log, /status server --json/);
		assert.match(log, /pane current --current/);
		assert.match(log, /pane layout --pane w1:p1/);
		assert.match(log, /pane split w1:p1 --direction right --ratio 0\.5 --cwd .* --no-focus/);
		assert.match(log, /pane rename w1:p2 \[path-session\] Path session child/);
		assert.doesNotMatch(log, /tab create|tab rename/);
		assert.match(log, /pane run w1:p2 /);
		assert.doesNotMatch(log, /pane send-keys w1:p2 Enter/);
		const launchScript = readHerdrRunScript(log);
		assert.match(launchScript, new RegExp(`cd '${escapeRegExp(childCwd.replace(/'/g, "'\\''"))}' &&`));
		const capsule = readLaunchCapsule(launchScript);
		assert.equal(capsule.cwd, childCwd);
		const sessionIndex = capsule.args.indexOf("--session");
		assert.notEqual(sessionIndex, -1);
		assert.equal(capsule.args[sessionIndex + 1], running.sessionFile);
		assert.ok(capsule.args.includes("--no-session"));
		assert.ok(capsule.args.includes("--approve"));
		assert.equal(capsule.overrides.CUSTOM_ENV, "from-agent");
		assert.equal(capsule.overrides.PI_SUBAGENT_SURFACE, "w1:p2");
		const alphaIndex = capsule.args.indexOf("--alpha");
		assert.notEqual(alphaIndex, -1);
		assert.equal(capsule.args[alphaIndex + 1], "two words");
		// The observable pane command must not carry env material.
		assert.doesNotMatch(launchScript, /CUSTOM_ENV=/);
		assert.doesNotMatch(launchScript, /PI_SUBAGENT_SURFACE=/);
	});

	it("uses an agent env Herdr placement policy before creating the child surface", async () => {
		const { logFile } = useFakeHerdr();
		process.env.PI_SUBAGENT_HERDR_PLACEMENT = "auto";
		const cwd = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = join(cwd, "artifacts");
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "tab-child.md"),
			[
				"---",
				"name: tab-child",
				"auto-exit: true",
				"env: PI_SUBAGENT_HERDR_PLACEMENT=tab",
				"---",
				"Use a dedicated Herdr tab.",
			].join("\n"),
		);
		const parentSession = writeParentSession(cwd);

		const running = await launchInteractiveSubagent(
			{
				name: "tab-placement-child",
				title: "Tab placement child",
				task: "Check per-agent placement.",
				agent: "tab-child",
			},
			{
				cwd,
				sessionManager: {
					getSessionFile: () => parentSession,
					getSessionId: () => "parent-session-id",
					getLeafId: () => "asst-001",
				},
			},
			{
				getContextWindow: () => undefined,
				getShellReadyDelayMs: () => 0,
			},
		);

		assert.equal(running.surface, "w1:p2");
		assert.equal(readSubagentLaunchMetadataForTest(running.sessionFile)?.herdrPlacementPolicy, "tab");
		const log = readFileSync(logFile, "utf8");
		assert.doesNotMatch(log, /pane layout|pane split/);
		assert.match(log, /tab create --workspace w1/);
	});

	it("honors an explicit Herdr mux preference at the launch seam", async () => {
		const { logFile } = useFakeHerdr();
		process.env.PI_SUBAGENT_MUX = "herdr";
		const cwd = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = join(cwd, "artifacts");
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "forced-herdr.md"),
			[
				"---",
				"name: forced-herdr",
				"mode: interactive",
				"auto-exit: true",
				"async: false",
				"spawning: false",
				"---",
				"Launch through explicitly forced Herdr.",
			].join("\n"),
		);
		const parentSession = writeParentSession(cwd);
		const baseParams = {
			name: "forced-herdr-child",
			title: "Forced Herdr child",
			task: "Check forced Herdr launch parity.",
			agent: "forced-herdr",
		};
		const agentDefs = loadAgentDefaults("forced-herdr", undefined, cwd);
		const effectiveParams = enforceAgentFrontmatterForTest(baseParams, agentDefs);
		assert.equal(effectiveParams.async, false);
		assert.equal(effectiveParams.blocking, true);

		const running = await launchInteractiveSubagent(
			effectiveParams,
			{
				cwd,
				sessionManager: {
					getSessionFile: () => parentSession,
					getSessionId: () => "parent-session-id",
					getLeafId: () => "asst-001",
				},
			},
			{
				getContextWindow: () => 4096,
				getShellReadyDelayMs: () => 0,
			},
		);

		assert.equal(running.mode, "interactive");
		assert.equal(running.surface, "w1:p2");
		assert.equal(running.async, false);
		assert.equal(running.blocking, true);
		assert.equal(running.autoExit, true);

		const metadata = readSubagentLaunchMetadataForTest(running.sessionFile);
		assert.equal(metadata?.mode, "interactive");
		assert.equal(metadata?.autoExit, true);
		assert.equal(metadata?.async, false);

		const log = readFileSync(logFile, "utf8");
		assert.match(log, /status server --json/);
		assert.match(log, /pane current --current/);
		assert.match(log, /pane split w1:p1 --direction right --ratio 0\.5 --cwd .* --no-focus/);
		assert.match(log, /pane rename w1:p2 \[forced-herdr\] Forced herdr child/);
		assert.doesNotMatch(log, /tab create|tab rename/);
		assert.match(log, /pane run w1:p2 /);
		assert.doesNotMatch(log, /pane send-keys w1:p2 Enter/);
		const launchScript = readHerdrRunScript(log);
		const capsule = readLaunchCapsule(launchScript);
		assert.equal(capsule.overrides.PI_SUBAGENT_SURFACE, "w1:p2");
	});

	it("launches interactive Herdr children with resolved capability, model, and lifecycle facts", async () => {
		const { logFile } = useFakeHerdr();
		const cwd = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = join(cwd, "artifacts");
		const agentConfigDir = join(cwd, "agent-config");
		process.env.PI_CODING_AGENT_DIR = agentConfigDir;
		mkdirSync(join(agentConfigDir, "agents"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		const skillDir = join(cwd, ".pi", "skills", "review");
		mkdirSync(skillDir, { recursive: true });
		const skillFile = join(skillDir, "SKILL.md");
		writeFileSync(
			skillFile,
			["---", "name: review", "description: Review skill fixture.", "---", "Review skill body token."].join("\n"),
		);
		writeFileSync(
			join(cwd, ".pi", "agents", "capability-lifecycle.md"),
			[
				"---",
				"name: capability-lifecycle",
				"model: zai-messages/glm-5-turbo",
				"thinking: off",
				"auto-exit: true",
				"async: false",
				"parent-close-policy: continue",
				"tools: read,grep",
				"deny-tools: grep,set_tab_title",
				"extensions: none",
				"skills: review",
				"inject-skills: review",
				"spawning: false",
				"no-context-files: true",
				"---",
				"Preserve capability and lifecycle facts.",
			].join("\n"),
		);
		const parentSession = writeParentSession(cwd);
		const baseParams = {
			name: "capability-child",
			title: "Capability child",
			task: "Check capability launch parity.",
			agent: "capability-lifecycle",
		};
		const agentDefs = loadAgentDefaults("capability-lifecycle", undefined, cwd);
		const effectiveParams = enforceAgentFrontmatterForTest(baseParams, agentDefs);
		assert.equal(effectiveParams.async, false);
		assert.equal(effectiveParams.blocking, true);
		const contextWindowRefs: Array<string | undefined> = [];

		const running = await launchInteractiveSubagent(
			effectiveParams,
			{
				cwd,
				parentModelRef: "parent/provider-model",
				parentThinking: "medium",
				sessionManager: {
					getSessionFile: () => parentSession,
					getSessionId: () => "parent-session-id",
					getLeafId: () => "asst-001",
				},
			},
			{
				getContextWindow: (modelRef) => {
					contextWindowRefs.push(modelRef);
					return modelRef === "zai-messages/glm-5-turbo:off" ? 8192 : undefined;
				},
				getShellReadyDelayMs: () => 0,
			},
		);

		assert.equal(running.mode, "interactive");
		assert.equal(running.surface, "w1:p2");
		assert.equal(running.autoExit, true);
		assert.equal(running.async, false);
		assert.equal(running.blocking, true);
		assert.equal(running.parentClosePolicy, "continue");
		assert.equal(running.modelRef, "zai-messages/glm-5-turbo:off");
		assert.equal(running.modelContextWindow, 8192);
		assert.deepEqual(contextWindowRefs, ["zai-messages/glm-5-turbo:off"]);

		const metadata = readSubagentLaunchMetadataForTest(running.sessionFile);
		assert.equal(metadata?.mode, "interactive");
		assert.equal(metadata?.autoExit, true);
		assert.equal(metadata?.async, false);
		assert.equal(metadata?.parentClosePolicy, "continue");
		assert.equal(metadata?.model, "zai-messages/glm-5-turbo");
		assert.equal(metadata?.thinking, "off");
		assert.equal(metadata?.modelRef, "zai-messages/glm-5-turbo:off");
		assert.equal(metadata?.definitionModel, "zai-messages/glm-5-turbo");
		assert.equal(metadata?.definitionThinking, "off");
		assert.equal(metadata?.modelSource, "agent");
		assert.equal(metadata?.tools, "read,grep");
		assert.equal(metadata?.skills, "review");
		assert.equal(metadata?.injectSkills, "review");
		assert.deepEqual(metadata?.extensions, []);
		assert.deepEqual(metadata?.denyTools, ["subagent", "subagent_resume", "subagent_kill", "grep", "set_tab_title"]);
		assert.equal(metadata?.noContextFiles, true);
		assert.equal(metadata?.inheritAppendSystem, false);

		const log = readFileSync(logFile, "utf8");
		assert.match(log, /pane split w1:p1 --direction right --ratio 0\.5 --cwd .* --no-focus/);
		assert.match(log, /pane rename w1:p2 \[capability-lifecycle\] Capability child/);
		assert.doesNotMatch(log, /tab create|tab rename/);
		assert.match(log, /pane run w1:p2 /);
		assert.doesNotMatch(log, /pane send-keys w1:p2 Enter/);
		const launchScript = readHerdrRunScript(log);
		const capsule = readLaunchCapsule(launchScript);
		assert.equal(capsule.overrides.PI_SUBAGENT_AUTO_EXIT, "1");
		assert.equal(capsule.overrides.PI_DENY_TOOLS, "subagent,subagent_resume,subagent_kill,grep,set_tab_title");
		assert.equal(capsule.overrides.PI_SUBAGENT_EXTENSIONS, "");
		const modelIndex = capsule.args.indexOf("--model");
		assert.notEqual(modelIndex, -1);
		assert.equal(capsule.args[modelIndex + 1], "zai-messages/glm-5-turbo:off");
		assert.ok(capsule.args.includes("--no-context-files"));
		const appendIndex = capsule.args.indexOf("--append-system-prompt");
		assert.notEqual(appendIndex, -1);
		assert.equal(capsule.args[appendIndex + 1], "");
		const noExtIndex = capsule.args.indexOf("--no-extensions");
		assert.notEqual(noExtIndex, -1);
		assert.equal(capsule.args[noExtIndex + 1], "-e");
		assert.match(capsule.args[noExtIndex + 2], /[\\/]tools[\\/]subagent-done\.ts$/);
		const toolsIndex = capsule.args.indexOf("--tools");
		assert.notEqual(toolsIndex, -1);
		assert.equal(capsule.args[toolsIndex + 1], "read,grep,caller_ping,subagent_done");
		const excludeIndex = capsule.args.indexOf("--exclude-tools");
		assert.notEqual(excludeIndex, -1);
		assert.equal(capsule.args[excludeIndex + 1], "subagent,subagent_resume,subagent_kill,grep,set_tab_title");
		const skillIndex = capsule.args.indexOf("--skill");
		assert.notEqual(skillIndex, -1);
		assert.equal(capsule.args[skillIndex + 1], skillFile);
		assert.doesNotMatch(launchScript, /PI_SUBAGENT_AUTO_EXIT=/);
		assert.doesNotMatch(launchScript, /PI_DENY_TOOLS=/);

		const taskArg = capsule.args.find((arg: string) => arg.startsWith("@"));
		assert.ok(taskArg, "expected capsule argv to carry the @task artifact");
		const taskArtifact = readFileSync(taskArg.slice(1), "utf8");
		assert.match(taskArtifact, /<skill name="review">/);
		assert.match(taskArtifact, /Review skill body token\./);
		assert.match(taskArtifact, /Complete your task autonomously\./);
		assert.match(taskArtifact, /FINAL assistant message should summarize what you accomplished\./);
		assert.doesNotMatch(taskArtifact, /set_tab_title/);
	});

	it("keeps background launches independent of Herdr mux availability", async () => {
		const { dir, logFile: herdrLogFile } = useFakeHerdr();
		const cwd = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = join(cwd, "artifacts");
		const childCwd = join(cwd, "background-workspace");
		mkdirSync(childCwd, { recursive: true });
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "bg-agent.md"),
			[
				"---",
				"name: bg-agent",
				"session-mode: lineage-only",
				"trust-project: true",
				"report-context-usage: false",
				"cwd: background-workspace",
				"env: |",
				"  CUSTOM_ENV=from-background-agent",
				"flags: --background-flag",
				"---",
				"Run in the background.",
			].join("\n"),
		);
		const parentSession = writeParentSession(cwd);
		const childLogFile = join(cwd, "background-child.log");
		const fakePi = writeExecutable(
			dir,
			"fake-pi",
			`#!/bin/sh
{
  printf 'PWD=%s\n' "$PWD"
  printf 'ARGS=%s\n' "$*"
  printf 'CUSTOM_ENV=%s\n' "\${CUSTOM_ENV-}"
  printf 'SURFACE=%s\n' "\${PI_SUBAGENT_SURFACE-}"
} >> "${childLogFile}"
`,
		);
		// A background child is spawned directly rather than through the staged script, so
		// on Windows nothing honours the shebang: run it through the POSIX interpreter.
		// Quoted because the interpreter usually lives under "Program Files".
		process.env.PI_SUBAGENT_PI_COMMAND =
			process.platform === "win32" ? `"${posixShellPath()}" "${fakePi}"` : fakePi;

		const running = await launchBackgroundSubagent(
			{
				name: "background-child",
				title: "Background child",
				task: "Check background launch isolation.",
				agent: "bg-agent",
			},
			{
				cwd,
				sessionManager: {
					getSessionFile: () => parentSession,
					getSessionId: () => "parent-session-id",
					getLeafId: () => "asst-001",
				},
			},
			{ getContextWindow: () => 2048 },
		);

		const childLog = await readEventually(
			childLogFile,
			(text) => text.includes("CUSTOM_ENV=") && text.includes("SURFACE="),
		);
		assert.equal(running.mode, "background");
		assert.equal(running.surface, undefined);
		assert.equal(running.modelContextWindow, 2048);
		assert.equal(running.reportContextUsage, false);
		assert.equal(readSubagentLaunchMetadataForTest(running.sessionFile)?.reportContextUsage, false);
		const expectedChildCwd = realpathSync(childCwd);
		// $PWD comes from the shell that ran the child, and its spelling is not portable:
		// Git-bash reports a Windows temp path as /tmp/..., not /c/Users/.../Temp/....
		// The identifying part is the unique test directory and the workspace under it.
		const pwdTail = expectedChildCwd.replace(/\\/g, "/").split("/").slice(-2).join("/");
		assert.match(childLog, new RegExp(`PWD=.*${escapeRegExp(pwdTail)}\n`));
		assert.match(childLog, /CUSTOM_ENV=from-background-agent/);
		assert.match(childLog, /SURFACE=\n/);
		assert.match(childLog, /--no-approve/);
		assert.match(childLog, /--background-flag/);
		assert.match(childLog, /--append-system-prompt\s{2}--no-approve/);
		assert.equal(readFileSync(herdrLogFile, "utf8"), "");
	});
});
