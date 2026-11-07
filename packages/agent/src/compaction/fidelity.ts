/**
 * Mechanical fidelity blocks appended to local compaction summaries.
 *
 * LLM summaries paraphrase, and the summarizer only sees tool results
 * truncated to a few thousand characters. These blocks carry what must survive
 * verbatim — exact identifiers from the full, untruncated history and the
 * user's own words — plus a pointer to where the uncompacted history lives.
 */

import { prompt, stringifyJson } from "@oh-my-pi/pi-utils";
import type { AgentMessage } from "../types";
import type { CompactionDetails } from "./compaction";
import compactionFidelityTemplate from "./prompts/compaction-fidelity.md" with { type: "text" };

export const ANCHOR_LIMITS = { errors: 15, hexIds: 20, refs: 20, urls: 15 } as const;
export const USER_MESSAGE_MAX_CHARS = 3000;
export const USER_MESSAGES_BUDGET_CHARS = 12000;

export interface CompactionAnchors {
	errors: string[];
	hexIds: string[];
	refs: string[];
	urls: string[];
}

export interface CompactionFidelity {
	anchors: CompactionAnchors;
	userMessages: string[];
	userMessagesOmitted: number;
}

type AnchorCategory = keyof CompactionAnchors;

const ANCHOR_CATEGORIES: readonly AnchorCategory[] = ["errors", "hexIds", "refs", "urls"];

const HEX_RE = /\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b/g;
const REF_HASH_RE = /(?<![\w&#/])#\d{1,7}\b/g;
const REF_KEY_RE = /\b[A-Z][A-Z0-9]{1,9}-\d{1,7}\b/g;
const REF_KEY_STOPLIST = new Set(["UTF", "SHA", "ISO", "AES", "RSA", "HTTP", "TLS", "SSL", "IPV", "MD"]);
const URL_RE = /\bhttps?:\/\/[^\s<>"'`\])}]+/g;
const URL_TRAILING_PUNCTUATION_RE = /[.,;:!?]+$/;
const ERROR_LINE_RE =
	/\b(?:error|exception|fatal|panic|traceback|failed|failure|denied|refused|timed out|timeout|oomkilled|crashloopbackoff|segmentation fault|exit (?:code|status) [1-9]\d*)\b/i;
const ERROR_NOISE_RE = /\b0 (?:failed|failures|errors?)\b/i;
const ERROR_LINE_MAX_CHARS = 200;

/** Tags whose literal occurrence inside user text would break a later strip of these blocks or `<files>`. */
const FIDELITY_TAG_RE = /<\s*\/?\s*(?:anchors|user-messages|recovery|files|read-files|modified-files)\s*>/gi;
const FIDELITY_BLOCK_RE = /<(anchors|user-messages|recovery)>[\s\S]*?<\/\1>\s*/g;

function blockText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null || !("type" in block)) continue;
		if (block.type === "text" && "text" in block && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "image") parts.push("[image]");
	}
	return parts.join("\n");
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeErrorLine(line: string): string {
	const collapsed = line.trim().replace(/\s+/g, " ");
	return collapsed.length > ERROR_LINE_MAX_CHARS ? `${collapsed.slice(0, ERROR_LINE_MAX_CHARS)}…` : collapsed;
}

function collectUserMessages(
	messages: readonly AgentMessage[],
	previous: CompactionDetails | undefined,
): { userMessages: string[]; userMessagesOmitted: number } {
	const newTexts: string[] = [];
	for (const message of messages) {
		if (message.role !== "user") continue;
		if ("synthetic" in message && message.synthetic === true) continue;
		if ("attribution" in message && message.attribution === "agent") continue;
		const text = blockText(message.content);
		if (text.trim().length === 0) continue;
		newTexts.push(
			text.length <= USER_MESSAGE_MAX_CHARS
				? text
				: `${text.slice(0, USER_MESSAGE_MAX_CHARS)}\n[… ${text.length - USER_MESSAGE_MAX_CHARS} chars truncated …]`,
		);
	}
	const combined = [...stringArray(previous?.userMessages), ...newTexts];
	const kept: string[] = [];
	let total = 0;
	for (let i = combined.length - 1; i >= 0; i--) {
		const text = combined[i];
		if (kept.length > 0 && total + text.length > USER_MESSAGES_BUDGET_CHARS) break;
		kept.push(text);
		total += text.length;
	}
	kept.reverse();
	const previousOmitted = typeof previous?.userMessagesOmitted === "number" ? previous.userMessagesOmitted : 0;
	return { userMessages: kept, userMessagesOmitted: previousOmitted + (combined.length - kept.length) };
}

/** Segments of one message scanned for anchors, plus whether they are tool output. */
function messageSegments(message: AgentMessage): { text: string; toolOutput: boolean }[] {
	if (!("content" in message)) return [];
	switch (message.role) {
		case "user":
			return [{ text: blockText(message.content), toolOutput: false }];
		case "assistant": {
			if (!Array.isArray(message.content)) return [];
			const segments: { text: string; toolOutput: boolean }[] = [];
			for (const block of message.content) {
				if (block.type === "text") segments.push({ text: block.text, toolOutput: false });
				else if (block.type === "toolCall") {
					segments.push({ text: stringifyJson(block.arguments) ?? "", toolOutput: false });
				}
			}
			return segments;
		}
		case "toolResult":
			return [{ text: blockText(message.content), toolOutput: true }];
		default:
			return [];
	}
}

function messageAnchors(message: AgentMessage): CompactionAnchors {
	const found: CompactionAnchors = { errors: [], hexIds: [], refs: [], urls: [] };
	if (message.role === "toolResult" && "isError" in message && message.isError === true) {
		const firstLine = blockText(message.content)
			.split("\n")
			.find(line => line.trim().length > 0);
		if (firstLine) found.errors.push(normalizeErrorLine(firstLine));
	}
	for (const { text, toolOutput } of messageSegments(message)) {
		if (!text) continue;
		for (const match of text.matchAll(HEX_RE)) found.hexIds.push(match[0]);
		for (const match of text.matchAll(REF_HASH_RE)) found.refs.push(match[0]);
		for (const match of text.matchAll(REF_KEY_RE)) {
			const prefix = match[0].slice(0, match[0].indexOf("-"));
			if (!REF_KEY_STOPLIST.has(prefix)) found.refs.push(match[0]);
		}
		for (const match of text.matchAll(URL_RE)) {
			const url = match[0].replace(URL_TRAILING_PUNCTUATION_RE, "");
			if (url.length > 0) found.urls.push(url);
		}
		if (toolOutput) {
			for (const line of text.split("\n")) {
				if (ERROR_LINE_RE.test(line) && !ERROR_NOISE_RE.test(line)) found.errors.push(normalizeErrorLine(line));
			}
		}
	}
	return found;
}

function collectAnchors(messages: readonly AgentMessage[], previous: CompactionDetails | undefined): CompactionAnchors {
	const anchors: CompactionAnchors = { errors: [], hexIds: [], refs: [], urls: [] };
	const seen: Record<AnchorCategory, Set<string>> = {
		errors: new Set(),
		hexIds: new Set(),
		refs: new Set(),
		urls: new Set(),
	};
	const add = (category: AnchorCategory, value: string): void => {
		if (anchors[category].length >= ANCHOR_LIMITS[category] || seen[category].has(value)) return;
		seen[category].add(value);
		anchors[category].push(value);
	};
	for (let i = messages.length - 1; i >= 0; i--) {
		const found = messageAnchors(messages[i]);
		for (const category of ANCHOR_CATEGORIES) {
			// The isError first line leads the error list; later matches rank first within the message.
			const values =
				category === "errors" && messages[i].role === "toolResult" && found.errors.length > 0
					? [found.errors[0], ...found.errors.slice(1).reverse()]
					: [...found[category]].reverse();
			for (const value of values) add(category, value);
		}
	}
	const previousAnchors = previous?.anchors as Partial<Record<AnchorCategory, unknown>> | undefined;
	for (const category of ANCHOR_CATEGORIES) {
		for (const value of stringArray(previousAnchors?.[category])) add(category, value);
	}
	return anchors;
}

/**
 * Build the fidelity record for the messages a compaction is about to discard,
 * merged with the record carried by the previous compaction.
 */
export function buildCompactionFidelity(
	messages: readonly AgentMessage[],
	previous: CompactionDetails | undefined,
): CompactionFidelity {
	return { anchors: collectAnchors(messages, previous), ...collectUserMessages(messages, previous) };
}

function escapeFidelityTags(text: string): string {
	return text.replace(FIDELITY_TAG_RE, tag => `&lt;${tag.slice(1)}`);
}

/** Remove previously rendered fidelity blocks from a summary. */
export function stripCompactionFidelityBlocks(summary: string): string {
	return summary.replace(FIDELITY_BLOCK_RE, "").trimEnd();
}

/** Replace the summary's fidelity blocks with freshly rendered ones. */
export function upsertCompactionFidelity(
	summary: string,
	fidelity: CompactionFidelity,
	recoveryPointer?: string,
): string {
	const base = stripCompactionFidelityBlocks(summary);
	const { anchors } = fidelity;
	const list = (values: string[]): string => values.map(value => `- ${escapeFidelityTags(value)}`).join("\n");
	const inline = (values: string[]): string => values.map(escapeFidelityTags).join(", ");
	const block = prompt
		.render(compactionFidelityTemplate, {
			hasAnchors: ANCHOR_CATEGORIES.some(category => anchors[category].length > 0),
			errors: list(anchors.errors),
			hexIds: inline(anchors.hexIds),
			refs: inline(anchors.refs),
			urls: list(anchors.urls),
			userMessages: fidelity.userMessages
				.map((text, index) => `[${index + 1}] ${escapeFidelityTags(text)}`)
				.join("\n---\n"),
			omitted: fidelity.userMessagesOmitted,
			recovery: recoveryPointer ?? "",
		})
		.trim();
	if (!block) return base;
	return base ? `${base}\n\n${block}` : block;
}
