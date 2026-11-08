/**
 * Read-only views over the user's local history, backing the `archive` eval
 * prelude: recent projects, their sessions with idle recaps, and prompt history.
 *
 * Sources: session JSONL files under the sessions root (stat-ordered; only the
 * listed files get a bounded header/tail scan, never a full transcript read)
 * and history.db (prompt history plus the recap journal). Each view returns
 * plain records and a compact text rendering the prelude prints.
 *
 * Scopes are resolved by the caller: a project is an absolute working
 * directory, and `undefined` spans every project.
 */
import * as path from "node:path";
import { previewLine, shortenPath, TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui/render/render-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { formatAge, formatCount, isRecord } from "@oh-my-pi/pi-utils";
import { type HistoryEntry, HistoryStorage } from "../session/history-storage";
import { listSessionRecaps, type SessionRecap } from "../session/session-index";
import {
	findSessionFiles,
	listRecentProjects,
	listRecentSessions,
	readSessionInfo,
	type SessionInfo,
	type SessionStatus,
	sessionDisplayName,
} from "../session/session-listing";
import { sessionDirForCwd } from "../session/session-paths";
import { formatSessionHistoryMarkdown } from "../session/session-history-format";
import { SessionSearchIndexClient } from "../session/session-search/client";
import { querySessionContent } from "../session/session-search/query";
import { openSessionSearchDb } from "../session/session-search/schema";
import { parseTitleSlotLine } from "../session/session-title-slot";

/** A listed session. Times are ISO-8601. */
export interface ArchiveSession {
	id: string;
	/** Session JSONL file. */
	file: string;
	/** Working directory the session ran in. */
	project: string;
	/** Title, else first prompt, else a timestamp label. */
	title: string;
	created: string;
	modified: string;
	messages: number;
	status?: SessionStatus;
	/** Newest journaled idle recap. */
	recap?: string;
}

/** A project with its newest session. */
export interface ArchiveProject {
	/** Working directory; pass it as `project` to scope other views. */
	path: string;
	/** Session files in the project, empty ones included. */
	sessions: number;
	lastActive: string;
	latest: ArchiveSession;
}

/** A unique prompt from prompt history, with its latest submission's provenance. */
export interface ArchivePrompt {
	text: string;
	/** Latest submission time. */
	at: string;
	project?: string;
	session?: string;
	/** Submissions of this exact prompt. */
	uses: number;
}

/** A journaled idle recap. */
export interface ArchiveRecap {
	text: string;
	at: string;
	session: string;
	project: string;
}

/** One session with its full recap journal and prompt history. */
export interface ArchiveSessionDetail extends ArchiveSession {
	/** Session file this one was forked from. */
	parent?: string;
	/** Every journaled recap, oldest first. */
	recaps: ArchiveRecap[];
	/** Newest prompts submitted in this session, oldest first. */
	prompts: ArchivePrompt[];
}

/** Records plus the text rendering the prelude prints for them. */
export interface ArchiveView<T> {
	text: string;
	records: T;
}

/** One session matching a content search, with its best-scoring doc. */
export interface ArchiveFindHit {
	session: string;
	project: string;
	title: string;
	/** Time of the matching entry. */
	at: string;
	/** Evidence type of the best match: user, assistant, tool_call, tool_result, summary, thinking, custom. */
	type: string;
	snippet: string;
	/** 1-based JSONL line of the best match (pass to `archiveOpen`). */
	line: number;
	file: string;
	/** Further matching entries in the same session. */
	more: number;
}

/** A window of one session transcript. */
export interface ArchiveOpenWindow {
	file: string;
	from: number;
	to: number;
	total: number;
}

const FIND_SNIPPET_WIDTH = 240;
const FIND_RECAP_WIDTH = 160;
const OPEN_SUMMARY_WIDTH = 1500;
const OPEN_MAX_CHARS = 12_000;
/** Indexing budget spent before each find; the worker keeps catching up across calls. */
const FIND_RECONCILE_BUDGET_MS = 300;

/** Display width of a prompt preview in listings; records keep the full text. */
const PROMPT_PREVIEW_WIDTH = 160;
/** Display width of a prompt inside a session detail view. */
const PROMPT_DETAIL_WIDTH = 600;
/**
 * Listed id length. 13 characters cover the 48-bit millisecond timestamp of a
 * UUIDv7 id (and 48 random bits of a UUIDv4), so listed prefixes stay unique
 * in practice while every view accepts any unique prefix.
 */
const SHORT_ID_LENGTH = 13;

/** Recent projects, newest activity first. */
export async function archiveProjects(limit: number): Promise<ArchiveView<ArchiveProject[]>> {
	const projects = await listRecentProjects(limit);
	const recaps = latestRecaps(projects.map(project => project.latest.id));
	const records = projects.map(project => ({
		path: project.cwd,
		sessions: project.sessionCount,
		lastActive: project.latest.modified.toISOString(),
		latest: toArchiveSession(project.latest, recaps.get(project.latest.id)),
	}));
	if (records.length === 0) return { text: "No projects with sessions yet.", records };
	const lines = ["Recent projects, newest first:"];
	for (const project of records) {
		lines.push(
			`- ${shortenPath(project.path)} · ${formatCount("session", project.sessions)} · active ${ago(project.lastActive)}`,
			`  latest ${shortId(project.latest.id)} · ${project.latest.title}`,
		);
		if (project.latest.recap) lines.push(`  recap: ${previewLine(project.latest.recap, TRUNCATE_LENGTHS.RECAP)}`);
	}
	return { text: lines.join("\n"), records };
}

/** Newest non-empty sessions of one project (`cwd`) or of every project. */
export async function archiveSessions(cwd: string | undefined, limit: number): Promise<ArchiveView<ArchiveSession[]>> {
	const sessions = await listRecentSessions({ limit, sessionDir: cwd ? sessionDirForCwd(cwd) : undefined });
	const recaps = latestRecaps(sessions.map(session => session.id));
	const records = sessions.map(session => toArchiveSession(session, recaps.get(session.id)));
	if (records.length === 0) return { text: `No sessions ${scopeLabel(cwd)}.`, records };
	const lines = [`Sessions ${scopeLabel(cwd)}, newest first:`];
	for (const session of records) {
		const facts = [shortId(session.id), ago(session.modified)];
		if (!cwd && session.project) facts.push(shortenPath(session.project));
		facts.push(formatCount("msg", session.messages));
		if (session.status && session.status !== "complete" && session.status !== "unknown") facts.push(session.status);
		facts.push(session.title);
		lines.push(`- ${facts.join(" · ")}`);
		if (session.recap) lines.push(`  recap: ${previewLine(session.recap, TRUNCATE_LENGTHS.RECAP)}`);
	}
	return { text: lines.join("\n"), records };
}

/**
 * One session by id prefix or absolute file path, with every recap and its
 * newest `limit` prompts.
 *
 * @throws {ToolError} when no session or several sessions match, or the file is not a session.
 */
export async function archiveSession(idOrFile: string, limit: number): Promise<ArchiveView<ArchiveSessionDetail>> {
	const file = path.isAbsolute(idOrFile) ? idOrFile : await resolveSessionFile(idOrFile);
	const info = await readSessionInfo(file);
	if (!info) throw new ToolError(`Not a readable session file: ${shortenPath(file)}`);
	const recaps = listSessionRecaps({ sessionIds: [info.id] })
		.map(toArchiveRecap)
		.reverse();
	const prompts = HistoryStorage.open().getRecent(limit, { sessionId: info.id }).map(toArchivePrompt).reverse();
	const record: ArchiveSessionDetail = {
		...toArchiveSession(info, recaps.at(-1)?.text),
		parent: info.parentSessionPath,
		recaps,
		prompts,
	};

	const facts = [`project ${shortenPath(record.project)}`, `created ${ago(record.created)}`];
	facts.push(`active ${ago(record.modified)}`, formatCount("msg", record.messages));
	if (record.status) facts.push(record.status);
	const lines = [`Session ${record.id} · ${record.title}`, facts.join(" · "), `file ${shortenPath(record.file)}`];
	if (record.parent) lines.push(`forked from ${shortenPath(record.parent)}`);
	lines.push("");
	if (recaps.length === 0) lines.push("No recaps journaled.");
	else {
		lines.push("Recaps, oldest first:");
		for (const recap of recaps) lines.push(`- ${ago(recap.at)}: ${previewLine(recap.text, TRUNCATE_LENGTHS.RECAP)}`);
	}
	if (prompts.length === 0) lines.push("No prompts in prompt history.");
	else {
		const more = prompts.length === limit ? `latest ${limit}, ` : "";
		lines.push(`Prompts, ${more}oldest first:`);
		for (const prompt of prompts) lines.push(`- ${ago(prompt.at)}: ${previewLine(prompt.text, PROMPT_DETAIL_WIDTH)}`);
	}
	return { text: lines.join("\n"), records: record };
}

/** Prompt history of one project (`cwd`) or every project, newest first; `query` switches to token search. */
export function archivePrompts(
	query: string | undefined,
	cwd: string | undefined,
	limit: number,
): ArchiveView<ArchivePrompt[]> {
	const history = HistoryStorage.open();
	const filter = { cwd };
	const entries = query ? history.search(query, limit, filter) : history.getRecent(limit, filter);
	const records = entries.map(toArchivePrompt);
	const subject = query ? `${scopeLabel(cwd)} matching ${JSON.stringify(query)}` : scopeLabel(cwd);
	if (records.length === 0) return { text: `No prompts ${subject}.`, records };
	const lines = [`Prompts ${subject}, newest first:`];
	for (const prompt of records) {
		const facts = [ago(prompt.at)];
		if (!cwd && prompt.project) facts.push(shortenPath(prompt.project));
		if (prompt.session) facts.push(shortId(prompt.session));
		if (prompt.uses > 1) facts.push(`used ${prompt.uses}×`);
		lines.push(`- ${facts.join(" · ")}`, `  ${previewLine(prompt.text, PROMPT_PREVIEW_WIDTH)}`);
	}
	return { text: lines.join("\n"), records };
}

/** Journaled idle recaps of one project (`cwd`) or every project, newest first. */
export function archiveRecaps(cwd: string | undefined, limit: number): ArchiveView<ArchiveRecap[]> {
	const records = listSessionRecaps({ cwd, limit }).map(toArchiveRecap);
	if (records.length === 0) return { text: `No recaps ${scopeLabel(cwd)}.`, records };
	const lines = [`Recaps ${scopeLabel(cwd)}, newest first:`];
	for (const recap of records) {
		const facts = [ago(recap.at)];
		if (!cwd) facts.push(shortenPath(recap.project));
		facts.push(shortId(recap.session));
		lines.push(`- ${facts.join(" · ")}`, `  ${previewLine(recap.text, TRUNCATE_LENGTHS.RECAP)}`);
	}
	return { text: lines.join("\n"), records };
}

/**
 * Verbatim content search over past sessions (assistant text, tool calls and
 * results, summaries): one row per session, best match first. Spends a small
 * indexing budget first; `cwd` undefined spans every project.
 *
 * @throws {ToolError} when the query is empty or the index cannot be opened.
 */
export async function archiveFind(
	query: string,
	cwd: string | undefined,
	limit: number,
	currentSessionId: string,
	opts: { currentCwd?: string; indexThinking?: boolean } = {},
): Promise<ArchiveView<ArchiveFindHit[]>> {
	const { complete } = await SessionSearchIndexClient.global().reconcile({
		scopeCwd: cwd ?? opts.currentCwd,
		budgetMs: FIND_RECONCILE_BUDGET_MS,
		indexThinking: opts.indexThinking,
	});
	const db = openSessionSearchDb();
	if (!db) throw new ToolError("Session content index is unavailable.");
	const hits = querySessionContent(db, {
		query,
		cwd,
		currentCwd: opts.currentCwd ?? cwd ?? "",
		currentSessionId,
		limit,
	});
	const states = new Map<string, { file_path: string; title: string | null }>();
	if (hits.length > 0) {
		const placeholders = hits.map(() => "?").join(", ");
		const rows = db
			.query<{ session_id: string; file_path: string; title: string | null }, string[]>(
				`SELECT session_id, file_path, title FROM session_index_state WHERE session_id IN (${placeholders})`,
			)
			.all(...hits.map(hit => hit.sessionId));
		for (const row of rows) states.set(row.session_id, row);
	}
	const recaps = latestRecaps(hits.map(hit => hit.sessionId));
	const records: ArchiveFindHit[] = hits.map(hit => ({
		session: hit.sessionId,
		project: hit.cwd,
		title: states.get(hit.sessionId)?.title || "untitled",
		at: hit.time,
		type: hit.type,
		snippet: hit.snippet,
		line: hit.lineNo,
		file: states.get(hit.sessionId)?.file_path ?? "",
		more: hit.more,
	}));

	const catchingUp = complete ? "" : "; index catching up — rerun for more";
	if (records.length === 0) {
		const note = complete ? "" : " Index catching up — rerun for more.";
		return { text: `No content matches for ${JSON.stringify(query)} ${scopeLabel(cwd)}.${note}`, records };
	}
	const lines = [
		`Content matches for ${JSON.stringify(query)} ${scopeLabel(cwd)} (${formatCount("session", records.length)}${catchingUp})`,
	];
	records.forEach((record, index) => {
		const facts = [shortId(record.session), ago(record.at), record.title];
		if (!cwd) facts.push(shortenPath(record.project));
		lines.push(`${index + 1}. ${facts.join(" · ")}`);
		const tool = hits[index]?.toolName;
		const tag = tool && record.type.startsWith("tool") ? `[${record.type} ${tool}]` : `[${record.type}]`;
		const more = record.more > 0 ? ` (+${record.more} more)` : "";
		lines.push(`   ${tag} ${previewLine(record.snippet, FIND_SNIPPET_WIDTH)}${more}`);
		const recap = recaps.get(record.session);
		if (recap) lines.push(`   recap: ${previewLine(recap, FIND_RECAP_WIDTH)}`);
		lines.push(`   open: archive.open("${shortId(record.session)}", {line: ${record.line}})`);
	});
	return { text: lines.join("\n"), records };
}

/**
 * A window of one session transcript around JSONL `line` (1-based), formatted
 * as a concise markdown transcript; without `line`, the session's last lines.
 *
 * @throws {ToolError} when no session or several sessions match, or the file is not a session.
 */
export async function archiveOpen(
	idOrFile: string,
	line: number | undefined,
	before = 8,
	after = 16,
): Promise<ArchiveView<ArchiveOpenWindow>> {
	const file = path.isAbsolute(idOrFile) ? idOrFile : await resolveSessionFile(idOrFile);
	const allLines = (await Bun.file(file).text()).split("\n");
	if (allLines.at(-1) === "") allLines.pop();
	const total = allLines.length;
	// Current files open with the fixed-width title slot; legacy files with the header.
	const header = parseJsonLine(allLines[parseTitleSlotLine(allLines[0] ?? "") ? 1 : 0]);
	if (!header || header.type !== "session" || typeof header.id !== "string") {
		throw new ToolError(`Not a readable session file: ${shortenPath(file)}`);
	}
	const from = line === undefined ? Math.max(1, total - before - after) : Math.max(1, line - before);
	const to = line === undefined ? total : Math.min(total, line + after);
	const messages: unknown[] = [];
	const summaries: string[] = [];
	for (let lineNo = from; lineNo <= to; lineNo++) {
		const entry = parseJsonLine(allLines[lineNo - 1]);
		if (!entry) continue;
		if (entry.type === "message" && isRecord(entry.message)) messages.push(entry.message);
		else if ((entry.type === "compaction" || entry.type === "branch_summary") && typeof entry.summary === "string") {
			summaries.push(`[summary] ${previewLine(entry.summary, OPEN_SUMMARY_WIDTH)}`);
		}
	}
	const id = header.id;
	// Tool output is usually what a find hit points at; render it (bounded) instead of a one-line status.
	const transcript = formatSessionHistoryMarkdown(messages, { expandToolIO: true });
	const body = [...summaries, transcript].filter(part => part.trim().length > 0).join("\n\n");
	const clipped = body.length > OPEN_MAX_CHARS ? `${body.slice(0, OPEN_MAX_CHARS)}\n…` : body;
	const lines = [`Session ${id} · lines ${from}–${to} of ${total} · ${shortenPath(file)}`, "", clipped];
	if (to < total) lines.push("", `more: archive.open("${shortId(id)}", {line: ${to + after}})`);
	return { text: lines.join("\n"), records: { file, from, to, total } };
}

function parseJsonLine(text: string | undefined): Record<string, unknown> | undefined {
	if (!text) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

async function resolveSessionFile(idPrefix: string): Promise<string> {
	const files = await findSessionFiles(idPrefix);
	if (files.length === 1) return files[0];
	if (files.length === 0) throw new ToolError(`No session id starts with "${idPrefix}".`);
	const ids = files.slice(0, 5).map(file => {
		const name = path.basename(file, ".jsonl");
		return name.slice(name.lastIndexOf("_") + 1);
	});
	throw new ToolError(`"${idPrefix}" matches ${files.length} sessions (${ids.join(", ")}); use a longer prefix.`);
}

/** Newest recap per session id. */
function latestRecaps(sessionIds: string[]): Map<string, string> {
	const latest = new Map<string, string>();
	for (const row of listSessionRecaps({ sessionIds })) {
		if (!latest.has(row.sessionId)) latest.set(row.sessionId, row.recap);
	}
	return latest;
}

function toArchiveSession(info: SessionInfo, recap: string | undefined): ArchiveSession {
	// Headers without a timestamp parse to an Invalid Date, whose toISOString throws.
	const created = Number.isNaN(info.created.getTime()) ? info.modified : info.created;
	return {
		id: info.id,
		file: info.path,
		project: info.cwd,
		title: sessionDisplayName(info),
		created: created.toISOString(),
		modified: info.modified.toISOString(),
		messages: info.messageCount,
		status: info.status,
		recap,
	};
}

function toArchivePrompt(entry: HistoryEntry): ArchivePrompt {
	return {
		text: entry.prompt,
		at: new Date(entry.created_at * 1000).toISOString(),
		project: entry.cwd,
		session: entry.sessionId,
		uses: entry.useCount,
	};
}

function toArchiveRecap(row: SessionRecap): ArchiveRecap {
	return {
		text: row.recap,
		at: new Date(row.createdAt * 1000).toISOString(),
		session: row.sessionId,
		project: row.cwd,
	};
}

/** `in ~/project` or `across all projects`, for view headers. */
function scopeLabel(cwd: string | undefined): string {
	return cwd ? `in ${shortenPath(cwd)}` : "across all projects";
}

/** Relative age of an ISO timestamp (`5m ago`); sub-minute ages read `just now`. */
function ago(iso: string): string {
	return formatAge(Math.max(1, (Date.now() - Date.parse(iso)) / 1000));
}

function shortId(id: string): string {
	return id.slice(0, SHORT_ID_LENGTH);
}
