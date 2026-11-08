import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool, taskSchema } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { getTaskSchema, type TaskForkSource } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

// Contract: the single-spawn schema (`task.batch: false`; the exported
// `taskSchema` instance) carries no batch fields while accepting a caller
// `model`, `outputSchema`, and its validation mode. The batch shape (`tasks[]` + shared
// `context`) is gated by the `task.batch` setting (default on, covered by
// test/task/task-batch.test.ts).

describe("task schema (single-spawn)", () => {
	it("requires task", () => {
		const parsed = taskSchema({ agent: "scout", solutionSpace: "c" });
		expect(parsed instanceof type.errors).toBe(true);
	});

	it("removes eval tool names from the wire shape when eval.tools.enabled is off", () => {
		const schema = getTaskSchema({
			isolationEnabled: false,
			batchEnabled: false,
			evalToolsEnabled: false,
		});
		const parsed = schema({
			agent: "scout",
			task: "Map the auth module.",
			solutionSpace: "c",
			tools: ["word_count"],
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (parsed && typeof parsed === "object" && !(parsed instanceof type.errors)) {
			expect("tools" in parsed).toBe(false);
		}
	});

	it("retains caller outputSchema, schemaMode, and eval tool names while stripping stale keys", () => {
		const outputSchema = { type: "object", properties: { answer: { type: "string" } } };
		const parsed = taskSchema({
			agent: "scout",
			task: "Map the auth module.",
			solutionSpace: "c",
			outputSchema,
			schemaMode: "strict",
			tools: ["word_count"],
			context: "shared background",
			tasks: [{ name: "A", task: "..." }],
			schema: '{"properties":{}}',
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.outputSchema).toEqual(outputSchema);
			expect(parsed.schemaMode).toBe("strict");
			expect(parsed.tools).toEqual(["word_count"]);
			expect("tasks" in parsed).toBe(false);
			expect("context" in parsed).toBe(false);
			expect("schema" in parsed).toBe(false);
		}
	});

	it("advertises a top-level `fork` only when task.fork.enabled is on", () => {
		for (const batchEnabled of [false, true]) {
			const withFork = getTaskSchema({ isolationEnabled: false, batchEnabled, forkEnabled: true });
			const withoutFork = getTaskSchema({ isolationEnabled: false, batchEnabled, forkEnabled: false });
			const params = batchEnabled
				? { context: "shared", tasks: [{ task: "review", solutionSpace: "c", fork: true }], fork: true }
				: { task: "review", solutionSpace: "c", fork: true };

			const forked = withFork(params);
			expect(forked instanceof type.errors).toBe(false);
			if (forked && typeof forked === "object" && !(forked instanceof type.errors)) {
				expect("fork" in forked && forked.fork).toBe(true);
				if (batchEnabled && "tasks" in forked && Array.isArray(forked.tasks)) {
					// Top-level only: a batch shares one parent snapshot.
					expect("fork" in forked.tasks[0]).toBe(false);
				}
			}

			const plain = withoutFork(params);
			expect(plain instanceof type.errors).toBe(false);
			if (plain && typeof plain === "object" && !(plain instanceof type.errors)) {
				expect("fork" in plain).toBe(false);
			}
		}
	});
});

describe("task spawn validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function createSession(
		getTaskForkSource?: () => Promise<TaskForkSource | undefined>,
		getActiveModel?: () => Model | undefined,
	): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({ "task.isolation.enabled": false, "task.batch": false }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getTaskForkSource,
			getActiveModel,
		} as unknown as ToolSession;
	}

	async function executeResult(params: unknown, getTaskForkSource?: () => Promise<TaskForkSource | undefined>) {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		const tool = await TaskTool.create(createSession(getTaskForkSource));
		return tool.execute("tool-call", params);
	}

	async function executeText(params: unknown): Promise<string> {
		const result = await executeResult(params);
		return result.content.find(part => part.type === "text")?.text ?? "";
	}

	it("defaults a missing agent to `task`", async () => {
		// With no `agent`, execute() normalizes to the `task` default, so the
		// failure is unknown-agent (none discovered), not missing-agent.
		const text = await executeText({ task: "..." });
		expect(text).toContain('Unknown agent "task"');
	});

	it("rejects a missing task", async () => {
		const text = await executeText({ agent: "scout" });
		expect(text).toContain("Missing `task`");
	});

	it("rejects fork without a persisted session snapshot", async () => {
		const result = await executeResult({ task: "review", solutionSpace: "c", fork: true }, async () => undefined);
		expect(result.isError).toBe(true);
		expect(result.content.find(part => part.type === "text")?.text).toBe(
			"fork requires a persisted session with an active model; use a normal task with full context",
		);
	});

	it("rejects fork on a model without mid-conversation tool changes", async () => {
		const model = buildModel({
			id: "gpt-test",
			name: "GPT Test",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		});
		const source: TaskForkSource = {
			sessionFile: "/tmp/parent.jsonl",
			systemPrompt: ["parent"],
			model,
			thinkingLevel: undefined,
			toolDefinitions: [],
			promptCacheKey: "parent",
		};
		const result = await executeResult({ task: "review", solutionSpace: "c", fork: true }, async () => source);
		expect(result.isError).toBe(true);
		expect(result.content.find(part => part.type === "text")?.text).toBe(
			"fork requires a model with mid-conversation tool changes (current: openai/gpt-test); use a normal task with full context",
		);
	});

	it("advertises `fork` only when the active model can reuse the parent's cache", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		const claude = buildModel({
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
		});
		// An OpenAI-compatible gateway in front of a self-hosted model (e.g. LiteLLM → vLLM).
		const gateway = buildModel({
			id: "glm-5.3-flash",
			name: "GLM 5.3 Flash",
			api: "openai-completions",
			provider: "litellm",
			baseUrl: "https://litellm.example.invalid/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});
		const params = { task: "review", solutionSpace: "c", fork: true };

		const supported = await TaskTool.create(createSession(undefined, () => claude));
		expect(supported.description).toContain("`fork`:");
		const forked = supported.parameters(params);
		expect(forked && typeof forked === "object" && !(forked instanceof type.errors) && "fork" in forked).toBe(true);

		const unsupported = await TaskTool.create(createSession(undefined, () => gateway));
		expect(unsupported.description).not.toContain("`fork`");
		const plain = unsupported.parameters(params);
		expect(plain && typeof plain === "object" && !(plain instanceof type.errors) && "fork" in plain).toBe(false);
	});
});
