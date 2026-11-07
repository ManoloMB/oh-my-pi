/**
 * The plan omp proposes in plan mode, shown in the chat the way Claude Code
 * and Codex do: the whole plan rendered as Markdown, a button to open it in an
 * editor tab, and omp's approval options as buttons. Refining first asks what
 * to change (typed or dictated) in a dialog; the feedback goes with the answer.
 */
import type { ChatRequest, ChatUpdate } from "../../src/protocol";
import { button, h } from "../dom";
import { icon } from "../icons";
import { setTooltip } from "../tooltip";
import { renderMarkdown } from "./markdown";
import type { PlanFeedbackDialog } from "./plan-feedback";

type Post = (request: ChatRequest) => void;
type PlanReview = Extract<ChatUpdate, { type: "planReview" }>;

/** omp's approving option (`packages/coding-agent/src/modes/rpc/rpc-plan.ts`); the others keep planning. */
const APPROVE_OPTION = "Approve and execute";

export class PlanCard {
	readonly element: HTMLElement;
	#actions: HTMLElement;
	#id: string;
	#feedback: PlanFeedbackDialog;

	constructor(review: PlanReview, post: Post, feedback: PlanFeedbackDialog) {
		this.#id = review.id;
		this.#feedback = feedback;
		const body = h("div", { className: "plan-card-body markdown" });
		body.innerHTML = renderMarkdown(review.content || "_The plan file is empty._");
		const header = h(
			"div",
			{ className: "plan-card-header" },
			h("span", { className: "plan-card-icon" }, icon("plan")),
			h("span", { className: "plan-card-label" }, "Plan"),
			h("span", { className: "plan-card-title", dataset: { tooltip: review.title } }, review.title),
		);
		const path = review.path;
		if (path) {
			const open = button("Open in editor", "plan-card-open", () => post({ type: "openPlan", path }));
			setTooltip(open, path);
			header.append(open);
		}
		this.#actions = h(
			"div",
			{ className: "plan-card-actions" },
			...review.options.map(option => {
				const approve = option === APPROVE_OPTION;
				const choice = button(option, approve ? "plan-card-approve" : "plan-card-secondary", () => {
					if (approve) {
						post({ type: "planDecision", id: review.id, value: option });
						this.#settle("Approved: implementing the plan");
						return;
					}
					feedback.open(review.id, review.title, text => {
						post({ type: "planDecision", id: review.id, value: option, feedback: text });
						this.#settle("Refining the plan with your feedback");
					});
				});
				setTooltip(
					choice,
					approve
						? "Leave plan mode and let MarIA Code implement this plan"
						: "Stay in plan mode: tell MarIA Code (typing or by voice) what to correct or improve in the plan",
				);
				return choice;
			}),
		);
		this.element = h("div", { className: "msg plan-card" }, header, body, this.#actions);
	}

	/** omp withdrew the review (the turn was aborted or the process stopped). */
	close(): void {
		this.#feedback.closeFor(this.#id);
		this.#settle("Review closed");
	}

	#settle(status: string): void {
		this.#actions.replaceChildren(h("span", { className: "plan-card-status" }, status));
	}
}
