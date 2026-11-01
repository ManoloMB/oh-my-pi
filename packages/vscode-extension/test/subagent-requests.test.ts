import { describe, expect, it } from "bun:test";
import { SubagentRequestLog } from "../src/chat/subagent-requests";
import type { AgentMessage } from "../src/protocol";

const usage = { input: 100, output: 20, cacheRead: 5000, cacheWrite: 30, totalTokens: 5150, cost: { total: 0.01 } };

function assistant(content: unknown[], extra: Record<string, unknown> = {}): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "test",
		provider: "test",
		model: "m",
		usage,
		stopReason: "toolUse",
		timestamp: 1000,
		...extra,
	} as AgentMessage;
}

function result(toolCallId: string, isError = false): AgentMessage {
	return { role: "toolResult", toolCallId, toolName: "read", content: [], isError, timestamp: 2000 } as AgentMessage;
}

describe("SubagentRequestLog", () => {
	it("counts each assistant message as a request and marks the one whose tools still run as current", () => {
		const log = new SubagentRequestLog();
		log.append([
			{ role: "user", content: "task", timestamp: 0 } as AgentMessage,
			assistant([
				{ type: "text", text: "\n  Looking at the parser\nmore" },
				{ type: "toolCall", id: "a", name: "read", arguments: { i: "Reading parser", path: "src/parser.ts" } },
				{ type: "toolCall", id: "b", name: "grep", arguments: { pattern: "parse(" } },
			]),
			result("a"),
			result("b", true),
			assistant([{ type: "toolCall", id: "c", name: "bash", arguments: { command: "bun test\n--watch" } }]),
		]);

		const view = log.view(true);
		expect(view.waiting).toBe(false);
		expect(view.requests).toMatchObject([
			{
				index: 1,
				text: "Looking at the parser",
				tokens: 150,
				cost: 0.01,
				current: false,
				tools: [
					{ name: "read", label: "Reading parser", status: "done" },
					{ name: "grep", label: "parse(", status: "error" },
				],
			},
			{ index: 2, current: true, tools: [{ name: "bash", label: "bun test", status: "running" }] },
		]);

		// Its result arrives in a later read: the model is now answering the next request.
		log.append([result("c")]);
		expect(log.view(true)).toMatchObject({ waiting: true, requests: [{ current: false }, { current: false }] });
	});

	it("shows calls left without a result as interrupted once the agent ended, and reports a failed answer", () => {
		const log = new SubagentRequestLog();
		log.append([
			assistant([{ type: "toolCall", id: "a", name: "read", arguments: { path: "x" } }]),
			assistant([], { stopReason: "error", errorMessage: "529 overloaded" }),
		]);
		const view = log.view(false);
		expect(view.waiting).toBe(false);
		expect(view.requests[0]).toMatchObject({ current: false, tools: [{ status: "interrupted" }] });
		expect(view.requests[1].error).toBe("529 overloaded");

		log.reset();
		expect(log.view(true)).toEqual({ requests: [], waiting: true });
	});
});
