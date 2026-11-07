/**
 * omp's pending skill proposals (`omp skill proposals --json`), shared by every
 * chat header and the Skills view. omp writes one JSON file per proposal under
 * `<agentDir>/skill-proposals`, from any session or the CLI, so the store
 * follows that folder; deciding goes through the omp CLI.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { errorMessage } from "../chat/agent-host";
import { agentDir } from "../config";
import type { SkillProposalSummary } from "../protocol";
import { runOmp } from "../settings/settings-panel";

const SCHEME = "omp-skill-proposal";

/** The proposal file fields the diff view needs (omp's `SkillProposal`). */
interface StoredProposal {
	skill: string;
	summary: string;
	/** `null`: the file does not exist on that side (created or deleted by the proposal). */
	files: Array<{ path: string; relativePath: string; before: string | null; after: string | null }>;
}

export class SkillProposalStore implements vscode.Disposable {
	readonly #onDidChange = new vscode.EventEmitter<void>();
	/** Fires when the pending proposals change. */
	readonly onDidChange = this.#onDidChange.event;
	readonly #disposables: vscode.Disposable[] = [];
	readonly #stored = new Map<string, StoredProposal>();
	#proposals: SkillProposalSummary[] = [];
	#debounce: NodeJS.Timeout | undefined;

	constructor(private readonly log: vscode.OutputChannel) {
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(path.join(agentDir(), "skill-proposals")), "**/*.json"),
		);
		const schedule = () => {
			clearTimeout(this.#debounce);
			this.#debounce = setTimeout(() => void this.refresh(), 300);
		};
		watcher.onDidCreate(schedule);
		watcher.onDidChange(schedule);
		watcher.onDidDelete(schedule);
		this.#disposables.push(
			watcher,
			vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
				provideTextDocumentContent: uri => this.#content(uri),
			}),
		);
		void this.refresh();
	}

	get proposals(): SkillProposalSummary[] {
		return this.#proposals;
	}

	/** Re-read the pending proposals from omp. */
	async refresh(): Promise<void> {
		this.#stored.clear();
		try {
			const parsed: unknown = JSON.parse(await runOmp(["skill", "proposals", "--json"]));
			const list = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "proposals") : undefined;
			// omp's own `--json` contract; entries are not validated field by field.
			this.#proposals = Array.isArray(list) ? (list as SkillProposalSummary[]) : [];
		} catch (error) {
			this.#proposals = [];
			this.log.appendLine(`[error] Could not list skill proposals: ${errorMessage(error)}`);
		}
		this.#onDidChange.fire();
	}

	/** Apply proposal `id`; rejects with omp's message (for example when the skill changed since). */
	async approve(id: string): Promise<void> {
		await runOmp(["skill", "approve", id]);
		await this.refresh();
	}

	/** Ask for an optional reason and decline proposal `id`; false when the user cancelled. */
	async reject(id: string): Promise<boolean> {
		const reason = await vscode.window.showInputBox({
			title: "Reject skill proposal",
			prompt: "Why? (optional — MarIA Code will not propose it again without new evidence)",
			ignoreFocusOut: true,
		});
		if (reason === undefined) return false;
		await runOmp(["skill", "reject", id, ...(reason.trim() ? [reason.trim()] : [])]);
		await this.refresh();
		return true;
	}

	/** Show the changes of proposal `id`: one diff per file, in one multi-file editor. */
	async openDiff(id: string): Promise<void> {
		const proposal = await this.#load(id);
		const sideUri = (side: "before" | "after", relativePath: string) =>
			vscode.Uri.from({
				scheme: SCHEME,
				path: `/${encodeURIComponent(id)}/${side}/${encodeURIComponent(relativePath)}`,
			});
		const title = `${proposal.skill}: ${proposal.summary}`;
		try {
			await vscode.commands.executeCommand(
				"vscode.changes",
				title,
				proposal.files.map(file => [
					vscode.Uri.file(file.path),
					sideUri("before", file.relativePath),
					sideUri("after", file.relativePath),
				]),
			);
		} catch {
			for (const file of proposal.files) {
				await vscode.commands.executeCommand(
					"vscode.diff",
					sideUri("before", file.relativePath),
					sideUri("after", file.relativePath),
					`${proposal.skill}: ${file.relativePath}`,
				);
			}
		}
	}

	dispose(): void {
		clearTimeout(this.#debounce);
		for (const disposable of this.#disposables) disposable.dispose();
		this.#onDidChange.dispose();
	}

	async #load(id: string): Promise<StoredProposal> {
		const cached = this.#stored.get(id);
		if (cached) return cached;
		const stored = JSON.parse(
			await fs.readFile(path.join(agentDir(), "skill-proposals", `${id}.json`), "utf8"),
		) as StoredProposal;
		this.#stored.set(id, stored);
		return stored;
	}

	async #content(uri: vscode.Uri): Promise<string> {
		const [, rawId, side, rawPath] = uri.path.split("/");
		if (!rawId || !rawPath) return "";
		const proposal = await this.#load(decodeURIComponent(rawId)).catch(() => undefined);
		const file = proposal?.files.find(entry => entry.relativePath === decodeURIComponent(rawPath));
		if (!file) return "";
		return (side === "before" ? file.before : file.after) ?? "";
	}
}
