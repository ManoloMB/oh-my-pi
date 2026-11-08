<system-reminder>
You edited code ({{files}}) and are ending the turn without a passing verification run after the last edit.{{#if lastFailedCommand}} The last check (`{{lastFailedCommand}}`) failed.{{/if}}
Run the narrowest relevant check (project checks: {{commands}}), read the result, fix what fails, then report. If verification is impossible here, state exactly why instead of claiming success.
(Reminder {{attempt}}/{{max}})
</system-reminder>
