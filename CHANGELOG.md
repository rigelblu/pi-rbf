---
title: Changelog
---

# 🔵⋯ [Unreleased]

---

# 🔵⋯ v0.33.0 (2026-11-05)
## 🟠⋯ Added for End Users
- 2026-11-05 - feat | choose native AGY model families and supported efforts through Pi's usual model controls, then run an ordinary task and same-conversation follow-ups directly through AGY, without operating AGY's own TUI. Install the four AGY files and fully restart Pi (#pi-21.1)
- 2026-11-05 - feat | read AGY answers as they stream, with the complete final answer kept in history. Interrupted, cancelled and over-limit output is marked `Incomplete AGY answer` (#pi-21.7)
- 2026-11-05 - feat | inspect the commands AGY ran and the output it reported in history, including after reopening Pi. Press `Ctrl+O` to expand and collapse them (#pi-21.8)
- 2026-11-05 - feat | resume the same AGY conversation after `/reload` or restarting Pi. Sessions saved before this release still can't resume and need `/new` (#pi-21.4)

## 🟠⋯ Fixed for End Users
- 2026-11-05 - fix | keep the AGY conversation going when other extensions write to the session, such as todos, monitor watches and `/cd`. Their entries no longer end it (#pi-21.4)
- 2026-11-05 - fix | start AGY from a folder you reached through a symlink. It used to refuse to start there (#pi-21.1)

## 🟠⋯ Changed for End Users
- 2026-11-05 - change | the footer's starting, running and stopping labels for AGY are gone (#pi-21.4)

---

# 🔵⋯ v0.32.1 (2026-11-22)
## 🟠⋯ Fixed for End Users
- 2026-11-22 - fix | click, drag, scroll or move the mouse over shell-command groups in Pi 1.6.0 without Pi exiting. The groups view no longer reads a private Pi field to route the mouse, and a fault in its own routing now turns the groups off with one warning instead of exiting Pi. Header and member clicks, links and drag-copy inside groups work as before on Pi 0.85.1 and 1.6.0. Update only `rbf-shell-command-groups.ts` and fully restart Pi. Known Pi 1.6.0 gaps outside the mouse: a session reopened after a mid-command kill miscounts its group (`#pi-59`). `v0.33.0` and `v0.33.1` were cut on the separate `#pi-21` stack, not on this line (#pi-57)

---

# 🔵⋯ v0.32.0 (2026-11-02)
## 🟠⋯ Added for End Users
- 2026-11-02 - feat | choose Fast, Standard or Codex default for a Codex-harness conversation with `/fast-codex`, keep the choice across resume and branches, and see `fast` or `standard` beside the model and thinking level. Global defaults stay unchanged. Explicit choices require Codex CLI 0.166.0 or newer; requested service does not guarantee speed, and higher usage may apply. Update only the Codex adapter and fully restart Pi (#pi-54)

---

# 🔵⋯ v0.31.4 (2026-10-28)
## 🟠⋯ Fixed for End Users
- 2026-10-25 - fix | resume saved Codex conversations containing Unicode line or paragraph separators. Fully restart Pi after updating the Codex adapter (#pi-10)

---

# 🔵⋯ v0.31.3 (2026-10-23)
## 🟠⋯ Fixed for End Users
- 2026-10-23 - fix (ux) | see Codex’s reported context usage, capacity and tokens remaining in Pi’s footer. Unavailable or stale figures read `context ? (Codex)` instead of the placeholder `0.0%/1000M (auto)`. Counts follow Codex reports; Codex keeps control of compaction. Update only the Codex adapter and fully restart Pi. Verified on Pi 0.85.1 and daily Pi 1.3.0, including a real Codex update and Tom’s interactive test (#pi-10.13)

---

# 🔵⋯ v0.31.2 (2026-10-20)
## 🟠⋯ Fixed for End Users
- 2026-10-20 - fix (ux) | keep announced Codex agents behind the `agents` footer until you choose to inspect them. Click the footer or use `/agents-codex` to open the full list; announcements, updates and restored snapshots no longer add an automatic roster above the editor. Saved freshness labels and native tool/dialog behavior remain available. Update the Codex adapter and fully restart Pi. Verified on Pi 0.85.1 and daily Pi 1.3.0; candidate-specific human visual check passed (#pi-10.12)

---

# 🔵⋯ v0.31.1 (2026-10-20)
## 🟠⋯ Added for End Users
- 2026-10-20 - feat | see announced Codex agents, their supplied assignments and last reported statuses in Pi. Open the full list from the agents footer or `/agents-codex`; saved branch snapshots read Last recorded until fresh evidence arrives. On supported direct Ghostty/cmux/Kitty terminals, the footer shows a hand pointer. Install the matching Codex adapter and fully restart Pi; individual child conversations and controls remain deferred. Preserves the v0.31.0 MCP/shell display (#pi-10.11)

---

# 🔵⋯ v0.31.0 (2026-10-20)
## 🟠⋯ Added for End Users
- 2026-10-20 - feat | see adjacent MCP/app calls and shell commands in one compact summary, with each recorded service’s name, call count and status. Expand to inspect the original calls; click an expanded member to close the whole group. Supplied friendly names are retained, with exact server/tool fallback for older records. Supported native MCP and Codex rows group; unsupported owners/renderers keep native rows. Update the grouping view and Codex adapter with their matching identity helper, then fully restart Pi. Verified on Pi 0.85.1 and daily Pi 1.3.0; all four human checks passed (#pi-52)

---

# 🔵⋯ v0.30.2 (2026-10-08)
## 🟠⋯ Fixed for End Users
- 2026-10-08 - fix (ux) | select visually wrapped transcript text and copy its original logical lines, without extra newlines or continuation indentation. Genuine line breaks, blank lines and selected source spaces remain. Supported fullscreen text, code and ordinary paragraphs use source-backed copying; unsupported renderers keep native copying. Install the copy extension with its matching path-label, clean-code and tool-indent files, then fully restart Pi. Verified on Pi 0.85.1 and 1.0.4; both physical clipboard checks passed, with leading spaces on the first multiline-control line explicitly accepted by Tom (#pi-50)

---

# 🔵⋯ v0.30.1 (2026-10-08)
## 🟠⋯ Improved for End Users
- 2026-10-08 - improve (ux) | collapse the whole shell group where you are reading: in fullscreen, one plain click on any expanded command or output immediately closes every member back to the count header. Header toggling and Ctrl+O remain available; drag selection and copy remain usable. Double/triple-click word/line selection inside a group is deliberately unavailable. Update only `rbf-shell-command-groups.ts` when the v0.27.0 execution owners are already installed, then restart Pi. Commands, results, task controls and saved history are unchanged. Verified on Pi 0.85.1 and 1.0.4; ordinary collapse and drag/copy passed human use. Remaining human checks were waived by Tomek; a test-only link fixture failed and does not establish native-link preservation in normal bash output (#pi-42.2)

---

# 🔵⋯ v0.30.0 (2026-10-08)
## 🟠⋯ Added for End Users
- 2026-10-08 - feat | use `/effort` as an alias for `/thinking`: bare `/effort` opens Pi's native thinking selector, and `/effort <level>` uses its native validation and session settings. Install `rbf-effort.ts`, then restart Pi or use `/reload`. A later custom editor replacement can disable the alias; use `/thinking` when its fallback notice appears. Verified on Pi 0.85.1 and 1.0.4, with human verification passed (#pi-51)

---

# 🔵⋯ v0.29.0 (2026-10-07)
## 🟠⋯ Improved for End Users
- 2026-10-07 - feat (ux) | see only user messages with `/rewind`: the native session tree opens with user messages first, so earlier prompts are visible without changing filters. Ctrl+U toggles the native user filter and Ctrl+O cycles filters; `/tree` keeps its configured filter. Native navigation and summary prompts remain available, and opening or cancelling saves no filter preference. Restart Pi after installation to replace the older rewind wrapper. Verified on Pi 0.85.1 and 1.0.4 (#pi-47)

---

# 🔵⋯ v0.28.0 (2026-10-07)
## 🟠⋯ Added for End Users
- 2026-10-07 - feat | have my Pi agent pick up a message or event meant for it after its turn has ended, without me prompting it: the agent arms a shell command with `monitor`, and each line it prints starts a turn or arrives mid-turn; `task_stop` stops it; `/monitors` lists and stops watches, and the footer shows how many run, as `1 watch`. Watches stop at their deadline, on a flood, and when Pi reloads, and the agent is told each time. `/cd` is refused while a watch runs. Not in a `--sandbox` session, and not for a `codex-harness` model (#pi-44.1)

---

# 🔵⋯ v0.27.0 (2026-10-06)
## 🟠⋯ Added for End Users
- 2026-10-06 - feat | scan agent shell activity as a command count and expand to inspect commands: shell commands an agent runs one after another now show as one line, such as `▸ ran 3 shell commands · 1 failed`, instead of a row per command. Click the line in fullscreen, or press Ctrl+O in either mode, to see the same command rows and results as before. The line names what needs attention while closed: `running`, `background` with its Task ID, `failed`, `cancelled`, `not run`. Covers Pi's own bash and Codex commands run through Pi. After you quit and reopen a session the groups read `status unknown`, because Pi no longer holds proof of how each command ended. A click on a command inside an open group does nothing, so links and text selection work as before. Needs three files installed together and a Pi restart. Unchanged: sandbox sessions, `!` and `!!` commands, nested calls, what runs and what is saved. Not yet run: `/rewind`, compaction, leaving a branch while a command runs, a sandbox session with running commands, light and monochrome themes, and telling a sub-agent's count from its parent's (#pi-42)

---

# 🔵⋯ v0.26.0 (2026-10-05)
## 🟠⋯ Added for End Users
- 2026-10-05 - feat (ux) | see how long ago I sent my last message in the status bar: the footer's token row now starts with `💬` and the age of your last message, as `💬 <1m` for the first minute, then minutes, hours and days. It updates once a minute and counts time away after a resume. A message you queue while Pi works keeps the earlier age on screen until Pi delivers it, then shows its own age with the wait included. `💬 ?` means the message's time could not be read. The cue hides when the token row has no room for it. Needs a full Pi restart to load; a Pi that was already running shows no cue and warns once to restart. Not yet run: opposite-order delivery of two queued messages, native dequeue, input held during compaction, and a Codex conversation (#pi-43)

---

# 🔵⋯ v0.25.0 (2026-10-05)
## 🟠⋯ Added for End Users
- 2026-10-05 - feat (ux) | tell at a glance which lines belong to which tool call or `!` command: the lines under a header hang 3 columns in, with one dim `└` on the first line. Covers shell, read, write and edit rows, Codex rows, and `!` rows, collapsed and expanded. Clicks and Ctrl+O work as before. Needs a full Pi restart to load. Known limit: a row that changes on every draw and holds non-ASCII lines costs 14 to 21 ms more per draw at 1,000 expanded lines

---

# 🔵⋯ v0.24.0 (2026-10-05)
## 🟠⋯ Added for End Users
- 2026-10-05 - feat | use `/cd` to change the active session's working directory: `/cd <path>` moves the running conversation to another directory without restarting Pi. The conversation, its session ID, the selected branch point, model and thinking level stay; from the next prompt the agent's tools, your `!` shell, the project rules and the footer use the new directory, and the conversation reopens there. Bare `/cd` shows the current directory. `/cd` refuses while a response, compaction, background task or `!` command is running and puts the typed command back in the editor. Not yet for Codex conversations, which are refused with a message; sandboxed and `--no-session` sessions can't move. The previous session file goes to the Trash. If a switch fails, Pi stops with the conversation intact and prints the command that reopens it

---

# 🔵⋯ v0.23.2 (2026-10-05)
## 🟠⋯ Fixed for End Users
- 2026-10-05 - fix (ux) | choose a thinking level in Pi and have Codex use that level: a Codex model now offers only the levels Codex can run (`low`, `medium`, `high`, and `xhigh` or `max` where the model supports them); `off` and `minimal` are no longer offered, and a saved `off` or `minimal` shows as the lowest supported level. Every Codex turn runs at the level Pi shows. Known limits: right after installing and `/reload`, a session still showing `off` gets one refused turn with `This thinking level is not available for this Codex model. Your message was not sent. Choose a level with /thinking, then send again.`; and Pi's thinking menu still describes levels with token budgets that do not apply to Codex (#pi-10.7)

---

# 🔵⋯ v0.23.1 (2026-10-05)
## 🟠⋯ Fixed for End Users
- 2026-10-05 - fix (ux) | stop Codex mid-turn and continue the same conversation: after Escape on a first or later turn, the next prompt starts exactly one new turn on the same verified Codex thread, also after reopening the branch; the stopped prompt is not replayed and no `/fork` or `/new` is needed. Failed, still-running, or unreadable Codex history still refuses the prompt. Known limits, fix planned as `pi-10.8`: a prompt sent before Codex has ended the stopped turn joins that turn and ends aborted (send it again), and a stopped turn that actually completed can be remembered on a sibling branch you move to. Stopping a command row still shows `This operation was aborted` (#pi-10.6)

---

# 🔵⋯ v0.23.0 (2026-10-04)
## 🟠⋯ Added for End Users
- 2026-10-04 - feat (ux) | select question-form answers with the mouse: click numbered choices, C or W without submitting; hover highlights temporarily and clears when the pointer leaves. Choices wrap in narrow panes, Write-in focuses immediately, notes survive switching, and Enter still submits (#pi-40.1)

---

# 🔵⋯ v0.22.0 (2026-10-04)
## 🟠⋯ Added for End Users
- 2026-10-04 - feat (ux) | read file references within the pane width while keeping filenames visible: long paths shorten in the middle and refit on resize; file links, `/copy`, and `/tree` keep the original targets and text. Commands, file contents, and approval text stay literal (#pi-39.1)

---

# 🔵⋯ v0.21.12 (2026-09-28)
## 🟠⋯ Added for End Users
- 2026-09-28 - feat (ux) | compact context in a bound Codex conversation with `/compact` without touching Pi's transcript: Pi intercepts `/compact` on `codex-harness` models before its native short-session guard, verifies the recorded branch against Codex history, and routes compaction directly to the bound Codex thread; instructions with `/compact` are safely rejected with the command preserved in the editor; ordinary prompts require Codex CLI >= 0.157.1 and fail closed when history cannot verify the branch (#pi-10.5) [@pi]

---

# 🔵⋯ v0.21.11 (2026-09-27)
## 🟠⋯ Fixed for End Users
- 2026-09-27 - fix (ux) | keep the footer, tool-row presentation, read cleanup, and fresh cache cues working after `/resume` or `/reload`; expired cache state stays out of the new module (#pi-34) [@pi]

---

# 🔵⋯ v0.21.10 (2026-09-27)
## 🟠⋯ Fixed for End Users
- 2026-09-27 - fix (ux) | edit question-form Write-in answers and optional notes with familiar Pi editor keys, insert a line with `Ctrl+J`, move through wrapped rows with Up, and submit only with Enter (#pi-36) [@pi]

---

# 🔵⋯ v0.21.9 (2026-09-27)
## 🟠⋯ Fixed for End Users
- 2026-09-26 - fix (ux) | reach the question form's final Write-in choice with `W` regardless of how many numbered answers were offered; `C` and the offered number keys keep their meanings (#pi-19.7) [@pi]

---

# 🔵⋯ v0.21.8 (2026-09-26)
## 🟠⋯ Fixed for End Users
- 2026-09-26 - fix (ux) | the question form's Write-in chip is now the last choice, after the canned `/convo-is-very-best` response — before, Write-in sat fourth and the canned response could not be reached with `→` at all, because arrowing onto Write-in jumped focus into its answer field; numeric and `C` shortcuts, focus rules, and submitted text are unchanged (#pi-19.5) [@pi]

---

# 🔵⋯ v0.21.7 (2026-09-26)
## 🟠⋯ 🔒 Security Fixes for End Users
- 2026-09-26 - fix | pasted terminal control characters no longer reach the terminal through the question form before submission; normal text, internal blank lines, and the submitted answer remain intact (#pi-19.4) [@pi]

---

# 🔵⋯ v0.21.6 (2026-09-23)
## 🟠⋯ Fixed for End Users
- 2026-09-23 - fix | pasting into the question form's write-in or notes field now works: the custom form silently dropped the terminal's bracketed-paste event before, so a paste had no effect at all; pasted text now inserts at the cursor, CRLF and lone CR normalize to newlines, internal blank lines survive to the submitted answer, and pasting while the option chips have focus moves focus into the answer field (#pi-19.4) [@pi]

---

# 🔵⋯ v0.21.5 (2026-09-23)
## 🟠⋯ Fixed for End Users
- 2026-09-23 - fix (ux) | long write-in answers in the question form no longer overflow the terminal pane — or crash it outright at widths under 74 columns: the form now wraps label and answer word-wise inside the border (like Pi's own editor), the cursor stays at its logical position across wraps and resizes, chips and hints clip at the right edge instead of throwing, and the submitted answer arrives byte-exact (#pi-19.3) [@pi]

---

# 🔵⋯ v0.21.4 (2026-09-15)
v0.21.3 was not cut: it is reserved for `#pi-11.2`, whose human lane is still pending.
## 🟠⋯ Added for End Users
- 2026-09-14 - feat (codex) | see every tool Codex calls as a Pi row: MCP servers, app connectors, and the code kernel that computer use runs through (the row shows Codex's title for the call and the JavaScript it wrote) draw like Pi's own tool rows, with the result behind Ctrl+O; when Codex wants to use an app on your Mac for the first time, Pi asks you in its own dialog with Codex's words, so computer use works through Pi (before this it was refused without a word); when Codex hands work to a sub-agent, that agent's commands, edits, and tool calls are rows prefixed with its name when Codex sends one (a code-mode model such as gpt-5.6-luna sends none, so those rows are untagged), its approvals ask you in Pi's dialog with the same prefix, and Escape ends the agent's turn along with yours (a command that was already running finishes on its own, as it always has) (#pi-10)

## 🟠⋯ Fixed for End Users
- 2026-09-15 - fix (codex) | a sub-agent spawned by a code-mode model (gpt-5.6-luna and -sol run `spawn_agent` inside their `exec` script) is announced only through the `collabAgentToolCall` item, which Pi did not read, so the agent's approvals were declined with the old notice and the agent gave up; Pi now admits every thread that item names and retires it when the item reports it done (#pi-10)
- 2026-09-14 - fix (ux) | a Codex row cut by Escape reads `Cancelled; command still running in Codex` instead of `Command aborted` (the command was never killed, in v0.21.1 either), Pi tells you once when such a command finishes, and a Codex MCP server that fails to start is named once in a notice (#pi-10)

---

# 🔵⋯ v0.21.2 (2026-09-14)
## 🟠⋯ Fixed for End Users
- 2026-09-14 - fix (ux) | see the provider on the model status line, like the footer: after `/model`, a picker pick, or a Ctrl+P model cycle, the status line reads `Model: (<provider>) <id>` / `Switched to (<provider>) <name>` whenever more than one provider is configured (#pi-31)

---

# 🔵⋯ v0.21.1 (2026-09-14)
## 🟠⋯ Added for End Users
- 2026-09-14 - feat (codex) | use Pi's normal conversation controls with Codex: every command and file change Codex runs is a Pi tool row you can expand, drawn like Pi's own bash and edit rows; when Codex asks before running something, answer Yes, Yes for this session, or No (which stops the turn so you can say what to do instead) in Pi's own dialog, and answer its clarifying questions the same way; fork or navigate the session and each branch keeps its own Codex memory; type while Codex works and it steers the running turn; paste an image on an image-capable Codex model (#pi-10)

## 🟠⋯ Fixed for End Users
- 2026-09-14 - fix (codex) | Escape cancels a Codex turn at once instead of after a 3 s wait and a restart (#pi-10)

---

# 🔵⋯ v0.21.0 (2026-09-13)
## 🟠⋯ Added for End Users
- 2026-09-13 - feat (codex) | use Codex's full agent harness through one Pi conversation: pick a `codex-…` model and effort in Pi's picker, see each command in the working line, keep the activity as thinking, watch the answer stream, Escape to cancel, and continue the same thread after reopening (#pi-10)

---

# 🔵⋯ v0.20.0 (2026-09-11)
## 🟠⋯ Added for End Users
- 2026-09-11 - feat (ux) | track session progress with todos (#pi-24)

---

# 🔵⋯ v0.19.0 (2026-09-10)
## 🟠⋯ Added for End Users
- 2026-09-10 - feat (ux) | see and cancel shell commands running in the background (#pi-29)

---

# 🔵⋯ v0.18.0 (2026-09-10)
## 🟠⋯ Added for End Users
- 2026-09-10 - feat (ux) | make command mode (i.e. using ! prefix) look different from input mode (#pi-28)

---

# 🔵⋯ v0.17.0 (2026-09-10)
## 🟠⋯ Added for End Users
- 2026-09-10 - feat | use /rename to name or rename the current Pi session (#pi-27)

---

# 🔵⋯ v0.16.0 (2026-09-10)
## 🟠⋯ Added for End Users
- 2026-09-10 - feat (ux) | use /rewind as an alias for /tree to navigate session branches (#pi-20)

---

# 🔵⋯ v0.15.0 (2026-09-10)
## 🟠⋯ Added for End Users
- 2026-09-10 - feat (ux) | use form to select answer to question (#pi-19)

---

# 🔵⋯ v0.14.1 (2026-09-10)
## 🟠⋯ Added for End Users
- 2026-09-10 - feat (ux) | support text objects ciw, diw, caw, daw (#pi-18.1)

---

# 🔵⋯ v0.14.0 (2026-09-10)
## 🟠⋯ Added for End Users
- 2026-09-10 - feat (ux) | use vim motions in input box (#pi-18)

---

# 🔵⋯ v0.13.0 (2026-09-10)
## 🟠⋯ Added for End Users
- 2026-09-10 - feat (ux) | see skills and slash commands standout in prompt as I type (#pi-14)

---

# 🔵⋯ v0.12.0 (2026-09-10)
## 🟠⋯ Added for End Users
- 2026-09-10 - feat (ux) | place the prompt cursor where I click in the prompt editor (#pi-7)

---

# 🔵⋯ v0.11.1 (2026-09-10)
## 🟠⋯ Added for End Users
- 2026-09-10 - fix (ux) | support CleanShot screenshot clipboard pastes with [Image #1] chip and multimodal delivery (#pi-3.1)

---

# 🔵⋯ v0.11.0 (2026-09-09)
## 🟠⋯ Added for End Users
- 2026-09-09 - feat (ux) | see short text (i.e. "Image 1") for pasted images instead of image path (#pi-3)

---

# 🔵⋯ v0.10.0 (2026-09-09)
## 🟠⋯ Added for End Users
- 2026-09-09 - feat (ux) | see on my status line what I see in claude code (#pi-17)

---

# 🔵⋯ v0.9.0 (2026-09-09)
## 🟠⋯ Added for End Users
- 2026-09-09 - feat | see when prompt cache reuse is no longer guaranteed (#pi-15.1)

---

# 🔵⋯ v0.8.0 (2026-09-09)
## 🟠⋯ Added for End Users
- 2026-09-09 - feat (ux) | see skills loaded blend into background (not stand out) (#pi-4)

---

# 🔵⋯ v0.7.0 (2026-09-09)
## 🟠⋯ Added for End Users
- 2026-09-09 - feat | use /clear to start a new chat (#pi-16)

---

# 🔵⋯ v0.6.0 (2026-09-09)
## 🟠⋯ Added for End Users
- 2026-09-09 - feat (ux) | see read file output and code blocks without markdown code fences and without extra blank line (#pi-11)
- 2026-09-09 - feat (ux) | syntax highlighting for TOML keys in teal and section headers in purple matching Claude Code (#pi-11)
- 2026-09-09 - fix (ux) | full-width pink/green diff background tinting with zero-dependency LCS word diff (#pi-6)

---

# 🔵⋯ v0.5.0 (2026-09-09)
## 🟠⋯ Added for End Users
- 2026-09-09 - feat (ux) | see only the first few lines of each edit at a glance, blend into background instead of standout (#pi-6)

---

# 🔵⋯ v0.4.0 (2026-09-09)
## 🟠⋯ Added for End Users
- 2026-09-09 - feat (ux) | see tools calls blend into background (not standout) in collapsed state (#pi-2.1)

---

# 🔵⋯ v0.3.0 (2026-09-09)
## 🟠⋯ Added for End Users
- 2026-09-09 - feat (ux) | see less vertical padding on my previous messages (#pi-1)

---

# 🔵⋯ v0.2.0 (2026-09-09)
## 🟠⋯ Added for End Users
- 2026-09-09 - feat | use /exit to quit pi (#pi-9)

---

# 🔵⋯ v0.1.0 (2026-09-08)
## 🟠⋯ Added for End Users
- 2026-09-08 - feat | set aside my current prompt and restore it intact (#pi-5)
