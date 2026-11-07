/**
 * Skill curation proposals: changes the curator staged for a skill, waiting for
 * the user to approve or reject them. One JSON file per proposal under
 * `<agentDir>/skill-proposals/<skill key>/<createdAt>.json`. Approving writes the
 * files and records a skill-history entry (so it can be reverted); decided
 * proposals stay on disk because later curation turns read the rejected ones.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import {
	readSkillFile,
	SKILL_ENTRY_ID_RE,
	type SkillHistoryEntry,
	type SkillHistoryFile,
	skillFileDiff,
	skillKey,
	writeSkillFile,
	writeSkillHistoryEntry,
} from "./history";

export type SkillProposalStatus = "pending" | "approved" | "rejected";

export interface SkillProposal {
	/** `<skill key>/<createdAt>`. */
	id: string;
	skill: string;
	createdAt: number;
	summary: string;
	/** The transcript evidence the curator gave for the change. */
	reason: string;
	files: SkillHistoryFile[];
	/** Session whose task produced the proposal. */
	sessionFile?: string;
	status: SkillProposalStatus;
	decidedAt?: number;
	rejectReason?: string;
	/** The skill-history entry approval created. */
	historyId?: string;
}

/** A proposal as listed (`omp skill proposals --json`): relative paths and a compact diff instead of full contents. */
export interface SkillProposalSummary {
	id: string;
	skill: string;
	createdAt: number;
	summary: string;
	reason: string;
	files: string[];
	diff: string;
	status: SkillProposalStatus;
	/** Pending only: a file on disk no longer matches what the proposal was based on, so it can only be rejected. */
	stale: boolean;
	/** Session whose task produced the proposal. */
	sessionFile?: string;
	decidedAt?: number;
	rejectReason?: string;
}

/** A new proposal as the `skill_curation` event reports it. */
export interface SkillProposalNotice {
	id: string;
	skill: string;
	summary: string;
	reason: string;
	files: string[];
	diff: string;
}

export function skillProposalsDir(agentDir?: string): string {
	return path.join(agentDir ?? getAgentDir(), "skill-proposals");
}

/** Every changed file as `--- <relative path>` plus its compact diff. */
export function proposalDiff(files: readonly SkillHistoryFile[]): string {
	return files.map(skillFileDiff).join("\n");
}

/** Store a new pending proposal; the id stays unique across concurrent omp processes. */
export async function writeSkillProposal(
	input: { skill: string; summary: string; reason: string; files: SkillHistoryFile[]; sessionFile?: string },
	agentDir?: string,
): Promise<SkillProposal> {
	const key = skillKey(input.skill);
	const dir = path.join(skillProposalsDir(agentDir), key);
	await fs.mkdir(dir, { recursive: true });
	for (let createdAt = Date.now(); ; createdAt++) {
		const proposal: SkillProposal = { id: `${key}/${createdAt}`, createdAt, ...input, status: "pending" };
		try {
			await fs.writeFile(path.join(dir, `${createdAt}.json`), JSON.stringify(proposal, null, 2), { flag: "wx" });
			return proposal;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
}

/**
 * What `file` becomes when the proposal is applied to `current`: its `after`
 * when the file is still as proposed against, otherwise its replacements
 * replayed on the current text, each still matching exactly once. Undefined
 * when the proposal no longer applies.
 */
function rebaseSkillFile(file: SkillHistoryFile, current: string | null): string | null | undefined {
	if (current === file.before) return file.after;
	if (!file.edits || current === null) return undefined;
	let text = current;
	for (const edit of file.edits) {
		if (text.split(edit.oldText).length !== 2) return undefined;
		text = text.replace(edit.oldText, () => edit.newText);
	}
	return text;
}

/** Each file of `proposal` as it is now and as approving would leave it; undefined when one no longer applies. */
async function planProposal(proposal: SkillProposal): Promise<SkillHistoryFile[] | undefined> {
	const files: SkillHistoryFile[] = [];
	for (const file of proposal.files) {
		const current = await readSkillFile(file.path);
		const after = rebaseSkillFile(file, current);
		if (after === undefined) return undefined;
		files.push({ path: file.path, relativePath: file.relativePath, before: current, after });
	}
	return files;
}

async function isStale(proposal: SkillProposal): Promise<boolean> {
	return (await planProposal(proposal)) === undefined;
}

/** Proposals newest first; pending ones by default. */
export async function listSkillProposals(
	options: { skill?: string; status?: SkillProposalStatus | "all"; limit?: number } = {},
	agentDir?: string,
): Promise<SkillProposalSummary[]> {
	const root = skillProposalsDir(agentDir);
	const status = options.status ?? "pending";
	let keys: string[];
	try {
		keys = await fs.readdir(root);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const proposals: SkillProposal[] = [];
	for (const key of keys) {
		let files: string[];
		try {
			files = await fs.readdir(path.join(root, key));
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			const proposal: SkillProposal = await Bun.file(path.join(root, key, file)).json();
			if (options.skill !== undefined && proposal.skill !== options.skill) continue;
			if (status !== "all" && proposal.status !== status) continue;
			proposals.push(proposal);
		}
	}
	proposals.sort((a, b) => b.createdAt - a.createdAt);
	const listed = proposals.slice(0, options.limit ?? proposals.length);
	return Promise.all(
		listed.map(async proposal => ({
			id: proposal.id,
			skill: proposal.skill,
			createdAt: proposal.createdAt,
			summary: proposal.summary,
			reason: proposal.reason,
			files: proposal.files.map(file => file.relativePath),
			diff: proposalDiff(proposal.files),
			status: proposal.status,
			stale: proposal.status === "pending" && (await isStale(proposal)),
			...(proposal.sessionFile !== undefined && { sessionFile: proposal.sessionFile }),
			...(proposal.decidedAt !== undefined && { decidedAt: proposal.decidedAt }),
			...(proposal.rejectReason !== undefined && { rejectReason: proposal.rejectReason }),
		})),
	);
}

async function loadPending(id: string, agentDir?: string): Promise<{ proposal: SkillProposal; file: string }> {
	if (!SKILL_ENTRY_ID_RE.test(id)) throw new Error(`unknown proposal: ${id}`);
	const file = path.join(skillProposalsDir(agentDir), `${id}.json`);
	let proposal: SkillProposal;
	try {
		proposal = await Bun.file(file).json();
	} catch (error) {
		if (isEnoent(error)) throw new Error(`unknown proposal: ${id}`);
		throw error;
	}
	if (proposal.status !== "pending") throw new Error(`already ${proposal.status}: ${id}`);
	return { proposal, file };
}

/**
 * Apply proposal `id` and record it in the skill history. A file changed since
 * the proposal still takes its replacements when each one still matches exactly
 * once. Refuses, writing nothing, when it is unknown or decided, or when a
 * changed file no longer takes them.
 */
export async function approveSkillProposal(
	id: string,
	agentDir?: string,
): Promise<{ proposal: SkillProposal; history: SkillHistoryEntry }> {
	const { proposal, file } = await loadPending(id, agentDir);
	const files = await planProposal(proposal);
	if (!files) {
		const changed: string[] = [];
		for (const entry of proposal.files) {
			if (rebaseSkillFile(entry, await readSkillFile(entry.path)) === undefined) changed.push(entry.relativePath);
		}
		throw new Error(`outdated: the skill changed since this proposal (${changed.join(", ")})`);
	}
	for (const entry of files) await writeSkillFile(entry.path, entry.after);
	const history = await writeSkillHistoryEntry({ skill: proposal.skill, summary: proposal.summary, files }, agentDir);
	proposal.status = "approved";
	proposal.decidedAt = Date.now();
	proposal.historyId = history.id;
	await Bun.write(file, JSON.stringify(proposal, null, 2));
	return { proposal, history };
}

/** Decline proposal `id`; an outdated one can still be rejected, which is how it is discarded. */
export async function rejectSkillProposal(
	id: string,
	reason: string | undefined,
	agentDir?: string,
): Promise<SkillProposal> {
	const { proposal, file } = await loadPending(id, agentDir);
	proposal.status = "rejected";
	proposal.decidedAt = Date.now();
	const trimmed = reason?.trim();
	if (trimmed) proposal.rejectReason = trimmed;
	await Bun.write(file, JSON.stringify(proposal, null, 2));
	return proposal;
}

/** Plain-text listing: a header line per proposal, its reason, then its diff indented by two spaces. */
export function formatSkillProposals(entries: readonly SkillProposalSummary[]): string {
	if (entries.length === 0) return "No pending skill proposals.";
	return entries
		.map(entry => {
			const header = `${entry.id}  ${new Date(entry.createdAt).toISOString()}  ${entry.skill}: ${entry.summary}${entry.stale ? " (outdated)" : ""}`;
			const diff = entry.diff
				.split("\n")
				.map(line => `  ${line}`)
				.join("\n");
			return `${header}\n  reason: ${entry.reason}\n${diff}`;
		})
		.join("\n\n");
}
