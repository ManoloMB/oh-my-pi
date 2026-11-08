import * as fs from "node:fs/promises";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { ToolSession } from ".";

/** On-disk version of a file as this session last read or wrote it. */
export interface FileReadVersion {
	size: number;
	mtimeMs: number;
	hash?: number | bigint;
}

/** Files above this size are tracked by size + mtime only, never hashed. */
export const READ_VERSION_HASH_MAX_BYTES = 4 * 1024 * 1024;

const kReadVersions = Symbol("read.versions");

interface SessionWithReadVersions extends ToolSession {
	[kReadVersions]?: Map<string, FileReadVersion>;
}

function versionsOf(session: ToolSession): Map<string, FileReadVersion> {
	const holder = session as SessionWithReadVersions;
	holder[kReadVersions] ??= new Map();
	return holder[kReadVersions];
}

async function statOrUndefined(absolutePath: string) {
	try {
		return await fs.stat(absolutePath);
	} catch (error) {
		// ENOENT, or a path through a non-directory (archive members, selectors): no file to track.
		if (isEnoent(error) || (error instanceof Error && "code" in error && error.code === "ENOTDIR")) return undefined;
		throw error;
	}
}

/** Record the current on-disk version of `absolutePath` as seen by this session. */
export async function recordFileVersion(session: ToolSession, absolutePath: string): Promise<void> {
	const stat = await statOrUndefined(absolutePath);
	if (!stat) return;
	if (!stat.isFile()) {
		forgetFileVersion(session, absolutePath);
		return;
	}
	const version: FileReadVersion = { size: stat.size, mtimeMs: stat.mtimeMs };
	if (stat.size <= READ_VERSION_HASH_MAX_BYTES) {
		version.hash = Bun.hash(await fs.readFile(absolutePath));
	}
	versionsOf(session).set(absolutePath, version);
}

export function forgetFileVersion(session: ToolSession, absolutePath: string): void {
	(session as SessionWithReadVersions)[kReadVersions]?.delete(absolutePath);
}

export function clearFileVersions(session: ToolSession): void {
	(session as SessionWithReadVersions)[kReadVersions]?.clear();
}

/**
 * Throw unless this session read (or wrote) `absolutePath` and the file is
 * still at that version on disk.
 */
export async function assertReadBeforeOverwrite(
	session: ToolSession,
	absolutePath: string,
	displayPath: string,
): Promise<void> {
	const recorded = (session as SessionWithReadVersions)[kReadVersions]?.get(absolutePath);
	if (!recorded) {
		throw new ToolError(
			`Refusing to overwrite '${displayPath}': this session has not read it. Read it first (any range), then write the complete file — or use edit for a partial change.`,
		);
	}
	const stat = await statOrUndefined(absolutePath);
	// The file vanished since it was read: nothing left to clobber.
	if (!stat) return;
	let stale = stat.size !== recorded.size;
	if (!stale) {
		if (recorded.hash !== undefined) {
			stale = Bun.hash(await fs.readFile(absolutePath)) !== recorded.hash;
		} else {
			stale = stat.mtimeMs !== recorded.mtimeMs;
		}
	}
	if (stale) {
		throw new ToolError(
			`Refusing to overwrite '${displayPath}': it changed on disk since this session last read it. Re-read it, then write the complete file — or use edit for a partial change.`,
		);
	}
}
