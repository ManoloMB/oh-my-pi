# team_task

> Durable task board shared by every agent in one task tree (root + subagents): create, claim and complete tasks with dependencies.

## Source
- Entry: `packages/coding-agent/src/tools/team-task.ts`
- Board logic: `packages/coding-agent/src/task/team-board.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/team-task.md`
- Renderer: `packages/tui/src/tools/team-task.ts`

## Input and availability
`op` is one of `create`, `list`, `get`, `claim`, `release`, `edit`, `set_deps`, `complete`, `reopen`, `reassign`, `delete`. Optional fields: `task_id`, `expected_revision`, `subject`, `description`, `blocked_by`, `write_scopes`, `owner`, and the `list` filters `status`/`ready`. Missing per-op fields return an error naming them.

Discoverable (schema not in every request), exclusive, read-approved. Available when `task.team.enabled` (default on) and the agent can message peers: every subagent, and top-level sessions able to spawn (`task.maxRecursionDepth`). Subagents with an explicit tool allowlist gain it automatically unless their list is restricted.

## Behavior
- The board lives in the root session's log as `team_task` custom entries (never in LLM context); every read re-derives state from that log, so a resumed root sees the same board.
- Each mutation is compare-and-set on `expected_revision` and bumps the revision; a stale revision fails with the current one. Mutations on one tree are serialized, so concurrent claims yield exactly one owner.
- `claim` needs a pending task whose `blocked_by` tasks are all completed. Owner or root may `release`/`edit`/`set_deps`/`complete`/`reopen`/`delete`; only the root may `reassign` (target must be a live, non-advisor agent in the tree).
- `blocked_by` must reference existing, non-deleted tasks and stay acyclic; deleting a task that still blocks another fails. `write_scopes` are advisory workspace-relative prefixes: overlap with an in-progress task adds a warning, never blocks.
- At most `task.team.maxTasks` (default 256) non-deleted tasks per board.
- Results include a compact JSON view; mutations that unblock tasks name them. Changes never wake or message other agents — use `write agent://<id>`.
