import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "../src/config/settings";
import type { ToolSession } from "../src/tools";
import { EvalTool } from "../src/tools/eval";
import { generateCodeModeDeclarations } from "@oh-my-pi/pi-tui/tools/eval-format/code-mode-declarations";

describe("generateCodeModeDeclarations", () => {
	test("emits self-contained args/output maps and the typed tool proxy", () => {
		const out = generateCodeModeDeclarations([
			{
				name: "read",
				parameters: {
					type: "object",
					properties: { path: { type: "string" }, limit: { type: "number" } },
					required: ["path"],
				},
			},
		]);
		expect(out.split("\n")).toEqual([
			"interface ToolArgsMap {",
			"  read: {",
			"    path: string;",
			"    limit?: number;",
			"  };",
			"}",
			"interface ToolOutputMap {",
			"  read: string | { text: string; details?: unknown };",
			"}",
			"type ToolName = keyof ToolOutputMap;",
			'declare class ToolCallError extends Error { readonly name: "ToolCallError"; readonly toolName: ToolName; readonly text: string; readonly details?: unknown }',
			"declare const tool: { [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]> };",
		]);
	});
	test("enums become literal unions", () => {
		const out = generateCodeModeDeclarations([
			{
				name: "todo",
				parameters: { type: "object", properties: { op: { enum: ["init", "done"] } }, required: ["op"] },
			},
		]);
		expect(out).toContain('op: "init" | "done"');
	});
	test("union item types stay grouped inside arrays", () => {
		const out = generateCodeModeDeclarations([
			{
				name: "chmod",
				parameters: {
					type: "object",
					properties: { modes: { type: "array", items: { enum: ["read", "write"] } } },
					required: ["modes"],
				},
			},
		]);
		expect(out).toContain('modes: Array<"read" | "write">');
	});
	test("non-identifier property keys stay quoted", () => {
		const out = generateCodeModeDeclarations([
			{
				name: "cfg",
				parameters: { type: "object", properties: { "some-flag": { type: "string" } }, required: ["some-flag"] },
			},
		]);
		expect(out).toContain('"some-flag": string');
	});
	test("quotes non-identifier tool names", () => {
		const out = generateCodeModeDeclarations([{ name: "my-tool", parameters: { type: "object" } }]);
		expect(out).toContain('  "my-tool": unknown;');
	});
	test("exotic schemas degrade to unknown without throwing", () => {
		const out = generateCodeModeDeclarations([{ name: "weird", parameters: { allOf: [{ type: "string" }] } }]);
		expect(out).toContain("  weird: unknown;");
	});
	test("renders nested argument types at any depth", () => {
		const out = generateCodeModeDeclarations([
			{
				name: "deep",
				parameters: type({ a: { b: { c: { d: "string" } } } }),
			},
		]);
		expect(out).toContain("d: string;");
		expect(out).not.toContain("unknown;\n");
	});
	test("an outputSchema types the resolved value as { text, details }", () => {
		const out = generateCodeModeDeclarations([
			{
				name: "glob",
				parameters: type({ pattern: "string" }),
				outputSchema: type({ "fileCount?": "number", "files?": "string[]" }),
			},
		]);
		expect(out).toContain(
			"  glob: { text: string; details: {\n    fileCount?: number;\n    files?: string[];\n  } };",
		);
		expect(out).not.toContain("glob: string |");
	});
	test("the first description line becomes one-line JSDoc", () => {
		const out = generateCodeModeDeclarations([
			{
				name: "grep",
				parameters: type({ pattern: "string" }),
				description: "Search file contents by regex */ safely\nSecond line is dropped.",
			},
		]);
		expect(out).toContain("  /** Search file contents by regex * / safely */\n  grep: {");
		expect(out).not.toContain("Second line");
	});
});

test("EvalTool advertises only tools authorized for its bridge", () => {
	const read = { name: "read", parameters: type({ path: "string" }) };
	const write = { name: "write", parameters: type({ path: "string", content: "string" }) };
	const session = {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		settings: Settings.isolated({ "providers.openai-codex.codeMode": "auto" }),
		toolRegistry: new Map<string, { name: string; parameters: object }>([
			["read", read],
			["write", write],
		]),
		getEvalBridgeToolNames: () => ["eval", "read"],
		getCodeModeDirectToolNames: () => ["eval"],
	} as unknown as ToolSession;

	const description = new EvalTool(session).description;

	expect(description).toContain("\n  read: {");
	expect(description).not.toContain("\n  write: {");
});

test("EvalTool omits tools the model can still call directly", () => {
	// Plan mode keeps `write` direct as the xd://propose transport; advertising it
	// as bridged would nest plan approval inside an eval result.
	const read = { name: "read", parameters: type({ path: "string" }) };
	const write = { name: "write", parameters: type({ path: "string", content: "string" }) };
	const session = {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		settings: Settings.isolated(),
		toolRegistry: new Map<string, typeof read | typeof write>([
			["read", read],
			["write", write],
		]),
		getEvalBridgeToolNames: () => ["eval", "read", "write"],
		getCodeModeDirectToolNames: () => ["eval", "write"],
	} as unknown as ToolSession;

	const description = new EvalTool(session).description;

	expect(description).toContain("\n  read: {");
	expect(description).not.toContain("\n  write: {");
});

test("EvalTool advertises bridged tool declarations only while Code Mode is active", () => {
	const read = { name: "read", parameters: type({ path: "string" }) };
	let preludeEnabled = true;
	const prelude = {
		name: "fixture",
		documentation: "fixture docs",
		javascript: "",
		python: "",
		exports: [],
		codeModeDeclarations: "declare const fixturePreludeDeclaration: true;",
		enabled: () => preludeEnabled,
		async invoke() {
			return { content: [] };
		},
	};
	const baseSession = {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		settings: Settings.isolated(),
		toolRegistry: new Map([["read", read]]),
		getEvalBridgeToolNames: () => ["eval", "read"],
		getEvalPreludes: () => [prelude],
	};
	const activeTool = new EvalTool({
		...baseSession,
		getCodeModeDirectToolNames: () => ["eval"],
	} as unknown as ToolSession);
	const active = activeTool.description;
	expect(active).toContain("declare const tool: { [K in ToolName]");
	expect(active).toContain("\n  read: {");
	expect(active).toContain("rejects with `ToolCallError`");
	expect(active).toContain("declare const fixturePreludeDeclaration: true;");

	preludeEnabled = false;
	expect(activeTool.description).not.toContain("fixturePreludeDeclaration");

	const inactive = new EvalTool({
		...baseSession,
		getCodeModeDirectToolNames: () => undefined,
	} as unknown as ToolSession).description;
	expect(inactive).not.toContain("declare const tool");
	expect(inactive).not.toContain("\n  read: {");
	expect(inactive).not.toContain("fixturePreludeDeclaration");
	// Plain eval points at the typed signatures instead of paying for them per request.
	expect(inactive).toContain("xd://eval/tools");
});

test("EvalTool serves typed bridge signatures as the xd://eval/tools topic", () => {
	const glob = {
		name: "glob",
		description: "Find files by glob\nMore detail.",
		parameters: type({ pattern: "string" }),
		outputSchema: type({ "fileCount?": "number" }),
	};
	const read = { name: "read", parameters: type({ path: "string" }) };
	const session = {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		settings: Settings.isolated(),
		toolRegistry: new Map<string, object>([
			["glob", glob],
			["read", read],
		]),
		getEvalBridgeToolNames: () => ["eval", "glob", "read"],
	} as unknown as ToolSession;

	const topic = new EvalTool(session).docTopics().tools;

	expect(topic).toContain("raises `ToolCallError` (`tool_name`, `text`, `details`)");
	expect(topic).toContain("  /** Find files by glob */\n  glob: {");
	expect(topic).toContain("  glob: { text: string; details: {\n    fileCount?: number;\n  } };");
	expect(topic).toContain("  read: string | { text: string; details?: unknown };");
	expect(topic).not.toContain("More detail.");
});

test("EvalTool withholds Code Mode transport support when the JS backend is disabled", () => {
	const session = {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		settings: Settings.isolated({ "eval.js": false, "eval.py": true }),
		toolRegistry: new Map(),
		getEvalBridgeToolNames: () => ["eval"],
	} as unknown as ToolSession;

	expect(new EvalTool(session).supportsCodeModeTransport()).toBe(false);
});
