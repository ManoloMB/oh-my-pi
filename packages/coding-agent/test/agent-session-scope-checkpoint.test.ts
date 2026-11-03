import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AsideMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * User-requested scope checkpoint: never sent on its own; the user sends one at
 * a level (light, severe, hard) and it lands, hidden, at the next tool-round
 * boundary of the running request, never at the stop boundary. The session
 * also reports the request's active time and tool rounds for the user to judge.
 *
 * Drives the aside provider directly, as the agent loop polls it between tool
 * rounds, with a mocked clock.
 */
const sharedAuthStorage = createInMemoryAuthStorage();
sharedAuthStorage.keys.setRuntime("anthropic", "test-key");
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage);

afterAll(() => {
	sharedAuthStorage.close();
});

const MINUTE = 60_000;

describe("AgentSession scope checkpoint", () => {
	let tempDir: TempDir | undefined;
	let session: AgentSession | undefined;
	let asideProvider: (() => AsideMessage[] | Promise<AsideMessage[]>) | undefined;
	let clock = 0;

	function setup(agentKind: "main" | "sub" = "main"): AgentSession {
		clock = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		tempDir = TempDir.createSync("@pi-scope-checkpoint-");
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		asideProvider = undefined;
		const originalSet = agent.setAsideMessageProvider.bind(agent);
		agent.setAsideMessageProvider = (fn): void => {
			if (fn !== undefined && asideProvider === undefined) asideProvider = fn;
			originalSet(fn);
		};
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry: sharedModelRegistry, agentKind });
		session.agent.emitExternalEvent({ type: "agent_start" });
		return session;
	}

	/** A running request; the instance property shadows the prototype getter for this test only. */
	function streaming(): void {
		Object.defineProperty(session!, "isStreaming", { get: () => true, configurable: true });
	}

	function assistant(stopReason: "toolUse" | "stop", calls = 1): AssistantMessage {
		return {
			role: "assistant",
			content:
				stopReason === "toolUse"
					? Array.from({ length: calls }, () => ({
							type: "toolCall" as const,
							id: `call_${Math.random()}`,
							name: "read",
							arguments: {},
						}))
					: [{ type: "text", text: "done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: clock,
		};
	}

	function rounds(count: number): void {
		for (let i = 0; i < count; i++) {
			session!.agent.emitExternalEvent({ type: "message_end", message: assistant("toolUse") });
			session!.agent.emitExternalEvent({
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId: `call_${i}`,
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: clock,
				},
			});
		}
	}

	async function drain(customType = "scope-checkpoint"): Promise<CustomMessage[]> {
		if (!asideProvider) throw new Error("aside provider was never captured");
		const out: CustomMessage[] = [];
		for (const entry of await asideProvider()) {
			const message = typeof entry === "function" ? entry() : entry;
			if (message?.role === "custom" && (message as CustomMessage).customType === customType) {
				out.push(message as CustomMessage);
			}
		}
		return out;
	}

	const text = (message: CustomMessage | undefined): string =>
		typeof message?.content === "string" ? message.content : "";

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		try {
			await tempDir?.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("never sends a checkpoint on its own, however long the run", async () => {
		setup();
		rounds(50);
		clock += 60 * MINUTE;
		expect(await drain()).toEqual([]);
	});

	it("delivers a requested checkpoint once, hidden, at the next tool round, never at the stop boundary", async () => {
		setup();
		streaming();
		rounds(6);
		expect(session!.requestScopeCheckpoint("light")).toBe(true);
		session!.agent.emitExternalEvent({ type: "message_end", message: assistant("stop") });
		expect(await drain()).toEqual([]);

		rounds(1);
		const delivered = await drain();
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.display).toBe(false);
		expect(text(delivered[0])).toContain("7 tool rounds");
		expect(text(delivered[0])).toContain("asked you to hurry");
		expect(text(delivered[0])).not.toContain("Stop iterating now");
		expect(await drain()).toEqual([]);
	});

	it("words each level by its strength", async () => {
		setup();
		streaming();
		rounds(1);
		session!.requestScopeCheckpoint("severe");
		const severe = text((await drain())[0]);
		expect(severe).toContain("pressing seriously to finish");
		expect(severe).not.toContain("Stop iterating now");

		session!.requestScopeCheckpoint("hard");
		const hard = text((await drain())[0]);
		expect(hard).toContain("Stop iterating now");
		expect(hard).toContain("last tool calls");
		expect(hard).not.toContain("pressing seriously");
	});

	it("lets a firmer pending level replace a lighter one, never the reverse", async () => {
		setup();
		streaming();
		rounds(1);
		session!.requestScopeCheckpoint("light");
		session!.requestScopeCheckpoint("hard");
		session!.requestScopeCheckpoint("severe");
		const delivered = await drain();
		expect(delivered).toHaveLength(1);
		expect(text(delivered[0])).toContain("Stop iterating now");
	});

	it("refuses a checkpoint when no request is running", async () => {
		setup();
		rounds(1);
		expect(session!.requestScopeCheckpoint("hard")).toBe(false);
		expect(await drain()).toEqual([]);
	});

	it("reports active time without time blocked on ask or between runs, tool rounds, and tool calls", () => {
		setup();
		rounds(3);
		clock += MINUTE;
		session!.agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "ask_1",
			toolName: "ask",
			args: {},
		});
		clock += 3 * MINUTE;
		// Still answering: the open wait is excluded too.
		expect(session!.getScopeCheckpointStats()).toEqual({
			running: false,
			activeMs: MINUTE,
			toolRounds: 3,
			toolCalls: 3,
		});
		session!.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: "ask_1",
			toolName: "ask",
			result: {},
		});
		clock += MINUTE;
		session!.agent.emitExternalEvent({ type: "agent_end", messages: [] });
		clock += 55 * MINUTE;
		session!.agent.emitExternalEvent({ type: "agent_start" });
		rounds(2);
		// One turn running three tools in parallel: one round, three calls.
		session!.agent.emitExternalEvent({ type: "message_end", message: assistant("toolUse", 3) });
		clock += MINUTE / 2;
		streaming();
		expect(session!.getScopeCheckpointStats()).toEqual({
			running: true,
			activeMs: 2.5 * MINUTE,
			toolRounds: 6,
			toolCalls: 8,
		});
	});

	it("delivers a requested wrap-up at the next tool round, once", async () => {
		setup("sub");
		streaming();
		expect(session!.requestWrapUp()).toBe(true);
		session!.agent.emitExternalEvent({ type: "message_end", message: assistant("stop") });
		expect(await drain("wrap-up-request")).toEqual([]);

		rounds(1);
		const delivered = await drain("wrap-up-request");
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.display).toBe(false);
		expect(text(delivered[0])).toContain("yield now");
		expect(await drain("wrap-up-request")).toEqual([]);
	});

	it("refuses a wrap-up when no request is running", () => {
		setup();
		expect(session!.requestWrapUp()).toBe(false);
	});
});
