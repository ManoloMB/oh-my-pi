/**
 * Popup over the chat with one subagent's model requests, oldest first: when
 * each was answered, how long it took, its tokens and cost, the first line of
 * its answer and its tool calls. The request whose tools are still running is
 * highlighted; while the model is answering the next one, a last row says so.
 * Opening it asks the host to follow the subagent's transcript
 * (`watchSubagent`); updates arrive as `subagentRequests`.
 */
import type { ChatRequest, ChatUpdate, SubagentRequestView, SubagentToolView, SubagentView } from "../../src/protocol";
import { h, iconButton } from "../dom";
import { setTooltip } from "../tooltip";
import { formatCost, formatTokens } from "./context-meter";
import { elapsedMs, formatDuration, isActive, STATUS_LABELS } from "./subagent-format";

type Post = (request: ChatRequest) => void;
type RequestsUpdate = Extract<ChatUpdate, { type: "subagentRequests" }>;

const TOOL_STATUS_LABELS: Record<SubagentToolView["status"], string> = {
	running: "Running",
	done: "Done",
	error: "Failed",
	interrupted: "Not finished: the agent ended first",
};

/** Within this distance of the bottom, the list keeps following new requests. */
const FOLLOW_SLACK_PX = 24;

export class SubagentRequestsDialog {
	readonly element: HTMLElement;
	#dot = h("span", { className: "subagent-dot" });
	#name = h("span", { className: "subagent-requests-name" });
	#meta = h("span", { className: "subagent-requests-meta" });
	#task = h("div", { className: "subagent-requests-task" });
	#list = h("div", { className: "subagent-requests-list" });
	#footer = h("div", { className: "subagent-requests-footer" });
	#closeButton: HTMLButtonElement;
	#row: SubagentView | undefined;
	#update: RequestsUpdate | undefined;
	#restore: Element | null = null;
	#ticker: number | undefined;

	constructor(private readonly post: Post) {
		this.#closeButton = iconButton("close", "Close (Esc)", () => this.close());
		const dialog = h(
			"div",
			{ className: "subagent-requests", role: "dialog", ariaModal: "true", ariaLabel: "Subagent requests" },
			h("div", { className: "subagent-requests-header" }, this.#dot, this.#name, this.#meta, this.#closeButton),
			this.#task,
			this.#list,
			this.#footer,
		);
		this.element = h("div", { className: "subagent-requests-overlay", hidden: true }, dialog);
		this.element.addEventListener("mousedown", event => {
			if (event.target === this.element) this.close();
		});
		this.element.addEventListener("keydown", event => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			this.close();
		});
		document.body.append(this.element);
	}

	open(row: SubagentView): void {
		this.#row = row;
		this.#update = undefined;
		this.#restore = document.activeElement;
		this.element.hidden = false;
		this.#renderHeader();
		this.#renderList();
		this.#closeButton.focus();
		this.#ticker ??= window.setInterval(() => this.#renderHeader(), 1000);
		this.post({ type: "watchSubagent", id: row.id });
	}

	close(): void {
		if (this.element.hidden) return;
		this.element.hidden = true;
		window.clearInterval(this.#ticker);
		this.#ticker = undefined;
		this.#row = undefined;
		this.#update = undefined;
		this.post({ type: "watchSubagent", id: null });
		if (this.#restore instanceof HTMLElement && this.#restore.isConnected) this.#restore.focus();
	}

	/** The panel's latest rows: refresh the header and the waiting row; close once the agent left the list. */
	setSubagents(rows: SubagentView[]): void {
		if (this.element.hidden) return;
		const row = rows.find(candidate => candidate.id === this.#row?.id);
		if (!row) {
			this.close();
			return;
		}
		this.#row = row;
		this.#renderHeader();
		if (this.#update) this.#renderList();
	}

	setRequests(update: RequestsUpdate): void {
		if (this.element.hidden || update.id !== this.#row?.id) return;
		const first = this.#update === undefined;
		this.#update = update;
		this.#renderList(first);
	}

	#renderHeader(): void {
		const row = this.#row;
		if (!row) return;
		this.#dot.className = `subagent-dot ${row.status}`;
		this.#name.textContent = row.id;
		this.#meta.textContent = [row.agent, STATUS_LABELS[row.status], formatDuration(elapsedMs(row, Date.now()))].join(
			" · ",
		);
		const task = row.description ?? row.assignment?.split("\n").find(line => line.trim()) ?? "";
		this.#task.textContent = task;
		this.#task.hidden = !task;
		setTooltip(this.#task, row.assignment);
	}

	/** Rebuild the rows in place, keeping the scroll position or, near the bottom (or on first data), following the end. */
	#renderList(scrollToEnd = false): void {
		const list = this.#list;
		const following = scrollToEnd || list.scrollHeight - list.scrollTop - list.clientHeight <= FOLLOW_SLACK_PX;
		const scrollTop = list.scrollTop;
		list.replaceChildren(...this.#rows());
		list.scrollTop = following ? list.scrollHeight : scrollTop;

		const update = this.#update;
		const tools = update?.requests.reduce((sum, request) => sum + request.tools.length, 0) ?? 0;
		this.#footer.textContent = update
			? `${update.requests.length} request${update.requests.length === 1 ? "" : "s"} · ${tools} tool call${tools === 1 ? "" : "s"}`
			: "";
	}

	#rows(): HTMLElement[] {
		const update = this.#update;
		if (!update) return [h("div", { className: "subagent-requests-empty" }, "Loading requests…")];
		if (update.error) {
			return [
				h(
					"div",
					{ className: "subagent-requests-empty" },
					`Could not read this subagent's requests: ${update.error}`,
				),
			];
		}
		const rows = update.requests.map(request => this.#request(request));
		if (update.waiting && this.#row && isActive(this.#row)) rows.push(this.#waiting(update.requests.length + 1));
		if (rows.length === 0) rows.push(h("div", { className: "subagent-requests-empty" }, "No requests yet."));
		return rows;
	}

	#request(request: SubagentRequestView): HTMLElement {
		const stats = [
			new Date(request.at).toLocaleTimeString(),
			request.durationMs !== undefined && formatDuration(request.durationMs),
			`${formatTokens(request.tokens)} tok`,
			formatCost(request.cost),
		].filter(Boolean);
		const header = h(
			"div",
			{ className: "subagent-request-header" },
			h("span", { className: "subagent-request-index" }, `#${request.index}`),
			h("span", { className: "subagent-request-stats" }, stats.join(" · ")),
			request.current && h("span", { className: "subagent-request-badge" }, "In progress"),
		);
		return h(
			"div",
			{ className: `subagent-request${request.current ? " current" : ""}` },
			header,
			request.text && h("div", { className: "subagent-request-text" }, request.text),
			request.error && h("div", { className: "subagent-request-error" }, request.error),
			request.tools.length > 0 &&
				h("div", { className: "subagent-request-tools" }, ...request.tools.map(tool => this.#tool(tool))),
		);
	}

	#tool(tool: SubagentToolView): HTMLElement {
		const element = h(
			"div",
			{ className: `subagent-tool ${tool.status}` },
			h("span", { className: `subagent-dot ${tool.status}` }),
			h("span", { className: "subagent-tool-name" }, tool.name),
			tool.label && h("span", { className: "subagent-tool-label" }, tool.label),
		);
		setTooltip(
			element,
			tool.label ? `${TOOL_STATUS_LABELS[tool.status]}: ${tool.label}` : TOOL_STATUS_LABELS[tool.status],
		);
		return element;
	}

	/** The request the model is answering now: not in the transcript until its answer is complete. */
	#waiting(index: number): HTMLElement {
		const activity = this.#row?.activity;
		return h(
			"div",
			{ className: "subagent-request current" },
			h(
				"div",
				{ className: "subagent-request-header" },
				h("span", { className: "subagent-request-index" }, `#${index}`),
				h("span", { className: "subagent-request-stats" }, "Waiting for the model's answer…"),
				h("span", { className: "subagent-request-badge" }, "In progress"),
			),
			activity && h("div", { className: "subagent-request-text" }, activity),
		);
	}
}
