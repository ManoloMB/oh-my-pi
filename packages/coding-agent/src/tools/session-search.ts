import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { prompt } from "@oh-my-pi/pi-utils";
import { archiveFind, archiveOpen } from "../archive/archive";
import { resolveProject } from "../archive/prelude-definition";
import sessionSearchDescription from "../prompts/tools/session-search.md" with { type: "text" };
import type { ToolSession } from ".";
import { resolveToCwd } from "./path-utils";
import { cfgArchiveIndexThinking } from "./settings";

const DEFAULT_FIND_LIMIT = 8;

const sessionSearchSchema = type({
	op: "'find' | 'open'",
	"query?": type("string").describe("words to find (find)"),
	"project?": type("string").describe('project path or "*" for every project (find)'),
	"limit?": type("1 <= number.integer <= 25").describe("max sessions (find)"),
	"id?": type("string").describe("session id prefix or .jsonl path (open)"),
	"line?": type("number.integer >= 1").describe("JSONL line to center on (open)"),
});

type SessionSearchParams = typeof sessionSearchSchema.infer;

/** Content search over past sessions for agents without `eval` (where `archive.find/open` live). */
export class SessionSearchTool implements AgentTool<typeof sessionSearchSchema> {
	readonly name = "session_search";
	readonly approval = "read" as const;
	readonly label = "Session Search";
	readonly summary = "Search the verbatim content of past sessions and open transcript windows";
	readonly description = prompt.render(sessionSearchDescription);
	readonly parameters = sessionSearchSchema;
	readonly concurrency = "shared";
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {}

	async execute(_toolCallId: string, params: SessionSearchParams): Promise<AgentToolResult> {
		const cwd = this.session.cwd;
		if (params.op === "find") {
			if (!params.query?.trim()) throw new ToolError("session_search find requires query");
			const view = await archiveFind(
				params.query,
				resolveProject(params.project, cwd),
				params.limit ?? DEFAULT_FIND_LIMIT,
				this.session.getSessionId?.() ?? "",
				{ currentCwd: cwd, indexThinking: cfgArchiveIndexThinking.get(this.session.settings) },
			);
			return { content: [{ type: "text", text: view.text }], details: view.records };
		}
		if (!params.id?.trim()) throw new ToolError("session_search open requires id");
		const view = await archiveOpen(
			params.id.endsWith(".jsonl") ? resolveToCwd(params.id, cwd) : params.id,
			params.line,
		);
		return { content: [{ type: "text", text: view.text }], details: view.records };
	}
}
