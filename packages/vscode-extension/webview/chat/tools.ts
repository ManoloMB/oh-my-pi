/**
 * Tool calls as one-line activity rows ("Ran `ls`", "Edited src/a.ts +3 −1"),
 * keyed by `toolCallId`. Clicking a row expands a card with the arguments and
 * the (live or final) result.
 */
import type { ImageContent } from "../../src/protocol";
import { button, h } from "../dom";
import { type IconName, icon } from "../icons";
import { setTooltip } from "../tooltip";
import {
	type ActivitySubject,
	type DiffStats,
	type ToolFamily,
	type ToolStatus,
	activityLabel,
	diffStats,
	str,
} from "./activity";
import { fileLink, thumbnail } from "./content";

const MAX_LINES = 200;
const FAMILY_ICONS: Record<ToolFamily, IconName> = {
	run: "bash",
	code: "python",
	read: "file",
	edit: "pencil",
	search: "search",
	web: "globe",
	task: "bot",
	plan: "plan",
	other: "wrench",
};

/** File tools whose finished rows offer "See changes". */
const CHANGE_TOOLS: Record<string, true> = { edit: true, write: true, notebook: true, ast_edit: true };

/** File subjects open in the editor; web URLs open in the browser (the transcript handles `data-href`). */
function subjectContent(subject: ActivitySubject): Node | string {
	if (subject.path) return fileLink(subject.path, subject.text);
	if (subject.url) {
		return h(
			"a",
			{ className: "web-link", dataset: { href: subject.url, tooltip: `Open ${subject.url}` }, tabIndex: 0 },
			subject.text,
		);
	}
	return subject.text;
}

/** Text, images, and diff extracted from a tool result (`{content, details}`, a string, or anything else). */
interface ResultParts {
	text: string;
	images: ImageContent[];
	diff?: string;
}

export function toolResultParts(result: unknown): ResultParts {
	if (result === undefined || result === null) return { text: "", images: [] };
	if (typeof result === "string") return { text: result, images: [] };
	if (typeof result !== "object") return { text: String(result), images: [] };
	const record = result as { content?: unknown; details?: unknown };
	if (!Array.isArray(record.content)) return { text: JSON.stringify(result, null, 2), images: [] };
	const texts: string[] = [];
	const images: ImageContent[] = [];
	for (const block of record.content as Array<{ type?: string; text?: unknown }>) {
		if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
		else if (block?.type === "image") images.push(block as unknown as ImageContent);
	}
	const details = record.details as { diff?: unknown } | undefined;
	const diff = details && typeof details === "object" ? str(details.diff) : undefined;
	return { text: texts.join("\n"), images, diff };
}

/** `<pre>` showing at most `MAX_LINES` lines, with a button revealing the rest. */
export function truncatedPre(text: string, className: string, lineClass?: (line: string) => string | undefined) {
	const pre = h("pre", { className: className });
	const lines = text.replace(/\n+$/, "").split("\n");
	const fill = (count: number) => {
		pre.replaceChildren();
		const shown = lines.slice(0, count);
		if (!lineClass) {
			pre.textContent = shown.join("\n");
			return;
		}
		for (const line of shown) pre.append(h("span", { className: lineClass(line) }, `${line}\n`));
	};
	fill(MAX_LINES);
	if (lines.length <= MAX_LINES) return pre;
	const more = button(`Show ${lines.length - MAX_LINES} more lines`, "link-button show-more", () => {
		fill(lines.length);
		more.remove();
	});
	return h("div", null, pre, more);
}

export function diffLineClass(line: string): string | undefined {
	if (line.startsWith("+")) return "diff-add";
	if (line.startsWith("-")) return "diff-del";
	if (line.startsWith("@@")) return "diff-hunk";
	return undefined;
}

export class ToolCard {
	readonly element: HTMLDetailsElement;
	#row = h("summary", { className: "activity-row" });
	#args = h("div", { className: "activity-args" });
	#result = h("div", { className: "activity-result" });
	#argsKey = "";
	#resultKey = "";
	#name = "";
	#callArgs: Record<string, unknown> = {};
	#purpose: string | undefined;
	#diff: DiffStats | undefined;

	constructor(
		private readonly label?: string,
		/** Set for the agent's own calls: their finished file edits offer "See changes". */
		private readonly toolCallId?: string,
	) {
		this.element = h(
			"details",
			{ className: "activity" },
			this.#row,
			h("div", { className: "activity-body" }, this.#args, this.#result),
		);
		this.setStatus("pending");
	}

	setCall(name: string, args: Record<string, unknown>, intent?: string): void {
		const key = `${name}\u0000${JSON.stringify(args)}\u0000${intent ?? ""}`;
		if (key === this.#argsKey) return;
		this.#argsKey = key;
		this.#name = name;
		this.#callArgs = args;
		// omp's harness-internal `i` argument is the model's one-line purpose for the call.
		this.#purpose = intent ?? str(args.i);
		const command = str(args.command) ?? str(args.cmd);
		const input = str(args.input);
		// `write` bodies (plan drafts, new files) read better as text than as an escaped JSON string.
		const content = str(args.content);
		const shown: Record<string, true> = { command: true, cmd: true, i: true, input: true, content: true };
		const rest = Object.fromEntries(Object.entries(args).filter(([k]) => !shown[k]));
		const children: Node[] = [];
		if (this.#purpose) children.push(h("div", { className: "activity-intent" }, this.#purpose));
		if (command) children.push(truncatedPre(`$ ${command}`, "activity-pre"));
		if (input) children.push(truncatedPre(input, "activity-pre"));
		if (content) children.push(truncatedPre(content, "activity-pre"));
		if (Object.keys(rest).length > 0) {
			children.push(truncatedPre(JSON.stringify(rest, null, 2), "activity-pre muted"));
		}
		this.#args.replaceChildren(...children);
		this.#renderRow();
	}

	setStatus(status: ToolStatus): void {
		if (this.element.dataset.status === status) return;
		this.element.dataset.status = status;
		this.#renderRow();
	}

	get status(): ToolStatus {
		return this.element.dataset.status as ToolStatus;
	}

	/** Show a partial or final result; the status is left to the caller. */
	setResult(result: unknown): void {
		const parts = toolResultParts(result);
		const key = `${parts.text}\u0000${parts.diff ?? ""}\u0000${parts.images.length}`;
		if (key === this.#resultKey) return;
		this.#resultKey = key;
		this.#diff = diffStats(parts.diff);
		const children: Node[] = [];
		if (parts.diff) children.push(truncatedPre(parts.diff, "activity-pre diff", diffLineClass));
		if (parts.text) children.push(truncatedPre(parts.text, "activity-pre"));
		for (const image of parts.images) children.push(thumbnail(image));
		this.#result.replaceChildren(...children);
		this.#renderRow();
	}

	#renderRow(): void {
		const status = this.status;
		const { verb, subject, code, family, detail } = activityLabel(
			this.#name || "tool",
			this.#callArgs,
			status,
			this.#purpose,
		);
		const running = status === "pending" || status === "running";
		const children: Node[] = [
			h("span", { className: "activity-icon" }, icon(FAMILY_ICONS[family])),
			h("span", { className: `activity-verb${running ? " shimmer" : ""}` }, verb),
		];
		if (subject) {
			children.push(
				h(
					"span",
					{ className: `activity-subject${code ? " code" : ""}`, dataset: { tooltip: subject.text } },
					subjectContent(subject),
				),
			);
		}
		if (this.label) children.push(h("span", { className: "activity-label" }, this.label));
		if (this.#diff) {
			children.push(
				h(
					"span",
					{ className: "activity-diff" },
					h("span", { className: "diff-added" }, `+${this.#diff.added}`),
					h("span", { className: "diff-removed" }, `−${this.#diff.removed}`),
				),
			);
		}
		if (status === "error") children.push(h("span", { className: "activity-state error" }, "Failed"));
		else if (status === "interrupted") children.push(h("span", { className: "activity-state" }, "Stopped"));
		if (this.toolCallId && status === "done" && CHANGE_TOOLS[(this.#name || "").toLowerCase()] && subject?.path) {
			const changes = h(
				"button",
				{
					type: "button",
					className: "activity-changes",
					dataset: { toolChanges: this.toolCallId, path: subject.path },
				},
				icon("fileDiff"),
				"See changes",
			);
			setTooltip(changes, "Open the file in the editor with this call's changes highlighted");
			children.push(changes);
		}
		children.push(h("span", { className: "activity-chevron" }, icon("chevronRight")));
		const line = h("div", { className: "activity-line" }, ...children);
		// Run rows titled by their intent show the command beneath, indented under the name.
		const beneath = detail
			? h(
					"div",
					{ className: "activity-detail", dataset: { tooltip: detail } },
					h("span", { className: "activity-branch", ariaHidden: "true" }, "└"),
					h("span", { className: "activity-detail-text" }, detail),
				)
			: null;
		this.#row.replaceChildren(line, ...(beneath ? [beneath] : []));
		// The purpose already titles a run row; elsewhere it is the row's tooltip.
		setTooltip(this.#row, detail ? undefined : this.#purpose);
	}
}
