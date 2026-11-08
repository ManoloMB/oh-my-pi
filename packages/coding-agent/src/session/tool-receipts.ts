/**
 * Per-tool-call receipts for subagent sessions. Each completed tool call in a
 * child session is numbered (`r1`, `r2`, …) and persisted as an append-only
 * custom entry, so the parent can cross-check the child's cited claims and
 * acceptance criteria against what actually ran.
 */
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { BashToolDetails } from "@oh-my-pi/pi-tui/tools/bash";
import type { CitationCounts, ReceiptTestOutcome, ToolReceipt } from "@oh-my-pi/pi-tui/tools/task";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "./session-entries";

export const TOOL_RECEIPT_CUSTOM_TYPE = "tool_receipt";

const COMMAND_MAX_CHARS = 400;
const TEST_SCAN_CHARS = 16_000;

const FAIL_SHAPES: readonly RegExp[] = [
	/\b[1-9]\d*\s+(?:failed|failing|fail|errors?)\b/i,
	/^FAIL(?:ED)?\b/m,
	/^--- FAIL/m,
];

const PASS_SHAPES: readonly RegExp[] = [
	/\b[1-9]\d*\s+(?:passed|passing|pass)\b/i,
	/\ball tests passed\b/i,
	/^ok\s+\S/m,
	/^OK(?:\s+\(.*\))?\s*$/m,
];

export const RECEIPT_CITATION_RE = /\[r([1-9]\d{0,6})(?:\s+([A-Za-z_][\w.-]*))?\]/g;

function isTestOutcome(value: unknown): value is ReceiptTestOutcome {
	return value === "passed" || value === "failed" || value === "none";
}

function isReceipt(value: unknown): value is ToolReceipt {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.toolCallId === "string" &&
		typeof value.toolName === "string" &&
		typeof value.seq === "number" &&
		(value.status === "ok" || value.status === "error") &&
		(value.command === undefined || typeof value.command === "string") &&
		(value.exitCode === undefined || typeof value.exitCode === "number") &&
		(value.testOutcome === undefined || isTestOutcome(value.testOutcome))
	);
}

/** Receipts recorded in `entries`, in log order; malformed entries are skipped. */
export function deriveToolReceipts(entries: readonly SessionEntry[]): ToolReceipt[] {
	const receipts: ToolReceipt[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== TOOL_RECEIPT_CUSTOM_TYPE) continue;
		if (isReceipt(entry.data)) receipts.push(entry.data);
	}
	return receipts;
}

function textOf(content: AgentToolResult<unknown>["content"]): string {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push(block.text);
	}
	return parts.join("\n");
}

/** Classify a test run's output by its summary shape; errors always count as failed. */
export function classifyTestOutcome(text: string, isError: boolean): ReceiptTestOutcome {
	if (isError) return "failed";
	const tail = text.length > TEST_SCAN_CHARS ? text.slice(-TEST_SCAN_CHARS) : text;
	if (FAIL_SHAPES.some(re => re.test(tail))) return "failed";
	if (PASS_SHAPES.some(re => re.test(tail))) return "passed";
	return "none";
}

export function mintToolReceipt(input: {
	seq: number;
	toolCallId: string;
	toolName: string;
	isError: boolean;
	args: Record<string, unknown>;
	result: AgentToolResult<unknown>;
}): ToolReceipt {
	const receipt: ToolReceipt = {
		id: `r${input.seq}`,
		seq: input.seq,
		toolCallId: input.toolCallId,
		toolName: input.toolName,
		status: input.isError ? "error" : "ok",
		at: Date.now(),
	};
	if (input.toolName === "bash") {
		const command = input.args.command;
		if (typeof command === "string") {
			receipt.command = command.replace(/\s+/g, " ").trim().slice(0, COMMAND_MAX_CHARS);
		}
		const exitCode = (input.result.details as BashToolDetails | undefined)?.exitCode;
		if (typeof exitCode === "number") receipt.exitCode = exitCode;
		receipt.testOutcome = classifyTestOutcome(textOf(input.result.content), input.isError);
	}
	return receipt;
}

/** Citations `[rN]` / `[rN tool]` in `text`, deduplicated by id + anchor, first-seen order. */
export function parseReceiptCitations(text: string): Array<{ id: string; anchor?: string }> {
	const seen = new Set<string>();
	const citations: Array<{ id: string; anchor?: string }> = [];
	for (const match of text.matchAll(RECEIPT_CITATION_RE)) {
		const id = `r${match[1]}`;
		const anchor = match[2];
		const key = `${id}\u0000${anchor ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		citations.push(anchor === undefined ? { id } : { id, anchor });
	}
	return citations;
}

export function verifyReceiptCitations(text: string, receipts: readonly ToolReceipt[]): CitationCounts {
	const byId = new Map(receipts.map(receipt => [receipt.id, receipt]));
	const citations = parseReceiptCitations(text);
	const counts: CitationCounts = { cited: citations.length, resolved: 0, failed: 0, unknown: 0 };
	for (const citation of citations) {
		const receipt = byId.get(citation.id);
		if (!receipt) counts.unknown++;
		else if (receipt.status === "error" || (citation.anchor !== undefined && citation.anchor !== receipt.toolName))
			counts.failed++;
		else counts.resolved++;
	}
	return counts;
}
