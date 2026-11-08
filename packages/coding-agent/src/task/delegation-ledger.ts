/**
 * Append-only record of subagent delegations in the parent session. Survives
 * compaction (custom entries are never summarized away) and is re-injected as
 * a hidden ledger message after history rewrites so the parent does not
 * re-delegate work it no longer remembers.
 */
import type { CitationCounts, SingleResult, SubagentVerification } from "@oh-my-pi/pi-tui/tools/task";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import delegationLedgerTemplate from "../prompts/system/delegation-ledger.md" with { type: "text" };
import { escapeHarnessTags } from "../session/harness-tags";
import type { SessionEntry } from "../session/session-entries";

export const DELEGATION_CUSTOM_TYPE = "delegation";

const LEDGER_MAX_ITEMS = 30;

export type DelegationStatus = "running" | "completed" | "failed" | "cancelled";

export interface DelegationVerificationCounts {
	hold: number;
	notHold: number;
	unverified: number;
	citations?: CitationCounts;
}

export interface DelegationEntryData {
	v: 1;
	agentId: string;
	agent: string;
	toolCallId: string;
	description: string;
	status: DelegationStatus;
	verification?: DelegationVerificationCounts;
	at: number;
}

function isDelegationEntryData(value: unknown): value is DelegationEntryData {
	return (
		isRecord(value) &&
		value.v === 1 &&
		typeof value.agentId === "string" &&
		typeof value.agent === "string" &&
		typeof value.toolCallId === "string" &&
		typeof value.description === "string" &&
		(value.status === "running" ||
			value.status === "completed" ||
			value.status === "failed" ||
			value.status === "cancelled") &&
		(value.verification === undefined || isRecord(value.verification)) &&
		typeof value.at === "number"
	);
}

/** Latest entry per agent, newest first; malformed entries are skipped. */
export function deriveDelegations(entries: readonly SessionEntry[]): DelegationEntryData[] {
	const byAgent = new Map<string, DelegationEntryData>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== DELEGATION_CUSTOM_TYPE) continue;
		if (isDelegationEntryData(entry.data)) byAgent.set(entry.data.agentId, entry.data);
	}
	return [...byAgent.values()].sort((a, b) => b.at - a.at);
}

/** Distinct agents delegated after the last user message, ignoring entries of `excludeToolCallId`. */
export function countDelegationsSinceLastUserMessage(
	entries: readonly SessionEntry[],
	excludeToolCallId: string,
): number {
	let start = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message" && entry.message.role === "user") {
			start = i + 1;
			break;
		}
	}
	const agents = new Set<string>();
	for (let i = start; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== DELEGATION_CUSTOM_TYPE) continue;
		if (!isDelegationEntryData(entry.data) || entry.data.toolCallId === excludeToolCallId) continue;
		agents.add(entry.data.agentId);
	}
	return agents.size;
}

export function delegationVerificationCounts(
	v: SubagentVerification | undefined,
): DelegationVerificationCounts | undefined {
	if (!v) return undefined;
	const counts: DelegationVerificationCounts = { hold: 0, notHold: 0, unverified: 0 };
	for (const check of v.checks) {
		if (check.outcome === "holds") counts.hold++;
		else if (check.outcome === "does-not-hold") counts.notHold++;
		else counts.unverified++;
	}
	if (v.citations) counts.citations = { ...v.citations };
	return counts;
}

export function delegationStatus(result: SingleResult): Exclude<DelegationStatus, "running"> {
	if (result.aborted) return "cancelled";
	return result.exitCode === 0 && !result.error ? "completed" : "failed";
}

export function renderDelegationLedger(delegations: readonly DelegationEntryData[]): string | undefined {
	if (delegations.length === 0) return undefined;
	return prompt.render(delegationLedgerTemplate, {
		delegations: delegations.slice(0, LEDGER_MAX_ITEMS).map(delegation => ({
			status: delegation.status,
			statusRunning: delegation.status === "running",
			agentId: delegation.agentId,
			agent: delegation.agent,
			description: escapeHarnessTags(delegation.description),
			verification: delegation.verification,
		})),
		omitted: Math.max(0, delegations.length - LEDGER_MAX_ITEMS),
	});
}
