/**
 * Delegate mode button with its subagent panel. Without subagents to show the
 * button toggles delegate mode; once the current task has subagents it opens a
 * popover listing each one (status, task, current step, run time, usage), the
 * delegate mode switch, and "Hurry up", which asks every running agent to wrap
 * up. Clicking a subagent opens the popup with its requests.
 */
import type { ChatRequest, ChatUpdate, SubagentView } from "../../src/protocol";
import { h } from "../dom";
import { icon } from "../icons";
import { setTooltip } from "../tooltip";
import { formatCost, formatTokens } from "./context-meter";
import { elapsedMs, formatDuration, isActive, STATUS_LABELS } from "./subagent-format";
import { SubagentRequestsDialog } from "./subagent-requests";

type Post = (request: ChatRequest) => void;

export class SubagentPanel {
	readonly element: HTMLElement;
	#trigger: HTMLButtonElement;
	#badge = h("span", { className: "subagent-badge", hidden: true });
	#popover = h("div", { className: "subagent-popover", role: "dialog", ariaLabel: "Subagents", hidden: true });
	#summary = h("span", { className: "subagent-summary" });
	#modeLabel = h("span");
	#modeButton = h("button", { type: "button", className: "subagent-mode-button" });
	#list = h("div", { className: "subagent-list" });
	#hurry = h("button", { type: "button", className: "subagent-hurry" }, icon("zap"), h("span", null, "Hurry up"));
	#rows: SubagentView[] = [];
	#available = false;
	#modeOn = false;
	#ticker: number | undefined;
	#requests: SubagentRequestsDialog;
	/** Card under the last pointer press: cards are rebuilt every second, so a click may end on a new node. */
	#pressedId: string | undefined;

	constructor(
		private readonly post: Post,
		private readonly onToggleMode: () => void,
	) {
		this.#trigger = h(
			"button",
			{ type: "button", className: "icon-button delegate-toggle", ariaHasPopup: "dialog" },
			icon("bot"),
			this.#badge,
		);
		this.#trigger.addEventListener("click", () => {
			if (this.#rows.length > 0) this.#popover.hidden ? this.#open() : this.#close();
			else this.onToggleMode();
		});
		this.#modeButton.addEventListener("click", () => this.onToggleMode());
		this.#requests = new SubagentRequestsDialog(post);
		this.#list.addEventListener("pointerdown", event => {
			this.#pressedId = event.button === 0 ? this.#cardId(event.target) : undefined;
		});
		this.#list.addEventListener("pointerup", event => {
			const id = this.#cardId(event.target);
			if (id !== undefined && id === this.#pressedId) this.#openRequests(id);
			this.#pressedId = undefined;
		});
		this.#list.addEventListener("keydown", event => {
			if (event.key !== "Enter" && event.key !== " ") return;
			const id = this.#cardId(event.target);
			if (id === undefined) return;
			event.preventDefault();
			this.#openRequests(id);
		});
		this.#hurry.addEventListener("click", () => {
			this.#hurry.disabled = true;
			this.post({ type: "hurrySubagents" });
		});
		// Built once: the ticker re-renders every second, and rebuilding the list would reset its scroll
		// and swallow clicks on buttons replaced between mousedown and mouseup.
		this.#popover.append(
			h(
				"div",
				{ className: "subagent-header" },
				h("span", { className: "subagent-title" }, "Subagents"),
				this.#summary,
			),
			h("div", { className: "subagent-mode" }, this.#modeLabel, this.#modeButton),
			this.#list,
			h("div", { className: "subagent-actions" }, this.#hurry),
		);
		this.element = h("div", { className: "subagent-panel" }, this.#trigger, this.#popover);
		this.element.addEventListener("keydown", event => {
			if (event.key === "Escape" && !this.#popover.hidden) {
				event.preventDefault();
				event.stopPropagation();
				this.#close();
				this.#trigger.focus();
			}
		});
		document.addEventListener("mousedown", event => {
			const target = event.target as Node;
			if (!this.#popover.hidden && !this.element.contains(target) && !this.#requests.element.contains(target))
				this.#close();
		});
		this.#renderTrigger();
	}

	/** Delegate mode availability and state; the button hides while omp cannot enter the mode and shows no subagents. */
	setMode(available: boolean, on: boolean): void {
		this.#available = available;
		this.#modeOn = on;
		this.#renderTrigger();
		if (!this.#popover.hidden) this.#render();
	}

	setSubagents(rows: SubagentView[]): void {
		this.#rows = rows;
		if (rows.length === 0) this.#close();
		this.#renderTrigger();
		if (!this.#popover.hidden) this.#render();
		this.#requests.setSubagents(rows);
	}

	/** Requests of the subagent whose popup is open. */
	setSubagentRequests(update: Extract<ChatUpdate, { type: "subagentRequests" }>): void {
		this.#requests.setRequests(update);
	}

	#cardId(target: EventTarget | null): string | undefined {
		return (target as Element | null)?.closest<HTMLElement>(".subagent-card")?.dataset.id;
	}

	#openRequests(id: string): void {
		const row = this.#rows.find(candidate => candidate.id === id);
		if (row) this.#requests.open(row);
	}

	#renderTrigger(): void {
		this.#trigger.hidden = !this.#available && this.#rows.length === 0;
		this.#trigger.ariaPressed = String(this.#modeOn);
		const running = this.#rows.filter(isActive).length;
		this.#badge.hidden = this.#rows.length === 0;
		this.#badge.textContent = String(running || this.#rows.length);
		this.#badge.classList.toggle("active", running > 0);
		const mode = this.#modeOn ? "Delegate mode on" : "Delegate mode off";
		const title =
			this.#rows.length > 0
				? `${mode}. ${running > 0 ? `${running} subagent${running === 1 ? "" : "s"} running` : "Subagents finished"}: click to see them`
				: this.#modeOn
					? "Leave delegate mode"
					: "Delegate mode: MarIA Code splits the task and runs it through subagents it picks per slice";
		setTooltip(this.#trigger, title);
		this.#trigger.ariaLabel = title;
	}

	#open(): void {
		this.#popover.hidden = false;
		this.#trigger.ariaExpanded = "true";
		this.#render();
		this.#ticker ??= window.setInterval(() => this.#render(), 1000);
	}

	#close(): void {
		this.#popover.hidden = true;
		this.#trigger.ariaExpanded = "false";
		if (this.#ticker !== undefined) window.clearInterval(this.#ticker);
		this.#ticker = undefined;
	}

	#render(): void {
		const now = Date.now();
		const active = this.#rows.filter(isActive);
		const finished = this.#rows.length - active.length;
		this.#summary.textContent = [
			active.length > 0 && `${active.length} running`,
			finished > 0 && `${finished} finished`,
		]
			.filter(Boolean)
			.join(" · ");

		this.#modeLabel.textContent = `Delegate mode: ${this.#modeOn ? "on" : "off"}`;
		this.#modeButton.textContent = this.#modeOn ? "Turn off" : "Turn on";
		this.#modeButton.disabled = !this.#available;

		const pendingWrapUp = active.filter(row => !row.wrapUpRequested).length;
		this.#hurry.disabled = pendingWrapUp === 0;
		setTooltip(
			this.#hurry,
			active.length === 0
				? "No subagent is running."
				: pendingWrapUp === 0
					? "Every running agent was already asked to wrap up."
					: "Ask every running agent to wrap up: finish the step in progress, skip optional work, and report what is done. MarIA Code integrates instead of starting new work.",
		);

		const list = this.#list;
		const scrollTop = list.scrollTop;
		const focusedId = list.contains(document.activeElement) ? this.#cardId(document.activeElement) : undefined;
		list.replaceChildren(...this.#rows.map(row => this.#card(row, now)));
		list.scrollTop = scrollTop;
		if (focusedId !== undefined) {
			[...list.querySelectorAll<HTMLElement>(".subagent-card")].find(card => card.dataset.id === focusedId)?.focus();
		}
	}

	#card(row: SubagentView, now: number): HTMLElement {
		const elapsed = elapsedMs(row, now);
		const task = row.description ?? row.assignment?.split("\n").find(line => line.trim()) ?? "";

		const header = h(
			"div",
			{ className: "subagent-card-header" },
			h("span", { className: `subagent-dot ${row.status}` }),
			h("span", { className: "subagent-name" }, row.id),
			h("span", { className: "subagent-agent" }, row.agent),
			h("span", { className: "subagent-time" }, formatDuration(elapsed)),
		);
		setTooltip(header.children[1] as HTMLElement, `${STATUS_LABELS[row.status]} · ${row.agent}`);

		const lines: HTMLElement[] = [header];
		if (task) {
			const taskEl = h("div", { className: "subagent-task" }, task);
			if (row.assignment) setTooltip(taskEl, row.assignment);
			lines.push(taskEl);
		}
		if (row.activity) lines.push(h("div", { className: "subagent-activity" }, row.activity));
		if (row.retry) lines.push(h("div", { className: "subagent-retry" }, row.retry));

		const stats = [
			`${row.toolCount} tool${row.toolCount === 1 ? "" : "s"}`,
			row.requestBudget ? `${row.requests}/${row.requestBudget} req` : `${row.requests} req`,
			`${formatTokens(row.tokens)} tok`,
			formatCost(row.cost),
		];
		const statsEl = h("div", { className: "subagent-stats" }, stats.join(" · "));
		if (row.model) setTooltip(statsEl, row.model);
		lines.push(statsEl);
		if (row.wrapUpRequested && isActive(row))
			lines.push(h("div", { className: "subagent-flag" }, "Asked to wrap up"));
		if (!isActive(row)) {
			lines.push(h("div", { className: `subagent-final ${row.status}` }, STATUS_LABELS[row.status]));
		}
		const card = h(
			"div",
			{ className: `subagent-card ${row.status}`, role: "button", tabIndex: 0, dataset: { id: row.id } },
			...lines,
		);
		setTooltip(card, "See its requests");
		return card;
	}
}
