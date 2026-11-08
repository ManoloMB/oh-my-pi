<task-result id="{{id}}" agent="{{agentName}}" status="{{status}}" duration="{{duration}}">
{{#if meta}}<meta lines="{{meta.lineCount}}" size="{{meta.charSize}}" />{{/if}}
{{#if abortReason}}
<abort-reason>{{abortReason}}{{#if resumable}} — the agent is still live with its full context; message it via `write agent://{{id}}` to resume instead of redoing the work.{{/if}}</abort-reason>
{{/if}}
{{#if error}}
<error>{{error}}</error>
{{/if}}
{{#if truncated}}
<preview full-output="agent://{{id}}">
{{preview}}
</preview>
{{else}}
<output>
{{preview}}
</output>
{{/if}}
{{#if verification}}
<verification note="execution evidence only; does not validate correctness">
{{#each verification.checks}}
- {{this.outcome}}: {{this.criterion}}{{#if this.detail}} — {{this.detail}}{{/if}}
{{/each}}
{{#if verification.citations}}
{{#if verification.citations.none}}
- citations: none cited
{{else}}
- citations: {{verification.citations.resolved}} resolved, {{verification.citations.failed}} failed, {{verification.citations.unknown}} unknown ({{verification.citations.cited}} cited)
{{/if}}
{{/if}}
</verification>
{{/if}}
{{#if mergeSummary}}
<merge-summary>
{{mergeSummary}}
</merge-summary>
{{/if}}
</task-result>
