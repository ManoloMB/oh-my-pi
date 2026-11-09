/**
 * The scrolling transcript: renders `history` snapshots and applies live
 * session events (streaming assistant messages, tool execution, retries,
 * compaction). Tool cards are shared between assistant tool calls and their
 * results through `toolCallId`.
 */
import type {
	AgentMessage,
	CommandOutput,
	AssistantMessage,
	ChatRequest,
	ChatUpdate,
	ImageContent,
	RpcAgentEvent,
	ToolResultMessage,
} from "../../src/protocol";
import { isSkillPromptDetails, isUserPrompt, type SkillPromptDetails, skillPromptDraft } from "../../src/protocol";
import { parseQuotedPrompt, type QuotedPrompt, quotedPrompt } from "../../src/quoted-prompt";
import { h, iconButton } from "../dom";
import { icon } from "../icons";
import { setTooltip } from "../tooltip";
import { fileLink, parseFileRef, thumbnail } from "./content";
import { ExamplePrompts } from "./example-prompts";
import { openLightbox } from "./lightbox";
import { playFarewell, preloadFarewell } from "./logo-farewell";
import { renderMarkdown } from "./markdown";
import { MessageEditor } from "./message-editor";
import { SelectionReply } from "./selection-reply";
import { hiddenNoticeElement, isSkillUpdateDetails, noticeElement, skillUpdateElement } from "./notices";
import { PlanCard } from "./plan-card";
import type { PlanFeedbackDialog } from "./plan-feedback";
import { ToolCard, truncatedPre } from "./tools";

type LiveEvent = RpcAgentEvent & { messageId?: string };
type Post = (request: ChatRequest) => void;

const PIN_THRESHOLD_PX = 32;
/** Blocks of an assistant message that are steps of the turn's timeline (a dot on its rail). */
const STEP_SELECTOR = ".markdown, .thinking, .activity, .thumbs, .msg-footer";
/** The TUI's braille activity spinner (packages/tui/src/status-line/segments.ts `brandSpinnerFrame`). */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

export interface BrailleSpinner {
	readonly element: HTMLElement;
	/** Animate on one 80 ms interval; `onTick` runs on the same interval (e.g. a timer label). */
	start(onTick?: () => void): void;
	stop(): void;
}

/** The TUI's braille spinner glyph; it only animates between `start()` and `stop()`. */
export function brailleSpinner(): BrailleSpinner {
	const element = h("span", { className: "working-spinner", ariaHidden: "true" }, SPINNER_FRAMES[0]);
	let frame = 0;
	let timer = 0;
	const stop = () => {
		window.clearInterval(timer);
		timer = 0;
	};
	return {
		element,
		start(onTick) {
			stop();
			frame = 0;
			element.textContent = SPINNER_FRAMES[0]!;
			timer = window.setInterval(() => {
				frame = (frame + 1) % SPINNER_FRAMES.length;
				element.textContent = SPINNER_FRAMES[frame]!;
				onTick?.();
			}, SPINNER_INTERVAL_MS);
		},
		stop,
	};
}

/** Elapsed turn time: `12s`, `1m 05s`, `2h 03m`. */
function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const pad = (value: number) => String(value).padStart(2, "0");
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`;
	return `${Math.floor(seconds / 3600)}h ${pad(Math.floor(seconds / 60) % 60)}m`;
}

/** The muted line under a finished turn's last answer: how long omp worked on it. */
function turnFooter(ms: number): HTMLElement {
	return h("div", { className: "msg turn-footer" }, `Worked for ${formatElapsed(ms)}`);
}

/**
 * Hover-revealed actions beside a user bubble: Edit (prompts only) and Copy,
 * whose icon turns into a check after copying.
 */
function messageActions(text: string, onEdit?: () => void): HTMLElement {
	const copy = iconButton("copy", "Copy message", () => {
		void navigator.clipboard.writeText(text).then(() => {
			copy.replaceChildren(icon("check"));
			setTimeout(() => copy.replaceChildren(icon("copy")), 1200);
		});
	});
	return h("div", { className: "msg-actions" }, onEdit && iconButton("pencil", "Edit message", onEdit), copy);
}

function contentText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text)
		.join("\n");
}

function contentImages(content: string | Array<{ type: string }>): ImageContent[] {
	return typeof content === "string" ? [] : (content.filter(block => block.type === "image") as ImageContent[]);
}

/** A prompt's bubble: the excerpt it replies to, plain text (pre-wrapped), and image thumbnails. */
function bubble(text: string, images: ImageContent[], onEdit?: () => void, quote?: string): HTMLElement {
	const el = h("div", { className: "msg user" });
	const body = h("div", { className: "bubble" });
	if (quote !== undefined) {
		body.append(h("div", { className: "bubble-quote", dataset: { tooltip: quote } }, quote));
	}
	if (text) body.append(h("div", { className: "bubble-text" }, text));
	if (images.length > 0) {
		body.append(h("div", { className: "thumbs" }, ...images.map(image => thumbnail(image))));
	}
	el.append(body, messageActions(text, onEdit));
	return el;
}

function summaryDivider(title: string, summary: string): HTMLElement {
	const details = h(
		"details",
		{ className: "summary-details" },
		h("summary", null, title),
		h("div", { className: "markdown" }),
	);
	(details.lastElementChild as HTMLElement).innerHTML = renderMarkdown(summary);
	return h("div", { className: "msg divider" }, details);
}

/** Something the user sent that starts work: a prompt or a skill invocation. */
function isPrompt(message: AgentMessage): message is Extract<AgentMessage, { role: "user" | "custom" }> {
	if (message.role === "user") return !message.synthetic;
	return message.role === "custom" && message.customType === "skill-prompt";
}

/** What a local slash command printed (`/shake`, `/compact`…), live or replayed from storage. */
function commandOutputElement(text: string): HTMLElement {
	return h("div", { className: "msg command-output" }, truncatedPre(text, "activity-pre"));
}

/**
 * A skill invocation as the user wrote it: the excerpt it replies to (when
 * `quoted`), the draft with each `/skill:name` token as a chip, and the loaded
 * SKILL.md (the message content sent to the model) folded below, as the
 * terminal shows it.
 */
function skillBubble(
	details: SkillPromptDetails,
	skillText: string,
	quoted: QuotedPrompt | undefined,
	onEdit?: () => void,
): HTMLElement {
	const draft = quoted?.message ?? skillPromptDraft(details);
	const text = h("div", { className: "bubble-text" });
	for (const part of draft.split(/(\/skill:[\w.:-]+)/)) {
		if (!part) continue;
		text.append(part.startsWith("/skill:") ? h("span", { className: "skill-chip" }, `✦ ${part.slice(7)}`) : part);
	}
	const lines = details.lineCount ?? skillText.split("\n").length;
	const prompt = h("div", { className: "markdown" });
	prompt.innerHTML = renderMarkdown(skillText);
	const folded = h(
		"details",
		{ className: "skill-details" },
		h(
			"summary",
			null,
			`${details.skills?.length ? `Skills ${details.skills.map(skill => skill.name).join(", ")}` : `Skill ${details.name}`} · ${lines} ${lines === 1 ? "line" : "lines"}`,
		),
		prompt,
	);
	return h(
		"div",
		{ className: "msg user" },
		h(
			"div",
			{ className: "bubble" },
			quoted && h("div", { className: "bubble-quote", dataset: { tooltip: quoted.selection } }, quoted.selection),
			text,
			folded,
		),
		messageActions(draft, onEdit),
	);
}

/** A visible timeline step among an assistant message's blocks; hidden and empty blocks have no dot. */
function isStep(el: Element): el is HTMLElement {
	if (!(el instanceof HTMLElement) || el.hidden || !el.matches(STEP_SELECTOR)) return false;
	return !el.classList.contains("msg-footer") || el.childElementCount > 0;
}

/** A prompt bubble in the transcript and its text, for the pinned prompt above the conversation. */
interface PromptMark {
	el: HTMLElement;
	text: string;
}

/** A prompt sent in this chat as the composer recalls it (↑/↓): text, excerpt replied to, images. */
export interface PromptRecall {
	text: string;
	quote?: string;
	images: ImageContent[];
}

interface Slot {
	type: string;
	el: HTMLElement;
	key: string;
}

class AssistantView {
	readonly element = h("div", { className: "msg assistant" });
	#slots: Slot[] = [];
	#footer = h("div", { className: "msg-footer" });

	constructor(
		private readonly key: string,
		private readonly card: (id: string) => ToolCard,
		/** The composer's "expand all thinking" toggle is on. */
		private readonly thinkingExpanded: () => boolean,
	) {
		this.element.append(this.#footer);
	}

	update(message: AssistantMessage, streaming: boolean): void {
		const content = message.content ?? [];
		for (let index = 0; index < content.length; index++) {
			const block = content[index]!;
			if (this.#slots[index]?.type !== block.type) this.#truncate(index);
			let slot = this.#slots[index];
			if (!slot) {
				slot = this.#createSlot(block.type);
				this.#slots.push(slot);
				this.element.insertBefore(slot.el, this.#footer);
			}
			switch (block.type) {
				case "text":
					if (slot.key !== block.text) {
						slot.key = block.text;
						slot.el.innerHTML = renderMarkdown(block.text);
					}
					slot.el.hidden = block.text.trim() === "";
					break;
				case "thinking": {
					const details = slot.el as HTMLDetailsElement;
					const live = streaming && index === content.length - 1;
					const label = details.querySelector(".thinking-label")!;
					label.textContent = live ? "Thinking" : "Thought";
					label.classList.toggle("shimmer", live);
					details.classList.toggle("live", live);
					if (slot.key !== block.thinking) {
						slot.key = block.thinking;
						// Models end thinking with blank lines; under `pre-wrap` they would stretch the block (and its rule) past the text.
						details.querySelector(".thinking-body")!.textContent = block.thinking.trim();
					}
					details.hidden = !streaming && block.thinking.trim() === "";
					break;
				}
				case "toolCall": {
					const card = this.card(block.id || `${this.key}:${index}`);
					card.setCall(block.name, block.arguments ?? {}, block.intent);
					if (slot.el !== card.element) {
						slot.el.replaceWith(card.element);
						slot.el = card.element;
					}
					break;
				}
				case "image":
					if (slot.key === "") {
						slot.key = "image";
						slot.el.append(thumbnail(block));
					}
					break;
			}
		}
		this.#truncate(content.length);

		this.#footer.replaceChildren();
		if (message.stopReason === "error") {
			this.#footer.append(h("div", { className: "error-block" }, message.errorMessage || "The request failed."));
		} else if (message.stopReason === "aborted") {
			this.#footer.append(h("div", { className: "note" }, "Interrupted"));
		}
	}

	#createSlot(type: string): Slot {
		switch (type) {
			case "text":
				return { type, el: h("div", { className: "markdown" }), key: "\u0000" };
			case "thinking": {
				const details = h(
					"details",
					{ className: "thinking" },
					h(
						"summary",
						null,
						h("span", { className: "thinking-chevron" }, icon("chevronRight")),
						h("span", { className: "thinking-label" }, "Thinking"),
					),
					h("div", { className: "thinking-body" }),
				);
				// Open only when the brain toggle is on, live or not; the shimmering
				// "Thinking" summary already shows the agent is reasoning.
				details.open = this.thinkingExpanded();
				return { type, el: details, key: "\u0000" };
			}
			case "image":
				return { type, el: h("div", { className: "thumbs" }), key: "" };
			default:
				// toolCall gets its card on first update; other block kinds are not displayed.
				return { type, el: h("span", { hidden: true }), key: "" };
		}
	}

	#truncate(length: number): void {
		for (const slot of this.#slots.splice(length)) slot.el.remove();
	}
}

export class Transcript {
	readonly element: HTMLElement;
	#scroller = h("div", { className: "transcript" });
	#list = h("div", { className: "messages" });
	#spinner = brailleSpinner();
	#elapsed = h("span", { className: "working-time" }, "0s");
	#busySince = 0;
	#thinkingExpanded = false;
	#working = h(
		"div",
		{ className: "working", hidden: true },
		this.#spinner.element,
		h("span", { className: "working-label shimmer" }, "Working"),
		this.#elapsed,
	);
	#empty: HTMLElement;
	/** The empty chat's prompts under the logo. */
	readonly examples: ExamplePrompts;
	#brand = h("div", { className: "empty-brand", role: "img", ariaLabel: "MarIA Code · Unicaja" });
	#emptyTitle = h("div", { className: "empty-title" }, "¿Qué construimos hoy con MarIA Code?");
	#emptyHint = h(
		"div",
		{ className: "empty-hint" },
		"Escribe / para comandos y skills · Shift+Enter para nueva línea",
	);
	/** Where the chat works (this project, or no workspace), under the title; hidden until the first `state`. */
	#place = h("div", { className: "empty-place", hidden: true });
	#farewellPlaying = false;
	#pill = h(
		"button",
		{
			type: "button",
			className: "new-messages",
			hidden: true,
			ariaLabel: "New messages",
			dataset: { tooltip: "New messages" },
		},
		icon("arrowUp"),
	);
	#tools = new Map<string, ToolCard>();
	#planCards = new Map<string, PlanCard>();
	#live = new Map<string, AssistantView | HTMLElement>();
	#pendingUpdates = new Map<string, AssistantMessage>();
	#frame = 0;
	#pinned = true;
	#anonymousKey = "";
	#anonymousCount = 0;
	#retryNote: HTMLElement | undefined;
	#compactionNote: HTMLElement | undefined;
	/** Editable prompts (`isUserPrompt`): each bubble knows its ordinal; counted like the host's `#findPrompt`. */
	#promptCount = 0;
	#editor: MessageEditor | undefined;
	/** Prompt bubbles in document order, for the pinned prompt. */
	#prompts: PromptMark[] = [];
	/** The editable prompts in order (oldest first), for the composer's ↑/↓ recall. */
	#recall: PromptRecall[] = [];
	/** The latest prompt scrolled out at the top, pinned above the conversation. */
	#pinnedPrompt = h("button", { type: "button", className: "pinned-prompt", hidden: true });
	/** Lays the pinned prompt out like the messages column, so it sits where its bubble does. */
	#pinnedRow = h(
		"div",
		{ className: "pinned-prompt-row" },
		h("div", { className: "pinned-prompt-lane" }, this.#pinnedPrompt),
	);
	#pinnedMark: PromptMark | undefined;
	#layoutFrame = 0;
	#timelineStale = false;

	/** The conversation's messages, which find-in-chat searches. */
	get searchRoot(): HTMLElement {
		return this.#list;
	}

	/** The scrolling container of the conversation. */
	get scrollElement(): HTMLElement {
		return this.#scroller;
	}

	constructor(
		private readonly post: Post,
		onExample: (prompt: string) => void,
		/** "Reply" on text selected in an answer. */
		onReply: (text: string) => void,
		/** Asks for the feedback when a plan card's "Refine plan" is clicked. */
		private readonly planFeedback: PlanFeedbackDialog,
	) {
		this.examples = new ExamplePrompts(post, onExample);
		this.#empty = h(
			"div",
			{ className: "empty" },
			this.#brand,
			this.#emptyTitle,
			this.#place,
			this.#emptyHint,
			this.examples.element,
		);
		preloadFarewell();
		this.#scroller.append(this.#empty, this.#list, this.#working);
		this.element = h("div", { className: "transcript-wrap" }, this.#scroller, this.#pinnedRow, this.#pill);
		this.element.append(new SelectionReply(this.#scroller, this.element, onReply).element);
		this.#pinnedPrompt.addEventListener("click", () => {
			const mark = this.#pinnedMark;
			if (!mark?.el.isConnected) return;
			// Land the bubble where the pinned box sits: it shows in full, unpins, and pushes the previous prompt's box out.
			const offset = mark.el.getBoundingClientRect().top - this.#scroller.getBoundingClientRect().top;
			this.#scroller.scrollTop += offset - this.#pinnedPrompt.offsetTop;
		});

		this.#scroller.addEventListener("scroll", () => {
			const distance = this.#scroller.scrollHeight - this.#scroller.scrollTop - this.#scroller.clientHeight;
			this.#pinned = distance < PIN_THRESHOLD_PX;
			if (this.#pinned) this.#pill.hidden = true;
			this.#scheduleLayout(false);
		});
		this.#pill.addEventListener("click", () => {
			this.#pinned = true;
			this.#afterChange();
		});
		this.#scroller.addEventListener("click", event => this.#onClick(event));
		this.#scroller.addEventListener("keydown", event => {
			const target = event.target as HTMLElement;
			if (event.key === "Enter" && target.matches("[data-file], [data-href], img.thumb")) {
				event.preventDefault();
				target.click();
			}
		});
		this.#afterChange();
	}

	/** The prompts sent in the shown chat, oldest first. */
	recentPrompts(): readonly PromptRecall[] {
		return this.#recall;
	}

	/** The first prompt of an empty chat: the logo says goodbye (landing on `mark`) while the conversation appears. */
	farewell(mark: HTMLElement): void {
		if (this.#empty.hidden || this.#farewellPlaying) return;
		this.#farewellPlaying = true;
		playFarewell({
			brand: this.#brand,
			empty: this.#empty,
			captions: [this.#emptyTitle, this.#place, this.#emptyHint, this.examples.element],
			conversation: [this.#list, this.#working],
			mark,
			onDone: () => {
				this.#farewellPlaying = false;
			},
		});
	}

	/** The host did not resend an edited prompt: its editor becomes editable again. */
	editAborted(): void {
		this.#editor?.reopen();
	}

	/**
	 * Edit the prompt `ordinal` in place; sending asks the host to rewind to it and
	 * resend. `original` is its text as sent; a reply to an excerpt (`quote`) edits
	 * only the message and resends it replying to the same excerpt.
	 */
	#editPrompt(element: HTMLElement, ordinal: number, original: string, quote: QuotedPrompt | undefined): void {
		this.#editor?.close();
		const editor = new MessageEditor(
			element,
			quote?.message ?? original,
			edited => {
				this.post({
					type: "editMessage",
					fromEnd: this.#promptCount - 1 - ordinal,
					original,
					text: quote ? quotedPrompt(quote.selection, edited) : edited,
				});
			},
			() => {
				if (this.#editor === editor) this.#editor = undefined;
			},
		);
		this.#editor = editor;
	}

	/** Rebuild the transcript; `commandOutputs` (oldest first) go where they appeared, by timestamp. */
	setHistory(messages: AgentMessage[], commandOutputs: readonly CommandOutput[] = []): void {
		cancelAnimationFrame(this.#frame);
		this.#frame = 0;
		this.#pendingUpdates.clear();
		this.#live.clear();
		this.#tools.clear();
		this.#retryNote = undefined;
		this.#compactionNote = undefined;
		this.#editor = undefined;
		this.#promptCount = 0;
		this.#prompts = [];
		this.#recall = [];
		this.#list.replaceChildren();
		// A turn starts at a prompt that is not steering an unfinished turn (the last answer did not
		// stop for tool calls) and ends at its last answer; finished turns get their "Worked for" line.
		let turnStart: number | undefined;
		let turnEnd: number | undefined;
		let lastStop: string | undefined;
		const closeTurn = () => {
			if (turnStart !== undefined && turnEnd !== undefined && lastStop !== "toolUse") {
				this.#list.append(turnFooter(turnEnd - turnStart));
			}
			turnStart = turnEnd = undefined;
		};
		let nextOutput = 0;
		/** Show every command output printed before `timestamp`. */
		const outputsBefore = (timestamp: number) => {
			while (nextOutput < commandOutputs.length && commandOutputs[nextOutput].timestamp < timestamp) {
				this.#list.append(commandOutputElement(commandOutputs[nextOutput].text));
				nextOutput++;
			}
		};
		for (const message of messages) {
			if (isPrompt(message) && lastStop !== "toolUse") {
				closeTurn();
				turnStart = message.timestamp;
			}
			outputsBefore(message.timestamp);
			if (message.role === "assistant") {
				const view = new AssistantView(
					`h${this.#list.childElementCount}`,
					id => this.#card(id),
					() => this.#thinkingExpanded,
				);
				view.update(message, false);
				this.#list.append(view.element);
				turnEnd = message.completedAt ?? message.timestamp + (message.duration ?? 0);
				lastStop = message.stopReason;
			} else {
				this.#appendStatic(message);
			}
		}
		closeTurn();
		outputsBefore(Number.POSITIVE_INFINITY);
		for (const card of this.#tools.values()) if (card.status === "pending") card.setStatus("none");
		this.#pinned = true;
		this.#afterChange();
	}

	/** Chats without a workspace keep no file snapshots: hide "See changes". */
	setChangesAvailable(available: boolean): void {
		this.element.classList.toggle("changes-unavailable", !available);
	}

	/** The empty chat shows where it works: the project (`folder`) or, for `noWorkspace`, its own folder. */
	setPlace(noWorkspace: boolean, folder: string): void {
		const kind = noWorkspace ? "none" : "workspace";
		if (this.#place.dataset.place === kind && this.#place.dataset.folder === folder) return;
		this.#emptyTitle.textContent = noWorkspace
			? "¿En qué te ayudo hoy con MarIA Code?"
			: "¿Qué construimos hoy con MarIA Code?";
		const name = noWorkspace ? "Tareas generales" : folder.split(/[\\/]/).filter(Boolean).pop() || folder;
		const switchTo = h(
			"button",
			{ type: "button", className: "empty-place-switch" },
			icon(noWorkspace ? "plus" : "plusGlobe"),
			noWorkspace ? "Nuevo chat en el proyecto" : "Nuevo chat sin workspace",
		);
		switchTo.addEventListener("click", () =>
			this.post(noWorkspace ? { type: "newSession" } : { type: "newSession", noWorkspace: true }),
		);
		this.#place.dataset.place = kind;
		this.#place.dataset.folder = folder;
		this.#place.replaceChildren(
			h("span", { className: "empty-place-icon" }, icon(noWorkspace ? "globe" : "folder")),
			h(
				"div",
				{ className: "empty-place-body" },
				h("div", { className: "empty-place-kind" }, noWorkspace ? "Sin workspace" : "Workspace"),
				h("div", { className: "empty-place-name" }, name),
				h(
					"div",
					{ className: "empty-place-desc" },
					noWorkspace
						? "Fuera de cualquier proyecto, en su propia carpeta"
						: "Lee y edita el código de este proyecto",
				),
				h("div", { className: "empty-place-path", dataset: { tooltip: folder } }, folder),
				switchTo,
			),
		);
		this.#place.hidden = false;
	}

	/** Open or fold every thinking block; blocks rendered later follow the same state. */
	setThinkingExpanded(expanded: boolean): void {
		this.#thinkingExpanded = expanded;
		for (const details of this.#list.querySelectorAll<HTMLDetailsElement>("details.thinking")) {
			details.open = expanded;
		}
		this.#afterChange();
	}

	/** Show or hide the working row; `since` is when the turn started, so its timer reads the turn's own age. */
	setBusy(busy: boolean, since = Date.now()): void {
		this.#working.hidden = !busy;
		if (busy) {
			this.#busySince = since;
			this.#elapsed.textContent = formatElapsed(Date.now() - since);
			this.#spinner.start(() => {
				this.#elapsed.textContent = formatElapsed(Date.now() - this.#busySince);
			});
		} else {
			this.#spinner.stop();
			this.#flush();
		}
		this.#afterChange();
	}

	/** Show the plan omp asks to approve; a card already shown for `review.id` is replaced. */
	showPlanReview(review: Extract<ChatUpdate, { type: "planReview" }>): void {
		const card = new PlanCard(review, this.post, this.planFeedback);
		const previous = this.#planCards.get(review.id);
		if (previous?.element.isConnected) previous.element.replaceWith(card.element);
		else this.#list.append(card.element);
		this.#planCards.set(review.id, card);
		// The decision is the next thing the user must do: bring it into view.
		this.#pinned = true;
		this.#afterChange();
	}

	closePlanReview(id: string): void {
		this.#planCards.get(id)?.close();
		this.#planCards.delete(id);
	}

	appendCommandOutput(text: string): void {
		this.#list.append(commandOutputElement(text));
		this.#afterChange();
	}

	handleEvent(event: LiveEvent): void {
		switch (event.type) {
			case "message_start": {
				const key = event.messageId ?? this.#nextAnonymousKey();
				this.#upsert(key, event.message, true);
				break;
			}
			case "message_update": {
				const key = event.messageId ?? this.#anonymousKey;
				if (event.message.role !== "assistant") break;
				this.#pendingUpdates.set(key, event.message);
				this.#frame ||= requestAnimationFrame(() => this.#flush());
				return;
			}
			case "message_end": {
				const key = event.messageId ?? this.#anonymousKey;
				this.#pendingUpdates.delete(key);
				this.#upsert(key, event.message, false);
				this.#live.delete(key);
				break;
			}
			case "tool_execution_start": {
				const card = this.#card(event.toolCallId);
				if (event.args && typeof event.args === "object") {
					card.setCall(event.toolName, event.args as Record<string, unknown>, event.intent);
				}
				card.setStatus("running");
				this.#adoptOrphan(card, event.toolName);
				break;
			}
			case "tool_execution_update": {
				const card = this.#card(event.toolCallId);
				card.setResult(event.partialResult);
				card.setStatus("running");
				this.#adoptOrphan(card, event.toolName);
				break;
			}
			case "tool_execution_end": {
				const card = this.#card(event.toolCallId);
				card.setResult(event.result);
				card.setStatus(event.isError ? "error" : "done");
				this.#adoptOrphan(card, event.toolName);
				break;
			}
			case "agent_end":
				this.#flush();
				for (const card of this.#tools.values()) {
					if (card.status === "pending" || card.status === "running") card.setStatus("interrupted");
				}
				if (!this.#working.hidden) this.#list.append(turnFooter(Date.now() - this.#busySince));
				break;
			case "auto_retry_start":
				this.#retryNote = this.#note(
					this.#retryNote,
					`Retrying (attempt ${event.attempt}/${event.maxAttempts})… ${event.errorMessage}`,
				);
				break;
			case "auto_retry_end":
				if (event.success) this.#retryNote?.remove();
				else this.#note(this.#retryNote, `Retry failed: ${event.finalError ?? "unknown error"}`);
				this.#retryNote = undefined;
				break;
			case "auto_compaction_start":
				this.#compactionNote = this.#note(this.#compactionNote, "Compacting context…");
				break;
			case "auto_compaction_end":
				if (event.skipped) this.#compactionNote?.remove();
				else if (event.aborted) this.#note(this.#compactionNote, "Compaction aborted");
				else if (event.errorMessage) this.#note(this.#compactionNote, `Compaction failed: ${event.errorMessage}`);
				else this.#note(this.#compactionNote, "Context compacted");
				this.#compactionNote = undefined;
				break;
			case "irc_message":
				this.#appendStatic(event.message);
				break;
			default:
				return;
		}
		this.#afterChange();
	}

	#nextAnonymousKey(): string {
		this.#anonymousKey = `anon${++this.#anonymousCount}`;
		return this.#anonymousKey;
	}

	#card(id: string): ToolCard {
		let card = this.#tools.get(id);
		if (!card) {
			card = new ToolCard(undefined, id);
			this.#tools.set(id, card);
		}
		return card;
	}

	/** A result whose call was never rendered (e.g. history trimmed by compaction) still gets a card. */
	#adoptOrphan(card: ToolCard, toolName: string): void {
		if (card.element.isConnected) return;
		card.setCall(toolName, {});
		this.#list.append(card.element);
	}

	#upsert(key: string, message: AgentMessage, streaming: boolean): void {
		if (message.role === "assistant") {
			let view = this.#live.get(key);
			if (!(view instanceof AssistantView)) {
				view = new AssistantView(
					key,
					id => this.#card(id),
					() => this.#thinkingExpanded,
				);
				this.#live.set(key, view);
				this.#list.append(view.element);
			}
			view.update(message, streaming);
			return;
		}
		if (message.role === "toolResult") {
			this.#applyToolResult(message);
			return;
		}
		if (this.#live.has(key)) return;
		const el = this.#appendStatic(message);
		if (el) this.#live.set(key, el);
	}

	#flush(): void {
		cancelAnimationFrame(this.#frame);
		this.#frame = 0;
		if (this.#pendingUpdates.size === 0) return;
		for (const [key, message] of this.#pendingUpdates) this.#upsert(key, message, true);
		this.#pendingUpdates.clear();
		this.#afterChange();
	}

	#applyToolResult(message: ToolResultMessage): void {
		const card = this.#card(message.toolCallId);
		card.setResult({ content: message.content, details: message.details });
		card.setStatus(message.isError ? "error" : "done");
		this.#adoptOrphan(card, message.toolName);
	}

	/** Render a non-assistant message; returns the appended element (if any). */
	#appendStatic(message: AgentMessage): HTMLElement | undefined {
		let el: HTMLElement | undefined;
		switch (message.role) {
			case "user": {
				if (message.synthetic) return undefined;
				const ordinal = this.#promptCount++;
				const raw = contentText(message.content);
				const quoted = parseQuotedPrompt(raw);
				const text = quoted?.message ?? raw;
				const images = contentImages(message.content);
				const prompt = bubble(
					text,
					images,
					() => this.#editPrompt(prompt, ordinal, raw, quoted),
					quoted?.selection,
				);
				this.#prompts.push({ el: prompt, text });
				this.#recall.push({ text, quote: quoted?.selection, images });
				el = prompt;
				break;
			}
			case "custom":
			case "hookMessage":
				// Hidden messages reached the model but not the TUI (harness reminders such as
				// `scope-checkpoint`, todo nudges, rule injections): show them muted and folded.
				if (!message.display) {
					el = hiddenNoticeElement(message.customType, contentText(message.content));
					break;
				}
				// Only a skill invocation is something the user wrote; the rest (background job results,
				// process exits, extension notices) comes from omp and must not look like a prompt.
				if (
					message.role === "custom" &&
					message.customType === "skill-prompt" &&
					isSkillPromptDetails(message.details)
				) {
					const details = message.details;
					const draft = skillPromptDraft(details);
					const quoted = parseQuotedPrompt(draft);
					const ordinal = isUserPrompt(message) ? this.#promptCount++ : undefined;
					const skill: HTMLElement = skillBubble(
						details,
						contentText(message.content),
						quoted,
						ordinal === undefined ? undefined : () => this.#editPrompt(skill, ordinal, draft, quoted),
					);
					el = skill;
					const text = quoted?.message ?? draft;
					this.#prompts.push({ el, text });
					if (ordinal !== undefined) this.#recall.push({ text, quote: quoted?.selection, images: [] });
				} else if (
					message.role === "custom" &&
					message.customType === "skill-update" &&
					isSkillUpdateDetails(message.details)
				) {
					const details = message.details;
					el = skillUpdateElement(details, () => this.post({ type: "revertSkillUpdate", id: details.id }));
				} else {
					el = noticeElement(message.customType, contentText(message.content), message.details);
				}
				break;
			case "toolResult":
				this.#applyToolResult(message);
				return undefined;
			case "bashExecution":
			case "pythonExecution": {
				const card = new ToolCard("you");
				const isBash = message.role === "bashExecution";
				card.setCall(isBash ? "bash" : "python", isBash ? { command: message.command } : { code: message.code });
				let output = message.output;
				if (message.truncated) output += "\n[output truncated]";
				if (message.cancelled) output += "\n[cancelled]";
				card.setResult(output);
				card.setStatus(
					message.cancelled
						? "interrupted"
						: message.exitCode !== undefined && message.exitCode !== 0
							? "error"
							: "done",
				);
				el = h("div", { className: "msg" }, card.element);
				break;
			}
			case "compactionSummary":
				el = summaryDivider("Context compacted", message.summary);
				break;
			case "branchSummary":
				el = summaryDivider("Branch summary", message.summary);
				break;
			case "fileMention":
				el = h("div", { className: "msg note" }, "Attached ");
				message.files.forEach((file, index) => {
					if (index > 0) el!.append(", ");
					el!.append(fileLink(file.path));
				});
				break;
			default:
				// developer messages and assistant (handled by AssistantView) are not rendered here.
				return undefined;
		}
		this.#list.append(el);
		return el;
	}

	/** Create or rewrite a muted inline note at the end of the transcript. */
	#note(existing: HTMLElement | undefined, text: string): HTMLElement {
		const el = existing ?? h("div", { className: "msg note" });
		el.textContent = text;
		if (!el.isConnected) this.#list.append(el);
		return el;
	}

	#afterChange(): void {
		this.#empty.hidden = this.#list.childElementCount > 0 || !this.#working.hidden;
		if (this.#pinned) {
			this.#scroller.scrollTop = this.#scroller.scrollHeight;
			this.#pill.hidden = true;
		} else {
			this.#pill.hidden = false;
		}
		this.#scheduleLayout(true);
	}

	/** Redraw the timeline (after content changed) and the pinned prompt on the next frame. */
	#scheduleLayout(content: boolean): void {
		this.#timelineStale ||= content;
		this.#layoutFrame ||= requestAnimationFrame(() => {
			this.#layoutFrame = 0;
			if (this.#timelineStale) {
				this.#timelineStale = false;
				this.#layoutTimeline();
			}
			this.#layoutPinnedPrompt();
		});
	}

	/**
	 * Mark each turn's steps (thinking, tool rows, answers) as dots on a vertical
	 * rail, like Claude Code: consecutive steps are joined by a line, and anything
	 * else in the conversation (a prompt, a notice, "Worked for") ends the run.
	 * Each link reaches down to the next step's dot, measured across the gap.
	 */
	#layoutTimeline(): void {
		let previous: HTMLElement | undefined;
		const link = (next: HTMLElement | undefined) => {
			if (!previous) return;
			const gap = next ? Math.round(next.getBoundingClientRect().top - previous.getBoundingClientRect().bottom) : -1;
			previous.classList.toggle("step-link", gap >= 0);
			if (gap >= 0 && previous.style.getPropertyValue("--step-gap") !== `${gap}px`) {
				previous.style.setProperty("--step-gap", `${gap}px`);
			}
		};
		for (const child of this.#list.children) {
			const steps = child.classList.contains("assistant")
				? Array.from(child.children).filter(isStep)
				: child.matches("details.activity")
					? [child as HTMLElement]
					: undefined;
			if (!steps) {
				link(undefined);
				previous = undefined;
				continue;
			}
			for (const step of steps) {
				step.classList.add("step");
				link(step);
				previous = step;
			}
		}
		link(undefined);
	}

	/**
	 * Pin the prompt of the turn in view above the conversation once its bubble
	 * scrolls out at the top: at the bottom of the chat that is the latest prompt.
	 */
	#layoutPinnedPrompt(): void {
		const top = this.#scroller.getBoundingClientRect().top;
		// Prompts are in document order: find the last one whose bubble is wholly above the view, so the box
		// never shows a prompt over its own bubble.
		let low = 0;
		let high = this.#prompts.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if (this.#prompts[middle]!.el.getBoundingClientRect().bottom <= top) low = middle + 1;
			else high = middle;
		}
		const mark = low > 0 ? this.#prompts[low - 1] : undefined;
		if (mark !== this.#pinnedMark) {
			this.#pinnedMark = mark;
			this.#pinnedPrompt.textContent = mark?.text.trim() ?? "";
			setTooltip(this.#pinnedPrompt, mark && "Scroll to this prompt");
		}
		this.#pinnedPrompt.hidden = !mark;
		if (!mark) return;
		// The messages column centers within the scroller minus its scrollbar; the row must too.
		this.#pinnedRow.style.right = `${this.#scroller.offsetWidth - this.#scroller.clientWidth}px`;
		// The next prompt never slides under the box: reaching it, it pushes the box up out of the row.
		const next = this.#prompts[low];
		const gap = this.#pinnedPrompt.offsetTop;
		const room = next ? next.el.getBoundingClientRect().top - top - gap : Infinity;
		const push = Math.min(0, room - (gap + this.#pinnedPrompt.offsetHeight));
		this.#pinnedPrompt.style.transform = push < 0 ? `translateY(${push}px)` : "";
	}

	#onClick(event: MouseEvent): void {
		const target = event.target as Element;
		const thumb = target.closest<HTMLImageElement>("img.thumb");
		if (thumb) {
			// In a tool card's summary row the click would also toggle the card.
			event.preventDefault();
			openLightbox(thumb.src);
			return;
		}
		const copy = target.closest<HTMLButtonElement>(".copy-btn");
		if (copy) {
			const code = copy.closest(".code-block")?.querySelector("code")?.textContent ?? "";
			void navigator.clipboard.writeText(code).then(() => {
				copy.classList.add("copied");
				setTimeout(() => copy.classList.remove("copied"), 1200);
			});
			return;
		}
		const changes = target.closest<HTMLElement>("[data-tool-changes]");
		if (changes) {
			// In a tool card's summary row the click would also toggle the card.
			event.preventDefault();
			this.post({ type: "showToolChanges", toolCallId: changes.dataset.toolChanges!, path: changes.dataset.path! });
			return;
		}
		const file = target.closest<HTMLElement>("[data-file]");
		if (file) {
			event.preventDefault();
			this.post({ type: "openFile", ...parseFileRef(file.dataset.file!) });
			return;
		}
		const link = target.closest<HTMLElement>("[data-href]");
		if (link) {
			event.preventDefault();
			const href = link.dataset.href!;
			if (/^https?:\/\//i.test(href)) this.post({ type: "openExternal", url: href });
			else if (!/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("file:") || href.startsWith("local://")) {
				if (!href.startsWith("#")) this.post({ type: "openFile", ...parseFileRef(href) });
			}
		}
	}
}
