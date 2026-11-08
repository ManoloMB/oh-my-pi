import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { isTeamEnabled, rootAgentId, TeamTaskBoard } from "@oh-my-pi/pi-coding-agent/task/team-board";

function createRealSession(): AgentSession {
	return new AgentSession({
		agent: new Agent({ initialState: { systemPrompt: ["system prompt"], messages: [], tools: [] } }),
		sessionManager: SessionManager.inMemory("/tmp"),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: {} as never,
	});
}

describe("team task board", () => {
	let registry: AgentRegistry;
	let lifecycle: AgentLifecycleManager;
	let board: TeamTaskBoard;
	let rootSession: AgentSession;
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		registry = new AgentRegistry();
		lifecycle = new AgentLifecycleManager(registry);
		board = new TeamTaskBoard(registry, () => lifecycle);
		rootSession = createRealSession();
		sessions.push(rootSession);
		registry.register({ id: "Main", displayName: "main", kind: "main", session: rootSession });
		registry.register({ id: "A", displayName: "task", kind: "sub", parentId: "Main", session: null });
		registry.register({ id: "B", displayName: "task", kind: "sub", parentId: "A", session: null });
		registry.register({ id: "Sub1", displayName: "task", kind: "sub", parentId: "Main", session: null });
		registry.register({ id: "Sub2", displayName: "task", kind: "sub", parentId: "Main", session: null });
		registry.register({ id: "Other", displayName: "main", kind: "main", session: null });
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	it("resolves the tree root through parent links", () => {
		expect(rootAgentId(registry, "B")).toBe("Main");
		expect(rootAgentId(registry, "Main")).toBe("Main");
	});

	it("creates sequential tasks at revision 1 and rejects unknown blockers", async () => {
		const first = await board.create("Main", { subject: "one" }, 256);
		const second = await board.create("A", { subject: "two" }, 256);
		expect(first.task).toMatchObject({ id: "task-1", revision: 1, status: "pending", ready: true });
		expect(second.task).toMatchObject({ id: "task-2", revision: 1 });
		await expect(board.create("Main", { subject: "three", blockedBy: ["task-9"] }, 256)).rejects.toThrow(
			'team task "task-9" not found',
		);
	});

	it("claims ready tasks, refuses blocked ones and enforces compare-and-set", async () => {
		await board.create("Main", { subject: "base" }, 256);
		await board.create("Main", { subject: "dependent", blockedBy: ["task-1"] }, 256);

		const claimed = await board.update("A", { op: "claim", taskId: "task-1", expectedRevision: 1 });
		expect(claimed.task).toMatchObject({ revision: 2, status: "in_progress", ownerId: "A" });

		await expect(board.update("B", { op: "claim", taskId: "task-2", expectedRevision: 1 })).rejects.toThrow(
			'team task "task-2" is not ready to claim',
		);
		await expect(board.update("A", { op: "complete", taskId: "task-1", expectedRevision: 1 })).rejects.toThrow(
			'stale team task "task-1" revision 1; current revision is 2',
		);
	});

	it("lets exactly one of two concurrent claims win", async () => {
		await board.create("Main", { subject: "contested" }, 256);
		const results = await Promise.allSettled([
			board.update("Sub1", { op: "claim", taskId: "task-1", expectedRevision: 1 }),
			board.update("Sub2", { op: "claim", taskId: "task-1", expectedRevision: 1 }),
		]);
		const won = results.filter(result => result.status === "fulfilled");
		const lost = results.filter(result => result.status === "rejected");
		expect(won).toHaveLength(1);
		expect(lost).toHaveLength(1);
		expect(String((lost[0] as PromiseRejectedResult).reason)).toMatch(
			/is owned by another member|stale team task "task-1" revision 1/,
		);
	});

	it("rejects cycles and deleting a task that still blocks another", async () => {
		await board.create("Main", { subject: "a" }, 256);
		await board.create("Main", { subject: "b", blockedBy: ["task-1"] }, 256);
		await expect(
			board.update("Main", { op: "set_deps", taskId: "task-1", expectedRevision: 1, blockedBy: ["task-2"] }),
		).rejects.toThrow(/dependency cycle detected/);
		await expect(board.update("Main", { op: "delete", taskId: "task-1", expectedRevision: 1 })).rejects.toThrow(
			'team task "task-1" still blocks "task-2"',
		);
	});

	it("warns on overlapping write scopes without blocking", async () => {
		await board.create("Main", { subject: "a", writeScopes: ["src/app"] }, 256);
		await board.create("Main", { subject: "b", writeScopes: ["src/app/x.ts"] }, 256);
		await board.update("Sub1", { op: "claim", taskId: "task-1", expectedRevision: 1 });
		const second = await board.update("Sub2", { op: "claim", taskId: "task-2", expectedRevision: 1 });
		expect(second.task?.status).toBe("in_progress");
		expect(second.task?.writeScopeWarnings).toEqual(["write scopes overlap with task-1"]);
		await expect(board.create("Main", { subject: "bad", writeScopes: ["../x"] }, 256)).rejects.toThrow(
			'invalid workspace-relative write scope "../x"',
		);
	});

	it("restricts reassign to the root and to agents inside the tree", async () => {
		await board.create("Main", { subject: "a" }, 256);
		await expect(
			board.update("A", { op: "reassign", taskId: "task-1", expectedRevision: 1, owner: "B" }),
		).rejects.toThrow("only the root agent can reassign tasks");
		await expect(
			board.update("Main", { op: "reassign", taskId: "task-1", expectedRevision: 1, owner: "Other" }),
		).rejects.toThrow('agent "Other" is not reachable from this task board\'s root');
		const reassigned = await board.update("Main", {
			op: "reassign",
			taskId: "task-1",
			expectedRevision: 1,
			owner: "B",
		});
		expect(reassigned.task).toMatchObject({ status: "in_progress", ownerId: "B" });
	});

	it("enforces the task limit", async () => {
		await board.create("Main", { subject: "a" }, 2);
		await board.create("Main", { subject: "b" }, 2);
		await expect(board.create("Main", { subject: "c" }, 2)).rejects.toThrow("Team task limit 2 reached");
	});

	it("derives state from the root session log, not from board memory", async () => {
		await board.create("Main", { subject: "a" }, 256);
		await board.update("A", { op: "claim", taskId: "task-1", expectedRevision: 1 });
		const fresh = new TeamTaskBoard(registry, () => lifecycle);
		expect(await fresh.get("B", "task-1")).toMatchObject({ status: "in_progress", ownerId: "A", revision: 2 });
	});

	it("gates on settings, recursion depth and IRC opt-out", () => {
		expect(isTeamEnabled(Settings.isolated({}), 0, undefined)).toBe(true);
		expect(isTeamEnabled(Settings.isolated({ "task.maxRecursionDepth": 0 }), 0, undefined)).toBe(false);
		expect(isTeamEnabled(Settings.isolated({}), 0, false)).toBe(false);
		expect(isTeamEnabled(Settings.isolated({ "task.team.enabled": false }), 1, undefined)).toBe(false);
	});

	describe("value", () => {
		it("splits independent work between peers without duplicate claims and unblocks the join", async () => {
			await board.create("Main", { subject: "left" }, 256);
			await board.create("Main", { subject: "right" }, 256);
			await board.create("Main", { subject: "join", blockedBy: ["task-1", "task-2"] }, 256);

			const claimFirstReady = async (agent: string) => {
				const ready = await board.list(agent, { ready: true });
				for (const view of ready) {
					try {
						return await board.update(agent, { op: "claim", taskId: view.id, expectedRevision: view.revision });
					} catch {}
				}
				return undefined;
			};
			const [one, two] = await Promise.all([claimFirstReady("Sub1"), claimFirstReady("Sub2")]);
			const claimedIds = [one?.task?.id, two?.task?.id];
			expect(new Set(claimedIds).size).toBe(2);
			expect(claimedIds.sort()).toEqual(["task-1", "task-2"]);
			expect((await board.get("Main", "task-3")).ready).toBe(false);

			const firstDone = await board.update(one?.task?.ownerId ?? "", {
				op: "complete",
				taskId: one?.task?.id ?? "",
				expectedRevision: 2,
			});
			expect(firstDone.newlyReady).toEqual([]);
			expect((await board.get("Main", "task-3")).ready).toBe(false);
			const secondDone = await board.update(two?.task?.ownerId ?? "", {
				op: "complete",
				taskId: two?.task?.id ?? "",
				expectedRevision: 2,
			});
			expect(secondDone.newlyReady).toEqual(["task-3"]);
			expect((await board.get("Main", "task-3")).ready).toBe(true);
		});
	});
});
