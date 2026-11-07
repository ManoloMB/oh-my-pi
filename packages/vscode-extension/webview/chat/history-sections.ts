/**
 * Where each chat of the history panel goes and how its row reads, apart from the
 * DOM so the rules can be tested: chats running, then the rest by calendar day
 * of their last change.
 */
import type { SessionListItem } from "../../src/protocol";

export type SectionId = "running" | "today" | "yesterday" | "week" | "older";

/** Sections in display order with their headings. */
export const SECTIONS: readonly { id: SectionId; title: string }[] = [
	{ id: "running", title: "Running" },
	{ id: "today", title: "Today" },
	{ id: "yesterday", title: "Yesterday" },
	{ id: "week", title: "This week" },
	{ id: "older", title: "Older" },
];

/** Sections folded on every opening (its count still shows on the heading): all but Today; Running never folds. */
export const FOLDED_BY_DEFAULT: readonly SectionId[] = ["yesterday", "week", "older"];

/** Local midnight `daysBack` days before the day of `now` (calendar days, so DST shifts don't move it). */
function dayStart(now: number, daysBack: number): number {
	const day = new Date(now);
	day.setHours(0, 0, 0, 0);
	day.setDate(day.getDate() - daysBack);
	return day.getTime();
}

/**
 * A running chat is still working; any other goes by the local calendar day it
 * last changed ("This week" covers the 5 days before yesterday).
 */
export function sectionOf(item: SessionListItem, now: number): SectionId {
	if (item.activity === "running") return "running";
	if (item.modified >= dayStart(now, 0)) return "today";
	if (item.modified >= dayStart(now, 1)) return "yesterday";
	if (item.modified >= dayStart(now, 6)) return "week";
	return "older";
}

/**
 * Short age for the row's right edge: "now", "5m", "3h" within 24 hours, the time
 * for earlier yesterday, the weekday within the week, then the date.
 */
export function compactAge(modified: number, now: number): string {
	const minutes = Math.floor((now - modified) / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const date = new Date(modified);
	if (modified >= dayStart(now, 1)) return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	if (modified >= dayStart(now, 6)) return date.toLocaleDateString(undefined, { weekday: "short" });
	const sameYear = date.getFullYear() === new Date(now).getFullYear();
	return date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: sameYear ? undefined : "numeric",
	});
}

/** How long a chat ran, from its start to its last change: "<1m", "45m", "2h 15m", "3d 4h". */
export function durationLabel(created: number, modified: number): string {
	const minutes = Math.floor(Math.max(0, modified - created) / 60_000);
	if (minutes < 1) return "<1m";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/**
 * The line under the chat's name: its latest prompt, which says where it was
 * left; for a single-prompt chat, that prompt unless the name already is it.
 */
export function previewOf(item: SessionListItem): string | undefined {
	if (item.lastPrompt) return item.lastPrompt;
	if (item.firstPrompt && item.firstPrompt !== item.label) return item.firstPrompt;
	return undefined;
}
