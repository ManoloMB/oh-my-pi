/**
 * Content search over session-search.db: FTS5 BM25 relevance × evidence-type
 * weight × recency decay per doc, aggregated to one row per session.
 */
import type { Database } from "bun:sqlite";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { SessionDocType } from "./extract";

const MAX_TERMS = 12;
const CANDIDATE_LIMIT = 300;
const DAY_MS = 86_400_000;
/** Recency half-weight horizon in days. */
const RECENCY_DAYS = 30;
const EXTRA_HIT_BONUS = 0.1;
const EXTRA_HIT_CAP = 5;
const CURRENT_PROJECT_BOOST = 1.25;

const TYPE_WEIGHT: Record<SessionDocType, number> = {
	user: 1.3,
	assistant: 1.2,
	summary: 1.1,
	tool_call: 1.0,
	tool_result: 0.8,
	thinking: 0.7,
	custom: 0.7,
};

export interface SessionContentQuery {
	query: string;
	/** Project filter; undefined spans every project. */
	cwd: string | undefined;
	/** The caller's project, boosted when searching every project. */
	currentCwd: string;
	/** Excluded from results (the running session). */
	currentSessionId: string;
	limit: number;
	now?: number;
}

export interface SessionContentHit {
	sessionId: string;
	cwd: string;
	lineNo: number;
	type: SessionDocType;
	toolName: string | null;
	time: string;
	snippet: string;
	/** Further matching docs in the same session. */
	more: number;
	score: number;
}

interface DocRow {
	id: number;
	session_id: string;
	cwd: string;
	line_no: number;
	type: SessionDocType;
	tool_name: string | null;
	time: string;
	char_len: number;
	snip: string;
	rank: number;
}

/** AND of quoted terms; the last term matches as a prefix. */
export function buildFtsQuery(query: string): string {
	const terms = query
		.split(/\s+/)
		.filter(term => term.length > 0)
		.slice(0, MAX_TERMS);
	if (terms.length === 0) throw new ToolError("archive.find requires a query");
	return terms
		.map((term, index) => {
			const quoted = `"${term.replaceAll('"', '""')}"`;
			return index === terms.length - 1 ? `${quoted}*` : quoted;
		})
		.join(" ");
}

/** Ranked sessions whose content matches `query`, best first. */
export function querySessionContent(db: Database, params: SessionContentQuery): SessionContentHit[] {
	const match = buildFtsQuery(params.query);
	const rows = db
		.query<DocRow, [string, string | null, string]>(
			`SELECT d.id, d.session_id, d.cwd, d.line_no, d.type, d.tool_name, d.time, d.char_len,
	snippet(session_docs_fts, 0, '«', '»', '…', 24) AS snip, bm25(session_docs_fts) AS rank
FROM session_docs_fts JOIN session_docs d ON d.id = session_docs_fts.rowid
WHERE session_docs_fts MATCH ?1 AND (?2 IS NULL OR d.cwd = ?2) AND d.session_id <> ?3
ORDER BY rank LIMIT ${CANDIDATE_LIMIT}`,
		)
		.all(match, params.cwd ?? null, params.currentSessionId);

	const now = params.now ?? Date.now();
	const bySession = new Map<string, { best: DocRow; bestScore: number; hits: number }>();
	for (const row of rows) {
		const ageDays = Math.max(0, (now - Date.parse(row.time)) / DAY_MS) || 0;
		const score = -row.rank * (TYPE_WEIGHT[row.type] ?? 0.7) * (1 / (1 + ageDays / RECENCY_DAYS));
		const group = bySession.get(row.session_id);
		if (!group) {
			bySession.set(row.session_id, { best: row, bestScore: score, hits: 1 });
			continue;
		}
		group.hits++;
		if (score > group.bestScore) {
			group.best = row;
			group.bestScore = score;
		}
	}

	const hits: SessionContentHit[] = [];
	for (const [sessionId, group] of bySession) {
		const extra = group.hits - 1;
		let score = group.bestScore + EXTRA_HIT_BONUS * Math.min(EXTRA_HIT_CAP, extra);
		if (params.cwd === undefined && group.best.cwd === params.currentCwd) score *= CURRENT_PROJECT_BOOST;
		hits.push({
			sessionId,
			cwd: group.best.cwd,
			lineNo: group.best.line_no,
			type: group.best.type,
			toolName: group.best.tool_name,
			time: group.best.time,
			snippet: group.best.snip,
			more: extra,
			score,
		});
	}
	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, params.limit);
}
