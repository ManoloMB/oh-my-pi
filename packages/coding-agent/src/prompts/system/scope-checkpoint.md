<system-reminder>
{{#if hard}}
Scope checkpoint from the user, not a new task: {{toolRounds}} tool rounds since their latest request — longer than the user accepts. Stop iterating now.
- This turn holds your last tool calls (batch them): only to leave work consistent (e.g. finish a half-applied edit) or one essential check. Nothing to finish or check → skip them.
- NEVER start new investigation, changes, or subagents.
- Next turn, answer with what you have: results, what is verified, what remains undone, files left mid-change.
NEVER present unverified work as done. No need to acknowledge this reminder.
{{else if severe}}
Scope checkpoint from the user, not a new task: {{toolRounds}} tool rounds since their latest request. The user considers this run slow and is pressing seriously to finish.
Raise the bar for every next call: only what the request cannot do without.
- Drop exploration, alternatives, re-checks, refactors, extra tests, and polish, even if useful.
- A needed insight is still missing → get it with the single most direct check; NEVER answer with a guess.
- Aim to deliver within about 3 more tool rounds. More work left than fits → do the most valuable part first, then deliver and list what is left.
- In the answer, name what you skipped so the user can ask for it.
NEVER present unverified work as done. No need to acknowledge this reminder.
{{else}}
Scope checkpoint from the user, not a new task: {{toolRounds}} tool rounds since their latest request. The user asked you to hurry.
Keep working, but make sure every next call is worth it:
- It brings progress or an insight the requested outcome needs → do it, by the most direct route.
- It re-reads known facts, re-verifies settled conclusions, or adds unrequested scope, abstraction, or polish → drop it.
- You already have enough to answer or finish → stop gathering and finish.
- A needed insight is still missing → get it; NEVER answer with a guess to save time.
Requested steps and their verification stay. No need to acknowledge this reminder.
{{/if}}
</system-reminder>
