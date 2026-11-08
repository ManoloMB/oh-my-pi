/**
 * Incremental indexer for session-search.db. Appends only the complete lines a
 * session file gained since the last pass; a shrunk file is reindexed from
 * scratch. Runs inside the session-search worker, or inline as a fallback and
 * in tests.
 */
import type { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { sessionDirForCwd } from "../session-paths";
import { parseTitleSlotLine } from "../session-title-slot";
import { extractDocs } from "./extract";

export interface ReconcileOptions {
	sessionsRoot: string;
	/** Project whose session directory is processed first. */
	scopeCwd?: string;
	/** Wall-clock budget; at least one changed file is processed per pass. */
	budgetMs: number;
	indexThinking: boolean;
}

export interface ReconcileResult {
	complete: boolean;
	indexedFiles: number;
}

interface IndexState {
	session_id: string;
	file_path: string;
	cwd: string;
	title: string | null;
	indexed_bytes: number;
	indexed_lines: number;
	mtime_ms: number;
	last_time: string | null;
}

interface SessionHeaderFields {
	id: string;
	cwd: string;
	title: string | null;
}

/** Max bytes read to find the header line when only the title may have changed. */
const HEADER_PROBE_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

function parseHeader(line: string): SessionHeaderFields | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		if (!isRecord(parsed) || parsed.type !== "session" || typeof parsed.id !== "string") return undefined;
		return {
			id: parsed.id,
			cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
			title: typeof parsed.title === "string" ? parsed.title : null,
		};
	} catch {
		return undefined;
	}
}

function readRange(file: string, start: number, end: number): Buffer {
	const length = Math.max(0, end - start);
	const buffer = Buffer.allocUnsafe(length);
	const fd = fs.openSync(file, "r");
	try {
		let read = 0;
		while (read < length) {
			const n = fs.readSync(fd, buffer, read, length - read, start + read);
			if (n === 0) break;
			read += n;
		}
		return read === length ? buffer : buffer.subarray(0, read);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Session id/cwd/title from the file head. Current files start with the
 * fixed-width title slot (the mutable title) followed by the session header;
 * legacy files start with the header itself.
 */
function readHeader(file: string, size: number): SessionHeaderFields | undefined {
	const probe = readRange(file, 0, Math.min(size, HEADER_PROBE_BYTES)).toString("utf8");
	const [first = "", second = ""] = probe.split("\n", 2);
	const slot = parseTitleSlotLine(first);
	if (!slot) return parseHeader(first);
	const header = parseHeader(second);
	return header && slot.title ? { ...header, title: slot.title } : header;
}

function listSessionFiles(sessionsRoot: string, scopeCwd: string | undefined): string[] {
	if (!fs.existsSync(sessionsRoot)) return [];
	const files = Array.from(new Bun.Glob("*/*.jsonl").scanSync(sessionsRoot), name => path.join(sessionsRoot, name));
	if (!scopeCwd) return files;
	const scopeDir = `${sessionDirForCwd(scopeCwd, sessionsRoot)}${path.sep}`;
	const first = files.filter(file => file.startsWith(scopeDir));
	const rest = files.filter(file => !file.startsWith(scopeDir));
	return [...first, ...rest];
}

/** Index every changed session file under `sessionsRoot` within the budget. */
export function reconcile(db: Database, opts: ReconcileOptions): ReconcileResult {
	const start = performance.now();
	const states = new Map<string, IndexState>();
	for (const row of db.query<IndexState, []>("SELECT * FROM session_index_state").all())
		states.set(row.file_path, row);

	using insertDoc = db.prepare(
		"INSERT INTO session_docs (session_id, cwd, line_no, type, tool_name, time, text, char_len) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	);
	using deleteDocs = db.prepare("DELETE FROM session_docs WHERE session_id = ?");
	using upsertState = db.prepare(`
INSERT INTO session_index_state (session_id, file_path, cwd, title, indexed_bytes, indexed_lines, mtime_ms, last_time)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
	file_path = excluded.file_path, cwd = excluded.cwd, title = excluded.title,
	indexed_bytes = excluded.indexed_bytes, indexed_lines = excluded.indexed_lines,
	mtime_ms = excluded.mtime_ms, last_time = excluded.last_time`);

	const indexFile = db.transaction((file: string, size: number, mtimeMs: number, prior: IndexState | undefined) => {
		const restart = prior === undefined || size < prior.indexed_bytes;
		let offset = restart ? 0 : prior.indexed_bytes;
		let lineNo = restart ? 0 : prior.indexed_lines;
		let sessionId = restart ? undefined : prior.session_id;
		let cwd = restart ? "" : prior.cwd;
		let title = restart ? null : prior.title;
		let lastTime = restart ? null : (prior?.last_time ?? null);
		if (restart && prior) deleteDocs.run(prior.session_id);

		if (size > offset) {
			const chunk = readRange(file, offset, size);
			const end = chunk.lastIndexOf(NEWLINE);
			if (end >= 0) {
				const lines = chunk.subarray(0, end).toString("utf8").split("\n");
				for (const line of lines) {
					lineNo++;
					if (!sessionId) {
						const slot = parseTitleSlotLine(line);
						if (slot) {
							if (slot.title) title = slot.title;
							continue;
						}
						const header = parseHeader(line);
						if (!header) return false;
						sessionId = header.id;
						cwd = header.cwd;
						title = title ?? header.title;
						continue;
					}
					if (!sessionId || line.length === 0) continue;
					let entry: unknown;
					try {
						entry = JSON.parse(line);
					} catch {
						continue;
					}
					for (const doc of extractDocs(entry, lineNo, { indexThinking: opts.indexThinking })) {
						insertDoc.run(
							sessionId,
							cwd,
							lineNo,
							doc.type,
							doc.toolName ?? null,
							doc.time,
							doc.text,
							doc.charLen,
						);
						lastTime = doc.time;
					}
				}
				offset += end + 1;
			}
		}
		if (!restart) {
			const header = readHeader(file, size);
			if (header && header.id === sessionId) title = header.title;
		}
		if (!sessionId) return false;
		upsertState.run(sessionId, file, cwd, title, offset, lineNo, Math.floor(mtimeMs), lastTime);
		return true;
	});

	let indexedFiles = 0;
	let processed = 0;
	for (const file of listSessionFiles(opts.sessionsRoot, opts.scopeCwd)) {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(file);
		} catch {
			continue;
		}
		const prior = states.get(file);
		if (prior && prior.mtime_ms === Math.floor(stat.mtimeMs) && stat.size >= prior.indexed_bytes) continue;
		if (processed > 0 && performance.now() - start >= opts.budgetMs) return { complete: false, indexedFiles };
		processed++;
		try {
			if (indexFile(file, stat.size, stat.mtimeMs, prior)) indexedFiles++;
		} catch (error) {
			logger.debug("Session search indexing failed", { file, error: String(error) });
		}
	}
	return { complete: true, indexedFiles };
}
