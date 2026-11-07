/**
 * Skill curation (`skills.selfImprove`): after every task that relied on a
 * loaded skill of the user's (see `signals.ts`), run one private side turn that
 * may stage corrections to those skills; each skill's staged changes become a
 * proposal the user approves or rejects (`proposals.ts`). Nothing is written to
 * a skill without that approval.
 *
 * Installed once per top-level session; every settled task re-reads the live
 * setting. A "task" is a stretch of runs from the first `agent_start` until the
 * session settles (no run, queued input or background work that could resume
 * it), so goal continuations, follow-ups and job results belong to one task.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Dirent } from "node:fs";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { getModelMatchPreferences, resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { cfgSkillsSelfImprove, cfgSkillsSelfImproveThirdParty } from "../extensibility/settings";
import { isSelfImprovableSkill, type Skill } from "../extensibility/skills";
import curationTemplate from "../prompts/skills/curation.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import type { Tool } from "../tools";
import { listSkillProposals, proposalDiff, type SkillProposalNotice, writeSkillProposal } from "./proposals";
import {
	type CurationSignals,
	collectCurationSignals,
	loadedSkills,
	renderTaskTranscript,
	type SkillAnchors,
	skillAnchors,
} from "./signals";
import { SkillEditTool } from "./skill-edit-tool";

/** Rejected proposals of a skill shown to the curator so it does not propose them again. */
const MAX_REJECTED_SHOWN = 5;
/** Files of a skill directory listed to the curator. */
const MAX_FILES_SHOWN = 60;
const SKIPPED_DIRS: Record<string, true> = { node_modules: true, __pycache__: true, venv: true };

/**
 * The files of a skill directory other than SKILL.md, relative to it,
 * breadth-first and by name; hidden entries and dependency folders skipped, at
 * most `MAX_FILES_SHOWN` plus a marker when there are more. The curator sees
 * SKILL.md inline and reads these on demand: a script at fault is fixed in the script.
 */
async function skillFiles(skill: Skill): Promise<string[]> {
	const files: string[] = [];
	const pending = [""];
	// Stop walking once past the cap: the listing only needs to know there are more.
	while (pending.length > 0 && files.length <= MAX_FILES_SHOWN) {
		const dir = pending.shift() ?? "";
		let entries: Dirent[];
		try {
			entries = await fs.readdir(path.join(skill.baseDir, dir), { withFileTypes: true });
		} catch (error) {
			logger.warn("Skill curation could not list a skill folder", { skill: skill.name, dir, error: String(error) });
			continue;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (entry.name.startsWith(".") || SKIPPED_DIRS[entry.name]) continue;
			const relative = dir ? `${dir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) pending.push(relative);
			else if (entry.isFile() && path.join(skill.baseDir, relative) !== skill.filePath) files.push(relative);
		}
	}
	if (files.length <= MAX_FILES_SHOWN) return files;
	return [...files.slice(0, MAX_FILES_SHOWN), "… more files not listed"];
}

/** Whether an assistant message from `start` on calls a tool. */
function runsTools(messages: readonly AgentMessage[], start: number): boolean {
	for (let index = start; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "assistant" && message.content.some(block => block.type === "toolCall")) return true;
	}
	return false;
}

/**
 * The model a curation turn runs on: the `curator` model role
 * (`modelRoles.curator`) resolved against `availableModels`. Undefined when the
 * role is unset or matches no available model — the turn then runs on the
 * session's model.
 */
export function resolveSkillCurationModel(
	settings: Settings,
	availableModels: Model[],
): { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined {
	const selector = settings.getModelRole("curator")?.trim();
	if (!selector) return undefined;
	const resolved = resolveModelRoleValue(selector, availableModels, {
		settings,
		matchPreferences: getModelMatchPreferences(settings),
	});
	if (!resolved.model) {
		logger.warn("modelRoles.curator matched no available model; skill curation uses the session model", {
			selector,
		});
		return undefined;
	}
	return { model: resolved.model, thinkingLevel: resolved.thinkingLevel };
}

export interface SkillCurationControllerOptions {
	session: AgentSession;
	settings: Settings;
	/** Run one private curation turn with `tools` over a clone of the session. */
	runTurn: (content: string, tools: Tool[]) => Promise<void>;
}

export class SkillCurationController {
	readonly #session: AgentSession;
	readonly #settings: Settings;
	readonly #runTurn: SkillCurationControllerOptions["runTurn"];
	/** `session.messages` length when the current task's first run started. */
	#taskStart: number | undefined;
	/**
	 * First message of the last task curation reviewed. A follow-up task that runs
	 * no tool — typically the user reacting to the result ("next time ask first") —
	 * relies on no skill itself, so it is reviewed together with that task.
	 */
	#reviewedTask: AgentMessage | undefined;
	#checking = false;

	constructor(options: SkillCurationControllerOptions) {
		this.#session = options.session;
		this.#settings = options.settings;
		this.#runTurn = options.runTurn;
		// The listener closure keeps the controller alive for the session's lifetime.
		this.#session.subscribe(event => {
			if (event.type === "agent_start") {
				this.#taskStart ??= this.#session.messages.length;
			} else if (event.type === "agent_end" && event.isTerminal !== false) {
				void this.#onTerminalEnd();
			}
		});
	}

	async #onTerminalEnd(): Promise<void> {
		if (this.#checking) return;
		this.#checking = true;
		try {
			const session = this.#session;
			await session.waitForIdle();
			while (!session.isStreaming && !session.hasAdmittedSubmission && session.hasPendingAsyncWork()) {
				await session.settleAsyncWork();
			}
			// Still busy: a later terminal end of the same task checks again.
			if (
				session.isStreaming ||
				session.hasAdmittedSubmission ||
				session.queuedMessageCount > 0 ||
				session.hasPendingAsyncWork()
			) {
				return;
			}
			let start = this.#taskStart;
			this.#taskStart = undefined;
			const messages = session.messages;
			if (start === undefined || start > messages.length) return;
			if (!cfgSkillsSelfImprove.get(this.#settings)) return;
			if (session.getPlanModeState()?.enabled || session.getGoalModeState()?.enabled) return;
			const last = messages.findLast(message => message.role === "assistant");
			if (last?.role === "assistant" && (last.stopReason === "aborted" || last.stopReason === "error")) return;
			const cwd = session.sessionManager.getCwd();
			const thirdParty = cfgSkillsSelfImproveThirdParty.get(this.#settings);
			const editable = session.skills.filter(skill => isSelfImprovableSkill(skill, thirdParty));
			const contents = new Map<Skill, string>();
			for (const skill of loadedSkills(messages, editable, cwd).keys()) {
				try {
					contents.set(skill, await Bun.file(skill.filePath).text());
				} catch (error) {
					logger.warn("Skill curation could not read a skill", { skill: skill.name, error: String(error) });
				}
			}
			if (contents.size === 0) return;
			const anchors = new Map<Skill, SkillAnchors>();
			for (const [skill, content] of contents) anchors.set(skill, skillAnchors(content));
			let signals = collectCurationSignals(messages, start, [...contents.keys()], cwd, anchors);
			if (!signals && !runsTools(messages, start) && this.#reviewedTask) {
				const previous = messages.indexOf(this.#reviewedTask);
				if (previous >= 0 && previous < start) {
					start = previous;
					signals = collectCurationSignals(messages, start, [...contents.keys()], cwd, anchors);
				}
			}
			this.#reviewedTask = signals ? messages[start] : undefined;
			// Not awaited: the next task is tracked while curation runs.
			if (signals) void this.#curate(signals, renderTaskTranscript(messages.slice(start)), contents);
		} catch (error) {
			logger.warn("Skill curation check failed", { error: String(error) });
		} finally {
			this.#checking = false;
		}
	}

	async #curate(signals: CurationSignals, transcript: string, contents: ReadonlyMap<Skill, string>): Promise<void> {
		const skills = [];
		for (const { skill, uses, matched, readLate, earlier } of signals.candidates) {
			let pending: Array<{ summary: string; diff: string }> = [];
			let rejected: Array<{ summary: string; reason?: string }> = [];
			try {
				const decisions = await listSkillProposals({ skill: skill.name, status: "all", limit: 20 });
				pending = decisions
					.filter(entry => entry.status === "pending")
					.map(entry => ({ summary: entry.summary, diff: entry.diff }));
				rejected = decisions
					.filter(entry => entry.status === "rejected")
					.slice(0, MAX_REJECTED_SHOWN)
					.map(entry => ({ summary: entry.summary, reason: entry.rejectReason }));
			} catch (error) {
				logger.warn("Skill curation could not list proposals", { skill: skill.name, error: String(error) });
			}
			const files = await skillFiles(skill);
			skills.push({
				name: skill.name,
				filePath: skill.filePath,
				content: contents.get(skill),
				used: `${uses.join(", ")}${matched.length > 0 ? ` (${matched.join(", ")})` : ""}`,
				readLate,
				earlier,
				files,
				hasFiles: files.length > 0,
				pending,
				rejected,
				hasPending: pending.length > 0,
				hasRejected: rejected.length > 0,
			});
		}
		const notices: SkillProposalNotice[] = [];
		this.#session.emitSkillCuration("running");
		try {
			const tool = new SkillEditTool(signals.candidates.map(candidate => candidate.skill));
			const read = this.#session.getToolByName("read");
			try {
				await this.#runTurn(
					prompt.render(curationTemplate, { transcript, skills, errorCount: signals.errorCount }),
					read ? [read, tool] : [tool],
				);
			} catch (error) {
				// Changes staged before the failure still become proposals.
				logger.warn("Skill curation failed", { error: String(error) });
			}
			const sessionFile = this.#session.sessionManager.getSessionFile();
			for (const record of tool.edits.values()) {
				const files = [...record.files]
					.filter(([, file]) => file.before !== file.after)
					.map(([filePath, file]) => ({ path: filePath, ...file }));
				if (files.length === 0) continue;
				try {
					const proposal = await writeSkillProposal({
						skill: record.skill.name,
						summary: record.summaries.join("; "),
						reason: record.reasons.join("\n"),
						files,
						sessionFile,
					});
					notices.push({
						id: proposal.id,
						skill: proposal.skill,
						summary: proposal.summary,
						reason: proposal.reason,
						files: files.map(file => file.relativePath),
						diff: proposalDiff(files),
					});
				} catch (error) {
					logger.warn("Skill curation could not record a proposal", {
						skill: record.skill.name,
						error: String(error),
					});
				}
			}
		} finally {
			this.#session.emitSkillCuration("done", notices);
		}
	}
}
