import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { SoundMode } from "./sounds";
import type { OmpCommand } from "./rpc/omp-process";
import { systemCaEnv } from "./system-ca";

/** The `ompCustom.*` settings, read fresh on every use so edits apply to the next process. */
export function readConfig() {
	const config = vscode.workspace.getConfiguration("ompCustom");
	return {
		executable: config.get<string>("executable", "omp").trim() || "omp",
		args: config.get<string[]>("args", []),
		extraArgs: config.get<string[]>("extraArgs", []),
		env: config.get<Record<string, string>>("env", {}),
		resumeLastSession: config.get<boolean>("resumeLastSession", true),
		sendWhileBusy: config.get<"steer" | "followUp">("sendWhileBusy", "steer"),
		fileCheckpoints: config.get<boolean>("fileCheckpoints", true),
		completionSound: config.get<SoundMode>("completionSound", "always"),
		/** Spoken alert while omp waits for an `ask` answer or a plan approval (see sounds.ts). */
		askAlertSound: config.get<SoundMode>("askAlertSound", "always"),
		/** Spoken language for voice input as an ISO 639-1 code; `""` lets the speech model detect it. */
		voiceLanguage: voiceLanguage(config.get<string>("voiceLanguage", "auto")),
		/** Folder chats without a workspace run in (see no-workspace.ts); may start with `~`. */
		noWorkspaceFolder: config.get<string>("noWorkspaceFolder", "~/omp-sin-workspace").trim() || "~/omp-sin-workspace",
	};
}

function voiceLanguage(value: string): string {
	const code = value.trim().toLowerCase();
	return code === "auto" ? "" : code;
}

/** The workspace folder omp works in: the active editor's folder, else the first one, else home. */
export function workspaceCwd(): string {
	const active = vscode.window.activeTextEditor?.document.uri;
	const folder =
		(active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0] ?? undefined;
	return folder?.uri.fsPath ?? os.homedir();
}

/** Every workspace folder, or the folder omp works in when none is open. */
export function workspaceRoots(): string[] {
	const folders = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
	return folders.length > 0 ? folders : [workspaceCwd()];
}

/** `dir` as shown to the user: under the home folder it starts with `~`. */
export function displayPath(dir: string): string {
	const home = os.homedir();
	return dir === home || dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir;
}

export async function ompCommand(cwd: string): Promise<OmpCommand> {
	const { executable, args, env } = readConfig();
	// Keep session titles (RPC skips them by default) so the sessions list reads well. The OS store's
	// certificates let omp reach HTTPS services through a network that re-signs TLS (see system-ca.ts).
	return { executable, args, env: { PI_RPC_AUTO_TITLE: "1", ...(await systemCaEnv(env)), ...env }, cwd };
}

/** omp's agent directory (`PI_CODING_AGENT_DIR`, default `~/.omp/agent`), honoring `ompCustom.env`. */
export function agentDir(): string {
	const configured = readConfig().env.PI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR;
	return configured ? path.resolve(configured) : path.join(os.homedir(), ".omp", "agent");
}
