<system-reminder>
{{#if stateSummary}}
{{stateSummary}}
Alive → its definitions are still loaded; reuse them. Dead → redefine what a cell needs before running it. A script missing from the list may still be loaded.
{{else}}
No eval kernel is running in this process: variables and functions from earlier eval cells are gone.
{{/if}}
Results already in the transcript stay valid; use them without re-running anything. Redefine setup only right before eval code that needs it. NEVER guess variable values from this note. No need to mention it to the user.
</system-reminder>
