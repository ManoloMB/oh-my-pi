/**
 * The prompts under the logo of an empty chat: clicking one fills the
 * composer. The user can replace them with their favourites; the extension
 * keeps those in its global state (see chat/example-prompt-store.ts). Shared
 * by the extension host and the chat webview.
 */

/** Shown until the user saves their own list (and again after "restore defaults"). */
export const DEFAULT_EXAMPLE_PROMPTS: readonly string[] = [
	"Dame una visión general de este código",
	"Busca posibles bugs en mis cambios recientes",
	"Escribe tests para el archivo que tengo abierto",
];

export const MAX_EXAMPLE_PROMPTS = 10;
export const MAX_EXAMPLE_PROMPT_LENGTH = 500;

/**
 * The list as kept and shown: each prompt on one line with its whitespace
 * collapsed, empty ones and repeats dropped, at most {@link MAX_EXAMPLE_PROMPTS}
 * of at most {@link MAX_EXAMPLE_PROMPT_LENGTH} characters.
 */
export function normalizeExamplePrompts(prompts: readonly unknown[]): string[] {
	const kept: string[] = [];
	for (const prompt of prompts) {
		if (typeof prompt !== "string") continue;
		const text = prompt.replace(/\s+/g, " ").trim().slice(0, MAX_EXAMPLE_PROMPT_LENGTH).trimEnd();
		if (text && !kept.includes(text)) kept.push(text);
		if (kept.length === MAX_EXAMPLE_PROMPTS) break;
	}
	return kept;
}
