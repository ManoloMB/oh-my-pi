import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	classifyTestOutcome,
	deriveToolReceipts,
	mintToolReceipt,
	parseReceiptCitations,
	TOOL_RECEIPT_CUSTOM_TYPE,
	verifyReceiptCitations,
} from "@oh-my-pi/pi-coding-agent/session/tool-receipts";
import type { ToolReceipt } from "@oh-my-pi/pi-tui/tools/task";

function receipt(seq: number, toolName: string, status: "ok" | "error"): ToolReceipt {
	return { id: `r${seq}`, seq, toolCallId: `tc-${seq}`, toolName, status, at: 0 };
}

describe("classifyTestOutcome", () => {
	it("recognizes pass and fail summaries", () => {
		expect(classifyTestOutcome("12 pass\n0 fail", false)).toBe("passed");
		expect(classifyTestOutcome("3 failed, 9 passed", false)).toBe("failed");
		expect(classifyTestOutcome("ok  \tpkg 0.2s", false)).toBe("passed");
		expect(classifyTestOutcome("hello", false)).toBe("none");
	});

	it("treats any errored call as failed", () => {
		expect(classifyTestOutcome("12 pass\n0 fail", true)).toBe("failed");
		expect(classifyTestOutcome("hello", true)).toBe("failed");
	});
});

describe("mintToolReceipt", () => {
	it("records bash command, exit code and test outcome", () => {
		const minted = mintToolReceipt({
			seq: 4,
			toolCallId: "tc-4",
			toolName: "bash",
			isError: true,
			args: { command: "bun   test\n  foo.test.ts" },
			result: { content: [{ type: "text", text: "1 failed" }], details: { exitCode: 1 } },
		});
		expect(minted).toMatchObject({
			id: "r4",
			seq: 4,
			status: "error",
			command: "bun test foo.test.ts",
			exitCode: 1,
			testOutcome: "failed",
		});
	});

	it("omits bash-only fields for other tools", () => {
		const minted = mintToolReceipt({
			seq: 1,
			toolCallId: "tc-1",
			toolName: "edit",
			isError: false,
			args: { path: "a.ts" },
			result: { content: [{ type: "text", text: "ok" }] },
		});
		expect(minted.status).toBe("ok");
		expect(minted.command).toBeUndefined();
		expect(minted.testOutcome).toBeUndefined();
	});
});

describe("deriveToolReceipts", () => {
	it("returns well-formed receipt entries in order and skips malformed ones", () => {
		const base = { parentId: null, timestamp: new Date(0).toISOString() };
		const entries = [
			{ ...base, id: "a", type: "custom", customType: TOOL_RECEIPT_CUSTOM_TYPE, data: receipt(1, "read", "ok") },
			{ ...base, id: "b", type: "custom", customType: TOOL_RECEIPT_CUSTOM_TYPE, data: { id: "r2" } },
			{ ...base, id: "c", type: "custom", customType: "other", data: receipt(3, "read", "ok") },
			{ ...base, id: "d", type: "custom", customType: TOOL_RECEIPT_CUSTOM_TYPE, data: receipt(2, "bash", "error") },
		] as unknown as SessionEntry[];
		expect(deriveToolReceipts(entries).map(r => r.id)).toEqual(["r1", "r2"]);
	});
});

describe("receipt citations", () => {
	it("parses and dedupes citations by id and anchor", () => {
		expect(parseReceiptCitations("[r1] [r1] [r2 bash] [r2] [r0] [x1]")).toEqual([
			{ id: "r1" },
			{ id: "r2", anchor: "bash" },
			{ id: "r2" },
		]);
	});

	it("counts resolved, failed and unknown citations", () => {
		const receipts = [receipt(1, "edit", "ok"), receipt(2, "bash", "error")];
		expect(verifyReceiptCitations("[r1] [r2 bash] [r9]", receipts)).toEqual({
			cited: 3,
			resolved: 1,
			failed: 1,
			unknown: 1,
		});
	});

	it("counts an anchor mismatch as failed", () => {
		expect(verifyReceiptCitations("[r1 write]", [receipt(1, "edit", "ok")])).toEqual({
			cited: 1,
			resolved: 0,
			failed: 1,
			unknown: 0,
		});
	});
});
