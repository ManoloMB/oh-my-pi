import type { AgentEvent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import scopeCheckpointPrompt from "../prompts/system/scope-checkpoint.md" with { type: "text" };
import wrapUpRequestPrompt from "../prompts/system/wrap-up-request.md" with { type: "text" };

const SCOPE_CHECKPOINT_MESSAGE_TYPE = "scope-checkpoint";
const WRAP_UP_REQUEST_MESSAGE_TYPE = "wrap-up-request";
/** Tools whose execution time is the user's, not the agent's. */
const USER_WAIT_TOOLS: Record<string, true> = { ask: true };

/**
 * How firmly a user-requested checkpoint pushes: `light` re-checks remaining
 * work against the request, `severe` asks to wrap up, `hard` asks to stop and
 * answer with what the agent has.
 */
export type ScopeCheckpointLevel = "light" | "severe" | "hard";

const LEVEL_RANK: Record<ScopeCheckpointLevel, number> = { light: 1, severe: 2, hard: 3 };

/** Work done on the current request, as the user sees it before sending a checkpoint. */
export interface ScopeCheckpointStats {
	/** A request is running and can receive a checkpoint. */
	running: boolean;
	/** Active time since the latest request started, excluding time between runs and time blocked on `ask`. */
	activeMs: number;
	/** Model turns that called tools since the latest request started. */
	toolRounds: number;
	/** Tool calls the model made since the latest request started; one turn may make several. */
	toolCalls: number;
}

/** Capabilities the scope checkpoint borrows from its owning session. */
export interface ScopeCheckpointHost {
	agentKind(): "main" | "sub";
}

/**
 * Hidden mid-work reminders the user sends on demand: a scope checkpoint at one
 * of three {@link ScopeCheckpointLevel}s ({@link request}) or the wrap-up
 * request `hurry_subagents` sends ({@link requestWrapUp}). Each is delivered
 * once, at the next tool-round boundary of the current request; a request that
 * ends first drops it.
 *
 * Also keeps the request's active time, tool rounds, and tool calls ({@link stats})
 * so the user can judge whether a checkpoint is due.
 */
export class ScopeCheckpoint {
	readonly #host: ScopeCheckpointHost;
	#activeMs = 0;
	#runStartedAt: number | undefined;
	#userWaitStartedAt: number | undefined;
	#userWaitMs = 0;
	#toolRounds = 0;
	#toolCalls = 0;
	#lastAssistantStopReason: string | undefined;
	#wrapUpPending = false;
	#pendingLevel: ScopeCheckpointLevel | undefined;

	constructor(host: ScopeCheckpointHost) {
		this.#host = host;
	}

	/** Resets per-request time, rounds, and pending reminders at the start of a request. */
	resetCycle(): void {
		this.#activeMs = 0;
		this.#runStartedAt = undefined;
		this.#userWaitStartedAt = undefined;
		this.#userWaitMs = 0;
		this.#toolRounds = 0;
		this.#toolCalls = 0;
		this.#lastAssistantStopReason = undefined;
		this.#wrapUpPending = false;
		this.#pendingLevel = undefined;
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
				return;
			case "tool_execution_start":
				if (USER_WAIT_TOOLS[event.toolName]) this.#userWaitStartedAt = Date.now();
				return;
			case "tool_execution_end":
				if (USER_WAIT_TOOLS[event.toolName] && this.#userWaitStartedAt !== undefined) {
					this.#userWaitMs += Date.now() - this.#userWaitStartedAt;
					this.#userWaitStartedAt = undefined;
				}
				return;
			case "message_end":
				if (event.message.role !== "assistant") return;
				this.#lastAssistantStopReason = event.message.stopReason;
				if (event.message.stopReason === "toolUse") this.#toolRounds++;
				for (const block of event.message.content) if (block.type === "toolCall") this.#toolCalls++;
				return;
		}
	}

	/** Active time, tool rounds, and tool calls of the current request; `running` comes from the session. */
	stats(running: boolean): ScopeCheckpointStats {
		const now = Date.now();
		const waiting = this.#userWaitStartedAt !== undefined ? now - this.#userWaitStartedAt : 0;
		const activeMs =
			this.#activeMs +
			(this.#runStartedAt !== undefined ? now - this.#runStartedAt : 0) -
			this.#userWaitMs -
			waiting;
		return {
			running,
			activeMs: Math.max(0, activeMs),
			toolRounds: this.#toolRounds,
			toolCalls: this.#toolCalls,
		};
	}

	/** Queue a checkpoint for the next tool-round boundary; a firmer level replaces a pending lighter one. */
	request(level: ScopeCheckpointLevel): void {
		if (this.#pendingLevel === undefined || LEVEL_RANK[level] > LEVEL_RANK[this.#pendingLevel]) {
			this.#pendingLevel = level;
		}
	}

	/** Queue a one-shot wrap-up reminder for the next tool-round boundary of the current request. */
	requestWrapUp(): void {
		this.#wrapUpPending = true;
	}

	/**
	 * Takes the pending wrap-up request; polled by the session's aside provider. The provider is
	 * also polled at the stop boundary, where a message would force an extra model turn after the
	 * agent finished, so both takers inject only between tool rounds.
	 */
	takeWrapUp(): AgentMessage | null {
		if (!this.#wrapUpPending || this.#lastAssistantStopReason !== "toolUse") return null;
		this.#wrapUpPending = false;
		const kind = this.#host.agentKind();
		logger.debug("Wrap-up request delivered", { agentKind: kind });
		return {
			role: "custom",
			customType: WRAP_UP_REQUEST_MESSAGE_TYPE,
			content: prompt.render(wrapUpRequestPrompt, { lead: kind === "main" }),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/** Takes the pending checkpoint between tool rounds (see {@link takeWrapUp}). */
	takeCheckpoint(): AgentMessage | null {
		const level = this.#pendingLevel;
		if (level === undefined || this.#lastAssistantStopReason !== "toolUse") return null;
		this.#pendingLevel = undefined;
		logger.debug("Scope checkpoint delivered", { level, toolRounds: this.#toolRounds });
		return {
			role: "custom",
			customType: SCOPE_CHECKPOINT_MESSAGE_TYPE,
			content: prompt.render(scopeCheckpointPrompt, {
				toolRounds: this.#toolRounds,
				severe: level === "severe",
				hard: level === "hard",
			}),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}
}
