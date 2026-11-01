/**
 * The shown session's subagents, folded from omp's `subagent_lifecycle` and
 * `subagent_progress` frames into the rows the chat's subagent panel renders.
 * Finished agents stay listed (with their final status) until the next task
 * starts, so the panel still shows how the last one went.
 */
import type {
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/wire/rpc-wire.generated";
import type { SubagentStatus, SubagentView } from "../protocol";

const STATUSES: Record<string, SubagentStatus> = {
	pending: "pending",
	running: "running",
	completed: "completed",
	failed: "failed",
	aborted: "aborted",
};

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function isActive(status: SubagentStatus): boolean {
	return status === "pending" || status === "running";
}

/** Provider retry state of an `AgentProgress` record as one short line. */
function retryLine(progress: Record<string, unknown>): string | undefined {
	const failure = record(progress.retryFailure);
	if (failure) return `Gave up retrying: ${str(failure.errorMessage) ?? "provider error"}`;
	const state = record(progress.retryState);
	if (!state) return undefined;
	const attempt = num(state.attempt);
	const max = num(state.maxAttempts);
	const counter = attempt !== undefined && max !== undefined ? ` ${attempt}/${max}` : "";
	return `Retrying${counter}: ${str(state.errorMessage) ?? "provider error"}`;
}

export class SubagentRoster {
	readonly #rows = new Map<string, SubagentView>();

	/** Rows, running first, then by when they started. */
	list(): SubagentView[] {
		return [...this.#rows.values()].sort(
			(a, b) => Number(isActive(b.status)) - Number(isActive(a.status)) || a.startedAt - b.startedAt,
		);
	}

	hasActive(): boolean {
		for (const row of this.#rows.values()) if (isActive(row.status)) return true;
		return false;
	}

	/** Forget every row (another session was opened). Returns whether anything was dropped. */
	clear(): boolean {
		const had = this.#rows.size > 0;
		this.#rows.clear();
		return had;
	}

	/** Forget finished rows (a new task starts). Returns whether anything was dropped. */
	clearFinished(): boolean {
		let dropped = false;
		for (const [id, row] of this.#rows) {
			if (isActive(row.status)) continue;
			this.#rows.delete(id);
			dropped = true;
		}
		return dropped;
	}

	/** Flag every active row as asked to wrap up. */
	markWrapUpRequested(): void {
		for (const row of this.#rows.values()) if (isActive(row.status)) row.wrapUpRequested = true;
	}

	applyLifecycle(payload: SubagentLifecyclePayload): void {
		const row = this.#rows.get(payload.id) ?? this.#create(payload.id, payload.agent);
		row.agent = payload.agent;
		row.description = str(payload.description) ?? row.description;
		row.status = payload.status === "started" ? "running" : payload.status;
		if (!isActive(row.status)) row.activity = undefined;
	}

	applyProgress(payload: SubagentProgressPayload): void {
		const progress = payload.progress;
		const id = str(progress.id);
		if (!id) return;
		const row = this.#rows.get(id) ?? this.#create(id, payload.agent);
		row.agent = payload.agent;
		// A terminal lifecycle frame is authoritative; a late progress frame must not revive the row.
		const status = STATUSES[String(progress.status)];
		if (status && isActive(row.status)) row.status = status;
		row.description = str(progress.description) ?? row.description;
		row.assignment = str(payload.assignment) ?? str(progress.assignment) ?? row.assignment;
		row.activity = isActive(row.status)
			? (str(progress.currentToolIntent) ?? str(progress.currentTool) ?? str(progress.lastIntent))
			: undefined;
		row.toolCount = num(progress.toolCount) ?? row.toolCount;
		row.requests = num(progress.requests) ?? row.requests;
		row.requestBudget = num(progress.requestBudget) ?? row.requestBudget;
		row.tokens = num(progress.tokens) ?? row.tokens;
		row.cost = num(progress.cost) ?? row.cost;
		row.durationMs = num(progress.durationMs) ?? row.durationMs;
		row.model = str(progress.resolvedModelIdentity) ?? str(progress.resolvedModel) ?? row.model;
		row.retry = retryLine(progress);
	}

	#create(id: string, agent: string): SubagentView {
		const row: SubagentView = {
			id,
			agent,
			status: "running",
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
			startedAt: Date.now(),
			wrapUpRequested: false,
		};
		this.#rows.set(id, row);
		return row;
	}
}
