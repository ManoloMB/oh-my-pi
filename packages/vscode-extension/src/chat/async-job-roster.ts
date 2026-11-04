/**
 * The shown session's background jobs (async bash, task and eval), folded from
 * omp's `get_async_jobs` answers into the rows the chat's jobs popup renders.
 * omp evicts a settled job shortly after delivering its result, so settled
 * jobs stay listed here (with their final status) until the next task starts.
 * A running job that vanishes from omp's list without a final status is
 * dropped: its outcome is unknown.
 */
import type { AsyncJob } from "../protocol";

export class AsyncJobRoster {
	readonly #jobs = new Map<string, AsyncJob>();

	/** Fold one `get_async_jobs` answer in; true when the rows changed. */
	apply(jobs: readonly AsyncJob[]): boolean {
		const before = this.#serialized();
		const listed = new Set(jobs.map(job => job.id));
		for (const [id, job] of this.#jobs) {
			if (!listed.has(id) && job.status === "running") this.#jobs.delete(id);
		}
		for (const job of jobs) this.#jobs.set(job.id, job);
		return this.#serialized() !== before;
	}

	/** Running jobs first (oldest first), then settled ones (latest settled first). */
	list(): AsyncJob[] {
		const running = [...this.#jobs.values()].filter(job => job.status === "running");
		const settled = [...this.#jobs.values()].filter(job => job.status !== "running");
		running.sort((a, b) => a.startTime - b.startTime);
		settled.sort((a, b) => (b.endTime ?? b.startTime) - (a.endTime ?? a.startTime));
		return [...running, ...settled];
	}

	get running(): boolean {
		for (const job of this.#jobs.values()) if (job.status === "running") return true;
		return false;
	}

	/** A new task starts: forget the settled jobs; true when any was listed. */
	clearFinished(): boolean {
		let changed = false;
		for (const [id, job] of this.#jobs) {
			if (job.status === "running") continue;
			this.#jobs.delete(id);
			changed = true;
		}
		return changed;
	}

	/** Another session or process: forget every job; true when any was listed. */
	clear(): boolean {
		const changed = this.#jobs.size > 0;
		this.#jobs.clear();
		return changed;
	}

	#serialized(): string {
		return JSON.stringify(this.list());
	}
}
