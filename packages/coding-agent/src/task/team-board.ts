/**
 * Shared task board for one agent tree (root + subagents). Every revision is a
 * custom entry in the root session's log; state is always re-derived from the
 * log, and mutations are compare-and-set on `revision`, serialized per root.
 */
import type { TeamTaskSnapshot, TeamTaskStatus, TeamTaskView } from "@oh-my-pi/pi-tui/tools/team-task";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { isIrcEnabled } from "../irc/messaging";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import type { SessionEntry } from "../session/session-entries";
import { cfgTaskTeamEnabled } from "./settings";

export type { TeamTaskSnapshot, TeamTaskStatus, TeamTaskView };

export const TEAM_TASK_CUSTOM_TYPE = "team_task";

const SUBJECT_MAX = 200;
const DESCRIPTION_MAX = 16_384;
const NUMERIC_TASK_ID = /^task-(\d+)$/;

/** Mutating board operations; each requires `taskId` + `expectedRevision`. */
export type TeamTaskMutation =
	| "claim"
	| "release"
	| "edit"
	| "set_deps"
	| "complete"
	| "reopen"
	| "reassign"
	| "delete";

export interface TeamTaskCreateRequest {
	subject: string;
	description?: string;
	blockedBy?: readonly string[];
	writeScopes?: readonly string[];
}

export interface TeamTaskUpdateRequest {
	op: TeamTaskMutation;
	taskId: string;
	expectedRevision: number;
	subject?: string;
	description?: string;
	blockedBy?: readonly string[];
	writeScopes?: readonly string[];
	/** Reassign target; omitted returns the task to pending without an owner. */
	owner?: string;
}

export interface TeamTaskListFilter {
	status?: Exclude<TeamTaskStatus, "deleted">;
	ready?: boolean;
}

export interface TeamTaskMutationResult {
	/** Committed revision; `deleted` for a tombstone. */
	snapshot: TeamTaskSnapshot;
	/** View of the committed revision; absent once deleted. */
	task?: TeamTaskView;
	/** Pending tasks that became claimable through this mutation. */
	newlyReady: string[];
}

export interface DerivedTeamTasks {
	tasks: TeamTaskSnapshot[];
	nextTaskNumber: number;
}

/** The board exists for agents that may coordinate with peers: same gate as IRC, plus its own switch. */
export function isTeamEnabled(settings: Settings, taskDepth: number, enableIrc: boolean | undefined): boolean {
	return cfgTaskTeamEnabled.get(settings) && enableIrc !== false && isIrcEnabled(settings, taskDepth);
}

/** Topmost ancestor of `id` following `parentId`; cycles stop at the first repeat. */
export function rootAgentId(registry: AgentRegistry, id: string): string {
	const visited = new Set<string>([id]);
	let current = id;
	for (;;) {
		const parentId = registry.get(current)?.parentId;
		if (!parentId || visited.has(parentId) || !registry.get(parentId)) return current;
		visited.add(parentId);
		current = parentId;
	}
}

/** Whether `candidateId` belongs to the tree rooted at `rootId`. */
export function isWithinTree(registry: AgentRegistry, candidateId: string, rootId: string): boolean {
	return registry.get(candidateId) !== undefined && rootAgentId(registry, candidateId) === rootId;
}

function isSnapshot(value: unknown): value is TeamTaskSnapshot {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		Number.isSafeInteger(value.revision) &&
		typeof value.subject === "string" &&
		typeof value.description === "string" &&
		(value.status === "pending" ||
			value.status === "in_progress" ||
			value.status === "completed" ||
			value.status === "deleted") &&
		(value.ownerId === undefined || typeof value.ownerId === "string") &&
		Array.isArray(value.blockedBy) &&
		value.blockedBy.every(item => typeof item === "string") &&
		Array.isArray(value.writeScopes) &&
		value.writeScopes.every(item => typeof item === "string")
	);
}

/** Replay committed snapshots in log order, enforcing contiguous revisions. */
export function deriveTasks(entries: readonly SessionEntry[]): DerivedTeamTasks {
	const byId = new Map<string, TeamTaskSnapshot>();
	let nextTaskNumber = 1;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== TEAM_TASK_CUSTOM_TYPE) continue;
		const snapshot = entry.data;
		if (!isSnapshot(snapshot)) throw new Error("team task board is corrupt: malformed task snapshot");
		const prior = byId.get(snapshot.id);
		if (prior === undefined && snapshot.revision !== 1) {
			throw new Error(`team task board is corrupt: task "${snapshot.id}" must begin at revision 1`);
		}
		if (prior !== undefined && snapshot.revision !== prior.revision + 1) {
			throw new Error(`team task board is corrupt: task "${snapshot.id}" revision is not contiguous`);
		}
		byId.set(snapshot.id, snapshot);
		const match = NUMERIC_TASK_ID.exec(snapshot.id);
		if (match) nextTaskNumber = Math.max(nextTaskNumber, Number(match[1]) + 1);
	}
	return { tasks: [...byId.values()], nextTaskNumber };
}

/** Validate the whole active graph after replacing one candidate snapshot. */
export function assertTaskGraph(tasks: readonly TeamTaskSnapshot[], candidate: TeamTaskSnapshot): void {
	const byId = new Map(tasks.map(task => [task.id, task]));
	byId.set(candidate.id, candidate);
	for (const task of byId.values()) {
		if (task.status === "deleted") continue;
		const seen = new Set<string>();
		for (const blockerId of task.blockedBy) {
			if (blockerId === task.id) throw new Error(`team task "${task.id}" cannot block itself`);
			if (seen.has(blockerId)) throw new Error(`team task "${task.id}" repeats blocker "${blockerId}"`);
			const blocker = byId.get(blockerId);
			if (blocker === undefined || blocker.status === "deleted") {
				throw new Error(`blocker task "${blockerId}" for "${task.id}" is missing or deleted`);
			}
			seen.add(blockerId);
		}
	}
	const visited = new Set<string>();
	const stack: string[] = [];
	const visit = (id: string): void => {
		const cycleStart = stack.indexOf(id);
		if (cycleStart >= 0)
			throw new Error(`dependency cycle detected: ${[...stack.slice(cycleStart), id].join(" -> ")}`);
		if (visited.has(id)) return;
		const task = byId.get(id);
		if (task === undefined || task.status === "deleted") return;
		stack.push(id);
		for (const blockerId of task.blockedBy) visit(blockerId);
		stack.pop();
		visited.add(id);
	};
	for (const id of byId.keys()) visit(id);
}

/** Workspace-relative slash-separated prefix; absolute, drive-letter, `.` and `..` segments are rejected. */
export function normalizeWriteScope(value: string): string {
	const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
	const segments = normalized.split("/");
	if (
		normalized.length === 0 ||
		normalized.startsWith("/") ||
		/^[a-z]:/i.test(normalized) ||
		segments.some(segment => segment.length === 0 || segment === "." || segment === "..")
	) {
		throw new Error(`invalid workspace-relative write scope "${value}"`);
	}
	return normalized;
}

/** Trimmed non-empty text bounded by `max` characters. */
export function requiredText(value: string, field: string, max: number): string {
	const text = value.trim();
	if (text.length === 0) throw new Error(`${field} must be non-empty`);
	if (text.length > max) throw new Error(`${field} exceeds ${max} characters`);
	return text;
}

/** Whether either path prefix contains the other on component boundaries. */
export function scopesOverlap(a: string, b: string): boolean {
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function isReady(tasks: readonly TeamTaskSnapshot[], task: TeamTaskSnapshot): boolean {
	return task.blockedBy.every(id => tasks.find(candidate => candidate.id === id)?.status === "completed");
}

/** Detached view with readiness and overlap warnings against in-progress siblings. */
export function projectView(tasks: readonly TeamTaskSnapshot[], task: TeamTaskSnapshot): TeamTaskView {
	if (task.status === "deleted") throw new Error(`team task "${task.id}" is deleted`);
	const warnings = new Set<string>();
	for (const other of tasks) {
		if (other.id === task.id || other.status !== "in_progress") continue;
		if (task.writeScopes.some(left => other.writeScopes.some(right => scopesOverlap(left, right)))) {
			warnings.add(`write scopes overlap with ${other.id}`);
		}
	}
	return {
		id: task.id,
		revision: task.revision,
		subject: task.subject,
		description: task.description,
		status: task.status,
		...(task.ownerId === undefined ? {} : { ownerId: task.ownerId }),
		blockedBy: [...task.blockedBy],
		writeScopes: [...task.writeScopes],
		ready: task.status === "pending" && isReady(tasks, task),
		writeScopeWarnings: [...warnings],
	};
}

function readyIds(tasks: readonly TeamTaskSnapshot[]): Set<string> {
	return new Set(tasks.filter(task => task.status === "pending" && isReady(tasks, task)).map(task => task.id));
}

function withoutOwner(task: TeamTaskSnapshot): TeamTaskSnapshot {
	const { ownerId: _ownerId, ...rest } = task;
	return rest;
}

function normalizeScopes(values: readonly string[]): string[] {
	return [...new Set(values.map(normalizeWriteScope))];
}

function optionalDescription(value: string | undefined): string {
	const text = value?.trim() ?? "";
	if (text.length > DESCRIPTION_MAX) throw new Error(`description exceeds ${DESCRIPTION_MAX} characters`);
	return text;
}

export class TeamTaskBoard {
	static #global: TeamTaskBoard | undefined;

	static global(): TeamTaskBoard {
		TeamTaskBoard.#global ??= new TeamTaskBoard();
		return TeamTaskBoard.#global;
	}

	/** Reset the global board. Test-only. */
	static resetGlobalForTests(): void {
		TeamTaskBoard.#global = undefined;
	}

	readonly #tails = new Map<string, Promise<void>>();

	constructor(
		private readonly registry: AgentRegistry = AgentRegistry.global(),
		private readonly lifecycle: () => AgentLifecycleManager = () => AgentLifecycleManager.global(),
	) {}

	async create(callerId: string, req: TeamTaskCreateRequest, maxTasks: number): Promise<TeamTaskMutationResult> {
		const rootId = rootAgentId(this.registry, callerId);
		return this.#transact(rootId, async () => {
			const session = await this.lifecycle().ensureLive(rootId);
			const { tasks, nextTaskNumber } = deriveTasks(session.sessionManager.getEntries());
			if (tasks.filter(task => task.status !== "deleted").length >= maxTasks) {
				throw new Error(`Team task limit ${maxTasks} reached`);
			}
			const blockedBy = [...(req.blockedBy ?? [])];
			for (const id of blockedBy) {
				const blocker = tasks.find(task => task.id === id);
				if (!blocker) throw new Error(`team task "${id}" not found`);
				if (blocker.status === "deleted") throw new Error(`team task "${id}" is deleted`);
			}
			const task: TeamTaskSnapshot = {
				id: `task-${nextTaskNumber}`,
				revision: 1,
				subject: requiredText(req.subject, "subject", SUBJECT_MAX),
				description: optionalDescription(req.description),
				status: "pending",
				blockedBy,
				writeScopes: normalizeScopes(req.writeScopes ?? []),
			};
			assertTaskGraph(tasks, task);
			session.sessionManager.appendCustomEntry(TEAM_TASK_CUSTOM_TYPE, task);
			await session.sessionManager.flush();
			const after = [...tasks, task];
			return { snapshot: task, task: projectView(after, task), newlyReady: [] };
		});
	}

	async get(callerId: string, taskId: string): Promise<TeamTaskView> {
		const tasks = await this.#read(callerId);
		const task = tasks.find(candidate => candidate.id === taskId);
		if (!task) throw new Error(`team task "${taskId}" not found`);
		return projectView(tasks, task);
	}

	async list(callerId: string, filter: TeamTaskListFilter = {}): Promise<TeamTaskView[]> {
		const tasks = await this.#read(callerId);
		return tasks
			.filter(task => task.status !== "deleted")
			.map(task => projectView(tasks, task))
			.filter(
				view =>
					(filter.status === undefined || view.status === filter.status) &&
					(filter.ready === undefined || view.ready === filter.ready),
			);
	}

	async update(callerId: string, req: TeamTaskUpdateRequest): Promise<TeamTaskMutationResult> {
		const rootId = rootAgentId(this.registry, callerId);
		return this.#transact(rootId, async () => {
			const session = await this.lifecycle().ensureLive(rootId);
			const { tasks } = deriveTasks(session.sessionManager.getEntries());
			const current = tasks.find(task => task.id === req.taskId);
			if (!current) throw new Error(`team task "${req.taskId}" not found`);
			if (current.status === "deleted") throw new Error(`team task "${current.id}" is deleted`);
			if (current.revision !== req.expectedRevision) {
				throw new Error(
					`stale team task "${current.id}" revision ${req.expectedRevision}; current revision is ${current.revision}`,
				);
			}
			const isRoot = callerId === rootId;
			const authorizeOwner = (): void => {
				if (!isRoot && current.ownerId !== callerId) {
					throw new Error("task mutation requires its owner or the root agent");
				}
			};
			let next: TeamTaskSnapshot;
			switch (req.op) {
				case "claim":
					if (current.ownerId !== undefined && current.ownerId !== callerId) {
						throw new Error(`team task "${current.id}" is owned by another member`);
					}
					if (current.status !== "pending" || !isReady(tasks, current)) {
						throw new Error(`team task "${current.id}" is not ready to claim`);
					}
					next = { ...current, status: "in_progress", ownerId: callerId };
					break;
				case "release":
					authorizeOwner();
					if (current.status !== "in_progress") throw new Error("only an in-progress task can be released");
					next = withoutOwner({ ...current, status: "pending" });
					break;
				case "edit":
					authorizeOwner();
					if (req.subject === undefined && req.description === undefined && req.writeScopes === undefined) {
						throw new Error("task edit requires subject, description, or write_scopes");
					}
					next = {
						...current,
						...(req.subject === undefined ? {} : { subject: requiredText(req.subject, "subject", SUBJECT_MAX) }),
						...(req.description === undefined ? {} : { description: optionalDescription(req.description) }),
						...(req.writeScopes === undefined ? {} : { writeScopes: normalizeScopes(req.writeScopes) }),
					};
					break;
				case "set_deps":
					authorizeOwner();
					if (req.blockedBy === undefined) throw new Error("set_deps requires blocked_by");
					next = { ...current, blockedBy: [...req.blockedBy] };
					break;
				case "complete":
					authorizeOwner();
					if (current.status !== "in_progress") throw new Error("only an in-progress task can complete");
					next = { ...current, status: "completed" };
					break;
				case "reopen":
					authorizeOwner();
					if (current.status !== "completed") throw new Error("only a completed task can reopen");
					next = withoutOwner({ ...current, status: "pending" });
					break;
				case "reassign":
					if (!isRoot) throw new Error("only the root agent can reassign tasks");
					if (current.status !== "pending" && current.status !== "in_progress") {
						throw new Error("only a pending or in-progress task can be reassigned");
					}
					if (req.owner === undefined) {
						next = withoutOwner({ ...current, status: "pending" });
						break;
					}
					this.#assertAssignable(req.owner, rootId);
					if (!isReady(tasks, current)) throw new Error(`team task "${current.id}" is not ready to claim`);
					next = { ...current, status: "in_progress", ownerId: req.owner };
					break;
				case "delete": {
					authorizeOwner();
					const dependent = tasks.find(
						task => task.status !== "deleted" && task.id !== current.id && task.blockedBy.includes(current.id),
					);
					if (dependent) throw new Error(`team task "${current.id}" still blocks "${dependent.id}"`);
					next = { ...current, status: "deleted" };
					break;
				}
				default:
					throw new Error(`unsupported team task operation "${String(req.op)}"`);
			}
			const task: TeamTaskSnapshot = { ...next, revision: current.revision + 1 };
			assertTaskGraph(tasks, task);
			session.sessionManager.appendCustomEntry(TEAM_TASK_CUSTOM_TYPE, task);
			await session.sessionManager.flush();
			const after = tasks.map(candidate => (candidate.id === task.id ? task : candidate));
			const before = readyIds(tasks);
			const newlyReady = [...readyIds(after)].filter(id => !before.has(id) && id !== task.id);
			return {
				snapshot: task,
				...(task.status === "deleted" ? {} : { task: projectView(after, task) }),
				newlyReady,
			};
		});
	}

	#assertAssignable(ownerId: string, rootId: string): void {
		const ref = this.registry.get(ownerId);
		if (!ref || ref.kind === "advisor" || ref.status === "aborted" || !isWithinTree(this.registry, ownerId, rootId)) {
			throw new Error(`agent "${ownerId}" is not reachable from this task board's root`);
		}
	}

	async #read(callerId: string): Promise<TeamTaskSnapshot[]> {
		const rootId = rootAgentId(this.registry, callerId);
		const session = await this.lifecycle().ensureLive(rootId);
		return deriveTasks(session.sessionManager.getEntries()).tasks;
	}

	async #transact<T>(rootId: string, op: () => Promise<T>): Promise<T> {
		const prior = this.#tails.get(rootId) ?? Promise.resolve();
		const run = prior.then(op, op);
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		this.#tails.set(rootId, tail);
		try {
			return await run;
		} finally {
			if (this.#tails.get(rootId) === tail) this.#tails.delete(rootId);
		}
	}
}
