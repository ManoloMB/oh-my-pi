Durable task board shared by every agent in this tree (root + subagents), persisted in the root session.
Ops: create, list, get, claim, release, edit, set_deps, complete, reopen, reassign, delete.
Workflow: list/get for the current revision → claim with `expected_revision` → work → complete. Every mutation except create needs `task_id` + `expected_revision`; a stale revision errors with the current one — reread and retry.
`blocked_by`: tasks that must complete first; claimable only when all are completed. `write_scopes`: advisory workspace-relative prefixes; overlap with another in-progress task warns, never blocks.
Only the owner or the root agent may release/edit/set_deps/complete/reopen/delete; only the root agent may reassign. Deleting a task that still blocks another fails.
Changes never wake a waiting agent or add to its inbox — `write agent://<id>` when someone must act now.
