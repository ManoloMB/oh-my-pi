/**
 * What one of omp's tool calls changed in a file, from the snapshots taken
 * after each file-changing call of a turn: call `i` changed what differs
 * between the snapshot after call `i - 1` (the turn's `before` for the first)
 * and the snapshot after call `i`.
 */
import * as path from "node:path";
import { changedFiles } from "../checkpoints/snapshots";
import type { CallSnapshot, Checkpoint } from "../checkpoints/store";
import { diffFile, type FileDiff } from "./hunks";

/** Files listed when a call's target is a directory. */
const MAX_DIRECTORY_FILES = 50;

export interface CallFileChange {
	root: string;
	/** Repository-relative, `/`-separated. */
	path: string;
	before: string;
	after: string;
	diff: FileDiff;
	/** "call": exactly this tool call's change; "turn": the whole turn's change to the file (the call's own could not be isolated). */
	scope: "call" | "turn";
}

export type CallChangesResult =
	| { kind: "file"; change: CallFileChange }
	| { kind: "choose"; files: CallFileChange[] }
	| { kind: "none" };

/** What tool call `toolCallId` of `entry` changed for `target` (an absolute real path); undefined when `entry` has no snapshot of that call. */
export async function callChanges(
	entry: Pick<Checkpoint, "repos" | "calls">,
	toolCallId: string,
	target: string,
	now: (root: string) => Promise<string>,
): Promise<CallChangesResult | undefined> {
	const calls = entry.calls ?? [];
	const index = calls.findIndex(call => call.toolCallId === toolCallId);
	if (index < 0) return undefined;
	const repo = entry.repos.find(candidate => inside(candidate.root, target));
	if (!repo) return { kind: "none" };
	const rel = path.relative(repo.root, target).split(path.sep).join("/");
	const before = index > 0 ? treeOf(calls[index - 1]!, repo.root) : repo.before;
	const after = treeOf(calls[index]!, repo.root);

	if (before && after) {
		const changed = await changedFiles(repo.root, before, after);
		if (changed.includes(rel)) {
			const diff = await diffFile(repo.root, before, after, rel);
			if (diff) return { kind: "file", change: { root: repo.root, path: rel, before, after, diff, scope: "call" } };
		}
		const files: CallFileChange[] = [];
		for (const file of changed) {
			if (rel !== "" && !file.startsWith(`${rel}/`)) continue;
			if (files.length >= MAX_DIRECTORY_FILES) break;
			const fileDiff = await diffFile(repo.root, before, after, file);
			if (fileDiff) files.push({ root: repo.root, path: file, before, after, diff: fileDiff, scope: "call" });
		}
		files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		if (files.length === 1) return { kind: "file", change: files[0]! };
		if (files.length > 1) return { kind: "choose", files };
	}

	const turnAfter = repo.after ?? (await now(repo.root));
	// A directory target would diff every file under it: only a file the turn changed is shown whole-turn.
	if (!(await changedFiles(repo.root, repo.before, turnAfter)).includes(rel)) return { kind: "none" };
	const diff = await diffFile(repo.root, repo.before, turnAfter, rel);
	if (diff) {
		return {
			kind: "file",
			change: { root: repo.root, path: rel, before: repo.before, after: turnAfter, diff, scope: "turn" },
		};
	}
	return { kind: "none" };
}

function treeOf(call: CallSnapshot, root: string): string | undefined {
	return call.trees.find(entry => entry.root === root)?.tree;
}

function inside(root: string, target: string): boolean {
	const rel = path.relative(root, target);
	return !rel.startsWith("..") && !path.isAbsolute(rel);
}
