/**
 * "Refine plan" on a plan card: a dialog over the chat where the user writes
 * (or dictates through the microphone) what MarIA Code should correct or
 * improve in the plan it proposed. Sending answers the review with the
 * refining option plus that feedback; cancelling leaves the review pending.
 * While it is open (or its dictation is still transcribing) it owns omp's
 * dictation updates instead of the composer.
 */
import type { ChatRequest } from "../../src/protocol";
import { button, h } from "../dom";
import { icon } from "../icons";
import { setTooltip } from "../tooltip";
import { DictationControl, type DictationState } from "./dictation";

type Post = (request: ChatRequest) => void;

const PLACEHOLDER = "¿Qué quieres que MarIA Code corrija o mejore del plan?";
const PLACEHOLDER_LISTENING = "Escuchando… pulsa el micrófono para terminar, Esc para cancelar";
const PLACEHOLDER_TRANSCRIBING = "Transcribiendo…";

interface OpenReview {
	id: string;
	onSend: (feedback: string) => void;
	restore: Element | null;
}

export class PlanFeedbackDialog {
	#dictation: DictationControl;
	#input = h("textarea", { className: "plan-feedback-input", rows: 5, placeholder: PLACEHOLDER });
	#preview = h("div", { className: "dictation-preview", hidden: true });
	#error = h("div", { className: "plan-feedback-error", role: "alert", hidden: true });
	#title = h("span", { className: "plan-feedback-title" });
	#send: HTMLButtonElement;
	#overlay: HTMLElement;
	#open: OpenReview | undefined;

	constructor(
		post: Post,
		/** Runs before the dialog shows: the composer drops a recording so the microphone is free. */
		private readonly onOpen: () => void,
	) {
		this.#dictation = new DictationControl(post, state => this.#onDictationState(state));
		this.#send = button("Enviar feedback", "plan-card-approve", () => this.#submit());
		setTooltip(this.#send, "Enviar a MarIA Code para que refine el plan (Ctrl+Enter)");
		const cancel = button("Cancelar", "plan-card-secondary", () => this.close());
		setTooltip(cancel, "Cerrar sin responder: el plan sigue esperando tu decisión (Esc)");
		this.#input.addEventListener("input", () => this.#refresh());
		const card = h(
			"div",
			{ className: "plan-feedback-card", role: "dialog", ariaModal: "true", ariaLabel: "Refinar el plan" },
			h(
				"div",
				{ className: "plan-feedback-header" },
				h("span", { className: "plan-card-icon" }, icon("plan")),
				h("span", { className: "plan-card-label" }, "Refinar el plan"),
				this.#title,
			),
			this.#input,
			this.#preview,
			this.#error,
			h(
				"div",
				{ className: "plan-feedback-footer" },
				this.#dictation.element,
				h("span", { className: "plan-feedback-hint" }, "Ctrl+Enter para enviar"),
				h("span", { className: "plan-feedback-spacer" }),
				cancel,
				this.#send,
			),
		);
		this.#overlay = h("div", { className: "plan-feedback", hidden: true }, card);
		this.#overlay.addEventListener("keydown", event => this.#onKeyDown(event));
		document.body.append(this.#overlay);
	}

	/** Dictation updates belong here while open, and until a capture started here has finished. */
	get ownsDictation(): boolean {
		return this.#open !== undefined || this.#dictation.state !== "idle";
	}

	/** Ask for feedback on the plan under review `id`; `onSend` gets the text when the user sends it. */
	open(id: string, planTitle: string, onSend: (feedback: string) => void): void {
		if (this.#open && this.#open.id !== id) this.close();
		this.onOpen();
		const restore = this.#open?.restore ?? document.activeElement;
		this.#open = { id, onSend, restore };
		this.#title.textContent = planTitle;
		this.#title.dataset.tooltip = planTitle;
		this.#error.hidden = true;
		this.#overlay.hidden = false;
		this.#refresh();
		this.#input.focus();
	}

	/** omp withdrew the review `id`: drop the dialog asking about it. */
	closeFor(id: string): void {
		if (this.#open?.id === id) this.close();
	}

	close(): void {
		const open = this.#open;
		if (!open) return;
		this.#open = undefined;
		this.#dictation.cancel();
		this.#overlay.hidden = true;
		this.#input.value = "";
		this.#preview.hidden = true;
		if (open.restore instanceof HTMLElement && open.restore.isConnected) open.restore.focus();
	}

	/** "Toggle Voice Input" from the command palette or a keybinding while the dialog is open. */
	toggleDictation(): void {
		this.#dictation.toggle();
	}

	/** omp's dictation state; `text` is a streaming model's running transcript. */
	dictationUpdate(
		state: "recording" | "transcribing" | "idle",
		text: string | undefined,
		error: string | undefined,
	): void {
		this.#dictation.update(state);
		this.#preview.textContent = text ?? "";
		this.#preview.hidden = state !== "recording" || !text;
		if (error) this.#showError(error);
	}

	/** A finished dictation: the text goes in at the cursor, and is sent when omp's submit trigger fired. */
	dictationText(text: string, submit: boolean): void {
		this.#dictation.update("idle");
		// Closed while transcribing: the speech was meant for a dialog that is gone.
		if (!this.#open) return;
		if (!text) {
			this.#showError("No se ha detectado voz.");
			return;
		}
		const { selectionStart, selectionEnd, value } = this.#input;
		const before = value.slice(0, selectionStart);
		const pad = before !== "" && !/\s$/.test(before) && !/^\s/.test(text) ? " " : "";
		this.#input.setRangeText(pad + text, selectionStart, selectionEnd, "end");
		this.#refresh();
		this.#input.focus();
		if (submit) this.#submit();
	}

	#submit(): void {
		const open = this.#open;
		const feedback = this.#input.value.trim();
		if (!open || !feedback || this.#dictation.state !== "idle") return;
		this.close();
		open.onSend(feedback);
	}

	#onKeyDown(event: KeyboardEvent): void {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			const state = this.#dictation.state;
			if (state === "starting" || state === "recording") this.#dictation.cancel();
			else this.close();
		} else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			this.#submit();
		}
	}

	#onDictationState(state: DictationState): void {
		if (state !== "recording") this.#preview.hidden = true;
		if (state !== "idle") this.#error.hidden = true;
		this.#refresh();
		if (state === "idle" && this.#open) this.#input.focus();
	}

	#showError(message: string): void {
		this.#error.textContent = message;
		this.#error.hidden = false;
	}

	#refresh(): void {
		const state = this.#dictation.state;
		this.#input.placeholder =
			state === "recording"
				? PLACEHOLDER_LISTENING
				: state === "transcribing"
					? PLACEHOLDER_TRANSCRIBING
					: PLACEHOLDER;
		this.#send.disabled = this.#input.value.trim() === "" || state !== "idle";
	}
}
