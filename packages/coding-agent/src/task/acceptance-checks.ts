/**
 * Deterministic, advisory checks of a subagent's delivery against
 * caller-supplied acceptance criteria. Outcomes annotate the task result; they
 * never change the run's status.
 */
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { type AcceptanceCheck, oneLineLabel, type ToolReceipt } from "@oh-my-pi/pi-tui/tools/task";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { escapeHarnessTags } from "../session/harness-tags";

export const MAX_ACCEPTANCE_CRITERIA = 12;
export const MAX_CRITERION_CHARS = 300;

const JSON_MAX_BYTES = 1_048_576;
const CSV_HEADER_BYTES = 64 * 1024;
const PARSE_ERROR_CHARS = 120;
const ISOLATED_NOT_APPLIED = "isolated run: changes not applied to the workspace";

const FILE_CRITERION_RE = /^file:\s*(.+?)\s+(exists|non-empty|json-valid|csv-columns:(.*))$/i;
const TESTS_PASSED_RE = /^tests_passed:\s*(.+)$/i;

/** Trimmed, tag-escaped, one-line criteria; empties dropped, first {@link MAX_ACCEPTANCE_CRITERIA} kept. */
export function normalizeAcceptanceCriteria(raw: readonly unknown[] | undefined): string[] {
	const criteria: string[] = [];
	for (const item of raw ?? []) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (!trimmed) continue;
		const text = oneLineLabel(escapeHarnessTags(trimmed), MAX_CRITERION_CHARS);
		if (!text) continue;
		criteria.push(text);
		if (criteria.length >= MAX_ACCEPTANCE_CRITERIA) break;
	}
	return criteria;
}

export async function runAcceptanceChecks(input: {
	criteria: readonly string[];
	cwd: string;
	receipts: readonly ToolReceipt[] | undefined;
	workspaceApplied: boolean;
}): Promise<AcceptanceCheck[]> {
	const checks: AcceptanceCheck[] = [];
	for (const criterion of input.criteria) {
		const { outcome, detail } = await checkCriterion(criterion, input);
		checks.push({ criterion, outcome, detail: escapeHarnessTags(detail) });
	}
	return checks;
}

type CheckVerdict = Omit<AcceptanceCheck, "criterion">;

async function checkCriterion(
	criterion: string,
	input: { cwd: string; receipts: readonly ToolReceipt[] | undefined; workspaceApplied: boolean },
): Promise<CheckVerdict> {
	const fileMatch = FILE_CRITERION_RE.exec(criterion);
	if (fileMatch) {
		if (!input.workspaceApplied) return { outcome: "unverified", detail: ISOLATED_NOT_APPLIED };
		const filePath = path.resolve(input.cwd, stripQuotes(fileMatch[1]));
		const predicate = fileMatch[2].toLowerCase();
		if (predicate === "exists") return checkExists(filePath);
		if (predicate === "non-empty") return checkNonEmpty(filePath);
		if (predicate === "json-valid") return checkJsonValid(filePath);
		const columns = splitCsvLine(fileMatch[3] ?? "", ",").filter(column => column.length > 0);
		return checkCsvColumns(filePath, columns);
	}
	const testsMatch = TESTS_PASSED_RE.exec(criterion);
	if (testsMatch) return checkTestsPassed(testsMatch[1], input.receipts);
	return { outcome: "unverified", detail: "not a checkable criterion" };
}

function stripQuotes(raw: string): string {
	const value = raw.trim();
	const first = value[0];
	if (value.length >= 2 && (first === "`" || first === '"' || first === "'") && value.at(-1) === first) {
		return value.slice(1, -1).trim();
	}
	return value;
}

/** `fs.stat`; ENOENT becomes does-not-hold, other errors unverified. */
async function statOrVerdict(filePath: string): Promise<Stats | CheckVerdict> {
	try {
		return await fs.stat(filePath);
	} catch (error) {
		if (isEnoent(error)) return { outcome: "does-not-hold", detail: "not found" };
		return { outcome: "unverified", detail: error instanceof Error ? error.message : String(error) };
	}
}

function isVerdict(value: object): value is CheckVerdict {
	return "outcome" in value;
}

async function checkExists(filePath: string): Promise<CheckVerdict> {
	const stat = await statOrVerdict(filePath);
	if (isVerdict(stat)) return stat;
	return stat.isFile() || stat.isDirectory()
		? { outcome: "holds", detail: "" }
		: { outcome: "does-not-hold", detail: "not a file or directory" };
}

async function checkNonEmpty(filePath: string): Promise<CheckVerdict> {
	const stat = await statOrVerdict(filePath);
	if (isVerdict(stat)) return stat;
	if (stat.isDirectory()) return { outcome: "does-not-hold", detail: "is a directory" };
	if (!stat.isFile()) return { outcome: "does-not-hold", detail: "not a regular file" };
	return stat.size > 0 ? { outcome: "holds", detail: "" } : { outcome: "does-not-hold", detail: "empty file" };
}

async function checkJsonValid(filePath: string): Promise<CheckVerdict> {
	const stat = await statOrVerdict(filePath);
	if (isVerdict(stat)) return stat;
	if (!stat.isFile()) return { outcome: "does-not-hold", detail: "not a regular file" };
	if (stat.size > JSON_MAX_BYTES) return { outcome: "unverified", detail: "larger than 1 MiB" };
	try {
		JSON.parse(await Bun.file(filePath).text());
		return { outcome: "holds", detail: "" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { outcome: "does-not-hold", detail: message.slice(0, PARSE_ERROR_CHARS) };
	}
}

async function checkCsvColumns(filePath: string, required: readonly string[]): Promise<CheckVerdict> {
	const stat = await statOrVerdict(filePath);
	if (isVerdict(stat)) return stat;
	if (!stat.isFile()) return { outcome: "does-not-hold", detail: "not a regular file" };
	const head = await Bun.file(filePath).slice(0, CSV_HEADER_BYTES).text();
	const newline = head.indexOf("\n");
	const headerLine = (newline === -1 ? head : head.slice(0, newline)).replace(/^\uFEFF/, "").replace(/\r$/, "");
	const header = new Set(splitCsvLine(headerLine, ","));
	const missing = required.filter(column => !header.has(column));
	return missing.length === 0
		? { outcome: "holds", detail: "" }
		: { outcome: "does-not-hold", detail: `missing: ${missing.join(", ")}` };
}

/** Quote-aware split of one delimited line; fields trimmed, surrounding double quotes removed. */
function splitCsvLine(line: string, delimiter: string): string[] {
	const fields: string[] = [];
	let current = "";
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === '"') {
			if (inQuotes && line[i + 1] === '"') {
				current += '"';
				i++;
			} else {
				inQuotes = !inQuotes;
			}
		} else if (char === delimiter && !inQuotes) {
			fields.push(current.trim());
			current = "";
		} else {
			current += char;
		}
	}
	fields.push(current.trim());
	return fields;
}

function checkTestsPassed(rawCommand: string, receipts: readonly ToolReceipt[] | undefined): CheckVerdict {
	if (receipts === undefined) {
		return { outcome: "unverified", detail: "no execution record (task.receipts.enabled is off)" };
	}
	const command = rawCommand.replace(/\s+/g, " ").trim();
	let match: ToolReceipt | undefined;
	for (const receipt of receipts) {
		if (receipt.toolName !== "bash" || receipt.command === undefined) continue;
		const segments = receipt.command
			.replace(/\s+/g, " ")
			.split(/&&|\|\||;|\|/)
			.map(segment => segment.trim());
		if (segments.some(segment => segment === command || segment.startsWith(`${command} `))) match = receipt;
	}
	if (!match) return { outcome: "unverified", detail: "no recorded run of this command" };
	if (match.status === "ok" && match.testOutcome === "passed") return { outcome: "holds", detail: `[${match.id}]` };
	if (match.testOutcome === "failed" || match.status === "error") {
		return {
			outcome: "does-not-hold",
			detail: match.exitCode === undefined ? `[${match.id}] failed` : `[${match.id}] exit ${match.exitCode}`,
		};
	}
	return { outcome: "unverified", detail: `[${match.id}] no test summary recognized` };
}
