import { describe, expect, it } from "bun:test";
import { AsyncJobRoster } from "../src/chat/async-job-roster";
import type { AsyncJob } from "../src/protocol";

const job = (id: string, fields: Partial<AsyncJob> = {}): AsyncJob => ({
	id,
	type: "bash",
	status: "running",
	label: `run ${id}`,
	startTime: 1000,
	...fields,
});

describe("AsyncJobRoster", () => {
	it("keeps settled jobs omp evicted, drops running ones that vanished without an outcome", () => {
		const roster = new AsyncJobRoster();
		roster.apply([job("bg_1"), job("bg_2")]);
		roster.apply([job("bg_1", { status: "completed", endTime: 3000 }), job("bg_2")]);
		// omp evicts bg_1 after delivering it; bg_2 disappears while still running.
		expect(roster.apply([])).toBe(true);
		expect(roster.list().map(row => [row.id, row.status])).toEqual([["bg_1", "completed"]]);
		expect(roster.running).toBe(false);
		expect(roster.apply([])).toBe(false);
	});

	it("lists running jobs oldest first, then settled ones latest first, and a new task keeps only running ones", () => {
		const roster = new AsyncJobRoster();
		roster.apply([
			job("bg_1", { status: "failed", startTime: 100, endTime: 200 }),
			job("bg_2", { startTime: 500 }),
			job("bg_3", { status: "cancelled", startTime: 150, endTime: 900 }),
			job("bg_4", { startTime: 300 }),
		]);
		expect(roster.list().map(row => row.id)).toEqual(["bg_4", "bg_2", "bg_3", "bg_1"]);
		expect(roster.clearFinished()).toBe(true);
		expect(roster.list().map(row => row.id)).toEqual(["bg_4", "bg_2"]);
	});
});
