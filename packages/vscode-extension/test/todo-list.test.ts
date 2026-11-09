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

	it("keeps an unfinished list through the next prompt and clears a finished one at the next prompt", () => {
		const tracker = new TodoListTracker();
		tracker.load([todo(["completed", "pending"]), prompt()]);
		expect(tracker.phases).toHaveLength(1);

		tracker.apply(todo(["completed", "abandoned"]));
		expect(tracker.apply(prompt({ steering: true }))).toBe(false);
		expect(tracker.apply(prompt({ synthetic: true }))).toBe(false);
		expect(tracker.apply(prompt())).toBe(true);
		expect(tracker.phases).toEqual([]);
	});

	it("clears an unfinished list omp left untouched through a whole request", () => {
		const tracker = new TodoListTracker();
		tracker.load([todo(["completed", "in_progress"]), prompt()]);
		expect(tracker.phases).toHaveLength(1);
		expect(tracker.apply(prompt())).toBe(true);
		expect(tracker.phases).toEqual([]);

		// Writing the list again brings it back.
		expect(tracker.apply(todo(["completed", "blocked"]))).toBe(true);
		expect(tracker.phases[0]?.tasks.map(task => task.status)).toEqual(["completed", "blocked"]);
	});

	it("adopts omp's list when it was edited outside the tool, and keeps an ended list hidden otherwise", () => {
		const tracker = new TodoListTracker();
		tracker.load([todo(["completed", "pending"])]);
		expect(tracker.sync([])).toBe(true);
		expect(tracker.phases).toEqual([]);

		tracker.load([todo(["completed", "completed"]), prompt()]);
		const finished: TodoPhase[] = [
			{
				name: "Build",
				tasks: [
					{ content: "step 0", status: "completed" },
					{ content: "step 1", status: "completed" },
				],
			},
		];
		expect(tracker.sync(finished)).toBe(false);
		expect(tracker.phases).toEqual([]);

		const edited: TodoPhase[] = [{ name: "Fix", tasks: [{ content: "redo", status: "pending" }] }];
		expect(tracker.sync(edited)).toBe(true);
		expect(tracker.phases).toEqual(edited);
		// A user-edited list counts as touched: the next prompt keeps it.
		expect(tracker.apply(prompt())).toBe(false);
		expect(tracker.phases).toEqual(edited);
	});
});
