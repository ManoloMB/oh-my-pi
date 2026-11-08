import { describe, expect, it } from "bun:test";
import {
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
	estimateAdaptiveReserveTokens,
	resolveBudgetReserveTokens,
	resolveThresholdTokens,
	shouldCompact,
} from "@oh-my-pi/pi-agent-core/compaction/compaction";
import type { SessionEntry } from "@oh-my-pi/pi-agent-core/compaction/entries";

const fixed = (thresholdTokens: number, extra: Partial<CompactionSettings> = {}): CompactionSettings => ({
	enabled: true,
	thresholdPercent: -1,
	thresholdTokens,
	keepRecentTokens: 20000,
	...extra,
});

let entrySeq = 0;

function assistantEntry(output: number, contextTokens: number): SessionEntry {
	entrySeq++;
	return {
		type: "message",
		id: `e${entrySeq}`,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "mock",
			provider: "mock",
			model: "mock-model",
			usage: {
				input: contextTokens - output,
				output,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: contextTokens,
				contextTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		},
	};
}

function compactionEntry(): SessionEntry {
	entrySeq++;
	return {
		type: "compaction",
		id: `e${entrySeq}`,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		summary: "summary",
		firstKeptEntryId: "e1",
		tokensBefore: 0,
	};
}

describe("adaptive reserve", () => {
	const outputs = [2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 5800, 6000];
	const tenTurns = outputs.map((output, i) => assistantEntry(output, 10_000 * (i + 1)));

	it("sizes the reserve from p95 output plus p95 growth plus headroom", () => {
		const reserve = estimateAdaptiveReserveTokens(tenTurns, 1_000_000);
		expect(reserve).toBe(6000 + 10_000 + 8192);
		expect(
			resolveThresholdTokens(1_000_000, { ...DEFAULT_COMPACTION_SETTINGS, adaptiveReserveTokens: reserve }),
		).toBe(1_000_000 - reserve!);
	});

	it("stays unset below the minimum sample count and keeps the legacy threshold", () => {
		const reserve = estimateAdaptiveReserveTokens(tenTurns.slice(0, 7), 1_000_000);
		expect(reserve).toBeUndefined();
		expect(
			resolveThresholdTokens(1_000_000, { ...DEFAULT_COMPACTION_SETTINGS, adaptiveReserveTokens: reserve }),
		).toBe(850_000);
	});

	it("never exceeds the 15% default reserve", () => {
		const huge = Array.from({ length: 10 }, (_, i) => assistantEntry(300_000, 310_000 + i * 1000));
		expect(estimateAdaptiveReserveTokens(huge, 1_000_000)).toBe(150_000);
	});

	it("floors at the default reserve and keeps small-window recovery", () => {
		const small = Array.from({ length: 10 }, (_, i) => assistantEntry(100, 1000 + i * 100));
		expect(estimateAdaptiveReserveTokens(small, 32_000)).toBe(16_384);
		// 16,384 leaves a 19,000 window less than its 15% budget, so recovery swaps in floor(0.15 * W).
		const reserve = estimateAdaptiveReserveTokens(small, 19_000);
		expect(reserve).toBe(16_384);
		expect(
			resolveBudgetReserveTokens(19_000, { ...DEFAULT_COMPACTION_SETTINGS, adaptiveReserveTokens: reserve }),
		).toBe(Math.floor(19_000 * 0.15));
	});

	it("records no growth across a compaction", () => {
		const entries = [
			...[100_000, 110_000, 120_000, 130_000].map(ctx => assistantEntry(1000, ctx)),
			compactionEntry(),
			...[500_000, 510_000, 520_000, 530_000].map(ctx => assistantEntry(1000, ctx)),
		];
		expect(estimateAdaptiveReserveTokens(entries, 1_000_000)).toBe(1000 + 10_000 + 8192);
	});

	it("ignores the adaptive reserve when an explicit reserve is set", () => {
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 5000, adaptiveReserveTokens: 24_192 };
		expect(resolveBudgetReserveTokens(1_000_000, settings)).toBe(150_000);
		expect(resolveThresholdTokens(1_000_000, settings)).toBe(850_000);
		expect(resolveBudgetReserveTokens(20_000, settings)).toBe(5000);
	});
});

describe("fixed compaction trigger near the window", () => {
	// A provider capping the model below the configured trigger (Factory serves Kimi K3 with 196,608).
	const window = 196_608;
	// max(floor(196608 * 0.15), 16384) = 29,491 reserved for the next prompt and response.
	const budget = window - 29_491;

	it("compacts a trigger at or past the window at the window less its reserve", () => {
		expect(resolveBudgetReserveTokens(window, fixed(300_000))).toBe(29_491);
		expect(resolveThresholdTokens(window, fixed(300_000))).toBe(budget);
		expect(resolveThresholdTokens(window, fixed(window))).toBe(budget);
		expect(shouldCompact(budget, window, fixed(300_000))).toBe(false);
		expect(shouldCompact(budget + 1, window, fixed(300_000))).toBe(true);
		// The same budget the reserve-based default compacts at.
		expect(resolveThresholdTokens(window, fixed(-1))).toBe(budget);
	});

	it("keeps a trigger below the window exact", () => {
		expect(resolveThresholdTokens(window, fixed(window - 1))).toBe(window - 1);
		expect(resolveThresholdTokens(window, fixed(budget + 1))).toBe(budget + 1);
		expect(resolveThresholdTokens(window, fixed(100_000))).toBe(100_000);
		expect(resolveThresholdTokens(1_000_000, fixed(300_000))).toBe(300_000);
	});

	it("uses an explicit reserve as the budget", () => {
		expect(resolveThresholdTokens(200_000, fixed(250_000, { reserveTokens: 50_000 }))).toBe(150_000);
		expect(resolveThresholdTokens(200_000, fixed(180_000, { reserveTokens: 50_000 }))).toBe(180_000);
	});

	it("falls back to the 15% reserve on small windows", () => {
		// The default 16,384 reserve would leave a 16,385 window one token; floor(16385 * 0.15) = 2,457 applies.
		expect(resolveBudgetReserveTokens(16_385, fixed(20_000))).toBe(2_457);
		expect(resolveThresholdTokens(16_385, fixed(20_000))).toBe(13_928);
		expect(resolveThresholdTokens(16_385, fixed(10_000))).toBe(10_000);
		// Degenerate windows stay strictly below the window and never go negative.
		expect(resolveThresholdTokens(2, fixed(5))).toBe(1);
		expect(resolveThresholdTokens(1, fixed(5))).toBe(0);
	});
});
