/**
 * Session-start snapshot of the code workspace for the coding system prompt:
 * git branch/status/recent commits plus project facts (manifests, package
 * managers, verify commands) detected from the project root.
 */
import * as os from "node:os";
import * as path from "node:path";
import type { VcsRepo, VcsStatusSummary } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { logger } from "@oh-my-pi/pi-utils";

export interface WorkspaceSnapshot {
	root: string;
	branch?: string;
	/** `clean`, or non-zero counts such as `2 staged, 3 untracked`. */
	status?: string;
	/** Up to three one-line commits, newest first. */
	commits: string[];
	/** Project marker filenames present at the root. */
	manifests: string[];
	/** Package managers implied by lockfiles at the root. */
	packageManagers: string[];
	/** Detected build/test/lint commands, in detection order. */
	verifyCommands: string[];
}

const PROJECT_MARKERS = [
	"pyproject.toml",
	"setup.py",
	"setup.cfg",
	"requirements.txt",
	"package.json",
	"tsconfig.json",
	"deno.json",
	"Cargo.toml",
	"go.mod",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"Gemfile",
	"composer.json",
	"mix.exs",
	"pubspec.yaml",
	"CMakeLists.txt",
	"Makefile",
	"Dockerfile",
	"justfile",
] as const;

const LOCKFILE_MANAGERS: ReadonlyArray<readonly [string, string]> = [
	["uv.lock", "uv"],
	["poetry.lock", "poetry"],
	["Pipfile.lock", "pipenv"],
	["pnpm-lock.yaml", "pnpm"],
	["bun.lockb", "bun"],
	["bun.lock", "bun"],
	["yarn.lock", "yarn"],
	["package-lock.json", "npm"],
];

const JS_MANAGERS = ["pnpm", "bun", "yarn", "npm"] as const;
export const VERIFY_TARGETS = ["test", "tests", "lint", "typecheck", "check", "build", "fmt", "format"] as const;
const MAX_MARKER_DEPTH = 6;
const MAX_MANIFESTS = 6;
const MAX_VERIFY_COMMANDS = 8;
const GIT_TIMEOUT_MS = 2500;

async function readText(file: string): Promise<string> {
	try {
		return await Bun.file(file).text();
	} catch {
		return "";
	}
}

/** Nearest ancestor (cwd plus up to 6 parents) holding a project marker; `$HOME` and the temp root never count. */
async function findMarkerRoot(cwd: string): Promise<string | null> {
	const skip = new Set([path.resolve(os.homedir()), path.resolve(os.tmpdir())]);
	let dir = path.resolve(cwd);
	for (let depth = 0; depth <= MAX_MARKER_DEPTH; depth++) {
		if (!skip.has(dir)) {
			for (const marker of PROJECT_MARKERS) {
				if (await Bun.file(path.join(dir, marker)).exists()) return dir;
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function formatStatus(summary: VcsStatusSummary): string {
	const parts = [
		summary.staged ? `${summary.staged} staged` : "",
		summary.unstaged ? `${summary.unstaged} unstaged` : "",
		summary.untracked ? `${summary.untracked} untracked` : "",
	].filter(Boolean);
	return parts.length > 0 ? parts.join(", ") : "clean";
}

function targetsIn(file: string, tool: string): string[] {
	if (!file) return [];
	return VERIFY_TARGETS.filter(name => new RegExp(`^${name}\\s*:`, "m").test(file)).map(name => `${tool} ${name}`);
}

async function detectProjectFacts(
	root: string,
): Promise<Pick<WorkspaceSnapshot, "manifests" | "packageManagers" | "verifyCommands">> {
	const present = await Promise.all(
		[...PROJECT_MARKERS, ...LOCKFILE_MANAGERS.map(([lock]) => lock)].map(async name =>
			(await Bun.file(path.join(root, name)).exists()) ? name : null,
		),
	);
	const manifests = PROJECT_MARKERS.filter(marker => present.includes(marker));
	const packageManagers = [
		...new Set(LOCKFILE_MANAGERS.filter(([lock]) => present.includes(lock)).map(([, pm]) => pm)),
	];
	const jsManager = JS_MANAGERS.find(pm => packageManagers.includes(pm)) ?? "npm";

	const verify: string[] = [];
	if (manifests.includes("package.json")) {
		try {
			const pkg: unknown = JSON.parse(await readText(path.join(root, "package.json")));
			const scripts = pkg && typeof pkg === "object" && "scripts" in pkg ? pkg.scripts : undefined;
			if (scripts && typeof scripts === "object") {
				for (const name of VERIFY_TARGETS) if (name in scripts) verify.push(`${jsManager} run ${name}`);
			}
		} catch {
			// Malformed package.json: no script commands.
		}
	}
	if (
		(await Bun.file(path.join(root, "pytest.ini")).exists()) ||
		(await readText(path.join(root, "pyproject.toml"))).includes("[tool.pytest")
	) {
		verify.push("pytest");
	}
	verify.push(...targetsIn(await readText(path.join(root, "Makefile")), "make"));
	verify.push(...targetsIn(await readText(path.join(root, "justfile")), "just"));
	if (manifests.includes("Cargo.toml")) verify.push("cargo test");
	if (manifests.includes("go.mod")) verify.push("go test ./...");

	return {
		manifests: manifests.slice(0, MAX_MANIFESTS),
		packageManagers,
		verifyCommands: [...new Set(verify)].slice(0, MAX_VERIFY_COMMANDS),
	};
}

/** Snapshot for `cwd`, or `null` when it is neither inside a repository nor under a project root. Never throws. */
export async function resolveWorkspaceSnapshot(cwd: string): Promise<WorkspaceSnapshot | null> {
	try {
		let repo: VcsRepo | null = null;
		try {
			repo = vcs.repo(cwd);
		} catch {
			repo = null;
		}
		const root = repo?.root() ?? (await findMarkerRoot(cwd));
		if (!root) return null;

		const snapshot: WorkspaceSnapshot = { root, commits: [], ...(await detectProjectFacts(root)) };
		if (repo) {
			const [branch, summary, commits] = await Promise.all([
				repo.label(AbortSignal.timeout(GIT_TIMEOUT_MS)).catch(() => undefined),
				repo.statusSummary(AbortSignal.timeout(GIT_TIMEOUT_MS)).catch(() => undefined),
				repo.logOnelines(3, AbortSignal.timeout(GIT_TIMEOUT_MS)).catch(() => [] as string[]),
			]);
			if (branch) snapshot.branch = branch;
			if (summary) snapshot.status = formatStatus(summary);
			snapshot.commits = commits;
		}
		return snapshot;
	} catch (err) {
		logger.debug("Failed to resolve workspace snapshot", { err: String(err) });
		return null;
	}
}
