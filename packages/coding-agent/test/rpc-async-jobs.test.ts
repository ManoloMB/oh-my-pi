import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { handleRpcGetAsyncJobs } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

describe("RPC get_async_jobs", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		session = undefined;
		authStorage = undefined;
		AsyncJobManager.resetForTests();
	});

	it("lists running jobs before settled ones, each with its command, cwd and a capped output tail", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Owner",
			asyncJobManager: manager,
		});

		manager.register(
			"task",
			"broken task",
			async () => {
				throw new Error("task exploded");
			},
			{ id: "bg_1", ownerId: "Owner" },
		);
		await session.settleAsyncWork();

		const progressed = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<string>();
		manager.register(
			"bash",
			"bun test",
			async ({ reportProgress }) => {
				await reportProgress(`${"x".repeat(10_000)}LAST LINE`);
				progressed.resolve();
				return gate.promise;
			},
			{ id: "bg_2", ownerId: "Owner", process: { command: "bun test --watch", cwd: "/repo", pids: () => [] } },
		);
		await progressed.promise;

		const jobs = handleRpcGetAsyncJobs(session);
		expect(jobs.map(job => [job.id, job.status])).toEqual([
			["bg_2", "running"],
			["bg_1", "failed"],
		]);
		const [running, failed] = jobs;
		expect(running).toMatchObject({ type: "bash", label: "bun test", command: "bun test --watch", cwd: "/repo" });
		expect(running.output?.length).toBe(4000);
		expect(running.output?.endsWith("LAST LINE")).toBe(true);
		expect(failed.output).toContain("task exploded");
		expect(failed.endTime).toBeNumber();

		gate.resolve("ok");
		await session.settleAsyncWork();
	});
});
