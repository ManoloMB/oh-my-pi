/**
 * The empty composer's placeholder types out invented prompts, one after
 * another: each is typed character by character, stays a moment, is erased,
 * and the next one starts, inviting the user to write their own. It only runs
 * while the composer is empty and idle, the webview is visible, and the user
 * does not ask for reduced motion; otherwise the placeholder is static text.
 */

const IDEAS = [
	"Explícame cómo funciona la autenticación de este proyecto",
	"¿Por qué falla el pipeline de CI en esta rama?",
	"Refactoriza esta función para que se entienda mejor",
	"¿Por qué este pod está en CrashLoopBackOff?",
	"Optimiza esta consulta SQL que va lenta",
	"Escribe tests unitarios para el servicio de pagos",
	"Encuentra dónde se calcula el saldo disponible",
	"Revisa este Terraform antes de aplicarlo",
	"Genera la documentación de esta API",
	"Añade validación a los campos del formulario",
	"Crea un script que limpie los logs antiguos",
	"Migra estos tests a la nueva versión del framework",
];
const CARET = "|";
const START_MS = 400;
const TYPE_MS = 45;
/** Up to this much is added to each typed character, so it reads like someone typing. */
const TYPE_JITTER_MS = 55;
const HOLD_MS = 2200;
const DELETE_MS = 18;
const GAP_MS = 450;

type Phase = "typing" | "holding" | "deleting";

export class PlaceholderTypewriter {
	#reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
	/** What the composer asks for (empty and idle). */
	#wanted = false;
	#running = false;
	#fallback = "";
	#timer = 0;
	#chars: string[] = [];
	#idea = -1;
	#shown = 0;
	#phase: Phase = "typing";

	constructor(private readonly input: HTMLTextAreaElement) {
		document.addEventListener("visibilitychange", () => this.#sync());
		this.#reducedMotion.addEventListener("change", () => this.#sync());
	}

	/** Animate while `active`; otherwise show the static `fallback`. */
	setActive(active: boolean, fallback: string): void {
		this.#wanted = active;
		this.#fallback = fallback;
		this.#sync();
	}

	#sync(): void {
		const run = this.#wanted && !document.hidden && !this.#reducedMotion.matches;
		this.input.classList.toggle("typewriter", run);
		if (run === this.#running) {
			if (!run) this.input.placeholder = this.#fallback;
			return;
		}
		this.#running = run;
		window.clearTimeout(this.#timer);
		if (!run) {
			this.input.placeholder = this.#fallback;
			return;
		}
		// Each start (a cleared draft, back to the tab) types a new idea from its first character.
		this.#nextIdea();
		this.input.placeholder = CARET;
		this.#timer = window.setTimeout(() => this.#tick(), START_MS);
	}

	#nextIdea(): void {
		const offset = 1 + Math.floor(Math.random() * (IDEAS.length - 1));
		this.#idea = this.#idea < 0 ? Math.floor(Math.random() * IDEAS.length) : (this.#idea + offset) % IDEAS.length;
		this.#chars = Array.from(IDEAS[this.#idea]!);
		this.#shown = 0;
		this.#phase = "typing";
	}

	#tick(): void {
		let delay: number;
		switch (this.#phase) {
			case "typing":
				this.#shown++;
				if (this.#shown >= this.#chars.length) {
					this.#phase = "holding";
					delay = HOLD_MS;
				} else {
					delay = TYPE_MS + Math.random() * TYPE_JITTER_MS;
				}
				break;
			case "holding":
				this.#phase = "deleting";
				delay = DELETE_MS;
				break;
			case "deleting":
				this.#shown--;
				if (this.#shown <= 0) {
					this.#nextIdea();
					delay = GAP_MS;
				} else {
					delay = DELETE_MS;
				}
				break;
		}
		this.input.placeholder = this.#chars.slice(0, this.#shown).join("") + CARET;
		this.#timer = window.setTimeout(() => this.#tick(), delay);
	}
}
