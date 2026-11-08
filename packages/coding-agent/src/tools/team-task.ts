import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { TeamTaskToolDetails } from "@oh-my-pi/pi-tui/tools/team-task";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { prompt } from "@oh-my-pi/pi-utils";
import teamTaskDescription from "../prompts/tools/team-task.md" with { type: "text" };
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import { cfgTaskTeamMaxTasks } from "../task/settings";
import { type TeamTaskMutation, type TeamTaskMutationResult, TeamTaskBoard } from "../task/team-board";
import type { ToolSession } from ".";

const teamTaskSchema = type({
	op: '"create" | "list" | "get" | "claim" | "release" | "edit" | "set_deps" | "complete" | "reopen" | "reassign" | "delete"',
	"task_id?": type("string").describe("task id, e.g. task-3"),
	"expected_revision?": type("number.integer").describe("revision you last read; required by every mutation"),
	"subject?": type("string").describe("one-line title (create/edit)"),
	"description?": type("string").describe("task details (create/edit)"),
	"blocked_by?": type("string").array().describe("task ids that must complete first (create/set_deps)"),
	"write_scopes?": type("string").array().describe("advisory workspace-relative path prefixes (create/edit)"),
	"owner?": type("string").describe("agent id for reassign; omit to unassign"),
	"status?": type('"pending" | "in_progress" | "completed"').describe("list filter"),
	"ready?": type("boolean").describe("list filter: only claimable (true) or blocked (false) tasks"),
});

type TeamTaskParams = typeof teamTaskSchema.infer;

const MUTATIONS: Record<TeamTaskMutation, true> = {
	claim: true,
	release: true,
	edit: true,
	set_deps: true,
	complete: true,
	reopen: true,
	reassign: true,
	delete: true,
};

function missingFields(params: TeamTaskParams): string[] {
	const missing: string[] = [];
	if (params.op === "create" && params.subject === undefined) missing.push("subject");
	if (params.op !== "create" && params.op !== "list" && params.task_id === undefined) missing.push("task_id");
	if (params.op in MUTATIONS && params.expected_revision === undefined) missing.push("expected_revision");
	if (params.op === "set_deps" && params.blocked_by === undefined) missing.push("blocked_by");
	return missing;
}

function mutationText(op: string, result: TeamTaskMutationResult): string {
	const lines = [
		result.task
			? JSON.stringify(result.task)
			: `${result.snapshot.id} deleted at revision ${result.snapshot.revision}`,
	];
	if (result.newlyReady.length > 0) {
		lines.push(
			`${result.newlyReady.length} task(s) are now ready: ${result.newlyReady.join(", ")}. Message likely owners with write agent://<id> if they need to act now.`,
		);
	}
	for (const warning of result.task?.writeScopeWarnings ?? []) lines.push(`warning: ${warning}`);
	return `${op}: ${lines.join("\n")}`;
}

/** Shared, durable task board for every agent in this tree. */
export class TeamTaskTool implements AgentTool<typeof teamTaskSchema, TeamTaskToolDetails> {
	readonly name = "team_task";
	readonly approval = "read" as const;
	readonly label = "Team Task";
	readonly summary = "Shared task board for every agent in this tree: create, claim, complete with dependencies";
	readonly description = prompt.render(teamTaskDescription);
	readonly parameters = teamTaskSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {}

	async execute(_toolCallId: string, params: TeamTaskParams): Promise<AgentToolResult<TeamTaskToolDetails>> {
		const missing = missingFields(params);
		if (missing.length > 0) {
			return {
				content: [{ type: "text", text: `team_task ${params.op} requires: ${missing.join(", ")}` }],
				details: { op: params.op },
				isError: true,
			};
		}
		const board = TeamTaskBoard.global();
		const callerId = this.session.getAgentId?.() ?? MAIN_AGENT_ID;
		try {
			switch (params.op) {
				case "create": {
					const result = await board.create(
						callerId,
						{
							subject: params.subject ?? "",
							description: params.description,
							blockedBy: params.blocked_by,
							writeScopes: params.write_scopes,
						},
						cfgTaskTeamMaxTasks.get(this.session.settings),
					);
					return {
						content: [{ type: "text", text: mutationText("created", result) }],
						details: { op: "create", task: result.task },
					};
				}
				case "list": {
					const tasks = await board.list(callerId, { status: params.status, ready: params.ready });
					const text = tasks.length > 0 ? JSON.stringify(tasks) : "No team tasks match.";
					return { content: [{ type: "text", text }], details: { op: "list", tasks } };
				}
				case "get": {
					const task = await board.get(callerId, params.task_id ?? "");
					return { content: [{ type: "text", text: JSON.stringify(task) }], details: { op: "get", task } };
				}
				default: {
					const result = await board.update(callerId, {
						op: params.op,
						taskId: params.task_id ?? "",
						expectedRevision: params.expected_revision ?? 0,
						subject: params.subject,
						description: params.description,
						blockedBy: params.blocked_by,
						writeScopes: params.write_scopes,
						owner: params.owner,
					});
					return {
						content: [{ type: "text", text: mutationText(params.op, result) }],
						details: { op: params.op, ...(result.task ? { task: result.task } : {}) },
					};
				}
			}
		} catch (error) {
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}
	}
}
