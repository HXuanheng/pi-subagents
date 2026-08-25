import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentConfigDir } from "./definitions.ts";

export interface ModelPolicyEntry {
	cost?: number;
	coding?: number;
	note?: string;
}

export type ModelPolicy = Record<string, ModelPolicyEntry>;

function isValidEntry(value: unknown): value is ModelPolicyEntry {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const entry = value as Record<string, unknown>;
	if (entry.cost !== undefined && typeof entry.cost !== "number") return false;
	if (entry.coding !== undefined && typeof entry.coding !== "number") return false;
	if (entry.note !== undefined && typeof entry.note !== "string") return false;
	return true;
}

export function getModelPolicyPath(agentConfigDir: string = getAgentConfigDir()): string {
	return join(agentConfigDir, "models-policy.json");
}

/**
 * Loads the optional hand-maintained model cost/capability file. Returns an
 * empty policy (no annotations, roster renders exactly as without the file)
 * when the file is missing, unreadable, not valid JSON, or shaped wrong. This
 * feature is strictly additive and must never block roster rendering.
 *
 * Validation is all-or-nothing: one bad entry discards the whole file. A
 * partially applied policy would annotate some refs and silently drop others,
 * which reads as "this model has no data" rather than "your file has a typo".
 */
export function loadModelPolicy(agentConfigDir: string = getAgentConfigDir()): ModelPolicy {
	let raw: string;
	try {
		raw = readFileSync(getModelPolicyPath(agentConfigDir), "utf8");
	} catch {
		return {};
	}
	try {
		const parsed = JSON.parse(raw);
		const models = parsed?.models;
		if (typeof models !== "object" || models === null || Array.isArray(models)) return {};
		const policy: ModelPolicy = {};
		for (const [ref, entry] of Object.entries(models as Record<string, unknown>)) {
			if (!isValidEntry(entry)) return {};
			policy[ref] = entry;
		}
		return policy;
	} catch {
		return {};
	}
}
