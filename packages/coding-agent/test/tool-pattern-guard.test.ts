import { describe, expect, it } from "bun:test";
import { ToolPatternGuard, type ToolPatternGuardOptions } from "@oh-my-pi/pi-coding-agent/session/tool-pattern-guard";

const frequencyOnly: ToolPatternGuardOptions = {
	frequencyThreshold: 3,
	frequencyExempt: new Set(["edit"]),
	alternation: false,
};

const alternationOnly: ToolPatternGuardOptions = {
	frequencyThreshold: 0,
	frequencyExempt: new Set(),
	alternation: true,
};

describe("ToolPatternGuard frequency", () => {
	it("fires at the threshold, then again every 15 calls", () => {
		const guard = new ToolPatternGuard();
		const firedAt: number[] = [];
		for (let call = 1; call <= 18; call++) {
			const detections = guard.record({ toolName: "read", isError: false }, frequencyOnly);
			if (detections.length > 0) {
				expect(detections).toEqual([{ kind: "frequency", toolName: "read", count: call, window: 50 }]);
				firedAt.push(call);
			}
		}
		expect(firedAt).toEqual([3, 18]);
	});

	it("never fires for an exempt tool", () => {
		const guard = new ToolPatternGuard();
		for (let call = 0; call < 40; call++) {
			expect(guard.record({ toolName: "edit", isError: false }, frequencyOnly)).toEqual([]);
		}
	});
});

describe("ToolPatternGuard alternation", () => {
	it("fires once when two tools keep failing in turn", () => {
		const guard = new ToolPatternGuard();
		expect(guard.record({ toolName: "edit", isError: true }, alternationOnly)).toEqual([]);
		expect(guard.record({ toolName: "bash", isError: true }, alternationOnly)).toEqual([]);
		expect(guard.record({ toolName: "edit", isError: true }, alternationOnly)).toEqual([]);
		expect(guard.record({ toolName: "bash", isError: true }, alternationOnly)).toEqual([
			{ kind: "alternation", first: "edit", second: "bash" },
		]);
		expect(guard.record({ toolName: "edit", isError: true }, alternationOnly)).toEqual([]);
	});

	it("re-arms after any successful call", () => {
		const guard = new ToolPatternGuard();
		for (const toolName of ["edit", "bash", "edit"]) guard.record({ toolName, isError: true }, alternationOnly);
		expect(guard.record({ toolName: "bash", isError: true }, alternationOnly)).toHaveLength(1);
		guard.record({ toolName: "read", isError: false }, alternationOnly);
		for (const toolName of ["edit", "bash", "edit"]) guard.record({ toolName, isError: true }, alternationOnly);
		expect(guard.record({ toolName: "bash", isError: true }, alternationOnly)).toEqual([
			{ kind: "alternation", first: "edit", second: "bash" },
		]);
	});

	it("ignores failures grouped by tool", () => {
		const guard = new ToolPatternGuard();
		for (const toolName of ["edit", "edit", "bash", "bash"]) {
			expect(guard.record({ toolName, isError: true }, alternationOnly)).toEqual([]);
		}
	});
});
