import { describe, expect, it } from "bun:test";
import { TodoListTracker } from "../src/chat/todo-list";
import type { AgentMessage, TodoPhase } from "../src/protocol";

const todo = (statuses: string[], toolName = "todo"): AgentMessage =>
	({
		role: "toolResult",
		toolCallId: "t",
		toolName,
		content: [],
		isError: false,
		timestamp: 0,
		details: {
			phases: [
				{ name: "Build", tasks: statuses.map((status, i) => ({ content: `step ${i}`, status })) },
				{ name: "Empty", tasks: [] },
			] as TodoPhase[],
			storage: "session",
		},
	}) as AgentMessage;

const prompt = (fields: Record<string, unknown> = {}) =>
	({ role: "user", content: "next", timestamp: 0, ...fields }) as AgentMessage;

describe("TodoListTracker", () => {
	it("follows the latest list, without empty phases, from either todo tool name", () => {
		const tracker = new TodoListTracker();
		tracker.load([todo(["pending", "pending"], "todo_write"), todo(["completed", "in_progress"])]);
		expect(tracker.phases.map(phase => phase.name)).toEqual(["Build"]);
		expect(tracker.phases[0]?.tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
	});

	it("keeps an unfinished list through follow-ups and clears a finished one at the next prompt", () => {
		const tracker = new TodoListTracker();
		tracker.load([todo(["completed", "pending"]), prompt()]);
		expect(tracker.phases).toHaveLength(1);

		tracker.apply(todo(["completed", "abandoned"]));
		expect(tracker.apply(prompt({ steering: true }))).toBe(false);
		expect(tracker.apply(prompt({ synthetic: true }))).toBe(false);
		expect(tracker.apply(prompt())).toBe(true);
		expect(tracker.phases).toEqual([]);
	});
});
