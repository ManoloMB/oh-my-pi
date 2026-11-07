/**
 * Session history overlay: a searchable list of chats covering the transcript,
 * filtered by two tabs: the workspace's sessions or the chats without a
 * workspace (it opens on the open chat's group). Chats are grouped under sticky
 * headings (see history-sections.ts): those running, then Today, Yesterday, This
 * week and Older; every section but Running folds, This week and Older start
 * folded, and a search unfolds everything.
 * Each row shows the chat's name, its age and its latest prompt. Opening it asks
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
import { compactAge, FOLDED_BY_DEFAULT, previewOf, SECTIONS, type SectionId, sectionOf } from "./history-sections";
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
			if (active && active.noWorkspace === this.#noWorkspace) {
				// The open chat stays reachable when its section starts folded.
				this.#folded.delete(sectionOf(active, Date.now()));
				this.#selectedPath = active.path;
			}
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
			setTooltip(slot, "Running");
		} else if (item.activity === "done") {
			slot.append(h("span", { className: "history-activity done" }));
			setTooltip(slot, "Finished while you were in another session");
		}
		return slot;
	}

	#render(): void {
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
		// The host lists them newest first: each section keeps that order.
		for (const item of group) {
			const id = sectionOf(item, now);
			const items = bySection.get(id);
			if (items) items.push(item);
			else bySection.set(id, [item]);
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
			for (const item of items) {
				this.#matches.push(item);
				const row = this.#row(item, now, terms, hits?.get(item.path));
				rows.push(row);
				children.push(row);
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
		// Running always shows unfolded: what is working stays in sight.
		if (id === "running" || folded === undefined) {
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

	#row(item: SessionListItem, now: number, terms: readonly string[], hit: SessionSearchHit | undefined): HTMLElement {
		const editing = item.path === this.#editing;
		const label = editing
			? this.#renameInput(item)
			: h("span", { className: "history-label" }, ...highlight(item.label, terms));
		const rename = iconButton("pencil", "Rename", event => {
			event.stopPropagation();
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
		const age = h("span", { className: "history-age" }, compactAge(item.modified, now));
		setTooltip(age, new Date(item.modified).toLocaleString());
		const classes = ["history-row"];
		if (item.active) classes.push("active");
		if (item.activity === "done") classes.push("unread");
		if (editing) classes.push("editing");
		const row = h(
			"div",
			{
				className: classes.join(" "),
				role: "option",
				ariaSelected: "false",
				dataset: { tooltip: item.active ? `Current chat · ${item.path}` : item.path },
			},
			h(
				"div",
				{ className: "history-line" },
				this.#marker(item),
				label,
				editing || item.proposals === 0
					? null
					: h(
							"span",
							{
								className: "history-curation",
								dataset: {
									tooltip: `${item.proposals} skill change${item.proposals === 1 ? "" : "s"} proposed`,
								},
							},
							icon("pencil"),
							String(item.proposals),
						),
				editing ? null : age,
				editing ? null : rename,
				editing ? null : remove,
			),
			editing ? null : this.#preview(item, terms, hit),
		);
		// Keep focus in the search box, except when clicking into the rename field.
		row.addEventListener("mousedown", event => {
			if (!(event.target as Element).closest(".history-rename")) event.preventDefault();
		});
		row.addEventListener("click", () => {
			if (!editing) this.#open(item);
		});
		return row;
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
				else this.close();
				return;
		}
	}
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
