Plan approved at {{planFilePath}}. Plan mode exited; proceed with the implementation.{{#if autosaveFailed}} (Plan autosave failed; continuing.){{/if}}
{{#if todo}}
Before execution: initialize todo tracking with `todo`, one task per plan step.
After each completed step: immediately update `todo`.
{{/if}}
