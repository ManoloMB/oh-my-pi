/**
 * Chat surfaces: the sidebar webview view and any number of editor tabs. Each
 * shows one session; the omp processes behind them live in one `AgentPool`, so
 * a session keeps running when its view moves on. The most recently focused
 * view is "active": it is what commands, the sessions list, and the status bar
 * act on.
 */
import * as vscode from "vscode";
import type { CheckpointStore } from "../checkpoints/store";
import type { CommandOutputStore } from "./command-outputs";
import { readConfig } from "../config";
import type { AgentHost, SessionTarget } from "./agent-host";
import { AgentPool } from "./agent-pool";
import { ChatSession, type ChatSurface } from "./chat-session";
import type { ExamplePromptStore } from "./example-prompt-store";
import type { SkillProposalStore } from "../skills/proposals";

type SessionCommands = ChatSession["commands"];

/** Context key: a chat webview has keyboard focus (the `ompCustom.findInChat` keybinding's `when`). */
const CHAT_FOCUSED_CONTEXT = "ompCustom.chatFocused";

export class ChatRegistry implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewId = "ompCustom.chat";

	readonly pool: AgentPool;
	#sidebar: ChatSession | undefined;
	#sidebarView: vscode.WebviewView | undefined;
	readonly #panels = new Set<ChatSession>();
	#active: ChatSession | undefined;
	/** The chat whose webview has keyboard focus. */
	#focused: ChatSession | undefined;
	readonly #onDidChangeActive = new vscode.EventEmitter<ChatSession | undefined>();
	/** Fires when the active chat changes or its session/state changes. */
	readonly onDidChangeActive = this.#onDidChangeActive.event;

	constructor(
		readonly extensionUri: vscode.Uri,
		readonly log: vscode.OutputChannel,
		readonly commands: SessionCommands,
		checkpoints: CheckpointStore,
		/** Pending skill proposals every chat header shows. */
		readonly proposals: SkillProposalStore,
		commandOutputs: CommandOutputStore,
		/** The empty chat's prompts every chat shows. */
		readonly examplePrompts: ExamplePromptStore,
	) {
		this.pool = new AgentPool(log, checkpoints, commandOutputs);
		this.pool.onNeedsAttention(host => void this.#offerHost(host));
	}

	get active(): ChatSession | undefined {
		return this.#active ?? this.#sidebar;
	}

	/** Every open chat: the sidebar and the editor tabs. */
	get all(): ChatSession[] {
		return this.#sidebar ? [this.#sidebar, ...this.#panels] : [...this.#panels];
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.#sidebarView = view;
		const session = this.#createView({
			webview: view.webview,
			get visible() {
				return view.visible;
			},
			reveal: () => view.show(true),
		});
		this.#sidebar = session;
		view.onDidChangeVisibility(() => {
			if (view.visible) this.#setActive(session);
		});
		view.onDidDispose(() => {
			this.#sidebar = undefined;
			this.#sidebarView = undefined;
			this.#forget(session);
		});
		this.#setActive(session);
		void session.open(readConfig().resumeLastSession ? { kind: "continue" } : { kind: "new" });
	}

	/** Reveal the sidebar chat (creating it if VS Code has not resolved the view yet). */
	async focusSidebar(): Promise<ChatSession | undefined> {
		if (this.#sidebarView) this.#sidebarView.show(false);
		else await vscode.commands.executeCommand(`${ChatRegistry.viewId}.focus`);
		return this.#sidebar;
	}

	/** Open a chat in a new editor tab on `target`. */
	openPanel(target: SessionTarget): ChatSession {
		const panel = vscode.window.createWebviewPanel(
			"ompCustom.chatPanel",
			"MarIA Code",
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "maria-mark.png");
		const session = this.#createView({
			webview: panel.webview,
			get visible() {
				return panel.visible;
			},
			reveal: () => panel.reveal(),
		});
		this.#panels.add(session);
		session.onDidChange(() => {
			panel.title = session.title ? `MarIA Code: ${session.title}` : "MarIA Code";
		});
		panel.onDidChangeViewState(() => {
			if (panel.active) this.#setActive(session);
		});
		panel.onDidDispose(() => {
			this.#panels.delete(session);
			this.#forget(session);
		});
		this.#setActive(session);
		void session.open(target);
		return session;
	}

	/** The chat to act on, revealing the sidebar when there is none yet. */
	async ensureActive(): Promise<ChatSession | undefined> {
		return this.active ?? (await this.focusSidebar());
	}

	dispose(): void {
		this.#sidebar?.dispose();
		for (const panel of this.#panels) panel.dispose();
		this.pool.dispose();
		this.#onDidChangeActive.dispose();
	}

	#createView(surface: ChatSurface): ChatSession {
		const session = new ChatSession(
			surface,
			this.extensionUri,
			this.log,
			this.commands,
			this.pool,
			this.proposals,
			this.examplePrompts,
		);
		session.onDidChange(() => {
			if (session === this.active) this.#onDidChangeActive.fire(session);
		});
		session.onDidChangeFocus(focused => {
			if (focused) this.#focused = session;
			else if (this.#focused === session) this.#focused = undefined;
			// Ctrl+F goes to the chat's find bar while one has focus, not to the editor's (package.json keybinding).
			void vscode.commands.executeCommand("setContext", CHAT_FOCUSED_CONTEXT, this.#focused !== undefined);
		});
		return session;
	}

	/** "Find in Chat": the chat with keyboard focus, else the active one, opens its find bar. */
	openFind(): void {
		(this.#focused ?? this.active)?.openFind();
	}

	/** A session no chat shows waits for the user: offer to show it in the active chat. */
	async #offerHost(host: AgentHost): Promise<void> {
		const name = host.title ?? "A background session";
		const choice = await vscode.window.showInformationMessage(
			`MarIA Code: ${name} is waiting for you to review its plan.`,
			"Show",
		);
		if (choice !== "Show" || !host.process) return;
		const chat = await this.ensureActive();
		chat?.surface.reveal();
		chat?.showHost(host);
	}

	#forget(session: ChatSession): void {
		session.dispose();
		if (this.#active === session) this.#active = undefined;
		this.#onDidChangeActive.fire(this.active);
	}

	#setActive(session: ChatSession): void {
		if (this.#active === session) return;
		this.#active = session;
		this.#onDidChangeActive.fire(session);
	}
}
