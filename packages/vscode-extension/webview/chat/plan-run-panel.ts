/**
 * Progress of an approved plan, behind the plan mode button. Approving leaves
 * plan mode, so the button is no longer pressed; while omp executes the plan it
 * shows a "done/total" badge, and clicking it opens this popover instead of re-entering plan mode: the
 * agent's step list by phase, the step in progress highlighted, and buttons to
 * open the plan, stop tracking it, or start a new plan.
 */
import type { ChatRequest, PlanRunView } from "../../src/protocol";
import { h } from "../dom";
import { setTooltip } from "../tooltip";
import { renderTodoBar, renderTodoList, todoCounts, todoSummary } from "./todo-view";

type Post = (request: ChatRequest) => void;

const STATUS_LABELS: Record<PlanRunView["status"], string> = {
	starting: "Starting",
	running: "Executing",
	paused: "Paused",
	done: "Completed",
};

export class PlanRunPanel {
	readonly element: HTMLElement;
	#badge = h("span", { className: "subagent-badge plan-run-badge", hidden: true });
	#popover = h("div", {
		className: "subagent-popover plan-run-popover",
		role: "dialog",
		ariaLabel: "Plan progress",
		hidden: true,
	});
	#title = h("span", { className: "plan-run-title" });
	#status = h("span", { className: "plan-run-status" });
	#summary = h("div", { className: "plan-run-summary" });
	#barFill = h("div", { className: "plan-run-bar-fill" });
	#bar = h("div", { className: "plan-run-bar" }, this.#barFill);
	#list = h("div", { className: "plan-run-list" });
	#openPlan = h("button", { type: "button", className: "subagent-mode-button" }, "Open plan");
	#run: PlanRunView | null = null;

	constructor(
		private readonly trigger: HTMLButtonElement,
		private readonly post: Post,
		private readonly onNewPlan: () => void,
	) {
		trigger.append(this.#badge);
		this.#openPlan.addEventListener("click", () => {
			if (this.#run?.planFile) this.post({ type: "openPlan", path: this.#run.planFile });
		});
		const stop = h("button", { type: "button", className: "subagent-mode-button" }, "Stop tracking");
		setTooltip(stop, "Turn the plan button off; the agent keeps working.");
		stop.addEventListener("click", () => {
			this.#close();
			this.post({ type: "dismissPlanRun" });
		});
		const newPlan = h("button", { type: "button", className: "subagent-mode-button" }, "New plan");
		setTooltip(newPlan, "Enter plan mode for the next task.");
		newPlan.addEventListener("click", () => {
			this.#close();
			this.onNewPlan();
		});
		// Built once: the step list refreshes after every message, and replacing buttons
		// between mousedown and mouseup would swallow the click.
		this.#popover.append(
			h("div", { className: "subagent-header" }, this.#title, this.#status),
			this.#summary,
			this.#bar,
			this.#list,
			h(
				"div",
				{ className: "plan-run-actions" },
				this.#openPlan,
				h("span", { className: "plan-run-spacer" }),
				stop,
				newPlan,
			),
		);
		this.element = h("div", { className: "subagent-panel plan-run-panel" }, trigger, this.#popover);
		this.element.addEventListener("keydown", event => {
			if (event.key === "Escape" && !this.#popover.hidden) {
				event.preventDefault();
				event.stopPropagation();
				this.#close();
				this.trigger.focus();
			}
		});
		document.addEventListener("mousedown", event => {
			if (!this.#popover.hidden && !this.element.contains(event.target as Node)) this.#close();
		});
	}

	/** A plan is being tracked: the button shows its progress instead of toggling plan mode. */
	get active(): boolean {
		return this.#run !== null;
	}

	/** The button's tooltip while a plan is tracked. */
	get title(): string {
		const run = this.#run;
		if (!run) return "";
		const { done, total } = todoCounts(run.phases);
		const steps = total > 0 ? `: ${done} of ${total} steps` : "";
		return run.status === "done"
			? `Plan "${run.title}" completed${steps}. Click to see it`
			: `${STATUS_LABELS[run.status]} plan "${run.title}"${steps}. Click to see progress`;
	}

	setRun(run: PlanRunView | null): void {
		this.#run = run;
		const { done, total } = todoCounts(run?.phases ?? []);
		this.#badge.hidden = !run || total === 0;
		this.#badge.textContent = `${done}/${total}`;
		this.#badge.classList.toggle("active", run?.status === "running" || run?.status === "starting");
		if (!run) this.#close();
		else if (!this.#popover.hidden) this.#render(false);
	}

	toggle(): void {
		if (this.#popover.hidden) this.#open();
		else this.#close();
	}

	#open(): void {
		if (!this.#run) return;
		this.#popover.hidden = false;
		this.trigger.ariaExpanded = "true";
		this.#render(true);
	}

	#close(): void {
		this.#popover.hidden = true;
		this.trigger.ariaExpanded = "false";
	}

	/** Refresh the popover; on opening, scroll the step in progress into view. */
	#render(opening: boolean): void {
		const run = this.#run;
		if (!run) return;
		this.#title.textContent = run.title;
		setTooltip(this.#title, run.title);
		this.#status.textContent = STATUS_LABELS[run.status];
		this.#status.className = `plan-run-status ${run.status}`;
		this.#summary.textContent =
			todoCounts(run.phases).total === 0
				? run.status === "paused"
					? "The agent stopped before making a step list."
					: "Preparing the steps…"
				: todoSummary(run.phases, "steps");
		renderTodoBar(this.#bar, this.#barFill, run.phases);
		this.#openPlan.hidden = !run.planFile;
		renderTodoList(this.#list, run.phases, opening);
	}
}
