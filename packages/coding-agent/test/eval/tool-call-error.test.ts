import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import type { ToolSession } from "../../src/tools";
import { EvalTool } from "../../src/tools/eval";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await disposeAllVmContexts();
	await Promise.all(temporaryDirectories.splice(0).map(directory => removeWithRetries(directory)));
});

it("a failed tool call surfaces in JS cell code as a catchable ToolCallError", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eval-tool-call-error-"));
	temporaryDirectories.push(directory);
	const boom = {
		name: "boom",
		label: "boom",
		description: "always fails",
		parameters: type({}),
		execute: async (): Promise<AgentToolResult> => ({
			content: [{ type: "text", text: "kaboom" }],
			details: { code: 7 },
			isError: true,
		}),
	} as unknown as AgentTool;
	const session: ToolSession = {
		cwd: directory,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getEvalSessionId: () => `eval-tool-call-error-${crypto.randomUUID()}`,
		getToolForEvalBridge: name => (name === "boom" ? boom : undefined),
		getEvalBridgeToolNames: () => ["boom"],
		settings: Settings.isolated({ "eval.autoBackground.enabled": false }),
	};

	const result = await new EvalTool(session).execute("catch", {
		language: "js",
		code: [
			"try {",
			"  await tool.boom({});",
			"} catch (e) {",
			"  console.log(JSON.stringify([e instanceof ToolCallError, e.toolName, e.text, e.details]));",
			"}",
		].join("\n"),
	});

	const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
	expect(result.isError).not.toBe(true);
	expect(text).toContain(JSON.stringify([true, "boom", "kaboom", { code: 7 }]));
});
