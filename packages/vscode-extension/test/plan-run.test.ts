import { describe, expect, it } from "bun:test";
import { PlanRunTracker } from "../src/chat/plan-run";
import type { AgentMessage, TodoPhase } from "../src/protocol";

function toolResult(toolCallId: string, toolName: string, details: unknown): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [],
		isError: false,
		timestamp: 0,
		details,
	} as AgentMessage;
}

const approval = (id: string, approved = true) =>
	toolResult(id, "write", { planFilePath: "local://auth-plan.md", title: "auth", planExists: true, approved });

const todo = (statuses: string[]): AgentMessage =>
	toolResult("t", "todo", {
		phases: [
			{ name: "Build", tasks: statuses.map((status, i) => ({ content: `step ${i}`, status })) },
		] as TodoPhase[],
		storage: "session",
	});

const prompt = (fields: Record<string, unknown> = {}) =>
	({ role: "user", content: "next", timestamp: 0, ...fields }) as AgentMessage;

describe("PlanRunTracker", () => {
	it("starts at an approval, ignores step lists from before it, and moves through its statuses", () => {
		const tracker = new PlanRunTracker();
		tracker.load([todo(["pending"]), approval("refine", false)]);
		expect(tracker.view(true)).toBeNull();

		tracker.apply(approval("a"));
		expect(tracker.view(true)).toEqual({ title: "auth", status: "starting", phases: [] });

		tracker.apply(todo(["completed", "in_progress"]));
		expect(tracker.view(true)?.status).toBe("running");
		expect(tracker.view(false)?.status).toBe("paused");

		tracker.apply(todo(["completed", "abandoned"]));
		expect(tracker.view(false)?.status).toBe("done");
	});

	it("keeps an unfinished run through follow-ups and ends a finished one at the next prompt", () => {
		const tracker = new PlanRunTracker();
		tracker.load([approval("a"), todo(["completed", "pending"]), prompt(), prompt({ steering: true })]);
		expect(tracker.id).toBe("a");

		tracker.apply(todo(["completed", "completed"]));
		expect(tracker.apply(prompt({ steering: true }))).toBe(false);
		expect(tracker.apply(prompt({ synthetic: true }))).toBe(false);
		expect(tracker.apply(prompt())).toBe(true);
		expect(tracker.view(false)).toBeNull();
	});
});
