/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Eval (per-backend toggles; add more as new backends ship, e.g. eval.ts)
export const cfgEvalPy = register({
	id: "eval.py",
	type: "boolean",
	default: true,
	env: "PI_PY",
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: "Python Eval Backend",
		description: "Allow the eval tool to dispatch Python cells to the IPython kernel",
	},
});

export const cfgEvalJs = register({
	id: "eval.js",
	type: "boolean",
	default: true,
	env: "PI_JS",
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: "JavaScript Eval Backend",
		description: "Allow the eval tool to dispatch JavaScript cells to the in-process runtime",
	},
});

export const cfgEvalAutoProvision = register({
	id: "eval.autoProvision",
	type: "boolean",
	default: true,
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: "Eval Environment Provisioning",
		description: "Automatically create the managed JavaScript eval package environment on first install",
	},
});

export const cfgEvalToolsEnabled = register({
	id: "eval.tools.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: "Eval-Defined Tools",
		description:
			"Let eval cells define tools (@tool in Python, tool(fn) in JS) that task, agent(), and workpool() subagents can call",
	},
});

export const cfgEvalToolsMaxParallelCalls = register({
	id: "eval.tools.maxParallelCalls",
	type: "number",
	default: 10,
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: "Max Parallel Tool Calls",
		description: "Maximum session tool calls one eval cell runs at once; exclusive tools (writes) always run alone",
		options: [
			{ value: "1", label: "1 call" },
			{ value: "4", label: "4 calls" },
			{ value: "10", label: "10 calls", description: "Default" },
			{ value: "32", label: "32 calls" },
		],
	},
});

export const cfgEvalToolsMaxCallsPerMinute = register({
	id: "eval.tools.maxCallsPerMinute",
	type: "number",
	default: 1024,
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: "Max Tool Calls Per Minute",
		description:
			"Cap on session tool calls per eval cell, scaled by the cell's timeout (calls per minute of timeout); stops runaway loops early. 0 disables the cap",
		options: [
			{ value: "0", label: "Unlimited" },
			{ value: "256", label: "256 per minute" },
			{ value: "1024", label: "1024 per minute", description: "Default" },
			{ value: "4096", label: "4096 per minute" },
		],
	},
});

export const cfgEvalWorkpoolFreshAgents = register({
	id: "eval.workpool.freshAgents",
	type: "boolean",
	default: false,
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: "Fresh Workpool Agents",
		description: "Spawn a new subagent for every workpool item instead of reusing workers or batching queued items",
	},
});

export const cfgEvalAutoBackgroundEnabled = register({
	id: "eval.autoBackground.enabled",
	protocolDefault: ["rpc"],
	type: "boolean",
	default: false,
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: "Eval Auto-Background",
		description: "Automatically background long-running eval cells and deliver the result later",
	},
});

export const cfgEvalAutoBackgroundThresholdMs = register({
	id: "eval.autoBackground.thresholdMs",
	protocolDefault: ["rpc"],
	type: "number",
	default: 60_000,
});

// Runtime knobs (consumed by eval backends and the /python slash command)
export const cfgPythonKernelMode = register({
	id: "python.kernelMode",
	type: "enum",
	values: ["session", "per-call"] as const,
	default: "session",
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: "Python Kernel Mode",
		description: "Keep the IPython kernel alive across eval calls or start fresh each time",
	},
});

export const cfgPythonInterpreter = register({
	id: "python.interpreter",
	type: "string",
	default: "",
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: "Python Interpreter",
		description:
			"Optional path to an exact Python executable. When set, automatic Python runtime discovery is skipped.",
	},
});
