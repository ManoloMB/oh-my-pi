/**
 * Find in the conversation (Ctrl+F, ⌘F on macOS), like a browser's find bar:
 * every match is highlighted, the current one more strongly, with a "3/12"
 * count and Enter / Shift+Enter (or the arrows, F3) to move between them.
 *
 * Matches are painted with the CSS Custom Highlight API, so the transcript's
 * DOM is never touched while it streams; the search reruns when the
 * conversation changes. A match inside a folded block (thinking, a tool row)
 * opens it when it becomes the current one. Text of buttons and other
 * controls is not searched.
 */
import { h, iconButton } from "../dom";

/** Elements whose text is not conversation content. */
const SKIPPED = "button, svg, script, style, textarea, input, .msg-actions, .message-editor, [hidden]";
/** Elements that start a new line: a match never spans two of them. */
const BLOCKS = "p, li, pre, div, td, th, h1, h2, h3, h4, h5, h6, summary, blockquote, details";
const RESEARCH_DELAY_MS = 200;

interface TextPiece {
	node: Text;
	/** Offset of the node's first character in the searched text. */
	start: number;
}

/** Highlight registry of the Custom Highlight API (missing on old engines: no painting then). */
const highlights: Map<string, unknown> | undefined = (globalThis.CSS as { highlights?: Map<string, unknown> })
	?.highlights;
const HighlightClass = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;

export class FindBar {
	readonly element: HTMLElement;
	#input = h("input", { type: "text", className: "find-input", placeholder: "Find", ariaLabel: "Find in chat" });
	#count = h("span", { className: "find-count" });
	#ranges: Range[] = [];
	#current = -1;
	#observer: MutationObserver;
	#timer = 0;
	/** What had focus before the bar opened, to return to on close. */
	#returnFocus: HTMLElement | null = null;
	/** Set by `openWith`: move to the first match as soon as the conversation shows one. */
	#jumpPending = false;

	/**
	 * @param root the conversation to search
	 * @param scroller its scrolling container
	 */
	constructor(
		private readonly root: HTMLElement,
		private readonly scroller: HTMLElement,
	) {
		this.element = h(
			"div",
			{ className: "find-bar", hidden: true, role: "search" },
			this.#input,
			this.#count,
			iconButton("chevronUp", "Previous match (Shift+Enter)", () => this.#step(-1)),
			iconButton("chevronDown", "Next match (Enter)", () => this.#step(1)),
			iconButton("close", "Close (Escape)", () => this.close()),
		);
		this.#input.addEventListener("input", () => this.#search(true));
		this.#input.addEventListener("keydown", event => {
			if (event.isComposing || event.keyCode === 229) return;
			if (event.key === "Enter" || event.key === "F3") {
				event.preventDefault();
				this.#step(event.shiftKey ? -1 : 1);
			} else if (event.key === "Escape") {
				event.preventDefault();
				this.close();
			}
		});
		this.#observer = new MutationObserver(() => {
			window.clearTimeout(this.#timer);
			this.#timer = window.setTimeout(() => this.#search(false), RESEARCH_DELAY_MS);
		});
	}

	get isOpen(): boolean {
		return !this.element.hidden;
	}

	/** Show the bar with its text selected, searching what it holds. */
	open(): void {
		if (!this.isOpen) {
			const active = document.activeElement;
			this.#returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
			this.element.hidden = false;
			this.#observer.observe(this.root, { childList: true, subtree: true, characterData: true });
			this.#search(true);
		}
		this.#input.focus();
		this.#input.select();
	}

	/**
	 * Show the bar searching `text` (a match a history search found in this chat)
	 * and move to its first match, waiting for it while the conversation loads.
	 */
	openWith(text: string): void {
		this.#input.value = text;
		this.#jumpPending = true;
		if (this.isOpen) this.#search(true);
		this.open();
	}

	close(): void {
		if (!this.isOpen) return;
		this.element.hidden = true;
		this.#observer.disconnect();
		this.#jumpPending = false;
		window.clearTimeout(this.#timer);
		this.#ranges = [];
		this.#current = -1;
		this.#paint();
		this.#returnFocus?.focus();
		this.#returnFocus = null;
	}

	/** Next (1) or previous (-1) match, wrapping around (F3 / Shift+F3 outside the input too). */
	step(direction: 1 | -1): void {
		this.#step(direction);
	}

	/**
	 * Find every match of the query. A new query (`jump`) moves to the first
	 * match at or below the top of the view; a rerun after the conversation
	 * changed keeps the current position and does not scroll.
	 */
	#search(jump: boolean): void {
		const query = this.#input.value.toLowerCase();
		this.#ranges = query ? findRanges(this.root, query) : [];
		if (this.#ranges.length === 0) this.#current = -1;
		else if (this.#jumpPending) this.#current = 0;
		else if (jump || this.#current < 0) {
			const top = this.scroller.getBoundingClientRect().top;
			const below = this.#ranges.findIndex(range => range.getBoundingClientRect().bottom >= top);
			this.#current = below < 0 ? 0 : below;
		} else {
			this.#current = Math.min(this.#current, this.#ranges.length - 1);
		}
		this.#paint();
		if ((jump || this.#jumpPending) && this.#current >= 0) {
			this.#jumpPending = false;
			this.#reveal(this.#ranges[this.#current]!);
		}
	}

	#step(direction: 1 | -1): void {
		if (this.#ranges.length === 0) return;
		this.#current = (this.#current + direction + this.#ranges.length) % this.#ranges.length;
		this.#paint();
		this.#reveal(this.#ranges[this.#current]!);
	}

	#paint(): void {
		const total = this.#ranges.length;
		this.#count.textContent = this.#input.value ? (total ? `${this.#current + 1}/${total}` : "No results") : "";
		this.element.classList.toggle("no-results", Boolean(this.#input.value) && total === 0);
		if (!highlights || !HighlightClass) return;
		const current = this.#ranges[this.#current];
		highlights.set("omp-find", new HighlightClass(...this.#ranges.filter(range => range !== current)));
		highlights.set("omp-find-current", new HighlightClass(...(current ? [current] : [])));
	}

	/** Open the folded blocks around a match and scroll it to the middle of the view. */
	#reveal(range: Range): void {
		for (let node: Node | null = range.startContainer; node && node !== this.root; node = node.parentNode) {
			if (node instanceof HTMLDetailsElement && !node.open) node.open = true;
		}
		const rect = range.getBoundingClientRect();
		const view = this.scroller.getBoundingClientRect();
		this.scroller.scrollTop += rect.top - view.top - view.height / 2 + rect.height / 2;
		// Long lines of code scroll sideways inside their block.
		const pre = range.startContainer.parentElement?.closest("pre");
		if (pre && pre.scrollWidth > pre.clientWidth) {
			const box = pre.getBoundingClientRect();
			pre.scrollLeft += range.getBoundingClientRect().left - box.left - box.width / 2;
		}
	}
}

/**
 * Ranges of every case-insensitive occurrence of `query` (already lowercase)
 * in the text of `root`, skipping controls. Text of different blocks is
 * joined with a line break, so a match never spans two paragraphs.
 */
export function findRanges(root: HTMLElement, query: string): Range[] {
	const pieces: TextPiece[] = [];
	let text = "";
	let block: Element | null = null;
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
		acceptNode: node =>
			node instanceof Element
				? node.matches(SKIPPED)
					? NodeFilter.FILTER_REJECT
					: NodeFilter.FILTER_SKIP
				: NodeFilter.FILTER_ACCEPT,
	});
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const value = (node as Text).data;
		if (!value) continue;
		const nodeBlock = node.parentElement?.closest(BLOCKS) ?? null;
		if (nodeBlock !== block) {
			text += "\n";
			block = nodeBlock;
		}
		pieces.push({ node: node as Text, start: text.length });
		const lower = value.toLowerCase();
		// Lowercasing can change the length of a few characters; keep offsets exact then.
		text += lower.length === value.length ? lower : value;
	}
	const ranges: Range[] = [];
	let piece = 0;
	for (let at = text.indexOf(query); at >= 0; at = text.indexOf(query, at + query.length)) {
		const end = at + query.length;
		while (piece + 1 < pieces.length && pieces[piece + 1]!.start <= at) piece++;
		let last = piece;
		while (last + 1 < pieces.length && pieces[last + 1]!.start < end) last++;
		const range = document.createRange();
		range.setStart(pieces[piece]!.node, at - pieces[piece]!.start);
		range.setEnd(pieces[last]!.node, end - pieces[last]!.start);
		ranges.push(range);
	}
	return ranges;
}
