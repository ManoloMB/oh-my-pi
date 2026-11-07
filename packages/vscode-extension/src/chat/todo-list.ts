/**
 * omp's task list (`todo`) of the shown session, folded from its transcript so
 * it survives reloads and session switches: every `todo` result carries the
 * whole list. A user prompt sent once every task is closed starts a new task
 * and hides the finished list.
 */
import { type AgentMessage, isUserPrompt, type TodoItem, type TodoPhase } from "../protocol";

/** omp's step-list tool (`todo_write` in older sessions). */
const TODO_TOOLS: Record<string, true> = { todo: true, todo_write: true };

/** The whole list a `todo` result carries, or undefined for any other message. */
export function todoPhasesOf(message: AgentMessage): TodoPhase[] | undefined {
	if (message.role !== "toolResult" || !TODO_TOOLS[message.toolName]) return undefined;
	const details = message.details;
	if (typeof details !== "object" || details === null || !("phases" in details)) return undefined;
	return Array.isArray(details.phases) ? (details.phases as TodoPhase[]) : undefined;
}

/** Done or dropped: nothing left to do for the task. */
export function isTodoClosed(task: TodoItem): boolean {
	return task.status === "completed" || task.status === "abandoned";
}

/** Whether `phases` hold tasks and every one is closed. */
export function allTodosClosed(phases: readonly TodoPhase[] | undefined): boolean {
	const tasks = phases?.flatMap(phase => phase.tasks) ?? [];
	return tasks.length > 0 && tasks.every(isTodoClosed);
}

export class TodoListTracker {
	#phases: TodoPhase[] = [];

	/** The current list; empty when there is none to show. */
	get phases(): TodoPhase[] {
		return this.#phases;
	}

	/** Rebuild from the whole transcript (startup, session switch, a view attaching). */
	load(messages: AgentMessage[]): void {
		this.#phases = [];
		for (const message of messages) this.apply(message);
	}

	/** Fold one finished message in; returns whether the list changed. */
	apply(message: AgentMessage): boolean {
		const phases = todoPhasesOf(message);
		if (phases) {
			this.#phases = phases.filter(phase => phase.tasks.length > 0);
			return true;
		}
		// Steering lands mid-task and a follow-up to unfinished work continues it.
		if (isUserPrompt(message) && !(message.role === "user" && message.steering) && allTodosClosed(this.#phases)) {
			this.#phases = [];
			return true;
		}
		return false;
	}
}
