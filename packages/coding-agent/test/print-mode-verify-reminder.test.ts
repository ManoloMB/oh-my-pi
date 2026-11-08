import { afterEach, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => vi.restoreAllMocks());

it("runs the verification reminder turn before print mode returns", async () => {
	const dir = TempDir.createSync("@pi-print-verify-reminder-");
	await Bun.write(path.join(dir.path(), "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
	await Bun.write(path.join(dir.path(), "bun.lock"), "");
	const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	const output: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
		if (typeof args[0] === "string") output.push(args[0]);
		const callback = args.at(-1);
		if (typeof callback === "function") callback();
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const model = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", name: "write", arguments: { path: "src/a.ts", content: "export {};\n" } }] },
			{ content: ["Edited src/a.ts."] },
			{ content: [{ type: "toolCall", name: "bash", arguments: { command: "bun run test" } }] },
			{ content: ["Edited src/a.ts and the tests pass."] },
		],
	});
	auth.keys.setRuntime(model.provider, "test-key");
	const objectSchema = type("object");
	const writeTool: AgentTool = {
		name: "write",
		label: "Write",
		description: "Mock write tool",
		parameters: objectSchema,
		execute: async () => ({ content: [{ type: "text" as const, text: "Wrote src/a.ts" }] }),
	};
	const bashTool: AgentTool = {
		name: "bash",
		label: "Bash",
		description: "Mock bash tool",
		parameters: objectSchema,
		execute: async () => ({ content: [{ type: "text" as const, text: "3 pass\n0 fail" }] }),
	};
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [writeTool, bashTool], messages: [] },
			convertToLlm,
			streamFn: model.stream,
		}),
		sessionManager: SessionManager.inMemory(dir.path()),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(auth, path.join(dir.path(), "models.yml")),
	});
	try {
		const code = await runPrintMode(session, { mode: "text", initialMessage: "Fix the bug in src/a.ts" });
		expect(code).toBe(0);
		expect(model.calls).toHaveLength(4);
		const reminderCall = model.calls[2];
		expect(JSON.stringify(reminderCall?.context.messages)).toContain("without a passing verification run");
		expect(output.join("")).toBe("Edited src/a.ts and the tests pass.\n");
	} finally {
		await session.dispose();
		auth.close();
		await dir.remove();
	}
});
