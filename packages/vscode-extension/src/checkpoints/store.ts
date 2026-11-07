/**
 * File checkpoints of each session, persisted in the extension's storage (one
 * JSON file per session file) so they survive restarts.
 */
import { SessionFileStore } from "../session-store";
import type { TurnSnapshots } from "./snapshots";

/** Older checkpoints of a session are dropped beyond this many. */
const MAX_CHECKPOINTS = 200;

/** One repository's snapshots around a turn. */
export interface RepoCheckpoint extends TurnSnapshots {
	root: string;
}

/** The work tree right after one of omp's tool calls that can change files. */
export interface CallSnapshot {
	toolCallId: string;
	/** Snapshot tree per repository root (repositories whose snapshot failed are absent). */
	trees: Array<{ root: string; tree: string }>;
}

/** The snapshots around one of omp's turns, keyed by the prompt that started it. */
export interface Checkpoint {
	/** `timestamp` of the user message that started the turn (as stored in the session). */
	promptTimestamp: number;
	repos: RepoCheckpoint[];
	/**
	 * Whether the session's own file tools (edit, write…) ran during the turn.
	 * Absent in checkpoints saved before it was tracked.
	 */
	editedFiles?: boolean;
	/** Snapshots after each file-changing tool call of the turn, in order; absent before this was tracked. */
	calls?: CallSnapshot[];
}

export class CheckpointStore {
	readonly #files: SessionFileStore<Checkpoint>;

	constructor(directory: string) {
		this.#files = new SessionFileStore(directory, isCheckpoint);
	}

	load(sessionFile: string): Promise<Checkpoint[]> {
		return this.#files.load(sessionFile);
	}

	/** Add a checkpoint, or replace the one with the same prompt. */
	put(sessionFile: string, checkpoint: Checkpoint): Promise<void> {
		return this.#files.update(sessionFile, checkpoints => {
			const kept = checkpoints.filter(entry => entry.promptTimestamp !== checkpoint.promptTimestamp);
			kept.push(checkpoint);
			return kept.slice(-MAX_CHECKPOINTS);
		});
	}

	/** Forget a session's checkpoints (its file was deleted). */
	remove(sessionFile: string): Promise<void> {
		return this.#files.remove(sessionFile);
	}
}

function isCheckpoint(value: unknown): value is Checkpoint {
	if (!value || typeof value !== "object" || !("promptTimestamp" in value) || !("repos" in value)) return false;
	if (
		typeof value.promptTimestamp !== "number" ||
		!Array.isArray(value.repos) ||
		!value.repos.every(isRepoCheckpoint)
	) {
		return false;
	}
	return (
		!("calls" in value) ||
		value.calls === undefined ||
		(Array.isArray(value.calls) && value.calls.every(isCallSnapshot))
	);
}

function isCallSnapshot(value: unknown): value is CallSnapshot {
	if (!value || typeof value !== "object" || !("toolCallId" in value) || !("trees" in value)) return false;
	if (typeof value.toolCallId !== "string" || !Array.isArray(value.trees)) return false;
	return value.trees.every(
		(entry: unknown) =>
			!!entry &&
			typeof entry === "object" &&
			"root" in entry &&
			"tree" in entry &&
			typeof entry.root === "string" &&
			typeof entry.tree === "string",
	);
}

function isRepoCheckpoint(value: unknown): value is RepoCheckpoint {
	if (!value || typeof value !== "object" || !("root" in value) || !("before" in value)) return false;
	if (typeof value.root !== "string" || typeof value.before !== "string") return false;
	return !("after" in value) || value.after === undefined || typeof value.after === "string";
}
