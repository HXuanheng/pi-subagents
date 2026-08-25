import { aggregateTraceRecords, parseTraceLines, type TraceRecord } from "../../src/trace/aggregate.ts";
import { assert, describe, it } from "../support/index.ts";

function rec(overrides: Partial<TraceRecord> & { event: string }): TraceRecord {
	return { timestamp: "2025-01-01T00:00:00.000Z", ...overrides };
}

describe("parseTraceLines", () => {
	it("parses one JSON object per line", () => {
		const raw = `${JSON.stringify({ event: "a" })}\n${JSON.stringify({ event: "b" })}\n`;
		const { records, malformedLines } = parseTraceLines(raw);
		assert.equal(records.length, 2);
		assert.equal(malformedLines, 0);
	});

	it("skips a truncated final line instead of throwing", () => {
		const raw = `${JSON.stringify({ event: "a" })}\n{"event":"b, truncat`;
		const { records, malformedLines } = parseTraceLines(raw);
		assert.equal(records.length, 1);
		assert.equal(malformedLines, 1);
	});

	it("ignores blank lines and counts non-object JSON as malformed", () => {
		const raw = `\n${JSON.stringify({ event: "a" })}\n\n42\n["not","an","object"]\n`;
		const { records, malformedLines } = parseTraceLines(raw);
		assert.equal(records.length, 1);
		assert.equal(malformedLines, 2);
	});
});

// One run's worth of events, from launch to whatever terminal event it got.
function run(
	id: string,
	name: string,
	surface: string,
	startIso: string,
	finished?: { outcome: string; at: string },
): TraceRecord[] {
	const records: TraceRecord[] = [
		rec({ event: "interactive.prepared", id, name, sessionMode: "standalone", timestamp: startIso }),
		rec({ event: "interactive.surface", id, name, surface, timestamp: startIso }),
		rec({ event: "interactive.watch.start", id, name, surface, signalAborted: false, timestamp: startIso }),
	];
	if (finished) {
		records.push(rec({ event: "interactive.watch.finished", id, name, surface, outcome: finished.outcome, timestamp: finished.at }));
	}
	return records;
}

describe("aggregateTraceRecords", () => {
	it("counts a completed run and measures its duration from first event to finished", () => {
		const summary = aggregateTraceRecords(
			run("id1", "reviewer", "pane:1", "2025-01-01T00:00:00.000Z", { outcome: "completed", at: "2025-01-01T00:00:05.300Z" }),
		);
		assert.equal(summary.agents.length, 1);
		const agent = summary.agents[0];
		assert.equal(agent.name, "reviewer");
		assert.equal(agent.launches, 1);
		assert.equal(agent.completions, 1);
		assert.equal(agent.timeouts, 0);
		assert.equal(agent.idleTimeouts, 0);
		assert.equal(agent.incomplete, 0);
		assert.equal(agent.duration?.count, 1);
		assert.equal(agent.duration?.minMs, 5300);
		assert.equal(agent.duration?.maxMs, 5300);
		assert.deepEqual(agent.sessionModeCounts, { standalone: 1 });
	});

	it("separates a whole-run timeout from an idle-timeout", () => {
		const summary = aggregateTraceRecords([
			...run("id2", "builder", "pane:2", "2025-01-01T00:01:00.000Z", { outcome: "timeout", at: "2025-01-01T00:01:30.000Z" }),
			...run("id3", "builder", "pane:3", "2025-01-01T00:02:00.000Z", { outcome: "idle-timeout", at: "2025-01-01T00:02:20.000Z" }),
		]);
		const agent = summary.agents.find((a) => a.name === "builder");
		assert.equal(agent?.timeouts, 1);
		assert.equal(agent?.idleTimeouts, 1);
		assert.equal(agent?.completions, 0);
		assert.equal(agent?.duration?.count, 2);
	});

	// The bug this replaced: closeFailed was read as "this run timed out", so a
	// successful timeout counted as a completion and a failed soft wrap-up close
	// counted as a timeout.
	it("never treats a failed pane close as a timeout", () => {
		const summary = aggregateTraceRecords([
			...run("id4", "wrapper", "pane:4", "2025-01-01T00:03:00.000Z", { outcome: "completed", at: "2025-01-01T00:03:10.000Z" }),
			rec({
				event: "interactive.timeout.closeFailed",
				name: "wrapper",
				surface: "pane:4",
				attempt: 1,
				errorMessage: "pane gone",
				timestamp: "2025-01-01T00:03:09.000Z",
			}),
		]);
		const agent = summary.agents.find((a) => a.name === "wrapper");
		assert.equal(agent?.timeouts, 0);
		assert.equal(agent?.completions, 1);
		assert.equal(agent?.closeFailures, 1);
	});

	it("counts a timeout that closed its pane cleanly, with no closeFailed event at all", () => {
		const summary = aggregateTraceRecords(
			run("id5", "quiet-timeout", "pane:5", "2025-01-01T00:04:00.000Z", { outcome: "timeout", at: "2025-01-01T00:04:30.000Z" }),
		);
		const agent = summary.agents.find((a) => a.name === "quiet-timeout");
		assert.equal(agent?.timeouts, 1);
		assert.equal(agent?.closeFailures, 0);
		assert.equal(agent?.completions, 0);
	});

	it("classifies aborted, error and ping outcomes separately", () => {
		const summary = aggregateTraceRecords([
			...run("id6", "multi", "pane:6", "2025-01-01T00:05:00.000Z", { outcome: "aborted", at: "2025-01-01T00:05:01.000Z" }),
			...run("id7", "multi", "pane:7", "2025-01-01T00:06:00.000Z", { outcome: "error", at: "2025-01-01T00:06:01.000Z" }),
			...run("id8", "multi", "pane:8", "2025-01-01T00:07:00.000Z", { outcome: "ping", at: "2025-01-01T00:07:01.000Z" }),
		]);
		const agent = summary.agents.find((a) => a.name === "multi");
		assert.equal(agent?.aborts, 1);
		assert.equal(agent?.errors, 1);
		assert.equal(agent?.pings, 1);
		assert.equal(agent?.completions, 0);
	});

	it("counts a resumed run as a resume as well as a launch", () => {
		const summary = aggregateTraceRecords([
			rec({ event: "resume.started", id: "id9", name: "resumed", agent: "worker", mode: "interactive", timestamp: "2025-01-01T00:08:00.000Z" }),
			rec({ event: "interactive.watch.start", id: "id9", name: "resumed", surface: "pane:9", timestamp: "2025-01-01T00:08:00.100Z" }),
			rec({ event: "interactive.watch.finished", id: "id9", name: "resumed", surface: "pane:9", outcome: "completed", timestamp: "2025-01-01T00:08:04.000Z" }),
		]);
		const agent = summary.agents.find((a) => a.name === "resumed");
		assert.equal(agent?.launches, 1);
		assert.equal(agent?.resumes, 1);
		assert.equal(agent?.completions, 1);
	});

	it("marks a run with no finished event as incomplete and reports no duration for it", () => {
		const summary = aggregateTraceRecords(run("id10", "hanging", "pane:10", "2025-01-01T00:09:00.000Z"));
		const agent = summary.agents.find((a) => a.name === "hanging");
		assert.equal(agent?.incomplete, 1);
		assert.equal(agent?.completions, 0);
		assert.equal(agent?.duration, null);
	});

	it("reports no duration for an unfinished run even when the finished run beside it has one", () => {
		const summary = aggregateTraceRecords([
			...run("id11", "mixed", "pane:11", "2025-01-01T00:10:00.000Z", { outcome: "completed", at: "2025-01-01T00:10:02.000Z" }),
			...run("id12", "mixed", "pane:12", "2025-01-01T00:11:00.000Z"),
		]);
		const agent = summary.agents.find((a) => a.name === "mixed");
		assert.equal(agent?.completions, 1);
		assert.equal(agent?.incomplete, 1);
		assert.equal(agent?.duration?.count, 1);
		assert.equal(agent?.duration?.maxMs, 2000);
	});

	it("keeps two runs that reused the same surface apart, because every event carries its id", () => {
		const summary = aggregateTraceRecords([
			...run("id13", "reuser", "pane:R", "2025-01-01T00:12:00.000Z", { outcome: "completed", at: "2025-01-01T00:12:01.000Z" }),
			...run("id14", "reuser", "pane:R", "2025-01-01T00:13:00.000Z", { outcome: "timeout", at: "2025-01-01T00:13:05.000Z" }),
		]);
		const agent = summary.agents.find((a) => a.name === "reuser");
		assert.equal(agent?.launches, 2);
		assert.equal(agent?.completions, 1);
		assert.equal(agent?.timeouts, 1);
		assert.equal(agent?.duration?.count, 2);
	});

	it("counts an unrecognized outcome string as incomplete rather than as a completion", () => {
		const summary = aggregateTraceRecords(
			run("id15", "future", "pane:15", "2025-01-01T00:14:00.000Z", { outcome: "something-new", at: "2025-01-01T00:14:01.000Z" }),
		);
		const agent = summary.agents.find((a) => a.name === "future");
		assert.equal(agent?.incomplete, 1);
		assert.equal(agent?.completions, 0);
	});

	it("buckets session.shutdown and unrecognized events as other, never dropping them", () => {
		const summary = aggregateTraceRecords([
			rec({ event: "session.shutdown", coordinatorOnlyTurnStop: false, running: 0, timestamp: "2025-01-01T00:15:00.000Z" }),
			rec({ event: "some.future.event", foo: "bar", timestamp: "2025-01-01T00:15:01.000Z" }),
		]);
		assert.equal(summary.agents.length, 0);
		const byEvent = Object.fromEntries(summary.other.map((o) => [o.event, o.count]));
		assert.equal(byEvent["session.shutdown"], 1);
		assert.equal(byEvent["some.future.event"], 1);
	});

	it("counts a launch with no id or surface without fabricating a duration", () => {
		const summary = aggregateTraceRecords([rec({ event: "interactive.prepared", name: "no-key-agent", timestamp: "2025-01-01T00:16:00.000Z" })]);
		const agent = summary.agents.find((a) => a.name === "no-key-agent");
		assert.equal(agent?.launches, 1);
		assert.equal(agent?.duration, null);
		assert.equal(agent?.incomplete, 1);
	});
});
