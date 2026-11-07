/**
 * "See changes" on a file tool row of the chat: opens the file with that
 * call's changes marked (added green, changed amber, removed red). The marks
 * are only a view: they go away as soon as the file is edited or closed.
 * When the file changed since the call, the version right after the call
 * opens instead (read-only, from its snapshot).
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { git } from "../checkpoints/git";
import type { ChatSession } from "../chat/chat-session";
import type { CallFileChange } from "./call-changes";
import type { FileDiff } from "./hunks";

const SCHEME = "maria-change";
const STATUS_MS = 10_000;

interface Marks {
	added: vscode.DecorationOptions[];
	modified: vscode.DecorationOptions[];
	removed: vscode.DecorationOptions[];
	deletedFile: vscode.DecorationOptions[];
}

type MarkKind = keyof Marks;

const NO_MARKS: Marks = { added: [], modified: [], removed: [], deletedFile: [] };

export class ChangeViewer implements vscode.Disposable {
	readonly #types: Record<MarkKind, vscode.TextEditorDecorationType>;
	readonly #marks = new Map<string, Marks>();
	readonly #disposables: vscode.Disposable[] = [];

	constructor() {
		const line = { isWholeLine: true, overviewRulerLane: vscode.OverviewRulerLane.Left } as const;
		this.#types = {
			added: vscode.window.createTextEditorDecorationType({
				...line,
				backgroundColor: "rgba(43, 209, 37, 0.14)",
				borderColor: "#2bd125",
				borderStyle: "solid",
				borderWidth: "0 0 0 3px",
				overviewRulerColor: "#2bd125",
			}),
			modified: vscode.window.createTextEditorDecorationType({
				...line,
				backgroundColor: "rgba(230, 160, 30, 0.14)",
				borderColor: "#e6a01e",
				borderStyle: "solid",
				borderWidth: "0 0 0 3px",
				overviewRulerColor: "#e6a01e",
			}),
			removed: vscode.window.createTextEditorDecorationType({
				...line,
				borderColor: "#f14c4c",
				borderStyle: "solid",
				borderWidth: "2px 0 0 0",
				overviewRulerColor: "#f14c4c",
			}),
			deletedFile: vscode.window.createTextEditorDecorationType({
				...line,
				backgroundColor: "rgba(241, 76, 76, 0.12)",
				borderColor: "#f14c4c",
				borderStyle: "solid",
				borderWidth: "0 0 0 3px",
				overviewRulerColor: "#f14c4c",
			}),
		};
		this.#disposables.push(
			...Object.values(this.#types),
			vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
				provideTextDocumentContent: uri => snapshotContent(uri),
			}),
			vscode.window.onDidChangeVisibleTextEditors(editors => {
				for (const editor of editors) this.#apply(editor);
			}),
			vscode.workspace.onDidChangeTextDocument(event => {
				if (event.contentChanges.length === 0) return;
				if (!this.#marks.delete(event.document.uri.toString())) return;
				for (const editor of vscode.window.visibleTextEditors) {
					if (editor.document === event.document) this.#apply(editor);
				}
			}),
			vscode.workspace.onDidCloseTextDocument(document => this.#marks.delete(document.uri.toString())),
		);
	}

	/** Open the file tool call `toolCallId` of the chat's session edited (`file` as its row names it), its changes marked. */
	async show(session: ChatSession, toolCallId: string, file: string): Promise<void> {
		const host = session.host;
		if (!host) return;
		const result = await host.toolChanges(toolCallId, file);
		if (!result) {
			void vscode.window.showInformationMessage(
				"MarIA Code: no hay datos para mostrar los cambios de esta llamada. Solo se guardan en chats con espacio de trabajo, con ompCustom.fileCheckpoints activado, y para llamadas hechas con esta versión de la extensión o posteriores.",
			);
			return;
		}
		if (result.kind === "none") {
			void vscode.window.showInformationMessage(
				`MarIA Code: esta llamada no dejó cambios en ${path.basename(file)}.`,
			);
			return;
		}
		if (result.kind === "choose") {
			const picked = await vscode.window.showQuickPick(
				result.files.map(change => ({
					label: change.path,
					description: `+${change.diff.added} −${change.diff.removed}`,
					change,
				})),
				{ title: "Archivos que cambió esta llamada de MarIA Code" },
			);
			if (picked) await this.#open(picked.change);
			return;
		}
		await this.#open(result.change);
	}

	dispose(): void {
		for (const disposable of this.#disposables) disposable.dispose();
		this.#marks.clear();
	}

	async #open(change: CallFileChange): Promise<void> {
		const { root, path: rel, diff } = change;
		if (diff.status === "binary") {
			void vscode.window.showInformationMessage(`MarIA Code: ${rel} es binario; no se pueden marcar sus líneas.`);
			return;
		}
		let document: vscode.TextDocument;
		let marks: Marks;
		if (diff.status === "deleted") {
			document = await vscode.workspace.openTextDocument(contentUri(root, change.before, rel));
			marks = {
				...NO_MARKS,
				deletedFile: [
					{
						range: new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0),
						hoverMessage: "MarIA Code borró este archivo",
					},
				],
			};
			vscode.window.setStatusBarMessage(
				"MarIA Code: este archivo se borró; se muestra su versión anterior.",
				STATUS_MS,
			);
		} else {
			const absolute = path.join(root, rel);
			const dirty = vscode.workspace.textDocuments.some(doc => doc.uri.fsPath === absolute && doc.isDirty);
			const onDisk = !dirty && (await sameAsDisk(root, change.after, rel));
			if (!onDisk) {
				vscode.window.setStatusBarMessage(
					"MarIA Code: el archivo cambió después; se muestra cómo quedó tras este cambio.",
					STATUS_MS,
				);
			}
			document = await vscode.workspace.openTextDocument(
				onDisk ? vscode.Uri.file(absolute) : contentUri(root, change.after, rel),
			);
			marks = marksFor(diff, document);
		}
		if (change.scope === "turn") {
			vscode.window.setStatusBarMessage(
				"MarIA Code: se marcan los cambios de todo el turno en este archivo.",
				STATUS_MS,
			);
		}
		this.#marks.set(document.uri.toString(), marks);
		const editor = await vscode.window.showTextDocument(document, { preview: true });
		this.#apply(editor);
		const lines = Object.values(marks).flatMap((options: vscode.DecorationOptions[]) =>
			options.map(option => option.range.start.line),
		);
		if (lines.length === 0) return;
		const first = Math.min(...lines);
		editor.revealRange(new vscode.Range(first, 0, first, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		editor.selection = new vscode.Selection(first, 0, first, 0);
	}

	#apply(editor: vscode.TextEditor): void {
		const marks = this.#marks.get(editor.document.uri.toString()) ?? NO_MARKS;
		for (const kind of Object.keys(this.#types) as MarkKind[]) {
			editor.setDecorations(this.#types[kind], marks[kind]);
		}
	}
}

/** Marks for `diff`'s hunks on `document` (its after side). */
function marksFor(diff: FileDiff, document: vscode.TextDocument): Marks {
	const marks: Marks = { added: [], modified: [], removed: [], deletedFile: [] };
	const last = Math.max(document.lineCount - 1, 0);
	for (const hunk of diff.hunks) {
		if (hunk.newLines.length > 0) {
			const range = new vscode.Range(hunk.newStart - 1, 0, hunk.newStart - 2 + hunk.newLines.length, 0);
			if (hunk.oldLines.length === 0) {
				marks.added.push({ range, hoverMessage: "Añadido por MarIA Code" });
			} else {
				marks.modified.push({
					range,
					hoverMessage: new vscode.MarkdownString()
						.appendText("Antes de este cambio de MarIA Code:")
						.appendCodeblock(hunk.oldLines.join("\n"), document.languageId),
				});
			}
			continue;
		}
		const line = Math.min(hunk.newStart, last);
		const count = hunk.oldLines.length;
		marks.removed.push({
			range: new vscode.Range(line, 0, line, 0),
			renderOptions: {
				after: {
					contentText: `  −${count} ${count === 1 ? "línea eliminada" : "líneas eliminadas"}`,
					color: "#f14c4c",
					fontStyle: "italic",
				},
			},
			hoverMessage: new vscode.MarkdownString()
				.appendText("MarIA Code eliminó:")
				.appendCodeblock(hunk.oldLines.join("\n"), document.languageId),
		});
	}
	return marks;
}

/** A file as snapshot `tree` holds it; the path ends with the real relative path so tabs and languages follow it. */
function contentUri(root: string, tree: string, rel: string): vscode.Uri {
	return vscode.Uri.from({ scheme: SCHEME, path: `/${encodeURIComponent(root)}/${tree}/${rel}` });
}

async function snapshotContent(uri: vscode.Uri): Promise<string> {
	const [encodedRoot = "", tree = "", ...rel] = uri.path.slice(1).split("/");
	return git(decodeURIComponent(encodedRoot), ["cat-file", "blob", `${tree}:${rel.join("/")}`]).catch(() => "");
}

/** Whether the file on disk is still exactly as snapshot `tree` holds it. */
async function sameAsDisk(root: string, tree: string, rel: string): Promise<boolean> {
	try {
		const [snapshot, disk] = await Promise.all([
			git(root, ["rev-parse", `${tree}:${rel}`]),
			git(root, ["hash-object", "--", rel]),
		]);
		return snapshot.trim() === disk.trim();
	} catch {
		return false;
	}
}
