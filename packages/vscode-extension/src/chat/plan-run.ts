/**
 * The approved plan the shown session is executing, folded from its transcript
 * so it survives reloads and session switches without a store of its own:
 * omp's `xd://propose` result marks the approval (the write's `details.xdev`
 * envelope carries the plan handler's `inner` details: `approved`, with the
 * plan's title), and every `todo` result carries the whole step list. A user
 * prompt sent once every step is closed starts a new task and ends the run.
 */
import { type AgentMessage, isUserPrompt, type PlanRunView, type TodoPhase } from "../protocol";
import { allTodosClosed, todoPhasesOf } from "./todo-list";

interface PlanRun {
	/** The approving tool call, which identifies the run across reloads. */
	id: string;
	title: string;
	phases: TodoPhase[] | undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

export class PlanRunTracker {
	#run: PlanRun | undefined;

	/** The approving tool call of the run, if any. */
	get id(): string | undefined {
		return this.#run?.id;
	}

	/** Rebuild from the whole transcript (startup, session switch, a view attaching). */
	load(messages: AgentMessage[]): void {
		this.#run = undefined;
		for (const message of messages) this.apply(message);
	}

	clear(): boolean {
		const had = this.#run !== undefined;
		this.#run = undefined;
		return had;
	}

	/** Fold one finished message in; returns whether the run changed. */
	apply(message: AgentMessage): boolean {
		if (message.role === "toolResult") {
			const details = record(message.details);
			// A device write wraps the device's own details: `{ xdev: { tool, inner } }`.
			const xdev = record(details?.xdev);
			const approval = xdev?.tool === "propose" ? record(xdev.inner) : undefined;
			if (message.toolName === "write" && approval?.approved === true && typeof approval.title === "string") {
				this.#run = { id: message.toolCallId, title: approval.title, phases: undefined };
				return true;
			}
			const phases = this.#run && todoPhasesOf(message);
			if (this.#run && phases) {
				this.#run.phases = phases;
				return true;
			}
			return false;
		}
		// Steering lands mid-run and a follow-up to an unfinished plan continues it: only a
		// prompt after the last step closed is a new task.
		if (this.#run && isUserPrompt(message) && !(message.role === "user" && message.steering) && this.#complete()) {
			this.#run = undefined;
			return true;
		}
		return false;
	}

	/** The run for the plan button; `busy`: the agent is working right now. */
	view(busy: boolean): Omit<PlanRunView, "planFile"> | null {
		const run = this.#run;
		if (!run) return null;
		const phases = run.phases ?? [];
		const status = this.#complete() ? "done" : !busy ? "paused" : run.phases ? "running" : "starting";
		return { title: run.title, status, phases };
	}

	#complete(): boolean {
		return allTodosClosed(this.#run?.phases);
	}
}
