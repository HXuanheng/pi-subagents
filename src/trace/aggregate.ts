// Aggregates records emitted by traceSubagentLaunch (see ../launch/trace.ts) into
// per-agent usage stats. Pure: no fs, no process.env, so it is unit-testable with
// hand-built record arrays.
//
// Event vocabulary actually emitted (surveyed against every traceSubagentLaunch
// call site as of this file's creation):
//
//   interactive.prepared            { id, name, agent, sessionMode, sessionFile, cwd, model, skills, injectSkills }
//   interactive.promptArgs          { id, name, directTask, taskArg, promptArgs }
//   interactive.surface             { id, name, surface, surfacePreCreated }
//   interactive.send                { id, name, surface, sessionFile, doneSentinelFile, commandParts, envKeys }
//   interactive.watch.start         { id, name, surface, sessionFile, signalAborted }
//   interactive.watch.pollResult    { id, name, surface, sessionFile, pollResult }
//   interactive.watch.error         { id, name, surface, sessionFile, errorMessage, signalAborted }
//   interactive.watch.finished      { id, name, surface, sessionFile, outcome, elapsed, exitCode, timedOutAfter?, errorMessage? }
//   interactive.timeout.closeFailed { name, surface, attempt, errorMessage }
//   resume.started                  { id, name, agent, mode, sessionFile }
//   session.shutdown                { coordinatorOnlyTurnStop, eventKeys, running } (no name/id/surface — parent-level, not per-run)
//
// Every event above carries `timestamp` (ISO string, added by traceSubagentLaunch)
// and `event`. All per-run events carry the launch `id`, so runs are keyed by it
// directly and a reused surface cannot mix two runs together.
//
// `interactive.watch.finished` is the terminal event. Its `outcome` is the
// authoritative run result: "completed", "timeout", "idle-timeout", "ping",
// "aborted" or "error". Nothing is inferred from `interactive.timeout.closeFailed`,
// which reports only that closing a pane failed and fires for soft wrap-up closes
// too; it is counted separately as a diagnostic, never as a timeout.
//
// Durations are measured strictly from a run's first event to its
// `interactive.watch.finished` timestamp. A run with no terminal event contributes
// no duration at all.
//
// Older logs, written before these events existed, have no `id` on watch events and
// no finished event. Such runs are counted as `incomplete` and excluded from
// outcome and duration stats rather than guessed at.

export interface TraceRecord {
	timestamp?: unknown;
	event?: unknown;
	[key: string]: unknown;
}

export interface RunDurationStats {
	count: number;
	minMs: number;
	medianMs: number;
	maxMs: number;
}

export interface AgentSummary {
	name: string;
	launches: number;
	/** Launches that came from subagent_resume rather than a fresh launch. */
	resumes: number;
	completions: number;
	/** Runs stopped by the whole-run `timeout` budget. */
	timeouts: number;
	/** Runs stopped by the `idle-timeout` budget. */
	idleTimeouts: number;
	aborts: number;
	errors: number;
	/** Runs that ended by asking the parent for help rather than finishing. */
	pings: number;
	/** Runs with no interactive.watch.finished event — still running, or logged by an older build. */
	incomplete: number;
	/**
	 * Failed attempts to close a pane, from interactive.timeout.closeFailed. This is a
	 * pane-teardown diagnostic and fires for soft wrap-up closes too, so it is never
	 * counted as a timeout.
	 */
	closeFailures: number;
	sessionModeCounts: Record<string, number>;
	duration: RunDurationStats | null;
}

export interface TraceSummary {
	agents: AgentSummary[];
	/** Events that could not be attributed to any per-run key (e.g. session.shutdown) or whose event name is unrecognized. */
	other: { event: string; count: number }[];
	/** Lines that failed JSON.parse and were skipped (see parseTraceLines). */
	malformedLines: number;
	totalRecords: number;
	notes: string[];
}

const KNOWN_EVENTS = new Set([
	"interactive.prepared",
	"interactive.promptArgs",
	"interactive.surface",
	"interactive.send",
	"interactive.watch.start",
	"interactive.watch.pollResult",
	"interactive.watch.error",
	"interactive.watch.finished",
	"interactive.timeout.closeFailed",
	"resume.started",
	"session.shutdown",
]);

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function parseTimestamp(v: unknown): number | undefined {
	const s = str(v);
	if (!s) return undefined;
	const ms = Date.parse(s);
	return Number.isNaN(ms) ? undefined : ms;
}

interface RunAccumulator {
	name?: string;
	firstTs?: number;
	/** Timestamp of interactive.watch.finished. Absent means no duration is computed. */
	finishedTs?: number;
	/** The `outcome` field of interactive.watch.finished. Absent means the run never finished in this log. */
	outcome?: string;
	closeFailures: number;
	sessionMode?: string;
	resumed: boolean;
	launched: boolean; // saw interactive.prepared/surface/send/resume.started (a real launch, not just a stray watch event)
}

/** Parses newline-delimited JSON, tolerating a truncated/malformed final line. */
export function parseTraceLines(raw: string): { records: TraceRecord[]; malformedLines: number } {
	const records: TraceRecord[] = [];
	let malformedLines = 0;
	const lines = raw.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				records.push(parsed as TraceRecord);
			} else {
				malformedLines++;
			}
		} catch {
			malformedLines++;
		}
	}
	return { records, malformedLines };
}

function median(sorted: number[]): number {
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function aggregateTraceRecords(records: TraceRecord[], malformedLines = 0): TraceSummary {
	const notes: string[] = [
		"Outcomes are read from the `outcome` field of interactive.watch.finished. Nothing is inferred from " +
			"interactive.timeout.closeFailed, which reports only a failed pane close and fires for soft wrap-up " +
			"closes too; those are reported separately as closeFailures.",
		"Duration is measured from a run's first event to its interactive.watch.finished timestamp. A run with no " +
			"finished event contributes no duration.",
	];

	// Chronological, not a pre-pass: a surface can be reused by a later run, and the
	// owner of a surface at the time an event was written is the run that event
	// belongs to. Only needed for logs written before watch events carried `id`.
	const surfaceToId = new Map<string, string>();

	const runs = new Map<string, RunAccumulator>();
	const other = new Map<string, number>();
	let unkeyedFallbackCounter = 0;

	const getRun = (key: string): RunAccumulator => {
		let run = runs.get(key);
		if (!run) {
			run = { closeFailures: 0, resumed: false, launched: false };
			runs.set(key, run);
		}
		return run;
	};

	for (const rec of records) {
		const event = str(rec.event);
		if (!event) {
			other.set("(missing event field)", (other.get("(missing event field)") ?? 0) + 1);
			continue;
		}
		if (!KNOWN_EVENTS.has(event)) {
			other.set(event, (other.get(event) ?? 0) + 1);
			continue;
		}
		if (event === "session.shutdown") {
			// Parent-level lifecycle event, not attributable to any single subagent run.
			other.set(event, (other.get(event) ?? 0) + 1);
			continue;
		}

		const id = str(rec.id);
		const surface = str(rec.surface);
		if (id && surface) surfaceToId.set(surface, id);
		const key = id ?? (surface && surfaceToId.get(surface)) ?? (surface ? `surface:${surface}` : undefined);
		const runKey = key ?? `unkeyed:${unkeyedFallbackCounter++}`;
		const run = getRun(runKey);

		const name = str(rec.name);
		if (name) run.name = name;

		const ts = parseTimestamp(rec.timestamp);
		if (ts !== undefined && (run.firstTs === undefined || ts < run.firstTs)) run.firstTs = ts;

		if (
			event === "interactive.prepared" ||
			event === "interactive.surface" ||
			event === "interactive.send" ||
			event === "resume.started"
		) {
			run.launched = true;
		}
		if (event === "resume.started") run.resumed = true;
		if (event === "interactive.prepared") {
			const mode = str(rec.sessionMode);
			if (mode) run.sessionMode = mode;
		}
		if (event === "interactive.watch.finished") {
			run.outcome = str(rec.outcome) ?? "completed";
			if (ts !== undefined) run.finishedTs = ts;
		}
		if (event === "interactive.timeout.closeFailed") {
			run.closeFailures++;
		}
	}

	const byAgent = new Map<string, AgentSummary>();
	const durationsByAgent = new Map<string, number[]>();
	let sawUnnamedRun = false;

	for (const run of runs.values()) {
		const name = run.name ?? "(unknown)";
		if (!run.name) sawUnnamedRun = true;
		let summary = byAgent.get(name);
		if (!summary) {
			summary = {
				name,
				launches: 0,
				resumes: 0,
				completions: 0,
				timeouts: 0,
				idleTimeouts: 0,
				aborts: 0,
				errors: 0,
				pings: 0,
				incomplete: 0,
				closeFailures: 0,
				sessionModeCounts: {},
				duration: null,
			};
			byAgent.set(name, summary);
		}

		if (run.launched) summary.launches++;
		if (run.resumed) summary.resumes++;
		summary.closeFailures += run.closeFailures;
		if (run.sessionMode) {
			summary.sessionModeCounts[run.sessionMode] = (summary.sessionModeCounts[run.sessionMode] ?? 0) + 1;
		}

		// The finished event is authoritative. An unrecognized outcome string is counted
		// as incomplete rather than silently folded into completions.
		switch (run.outcome) {
			case "completed":
				summary.completions++;
				break;
			case "timeout":
				summary.timeouts++;
				break;
			case "idle-timeout":
				summary.idleTimeouts++;
				break;
			case "ping":
				summary.pings++;
				break;
			case "aborted":
				summary.aborts++;
				break;
			case "error":
				summary.errors++;
				break;
			default:
				summary.incomplete++;
				break;
		}

		// Only a real terminal event yields a duration; a hung run gets none.
		if (run.firstTs !== undefined && run.finishedTs !== undefined) {
			const durationMs = run.finishedTs - run.firstTs;
			if (durationMs >= 0) {
				const arr = durationsByAgent.get(name) ?? [];
				arr.push(durationMs);
				durationsByAgent.set(name, arr);
			}
		}
	}

	for (const [name, ms] of durationsByAgent) {
		const summary = byAgent.get(name);
		if (!summary) continue;
		const sorted = [...ms].sort((a, b) => a - b);
		summary.duration = {
			count: sorted.length,
			minMs: sorted[0],
			medianMs: median(sorted),
			maxMs: sorted[sorted.length - 1],
		};
	}

	if (sawUnnamedRun) {
		notes.push("Some runs never carried a `name` field (e.g. isolated timeout.closeFailed retries) and were grouped under '(unknown)'.");
	}

	const otherList = [...other.entries()]
		.map(([event, count]) => ({ event, count }))
		.sort((a, b) => b.count - a.count);

	const agents = [...byAgent.values()].sort((a, b) => a.name.localeCompare(b.name));

	return {
		agents,
		other: otherList,
		malformedLines,
		totalRecords: records.length,
		notes,
	};
}
