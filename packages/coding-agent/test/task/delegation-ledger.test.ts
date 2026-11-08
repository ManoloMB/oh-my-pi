import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	countDelegationsSinceLastUserMessage,
	DELEGATION_CUSTOM_TYPE,
	type DelegationEntryData,
	deriveDelegations,
	renderDelegationLedger,
} from "@oh-my-pi/pi-coding-agent/task/delegation-ledger";

let entryCounter = 0;

function delegationEntry(data: Partial<DelegationEntryData> & { agentId: string }): SessionEntry {
	const full: DelegationEntryData = {
		v: 1,
		agent: "task",
		toolCallId: "call-1",
		description: `work for ${data.agentId}`,
		status: "running",
		at: 0,
		...data,
	};
	return {
		id: `e${++entryCounter}`,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		type: "custom",
		customType: DELEGATION_CUSTOM_TYPE,
		data: full,
	} as unknown as SessionEntry;
}

function userEntry(): SessionEntry {
	return {
		id: `e${++entryCounter}`,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		type: "message",
		message: { role: "user", content: "next", timestamp: 0 },
	} as unknown as SessionEntry;
}

describe("deriveDelegations", () => {
	it("keeps the latest entry per agent", () => {
		const delegations = deriveDelegations([
			delegationEntry({ agentId: "A", status: "running", at: 1 }),
			delegationEntry({ agentId: "A", status: "completed", at: 2 }),
		]);
		expect(delegations).toHaveLength(1);
		expect(delegations[0]!.status).toBe("completed");
	});
});

describe("countDelegationsSinceLastUserMessage", () => {
	it("counts distinct agents after the last user message, excluding the current call", () => {
		const entries = [
			delegationEntry({ agentId: "Old" }),
			userEntry(),
			delegationEntry({ agentId: "A", toolCallId: "call-1" }),
			delegationEntry({ agentId: "A", toolCallId: "call-1", status: "completed" }),
			delegationEntry({ agentId: "B", toolCallId: "call-2" }),
			delegationEntry({ agentId: "C", toolCallId: "call-3" }),
		];
		expect(countDelegationsSinceLastUserMessage(entries, "call-3")).toBe(2);
		expect(countDelegationsSinceLastUserMessage(entries, "none")).toBe(3);
	});
});

describe("renderDelegationLedger", () => {
	it("returns undefined for no delegations", () => {
		expect(renderDelegationLedger([])).toBeUndefined();
	});

	it("lists status and agent id", () => {
		const text = renderDelegationLedger(
			deriveDelegations([delegationEntry({ agentId: "BuildFixer", status: "completed", at: 1 })]),
		);
		expect(text).toContain("[completed]");
		expect(text).toContain("BuildFixer");
	});

	it("caps the list at 30 and reports the rest as omitted", () => {
		const entries = Array.from({ length: 35 }, (_, i) => delegationEntry({ agentId: `Agent${i}`, at: i }));
		const text = renderDelegationLedger(deriveDelegations(entries))!;
		expect(text.split("\n").filter(line => line.startsWith("- [")).length).toBe(30);
		expect(text).toContain("5 older delegations omitted");
	});
});
