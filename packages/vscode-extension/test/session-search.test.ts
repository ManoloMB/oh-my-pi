import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionSearch } from "../src/sessions/session-search";

const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vscode-search-"));
	dirs.push(dir);
	return dir;
}

const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (...content: unknown[]) => ({ type: "message", message: { role: "assistant", content } });
const toolResult = (text: string) => ({
	type: "message",
	message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text }] },
});

async function writeSession(dir: string, name: string, entries: unknown[]): Promise<string> {
	const file = path.join(dir, `${name}.jsonl`);
	const lines = [{ type: "title", title: "" }, { type: "session", id: name }, ...entries];
	await fs.writeFile(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	return file;
}

describe("session search", () => {
	it("finds words from answers, thinking, tool calls and tool output, not only prompts", async () => {
		const dir = await tempDir();
		const file = await writeSession(dir, "a", [
			user("revisa el despliegue"),
			assistant(
				{ type: "thinking", thinking: "maybe the readiness probe" },
				{ type: "toolCall", name: "bash", arguments: { command: "kubectl get pods -n pagos" } },
			),
			toolResult("Error: ImagePullBackOff for registry.unicaja/api:1.4"),
			assistant({ type: "text", text: "El pod falla al descargar la imagen" }),
		]);
		await writeSession(dir, "b", [user("otra cosa"), assistant({ type: "text", text: "nada que ver" })]);
		const search = new SessionSearch();

		for (const [query, source] of [
			["readiness", "thinking"],
			["pagos", "tool"],
			["ImagePullBackOff", "output"],
			["descargar", "answer"],
		] as const) {
			const hits = await search.search([dir], query);
			expect(hits.map(hit => hit.path)).toEqual([file]);
			expect(hits[0]!.snippet?.source).toBe(source);
		}
	});

	it("ignores case and accents, and needs every term but not in the same message", async () => {
		const dir = await tempDir();
		const file = await writeSession(dir, "a", [
			user("¿Por qué falla la canción?"),
			assistant({ type: "text", text: "Revisa el Códec de audio" }),
		]);
		await writeSession(dir, "b", [user("cancion sin más")]);
		const search = new SessionSearch();

		expect((await search.search([dir], "CANCION codec")).map(hit => hit.path)).toEqual([file]);
		const [hit] = await search.search([dir], "codec");
		// The snippet keeps the original text; the range marks the accented word.
		expect(hit!.snippet!.text.slice(...hit!.snippet!.ranges[0]!)).toBe("Códec");
	});

	it("matches words one edit away only for terms no session contains as typed", async () => {
		const dir = await tempDir();
		const file = await writeSession(dir, "a", [user("configura el kubernetes ingress")]);
		await writeSession(dir, "b", [user("el ingres de la semana")]);
		const search = new SessionSearch();

		const typo = await search.search([dir], "kubernetis");
		expect(typo.map(hit => hit.path)).toEqual([file]);
		expect(typo[0]!.fuzzy).toBe(true);
		// "ingress" exists as typed, so "ingres" does not widen to it (and vice versa).
		expect((await search.search([dir], "ingress")).map(hit => hit.path)).toEqual([file]);
	});

	it("ranks a session that has the terms in a prompt above one that only has them in tool output", async () => {
		const dir = await tempDir();
		const inOutput = await writeSession(dir, "a", [user("hola"), toolResult("timeout reached")]);
		const inPrompt = await writeSession(dir, "b", [user("por qué hay un timeout")]);

		const hits = await new SessionSearch().search([dir], "timeout");

		expect(hits.map(hit => hit.path)).toEqual([inPrompt, inOutput]);
	});

	it("sees what a running session appended since the last search", async () => {
		const dir = await tempDir();
		const file = await writeSession(dir, "a", [user("primera pregunta")]);
		const search = new SessionSearch();
		expect(await search.search([dir], "zanahoria")).toEqual([]);

		await fs.appendFile(file, `${JSON.stringify(assistant({ type: "text", text: "una zanahoria" }))}\n`);

		expect((await search.search([dir], "zanahoria")).map(hit => hit.path)).toEqual([file]);
	});
});
