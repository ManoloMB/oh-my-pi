/**
 * omp's task list (`todo`) as popover content: progress counts and the tasks by
 * phase, the one in progress highlighted. Shared by the plan button's progress
 * popover and the composer's task list button.
 */
import { isTodoClosed } from "../../src/chat/todo-list";
import type { TodoItem, TodoPhase } from "../../src/protocol";
import { h } from "../dom";
import { setTooltip } from "../tooltip";

const TASK_GLYPHS: Record<TodoItem["status"], string> = {
	completed: "✓",
	in_progress: "●",
	pending: "○",
	abandoned: "–",
	blocked: "!",
};

const TASK_LABELS: Record<TodoItem["status"], string> = {
	completed: "Done",
	in_progress: "In progress",
	pending: "Pending",
	abandoned: "Dropped",
	blocked: "Blocked",
};

/** Closed (done or dropped) and total tasks across `phases`. */
export function todoCounts(phases: readonly TodoPhase[]): { done: number; total: number } {
	const tasks = phases.flatMap(phase => phase.tasks);
	return { done: tasks.filter(isTodoClosed).length, total: tasks.length };
}

/** "3 of 7 steps · Phase 2 of 3: Build": the counts plus, with several phases, the first one with open tasks. */
export function todoSummary(phases: readonly TodoPhase[], noun: string): string {
	const { done, total } = todoCounts(phases);
	const phaseIndex = phases.findIndex(phase => phase.tasks.some(task => !isTodoClosed(task)));
	const phase = phaseIndex >= 0 ? phases[phaseIndex] : undefined;
	return [
		`${done} of ${total} ${noun}`,
		phase && phases.length > 1 && `Phase ${phaseIndex + 1} of ${phases.length}: ${phase.name}`,
	]
		.filter(Boolean)
		.join(" · ");
}

/** Fill `bar` (a `.plan-run-bar` around its fill) with the closed share of the tasks; hidden without tasks. */
export function renderTodoBar(bar: HTMLElement, fill: HTMLElement, phases: readonly TodoPhase[]): void {
	const { done, total } = todoCounts(phases);
	bar.hidden = total === 0;
	fill.style.width = `${total === 0 ? 0 : Math.round((done / total) * 100)}%`;
}

/** Replace `list` with the tasks by phase, keeping its scroll; `opening` scrolls the task in progress into view. */
export function renderTodoList(list: HTMLElement, phases: readonly TodoPhase[], opening: boolean): void {
	const scrollTop = list.scrollTop;
	list.replaceChildren(
		...phases.map(phase =>
			h(
				"div",
				{ className: "plan-run-phase" },
				h(
					"div",
					{ className: "plan-run-phase-name" },
					h("span", null, phase.name),
					h(
						"span",
						{ className: "plan-run-phase-count" },
						`${phase.tasks.filter(isTodoClosed).length}/${phase.tasks.length}`,
					),
				),
				...phase.tasks.map(todoTask),
			),
		),
	);
	list.hidden = phases.length === 0;
	list.scrollTop = scrollTop;
	if (opening) list.querySelector(".plan-run-task.in_progress")?.scrollIntoView({ block: "nearest" });
}

function todoTask(task: TodoItem): HTMLElement {
	const element = h(
		"div",
		{ className: `plan-run-task ${task.status}` },
		h("span", { className: "plan-run-glyph", ariaHidden: "true" }, TASK_GLYPHS[task.status]),
		h(
			"div",
			{ className: "plan-run-task-body" },
			h("span", null, task.content),
			task.status === "blocked" && task.blocker && h("div", { className: "plan-run-blocker" }, task.blocker),
		),
	);
	element.ariaLabel = `${TASK_LABELS[task.status]}: ${task.content}`;
	setTooltip(element, task.details ? `${TASK_LABELS[task.status]} · ${task.details}` : TASK_LABELS[task.status]);
	return element;
}
