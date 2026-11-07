Stage a change to one file of an omp skill: SKILL.md, a script, a reference or any other file in its directory. Nothing is written now: your staged changes to a skill become one proposal the user reviews, then approves or rejects. Calls on the same file build on each other. `file` is relative to the skill directory (default `SKILL.md`).
- Targeted change: exact `old_text` → `new_text`; `old_text` MUST match exactly once; empty `new_text` deletes it. To fix a wrong or vague passage, make it `old_text` and replace it; NEVER insert a caveat beside a passage that stays wrong.
- Restructure or rewrite: omit `old_text`; `new_text` is the whole new file, frontmatter included.
- New file: a `file` that does not exist, `old_text` omitted, `new_text` its content. A new script starting with `#!` is made executable.
- Delete a file: `delete: true` (never SKILL.md).
SKILL.md keeps its frontmatter `name`; `description` stays third person, ≤1024 characters; body ≤500 lines.
The result reports the file's line and word counts before your first edit and now, and the whole staged diff of that file: check that every intended change is in it and nothing else.
`summary`: one line for the user — what the skill will now get right.
`reason`: for the user — the evidence (transcript, the skill's own text, or a source you read) that makes this change an improvement.
