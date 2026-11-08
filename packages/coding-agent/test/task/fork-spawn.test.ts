import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { TaskForkSource } from "@oh-my-pi/pi-coding-agent/task/types";
import { TempDir } from "@oh-my-pi/pi-utils";

const CHILD_ID = "fork-child";
const tempDirs: TempDir[] = [];

const PARENT_MODEL = buildModel({
	id: "claude-fable-5",
	name: "Claude Fable 5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
});

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

function createTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: "ok" }], details: { status: "success", data: {} } };
		},
	};
}

function parentAssistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: PARENT_MODEL.id,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Writes a persisted parent transcript and returns the fork snapshot pointing at it. */
async function createForkSource(cwd: string): Promise<TaskForkSource> {
	const parent = SessionManager.create(cwd, path.join(cwd, "parent-sessions"));
	parent.appendMessage({ role: "user", content: "parent question about src/a.ts", timestamp: Date.now() });
	parent.appendMessage(parentAssistant("parent answer: the bug is in paginate"));
	await parent.ensureOnDisk();
	await parent.flush();
	const sessionFile = parent.getSessionFile();
	if (!sessionFile) throw new Error("expected a persisted parent session");
	return {
		sessionFile,
		systemPrompt: ["parent base prompt", "parent project context"],
		model: PARENT_MODEL,
		thinkingLevel: "auto",
		toolDefinitions: [
			{ name: "read", description: "parent read", parameters: { type: "object", properties: {} } },
			{ name: "todo", description: "parent todo", parameters: { type: "object", properties: {} } },
		],
		promptCacheKey: "parent-cache-key",
	};
}

interface RecordingSession {
	session: AgentSession;
	/** Messages of each provider request, in order. */
	requests: Message[][];
}

/** A real AgentSession on a scripted model, recording each request's messages. */
function createRecordingSession(sessionManager: SessionManager, responses: MockResponse[]): RecordingSession {
	const mock = createMockModel({ responses, handler: { content: ["done"] } });
	const requests: Message[][] = [];
	const tools = [createTool("read"), createTool("yield")];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: buildModel({
				id: "mock",
				name: "mock",
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 2048,
			}),
			systemPrompt: ["recording"],
			tools,
			messages: [],
		},
		convertToLlm,
		streamFn: (model, context, streamOptions) => {
			requests.push([...context.messages]);
			return mock.stream(model, context, streamOptions);
		},
	});
	const session: AgentSession = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
		modelRegistry: {
			getApiKey: async () => "test-key",
			getAvailable: () => [],
			find: () => agent.state.model,
			hasConfiguredAuth: () => true,
		} as never,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		extensionRunner: {
			initialize: () => {},
			onError: () => () => {},
			hasHandlers: () => false,
			emit: async () => {},
			emitBeforeAgentStart: async () => undefined,
		} as unknown as ExtensionRunner,
		rebuildSystemPrompt: async () => ({ systemPrompt: ["recording"] }),
	});
	return { session, requests };
}

function textOf(message: Message | undefined): string {
	if (!message || message.role !== "user") return "";
	return typeof message.content === "string"
		? message.content
		: message.content.map(part => (part.type === "text" ? part.text : "")).join("");
}

describe("task fork spawn", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(sessions.splice(0).map(session => session.dispose()));
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.global().unregister(CHILD_ID);
		await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
	});

	async function spawnFork(cwd: string, forkSource: TaskForkSource, agentModel?: string[]) {
		let captured: CreateAgentSessionOptions | undefined;
		let spawned: RecordingSession | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementationOnce(async options => {
			captured = options;
			spawned = createRecordingSession(options!.sessionManager!, [
				{ content: [{ type: "toolCall", name: "yield", arguments: {} }] },
				{ content: ["done"] },
			]);
			sessions.push(spawned.session);
			AgentRegistry.global().register({
				id: CHILD_ID,
				displayName: CHILD_ID,
				kind: "sub",
				session: spawned.session,
				sessionFile: options!.sessionManager!.getSessionFile() ?? null,
				status: "running",
			});
			return { session: spawned.session } as CreateAgentSessionResult;
		});
		const result = await executorModule.runSubprocess({
			cwd,
			agent: { name: "task", description: "test", systemPrompt: "charter", source: "bundled", model: agentModel },
			task: "review the change to paginate",
			index: 0,
			id: CHILD_ID,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir: cwd,
			effort: "hi",
			forkSource,
		});
		expect(result.exitCode).toBe(0);
		if (!captured || !spawned) throw new Error("expected the fork to create a session");
		return { options: captured, spawned };
	}

	it("opens the parent transcript and sends the parent's prompt, model, tools and cache key", async () => {
		const cwd = makeTempDir("@pi-task-fork-");
		const forkSource = await createForkSource(cwd);
		const { options, spawned } = await spawnFork(cwd, forkSource, ["openai/gpt-4.1-mini"]);

		expect(options.systemPrompt).toEqual(forkSource.systemPrompt);
		expect(options.model).toBe(forkSource.model);
		expect(options.modelPattern).toBeUndefined();
		expect(options.thinkingLevel).toBe(forkSource.thinkingLevel);
		expect(options.thinkingLevelCeiling).toBeUndefined();
		expect(options.pinnedToolDefinitions).toBe(forkSource.toolDefinitions);
		expect(options.providerPromptCacheKey).toBe(forkSource.promptCacheKey);
		expect(options.providerPromptCacheKeySource).toBe("fork");
		expect(options.prewalk).toBeUndefined();

		const childFile = path.join(cwd, `${CHILD_ID}.jsonl`);
		expect(options.sessionManager?.getSessionFile()).toBe(childFile);
		const childTranscript = await Bun.file(childFile).text();
		expect(childTranscript).toContain("parent question about src/a.ts");
		expect(childTranscript).toContain("parent answer: the bug is in paginate");

		const firstPrompt = textOf(spawned.requests[0]?.findLast(message => message.role === "user"));
		expect(firstPrompt).toContain('<system-notice cause="fork">');
		expect(firstPrompt).toContain("charter");
		expect(firstPrompt).toContain("review the change to paginate");
	});

	it("keeps the parent's system prompt and pinned tools when the lifecycle revives the fork", async () => {
		const cwd = makeTempDir("@pi-task-fork-revive-");
		const forkSource = await createForkSource(cwd);
		await spawnFork(cwd, forkSource);

		const lifecycle = AgentLifecycleManager.global();
		await lifecycle.park(CHILD_ID);
		let revivedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementationOnce(async options => {
			revivedOptions = options;
			const warm = createRecordingSession(options!.sessionManager!, [{ content: ["next"] }]);
			sessions.push(warm.session);
			return { session: warm.session } as CreateAgentSessionResult;
		});
		await lifecycle.ensureLive(CHILD_ID);
		if (!revivedOptions) throw new Error("expected a warm revive through the lifecycle");

		expect(revivedOptions.systemPrompt).toEqual(forkSource.systemPrompt);
		expect(revivedOptions.pinnedToolDefinitions).toBe(forkSource.toolDefinitions);
		expect(revivedOptions.providerPromptCacheKey).toBe(forkSource.promptCacheKey);
	});
});
