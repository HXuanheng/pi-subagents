import { readFileSync } from "node:fs";
import { aggregateTraceRecords, parseTraceLines, type TraceSummary } from "./aggregate.ts";

function formatMs(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

export function renderTraceReport(summary: TraceSummary, logPath: string): string {
	const lines: string[] = [];
	lines.push(`Subagent trace report — ${logPath}`);
	lines.push(`records: ${summary.totalRecords}  malformed lines skipped: ${summary.malformedLines}`);
	lines.push("");

	if (summary.agents.length === 0) {
		lines.push("No per-agent runs found in this log.");
	} else {
		const header = [
			"agent",
			"launches",
			"resumes",
			"done",
			"timeout",
			"idle",
			"ping",
			"abort",
			"error",
			"incomplete",
			"min",
			"median",
			"max",
		];
		const rows = summary.agents.map((a) => [
			a.name,
			String(a.launches),
			String(a.resumes),
			String(a.completions),
			String(a.timeouts),
			String(a.idleTimeouts),
			String(a.pings),
			String(a.aborts),
			String(a.errors),
			String(a.incomplete),
			a.duration ? formatMs(a.duration.minMs) : "-",
			a.duration ? formatMs(a.duration.medianMs) : "-",
			a.duration ? formatMs(a.duration.maxMs) : "-",
		]);
		const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
		const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join("  ");
		lines.push(fmt(header));
		lines.push(widths.map((w) => "-".repeat(w)).join("  "));
		for (const row of rows) lines.push(fmt(row));

		const withCloseFailures = summary.agents.filter((a) => a.closeFailures > 0);
		if (withCloseFailures.length > 0) {
			lines.push("");
			lines.push("pane close failures (teardown diagnostic, not timeouts):");
			for (const a of withCloseFailures) lines.push(`  ${a.name}: ${a.closeFailures}`);
		}

		lines.push("");
		lines.push("sessionMode distribution per agent:");
		for (const a of summary.agents) {
			const entries = Object.entries(a.sessionModeCounts);
			if (entries.length === 0) continue;
			lines.push(`  ${a.name}: ${entries.map(([mode, count]) => `${mode}=${count}`).join(", ")}`);
		}
	}

	if (summary.other.length > 0) {
		lines.push("");
		lines.push("other/unattributed events:");
		for (const o of summary.other) lines.push(`  ${o.event}: ${o.count}`);
	}

	if (summary.notes.length > 0) {
		lines.push("");
		lines.push("notes:");
		for (const n of summary.notes) lines.push(`  - ${n}`);
	}

	return lines.join("\n");
}

function main(): void {
	const arg = process.argv[2];
	const logPath = arg?.trim() || process.env.PI_SUBAGENT_TRACE_LOG?.trim();
	if (!logPath) {
		console.error("Usage: trace-report <path-to-trace.jsonl>  (or set PI_SUBAGENT_TRACE_LOG)");
		process.exitCode = 1;
		return;
	}

	let raw: string;
	try {
		raw = readFileSync(logPath, "utf8");
	} catch (err: unknown) {
		console.error(`Could not read trace log at ${logPath}: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 1;
		return;
	}

	const { records, malformedLines } = parseTraceLines(raw);
	const summary = aggregateTraceRecords(records, malformedLines);
	console.log(renderTraceReport(summary, logPath));
}

main();
