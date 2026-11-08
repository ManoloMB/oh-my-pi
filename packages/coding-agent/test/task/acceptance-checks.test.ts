import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	MAX_ACCEPTANCE_CRITERIA,
	normalizeAcceptanceCriteria,
	runAcceptanceChecks,
} from "@oh-my-pi/pi-coding-agent/task/acceptance-checks";
import type { ToolReceipt } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";

function bashReceipt(seq: number, command: string, overrides: Partial<ToolReceipt> = {}): ToolReceipt {
	return {
		id: `r${seq}`,
		seq,
		toolCallId: `tc-${seq}`,
		toolName: "bash",
		status: "ok",
		command,
		testOutcome: "passed",
		at: 0,
		...overrides,
	};
}

describe("runAcceptanceChecks", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-acceptance-checks-");
	});

	afterEach(() => {
		tempDir.removeSync();
	});

	async function check(criterion: string, options: { receipts?: ToolReceipt[]; workspaceApplied?: boolean } = {}) {
		const [result] = await runAcceptanceChecks({
			criteria: [criterion],
			cwd: tempDir.path(),
			receipts: options.receipts,
			workspaceApplied: options.workspaceApplied ?? true,
		});
		return result!;
	}

	it("checks file existence", async () => {
		await Bun.write(path.join(tempDir.path(), "out.txt"), "hi");
		expect((await check("file:out.txt exists")).outcome).toBe("holds");
		expect(await check("file:missing.txt exists")).toMatchObject({ outcome: "does-not-hold", detail: "not found" });
	});

	it("flags an empty file under non-empty", async () => {
		await Bun.write(path.join(tempDir.path(), "empty.txt"), "");
		expect(await check("file:`empty.txt` non-empty")).toMatchObject({
			outcome: "does-not-hold",
			detail: "empty file",
		});
	});

	it("validates JSON", async () => {
		await Bun.write(path.join(tempDir.path(), "good.json"), '{"ok":true}');
		await Bun.write(path.join(tempDir.path(), "bad.json"), "{ok:");
		expect((await check("file:good.json json-valid")).outcome).toBe("holds");
		expect((await check("file:bad.json json-valid")).outcome).toBe("does-not-hold");
	});

	it("checks CSV header columns with quoted fields", async () => {
		await Bun.write(path.join(tempDir.path(), "data.csv"), 'id,"name",age\n1,"a",3\n');
		expect((await check("file:data.csv csv-columns:id,name")).outcome).toBe("holds");
		expect(await check("file:data.csv csv-columns:id,email")).toMatchObject({
			outcome: "does-not-hold",
			detail: "missing: email",
		});
	});

	it("matches tests_passed against recorded bash receipts", async () => {
		expect(
			await check("tests_passed:bun test", { receipts: [bashReceipt(2, "cd x && bun test foo.test.ts")] }),
		).toMatchObject({ outcome: "holds", detail: "[r2]" });
		expect(await check("tests_passed:bun test", { receipts: [bashReceipt(1, "echo bun test")] })).toMatchObject({
			outcome: "unverified",
			detail: "no recorded run of this command",
		});
		expect(
			await check("tests_passed:bun test", {
				receipts: [bashReceipt(3, "bun test", { status: "error", exitCode: 1, testOutcome: "failed" })],
			}),
		).toMatchObject({ outcome: "does-not-hold", detail: "[r3] exit 1" });
	});

	it("reports tests_passed unverified without an execution record", async () => {
		expect((await check("tests_passed:bun test")).outcome).toBe("unverified");
	});

	it("leaves file criteria unverified when isolated changes were not applied", async () => {
		await Bun.write(path.join(tempDir.path(), "out.txt"), "hi");
		expect(await check("file:out.txt exists", { workspaceApplied: false })).toMatchObject({
			outcome: "unverified",
			detail: "isolated run: changes not applied to the workspace",
		});
	});

	it("reports free text as not checkable", async () => {
		expect(await check("the code is clean")).toMatchObject({
			outcome: "unverified",
			detail: "not a checkable criterion",
		});
	});
});

describe("normalizeAcceptanceCriteria", () => {
	it("trims, drops empties and non-strings, and caps the list", () => {
		const raw = ["  a  ", "", 3, ...Array.from({ length: 20 }, (_, i) => `c${i}`)];
		const criteria = normalizeAcceptanceCriteria(raw);
		expect(criteria[0]).toBe("a");
		expect(criteria).toHaveLength(MAX_ACCEPTANCE_CRITERIA);
	});
});
