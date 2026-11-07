/**
 * Git snapshots of a work tree and the restore that reverts omp's changes.
 *
 * A snapshot is a tree object of every file git would see in the work tree:
 * tracked files as they are on disk plus untracked, non-ignored ones (up to
 * {@link MAX_UNTRACKED_BYTES}). It is built in a temporary index, so HEAD, the
 * user's index, branches and refs are never touched; the objects stay loose
 * and unreferenced until `git gc` prunes them (two weeks by default).
 * Git-ignored files (a venv, `node_modules`, build output) and nested
 * repositories are not part of it.
 *
 * A restore takes the snapshots around each of omp's turns (`before`, `after`)
 * and reverts only what changed inside those turns: a file nothing else
 * touched goes back to its content before the first turn; a file that also
 * changed between or after the turns (the user, another session) has each
 * turn's patch reversed onto its current content, and is a conflict when a
 * patch no longer applies. All of it is computed in a temporary index and
 * written to disk only for the files that change.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { git } from "./git";

/** Untracked files larger than this are left out of snapshots. */
export const MAX_UNTRACKED_BYTES = 10 * 1024 * 1024;

const GITLINK_MODE = "160000";
const REMOVE_ENTRY = `0 ${"0".repeat(40)}`;

/** Snapshots of one repository around one of omp's turns. */
export interface TurnSnapshots {
	before: string;
	/** Absent when the turn never finished (the extension stopped mid-turn). */
	after?: string;
}

/** A file a restore writes: its new blob, or `undefined` when the restore deletes it. */
export interface WrittenFile {
	path: string;
	blob: string | undefined;
}

export interface RestoreResult {
	root: string;
	/** Snapshot of the work tree just before the restore (what an undo goes back to). */
	current: string;
	/** Files the restore changes (repository-relative, `/`-separated). */
	files: WrittenFile[];
	/** Files changed both by omp and outside its turns whose patches no longer apply; left as they are. */
	conflicts: string[];
}

interface TreeEntry {
	mode: string;
	blob: string;
}

/** Snapshot every non-ignored file of the work tree at `root`; resolves to the tree id. */
export async function snapshotTree(root: string): Promise<string> {
	return withTempIndex(root, { copyIndex: true }, async env => {
		await git(root, ["add", "-u"], { env });
		const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"], { env }))
			.split("\0")
			// `dir/` entries are nested repositories: they have snapshots of their own.
			.filter(file => file !== "" && !file.endsWith("/"));
		const included: string[] = [];
		for (const file of untracked) {
			const stats = await fs.lstat(path.join(root, file)).catch(() => undefined);
			if (stats && (stats.isFile() || stats.isSymbolicLink()) && stats.size <= MAX_UNTRACKED_BYTES) {
				included.push(file);
			}
		}
		if (included.length > 0) {
			await git(root, ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
				env,
				input: included.join("\0"),
			});
		}
		return (await git(root, ["write-tree"], { env })).trim();
	});
}

/**
 * Revert omp's changes in `turns` (oldest first): see the module comment.
 * With `write` false nothing on disk changes (a preview). Files in
 * `overwrite` that would be conflicts are reset to their content before the
 * first turn instead, discarding the other changes made to them.
 */
export async function restoreTurns(
	root: string,
	turns: readonly TurnSnapshots[],
	options: { write: boolean; overwrite?: ReadonlySet<string> },
): Promise<RestoreResult> {
	const current = await snapshotTree(root);
	if (turns.length === 0) return { root, current, files: [], conflicts: [] };
	const afterOf = (index: number) => turns[index]!.after ?? turns[index + 1]?.before ?? current;
	const base = turns[0]!.before;

	// Files omp changed, with the turns that changed them; files changed outside the turns.
	const changedBy = new Map<string, number[]>();
	for (let index = 0; index < turns.length; index++) {
		for (const file of await changedFiles(root, turns[index]!.before, afterOf(index))) {
			const list = changedBy.get(file) ?? [];
			list.push(index);
			changedBy.set(file, list);
		}
	}
	const outside = new Set<string>();
	for (let index = 0; index < turns.length; index++) {
		const next = turns[index + 1]?.before ?? current;
		for (const file of await changedFiles(root, afterOf(index), next)) outside.add(file);
	}

	const [baseTree, currentTree] = await Promise.all([listTree(root, base), listTree(root, current)]);
	return withTempIndex(root, { tree: current }, async env => {
		const resets: string[] = [];
		const conflicts: string[] = [];
		for (const [file, turnIndexes] of changedBy) {
			if (!outside.has(file) || options.overwrite?.has(file)) {
				resets.push(file);
				continue;
			}
			if (!(await reversePatches(root, env, file, turnIndexes, turns, afterOf))) {
				await setEntries(root, env, [[file, currentTree.get(file)]]);
				conflicts.push(file);
			}
		}
		await setEntries(
			root,
			env,
			resets.map(file => [file, baseTree.get(file)]),
		);
		const result = await listIndex(root, env);
		const files: WrittenFile[] = [];
		for (const file of changedBy.keys()) {
			const before = currentTree.get(file);
			const after = result.get(file);
			if (before?.blob === after?.blob && before?.mode === after?.mode) continue;
			files.push({ path: file, blob: after?.blob });
		}
		if (options.write) await writeFiles(root, env, files);
		return { root, current, files, conflicts: conflicts.sort() };
	});
}

/**
 * Undo a restore: files still exactly as the restore wrote them go back to
 * their content in `current`; files changed since are left alone. Resolves to
 * the paths it could not undo.
 */
export async function undoRestore(root: string, current: string, files: readonly WrittenFile[]): Promise<string[]> {
	const now = await snapshotTree(root);
	const [nowTree, previousTree] = await Promise.all([listTree(root, now), listTree(root, current)]);
	const undo: WrittenFile[] = [];
	const skipped: string[] = [];
	for (const file of files) {
		if (nowTree.get(file.path)?.blob === file.blob) {
			undo.push({ path: file.path, blob: previousTree.get(file.path)?.blob });
		} else {
			skipped.push(file.path);
		}
	}
	await withTempIndex(root, { tree: now }, async env => {
		await setEntries(
			root,
			env,
			undo.map(file => [file.path, previousTree.get(file.path)]),
		);
		await writeFiles(root, env, undo);
	});
	return skipped;
}

/** Reverse each turn's patch for `file`, newest first, in the temporary index; false when one no longer applies. */
async function reversePatches(
	root: string,
	env: Record<string, string>,
	file: string,
	turnIndexes: readonly number[],
	turns: readonly TurnSnapshots[],
	afterOf: (index: number) => string,
): Promise<boolean> {
	for (const index of [...turnIndexes].reverse()) {
		const patch = await git(root, [
			"diff-tree",
			"-p",
			"--binary",
			"--full-index",
			"--no-renames",
			turns[index]!.before,
			afterOf(index),
			"--",
			file,
		]);
		const applied = await git(root, ["apply", "-R", "--cached", "--binary", "-"], { env, input: patch }).then(
			() => true,
			() => false,
		);
		if (!applied) return false;
	}
	return true;
}

/** Paths whose content or mode differs between two trees, nested repositories excluded. */
export async function changedFiles(root: string, from: string, to: string): Promise<string[]> {
	if (from === to) return [];
	const fields = (await git(root, ["diff-tree", "-r", "-z", "--no-renames", from, to])).split("\0");
	const files: string[] = [];
	for (let index = 0; index + 1 < fields.length; index += 2) {
		const [oldMode, newMode] = fields[index]!.slice(1).split(" ");
		if (oldMode === GITLINK_MODE || newMode === GITLINK_MODE) continue;
		files.push(fields[index + 1]!);
	}
	return files;
}

async function listTree(root: string, tree: string): Promise<Map<string, TreeEntry>> {
	return parseEntries(await git(root, ["ls-tree", "-r", "-z", tree]), /^(\d+) \w+ ([0-9a-f]+)$/);
}

async function listIndex(root: string, env: Record<string, string>): Promise<Map<string, TreeEntry>> {
	return parseEntries(await git(root, ["ls-files", "-s", "-z"], { env }), /^(\d+) ([0-9a-f]+) \d+$/);
}

/** `<meta>\t<path>\0` records (ls-tree, ls-files -s) by path. */
function parseEntries(output: string, meta: RegExp): Map<string, TreeEntry> {
	const entries = new Map<string, TreeEntry>();
	for (const record of output.split("\0")) {
		const tab = record.indexOf("\t");
		if (tab < 0) continue;
		const match = meta.exec(record.slice(0, tab));
		if (match && match[1] !== GITLINK_MODE) entries.set(record.slice(tab + 1), { mode: match[1]!, blob: match[2]! });
	}
	return entries;
}

/** Set (or, for `undefined`, remove) entries of the temporary index. */
async function setEntries(
	root: string,
	env: Record<string, string>,
	entries: ReadonlyArray<readonly [string, TreeEntry | undefined]>,
): Promise<void> {
	if (entries.length === 0) return;
	const input = entries
		.map(([file, entry]) => `${entry ? `${entry.mode} ${entry.blob}` : REMOVE_ENTRY}\t${file}`)
		.join("\0");
	await git(root, ["update-index", "-z", "--index-info"], { env, input: `${input}\0` });
}

/** Write `files` from the temporary index to disk; delete the ones without a blob (and directories left empty). */
async function writeFiles(root: string, env: Record<string, string>, files: readonly WrittenFile[]): Promise<void> {
	const written = files.filter(file => file.blob !== undefined).map(file => file.path);
	if (written.length > 0) {
		await git(root, ["checkout-index", "-f", "-z", "--stdin"], { env, input: `${written.join("\0")}\0` });
	}
	for (const file of files) {
		if (file.blob !== undefined) continue;
		const absolute = path.join(root, file.path);
		await fs.rm(absolute, { force: true });
		await pruneEmptyDirs(root, path.dirname(absolute));
	}
}

async function pruneEmptyDirs(root: string, dir: string): Promise<void> {
	const stop = path.resolve(root);
	for (
		let current = path.resolve(dir);
		current.startsWith(stop) && current !== stop;
		current = path.dirname(current)
	) {
		const entries = await fs.readdir(current).catch(() => undefined);
		if (!entries || entries.length > 0) return;
		await fs.rmdir(current).catch(() => {});
	}
}

/**
 * Run `fn` with `GIT_INDEX_FILE` pointing at a temporary index, seeded from the
 * user's index (`copyIndex`, so `git add` only rehashes changed files) or from
 * a tree; the temporary file is always removed.
 */
async function withTempIndex<T>(
	root: string,
	seed: { copyIndex: true } | { tree: string },
	fn: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
	const file = path.join(os.tmpdir(), `omp-checkpoint-${randomUUID()}.index`);
	const env = { GIT_INDEX_FILE: file };
	try {
		if ("tree" in seed) {
			await git(root, ["read-tree", seed.tree], { env });
		} else {
			const index = path.resolve(root, (await git(root, ["rev-parse", "--git-path", "index"])).trim());
			await fs.copyFile(index, file).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
		return await fn(env);
	} finally {
		await fs.rm(file, { force: true });
		await fs.rm(`${file}.lock`, { force: true });
	}
}
