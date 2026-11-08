import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	generateHandoff,
	generateSummary,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model, StopReason } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

function createAssistantMessage(text: string, stopReason: StopReason = "stop"): AssistantMessage {
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
		stopReason,
	};
}

function getModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
	return model;
}

const messages: AgentMessage[] = [
	{ role: "user", content: "start work", timestamp: 1 },
	createAssistantMessage("started"),
];

afterEach(() => {
	vi.restoreAllMocks();
});

describe("compaction rejects truncated summaries", () => {
	test("generateSummary retries once with a doubled budget and no reasoning", async () => {
		const model = getModel();
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(createAssistantMessage("cut off mid", "length"))
			.mockResolvedValueOnce(createAssistantMessage("full"));

		const summary = await generateSummary(messages, model, 10_000, "test-key");

		expect(summary).toBe("full");
		expect(spy).toHaveBeenCalledTimes(2);
		const firstMaxTokens = spy.mock.calls[0]?.[2]?.maxTokens;
		if (firstMaxTokens === undefined) throw new Error("expected a maxTokens on the first call");
		expect(spy.mock.calls[0]?.[2]?.reasoning).toBe(ai.Effort.High);
		expect(spy.mock.calls[1]?.[2]?.maxTokens).toBe(
			Math.min(firstMaxTokens * 2, model.maxTokens ?? firstMaxTokens * 2),
		);
		expect(spy.mock.calls[1]?.[2]?.reasoning).toBeUndefined();
	});

	test("generateSummary rejects a summary truncated twice without signalling input overflow", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("cut off mid", "length"));

		let caught: unknown;
		try {
			await generateSummary(messages, getModel(), 10_000, "test-key");
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toMatch(/Summarization failed: summary output truncated/);
		expect(AIError.is(AIError.classify(caught), AIError.Flag.ContextOverflow)).toBe(false);
		// Exactly one retry, and no input-halving loop on top of it.
		expect(spy).toHaveBeenCalledTimes(2);
	});

	test("generateHandoff rejects a handoff truncated twice", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("cut off mid", "length"));

		await expect(
			generateHandoff(messages, getModel(), "test-key", { systemPrompt: ["sp"], tools: [] }),
		).rejects.toThrow(/Handoff generation failed: summary output truncated/);
		expect(spy).toHaveBeenCalledTimes(2);
	});

	test("compact() keeps a still-truncated short summary instead of failing", async () => {
		// Short summary asks for 512 tokens and retries at 1024; the other two
		// summarizers ask for far more under this reserve.
		const spy = vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, _context, opts) => {
			const maxTokens = opts?.maxTokens ?? Number.POSITIVE_INFINITY;
			return maxTokens <= 1024
				? createAssistantMessage("short cut off", "length")
				: createAssistantMessage("summary");
		});
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept",
			messagesToSummarize: messages,
			turnPrefixMessages: [{ role: "user", content: "continue", timestamp: 2 }],
			recentMessages: [{ role: "user", content: "recent", timestamp: 3 }],
			isSplitTurn: true,
			tokensBefore: 900_000,
			fileOps: createFileOps(),
			settings: { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 150_000, remoteEnabled: false },
		};

		const result = await compact(preparation, getModel(), "test-key");

		expect(result.shortSummary).toBe("short cut off");
		const shortBudgets = spy.mock.calls.map(call => call[2]?.maxTokens).filter(budget => (budget ?? 0) <= 1024);
		expect(shortBudgets.sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([512, 1024]);
	});
});
