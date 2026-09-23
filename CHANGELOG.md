---
title: Changelog
---

# 🔵⋯ [Unreleased]

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
