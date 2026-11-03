/**
 * Chat webview entry: mounts header, transcript, history panel, and composer
 * into `#root` and routes host `ChatUpdate`s to them.
 */
import type { AgentStatus, ChatRequest, ChatUpdate } from "../../src/protocol";
import { button, h } from "../dom";
import { installTooltips } from "../tooltip";
import { getVsCodeApi } from "../vscode-api";
import { Composer, type ComposerState } from "./composer";
import { Header } from "./header";
import { HistoryPanel } from "./history";
import { FindBar } from "./find";
import { Transcript, brailleSpinner } from "./transcript";

type ChatViewState = Partial<ComposerState>;

const vscode = getVsCodeApi<ChatRequest, ChatViewState>();
const post = (request: ChatRequest) => vscode.postMessage(request);

const header = new Header(post, () => history.toggle());
// The History replaces the chat: the composer (with its queue and notices) has nothing to send to there.
const history = new HistoryPanel(post, open => {
	header.setHistoryMode(open);
	composer.element.hidden = open;
});
const saved = vscode.getState();
const composer = new Composer(
	post,
	state => vscode.setState(state),
	{ draft: saved?.draft ?? "", quote: saved?.quote },
	{
		// TUI commands without an RPC handler, run by the chat itself.
		localCommands: [
			{ name: "new", description: "Start a new session", run: () => post({ type: "newSession" }) },
			{
				name: "resume",
				description: "Resume a different session",
				run: () => {
					if (!history.isOpen) history.toggle();
				},
			},
			{ name: "settings", description: "Open settings", run: () => post({ type: "openSettings" }) },
		],
		onToggleThinking: expanded => transcript.setThinkingExpanded(expanded),
		promptHistory: () => transcript.recentPrompts(),
	},
);
const transcript = new Transcript(
	post,
	prompt => composer.fill(prompt),
	text => composer.setQuote(text),
);

const statusSpinner = brailleSpinner();
const statusLabel = h("div", { className: "status-label" });
const statusMessage = h("pre", { className: "status-message" });
const restart = button("Restart", "primary-button", () => post({ type: "restart" }));
const statusPanel = h(
	"div",
	{ className: "status-overlay" },
	h("div", { className: "status-card" }, statusSpinner.element, statusLabel, statusMessage, restart),
);

const find = new FindBar(transcript.searchRoot, transcript.scrollElement);

const root = document.getElementById("root")!;
root.classList.add("chat");
installTooltips();
root.append(
	header.element,
	h("div", { className: "main" }, transcript.element, find.element, statusPanel, history.element),
	composer.element,
);

// Find in chat: Ctrl+F (⌘F on macOS, where Ctrl+F moves the caret), then F3 / ⌘G for the next match.
// VS Code binds Ctrl+F to the code editor's find even while this webview has focus, so the
// extension contributes a keybinding (`ompCustom.findInChat`) for while it reports focus here;
// that command arrives as `openFind`. The key handler below covers the key when no binding applies.
function openFind(): void {
	if (history.isOpen) history.focusSearch();
	else find.open();
}
const isMac = navigator.userAgent.includes("Mac");
document.addEventListener("keydown", event => {
	const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
	const key = event.key.toLowerCase();
	if (mod && !event.altKey && key === "f") {
		event.preventDefault();
		openFind();
	} else if (find.isOpen && (event.key === "F3" || (mod && key === "g"))) {
		event.preventDefault();
		find.step(event.shiftKey ? -1 : 1);
	}
});
window.addEventListener("focus", () => post({ type: "focusChanged", focused: true }));
window.addEventListener("blur", () => post({ type: "focusChanged", focused: false }));

let sessionFile: string | undefined;

let busy = false;
let busySince: number | undefined;
/** `since`: when the shown session's turn started; a session switch keeps busy but changes it. */
function setBusy(next: boolean, since?: number): void {
	const start = next ? (since ?? (busy ? busySince : undefined) ?? Date.now()) : undefined;
	if (busy === next && busySince === start) return;
	busy = next;
	busySince = start;
	transcript.setBusy(next, start);
	composer.setBusy(next);
}

function setStatus(status: AgentStatus): void {
	statusPanel.dataset.phase = status.phase;
	statusPanel.hidden = status.phase === "ready";
	statusSpinner.element.hidden = status.phase !== "starting";
	if (status.phase === "starting") statusSpinner.start();
	else statusSpinner.stop();
	statusLabel.textContent = status.phase === "starting" ? "Starting MarIA Code…" : "MarIA Code is not running";
	statusMessage.textContent = status.phase === "stopped" ? status.message : "";
	statusMessage.hidden = status.phase !== "stopped";
	restart.hidden = status.phase !== "stopped";
	composer.setEnabled(status.phase === "ready");
	if (status.phase !== "ready") setBusy(false);
}

function handle(update: ChatUpdate): void {
	switch (update.type) {
		case "status":
			setStatus(update.status);
			break;
		case "history":
			transcript.setHistory(update.messages, update.commandOutputs);
			composer.resetHistoryNavigation();
			history.close();
			break;
		case "event": {
			const { event } = update;
			switch (event.type) {
				case "agent_start":
					setBusy(true);
					break;
				case "agent_end":
					transcript.handleEvent(event);
					setBusy(false);
					break;
				case "queue_update":
					composer.setQueue(event.steering, event.followUp, event.liveSteered);
					break;
				case "notice":
					composer.showNotice(event.level, event.message);
					break;
				case "thinking_level_changed":
					if (event.thinkingLevel) composer.picker.setThinkingLevel(event.thinkingLevel);
					break;
				default:
					transcript.handleEvent(event);
			}
			break;
		}
		case "state": {
			const { state } = update;
			header.setState(state, update.stats, update.title, update.noWorkspace);
			history.setChatNoWorkspace(update.noWorkspace);
			composer.picker.setCurrent(state.model);
			if (state.thinkingLevel) composer.picker.setThinkingLevel(state.thinkingLevel);
			composer.setUsage(state, update.stats);
			composer.setModeState(state);
			if (state.isStreaming !== undefined) setBusy(state.isStreaming, update.busySince);
			if (state.queuedMessages) {
				const queued = state.queuedMessages;
				composer.setQueue(queued.steering, queued.followUp, queued.liveSteered);
			}
			if (state.sessionFile !== sessionFile) {
				sessionFile = state.sessionFile;
				history.close();
			}
			break;
		}
		case "models":
			composer.picker.setModels(update.models);
			break;
		case "thinkingLevels":
			composer.picker.setThinkingLevels(update.levels);
			break;
		case "sessions":
			history.setSessions(update.sessions);
			break;
		case "sessionActivity":
			history.setActivity(update.activity);
			header.setActivity(update.activity);
			break;
		case "sessionProposals":
			history.setProposalCounts(update.counts);
			break;
		case "planReview":
			history.close();
			transcript.showPlanReview(update);
			break;
		case "planReviewClosed":
			transcript.closePlanReview(update.id);
			break;
		case "planRun":
			composer.setPlanRun(update.run);
			break;
		case "subagents":
			composer.setSubagents(update.subagents);
			break;
		case "subagentRequests":
			composer.setSubagentRequests(update);
			break;
		case "scopeCheckpoint":
			composer.setScopeCheckpointStats(update.stats);
			break;
		case "commands":
			composer.setCommands(update.commands);
			break;
		case "commandOutput":
			transcript.appendCommandOutput(update.text);
			break;
		case "notice":
			composer.showNotice(update.level, update.message);
			break;
		case "insertText":
			composer.insertText(update.text);
			break;
		case "focusInput":
			composer.focus();
			break;
		case "editAborted":
			transcript.editAborted();
			break;
		case "dictation":
			composer.dictationUpdate(update.state, update.text, update.error);
			break;
		case "wordPrediction":
			composer.wordPrediction(update.requestId, update.suffix);
			break;
		case "dictationText":
			composer.dictationText(update.text, update.submit);
			break;
		case "toggleDictation":
			composer.toggleDictation();
			break;
		case "openFind":
			openFind();
			break;
		case "skillCuration":
			header.setCuration(update.status);
			break;
		case "skillProposals":
			header.setProposals(update.proposals);
			break;
	}
}

window.addEventListener("message", (event: MessageEvent<ChatUpdate>) => handle(event.data));
setStatus({ phase: "starting" });
post({ type: "ready" });
