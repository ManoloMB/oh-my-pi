import type { Component } from "../tui";
import { Text } from "../components/text";
import type { Theme, ThemeColor } from "../theme/theme";
import { formatErrorDetail, TRUNCATE_LENGTHS } from "../render/render-utils";
import { renderStatusLine, truncateToWidth } from "../render/index";
import { framedToolCard } from "../render/tool-card";
import { compact, span, text } from "../native/describe";
import { OwnerMemo } from "../native/memo";
import { errorView, resultText, toolHead } from "./native-view";
import type { NativeToolView, RenderResultOptions, ToolRenderer, ToolRenderResult } from "./renderer";

/** Lifecycle state of a shared team task; `deleted` is a tombstone. */
export type TeamTaskStatus = "pending" | "in_progress" | "completed" | "deleted";

/** One committed revision of a team task, as persisted in the root session log. */
export interface TeamTaskSnapshot {
	id: string;
	revision: number;
	subject: string;
	description: string;
	status: TeamTaskStatus;
	ownerId?: string;
	blockedBy: string[];
	writeScopes: string[];
}

/** Task revision plus readiness and advisory write-scope overlaps. */
export interface TeamTaskView extends Omit<TeamTaskSnapshot, "status"> {
	status: Exclude<TeamTaskStatus, "deleted">;
	ready: boolean;
	writeScopeWarnings: string[];
}

/** Operations accepted by the `team_task` tool. */
export type TeamTaskOp =
	| "create"
	| "list"
	| "get"
	| "claim"
	| "release"
	| "edit"
	| "set_deps"
	| "complete"
	| "reopen"
	| "reassign"
	| "delete";

/** Result payload of a `team_task` call. */
export interface TeamTaskToolDetails {
	op: TeamTaskOp;
	task?: TeamTaskView;
	tasks?: TeamTaskView[];
}

interface TeamTaskRenderArgs {
	op?: TeamTaskOp;
	task_id?: string;
	subject?: string;
}

const MAX_ROWS = 12;

function statusColor(status: TeamTaskView["status"]): ThemeColor {
	switch (status) {
		case "completed":
			return "success";
		case "in_progress":
			return "accent";
		default:
			return "warning";
	}
}

function callDescription(args: TeamTaskRenderArgs | undefined): string {
	const op = args?.op ?? "?";
	if (args?.task_id) return `${op} ${args.task_id}`;
	return op;
}

function taskLine(task: TeamTaskView): string {
	const owner = task.ownerId ? ` @${task.ownerId}` : "";
	const ready = task.status === "pending" ? (task.ready ? " ready" : " blocked") : "";
	return `${task.id} r${task.revision} [${task.status}${ready}]${owner} ${task.subject}`;
}

function resultTasks(details: TeamTaskToolDetails | undefined): TeamTaskView[] {
	if (!details) return [];
	if (details.tasks) return details.tasks;
	return details.task ? [details.task] : [];
}

function describeTeamTaskResult(
	result: ToolRenderResult<TeamTaskToolDetails>,
	args: TeamTaskRenderArgs | undefined,
): NativeToolView {
	const description = callDescription({ ...args, op: result.details?.op ?? args?.op });
	if (result.isError) return errorView("Team Task", resultText(result) || "Team task failed", description);
	const tasks = resultTasks(result.details);
	if (tasks.length === 0) return { head: toolHead("Team Task", description, "no tasks") };
	const rows = tasks.slice(0, MAX_ROWS).map(task =>
		text([span(task.status, `${statusColor(task.status)} strong`), span(` ${taskLine(task)}`, "muted")], {
			wrap: "word",
		}),
	);
	const more = tasks.length > MAX_ROWS ? text([span(`… ${tasks.length - MAX_ROWS} more`, "dim")]) : undefined;
	return { head: toolHead("Team Task", description), body: compact([...rows, more]) };
}

const teamTaskResultMemo = new OwnerMemo<NativeToolView | undefined>();

/** Renders shared team task board operations. */
export const teamTaskToolRenderer = {
	renderCall(args: TeamTaskRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		const subject = typeof args?.subject === "string" ? args.subject.trim() : "";
		if (subject) meta.push(uiTheme.fg("muted", truncateToWidth(subject, TRUNCATE_LENGTHS.TITLE)));
		return new Text(
			renderStatusLine({ icon: "pending", title: "Team Task", description: callDescription(args), meta }, uiTheme),
			0,
			0,
		);
	},

	renderResult(
		result: ToolRenderResult<TeamTaskToolDetails>,
		_options: RenderResultOptions,
		uiTheme: Theme,
		args?: TeamTaskRenderArgs,
	): Component {
		const description = callDescription({ ...args, op: result.details?.op ?? args?.op });
		if (result.isError) {
			const header = renderStatusLine({ icon: "error", title: "Team Task", description }, uiTheme);
			const fallback = result.content?.find(c => c.type === "text")?.text ?? "";
			return framedToolCard(uiTheme, () => ({
				header,
				sections: [{ content: formatErrorDetail(fallback || "Team task failed", uiTheme).split("\n") }],
				phase: "error",
				borderColor: "error",
			}));
		}
		const tasks = resultTasks(result.details);
		const header = renderStatusLine(
			{ icon: "success", title: "Team Task", description, meta: [`${tasks.length} task(s)`] },
			uiTheme,
		);
		if (tasks.length === 0) return new Text(header, 0, 0);
		const lines = tasks
			.slice(0, MAX_ROWS)
			.map(task => uiTheme.fg(statusColor(task.status), truncateToWidth(taskLine(task), TRUNCATE_LENGTHS.LONG)));
		if (tasks.length > MAX_ROWS) lines.push(uiTheme.fg("dim", `… ${tasks.length - MAX_ROWS} more`));
		return framedToolCard(uiTheme, () => ({
			header,
			sections: [{ content: lines }],
			phase: "success",
			borderColor: "borderMuted",
		}));
	},

	describeCall(args: TeamTaskRenderArgs): NativeToolView {
		const head = toolHead("Team Task", callDescription(args));
		const subject = typeof args?.subject === "string" ? args.subject.trim() : "";
		if (subject) head.push(span(" "), span(`"${subject}"`, "muted"));
		return { head };
	},

	describeResult(
		result: ToolRenderResult<TeamTaskToolDetails>,
		_options: RenderResultOptions,
		args?: TeamTaskRenderArgs,
	): NativeToolView | undefined {
		return teamTaskResultMemo.get(result, [args?.op, args?.task_id], () => describeTeamTaskResult(result, args));
	},

	mergeCallAndResult: true,
} satisfies ToolRenderer<TeamTaskRenderArgs, TeamTaskToolDetails>;
