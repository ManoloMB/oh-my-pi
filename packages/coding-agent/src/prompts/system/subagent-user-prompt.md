Complete assignment thoroughly:

{{assignment}}
{{#if acceptanceCriteria.length}}

Acceptance criteria from the delegating agent (checked against the workspace and your recorded tool calls after you finish; address each one in your final result):
{{#each acceptanceCriteria}}
- {{this}}
{{/each}}
{{/if}}
