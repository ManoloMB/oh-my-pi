import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { GlobTool } from "@oh-my-pi/pi-coding-agent/tools/glob";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { TodoTool } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { outputJsonSchema } from "@oh-my-pi/pi-tui/tools/eval-format/code-mode-declarations";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

/**
 * Drift guard: each built-in `outputSchema` must accept the `details` its tool
 * really produces, or eval code typed against `xd://eval/tools` would be lied to.
 */
describe("built-in tool outputSchema contracts", () => {
	let cwd: string;
	let session: ToolSession;

	beforeAll(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "output-schema-contract-"));
		await Bun.write(path.join(cwd, "a.txt"), "needle one\n");
		await Bun.write(path.join(cwd, "b.txt"), "needle two\nneedle three\n");
		let phases: TodoPhase[] = [];
		session = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			getTodoPhases: () => phases,
			setTodoPhases: next => {
				phases = next;
			},
		};
	});

	afterAll(async () => {
		await removeWithRetries(cwd);
	});

	function expectDetailsMatch(tool: AgentTool, result: AgentToolResult): void {
		expect(tool.outputSchema).toBeDefined();
		expect(result.details).toBeDefined();
		// Eval code receives details as JSON: `undefined`-valued keys are absent there.
		const details: unknown = JSON.parse(JSON.stringify(result.details));
		const validation = validateJsonSchemaValue(outputJsonSchema(tool.outputSchema), details);
		expect(validation.issues).toEqual([]);
		expect(validation.success).toBe(true);
	}

	it("grep", async () => {
		const tool = new GrepTool(session);
		const result = await tool.execute("contract-grep", { pattern: "needle", path: "." });
		expectDetailsMatch(tool as unknown as AgentTool, result);
	});

	it("glob", async () => {
		const tool = new GlobTool(session);
		const result = await tool.execute("contract-glob", { path: "*.txt" });
		expectDetailsMatch(tool as unknown as AgentTool, result);
	});

	it("bash", async () => {
		const tool = new BashTool(session);
		const result = await tool.execute("contract-bash", { command: "echo hi" });
		expectDetailsMatch(tool as unknown as AgentTool, result);
	});

	it("todo", async () => {
		const tool = new TodoTool(session);
		const result = await tool.execute("contract-todo", {
			op: "init",
			list: [{ phase: "Ship", items: ["Write", "Test"] }],
		});
		expectDetailsMatch(tool as unknown as AgentTool, result);
	});
});
