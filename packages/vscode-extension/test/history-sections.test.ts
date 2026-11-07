import { describe, expect, it } from "bun:test";
import type { SessionListItem } from "../src/protocol";
import { compactAge, previewOf, sectionOf } from "../webview/chat/history-sections";

const item = (fields: Partial<SessionListItem> = {}): SessionListItem => ({
	path: "/s.jsonl",
	label: "chat",
	modified: 0,
	active: false,
	noWorkspace: false,
	proposals: 0,
	...fields,
});

/** Wednesday 2026-11-04 at 10:00 local time. */
const now = new Date(2026, 10, 4, 10, 0).getTime();
const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0).getTime();

describe("history sections", () => {
	it("puts running chats under Running even with proposals, and finished-unseen or proposals by day", () => {
		expect(sectionOf(item({ activity: "running", proposals: 2, modified: at(1, 9) }), now)).toBe("running");
		expect(sectionOf(item({ activity: "done", modified: at(4, 9) }), now)).toBe("today");
		expect(sectionOf(item({ proposals: 1, modified: at(3, 9) }), now)).toBe("yesterday");
	});

	it("groups the rest by local calendar day, not by 24-hour windows", () => {
		expect(sectionOf(item({ modified: at(4, 0) }), now)).toBe("today");
		// 11 hours ago, but before midnight.
		expect(sectionOf(item({ modified: at(3, 23) }), now)).toBe("yesterday");
		expect(sectionOf(item({ modified: at(3, 0) }), now)).toBe("yesterday");
		expect(sectionOf(item({ modified: at(2, 23) }), now)).toBe("week");
		expect(sectionOf(item({ modified: new Date(2026, 9, 29, 0, 0).getTime() }), now)).toBe("week");
		expect(sectionOf(item({ modified: new Date(2026, 9, 28, 23, 0).getTime() }), now)).toBe("older");
	});
});

describe("history row age", () => {
	it("shows minutes and hours, the time for earlier yesterday, the weekday, then the date with the year only when it differs", () => {
		expect(compactAge(now - 30_000, now)).toBe("now");
		expect(compactAge(now - 5 * 60_000, now)).toBe("5m");
		expect(compactAge(now - 23 * 3_600_000, now)).toBe("23h");
		const yesterdayMorning = new Date(at(3, 8));
		expect(compactAge(yesterdayMorning.getTime(), now)).toBe(
			yesterdayMorning.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
		);
		const twoDays = new Date(now - 2 * 86_400_000);
		expect(compactAge(twoDays.getTime(), now)).toBe(twoDays.toLocaleDateString(undefined, { weekday: "short" }));
		const lastYear = new Date(2025, 0, 15).getTime();
		expect(compactAge(lastYear, now)).toContain("2025");
		expect(compactAge(new Date(2026, 0, 15).getTime(), now)).not.toContain("2026");
	});
});

describe("history row preview", () => {
	it("shows the latest prompt, or a single prompt only when the name is not that prompt", () => {
		expect(previewOf(item({ firstPrompt: "first", lastPrompt: "latest" }))).toBe("latest");
		expect(previewOf(item({ label: "first", firstPrompt: "first" }))).toBeUndefined();
		expect(previewOf(item({ label: "Renamed", firstPrompt: "first" }))).toBe("first");
	});
});
