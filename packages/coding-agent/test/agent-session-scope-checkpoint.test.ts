import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentEvent, type AsideMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { ScopeCheckpoint } from "@oh-my-pi/pi-coding-agent/session/scope-checkpoint";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * Long-run scope checkpoint: a hidden reminder injected at the mid-work aside
 * boundary once a main-agent request has been ACTIVE for the configured minutes
 * (time between runs and time blocked on `ask` excluded) and has made at least
 * 4 tool rounds (8 for a subagent); a second, firmer one at twice the time after
 * 8 more rounds;
 * never more than two per request and never at the stop boundary.
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

	function setup(overrides: Record<string, unknown> = {}, agentKind: "main" | "sub" = "main"): AgentSession {
		clock = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		tempDir = TempDir.createSync("@pi-scope-checkpoint-");
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false, ...overrides });
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

	function assistant(stopReason: "toolUse" | "stop"): AssistantMessage {
		return {
			role: "assistant",
			content:
				stopReason === "toolUse"
					? [{ type: "toolCall", id: `call_${Math.random()}`, name: "read", arguments: {} }]
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

	it("fires once, hidden, when active time reaches the threshold", async () => {
		setup();
		rounds(20);
		clock += 5 * MINUTE - 1;
		expect(await drain()).toEqual([]);

		clock += 1;
		const fired = await drain();
		expect(fired).toHaveLength(1);
		expect(fired[0]?.display).toBe(false);
		expect(text(fired[0])).toContain("20 tool rounds");
		expect(text(fired[0])).not.toContain("Second checkpoint");
		expect(await drain()).toEqual([]);
	});

	it("fires a firmer second checkpoint at twice the threshold after 8 more rounds, then stops", async () => {
		setup();
		rounds(10);
		clock += 5 * MINUTE;
		expect(await drain()).toHaveLength(1);

		clock += 5 * MINUTE;
		rounds(7);
		expect(await drain()).toEqual([]);
		rounds(1);
		const second = await drain();
		expect(second).toHaveLength(1);
		expect(text(second[0])).toContain("Second checkpoint");
		expect(text(second[0])).toContain("Start wrapping up");

		clock += 20 * MINUTE;
		rounds(20);
		expect(await drain()).toEqual([]);
	});

	it("needs 4 tool rounds for a main agent's first checkpoint, however long the run", async () => {
		setup();
		rounds(3);
		clock += 10 * MINUTE;
		expect(await drain()).toEqual([]);
		rounds(1);
		expect(await drain()).toHaveLength(1);
	});

	it("needs 8 tool rounds for a subagent's first checkpoint", async () => {
		setup({}, "sub");
		rounds(7);
		clock += 20 * MINUTE;
		expect(await drain()).toEqual([]);
		rounds(1);
		expect(await drain()).toHaveLength(1);
	});

	it("never injects at the stop boundary", async () => {
		setup();
		rounds(10);
		clock += 7 * MINUTE;
		session!.agent.emitExternalEvent({ type: "message_end", message: assistant("stop") });
		expect(await drain()).toEqual([]);
	});

	it("excludes time blocked on the ask tool", async () => {
		setup();
		rounds(10);
		clock += MINUTE;
		session!.agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "ask_1",
			toolName: "ask",
			args: {},
		});
		clock += 3 * MINUTE;
		session!.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: "ask_1",
			toolName: "ask",
			result: {},
		});
		rounds(1);
		clock += MINUTE;
		expect(await drain()).toEqual([]);

		clock += 4 * MINUTE;
		expect(await drain()).toHaveLength(1);
	});

	it("excludes idle time between agent runs", async () => {
		setup();
		rounds(10);
		clock += 4 * MINUTE;
		session!.agent.emitExternalEvent({ type: "agent_end", messages: [] });
		clock += 55 * MINUTE;
		session!.agent.emitExternalEvent({ type: "agent_start" });
		clock += MINUTE / 2;
		expect(await drain()).toEqual([]);

		clock += MINUTE / 2;
		expect(await drain()).toHaveLength(1);
	});

	it("is inert when disabled", async () => {
		setup({ "model.scopeCheckpoint.enabled": false });
		rounds(20);
		clock += 10 * MINUTE;
		expect(await drain()).toEqual([]);
	});

	it("skips the main agent's checkpoint once it delegates through task", async () => {
		setup();
		session!.agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "task_1",
			toolName: "task",
			args: {},
		});
		rounds(20);
		clock += 20 * MINUTE;
		expect(await drain()).toEqual([]);
	});

	it("gives a subagent its own timer on the subagent minutes, worded for its assignment", async () => {
		setup({ "model.scopeCheckpoint.minutes": 4 }, "sub");
		rounds(10);
		clock += 8 * MINUTE - 1;
		expect(await drain()).toEqual([]);

		clock += 1;
		const fired = await drain();
		expect(fired).toHaveLength(1);
		expect(text(fired[0])).toContain("your assignment");
		expect(text(fired[0])).toContain("in your yield");
	});

	it("delivers a requested wrap-up at the next tool round, ahead of the time gate, once", async () => {
		setup({}, "sub");
		// A running request; the instance property shadows the prototype getter for this test only.
		Object.defineProperty(session!, "isStreaming", { get: () => true, configurable: true });
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

/**
 * Plan mode gets no scope checkpoint: neither while the agent drafts the plan nor
 * while it carries out an approved one, across follow-ups until its steps close.
 */
describe("ScopeCheckpoint in plan mode", () => {
	let clock = 0;

	function checkpoint(planMode = false): ScopeCheckpoint {
		clock = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		return new ScopeCheckpoint({
			settings: Settings.isolated({}),
			agentKind: () => "main",
			planModeEnabled: () => planMode,
			delegateModeEnabled: () => false,
		});
	}

	const event = (value: unknown) => value as AgentEvent;
	const answer = (scope: ScopeCheckpoint, stopReason: "toolUse" | "stop" | "aborted") =>
		scope.onAgentEvent(event({ type: "message_end", message: { role: "assistant", content: [], stopReason } }));
	const request = (scope: ScopeCheckpoint) => {
		scope.resetCycle();
		scope.onAgentEvent(event({ type: "agent_start" }));
	};
	const runEnd = (scope: ScopeCheckpoint) => scope.onAgentEvent(event({ type: "agent_end", messages: [] }));
	const steps = (scope: ScopeCheckpoint, statuses: string[]) =>
		scope.onAgentEvent(
			event({
				type: "tool_execution_end",
				toolCallId: "todo_1",
				toolName: "todo",
				result: {
					content: [],
					details: { phases: [{ name: "Build", tasks: statuses.map(status => ({ content: "step", status })) }] },
				},
			}),
		);
	/** Long enough and with enough tool rounds for a checkpoint outside plan mode. */
	const longWork = (scope: ScopeCheckpoint) => {
		for (let i = 0; i < 10; i++) answer(scope, "toolUse");
		clock += 20 * MINUTE;
	};

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("gives none while the agent drafts the plan", () => {
		const scope = checkpoint(true);
		request(scope);
		longWork(scope);
		expect(scope.take()).toBeNull();
	});

	it("gives none while an approved plan runs, through follow-ups with open steps, until a request after its steps close", () => {
		const scope = checkpoint();
		request(scope);
		// RPC: the approval lands mid-request and the same run carries the plan out.
		scope.startPlanRun();
		longWork(scope);
		steps(scope, ["completed", "in_progress"]);
		expect(scope.take()).toBeNull();
		runEnd(scope);

		request(scope);
		longWork(scope);
		expect(scope.take()).toBeNull();
		steps(scope, ["completed", "abandoned"]);
		runEnd(scope);

		request(scope);
		longWork(scope);
		expect(scope.take()).not.toBeNull();
	});

	it("ends a plan run without steps after a run that worked on it, not at the turn the approval interrupted", () => {
		const scope = checkpoint();
		request(scope);
		scope.startPlanRun();
		// Interactive: the planning turn is aborted at approval, then a new request executes the plan.
		answer(scope, "aborted");
		runEnd(scope);

		request(scope);
		longWork(scope);
		expect(scope.take()).toBeNull();
		runEnd(scope);

		request(scope);
		longWork(scope);
		expect(scope.take()).not.toBeNull();
	});

	it("drops the plan run when the session changes", () => {
		const scope = checkpoint();
		scope.startPlanRun();
		scope.endPlanRun();
		request(scope);
		longWork(scope);
		expect(scope.take()).not.toBeNull();
	});
});
