/**
 * One chat surface (sidebar view or editor tab): a webview showing one
 * session at a time.
 *
 * The omp process behind the session is an `AgentHost` from the shared
 * `AgentPool`. Moving to another session attaches the view to that session's
 * host and leaves the previous host running if it is busy, so several
 * sessions can work at once; an idle host is reused in place or stopped.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { SessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/wire/rpc-wire.generated";
import { agentDir, readConfig, workspaceCwd } from "../config";
import type { AgentStatus, ChatRequest, ChatUpdate, ModelChoice } from "../protocol";
import { OmpCommandError, type OmpProcess } from "../rpc/omp-process";
import { renameStoredSession } from "../sessions/rename";
import { sessionSearch } from "../sessions/session-search";
import { guessSessionDir, listSessions, sessionLabel } from "../sessions/session-store";
import { isNoWorkspaceSession, noWorkspaceFolder, noWorkspaceSessionDir } from "../no-workspace";
import { runOmp } from "../settings/settings-panel";
import type { SkillProposalStore } from "../skills/proposals";
import { webviewHtml } from "../webview-html";
import {
	type AgentHost,
	type EditPlan,
	errorMessage,
	type FileRestore,
	type HostView,
	type SessionTarget,
} from "./agent-host";
import type { AgentPool } from "./agent-pool";
import type { ExamplePromptStore } from "./example-prompt-store";
import { mentionCandidates } from "./mentioned-file";

export interface ChatSurface {
	readonly webview: vscode.Webview;
	readonly visible: boolean;
	reveal(): void;
	/** Starts a new chat in a tab beside this one (editor tabs). Absent where "new session" replaces this chat's session. */
	openBeside?(noWorkspace: boolean): void;
}

/** Shown before the view has a process (it gets one as soon as it opens). */
const NO_PROCESS: AgentStatus = { phase: "starting" };
const NO_STATUS_TEXTS: ReadonlyMap<string, string> = new Map();

export class ChatSession implements vscode.Disposable, HostView {
	#host: AgentHost | undefined;
	#hostSubscription: vscode.Disposable | undefined;
	#webviewReady = false;
	/** The session whose proposals the webview shows; `null` until first sent. */
	#proposalsSessionFile: string | undefined | null = null;
	readonly #disposables: vscode.Disposable[] = [];
	readonly #onDidChange = new vscode.EventEmitter<ChatSession>();
	/** Fires when the shown session, its process, title, model, or busy state changes. */
	readonly onDidChange = this.#onDidChange.event;
	readonly #onDidChangeFocus = new vscode.EventEmitter<boolean>();
	/** Fires when keyboard focus enters (`true`) or leaves the chat webview. */
	readonly onDidChangeFocus = this.#onDidChangeFocus.event;

	constructor(
		readonly surface: ChatSurface,
		readonly extensionUri: vscode.Uri,
		readonly log: vscode.OutputChannel,
		/** Commands the webview can trigger that live outside this session. */
		readonly commands: {
			openSettings(): void;
			login(session: ChatSession): void;
			attachFiles(session: ChatSession): void;
			/** Asks for confirmation; resolves once the session is deleted or the user declined. */
			deleteSession(sessionFile: string, label: string): Promise<void>;
			/** Opens the file with the tool call's changes marked. */
			showToolChanges(session: ChatSession, toolCallId: string, path: string): Promise<void>;
		},
		readonly pool: AgentPool,
		/** Pending skill proposals of every session; the header shows the shown session's. */
		readonly proposals: SkillProposalStore,
		/** The empty chat's prompts, shared by every chat. */
		readonly examplePrompts: ExamplePromptStore,
	) {
		surface.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist", "webview")],
		};
		surface.webview.html = webviewHtml(surface.webview, extensionUri, "chat");
		this.#disposables.push(
			surface.webview.onDidReceiveMessage((request: ChatRequest) => {
				void this.#handle(request).catch(error => this.#notice("error", explainError(errorMessage(error))));
			}),
			// Running/finished marks in the history panel follow every session of the window.
			pool.onDidChangeActivity(() => this.post({ type: "sessionActivity", activity: pool.activities() })),
			proposals.onDidChange(() => {
				this.#postProposals(true);
				this.post({ type: "sessionProposals", counts: this.#proposalCounts() });
			}),
			examplePrompts.onDidChange(() => this.post({ type: "examplePrompts", ...examplePrompts.get() })),
		);
	}

	get host(): AgentHost | undefined {
		return this.#host;
	}
	get status(): AgentStatus {
		return this.#host?.status ?? NO_PROCESS;
	}
	get state(): SessionState | undefined {
		return this.#host?.state;
	}
	get title(): string | undefined {
		return this.#host?.title;
	}
	get busy(): boolean {
		return this.#host?.busy ?? false;
	}
	get process(): OmpProcess | undefined {
		return this.#host?.process;
	}
	/** Extension status texts (`setStatus`), e.g. from omp extensions. */
	get statusTexts(): ReadonlyMap<string, string> {
		return this.#host?.statusTexts ?? NO_STATUS_TEXTS;
	}

	/**
	 * Show `target` in a new process (a chat without a workspace when `noWorkspace`);
	 * joins the existing process instead when that session is already open.
	 */
	async open(target: SessionTarget, noWorkspace = false): Promise<void> {
		if (target.kind === "resume") {
			const existing = this.pool.find(target.sessionFile);
			if (existing) {
				this.showHost(existing);
				return;
			}
		}
		const host = this.pool.create(noWorkspace);
		this.showHost(host);
		await host.start(target);
		// `--continue` picks the newest session, which another view may already have open:
		// one process per session file, so join that one.
		const twin = this.pool.find(host.sessionFile, host);
		if (twin && this.#host === host) this.showHost(twin);
	}

	/** Show the session `host` runs, leaving the previous one running if it is busy. */
	showHost(host: AgentHost): void {
		const previous = this.#host;
		if (previous === host) return;
		this.#hostSubscription?.dispose();
		previous?.detach(this);
		this.#host = host;
		host.attach(this);
		this.#hostSubscription = host.onDidChange(() => {
			this.#postProposals(false);
			this.#onDidChange.fire(this);
		});
		this.pool.seen(host.sessionFile);
		if (this.#webviewReady) void host.replay(this).catch(error => this.log.appendLine(String(error)));
		if (previous) this.pool.release(previous);
		this.#postProposals(false);
		this.#onDidChange.fire(this);
	}

	/**
	 * Send the pending proposals the shown session's task produced; unless `force`,
	 * only when the shown session changed since the last send.
	 */
	#postProposals(force: boolean): void {
		if (!this.#webviewReady) return;
		const sessionFile = this.#host?.sessionFile;
		if (!force && sessionFile === this.#proposalsSessionFile) return;
		this.#proposalsSessionFile = sessionFile;
		const proposals = sessionFile
			? this.proposals.proposals.filter(proposal => proposal.sessionFile === sessionFile)
			: [];
		this.post({ type: "skillProposals", proposals });
	}

	/** Pending proposals per session file, for the history panel's curation marks. */
	#proposalCounts(): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const { sessionFile } of this.proposals.proposals) {
			if (sessionFile) counts[sessionFile] = (counts[sessionFile] ?? 0) + 1;
		}
		return counts;
	}

	/**
	 * Show the session in `sessionFile`. A session already open in this window is
	 * joined; an idle process this view alone uses switches in place when it runs in
	 * the same place (the workspace, or the no-workspace folder); otherwise a new
	 * process opens the session and a busy one keeps running in the background.
	 */
	async switchSession(sessionFile: string): Promise<void> {
		const current = this.#host;
		if (current?.sessionFile === sessionFile && current.process) return;
		const existing = this.pool.find(sessionFile);
		if (existing) {
			this.showHost(existing);
			return;
		}
		const noWorkspace = await isNoWorkspaceSession(sessionFile);
		if (current && current.noWorkspace === noWorkspace && this.#ownsIdle(current)) {
			await current.switchSession(sessionFile);
			this.pool.seen(sessionFile);
			return;
		}
		await this.open({ kind: "resume", sessionFile }, noWorkspace);
	}

	/**
	 * Start a new session (without a workspace when `noWorkspace`): in this view's
	 * process when it is idle, not shared and runs in the same place, else in a new one.
	 */
	async newSession(noWorkspace = false): Promise<void> {
		const current = this.#host;
		if (current && current.noWorkspace === noWorkspace && this.#ownsIdle(current)) {
			await current.newSession();
			return;
		}
		await this.open({ kind: "new" }, noWorkspace);
	}

	async restart(): Promise<void> {
		await this.#requireHost().restart();
	}

	async rename(name: string): Promise<void> {
		await this.#requireHost().rename(name);
	}

	async abort(): Promise<void> {
		await this.#host?.abort();
	}

	async compact(): Promise<void> {
		await this.#requireHost().compact();
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		await this.#requireHost().setModel(provider, modelId);
	}

	async setThinkingLevel(level: SessionState["thinkingLevel"] & string): Promise<void> {
		await this.#requireHost().setThinkingLevel(level);
	}

	async availableModels(): Promise<ModelChoice[]> {
		return this.#requireHost().availableModels();
	}

	/**
	 * Resend a prompt edited. Editing one that is not the last drops the later
	 * turns from the conversation, and when omp changed files since that prompt
	 * the user picks whether they go back too; either asks for confirmation.
	 */
	async #editMessage(fromEnd: number, original: string, text: string): Promise<void> {
		let resent = false;
		try {
			const host = this.#requireHost();
			const plan = await host.planEdit(fromEnd, original);
			const decision = await confirmEdit(fromEnd, plan);
			if (!decision) return;
			const result = await host.editMessage(fromEnd, original, text, decision.restore);
			resent = result.resent;
			if (result.restored) void this.#reportRestore(host, result.restored);
		} finally {
			// The webview keeps the editor open until the conversation reloads.
			if (!resent) this.post({ type: "editAborted" });
		}
	}

	/** Say what the restore did, offering to undo it. */
	async #reportRestore(host: AgentHost, restored: FileRestore): Promise<void> {
		const count = restored.files.length;
		const kept = restored.conflicts.length;
		if (count === 0 && kept === 0) return;
		const parts = [`MarIA Code: restored ${count} ${count === 1 ? "file" : "files"}`];
		if (kept > 0) parts.push(`kept ${kept} you also changed: ${relativeList(restored.conflicts)}`);
		const message = `${parts.join("; ")}.`;
		if (count === 0) {
			void vscode.window.showInformationMessage(message);
			return;
		}
		if ((await vscode.window.showInformationMessage(message, "Undo")) !== "Undo") return;
		try {
			const skipped = await host.undoRestore(restored);
			if (skipped.length > 0) {
				void vscode.window.showWarningMessage(
					`MarIA Code: undid the restore except for files changed since: ${relativeList(skipped)}.`,
				);
			}
		} catch (error) {
			this.#notice("error", `Undo failed: ${errorMessage(error)}`);
		}
	}

	post(update: ChatUpdate): void {
		if (this.#webviewReady) void this.surface.webview.postMessage(update);
	}

	reveal(): void {
		this.surface.reveal();
	}

	/** Insert text into the composer, revealing the chat. */
	insertText(text: string): void {
		this.surface.reveal();
		this.post({ type: "insertText", text });
	}

	/** "Toggle Voice Input": the webview starts dictating, or stops and transcribes. */
	toggleDictation(): void {
		this.surface.reveal();
		this.post({ type: "toggleDictation" });
	}

	/** "Find in Chat" (Ctrl+F while the chat has focus): open the webview's find bar. */
	openFind(): void {
		this.post({ type: "openFind" });
	}

	dispose(): void {
		this.#hostSubscription?.dispose();
		const host = this.#host;
		this.#host = undefined;
		if (host) {
			host.detach(this);
			this.pool.release(host);
		}
		for (const disposable of this.#disposables) disposable.dispose();
		this.#onDidChange.dispose();
		this.#onDidChangeFocus.fire(false);
		this.#onDidChangeFocus.dispose();
	}

	/**
	 * Idle (nothing running or pending) and shown by this view only: reusable for
	 * another session, since `new_session`/`switch_session` would abort a running turn.
	 */
	#ownsIdle(host: AgentHost): boolean {
		return Boolean(host.process) && !host.running && host.settled && host.views.size === 1;
	}

	#requireHost(): AgentHost {
		const host = this.#host;
		if (!host) throw new Error('MarIA Code is not running. Use "MarIA Code: Restart Agent Process".');
		return host;
	}

	#notice(level: "info" | "warning" | "error", message: string): void {
		this.log.appendLine(`[${level}] ${message}`);
		this.post({ type: "notice", level, message });
	}

	/** Voice input: omp records the microphone and transcribes it; the webview shows the state. */
	async #dictation(action: "start" | "stop" | "cancel"): Promise<void> {
		const host = this.#requireHost();
		if (action === "cancel") {
			await host.dictationCancel();
			return;
		}
		if (action === "start") {
			await this.#startDictation(host);
			return;
		}
		try {
			const { text, submit } = await host.dictationStop();
			this.post({ type: "dictationText", text, submit });
		} catch (error) {
			this.post({ type: "dictation", state: "idle" });
			throw error;
		}
	}

	/**
	 * Start dictating. Without a cloud speech model (no Groq key) offer to sign
	 * in to Groq, then start.
	 */
	async #startDictation(host: AgentHost): Promise<void> {
		try {
			await host.dictationStart(readConfig().voiceLanguage);
		} catch (error) {
			this.post({ type: "dictation", state: "idle" });
			if (!(error instanceof OmpCommandError)) throw error;
			if (error.message.startsWith("Unknown command")) {
				throw new Error("Voice input needs a newer MarIA Code engine (omp with the dictation RPC commands).");
			}
			if (error.code !== "no_dictation_model") throw error;
			if (!(await confirmGroqSetup())) return;
			const process = host.process;
			if (!process) return;
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: "MarIA Code: signing in to Groq…" },
				() => process.request("login", { providerId: "groq" }),
			);
			await this.#startDictation(host);
		}
	}

	/** Session directories the history panel lists: the workspace's, then the chats without a workspace. */
	async #sessionDirs(): Promise<[string, string]> {
		const current = this.state?.sessionFile;
		const currentDir = current && path.dirname(current);
		const sessionsRoot = path.join(agentDir(), "sessions");
		return Promise.all([
			currentDir && !this.#host?.noWorkspace ? currentDir : guessSessionDir(sessionsRoot, workspaceCwd()),
			currentDir && this.#host?.noWorkspace ? currentDir : noWorkspaceSessionDir(),
		]);
	}

	/**
	 * The history panel's sessions, newest first: the workspace's, then the chats
	 * without a workspace, with what each is doing.
	 */
	async #postSessions(): Promise<void> {
		const current = this.state?.sessionFile;
		const [workspaceDir, noWorkspaceDir] = await this.#sessionDirs();
		const groups = await Promise.all(
			[workspaceDir, noWorkspaceDir].map(async (dir, index) => ({
				noWorkspace: index === 1,
				// Both are the same when the workspace is the no-workspace folder itself: list its chats once.
				sessions: index === 1 && dir === workspaceDir ? [] : await listSessions(dir),
			})),
		);
		const activity = this.pool.activities();
		const proposals = this.#proposalCounts();
		this.post({
			type: "sessions",
			sessions: groups.flatMap(({ noWorkspace, sessions }) =>
				sessions.map(session => ({
					path: session.path,
					label: sessionLabel(session),
					firstPrompt: session.firstMessage,
					lastPrompt: session.singlePrompt ? undefined : session.lastMessage,
					firstPromptFull: session.firstMessageFull,
					lastPromptFull: session.singlePrompt ? undefined : session.lastMessageFull,
					modified: session.modified.getTime(),
					created: session.created?.getTime(),
					messages: session.messageCount,
					messagesPartial: session.truncated,
					active: session.path === current,
					activity: activity[session.path],
					noWorkspace,
					proposals: proposals[session.path] ?? 0,
				})),
			),
		});
	}

	async #handle(request: ChatRequest): Promise<void> {
		switch (request.type) {
			case "focusChanged":
				this.#onDidChangeFocus.fire(request.focused);
				return;
			case "ready":
				this.#webviewReady = true;
				this.post({ type: "examplePrompts", ...this.examplePrompts.get() });
				this.#postProposals(true);
				this.post({ type: "sessionActivity", activity: this.pool.activities() });
				this.post({ type: "sessionProposals", counts: this.#proposalCounts() });
				if (this.#host) await this.#host.replay(this);
				else this.post({ type: "status", status: NO_PROCESS });
				return;
			case "setExamplePrompts":
				await this.examplePrompts.set(request.prompts);
				return;
			case "prompt":
				await this.#requireHost().prompt(request.text, request.images);
				return;
			case "editMessage":
				await this.#editMessage(request.fromEnd, request.original, request.text);
				return;
			case "abort":
				await this.abort();
				return;
			case "newSession":
				if (this.surface.openBeside) this.surface.openBeside(request.noWorkspace ?? false);
				else await this.newSession(request.noWorkspace);
				return;
			case "listSessions":
				await this.#postSessions();
				return;
			case "searchSessions": {
				const hits = await sessionSearch.search(await this.#sessionDirs(), request.query);
				this.post({ type: "sessionSearch", query: request.query, hits });
				return;
			}
			case "openSession":
				await this.switchSession(request.path);
				return;
			case "renameSession": {
				const name = request.name.trim();
				if (!name) return;
				// A session open in some process is renamed there: two writers would clobber its file.
				const host = request.path === undefined ? this.#host : this.pool.find(request.path);
				if (host) await host.rename(name);
				else if (request.path) await renameStoredSession(request.path, name, this.log);
				await this.#postSessions();
				return;
			}
			case "deleteSession":
				await this.commands.deleteSession(request.path, request.label);
				await this.#postSessions();
				return;
			case "attachFiles":
				this.commands.attachFiles(this);
				return;
			case "setModel":
				await this.setModel(request.provider, request.modelId);
				return;
			case "setThinkingLevel":
				await this.setThinkingLevel(request.level);
				return;
			case "setPlanMode": {
				const host = this.#requireHost();
				await host.setPlanMode(request.enabled);
				if (request.prompt) await host.prompt(request.prompt, undefined);
				return;
			}
			case "setDelegateMode":
				await this.#requireHost().setDelegateMode(request.enabled);
				return;
			case "hurrySubagents":
				await this.#requireHost().hurrySubagents();
				return;
			case "getScopeCheckpoint": {
				const stats = await this.#host?.scopeCheckpointStats().catch((error: unknown) => {
					this.log.appendLine(`[warning] get_scope_checkpoint failed: ${errorMessage(error)}`);
					return undefined;
				});
				this.post({ type: "scopeCheckpoint", stats: stats ?? null });
				return;
			}
			case "sendScopeCheckpoint":
				await this.#requireHost().sendScopeCheckpoint(request.level);
				return;
			case "cancelAsyncJob":
				await this.#requireHost().cancelAsyncJob(request.id);
				return;
			case "watchSubagent":
				this.#host?.watchSubagent(request.id);
				return;
			case "openSettings":
				this.commands.openSettings();
				return;
			case "login":
				this.commands.login(this);
				return;
			case "dictation":
				await this.#dictation(request.action);
				return;
			case "predictWord": {
				const suffix = await this.#host?.predictWord(request.text, request.cursor);
				this.post({ type: "wordPrediction", requestId: request.requestId, suffix: suffix ?? null });
				return;
			}
			case "predictWordFeedback":
				this.#host?.predictWordFeedback(request.text, request.cursor, request.suggestion, request.accepted);
				return;
			case "compact":
				await this.compact();
				return;
			case "restart":
				await this.restart();
				return;
			case "planDecision":
				await this.#host?.decidePlan(request.id, request.value, request.feedback);
				return;
			case "dismissPlanRun":
				this.#host?.dismissPlanRun();
				return;
			case "openPlan":
				// Rendered, as Claude Code and Codex show plans; the preview links to the source.
				await vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.file(request.path));
				return;
			case "revertSkillUpdate":
				try {
					await runOmp(["skill", "revert", request.id]);
					this.#notice("info", "Skill change reverted.");
				} catch (error) {
					this.#notice(
						"error",
						`Could not revert the skill change: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				return;
			case "approveSkillProposal":
				try {
					await this.proposals.approve(request.id);
					this.#notice("info", "Skill proposal applied.");
				} catch (error) {
					this.#notice("error", `Could not apply the proposal: ${errorMessage(error)}`);
				}
				return;
			case "rejectSkillProposal":
				try {
					await this.proposals.reject(request.id);
				} catch (error) {
					this.#notice("error", `Could not reject the proposal: ${errorMessage(error)}`);
				}
				return;
			case "openSkillProposalDiff":
				await this.proposals.openDiff(request.id);
				return;
			case "openFile":
				await openMentionedFile(request.path, request.line, {
					noWorkspace: this.#host?.noWorkspace ?? false,
					sessionFile: this.state?.sessionFile,
				});
				return;
			case "showToolChanges":
				await this.commands.showToolChanges(this, request.toolCallId, request.path);
				return;
			case "openExternal":
				await vscode.env.openExternal(vscode.Uri.parse(request.url, true));
				return;
			case "removeQueued":
				await this.#requireHost().removeQueued(request.message, request.queue);
				return;
		}
	}
}

/**
 * Open a file the transcript mentions at an optional 1-based line; see
 * {@link resolveMentionedFile}. `noWorkspace`: the chat runs in the no-workspace folder.
 */
async function openMentionedFile(
	file: string,
	line: number | undefined,
	chat: { noWorkspace: boolean; sessionFile?: string },
): Promise<void> {
	const uri = await resolveMentionedFile(file, chat);
	if (!uri) {
		const where = chat.noWorkspace ? noWorkspaceFolder() : "this workspace";
		void vscode.window.showWarningMessage(`MarIA Code: "${file}" was not found in ${where}.`);
		return;
	}
	const document = await vscode.workspace.openTextDocument(uri);
	const position = line && line > 0 ? new vscode.Position(line - 1, 0) : undefined;
	await vscode.window.showTextDocument(document, {
		preview: true,
		selection: position && new vscode.Range(position, position),
	});
}

/** Folders never searched for a mentioned file. */
const SEARCH_EXCLUDE = "**/{node_modules,.git,.venv,venv,dist,build,out,target}/**";
/** Matches listed for a mention that names several files. */
const MAX_MATCHES = 50;

/**
 * The file behind a path the agent wrote: a `local://` scratch file of the
 * session, a `~`/absolute path, or a path relative to the folder the chat works
 * in (the no-workspace folder for a chat without a workspace). Agents in a
 * workspace also cite paths relative to the repository they work in (often a
 * subfolder of the open folder, such as one repo of several) or just a file name
 * (`agent.md`), so there a path missing under the workspace folders is looked up
 * anywhere in the workspace: one match opens, several ask which one, none
 * resolve to undefined.
 */
async function resolveMentionedFile(
	file: string,
	chat: { noWorkspace: boolean; sessionFile?: string },
): Promise<vscode.Uri | undefined> {
	const roots = chat.noWorkspace
		? [noWorkspaceFolder()]
		: [workspaceCwd(), ...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath)];
	for (const candidate of mentionCandidates(file, { roots, sessionFile: chat.sessionFile, home: os.homedir() })) {
		if (await isFile(candidate)) return vscode.Uri.file(candidate);
	}
	// The workspace search does not cover the no-workspace folder, nor names that are not relative paths.
	if (chat.noWorkspace || file.startsWith("local://") || /^~([/\\]|$)/.test(file) || path.isAbsolute(file)) {
		return undefined;
	}
	const relative = file.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
	if (relative.startsWith("../")) return undefined;
	// Glob metacharacters in names (`[id].tsx`) must match literally.
	const pattern = `**/${relative.replace(/[[\]{}()*?!]/g, char => `[${char}]`)}`;
	const matches = await vscode.workspace.findFiles(pattern, SEARCH_EXCLUDE, MAX_MATCHES);
	if (matches.length <= 1) return matches[0];
	const items = matches
		.map(uri => ({ label: vscode.workspace.asRelativePath(uri, true), uri }))
		.sort((a, b) => a.label.length - b.label.length || a.label.localeCompare(b.label));
	const picked = await vscode.window.showQuickPick(items, {
		title: `MarIA Code: open ${relative}`,
		placeHolder: `${matches.length} files match "${relative}"`,
	});
	return picked?.uri;
}

async function isFile(file: string): Promise<boolean> {
	return fs.stat(file).then(
		stats => stats.isFile(),
		() => false,
	);
}

const RESTORE = "Edit and Restore Files";
const KEEP = "Edit Only";
const RESEND = "Edit and Resend";

/**
 * Ask how to edit prompt `fromEnd`: whether to continue (always asked when
 * later messages go away) and whether to restore the files omp changed since,
 * with the conflicting files to reset outright. Undefined when cancelled.
 */
async function confirmEdit(
	fromEnd: number,
	plan: EditPlan,
): Promise<{ restore?: { overwrite: string[] } } | undefined> {
	const changed = plan.files.length + plan.conflicts.length;
	if (fromEnd === 0 && changed === 0) return {};
	const detail: string[] = [];
	if (fromEnd > 0) {
		const later = fromEnd === 1 ? "the message after it" : `the ${fromEnd} messages after it`;
		detail.push(
			`MarIA Code continues the session from the edited message: ${later} and every answer to them are removed from the conversation.`,
		);
	}
	if (changed > 0) {
		detail.push(
			`Since this message MarIA Code changed ${changed} ${changed === 1 ? "file" : "files"}: ${relativeList([...plan.files, ...plan.conflicts])}. Restoring reverts only MarIA Code's changes; changes made by you or other sessions are kept.`,
		);
		if (plan.conflicts.length > 0) {
			detail.push(
				`${plan.conflicts.length} of them were also changed by someone else on the same lines; you choose which of those go back.`,
			);
		}
		detail.push("Git-ignored files (such as a venv) and files outside git repositories are not restored.");
	} else if (!plan.checkpoint) {
		detail.push("This message has no file snapshot, so your files stay as they are.");
	}
	const buttons = changed > 0 ? [RESTORE, KEEP] : [RESEND];
	const choice = await vscode.window.showWarningMessage(
		fromEnd > 0
			? "Edit this message and continue from it?"
			: "Restore the files MarIA Code changed since this message?",
		{ modal: true, detail: detail.join("\n\n") },
		...buttons,
	);
	if (choice === undefined) return undefined;
	if (choice !== RESTORE) return {};
	if (plan.conflicts.length === 0) return { restore: { overwrite: [] } };
	const picked = await vscode.window.showQuickPick(
		plan.conflicts.map(file => ({ label: vscode.workspace.asRelativePath(file), file })),
		{
			canPickMany: true,
			title: "MarIA Code: files changed by MarIA Code and by someone else",
			placeHolder: "Pick the files to put back as they were before the message (other changes in them are lost)",
		},
	);
	if (picked === undefined) return undefined;
	return { restore: { overwrite: picked.map(item => item.file) } };
}

/**
 * A certificate failure means the network re-signs HTTPS with a root omp does
 * not trust: the OS store and the proxy client's certificates are already
 * handed to omp, so say how to add one that is not there, or to stop checking.
 */
function explainError(message: string): string {
	if (!/certificate/i.test(message)) return message;
	return `${message}. Your network re-signs HTTPS with a certificate MarIA Code did not find: set NODE_EXTRA_CA_CERTS in the ompCustom.env setting to that certificate's .pem file (ask IT for it), or as a last resort set NODE_TLS_REJECT_UNAUTHORIZED to "0" there to stop checking certificates; then restart the chat.`;
}

/** Up to six workspace-relative paths, then "and N more". */
function relativeList(files: readonly string[]): string {
	const shown = files.slice(0, 6).map(file => vscode.workspace.asRelativePath(file));
	return files.length > shown.length
		? `${shown.join(", ")} and ${files.length - shown.length} more`
		: shown.join(", ");
}

const SIGN_IN_TO_GROQ = "Sign In to Groq";

/** Voice input transcribes through Groq's API: ask to sign in when omp has no Groq key. */
async function confirmGroqSetup(): Promise<boolean> {
	const choice = await vscode.window.showInformationMessage(
		"Set up voice input",
		{
			modal: true,
			detail:
				"MarIA Code records your microphone and Groq turns speech into text with Whisper, in about a second; its free tier covers hours of audio a day. Sign in with an API key from console.groq.com/keys.",
		},
		SIGN_IN_TO_GROQ,
	);
	return choice === SIGN_IN_TO_GROQ;
}
