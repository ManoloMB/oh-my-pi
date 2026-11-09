/**
 * omp's task list (`todo`) of the shown session, folded from its transcript so
 * it survives reloads and session switches: every `todo` result carries the
 * whole list. Between turns omp's own list (`get_state`) is authoritative too,
 * so edits made outside the tool (`/todo`, `/tan`, `set_todos`) reach the button.
 *
 * A user prompt ends the list for the chat (hides it until omp writes it again)
 * when every task is closed, or when omp left it untouched through the whole
 * previous request: a list the agent stopped updating is abandoned, not in
 * progress, whatever its open tasks say.
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
	/** omp's list as last seen: from a `todo` result or, between turns, from `get_state`. */
	#source: TodoPhase[] = [];
	/** A user prompt ended the list: finished, or untouched through a whole request. */
	#hidden = false;
	/** omp wrote the list since the latest user prompt. */
	#touched = false;

	/** The current list; empty when there is none to show. */
	get phases(): TodoPhase[] {
		return this.#hidden ? [] : this.#source;
	}

	/** Rebuild from the whole transcript (startup, session switch, a view attaching). */
	load(messages: AgentMessage[]): void {
		this.#source = [];
		this.#hidden = false;
		this.#touched = false;
		for (const message of messages) this.apply(message);
	}

	/** Fold one finished message in; returns whether the shown list changed. */
	apply(message: AgentMessage): boolean {
		const phases = todoPhasesOf(message);
		if (phases) {
			this.#adopt(phases.filter(phase => phase.tasks.length > 0));
			return true;
		}
		// Steering lands mid-task: it neither starts a new request nor ends the list.
		if (!isUserPrompt(message) || (message.role === "user" && message.steering)) return false;
		const touched = this.#touched;
		this.#touched = false;
		if (this.#hidden || this.#source.length === 0) return false;
		// A follow-up to work the agent was still updating continues it.
		if (touched && !allTodosClosed(this.#source)) return false;
		this.#hidden = true;
		return true;
	}

	/**
	 * omp's list from `get_state`, read between turns only (mid-turn a `todo`
	 * result may be newer than the answer). A list other than the last one seen
	 * was edited outside the tool and replaces it; the same list changes nothing,
	 * so a list a prompt ended stays hidden.
	 */
	sync(phases: readonly TodoPhase[]): boolean {
		const next = phases.filter(phase => phase.tasks.length > 0);
		if (JSON.stringify(next) === JSON.stringify(this.#source)) return false;
		this.#adopt(next);
		return true;
	}

	/** omp wrote `phases` (empty phases already dropped): show them, as touched in this request. */
	#adopt(phases: TodoPhase[]): void {
		this.#source = phases;
		this.#hidden = false;
		this.#touched = true;
	}
}
