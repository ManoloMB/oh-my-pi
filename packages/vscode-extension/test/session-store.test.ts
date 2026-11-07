import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { quotedPrompt } from "../src/quoted-prompt";
import { guessSessionDir, listSessions, sessionLabel } from "../src/sessions/session-store";

const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vscode-sessions-"));
	dirs.push(dir);
	return dir;
}

/** A session file as omp writes it: fixed-width title slot, header, then entries. */
function sessionFile(options: {
	title?: string;
	id: string;
	prompts: string[];
	padding?: number;
	timestamp?: string;
}): string {
	const slot = JSON.stringify({ type: "title", v: 1, title: options.title ?? "", updatedAt: "x", pad: "" });
	const header = { type: "session", version: 3, id: options.id, cwd: "/w", timestamp: options.timestamp };
	const lines = [slot, JSON.stringify(header)];
	for (const prompt of options.prompts) {
		lines.push(
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: prompt }] } }),
		);
		lines.push(
			JSON.stringify({
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "x".repeat(options.padding ?? 10) }] },
			}),
		);
	}
	return `${lines.join("\n")}\n`;
}

describe("listSessions", () => {
	it("lists sessions newest first, labelled by title or first prompt, skipping empty ones", async () => {
		const dir = await tempDir();
		const older = path.join(dir, "2026-01-01_a.jsonl");
		const newer = path.join(dir, "2026-01-02_b.jsonl");
		await fs.writeFile(older, sessionFile({ id: "a", prompts: ["first line\nsecond line", "later"] }));
		await fs.writeFile(newer, sessionFile({ title: "Named session", id: "b", prompts: ["hello"] }));
		await fs.writeFile(path.join(dir, "2026-01-03_c.jsonl"), sessionFile({ id: "c", prompts: [] }));
		await fs.utimes(older, new Date("2026-01-01"), new Date("2026-01-01"));
		await fs.utimes(newer, new Date("2026-01-02"), new Date("2026-01-02"));

		const sessions = await listSessions(dir);

		expect(sessions.map(session => session.id)).toEqual(["b", "a"]);
		expect(sessions.map(sessionLabel)).toEqual(["Named session", "first line"]);
		expect(sessions[1]).toMatchObject({ messageCount: 4, truncated: false });
	});

	it("reads when the session started from its header, and leaves it unset when the header has none", async () => {
		const dir = await tempDir();
		await fs.writeFile(
			path.join(dir, "2026-01-01_t.jsonl"),
			sessionFile({ id: "t", prompts: ["hi"], timestamp: "2026-01-01T09:30:00.000Z" }),
		);
		await fs.writeFile(path.join(dir, "2026-01-01_u.jsonl"), sessionFile({ id: "u", prompts: ["hi"] }));

		const byId = Object.fromEntries((await listSessions(dir)).map(session => [session.id, session]));

		expect(byId.t?.created?.toISOString()).toBe("2026-01-01T09:30:00.000Z");
		expect(byId.u?.created).toBeUndefined();
	});

	it("lists a reply to selected text by what the user wrote, not its wrapper", async () => {
		const dir = await tempDir();
		const file = path.join(dir, "2026-01-01_q.jsonl");
		const prompts = [quotedPrompt("an excerpt", "mi pregunta\nmás"), quotedPrompt("other", "luego")];
		await fs.writeFile(file, sessionFile({ id: "q", prompts }));

		const [session] = await listSessions(dir);

		expect(session).toMatchObject({ firstMessage: "mi pregunta", lastMessage: "luego" });
	});

	it("reads only a prefix of long sessions and reports the count as partial", async () => {
		const dir = await tempDir();
		const file = path.join(dir, "2026-01-01_long.jsonl");
		await fs.writeFile(file, sessionFile({ id: "long", prompts: ["start", "more", "even more"], padding: 40_000 }));

		const [session] = await listSessions(dir);

		expect(session).toMatchObject({ id: "long", firstMessage: "start", truncated: true });
		expect(session!.messageCount).toBeLessThan(6);
	});

	it("reports the first and latest prompts, and a session with a single prompt", async () => {
		const dir = await tempDir();
		await fs.writeFile(
			path.join(dir, "2026-01-01_a.jsonl"),
			sessionFile({ id: "a", prompts: ["explain the repo", "now add tests\nwith details"] }),
		);
		await fs.writeFile(path.join(dir, "2026-01-02_b.jsonl"), sessionFile({ id: "b", prompts: ["same text"] }));
		// Two prompts with the same text are still two prompts.
		await fs.writeFile(path.join(dir, "2026-01-03_c.jsonl"), sessionFile({ id: "c", prompts: ["again", "again"] }));

		const byId = Object.fromEntries((await listSessions(dir)).map(session => [session.id, session]));

		expect(byId.a).toMatchObject({
			firstMessage: "explain the repo",
			lastMessage: "now add tests",
			singlePrompt: false,
		});
		expect(byId.b).toMatchObject({ firstMessage: "same text", lastMessage: "same text", singlePrompt: true });
		expect(byId.c).toMatchObject({ firstMessage: "again", lastMessage: "again", singlePrompt: false });
	});

	it("keeps whole prompts on one line, cutting only the middle of a very long one", async () => {
		const dir = await tempDir();
		const long = `start ${"x".repeat(2000)} end`;
		await fs.writeFile(
			path.join(dir, "2026-01-01_f.jsonl"),
			sessionFile({ id: "f", prompts: ["fix the login\n  and the logout", long] }),
		);

		const [session] = await listSessions(dir);

		expect(session).toMatchObject({
			firstMessage: "fix the login",
			firstMessageFull: "fix the login and the logout",
		});
		expect(session?.lastMessageFull).toStartWith("start x");
		expect(session?.lastMessageFull).toEndWith("x end");
		expect(session?.lastMessageFull).toContain(" … ");
		expect(session?.lastMessageFull?.length).toBe(1200 + " … ".length);
	});

	it("finds the latest prompt near the end of a long session, past long tool output", async () => {
		const dir = await tempDir();
		const file = path.join(dir, "2026-01-01_long.jsonl");
		// ~1.2 MB: the latest prompt sits after several 256 KB reads from the end, its line cut by one of them.
		const prompts = ["start", "middle", "latest ñandú prompt"];
		await fs.writeFile(file, `${sessionFile({ id: "long", prompts, padding: 400_000 })}`);

		const [session] = await listSessions(dir);

		expect(session).toMatchObject({
			firstMessage: "start",
			lastMessage: "latest ñandú prompt",
			singlePrompt: false,
			truncated: true,
		});
	});

	it("does not count user messages omp injects as prompts", async () => {
		const dir = await tempDir();
		const file = path.join(dir, "2026-01-01_s.jsonl");
		const injected = JSON.stringify({
			type: "message",
			message: { role: "user", synthetic: true, content: [{ type: "text", text: "<system-notice>job done" }] },
		});
		await fs.writeFile(file, `${sessionFile({ id: "s", prompts: ["only real prompt"] })}${injected}\n`);

		const [session] = await listSessions(dir);

		expect(session).toMatchObject({ lastMessage: "only real prompt", singlePrompt: true });
	});

	it("counts /skill: invocations as prompts, showing what the user typed", async () => {
		const dir = await tempDir();
		const file = path.join(dir, "2026-01-01_k.jsonl");
		// As omp writes them: a user-attributed custom message whose content is the expanded skill.
		const skill = (args: string, attribution = "user") =>
			JSON.stringify({
				type: "custom_message",
				customType: "skill-prompt",
				content: '[IMPORTANT: User invoked the "demo" skill; follow its instructions]\n\nDo the demo thing.',
				display: true,
				details: { name: "demo", args, prompt: `/skill:demo ${args}`, lineCount: 1 },
				attribution,
			});
		const [header, title, ...messages] = sessionFile({ id: "k", prompts: ["plain question"] }).split("\n");
		const lines = [
			header,
			title,
			skill("check the gateway"),
			...messages.filter(Boolean),
			skill("auto-loaded", "agent"),
			skill("last one"),
		];
		await fs.writeFile(file, `${lines.join("\n")}\n`);

		const [session] = await listSessions(dir);

		expect(session).toMatchObject({
			firstMessage: "/skill:demo check the gateway",
			lastMessage: "/skill:demo last one",
			singlePrompt: false,
		});
	});

	it("finds a first prompt whose line is longer than the scanned prefix (an attached image)", async () => {
		const dir = await tempDir();
		const file = path.join(dir, "2026-01-01_img.jsonl");
		const header = sessionFile({ id: "img", prompts: [] });
		const withImage = JSON.stringify({
			type: "message",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "what is in this screenshot?" },
					{ type: "image", data: "A".repeat(300_000), mimeType: "image/png" },
				],
			},
		});
		const rest = sessionFile({ id: "img", prompts: ["follow-up"] })
			.split("\n")
			.slice(2)
			.join("\n");
		await fs.writeFile(file, `${header}${withImage}\n${rest}`);

		const [session] = await listSessions(dir);

		expect(session).toMatchObject({
			firstMessage: "what is in this screenshot?",
			lastMessage: "follow-up",
			singlePrompt: false,
		});
	});

	it("returns nothing for a directory that does not exist yet", async () => {
		expect(await listSessions(path.join(await tempDir(), "missing"))).toEqual([]);
	});
});

describe("guessSessionDir", () => {
	it("encodes home-relative and absolute workspaces like omp's session buckets", async () => {
		const root = "/sessions";
		const home = await fs.realpath(os.homedir());
		expect(await guessSessionDir(root, home)).toBe(path.join(root, "-"));
		expect(await guessSessionDir(root, path.join(home, "Documents", "proj"))).toBe(
			path.join(root, "-Documents-proj"),
		);
		const outside = await tempDir();
		const resolved = await fs.realpath(outside);
		expect(await guessSessionDir(root, outside)).toBe(
			path.join(root, `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`),
		);
	});
});
