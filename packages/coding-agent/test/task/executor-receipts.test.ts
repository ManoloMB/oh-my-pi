/**
 * Receipt carry-through: `runSubprocess` snapshots the child session's tool
 * receipts onto its `SingleResult`, and the `<task-result>` envelope renders
 * advisory verification without changing the run's status.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runAcceptanceChecks } from "@oh-my-pi/pi-coding-agent/task/acceptance-checks";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { formatTaskResultSummary } from "@oh-my-pi/pi-coding-agent/task/result-summary";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { ToolReceipt } from "@oh-my-pi/pi-tui/tools/task";

const AGENT_ID = "receipt-carrier";

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

const RECEIPTS: ToolReceipt[] = [
	{ id: "r1", seq: 1, toolCallId: "tc-1", toolName: "edit", status: "ok", at: 1 },
	{
		id: "r2",
		seq: 2,
		toolCallId: "tc-2",
		toolName: "bash",
		status: "ok",
		command: "bun test",
		testOutcome: "passed",
		at: 2,
	},
];

function assistantStopMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Minimal executor run surface whose prompt submits a terminal `yield` and exposes receipts. */
function createSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: AssistantMessage[] = [];
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners.slice()) listener(event);
	};
	const session = {
		state: { messages },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		getToolByName: () => undefined,
		setActiveToolsByName: async () => {},
		setWorkPoolYieldItems: () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async () => {
			const message = assistantStopMessage("edited [r1], tests pass [r2 bash]");
			messages.push(message);
			emit({ type: "message_end", message } as AgentSessionEvent);
			emit({
				type: "tool_execution_end",
				toolCallId: "yield-1",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { report: "edited [r1], tests pass [r2 bash]" } },
				},
			} as AgentSessionEvent);
			return true;
		},
		waitForIdle: async () => {},
		isAdvisorActive: () => false,
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getLastAssistantMessage: () => messages[messages.length - 1],
		hasPendingAsyncWork: () => false,
		getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
		settleAsyncWork: async () => {},
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
		trackIrcReply: () => {},
		subscribeRunState: () => () => {},
		getToolReceipts: () => RECEIPTS,
	};
	return session as unknown as AgentSession;
}

describe("subagent tool receipts", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	it("carries receipts onto the result and renders verification in the task summary", async () => {
		const session = createSession();
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			session,
			status: "running",
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} as CreateAgentSessionResult);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do the work",
			index: 0,
			id: AGENT_ID,
		});

		expect(result.exitCode).toBe(0);
		expect(result.receipts).toEqual(RECEIPTS);

		const checks = await runAcceptanceChecks({
			criteria: ["tests_passed:bun test"],
			cwd: "/tmp",
			receipts: result.receipts,
			workspaceApplied: true,
		});
		const summary = formatTaskResultSummary(
			{ ...result, verification: { checks, citations: { cited: 2, resolved: 2, failed: 0, unknown: 0 } } },
			{ totalDurationMs: 10 },
		);
		expect(summary).toContain("<verification");
		expect(summary).toContain("holds: tests_passed:bun test — [r2]");
		expect(summary).toContain("citations: 2 resolved, 0 failed, 0 unknown (2 cited)");
		expect(summary).toContain('status="completed"');
	});
});
