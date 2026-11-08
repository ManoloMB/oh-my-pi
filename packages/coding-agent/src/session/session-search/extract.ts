/**
 * Pure mapping from one session JSONL entry to the searchable docs it yields.
 * Credentials are redacted before truncation so a cut never leaves a partial
 * secret behind.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import { builtinCredentialSecretEntries } from "../../secrets";

export type SessionDocType = "user" | "assistant" | "thinking" | "tool_call" | "tool_result" | "summary" | "custom";

export interface ExtractedDoc {
	type: SessionDocType;
	toolName?: string;
	time: string;
	text: string;
	charLen: number;
}

const USER_CAP = 4000;
const ASSISTANT_CAP = 4000;
const THINKING_CAP = 2000;
// Tool-call args carry whole file bodies for write/edit; the searchable part
// (tool, paths, commands, patterns) sits at the front.
const TOOL_CALL_CAP = 600;
// Outputs put errors, failing assertions and summaries at the end as often as
// at the start, so a long result keeps both edges.
const TOOL_RESULT_EDGE = 500;
const SUMMARY_CAP = 4000;
const CUSTOM_CAP = 2000;

let credentialPatterns: RegExp[] | undefined;

function redact(text: string): string {
	credentialPatterns ??= builtinCredentialSecretEntries().map(
		entry => new RegExp(entry.content, entry.flags?.includes("g") ? entry.flags : `${entry.flags ?? ""}g`),
	);
	let out = text;
	for (const pattern of credentialPatterns) out = out.replace(pattern, "[redacted]");
	return out;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

function makeDoc(
	type: SessionDocType,
	raw: string,
	cap: number,
	time: string,
	toolName?: string,
	tailCap = 0,
): ExtractedDoc | undefined {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return undefined;
	const redacted = redact(trimmed);
	let text = redacted;
	if (redacted.length > cap + tailCap) {
		text = tailCap > 0 ? `${redacted.slice(0, cap)}\n…\n${redacted.slice(-tailCap)}` : redacted.slice(0, cap);
	}
	return { type, ...(toolName ? { toolName } : {}), time, text, charLen: redacted.length };
}

function entryTime(entry: Record<string, unknown>, message?: Record<string, unknown>): string {
	if (typeof entry.timestamp === "string") return entry.timestamp;
	if (message && typeof message.timestamp === "number") return new Date(message.timestamp).toISOString();
	return new Date(0).toISOString();
}

/** Searchable docs for one parsed JSONL line (`lineNo` is the 1-based physical line in the session file). */
export function extractDocs(entry: unknown, _lineNo: number, opts: { indexThinking: boolean }): ExtractedDoc[] {
	if (!isRecord(entry)) return [];
	const docs: Array<ExtractedDoc | undefined> = [];
	switch (entry.type) {
		case "message": {
			const message = entry.message;
			if (!isRecord(message)) return [];
			const time = entryTime(entry, message);
			if (message.role === "user") {
				docs.push(makeDoc("user", textOf(message.content), USER_CAP, time));
			} else if (message.role === "assistant" && Array.isArray(message.content)) {
				for (const block of message.content) {
					if (!isRecord(block)) continue;
					if (block.type === "text" && typeof block.text === "string") {
						docs.push(makeDoc("assistant", block.text, ASSISTANT_CAP, time));
					} else if (block.type === "thinking" && opts.indexThinking && typeof block.thinking === "string") {
						docs.push(makeDoc("thinking", block.thinking, THINKING_CAP, time));
					} else if (block.type === "toolCall" && typeof block.name === "string") {
						const args = JSON.stringify(block.arguments ?? {});
						docs.push(makeDoc("tool_call", `${block.name} ${args}`, TOOL_CALL_CAP, time, block.name));
					}
				}
			} else if (message.role === "toolResult") {
				const toolName = typeof message.toolName === "string" ? message.toolName : undefined;
				docs.push(
					makeDoc("tool_result", textOf(message.content), TOOL_RESULT_EDGE, time, toolName, TOOL_RESULT_EDGE),
				);
			}
			break;
		}
		case "compaction":
		case "branch_summary":
			if (typeof entry.summary === "string")
				docs.push(makeDoc("summary", entry.summary, SUMMARY_CAP, entryTime(entry)));
			break;
		case "custom_message":
			if (entry.display === true) {
				const customType = typeof entry.customType === "string" ? entry.customType : undefined;
				docs.push(makeDoc("custom", textOf(entry.content), CUSTOM_CAP, entryTime(entry), customType));
			}
			break;
	}
	return docs.filter(doc => doc !== undefined);
}
