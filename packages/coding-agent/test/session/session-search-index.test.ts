import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { reconcile } from "@oh-my-pi/pi-coding-agent/session/session-search/indexer";
import { openSessionSearchDbAt } from "@oh-my-pi/pi-coding-agent/session/session-search/schema";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

let root: string;
let sessionsRoot: string;
let db: Database;

const header = (id: string, title?: string) =>
	JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/work/app", title });
const user = (text: string) =>
	JSON.stringify({
		type: "message",
		id: crypto.randomUUID(),
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	});
const toolResult = (text: string) =>
	JSON.stringify({
		type: "message",
		id: crypto.randomUUID(),
		timestamp: "2026-01-01T00:00:02.000Z",
		message: {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "bash",
			content: [{ type: "text", text }],
			timestamp: 2,
		},
	});
const assistantThinking = (thinking: string, text: string) =>
	JSON.stringify({
		type: "message",
		id: crypto.randomUUID(),
		timestamp: "2026-01-01T00:00:03.000Z",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking },
				{ type: "text", text },
			],
			timestamp: 3,
		},
	});

function sessionFile(id: string): string {
	const dir = path.join(sessionsRoot, "--work-app--");
	fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, `1700000000000_${id}.jsonl`);
}

function docs(): Array<{ type: string; line_no: number; text: string }> {
	return db
		.query<{ type: string; line_no: number; text: string }, []>(
			"SELECT type, line_no, text FROM session_docs ORDER BY id",
		)
		.all();
}

function state(id: string): { indexed_bytes: number; indexed_lines: number; title: string | null } | null {
	return db
		.query<{ indexed_bytes: number; indexed_lines: number; title: string | null }, [string]>(
			"SELECT indexed_bytes, indexed_lines, title FROM session_index_state WHERE session_id = ?",
		)
		.get(id);
}

function bumpMtime(file: string, seconds: number): void {
	const time = new Date(Date.now() + seconds * 1000);
	fs.utimesSync(file, time, time);
}

const run = (opts: { budgetMs?: number; indexThinking?: boolean } = {}) =>
	reconcile(db, { sessionsRoot, budgetMs: opts.budgetMs ?? 10_000, indexThinking: opts.indexThinking ?? false });

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-search-"));
	sessionsRoot = path.join(root, "sessions");
	db = openSessionSearchDbAt(path.join(root, "session-search.db"));
});

afterEach(() => {
	db.close();
	removeSyncWithRetries(root);
});

describe("session search indexer", () => {
	it("indexes only appended complete lines", () => {
		const file = sessionFile("s1");
		fs.writeFileSync(file, `${header("s1")}\n${user("first prompt")}\n${user("second prompt").slice(0, 30)}`);
		expect(run().complete).toBe(true);
		expect(docs()).toEqual([{ type: "user", line_no: 2, text: "first prompt" }]);
		const completeBytes = Buffer.byteLength(`${header("s1")}\n${user("first prompt")}\n`);
		expect(state("s1")?.indexed_bytes).toBe(completeBytes);

		fs.writeFileSync(file, `${header("s1")}\n${user("first prompt")}\n${user("second prompt")}\n`);
		bumpMtime(file, 5);
		run();
		expect(docs().map(doc => doc.text)).toEqual(["first prompt", "second prompt"]);
		expect(docs()[1]?.line_no).toBe(3);
	});

	it("reindexes a shrunk file and refreshes a rewritten title without duplicating docs", () => {
		const file = sessionFile("s2");
		fs.writeFileSync(file, `${header("s2", "aaaa")}\n${user("one")}\n${user("two")}\n`);
		run();
		expect(docs()).toHaveLength(2);

		fs.writeFileSync(file, `${header("s2", "bbbb")}\n${user("one")}\n${user("two")}\n`);
		bumpMtime(file, 5);
		run();
		expect(docs()).toHaveLength(2);
		expect(state("s2")?.title).toBe("bbbb");

		fs.writeFileSync(file, `${header("s2", "bbbb")}\n${user("solo")}\n`);
		bumpMtime(file, 10);
		run();
		expect(docs().map(doc => doc.text)).toEqual(["solo"]);
		expect(state("s2")?.indexed_lines).toBe(2);
	});

	it("redacts credentials in tool results", () => {
		const secret = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrSt";
		fs.writeFileSync(sessionFile("s3"), `${header("s3")}\n${toolResult(`export KEY=${secret} done`)}\n`);
		run();
		const [doc] = docs();
		expect(doc?.text).toContain("[redacted]");
		expect(doc?.text).not.toContain(secret);
	});

	it("excludes thinking unless enabled", () => {
		fs.writeFileSync(sessionFile("s4"), `${header("s4")}\n${assistantThinking("private plan", "public answer")}\n`);
		run();
		expect(docs().map(doc => doc.type)).toEqual(["assistant"]);

		db.run("DELETE FROM session_docs");
		db.run("DELETE FROM session_index_state");
		run({ indexThinking: true });
		expect(docs().map(doc => doc.type)).toEqual(["thinking", "assistant"]);
	});

	it("stops at the budget and reports incomplete", () => {
		for (const id of ["b1", "b2", "b3"])
			fs.writeFileSync(sessionFile(id), `${header(id)}\n${user(`prompt ${id}`)}\n`);
		const result = run({ budgetMs: 0 });
		expect(result.complete).toBe(false);
		expect(result.indexedFiles).toBeLessThan(3);
	});

	it("indexes current-format files that start with the title slot", () => {
		const file = sessionFile("t1");
		const slot = serializeTitleSlot({ title: "Slot title", updatedAt: "2026-01-01T00:00:00.000Z" });
		fs.writeFileSync(file, `${slot}${header("t1")}\n${user("needle in slot file")}\n`);
		run();
		expect(docs()).toEqual([{ type: "user", line_no: 3, text: "needle in slot file" }]);
		expect(state("t1")?.title).toBe("Slot title");

		const renamed = serializeTitleSlot({ title: "Renamed title", updatedAt: "2026-01-02T00:00:00.000Z" });
		const body = fs.readFileSync(file, "utf8").slice(slot.length);
		fs.writeFileSync(file, `${renamed}${body}`);
		bumpMtime(file, 5);
		run();
		expect(docs()).toHaveLength(1);
		expect(state("t1")?.title).toBe("Renamed title");
	});
});
