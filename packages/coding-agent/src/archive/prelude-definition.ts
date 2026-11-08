import { type } from "@oh-my-pi/omptype";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { EvalPreludeDefinition } from "../eval/preludes";
import archiveDocumentation from "../prompts/tools/archive.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { resolveToCwd } from "../tools/path-utils";
import { cfgArchiveContentSearch, cfgArchiveEnabled, cfgArchiveIndexThinking } from "../tools/settings";
import {
	type ArchiveView,
	archiveFind,
	archiveOpen,
	archiveProjects,
	archivePrompts,
	archiveRecaps,
	archiveSession,
	archiveSessions,
} from "./archive";
// @ts-expect-error Bun imports this declaration source as text instead of a TypeScript module.
import archiveDeclarations from "./declarations.d.ts" with { type: "text" };
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import archiveJavascript from "./prelude.js" with { type: "text" };
import archivePython from "./prelude.py" with { type: "text" };

/** Listing size when a call omits `limit`. */
const DEFAULT_LIMIT = 20;
/** Content-search rows when `find` omits `limit`. */
const DEFAULT_FIND_LIMIT = 8;

const limit = "1 <= number.integer <= 500";
const project = "string > 0";

const paramsSchema = type({ action: "'projects'", "limit?": limit, "+": "reject" })
	.or({ action: "'sessions' | 'recaps'", "project?": project, "limit?": limit, "+": "reject" })
	.or({ action: "'session'", id: "string > 0", "limit?": limit, "+": "reject" })
	.or({ action: "'prompts'", "query?": "string > 0", "project?": project, "limit?": limit, "+": "reject" })
	.or({
		action: "'find'",
		query: "string > 0",
		"project?": project,
		"limit?": "1 <= number.integer <= 25",
		"+": "reject",
	})
	.or({
		action: "'open'",
		id: "string > 0",
		"line?": "number.integer >= 1",
		"before?": "0 <= number.integer <= 200",
		"after?": "0 <= number.integer <= 200",
		"+": "reject",
	});

type ArchiveParams = typeof paramsSchema.infer;

/**
 * Absolute project directory for a `project` argument; `undefined` spans every
 * project. Omitted means the session's own working directory, `"*"` every
 * project, anything else a path (`~` expanded, relative to the session cwd).
 */
export function resolveProject(project: string | undefined, cwd: string): string | undefined {
	if (project === "*") return undefined;
	return project === undefined ? cwd : resolveToCwd(project, cwd);
}

function assertContentSearch(session: ToolSession): void {
	if (!cfgArchiveContentSearch.get(session.settings)) {
		throw new ToolError("archive content search is disabled (archive.contentSearch)");
	}
}

async function archiveView(params: ArchiveParams, session: ToolSession): Promise<ArchiveView<unknown>> {
	const cwd = session.cwd;
	switch (params.action) {
		case "projects":
			return archiveProjects(params.limit ?? DEFAULT_LIMIT);
		case "sessions":
			return archiveSessions(resolveProject(params.project, cwd), params.limit ?? DEFAULT_LIMIT);
		case "session":
			return archiveSession(
				params.id.endsWith(".jsonl") ? resolveToCwd(params.id, cwd) : params.id,
				params.limit ?? DEFAULT_LIMIT,
			);
		case "prompts":
			return archivePrompts(params.query, resolveProject(params.project, cwd), params.limit ?? DEFAULT_LIMIT);
		case "recaps":
			return archiveRecaps(resolveProject(params.project, cwd), params.limit ?? DEFAULT_LIMIT);
		case "find":
			assertContentSearch(session);
			return archiveFind(
				params.query,
				resolveProject(params.project, cwd),
				params.limit ?? DEFAULT_FIND_LIMIT,
				session.getSessionId?.() ?? "",
				{ currentCwd: cwd, indexThinking: cfgArchiveIndexThinking.get(session.settings) },
			);
		case "open":
			assertContentSearch(session);
			return archiveOpen(
				params.id.endsWith(".jsonl") ? resolveToCwd(params.id, cwd) : params.id,
				params.line,
				params.before,
				params.after,
			);
	}
}

/** Status-tree line for a completed archive call: `archive.search("retry")`, `archive.sessions(*)`. */
function describeArchiveCall(parameters: unknown): string | undefined {
	const parsed = paramsSchema(parameters);
	if (parsed instanceof type.errors) return undefined;
	switch (parsed.action) {
		case "projects":
			return "archive.projects()";
		case "session":
			return `archive.session(${parsed.id})`;
		case "prompts":
			if (parsed.query) return `archive.search(${JSON.stringify(parsed.query)})`;
			return `archive.prompts(${parsed.project ? shortenPath(parsed.project) : ""})`;
		case "sessions":
		case "recaps":
			return `archive.${parsed.action}(${parsed.project ? shortenPath(parsed.project) : ""})`;
		case "find":
			return `archive.find(${JSON.stringify(parsed.query)})`;
		case "open":
			return `archive.open(${parsed.id})`;
	}
}

/** Create the read-only archive prelude: prompt history, recent projects, past sessions, and recaps. */
export function createArchivePrelude(session: ToolSession): EvalPreludeDefinition {
	return {
		name: "archive",
		documentation: archiveDocumentation,
		javascript: archiveJavascript,
		python: archivePython,
		exports: ["archive"],
		codeModeDeclarations: archiveDeclarations,
		approval: "read",
		enabled: () => cfgArchiveEnabled.get(session.settings) === true,
		invoke: async parameters => {
			const parsed = paramsSchema(parameters);
			if (parsed instanceof type.errors)
				throw new ToolError(`archive received invalid arguments: ${parsed.summary}`);
			const view = await archiveView(parsed, session);
			return { content: [{ type: "text", text: view.text }], details: view.records };
		},
		status: describeArchiveCall,
	};
}
