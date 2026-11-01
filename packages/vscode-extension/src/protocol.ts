/**
 * Messages between the extension host and its webviews (`postMessage`).
 *
 * The chat webview renders omp's RPC wire types directly: the host forwards
 * every live session event untouched (`event`) and supplies snapshots the
 * webview cannot derive from events alone (transcript history after a session
 * switch, state, models). Commands flow back as `ChatRequest`s; the host owns
 * the omp process, VS Code dialogs, and the session store.
 *
 * Shared by `src/` (host, Node) and `webview/` (browser); type-only imports.
 * It also holds the few pure helpers both sides must agree on (which messages
 * are editable prompts and their draft text).
 */
import type {
	AgentMessage,
	AvailableSlashCommand,
	ImageContent,
	RpcAgentEvent,
	SessionState,
	SessionStats,
	ThinkingLevel,
	TodoPhase,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/wire/rpc-wire.generated";

export type {
	AgentMessage,
	AssistantMessage,
	AvailableSlashCommand,
	BashExecutionMessage,
	CustomMessage,
	ImageContent,
	RpcAgentEvent,
	SessionState,
	SessionStats,
	TextContent,
	ThinkingContent,
	ThinkingLevel,
	ToolCall,
	TodoItem,
	TodoPhase,
	ToolResultMessage,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/wire/rpc-wire.generated";

/** A model the user can pick (trimmed from omp's catalog entry). */
export interface ModelChoice {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number | null;
}

/** One proposal of `omp skill proposals --json`: a skill change omp suggests, awaiting the user's decision. */
export interface SkillProposalSummary {
	/** Passed to `omp skill approve|reject`. */
	id: string;
	skill: string;
	createdAt: number;
	summary: string;
	/** The evidence omp gives for the change. */
	reason: string;
	/** Paths relative to the skill directory. */
	files: string[];
	diff: string;
	status: "pending" | "approved" | "rejected";
	/** The skill changed after the proposal: it can only be discarded. */
	stale: boolean;
	/** Session whose task produced the proposal; absent for older proposals. */
	sessionFile?: string;
}

/** `details` of omp's `skill-prompt` custom message (packages/tui/src/chat/messages.ts `SkillPromptDetails`). */
export interface SkillPromptDetails {
	name: string;
	args?: string;
	/** The draft as submitted, `/skill:<name>` token in place; absent on older sessions. */
	prompt?: string;
	lineCount?: number;
	/** Every skill a multi-skill invocation loaded, in the order typed; absent for one skill. */
	skills?: Array<{ name: string; path: string }>;
}

export function isSkillPromptDetails(details: unknown): details is SkillPromptDetails {
	return typeof details === "object" && details !== null && "name" in details && typeof details.name === "string";
}

/** The draft of a skill invocation as submitted, `/skill:<name>` token in place. */
export function skillPromptDraft(details: SkillPromptDetails): string {
	const token = `/skill:${details.name}`;
	return details.prompt ?? (details.args ? `${token} ${details.args}` : token);
}

/**
 * A prompt the user wrote, and so can edit: a non-synthetic user message, or a
 * `/skill:` prompt the user invoked (attribution `user`). Agent/autoload skill
 * injections are not: omp's `navigate_tree` does not rewind to them.
 * Host (`#findPrompt`, via prompt-entries.ts) and webview count prompts with this.
 */
export function isUserPrompt(message: AgentMessage): boolean {
	if (message.role === "user") return !message.synthetic;
	return message.role === "custom" && message.customType === "skill-prompt" && message.attribution === "user";
}

/**
 * An approved plan being executed, tracked by the plan button. `starting`: no
 * step list yet; `running`: the agent works through open steps; `paused`: the
 * agent stopped with steps still open; `done`: every step is closed.
 */
export interface PlanRunView {
	title: string;
	/** Local path of the plan file, when it can be opened. */
	planFile?: string;
	status: "starting" | "running" | "paused" | "done";
	/** The agent's step list (`todo`) since the approval; empty until it makes one. */
	phases: TodoPhase[];
}

/** Lifecycle status of a subagent row. */
export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "aborted";

/** One subagent of the shown session, folded from omp's `subagent_lifecycle`/`subagent_progress` frames. */
export interface SubagentView {
	id: string;
	/** Agent type (`task`, `scout`, a custom agent…). */
	agent: string;
	status: SubagentStatus;
	/** Short label the spawner gave, if any. */
	description?: string;
	/** The task the agent was given. */
	assignment?: string;
	/** What it is doing now: the current call's intent or tool, else its latest intent. */
	activity?: string;
	toolCount: number;
	requests: number;
	/** Soft request budget the run is held to. */
	requestBudget?: number;
	tokens: number;
	cost: number;
	/** Run time reported by omp (ms). */
	durationMs: number;
	/** When the host first saw the agent (epoch ms); running rows tick from it. */
	startedAt: number;
	model?: string;
	/** Provider retry in progress or the final retry failure, as a short line. */
	retry?: string;
	/** The user asked it to wrap up (`hurrySubagents`). */
	wrapUpRequested: boolean;
}

/** A tool call of a subagent request: `running` until its result arrives, `interrupted` when the agent ended first. */
export interface SubagentToolView {
	name: string;
	/** The call's intent, else its first text argument (path, command, pattern…). */
	label?: string;
	status: "running" | "done" | "error" | "interrupted";
}

/** One model request of a subagent (an assistant message of its transcript), oldest first. */
export interface SubagentRequestView {
	/** 1-based, as omp counts the subagent's requests. */
	index: number;
	/** When the model's answer was recorded (epoch ms). */
	at: number;
	/** How long the model took to answer (ms). */
	durationMs?: number;
	/** Input + output + cache-write tokens, as the panel's token total counts them. */
	tokens: number;
	cost: number;
	/** First line of the answer's text. */
	text?: string;
	tools: SubagentToolView[];
	/** The provider error or abort that ended the answer. */
	error?: string;
	/** Its tool calls are still running: the request the agent is processing. */
	current: boolean;
}

/** What a session is doing in this window: working, or finished while no chat showed it. */
export type SessionActivity = "running" | "done";

/** One row of the chat's history panel (a session file of the workspace). */
export interface SessionListItem {
	path: string;
	label: string;
	/** First line of the session's first prompt. */
	firstPrompt?: string;
	/** First line of its latest prompt; absent when that is the first one (see `singlePrompt`) or unknown. */
	lastPrompt?: string;
	/** The session has a single prompt. */
	singlePrompt: boolean;
	age: string;
	/** When the session file last changed (epoch ms); the panel folds chats older than 24 hours. */
	modified: number;
	active: boolean;
	activity?: SessionActivity;
	/** A chat without a workspace (listed in the history panel's own section). */
	noWorkspace: boolean;
	/** Skill proposals awaiting a decision that this session's tasks produced. */
	proposals: number;
}

/** Text a local slash command printed, and when (epoch ms, comparable with message timestamps). */
export interface CommandOutput {
	timestamp: number;
	text: string;
}

/** Lifecycle of the omp process behind a chat view. */
export type AgentStatus =
	| { phase: "starting" }
	| { phase: "ready" }
	/** The process exited or could not start; `message` explains why (missing binary, crash). */
	| { phase: "stopped"; message: string };

/** Host → chat webview. */
export type ChatUpdate =
	| { type: "status"; status: AgentStatus }
	/**
	 * Replace the whole transcript (startup, session switch, new session).
	 * Messages are in chronological order; tool results follow their assistant
	 * message and pair with its tool calls by `toolCallId`. `commandOutputs` are
	 * what local slash commands printed in the session, placed by timestamp.
	 */
	| { type: "history"; messages: AgentMessage[]; commandOutputs: CommandOutput[] }
	/**
	 * One live session event exactly as omp emitted it (`message_start`,
	 * `message_update`, `message_end`, `tool_execution_*`, `agent_start`,
	 * `agent_end`, `queue_update`, `auto_compaction_*`, `auto_retry_*`,
	 * `notice`, ...). `message_*` frames carry `messageId`, stable from start to end.
	 */
	| { type: "event"; event: RpcAgentEvent & { messageId?: string } }
	/**
	 * Session snapshot; re-sent after every turn, model change, or session switch.
	 * `busySince` is when the session's running turn started (epoch ms), absent while idle.
	 * `noWorkspace`: a chat without a workspace (runs in the no-workspace folder).
	 */
	| {
			type: "state";
			state: SessionState;
			stats?: SessionStats;
			title?: string;
			busySince?: number;
			noWorkspace: boolean;
	  }
	| { type: "models"; models: ModelChoice[] }
	| { type: "thinkingLevels"; levels: ThinkingLevel[] }
	/** Slash commands for composer completion. */
	| { type: "commands"; commands: AvailableSlashCommand[] }
	/** Text printed by a local slash command (no agent turn). */
	| { type: "commandOutput"; text: string }
	/** Transient banner (errors, info) shown above the composer. */
	| { type: "notice"; level: "info" | "warning" | "error"; message: string }
	/** Insert text at the composer cursor (Add Selection / Add File) and focus it. */
	| { type: "insertText"; text: string }
	| { type: "focusInput" }
	/** An `editMessage` was not resent (declined, vetoed, or failed): the webview reopens its editor. */
	| { type: "editAborted" }
	/**
	 * Dictation state from omp (recording, transcribing, idle), with a streaming
	 * model's running transcript in `text`; `error` when a capture failed.
	 */
	| { type: "dictation"; state: "recording" | "transcribing" | "idle"; text?: string; error?: string }
	/** omp's answer to a `predictWord` request: the rest of the word, or null for nothing to show. */
	| { type: "wordPrediction"; requestId: number; suffix: string | null }
	/** "Find in Chat" (Ctrl+F while the chat has focus): open the find bar. */
	| { type: "openFind" }
	/** A finished dictation: insert `text` at the cursor, and send it when `submit`. */
	| { type: "dictationText"; text: string; submit: boolean }
	/** The "Toggle Voice Input" command: start dictating, or stop and transcribe. */
	| { type: "toggleDictation" }
	/** Sessions of the workspace and then those without a workspace, each newest first (answer to `listSessions`). */
	| { type: "sessions"; sessions: SessionListItem[] }
	/** Activity of every session that is running or finished unseen, by session file; sent when it changes. */
	| { type: "sessionActivity"; activity: Record<string, SessionActivity> }
	/** Pending skill proposals per session file (sessions without any are absent); sent when they change. */
	| { type: "sessionProposals"; counts: Record<string, number> }
	/**
	 * omp asks to approve the plan it proposed: show it in the chat with `options`
	 * as buttons and answer with `planDecision`. `path` is the plan file on disk.
	 */
	| { type: "planReview"; id: string; title: string; content: string; path?: string; options: string[] }
	/** The approved plan being executed, or null when none (cleared by a new plan, a new task, or `dismissPlanRun`). */
	| { type: "planRun"; run: PlanRunView | null }
	/** omp withdrew the plan review (the turn was aborted); disable its buttons. */
	| { type: "planReviewClosed"; id: string }
	/** omp is reviewing the skills the last task of the open session relied on (`running`), or not (`idle`). */
	| { type: "skillCuration"; status: "idle" | "running" }
	/** Pending skill proposals of the shown session, newest first. */
	| { type: "skillProposals"; proposals: SkillProposalSummary[] }
	/** Subagents of the shown session's current task (running first, then finished); empty when none. */
	| { type: "subagents"; subagents: SubagentView[] }
	/**
	 * Requests of the watched subagent (`watchSubagent`), re-sent as its transcript grows.
	 * `waiting`: it is running with no tool in flight, so the model is answering its next request.
	 * `error`: its transcript could not be read (e.g. a session that is not saved to disk).
	 */
	| { type: "subagentRequests"; id: string; requests: SubagentRequestView[]; waiting: boolean; error?: string };

/** Chat webview → host. */
export type ChatRequest =
	/** Webview loaded; the host replies with status, history, state, models, commands. */
	| { type: "ready" }
	/** Send a prompt (with pasted images). While the agent is busy the host queues it (`ompCustom.sendWhileBusy`). */
	| { type: "prompt"; text: string; images?: ImageContent[] }
	/**
	 * Edit a prompt of the conversation and resend it: the session continues from
	 * there and everything after it leaves the conversation. `fromEnd` counts the
	 * prompts (`isUserPrompt`) after it (0 = the last one); `original` is its text as shown.
	 */
	| { type: "editMessage"; fromEnd: number; original: string; text: string }
	| { type: "abort" }
	/** Start a new chat; `noWorkspace` starts one without a workspace (see no-workspace.ts). */
	| { type: "newSession"; noWorkspace?: boolean }
	/** List the sessions for the history panel; the host answers with `sessions`. */
	| { type: "listSessions" }
	| { type: "openSession"; path: string }
	/** Rename the session at `path`, or the open one when `path` is absent; the host re-sends `sessions`. */
	| { type: "renameSession"; path?: string; name: string }
	/** Delete the session at `path` (named `label` in the confirmation); the host re-sends `sessions`. */
	| { type: "deleteSession"; path: string; label: string }
	/** Pick files with the open dialog and insert them as `@path` mentions. */
	| { type: "attachFiles" }
	| { type: "setModel"; provider: string; modelId: string }
	| { type: "setThinkingLevel"; level: ThinkingLevel }
	/** Enter or leave omp's plan mode, then send `prompt` if given (`/plan <prompt>`); the host replies with a fresh `state`. */
	| { type: "setPlanMode"; enabled: boolean; prompt?: string }
	/** Turn omp's delegate mode on or off (prompts run through subagents); the host replies with a fresh `state`. */
	| { type: "setDelegateMode"; enabled: boolean }
	/** Ask every running subagent (and the lead) to wrap up. */
	| { type: "hurrySubagents" }
	/** Follow one subagent's requests (`subagentRequests`), or stop with `null`. */
	| { type: "watchSubagent"; id: string | null }
	/** Answer a `planReview` with one of its options. */
	| { type: "planDecision"; id: string; value: string }
	/** Stop tracking the approved plan's execution (the plan button turns off). */
	| { type: "dismissPlanRun" }
	/** Open a plan file (absolute path) rendered in an editor tab. */
	| { type: "openPlan"; path: string }
	/** Revert one of omp's self-improvement edits to a skill (`omp skill revert <id>`), from its `skill-update` card. */
	| { type: "revertSkillUpdate"; id: string }
	/** Apply a skill proposal (`omp skill approve <id>`). */
	| { type: "approveSkillProposal"; id: string }
	/** Decline a skill proposal (asks for an optional reason, then `omp skill reject <id>`). */
	| { type: "rejectSkillProposal"; id: string }
	/** Show a skill proposal's changes in a diff editor. */
	| { type: "openSkillProposalDiff"; id: string }
	| { type: "openSettings" }
	| { type: "login" }
	| { type: "compact" }
	| { type: "restart" }
	/** Open a file the transcript mentions; relative paths resolve against the workspace. */
	| { type: "openFile"; path: string; line?: number }
	| { type: "openExternal"; url: string }
	/** Remove a queued (not yet delivered) message. */
	| { type: "removeQueued"; message: string; queue: "steering" | "followUp" }
	/** Voice input: start recording, stop and transcribe, or drop the recording. */
	| { type: "dictation"; action: "start" | "stop" | "cancel" }
	/** Ghost text: predict the end of the word at `cursor` (a UTF-16 offset into `text`); answered by `wordPrediction`. */
	| { type: "predictWord"; requestId: number; text: string; cursor: number }
	/** A shown prediction was accepted (Tab/→) or typed past, for the engine to learn from. */
	| { type: "predictWordFeedback"; text: string; cursor: number; suggestion: string; accepted: boolean }
	/** Keyboard focus entered or left the webview (drives the Ctrl+F keybinding's context). */
	| { type: "focusChanged"; focused: boolean };

/** One setting row in the settings panel (from `omp config list --json`). */
export interface SettingEntry {
	key: string;
	type: "boolean" | "string" | "number" | "enum" | "array" | "record";
	/** Effective value; absent for unset settings and for redacted credentials. */
	value?: unknown;
	redacted?: boolean;
	default?: unknown;
	description: string;
	values?: string[];
	ui?: {
		tab: string;
		group?: string;
		label: string;
		warning?: string;
		options?: { value: string; label: string; description?: string }[];
	};
}

/** Host → settings webview. */
export type SettingsUpdate =
	| { type: "settings"; entries: SettingEntry[]; configPath: string }
	/** Result of a `set`/`reset`: the new effective value, or the error omp reported. */
	| { type: "saved"; key: string; value?: unknown; error?: string }
	| { type: "error"; message: string };

/** Settings webview → host. */
export type SettingsRequest =
	| { type: "ready" }
	| { type: "refresh" }
	/** `value` is passed verbatim to `omp config set <key> <value>` (arrays/records as JSON). */
	| { type: "set"; key: string; value: string }
	| { type: "reset"; key: string }
	| { type: "openConfigFile" };
