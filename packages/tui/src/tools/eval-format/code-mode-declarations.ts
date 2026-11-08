/**
 * Generate the TypeScript declarations advertising eval-bridged tools: the
 * Codex Code Mode prompt splices them in (mirroring codex-rs
 * augment_tool_spec_for_code_mode), and plain eval serves them on demand at
 * `xd://eval/tools`.
 */
import { jsonSchemaToTypeScript } from "@oh-my-pi/pi-ai/utils/schema/typescript";
import { arkToWireSchema, isArkSchema } from "@oh-my-pi/pi-ai/utils/schema/wire";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";

export interface CodeModeToolSpec {
	name: string;
	parameters: unknown;
	/** Tool description; only its first line is rendered, as JSDoc. */
	description?: string;
	/** Shape of `details` on success; tools with one always resolve `{ text, details }`. */
	outputSchema?: unknown;
}

const TS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const DESCRIPTION_MAX_CHARS = 160;
const MEMBER_PAD = "  ";

function wireSchema(schema: unknown): Record<string, unknown> | undefined {
	const wire = isArkSchema(schema) ? arkToWireSchema(schema) : schema;
	return wire !== null && typeof wire === "object" && !Array.isArray(wire)
		? (wire as Record<string, unknown>)
		: undefined;
}

/** Nests a rendered schema one level inside an interface body. */
function memberType(schema: Record<string, unknown>): string {
	return jsonSchemaToTypeScript(schema).replaceAll("\n", `\n${MEMBER_PAD}`);
}

function argsType(parameters: unknown): string {
	const wire = wireSchema(parameters);
	// Exotic roots (allOf, bare records) give the model nothing to fill in.
	return wire?.type === "object" && wire.properties ? memberType(wire) : "unknown";
}

function outputType(outputSchema: unknown): string {
	const json = outputSchema === undefined ? undefined : outputJsonSchema(outputSchema);
	if (!isRecord(json)) return "string | { text: string; details?: unknown }";
	return `{ text: string; details: ${memberType(json)} }`;
}

const outputJsonSchemaCache = new WeakMap<object, unknown>();

/**
 * JSON Schema for a tool's `outputSchema`. Unlike the closed model-facing
 * argument wire, objects stay open: `details` routinely carries presentation
 * fields beyond the documented contract.
 */
export function outputJsonSchema(schema: unknown): unknown {
	if (!isArkSchema(schema)) return schema;
	let json = outputJsonSchemaCache.get(schema);
	if (json === undefined) {
		const raw = schema.toJsonSchema({ target: "draft-2020-12", fallback: ctx => ctx.base }) as Record<
			string,
			unknown
		>;
		const { $schema: _dialect, ...rest } = raw;
		json = rest;
		outputJsonSchemaCache.set(schema, json);
	}
	return json;
}

function descriptionLine(description: string | undefined): string | undefined {
	const first = description?.trim().split("\n", 1)[0]?.trim();
	if (!first) return undefined;
	const clipped = first.length > DESCRIPTION_MAX_CHARS ? `${first.slice(0, DESCRIPTION_MAX_CHARS - 1)}…` : first;
	return clipped.replaceAll("*/", "* /");
}

/** Format tool schemas as self-contained TypeScript declarations for the `tool` proxy. */
export function generateCodeModeDeclarations(tools: ReadonlyArray<CodeModeToolSpec>): string {
	const args: string[] = [];
	const outputs: string[] = [];
	for (const tool of tools) {
		const key = TS_IDENTIFIER.test(tool.name) ? tool.name : JSON.stringify(tool.name);
		const doc = descriptionLine(tool.description);
		if (doc) args.push(`${MEMBER_PAD}/** ${doc} */`);
		args.push(`${MEMBER_PAD}${key}: ${argsType(tool.parameters)};`);
		outputs.push(`${MEMBER_PAD}${key}: ${outputType(tool.outputSchema)};`);
	}
	return [
		"interface ToolArgsMap {",
		...args,
		"}",
		"interface ToolOutputMap {",
		...outputs,
		"}",
		"type ToolName = keyof ToolOutputMap;",
		'declare class ToolCallError extends Error { readonly name: "ToolCallError"; readonly toolName: ToolName; readonly text: string; readonly details?: unknown }',
		"declare const tool: { [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]> };",
	].join("\n");
}
