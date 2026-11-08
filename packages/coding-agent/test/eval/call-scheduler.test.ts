import { describe, expect, test } from "bun:test";
import { computeEvalCallAllowance, EvalCallScheduler } from "../../src/eval/call-scheduler";

function scheduler(maxParallel: number, maxCalls = Infinity): EvalCallScheduler {
	return new EvalCallScheduler({ maxParallel, maxCalls, callsPerMinute: 1024 });
}

/** Drains pending microtasks so any admission the scheduler granted has run its continuation. */
async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("computeEvalCallAllowance", () => {
	test("scales calls per minute by the cell timeout", () => {
		expect(computeEvalCallAllowance(30_000, 1024)).toBe(512);
	});

	test("is uncapped without a timeout or with the cap disabled", () => {
		expect(computeEvalCallAllowance(undefined, 1024)).toBe(Infinity);
		expect(computeEvalCallAllowance(60_000, 0)).toBe(Infinity);
	});
});

describe("EvalCallScheduler", () => {
	test("admits shared calls up to maxParallel and queues the rest until a release", async () => {
		const s = scheduler(2);
		const first = await s.acquire("shared");
		const second = await s.acquire("shared");
		let thirdAdmitted = false;
		const third = s.acquire("shared").then(release => {
			thirdAdmitted = true;
			return release;
		});
		await flush();
		expect(thirdAdmitted).toBe(false);

		first();
		(await third)();
		expect(thirdAdmitted).toBe(true);
		second();
	});

	test("an exclusive call waits for in-flight shared calls and blocks later ones", async () => {
		const s = scheduler(4);
		const shared1 = await s.acquire("shared");
		const shared2 = await s.acquire("shared");
		const order: string[] = [];
		const exclusive = s.acquire("exclusive").then(release => {
			order.push("exclusive");
			return release;
		});
		const later = s.acquire("shared").then(release => {
			order.push("later");
			return release;
		});
		await flush();
		expect(order).toEqual([]);

		shared1();
		await flush();
		expect(order).toEqual([]);

		shared2();
		const releaseExclusive = await exclusive;
		await flush();
		expect(order).toEqual(["exclusive"]);

		releaseExclusive();
		(await later)();
		expect(order).toEqual(["exclusive", "later"]);
	});

	test("release is idempotent", async () => {
		const s = scheduler(1);
		const release = await s.acquire("shared");
		release();
		release();
		const a = await s.acquire("shared");
		let bAdmitted = false;
		const b = s.acquire("shared").then(r => {
			bAdmitted = true;
			return r;
		});
		await flush();
		// A double release must not have freed a phantom slot.
		expect(bAdmitted).toBe(false);
		a();
		(await b)();
	});

	test("rejects the attempt that exceeds maxCalls and every attempt after it", () => {
		const s = scheduler(10, 2);
		s.recordAttempt();
		s.recordAttempt();
		expect(() => s.recordAttempt()).toThrow(/exceeded its limit of 2 tool calls/);
		expect(() => s.recordAttempt()).toThrow(/exceeded its limit of 2 tool calls/);
	});

	test("the limit error names itself and the call number", () => {
		const s = scheduler(10, 0);
		try {
			s.recordAttempt();
			throw new Error("expected recordAttempt to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).name).toBe("EvalCallLimitExceededError");
			expect((error as Error).message).toContain("call 1 was not dispatched");
		}
	});

	test("aborting a queued entry rejects only it; a later entry is still admitted", async () => {
		const s = scheduler(1);
		const holder = await s.acquire("shared");
		const controller = new AbortController();
		const aborted = s.acquire("shared", controller.signal);
		const survivor = s.acquire("shared");
		const reason = new Error("cancelled");
		controller.abort(reason);
		await expect(aborted).rejects.toBe(reason);

		holder();
		const release = await survivor;
		expect(typeof release).toBe("function");
		release();
	});
});
