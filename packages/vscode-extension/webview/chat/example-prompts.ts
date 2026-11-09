/**
 * The prompts under the logo of an empty chat. Clicking one fills the
 * composer; "Editar" turns the list into fields to rewrite, remove, add or
 * restore them, and saving keeps the list for every chat (the host stores it,
 * see src/chat/example-prompt-store.ts).
 */
import type { ChatRequest } from "../../src/protocol";
import { MAX_EXAMPLE_PROMPT_LENGTH, MAX_EXAMPLE_PROMPTS, normalizeExamplePrompts } from "../../src/example-prompts";
import { button, h, iconButton } from "../dom";
import { icon } from "../icons";
import { setTooltip } from "../tooltip";

type Post = (request: ChatRequest) => void;

export class ExamplePrompts {
	readonly element = h("div", { className: "examples" });
	#prompts: string[] = [];
	#custom = false;
	/** Whether the host sent the list yet: nothing shows before, so a saved list never flickers over the defaults. */
	#loaded = false;
	#editing = false;
	#fields = h("div", { className: "examples-fields" });
	#add: HTMLButtonElement;
	#count = h("span", { className: "examples-count" });
	#saveButton = button("Guardar", "primary-button", () =>
		this.#save([...this.#fields.querySelectorAll<HTMLInputElement>(".example-input")].map(input => input.value)),
	);

	constructor(
		private readonly post: Post,
		private readonly onPick: (prompt: string) => void,
	) {
		this.#add = button("", "link-button examples-add", () => {
			this.#addField("").focus();
			this.#renderCount();
		});
		this.#add.append(icon("plus"), "Añadir prompt");
	}

	/** The host's list (`examplePrompts`); an open editor keeps what the user is writing. */
	set(prompts: string[], custom: boolean): void {
		this.#prompts = prompts;
		this.#custom = custom;
		this.#loaded = true;
		if (!this.#editing) this.#renderList();
	}

	#renderList(): void {
		this.#editing = false;
		this.element.classList.remove("editing");
		if (!this.#loaded) {
			this.element.replaceChildren();
			return;
		}
		const chips = this.#prompts.map(prompt => {
			const chip = button(prompt, "example", () => this.onPick(prompt));
			chip.title = prompt;
			return chip;
		});
		const edit = button("", "link-button examples-edit", () => this.#openEditor());
		edit.append(icon("pencil"), this.#prompts.length > 0 ? "Editar prompts" : "Añadir tus prompts favoritos");
		setTooltip(edit, "Pon aquí tus prompts favoritos; se guardan para todos los chats");
		this.element.replaceChildren(...chips, edit);
	}

	#openEditor(): void {
		this.#editing = true;
		this.element.classList.add("editing");
		this.#fields.replaceChildren();
		for (const prompt of this.#prompts) this.#addField(prompt);
		if (this.#prompts.length === 0) this.#addField("");
		this.#renderCount();
		const actions = h(
			"div",
			{ className: "examples-actions" },
			this.#custom
				? button("Restaurar predeterminados", "link-button examples-reset", () => this.#save(null))
				: null,
			h("span", { className: "examples-spacer" }),
			button("Cancelar", "secondary-button", () => this.#renderList()),
			this.#saveButton,
		);
		this.element.replaceChildren(
			h("div", { className: "examples-edit-title" }, "Tus prompts favoritos", this.#count),
			this.#fields,
			this.#add,
			actions,
		);
		(this.#fields.querySelector("input") as HTMLInputElement | null)?.focus();
	}

	#addField(value: string): HTMLInputElement {
		const input = h("input", {
			type: "text",
			className: "example-input",
			value,
			maxLength: MAX_EXAMPLE_PROMPT_LENGTH,
			placeholder: "Escribe un prompt…",
			ariaLabel: "Prompt favorito",
		});
		input.addEventListener("keydown", event => {
			if (event.key === "Enter" && !event.isComposing) {
				event.preventDefault();
				this.#saveButton.click();
			} else if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				this.#renderList();
			}
		});
		const row = h("div", { className: "example-edit-row" }, input);
		row.append(
			iconButton("trash", "Quitar", () => {
				row.remove();
				this.#renderCount();
			}),
		);
		this.#fields.append(row);
		return input;
	}

	#renderCount(): void {
		const rows = this.#fields.childElementCount;
		this.#count.textContent = `${rows}/${MAX_EXAMPLE_PROMPTS}`;
		this.#add.disabled = rows >= MAX_EXAMPLE_PROMPTS;
	}

	/** Show the list right away; the host's `examplePrompts` echo confirms it in every chat. */
	#save(prompts: string[] | null): void {
		if (prompts !== null) {
			this.#prompts = normalizeExamplePrompts(prompts);
			this.#custom = true;
		}
		this.post({ type: "setExamplePrompts", prompts: prompts === null ? null : this.#prompts });
		this.#renderList();
	}
}
