import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { postProcessToolResult } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import {
	buildOutputSynopsis,
	renderOutputSynopsis,
	SYNOPSIS_MAX_CHARS,
	SYNOPSIS_MAX_INPUT_BYTES,
} from "@oh-my-pi/pi-coding-agent/tools/output-synopsis";
import { TempDir } from "@oh-my-pi/pi-utils";

function issues(count: number): Array<{ id: number; title: string; state: string }> {
	return Array.from({ length: count }, (_, i) => ({
		id: i + 1,
		title: `Issue number ${i + 1}`,
		state: i % 2 === 0 ? "open" : "closed",
	}));
}

describe("buildOutputSynopsis", () => {
	it("summarizes a JSON array of objects with keys and enum values", () => {
		const synopsis = buildOutputSynopsis(JSON.stringify(issues(340), null, 2));
		expect(synopsis?.kind).toBe("json");
		const text = synopsis?.lines.join("\n") ?? "";
		expect(text).toContain("array of 340 items");
		expect(text).toContain("Item keys: id ×340");
		expect(text).toContain('state: "open" ×170');
		expect(text).not.toContain("title:");
	});

	it("parses a fenced json block", () => {
		const synopsis = buildOutputSynopsis(`\`\`\`json\n${JSON.stringify({ items: issues(3), total: 3 })}\n\`\`\``);
		expect(synopsis?.kind).toBe("json");
		expect(synopsis?.lines[0]).toBe("Top level: object with 2 keys: items (array[3]), total (number)");
		expect(synopsis?.lines[1]).toBe("items[]: 3 items, keys: id, title, state");
	});

	it("detects JSON Lines", () => {
		const text = issues(3)
			.map(item => JSON.stringify(item))
			.join("\n");
		const synopsis = buildOutputSynopsis(text);
		expect(synopsis?.kind).toBe("jsonl");
		expect(synopsis?.lines.join("\n")).toContain("Item keys: id ×3");
	});

	it("detects CSV with rows, columns, and samples", () => {
		const rows = ["id,name,age", ...Array.from({ length: 100 }, (_, i) => `${i},"Name, ${i}",${20 + i}`)];
		const synopsis = buildOutputSynopsis(rows.join("\n"));
		expect(synopsis?.kind).toBe("csv");
		expect(synopsis?.lines[0]).toBe("100 rows × 3 columns");
		expect(synopsis?.lines[1]).toBe("Columns: id, name, age");
		expect(synopsis?.lines[2]).toBe("Sample rows:");
		expect(synopsis?.lines[3]).toBe('0,"Name, 0",20');
		expect(synopsis?.lines).toHaveLength(6);
	});

	it("detects code-like text by declarations", () => {
		const lines: string[] = [];
		for (let i = 0; i < 6; i++) {
			lines.push(`export function fn${i}(value: number): number {`, "\treturn value;", "}", "");
		}
		while (lines.length < 30) lines.push("// filler");
		const synopsis = buildOutputSynopsis(lines.join("\n"));
		expect(synopsis?.kind).toBe("code");
		expect(synopsis?.lines[0]).toBe("30 lines");
		expect(synopsis?.lines[1]).toStartWith("Declarations: L1 export function fn0, L5 export function fn1");
	});

	it("returns undefined for plain log text", () => {
		const log = Array.from({ length: 200 }, (_, i) => `[info] step ${i} completed in ${i * 3}ms`).join("\n");
		expect(buildOutputSynopsis(log)).toBeUndefined();
	});

	it("returns undefined above the input size cap", () => {
		const big = JSON.stringify(["x".repeat(SYNOPSIS_MAX_INPUT_BYTES)]);
		expect(buildOutputSynopsis(big)).toBeUndefined();
	});
});

describe("renderOutputSynopsis", () => {
	it("renders the header with artifact link and bullet lines", () => {
		const text = renderOutputSynopsis({ kind: "json", bytes: 2048, lines: ["a", "b"] }, "7");
		expect(text).toStartWith("[Synopsis of the full output (artifact://7): JSON, ");
		expect(text).toContain("\n- a\n- b");
	});

	it("omits the artifact link when none is known and caps length", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(40)}`);
		const text = renderOutputSynopsis({ kind: "csv", bytes: 10, lines }, undefined);
		expect(text).toStartWith("[Synopsis of the full output: CSV, ");
		expect(text.length).toBe(SYNOPSIS_MAX_CHARS);
		expect(text.endsWith("…")).toBe(true);
	});
});

describe("spill synopsis", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) await cleanup();
	});

	async function spillContext(overrides: Record<string, unknown> = {}): Promise<{
		context: AgentToolContext;
		manager: SessionManager;
	}> {
		const tempDir = TempDir.createSync("@omp-output-synopsis-");
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		await manager.ensureOnDisk();
		cleanups.push(async () => {
			await manager.close();
			tempDir.removeSync();
		});
		const settings = Settings.isolated({
			"tools.artifactSpillThreshold": 20,
			"tools.artifactTailBytes": 2,
			"tools.artifactTailLines": 10,
			"tools.artifactHeadBytes": 2,
			...overrides,
		});
		const context = { sessionManager: manager, settings, toolNames: ["probe"] } as unknown as AgentToolContext;
		return { context, manager };
	}

	function textResult(text: string, details?: AgentToolResult["details"]): AgentToolResult {
		return { content: [{ type: "text", text }], details };
	}

	it("prepends a synopsis when a JSON result spills", async () => {
		const { context } = await spillContext();
		const result = await postProcessToolResult(textResult(JSON.stringify(issues(500), null, 2)), "probe", context);
		expect(result.content).toHaveLength(2);
		const [synopsis, preview] = result.content;
		expect(synopsis.type === "text" && synopsis.text).toStartWith("[Synopsis of the full output (artifact://");
		expect(synopsis.type === "text" && synopsis.text).toContain("array of 500 items");
		expect(preview.type === "text" && preview.text).toContain("artifact://");
	});

	it("leaves plain-text spills without a synopsis", async () => {
		const { context } = await spillContext();
		const log = Array.from({ length: 3000 }, (_, i) => `[info] step ${i} done`).join("\n");
		const result = await postProcessToolResult(textResult(log), "probe", context);
		expect(result.content).toHaveLength(1);
		expect(result.content[0].type === "text" && result.content[0].text).not.toContain("[Synopsis");
	});

	it("respects tools.outputSynopsis=false", async () => {
		const { context } = await spillContext({ "tools.outputSynopsis": false });
		const result = await postProcessToolResult(textResult(JSON.stringify(issues(500))), "probe", context);
		expect(result.content).toHaveLength(1);
	});

	it("prepends a synopsis from an artifact the tool already saved", async () => {
		const { context, manager } = await spillContext();
		const full = issues(500)
			.map(item => JSON.stringify(item))
			.join("\n");
		const artifactId = await manager.saveArtifact(full, "bash");
		if (!artifactId) throw new Error("expected an artifact id");
		const truncation = {
			direction: "tail" as const,
			truncatedBy: "bytes" as const,
			totalLines: 500,
			totalBytes: full.length,
			outputLines: 1,
			outputBytes: 10,
			artifactId,
		};
		const result = await postProcessToolResult(textResult("tail line", { meta: { truncation } }), "bash", context);
		const first = result.content[0];
		expect(first.type === "text" && first.text).toStartWith(
			`[Synopsis of the full output (artifact://${artifactId}): JSON Lines`,
		);
		expect(result.content[1].type === "text" && result.content[1].text).toStartWith("tail line");

		const sampled = await postProcessToolResult(
			textResult("tail line", { meta: { truncation: { ...truncation, artifactElidedBytes: 100 } } }),
			"bash",
			context,
		);
		expect(sampled.content).toHaveLength(1);
	});
});
