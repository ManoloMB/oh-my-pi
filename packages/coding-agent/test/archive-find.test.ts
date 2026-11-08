import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { archiveFind, archiveOpen, archivePrompts } from "@oh-my-pi/pi-coding-agent/archive/archive";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { resetSessionIndexForTests } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { sessionDirForCwd } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { SessionSearchIndexClient } from "@oh-my-pi/pi-coding-agent/session/session-search/client";
import { resetSessionSearchDbForTests } from "@oh-my-pi/pi-coding-agent/session/session-search/schema";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const TRACE = "Error: read ECONNRESET at retry.ts:42";
let root: string;
let projectA: string;
let projectB: string;

/** Writes a session whose bash result carries `resultText`; returns its id, file, and the result's 1-based line. */
function writeSession(cwd: string, resultText: string, at = new Date()): { id: string; file: string; line: number } {
	const id = crypto.randomUUID();
	const dir = sessionDirForCwd(cwd);
	fs.mkdirSync(dir, { recursive: true });
	const stamp = at.toISOString();
	const entries: unknown[] = [
		{ type: "session", version: 3, id, timestamp: stamp, cwd, title: `session ${id.slice(0, 4)}` },
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: stamp,
			message: { role: "user", content: "run the sync", timestamp: 1 },
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: stamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "bun run sync" } }],
				timestamp: 2,
			},
		},
		{
			type: "message",
			id: "r1",
			parentId: "a1",
			timestamp: stamp,
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "bash",
				content: [{ type: "text", text: resultText }],
				timestamp: 3,
			},
		},
	];
	for (let index = 0; index < 25; index++) {
		entries.push({
			type: "message",
			id: `f${index}`,
			parentId: null,
			timestamp: stamp,
			message: { role: "user", content: `filler ${index}`, timestamp: 4 + index },
		});
	}
	const file = path.join(dir, `${at.getTime()}_${id}.jsonl`);
	// Production layout: fixed-width title slot first, then the header and entries.
	const slot = serializeTitleSlot({ title: `session ${id.slice(0, 4)}`, updatedAt: stamp });
	fs.writeFileSync(file, `${slot}${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
	return { id, file, line: 5 };
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-archive-find-"));
	projectA = path.join(root, "a");
	projectB = path.join(root, "b");
	HistoryStorage.close();
	resetSessionIndexForTests();
	SessionSearchIndexClient.resetGlobalForTests();
	resetSessionSearchDbForTests();
	setAgentDir(path.join(root, "agent"));
});

afterEach(() => {
	HistoryStorage.close();
	resetSessionIndexForTests();
	SessionSearchIndexClient.resetGlobalForTests();
	resetSessionSearchDbForTests();
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(path.join(getConfigRootDir(), "agent"));
		delete process.env.PI_CODING_AGENT_DIR;
	}
	removeSyncWithRetries(root);
});

describe("archive content search", () => {
	it("finds tool-result content that prompt search cannot", async () => {
		const a = writeSession(projectA, TRACE);
		writeSession(projectB, "all good");

		const view = await archiveFind("ECONNRESET retry", projectA, 8, "current-session", { currentCwd: projectA });
		expect(view.records).toHaveLength(1);
		const [hit] = view.records;
		expect(hit?.session).toBe(a.id);
		expect(hit?.type).toBe("tool_result");
		const lines = fs.readFileSync(a.file, "utf8").split("\n");
		expect(lines[(hit?.line ?? 0) - 1]).toContain("ECONNRESET at retry.ts:42");
		expect(view.text).toContain(`open: archive.open("${a.id.slice(0, 13)}", {line: ${a.line}})`);

		expect(archivePrompts("ECONNRESET", projectA, 20).records).toHaveLength(0);
	});

	it("excludes the current session and respects the project scope", async () => {
		const a = writeSession(projectA, TRACE);
		writeSession(projectB, "nothing relevant here");

		const excluded = await archiveFind("ECONNRESET", projectA, 8, a.id, { currentCwd: projectA });
		expect(excluded.records).toHaveLength(0);

		const everywhere = await archiveFind("ECONNRESET", undefined, 8, "current-session", { currentCwd: projectA });
		expect(everywhere.records.map(record => record.project)).toEqual([projectA]);
		const scopedToB = await archiveFind("ECONNRESET", projectB, 8, "current-session", { currentCwd: projectA });
		expect(scopedToB.records).toHaveLength(0);
	});

	it("returns one row per session within the limit and a bounded listing", async () => {
		const base = Date.now() - 60_000;
		for (let index = 0; index < 30; index++)
			writeSession(projectA, `${TRACE} attempt ${index}`, new Date(base + index));

		let view = await archiveFind("ECONNRESET", projectA, 8, "current-session", { currentCwd: projectA });
		// The background pass may need more than one call to cover every file.
		for (let attempt = 0; attempt < 10 && view.text.includes("index catching up"); attempt++) {
			view = await archiveFind("ECONNRESET", projectA, 8, "current-session", { currentCwd: projectA });
		}
		expect(view.records).toHaveLength(8);
		expect(new Set(view.records.map(record => record.session)).size).toBe(8);
		expect(view.text.split("\n").length).toBeLessThanOrEqual(8 * 5);
	});

	it("opens a formatted transcript window with a continuation hint", async () => {
		const a = writeSession(projectA, TRACE);
		const view = await archiveOpen(a.id, a.line);
		expect(view.records).toEqual({ file: a.file, from: 1, to: a.line + 16, total: 30 });
		expect(view.text).toContain("ECONNRESET at retry.ts:42");
		expect(view.text).toContain(`Session ${a.id} · lines 1–${a.line + 16} of 30`);
		expect(view.text).toContain(`more: archive.open("${a.id.slice(0, 13)}", {line: ${a.line + 32}})`);
	});
});
