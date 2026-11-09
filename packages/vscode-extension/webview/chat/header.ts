/**
 * Top bar: π mark, session title (renamable in place), skill self-improvement
 * beside it (a spinner while omp reviews the skills the last task relied on, and
 * a button counting the skill proposals awaiting a decision, which opens them
 * with Approve / Reject), a "No workspace" badge on chats without a workspace,
 * and New chat / New chat without workspace / History / Settings icon buttons.
 * History carries a blinking green badge counting the sessions that finished unseen.
 */
import type {
	ChatRequest,
	SessionActivity,
	SessionState,
	SessionStats,
	SkillProposalSummary,
} from "../../src/protocol";
import { h, iconButton } from "../dom";
import { icon } from "../icons";
import { setTooltip } from "../tooltip";
import { skillProposalElement } from "./notices";

type Post = (request: ChatRequest) => void;

export class Header {
	readonly element: HTMLElement;
	/** The MarIA Code mark at the start of the bar, where the empty chat's logo lands on the first prompt. */
	readonly brand = h("span", { className: "brand", ariaHidden: "true" });
	#title = h("div", { className: "session-title" }, "New chat");
	#rename: HTMLButtonElement;
	#input = h("input", { type: "text", className: "title-input", ariaLabel: "Session name", hidden: true });
	#sessionTitle = "New chat";
	#history: HTMLButtonElement;
	#historyBadge = h("span", { className: "history-badge", hidden: true, ariaHidden: "true" });
	#back: HTMLButtonElement;
	#historyOpen = false;
	/** A session is open (omp answered `get_state`), so it can be renamed. */
	#hasSession = false;
	#noWorkspace = h(
		"span",
		{
			className: "no-workspace-badge",
			hidden: true,
			dataset: { tooltip: "A chat without a workspace: MarIA Code runs in its own folder, not in this project" },
		},
		icon("globe"),
		"No workspace",
	);
	#curationRunning = false;
	#proposalCount = 0;
	#curationSpinner = h("span", {
		className: "curation-spinner",
		hidden: true,
		role: "status",
		ariaLabel: "Reviewing skills",
		dataset: { tooltip: "MarIA Code is reviewing the skills this task relied on" },
	});
	#curationCount = h("span", { className: "curation-count" });
	#curationDone = h(
		"button",
		{ type: "button", className: "curation-done", hidden: true, ariaExpanded: "false" },
		icon("pencil"),
		this.#curationCount,
	);
	#curationList = h("div", { className: "curation-list" });
	#curationPanel = h(
		"div",
		{ className: "curation-panel", hidden: true, role: "dialog", ariaLabel: "Skill proposals" },
		h(
			"div",
			{ className: "curation-panel-head" },
			h("span", { className: "curation-panel-title" }, "Skill proposals"),
			iconButton("close", "Close", () => this.#closeCurationPanel()),
		),
		this.#curationList,
	);

	constructor(
		private readonly post: Post,
		onHistory: () => void,
	) {
		this.#history = iconButton("history", "History", onHistory);
		this.#history.append(this.#historyBadge);
		this.#back = iconButton("back", "Back to chat", onHistory);
		this.#back.hidden = true;
		this.#rename = iconButton("pencil", "Rename chat", () => this.#startRename());
		this.#rename.classList.add("title-rename");
		this.#title.addEventListener("dblclick", () => this.#startRename());
		this.#curationDone.addEventListener("click", () => {
			if (this.#curationPanel.hidden) this.#openCurationPanel();
			else this.#closeCurationPanel();
		});
		document.addEventListener("keydown", event => {
			if (event.key === "Escape" && !this.#curationPanel.hidden) this.#closeCurationPanel();
		});
		document.addEventListener("mousedown", event => {
			const target = event.target as Node | null;
			if (this.#curationPanel.hidden || !target) return;
			if (this.#curationPanel.contains(target) || this.#curationDone.contains(target)) return;
			this.#closeCurationPanel();
		});
		this.#input.addEventListener("keydown", event => {
			if (event.isComposing) return;
			if (event.key === "Enter") {
				event.preventDefault();
				this.#finishRename(true);
			} else if (event.key === "Escape") {
				event.preventDefault();
				this.#finishRename(false);
			}
		});
		this.#input.addEventListener("blur", () => this.#finishRename(true));
		this.element = h(
			"header",
			{ className: "header" },
			this.brand,
			this.#title,
			this.#input,
			this.#curationSpinner,
			this.#curationDone,
			this.#rename,
			this.#noWorkspace,
			h(
				"div",
				{ className: "header-actions" },
				iconButton("plus", "New chat", () => post({ type: "newSession" })),
				iconButton("plusGlobe", "New chat without workspace (general tasks, not this project)", () =>
					post({ type: "newSession", noWorkspace: true }),
				),
				this.#history,
				this.#back,
				iconButton("settings", "Settings", () => post({ type: "openSettings" })),
			),
			this.#curationPanel,
		);
		this.#render();
	}

	setState(
		state: SessionState,
		_stats: SessionStats | undefined,
		title: string | undefined,
		noWorkspace: boolean,
	): void {
		this.#hasSession = true;
		this.#sessionTitle = title || state.sessionName || "New chat";
		this.#noWorkspace.dataset.on = String(noWorkspace);
		this.#render();
	}

	/** Whether omp is reviewing the open session's skills (host `skillCuration` update). */
	setCuration(status: "idle" | "running"): void {
		this.#curationRunning = status === "running";
		this.#render();
	}

	/** The skill proposals awaiting a decision that the shown session's task produced (host `skillProposals` update). */
	setProposals(proposals: SkillProposalSummary[]): void {
		this.#proposalCount = proposals.length;
		this.#curationCount.textContent = String(proposals.length);
		setTooltip(
			this.#curationDone,
			`${proposals.length} skill change${proposals.length === 1 ? "" : "s"} proposed — click to review`,
		);
		this.#curationList.replaceChildren(
			...proposals.map(proposal =>
				skillProposalElement(proposal, {
					approve: () => this.post({ type: "approveSkillProposal", id: proposal.id }),
					reject: () => this.post({ type: "rejectSkillProposal", id: proposal.id }),
					openDiff: () => this.post({ type: "openSkillProposalDiff", id: proposal.id }),
				}),
			),
		);
		this.#render();
	}

	#openCurationPanel(): void {
		this.#curationPanel.hidden = false;
		this.#curationDone.ariaExpanded = "true";
	}

	#closeCurationPanel(): void {
		this.#curationPanel.hidden = true;
		this.#curationDone.ariaExpanded = "false";
	}

	/** While the history panel is open the bar reads "History" and offers Back instead of History. */
	setHistoryMode(open: boolean): void {
		this.#historyOpen = open;
		this.#history.hidden = open;
		this.#back.hidden = !open;
		if (open) this.#finishRename(false);
		this.#render();
	}

	/** Sessions finished while unseen are counted on a blinking badge on History (host `sessionActivity` update). */
	setActivity(activity: Record<string, SessionActivity>): void {
		const finished = Object.values(activity).filter(state => state === "done").length;
		this.#historyBadge.hidden = finished === 0;
		this.#historyBadge.textContent = finished > 9 ? "9+" : String(finished);
		const label =
			finished === 0
				? "History"
				: `History — ${finished} chat${finished === 1 ? "" : "s"} finished while you were away`;
		this.#history.ariaLabel = label;
		setTooltip(this.#history, label);
	}

	#canRename(): boolean {
		return this.#hasSession && !this.#historyOpen;
	}

	#startRename(): void {
		if (!this.#canRename() || !this.#input.hidden) return;
		this.#input.value = this.#sessionTitle === "New chat" ? "" : this.#sessionTitle;
		this.#input.placeholder = "Name this chat";
		this.#input.hidden = false;
		this.#title.hidden = true;
		this.#rename.hidden = true;
		this.#input.focus();
		this.#input.select();
	}

	/** Enter or leaving the field renames (an empty or unchanged name does nothing); Escape cancels. */
	#finishRename(save: boolean): void {
		if (this.#input.hidden) return;
		this.#input.hidden = true;
		const name = this.#input.value.trim();
		if (save && name && name !== this.#sessionTitle) {
			// Shown at once; omp's refreshed state follows.
			this.#sessionTitle = name;
			this.post({ type: "renameSession", name });
		}
		this.#render();
	}

	#render(): void {
		const text = this.#historyOpen ? "History" : this.#sessionTitle;
		this.#title.textContent = text;
		this.#title.hidden = !this.#input.hidden;
		this.#rename.hidden = !this.#canRename() || !this.#input.hidden;
		this.#noWorkspace.hidden = this.#noWorkspace.dataset.on !== "true" || this.#historyOpen || !this.#input.hidden;
		const curationVisible = !this.#historyOpen && this.#input.hidden;
		this.#curationSpinner.hidden = !curationVisible || !this.#curationRunning;
		this.#curationDone.hidden = !curationVisible || this.#proposalCount === 0;
		if (this.#curationDone.hidden) this.#closeCurationPanel();
		setTooltip(this.#title, this.#canRename() ? `${text}\nDouble-click to rename` : text);
	}
}
