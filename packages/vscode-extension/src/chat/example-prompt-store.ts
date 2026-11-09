/**
 * The user's own empty-chat prompts, kept in the extension's global state:
 * every window and workspace shows the same list, it survives restarts and
 * updates, and Settings Sync carries it to the user's other machines.
 */
import * as vscode from "vscode";
import { DEFAULT_EXAMPLE_PROMPTS, normalizeExamplePrompts } from "../example-prompts";

const KEY = "examplePrompts";

export interface ExamplePrompts {
	prompts: string[];
	/** The user saved this list (false: the defaults). */
	custom: boolean;
}

export class ExamplePromptStore implements vscode.Disposable {
	readonly #onDidChange = new vscode.EventEmitter<void>();
	/** Fires when this window saves or restores the list. */
	readonly onDidChange = this.#onDidChange.event;

	constructor(private readonly state: vscode.Memento & { setKeysForSync(keys: readonly string[]): void }) {
		state.setKeysForSync([KEY]);
	}

	get(): ExamplePrompts {
		const saved = this.state.get<unknown>(KEY);
		if (!Array.isArray(saved)) return { prompts: [...DEFAULT_EXAMPLE_PROMPTS], custom: false };
		return { prompts: normalizeExamplePrompts(saved), custom: true };
	}

	/** Keep `prompts` as the user's list; `null` goes back to the defaults. */
	async set(prompts: readonly string[] | null): Promise<void> {
		await this.state.update(KEY, prompts === null ? undefined : normalizeExamplePrompts(prompts));
		this.#onDidChange.fire();
	}

	dispose(): void {
		this.#onDidChange.dispose();
	}
}
