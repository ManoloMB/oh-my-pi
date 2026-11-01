/**
 * One omp process (`omp --mode rpc-ui`) and the session it has open.
 *
 * Chat views attach to a host to show it and detach when they move to another
 * session; the host keeps running with no view attached, so a turn started in
 * one session continues while the user works in another (`AgentPool` decides
 * when an idle, detached host stops). Live events go to every attached view;
 * a view that attaches later gets a snapshot (`replay`).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as vscode from "vscode";
import type {
	AgentMessage,
	ImageContent,
	RpcNotification,
	SessionState,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/wire/rpc-wire.generated";
import { gitAvailable } from "../checkpoints/git";
import { discoverRepos } from "../checkpoints/repos";
import {
	restoreTurns,
	snapshotTree,
	type TurnSnapshots,
	undoRestore,
	type WrittenFile,
} from "../checkpoints/snapshots";
import type { CheckpointStore, RepoCheckpoint } from "../checkpoints/store";
import type { CommandOutputStore } from "./command-outputs";
import { playCompletionSound } from "../sounds";
import { ompCommand, readConfig, workspaceCwd, workspaceRoots } from "../config";
import { ensureNoWorkspaceFolder, rememberNoWorkspaceSession } from "../no-workspace";
import { lastSystemCa } from "../system-ca";
import { DialogBridge } from "../dialogs";
import { type AgentStatus, type ChatUpdate, isUserPrompt, type ModelChoice, type PlanRunView } from "../protocol";
import { OmpCommandError, OmpProcess, type OmpResult } from "../rpc/omp-process";
import { PlanRunTracker } from "./plan-run";
import { userPrompt } from "./prompt-entries";
import { SubagentRequestLog } from "./subagent-requests";
import { SubagentRoster } from "./subagent-roster";

/** How often a followed subagent's transcript is re-read while it runs. */
const WATCH_POLL_MS = 2000;

/** Notification frames that are not session events (everything else is forwarded as `event`). */
const NON_EVENT_FRAMES: Record<string, true> = {
	ready: true,
	prompt_result: true,
	session_settled: true,
	extension_error: true,
	extension_ui_request: true,
	available_commands_update: true,
	subagent_lifecycle: true,
	subagent_progress: true,
	subagent_event: true,
	live_phase: true,
	live_levels: true,
	live_transcript: true,
	live_end: true,
	dictation_state: true,
	btw_delta: true,
	btw_record: true,
	command_output: true,
	session_info_update: true,
	config_update: true,
	rpc_frame_error: true,
	skill_curation: true,
};

/** Frames after which the session snapshot (state, stats, title) is re-read. */
const STATE_CHANGING_EVENTS: Record<string, true> = {
	// Each finished message moves the context meter mid-turn: an assistant reply adds its
	// token usage and cost, a tool result grows the context.
	message_end: true,
	agent_end: true,
	model_changed: true,
	thinking_level_changed: true,
	auto_compaction_end: true,
	session_settled: true,
	session_info_update: true,
	config_update: true,
	// Local slash commands (`/shake`, `/compact`, `/handoff`…) run no agent turn: their
	// output is the only frame telling the host the context changed.
	command_output: true,
	prompt_result: true,
};

/** `navigate_tree` retries while an aborted turn still winds down (bash, retries…). */
const NAVIGATE_BUSY_RETRIES = 6;
const NAVIGATE_BUSY_DELAY_MS = 500;
/** Transcribing a long dictation through a cloud API can take a while. */
const DICTATION_STOP_TIMEOUT_MS = 120_000;
/** A first word prediction waits for omp's prediction daemon to start and load (up to about two minutes). */
const PREDICT_TIMEOUT_MS = 155_000;

/** What a new process should open. */
export type SessionTarget = { kind: "continue" } | { kind: "new" } | { kind: "resume"; sessionFile: string };

/** A turn's file checkpoint while it runs. */
interface TurnCheckpoint {
	sessionFile: string;
	/** The snapshots before the turn, once `snapshot` settled. */
	repos: RepoCheckpoint[];
	/** Settles (never rejects) when the snapshots before the turn are taken. */
	snapshot: Promise<void>;
	/** `snapshot` settled. */
	ready: boolean;
	/** No usable snapshots: git is missing, or a tool started before they were done (they might hold its changes). */
	discarded: boolean;
	promptTimestamp?: number;
	editedFiles: boolean;
}

/** Files involved in editing a prompt (absolute paths). */
export interface EditPlan {
	/** Whether the prompt has a file checkpoint (it started a turn while file checkpoints were on). */
	checkpoint: boolean;
	/** Files a restore changes. */
	files: string[];
	/** Files omp and someone else changed on the same lines: a restore leaves them unless told to overwrite. */
	conflicts: string[];
}

/** A file restore that was applied, with what undoing it needs. */
export interface FileRestore {
	repos: Array<{ root: string; current: string; files: WrittenFile[] }>;
	files: string[];
	conflicts: string[];
}

export interface EditResult {
	/** False when a hook vetoed the rewind: nothing changed. */
	resent: boolean;
	restored?: FileRestore;
}

/** A chat view showing a host: where its updates go. */
export interface HostView {
	post(update: ChatUpdate): void;
	reveal(): void;
}

type PlanReview = Extract<ChatUpdate, { type: "planReview" }>;
type SkillCuration = Extract<ChatUpdate, { type: "skillCuration" }>;

const CURATION_IDLE: SkillCuration = { type: "skillCuration", status: "idle" };

export class AgentHost implements vscode.Disposable {
	#process: OmpProcess | undefined;
	#status: AgentStatus = { phase: "starting" };
	#state: SessionState | undefined;
	#title: string | undefined;
	/** Between `agent_start` and `agent_end`: a turn is running. */
	#busy = false;
	/** When the running turn started (`agent_start`), for the working timer of every view showing it. */
	#busySince = 0;
	/** A dictation this host started is recording (or transcribing). */
	#dictating = false;
	/** Idle with nothing queued or pending (omp's `session_settled` / `get_state.isSettled`). */
	#settled = true;
	/** A turn finished while no view was attached; cleared when a view shows the session. */
	#finishedUnseen = false;
	/** A run started since the last `session_settled`: that stretch of work ends with one completion sound. */
	#soundPending = false;
	/** The latest run was stopped by the user or ended in an error: its stretch ends silently. */
	#soundSuppressed = false;
	#refreshTimer: NodeJS.Timeout | undefined;
	/** Subagents of the shown session's current task, for the chat's subagent panel. */
	readonly #subagents = new SubagentRoster();
	#subagentsTimer: NodeJS.Timeout | undefined;
	/** The subagent whose requests a view's popup follows, with the transcript read so far. */
	#watched: { id: string; log: SubagentRequestLog; reading: boolean; stale: boolean } | undefined;
	/** Re-reads the watched transcript between progress frames (a long tool call sends none). */
	#watchTimer: NodeJS.Timeout | undefined;
	/** The turn being checkpointed: snapshots taken (in the background) as its prompt was sent. */
	#turn: TurnCheckpoint | undefined;
	/** Checkpoint snapshots and writes, in order; awaited before anything reads them. */
	#checkpointWork: Promise<void> = Promise.resolve();
	readonly #views = new Set<HostView>();
	readonly #dialogs: DialogBridge;
	readonly #statusTexts = new Map<string, string>();
	/** Plan reviews awaiting a decision, by request id; re-sent to views that attach later. */
	readonly #planReviews = new Map<string, { update: PlanReview; resolve(value: string | undefined): void }>();
	/** Whether omp is reviewing the open session's skills, re-sent to views that attach later. */
	#curation: SkillCuration = CURATION_IDLE;
	/** The approved plan being executed, folded from the transcript, for the plan button. */
	readonly #planRun = new PlanRunTracker();
	/** Local plan files by approving tool call: known only for plans approved in this window. */
	readonly #planFiles = new Map<string, string>();
	/** Plan file of the review answered last; the approval result that follows takes it. */
	#reviewedPlanFile: string | undefined;
	/** The plan run as last posted (JSON), so unchanged refreshes post nothing. */
	#postedPlanRun = "null";
	/** The run the user stopped tracking; a view attaching rebuilds from the transcript and must not revive it. */
	#dismissedPlanRun: string | undefined;
	readonly #onDidChange = new vscode.EventEmitter<AgentHost>();
	/** Fires when the process, session, title, model, busy or settled state changes. */
	readonly onDidChange = this.#onDidChange.event;
	readonly #onNeedsAttention = new vscode.EventEmitter<AgentHost>();
	/** Fires when the session waits for the user (a plan to approve) with no view showing it. */
	readonly onNeedsAttention = this.#onNeedsAttention.event;

	constructor(
		readonly log: vscode.OutputChannel,
		/** Absent for chats without a workspace: they have no repositories to snapshot. */
		private readonly checkpoints?: CheckpointStore,
		/** Runs omp in the no-workspace folder instead of the workspace (see no-workspace.ts). */
		readonly noWorkspace = false,
		/** Keeps what local slash commands printed, to show it again when the transcript is rebuilt. */
		private readonly commandOutputs?: CommandOutputStore,
	) {
		this.#dialogs = new DialogBridge({
			respond: response => this.#process?.respond(response),
			setStatus: (key, text) => {
				if (text) this.#statusTexts.set(key, text);
				else this.#statusTexts.delete(key);
				this.#onDidChange.fire(this);
			},
			setEditorText: text => this.post({ type: "insertText", text }),
			log: line => this.log.appendLine(line),
			reviewPlan: (request, token) => this.#reviewPlan(request, token),
		});
	}

	get status(): AgentStatus {
		return this.#status;
	}
	get state(): SessionState | undefined {
		return this.#state;
	}
	get title(): string | undefined {
		return this.#title;
	}
	get busy(): boolean {
		return this.#busy;
	}
	/** Working on something: a turn or a compaction. */
	get running(): boolean {
		return this.#busy || this.#state?.isCompacting === true;
	}
	get settled(): boolean {
		return this.#settled;
	}
	get finishedUnseen(): boolean {
		return this.#finishedUnseen;
	}
	get sessionFile(): string | undefined {
		return this.#state?.sessionFile;
	}
	get process(): OmpProcess | undefined {
		return this.#process?.running ? this.#process : undefined;
	}
	/** omp is reviewing the skills the last task used; stopping the process now would cut it off. */
	get curating(): boolean {
		return this.#curation.status === "running";
	}
	get views(): ReadonlySet<HostView> {
		return this.#views;
	}
	/** Extension status texts (`setStatus`), e.g. from omp extensions. */
	get statusTexts(): ReadonlyMap<string, string> {
		return this.#statusTexts;
	}

	attach(view: HostView): void {
		this.#views.add(view);
		this.#finishedUnseen = false;
	}

	detach(view: HostView): void {
		this.#views.delete(view);
		// Speech meant for a view that moved on must not land in another one.
		if (this.#views.size === 0 && this.#dictating) void this.dictationCancel();
		if (this.#views.size === 0) this.watchSubagent(null);
	}

	/** Bring `view` up to date: status, transcript and pickers, pending plan reviews. */
	async replay(view: HostView): Promise<void> {
		view.post({ type: "status", status: this.#status });
		const process = this.process;
		if (process) await this.#sendSnapshot(process, [view]);
		for (const review of this.#planReviews.values()) view.post(review.update);
		view.post(this.#curation);
		view.post({ type: "subagents", subagents: this.#subagents.list() });
	}

	#setCuration(curation: SkillCuration): void {
		this.#curation = curation;
		this.post(curation);
		this.#onDidChange.fire(this);
	}

	/** Start (or restart) omp on `target`; resolves once the first snapshot reached the views. */
	async start(target: SessionTarget): Promise<void> {
		await this.#stopProcess();
		const cwd = this.noWorkspace ? await ensureNoWorkspaceFolder() : workspaceCwd();
		const command = await ompCommand(cwd);
		if (lastSystemCa) {
			this.log.appendLine(
				`[start] trusting ${lastSystemCa.certificates} certificates of the OS store (${lastSystemCa.file})`,
			);
		}
		const process = new OmpProcess(command);
		this.#process = process;
		this.#busy = false;
		this.#settled = true;
		this.#setStatus({ phase: "starting" });
		this.#resetSubagents();
		process.on("frame", frame => this.#onFrame(process, frame));
		process.on("uiRequest", request => {
			if (this.#process === process) this.#dialogs.handle(request);
		});
		process.on("stderr", text => this.log.append(text));
		process.on("exit", reason => {
			this.log.appendLine(`[omp exited] ${reason}`);
			if (this.#process !== process) return;
			this.#dialogs.dispose();
			// A dead process runs nothing: let the pool retire it if no view shows it.
			this.#busy = false;
			this.#settled = true;
			if (this.#curation.status === "running") this.#setCuration(CURATION_IDLE);
			this.#setStatus({ phase: "stopped", message: reason });
		});
		const args = [...readConfig().extraArgs];
		// Chats without a workspace keep the general prompt: no coding guidance or workspace snapshot.
		if (this.noWorkspace) args.push("--no-coding-guidance");
		if (target.kind === "resume") args.push("--resume", target.sessionFile);
		else if (target.kind === "continue") args.push("--continue");
		this.log.appendLine(
			`[start] ${process.command.executable} ${[...process.command.args, ...args].join(" ")} (cwd ${cwd})`,
		);
		try {
			await process.start(args);
		} catch (error) {
			if (this.#process === process) this.#setStatus({ phase: "stopped", message: errorMessage(error) });
			return;
		}
		await process.request("set_ask_dialog", { enabled: true }).catch(error => this.log.appendLine(String(error)));
		// Progress frames feed the subagent panel.
		await process
			.request("set_subagent_subscription", { level: "progress" })
			.catch(error => this.log.appendLine(String(error)));
		this.#setStatus({ phase: "ready" });
		this.#title = undefined;
		this.#setCuration(CURATION_IDLE);
		await this.#sendSnapshot(process, this.#views);
	}

	async restart(): Promise<void> {
		const sessionFile = this.#state?.sessionFile;
		await this.start(sessionFile ? { kind: "resume", sessionFile } : { kind: "continue" });
	}

	/** Stop the process; the host can be started again. */
	async stop(): Promise<void> {
		await this.#stopProcess();
		this.#busy = false;
		this.#settled = true;
		this.#onDidChange.fire(this);
	}

	/** Start a new session in this process. Aborts a running turn: callers only use it when idle. */
	async newSession(): Promise<void> {
		const process = this.#requireProcess();
		const result = await process.request("new_session", {});
		if (result.cancelled) return;
		this.#title = undefined;
		this.#setCuration(CURATION_IDLE);
		this.#resetSubagents();
		await this.#sendSnapshot(process, this.#views);
	}

	/** Open another session in this process. Aborts a running turn: callers only use it when idle. */
	async switchSession(sessionFile: string): Promise<void> {
		const process = this.process;
		if (!process) {
			await this.start({ kind: "resume", sessionFile });
			return;
		}
		const result = await process.request("switch_session", { sessionPath: sessionFile });
		if (result.cancelled) return;
		this.#title = undefined;
		this.#resetSubagents();
		this.#setCuration(CURATION_IDLE);
		await this.#sendSnapshot(process, this.#views);
	}

	/**
	 * Send a prompt. One that starts a turn also snapshots the workspace's
	 * repositories (file checkpoints), in the background: the prompt does not wait.
	 */
	async prompt(text: string, images: ImageContent[] | undefined): Promise<void> {
		const process = this.#requireProcess();
		if (!this.#busy) {
			this.#beginTurnCheckpoint();
			// A new task: the panel lists only its subagents.
			if (this.#subagents.clearFinished()) this.#postSubagents();
		}
		await process.request("prompt", {
			message: text,
			...(images?.length ? { images } : {}),
			streamingBehavior: readConfig().sendWhileBusy,
		});
	}

	/**
	 * What editing the prompt `fromEnd` prompts from the end involves for files:
	 * whether that prompt has a file checkpoint and, if so, which files a
	 * restore would change and which conflict (changed by omp and by someone
	 * else on the same lines). Nothing changes on disk.
	 */
	async planEdit(fromEnd: number, original: string): Promise<EditPlan> {
		const target = await this.#findPrompt(this.#requireProcess(), fromEnd, original);
		const repos = await this.#repoTurns(target.timestamps);
		if (!repos) return { checkpoint: false, files: [], conflicts: [] };
		const results = await Promise.all(repos.map(repo => restoreTurns(repo.root, repo.turns, { write: false })));
		return {
			checkpoint: true,
			files: results.flatMap(result => result.files.map(file => path.join(result.root, file.path))),
			conflicts: results.flatMap(result => result.conflicts.map(file => path.join(result.root, file))),
		};
	}

	/**
	 * Resend the user message `fromEnd` prompts from the end of the conversation
	 * with `text` (keeping its images). omp's `navigate_tree` rewinds the session
	 * in place to just before that message, so the edited prompt continues from
	 * there and the later turns leave the conversation (they stay in the session
	 * file on an abandoned branch, reachable from the terminal's `/tree`).
	 * A running turn is aborted first.
	 *
	 * With `restoreFiles`, the files omp changed since that message go back to
	 * how they were (see `restoreTurns`); conflicting files listed in `overwrite`
	 * are reset outright, other conflicts are left as they are.
	 */
	async editMessage(
		fromEnd: number,
		original: string,
		text: string,
		restoreFiles?: { overwrite: readonly string[] },
	): Promise<EditResult> {
		const process = this.#requireProcess();
		const target = await this.#findPrompt(process, fromEnd, original);
		if (this.running) {
			this.#soundSuppressed = true;
			await process.request("abort");
			await this.#untilIdle();
		}
		// The aborted turn's closing snapshot belongs to what gets restored.
		await this.#checkpointWork;
		const result = await this.#navigateTree(process, target.entryId);
		if (result.cancelled) return { resent: false };
		const restored = restoreFiles ? await this.#restoreFiles(target.timestamps, restoreFiles.overwrite) : undefined;
		await this.#sendSnapshot(process, this.#views);
		await this.prompt(text, result.editorImages);
		return { resent: true, restored };
	}

	/** Undo a file restore; resolves to the files left alone because they changed since. */
	async undoRestore(restored: FileRestore): Promise<string[]> {
		const skipped = await Promise.all(
			restored.repos.map(async repo =>
				(await undoRestore(repo.root, repo.current, repo.files)).map(file => path.join(repo.root, file)),
			),
		);
		return skipped.flat();
	}

	async removeQueued(message: string, queue: "steering" | "followUp"): Promise<void> {
		await this.#requireProcess().request("remove_queued_message", { message, queue });
	}

	async rename(name: string): Promise<void> {
		await this.#requireProcess().request("set_session_name", { name });
		// The cached title would otherwise win over the new name until omp reports it.
		this.#title = name;
		await this.#refreshState();
	}

	async abort(): Promise<void> {
		// Before the request: the aborted run's frames can arrive before its response.
		if (this.running) this.#soundSuppressed = true;
		await this.process?.request("abort");
	}

	async compact(): Promise<void> {
		const process = this.#requireProcess();
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: "MarIA Code: compacting context…" },
			() => process.request("compact", {}),
		);
		await this.#sendSnapshot(process, this.#views);
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		await this.#requireProcess().request("set_model", { provider, modelId });
		await this.#refreshState();
		await this.#sendThinkingLevels(this.#views);
	}

	async setThinkingLevel(level: SessionState["thinkingLevel"] & string): Promise<void> {
		await this.#requireProcess().request("set_thinking_level", { level });
		await this.#refreshState();
	}

	async setPlanMode(enabled: boolean): Promise<void> {
		try {
			await this.#requireProcess().request("set_plan_mode", { enabled });
			// A new plan replaces the one being tracked.
			if (enabled) this.#planRun.clear();
		} finally {
			// Also on failure: the webview toggled its button optimistically.
			await this.#refreshState();
		}
	}

	/** Stop tracking the executing plan: the plan button turns off until the next approval. */
	dismissPlanRun(): void {
		this.#dismissedPlanRun = this.#planRun.id;
		this.#planRun.clear();
		this.#postPlanRun();
	}

	async setDelegateMode(enabled: boolean): Promise<void> {
		try {
			await this.#requireProcess().request("set_delegate_mode", { enabled });
		} finally {
			// Also on failure: the webview toggled its button optimistically.
			await this.#refreshState();
		}
	}

	/** Ask every running subagent (and the lead agent) to wrap up; reports how many were reached. */
	async hurrySubagents(): Promise<void> {
		const { notified } = await this.#requireProcess().request("hurry_subagents");
		if (notified === 0) {
			this.#notice("info", "No subagent is running right now.");
			return;
		}
		this.#subagents.markWrapUpRequested();
		this.#postSubagents();
		this.#notice(
			"info",
			`Asked ${notified} ${notified === 1 ? "subagent" : "subagents"} to wrap up; each gets the request at its next step.`,
		);
	}

	/** Follow `id`'s requests in the views (`subagentRequests`), or stop following with `null`. */
	watchSubagent(id: string | null): void {
		clearInterval(this.#watchTimer);
		this.#watchTimer = undefined;
		this.#watched = id === null ? undefined : { id, log: new SubagentRequestLog(), reading: false, stale: false };
		if (id === null) return;
		this.#watchTimer = setInterval(() => void this.#readWatched(), WATCH_POLL_MS);
		void this.#readWatched();
	}

	async availableModels(): Promise<ModelChoice[]> {
		const { models } = await this.#requireProcess().request("get_available_models");
		return models.map(model => ({
			provider: model.provider,
			id: model.id,
			name: model.name || model.id,
			reasoning: model.reasoning,
			contextWindow: model.contextWindow,
		}));
	}

	/**
	 * Start recording the microphone for dictation (omp records, and transcribes
	 * through a cloud API such as Groq's Whisper); resolves with the speech model
	 * once recording. `language` is an ISO code, or `""` to let the model detect
	 * it. Unbounded: opening the microphone can wait for the OS permission prompt.
	 */
	async dictationStart(language: string): Promise<string> {
		const { model } = await this.#requireProcess().request("dictation_start", { language });
		this.#dictating = true;
		return model;
	}

	/** Stop recording and transcribe; `submit` when omp's `stt.submitTrigger` asks to send. */
	async dictationStop(): Promise<{ text: string; submit: boolean }> {
		try {
			return await this.#requireProcess().request("dictation_stop", undefined, DICTATION_STOP_TIMEOUT_MS);
		} finally {
			this.#dictating = false;
		}
	}

	/** Drop the running dictation without transcribing it. */
	async dictationCancel(): Promise<void> {
		this.#dictating = false;
		await this.#process?.request("dictation_cancel");
	}

	/**
	 * The rest of the prose word ending at `cursor` in `text`, from omp's word
	 * prediction (`spelling.autocomplete`), or null. Failures (an omp without
	 * the command, a prediction daemon that cannot start) show as no suggestion.
	 */
	async predictWord(text: string, cursor: number): Promise<string | null> {
		const process = this.#process;
		if (!process?.running) return null;
		try {
			const { suffix } = await process.request("predict_word", { text, cursor }, PREDICT_TIMEOUT_MS);
			return suffix;
		} catch {
			return null;
		}
	}

	/** Tell omp's prediction engine a suggestion was accepted or typed past. */
	predictWordFeedback(text: string, cursor: number, suggestion: string, accepted: boolean): void {
		const process = this.#process;
		if (!process?.running) return;
		void process.request("predict_word_feedback", { text, cursor, suggestion, accepted }).catch(() => {});
	}

	/** Answer a plan review shown in a view. */
	decidePlan(id: string, value: string): void {
		const review = this.#planReviews.get(id);
		this.#planReviews.delete(id);
		this.#reviewedPlanFile = review?.update.path;
		review?.resolve(value);
	}

	/** The executing plan for the views; hidden while plan mode is on (the button is busy planning). */
	#planRunView(): PlanRunView | null {
		if (this.#state?.planMode?.enabled) return null;
		const run = this.#planRun.view(this.#busy);
		const id = this.#planRun.id;
		const planFile = id === undefined ? undefined : this.#planFiles.get(id);
		return run && { ...run, ...(planFile ? { planFile } : {}) };
	}

	/** Post the executing plan when it changed since the last post. */
	#postPlanRun(): void {
		const run = this.#planRunView();
		const json = JSON.stringify(run);
		if (json === this.#postedPlanRun) return;
		this.#postedPlanRun = json;
		this.post({ type: "planRun", run });
	}

	post(update: ChatUpdate): void {
		for (const view of this.#views) view.post(update);
	}

	dispose(): void {
		clearTimeout(this.#refreshTimer);
		clearTimeout(this.#subagentsTimer);
		clearInterval(this.#watchTimer);
		void this.#stopProcess();
		this.#dialogs.dispose();
		this.#onDidChange.dispose();
		this.#onNeedsAttention.dispose();
	}

	#requireProcess(): OmpProcess {
		const process = this.process;
		if (!process) throw new Error('MarIA Code is not running. Use "MarIA Code: Restart Agent Process".');
		return process;
	}

	/**
	 * The user message `fromEnd` prompts from the end of the current branch:
	 * its entry id, and the timestamps of it and every later prompt, oldest first.
	 */
	async #findPrompt(
		process: OmpProcess,
		fromEnd: number,
		original: string,
	): Promise<{ entryId: string; timestamps: number[] }> {
		const { entries, leafId } = await process.request("get_entries", {});
		const byId = new Map<string, Record<string, unknown>>();
		for (const entry of entries) if (typeof entry.id === "string") byId.set(entry.id, entry);
		const timestamps: number[] = [];
		let seen = 0;
		for (let id = leafId; id;) {
			const entry = byId.get(id);
			if (!entry) break;
			const prompt = userPrompt(entry);
			if (prompt) {
				if (prompt.timestamp !== undefined) timestamps.unshift(prompt.timestamp);
				if (seen++ === fromEnd) {
					if (prompt.text.trim() !== original.trim()) break;
					// Checkpoints are keyed by the prompt's timestamp: without one there is none to find.
					return { entryId: id, timestamps: prompt.timestamp === undefined ? [] : timestamps };
				}
			}
			id = typeof entry.parentId === "string" ? entry.parentId : null;
		}
		throw new Error("That message is no longer in this session. Reopen the chat and try again.");
	}

	/**
	 * Start snapshotting the repositories for a turn that starts now; the prompt
	 * that starts it keys the checkpoint. The prompt is sent without waiting:
	 * omp changes no file before the model answers and asks for a tool, and a
	 * tool starting before the snapshots are done discards them (see `#trackCheckpoint`).
	 */
	#beginTurnCheckpoint(): void {
		this.#turn = undefined;
		const sessionFile = this.sessionFile;
		if (!this.checkpoints || !sessionFile || !readConfig().fileCheckpoints) return;
		const turn: TurnCheckpoint = {
			sessionFile,
			repos: [],
			snapshot: Promise.resolve(),
			ready: false,
			discarded: false,
			editedFiles: false,
		};
		turn.snapshot = this.#snapshotRepos().then(repos => {
			if (repos) turn.repos = repos;
			else turn.discarded = true;
			turn.ready = true;
		});
		this.#turn = turn;
	}

	/** Snapshot every repository of the workspace; undefined without git or when they cannot be listed. */
	async #snapshotRepos(): Promise<RepoCheckpoint[] | undefined> {
		try {
			if (!(await gitAvailable())) return undefined;
			const roots = await discoverRepos(workspaceRoots());
			const repos = await Promise.all(
				roots.map(root =>
					snapshotTree(root).then(
						before => ({ root, before }),
						error => {
							this.log.appendLine(`[checkpoint] ${root}: ${errorMessage(error)}`);
							return undefined;
						},
					),
				),
			);
			return repos.filter(repo => repo !== undefined);
		} catch (error) {
			this.log.appendLine(`[checkpoint] ${errorMessage(error)}`);
			return undefined;
		}
	}

	/**
	 * Track the turn's checkpoint through its events: keyed by its prompt,
	 * marked when one of the session's own file tools runs, closed by `agent_end`.
	 * Saving waits for the turn's snapshots; a turn whose first tool started
	 * before they were done saves nothing (its prompt offers no file restore).
	 */
	#trackCheckpoint(frame: RpcNotification): void {
		const turn = this.#turn;
		const store = this.checkpoints;
		if (!turn || !store) return;
		if (frame.type === "tool_execution_start") {
			if (!turn.ready && !turn.discarded) {
				turn.discarded = true;
				this.log.appendLine(
					`[checkpoint] ${frame.toolName} started before the file snapshot was done; this prompt has no file checkpoint`,
				);
			}
			if (editsFiles(frame.toolName, frame.args)) turn.editedFiles = true;
		} else if (
			(frame.type === "message_start" || frame.type === "message_end") &&
			turn.promptTimestamp === undefined
		) {
			const message = frame.message;
			if (!isUserPrompt(message)) return;
			const promptTimestamp = message.timestamp;
			turn.promptTimestamp = promptTimestamp;
			this.#queueCheckpointWork(async () => {
				await turn.snapshot;
				if (turn.discarded) return;
				await store.put(turn.sessionFile, { promptTimestamp, repos: turn.repos, editedFiles: turn.editedFiles });
			});
		} else if (frame.type === "agent_end") {
			this.#turn = undefined;
			const promptTimestamp = turn.promptTimestamp;
			if (promptTimestamp === undefined) return;
			this.#queueCheckpointWork(async () => {
				await turn.snapshot;
				if (turn.discarded) return;
				const repos = await Promise.all(
					turn.repos.map(async repo => ({
						...repo,
						after: await snapshotTree(repo.root).catch(() => undefined),
					})),
				);
				await store.put(turn.sessionFile, { promptTimestamp, repos, editedFiles: turn.editedFiles });
			});
		}
	}

	#queueCheckpointWork(work: () => Promise<void>): void {
		this.#checkpointWork = this.#checkpointWork
			.then(work)
			.catch(error => this.log.appendLine(`[checkpoint] ${errorMessage(error)}`));
	}

	/**
	 * Per repository, the snapshots of the turns started by `timestamps` (a
	 * prompt and the later ones on the branch) in which the session edited files
	 * with its own file tools, or undefined when the first prompt has no
	 * checkpoint. Turns that edited nothing are left out, so what changed during
	 * them (other sessions, the user) is never restored. Repositories the first
	 * checkpoint lacks are skipped.
	 */
	async #repoTurns(
		timestamps: readonly number[],
	): Promise<Array<{ root: string; turns: TurnSnapshots[] }> | undefined> {
		const sessionFile = this.sessionFile;
		const [first] = timestamps;
		if (!this.checkpoints || !sessionFile || first === undefined) return undefined;
		await this.#checkpointWork;
		const byPrompt = new Map((await this.checkpoints.load(sessionFile)).map(entry => [entry.promptTimestamp, entry]));
		const start = byPrompt.get(first);
		if (!start) return undefined;
		// Checkpoints saved before this was tracked have no flag: they count as editing.
		const editing = timestamps.flatMap(timestamp => {
			const checkpoint = byPrompt.get(timestamp);
			return checkpoint && checkpoint.editedFiles !== false ? [checkpoint] : [];
		});
		return start.repos.map(({ root }) => ({
			root,
			turns: editing.flatMap(checkpoint => checkpoint.repos.find(repo => repo.root === root) ?? []),
		}));
	}

	async #restoreFiles(timestamps: readonly number[], overwrite: readonly string[]): Promise<FileRestore | undefined> {
		const repos = await this.#repoTurns(timestamps);
		if (!repos) return undefined;
		const results = await Promise.all(
			repos.map(repo => {
				const relative = overwrite
					.map(file => path.relative(repo.root, file))
					.filter(file => !file.startsWith("..") && !path.isAbsolute(file))
					.map(file => file.split(path.sep).join("/"));
				return restoreTurns(repo.root, repo.turns, { write: true, overwrite: new Set(relative) });
			}),
		);
		return {
			repos: results.map(({ root, current, files }) => ({ root, current, files })),
			files: results.flatMap(result => result.files.map(file => path.join(result.root, file.path))),
			conflicts: results.flatMap(result => result.conflicts.map(file => path.join(result.root, file))),
		};
	}

	/** `navigate_tree`, retried while omp finishes winding down an aborted turn. */
	async #navigateTree(process: OmpProcess, entryId: string): Promise<OmpResult<"navigate_tree">> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await process.request("navigate_tree", { entryId });
			} catch (error) {
				if (!(error instanceof OmpCommandError)) throw error;
				if (error.message.startsWith("Unknown command")) {
					throw new Error(
						"Editing messages needs a newer MarIA Code engine (omp with the `navigate_tree` RPC command).",
					);
				}
				if (error.code !== "session_busy" || attempt >= NAVIGATE_BUSY_RETRIES) throw error;
				await sleep(NAVIGATE_BUSY_DELAY_MS);
			}
		}
	}

	/** Resolves once no turn or compaction runs (or after `timeoutMs`; omp then reports what is still busy). */
	async #untilIdle(timeoutMs = 15_000): Promise<void> {
		if (!this.running) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		const subscription = this.onDidChange(() => {
			if (!this.running) resolve();
		});
		const timer = setTimeout(resolve, timeoutMs);
		try {
			await promise;
		} finally {
			subscription.dispose();
			clearTimeout(timer);
		}
	}

	async #stopProcess(): Promise<void> {
		const process = this.#process;
		this.#process = undefined;
		this.#dialogs.dispose();
		if (process) await process.stop();
	}

	#setStatus(status: AgentStatus): void {
		this.#status = status;
		this.post({ type: "status", status });
		this.#onDidChange.fire(this);
	}

	#notice(level: "info" | "warning" | "error", message: string): void {
		this.log.appendLine(`[${level}] ${message}`);
		this.post({ type: "notice", level, message });
	}

	/**
	 * omp's plan-approval dialog, shown as a card in the chat with the whole plan
	 * (read from the plan file `get_state` reports) and the dialog's options.
	 */
	async #reviewPlan(
		request: { id: string; title: string; options: string[] },
		token: vscode.CancellationToken,
	): Promise<string | undefined> {
		const [heading = "", ...preview] = request.title.split("\n");
		const planFile = (await this.process?.request("get_state"))?.planMode?.planFile;
		const content = planFile ? await fs.readFile(planFile, "utf8").catch(() => undefined) : undefined;
		const update: PlanReview = {
			type: "planReview",
			id: request.id,
			// `Approve plan "<title>" and start implementation?`
			title: /"(.+)"/.exec(heading)?.[1] ?? heading,
			// Without a readable plan file, the dialog's own preview of the plan.
			content: content ?? preview.join("\n").trim(),
			path: content === undefined ? undefined : planFile,
			options: request.options,
		};
		if (token.isCancellationRequested) return undefined;
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		this.#planReviews.set(request.id, { update, resolve });
		const cancelled = token.onCancellationRequested(() => {
			this.#planReviews.delete(request.id);
			this.post({ type: "planReviewClosed", id: request.id });
			resolve(undefined);
		});
		if (this.#views.size === 0) this.#onNeedsAttention.fire(this);
		for (const view of this.#views) view.reveal();
		this.post(update);
		try {
			return await promise;
		} finally {
			cancelled.dispose();
		}
	}

	#onFrame(process: OmpProcess, frame: RpcNotification): void {
		if (this.#process !== process) return;
		this.#trackCheckpoint(frame);
		switch (frame.type) {
			case "available_commands_update":
				this.post({ type: "commands", commands: frame.commands });
				break;
			case "command_output": {
				this.post({ type: "commandOutput", text: frame.text });
				const sessionFile = this.sessionFile;
				if (sessionFile && this.commandOutputs) {
					this.commandOutputs
						.add(sessionFile, { timestamp: Date.now(), text: frame.text })
						.catch(error => this.log.appendLine(`[error] Could not save command output: ${errorMessage(error)}`));
				}
				break;
			}
			case "session_info_update":
				if (frame.title) this.#title = frame.title;
				break;
			case "skill_curation":
				// Its proposals reach the views through the shared proposal store.
				this.#setCuration(
					frame.status === "running" ? { type: "skillCuration", status: "running" } : CURATION_IDLE,
				);
				break;
			case "subagent_lifecycle":
				this.#subagents.applyLifecycle(frame.payload);
				this.#scheduleSubagents();
				break;
			case "subagent_progress":
				this.#subagents.applyProgress(frame.payload);
				this.#scheduleSubagents();
				break;
			case "prompt_result":
				if (frame.status === "error" && frame.error) this.#notice("error", frame.error.message);
				break;
			case "session_settled":
				this.#settled = true;
				this.#onDidChange.fire(this);
				// Settled, not `agent_end`: a non-terminal end, a queued follow-up, a goal continuation
				// or a background job's result still wakes the agent, so the task is not done yet.
				if (this.#soundPending) {
					this.#soundPending = false;
					if (!this.#soundSuppressed) playCompletionSound(readConfig().completionSound);
				}
				break;
			case "extension_error":
				this.log.appendLine(`[extension error] ${JSON.stringify(frame)}`);
				break;
			case "rpc_frame_error":
				this.log.appendLine(`[frame dropped] ${frame.error}`);
				break;
			case "dictation_state":
				if (frame.state === "idle") this.#dictating = false;
				this.post({ type: "dictation", state: frame.state, text: frame.text, error: frame.error });
				break;
		}
		if (!NON_EVENT_FRAMES[frame.type])
			this.post({ type: "event", event: frame as Extract<ChatUpdate, { type: "event" }>["event"] });
		if (frame.type === "agent_start") {
			this.#busy = true;
			this.#busySince = Date.now();
			this.#settled = false;
			this.#soundPending = true;
			this.#soundSuppressed = false;
			this.#onDidChange.fire(this);
		} else if (frame.type === "agent_end") {
			this.#busy = false;
			if (this.#views.size === 0) this.#finishedUnseen = true;
			this.#onDidChange.fire(this);
			// A run that was stopped or failed is not a finished task (as omp's terminal notification).
			const last = frame.messages.findLast(message => message.role === "assistant");
			if (last?.stopReason === "aborted" || last?.stopReason === "error") this.#soundSuppressed = true;
		}
		if (frame.type === "message_end") {
			const runBefore = this.#planRun.id;
			this.#planRun.apply(frame.message);
			const run = this.#planRun.id;
			if (run !== undefined && run !== runBefore && this.#reviewedPlanFile) {
				this.#planFiles.set(run, this.#reviewedPlanFile);
				this.#reviewedPlanFile = undefined;
			}
		}
		if (frame.type === "message_end" || frame.type === "agent_start" || frame.type === "agent_end") {
			this.#postPlanRun();
		}
		// Approving a plan (a `write` to `xd://propose`) leaves plan mode mid-turn.
		const planDecision = frame.type === "tool_execution_end" && frame.toolName === "write";
		if (STATE_CHANGING_EVENTS[frame.type] || (planDecision && this.#state?.planMode)) this.#scheduleRefresh();
	}

	/** Coalesce bursts of state-changing events into one `get_state`. */
	#scheduleRefresh(): void {
		clearTimeout(this.#refreshTimer);
		this.#refreshTimer = setTimeout(() => void this.#refreshState().catch(() => {}), 150);
	}

	/** Coalesce bursts of subagent frames into one panel update. */
	#scheduleSubagents(): void {
		if (this.#subagentsTimer) return;
		this.#subagentsTimer = setTimeout(() => this.#postSubagents(), 200);
	}

	#postSubagents(): void {
		clearTimeout(this.#subagentsTimer);
		this.#subagentsTimer = undefined;
		this.post({ type: "subagents", subagents: this.#subagents.list() });
		void this.#readWatched();
	}

	#resetSubagents(): void {
		this.watchSubagent(null);
		if (this.#subagents.clear()) this.#postSubagents();
	}

	/**
	 * Read the watched subagent's new transcript lines and post its requests. One
	 * read at a time: a call while reading marks the result stale, and the reader
	 * goes again before posting.
	 */
	async #readWatched(): Promise<void> {
		const watched = this.#watched;
		const process = this.process;
		if (!watched || !process) return;
		if (watched.reading) {
			watched.stale = true;
			return;
		}
		watched.reading = true;
		try {
			do {
				watched.stale = false;
				const transcript = await process.request("get_subagent_messages", {
					subagentId: watched.id,
					fromByte: watched.log.nextByte,
				});
				if (this.#watched !== watched) return;
				if (transcript.reset) watched.log.reset();
				watched.log.append(transcript.messages);
				watched.log.nextByte = transcript.nextByte;
			} while (watched.stale);
			const row = this.#subagents.list().find(subagent => subagent.id === watched.id);
			const active = row?.status === "pending" || row?.status === "running";
			this.post({ type: "subagentRequests", id: watched.id, ...watched.log.view(active) });
			if (!active) {
				clearInterval(this.#watchTimer);
				this.#watchTimer = undefined;
			}
		} catch (error) {
			if (this.#watched !== watched) return;
			this.post({
				type: "subagentRequests",
				id: watched.id,
				requests: [],
				waiting: false,
				error: errorMessage(error),
			});
			clearInterval(this.#watchTimer);
			this.#watchTimer = undefined;
		} finally {
			watched.reading = false;
		}
	}

	async #refreshState(): Promise<void> {
		const process = this.process;
		if (!process) return;
		const [state, stats] = await Promise.all([
			process.request("get_state"),
			process.request("get_session_stats").catch(() => undefined),
		]);
		if (this.#process !== process) return;
		const fileChanged = state.sessionFile !== this.#state?.sessionFile;
		this.#state = state;
		if (this.noWorkspace && state.sessionFile) rememberNoWorkspaceSession(state.sessionFile);
		if (state.isSettled !== undefined) this.#settled = state.isSettled && !this.#busy;
		if (state.sessionName) this.#title = state.sessionName;
		else if (fileChanged) this.#title = undefined;
		this.post({
			type: "state",
			state,
			stats,
			title: this.#title,
			busySince: this.#busy ? this.#busySince : undefined,
			noWorkspace: this.noWorkspace,
		});
		this.#onDidChange.fire(this);
		this.#postPlanRun();
	}

	async #sendThinkingLevels(views: Iterable<HostView>): Promise<void> {
		const process = this.process;
		if (!process) return;
		const { levels } = await process.request("get_available_thinking_levels");
		for (const view of views) view.post({ type: "thinkingLevels", levels });
	}

	/** Everything `views` need after a (re)start, session change, or attaching. */
	async #sendSnapshot(process: OmpProcess, views: Iterable<HostView>): Promise<void> {
		const targets = [...views];
		const send = (update: ChatUpdate) => {
			for (const view of targets) view.post(update);
		};
		await this.#refreshState();
		const messages = await this.#history(process);
		const sessionFile = this.sessionFile;
		const commandOutputs =
			sessionFile && this.commandOutputs ? await this.commandOutputs.load(sessionFile).catch(() => []) : [];
		if (this.#process !== process) return;
		send({ type: "history", messages, commandOutputs });
		this.#planRun.load(messages);
		if (this.#planRun.id !== undefined && this.#planRun.id === this.#dismissedPlanRun) this.#planRun.clear();
		const run = this.#planRunView();
		this.#postedPlanRun = JSON.stringify(run);
		this.post({ type: "planRun", run });
		const [commands] = await Promise.all([
			process.request("get_available_commands").catch(() => undefined),
			this.#sendThinkingLevels(targets).catch(error => this.log.appendLine(String(error))),
		]);
		if (commands) send({ type: "commands", commands: commands.commands });
		// Model discovery can take seconds; the picker fills in when it finishes.
		void this.availableModels()
			.then(models => send({ type: "models", models }))
			.catch(error => this.log.appendLine(`model list failed: ${errorMessage(error)}`));
	}

	/** The whole transcript, paged so long sessions never exceed a frame. */
	async #history(process: OmpProcess): Promise<AgentMessage[]> {
		const messages: AgentMessage[] = [];
		let cursor: string | undefined;
		try {
			do {
				const page = await process.request("get_messages_page", cursor ? { cursor, limit: 256 } : { limit: 256 });
				messages.push(...page.messages);
				cursor = page.nextCursor;
			} while (cursor);
		} catch (error) {
			// Paging refuses to start mid-turn (`session_busy`) or after the session moved (`stale_cursor`).
			if (!(error instanceof OmpCommandError) || (error.code !== "session_busy" && error.code !== "stale_cursor")) {
				throw error;
			}
			return (await process.request("get_messages")).messages;
		}
		return messages;
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** omp's tools that write files directly; the `lsp` tool only when it applies a rename or code action. */
const FILE_EDIT_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true, notebook: true };
const LSP_EDIT_ACTIONS: Record<string, true> = { rename: true, rename_file: true, code_actions: true };

/**
 * Whether a tool call edits files directly (edit, write, ast_edit, notebook,
 * an applied LSP rename/code action). Shell and code tools do not count: what
 * they change cannot be told apart from other sessions' work.
 */
export function editsFiles(toolName: string, args: unknown): boolean {
	if (FILE_EDIT_TOOLS[toolName]) return true;
	if (toolName !== "lsp" || !args || typeof args !== "object" || !("action" in args)) return false;
	const apply = "apply" in args ? args.apply : undefined;
	return typeof args.action === "string" && LSP_EDIT_ACTIONS[args.action] === true && apply !== false;
}
