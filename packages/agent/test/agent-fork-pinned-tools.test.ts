import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AssistantMessage, Message, Tool, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Agent } from "../src/agent";
import type { AgentTool } from "../src/types";

const spec: ModelSpec<"anthropic-messages"> = {
	id: "claude-fable-5",
	name: "Claude Fable 5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
};
const MODEL = buildModel(spec);
const SYSTEM = ["Parent system prompt.", "Project context block."];

type WireMessage = { role: string; content: unknown };
type Payload = {
	system?: unknown;
	messages: WireMessage[];
	tools?: { name: string; defer_loading?: boolean }[];
};

function agentTool(name: string, description = `${name} tool`): AgentTool {
	return {
		name,
		label: name,
		description,
		parameters: type({ arg: type("string") }) as unknown as AgentTool["parameters"],
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
}

let clock = 1;
function user(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], attribution: "user", timestamp: clock++ };
}
function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: MODEL.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: clock++,
	};
}
function toolResult(toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: "export const a = 1;" }],
		isError: false,
		timestamp: clock++,
	};
}

/** `message` as the response to the request that produced `reply` (its `requestControls`). */
function answering<T extends AssistantMessage>(message: T, reply: AssistantMessage): T {
	return { ...message, requestControls: reply.requestControls };
}

/** Cache breakpoints move with the request; everything else must be byte-identical. */
function withoutCacheControl(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutCacheControl);
	if (value && typeof value === "object") {
		const source = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key in source) {
			if (key !== "cache_control") out[key] = withoutCacheControl(source[key]);
		}
		return out;
	}
	return value;
}

function referencesTool(messages: WireMessage[], blockType: string, name: string): boolean {
	return messages.some(
		message =>
			Array.isArray(message.content) &&
			message.content.some(
				(block: { type?: string; tool?: { type?: string; name?: string } }) =>
					block.type === blockType && block.tool?.type === "tool_reference" && block.tool.name === name,
			),
	);
}

/**
 * Builds every request through the real Anthropic param path; a pre-aborted
 * signal stops it before any network I/O. Returns the captured payloads and the
 * terminal messages (which carry the request's `requestControls`).
 */
function capturingAgent(options: {
	tools: AgentTool[];
	messages?: Message[];
	pinnedToolDefinitions?: readonly Tool[];
}): { agent: Agent; payloads: Payload[]; replies: () => Promise<AssistantMessage[]> } {
	const payloads: Payload[] = [];
	const streams: AssistantMessageEventStream[] = [];
	const agent = new Agent({
		initialState: { model: MODEL, systemPrompt: SYSTEM, tools: options.tools, messages: options.messages ?? [] },
		pinnedToolDefinitions: options.pinnedToolDefinitions,
		// Only the request shape matters; caller options stay out so both agents build alike.
		streamFn: (_model, context) => {
			const controller = new AbortController();
			controller.abort();
			const stream = streamAnthropic(MODEL, context, {
				apiKey: "sk-ant-test",
				signal: controller.signal,
				onPayload: captured => {
					payloads.push(captured as Payload);
				},
			});
			streams.push(stream);
			return stream;
		},
	});
	return { agent, payloads, replies: () => Promise.all(streams.map(stream => stream.result())) };
}

describe("Agent — pinned tool definitions for forked children", () => {
	let previousDialect: string | undefined;
	beforeEach(() => {
		previousDialect = Bun.env.PI_DIALECT;
		delete Bun.env.PI_DIALECT;
	});
	afterEach(() => {
		if (previousDialect === undefined) delete Bun.env.PI_DIALECT;
		else Bun.env.PI_DIALECT = previousDialect;
	});

	async function runParent() {
		const parentTools = [agentTool("read"), agentTool("grep"), agentTool("todo")];
		const parent = capturingAgent({ tools: parentTools });
		await parent.agent.prompt("start");
		const [turn1] = await parent.replies();
		if (!turn1) throw new Error("expected the first parent request");

		const toolCallTurn = answering(
			assistant([{ type: "toolCall", id: "toolu_read_1", name: "read", arguments: { arg: "a.ts" } }], "toolUse"),
			turn1,
		);
		const history: Message[] = [user("start"), toolCallTurn, toolResult("toolu_read_1")];
		parent.agent.replaceMessages(history);
		await parent.agent.continue();
		const replies = await parent.replies();
		const turn2 = replies[1];
		const p1 = parent.payloads[1];
		if (!turn2 || !p1) throw new Error("expected the second parent request");
		return { history, turn2, p1, snapshot: parent.agent.getSentToolDefinitions() };
	}

	function childMessages(history: Message[], turn2: AssistantMessage): Message[] {
		return [...history, answering(assistant([{ type: "text", text: "ready" }], "stop"), turn2)];
	}

	const childTools = () => [
		agentTool("read", "read tool as rendered for a subagent"),
		agentTool("grep"),
		agentTool("yield"),
	];

	it("sends the parent's system, tools and messages as a byte-identical prefix", async () => {
		expect(MODEL.compat.supportsMidConversationToolChanges).toBe(true);
		const { history, turn2, p1, snapshot } = await runParent();
		expect(snapshot.map(tool => tool.name)).toEqual(["read", "grep", "todo"]);

		const child = capturingAgent({
			tools: childTools(),
			messages: childMessages(history, turn2),
			pinnedToolDefinitions: snapshot,
		});
		await child.agent.prompt("review the change");
		const p2 = child.payloads[0];
		if (!p2) throw new Error("expected the child request");

		expect(p2.system).toEqual(p1.system);

		const p2Tools = p2.tools ?? [];
		const nonDeferred = p2Tools.filter(tool => tool.defer_loading !== true);
		expect(withoutCacheControl(nonDeferred)).toEqual(withoutCacheControl(p1.tools));
		expect(p2Tools.filter(tool => tool.name === "yield")).toHaveLength(1);
		expect(p2Tools.at(-1)?.name).toBe("yield");
		expect(p2Tools.at(-1)?.defer_loading).toBe(true);

		const serialize = (message: WireMessage) => JSON.stringify(withoutCacheControl(message));
		expect(p2.messages.slice(0, p1.messages.length).map(serialize)).toEqual(p1.messages.map(serialize));
		const tail = p2.messages.slice(p1.messages.length);
		expect(referencesTool(tail, "tool_addition", "yield")).toBe(true);
		expect(referencesTool(tail, "tool_removal", "todo")).toBe(true);
	});

	it("misses the parent's tool bytes without pinned definitions", async () => {
		const { history, turn2, p1 } = await runParent();
		const child = capturingAgent({ tools: childTools(), messages: childMessages(history, turn2) });
		await child.agent.prompt("review the change");
		const p2 = child.payloads[0];
		if (!p2) throw new Error("expected the child request");
		const nonDeferred = (p2.tools ?? []).filter(tool => tool.defer_loading !== true);
		expect(withoutCacheControl(nonDeferred)).not.toEqual(withoutCacheControl(p1.tools));
	});
});
