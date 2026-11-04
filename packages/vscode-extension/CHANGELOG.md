# Changelog

## [0.25.0]

### Added

- A background tasks button in the composer, shown while the chat has background jobs (commands, subagent tasks or eval cells MarIA Code left running), with a badge counting the running ones. Its popup lists each task with what it does, its status, how long it has run and, unfolded, its command and latest output; a running task can be cancelled from there. Finished tasks stay listed until your next request

### Changed

- In the history, the open chat is marked with a blue right arrow instead of a green dot, so it no longer looks like a chat that finished with new messages

## [0.24.0]

### Added

- A stopwatch button in the composer while MarIA Code works opens a scope checkpoint popup: how long it has been working on your request, how many turns it took and how many tool calls it made, and a choice of checkpoint — Light (hurry: every step must add something needed, no overengineering), Severe (only the essentials, deliver in about 3 rounds) or Hard (last tool calls only to leave nothing half-done, then answer with what it has). Confirming sends it as a hidden reminder that MarIA Code gets at its next step; omp no longer sends these checkpoints on its own

## [0.23.0]

### Changed

- The accent (send button, thinking, plan and subagent buttons, spinners, skill chips, picker checks) is now Unicaja green `#2bd125` in every theme, instead of yellow (teal in light themes)
- The empty chat shows the green MarIA Code logo with the Unicaja symbol
- A command still running, and the thinking step while the model thinks, show their step dot blinking grey instead of green; a command's dot turns green when it finishes successfully

### Fixed

- Approving a plan with "Approve and execute" now keeps the plan button lit and tracking the execution: the extension read the approval from the wrong place in omp's `xd://propose` result, so the button switched off as plan mode ended

## [0.22.0]

### Added

- Clicking a subagent in the subagent panel opens a popup with its requests: when each was answered, how long it took, tokens, cost, the first line of the answer and its tool calls (running, done, failed), with the request in progress highlighted and a row while the model is answering the next one
- After you approve a plan with "Approve and execute", the plan button stays lit with a done/total badge while omp implements it; clicking it shows the agent's steps by phase with the one in progress highlighted, plus Open plan, Stop tracking and New plan. Tracking ends at your next prompt once every step is closed, and is rebuilt from the session when you reopen it

### Changed

- The subagent panel no longer shows a completion estimate, time left or progress bar, and omp no longer asks subagents how far along they are: each card shows run time, requests, tools, tokens and cost

### Fixed

- The subagent panel keeps its scroll position with several subagents instead of jumping back to the top every second, and its Turn on/off and Hurry up buttons no longer miss clicks

## [0.21.0]

### Added

- When a chat's context passes 30% of the model's window, a card above the input offers Clean up (`/shake`), explaining what it removes, what it keeps and why it helps; it appears between turns only, and "Ahora no" silences it until the context drops below 30% and crosses it again

### Changed

- The empty chat (title, hint and example prompts) and the composer placeholders are now in Spanish
- The empty chat shows the new MarIA Code logo with the centered symbol

### Fixed

- Tool results, diff counts, finished-session dots and errors keep green and red under every color theme instead of taking the theme's git decoration and error colors

## [0.20.0]

### Changed

- Rebranded the extension as MarIA Code for Unicaja: new name, MarIA Code logo in the activity bar, chat header, empty chat, editor tabs and terminal, and "MarIA Code" in titles, commands, notifications and settings. The engine (`omp`), the `ompCustom.*` settings and command IDs are unchanged; the extension ID is now `maria-code` and the package `maria-code.vsix`, so uninstall "omp (custom)" before installing it

## [0.19.0]

### Added

- Delegate mode button (robot icon) next to Plan mode in the chat input: while on, omp splits each prompt into slices and runs them through subagents it picks per slice. Needs an omp build with `set_delegate_mode`
- While a task runs subagents, the delegate mode button shows how many are running; clicking it opens a panel with each subagent's status, task, current step, progress with estimated time left, and usage, plus the delegate mode switch and a "Hurry up" button that asks every running agent to wrap up

### Changed

- Chats without a workspace start omp with `--no-coding-guidance`, so they keep the general system prompt; "New chat" uses the coding prompt with a workspace snapshot. Needs an omp build that knows the flag

## [0.18.0]

### Added

- Messages omp sends to the model without showing them (scope checkpoints, todo reminders, rule injections…) now appear in the chat as muted, folded "Hidden" rows; expand one to read the exact text the model received
- History shows only the chats from the last 24 hours; a "Show N older chats" button under them unfolds the rest (a search always looks through every chat)

### Fixed

- History opened from a chat without a workspace now opens on the "No workspace" tab, also for a new chat that has no saved messages yet

## [0.17.0]

### Added

- Select text in one of omp's answers and click Reply to ask about it: the excerpt shows above the input box and the prompt is sent as a reply to that excerpt
- ↑ / ↓ in an empty input box recall the prompts sent in the open chat (skill invocations, file mentions, images and replies included), ready to send or edit
- History rows show a yellow pill counting the skill proposals awaiting a decision for that chat

### Changed

- The green badge on the History icon shows how many chats finished while you were away

### Fixed

- File links in chats without a workspace (relative to its folder, `~/…` or `local://…`) now open the file instead of reporting it missing

## [0.16.0]

### Added

- A small blinking green dot on the History icon while another chat has finished its task and you have not opened it yet, so you notice without opening History

### Changed

- The chat now uses the full width of the panel: widening the sidebar or editor tab no longer leaves empty margins on both sides of the messages and the input box
- The skill proposals button beside the session title only counts and lists the proposals made in the session you are viewing; switching to another chat no longer shows them. The Skills view still lists every pending proposal

## [0.15.0]

### Changed

- Skill self-improvement now asks before changing a skill: the button beside the session title counts omp's pending skill proposals (from every session) and opens them with omp's reason, the diff, Approve, Reject (with an optional reason omp learns from) and Open diff; the Skills view lists them under each skill with inline Approve / Reject. A proposal whose skill changed since shows as outdated and can only be discarded

### Fixed

- What local commands print in the chat (Clean up / `/shake`, Compact, `/session`…) no longer disappears when you leave the chat and come back or restart VS Code: it is kept per session and shown again where it appeared

## [0.14.0]

### Added

- A spinner beside the session title while omp reviews the skills the last task used; when it changed skills, a button in its place opens the edits with their diffs, a Revert button for each, and Dismiss

## [0.13.0]

### Added

- A spoken alert (`media/ask-alert.mp3`) plays when omp asks you questions or waits for a plan approval, and repeats every minute until you answer (`ompCustom.askAlertSound`: `always`, `windowUnfocused`, `off`)

### Fixed

- Prompts that invoke a skill (`/skill:<name> …`) can be edited and resent like any other prompt, including restoring the files omp changed since

## [0.12.0]

### Added

- A short system sound plays when omp finishes a task, so a task left running is noticed (`ompCustom.completionSound`: `always`, `windowUnfocused`, `off`)
- When omp corrects one of your skills after a task that tripped while using it, the chat shows a "Skill updated" row with the summary and diff, and a Revert button that undoes the edit (`omp skill revert`)
- Skills view: every skill omp discovers, with its source and whether omp may correct it ("self-improving"); each skill lists omp's edits to it, newest first. Click an edit to see its diff, revert it from its inline button; the view refreshes when the skill history changes

### Changed

- The context ring and its popover show token counts with one decimal (`13.4k` instead of `13k`)
- New chats without a workspace get an `AGENTS.md` that expects platform and operations work (cloud resources, dashboards, tickets, wiki pages, gateways, model registries through the matching skills) as much as general tasks

### Fixed

- The composer no longer shows below the History; it comes back with Back to chat or when a chat opens
- The context ring and its popover (context used, input/output tokens, cost) update after every reply and tool result while omp works, not only when the task ends

## [0.11.1]

### Changed

- History tabs: "This workspace" and "No workspace" are two separate buttons, and the selected one is highlighted in the accent color

### Fixed

- The pinned prompt of the open chat no longer shows on top of the History or the "Starting omp…" panel

## [0.11.0]

### Added

- Delete chats from the History: each row has a trash button next to its pencil; after a confirmation, the session file and its artifacts move to the trash, and a chat showing that session starts a new one
- History filter: two tabs under the search box, "This workspace" and "No workspace", each with how many chats match, show one group at a time instead of both lists; it opens on the open chat's group

## [0.10.1]

### Fixed

- The pinned prompt no longer overlaps prompts under it: the next prompt pushes it up and out as it reaches the top, and a prompt is pinned only once its bubble has left the view

## [0.10.0]

### Added

- Chats without a workspace: a globe `+` in the chat header opens a chat for general tasks that runs omp in its own folder (`ompCustom.noWorkspaceFolder`, default `~/omp-sin-workspace`) instead of the workspace, so the project's file tree, `AGENTS.md` and memory stay out of it. An `AGENTS.md` written there on first use (never overwritten) tells omp these chats are for general tasks. The header marks such a chat "No workspace"; the History lists these chats under their own heading, the same in every window; they take no file checkpoints; the Sessions view keeps listing the workspace's sessions

### Fixed

- The pinned prompt has the shape of its bubble: on the right, as wide as its text (up to the bubble's 85%) and with the same rounded corners, instead of a box stretched across the whole chat

## [0.9.2]

### Changed

- Sending a prompt no longer waits for the file checkpoint's git snapshot (a few git runs, slow on Windows with antivirus): the prompt goes to omp at once and the snapshot is taken alongside. If a tool starts before the snapshot is done, the snapshot is dropped and that prompt offers no file restore, so a checkpoint never holds omp's own changes

## [0.9.1]

### Changed

- Bash and shell tool rows (and background bash jobs) show the Bash logo instead of the `>_` terminal icon

## [0.9.0]

### Added

- Timeline, as in Claude Code: the steps of each turn (thinking, tool calls, the answer) hang from dots on a vertical line: green when a tool succeeded, red when it failed (or the reply ended in an error), pulsing amber while it runs, grey for thinking and text
- Pinned prompt: once a prompt's bubble scrolls out at the top, it stays pinned above the conversation, so the top shows the prompt of the turn in view (at the bottom, the latest one), the composer sits below, and the turn scrolls in between. Clicking it scrolls back to the prompt

## [0.8.2]

### Fixed

- `Ctrl+F` (`⌘F`) in the chat opened the code editor's find, which took the typing, while the chat's find bar appeared without focus. The chat now reports when it has keyboard focus and contributes a keybinding (`omp: Find in Chat`) that, while it does, sends the key to its own find bar

## [0.8.1]

### Fixed

- History's first and latest prompt now count `/skill:` invocations (and collab prompts), which omp stores apart from plain messages: a session whose first or latest prompt used a skill showed only its plain messages, often as a single "Only prompt". They show as typed (`/skill:name …`), and count in the Sessions view's message total

## [0.8.0]

### Added

- Word prediction in the composer, as in omp's terminal: the end of the word being typed shows in grey after the caret; `Tab` accepts it with a space, `→` without one, letters of it shorten it, anything else hides it. It uses omp's `predict_word` (engine set by `spelling.autocomplete`, learning from your prompt history), and accepted or ignored suggestions are reported back so it keeps learning

## [0.7.0]

### Added

- Find in chat: `Ctrl+F` (`⌘F` on macOS) opens a find bar that highlights every match in the conversation, with a "3/12" count, `Enter` / `Shift+Enter` (`F3`, `⌘G`) to move between matches, and folded thinking or tool rows unfolding to show the current one. It follows the conversation as it streams
- The History panel shows each session's first and latest prompt under its name ("Only prompt" when there is one); its search also matches them. The Sessions view tooltip and `omp: Switch Session…` show them too. In long sessions the latest prompt is found by reading the file from its end

### Fixed

- Sessions whose first prompt carries a large image no longer disappear from the History panel and the Sessions view

## [0.6.3]

### Fixed

- The company certificate is found on more machines: the OS store is read with the OS's own tools (PowerShell's certificate drive on Windows, the system keychain on macOS) instead of Node inside VS Code, which could return nothing, and the Netskope client's own CA files are added. The output channel logs how many certificates omp trusts this way. A remaining certificate error also names the last resort, `NODE_TLS_REJECT_UNAUTHORIZED: "0"` in `ompCustom.env`

## [0.6.2]

### Fixed

- Behind a company network that re-signs HTTPS with its own root certificate, omp failed with "self signed certificate in certificate chain" (for example signing in to Groq for voice input) even though the root is installed in the system. The extension now hands omp the certificates of the OS store (the Windows certificate store, or roots added to the macOS keychain) as `NODE_EXTRA_CA_CERTS`, unless you set that variable yourself; a certificate error that remains says how to add the company's certificate

## [0.6.1]

### Changed

- Voice input always transcribes through Groq's API: the option to download and run a local speech model is gone, and without a Groq key the microphone button only offers to sign in to Groq. Needs omp v18.9.1-custom.15 or later

## [0.6.0]

### Added

- Voice input: a microphone button in the composer (and the `omp: Toggle Voice Input` command) records what you say and inserts the transcript at the cursor. omp records the microphone natively and transcribes with Groq's Whisper (`groq/whisper-large-v3-turbo`, free tier with an API key) or its local model; without either, the first click offers to sign in to Groq or download the local model. While recording the button turns red with a timer; click it again to transcribe, `Esc` to drop the recording. `ompCustom.voiceLanguage` sets the spoken language (`auto` by default). Needs omp v18.9.1-custom.14 or later

## [0.5.4]

### Fixed

- Editing a prompt in a session that changed no files no longer offers to restore files another session (or you) changed while it was answering. Only turns in which the session's own file tools ran (edit, write, ast_edit, notebook, an applied LSP rename or code action) are restored; turns that only talked or ran shell commands are left out, so changes made only through commands are no longer offered for restore

## [0.5.3]

### Added

- A finished turn shows a small "Worked for 1m 23s" line under omp's last answer, also for earlier turns when a session is reopened (measured from the prompt to the last answer; messages sent while omp was working count toward the same turn)

### Changed

- The "Working" timer shows seconds past the first minute: `1m 05s` instead of `1m`, and `2h 03m` past the first hour

## [0.5.2]

### Fixed

- omp's own messages no longer look like prompts you sent. A finished background job showed its result (the `<system-notice>` omp hands the model) in a user bubble labelled "async-result"; it is now an activity row like the terminal's, "Background job completed bg_1 · bash · 650ms", that expands to the command and its output. Supervised process exits show as "Supervised process completed/failed" rows, and any other extension notice as a row named after its type

## [0.5.1]

### Fixed

- The "Working" timer shows how long the session on screen has been running. Switching between two sessions that both work kept the first one's timer, and going back to a working session restarted it from 0s; each session now keeps its own start time

## [0.5.0]

### Added

- Editing a prompt can restore the files omp changed since it ("Edit and Restore Files", also offered for the last prompt when it changed files). The extension snapshots every git repository of the workspace before each prompt that starts a turn and when the turn ends, and reverts only what changed inside omp's turns, shell commands included; changes you or other sessions made in between are kept, and files both changed on the same lines are listed so you pick which go back. A notification offers to undo the restore. Snapshots never touch branches, the index or history; git-ignored files (a venv, `node_modules`), untracked files over 10 MB and files outside git repositories are not covered. Prompts sent before this version, or while omp was working, have no snapshot. Needs git on the PATH; `ompCustom.fileCheckpoints` turns it off

## [0.4.0]

### Added

- Edit any prompt of the conversation: hover a message and click its pencil to edit it in place (`Enter` sends, `Esc` cancels). Editing the last prompt runs it again with the new text (a running turn is stopped first); editing an earlier one asks for confirmation and continues the session from it, removing the later messages from the conversation. The session stays the same (title, file); the removed turns remain in the session file on an abandoned branch, reachable from the terminal's `/tree`. Images of the message are sent again unchanged. Changes omp made to files are not undone. Needs omp with the `navigate_tree` RPC command (v18.9.1-custom.13 or later)

## [0.3.1]

### Changed

- Going back to a session you left while it was working no longer starts omp again: once its work is done, its process stays warm (up to 3 idle sessions, each for 10 minutes, the least recently used stopping first), so returning joins it at once instead of showing "Starting omp…"

## [0.3.0]

### Fixed

- Moving to another session (History, New chat, the Sessions view, `omp: Switch Session…`) no longer kills the turn running in the current one. Each session now runs in its own omp process: a session that is working keeps going in the background while you open, start, or prompt others, and switching back joins it live. Before, the chat reused one process for every session it showed, and omp's session switch aborted the running turn (the interrupted session could even be lost from disk)

### Added

- The Sessions view and the History panel mark each session's activity: a spinner while it works, a green dot once it finished while you were in another session (cleared when you open it)
- When a session in the background waits for a plan approval, a notification offers to show it

### Changed

- An idle process is reused in place when you switch sessions (no new start-up), and a background process stops once its work has settled; the session reopens from disk when you go back to it

## [0.2.4]

### Fixed

- The context ring and its popover update right after Clean up, Compact, Handoff or any other local slash command, instead of only after the next reply: the chat now re-reads the session when omp reports command output
- The popover's session numbers read as what they are: "Session totals · N requests" with "Input sent", "Output", "Cache read" and "Cache write", summed over every model request (each request sends the whole conversation again, so they grow far past the context window); a tooltip explains it

## [0.2.3]

### Added

- Clicking an image (a pasted attachment in the composer, or an image in the conversation) opens it enlarged over the chat on a dimmed backdrop; Escape, the close button, or a click outside the image closes it. Thumbnails are also reachable with Tab and open with Enter

## [0.2.2]

### Added

- Pasting an image (a screenshot or a copied picture) into the composer attaches it to the next prompt; attachments show as thumbnails above the text with a button to remove each one, and a prompt can be just images
- Rename chats from the chat: double-click the title (or its pencil on hover) to rename the open one, or use the pencil of any row in History to rename an older one

## [0.2.1]

### Fixed

- File links in answers open when the agent cites a path relative to the repository it works in (a subfolder of the open folder) or only a file name (`agent.md`): a path missing under the workspace folders is looked up anywhere in the workspace, opening the only match or asking which one when several match, instead of failing with "Unable to resolve nonexistent file"

## [0.2.0]

### Changed

- The chat is restyled after the Codex extension while keeping omp's π mark, accent colour, and braille spinner with turn timer
- Tool calls show as one-line activity rows ("Read …", "Edited … +N −M") that expand on click. `bash`/`shell` calls read "Bash" and `python`/`eval` calls "Code" (Python icon), titled by the call's purpose with the command or first line of code indented beneath, like the TUI's compact rows
- The assistant messages of one turn (each tool round trip is a message) are spaced like the blocks inside a message, so thinking, tool and answer rows sit evenly apart; a user message's Copy action appears beside its bubble on hover instead of under it, so every bubble sits at the same distance from the answer above and the reply below
- Model and reasoning moved from the header to a picker in the composer, next to a context-window ring; `+` in the composer attaches files as `@path` mentions
- History in the chat header opens a searchable session list inside the chat instead of a QuickPick
- The chat view's title bar has no icons; Open Chat in Editor moved to its `…` menu
- Clicking the context ring opens a popover with context usage, session tokens and cost, and Compact (`/compact`), Clean up (`/shake`) and Handoff (`/handoff`) buttons whose tooltips explain each
- A brain button in the composer expands or folds every thinking block of the session; with it off, thinking stays folded while it streams too (a shimmering "Thinking" row shows it is in progress) instead of opening until the message ends. Expanded thinking ends at its last line (the blank lines models append are trimmed)
- Reading a web URL shows as "Fetched <url>" with a globe icon, and the URL opens in the browser
- Code blocks are syntax-highlighted (highlight.js, VS Code Dark/Light Modern colors)
- `/new`, `/resume`, and `/settings` work in the chat (omp's RPC mode does not offer them; the chat runs them itself)
- A plan button in the composer (and `/plan`, `/plan <prompt>`) turns omp's plan mode on and off. The plan omp proposes appears in the chat as a card with the whole plan rendered, an Open in editor button (Markdown preview), and Approve and execute / Refine plan buttons; the proposal shows as a "Proposed plan" row. Needs an omp with RPC plan mode (this repo's `packages/coding-agent`); with older omp builds the button stays hidden
- Expanded `write` rows show the written content as text instead of escaped JSON
- Multi-line `select` prompts from omp open as a modal dialog with the options as buttons
- Tooltips are the chat's own (VS Code hover style): they appear after 350 ms, at once when moving between controls, and stay up while the chat refreshes, instead of the native `title` tooltip that took about a second and often did not show

## [0.1.2]

### Fixed

- A prompt that invokes a skill shows what you wrote, with the skill as a chip, instead of the whole SKILL.md; the skill's instructions sent to the model are folded below it, as in the terminal

## [0.1.1]

### Fixed

- Slash completion also opens mid-prompt: a `/` after a space lists skills (`/skill:name`, the commands omp expands anywhere in a prompt) and completes in place; at the start of the draft it still lists every command

## [0.1.0]

### Added

- Initial release: chat view and editor-tab chats driving `omp --mode rpc-ui`, a sessions view (open, rename, delete), model and thinking pickers, an omp settings editor backed by `omp config`, Add Selection/File to Chat, native dialogs for omp's `ask`/confirm/sign-in requests, provider login/logout, and an Open in Terminal command.
