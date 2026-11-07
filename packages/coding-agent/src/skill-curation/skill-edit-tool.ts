import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isEnoent, parseFrontmatter } from "@oh-my-pi/pi-utils";
import type { Skill } from "../extensibility/skills";
import skillEditDescription from "../prompts/tools/skill-edit.md" with { type: "text" };
import { compactSkillDiff, type SkillTextEdit } from "./history";

const skillEditSchema = type({
	skill: type("string").describe("skill name as listed in the maintenance request"),
	"file?": type("string").describe("file inside the skill directory, relative to it; default SKILL.md"),
	"old_text?": type("string").describe(
		"exact text to replace; must occur exactly once; omit to rewrite the whole file or create a new one",
	),
	"new_text?": type("string").describe(
		"replacement text (an empty string deletes old_text), or the whole new file; required unless delete",
	),
	"delete?": type("boolean").describe("delete the file; not allowed for SKILL.md"),
	summary: type("string").describe("one user-facing line: what the skill will now get right"),
	reason: type("string").describe("evidence from the transcript or the skill: why this makes the skill better"),
});

export type SkillEditParams = typeof skillEditSchema.infer;

/** Agent Skills limit for the frontmatter `description`. */
const MAX_DESCRIPTION_CHARS = 1024;
/** Agent Skills guidance for the SKILL.md body. */
const MAX_BODY_LINES = 500;
const MAX_SUMMARY_CHARS = 200;
const MAX_REASON_CHARS = 600;
const MAX_FILE_BYTES = 256 * 1024;

export interface SkillEditFile {
	relativePath: string;
	/** `null`: the file does not exist yet. */
	before: string | null;
	/** `null`: the file is deleted. */
	after: string | null;
	/** Every change so far as exact replacements; absent once a call rewrote, created or deleted the file. */
	edits?: SkillTextEdit[];
}

export interface SkillEditRecord {
	skill: Skill;
	/** By absolute path: content before the first edit and after the latest. */
	files: Map<string, SkillEditFile>;
	summaries: string[];
	reasons: string[];
}

function failure(text: string): AgentToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

function lineCount(text: string | null): number {
	if (!text) return 0;
	const parts = text.split("\n").length;
	return text.endsWith("\n") ? parts - 1 : parts;
}

function wordCount(text: string | null): number {
	return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function signed(delta: number): string {
	return delta > 0 ? `+${delta}` : delta < 0 ? String(delta) : "±0";
}

/**
 * The only write tool of a skill curation turn: stages exact-match replacements,
 * whole-file rewrites, new files and deletions in the files of the skills it was
 * created for, keeping SKILL.md's frontmatter valid and within the Agent Skills
 * limits. Nothing touches disk — the controller turns each skill's staged files
 * (`edits`) into a proposal.
 */
export class SkillEditTool implements AgentTool<typeof skillEditSchema> {
	readonly name = "skill_edit";
	readonly approval = "write" as const;
	readonly label = "Skill Edit";
	readonly description = skillEditDescription;
	readonly parameters = skillEditSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Edit an omp skill in place";
	/** By skill name. */
	readonly edits = new Map<string, SkillEditRecord>();
	readonly #skills: Map<string, Skill>;
	/**
	 * Calls run one at a time: each builds on the file as staged by the previous
	 * one, and a model often sends several edits in one message. Run concurrently,
	 * two edits of one file both start from disk and the later drops the earlier.
	 */
	#queue: Promise<unknown> = Promise.resolve();

	constructor(skills: readonly Skill[]) {
		this.#skills = new Map(skills.map(skill => [skill.name, skill]));
	}

	execute(_id: string, params: SkillEditParams): Promise<AgentToolResult> {
		const run = this.#queue.then(() => this.#execute(params));
		this.#queue = run.catch(() => {});
		return run;
	}

	async #execute(params: SkillEditParams): Promise<AgentToolResult> {
		const skill = this.#skills.get(params.skill);
		if (!skill) {
			return failure(
				`"${params.skill}" is not editable here. Editable skills: ${[...this.#skills.keys()].join(", ")}.`,
			);
		}
		const summary = params.summary.trim();
		if (!summary || /[\r\n]/.test(summary) || summary.length > MAX_SUMMARY_CHARS) {
			return failure(`summary must be one non-empty line of at most ${MAX_SUMMARY_CHARS} characters.`);
		}
		const reason = params.reason.trim();
		if (!reason || reason.length > MAX_REASON_CHARS) {
			return failure(`reason must be non-empty and at most ${MAX_REASON_CHARS} characters.`);
		}
		const absolute = path.resolve(skill.baseDir, params.file ?? "SKILL.md");
		const relativePath = path.relative(skill.baseDir, absolute);
		if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
			return failure(`file must stay inside the skill directory ${skill.baseDir}.`);
		}
		const isSkillFile = absolute === skill.filePath;
		if (params.delete && isSkillFile) return failure("SKILL.md cannot be deleted.");
		if (!params.delete && params.new_text === undefined) return failure("new_text is required unless delete is set.");

		const record = this.edits.get(skill.name);
		const staged = record?.files.get(absolute);
		let current: string | null;
		if (staged) {
			current = staged.after;
		} else {
			try {
				const stat = await fs.stat(absolute);
				if (!stat.isFile()) return failure(`${relativePath} is not a file.`);
				if (stat.size > MAX_FILE_BYTES) return failure(`${relativePath} is larger than ${MAX_FILE_BYTES} bytes.`);
				current = await Bun.file(absolute).text();
			} catch (error) {
				if (!isEnoent(error)) throw error;
				current = null;
			}
		}
		if (current?.includes("\0")) return failure(`${relativePath} is not a text file.`);

		let next: string | null;
		let insertion = false;
		let replaced: SkillTextEdit | undefined;
		if (params.delete) {
			if (current === null) return failure(`${relativePath}: file not found.`);
			next = null;
		} else if (params.old_text === undefined) {
			const text = params.new_text ?? "";
			if (!text.trim()) return failure("a whole-file rewrite must not be empty; set delete to remove the file.");
			if (Buffer.byteLength(text) > MAX_FILE_BYTES)
				return failure(`new_text is larger than ${MAX_FILE_BYTES} bytes.`);
			next = text;
		} else {
			if (current === null) {
				return failure(`${relativePath}: file not found; omit old_text to create it with new_text as its content.`);
			}
			if (!params.old_text) return failure("old_text must not be empty; omit it to rewrite the whole file.");
			const occurrences = current.split(params.old_text).length - 1;
			if (occurrences !== 1) {
				return failure(
					`old_text occurs ${occurrences} times in ${relativePath}; it must occur exactly once (add surrounding text).`,
				);
			}
			const replacement = params.new_text ?? "";
			next = current.replace(params.old_text, () => replacement);
			insertion = replacement.length > params.old_text.length && replacement.includes(params.old_text);
			replaced = { oldText: params.old_text, newText: replacement };
		}

		if (isSkillFile && current !== null && next !== null) {
			const invalid = validateSkillFile(current, next, absolute);
			if (invalid) return failure(invalid);
		}

		const target: SkillEditRecord = record ?? { skill, files: new Map(), summaries: [], reasons: [] };
		this.edits.set(skill.name, target);
		if (staged) {
			staged.after = next;
			staged.edits = replaced && staged.edits ? [...staged.edits, replaced] : undefined;
		} else {
			target.files.set(absolute, { relativePath, before: current, after: next, edits: replaced && [replaced] });
		}
		target.summaries.push(summary);
		target.reasons.push(reason);
		const before = staged ? staged.before : current;
		const linesBefore = lineCount(before);
		const linesAfter = lineCount(next);
		const wordsBefore = wordCount(before);
		const wordsAfter = wordCount(next);
		const state = next === null ? " (deleted)" : before === null ? " (new file)" : "";
		// Words, not just lines: cramming text into an existing line is growth too.
		let text = `Staged ${skill.name}/${relativePath}${state} (proposal for the user): ${linesBefore} → ${linesAfter} lines (${signed(linesAfter - linesBefore)}), ${wordsBefore} → ${wordsAfter} words (${signed(wordsAfter - wordsBefore)}).`;
		if (insertion && relativePath.endsWith(".md")) {
			text +=
				" This edit only inserts text and leaves every existing line as it was. If a line already there covers this case (wrong, vague, or narrower than the rule), replace it instead; keep the insertion only if no existing line can carry it.";
		}
		// The whole staged change, not just this call: a lost edit or a stray reformat shows here.
		if (next !== null)
			text += `\nStaged change so far, as the user will review it:\n${compactSkillDiff(before ?? "", next)}`;
		return {
			content: [{ type: "text", text }],
			details: { skill: skill.name, file: relativePath },
		};
	}
}

/** Why `next` is not an acceptable SKILL.md replacing `current`, or undefined when it is. */
function validateSkillFile(current: string, next: string, source: string): string | undefined {
	let before: { frontmatter: Record<string, unknown>; body: string };
	let after: { frontmatter: Record<string, unknown>; body: string };
	try {
		before = parseFrontmatter(current, { source, repair: false, level: "off" });
		after = parseFrontmatter(next, { source, repair: false, level: "off" });
	} catch (error) {
		return `frontmatter no longer parses: ${error instanceof Error ? error.message : String(error)}`;
	}
	if (before.frontmatter.name !== after.frontmatter.name) return "the frontmatter name must not change.";
	const description = after.frontmatter.description;
	if (typeof description !== "string" || !description.trim()) {
		return "the frontmatter description must stay a non-empty string.";
	}
	if (description.length > MAX_DESCRIPTION_CHARS) {
		return `the description has ${description.length} characters; the limit is ${MAX_DESCRIPTION_CHARS}.`;
	}
	const beforeLines = before.body.split("\n").length;
	const afterLines = after.body.split("\n").length;
	if (afterLines > MAX_BODY_LINES && afterLines > beforeLines) {
		return `the body would have ${afterLines} lines; keep it at most ${MAX_BODY_LINES} (move details into a referenced file).`;
	}
	return undefined;
}
