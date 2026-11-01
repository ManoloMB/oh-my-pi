import { describe, expect, it } from "bun:test";
import { SubagentRoster } from "../src/chat/subagent-roster";

const progress = (id: string, fields: Record<string, unknown>) => ({
	index: 0,
	agent: "task",
	agentSource: "bundled" as const,
	task: "t",
	assignment: "Refactor the parser\nKeep the API",
	progress: { id, status: "running", toolCount: 3, requests: 4, requestBudget: 40, ...fields },
});

describe("SubagentRoster", () => {
	it("folds progress into a row, then keeps a finished row's terminal status against late progress", () => {
		const roster = new SubagentRoster();
		roster.applyLifecycle({ id: "Parser", agent: "task", agentSource: "bundled", status: "started", index: 0 });
		roster.applyProgress(progress("Parser", { currentToolIntent: "Reading parser.ts" }));
		expect(roster.list()[0]).toMatchObject({
			status: "running",
			activity: "Reading parser.ts",
			requests: 4,
			requestBudget: 40,
			assignment: "Refactor the parser\nKeep the API",
		});

		roster.applyLifecycle({ id: "Parser", agent: "task", agentSource: "bundled", status: "completed", index: 0 });
		roster.applyProgress(progress("Parser", { status: "running", currentToolIntent: "late" }));
		expect(roster.list()[0]).toMatchObject({ status: "completed", activity: undefined });
		expect(roster.hasActive()).toBe(false);
	});

	it("lists running rows first and drops only finished rows for a new task", () => {
		const roster = new SubagentRoster();
		roster.applyLifecycle({ id: "Done", agent: "scout", agentSource: "bundled", status: "started", index: 0 });
		roster.applyLifecycle({ id: "Done", agent: "scout", agentSource: "bundled", status: "failed", index: 0 });
		roster.applyLifecycle({ id: "Live", agent: "task", agentSource: "bundled", status: "started", index: 1 });
		expect(roster.list().map(row => row.id)).toEqual(["Live", "Done"]);

		roster.markWrapUpRequested();
		expect(roster.list().map(row => row.wrapUpRequested)).toEqual([true, false]);

		expect(roster.clearFinished()).toBe(true);
		expect(roster.list().map(row => row.id)).toEqual(["Live"]);
	});
});
