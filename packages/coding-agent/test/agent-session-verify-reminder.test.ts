import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, TextContent, ToolCall } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const sharedAuthStorage = createInMemoryAuthStorage();
sharedAuthStorage.keys.setRuntime("anthropic", "test-key");
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage);

afterAll(() => {
	sharedAuthStorage.close();
});

const USAGE = {
	input: 50,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 60,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("AgentSession verify-before-stop reminder", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let verifyNotices: string[];
	let callCounter = 0;

	function emitTextOnlyStop(text = "Done, the change is in place."): void {
		const msg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: USAGE,
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
	}

	function emitToolResult(
		toolName: string,
		args: Record<string, unknown>,
		options: { details?: Record<string, unknown>; isError?: boolean; text?: string } = {},
	): void {
		const toolCallId = `call_${toolName}_${++callCounter}`;
		const toolCall: ToolCall = { type: "toolCall", id: toolCallId, name: toolName, arguments: args };
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [toolCall],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: USAGE,
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		const content: TextContent[] = [{ type: "text", text: options.text ?? "ok" }];
		session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId,
				toolName,
				content,
				isError: options.isError ?? false,
				details: options.details ?? {},
				timestamp: Date.now(),
			},
		});
	}

	function emitCodeEdit(filePath = "src/a.ts"): void {
		emitToolResult("edit", { path: filePath }, { details: { diff: "", path: path.join(tempDir.path(), filePath) } });
	}

	function emitUserMessage(text: string): void {
		session.agent.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
	}

	function verifyReminders(): string[] {
		const texts: string[] = [];
		for (const entry of sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "developer") continue;
			const { content } = entry.message;
			if (!Array.isArray(content)) continue;
			for (const item of content) {
				if (item.type === "text" && item.text.includes("without a passing verification run")) {
					texts.push(item.text);
				}
			}
		}
		return texts;
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-verify-reminder-");
		await Bun.write(
			path.join(tempDir.path(), "package.json"),
			JSON.stringify({ name: "fixture", scripts: { test: "bun test" } }),
		);
		await Bun.write(path.join(tempDir.path(), "bun.lock"), "");
		sessionManager = SessionManager.inMemory(tempDir.path());

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: sharedModelRegistry,
		});

		verifyNotices = [];
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "notice" && event.source === "verify") verifyNotices.push(event.message);
		});
		emitUserMessage("Fix the bug in src/a.ts");
	});

	afterEach(async () => {
		await session.dispose();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("reminds once after an unverified code edit, naming the file and the project check", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		emitCodeEdit();
		emitTextOnlyStop();
		await session.waitForIdle();

		const reminders = verifyReminders();
		expect(reminders).toHaveLength(1);
		expect(reminders[0]).toContain("src/a.ts");
		expect(reminders[0]).toContain("bun run test");
		expect(reminders[0]).toContain("(Reminder 1/2)");
		expect(reminders[0]).not.toContain("The last check");
		expect(verifyNotices).toEqual(["Verification reminder 1/2: code edited without a passing check"]);
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("stays silent when a passing check ran after the last edit", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		emitCodeEdit();
		emitToolResult("bash", { command: "bun test src/a.test.ts" }, { text: "3 pass\n0 fail" });
		emitTextOnlyStop();
		await session.waitForIdle();

		expect(verifyReminders()).toEqual([]);
		expect(verifyNotices).toEqual([]);
	});

	it("names the failed check when the last verification failed", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		emitCodeEdit();
		emitToolResult(
			"bash",
			{ command: "bun run test" },
			{ isError: true, details: { exitCode: 1 }, text: "1 fail\n\nCommand exited with code 1" },
		);
		emitTextOnlyStop();
		await session.waitForIdle();

		const reminders = verifyReminders();
		expect(reminders).toHaveLength(1);
		expect(reminders[0]).toContain("The last check (`bun run test`) failed");
	});

	it("does not remind for documentation-only edits", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		emitCodeEdit("README.md");
		emitTextOnlyStop();
		await session.waitForIdle();

		expect(verifyReminders()).toEqual([]);
	});

	it("does not remind for code written outside the session working tree", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		const outside = path.join(path.dirname(tempDir.path()), "scratch-probe.ts");
		emitToolResult("write", { path: outside, content: "export {};" });
		emitTextOnlyStop();
		await session.waitForIdle();

		expect(verifyReminders()).toEqual([]);
	});

	it("does not repeat the reminder across text-only stops without tool progress", async () => {
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			emitTextOnlyStop("I already verified it mentally.");
		});
		emitCodeEdit();
		emitTextOnlyStop();
		await session.waitForIdle();

		expect(verifyReminders()).toHaveLength(1);
	});

	it("caps reminders at verify.remindersMax", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		for (let cycle = 0; cycle < 3; cycle++) {
			emitCodeEdit();
			emitTextOnlyStop();
			await session.waitForIdle();
		}

		const reminders = verifyReminders();
		expect(reminders).toHaveLength(2);
		expect(reminders[0]).toContain("(Reminder 1/2)");
		expect(reminders[1]).toContain("(Reminder 2/2)");
		expect(verifyNotices).toHaveLength(2);
	});

	it("does not remind in plan mode", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		emitCodeEdit();
		emitTextOnlyStop();
		await session.waitForIdle();

		expect(verifyReminders()).toEqual([]);
		expect(verifyNotices).toEqual([]);
	});

	it("does not remind when the user asked not to run anything", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		emitUserMessage("no ejecutes nada, solo edita");
		emitCodeEdit();
		emitTextOnlyStop();
		await session.waitForIdle();

		expect(verifyReminders()).toEqual([]);
	});
});
