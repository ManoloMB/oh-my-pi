/**
 * The "i" button beside the history's search box: a popup that explains what
 * the search looks through, how it matches, what a result shows, and offers
 * example queries that run when clicked.
 */
import { h } from "../dom";
import { icon } from "../icons";
import { setTooltip } from "../tooltip";

/** Example queries of the popup, each with what it shows off. */
const EXAMPLES: { query: string; what: string }[] = [
	{ query: "ImagePullBackOff", what: "an error a command printed" },
	{ query: "kubectl pagos", what: "two words anywhere in the same chat" },
	{ query: '"connection refused"', what: "an exact phrase" },
	{ query: "migracion", what: "finds “migración” too" },
];

export class SearchHelp {
	readonly element: HTMLElement;
	#trigger: HTMLButtonElement;
	#popover = h("div", { className: "history-help", role: "dialog", ariaLabel: "How search works", hidden: true });

	/** @param onExample an example was clicked: search for `query` */
	constructor(onExample: (query: string) => void) {
		this.#trigger = h(
			"button",
			{
				type: "button",
				className: "icon-button history-help-toggle",
				ariaHasPopup: "dialog",
				ariaLabel: "How search works",
			},
			icon("info"),
		);
		setTooltip(this.#trigger, "How search works");
		// Keep focus in the search box, as the rows do.
		this.#trigger.addEventListener("mousedown", event => event.preventDefault());
		this.#trigger.addEventListener("click", () => (this.isOpen ? this.close() : this.#open()));

		const section = (title: string, ...items: (string | Node)[][]) =>
			h(
				"section",
				{ className: "history-help-section" },
				h("h3", null, title),
				h("ul", null, ...items.map(parts => h("li", null, ...parts))),
			);
		const code = (text: string) => h("code", null, text);
		const examples = EXAMPLES.map(({ query, what }) => {
			const example = h(
				"button",
				{ type: "button", className: "history-help-example" },
				code(query),
				h("span", null, what),
			);
			example.addEventListener("mousedown", event => event.preventDefault());
			example.addEventListener("click", () => {
				this.close();
				onExample(query);
			});
			return example;
		});

		this.#popover.append(
			h("div", { className: "history-help-title" }, "Search finds anything you saw in a chat"),
			section(
				"What it looks through",
				["Chat names, every prompt you sent, and MarIA Code's answers and thinking."],
				[
					"The commands, files and patterns of every tool it ran, and ",
					h("strong", null, "what those tools returned"),
					" (outputs, errors, files it read).",
				],
				["Summaries of compacted conversations."],
			),
			section(
				"How it matches",
				["Case and accents don't matter."],
				["Every word must appear, anywhere in the chat (not necessarily in the same message)."],
				["Put a phrase in quotes to find it as written: ", code('"connection refused"'), "."],
				["A word found in no chat (a typo) matches similar words, shown with a dotted underline."],
			),
			section(
				"Results",
				[
					"Each result says where it matched (",
					code("You"),
					", ",
					code("MarIA Code"),
					", ",
					code("Tool"),
					", ",
					code("Output"),
					"…), with the words around it; ",
					code("+3"),
					" means 3 more places in that chat match.",
				],
				[
					"Opening a result jumps to the match in the conversation. Use ",
					code("↑"),
					" ",
					code("↓"),
					" and ",
					code("Enter"),
					" from the search box.",
				],
				["Covers this workspace's chats and the chats without a workspace (see the tabs)."],
			),
			h("div", { className: "history-help-subtitle" }, "Try"),
			h("div", { className: "history-help-examples" }, ...examples),
		);
		this.element = h("div", { className: "history-help-anchor" }, this.#trigger, this.#popover);
		document.addEventListener("mousedown", event => {
			if (this.isOpen && !this.element.contains(event.target as Node)) this.close();
		});
	}

	get isOpen(): boolean {
		return !this.#popover.hidden;
	}

	close(): void {
		this.#popover.hidden = true;
		this.#trigger.ariaExpanded = "false";
	}

	#open(): void {
		this.#popover.hidden = false;
		this.#trigger.ariaExpanded = "true";
	}
}
