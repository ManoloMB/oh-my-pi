import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	DIR_CONTEXT_NOTICE_CUSTOM_TYPE,
	descendantDirsFromCwd,
	touchedPathsForResult,
} from "@oh-my-pi/pi-coding-agent/session/dir-context-coordinator";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("dir context helpers", () => {
	it("lists directories strictly below cwd down to the target", () => {
		expect(descendantDirsFromCwd("/repo", "/repo/a/b")).toEqual(["/repo/a", "/repo/a/b"]);
		expect(descendantDirsFromCwd("/repo", "/repo")).toEqual([]);
		expect(descendantDirsFromCwd("/repo", "/elsewhere/a")).toEqual([]);
	});

	it("takes only successful files from a multi-file edit", () => {
		const result = {
			details: {
				perFileResults: [
					{ path: "/repo/ok.ts", diff: "" },
					{ path: "/repo/bad.ts", diff: "", isError: true },
				],
			},
		};
		expect(touchedPathsForResult("edit", result)).toEqual(["/repo/ok.ts"]);
		expect(touchedPathsForResult("edit", { details: { path: "/repo/single.ts" } })).toEqual(["/repo/single.ts"]);
		expect(touchedPathsForResult("read", { details: { kind: "url", resolvedPath: "/x" } })).toEqual([]);
		expect(touchedPathsForResult("bash", { details: { resolvedPath: "/x" } })).toEqual([]);
	});
});

describe("dir context auto-injection", () => {
	let tempDir: TempDir;
	let cwd: string;
	let sessionsDir: string;
	const sessions: AgentSession[] = [];
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-dir-context-inject-");
		cwd = tempDir.join("project");
		sessionsDir = tempDir.join("sessions");
		await Bun.write(path.join(cwd, "src", "sub", "AGENTS.md"), "USE_CURRENCY_ENUM for every amount.");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
		authStorage.close();
		await tempDir.remove();
	});

	function stringArg(args: unknown, key: string): string {
		if (args && typeof args === "object" && key in args) {
			const value: unknown = Reflect.get(args, key);
			if (typeof value === "string") return value;
		}
		throw new Error(`missing string argument ${key}`);
	}

	function fileTools(): AgentTool[] {
		const write: AgentTool = {
			name: "write",
			label: "Write",
			description: "Write a file",
			parameters: type({ path: "string", content: "string" }),
			async execute(_id, args) {
				const resolvedPath = path.resolve(cwd, stringArg(args, "path"));
				await Bun.write(resolvedPath, stringArg(args, "content"));
				return { content: [{ type: "text", text: "written" }], details: { resolvedPath } };
			},
		};
		const read: AgentTool = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters: type({ path: "string" }),
			async execute(_id, args) {
				const resolvedPath = path.resolve(cwd, stringArg(args, "path"));
				const text = await Bun.file(resolvedPath).text();
				return { content: [{ type: "text", text }], details: { resolvedPath } };
			},
		};
		return [write, read];
	}

	function createSession(
		sessionManager: SessionManager,
		overrides: Record<string, unknown> = {},
	): { session: AgentSession; mock: MockModel } {
		const mock = createMockModel({ provider: "openai", id: "gpt-test" });
		const tools = fileTools();
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: mock.model,
				systemPrompt: ["Test"],
				tools,
				messages: sessionManager.buildSessionContext().messages,
			},
			convertToLlm,
			streamFn: mock.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, ...overrides }),
			modelRegistry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		});
		sessions.push(session);
		return { session, mock };
	}

	let callSeq = 0;
	async function runTool(
		session: AgentSession,
		mock: MockModel,
		name: "write" | "read",
		args: Record<string, unknown>,
	): Promise<void> {
		callSeq++;
		mock.push({ content: [{ type: "toolCall", id: `call-${callSeq}`, name, arguments: args }] });
		mock.push({ content: ["done"] });
		await session.prompt(`step ${callSeq}`);
	}

	function notices(session: AgentSession): Array<Extract<AgentMessage, { role: "custom" }>> {
		return session.agent.state.messages.filter(
			(message): message is Extract<AgentMessage, { role: "custom" }> =>
				message.role === "custom" && message.customType === DIR_CONTEXT_NOTICE_CUSTOM_TYPE,
		);
	}

	function noticeText(message: Extract<AgentMessage, { role: "custom" }>): string {
		return typeof message.content === "string"
			? message.content
			: message.content.map(block => (block.type === "text" ? block.text : "")).join("");
	}

	it("injects a nested AGENTS.md before the next model request, once", async () => {
		const { session, mock } = createSession(SessionManager.create(cwd, sessionsDir));
		await runTool(session, mock, "write", { path: "src/sub/x.ts", content: "export {}" });

		const injected = notices(session);
		expect(injected).toHaveLength(1);
		const text = noticeText(injected[0]);
		expect(text).toContain("Instructions from: src/sub/AGENTS.md");
		expect(text).toContain("USE_CURRENCY_ENUM");
		expect(injected[0].details).toEqual({
			entries: [{ path: path.join(cwd, "src", "sub", "AGENTS.md"), action: "set", digest: expect.any(String) }],
		});
		// The follow-up request after the tool call already carries the notice.
		expect(JSON.stringify(mock.calls.at(-1)?.context.messages)).toContain("USE_CURRENCY_ENUM");

		await runTool(session, mock, "write", { path: "src/sub/y.ts", content: "export {}" });
		expect(notices(session)).toHaveLength(1);
	});

	it("re-injects an updated file and reports a removed one", async () => {
		const { session, mock } = createSession(SessionManager.create(cwd, sessionsDir));
		const agentsPath = path.join(cwd, "src", "sub", "AGENTS.md");
		await runTool(session, mock, "write", { path: "src/sub/x.ts", content: "1" });

		await Bun.write(agentsPath, "USE_DECIMAL_TYPE instead of floats, always.");
		await runTool(session, mock, "write", { path: "src/sub/x.ts", content: "2" });
		const updated = notices(session);
		expect(updated).toHaveLength(2);
		expect(noticeText(updated[1])).toContain("Updated instructions from: src/sub/AGENTS.md");
		expect(noticeText(updated[1])).toContain("USE_DECIMAL_TYPE");

		await fs.rm(agentsPath);
		await runTool(session, mock, "write", { path: "src/sub/x.ts", content: "3" });
		const removed = notices(session);
		expect(removed).toHaveLength(3);
		expect(noticeText(removed[2])).toContain("Instructions removed: src/sub/AGENTS.md");
		expect(removed[2].details).toEqual({ entries: [{ path: agentsPath, action: "remove" }] });
	});

	it("does not duplicate a notice after resuming the session", async () => {
		const sessionManager = SessionManager.create(cwd, sessionsDir);
		const first = createSession(sessionManager);
		await runTool(first.session, first.mock, "write", { path: "src/sub/x.ts", content: "1" });
		expect(notices(first.session)).toHaveLength(1);
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected a persisted session file");

		const resumed = createSession(await SessionManager.open(sessionFile, sessionsDir));
		expect(notices(resumed.session)).toHaveLength(1);
		await runTool(resumed.session, resumed.mock, "write", { path: "src/sub/y.ts", content: "2" });
		expect(notices(resumed.session)).toHaveLength(1);
	});

	it("re-injects rules that a compaction summarized away", async () => {
		const { session, mock } = createSession(SessionManager.create(cwd, sessionsDir), {
			"compaction.keepRecentTokens": 1,
			"compaction.methodOrder": ["soft"],
		});
		await runTool(session, mock, "write", { path: "src/sub/x.ts", content: "1" });
		expect(notices(session)).toHaveLength(1);

		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "Wrote src/sub/x.ts.",
			shortSummary: "Wrote x.ts",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 1,
		}));
		await session.compact(undefined, { suppressContinuation: true });
		expect(notices(session)).toHaveLength(0);

		await runTool(session, mock, "write", { path: "src/sub/y.ts", content: "2" });
		const injected = notices(session);
		expect(injected).toHaveLength(1);
		expect(noticeText(injected[0])).toContain("Instructions from: src/sub/AGENTS.md");
	});

	it("stays silent when disabled or when the context file itself is read", async () => {
		const disabled = createSession(SessionManager.create(cwd, sessionsDir), {
			"contextFiles.nestedAutoInject": false,
		});
		await runTool(disabled.session, disabled.mock, "write", { path: "src/sub/x.ts", content: "1" });
		expect(notices(disabled.session)).toHaveLength(0);

		const direct = createSession(SessionManager.create(cwd, sessionsDir));
		await runTool(direct.session, direct.mock, "read", { path: "src/sub/AGENTS.md" });
		expect(notices(direct.session)).toHaveLength(0);
	});

	it("injects a context file deeper than the static index reaches", async () => {
		const deepDir = path.join(cwd, "a", "b", "c", "d", "e", "f");
		await Bun.write(path.join(deepDir, "AGENTS.md"), "DEEP_RULE applies here.");
		const { session, mock } = createSession(SessionManager.create(cwd, sessionsDir));
		await runTool(session, mock, "write", { path: "a/b/c/d/e/f/x.ts", content: "1" });

		const injected = notices(session);
		expect(injected).toHaveLength(1);
		expect(noticeText(injected[0])).toContain("Instructions from: a/b/c/d/e/f/AGENTS.md");
		expect(noticeText(injected[0])).toContain("DEEP_RULE");
	});
});
