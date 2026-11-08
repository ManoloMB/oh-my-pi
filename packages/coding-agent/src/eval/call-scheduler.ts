/**
 * Per-cell scheduling for session tools invoked from eval code: the same
 * shared/exclusive barrier the agent loop applies to one model turn, a bound on
 * parallel fan-out, and a call allowance derived from the cell's timeout so a
 * runaway loop fails fast instead of burning the whole deadline.
 */

export class EvalCallLimitExceededError extends Error {
	constructor(limit: number, callsPerMinute: number, callNumber: number) {
		super(
			`eval cell exceeded its limit of ${limit} tool calls (${callsPerMinute} per minute of its timeout); call ${callNumber} was not dispatched. The cell may be looping without bound; check loop termination, raise the cell's timeout, or split the work into smaller cells.`,
		);
		this.name = "EvalCallLimitExceededError";
	}
}

/** Calls one cell may attempt: `callsPerMinute` per minute of its idle timeout. `Infinity` when uncapped. */
export function computeEvalCallAllowance(idleTimeoutMs: number | undefined, callsPerMinute: number): number {
	if (callsPerMinute <= 0 || idleTimeoutMs === undefined) return Infinity;
	return Math.max(0, Math.floor((idleTimeoutMs / 60_000) * callsPerMinute));
}

export interface EvalCallSchedulerOptions {
	maxParallel: number;
	maxCalls: number;
	callsPerMinute: number;
}

interface QueuedAcquire {
	mode: "shared" | "exclusive";
	resolve: (release: () => void) => void;
	reject: (reason: unknown) => void;
	detach?: () => void;
}

export class EvalCallScheduler {
	readonly #maxParallel: number;
	readonly #maxCalls: number;
	readonly #callsPerMinute: number;
	#attempts = 0;
	#poison: EvalCallLimitExceededError | undefined;
	#active = 0;
	#exclusiveActive = false;
	readonly #queue: QueuedAcquire[] = [];

	constructor(options: EvalCallSchedulerOptions) {
		this.#maxParallel = Math.max(1, Math.floor(options.maxParallel) || 1);
		this.#maxCalls = options.maxCalls;
		this.#callsPerMinute = options.callsPerMinute;
	}

	/** Counts one call attempt; throws once the allowance is exhausted and on every attempt after. */
	recordAttempt(): void {
		if (this.#poison) throw this.#poison;
		this.#attempts++;
		if (this.#attempts > this.#maxCalls) {
			this.#poison = new EvalCallLimitExceededError(this.#maxCalls, this.#callsPerMinute, this.#attempts);
			throw this.#poison;
		}
	}

	/** Waits FIFO for a slot; resolves with an idempotent release. */
	acquire(mode: "shared" | "exclusive", signal?: AbortSignal): Promise<() => void> {
		if (this.#poison) return Promise.reject(this.#poison);
		if (signal?.aborted) return Promise.reject(signal.reason);
		if (this.#queue.length === 0 && this.#hasCapacity(mode)) {
			return Promise.resolve(this.#admit(mode));
		}
		const { promise, resolve, reject } = Promise.withResolvers<() => void>();
		const entry: QueuedAcquire = { mode, resolve, reject };
		if (signal) {
			const onAbort = (): void => {
				const index = this.#queue.indexOf(entry);
				if (index === -1) return;
				this.#queue.splice(index, 1);
				reject(signal.reason);
				// The aborted head may have been blocking admissible entries behind it.
				this.#drain();
			};
			signal.addEventListener("abort", onAbort, { once: true });
			entry.detach = () => signal.removeEventListener("abort", onAbort);
		}
		this.#queue.push(entry);
		return promise;
	}

	#hasCapacity(mode: "shared" | "exclusive"): boolean {
		if (this.#exclusiveActive) return false;
		return mode === "exclusive" ? this.#active === 0 : this.#active < this.#maxParallel;
	}

	#admit(mode: "shared" | "exclusive"): () => void {
		this.#active++;
		if (mode === "exclusive") this.#exclusiveActive = true;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#active--;
			if (mode === "exclusive") this.#exclusiveActive = false;
			this.#drain();
		};
	}

	#drain(): void {
		while (this.#queue.length > 0) {
			const head = this.#queue[0];
			if (!this.#hasCapacity(head.mode)) return;
			this.#queue.shift();
			head.detach?.();
			head.resolve(this.#admit(head.mode));
		}
	}
}
