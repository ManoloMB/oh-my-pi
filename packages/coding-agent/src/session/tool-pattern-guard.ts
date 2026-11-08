/**
 * Per-call tool-usage pattern detection: one tool dominating the recent call
 * window (frequency) and two tools failing in turn (alternation). Detections
 * only produce reminders; nothing aborts.
 */

export const TOOL_FREQUENCY_WINDOW = 50;
export const TOOL_FREQUENCY_REPEAT_EVERY = 15;

export type ToolPatternDetection =
	| { kind: "frequency"; toolName: string; count: number; window: number }
	| { kind: "alternation"; first: string; second: string };

export interface ToolPatternGuardOptions {
	frequencyThreshold: number;
	frequencyExempt: ReadonlySet<string>;
	alternation: boolean;
}

interface RecordedCall {
	toolName: string;
	isError: boolean;
}

export class ToolPatternGuard {
	#history: RecordedCall[] = [];
	#warnedTools = new Set<string>();
	#callsSinceWarn = new Map<string, number>();
	#lastAlternationPair: string | undefined;

	record(call: RecordedCall, options: ToolPatternGuardOptions): ToolPatternDetection[] {
		const detections: ToolPatternDetection[] = [];
		const history = this.#history;

		if (!call.isError) {
			this.#lastAlternationPair = undefined;
		} else if (options.alternation && history.length >= 3) {
			const a = history[history.length - 3];
			const b = history[history.length - 2];
			const c = history[history.length - 1];
			if (
				a.toolName === c.toolName &&
				b.toolName === call.toolName &&
				a.toolName !== b.toolName &&
				a.isError &&
				b.isError &&
				c.isError
			) {
				const pair = [a.toolName, b.toolName].sort().join("\u0000");
				if (pair !== this.#lastAlternationPair) {
					detections.push({ kind: "alternation", first: a.toolName, second: b.toolName });
					this.#lastAlternationPair = pair;
				}
			}
		}

		history.push({ toolName: call.toolName, isError: call.isError });
		if (history.length > TOOL_FREQUENCY_WINDOW) history.splice(0, history.length - TOOL_FREQUENCY_WINDOW);

		const threshold = options.frequencyThreshold;
		if (threshold > 0 && !options.frequencyExempt.has(call.toolName)) {
			let count = 0;
			for (const entry of history) if (entry.toolName === call.toolName) count++;
			const sinceWarn = (this.#callsSinceWarn.get(call.toolName) ?? 0) + 1;
			this.#callsSinceWarn.set(call.toolName, sinceWarn);
			if (
				count >= threshold &&
				(!this.#warnedTools.has(call.toolName) || sinceWarn >= TOOL_FREQUENCY_REPEAT_EVERY)
			) {
				this.#warnedTools.add(call.toolName);
				this.#callsSinceWarn.set(call.toolName, 0);
				detections.push({ kind: "frequency", toolName: call.toolName, count, window: TOOL_FREQUENCY_WINDOW });
			}
		}

		return detections;
	}
}
