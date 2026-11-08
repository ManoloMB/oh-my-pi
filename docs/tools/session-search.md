# session_search

> Verbatim content search over past sessions, for agents without `eval` (where the same search is `archive.find`/`archive.open`).

## Source
- Entry: `packages/coding-agent/src/tools/session-search.ts`
- Views: `archiveFind`/`archiveOpen` in `packages/coding-agent/src/archive/archive.ts`
- Index: `packages/coding-agent/src/session/session-search/` (schema, extraction, incremental indexer, worker, query)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/session-search.md`

## Input and availability
`op: "find"` with `query` (optional `project` path or `"*"`, `limit` 1–25, default 8), or `op: "open"` with `id` (session id prefix or `.jsonl` path) and optional `line`.

Discoverable, shared, read-approved. Registered only when `archive.enabled` and `archive.contentSearch` are on and `eval` is unavailable or not requested; with `eval`, use `archive.find`/`archive.open` instead.

## Behavior
- Indexes user prompts, assistant text, tool calls and results, compaction/branch summaries and displayed custom messages of top-level sessions into `session-search.db` (separate from `history.db`; safe to delete). Thinking is indexed only with `archive.indexThinking`. Built-in credential patterns are redacted before storage.
- Indexing is incremental (only appended complete lines) and runs in a worker thread; each `find` spends a short budget first and reports `index catching up` when files remain. Interactive sessions warm the index in the background shortly after start.
- `find` ranks by BM25 × evidence type × recency, one row per session (current session excluded) with snippet, recap and an `open` hint. `open` returns a bounded transcript window around a JSONL line, or the session's end.
- `omp gc` drops indexed rows of archived sessions.
