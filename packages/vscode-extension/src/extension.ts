import * as path from "node:path";
import * as vscode from "vscode";
import { CheckpointStore } from "./checkpoints/store";
import { errorMessage } from "./chat/agent-host";
import { CommandOutputStore } from "./chat/command-outputs";
import type { ChatSession } from "./chat/chat-session";
import { ChatRegistry } from "./chat/chat-views";
import { agentDir, readConfig, workspaceCwd } from "./config";
import { ChangeViewer } from "./editor-changes/change-viewer";
import { bindNoWorkspaceState } from "./no-workspace";
import { renameStoredSession } from "./sessions/rename";
import { guessSessionDir, sessionLabel, sessionPaths } from "./sessions/session-store";
import { SessionItem, SessionsTree, pickSession } from "./sessions/sessions-tree";
import { SettingsPanel, openConfigFile, runOmp } from "./settings/settings-panel";
import type { SkillProposalSummary } from "./protocol";
import { SkillProposalStore } from "./skills/proposals";
import { type HistoryEntry, SkillsTree, type SkillsNode } from "./skills/skills-tree";
import { initSounds } from "./sounds";

export function activate(context: vscode.ExtensionContext): void {
	initSounds(context.extensionUri);
	const log = vscode.window.createOutputChannel("MarIA Code");
	bindNoWorkspaceState(context.globalState);
	const checkpoints = new CheckpointStore(path.join(context.globalStorageUri.fsPath, "checkpoints"));
	const commandOutputs = new CommandOutputStore(path.join(context.globalStorageUri.fsPath, "command-outputs"));
	const proposals = new SkillProposalStore(log);
	context.subscriptions.push(proposals);
	const chats: ChatRegistry = new ChatRegistry(
		context.extensionUri,
		log,
		{
			openSettings: () => SettingsPanel.show(context.extensionUri),
			login: session => void login(session),
			attachFiles: session => void attachFiles(session),
			deleteSession: (sessionFile, label) => deleteSession(sessionFile, label),
			showToolChanges: (session, toolCallId, file) => changeViewer.show(session, toolCallId, file),
		},
		checkpoints,
		proposals,
		commandOutputs,
	);
	const changeViewer = new ChangeViewer();
	// Running and finished-unseen marks for every session with a process in this window.
	const tree = new SessionsTree(() => chats.pool.activities());
	const skillsTree = new SkillsTree(log, proposals);
	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBar.command = "ompCustom.focusChat";

	const updateActive = async (session: ChatSession | undefined) => {
		// The Sessions view lists the workspace's sessions: a chat without a workspace does not move it.
		const sessionFile = session?.host?.noWorkspace ? undefined : session?.state?.sessionFile;
		const dir = sessionFile
			? path.dirname(sessionFile)
			: await guessSessionDir(path.join(agentDir(), "sessions"), workspaceCwd());
		tree.setLocation(dir, sessionFile);
		renderStatusBar(statusBar, session);
	};
	void updateActive(undefined);

	/** The active chat, or an error message when none can be shown. */
	const activeChat = async (): Promise<ChatSession | undefined> => {
		const session = await chats.ensureActive();
		if (!session) void vscode.window.showErrorMessage("MarIA Code: open the MarIA Code chat first.");
		return session;
	};

	const showSessions = async () => {
		const session = await activeChat();
		if (!session) return;
		await tree.getChildren();
		const picked = await pickSession(tree.sessions, session.state?.sessionFile);
		if (picked) await session.switchSession(picked.path);
	};

	const attachFiles = async (session: ChatSession) => {
		const picked = await vscode.window.showOpenDialog({
			canSelectMany: true,
			defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
			openLabel: "Attach",
		});
		if (!picked?.length) return;
		session.insertText(`${picked.map(file => mention(vscode.workspace.asRelativePath(file, false))).join(" ")} `);
	};

	const login = async (session?: ChatSession) => {
		const chat = session ?? (await activeChat());
		const process = chat?.process;
		if (!chat || !process) return;
		const { providers } = await process.request("get_login_providers");
		const picked = await vscode.window.showQuickPick(
			providers
				.filter(provider => provider.available)
				.map(provider => ({
					label: provider.name,
					description: provider.authenticated ? "$(check) signed in" : undefined,
					provider,
				})),
			{ title: "MarIA Code: Log In", placeHolder: "Provider to sign in to" },
		);
		if (!picked) return;
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `MarIA Code: signing in to ${picked.provider.name}…`,
				cancellable: false,
			},
			() => process.request("login", { providerId: picked.provider.id }),
		);
		void vscode.window.showInformationMessage(`MarIA Code: signed in to ${picked.provider.name}.`);
		await chat.restart();
	};

	const logout = async () => {
		const chat = await activeChat();
		const process = chat?.process;
		if (!process) return;
		const { providers } = await process.request("get_login_providers");
		const provider = await vscode.window.showQuickPick(
			providers.filter(entry => entry.authenticated).map(entry => ({ label: entry.name, entry })),
			{ title: "MarIA Code: Log Out", placeHolder: "Provider to sign out of" },
		);
		if (!provider) return;
		const { accounts } = await process.request("get_logout_accounts", { providerId: provider.entry.id });
		const account =
			accounts.length === 1
				? { account: accounts[0]! }
				: await vscode.window.showQuickPick(
						accounts.map(account => ({
							label: account.label,
							description: account.active ? "in use" : undefined,
							detail: account.detail,
							account,
						})),
						{ title: `MarIA Code: Log Out of ${provider.label}` },
					);
		if (!account) return;
		const { remainingSource } = await process.request("logout", {
			providerId: provider.entry.id,
			credentialId: account.account.credentialId,
		});
		void vscode.window.showInformationMessage(
			remainingSource
				? `MarIA Code: signed out; ${provider.label} still authenticates via ${remainingSource}.`
				: `MarIA Code: signed out of ${provider.label}.`,
		);
	};

	/** Rename a session: the active one in place, any other through a short-lived omp process. */
	const renameSession = async (item?: SessionItem) => {
		const chat = chats.active;
		const target = item?.session.path ?? chat?.state?.sessionFile;
		if (!target) return;
		const current = item ? sessionLabel(item.session) : chat?.title;
		const name = await vscode.window.showInputBox({
			title: "MarIA Code: Rename Session",
			value: current,
			prompt: "New name",
		});
		if (!name?.trim()) return;
		// A session open in some process is renamed there: two writers would clobber its file.
		const host = chats.pool.find(target);
		if (host) await host.rename(name.trim());
		else await renameStoredSession(target, name.trim(), log);
		tree.refresh();
	};

	/** Delete a session after a modal confirmation; every chat showing it moves to a new session first. */
	const deleteSession = async (sessionFile: string, label: string): Promise<void> => {
		const choice = await vscode.window.showWarningMessage(
			`Delete the MarIA Code session "${label}"?`,
			{ modal: true, detail: "The session file and its artifacts move to the trash." },
			"Delete",
		);
		if (choice !== "Delete") return;
		for (const chat of chats.all) {
			if (chat.process && chat.state?.sessionFile === sessionFile) await chat.newSession(chat.host?.noWorkspace);
		}
		await chats.pool.stopSession(sessionFile);
		await checkpoints.remove(sessionFile);
		await commandOutputs.remove(sessionFile);
		for (const file of sessionPaths(sessionFile)) {
			await vscode.workspace.fs
				.delete(vscode.Uri.file(file), { recursive: true, useTrash: true })
				.then(undefined, (error: unknown) => {
					if (!(error instanceof vscode.FileSystemError && error.code === "FileNotFound")) throw error;
				});
		}
		tree.refresh();
	};

	const selectModel = async () => {
		const chat = await activeChat();
		if (!chat?.process) return;
		const models = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: "MarIA Code: loading models" },
			() => chat.availableModels(),
		);
		const current = chat.state?.model;
		const picked = await vscode.window.showQuickPick(
			models.map(model => ({
				label: `${model.provider === current?.provider && model.id === current?.id ? "$(check) " : ""}${model.name}`,
				description: `${model.provider}/${model.id}`,
				detail: model.contextWindow ? `${Math.round(model.contextWindow / 1000)}K context` : undefined,
				model,
			})),
			{ title: "MarIA Code: Select Model", matchOnDescription: true },
		);
		if (picked) await chat.setModel(picked.model.provider, picked.model.id);
	};

	const selectThinkingLevel = async () => {
		const chat = await activeChat();
		const process = chat?.process;
		if (!chat || !process) return;
		const { levels } = await process.request("get_available_thinking_levels");
		if (levels.length === 0) {
			void vscode.window.showInformationMessage("MarIA Code: the current model has no thinking levels.");
			return;
		}
		const level = await vscode.window.showQuickPick(
			levels.map(value => ({ label: `${value === chat.state?.thinkingLevel ? "$(check) " : ""}${value}`, value })),
			{ title: "MarIA Code: Thinking Level" },
		);
		if (level) await chat.setThinkingLevel(level.value);
	};

	const addSelectionToChat = async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;
		const chat = await chats.focusSidebar().then(sidebar => chats.active ?? sidebar);
		if (!chat) return;
		const relative = vscode.workspace.asRelativePath(editor.document.uri, false);
		const parts = editor.selections
			.filter(selection => !selection.isEmpty)
			.map(selection => {
				const start = selection.start.line + 1;
				const end = selection.end.line + (selection.end.character === 0 ? 0 : 1);
				const range = start === end ? `line ${start}` : `lines ${start}-${end}`;
				const fence = "```";
				return `\`${relative}\` (${range}):\n${fence}${editor.document.languageId}\n${editor.document.getText(selection)}\n${fence}\n`;
			});
		chat.insertText(parts.length ? parts.join("\n") : `${mention(relative)} `);
	};

	const addFileToChat = async (uri?: vscode.Uri, selected?: vscode.Uri[]) => {
		const targets = selected?.length ? selected : uri ? [uri] : [vscode.window.activeTextEditor?.document.uri];
		const files = targets.filter((target): target is vscode.Uri => target !== undefined);
		if (!files.length) return;
		const chat = await chats.focusSidebar().then(sidebar => chats.active ?? sidebar);
		chat?.insertText(`${files.map(file => mention(vscode.workspace.asRelativePath(file, false))).join(" ")} `);
	};

	const run =
		(action: (...args: never[]) => Promise<unknown> | unknown) =>
		async (...args: never[]) => {
			try {
				await action(...args);
			} catch (error) {
				log.appendLine(`[error] ${errorMessage(error)}`);
				void vscode.window.showErrorMessage(`MarIA Code: ${errorMessage(error)}`);
			}
		};

	context.subscriptions.push(
		log,
		tree,
		skillsTree,
		chats,
		changeViewer,
		statusBar,
		vscode.window.registerWebviewViewProvider(ChatRegistry.viewId, chats, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.window.createTreeView("ompCustom.sessions", { treeDataProvider: tree, showCollapseAll: false }),
		vscode.window.createTreeView("ompCustom.skills", { treeDataProvider: skillsTree }),
		chats.onDidChangeActive(session => void updateActive(session)),
		chats.pool.onDidChangeActivity(() => tree.refresh()),
		vscode.commands.registerCommand(
			"ompCustom.focusChat",
			run(() => chats.focusSidebar()),
		),
		vscode.commands.registerCommand(
			"ompCustom.openChatInEditor",
			run(() => chats.openPanel({ kind: "new" })),
		),
		vscode.commands.registerCommand(
			"ompCustom.newSession",
			run(async () => (await activeChat())?.newSession()),
		),
		vscode.commands.registerCommand("ompCustom.showSessions", run(showSessions)),
		vscode.commands.registerCommand(
			"ompCustom.refreshSessions",
			run(() => tree.refresh()),
		),
		vscode.commands.registerCommand(
			"ompCustom.openSession",
			run(async (item: SessionItem) => {
				const chat = await activeChat();
				chat?.surface.reveal();
				await chat?.switchSession(item.session.path);
			}),
		),
		vscode.commands.registerCommand("ompCustom.renameSession", run(renameSession)),
		vscode.commands.registerCommand(
			"ompCustom.deleteSession",
			run((item?: SessionItem) => item && deleteSession(item.session.path, sessionLabel(item.session))),
		),
		vscode.commands.registerCommand(
			"ompCustom.revealSessionFile",
			run((item: SessionItem) =>
				vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(item.session.path)),
			),
		),
		vscode.commands.registerCommand("ompCustom.selectModel", run(selectModel)),
		vscode.commands.registerCommand("ompCustom.selectThinkingLevel", run(selectThinkingLevel)),
		vscode.commands.registerCommand("ompCustom.addSelectionToChat", run(addSelectionToChat)),
		vscode.commands.registerCommand("ompCustom.addFileToChat", run(addFileToChat)),
		vscode.commands.registerCommand(
			"ompCustom.toggleVoiceInput",
			run(async () => {
				const chat = chats.active ?? (await chats.focusSidebar());
				chat?.toggleDictation();
			}),
		),
		vscode.commands.registerCommand(
			"ompCustom.findInChat",
			run(() => chats.openFind()),
		),
		vscode.commands.registerCommand(
			"ompCustom.openSettings",
			run(() => SettingsPanel.show(context.extensionUri)),
		),
		vscode.commands.registerCommand("ompCustom.openConfigFile", run(openConfigFile)),
		vscode.commands.registerCommand(
			"ompCustom.login",
			run(() => login()),
		),
		vscode.commands.registerCommand("ompCustom.logout", run(logout)),
		vscode.commands.registerCommand(
			"ompCustom.compact",
			run(async () => (await activeChat())?.compact()),
		),
		vscode.commands.registerCommand(
			"ompCustom.abort",
			run(() => chats.active?.abort()),
		),
		vscode.commands.registerCommand(
			"ompCustom.restartAgent",
			run(async () => (await activeChat())?.restart()),
		),
		vscode.commands.registerCommand(
			"ompCustom.openInTerminal",
			run(() => {
				const { executable, args, env } = readConfig();
				const terminal = vscode.window.createTerminal({
					name: "MarIA Code",
					shellPath: executable,
					shellArgs: [...args],
					cwd: workspaceCwd(),
					env,
					iconPath: vscode.Uri.joinPath(context.extensionUri, "media", "maria-mark.png"),
				});
				terminal.show();
			}),
		),
		vscode.commands.registerCommand(
			"ompCustom.refreshSkills",
			run(() => skillsTree.refresh()),
		),
		vscode.commands.registerCommand(
			"ompCustom.showSkillChange",
			run(async (entry: HistoryEntry) =>
				vscode.window.showTextDocument(
					await vscode.workspace.openTextDocument({ content: entry.diff, language: "diff" }),
				),
			),
		),
		vscode.commands.registerCommand(
			"ompCustom.revertSkillChange",
			run(async (node: SkillsNode) => {
				if (node.kind !== "entry") return;
				await runOmp(["skill", "revert", node.entry.id]);
				void vscode.window.showInformationMessage(`Reverted ${node.entry.skill}`);
				await skillsTree.refresh();
			}),
		),
		vscode.commands.registerCommand(
			"ompCustom.approveSkillProposal",
			run(async (node: SkillsNode) => {
				if (node.kind !== "proposal") return;
				await proposals.approve(node.proposal.id);
				void vscode.window.showInformationMessage(`Applied the proposal to ${node.proposal.skill}`);
			}),
		),
		vscode.commands.registerCommand(
			"ompCustom.rejectSkillProposal",
			run(async (node: SkillsNode) => {
				if (node.kind !== "proposal") return;
				await proposals.reject(node.proposal.id);
			}),
		),
		vscode.commands.registerCommand(
			"ompCustom.showSkillProposal",
			run((proposal: SkillProposalSummary) => proposals.openDiff(proposal.id)),
		),
		vscode.commands.registerCommand("ompCustom.showLog", () => log.show()),
	);
}

export function deactivate(): void {}

/** An omp `@file` mention; paths with spaces are quoted. */
function mention(relative: string): string {
	return /\s/.test(relative) ? `@"${relative}"` : `@${relative}`;
}

function renderStatusBar(item: vscode.StatusBarItem, session: ChatSession | undefined): void {
	if (!session) {
		item.hide();
		return;
	}
	const state = session.state;
	const busy = session.busy || state?.isCompacting;
	const status = session.status;
	const icon =
		status.phase === "stopped" ? "$(error)" : busy || status.phase === "starting" ? "$(loading~spin)" : "$(sparkle)";
	item.text = `${icon} MarIA Code${state?.model ? ` · ${state.model.id}` : ""}`;
	const lines = [
		session.title ? `**${session.title}**` : "New session",
		state?.contextUsage ? `Context: ${Math.round(state.contextUsage.percent)}%` : undefined,
		status.phase === "stopped" ? `Stopped: ${status.message}` : undefined,
		...session.statusTexts.values(),
	].filter(Boolean);
	item.tooltip = new vscode.MarkdownString(lines.join("\n\n"));
	item.show();
}
