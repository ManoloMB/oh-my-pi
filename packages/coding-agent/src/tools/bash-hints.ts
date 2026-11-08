/**
 * Pure detectors for model-facing bash recovery hints: a fixed hint for
 * recognizable failures, and a warning when exit 0 comes from a pipeline tail
 * or fallback while the output shows failures. Hints never interpolate output.
 */
import { extractFlatShellCommandSegments } from "./shell-tokenize";

export interface BashHintInput {
	command: string;
	output: string;
	exitCode: number | undefined;
}

/** Only the output tail is scanned; failures surface at the end of runs. */
const SCAN_TAIL_CHARS = 16_000;

interface FailureHintRule {
	matches(exitCode: number, output: string): boolean;
	hint: string;
}

const FAILURE_HINT_RULES: readonly FailureHintRule[] = [
	{
		matches: (exitCode, output) => exitCode === 127 || /\bcommand not found\b/.test(output),
		hint: "The shell could not find the program. Check it is installed and on PATH, or run it through the project's runner (`bun run`, `npx`, `uv run`, `./node_modules/.bin/…`).",
	},
	{
		matches: (_, output) => /ModuleNotFoundError|No module named ['"]/.test(output),
		hint: "Python could not import a module. Use the project's interpreter or virtualenv (`uv run`, `.venv/bin/python`, `poetry run`) and check the dependency is installed there.",
	},
	{
		matches: (_, output) => /Cannot find module ['"]|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(output),
		hint: "Node could not resolve a module. Check the import path and that dependencies are installed in the package that runs the command.",
	},
	{
		matches: (_, output) =>
			/CONFLICT \([^)]+\): Merge conflict|Automatic merge failed|Your local changes to the following files would be overwritten/.test(
				output,
			),
		hint: "Git stopped on conflicting changes. Inspect `git status` and resolve them; rerunning the same command fails the same way.",
	},
	{
		matches: (_, output) => /\bEADDRINUSE\b|address already in use/i.test(output),
		hint: "The port is already in use by another process. Find it (`lsof -i :<port>`) or choose another port instead of retrying.",
	},
	{
		matches: (_, output) => /\bENOSPC\b|No space left on device/.test(output),
		hint: "The disk is full. Free space before retrying.",
	},
	{
		matches: (_, output) => /\bEACCES\b|Permission denied/.test(output),
		hint: "Permission denied. Check ownership and the executable bit (`ls -l`, `chmod +x`); do not retry unchanged.",
	},
	{
		matches: exitCode => exitCode === 126,
		hint: "The file exists but is not executable. Check the executable bit and shebang.",
	},
	{
		matches: exitCode => exitCode === 137,
		hint: "The process was killed (SIGKILL, often out of memory). Reduce the workload before retrying.",
	},
	{
		matches: exitCode => exitCode === 124,
		hint: "The command reported a timeout (exit 124). Raise the limit or narrow the command.",
	},
];

/** Recovery hint for a recognizable non-zero exit; first matching rule wins. */
export function detectBashFailureHint(input: BashHintInput): string | undefined {
	const { exitCode } = input;
	if (exitCode === undefined || exitCode === 0) return undefined;
	const output = input.output.slice(-SCAN_TAIL_CHARS);
	return FAILURE_HINT_RULES.find(rule => rule.matches(exitCode, output))?.hint;
}

const MASKING_PIPE_TAILS: Record<string, true> = { tail: true, head: true, grep: true, tee: true };
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MASKING_FALLBACK = /(?:\|\||;)\s*(?:true|:|echo\b[^;&|]*)$/;

const FAILURE_SIGNATURES: readonly RegExp[] = [
	/^error\[E\d{4}\]/m,
	/^error: could not compile/m,
	/Traceback \(most recent call last\)/,
	/\b[1-9]\d* (?:failed|failing)\b/,
	/^\s*[1-9]\d* fail\b/m,
	/^FAILED /m,
	/^--- FAIL: /m,
	/^FAIL\b/m,
	/npm ERR!/,
	/^make(?:\[\d+\])?: \*\*\* /m,
	/error TS\d{4}:/,
];

function hasMaskingShape(command: string): boolean {
	const lastSegment = extractFlatShellCommandSegments(command).at(-1);
	if (lastSegment?.pipedStdin) {
		const program = lastSegment.text.split(/\s+/).find(word => !ENV_ASSIGNMENT.test(word));
		if (program !== undefined && MASKING_PIPE_TAILS[program] === true) return true;
	}
	return MASKING_FALLBACK.test(command.trimEnd());
}

/** True when exit 0 comes from a pipe tail or fallback while the output shows failures. */
export function detectMaskedSuccess(input: BashHintInput): boolean {
	if (input.exitCode !== 0 || !hasMaskingShape(input.command)) return false;
	const output = input.output.slice(-SCAN_TAIL_CHARS);
	return FAILURE_SIGNATURES.some(pattern => pattern.test(output));
}

export const MASKED_SUCCESS_HINT =
	"Exit code 0 here comes from the last command of the pipeline or fallback (`| tail`, `|| true`, …), not from the command that produced this output, and the output shows failures. Treat this run as FAILED; rerun without the pipe/fallback (or with `set -o pipefail`) to get the real exit status.";
