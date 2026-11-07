{{#if hasAnchors}}
{{#xml "anchors"}}
Exact identifiers from the summarized history, verbatim, newest first.
{{#if errors}}
Errors:
{{errors}}
{{/if}}
{{#if hexIds}}
Hex ids: {{hexIds}}
{{/if}}
{{#if refs}}
Issue/PR refs: {{refs}}
{{/if}}
{{#if urls}}
URLs:
{{urls}}
{{/if}}
{{/xml}}
{{/if}}
{{#if userMessages}}
{{#xml "user-messages"}}
User messages from the summarized history, verbatim, oldest first{{#if omitted}} ({{omitted}} older omitted){{/if}}:
{{userMessages}}
{{/xml}}
{{/if}}
{{#xml "recovery"}}
{{recovery}}
{{/xml}}
