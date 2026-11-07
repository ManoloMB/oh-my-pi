/** Line changes of one file between two snapshot trees (`git diff -U0`), for marking them in an editor. */
import { git } from "../checkpoints/git";

export type FileChangeStatus = "added" | "modified" | "deleted" | "binary";

export interface Hunk {
	/** 1-based first line in the before content; for a pure addition, the line after which lines were added (0 = top). */
	oldStart: number;
	oldLines: string[];
	/** 1-based first line in the after content; for a pure deletion, the line after which lines were removed (0 = top). */
	newStart: number;
	newLines: string[];
}

export interface FileDiff {
	status: FileChangeStatus;
	/** Empty for binary files. */
	hunks: Hunk[];
	added: number;
	removed: number;
}

export interface ParsedDiff {
	newFile: boolean;
	deletedFile: boolean;
	binary: boolean;
	hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parse the zero-context patch of one file. */
export function parseZeroContextDiff(patch: string): ParsedDiff {
	const parsed: ParsedDiff = { newFile: false, deletedFile: false, binary: false, hunks: [] };
	let hunk: Hunk | undefined;
	for (const line of patch.split("\n")) {
		const header = HUNK_HEADER.exec(line);
		if (header) {
			hunk = { oldStart: Number(header[1]), oldLines: [], newStart: Number(header[2]), newLines: [] };
			parsed.hunks.push(hunk);
			continue;
		}
		if (hunk) {
			if (line.startsWith("-")) hunk.oldLines.push(stripCr(line.slice(1)));
			else if (line.startsWith("+")) hunk.newLines.push(stripCr(line.slice(1)));
			else if (!line.startsWith("\\")) hunk = undefined;
			continue;
		}
		if (line.startsWith("new file mode")) parsed.newFile = true;
		else if (line.startsWith("deleted file mode")) parsed.deletedFile = true;
		else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) parsed.binary = true;
	}
	return parsed;
}

/** Diff of `relativePath` (`/`-separated) between two snapshot trees; undefined when it did not change. */
export async function diffFile(
	root: string,
	from: string,
	to: string,
	relativePath: string,
): Promise<FileDiff | undefined> {
	const patch = await git(root, [
		"diff",
		"-U0",
		"--no-color",
		"--no-ext-diff",
		"--no-textconv",
		"--no-renames",
		"--ignore-submodules=all",
		from,
		to,
		"--",
		relativePath,
	]);
	if (patch.trim() === "") return undefined;
	const parsed = parseZeroContextDiff(patch);
	const status: FileChangeStatus = parsed.binary
		? "binary"
		: parsed.newFile
			? "added"
			: parsed.deletedFile
				? "deleted"
				: "modified";
	const hunks = parsed.binary ? [] : parsed.hunks;
	let added = 0;
	let removed = 0;
	for (const hunk of hunks) {
		added += hunk.newLines.length;
		removed += hunk.oldLines.length;
	}
	return { status, hunks, added, removed };
}

function stripCr(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}
