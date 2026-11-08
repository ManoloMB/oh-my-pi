/**
 * Session history overlay: a searchable list of chats covering the transcript,
 * filtered by two tabs: the workspace's sessions or the chats without a
 * workspace (it opens on the open chat's group). Chats are grouped under sticky
 * headings (see history-sections.ts): Today, Yesterday, This week and Older;
 * every section folds, only Today starts unfolded, and a search unfolds
 * everything. Running chats sit first under Today, with a spinning marker.
 * Today's chats show as portrait cards whose info button flips them to more detail; the
 * other sections, and every section while searching, show rows with the chat's
 * name, its age and its latest prompt. Opening it asks
 * the host for `listSessions`; picking a row posts `openSession`, its pencil
 * renames it in place (`renameSession`), its trash deletes it after the host's
 * confirmation (`deleteSession`). Sessions working in the window show a spinner,
 * those that finished unseen a green dot and a bold name, the open one an accent
 * bar, and those with skill proposals a pill counting them while hovered.
 */
import type { ChatRequest, SearchSource, SessionActivity, SessionListItem, SessionSearchHit } from "../../src/protocol";
import { foldText, parseQuery, termRanges } from "../../src/search-text";
import { h, iconButton } from "../dom";
import { icon } from "../icons";
import { setTooltip } from "../tooltip";
import {
	compactAge,
	durationLabel,
	FOLDED_BY_DEFAULT,
	previewOf,
	SECTIONS,
	type SectionId,
	sectionOf,
} from "./history-sections";
import { SearchHelp } from "./history-search-help";

type Post = (request: ChatRequest) => void;

/** Pause in typing before the host searches every message. */
const SEARCH_DELAY_MS = 150;

/** How a search snippet names the kind of text it comes from. */
const SOURCE_LABELS: Record<SearchSource, string> = {
	title: "Title",
	prompt: "You",
	answer: "MarIA Code",
	thinking: "Thinking",
	tool: "Tool",
	output: "Output",
	summary: "Summary",
};

export class HistoryPanel {
	readonly element: HTMLElement;
	#search = h("input", {
		type: "text",
		className: "history-search",
		placeholder: "Search chats",
		ariaLabel: "Search chats",
	});
	#list = h("div", { className: "history-list", role: "listbox" });
	#workspaceTab = h("button", { type: "button", className: "history-tab", role: "tab" });
	#noWorkspaceTab = h("button", { type: "button", className: "history-tab", role: "tab" });
	/** Undefined until the host answers `listSessions`. */
	#sessions: SessionListItem[] | undefined;
	/** The rows shown, in order: what the arrow keys move through. */
	#matches: SessionListItem[] = [];
	#selected = 0;
	/** Path of the selected row, so it stays selected when a chat changes section. */
	#selectedPath: string | undefined;
	/** Path of the row whose name is being edited. */
	#editing: string | undefined;
	/** Path of Today's card turned to its details by its info button (one at a time). */
	#flipped: string | undefined;
	/** The tab shown: chats without a workspace, else the workspace's. */
	#noWorkspace = false;
	/** Whether this opening picked its tab yet (from the first `sessions` answer). */
	#tabPicked = false;
	/** Folded time sections (reset on every opening). */
	#folded = new Set<SectionId>(FOLDED_BY_DEFAULT);
	/** Group of the chat this view shows, from its `state`; the panel opens on it. */
	#chatNoWorkspace: boolean | undefined;
	/** The host's matches through every message, by session file, for `#hitsQuery`. */
	#hits = new Map<string, SessionSearchHit>();
	/** Query `#hits` answers; undefined before the first answer of this opening. */
	#hitsQuery: string | undefined;
	#searchTimer = 0;
	/**
	 * Marks a card's prompt body `clipped` when its whole text does not fit the
	 * room it has; CSS then shows the prompt's start, "…", and its end. Runs again
	 * whenever the room changes (the card growing, widening, its type shrinking).
	 */
	#promptFit = new ResizeObserver(entries => {
		for (const { target } of entries) {
			const head = target.firstElementChild;
			if (!(head instanceof HTMLElement)) continue;
			target.classList.remove("clipped");
			target.classList.toggle("clipped", head.offsetHeight > target.clientHeight + 1);
		}
	});
	/** The "i" beside the search box; its examples search when clicked. */
	#help = new SearchHelp(query => {
		this.#search.value = query;
		this.#search.focus();
		this.#queryChanged();
	});

	/**
	 * @param onFind a row opened from a search: find `text` (a match of it) in that chat once it shows
	 */
	constructor(
		private readonly post: Post,
		private readonly onModeChange: (open: boolean) => void,
		private readonly onFind: (path: string, text: string) => void,
	) {
		const tabs = h(
			"div",
			{ className: "history-tabs", role: "tablist", ariaLabel: "Chats to show" },
			this.#workspaceTab,
			this.#noWorkspaceTab,
		);
		this.element = h(
			"div",
			{ className: "history-panel", hidden: true },
			h("div", { className: "history-search-row" }, this.#search, this.#help.element),
			tabs,
			this.#list,
		);
		this.#search.addEventListener("input", () => this.#queryChanged());
		this.#search.addEventListener("keydown", event => this.#onKeyDown(event));
		for (const [tab, noWorkspace] of [
			[this.#workspaceTab, false],
			[this.#noWorkspaceTab, true],
		] as const) {
			// Keep focus in the search box, as the rows do.
			tab.addEventListener("mousedown", event => event.preventDefault());
			tab.addEventListener("click", () => {
				if (this.#noWorkspace === noWorkspace) return;
				this.#noWorkspace = noWorkspace;
				this.#select(0, undefined);
				this.#render();
			});
		}
	}

	get isOpen(): boolean {
		return !this.element.hidden;
	}

	/** Put the caret in the panel's search box (Ctrl+F while the panel is open). */
	focusSearch(): void {
		this.#search.focus();
		this.#search.select();
	}

	toggle(): void {
		if (this.isOpen) {
			this.close();
			return;
		}
		this.element.hidden = false;
		this.#sessions = undefined;
		this.#tabPicked = false;
		this.#folded = new Set(FOLDED_BY_DEFAULT);
		this.#search.value = "";
		window.clearTimeout(this.#searchTimer);
		this.#hits = new Map();
		this.#hitsQuery = undefined;
		this.#select(0, undefined);
		this.#render();
		this.onModeChange(true);
		this.post({ type: "listSessions" });
		this.#search.focus();
	}

	close(): void {
		if (!this.isOpen) return;
		this.#help.close();
		this.#flipped = undefined;
		this.element.hidden = true;
		this.onModeChange(false);
	}

	/** The chat this view shows runs without a workspace (or in it): the panel opens on that group. */
	setChatNoWorkspace(noWorkspace: boolean): void {
		this.#chatNoWorkspace = noWorkspace;
	}

	setSessions(items: SessionListItem[]): void {
		this.#sessions = items;
		if (!this.#tabPicked) {
			// Open on the open chat's group, even before its session is listed (a new chat has no
			// file yet); without a chat, on the active row's group, else the one that has chats.
			this.#tabPicked = true;
			const active = items.find(item => item.active);
			this.#noWorkspace =
				this.#chatNoWorkspace ??
				(active
					? active.noWorkspace
					: !items.some(item => !item.noWorkspace) && items.some(item => item.noWorkspace));
			// Selected even when its section starts folded: only Today opens unfolded.
			if (active && active.noWorkspace === this.#noWorkspace) this.#selectedPath = active.path;
		}
		this.#render();
	}

	/** Running/finished marks changed somewhere in the window: update the listed rows. */
	setActivity(activity: Record<string, SessionActivity>): void {
		if (!this.#sessions) return;
		for (const item of this.#sessions) item.activity = activity[item.path];
		// Re-rendering would discard a name being typed; the next render shows the marks.
		if (this.isOpen && this.#editing === undefined) this.#render();
	}

	/** Pending skill proposals changed somewhere: update the listed rows' curation pills. */
	setProposalCounts(counts: Record<string, number>): void {
		if (!this.#sessions) return;
		for (const item of this.#sessions) item.proposals = counts[item.path] ?? 0;
		if (this.isOpen && this.#editing === undefined) this.#render();
	}

	/** The host's answer to `searchSessions`; dropped when the box no longer holds that query. */
	setSearchResults(query: string, hits: SessionSearchHit[]): void {
		if (query !== this.#search.value.trim()) return;
		this.#hits = new Map(hits.map(hit => [hit.path, hit]));
		this.#hitsQuery = query;
		// The list just grew with the matches inside messages: start again from the top.
		this.#select(0, undefined);
		if (this.isOpen && this.#editing === undefined) this.#render();
	}

	#select(index: number, path: string | undefined): void {
		this.#selected = index;
		this.#selectedPath = path;
	}

	/** Spinner while the session runs, green dot once it finished unseen; a fixed-width slot so every name lines up. */
	#marker(item: SessionListItem): HTMLElement {
		const slot = h("span", { className: "history-marker" });
		if (item.activity === "running") {
			slot.append(h("span", { className: "history-activity running" }));
			setTooltip(slot, "MarIA Code is working on this session");
		} else if (item.activity === "done") {
			slot.append(h("span", { className: "history-activity done" }));
			setTooltip(slot, "Finished while you were in another session");
		}
		return slot;
	}

	#render(): void {
		// The cards built below replace the observed ones.
		this.#promptFit.disconnect();
		if (this.#sessions === undefined) {
			this.#matches = [];
			this.#renderTabs(undefined);
			this.#list.replaceChildren(h("div", { className: "history-empty" }, "Loading…"));
			return;
		}
		const query = this.#search.value.trim();
		const terms = parseQuery(query);
		const searching = terms.length > 0;
		// The host's hits, once it answered this very query.
		const hits = this.#hitsQuery === query ? this.#hits : undefined;
		// Names and prompts filter at once; the host's search through every message adds its hits.
		const pending = searching && !hits;
		const found = searching
			? this.#sessions.filter(item => {
					if (hits?.has(item.path)) return true;
					const known = foldText(`${item.label}\n${item.firstPrompt ?? ""}\n${item.lastPrompt ?? ""}`);
					return terms.every(term => known.includes(term));
				})
			: this.#sessions;
		this.#renderTabs(found);
		const group = found.filter(item => item.noWorkspace === this.#noWorkspace);
		if (group.length === 0) {
			this.#matches = [];
			const empty = this.#noWorkspace ? "No chats without a workspace yet" : "No chats in this workspace yet";
			const inGroup = this.#sessions.some(item => item.noWorkspace === this.#noWorkspace);
			const message = !inGroup ? empty : pending ? "Searching all messages…" : "No matches";
			this.#list.replaceChildren(h("div", { className: "history-empty" }, message));
			return;
		}
		const now = Date.now();
		const bySection = new Map<SectionId, SessionListItem[]>();
		// The host lists them newest first: each section keeps that order, running chats first.
		for (const item of group) {
			const id = sectionOf(item, now);
			const items = bySection.get(id);
			if (items) items.push(item);
			else bySection.set(id, [item]);
		}
		const today = bySection.get("today");
		if (today) {
			bySection.set("today", [
				...today.filter(item => item.activity === "running"),
				...today.filter(item => item.activity !== "running"),
			]);
		}
		// A search looks through every chat: folded sections show their matches.
		const children: HTMLElement[] = [];
		this.#matches = [];
		const rows: HTMLElement[] = [];
		for (const { id, title } of SECTIONS) {
			const items = bySection.get(id);
			if (!items) continue;
			const folded = !searching && this.#folded.has(id);
			children.push(this.#heading(id, title, items.length, searching ? undefined : folded));
			if (folded) continue;
			// Today's few chats read as cards; a search keeps rows, whose snippets show where it matched.
			const cards = id === "today" && !searching ? h("div", { className: "history-cards" }) : undefined;
			if (cards) children.push(cards);
			for (const item of items) {
				this.#matches.push(item);
				const row = cards ? this.#card(item, now) : this.#row(item, now, terms, hits?.get(item.path));
				rows.push(row);
				if (cards) cards.append(row);
				else children.push(row);
			}
		}
		if (pending) children.push(h("div", { className: "history-empty" }, "Searching all messages…"));
		const kept = this.#matches.findIndex(item => item.path === this.#selectedPath);
		const index = kept >= 0 ? kept : Math.max(0, Math.min(this.#selected, this.#matches.length - 1));
		this.#select(index, this.#matches[index]?.path);
		rows[index]?.setAttribute("aria-selected", "true");
		this.#list.replaceChildren(...children);
		rows[index]?.scrollIntoView({ block: "nearest" });
		this.#list.querySelector<HTMLInputElement>(".history-rename")?.focus();
	}

	/**
	 * Sticky section heading with its count; foldable sections fold and unfold on click
	 * (`folded` is undefined when the section cannot fold, or while searching).
	 */
	#heading(id: SectionId, title: string, count: number, folded: boolean | undefined): HTMLElement {
		const content = [
			h("span", { className: "history-section-title" }, title),
			h("span", { className: "history-section-count" }, String(count)),
		];
		if (folded === undefined) {
			return h("div", { className: `history-section ${id}`, role: "presentation" }, ...content);
		}
		const toggle = h(
			"button",
			{ type: "button", className: `history-section ${id} foldable`, ariaExpanded: String(!folded) },
			icon(folded ? "chevronRight" : "chevronDown"),
			...content,
		);
		// Keep focus in the search box, as the rows do.
		toggle.addEventListener("mousedown", event => event.preventDefault());
		toggle.addEventListener("click", () => {
			if (folded) this.#folded.delete(id);
			else this.#folded.add(id);
			this.#render();
		});
		return toggle;
	}

	/** Tab labels with how many chats of each group match the search (no count while loading). */
	#renderTabs(found: SessionListItem[] | undefined): void {
		for (const [tab, noWorkspace, label] of [
			[this.#workspaceTab, false, "This workspace"],
			[this.#noWorkspaceTab, true, "No workspace"],
		] as const) {
			const count = found?.filter(item => item.noWorkspace === noWorkspace).length;
			tab.replaceChildren(
				label,
				count === undefined ? "" : h("span", { className: "history-tab-count" }, String(count)),
			);
			tab.ariaSelected = String(noWorkspace === this.#noWorkspace);
		}
	}

	/** Rename pencil and delete trash of a chat (row or card). */
	#actions(item: SessionListItem): [HTMLButtonElement, HTMLButtonElement] {
		const rename = iconButton("pencil", "Rename", event => {
			event.stopPropagation();
			// Renaming shows the front, where the name field is.
			this.#flipped = undefined;
			this.#editing = item.path;
			this.#render();
		});
		// The host asks for confirmation, then re-sends the list without it.
		const remove = iconButton("trash", "Delete", event => {
			event.stopPropagation();
			this.post({ type: "deleteSession", path: item.path, label: item.label });
		});
		rename.classList.add("history-row-button");
		remove.classList.add("history-row-button");
		return [rename, remove];
	}

	/** Pill counting the skill proposals this chat's tasks produced; null without any. */
	#curation(item: SessionListItem): HTMLElement | null {
		if (item.proposals === 0) return null;
		return h(
			"span",
			{
				className: "history-curation",
				dataset: { tooltip: `${item.proposals} skill change${item.proposals === 1 ? "" : "s"} proposed` },
			},
			icon("pencil"),
			String(item.proposals),
		);
	}

	/** Row or card classes shared by both shapes: open chat, finished unseen, being renamed. */
	#stateClasses(base: string, item: SessionListItem, editing: boolean): string {
		const classes = [base];
		if (item.active) classes.push("active");
		if (item.activity === "done") classes.push("unread");
		if (editing) classes.push("editing");
		return classes.join(" ");
	}

	/** Clicking opens the chat; focus stays in the search box except inside the rename field. */
	#wireOpen(element: HTMLElement, item: SessionListItem, editing: boolean): void {
		element.addEventListener("mousedown", event => {
			if (!(event.target as Element).closest(".history-rename")) event.preventDefault();
		});
		element.addEventListener("click", () => {
			if (!editing) this.#open(item);
		});
	}

	#row(item: SessionListItem, now: number, terms: readonly string[], hit: SessionSearchHit | undefined): HTMLElement {
		const editing = item.path === this.#editing;
		const label = editing
			? this.#renameInput(item)
			: h("span", { className: "history-label" }, ...highlight(item.label, terms));
		const [rename, remove] = this.#actions(item);
		const age = h("span", { className: "history-age" }, compactAge(item.modified, now));
		setTooltip(age, new Date(item.modified).toLocaleString());
		const row = h(
			"div",
			{
				className: this.#stateClasses("history-row", item, editing),
				role: "option",
				ariaSelected: "false",
				dataset: { tooltip: item.active ? `Current chat · ${item.path}` : item.path },
			},
			h(
				"div",
				{ className: "history-line" },
				this.#marker(item),
				label,
				editing ? null : this.#curation(item),
				editing ? null : age,
				editing ? null : rename,
				editing ? null : remove,
			),
			editing ? null : this.#preview(item, terms, hit),
		);
		this.#wireOpen(row, item, editing);
		return row;
	}

	/**
	 * Today's chat as a portrait card. The front tells chats apart at a glance:
	 * state, age, name and where it was left. Clicking the card opens the chat;
	 * its info button turns it to the back: when it started, how long it ran, its
	 * size, its first and latest prompts, and the rename and delete buttons.
	 * Renaming keeps the front in view.
	 */
	#card(item: SessionListItem, now: number): HTMLElement {
		const editing = item.path === this.#editing;
		const [rename, remove] = this.#actions(item);
		const messages =
			item.messages === undefined
				? undefined
				: `${item.messages}${item.messagesPartial ? "+" : ""} message${item.messages === 1 && !item.messagesPartial ? "" : "s"}`;
		const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
		// The latest prompt is where the chat was left; with a single prompt that is the first one.
		const last = item.lastPromptFull ?? item.lastPrompt ?? item.firstPromptFull ?? item.firstPrompt;
		const front = h(
			"div",
			{ className: "history-card-face history-card-front" },
			h(
				"div",
				{ className: "history-card-top" },
				this.#marker(item),
				h("span", { className: "history-card-age" }, compactAge(item.modified, now)),
				item.active ? h("span", { className: "history-card-badge" }, "Open") : null,
			),
			editing ? this.#renameInput(item) : h("div", { className: "history-card-title" }, item.label),
			last && last !== item.label
				? h(
						"div",
						{ className: "history-card-preview" },
						h("div", { className: "history-card-prompt-label" }, "Last user message"),
						h("div", { className: "history-card-preview-text" }, last),
					)
				: null,
			h(
				"div",
				{ className: "history-card-foot" },
				messages ? h("span", null, messages) : null,
				this.#curation(item),
			),
		);
		const fact = (label: string, value: string) =>
			h("div", { className: "history-card-fact" }, h("dt", null, label), h("dd", null, value));
		// The whole prompt when it fits; otherwise CSS shows its start, "…", and its end (see #promptFit).
		const prompt = (label: string, text: string | undefined) => {
			if (!text) return null;
			const body = h(
				"div",
				{ className: "history-card-prompt-body" },
				h("span", { className: "history-card-prompt-head" }, text),
				h("span", { className: "history-card-prompt-tail" }, h("span", null, text)),
			);
			this.#promptFit.observe(body);
			return h(
				"div",
				{ className: "history-card-prompt" },
				h("div", { className: "history-card-prompt-label" }, label),
				body,
			);
		};
		const back = h(
			"div",
			{ className: "history-card-face history-card-back" },
			h(
				"dl",
				{ className: "history-card-facts" },
				item.created === undefined ? null : fact("Started", time(item.created)),
				fact("Last change", time(item.modified)),
				item.created === undefined ? null : fact("Ran for", durationLabel(item.created, item.modified)),
				messages ? fact("Size", messages) : null,
			),
			prompt("First user message", item.firstPromptFull ?? item.firstPrompt),
			prompt("Last user message", item.lastPromptFull ?? item.lastPrompt),
			h("div", { className: "history-card-actions" }, rename, remove),
		);
		const flipped = !editing && item.path === this.#flipped;
		const info = iconButton(flipped ? "close" : "info", flipped ? "Hide details" : "Show details", event => {
			event.stopPropagation();
			this.#toggleFlip(card, item, info);
		});
		info.classList.add("history-card-info");
		info.ariaPressed = String(flipped);
		const card = h(
			"div",
			{
				className: this.#stateClasses("history-card", item, editing) + (flipped ? " flipped" : ""),
				role: "option",
				ariaSelected: "false",
				ariaLabel: item.label,
				dataset: { tooltip: item.active ? `Current chat · ${item.path}` : item.path },
			},
			h("div", { className: "history-card-inner" }, front, back),
			editing ? null : info,
		);
		this.#wireOpen(card, item, editing);
		// A re-render rebuilds the grid without its widened tracks: widen it again once the card is in place.
		if (flipped) queueMicrotask(() => card.parentElement && widenColumn(card.parentElement, card));
		return card;
	}

	/**
	 * Turn `card` to its details (and any other turned card back), or turn it back.
	 * Toggled on the live elements, not by re-rendering, so the turn animates.
	 */
	#toggleFlip(card: HTMLElement, item: SessionListItem, button: HTMLButtonElement): void {
		const grid = card.parentElement;
		const turning = this.#flipped !== item.path;
		for (const other of grid?.querySelectorAll<HTMLElement>(".history-card.flipped") ?? []) {
			if (other !== card) this.#setFlipped(other, false);
		}
		this.#flipped = turning ? item.path : undefined;
		this.#setFlipped(card, turning, button);
		if (grid) widenColumn(grid, turning ? card : undefined);
	}

	#setFlipped(
		card: HTMLElement,
		flipped: boolean,
		button = card.querySelector<HTMLButtonElement>(".history-card-info"),
	): void {
		card.classList.toggle("flipped", flipped);
		if (!button) return;
		const title = flipped ? "Hide details" : "Show details";
		button.replaceChildren(icon(flipped ? "close" : "info"));
		button.ariaLabel = title;
		button.ariaPressed = String(flipped);
		setTooltip(button, title);
	}

	/** Turn the shown flipped card back (Escape). */
	#unflipShown(): void {
		const card = this.#list.querySelector<HTMLElement>(".history-card.flipped");
		this.#flipped = undefined;
		if (!card) return;
		this.#setFlipped(card, false);
		if (card.parentElement) widenColumn(card.parentElement, undefined);
	}

	/** Inline name editor: Enter renames, Escape or leaving the field cancels. */
	#renameInput(item: SessionListItem): HTMLInputElement {
		const input = h("input", {
			type: "text",
			className: "history-rename",
			value: item.label,
			ariaLabel: "Session name",
		});
		const finish = (save: boolean) => {
			if (this.#editing !== item.path) return;
			this.#editing = undefined;
			const name = input.value.trim();
			if (save && name && name !== item.label) {
				// Shown at once; the host's refreshed list follows.
				item.label = name;
				this.post({ type: "renameSession", path: item.path, name });
			}
			this.#render();
			this.#search.focus();
		};
		input.addEventListener("keydown", event => {
			event.stopPropagation();
			if (event.isComposing) return;
			if (event.key === "Enter") {
				event.preventDefault();
				finish(true);
			} else if (event.key === "Escape") {
				event.preventDefault();
				finish(false);
			}
		});
		input.addEventListener("blur", () => finish(false));
		queueMicrotask(() => input.select());
		return input;
	}

	#open(item: SessionListItem): void {
		const query = this.#search.value.trim();
		const snippet = this.#hitsQuery === query ? this.#hits.get(item.path)?.snippet : undefined;
		this.close();
		this.post({ type: "openSession", path: item.path });
		// Land on the match: titles are not part of the conversation, everything else is.
		const range = snippet?.ranges[0];
		if (snippet && range && snippet.source !== "title")
			this.onFind(item.path, snippet.text.slice(range[0], range[1]));
	}

	/** The search box's text changed: filter at once and ask the host to search every message once typing pauses. */
	#queryChanged(): void {
		this.#select(0, undefined);
		window.clearTimeout(this.#searchTimer);
		const query = this.#search.value.trim();
		if (query) {
			this.#searchTimer = window.setTimeout(() => this.post({ type: "searchSessions", query }), SEARCH_DELAY_MS);
		}
		this.#render();
	}

	/**
	 * Line under the name while searching: where the host found the terms (which
	 * kind of text, the words around them, how many more texts matched), else the
	 * chat's latest prompt with the terms marked.
	 */
	#preview(item: SessionListItem, terms: readonly string[], hit: SessionSearchHit | undefined): HTMLElement | null {
		const snippet = terms.length ? hit?.snippet : undefined;
		if (!snippet || !hit) {
			const preview = previewOf(item);
			return preview ? h("div", { className: "history-preview" }, ...highlight(preview, terms)) : null;
		}
		const more =
			hit.count > 1
				? h(
						"span",
						{
							className: "history-snippet-more",
							dataset: {
								tooltip: `${hit.count - 1} more place${hit.count === 2 ? "" : "s"} in this chat match`,
							},
						},
						`+${hit.count - 1}`,
					)
				: null;
		const line = h(
			"div",
			{ className: `history-preview history-snippet${hit.fuzzy ? " fuzzy" : ""}` },
			h("span", { className: "history-snippet-source" }, SOURCE_LABELS[snippet.source]),
			h("span", { className: "history-snippet-text" }, ...marked(snippet.text, snippet.ranges)),
			more,
		);
		if (hit.fuzzy) setTooltip(line, "No exact match: similar words were found");
		return line;
	}

	#onKeyDown(event: KeyboardEvent): void {
		if (event.isComposing) return;
		switch (event.key) {
			case "ArrowDown":
			case "ArrowUp": {
				event.preventDefault();
				const count = this.#matches.length;
				if (count === 0) return;
				const index = (this.#selected + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
				this.#select(index, this.#matches[index].path);
				this.#render();
				return;
			}
			case "Enter": {
				event.preventDefault();
				const item = this.#matches[this.#selected];
				if (item) this.#open(item);
				return;
			}
			case "Escape":
				event.preventDefault();
				if (this.#help.isOpen) this.#help.close();
				else if (this.#flipped !== undefined) this.#unflipShown();
				else this.close();
				return;
		}
	}
}

/** Share of the row a turned card's column takes, by column count; the other columns split the rest. */
const WIDE_COLUMN_FR: Record<number, number> = { 2: 1.4 };
const WIDE_COLUMN_FR_DEFAULT = 1.6;
/** A little past the CSS transition of `grid-template-columns`, so the equal tracks have settled. */
const UNWIDEN_SETTLE_MS = 950;
/** Pending return of a card grid to its own auto-fill columns. */
const unwidenTimers = new WeakMap<HTMLElement, number>();

/**
 * Widen the column of `card` in Today's card grid and narrow the others, or
 * (`card` undefined) bring them back to equal widths. Grid tracks only animate
 * between lists of the same length, so the auto-fill columns are first spelled
 * out as the explicit equal tracks the width gives, which looks the same; once
 * they are equal again the inline tracks go, so a resize re-flows the columns.
 */
function widenColumn(cards: HTMLElement, card: HTMLElement | undefined): void {
	window.clearTimeout(unwidenTimers.get(cards));
	const count = getComputedStyle(cards).gridTemplateColumns.split(" ").filter(Boolean).length;
	if (count < 2) return;
	const equal = Array.from({ length: count }, () => "minmax(0, 1fr)").join(" ");
	if (!card) {
		if (!cards.style.gridTemplateColumns) return;
		cards.style.gridTemplateColumns = equal;
		unwidenTimers.set(
			cards,
			window.setTimeout(() => cards.style.removeProperty("grid-template-columns"), UNWIDEN_SETTLE_MS),
		);
		return;
	}
	if (!cards.style.gridTemplateColumns) {
		cards.style.gridTemplateColumns = equal;
		// Commit the equal tracks before changing them, so the change animates.
		void cards.offsetWidth;
	}
	const column = Array.prototype.indexOf.call(cards.children, card) % count;
	const wide = WIDE_COLUMN_FR[count] ?? WIDE_COLUMN_FR_DEFAULT;
	const narrow = (count - wide) / (count - 1);
	cards.style.gridTemplateColumns = Array.from(
		{ length: count },
		(_, index) => `minmax(0, ${index === column ? wide : narrow}fr)`,
	).join(" ");
}

/** `text` with the folded occurrences of `terms` (see search-text.ts) wrapped in `<mark>`. */
function highlight(text: string, terms: readonly string[]): (string | HTMLElement)[] {
	return terms.length ? marked(text, termRanges(foldText(text), terms)) : [text];
}

/** `text` with the `[start, end)` ranges (sorted, not overlapping) wrapped in `<mark>`. */
function marked(text: string, ranges: readonly [number, number][]): (string | HTMLElement)[] {
	const parts: (string | HTMLElement)[] = [];
	let from = 0;
	for (const [start, end] of ranges) {
		if (start > from) parts.push(text.slice(from, start));
		parts.push(h("mark", { className: "history-match" }, text.slice(start, end)));
		from = end;
	}
	if (from < text.length) parts.push(text.slice(from));
	return parts;
}
