/**
 * Structural synopsis of large tool outputs that spill to an artifact.
 *
 * The head/tail preview of a spilled result hides the shape of structured data
 * (a JSON array's item keys, CSV columns, a source file's declarations). The
 * synopsis restores that shape in a few lines so the model can decide which
 * part of the artifact to read. Plain text and logs get none.
 */
import { formatBytes } from "@oh-my-pi/pi-tui/render/render-utils";
import { prompt } from "@oh-my-pi/pi-utils";
import outputSynopsisTemplate from "../prompts/tools/output-synopsis.md" with { type: "text" };

export const SYNOPSIS_MAX_INPUT_BYTES = 5 * 1024 * 1024;
export const SYNOPSIS_MAX_CHARS = 2000;

export type OutputSynopsisKind = "json" | "jsonl" | "csv" | "tsv" | "code";

export interface OutputSynopsis {
	kind: OutputSynopsisKind;
	bytes: number;
	lines: string[];
}

const KIND_LABELS: Record<OutputSynopsisKind, string> = {
	json: "JSON",
	jsonl: "JSON Lines",
	csv: "CSV",
	tsv: "TSV",
	code: "code-like text",
};

const MAX_ITEM_KEYS = 20;
const MAX_ENUM_KEYS = 4;
const MIN_ENUM_VALUES = 2;
const MAX_ENUM_VALUES = 8;
const MAX_OBJECT_KEYS = 24;
const MAX_ARRAY_KEYS = 4;
const MAX_NESTED_ITEM_KEYS = 12;
const MAX_COLUMNS = 24;
const SAMPLE_ROWS = 3;
const SAMPLE_ROW_CHARS = 200;
const TABLE_PROBE_LINES = 50;
const TABLE_MIN_CONSISTENCY = 0.8;
const CODE_MIN_LINES = 20;
const CODE_MIN_DECLARATIONS = 5;
const MAX_DECLARATIONS = 24;
const DECLARATION_CHARS = 120;
const LABEL_CHARS = 80;

const LEADING_FENCE_RE = /^```[\w-]*\n/;
const DECLARATION_RE =
	/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|def|fn|pub\s+(?:async\s+)?fn|struct|impl|trait|func)\s+[A-Za-z_$][\w$]*/;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cut(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function stripFence(text: string): string {
	const opening = LEADING_FENCE_RE.exec(text);
	if (!opening) return text;
	const rest = text.slice(opening[0].length).trimEnd();
	if (!rest.endsWith("```")) return text;
	return rest.slice(0, -3);
}

function tryParseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Keys of `items` by descending frequency; ties keep first-seen order. */
function keyFrequencies(items: readonly JsonObject[]): Array<[string, number]> {
	const counts = new Map<string, number>();
	for (const item of items) {
		for (const key of Object.keys(item)) counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts].sort((a, b) => b[1] - a[1]);
}

/** Distinct string values of `key` with counts, or undefined past {@link MAX_ENUM_VALUES}. */
function enumValues(items: readonly JsonObject[], key: string): Array<[string, number]> | undefined {
	const counts = new Map<string, number>();
	for (const item of items) {
		const value = item[key];
		if (typeof value !== "string") continue;
		counts.set(value, (counts.get(value) ?? 0) + 1);
		if (counts.size > MAX_ENUM_VALUES) return undefined;
	}
	if (counts.size < MIN_ENUM_VALUES) return undefined;
	return [...counts].sort((a, b) => b[1] - a[1]);
}

function itemLines(objects: readonly JsonObject[]): string[] {
	if (objects.length === 0) return [];
	const keys = keyFrequencies(objects);
	const lines = [
		`Item keys: ${keys
			.slice(0, MAX_ITEM_KEYS)
			.map(([key, count]) => `${cut(key, LABEL_CHARS)} ×${count}`)
			.join(", ")}`,
	];
	let enumKeys = 0;
	for (const [key] of keys) {
		if (enumKeys >= MAX_ENUM_KEYS) break;
		const values = enumValues(objects, key);
		if (!values) continue;
		enumKeys++;
		lines.push(
			`${cut(key, LABEL_CHARS)}: ${values.map(([value, count]) => `${JSON.stringify(cut(value, LABEL_CHARS))} ×${count}`).join(", ")}`,
		);
	}
	return lines;
}

function arraySynopsisLines(items: readonly unknown[]): string[] {
	const objects: JsonObject[] = [];
	let arrays = 0;
	for (const item of items) {
		if (isJsonObject(item)) objects.push(item);
		else if (Array.isArray(item)) arrays++;
	}
	const scalars = items.length - objects.length - arrays;
	return [
		`Top level: array of ${items.length} items (objects: ${objects.length}, arrays: ${arrays}, scalars: ${scalars})`,
		...itemLines(objects),
	];
}

function jsonTypeLabel(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return `array[${value.length}]`;
	if (typeof value === "object") return `object{${Object.keys(value).length}}`;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return typeof value;
	return "null";
}

function objectSynopsisLines(object: JsonObject): string[] {
	const entries = Object.entries(object);
	const lines = [
		`Top level: object with ${entries.length} keys: ${entries
			.slice(0, MAX_OBJECT_KEYS)
			.map(([key, value]) => `${cut(key, LABEL_CHARS)} (${jsonTypeLabel(value)})`)
			.join(", ")}`,
	];
	let arrayKeys = 0;
	for (const [key, value] of entries) {
		if (arrayKeys >= MAX_ARRAY_KEYS) break;
		if (!Array.isArray(value)) continue;
		arrayKeys++;
		const nested = keyFrequencies(value.filter(isJsonObject))
			.slice(0, MAX_NESTED_ITEM_KEYS)
			.map(([nestedKey]) => cut(nestedKey, LABEL_CHARS));
		lines.push(
			`${cut(key, LABEL_CHARS)}[]: ${value.length} items${nested.length > 0 ? `, keys: ${nested.join(", ")}` : ""}`,
		);
	}
	return lines;
}

function detectJson(body: string): string[] | undefined {
	const first = body.trimStart()[0];
	if (first !== "{" && first !== "[") return undefined;
	const parsed = tryParseJson(body);
	if (Array.isArray(parsed)) return arraySynopsisLines(parsed);
	if (isJsonObject(parsed)) return objectSynopsisLines(parsed);
	return undefined;
}

function detectJsonl(body: string): string[] | undefined {
	if (body.trimStart()[0] !== "{") return undefined;
	const objects: JsonObject[] = [];
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const parsed = tryParseJson(trimmed);
		if (!isJsonObject(parsed)) return undefined;
		objects.push(parsed);
	}
	if (objects.length < 2) return undefined;
	return [`Top level: ${objects.length} JSON objects, one per line`, ...itemLines(objects)];
}

/** Split one delimited line, honoring double quotes; fields trimmed and unquoted. */
function splitDelimited(line: string, delimiter: string): string[] {
	const fields: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quoted) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					quoted = false;
				}
			} else {
				field += ch;
			}
		} else if (ch === '"') {
			quoted = true;
		} else if (ch === delimiter) {
			fields.push(field.trim());
			field = "";
		} else {
			field += ch;
		}
	}
	fields.push(field.trim());
	return fields;
}

function detectTable(lines: readonly string[], delimiter: string): string[] | undefined {
	if (lines.length < 3) return undefined;
	const header = lines[0];
	if (!header.includes(delimiter)) return undefined;
	const columns = splitDelimited(header, delimiter);
	const probe = lines.slice(0, TABLE_PROBE_LINES);
	let consistent = 0;
	for (const line of probe) {
		if (splitDelimited(line, delimiter).length === columns.length) consistent++;
	}
	if (consistent / probe.length < TABLE_MIN_CONSISTENCY) return undefined;
	return [
		`${lines.length - 1} rows × ${columns.length} columns`,
		`Columns: ${columns
			.slice(0, MAX_COLUMNS)
			.map(column => cut(column, LABEL_CHARS))
			.join(", ")}`,
		"Sample rows:",
		...lines.slice(1, 1 + SAMPLE_ROWS).map(row => cut(row, SAMPLE_ROW_CHARS)),
	];
}

function detectCode(body: string): string[] | undefined {
	const lines = body.split("\n");
	if (lines.length < CODE_MIN_LINES) return undefined;
	const declarations: string[] = [];
	let matched = 0;
	for (let i = 0; i < lines.length; i++) {
		const match = DECLARATION_RE.exec(lines[i]);
		if (!match) continue;
		matched++;
		if (declarations.length < MAX_DECLARATIONS) {
			declarations.push(`L${i + 1} ${cut(match[0].trim(), DECLARATION_CHARS)}`);
		}
	}
	if (matched < CODE_MIN_DECLARATIONS) return undefined;
	return [`${lines.length} lines`, `Declarations: ${declarations.join(", ")}`];
}

/**
 * Detect the structure of `text`: JSON, JSON Lines, TSV/CSV, or code-like text.
 * Returns undefined for plain text and logs, and for inputs over
 * {@link SYNOPSIS_MAX_INPUT_BYTES}.
 */
export function buildOutputSynopsis(text: string): OutputSynopsis | undefined {
	const bytes = Buffer.byteLength(text, "utf-8");
	if (bytes > SYNOPSIS_MAX_INPUT_BYTES) return undefined;
	const body = stripFence(text);

	const json = detectJson(body);
	if (json) return { kind: "json", bytes, lines: json };
	const jsonl = detectJsonl(body);
	if (jsonl) return { kind: "jsonl", bytes, lines: jsonl };

	const nonEmptyLines = body
		.replace(/^\uFEFF/, "")
		.split("\n")
		.map(line => (line.endsWith("\r") ? line.slice(0, -1) : line))
		.filter(line => line.trim().length > 0);
	const tsv = detectTable(nonEmptyLines, "\t");
	if (tsv) return { kind: "tsv", bytes, lines: tsv };
	const csv = detectTable(nonEmptyLines, ",");
	if (csv) return { kind: "csv", bytes, lines: csv };

	const code = detectCode(body);
	if (code) return { kind: "code", bytes, lines: code };
	return undefined;
}

/** Render a synopsis as the text block placed before the spilled preview. */
export function renderOutputSynopsis(synopsis: OutputSynopsis, artifactId: string | undefined): string {
	const rendered = prompt.render(outputSynopsisTemplate, {
		artifactId,
		kindLabel: KIND_LABELS[synopsis.kind],
		size: formatBytes(synopsis.bytes),
		lines: synopsis.lines,
	});
	return rendered.length > SYNOPSIS_MAX_CHARS ? `${rendered.slice(0, SYNOPSIS_MAX_CHARS - 1)}…` : rendered;
}
