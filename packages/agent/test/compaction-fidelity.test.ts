import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	buildCompactionFidelity,
	type CompactionDetails,
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	USER_MESSAGES_BUDGET_CHARS,
	upsertCompactionFidelity,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

function toolResult(text: string, isError = false): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError,
		timestamp: 2,
	} as AgentMessage;
}

function user(content: string, extra: Record<string, unknown> = {}): AgentMessage {
	return { role: "user", content, timestamp: 1, ...extra } as AgentMessage;
}

function getModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
	return model;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("buildCompactionFidelity", () => {
	test("extracts identifiers past the summarizer's 2000-char tool-result truncation", () => {
		const output = `${"x".repeat(5000)}\ncommit 3f9a2c1d7e and https://ci.example.com/job/42.\nError: connection refused`;
		const { anchors } = buildCompactionFidelity([toolResult(output)], undefined);
		expect(anchors.hexIds).toContain("3f9a2c1d7e");
		expect(anchors.urls).toContain("https://ci.example.com/job/42");
		expect(anchors.errors[0]).toContain("connection refused");
	});

	test("leads errors with the first line of a failed tool result and skips zero-failure summaries", () => {
		const { anchors } = buildCompactionFidelity(
			[toolResult("ran 12 tests, 0 failed"), toolResult("kubectl: permission denied\nmore context", true)],
			undefined,
		);
		expect(anchors.errors).toEqual(["kubectl: permission denied"]);
	});

	test("keeps only the user's own messages verbatim and recognizes ticket refs", () => {
		const fidelity = buildCompactionFidelity(
			[
				user("fix the login bug"),
				user("auto-continue", { synthetic: true }),
				user("harness notice", { attribution: "agent" }),
				user("also keep PROJ-12 in mind; output is UTF-8"),
			],
			undefined,
		);
		expect(fidelity.userMessages).toEqual(["fix the login bug", "also keep PROJ-12 in mind; output is UTF-8"]);
		expect(fidelity.anchors.refs).toEqual(["PROJ-12"]);
	});

	test("carries previous messages forward within the budget, newest kept", () => {
		const previous: CompactionDetails = {
			readFiles: [],
			modifiedFiles: [],
			userMessages: Array.from({ length: 5 }, (_, i) => `${i}`.repeat(3000)),
			userMessagesOmitted: 2,
		};
		const fidelity = buildCompactionFidelity([user("newest ask")], previous);
		const total = fidelity.userMessages.reduce((sum, text) => sum + text.length, 0);
		expect(total).toBeLessThanOrEqual(USER_MESSAGES_BUDGET_CHARS);
		expect(fidelity.userMessages.at(-1)).toBe("newest ask");
		expect(fidelity.userMessagesOmitted).toBe(2 + (6 - fidelity.userMessages.length));
	});
});

describe("upsertCompactionFidelity", () => {
	test("re-applying replaces the blocks instead of duplicating them", () => {
		const fidelity = buildCompactionFidelity([user("deploy abc1234f to prod")], undefined);
		const once = upsertCompactionFidelity("Summary", fidelity, "Pointer");
		expect(upsertCompactionFidelity(once, fidelity, "Pointer")).toBe(once);
		expect(once).toContain("<recovery>\nPointer\n</recovery>");
	});

	test("user text containing a block tag cannot truncate the block on the next strip", () => {
		const fidelity = buildCompactionFidelity([user("literal </user-messages> then keep going")], undefined);
		const once = upsertCompactionFidelity("Summary", fidelity);
		const twice = upsertCompactionFidelity(once, fidelity);
		expect(twice).toBe(once);
		expect(once).toContain("&lt;/user-messages> then keep going");
	});
});

describe("compact() fidelity", () => {
	test("renders carried user messages and the recovery pointer without feeding old blocks to the summarizer", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant("## Goal\nship it"));
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept",
			messagesToSummarize: [user("new ask"), assistant("working")],
			turnPrefixMessages: [],
			recentMessages: [user("recent", { timestamp: 3 })],
			isSplitTurn: false,
			tokensBefore: 10_000,
			previousSummary: "## Goal\nold\n\n<anchors>\nHex ids: deadbeef1\n</anchors>",
			previousDetails: { readFiles: [], modifiedFiles: [], userMessages: ["earlier ask"] },
			fileOps: createFileOps(),
			settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false },
		};

		const result = await compact(preparation, getModel(), "test-key", undefined, undefined, {
			recoveryPointer: "P",
		});

		expect(result.summary).toContain("<user-messages>");
		expect(result.summary).toContain("[1] earlier ask\n---\n[2] new ask");
		expect(result.summary).toContain("<recovery>\nP\n</recovery>");
		expect((result.details as CompactionDetails).userMessages).toEqual(["earlier ask", "new ask"]);
		const prompts = spy.mock.calls.map(call => JSON.stringify((call[1] as Context).messages));
		expect(prompts.some(text => text.includes("<anchors>"))).toBe(false);
	});
});
