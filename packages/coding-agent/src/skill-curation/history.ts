/**
 * History of skill curation edits: one JSON file per edit under
 * `<agentDir>/skill-history/<skill>/<createdAt>.json`, holding every changed
 * file before and after, so an edit can be shown as a diff and reverted.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { diffMentalModelContent } from "../hindsight/mental-models";

export interface SkillHistoryFile {
	/** Absolute path of the edited file. */
	path: string;
	/** Path relative to the skill directory. */
	relativePath: string;
	/** `null`: the file did not exist (the edit created it). */
	before: string | null;
	/** `null`: the edit deleted the file. */
	after: string | null;
	/**
	 * The exact replacements that turned `before` into `after`, in order; absent
	 * when the change also rewrote, created or deleted the file. Lets a proposal
	 * still apply after another approved change touched other parts of the file.
	 */
	edits?: SkillTextEdit[];
}

export interface SkillTextEdit {
	oldText: string;
	newText: string;
}

export interface SkillHistoryEntry {
	/** `<skill key>/<createdAt>`; the skill key is the name with `/` replaced by `__`. */
	id: string;
	skill: string;
	createdAt: number;
	summary: string;
	files: SkillHistoryFile[];
	revertedAt?: number;
}

/** An entry as listed (`omp skill history --json`): changed files and a compact diff instead of full contents. */
export interface SkillHistorySummary {
	id: string;
	skill: string;
	createdAt: number;
	summary: string;
	files: string[];
	diff: string;
	revertedAt?: number;
}

/** `<skill key>/<createdAt>`: the id shape of history entries and proposals. */
export const SKILL_ENTRY_ID_RE = /^[^/\\]+\/\d+$/;
const DIFF_CONTEXT_LINES = 2;
const MAX_DIFF_LINES = 80;

export function skillHistoryDir(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "skill-history");
}

/** A skill name as a directory name: `/` becomes `__`. */
export function skillKey(name: string): string {
	return name.replaceAll("/", "__");
}

/** Record one curation edit; `createdAt` is now. */
export async function writeSkillHistoryEntry(
	input: { skill: string; summary: string; files: SkillHistoryFile[] },
	agentDir?: string,
): Promise<SkillHistoryEntry> {
	const createdAt = Date.now();
	const key = skillKey(input.skill);
	const entry: SkillHistoryEntry = { id: `${key}/${createdAt}`, createdAt, ...input };
	await Bun.write(path.join(skillHistoryDir(agentDir), key, `${createdAt}.json`), JSON.stringify(entry, null, 2));
	return entry;
}

/** Entries newest first, optionally for one skill; summaries carry a compact diff per file. */
export async function listSkillHistory(
	options: { skill?: string; limit?: number } = {},
	agentDir?: string,
): Promise<SkillHistorySummary[]> {
	const root = skillHistoryDir(agentDir);
	let keys: string[];
	try {
		keys = await fs.readdir(root);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const entries: SkillHistoryEntry[] = [];
	for (const key of keys) {
		let files: string[];
		try {
			files = await fs.readdir(path.join(root, key));
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			const entry: SkillHistoryEntry = await Bun.file(path.join(root, key, file)).json();
			if (options.skill === undefined || entry.skill === options.skill) entries.push(entry);
		}
	}
	entries.sort((a, b) => b.createdAt - a.createdAt);
	return entries.slice(0, options.limit ?? entries.length).map(entry => ({
		id: entry.id,
		skill: entry.skill,
		createdAt: entry.createdAt,
		summary: entry.summary,
		files: entry.files.map(file => file.relativePath),
		diff: entry.files.map(skillFileDiff).join("\n"),
		...(entry.revertedAt !== undefined && { revertedAt: entry.revertedAt }),
	}));
}

/** Plain-text listing: one header line per entry, then its diff indented by two spaces. */
export function formatSkillHistory(entries: readonly SkillHistorySummary[]): string {
	if (entries.length === 0) return "No skill self-improvement edits yet.";
	return entries
		.map(entry => {
			const header = `${entry.id}  ${new Date(entry.createdAt).toISOString()}  ${entry.skill}: ${entry.summary}${entry.revertedAt !== undefined ? " (reverted)" : ""}`;
			const diff = entry.diff
				.split("\n")
				.map(line => `  ${line}`)
				.join("\n");
			return `${header}\n${diff}`;
		})
		.join("\n\n");
}

/**
 * Restore every file of entry `id` to its content before the edit. Refuses,
 * writing nothing, when the entry is unknown or already reverted, or when any
 * file changed since the edit.
 */
export async function revertSkillHistoryEntry(id: string, agentDir?: string): Promise<SkillHistoryEntry> {
	if (!SKILL_ENTRY_ID_RE.test(id)) throw new Error(`unknown history entry: ${id}`);
	const entryPath = path.join(skillHistoryDir(agentDir), `${id}.json`);
	let entry: SkillHistoryEntry;
	try {
		entry = await Bun.file(entryPath).json();
	} catch (error) {
		if (isEnoent(error)) throw new Error(`unknown history entry: ${id}`);
		throw error;
	}
	if (entry.revertedAt !== undefined) throw new Error(`already reverted: ${id}`);
	const changed: string[] = [];
	for (const file of entry.files) {
		if ((await readSkillFile(file.path)) !== file.after) changed.push(file.relativePath);
	}
	if (changed.length > 0) throw new Error(`changed since the update: ${changed.join(", ")}`);
	for (const file of entry.files) await writeSkillFile(file.path, file.before);
	entry.revertedAt = Date.now();
	await Bun.write(entryPath, JSON.stringify(entry, null, 2));
	return entry;
}

/** A skill file's content, or `null` when it does not exist. */
export async function readSkillFile(filePath: string): Promise<string | null> {
	try {
		return await Bun.file(filePath).text();
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

/**
 * Give a skill file `content`; `null` deletes it. A file this creates that
 * starts with a shebang is made executable, since skills run their scripts.
 */
export async function writeSkillFile(filePath: string, content: string | null): Promise<void> {
	if (content === null) {
		await fs.rm(filePath, { force: true });
		return;
	}
	const created = (await readSkillFile(filePath)) === null;
	await Bun.write(filePath, content);
	if (created && content.startsWith("#!")) await fs.chmod(filePath, 0o755);
}

/** `--- <relative path>` (marked when created or deleted) plus the file's compact diff. */
export function skillFileDiff(file: SkillHistoryFile): string {
	const mark = file.before === null ? " (new file)" : file.after === null ? " (deleted)" : "";
	return `--- ${file.relativePath}${mark}\n${compactSkillDiff(file.before ?? "", file.after ?? "")}`;
}

/** Changed lines (`- `/`+ `) with two lines of context, `…` between hunks, at most 80 lines. */
export function compactSkillDiff(before: string, after: string): string {
	const lines = diffMentalModelContent(before, after, Number.MAX_SAFE_INTEGER).split("\n");
	const changed = lines.map(line => line.startsWith("- ") || line.startsWith("+ "));
	const keep = changed.map((_, index) =>
		changed.slice(Math.max(0, index - DIFF_CONTEXT_LINES), index + DIFF_CONTEXT_LINES + 1).some(Boolean),
	);
	const out: string[] = [];
	let previous = -1;
	keep.forEach((kept, index) => {
		if (!kept) return;
		if (previous !== -1 && index !== previous + 1) out.push("…");
		out.push(lines[index]);
		previous = index;
	});
	if (out.length <= MAX_DIFF_LINES) return out.join("\n");
	return `${out.slice(0, MAX_DIFF_LINES).join("\n")}\n[…${out.length - MAX_DIFF_LINES} lines]`;
}
