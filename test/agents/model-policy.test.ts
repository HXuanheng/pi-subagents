import { getAgentListEntries, renderAgentListReminder } from "../../src/agents/agent-list.ts";
import { getEffectiveAgentDefinitions } from "../../src/agents/definitions.ts";
import { loadModelPolicy } from "../../src/agents/model-policy.ts";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	it,
	join,
	mkdirSync,
	resetSubagentStateForTest,
	writeFileSync,
} from "../support/index.ts";

function setupAgentRoot(dir: string, frontmatter: string): { configDir: string; agentsDir: string } {
	const configDir = join(dir, "agent-root");
	const agentsDir = join(configDir, "agents");
	mkdirSync(agentsDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = configDir;
	writeFileSync(join(agentsDir, "reviewer.md"), `---\nname: reviewer\ndescription: Review changes\n${frontmatter}\n---\n\nBody.`);
	return { configDir, agentsDir };
}

function resolveSessionMode(agent: ReturnType<typeof getEffectiveAgentDefinitions>[number]) {
	return agent.sessionMode ?? "lineage-only";
}

function listEntries(dir: string) {
	return getAgentListEntries(dir, resolveSessionMode, { callerAgent: null, callerSpawnable: true });
}

describe("model policy annotations", () => {
	afterEach(() => resetSubagentStateForTest());

	it("annotates default_model and models with cost/coding/note when the policy file is present", () => {
		const dir = createTestDir();
		const { configDir } = setupAgentRoot(
			dir,
			"model: anthropic/claude-sonnet-5\nallow-model-override: true\nallowed-models: anthropic/claude-haiku-4-5",
		);
		writeFileSync(
			join(configDir, "models-policy.json"),
			JSON.stringify({
				models: {
					"anthropic/claude-sonnet-5": { cost: 4.6, coding: 70.8, note: "default implementer" },
					"anthropic/claude-haiku-4-5": { cost: 1.0, coding: 42.0, note: "cheap scout" },
				},
			}),
		);

		const reminder = renderAgentListReminder(listEntries(dir));
		assert.match(reminder, /default_model: anthropic\/claude-sonnet-5 \(cost 4\.6, coding 70\.8\) — default implementer/);
		assert.match(reminder, /anthropic\/claude-haiku-4-5 \(cost 1, coding 42\) — cheap scout/);
	});

	it("renders exactly as without the file when no policy file exists", () => {
		const dir = createTestDir();
		setupAgentRoot(dir, "model: anthropic/claude-sonnet-5\nallow-model-override: true\nallowed-models: anthropic/claude-haiku-4-5");

		const withoutFile = renderAgentListReminder(listEntries(dir));
		assert.doesNotMatch(withoutFile, /cost \d/);
		assert.doesNotMatch(withoutFile, / — /);
		assert.match(withoutFile, /default_model: anthropic\/claude-sonnet-5$/m);
		assert.match(withoutFile, /models: anthropic\/claude-sonnet-5 \| anthropic\/claude-haiku-4-5$/m);
	});

	// Each degradation case is compared against the same roster rendered with no
	// policy file at all, so the guarantee tested is byte identity rather than the
	// absence of a few substrings.
	for (const [label, contents] of [
		["malformed JSON", "{ not valid json"],
		["a wrong top-level shape", JSON.stringify({ models: ["not", "an", "object"] })],
		["no models key", JSON.stringify({ allowed: ["anthropic/claude-sonnet-5"] })],
		[
			"one invalid entry beside valid ones",
			JSON.stringify({
				models: {
					"anthropic/claude-sonnet-5": { cost: 4.6, coding: 70.8, note: "default implementer" },
					"anthropic/claude-haiku-4-5": { cost: "free" },
				},
			}),
		],
	] as const) {
		it(`renders byte-identically to no policy file when the policy has ${label}`, () => {
			const frontmatter =
				"model: anthropic/claude-sonnet-5\nallow-model-override: true\nallowed-models: anthropic/claude-haiku-4-5";

			const baselineDir = createTestDir();
			setupAgentRoot(baselineDir, frontmatter);
			const baseline = renderAgentListReminder(listEntries(baselineDir));
			resetSubagentStateForTest();

			const dir = createTestDir();
			const { configDir } = setupAgentRoot(dir, frontmatter);
			writeFileSync(join(configDir, "models-policy.json"), contents);

			assert.equal(renderAgentListReminder(listEntries(dir)), baseline);
			assert.deepEqual(loadModelPolicy(configDir), {});
		});
	}

	it("renders a model ref missing from the policy with no annotation and no fake score", () => {
		const dir = createTestDir();
		const { configDir } = setupAgentRoot(
			dir,
			"model: anthropic/claude-sonnet-5\nallow-model-override: true\nallowed-models: anthropic/claude-opus-4-8",
		);
		writeFileSync(
			join(configDir, "models-policy.json"),
			JSON.stringify({ models: { "anthropic/claude-sonnet-5": { cost: 4.6, coding: 70.8 } } }),
		);

		const reminder = renderAgentListReminder(listEntries(dir));
		assert.match(reminder, /default_model: anthropic\/claude-sonnet-5 \(cost 4\.6, coding 70\.8\)/);
		assert.match(reminder, /models: anthropic\/claude-sonnet-5 \(cost 4\.6, coding 70\.8\) \| anthropic\/claude-opus-4-8$/m);
	});

	it("annotates a ref carrying a :thinking suffix from a policy key without one", () => {
		const dir = createTestDir();
		const { configDir } = setupAgentRoot(dir, "model: anthropic/claude-sonnet-5\nthinking: high\nallow-model-override: true");
		writeFileSync(
			join(configDir, "models-policy.json"),
			JSON.stringify({ models: { "anthropic/claude-sonnet-5": { cost: 4.6 } } }),
		);

		const reminder = renderAgentListReminder(listEntries(dir));
		assert.match(reminder, /default_model: anthropic\/claude-sonnet-5:high \(cost 4\.6\)/);
	});

	it("annotates from a policy key that carries the :thinking suffix itself", () => {
		const dir = createTestDir();
		const { configDir } = setupAgentRoot(dir, "model: anthropic/claude-sonnet-5\nthinking: high\nallow-model-override: true");
		writeFileSync(
			join(configDir, "models-policy.json"),
			JSON.stringify({ models: { "anthropic/claude-sonnet-5:high": { cost: 9.9 } } }),
		);

		const reminder = renderAgentListReminder(listEntries(dir));
		assert.match(reminder, /default_model: anthropic\/claude-sonnet-5:high \(cost 9\.9\)/);
	});

	it("prefers the bare model key over a :thinking key when both exist", () => {
		const dir = createTestDir();
		const { configDir } = setupAgentRoot(dir, "model: anthropic/claude-sonnet-5\nthinking: high\nallow-model-override: true");
		writeFileSync(
			join(configDir, "models-policy.json"),
			JSON.stringify({
				models: {
					"anthropic/claude-sonnet-5": { cost: 4.6 },
					"anthropic/claude-sonnet-5:high": { cost: 9.9 },
				},
			}),
		);

		const reminder = renderAgentListReminder(listEntries(dir));
		assert.match(reminder, /default_model: anthropic\/claude-sonnet-5:high \(cost 4\.6\)/);
	});
});
