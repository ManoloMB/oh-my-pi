/**
 * Task list button in the composer, shown while omp keeps a task list (`todo`)
 * for the chat and no approved plan is being tracked (the plan button shows the
 * same list then). A "done/total" badge shows the progress; the popup lists the
 * tasks by phase with the one in progress highlighted. The host re-sends the
 * list (`todos`) after every change.
 */
import { allTodosClosed } from "../../src/chat/todo-list";
import type { TodoPhase } from "../../src/protocol";
import { button, h } from "../dom";
import { icon } from "../icons";
import { setTooltip } from "../tooltip";
import { renderTodoBar, renderTodoList, todoCounts, todoSummary } from "./todo-view";

type TodoListStatus = "running" | "paused" | "done";

const STATUS_LABELS: Record<TodoListStatus, string> = {
	running: "In progress",
	paused: "Paused",
	done: "Completed",
};

export class TodoPanel {
	readonly element: HTMLElement;
	#trigger: HTMLButtonElement;
	#badge = h("span", { className: "subagent-badge todo-badge" });
	#popover = h("div", {
		className: "subagent-popover todo-popover",
		role: "dialog",
		ariaLabel: "Task list",
		hidden: true,
	});
	#status = h("span", { className: "plan-run-status" });
	#summary = h("div", { className: "plan-run-summary" });
	#barFill = h("div", { className: "plan-run-bar-fill" });
	#bar = h("div", { className: "plan-run-bar" }, this.#barFill);
	#list = h("div", { className: "plan-run-list" });
	#phases: TodoPhase[] = [];
	#busy = false;
	/** An approved plan is tracked: its button shows this list instead. */
	#suppressed = false;

	constructor() {
		this.#trigger = h(
			"button",
			{ type: "button", className: "icon-button todo-toggle", ariaHasPopup: "dialog", hidden: true },
			icon("listTodo"),
			this.#badge,
		);
		this.#trigger.addEventListener("click", () => (this.#popover.hidden ? this.#open() : this.#close()));
		const close = button("×", "notice-close", () => this.#close());
		setTooltip(close, "Close");
		this.#popover.append(
			h(
				"div",
				{ className: "subagent-header" },
				h("span", { className: "plan-run-title" }, "Task list"),
				this.#status,
				close,
			),
			this.#summary,
			this.#bar,
			this.#list,
			h(
				"p",
				{ className: "todo-note" },
				"The checklist MarIA Code keeps for your request. A finished list clears at your next request.",
			),
		);
		this.element = h("div", { className: "subagent-panel todo-panel" }, this.#trigger, this.#popover);
		this.element.addEventListener("keydown", event => {
			if (event.key === "Escape" && !this.#popover.hidden) {
				event.preventDefault();
				event.stopPropagation();
				this.#close();
				this.#trigger.focus();
			}
		});
		document.addEventListener("mousedown", event => {
			if (!this.#popover.hidden && !this.element.contains(event.target as Node)) this.#close();
		});
	}

	/** The host's `todos`. */
	setPhases(phases: TodoPhase[]): void {
		this.#phases = phases;
		this.#update();
	}

	/** The agent is working: open tasks count as in progress, not paused. */
	setBusy(busy: boolean): void {
		this.#busy = busy;
		this.#update();
	}

	setSuppressed(suppressed: boolean): void {
		this.#suppressed = suppressed;
		this.#update();
	}

	#statusOf(): TodoListStatus {
		return allTodosClosed(this.#phases) ? "done" : this.#busy ? "running" : "paused";
	}

	#update(): void {
		const { done, total } = todoCounts(this.#phases);
		const shown = total > 0 && !this.#suppressed;
		this.#trigger.hidden = !shown;
		if (!shown) {
			this.#close();
			return;
		}
		const status = this.#statusOf();
		this.#badge.textContent = `${done}/${total}`;
		this.#badge.classList.toggle("active", status === "running");
		const title = `Task list: ${done} of ${total} done (${STATUS_LABELS[status].toLowerCase()}). Click to see it`;
		setTooltip(this.#trigger, title);
		this.#trigger.ariaLabel = title;
		if (!this.#popover.hidden) this.#render(false);
	}

	#open(): void {
		this.#popover.hidden = false;
		this.#trigger.ariaExpanded = "true";
		this.#render(true);
	}

	#close(): void {
		this.#popover.hidden = true;
		this.#trigger.ariaExpanded = "false";
	}

	/** Refresh the popover; on opening, scroll the task in progress into view. */
	#render(opening: boolean): void {
		const status = this.#statusOf();
		this.#status.textContent = STATUS_LABELS[status];
		this.#status.className = `plan-run-status ${status}`;
		this.#summary.textContent = todoSummary(this.#phases, "tasks");
		renderTodoBar(this.#bar, this.#barFill, this.#phases);
		renderTodoList(this.#list, this.#phases, opening);
	}
}
