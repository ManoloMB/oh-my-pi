{{baseDescription}}

Codex Code Mode is active: this tool is your primary work surface and the direct tool surface is restricted.
Plan multiple operations into ONE cell whenever the next steps are known, calling session tools via `await tool.<name>(args)`;
spawn independent calls without awaiting, then `await Promise.all([…])`. Prefer `tool.*` calls over raw `Bun.file`/fs so operations flow through the session tool pipeline.
Reserve separate cells for steps that must inspect earlier results.

A failed tool call rejects with `ToolCallError` (`toolName`, `text`, `details`); `try/catch` it to handle and continue.

exec tool declarations:
```ts
{{{declarations}}}
{{#if preludeDeclarations}}

{{{preludeDeclarations}}}
{{/if}}
```
