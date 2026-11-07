/**
 * Text matching shared by the history search on both sides (the host's search
 * through every message and the panel's instant filter on names): queries and
 * texts are folded to lowercase without accents, so "Cancion" finds "canción".
 * No Node or DOM APIs: the webview imports it too.
 */

const ASCII = /^[\x00-\x7f]*$/;
const MARKS = /\p{M}/gu;

/**
 * `text` in lowercase without diacritics, with the same length so an offset in
 * the folded text is the offset of the same character in `text`; characters
 * whose folding would change the length stay as they are (lowercased when that
 * keeps the length).
 */
export function foldText(text: string): string {
	if (ASCII.test(text)) return text.toLowerCase();
	const whole = text.normalize("NFD").replace(MARKS, "").toLowerCase();
	if (whole.length === text.length) return whole;
	let folded = "";
	for (const char of text) {
		const plain = char.normalize("NFD").replace(MARKS, "").toLowerCase();
		if (plain.length === char.length) folded += plain;
		else {
			const lower = char.toLowerCase();
			folded += lower.length === char.length ? lower : char;
		}
	}
	return folded;
}

/**
 * Folded terms of a query: words, or `"quoted phrases"` kept whole; every term
 * must be found for a chat to match. Duplicates are dropped.
 */
export function parseQuery(query: string): string[] {
	const terms: string[] = [];
	for (const match of foldText(query).matchAll(/"([^"]*)"|(\S+)/g)) {
		const term = (match[1] ?? match[2] ?? "").trim().replace(/\s+/g, " ");
		if (term && !terms.includes(term)) terms.push(term);
	}
	return terms;
}

/** Offsets `[start, end)` of every occurrence of `terms` in `folded` (a folded text), sorted and merged. */
export function termRanges(folded: string, terms: readonly string[]): [number, number][] {
	const ranges: [number, number][] = [];
	for (const term of terms) {
		for (let at = folded.indexOf(term); at >= 0; at = folded.indexOf(term, at + term.length)) {
			ranges.push([at, at + term.length]);
		}
	}
	ranges.sort((a, b) => a[0] - b[0]);
	const merged: [number, number][] = [];
	for (const range of ranges) {
		const last = merged.at(-1);
		if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
		else merged.push([range[0], range[1]]);
	}
	return merged;
}
