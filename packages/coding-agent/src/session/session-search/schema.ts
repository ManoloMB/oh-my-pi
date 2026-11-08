/**
 * session-search.db: a derived full-text index of past session content
 * (assistant text, tool calls and results, summaries). Kept apart from
 * history.db so indexing never contends for the interactive history locks and
 * the file can be deleted and rebuilt at any time. A schema version mismatch
 * drops and recreates every table.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getSessionSearchDbPath } from "@oh-my-pi/pi-utils/dirs";
import { getDbBusyTimeoutMs } from "@oh-my-pi/pi-utils/env";
import * as logger from "@oh-my-pi/pi-utils/logger";

export const SESSION_SEARCH_SCHEMA_VERSION = 1;

const SESSION_SEARCH_DDL = `
CREATE TABLE IF NOT EXISTS session_docs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id TEXT NOT NULL, cwd TEXT NOT NULL, line_no INTEGER NOT NULL,
	type TEXT NOT NULL, tool_name TEXT, time TEXT NOT NULL,
	text TEXT NOT NULL, char_len INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_docs_session ON session_docs(session_id, line_no);
CREATE VIRTUAL TABLE IF NOT EXISTS session_docs_fts USING fts5(text, content='session_docs', content_rowid='id', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS session_docs_ai AFTER INSERT ON session_docs BEGIN
	INSERT INTO session_docs_fts(rowid, text) VALUES (new.id, new.text); END;
CREATE TRIGGER IF NOT EXISTS session_docs_ad AFTER DELETE ON session_docs BEGIN
	INSERT INTO session_docs_fts(session_docs_fts, rowid, text) VALUES('delete', old.id, old.text); END;
CREATE TABLE IF NOT EXISTS session_index_state (
	session_id TEXT PRIMARY KEY, file_path TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT,
	indexed_bytes INTEGER NOT NULL, indexed_lines INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, last_time TEXT
);
`;

/**
 * Open (creating or migrating) the index at `dbPath`. Each caller owns the
 * returned connection; the worker keeps one, the main thread caches one via
 * {@link openSessionSearchDb}.
 */
export function openSessionSearchDbAt(dbPath: string): Database {
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	try {
		// Install the busy handler BEFORE any lock-taking statement.
		db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
		db.run("PRAGMA journal_mode=WAL");
		db.run("PRAGMA synchronous=NORMAL");
		// Version check and rebuild in one write transaction so a concurrent opener
		// (worker vs main thread) never drops tables the other just populated.
		db.transaction(() => {
			const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
			if (version === SESSION_SEARCH_SCHEMA_VERSION) return;
			db.run("DROP TRIGGER IF EXISTS session_docs_ai");
			db.run("DROP TRIGGER IF EXISTS session_docs_ad");
			db.run("DROP TABLE IF EXISTS session_docs_fts");
			db.run("DROP TABLE IF EXISTS session_docs");
			db.run("DROP TABLE IF EXISTS session_index_state");
			db.run(SESSION_SEARCH_DDL);
			db.run(`PRAGMA user_version = ${SESSION_SEARCH_SCHEMA_VERSION}`);
		}).immediate();
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

let handle: { dbPath: string; db: Database } | undefined;
/** Db path whose open failed; skip retries (and log spam) until the path changes. */
let failedPath: string | undefined;

/**
 * Main-thread connection for queries, re-resolved against the current agent
 * dir on every call so profile switches and test isolation reopen the right file.
 */
export function openSessionSearchDb(): Database | undefined {
	const dbPath = getSessionSearchDbPath();
	if (handle?.dbPath === dbPath) return handle.db;
	if (failedPath === dbPath) return undefined;
	resetSessionSearchDbForTests();
	try {
		handle = { dbPath, db: openSessionSearchDbAt(dbPath) };
		failedPath = undefined;
		return handle.db;
	} catch (error) {
		failedPath = dbPath;
		logger.warn("Session search index unavailable", { dbPath, error: String(error) });
		return undefined;
	}
}

/** Close the cached main-thread connection. */
export function resetSessionSearchDbForTests(): void {
	if (!handle) return;
	try {
		handle.db.close();
	} catch {}
	handle = undefined;
}

/**
 * Drop every indexed doc and index state row of `sessionIds` (used by `omp gc`
 * when sessions are archived). Returns the number of docs removed; a missing
 * index file removes nothing.
 */
export function deleteSessionSearchRows(
	sessionIds: readonly string[],
	dbPath: string = getSessionSearchDbPath(),
): number {
	if (sessionIds.length === 0 || !fs.existsSync(dbPath)) return 0;
	const db = openSessionSearchDbAt(dbPath);
	try {
		// `changes` also counts the FTS delete-trigger writes; count the docs themselves.
		using countDocs = db.prepare<{ n: number }, [string]>(
			"SELECT COUNT(*) AS n FROM session_docs WHERE session_id = ?",
		);
		using deleteDocs = db.prepare("DELETE FROM session_docs WHERE session_id = ?");
		using deleteState = db.prepare("DELETE FROM session_index_state WHERE session_id = ?");
		let deleted = 0;
		db.transaction((ids: readonly string[]) => {
			for (const id of ids) {
				deleted += countDocs.get(id)?.n ?? 0;
				deleteDocs.run(id);
				deleteState.run(id);
			}
		})(sessionIds);
		return deleted;
	} finally {
		db.close();
	}
}
