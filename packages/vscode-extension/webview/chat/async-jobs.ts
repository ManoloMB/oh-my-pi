/**
 * Background tasks button in the composer, shown while the chat has background
 * jobs (bash commands, subagent tasks or eval cells omp left running instead
 * of waiting for them). A badge counts the running ones; the popup lists every
 * job with what it does, its status, how long it has run and, unfolded, its
 * output tail, and cancels a running one. The host re-sends the list
 * (`asyncJobs`) as it changes.
 */
import type { AsyncJob, AsyncJobStatus, AsyncJobType, ChatRequest } from "../../src/protocol";
import { button, h } from "../dom";
import { icon } from "../icons";
import { setTooltip } from "../tooltip";
import { formatDuration } from "./subagent-format";

type Post = (request: ChatRequest) => void;

const STATUS_LABELS: Record<AsyncJobStatus, string> = {
	running: "Running",
	completed: "Done",
	failed: "Failed",
	cancelled: "Cancelled",
};

const TYPE_LABELS: Record<AsyncJobType, string> = {
	bash: "Bash",
	task: "Task",
	eval: "Eval",
};

/** Pixels from the bottom within which an output tail counts as followed (it stays pinned to new output). */
const FOLLOW_SLACK_PX = 8;

export class AsyncJobsPanel {
	readonly element: HTMLElement;
	#trigger: HTMLButtonElement;
	#badge = h("span", { className: "async-jobs-badge", hidden: true });
	#popover = h("div", {
		className: "async-jobs-popover",
		role: "dialog",
		ariaLabel: "Background tasks",
		hidden: true,
	});
	#summary = h("span", { className: "async-jobs-summary" });
	#list = h("div", { className: "async-jobs-list", role: "list" });
	#jobs: AsyncJob[] = [];
	/** Jobs whose output tail is unfolded. */
	readonly #expanded = new Set<string>();
	/** Live run-time labels of running jobs, re-rendered every second while the popup is open. */
	#durations: { job: AsyncJob; label: HTMLElement }[] = [];
	#ticker: number | undefined;

	constructor(private readonly post: Post) {
		this.#trigger = h(
			"button",
			{ type: "button", className: "icon-button async-jobs-toggle", ariaHasPopup: "dialog" },
			icon("layers"),
			this.#badge,
		);
		const title = "Background tasks: commands and subagents MarIA Code left running";
		setTooltip(this.#trigger, title);
		this.#trigger.ariaLabel = title;
		this.#trigger.hidden = true;
		this.#trigger.addEventListener("click", () => (this.#popover.hidden ? this.#open() : this.#close()));

		const close = button("×", "notice-close", () => this.#close());
		setTooltip(close, "Close");
		this.#popover.append(
			h(
				"div",
				{ className: "async-jobs-header" },
				h("span", { className: "async-jobs-title" }, "Background tasks"),
				this.#summary,
				close,
			),
			this.#list,
			h(
				"p",
				{ className: "async-jobs-note" },
				"MarIA Code gets each result automatically when the task ends. Finished tasks stay listed until your next request.",
			),
		);
		this.element = h("div", { className: "async-jobs" }, this.#trigger, this.#popover);
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

	/** The host's `asyncJobs`: the button shows while there is any job; the open popup re-renders. */
	setJobs(jobs: AsyncJob[]): void {
		this.#jobs = jobs;
		const running = jobs.filter(job => job.status === "running").length;
		this.#trigger.hidden = jobs.length === 0;
		this.#trigger.classList.toggle("running", running > 0);
		this.#badge.hidden = running === 0;
		this.#badge.textContent = String(running);
		for (const id of this.#expanded) if (!jobs.some(job => job.id === id)) this.#expanded.delete(id);
		if (jobs.length === 0) this.#close();
		else if (!this.#popover.hidden) this.#render();
	}

	#open(): void {
		this.#popover.hidden = false;
		this.#trigger.ariaExpanded = "true";
		this.#render();
		this.#ticker ??= window.setInterval(() => this.#tick(), 1000);
	}

	#close(): void {
		this.#popover.hidden = true;
		this.#trigger.ariaExpanded = "false";
		window.clearInterval(this.#ticker);
		this.#ticker = undefined;
	}

	#tick(): void {
		const now = Date.now();
		for (const { job, label } of this.#durations) label.textContent = formatDuration(now - job.startTime);
	}

	#render(): void {
		const running = this.#jobs.filter(job => job.status === "running").length;
		const settled = this.#jobs.length - running;
		this.#summary.textContent = [running && `${running} running`, settled && `${settled} finished`]
			.filter(Boolean)
			.join(" · ");
		// Re-rendering replaces the output tails: keep each one where the user left it.
		const scroll = new Map<string, { top: number; followed: boolean }>();
		for (const pre of this.#list.querySelectorAll<HTMLElement>(".async-job-output")) {
			const id = pre.dataset.id;
			if (!id) continue;
			const followed = pre.scrollHeight - pre.scrollTop - pre.clientHeight <= FOLLOW_SLACK_PX;
			scroll.set(id, { top: pre.scrollTop, followed });
		}
		this.#durations = [];
		this.#list.replaceChildren(...this.#jobs.map(job => this.#row(job)));
		for (const pre of this.#list.querySelectorAll<HTMLElement>(".async-job-output")) {
			const previous = pre.dataset.id ? scroll.get(pre.dataset.id) : undefined;
			pre.scrollTop = !previous || previous.followed ? pre.scrollHeight : previous.top;
		}
	}

	#row(job: AsyncJob): HTMLElement {
		const now = Date.now();
		const runMs = (job.endTime ?? now) - job.startTime;
		const duration = h("span", { className: "async-job-duration" }, formatDuration(runMs));
		if (job.status === "running") this.#durations.push({ job, label: duration });
		const expanded = this.#expanded.has(job.id);
		const output = job.output?.trimEnd();

		const meta = h(
			"div",
			{ className: "async-job-meta" },
			h("span", { className: `async-job-status ${job.status}` }, STATUS_LABELS[job.status]),
			h("span", { className: "async-job-type" }, TYPE_LABELS[job.type]),
			h("span", { className: "async-job-id" }, job.id),
			duration,
			job.exitCode !== undefined && job.status !== "running"
				? h("span", { className: "async-job-exit" }, `exit ${job.exitCode}`)
				: null,
		);
		const head = h(
			"button",
			{ type: "button", className: "async-job-head", ariaExpanded: String(expanded) },
			h("span", { className: `async-job-mark ${job.status}` }),
			h("span", { className: "async-job-text" }, h("span", { className: "async-job-label" }, job.label), meta),
			icon(expanded ? "chevronDown" : "chevronRight"),
		);
		if (job.command && job.command !== job.label) setTooltip(head, job.command);
		head.addEventListener("click", () => {
			if (this.#expanded.has(job.id)) this.#expanded.delete(job.id);
			else this.#expanded.add(job.id);
			this.#render();
		});

		const row = h("div", { className: `async-job ${job.status}`, role: "listitem" }, head);
		if (job.status === "running") {
			const cancel = button("Cancel", "async-job-cancel", () => {
				cancel.disabled = true;
				this.post({ type: "cancelAsyncJob", id: job.id });
			});
			setTooltip(cancel, `Stop ${job.id}`);
			row.append(cancel);
		}
		if (expanded) {
			row.append(
				h(
					"div",
					{ className: "async-job-details" },
					job.command ? h("code", { className: "async-job-command" }, job.command) : null,
					job.cwd ? h("span", { className: "async-job-cwd" }, job.cwd) : null,
					h(
						"pre",
						{ className: "async-job-output", dataset: { id: job.id } },
						output || (job.status === "running" ? "No output yet." : "No output."),
					),
				),
			);
		}
		return row;
	}
}
