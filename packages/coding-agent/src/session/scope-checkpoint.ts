import type { AgentEvent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import scopeCheckpointPrompt from "../prompts/system/scope-checkpoint.md" with { type: "text" };
import wrapUpRequestPrompt from "../prompts/system/wrap-up-request.md" with { type: "text" };
import {
	cfgModelScopeCheckpointEnabled,
	cfgModelScopeCheckpointMinutes,
	cfgModelScopeCheckpointSubagentMinutes,
} from "./settings";

const SCOPE_CHECKPOINT_MESSAGE_TYPE = "scope-checkpoint";
const WRAP_UP_REQUEST_MESSAGE_TYPE = "wrap-up-request";
const SCOPE_CHECKPOINT_MAX_PER_CYCLE = 2;
/** Tool rounds required before each checkpoint (since request start / since the previous checkpoint). */
const SCOPE_CHECKPOINT_MIN_TOOL_ROUNDS = 8;
/** A main agent's first checkpoint needs fewer rounds: a short request may still have run long. */
const MAIN_FIRST_CHECKPOINT_MIN_TOOL_ROUNDS = 4;
/** Tools whose execution time is the user's, not the agent's. */
const USER_WAIT_TOOLS: Record<string, true> = { ask: true };
/** Tool that hands work to subagents; a main run calling it delegates. */
const DELEGATION_TOOL = "task";
/** omp's step-list tool (`todo_write` in older sessions). */
const TODO_TOOLS: Record<string, true> = { todo: true, todo_write: true };
/** Step statuses that close a step. */
const CLOSED_TODO_STATUSES: Record<string, true> = { completed: true, abandoned: true };

/** Whether a `todo` result's step list (`details.phases`) has steps left; `undefined` when it carries none. */
function hasOpenSteps(result: unknown): boolean | undefined {
	const details = (result as { details?: { phases?: unknown } } | undefined)?.details;
	if (!Array.isArray(details?.phases)) return undefined;
	return details.phases.some(
		(phase: { tasks?: { status?: string }[] }) =>
			Array.isArray(phase?.tasks) && phase.tasks.some(task => !CLOSED_TODO_STATUSES[task?.status ?? ""]),
	);
}

/** Capabilities the scope checkpoint borrows from its owning session. */
export interface ScopeCheckpointHost {
	settings: Settings;
	agentKind(): "main" | "sub";
	planModeEnabled(): boolean;
	delegateModeEnabled(): boolean;
}

/**
 * Hidden mid-work reminder asking a long-running agent to re-check its
 * remaining work against the literal request. Fires at most twice per request:
 * once the run has been active for the configured minutes (excluding time
 * between runs and time blocked on the user) AND has made enough tool rounds
 * (4 for a main agent's first checkpoint, 8 otherwise), then again at twice
 * that time after 8 more rounds.
 *
 * A main run that delegates (delegate mode on, or a `task` call this request)
 * gets no checkpoint: its time is spent waiting on subagents, and each
 * subagent session runs its own timer on the subagent minutes setting.
 *
 * Plan mode gets none either: neither while the agent drafts the plan nor while
 * it carries out an approved one ({@link startPlanRun}). The execution lasts
 * across follow-up requests while its step list has open steps; a request that
 * starts once every step is closed — or, for a plan run without a step list,
 * once a run that worked on it (an answer that was not aborted) has ended — is
 * a new task.
 *
 * {@link requestWrapUp} queues a one-shot wrap-up reminder delivered at the
 * next tool-round boundary, bypassing the time and round gates.
 */
export class ScopeCheckpoint {
	readonly #host: ScopeCheckpointHost;
	#activeMs = 0;
	#runStartedAt: number | undefined;
	#userWaitStartedAt: number | undefined;
	#userWaitMs = 0;
	#toolRounds = 0;
	#roundsAtLastCheckpoint = 0;
	#fired = 0;
	#lastAssistantStopReason: string | undefined;
	#delegated = false;
	#wrapUpPending = false;
	/** An approved plan is being carried out. */
	#planRunning = false;
	/** Whether the plan run's latest step list has open steps; `undefined` until one is written. */
	#planStepsOpen: boolean | undefined;
	/** The model answered (not aborted) since the approval: the run is working on the plan. */
	#planWorked = false;
	/** A run that worked on the plan ended. */
	#planRunEnded = false;

	constructor(host: ScopeCheckpointHost) {
		this.#host = host;
	}

	/**
	 * Resets per-request time, round, checkpoint, delegation, and wrap-up state at
	 * the start of a request, which also ends a finished plan run.
	 */
	resetCycle(): void {
		const planDone = this.#planStepsOpen === false || (this.#planStepsOpen === undefined && this.#planRunEnded);
		if (this.#planRunning && planDone) this.endPlanRun();
		this.#activeMs = 0;
		this.#runStartedAt = undefined;
		this.#userWaitStartedAt = undefined;
		this.#userWaitMs = 0;
		this.#toolRounds = 0;
		this.#roundsAtLastCheckpoint = 0;
		this.#fired = 0;
		this.#lastAssistantStopReason = undefined;
		this.#delegated = false;
		this.#wrapUpPending = false;
	}

	/** The user approved a plan: carrying it out gets no checkpoint until it is done. */
	startPlanRun(): void {
		this.#planRunning = true;
		this.#planStepsOpen = undefined;
		this.#planWorked = false;
		this.#planRunEnded = false;
	}

	/** Drops the plan run (the session changed). */
	endPlanRun(): void {
		this.#planRunning = false;
		this.#planStepsOpen = undefined;
		this.#planWorked = false;
		this.#planRunEnded = false;
	}

	/** Synchronous event bookkeeping; MUST run before any await in the session event handler. */
	onAgentEvent(event: AgentEvent): void {
		switch (event.type) {
			case "agent_start":
				this.#runStartedAt = Date.now();
				return;
			case "agent_end":
				if (this.#runStartedAt !== undefined) {
					this.#activeMs += Date.now() - this.#runStartedAt;
					this.#runStartedAt = undefined;
				}
				if (this.#planWorked) this.#planRunEnded = true;
				return;
			case "tool_execution_start":
				if (event.toolName === DELEGATION_TOOL) this.#delegated = true;
				if (USER_WAIT_TOOLS[event.toolName]) this.#userWaitStartedAt = Date.now();
				return;
			case "tool_execution_end":
				if (USER_WAIT_TOOLS[event.toolName] && this.#userWaitStartedAt !== undefined) {
					this.#userWaitMs += Date.now() - this.#userWaitStartedAt;
					this.#userWaitStartedAt = undefined;
				}
				if (this.#planRunning && TODO_TOOLS[event.toolName] && !event.isError) {
					this.#planStepsOpen = hasOpenSteps(event.result) ?? this.#planStepsOpen;
				}
				return;
			case "message_end":
				if (event.message.role !== "assistant") return;
				this.#lastAssistantStopReason = event.message.stopReason;
				if (event.message.stopReason === "toolUse") this.#toolRounds++;
				if (this.#planRunning && event.message.stopReason !== "aborted") this.#planWorked = true;
				return;
		}
	}

	/** Queue a one-shot wrap-up reminder for the next tool-round boundary of the current request. */
	requestWrapUp(): void {
		this.#wrapUpPending = true;
	}

	/** Takes the next wrap-up or checkpoint message when its gates pass; polled by the session's aside provider. */
	take(): AgentMessage | null {
		// The aside provider is also polled at the stop boundary, where a message would force an
		// extra model turn after the agent finished; inject only between tool rounds.
		if (this.#lastAssistantStopReason !== "toolUse") return null;
		const now = Date.now();
		const kind = this.#host.agentKind();
		if (this.#wrapUpPending) {
			this.#wrapUpPending = false;
			logger.debug("Wrap-up request delivered", { agentKind: kind });
			return {
				role: "custom",
				customType: WRAP_UP_REQUEST_MESSAGE_TYPE,
				content: prompt.render(wrapUpRequestPrompt, { lead: kind === "main" }),
				display: false,
				attribution: "agent",
				timestamp: now,
			};
		}
		const settings = this.#host.settings;
		if (!cfgModelScopeCheckpointEnabled.get(settings)) return null;
		if (this.#host.planModeEnabled() || this.#planRunning) return null;
		if (kind === "main" && (this.#delegated || this.#host.delegateModeEnabled())) return null;
		const minutes =
			kind === "sub"
				? cfgModelScopeCheckpointSubagentMinutes.get(settings)
				: cfgModelScopeCheckpointMinutes.get(settings);
		if (!(minutes > 0)) return null;
		if (this.#fired >= SCOPE_CHECKPOINT_MAX_PER_CYCLE) return null;
		const elapsedMs =
			this.#activeMs + (this.#runStartedAt !== undefined ? now - this.#runStartedAt : 0) - this.#userWaitMs;
		if (elapsedMs < minutes * 60_000 * (this.#fired + 1)) return null;
		const minRounds =
			kind === "main" && this.#fired === 0
				? MAIN_FIRST_CHECKPOINT_MIN_TOOL_ROUNDS
				: SCOPE_CHECKPOINT_MIN_TOOL_ROUNDS;
		if (this.#toolRounds - this.#roundsAtLastCheckpoint < minRounds) return null;
		this.#fired++;
		this.#roundsAtLastCheckpoint = this.#toolRounds;
		const content = prompt.render(scopeCheckpointPrompt, {
			toolRounds: this.#toolRounds,
			second: this.#fired === 2,
			subagent: kind === "sub",
		});
		logger.debug("Scope checkpoint fired", {
			agentKind: kind,
			checkpoint: this.#fired,
			toolRounds: this.#toolRounds,
			elapsedMs,
		});
		return {
			role: "custom",
			customType: SCOPE_CHECKPOINT_MESSAGE_TYPE,
			content,
			display: false,
			attribution: "agent",
			timestamp: now,
		};
	}
}
