import { describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EvalCallScheduler } from "@oh-my-pi/pi-coding-agent/eval/call-scheduler";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import type { EvalShadowCellSession } from "@oh-my-pi/pi-coding-agent/eval/speculation/cell-session";
import { type TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { ToolCallError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { TodoTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

function createTool(name: string, execute: AgentTool["execute"]): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({}),
		concurrency: "parallel",
		execute,
	} as unknown as AgentTool;
}

function createSchemaTool(name: string, parameters: Record<string, unknown>): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters,
		concurrency: "parallel",
		execute: async (_id: string, args: unknown) => ({
			content: [
				{
					type: "text" as const,
					text: `${typeof (args as Record<string, unknown>)[INTENT_FIELD]}:${String((args as Record<string, unknown>)[INTENT_FIELD])}`,
				},
			],
		}),
	} as unknown as AgentTool;
}

function createSession(tools: AgentTool[]): ToolSession {
	const registry = new Map(tools.map(tool => [tool.name, tool]));
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		getToolByName: name => registry.get(name),
	};
}

describe("callSessionTool", () => {
	it("summarizes text results into the bridge value and status event", async () => {
		const execute = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "hello" }],
		});
		const session = createSession([createTool("read", execute)]);
		const statuses: Array<Record<string, unknown>> = [];

		const result = await callSessionTool(
			"read",
			{ path: "/tmp/demo.txt" },
			{
				session,
				emitStatus: event => {
					statuses.push(event);
				},
			},
		);

		expect(result).toBe("hello");
		expect(statuses).toEqual([expect.objectContaining({ op: "read", path: "/tmp/demo.txt", chars: 5 })]);
	});

	it("settles an interrupted speculative wait without starting ordinary tool execution", async () => {
		const started = Promise.withResolvers<void>();
		const controller = new AbortController();
		const lateClaim = Promise.withResolvers<undefined>();
		const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ordinary" }] });
		const shadowCell = {
			async claim(
				_name: string,
				_args: unknown,
				_identity: { siteId: string; occurrence: number },
				_remainingTimeoutMs: number,
				_signal?: AbortSignal,
			) {
				started.resolve();
				return await lateClaim.promise;
			},
		} as unknown as EvalShadowCellSession;
		const call = callSessionTool(
			"read",
			{ path: "/tmp/waiting.txt" },
			{
				session: createSession([createTool("read", execute)]),
				signal: controller.signal,
				identity: { siteId: "site-1", occurrence: 0 },
				shadowCell,
			},
		);

		await started.promise;
		controller.abort();

		await expect(call).rejects.toThrow();
		expect(execute).not.toHaveBeenCalled();
		lateClaim.reject(new Error("late speculative failure"));
		await Promise.resolve();
	});

	it("validates optional nulls before executing a real todo tool", async () => {
		let phases: TodoPhase[] = [
			{
				name: "Regression",
				tasks: [{ content: "Exercise bridge", status: "in_progress" }],
			},
		];
		const session: ToolSession = {
			...createSession([]),
			getTodoPhases: () => phases,
			setTodoPhases: next => {
				phases = next;
			},
			getToolByName: name => (name === "todo" ? (todoTool as unknown as AgentTool) : undefined),
		};
		const todoTool = new TodoTool(session);

		const result = await callSessionTool(
			"todo",
			{
				op: "done",
				phase: "Regression",
				list: null,
				task: null,
				items: null,
				reason: null,
			},
			{ session },
		);

		// A failed call throws ToolCallError; resolving with the typed `{ text, details }` shape means success.
		expect(result).toMatchObject({ details: { storage: expect.any(String) } });
		expect(phases[0]?.tasks.map(task => task.status)).toEqual(["completed"]);
	});

	it("rejects null for a required field before executing a strict tool", async () => {
		const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "unexpected" }] });
		const tool: AgentTool = {
			name: "strict",
			label: "strict",
			description: "strict tool",
			parameters: type({ value: "string" }),
			concurrency: "parallel",
			execute,
		} as unknown as AgentTool;
		await expect(callSessionTool("strict", { value: null }, { session: createSession([tool]) })).rejects.toThrow(
			"Validation failed",
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it("executes a closed-schema tool with schema-shaped args whether or not the caller supplies harness intent", async () => {
		const received: unknown[] = [];
		const tool: AgentTool = {
			name: "strict-extension",
			label: "strict extension",
			description: "rejects undeclared keys like a strict backing server",
			parameters: { type: "object", properties: { value: { type: "string" } }, additionalProperties: false },
			concurrency: "parallel",
			execute: async (_id: string, args: unknown) => {
				const extra = Object.keys(args as Record<string, unknown>).filter(key => key !== "value");
				if (extra.length > 0) throw new Error(`Invalid params: unexpected parameters: ${JSON.stringify(extra)}`);
				received.push(args);
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		} as unknown as AgentTool;
		const session = createSession([tool]);
		expect(await callSessionTool("strict-extension", { value: "x" }, { session })).toBe("ok");
		expect(
			await callSessionTool("strict-extension", { value: "x", [INTENT_FIELD]: "caller intent" }, { session }),
		).toBe("ok");
		expect(received).toEqual([{ value: "x" }, { value: "x" }]);
	});

	it("validates and preserves a schema-declared intent field", async () => {
		const execute = async (_id: string, args: unknown) => ({
			content: [
				{
					type: "text" as const,
					text: `${typeof (args as Record<string, unknown>)[INTENT_FIELD]}:${String((args as Record<string, unknown>)[INTENT_FIELD])}`,
				},
			],
		});
		const tool: AgentTool = {
			name: "required-intent",
			label: "required intent",
			description: "required intent tool",
			parameters: type({ [INTENT_FIELD]: "number" }),
			concurrency: "parallel",
			execute,
		} as unknown as AgentTool;

		const result = await callSessionTool(
			"required-intent",
			{ [INTENT_FIELD]: "5" },
			{ session: createSession([tool]) },
		);

		expect(result).toBe("number:5");
	});

	it("preserves a required-only intent field", async () => {
		const tool = createSchemaTool("required-only-intent", {
			type: "object",
			required: [INTENT_FIELD],
		});

		expect(
			await callSessionTool(
				"required-only-intent",
				{ [INTENT_FIELD]: "caller intent" },
				{ session: createSession([tool]) },
			),
		).toBe("string:caller intent");
	});

	it("preserves intent required by a dependent property", async () => {
		const tool = createSchemaTool("dependent-required-intent", {
			type: "object",
			properties: { mode: { type: "string" } },
			dependentRequired: { mode: [INTENT_FIELD] },
		});

		expect(
			await callSessionTool(
				"dependent-required-intent",
				{ mode: "active", [INTENT_FIELD]: "caller intent" },
				{ session: createSession([tool]) },
			),
		).toBe("string:caller intent");
	});

	it("rejects a missing field required by supplied intent", async () => {
		const tool = createSchemaTool("intent-dependent-trigger", {
			type: "object",
			dependentRequired: { [INTENT_FIELD]: ["value"] },
		});
		const execute = vi.fn(tool.execute);
		tool.execute = execute;

		await expect(
			callSessionTool(
				"intent-dependent-trigger",
				{ [INTENT_FIELD]: "caller intent" },
				{ session: createSession([tool]) },
			),
		).rejects.toThrow("Validation failed");
		expect(execute).not.toHaveBeenCalled();
	});

	it("drops harness intent when propertyNames does not open a closed schema", async () => {
		const tool = createSchemaTool("closed-property-names", {
			type: "object",
			properties: { value: {} },
			propertyNames: { type: "string" },
			additionalProperties: false,
		});
		expect(
			await callSessionTool(
				"closed-property-names",
				{ value: "x", i: "caller intent" },
				{ session: createSession([tool]) },
			),
		).toBe("undefined:undefined");
	});

	it.each(["const", "enum"] as const)("preserves intent in object-valued %s", async keyword => {
		const tool = createSchemaTool("object-constraint", {
			type: "object",
			[keyword]: keyword === "const" ? { i: "token" } : [{ i: "token" }],
		});
		expect(await callSessionTool("object-constraint", { i: "token" }, { session: createSession([tool]) })).toBe(
			"string:token",
		);
	});

	it("preserves intent admitted by propertyNames", async () => {
		const tool = createSchemaTool("property-name-intent", {
			type: "object",
			propertyNames: { const: INTENT_FIELD },
			minProperties: 1,
		});

		expect(
			await callSessionTool(
				"property-name-intent",
				{ [INTENT_FIELD]: "caller intent" },
				{ session: createSession([tool]) },
			),
		).toBe("string:caller intent");
	});

	it("preserves intent admitted by referenced propertyNames", async () => {
		const tool = createSchemaTool("referenced-property-name-intent", {
			type: "object",
			propertyNames: { $ref: "#/$defs/intentName" },
			minProperties: 1,
			$defs: { intentName: { const: INTENT_FIELD } },
		});

		expect(
			await callSessionTool(
				"referenced-property-name-intent",
				{ [INTENT_FIELD]: "caller intent" },
				{ session: createSession([tool]) },
			),
		).toBe("string:caller intent");
	});

	it("does not claim intent excluded by propertyNames", async () => {
		const tool = createSchemaTool("excluded-property-name-intent", {
			type: "object",
			propertyNames: { not: { const: INTENT_FIELD } },
		});

		expect(
			await callSessionTool(
				"excluded-property-name-intent",
				{ [INTENT_FIELD]: "caller intent" },
				{ session: createSession([tool]) },
			),
		).toBe("undefined:undefined");
	});

	it("rejects invalid intent matched by patternProperties", async () => {
		const tool = createSchemaTool("pattern-intent", {
			type: "object",
			patternProperties: { "^i$": { type: "number" } },
		});
		const execute = vi.fn(tool.execute);
		tool.execute = execute;

		await expect(
			callSessionTool("pattern-intent", { [INTENT_FIELD]: "invalid" }, { session: createSession([tool]) }),
		).rejects.toThrow("Validation failed");
		expect(execute).not.toHaveBeenCalled();
	});

	it("preserves and coerces intent consumed by additionalProperties", async () => {
		const tool = createSchemaTool("additional-intent", {
			type: "object",
			additionalProperties: { type: "number" },
		});

		expect(
			await callSessionTool("additional-intent", { [INTENT_FIELD]: "5" }, { session: createSession([tool]) }),
		).toBe("number:5");
	});

	it("treats intent ownership as schema-wide across anyOf branches", async () => {
		const tool = createSchemaTool("schema-wide-intent", {
			anyOf: [
				{
					type: "object",
					properties: { [INTENT_FIELD]: { type: "number" } },
					required: [INTENT_FIELD],
					additionalProperties: false,
				},
				{
					type: "object",
					properties: { value: { type: "string" } },
					required: ["value"],
					additionalProperties: false,
				},
			],
		});
		const execute = vi.fn(tool.execute);
		tool.execute = execute;
		const session = createSession([tool]);

		await expect(
			callSessionTool("schema-wide-intent", { value: "x", [INTENT_FIELD]: "invalid" }, { session }),
		).rejects.toThrow("Validation failed");
		expect(execute).not.toHaveBeenCalled();
		expect(await callSessionTool("schema-wide-intent", { value: "x" }, { session })).toBe("undefined:undefined");
	});

	it("preserves and coerces a required intent field declared by an anyOf branch", async () => {
		const tool = createSchemaTool("any-of-intent", {
			anyOf: [
				{
					type: "object",
					properties: { [INTENT_FIELD]: { type: "number" } },
					required: [INTENT_FIELD],
					additionalProperties: false,
				},
				{
					type: "object",
					properties: { value: { type: "string" } },
					required: ["value"],
					additionalProperties: false,
				},
			],
		});

		expect(await callSessionTool("any-of-intent", { [INTENT_FIELD]: "5" }, { session: createSession([tool]) })).toBe(
			"number:5",
		);
	});

	it("preserves and coerces an intent field declared by a oneOf branch", async () => {
		const tool = createSchemaTool("one-of-intent", {
			oneOf: [
				{
					type: "object",
					properties: { [INTENT_FIELD]: { type: "number" } },
					required: [INTENT_FIELD],
					additionalProperties: false,
				},
				{
					type: "object",
					properties: { value: { type: "string" } },
					required: ["value"],
					additionalProperties: false,
				},
			],
		});

		expect(await callSessionTool("one-of-intent", { [INTENT_FIELD]: "5" }, { session: createSession([tool]) })).toBe(
			"number:5",
		);
	});

	it("preserves and coerces an intent field constrained by allOf", async () => {
		const tool = createSchemaTool("all-of-intent", {
			type: "object",
			allOf: [
				{
					properties: { [INTENT_FIELD]: { type: "number" } },
					required: [INTENT_FIELD],
				},
			],
		});

		expect(await callSessionTool("all-of-intent", { [INTENT_FIELD]: "5" }, { session: createSession([tool]) })).toBe(
			"number:5",
		);
	});

	it("preserves and coerces intent declared by a selected conditional branch", async () => {
		const tool = createSchemaTool("conditional-intent", {
			type: "object",
			properties: { mode: { type: "string" } },
			required: ["mode"],
			if: {
				properties: { mode: { const: "intent" } },
				required: ["mode"],
			},
			// oxlint-disable-next-line unicorn/no-thenable -- JSON Schema if/then/else keyword
			then: {
				properties: { [INTENT_FIELD]: { type: "number" } },
				required: [INTENT_FIELD],
			},
		});

		expect(
			await callSessionTool(
				"conditional-intent",
				{ mode: "intent", [INTENT_FIELD]: "5" },
				{ session: createSession([tool]) },
			),
		).toBe("number:5");
	});

	it("preserves and coerces intent declared by an activated dependent schema", async () => {
		const tool = createSchemaTool("dependent-intent", {
			type: "object",
			properties: { enabled: { type: "boolean" } },
			required: ["enabled"],
			dependentSchemas: {
				enabled: {
					properties: { [INTENT_FIELD]: { type: "number" } },
					required: [INTENT_FIELD],
				},
			},
		});

		expect(
			await callSessionTool(
				"dependent-intent",
				{ enabled: true, [INTENT_FIELD]: "5" },
				{ session: createSession([tool]) },
			),
		).toBe("number:5");
	});

	it("keeps intent predicates from bypassing conditional validation", async () => {
		const tool = createSchemaTool("intent-predicate", {
			type: "object",
			if: { properties: { i: { const: "strict" } }, required: ["i"] },
			// oxlint-disable-next-line unicorn/no-thenable -- JSON Schema if/then/else keyword
			then: { properties: { value: { type: "number" } }, required: ["value"] },
		});
		await expect(
			callSessionTool("intent-predicate", { i: "strict", value: "invalid" }, { session: createSession([tool]) }),
		).rejects.toThrow("Validation failed");
	});

	it.each(["direct", "annotated", "reference"] as const)(
		"keeps harness intent out of a presence prohibition (%s)",
		async shape => {
			const presence =
				shape === "annotated"
					? { type: "object", required: ["i"], description: "Reserved name" }
					: { required: ["i"] };
			const tool = createSchemaTool("forbidden-presence", {
				type: "object",
				not: shape === "reference" ? { $ref: "#/$defs/presence" } : presence,
				$defs: { presence },
			});
			expect(
				await callSessionTool("forbidden-presence", { i: "caller intent" }, { session: createSession([tool]) }),
			).toBe("undefined:undefined");
		},
	);

	it("keeps harness intent out of a false property schema", async () => {
		const tool = createSchemaTool("false-intent", { type: "object", properties: { i: false } });
		expect(await callSessionTool("false-intent", { i: "caller intent" }, { session: createSession([tool]) })).toBe(
			"undefined:undefined",
		);
	});

	it("strips intent prohibited by a false pattern schema", async () => {
		const tool = createSchemaTool("false-pattern-intent", {
			type: "object",
			patternProperties: { "^i$": false },
		});
		expect(
			await callSessionTool("false-pattern-intent", { i: "caller intent" }, { session: createSession([tool]) }),
		).toBe("undefined:undefined");
	});

	it("preserves intent constrained by unevaluatedProperties", async () => {
		const tool = createSchemaTool("unevaluated-intent", {
			type: "object",
			unevaluatedProperties: { type: "string" },
			minProperties: 1,
		});
		expect(
			await callSessionTool("unevaluated-intent", { i: "caller intent" }, { session: createSession([tool]) }),
		).toBe("string:caller intent");
	});

	it("preserves data required by negating a false property schema", async () => {
		const tool = createSchemaTool("not-false-intent", { type: "object", not: { properties: { i: false } } });
		expect(await callSessionTool("not-false-intent", { i: "data" }, { session: createSession([tool]) })).toBe(
			"string:data",
		);
	});

	it("preserves false-property predicates as decision inputs", async () => {
		const tool = createSchemaTool("false-intent-predicate", {
			type: "object",
			if: { properties: { i: false } },
			// oxlint-disable-next-line unicorn/no-thenable -- JSON Schema if/then/else keyword
			then: false,
			else: true,
		});
		expect(await callSessionTool("false-intent-predicate", { i: "data" }, { session: createSession([tool]) })).toBe(
			"string:data",
		);
	});

	it("preserves intent required by double negation", async () => {
		const tool = createSchemaTool("double-not-intent", { type: "object", not: { not: { required: ["i"] } } });
		expect(await callSessionTool("double-not-intent", { i: "data" }, { session: createSession([tool]) })).toBe(
			"string:data",
		);
	});

	it("visits a shared reference under both negation polarities", async () => {
		const tool = createSchemaTool("shared-polarity", {
			type: "object",
			anyOf: [{ $ref: "#/$defs/absent" }, { not: { $ref: "#/$defs/absent" } }],
			$defs: { absent: { not: { required: ["i"] } } },
		});
		expect(await callSessionTool("shared-polarity", {}, { session: createSession([tool]) })).toBe(
			"undefined:undefined",
		);
	});

	it("validates intent constraints inside a negated schema", async () => {
		const tool = createSchemaTool("negated-intent", {
			type: "object",
			not: { properties: { i: { const: "forbidden" } }, required: ["i"] },
		});
		await expect(
			callSessionTool("negated-intent", { i: "forbidden" }, { session: createSession([tool]) }),
		).rejects.toThrow("Validation failed");
	});

	it("preserves and coerces intent through an escaped local reference", async () => {
		const tool = createSchemaTool("referenced-intent", {
			$ref: "#/$defs/intent~1property~0schema",
			$defs: {
				"intent/property~schema": {
					type: "object",
					properties: { [INTENT_FIELD]: { type: "number" } },
					required: [INTENT_FIELD],
					additionalProperties: false,
				},
			},
		});

		expect(
			await callSessionTool("referenced-intent", { [INTENT_FIELD]: "5" }, { session: createSession([tool]) }),
		).toBe("number:5");
	});

	it("terminates cyclic local references without claiming intent ownership", async () => {
		const tool = createSchemaTool("cyclic-schema", {
			$ref: "#/$defs/cycle",
			$defs: { cycle: { $ref: "#/$defs/cycle" } },
		});

		expect(
			await callSessionTool(
				"cyclic-schema",
				{ [INTENT_FIELD]: "caller intent" },
				{ session: createSession([tool]) },
			),
		).toBe("undefined:undefined");
	});

	it("does not treat a nested intent property as a root tool parameter", async () => {
		const tool = createSchemaTool("nested-intent", {
			type: "object",
			properties: {
				wrapper: {
					type: "object",
					properties: { [INTENT_FIELD]: { type: "number" } },
				},
			},
			additionalProperties: false,
		});

		expect(
			await callSessionTool(
				"nested-intent",
				{ wrapper: {}, [INTENT_FIELD]: "caller intent" },
				{ session: createSession([tool]) },
			),
		).toBe("undefined:undefined");
	});

	it("validates constrained tool-owned intent without supplying a missing optional value", async () => {
		const execute = vi.fn(async (_id: string, args: unknown) => ({
			content: [{ type: "text" as const, text: String((args as Record<string, unknown>)[INTENT_FIELD]) }],
		}));
		const tool: AgentTool = {
			name: "constrained-intent",
			label: "constrained intent",
			description: "constrained intent tool",
			parameters: type({ [`${INTENT_FIELD}?`]: "'allowed'" }),
			concurrency: "parallel",
			execute,
		} as unknown as AgentTool;

		await expect(
			callSessionTool("constrained-intent", { [INTENT_FIELD]: "disallowed" }, { session: createSession([tool]) }),
		).rejects.toThrow("Validation failed");
		expect(execute).not.toHaveBeenCalled();
		expect(await callSessionTool("constrained-intent", {}, { session: createSession([tool]) })).toBe("undefined");
	});

	it("recovers a missing todo operation from raw parse metadata", async () => {
		let phases: TodoPhase[] = [];
		const session: ToolSession = {
			...createSession([]),
			getTodoPhases: () => phases,
			setTodoPhases: next => {
				phases = next;
			},
			getToolByName: name => (name === "todo" ? (todoTool as unknown as AgentTool) : undefined),
		};
		const todoTool = new TodoTool(session);

		const result = await callSessionTool(
			"todo",
			{
				list: [{ phase: "Recovered", items: ["From malformed JSON"] }],
				__parseError: "Unexpected token",
				__rawJson: '{"list": [broken}',
			},
			{ session },
		);

		expect(result).toMatchObject({ details: { storage: expect.any(String) } });
		expect(phases).toEqual([
			{ name: "Recovered", tasks: [{ content: "From malformed JSON", status: "in_progress" }] },
		]);
	});

	it("persists bridged todo mutations to the branch, which a direct toolResult would carry", async () => {
		let phases: TodoPhase[] = [{ name: "Ship", tasks: [{ content: "Persist", status: "in_progress" }] }];
		const persisted: TodoPhase[][] = [];
		const session: ToolSession = {
			...createSession([]),
			getTodoPhases: () => phases,
			setTodoPhases: next => {
				phases = next;
			},
			persistTodoPhases: next => persisted.push(next),
			getToolByName: name => (name === "todo" ? (todoTool as unknown as AgentTool) : undefined),
		};
		const todoTool = new TodoTool(session);

		await callSessionTool("todo", { op: "done", task: "Persist" }, { session });
		expect(persisted).toEqual([[{ name: "Ship", tasks: [{ content: "Persist", status: "completed" }] }]]);

		// Reads and rejected batches leave the branch untouched.
		await callSessionTool("todo", { op: "view" }, { session });
		await expect(callSessionTool("todo", { op: "done", task: "No such task" }, { session })).rejects.toBeInstanceOf(
			ToolCallError,
		);
		expect(persisted).toHaveLength(1);
	});

	it("keeps persisted nested Todo status bounded for large checklists", async () => {
		let phases: TodoPhase[] = [
			{
				name: "Ship",
				tasks: Array.from({ length: 100 }, (_, index) => ({
					content: `Task ${index}`,
					status: index === 0 ? ("in_progress" as const) : ("pending" as const),
				})),
			},
		];
		const statuses: Array<Record<string, unknown>> = [];
		const session: ToolSession = {
			...createSession([]),
			getTodoPhases: () => phases,
			setTodoPhases: next => {
				phases = next;
			},
			getToolByName: name => (name === "todo" ? (todoTool as unknown as AgentTool) : undefined),
		};
		const todoTool = new TodoTool(session);

		await callSessionTool(
			"todo",
			{ op: "done", task: "Task 0" },
			{ session, emitStatus: event => statuses.push(event) },
		);
		await callSessionTool("todo", { op: "view" }, { session, emitStatus: event => statuses.push(event) });

		expect(phases[0]?.tasks[0]?.status).toBe("completed");
		expect(statuses.map(event => event.committed)).toEqual([true, false]);
		expect(JSON.stringify(statuses).length).toBeLessThan(500);
	});

	it("returns structured tool results when details or images are present", async () => {
		const session = createSession([
			createTool("custom", async () => ({
				content: [
					{ type: "text", text: "done" },
					{ type: "image", mimeType: "image/png", data: "abc123" },
				],
				details: { ok: true },
			})),
		]);

		const result = await callSessionTool("custom", {}, { session });

		expect(result).toEqual({
			text: "done",
			details: { ok: true },
			images: [{ mimeType: "image/png", data: "abc123" }],
		});
	});

	it("rejects with ToolCallError when the underlying tool reports an error in details", async () => {
		const session = createSession([
			createTool("mcp__demo_fail", async () => ({
				content: [{ type: "text", text: "Error: bad input" }],
				details: { serverName: "demo", mcpToolName: "fail", isError: true },
			})),
		]);
		const statuses: Array<Record<string, unknown>> = [];

		const error = await callSessionTool(
			"mcp__demo_fail",
			{},
			{ session, emitStatus: event => statuses.push(event) },
		).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(ToolCallError);
		expect(error).toMatchObject({
			toolName: "mcp__demo_fail",
			message: "Error: bad input",
			text: "Error: bad input",
			details: { serverName: "demo", mcpToolName: "fail", isError: true },
		});
		expect(statuses).toEqual([
			expect.objectContaining({
				op: "mcp__demo_fail",
				chars: 16,
				hasError: true,
				error: "Error: bad input",
			}),
		]);
	});

	it("rejects with ToolCallError on a top-level isError result", async () => {
		const session = createSession([
			createTool(
				"bash",
				async () =>
					({
						content: [{ type: "text", text: "boom" }],
						isError: true,
					}) as AgentToolResult,
			),
		]);
		const statuses: Array<Record<string, unknown>> = [];

		const error = await callSessionTool(
			"bash",
			{ command: "false" },
			{ session, emitStatus: event => statuses.push(event) },
		).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(ToolCallError);
		expect((error as ToolCallError).toolName).toBe("bash");
		expect((error as ToolCallError).text).toBe("boom");
		// The failure is recorded once, by the result summary, not again by the rethrow.
		expect(statuses).toHaveLength(1);
	});

	it("resolves { text, details } for a tool that declares an outputSchema", async () => {
		const tool = {
			...createTool("glob", async () => ({
				content: [{ type: "text", text: "a\nb\nc" }],
				details: { fileCount: 3 },
			})),
			outputSchema: type({ "fileCount?": "number" }),
		} as AgentTool;
		const result = await callSessionTool("glob", {}, { session: createSession([tool]) });
		expect(result).toEqual({ text: "a\nb\nc", details: { fileCount: 3 } });
	});

	it("resolves { text, details } with an outputSchema even when details are absent", async () => {
		const tool = {
			...createTool("glob", async () => ({ content: [{ type: "text", text: "none" }] })),
			outputSchema: type({ "fileCount?": "number" }),
		} as AgentTool;
		const result = await callSessionTool("glob", {}, { session: createSession([tool]) });
		expect(result).toEqual({ text: "none", details: undefined });
	});

	it("keeps the legacy shape for tools without an outputSchema", async () => {
		const session = createSession([
			createTool("plain", async () => ({ content: [{ type: "text", text: "just text" }] })),
			createTool("detailed", async () => ({ content: [{ type: "text", text: "t" }], details: { x: 1 } })),
		]);
		expect(await callSessionTool("plain", {}, { session })).toBe("just text");
		expect(await callSessionTool("detailed", {}, { session })).toEqual({ text: "t", details: { x: 1 } });
	});

	it("serializes an exclusive call behind an in-flight shared one", async () => {
		const spans: Record<string, { start: number; end: number }> = {};
		const timed = (name: string, concurrency: "shared" | "exclusive"): AgentTool =>
			({
				...createTool(name, async () => {
					const start = Bun.nanoseconds();
					// Yield a few turns so overlap would be observable without the scheduler.
					for (let i = 0; i < 20; i++) await Promise.resolve();
					spans[name] = { start, end: Bun.nanoseconds() };
					return { content: [{ type: "text", text: name }] };
				}),
				concurrency,
			}) as AgentTool;
		const session = createSession([timed("reader", "shared"), timed("writer", "exclusive")]);
		const scheduler = new EvalCallScheduler({ maxParallel: 1, maxCalls: Infinity, callsPerMinute: 1024 });

		await Promise.all([
			callSessionTool("reader", {}, { session, scheduler }),
			callSessionTool("writer", {}, { session, scheduler }),
		]);

		expect(spans.writer!.start).toBeGreaterThanOrEqual(spans.reader!.end);
	});

	it("rejects the call that exceeds the scheduler's allowance without dispatching it", async () => {
		const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
		const session = createSession([createTool("read", execute)]);
		const scheduler = new EvalCallScheduler({ maxParallel: 10, maxCalls: 1, callsPerMinute: 2 });

		expect(await callSessionTool("read", {}, { session, scheduler })).toBe("ok");
		await expect(callSessionTool("read", {}, { session, scheduler })).rejects.toThrow(
			/exceeded its limit of 1 tool calls/,
		);
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("throws when the requested tool is not available in the session registry", async () => {
		const session = createSession([]);

		await expect(callSessionTool("missing", {}, { session })).rejects.toThrow("Unknown tool from js runtime");
	});

	it("executes the bridge-authorized tool instead of the raw registry tool", async () => {
		const rawExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "raw" }] });
		const authorizedExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "authorized" }] });
		const session = {
			...createSession([createTool("write", rawExecute)]),
			getToolForEvalBridge: () => createTool("write", authorizedExecute),
		};

		const result = await callSessionTool("write", { path: "out.txt", content: "data" }, { session });

		expect(result).toBe("authorized");
		expect(authorizedExecute).toHaveBeenCalledTimes(1);
		expect(rawExecute).not.toHaveBeenCalled();
	});

	it("rejects checkpoint and rewind before reaching the registry", async () => {
		const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
		const session = createSession([createTool("checkpoint", execute), createTool("rewind", execute)]);

		await expect(callSessionTool("checkpoint", { goal: "g" }, { session })).rejects.toThrow(
			"cannot run through the eval bridge",
		);
		await expect(callSessionTool("rewind", { report: "r" }, { session })).rejects.toThrow(
			"cannot run through the eval bridge",
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it("rejects a registry tool excluded from the eval bridge", async () => {
		const rawExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "raw" }] });
		const session = {
			...createSession([createTool("write", rawExecute)]),
			getToolForEvalBridge: () => undefined,
		};

		await expect(callSessionTool("write", { path: "out.txt", content: "data" }, { session })).rejects.toThrow(
			"Unknown tool from js runtime",
		);
		expect(rawExecute).not.toHaveBeenCalled();
	});
});
