import * as path from "node:path";
import type { Agent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { isRecord, logger, prompt, stringProperty } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import verifyReminderPrompt from "../prompts/system/verify-reminder.md" with { type: "text" };
import { detectMaskedSuccess } from "../tools/bash-hints";
import { cfgVerifyReminders, cfgVerifyRemindersMax } from "../tools/settings";
import { tokenizeShellSegments } from "../tools/shell-tokenize";
import { resolveWorkspaceSnapshot, VERIFY_TARGETS } from "../utils/workspace-snapshot";
import type { SessionManager } from "./session-manager";
import { isAwaitingUserAnswer } from "./todo-tracker";

const CODE_EXTENSIONS: Record<string, true> = {
	".ts": true,
	".tsx": true,
	".js": true,
	".jsx": true,
	".mjs": true,
	".cjs": true,
	".mts": true,
	".cts": true,
	".py": true,
	".rs": true,
	".go": true,
	".java": true,
	".kt": true,
	".kts": true,
	".scala": true,
	".swift": true,
	".c": true,
	".h": true,
	".cc": true,
	".cpp": true,
	".cxx": true,
	".hpp": true,
	".hh": true,
	".cs": true,
	".rb": true,
	".php": true,
	".lua": true,
	".dart": true,
	".ex": true,
	".exs": true,
	".erl": true,
	".hs": true,
	".ml": true,
	".mli": true,
	".clj": true,
	".vue": true,
	".svelte": true,
	".sql": true,
	".sh": true,
	".bash": true,
	".zsh": true,
	".zig": true,
	".nim": true,
	".jl": true,
};

const MAX_LISTED_FILES = 5;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Lookups compare `=== true` so shell words like `constructor` never hit Object.prototype members.
const WRAPPER_WORDS: Record<string, true> = { env: true, time: true, nice: true, command: true };
const JS_RUNNERS: Record<string, true> = { bun: true, npm: true, pnpm: true, yarn: true };
const JS_EXEC_TOOLS: Record<string, true> = {
	tsc: true,
	vitest: true,
	jest: true,
	eslint: true,
	biome: true,
	oxlint: true,
	playwright: true,
};
const BARE_CHECKERS: Record<string, true> = {
	tsc: true,
	vitest: true,
	jest: true,
	pytest: true,
	ruff: true,
	mypy: true,
	pyright: true,
};
const CARGO_SUBCOMMANDS: Record<string, true> = { test: true, check: true, build: true, clippy: true, nextest: true };
const GO_SUBCOMMANDS: Record<string, true> = { test: true, build: true, vet: true };
const JVM_RUNNERS: Record<string, true> = { gradle: true, "./gradlew": true, mvn: true };
const JVM_TARGETS: Record<string, true> = { test: true, build: true, check: true, verify: true };
const DOTNET_SUBCOMMANDS: Record<string, true> = { test: true, build: true };
const NO_VERIFY_REQUEST_RE =
	/\b(?:do not|don't|dont|never|no|without)\s+(?:run|running|execute|executing|test|testing|build|building|verify|verifying)\b|\b(?:no|sin|nunca)\s+(?:ejecutes|ejecutar|ejecuten|corras|correr|lances|lanzar|pruebes|probar|compiles|compilar|verifiques|verificar)\b/i;

interface BashRun {
	seq: number;
	command: string;
	passed: boolean;
}

/** Capabilities the verify tracker borrows from its owning session. */
export interface VerifyTrackerHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	cwd(): string;
	planModeEnabled(): boolean;
	hasPendingAsyncWake(): boolean;
	scheduleAgentContinue(options: { source: string; generation?: number }): void;
	promptGeneration(): number;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
}

/** Reminds the agent to run a project check before a text-only stop that follows unverified code edits. */
export class VerifyTracker {
	readonly #host: VerifyTrackerHost;
	#editedFiles = new Set<string>();
	#seq = 0;
	#lastEditSeq = 0;
	#bashRuns: BashRun[] = [];
	#reminderCount = 0;
	#awaitingProgress = false;
	#verifyCommands: Promise<readonly string[]> | undefined;
	#verifyCommandsCwd: string | undefined;

	constructor(host: VerifyTrackerHost) {
		this.#host = host;
	}

	/** Resets per-prompt edit, verification and reminder state; keeps the cached verify commands. */
	resetCycle(): void {
		this.#editedFiles.clear();
		this.#seq = 0;
		this.#lastEditSeq = 0;
		this.#bashRuns = [];
		this.#reminderCount = 0;
		this.#awaitingProgress = false;
	}

	/** Records a completed tool result before asynchronous event processing begins. */
	onToolResult(message: ToolResultMessage): void {
		const seq = ++this.#seq;
		this.#awaitingProgress = false;
		const { toolName } = message;
		if (toolName !== "edit" && toolName !== "write" && toolName !== "ast_edit" && toolName !== "bash") return;
		const args = this.#toolCallArguments(message.toolCallId);
		const details = isRecord(message.details) ? message.details : undefined;
		if (toolName === "bash") {
			const command = args ? (stringProperty(args, "command") ?? "") : "";
			const output = message.content
				.map(block => (block.type === "text" ? block.text : ""))
				.filter(text => text.length > 0)
				.join("\n");
			const passed =
				!message.isError &&
				details?.exitCode === undefined &&
				details?.timedOut !== true &&
				!detectMaskedSuccess({ command, output, exitCode: 0 });
			this.#bashRuns.push({ seq, command, passed });
			return;
		}
		if (message.isError) return;
		// Project checks cannot vouch for files outside the session's working tree (e.g. scratch files in /tmp).
		const cwd = this.#host.cwd();
		const codePaths = editedPaths(toolName, details, args).filter(
			filePath => CODE_EXTENSIONS[path.extname(filePath).toLowerCase()] === true && isInsideCwd(filePath, cwd),
		);
		if (codePaths.length === 0) return;
		for (const filePath of codePaths) this.#editedFiles.add(displayPath(filePath, cwd));
		this.#lastEditSeq = seq;
	}

	/** Checks a terminal assistant turn and schedules a verification reminder when code went unverified. */
	async checkCompletion(message: AssistantMessage, servedToolChoiceLabel: string | undefined): Promise<boolean> {
		const settings = this.#host.settings;
		if (!cfgVerifyReminders.get(settings)) return false;
		if (servedToolChoiceLabel === "user-force") return false;
		if (this.#host.planModeEnabled()) return false;
		if (this.#awaitingProgress) {
			logger.debug("Verify completion: prior reminder still awaiting agent action; staying silent", {
				attempt: this.#reminderCount,
			});
			return false;
		}
		if (this.#editedFiles.size === 0) return false;
		const max = cfgVerifyRemindersMax.get(settings);
		if (this.#reminderCount >= max) return false;
		const verifyCommands = await this.#resolveVerifyCommands();
		const lastVerification = this.#lastVerification(verifyCommands);
		if (lastVerification?.passed) return false;
		if (verifyCommands.length === 0) return false;
		if (isAwaitingUserAnswer(message)) return false;
		if (NO_VERIFY_REQUEST_RE.test(this.#latestUserText())) return false;
		if (this.#host.hasPendingAsyncWake()) return false;
		// The awaits above can interleave with a new tool result or another stop; re-check the latch.
		if (this.#awaitingProgress || this.#reminderCount >= max) return false;

		const attempt = ++this.#reminderCount;
		const files = [...this.#editedFiles];
		const listed = files.slice(0, MAX_LISTED_FILES).join(", ");
		const extra = files.length - MAX_LISTED_FILES;
		const text = prompt.render(verifyReminderPrompt, {
			files: extra > 0 ? `${listed} +${extra} more` : listed,
			commands: verifyCommands.join("; "),
			lastFailedCommand: lastVerification && !lastVerification.passed ? lastVerification.command : undefined,
			attempt,
			max,
		});
		const reminderMessage: Message = {
			role: "developer",
			content: [{ type: "text", text }],
			attribution: "agent",
			timestamp: Date.now(),
		};
		logger.debug("Verify completion: sending reminder", { attempt, files: files.length });
		this.#awaitingProgress = true;
		this.#host.agent.appendMessage(reminderMessage);
		this.#host.sessionManager.appendMessage(reminderMessage);
		this.#host.emitNotice(
			"info",
			`Verification reminder ${attempt}/${max}: code edited without a passing check`,
			"verify",
		);
		this.#host.scheduleAgentContinue({ source: "verify-reminder", generation: this.#host.promptGeneration() });
		return true;
	}

	#resolveVerifyCommands(): Promise<readonly string[]> {
		const cwd = this.#host.cwd();
		if (!this.#verifyCommands || this.#verifyCommandsCwd !== cwd) {
			this.#verifyCommandsCwd = cwd;
			this.#verifyCommands = resolveWorkspaceSnapshot(cwd).then(snapshot => snapshot?.verifyCommands ?? []);
		}
		return this.#verifyCommands;
	}

	#lastVerification(verifyCommands: readonly string[]): BashRun | undefined {
		for (let index = this.#bashRuns.length - 1; index >= 0; index--) {
			const run = this.#bashRuns[index];
			if (run.seq <= this.#lastEditSeq) return undefined;
			if (isVerificationCommand(run.command, verifyCommands)) return run;
		}
		return undefined;
	}

	#toolCallArguments(toolCallId: string): Record<string, unknown> | undefined {
		const messages = this.#host.agent.state.messages;
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (!message) continue;
			const args = toolCallArgumentsFromMessage(message, toolCallId);
			if (args) return args;
		}
		return undefined;
	}

	#latestUserText(): string {
		const messages = this.#host.agent.state.messages;
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (message?.role !== "user" || message.synthetic) continue;
			if (typeof message.content === "string") return message.content;
			return message.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
		}
		return "";
	}
}

function toolCallArgumentsFromMessage(message: AgentMessage, toolCallId: string): Record<string, unknown> | undefined {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	for (const block of message.content) {
		if (!isRecord(block) || block.type !== "toolCall" || block.id !== toolCallId) continue;
		return isRecord(block.arguments) ? block.arguments : {};
	}
	return undefined;
}

function editedPaths(
	toolName: string,
	details: Record<string, unknown> | undefined,
	args: Record<string, unknown> | undefined,
): string[] {
	const paths: string[] = [];
	if (toolName === "write") {
		const filePath = args ? stringProperty(args, "path") : undefined;
		if (filePath) paths.push(filePath);
		return paths;
	}
	if (!details) return paths;
	if (toolName === "edit") {
		const filePath = stringProperty(details, "path");
		if (filePath) paths.push(filePath);
		if (Array.isArray(details.perFileResults)) {
			for (const result of details.perFileResults) {
				if (!isRecord(result) || result.isError === true) continue;
				const resultPath = stringProperty(result, "path");
				if (resultPath) paths.push(resultPath);
			}
		}
		return paths;
	}
	if (details.applied === true && Array.isArray(details.fileReplacements)) {
		for (const replacement of details.fileReplacements) {
			if (!isRecord(replacement)) continue;
			const replacementPath = stringProperty(replacement, "path");
			if (replacementPath) paths.push(replacementPath);
		}
	}
	return paths;
}

function displayPath(filePath: string, cwd: string): string {
	if (!path.isAbsolute(filePath)) return filePath;
	const relative = path.relative(cwd, filePath);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return filePath;
	return relative;
}

function isInsideCwd(filePath: string, cwd: string): boolean {
	if (!path.isAbsolute(filePath)) return true;
	const relative = path.relative(cwd, filePath);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isVerifyTarget(word: string): boolean {
	return VERIFY_TARGETS.some(target => word === target || word.startsWith(`${target}:`));
}

function stripCommandPrefix(words: readonly string[]): string[] {
	let index = 0;
	for (;;) {
		const word = words[index];
		if (word === undefined) break;
		if (ENV_ASSIGNMENT_RE.test(word) || WRAPPER_WORDS[word] === true) {
			index++;
		} else if (word === "timeout") {
			index += 2;
		} else {
			break;
		}
	}
	return words.slice(index);
}

function matchesGenericCheck(words: readonly string[]): boolean {
	const [first = "", second = "", third = ""] = words;
	if (JS_RUNNERS[first] === true) {
		if (second === "run") return isVerifyTarget(third);
		if (isVerifyTarget(second)) return true;
		if (first === "pnpm" && second === "exec") return JS_EXEC_TOOLS[third] === true;
		return first === "yarn" && JS_EXEC_TOOLS[second] === true;
	}
	if (first === "npx" || first === "bunx") return JS_EXEC_TOOLS[second] === true;
	if (BARE_CHECKERS[first] === true) return true;
	if (first === "python" || first === "python3") return second === "-m" && third === "pytest";
	if (first === "uv") return second === "run" && third === "pytest";
	if (first === "cargo") return CARGO_SUBCOMMANDS[second] === true;
	if (first === "go") return GO_SUBCOMMANDS[second] === true;
	if (first === "make" || first === "just") return isVerifyTarget(second);
	if (JVM_RUNNERS[first] === true) return JVM_TARGETS[second] === true;
	if (first === "dotnet") return DOTNET_SUBCOMMANDS[second] === true;
	return false;
}

/** Whether any segment of `command` runs a project check (detected verify command or a well-known test/build/lint tool). */
export function isVerificationCommand(command: string, verifyCommands: readonly string[]): boolean {
	const verifyWords = verifyCommands.map(entry => entry.split(/\s+/).filter(word => word.length > 0));
	for (const segment of tokenizeShellSegments(command)) {
		const words = stripCommandPrefix(segment);
		if (words.length === 0) continue;
		if (
			verifyWords.some(entry => entry.length > 0 && entry.every((word, index) => words[index] === word)) ||
			matchesGenericCheck(words)
		) {
			return true;
		}
	}
	return false;
}
