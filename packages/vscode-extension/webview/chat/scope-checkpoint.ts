/**
 * Scope checkpoint button in the composer, shown while MarIA Code works. It
 * opens a popup with the running request's active time, tool rounds and tool
 * calls, and three checkpoint levels; confirming sends omp a hidden reminder
 * that reaches the model at its next step: Light asks it to hurry without
 * overengineering, Severe presses it to deliver the essentials soon, Hard asks
 * it to make its last tool calls and answer with what it has.
 */
import type { ChatRequest, ScopeCheckpointLevel, ScopeCheckpointStats } from "../../src/protocol";
import { button, h } from "../dom";
import { icon } from "../icons";
import { setTooltip } from "../tooltip";
import { formatDuration } from "./subagent-format";

type Post = (request: ChatRequest) => void;

/** How often the open popup re-reads the stats from omp (tool rounds move only there). */
const REFRESH_MS = 2000;

const LEVELS: { level: ScopeCheckpointLevel; label: string; description: string }[] = [
	{
		level: "light",
		label: "Light",
		description:
			"Asks it to hurry: every step must add something needed, no overengineering or repeated checks. It keeps working.",
	},
	{
		level: "severe",
		label: "Severe",
		description:
			"Presses seriously: only the essentials, delivered in about 3 rounds, naming what it left out. Running subagents wrap up too.",
	},
	{
		level: "hard",
		label: "Hard",
		description:
			"Stop now: last tool calls only to leave nothing half-done, then it answers with what it has. Running subagents wrap up too.",
	},
];

export class ScopeCheckpointPanel {
	readonly element: HTMLElement;
	#trigger: HTMLButtonElement;
	#popover = h("div", {
		className: "scope-checkpoint-popover",
		role: "dialog",
		ariaLabel: "Scope checkpoint",
		hidden: true,
	});
	#time = h("span", { className: "scope-checkpoint-value" });
	#rounds = h("span", { className: "scope-checkpoint-value" });
	#calls = h("span", { className: "scope-checkpoint-value" });
	#status = h("p", { className: "scope-checkpoint-status" });
	#options: HTMLButtonElement[];
	#send: HTMLButtonElement;
	#level: ScopeCheckpointLevel = "light";
	#stats: ScopeCheckpointStats | null | undefined;
	/** When `#stats` arrived: a running request's time keeps counting from there. */
	#statsAt = 0;
	#ticker: number | undefined;
	#refresher: number | undefined;

	constructor(private readonly post: Post) {
		this.#trigger = h(
			"button",
			{ type: "button", className: "icon-button scope-checkpoint-toggle", ariaHasPopup: "dialog" },
			icon("timer"),
		);
		const title = "Scope checkpoint: see how long MarIA Code has been working and ask it to focus or finish";
		setTooltip(this.#trigger, title);
		this.#trigger.ariaLabel = title;
		this.#trigger.hidden = true;
		this.#trigger.addEventListener("click", () => (this.#popover.hidden ? this.#open() : this.#close()));

		this.#options = LEVELS.map(({ level, label, description }) => {
			const option = h(
				"button",
				{ type: "button", className: `scope-checkpoint-option ${level}`, role: "radio", dataset: { level } },
				h("span", { className: "scope-checkpoint-option-label" }, label),
				h("span", { className: "scope-checkpoint-option-desc" }, description),
			);
			option.addEventListener("click", () => {
				this.#level = level;
				this.#render();
			});
			return option;
		});
		const close = button("×", "notice-close", () => this.#close());
		setTooltip(close, "Close");
		this.#send = button("Send checkpoint", "scope-checkpoint-send", () => {
			this.post({ type: "sendScopeCheckpoint", level: this.#level });
			this.#close();
		});

		this.#popover.append(
			h(
				"div",
				{ className: "scope-checkpoint-header" },
				h("span", { className: "scope-checkpoint-title" }, "Scope checkpoint"),
				close,
			),
			h(
				"div",
				{ className: "scope-checkpoint-stats" },
				h("div", { className: "scope-checkpoint-stat" }, h("span", null, "Time working"), this.#time),
				h("div", { className: "scope-checkpoint-stat" }, h("span", null, "Turns"), this.#rounds),
				h("div", { className: "scope-checkpoint-stat" }, h("span", null, "Tool calls"), this.#calls),
			),
			h(
				"p",
				{ className: "scope-checkpoint-note" },
				"Since your latest request, not counting time spent waiting for your answers. A turn is one model step that uses tools; a single turn can run several tools at once.",
			),
			h(
				"div",
				{ className: "scope-checkpoint-options", role: "radiogroup", ariaLabel: "Checkpoint type" },
				...this.#options,
			),
			this.#status,
			h(
				"div",
				{ className: "scope-checkpoint-actions" },
				button("Cancel", "scope-checkpoint-cancel", () => this.#close()),
				this.#send,
			),
		);
		this.element = h("div", { className: "scope-checkpoint" }, this.#trigger, this.#popover);
		this.element.addEventListener("keydown", event => {
			if (event.key === "Escape" && !this.#popover.hidden) {
				event.preventDefault();
				event.stopPropagation();
				this.#close();
				this.#trigger.focus();
			}
		});
		document.addEventListener("mousedown", event => {
			if (!this.#popover.hidden && !this.element.contains(event.target as Node)) this.#close();
		});
	}

	/** The button shows only while MarIA Code works; a finished turn closes the popup. */
	setBusy(busy: boolean): void {
		this.#trigger.hidden = !busy;
		if (!busy) this.#close();
	}

	/** omp's answer to `getScopeCheckpoint`. */
	setStats(stats: ScopeCheckpointStats | null): void {
		if (this.#popover.hidden) return;
		this.#stats = stats;
		this.#statsAt = Date.now();
		this.#render();
	}

	#open(): void {
		this.#level = "light";
		this.#stats = undefined;
		this.#popover.hidden = false;
		this.#trigger.ariaExpanded = "true";
		this.#render();
		this.post({ type: "getScopeCheckpoint" });
		this.#ticker ??= window.setInterval(() => this.#render(), 1000);
		this.#refresher ??= window.setInterval(() => this.post({ type: "getScopeCheckpoint" }), REFRESH_MS);
	}

	#close(): void {
		this.#popover.hidden = true;
		this.#trigger.ariaExpanded = "false";
		window.clearInterval(this.#ticker);
		window.clearInterval(this.#refresher);
		this.#ticker = undefined;
		this.#refresher = undefined;
	}

	#render(): void {
		const stats = this.#stats;
		if (stats) {
			const activeMs = stats.activeMs + (stats.running ? Date.now() - this.#statsAt : 0);
			this.#time.textContent = formatDuration(activeMs);
			this.#rounds.textContent = String(stats.toolRounds);
			this.#calls.textContent = String(stats.toolCalls);
		} else {
			this.#time.textContent = "—";
			this.#rounds.textContent = "—";
			this.#calls.textContent = "—";
		}
		this.#status.textContent =
			stats === undefined
				? "Reading MarIA Code's progress…"
				: stats === null
					? "Could not read MarIA Code's progress."
					: stats.running
						? "MarIA Code gets it as a hidden reminder at its next step; it does not show up as a message from you."
						: "MarIA Code has already finished: there is nothing to check.";
		for (const option of this.#options) {
			option.ariaChecked = String(option.dataset.level === this.#level);
		}
		this.#send.disabled = stats?.running !== true;
	}
}
