<delegation-ledger>
Subagent work already delegated in this session, newest first. Your context no longer holds most of these results: reuse finished work through `agent://<id>` instead of delegating it again, and never re-delegate work marked running.
{{#each delegations}}
- [{{this.status}}] `{{this.agentId}}` ({{this.agent}}): {{this.description}}{{#if this.verification}} · criteria: {{this.verification.hold}} hold, {{this.verification.notHold}} not, {{this.verification.unverified}} unverified{{#if this.verification.citations}}; citations: {{this.verification.citations.resolved}}/{{this.verification.citations.cited}} resolved{{/if}}{{/if}}
{{/each}}
{{#if omitted}}
- … {{omitted}} older delegations omitted
{{/if}}
</delegation-ledger>
