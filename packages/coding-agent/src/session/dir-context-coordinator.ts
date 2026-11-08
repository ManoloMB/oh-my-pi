import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AfterToolCallContext, AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import dirContextNoticeTemplate from "../prompts/system/dir-context-notice.md" with { type: "text" };
import dirContextNoticeItemTemplate from "../prompts/system/dir-context-notice-item.md" with { type: "text" };
import {
	cfgContextFilesExtra,
	cfgContextFilesNestedAutoInject,
	cfgContextFilesNestedMaxBytes,
} from "./context-settings";

/** Custom message type carrying auto-injected nested context files. */
export const DIR_CONTEXT_NOTICE_CUSTOM_TYPE = "dir-context-notice";

/** One context-file change delivered in a notice; persisted in the message `details.entries`. */
export interface DirContextEntryRecord {
	/** Absolute path of the context file. */
	path: string;
	action: "set" | "update" | "remove";
	/** SHA-1 of the trimmed content; absent for `remove`. */
	digest?: string;
}

/** Capabilities the coordinator borrows from its owning session. */
export interface DirContextCoordinatorHost {
	cwd(): string;
	settings: Settings;
	messages(): readonly AgentMessage[];
	deliver(content: string, entries: DirContextEntryRecord[]): Promise<void>;
}

interface CachedContextFile {
	digest: string;
	mtimeMs: number;
	size: number;
}

interface ToolResultLike {
	details?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/**
 * Filesystem paths a successful tool result touched, from its structured
 * `details` (hashline `edit` carries no path in its arguments). A directory
 * read yields the directory itself; URL, `proc://` and `cfg://` results yield
 * nothing.
 */
export function touchedPathsForResult(toolName: string, result: ToolResultLike | undefined): string[] {
	const details = asRecord(result?.details);
	if (!details) return [];
	switch (toolName) {
		case "read": {
			if (details.kind === "url" || details.proc !== undefined || details.cfg !== undefined) return [];
			if (typeof details.resolvedPath === "string") return [details.resolvedPath];
			const source = asRecord(asRecord(details.meta)?.source);
			return source?.type === "path" && typeof source.value === "string" ? [source.value] : [];
		}
		case "write":
			if (details.proc !== undefined || details.cfg !== undefined) return [];
			return typeof details.resolvedPath === "string" ? [details.resolvedPath] : [];
		case "edit": {
			if (Array.isArray(details.perFileResults)) {
				const paths: string[] = [];
				for (const entry of details.perFileResults) {
					const file = asRecord(entry);
					if (file && file.isError !== true && typeof file.path === "string") paths.push(file.path);
				}
				return paths;
			}
			return typeof details.path === "string" ? [details.path] : [];
		}
		default:
			return [];
	}
}

/**
 * Directories strictly below `cwd` down to and including `targetDir`, shallowest
 * first. `cwd` itself is excluded (its context files load at session start);
 * a target outside `cwd` yields `[]`.
 */
export function descendantDirsFromCwd(cwd: string, targetDir: string): string[] {
	const relative = path.relative(cwd, targetDir);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return [];
	const dirs: string[] = [];
	let current = cwd;
	for (const segment of relative.split(path.sep)) {
		current = path.join(current, segment);
		dirs.push(current);
	}
	return dirs;
}

/** Context file names checked in each directory: AGENTS.md, CLAUDE.md, then `contextFiles.extra`. */
export function candidateNames(settings: Settings): string[] {
	return [...new Set(["AGENTS.md", "CLAUDE.md", ...cfgContextFilesExtra.get(settings)])];
}

/** SHA-1 hex of the trimmed content: whitespace-only edits do not re-inject. */
export function trimmedDigest(content: string): string {
	return new Bun.CryptoHasher("sha1").update(content.trim()).digest("hex");
}

/** Cut `content` to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function truncateUtf8(content: string, maxBytes: number): string {
	const bytes = Buffer.from(content, "utf8");
	if (bytes.length <= maxBytes) return content;
	let end = Math.max(0, maxBytes);
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return `${bytes.subarray(0, end).toString("utf8")}\n\n[truncated to ${maxBytes} bytes]`;
}

/**
 * Injects AGENTS.md / CLAUDE.md (and `contextFiles.extra`) from subdirectories
 * of the working directory the first time a tool reads or edits inside them,
 * re-injecting when a file changes and noting when one is removed.
 */
export class DirContextCoordinator {
	readonly #host: DirContextCoordinatorHost;
	readonly #cache = new Map<string, CachedContextFile>();
	#seeded = false;

	constructor(host: DirContextCoordinatorHost) {
		this.#host = host;
	}

	/**
	 * Forget which files were shown. Call after the conversation is replaced
	 * (compaction, rollover, resume, branch): the next touch re-seeds from the
	 * notices that survived and re-injects rules that were summarized away.
	 */
	reset(): void {
		this.#cache.clear();
		this.#seeded = false;
	}

	async afterToolCall(ctx: AfterToolCallContext): Promise<void> {
		if (ctx.isError || !cfgContextFilesNestedAutoInject.get(this.#host.settings)) return;
		const touched = touchedPathsForResult(ctx.toolCall.name, ctx.result);
		if (touched.length === 0) return;
		this.#seed();

		const cwd = this.#host.cwd();
		const names = candidateNames(this.#host.settings);
		const maxBytes = cfgContextFilesNestedMaxBytes.get(this.#host.settings);
		const entries: DirContextEntryRecord[] = [];
		const items: string[] = [];
		const visited = new Set<string>();
		for (const rawPath of touched) {
			const touchedPath = path.resolve(cwd, rawPath);
			const isDirectory = ctx.toolCall.name === "read" && asRecord(ctx.result?.details)?.isDirectory === true;
			const targetDir = isDirectory ? touchedPath : path.dirname(touchedPath);
			for (const dir of descendantDirsFromCwd(cwd, targetDir)) {
				for (const name of names) {
					const filePath = path.join(dir, name);
					if (visited.has(filePath)) continue;
					visited.add(filePath);
					const item = await this.#check(filePath, filePath === touchedPath, cwd, dir, maxBytes);
					if (!item) continue;
					entries.push(item.entry);
					items.push(item.text);
				}
			}
		}
		if (entries.length === 0) return;
		const content = prompt.render(dirContextNoticeTemplate, { body: items.join("\n\n") });
		try {
			await this.#host.deliver(content, entries);
		} catch (error) {
			logger.debug("Failed to deliver nested context notice", { error: String(error) });
		}
	}

	/** Rebuild the shown-file cache from notices already in the conversation (resume). */
	#seed(): void {
		if (this.#seeded) return;
		this.#seeded = true;
		for (const message of this.#host.messages()) {
			if (message.role !== "custom" || message.customType !== DIR_CONTEXT_NOTICE_CUSTOM_TYPE) continue;
			const recorded = asRecord(message.details)?.entries;
			if (!Array.isArray(recorded)) continue;
			for (const raw of recorded) {
				const entry = asRecord(raw);
				if (!entry || typeof entry.path !== "string") continue;
				if (entry.action === "remove") {
					this.#cache.delete(entry.path);
				} else if (typeof entry.digest === "string") {
					// Unknown stat: the first check re-reads and compares digests.
					this.#cache.set(entry.path, { digest: entry.digest, mtimeMs: -1, size: -1 });
				}
			}
		}
	}

	async #check(
		filePath: string,
		isTouchedFile: boolean,
		cwd: string,
		dir: string,
		maxBytes: number,
	): Promise<{ entry: DirContextEntryRecord; text: string } | undefined> {
		// Lexical, not realpath-based: a removed file must still display relative to cwd.
		const displayPath = path.relative(cwd, filePath).split(path.sep).join("/");
		const cached = this.#cache.get(filePath);
		let stat: Stats;
		try {
			stat = await fs.stat(filePath);
		} catch (error) {
			if (!isEnoent(error)) {
				logger.debug("Failed to stat nested context file", { path: filePath, error: String(error) });
				return undefined;
			}
			if (!cached) return undefined;
			this.#cache.delete(filePath);
			return {
				entry: { path: filePath, action: "remove" },
				text: prompt.render(dirContextNoticeItemTemplate, { isRemoved: true, path: displayPath }),
			};
		}
		if (!stat.isFile()) return undefined;
		if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return undefined;

		let content: string;
		try {
			content = await Bun.file(filePath).text();
		} catch (error) {
			logger.debug("Failed to read nested context file", { path: filePath, error: String(error) });
			return undefined;
		}
		const digest = trimmedDigest(content);
		this.#cache.set(filePath, { digest, mtimeMs: stat.mtimeMs, size: stat.size });
		// The model already sees a context file it read or edited directly.
		if (isTouchedFile || cached?.digest === digest) return undefined;

		const action = cached ? "update" : "set";
		return {
			entry: { path: filePath, action, digest },
			text: prompt.render(dirContextNoticeItemTemplate, {
				isSet: action === "set",
				isUpdated: action === "update",
				path: displayPath,
				scope: path.relative(cwd, dir).split(path.sep).join("/"),
				content: truncateUtf8(content.trim(), maxBytes),
			}),
		};
	}
}
