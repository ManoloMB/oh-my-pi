import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { git } from "../src/checkpoints/git";
import { changedFiles, snapshotTree } from "../src/checkpoints/snapshots";
import { callChanges } from "../src/editor-changes/call-changes";
import { diffFile } from "../src/editor-changes/hunks";

const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-vscode-editor-changes-")));
	dirs.push(dir);
	return dir;
}

/** A repository with one commit of `files`. */
async function repo(dir: string, files: Record<string, string | Uint8Array>): Promise<string> {
	await git(dir, ["init", "-q"]);
	await git(dir, ["config", "user.email", "t@t"]);
	await git(dir, ["config", "user.name", "t"]);
	await write(dir, files);
	await git(dir, ["add", "-A"]);
	await git(dir, ["commit", "-qm", "init"]);
	return dir;
}

async function write(dir: string, files: Record<string, string | Uint8Array>): Promise<void> {
	for (const [file, content] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
		await fs.writeFile(path.join(dir, file), content);
	}
}

const lines = (count: number, edit: Record<number, string> = {}) =>
	`${Array.from({ length: count }, (_, index) => edit[index + 1] ?? String(index + 1)).join("\n")}\n`;

const noNow = (): Promise<string> => {
	throw new Error("the turn has its after snapshot");
};

describe("diffFile", () => {
	it("reports each file's status and the changed lines of both sides", async () => {
		const dir = await repo(await tempDir(), { "a.txt": lines(10), "b.txt": "x\n", "gone.txt": "g\n" });
		const before = await snapshotTree(dir);
		await write(dir, { "a.txt": lines(12, { 5: "five" }), "new.txt": "n1\nn2\n" });
		await fs.rm(path.join(dir, "gone.txt"));
		const after = await snapshotTree(dir);

		expect((await changedFiles(dir, before, after)).sort()).toEqual(["a.txt", "gone.txt", "new.txt"]);
		expect(await diffFile(dir, before, after, "a.txt")).toEqual({
			status: "modified",
			hunks: [
				{ oldStart: 5, oldLines: ["5"], newStart: 5, newLines: ["five"] },
				{ oldStart: 10, oldLines: [], newStart: 11, newLines: ["11", "12"] },
			],
			added: 3,
			removed: 1,
		});
		const created = await diffFile(dir, before, after, "new.txt");
		expect(created?.status).toBe("added");
		expect(created?.hunks.map(hunk => hunk.newLines)).toEqual([["n1", "n2"]]);
		const deleted = await diffFile(dir, before, after, "gone.txt");
		expect(deleted?.status).toBe("deleted");
		expect(deleted?.removed).toBe(1);
		expect(await diffFile(dir, before, after, "b.txt")).toBeUndefined();
	});

	it("reports binary files without line changes", async () => {
		const dir = await repo(await tempDir(), { "img.bin": new Uint8Array([0, 1, 2]) });
		const before = await snapshotTree(dir);
		await write(dir, { "img.bin": new Uint8Array([0, 3, 4]) });
		const after = await snapshotTree(dir);

		expect(await diffFile(dir, before, after, "img.bin")).toEqual({
			status: "binary",
			hunks: [],
			added: 0,
			removed: 0,
		});
	});
});

describe("callChanges", () => {
	/** A turn of three calls: an edit of a.txt, a command changing b.txt, another edit of a.txt. */
	async function turn() {
		const dir = await repo(await tempDir(), { "a.txt": lines(5), "b.txt": "b\n" });
		const t0 = await snapshotTree(dir);
		await write(dir, { "a.txt": lines(5, { 2: "dos" }) });
		const t1 = await snapshotTree(dir);
		await write(dir, { "b.txt": "B\n" });
		const t2 = await snapshotTree(dir);
		await write(dir, { "a.txt": lines(5, { 2: "dos", 4: "cuatro" }) });
		const t3 = await snapshotTree(dir);
		const entry = {
			repos: [{ root: dir, before: t0, after: t3 }],
			calls: [
				{ toolCallId: "c1", trees: [{ root: dir, tree: t1 }] },
				{ toolCallId: "c2", trees: [{ root: dir, tree: t2 }] },
				{ toolCallId: "c3", trees: [{ root: dir, tree: t3 }] },
			],
		};
		return { dir, entry };
	}

	it("isolates each call's own change to a file edited twice", async () => {
		const { dir, entry } = await turn();

		const second = await callChanges(entry, "c3", path.join(dir, "a.txt"), noNow);
		expect(second?.kind === "file" && second.change.scope).toBe("call");
		expect(second?.kind === "file" && second.change.diff.hunks).toEqual([
			{ oldStart: 4, oldLines: ["4"], newStart: 4, newLines: ["cuatro"] },
		]);
		const first = await callChanges(entry, "c1", path.join(dir, "a.txt"), noNow);
		expect(first?.kind === "file" && first.change.diff.hunks).toEqual([
			{ oldStart: 2, oldLines: ["2"], newStart: 2, newLines: ["dos"] },
		]);
	});

	it("falls back to the whole turn when the call left no change in the file", async () => {
		const { dir, entry } = await turn();

		const result = await callChanges(entry, "c3", path.join(dir, "b.txt"), noNow);
		expect(result?.kind === "file" && result.change.scope).toBe("turn");
		expect(result?.kind === "file" && result.change.diff.hunks).toEqual([
			{ oldStart: 1, oldLines: ["b"], newStart: 1, newLines: ["B"] },
		]);
	});

	it("is undefined for a call the turn has no snapshot of", async () => {
		const { dir, entry } = await turn();
		expect(await callChanges(entry, "zz", path.join(dir, "a.txt"), noNow)).toBeUndefined();
	});

	it("offers the files a call changed under a directory target", async () => {
		const dir = await repo(await tempDir(), { "sub/x.txt": "x\n", "sub/y.txt": "y\n", "z.txt": "z\n" });
		const t0 = await snapshotTree(dir);
		await write(dir, { "sub/y.txt": "Y\n", "sub/x.txt": "X\n", "z.txt": "Z\n" });
		const t1 = await snapshotTree(dir);
		const entry = {
			repos: [{ root: dir, before: t0, after: t1 }],
			calls: [{ toolCallId: "c1", trees: [{ root: dir, tree: t1 }] }],
		};

		const result = await callChanges(entry, "c1", path.join(dir, "sub"), noNow);
		expect(result?.kind === "choose" && result.files.map(file => file.path)).toEqual(["sub/x.txt", "sub/y.txt"]);
	});
});
