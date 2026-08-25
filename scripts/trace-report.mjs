#!/usr/bin/env node
// Thin entry point: `node scripts/trace-report.mjs [path-to-trace.jsonl]`.
// Falls back to PI_SUBAGENT_TRACE_LOG when no path is given. See src/trace/cli.ts.
import "../src/trace/cli.ts";
