import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import { disposeAllVmContexts } from "../src/eval/js/context-manager";
import type { ToolSession } from "../src/tools";
import { EvalTool } from "../src/tools/eval";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await disposeAllVmContexts();
	await Promise.all(temporaryDirectories.splice(0).map(directory => removeWithRetries(directory)));
});

function fakeTool(name: string, execute: () => Promise<AgentToolResult>): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ "path?": "string" }),
		concurrency: "shared",
		execute,
	} as unknown as AgentTool;
}

async function makeSession(settings: Settings, tool: AgentTool): Promise<ToolSession> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eval-call-allowance-"));
	temporaryDirectories.push(directory);
	return {
		cwd: directory,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getEvalSessionId: () => `eval-call-allowance-${crypto.randomUUID()}`,
		getToolForEvalBridge: name => (name === tool.name ? tool : undefined),
		getEvalBridgeToolNames: () => [tool.name],
		settings,
	};
}

function resultText(result: AgentToolResult): string {
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

describe("eval cell tool-call scheduling", () => {
	it("fails a runaway tool loop fast once the cell's call allowance is spent", async () => {
		let calls = 0;
		const read = fakeTool("read", async () => {
			calls++;
			return { content: [{ type: "text", text: "x" }] };
		});
		const settings = Settings.isolated({
			"eval.autoBackground.enabled": false,
			"eval.tools.maxCallsPerMinute": 60,
		});
		const evalTool = new EvalTool(await makeSession(settings, read));
		// Warm the worker so the measurement covers only the looping cell.
		await evalTool.execute("warm", { language: "js", code: "globalThis.warm = true" });

		const started = performance.now();
		const result = await evalTool
			.execute("loop", {
				language: "js",
				code: 'for (;;) { await tool.read({ path: "x" }) }',
				timeout: 2,
			})
			.catch((error: unknown) => error);
		const elapsedMs = performance.now() - started;

		const text = result instanceof Error ? result.message : resultText(result as AgentToolResult);
		expect(text).toContain("exceeded its limit");
		// 2 s timeout × 60 calls/min = 2 calls; the third is refused, not dispatched.
		expect(calls).toBe(2);
		expect(elapsedMs).toBeLessThan(1000);
	});

	it("bounds parallel tool fan-out from one cell", async () => {
		const total = 20;
		const cap = 3;
		let active = 0;
		let peak = 0;
		let started = 0;
		const probe = fakeTool("probe", async () => {
			started++;
			active++;
			peak = Math.max(peak, active);
			// Simulated I/O: calls cross a real worker IPC boundary, so overlap only
			// shows if each call stays in flight across event-loop turns. No fake-clock
			// hook reaches the kernel's message delivery, hence a short real delay.
			await Bun.sleep(10);
			active--;
			return { content: [{ type: "text", text: "ok" }] };
		});
		const settings = Settings.isolated({
			"eval.autoBackground.enabled": false,
			"eval.tools.maxParallelCalls": cap,
		});
		const evalTool = new EvalTool(await makeSession(settings, probe));

		const result = await evalTool.execute("fanout", {
			language: "js",
			code: `const values = await Promise.all(Array.from({ length: ${total} }, () => tool.probe({}))); return values.length;`,
		});

		expect(result.isError).not.toBe(true);
		expect(started).toBe(total);
		expect(peak).toBeLessThanOrEqual(cap);
	});
});
