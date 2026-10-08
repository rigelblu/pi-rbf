---
title: "rbf-stash-prompt"
---

# 🔵⋯ Overview
Local Pi extension setting aside an unfinished prompt in the main editor with `Ctrl+S` and restoring or swapping it intact without persistent history or clipboard workarounds.

# 🔵⋯ Capabilities & Behavior

## 🟠⋯ Draft Operations
- Stash: when the editor contains non-empty text and the slot is empty, pressing `Ctrl+S` clears the editor, stores the text in runtime memory, and renders `Draft stashed · Ctrl+S restore` in dim text directly below the editor
- Restore: when a draft is stashed and the editor is empty or whitespace-only, pressing `Ctrl+S` restores the stashed text to the editor, empties the slot, and removes the below-editor status line
- Swap: when both the editor and the stash slot contain non-empty text, pressing `Ctrl+S` swaps them so neither draft is lost, keeping the below-editor status line visible
- Whitespace-only text: whitespace-only editor text (`text.trim().length === 0`) is treated as empty; if no stash exists, `Ctrl+S` is a silent no-op leaving whitespace untouched; if a stash exists, `Ctrl+S` restores the stashed draft, discards the whitespace, and empties the slot

## 🟠⋯ Memory & Boundaries
- Runtime-local state: stashed drafts live strictly in process memory inside the extension factory closure, never written to disk, session files, messages, or logs
- Lifecycle boundaries: every runtime replacement boundary—`/reload`, `/new`, `/resume`, `/fork`, and process exit—creates a fresh runtime and discards the in-memory stash slot
- Large paste expansion: restoration uses direct text replacement (`setEditorText`); mixed typed-and-pasted drafts remain fully visible, and large paste markers restore as visible expanded lines rather than collapsed paste markers
- Textual image paths: clipboard-pasted images appear as bare temporary file paths in editor text and travel with the prompt text intact

# 🔵⋯ Compatibility & Diagnostics

## 🟠⋯ Pi Version & Shortcuts
- Target version: verified against Pi 0.85.1
- Expected startup conflict warning: Pi reports `Extension shortcut conflict: 'ctrl+s' is built-in shortcut for … Using …` because `/resume`, `/model`, and `/thinking` define scoped keybindings for `Ctrl+S`
- Registration failure: if the diagnostic message ends with `Skipping.`, shortcut registration failed; quit Pi, remove conflicting copies, and ensure exactly one copy is loaded
- Unaffected picker actions: scoped pickers retain their built-in actions because the extension handles `Ctrl+S` only in the focused main prompt editor:
  - `/resume`: `Ctrl+S` toggles session sort mode
  - `/model`: `Ctrl+S` saves the highlighted model selection
  - `/thinking`: `Ctrl+S` saves the thinking level

# 🔵⋯ Setup & Verification

## 🟠⋯ Local Dogfood from Clean Checkout
Step-by-step verification:
1. Run `bun install`
2. Confirm Pi reports target version with `pi --version` (must report `0.85.1`)
3. Launch local extension with `pi -e ./extensions/rbf-stash-prompt.ts`
4. Type `alpha` in the main editor and press `Ctrl+S`; the editor clears and `Draft stashed · Ctrl+S restore` appears
5. Press `Ctrl+S` again; `alpha` returns and the status line disappears

## 🟠⋯ Global Installation
Installation after local verification:
1. Quit the active `-e` Pi session completely (`/quit`, or `Ctrl+D` when the prompt editor is empty)
2. Copy the extension to the global extensions directory with `mkdir -p ~/.pi/agent/extensions && cp ./extensions/rbf-stash-prompt.ts ~/.pi/agent/extensions/rbf-stash-prompt.ts`
3. Relaunch cleanly without `-e` using `pi`
4. Repeat the `alpha` stash and restore check, confirming exactly one status line appears
5. Never load explicit and global copies simultaneously; running `pi -e` while the global copy is present creates independent duplicate instances

## 🟠⋯ Removal & Rollback
Rollback procedure:
1. Delete the installed extension file with `rm -f ~/.pi/agent/extensions/rbf-stash-prompt.ts`
2. Run `/quit` and relaunch Pi, or run `/reload` in an active session; `Ctrl+S` returns to default editor behavior

# 🔵⋯ Fallbacks & Troubleshooting

## 🟠⋯ Diagnostic Recovery
Troubleshooting steps:
- Terminal flow control: if `Ctrl+S` does not reach Pi, disable software flow control in the launching shell with `stty -ixon`, and verify your terminal emulator or multiplexer does not bind `Ctrl+S`
- Registration skipped: if startup diagnostics report `Skipping.`, stop, quit Pi, remove duplicate or conflicting extension files, and relaunch with exactly one verified copy
- Duplicate copies: if two status lines appear, quit Pi completely, ensure only one copy exists between `-e` and `~/.pi/agent/extensions/`, and relaunch cleanly
- Unverified Pi version: if `pi --version` is not `0.85.1`, do not install globally; run `pi -e` locally and verify all automated and terminal scenarios before accepting compatibility

---

# 🔵⋯ rbf-exit

## 🟠⋯ Overview
Local Pi extension registering the `/exit` slash command to quit Pi cleanly, matching built-in `/quit` and standard shell muscle memory.

## 🟠⋯ Capabilities & Behavior
- Command registration: registers `/exit` with description `Exit pi`
- Immediate clean shutdown: calls `ctx.shutdown()`, which tears down the TUI, runs runtime cleanup, prints the session resume command, and exits process with code 0
- Argument tolerance: trailing arguments (e.g. `/exit now` or trailing spaces) are ignored without error
- No prompts: exits immediately without confirmation dialogs

## 🟠⋯ Setup & Verification
- Local verification: launch `pi -e ./extensions/rbf-exit.ts`, type `/exit`, press Enter
- Global installation: `cp ./extensions/rbf-exit.ts ~/.pi/agent/extensions/rbf-exit.ts`
- Removal: `rm -f ~/.pi/agent/extensions/rbf-exit.ts`

---

# 🔵⋯ rbf-user-message-padding

## 🟠⋯ Overview
Local Pi extension that compacts vertical padding on previous user messages by setting `paddingY: 0` on `UserMessageComponent`.

## 🟠⋯ Capabilities & Behavior
- Compact padding: replaces the default 1-row blank top and 1-row blank bottom cream background padding with 0, reducing a 1-line user prompt from 3 rows to 1 row
- Clean separation: preserves standard external terminal spacing (`Spacer(1)`) between the user message and subsequent assistant replies
- Horizontal padding: leaves `outputPad` (default 1) untouched so left margin alignment is preserved
- Idempotent: safe against multiple extension reloads without nested function wrappers

## 🟠⋯ Setup & Verification
- Local verification: launch `pi -e ./extensions/rbf-user-message-padding.ts`, enter a prompt, and observe the compact single-row background strip hugging the text
- Global installation: `cp ./extensions/rbf-user-message-padding.ts ~/.pi/agent/extensions/rbf-user-message-padding.ts`
- Removal: `rm -f ~/.pi/agent/extensions/rbf-user-message-padding.ts`

---

# 🔵⋯ rbf-tool-execution-blended

## 🟠⋯ Overview
Local Pi extension that blends collapsed tool executions into the terminal background by setting transparent fill (`bgFn = undefined`) and zero vertical padding (`paddingY = 0`) on `ToolExecutionComponent`, while restoring standard boxed card styling when expanded.

## 🟠⋯ Capabilities & Behavior
- Blended collapsed state: removes the full-width colored background box (`toolPendingBg`, `toolSuccessBg`, `toolErrorBg`) and top/bottom blank lines, reducing routine tool rows to subtle, unboxed lines hugging the text
- Framed expanded state: restoring standard `Box(1, 1, bgFn)` when a tool execution is expanded (`Ctrl+O` or click), cleanly containerizing multi-line output, diffs, and inspectable data
- Fallback tolerance: handles both renderer-defined tools and generic `contentText` fallbacks
- Idempotent: wraps `ToolExecutionComponent.prototype.updateDisplay` exactly once, guarded by a unique Symbol

## 🟠⋯ Setup & Verification
---

# 🔵⋯ rbf-edit-glance

## 🟠⋯ Overview
Local Pi extension that provides a clean, unboxed glance presentation for the `edit` tool matching Claude Code's diff UI: blends into the terminal background, displays an immediate line-count summary (`└  Added <A> lines, removed <R> lines`), caps collapsed diffs to 8 changed lines with an expansion hint, and highlights added and removed lines with subtle line-level background tints.

## 🟠⋯ Capabilities & Behavior
- Unboxed background: removes the solid colored card background and vertical padding from `edit` executions (`bgFn = undefined`, `paddingY = 0`, `paddingX = 0`), allowing edits to blend directly into the terminal background
- Line-count summary: calculates added and removed lines from the diff and displays `└  Added <A> line(s), removed <R> line(s)`, with two spaces after the `└`, immediately beneath the file path header
- Glance truncation cap: in collapsed mode (default), displays context lines plus up to 8 changed lines; diffs exceeding this cap append `... (<N> more lines, ctrl+o to expand)`
- Expanded full diff: pressing `Ctrl+O` or clicking expands the component to display the entire diff with all context and changed lines
- Line-level tinting: context lines remain plain with dim line numbers on transparent background; removed lines `-` receive subtle red background tinting with red text; added lines `+` receive subtle green background tinting with green text; single-line replacements retain word-level reverse video highlighting
- Idempotent: wraps `ToolExecutionComponent.prototype.updateDisplay` safely, guarded by a unique Symbol, and cleanly restores via `restoreEditGlance()`
- With `rbf-tool-parts-indent` loaded: the header moves right one column to line up with other tool rows, the summary and the diff hang under it, and the red and green tints start at the indented column and run to the pane's right edge. Without it the row draws at the left edge as before, apart from the summary's second space

## 🟠⋯ Setup & Verification
- Local verification: launch `pi -e ./extensions/rbf-edit-glance.ts`, execute a file edit, and observe the unboxed diff with summary line and line-level tinting
- Expand/collapse check: press `Ctrl+O` on a truncated edit diff to expand to full view, then press `Ctrl+O` again to return to glance mode
- Global installation: `cp ./extensions/rbf-edit-glance.ts ~/.pi/agent/extensions/rbf-edit-glance.ts`
- Removal: `rm -f ~/.pi/agent/extensions/rbf-edit-glance.ts`

---

# 🔵⋯ rbf-clear

## 🟠⋯ Overview
Local Pi extension registering the `/clear` slash command to start a new chat session cleanly, honoring Claude Code terminal muscle memory while matching native Pi `/new` behavior.

## 🟠⋯ Capabilities & Behavior
- Command registration: registers `/clear` with description `Clear conversation and start a new session`
- Official session replacement: calls `ctx.newSession()`, which persists the previous session transcript to `.pi/agent/sessions/`, resets the message tree, clears the chat container, and rebinds active extensions
- Visual confirmation: displays `✓ New session started` via `withSession` post-switch callback, matching native Pi `/new` feedback
- Argument tolerance: trailing arguments (e.g. `/clear now` or trailing spaces) are ignored without error
- No prompts: executes immediately without confirmation modals
- Zero dependencies: pure TypeScript extension using standard Pi extension APIs

## 🟠⋯ Setup & Verification
- Local verification: launch `pi -e ./extensions/rbf-clear.ts`, type `/clear`, press Enter
- Global installation: `cp ./extensions/rbf-clear.ts ~/.pi/agent/extensions/rbf-clear.ts`
- Removal: `rm -f ~/.pi/agent/extensions/rbf-clear.ts`

---

# 🔵⋯ rbf-skill-loaded-blended

## 🟠⋯ Overview
Local Pi extension that blends skill invocations directly into the terminal background by setting transparent fill (`bgFn = undefined`) and zero vertical padding (`paddingY = 0`) on `SkillInvocationMessageComponent`, presenting a compact, uncluttered Claude Code layout.

## 🟠⋯ Capabilities & Behavior
- Blended collapsed state: removes the solid colored card background box (`customMessageBg`) and top/bottom blank lines, reducing skill invocations to two unboxed rows:
  - Line 1: `● Skill(<name>)` with a green bullet (`success`), bold "Skill", and unbolded `(<name>)`
  - Line 2: `  └  Successfully loaded skill` with a muted branch symbol (`muted`) and muted status label
- Clutter removal: strips the redundant `[skill]` tag and `(Ctrl+O to expand)` hint from the collapsed view
- Clean expanded state: pressing `Ctrl+O` or clicking expands the component to display the same clean two-line header followed by a spacer and full unboxed markdown instructions
- Zero dependencies: pure TypeScript extension utilizing standard Pi extension APIs and component inheritance
- Idempotent: monkey-patches `SkillInvocationMessageComponent.prototype.updateDisplay` safely with symbol guard `Symbol.for("rbf.skillLoadedBlended.patched")` and provides `restoreSkillLoadedBlended()`

## 🟠⋯ Setup & Verification
- Local verification: launch `pi -e ./extensions/rbf-skill-loaded-blended.ts`, invoke a skill (e.g. `/skill:find-skills` or `/find-skills`), and observe the clean unboxed indicator
- Expand/collapse check: press `Ctrl+O` on the loaded skill row to expand full markdown instructions, then press `Ctrl+O` again to collapse
- Global installation: `cp ./extensions/rbf-skill-loaded-blended.ts ~/.pi/agent/extensions/rbf-skill-loaded-blended.ts`
- Removal: `rm -f ~/.pi/agent/extensions/rbf-skill-loaded-blended.ts`

---

# 🔵⋯ rbf-cache-guardian

## 🟠⋯ Overview
Local Pi extension that acts as a passive Cache Guardian for prompt-caching providers (Anthropic, OpenAI Codex, OpenAI): tracks the cache window from provider request start, renders a live status meter right-aligned inline on line 0 of Pi's footer (on the same row as the working directory and git branch), updates on a calm 1-minute cadence with a 5-pip draining progress bar, alerts at ≤ 10% remaining, and prompts to `/clear` stale history at 0m with Claude Code styled accent text.

## 🟠⋯ Capabilities & Behavior
- Inline footer placement: monkey-patches `FooterComponent.prototype.render` to place the status meter right-aligned on line 0 alongside the current working directory and git branch, consuming zero dedicated widget lines below the editor.
- 1-minute cadence with precision targeting: updates the countdown every 60 seconds (rendering as `${m}m`, e.g. `5m`, `4m`, `3m`, `2m`), switching to seconds when under 1 minute (`50s`, `30s`), and dynamically scheduling ticks so the exact critical alert boundary and 0m expiration deadline are hit precisely.
- Configurable cache TTL: resolves TTL from `settings.json` (`cacheTtl`, `cacheTtlMinutes`, or `cacheTtlMs`), supporting provider-level (`"openai-codex": "10m"`) or model-level overrides (`"openai-codex/gpt-5.6-terra": "15m"`), with built-in defaults:
  - Anthropic: 5 minutes (`300_000` ms)
  - OpenAI Codex (`openai-codex`): 10 minutes (`600_000` ms)
  - OpenAI (`openai`): 10 minutes (`600_000` ms)
- Multi-provider cache accounting:
  - Anthropic: uses provider-reported `cacheRead + cacheWrite`
  - OpenAI / Codex: uses provider-reported `cacheRead`; on Turn 1 cold start, automatically detects cached prompt prefix when `usage.input >= 1024` tokens
- Absolute window tracking: computes deadline from provider request start (`startedAt + totalTtlMs`), accurately accounting for model generation time, tool runs, and sleep/wake jumps
- Proportional footer sensory states:
  - Calm (> 30% remaining): muted text `5m TTL [█████] 182.6k cached` (or `10m TTL ...` on 10m)
  - Warning (≤ 30% remaining): yellow warning tint with `⚠️ 1m TTL [█░░░░] 182.6k cached` (or `⚠️ 3m TTL ...` on 10m)
  - Critical (≤ 10% remaining): red error tint with `🚨 30s TTL [░░░░░] 182.6k cached` (or `🚨 60s TTL ...` on 10m)
  - Elapsed (0m): Claude Code styled call-to-action `new task? /clear to save 182.6k tokens` with `/clear` and token count highlighted in accent color
- Dual notifications: triggers one terminal toast (`ctx.ui.notify`) and one macOS desktop notification (`pi.exec` via `/usr/bin/osascript`, with terminal bell fallback) once at the critical ≤ 10% boundary (e.g. 30s for 5m TTL, 60s for 10m TTL)
- Safe lifecycle invalidation: automatically clears timers, advances epochs, and clears active footer state on user input, session switch, compaction, tree navigation, model change, or thinking level change
- Passive operation: makes zero background provider completions and registers no keep-alive commands

## 🟠⋯ Setup & Verification
- Configuration (optional): add `"cacheTtl": { "anthropic": "5m", "openai-codex": "10m" }` to `~/.pi/agent/settings.json`
- Local verification: launch `pi -e ./extensions/rbf-cache-guardian.ts`, run a prompt against Anthropic or Codex, and observe the live countdown inline and right-aligned on footer line 0
- Global installation: `cp ./extensions/rbf-cache-guardian.ts ~/.pi/agent/extensions/rbf-cache-guardian.ts`
- Removal: `rm -f ~/.pi/agent/extensions/rbf-cache-guardian.ts`

---

# 🔵⋯ rbf-status-line

## 🟠⋯ Overview
Local Pi extension that brings parity with Claude Code's status line to Line 1 of Pi's interactive terminal footer: displays directory name, repository root, Jujutsu workspace or Git worktree identity, cross-worktree agent divergence warnings, nearest ancestor bookmarks, and parent change ID (`📁 <dir_name> | 📦 <repo_name> | <tree_label> [| 🌴 <agent_tree>] [| 🏷️  <branch>] @<commit> [• <session_name>]`), while preserving Pi's native Line 2 token/cache/cost metrics and Line 3 extension statuses.

## 🟠⋯ Capabilities & Behavior
- Formatted status line: replaces Line 1 (`pwdLine`) with Claude Code status line components:
  - `📁 <dir_name>`: current working directory basename
  - `📦 <repo_name>`: repository root name (via `jj root` or `git rev-parse --show-toplevel`)
  - `<tree_label>`: ` main` for default workspace, ` wt:<name>` for secondary worktrees/workspaces, plus ` ⚠stale` if the Jujutsu workspace is stale
  - `🌴 <agent_tree>`: reads `~/.claude/agent_tree.state`; if modified within 30 minutes and writing outside the current repository root (excluding `rb-drive`), flags divergence
  - `🏷️  <branch>`: nearest ancestor bookmark from `jj log -r 'latest(ancestors(@) & bookmarks())' -T 'bookmarks'` (or git branch)
  - `@<commit>`: shortest parent change ID from `jj log -r @- -T 'change_id.shortest()'` (or git commit)
  - `• <session_name>`: preserves session name if set via `/name`
- Preserves native metrics: keeps Pi's Line 2 (cumulative tokens, cache reads/writes, cost, context percentage, model, thinking level) complete, and Line 3 (extension statuses) untouched
- Last-message age (v0.26.0): Line 2 starts with `💬 <age> | `, the time since your newest delivered message on the current branch: `<1m` for the first minute, then `Nm`, `Nh`, `Nd`. It updates once a minute, reads the message's saved timestamp, so time away counts after a resume, and shows `💬 ?` when that timestamp cannot be read or is in the future. A queued message keeps the earlier age until Pi delivers it. The cue takes cells only from the padding before the model name, never widens the row, and hides when fewer than two padding cells would remain. TUI mode only: print and RPC modes draw nothing and send no status request
- First install of the age cue needs a full Pi restart. A Pi that still holds the footer wrapper from before v0.26.0 shows no cue and warns once: `Last msg needs a Pi restart to appear.` Roll back by restoring the previous file and restarting; `/reload` does not roll back across that boundary
- Session lifecycle continuity: after `/resume`, a same-type session switch, or `/reload`, background-tasks and todos release their footer hooks without replacing this extension's wrapper; the rich workspace row and native metrics row stay in place. Fresh extension modules keep the established collapsed tool blending, fenced-read cleanup, edit glance, cache-guardian state, and status-line cache binding; an old cache window disappears on shutdown and reappears only after a new eligible turn
- Seamless Cache Guardian integration: coordinates with `rbf-cache-guardian` to right-align the passive cache guardian countdown on Line 0 alongside the status line
- Sub-millisecond TUI rendering: in-memory caching with 2-second TTL ensures zero subprocess latency during typing or streaming responses, invalidating reactively on session, turn, and bash events
- Zero external dependencies: pure TypeScript extension utilizing standard Node built-ins (`node:child_process`, `node:fs`, `node:path`, `node:os`), `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui`

## 🟠⋯ Setup & Verification
- Local verification: launch `pi -e ./extensions/rbf-status-line.ts` and inspect Line 1 of the footer (e.g. `📁 pi-rbf | 📦 pi-rbf |  main | 🌴 .claude @mm`)
- Resume verification: launch `pi -e ./extensions/rbf-background-tasks.ts -e ./extensions/rbf-todos.ts -e ./extensions/rbf-status-line.ts -e ./extensions/rbf-cache-guardian.ts`, name two sessions with `/name`, then `/resume` the earlier one; the first row keeps `📁 … | 📦 … • <resumed name>` and the native usage/model row remains below it. A `/reload` verification should also show familiar collapsed tool rows and no stale cache countdown before a fresh eligible turn
- Subdirectory check: `cd extensions` and observe `📁 extensions | 📦 pi-rbf |  main | 🌴 .claude @mm`
- Global installation: `cp ./extensions/rbf-status-line.ts ~/.pi/agent/extensions/rbf-status-line.ts`
- Removal: `rm -f ~/.pi/agent/extensions/rbf-status-line.ts`

---

# 🔵⋯ rbf-image-short-text

## 🟠⋯ Overview
Local Pi extension that shows clean, numbered short text chips (e.g. `[Image #1]`, `[Image #2]`) in the prompt editor when pasting images from the clipboard instead of verbose temporary filesystem paths (`/tmp/pi-clipboard-...png`), and delivers images natively as multimodal attachments (`ImageContent`) upon prompt submission.

## 🟠⋯ Capabilities & Behavior
- Compact Image Chips: clipboard image pastes (`Cmd+V` / `Ctrl+V`) insert `[Image #1]` at the cursor, keeping the editor concise, readable, and free of noisy temporary path clutter.
- Sequential Turn-Local Numbering: consecutive pastes in the same prompt allocate sequential integers (`[Image #1]`, `[Image #2]`). If a chip is deleted, the lowest unused integer is reused. Counter and active memory reset per prompt turn.
- Native Multimodal Delivery: on prompt submission, the extension intercepts the `input` event, finds all `[Image #N]` tokens in the prompt text, attaches their base64 image data as native multimodal `ImageContent` to the user message, and leaves the `[Image #N]` label in the prompt text. The model sees the visual image directly without needing an intermediate `read` tool call.
- Deletion Resilience: if the user deletes `[Image #1]` from the prompt text before submitting, only images whose chips remain present in the text are attached to the turn.
- Strictly Scoped to Clipboard Images: temporary clipboard files created by terminal emulators (e.g. Ghostty, iTerm2, WezTerm via `clipboard-*`), native paste (`pi-clipboard-*`) in system temporary directories, and CleanShot X screenshot captures (`~/Library/Application Support/CleanShot/media/` or `CleanShot` prefix) are intercepted. Explicitly typed file paths and plain text pastes remain completely untouched.
- Zero External Dependencies: implemented purely using Node standard modules (`node:fs`, `node:path`, `node:os`, `node:crypto`) and `@earendil-works/pi-coding-agent`.

## 🟠⋯ Setup & Verification
- Local verification: launch `pi -e ./extensions/rbf-image-short-text.ts`, copy an image to the clipboard, press `Cmd+V` or `Ctrl+V`, and verify `[Image #1]` appears.
- Global installation: `cp ./extensions/rbf-image-short-text.ts ~/.pi/agent/extensions/rbf-image-short-text.ts`
- Removal: `rm -f ~/.pi/agent/extensions/rbf-image-short-text.ts`

---

# 🔵⋯ rbf-click-cursor

## 🟠⋯ Overview
Local Pi extension that places the prompt cursor exactly where clicked with the mouse in fullscreen TUI mode (`tuiMode: "fullscreen"`), repaints the terminal screen immediately without waiting for a subsequent keypress, and prevents stray text selection highlight boxes from appearing on simple clicks.

## 🟠⋯ Capabilities & Behavior
- Instant Click Placement: clicking anywhere within single-line or multiline prompt text immediately repositions the text insertion cursor to the clicked line and column.
- Immediate Screen Repaint: returns `{ handled: true, focus: true, render: true }` and calls `tui.requestRender()` so the cursor marker visibly jumps instantly on mouse down (`press`) without requiring an extra keypress.
- Stray Selection Prevention: intercepts mouse `"press"` events on the editor so `TuiAltScreen` does not fall through to global screen-level text selection during normal click navigation.
- Boundary & Padding Aware: properly accounts for horizontal editor padding (`paddingX`), snaps clicks past the line end to the line length, and clamps clicks before the first character to column 0.
- Unicode & Emoji Support: accurately tracks multi-column grapheme boundaries (`visibleWidth`) so clicking on or around fullwidth emojis and wide characters positions the cursor cleanly.
- Autocomplete Compatibility: forwards clicks on active autocomplete dropdown menus directly to `autocompleteList.handleMouse`, ensuring slash command and file completions remain fully clickable.
- Broad Subclass Inheritance: patches base `Editor.prototype.handleMouse`, allowing custom editors (such as `CustomEditor` and future modal/vim editors) to inherit mouse cursor placement automatically.
- Idempotent Lifecycle: provides `applyClickCursor()` and `restoreClickCursor()` functions keyed with unique symbols to ensure safe loading and unpatching.

## 🟠⋯ Setup & Verification
- Local verification: launch `pi -e ./extensions/rbf-click-cursor.ts`, type a multiline prompt, and click anywhere in the text to reposition the cursor.
- Global installation: `cp ./extensions/rbf-click-cursor.ts ~/.pi/agent/extensions/rbf-click-cursor.ts`
- Removal: `rm -f ~/.pi/agent/extensions/rbf-click-cursor.ts`

---

# 🔵⋯ rbf-standout-commands

## 🟠⋯ Overview
Local Pi extension that provides inline syntax highlighting for registered slash commands (`/clear`, `/model`) and skills (`/skill:<name>`) in the prompt editor as you type, matching Claude Code's visual polish while maintaining strict registry validation and zero shift to prompt borders or cursor mechanics.

## 🟠⋯ Capabilities & Behavior
- Inline Token Highlighting: recognized slash commands (e.g. `/model`, `/clear`, `/exit`) and `/skill:<name>` tokens highlight in theme link/keyword blue (`mdLink` / `foam` / `pine`) as you type, whether starting a line or appearing inline within a prompt sentence.
- Strict Registry Validation: only tokens matching explicitly registered built-in slash commands, extension commands, prompt templates, or installed skills are highlighted. Unrecognized tokens (`/not-a-command`) or partial typos remain unstyled plain text.
- File Path Protection: filesystem paths containing multiple slashes (e.g. `/usr/local/bin`, `/tmp/file.txt`, `src/index.ts`) are never highlighted as commands.
- Cursor & ANSI Safety: ANSI color codes are applied strictly within visual display strings without altering `visibleWidth` or line padding. Cursors landing inside, before, or after highlighted tokens retain crisp inverse styling (`\x1b[7m...\x1b[0m`) and zero ANSI color leakage.
- Pi `/skill:` Convention: respects Pi's skill naming convention (`/skill:<name>` and `skill:<name>`).
- Subclass Inheritance: patches `Editor.prototype.render`, automatically covering both standard `Editor` and `CustomEditor`.
- Idempotent Lifecycle: provides `applyStandoutCommands()` and `restoreStandoutCommands()` functions keyed with unique symbols for safe loading and unpatching.

## 🟠⋯ Setup & Verification
- Local verification: launch `pi -e ./extensions/rbf-standout-commands.ts`, type `run this /skill:convo-one-at-a-time after` or `/model gpt-5.6-luna`, and observe the vivid blue syntax highlighting.
- Global installation: `cp ./extensions/rbf-standout-commands.ts ~/.pi/agent/extensions/rbf-standout-commands.ts`
- Removal: `rm -f ~/.pi/agent/extensions/rbf-standout-commands.ts`

---

# 🔵⋯ rbf-vim

## 🟠⋯ Overview
Local Pi extension that adds familiar Vim modal navigation and editing in Pi's prompt input, toggleable via `/vim`, with zero external dependencies, persistent settings, bottom-border mode badge, and strict double-`Esc` safety.

## 🟠⋯ Capabilities & Behavior
- Modal State Machine: Starts in `insert` mode by default for standard typing. Pressing `Esc` transitions to `normal` mode.
- Strict Double-`Esc` Safety: Swallows `Esc` in `normal` mode, clearing pending operators/counts without ever calling `super.handleInput` or triggering `app.interrupt` (preventing accidental agent aborts). When autocomplete dropdown is open, `Esc` dismisses autocomplete first.
- Direct Enter Submission: Pressing `Enter` in either `insert` or `normal` mode immediately submits the prompt.
- Full Motion Vocabulary:
  - Character navigation: `h`, `j`, `k`, `l` (plus arrow keys)
  - Word motions: `w` (forward word start), `b` (backward word start), `e` (word end)
  - Line boundaries: `0` (column 0), `^` (first non-blank), `$` (end of line)
  - Buffer boundaries: `gg` (first line), `G` (last line)
  - Character find: `f<char>` (find forward), `F<char>` (find backward), `;` (repeat find), `,` (reverse find)
- Full Operator & Verb Vocabulary:
  - Deletion: `x` (char under cursor), `X` (backspace), `dd` (delete line), `dw` / `de` (delete word forward), `db` (delete word backward), `D` / `d$` (delete to line end), `d0` / `d^` (delete to line start)
  - Change: `cc` (clear line & enter insert), `cw` / `ce` (change word), `cb` (change word backward), `C` / `c$` (change to line end), `c0` / `c^` (change to line start)
  - Replacement: `r<char>` (replace character under cursor and remain in normal mode)
  - Undo: `u` (undo last change via editor's undo stack)
  - Yank & Paste: `yy` (yank line), `yw` (yank word), `y$` (yank to line end), `p` (paste below/after), `P` (paste above/before)
  - Insertion Entry Points: `i` (insert before cursor), `I` (insert at first non-blank), `a` (append after cursor), `A` (append at end of line), `o` (open newline below), `O` (open newline above)
  - Text Objects: Supports inner (`i`) and around (`a`) text objects under operators `d`, `c`, `y`: word (`w`), quotes (`"`, `'`, `` ` ``), parentheses (`(`, `)`, `b`), brackets (`[`, `]`), braces (`{`, `}`, `B`), and angle brackets (`<`, `>`). Nested pairs, count multipliers (e.g. `2diw`), and quote jump-ahead supported.
  - Count Multipliers: Numerical prefixes (`2w`, `3dd`, `5x`, `2j`, `2diw`) repeat motions and verbs.
- Bottom Border Mode Badge: Overrides `renderBottomBorder(width, hiddenLineCount)` to embed ` NORMAL ` (yellow) or ` INSERT ` (dim) directly into the bottom frame without layout shifts or colliding with autocomplete popups.
- Runtime Toggle & Persistence: `/vim` command toggles modal editing on/off (`/vim`, `/vim on`, `/vim off`), persisting `"editorMode": "vim"` directly to `~/.pi/agent/settings.json`.
- Zero External Dependencies: Built purely using Node standard modules (`node:fs`, `node:path`, `node:os`) and `@earendil-works/*`.

## 🟠⋯ Setup & Verification
- Local verification: launch `pi -e ./extensions/rbf-vim.ts`, type `/vim on` or press `Esc`, and navigate the prompt box using standard vim motions.
- Global installation: `cp ./extensions/rbf-vim.ts ~/.pi/agent/extensions/rbf-vim.ts`
- Removal: `rm -f ~/.pi/agent/extensions/rbf-vim.ts`

---

# 🔵⋯ rbf-question-form

Mouse selection and temporary hover feedback are available locally in v0.23.0.

Hover highlights the chip under the pointer without selecting it; moving away clears it. The selected answer retains its distinct filled highlight.

## 🟠⋯ Overview
Local Pi extension providing an inline, non-modal selector at the prompt line for agent questions with numbered options. Keeps recommendation and framing context in the transcript above as readable markdown, letting users pick an offered answer with its number key (`1`–`9`), the canned reply with `C`, or Write-in with `W`.

## 🟠⋯ Capabilities & Behavior
- Transcript Separation: The agent's full question, recommendation text, user need framing, and context paragraphs stay in the transcript as regular markdown. Only the numbered options appear in the compact interactive form.
- Input Box Overlap: Uses `ctx.ui.custom()` to temporarily occupy the input box area directly, eliminating double borders and visual separation.
- Compact Number Selection: Renders compact chips with the final fallback last — numbered answers, then `[ C. /convo-is-very-best ]`, then `[ W. Write-in ]` — without repeating the full text that already sits right above in the transcript.
- Write-in Last: Write-in is always the rightmost chip and the final `→` traversal stop, after the canned response; selecting it moves focus into its answer field. `Tab` returns to the chips from any answer row; `↑` returns only from the first visual row.
- Dark Background & Light Text: The active selection chip is highlighted with a prominent dark background and bold bright white text.
- Additional Notes Input: Embedded `Add notes to selection:` field allows typing extra instructions or modifications to append to the chosen option before submitting.
- Write-in Option: Press `w` or `W` while the chips are focused to select the final `W. Write-in` chip and focus its required answer field. The old generated number does not select Write-in. Once the field has focus, `w` and `W` type normally. Long answers wrap word-wise inside the pane (like Pi's own editor), with a constant one-column cursor reservation, an inverse cursor that covers the whole grapheme at the insertion point, and chips/hints that clip at the right edge — the submitted text is always byte-exact.
- Terminal Paste: Pasting into the write-in or notes field (from chips or field focus) inserts clipboard text at the cursor, preserves internal blank lines, and removes terminal control characters before rendering or submission.
- Canned Reply: Quick chip `[ C. /convo-is-very-best ]` (or pressing `c` / `C`) immediately selects `/skill:convo-is-very-best` (with optional notes).
- Accidental ESC Recovery: If dismissed with `Esc`, the options are cached. Typing `/answer-question`, or pressing `Ctrl+Q`, re-opens the selector instantly.
- Keyboard Navigation & Controls:
  - Chip focus (`options`):
    - `1`–`9`: Select matching numbered answer
    - `c` / `C`: Select canned reply
    - `w` / `W`: Select Write-in and focus answer field
    - `←` / `→` or `h` / `l`: Move selection between chips
    - `Tab` or `↓` / `j`: Move focus down to answer/notes field
    - `Enter`: Confirm and submit selected option (blocks if Write-in is empty)
    - `Esc`: Dismiss selector without submitting
  - Field focus (`notes`):
    - Configured Pi editor key families (respects `~/.pi/agent/keybindings.json` via active keybindings manager):
      - Character & word navigation: `←` / `→` or `Ctrl+B` / `Ctrl+F` (char left/right), `Alt+B` / `Alt+F` (word left/right), `Home` / `End` or `Ctrl+A` / `Ctrl+E` (logical line start/end)
      - Deletion: `Backspace` / `Ctrl+H` (char left), `Delete` / `Ctrl+D` (char right), `Ctrl+W` / `Alt+Backspace` (word left), `Alt+D` (word right), `Ctrl+U` (delete to line start), `Ctrl+K` (delete to line end; deletes newline when at line end)
      - Kill ring & undo: `Ctrl+Y` (yank), `Alt+Y` (yank-pop to cycle kill ring), `Ctrl+-` / `Ctrl+_` (undo)
    - Visual row multiline navigation:
      - `↑` (Up): traverses earlier visual (wrapped) rows; pressing `↑` on the first visual row returns to choices.
      - `↓` (Down): traverses later visual rows; consecutive vertical moves remember the original visual column across shorter rows and restore it on longer rows (non-vertical movements or edits reset the remembered column).
    - Focus, submission, and priority:
      - `Tab`: unconditionally returns to choices from any row.
      - `Enter`: submits the form (Form `Enter`, `Tab`, and `Esc` always take precedence over colliding custom editor bindings).
      - `Esc`: if field contains text, clears field and returns to choices; pressing `Esc` again dismisses form.
    - Newline vs. Enter & Terminal Caveat:
      - `Shift+Enter` and `Ctrl+J` insert a newline (`\n`) without submitting. Bare `Enter` submits.
      - *Terminal Shift+Enter Caveat:* In terminals without extended keyboard protocols (like Kitty keyboard protocol or CSI u), `Shift+Enter` is reported identically to bare `Enter` (`\r`), triggering submission. Use `Ctrl+J` in these terminals to insert newlines reliably.
    - Field-focused hints wrap at word boundaries and show separate `[Shift+Enter] / [Ctrl+J]` keys; Enter and Escape actions remain complete in narrow panes.
- Mouse selection (fullscreen): click anywhere inside a numbered, C or W chip, including its brackets/padding. Clicks select without sending; Enter submits. Numbered/C clicks focus choices; W focuses the retained answer field. Notes, cursor, undo and kill/yank history survive switching. Dragging, modified/right/middle clicks, gaps and stale targets do not activate.
- Narrow panes: complete chips wrap in numbered → C → W order from 20 columns, with stable selected footprints. C compacts to `C` only when its full label cannot fit a row; W likewise. Allow enough pane height for the wrapped form. Below 20 columns output fits and keyboard operation remains available; mouse reachability is not promised.
- Terminal modes: `--tui-mode fullscreen` enables native mouse routing and the Click hint. `--tui-mode regular` keeps keyboard operation and terminal selection without a Click hint. Normal prompt clicking remains owned by `rbf-click-cursor` after form dismissal.
- Dual Tool Registration: Exposes both `question` and `ask_question` tools accepting string options or structured `{ label, description }` objects.
- Text Detection Heuristic: Automatically activates the selector on `agent_settled` when assistant messages end with numbered options following `Recommendation:`, `User Need Framing:`, preceding `?`, or containing `← recommended` / `(recommended)` tags. Regular tutorial lists are never misidentified.

## 🟠⋯ Setup & Verification
- Activation recipe: always on; no configuration flag needed.
  1. Launch local extension in isolated session: `pi --no-extensions --tui-mode fullscreen -e ./extensions/rbf-question-form.ts`
  2. Ask a question with options (or invoke `question` tool).
  3. Press `W` to focus Write-in, or press `1` then `Tab` for optional notes.
  4. Edit text with editor keys (`Ctrl+A`, `Ctrl+E`, `Ctrl+U`, `Ctrl+K`, `Ctrl+Y`, `Ctrl+-`), insert newlines with `Ctrl+J`, navigate visual rows with `↑`/`↓`, and submit with `Enter`.
- Candidate checks: `npm test -- extensions/rbf-question-form.test.ts --testTimeout 30000` and `npm run typecheck`. Tests include cell/payload/gesture cases and the native fullscreen dispatcher/custom-UI restoration. Real terminal/font/theme comfort still requires the documented human checks before delivery.
- Global installation (after separately authorized verification/delivery): `cp ./extensions/rbf-question-form.ts ~/.pi/agent/extensions/rbf-question-form.ts`
- Removal: `rm -f ~/.pi/agent/extensions/rbf-question-form.ts`

---

# 🔵⋯ rbf-rewind

## 🟠⋯ Overview
Local Pi extension registering `/rewind` to navigate the session tree with user messages first, while preserving native filter switching and `/tree` behavior. Allows users accustomed to Claude Code muscle memory to navigate checkpoints and switch session branches cleanly by typing `/rewind`.

## 🟠⋯ Capabilities & Behavior
- User Messages First: Typing `/rewind` in Pi's prompt editor opens the native session tree selector modal with the initial filter set to user-only (`[user]`), showing only user messages immediately.
- Native Filter Switching: Native filter shortcuts remain fully functional; pressing `Ctrl+U` toggles between user-only and default filter views, and `Ctrl+O` cycles through all available native filters.
- Native `/tree` Isolation: Typing `/tree` directly continues to open the session tree with its configured filter (e.g. `default` or `all`); `/rewind` never alters saved filter preferences or `settings.json`.
- Summary Cancel & Reopen: If branch summarization is cancelled or aborted with Escape, subsequent selector reopens follow native Pi behavior and read the configured native filter.
- Argument Tolerance: Ignores trailing whitespace and arguments (e.g. `/rewind 2`, `/rewind now`, `  /rewind  `), matching native `/tree` behavior.
- Autocomplete: Registered in Pi's command list with description `"Navigate session tree (user messages first)"`, making it discoverable when typing `/re`.
- Standout Syntax Highlighting: Supported by `rbf-standout-commands`, highlighting `/rewind` as a valid keyword in the prompt.
- Non-Interactive / RPC Fallback: If executed in headless or non-interactive environments where interactive UI is unavailable, outputs an informational notification explaining that tree navigation requires interactive mode.
- Legacy Activation & Fresh Process: If upgrading from a previous version in an already running Pi session, a fresh Pi process restart is required to enable user-only navigation; if the legacy wrapper is detected, a warning prompts to restart Pi.
- Runtime Support Seam: Verified on project Pi 0.85.1 and daily Pi 1.0.4; if the host's private integration seam is unavailable or cannot be shadowed, a visible warning advises using `/tree` to navigate and refuses unsupported opening.

## 🟠⋯ Setup & Verification
- User messages first ships in pi-rbf v0.29.0 (#pi-47); installed in the daily extension directory. Start a fresh Pi process after this upgrade, because `/reload` cannot replace the old boolean-only wrapper safely
- Install the release file as `~/.pi/agent/extensions/rbf-rewind.ts`, keeping a copy of the previous file outside the extensions directory
- Roll back by restoring that previous file and restarting Pi. This local release retains its original at `/Volumes/tom-ssd/tmp/pi-47/local-release-v0.29.0/rbf-rewind.before.ts`
- Local verification: launch `pi -e ./extensions/rbf-rewind.ts`, type `/re` to inspect autocomplete, press Enter on `/rewind` to verify tree navigation modal opens with user messages first (`[user]`).

---

# 🔵⋯ rbf-rename

## 🟠⋯ Overview
Local Pi extension registering `/rename <name>` as a familiar alias for Pi's native `/name <name>` session naming.

## 🟠⋯ Capabilities & Behavior
- Name or rename: `/rename <name>` sets or replaces the current session name through Pi's public session-name API.
- Native persistence and display: Pi stores the name in session metadata and shows it in the footer, terminal title, `/session`, and `/resume` selector.
- Bare command: `/rename` shows `Session name: <name>` when named, or `Usage: /rename <name>` when unnamed.
- Native normalization: surrounding whitespace is trimmed; Pi replaces embedded line breaks with spaces and the extension reports the stored value.
- Compatibility: native `/name` remains unchanged; the extension uses no prototype patches or external dependencies.

## 🟠⋯ Setup & Verification
- Local verification: launch `pi -e ./extensions/rbf-rename.ts`, run `/rename first-name`, then `/rename second-name`, and inspect the footer and `/session`.
- Global installation: `cp ./extensions/rbf-rename.ts ~/.pi/agent/extensions/rbf-rename.ts`
- Removal: `rm -f ~/.pi/agent/extensions/rbf-rename.ts`

---

# 🔵⋯ rbf-shell-mode-indicator

## 🟠⋯ Overview
Local Pi extension that distinguishes shell command mode (commands starting with `!` or `!!`) from standard prompt input mode by dynamically tinting top and bottom editor horizontal border lines to `#FF0087`, styling the leading `!` in `#FF0087`, and displaying `In shell mode` in `#FF0087` on the same line as the bottom horizontal border line.

## 🟠⋯ Capabilities & Behavior
- Keystroke-reactive activation: typing `!` or `!!` as the prompt prefix immediately turns top and bottom horizontal border lines to `#FF0087` (vivid magenta-pink)
- Prompt prefix styling: formats the leading `!` or `!!` in the editor prompt text with `#FF0087`, with seamless cursor reverse-video rendering and single-space visual prefix padding between `!` and the cursor / command text
- Same-line bottom indicator: renders `In shell mode` directly on the bottom horizontal border line in `#FF0087` (`── In shell mode ─────────────────────`), saving vertical terminal space with zero below-editor line overhead
- Instant reversion: deleting `!` or clearing the editor immediately reverts horizontal borders to the default theme border color, removes the shell mode label, and restores normal prompt styling
- Clean solid top border: renders clean solid horizontal line in `#FF0087` without punctuation symbols on the top rule
- TrueColor precision: renders `#FF0087` via 24-bit ANSI truecolor (`\x1b[38;2;255;0;135m`) across all themes
- Parity between single and double exclamation: both `!` (bash with context) and `!!` (bash without context) receive `#FF0087` styling, visual prefix padding, and activate shell mode indicators
- Border width preservation: preserves terminal column width matching exactly, including scroll indicators (`↑ N more`, `↓ N more`)
- Vim mode coordination: coordinates with `rbf-vim`'s `VimEditor`, rendering `── NORMAL ── In shell mode ───────` or `── INSERT ── In shell mode ───────` with Vim mode badges styled and border rules and shell label in `#FF0087`
- Standout commands chaining: cleanly chains with `rbf-standout-commands` without conflicting border or text patches
- Zero external dependencies: implemented in a single self-contained file with prototype-safe scoping

## 🟠⋯ Setup & Verification
- Local verification: launch `pi -e ./extensions/rbf-shell-mode-indicator.ts`, type `!`, observe `#FF0087` horizontal lines, `#FF0087` colored `!`, visual space padding before the cursor (`! █`), and `── In shell mode ──────` on the bottom border; backspace `!`, observe instant reversion to standard prompt
- Global installation: `cp ./extensions/rbf-shell-mode-indicator.ts ~/.pi/agent/extensions/rbf-shell-mode-indicator.ts`
- Removal: `rm -f ~/.pi/agent/extensions/rbf-shell-mode-indicator.ts`

---

# 🔵⋯ rbf-background-tasks

## 🟠⋯ Overview
Local Pi extension enabling users to detach running foreground shell commands (`!`) to the background using `Ctrl+B`, inspect background task progress and logs via `/tasks` (alias `/bashes`), directly cancel tasks via `/cancel <id>` (alias `/kill <id>`), view active background counts in the footer status badge (`1 shell`), and cleanly terminate child process groups on session shutdown.

## 🟠⋯ Capabilities & Behavior
- Foreground Detachment: While a user `!` shell command runs in the foreground, `(ctrl+b to run in background · Esc to cancel)` is displayed. Pressing `Ctrl+B` immediately detaches the command to the background, prints the task ID and log path in the chat row, and restores the prompt.
- Kitty & Legacy Protocol Parity: Captures `Ctrl+B` via `matchesKey` supporting both Kitty keyboard protocol CSI-u sequences (Ghostty/cmux) and legacy ASCII control codes (`\x02`).
- Pass-Through Navigation: When no foreground command is executing, `Ctrl+B` passes through cleanly to the prompt editor to preserve cursor-left navigation.
- Task Viewer (`/tasks`, `/bashes`):
  - Single task: opens the `Shell details` modal directly showing status, live elapsed runtime, executed command, log file path, boxed scrollable output with line counts, and controls.
  - Multiple tasks: opens an interactive `Shell tasks` list allowing navigation, viewing details with `Enter`, or stopping a task with `x`. Pressing `←` in details returns to the list.
- Cancellation (`/cancel <id>`, `/kill <id>`, or `x` in modal): Cleanly terminates the child process group via `SIGTERM` followed by `SIGKILL` escalation.
- Footer Status: Displays `1 shell` / `N shells` in the status line while background commands are active, automatically clearing when all tasks exit.
- Log Management & Truncation: Writes task logs to `/tmp/pi-tasks/session-<id>/<taskId>.log` (mode `0700` directory), capped at 10MB to protect disk space.
- Zombie Process Protection: On session shutdown (`pi.on("session_shutdown")`), terminates all active background process trees immediately.
- Concurrency Cap: Limits concurrent background tasks to 10 to prevent system resource exhaustion.
- Zero Conflict with Sandboxing: Scoped strictly to user `!` commands via `user_bash`, leaving agent tool bindings untouched.

## 🟠⋯ Setup & Verification
- Local verification: launch `pi -e ./extensions/rbf-background-tasks.ts`, run `! sleep 15`, verify `(ctrl+b to run in background)` appears, press `Ctrl+B`, inspect `/tasks`, stop task with `x`, verify footer badge clears.
- Global installation: `cp ./extensions/rbf-background-tasks.ts ~/.pi/agent/extensions/rbf-background-tasks.ts`
- Removal: `rm -f ~/.pi/agent/extensions/rbf-background-tasks.ts`

---

# 🔵⋯ rbf-todos

## 🟠⋯ Overview
Local Pi extension tracking session progress with an agent-callable `todo` checklist tool, a live monospace boxed checklist widget pinned above the prompt editor, an `Alt+T` visibility toggle shortcut, an interactive `/todos` full-screen modal viewer, a footer status line indicator (`📋 X/Y`), completion auto-collapse on prompt submission, and branch-safe state reconstruction.

## 🟠⋯ Capabilities & Behavior
- Model Tool `todo`:
  - `add`: `{ text: string }` creates a new checklist item in `pending` status with an auto-incrementing ID.
  - `update`: `{ id: number, status?: "pending" | "in_progress" | "completed", text?: string }` updates item status or description.
  - `toggle`: `{ id: number }` cycles item status (`pending` -> `in_progress` -> `completed` -> `pending`).
  - `list`: returns formatted list of current items and completion counts.
  - `clear`: removes all items and resets the checklist.
- Above-Editor Open Widget:
  - Displays directly above the input box via `ctx.ui.setWidget("todos", ...)` with placement `aboveEditor`.
  - Clean open layout with top and bottom horizontal borders, resilient against terminal resizing and ANSI escape sequences.
  - Status symbols: completed `✓` in greenish success color, in-progress `⋮` in started color (`#7A81FF`), pending `○` in muted color with dark font for top unstarted item and muted light grey for queued items below.
  - Capped at 5 visible items with a clean `… and N more (type /todos to view all)` overflow notice to prevent viewport compression.
- TUI Shortcut `Alt+T`:
  - Toggles visibility of the above-editor checklist widget without affecting prompt input.
  - Avoids collision with Pi's reserved `ctrl+t` keybinding (`app.thinking.toggle`).
- Interactive Modal Command `/todos`:
  - Opens a full-screen interactive viewer via `ctx.ui.custom()` to inspect and scroll through the complete list of todos.
  - `Up` / `Down` (or `k` / `j`) navigates the list.
  - `Space` or `Enter` toggles status of the selected item.
  - `c` clears completed items.
  - `q` or `Escape` closes the modal.
  - Non-TUI mode falls back to notifications.
- Footer Status Line:
  - Displays `📋 X/Y` in accent color via `ctx.ui.setStatus("todos", ...)`.
  - Persists even when the above-editor widget is collapsed or toggled off with `Alt+T`.
- Completion Auto-Collapse:
  - When all todos are marked `completed`, the widget remains visible for the remainder of the current turn so the user sees the completed state.
  - On the next user prompt submission (`before_agent_start` / `input`), the completed widget collapses automatically to restore clean prompt space.
  - Adding a new todo or re-opening a completed todo un-collapses the widget immediately.
- Branch-Safe State Reconstruction:
  - Listens to `session_start` and `session_tree`.
  - Reconstructs active checklist state from tool results and custom entries along the active session branch, ensuring time-traveling via `/tree`, `/rewind`, or `/fork` restores the exact checklist state for that point in history.
- Zero External Dependencies:
  - Pure TypeScript importing only `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`.

## 🟠⋯ Setup & Verification
- Local verification: launch `pi -e ./extensions/rbf-todos.ts`, prompt agent to create a 3-step plan with the `todo` tool, verify widget appears, press `Alt+T` to toggle, run `/todos` to inspect modal, and verify auto-collapse on prompt submission after completion.
- Global installation: `cp ./extensions/rbf-todos.ts ~/.pi/agent/extensions/rbf-todos.ts`
- Removal: `rm -f ~/.pi/agent/extensions/rbf-todos.ts`


---

# 🔵⋯ rbf-model-status

## 🟠⋯ Overview
Local Pi extension that makes the transient status line after a model change name the provider the way the footer does: `Model: (<provider>) <id>` after `/model <id>` or a picker pick (`/model`, Ctrl+L), and `Switched to (<provider>) <name> …` after a model cycle (Ctrl+P, Shift+Ctrl+P).

## 🟠⋯ Capabilities & Behavior
- Same rule as the footer: the `(<provider>) ` prefix appears only when more than one provider is configured (`footerDataProvider.getAvailableProviderCount() > 1`); with one provider both lines stay bare
- Copy untouched: only the prefix is inserted after `Model: ` or `Switched to `; the rest of Pi's line, including `(thinking: <level>)` and a catalog name such as `gpt-5.6-luna (Codex agent)`, is what Pi printed
- Every other status line (`Default model: …`, `Forked to new session`, …) passes through unchanged
- Extension notifications reach the same seam, so another extension's `info` notice that starts with `Model: ` or `Switched to ` gains the prefix too; non-string notices pass through untouched
- Mechanism: wraps `InteractiveMode.prototype.showStatus`, the one seam the three Pi call sites share; symbol-guarded so `/reload` never double-wraps; no width fallback, since the status row is a chat line, not the footer's fixed strip

## 🟠⋯ Setup & Verification
- Local verification: `pi -e ./extensions/rbf-model-status.ts`, then `/model <id>` and Ctrl+P; with two or more providers configured both status lines carry `(<provider>)`
- Global installation: `cp ./extensions/rbf-model-status.ts ~/.pi/agent/extensions/rbf-model-status.ts`; always on once installed, no flag or configuration
- Removal: `rm -f ~/.pi/agent/extensions/rbf-model-status.ts`

---

# 🔵⋯ rbf-codex

## 🟠⋯ Overview
Local Pi extension that registers Codex as the model provider `codex-harness`, so a Pi conversation runs on Codex's full agent harness with Pi as the only visible interface: Codex's commands, file changes, tool calls (MCP servers, app connectors, computer use), and questions show as Pi's own tool rows, a sub-agent's rows and dialogs carry its name, approvals, questions, and computer use's per-app question are answered through Pi's dialogs, and Pi's fork, tree, steer, and image paste work as they do for Pi's own models. Verified against Pi 0.85.1 and Codex CLI >= 0.157.1 on Node.

## 🟠⋯ Capabilities & Behavior
- Who owns what: Codex owns context, instructions, tools, sandbox, approval policy, compaction, and auth; Pi owns input, display, the conversation binding, and cancellation. Pi passes no policy and injects nothing
- Runtime: Pi spawns `codex app-server` over stdio as a direct child, one per Pi session, and closes it with the session (stdin EOF, then SIGTERM, then SIGKILL). No daemon, socket, or lock
- Models and effort: `/model` lists Codex's real models as `<id> [codex-harness]` rows, next to the bootstrap `codex` row; the provider tag keeps them apart from Pi's built-in `[openai-codex]` rows that list the same ids; Pi's thinking selector sets the effort. Both go on every turn. The bootstrap row means Codex's default model at the picked effort. The catalog refreshes when the picker opens, at most once a day, and persists in Pi's model store
- Activity: each Codex command is a collapsed `$ <command>` row that expands to its output (`codex_command`), each file change an edit row with the diff (`codex_patch`, glanced like Pi's own edit rows), each question a `? <header>` row (`codex_question`), and every other tool call (an MCP server's tool, an app connector, the code kernel that computer use and browser use run through) a `<server>.<tool>` row (`codex_tool`; the app's name stands for the server while the turn holds the call, the server's after a reload or resume) with Codex's own title for the call after it and the arguments under it: the JavaScript of a `cua_repl.js` or `node_repl.js` call as Codex wrote it, collapsed like a command's output, anything else as one JSON line; the tool's text result sits behind Ctrl+O like a command's output. Computer use is that row plus Codex's own macOS overlay; Pi adds no label. Ctrl+O expands a row as for every Pi tool row; reasoning summaries persist as thinking; commentary and the answer stream as text. A declined, stopped, or failed row draws in Pi's error tint, as a failed bash row does. The rows are Pi tool calls that only the Codex turn can open; another model calling them gets an error result. Every row's persisted arguments carry `threadId` and `agentPath` (empty for the root); rows written before v0.21.4 carry neither and read as the root's
- Approvals and questions: when Codex asks to run a command or edit files, a dialog opens on that row with `Yes`, `Yes for this session`, and `No, tell Codex what to do instead`; `No` and Escape both refuse and stop the turn, so you type what to do next on the same thread. `Yes for this session` lasts as long as the Codex child; if Codex restarts mid-session a notice says those answers were reset. A clarifying question opens one selector per question (`Other…` for free text when Codex allows it); a secret is declined because Pi's input echoes. In print and RPC modes every request is declined with a notice. When Codex asks is Codex's policy, not Pi's: with `approval_policy = "on-request"` the model decides and gpt-5.6-luna mostly runs sandboxed and reports the failure instead; `on-failure` asks after a sandbox denial (a write outside the workspace's writable roots) and, approved, reruns the command outside the sandbox; a project root marked `trusted` in `~/.codex/config.toml` is never blocked. Codex offers its question tool in the default collaboration mode only with `[features] default_mode_request_user_input = true`
- Computer use's app question: before its first call on an app, Codex asks through an MCP elicitation; Pi opens the approval dialog titled with Codex's own words (`Allow Computer Use to use "Safari"?`) with `Yes`, `Yes for this session` (when Codex offers to remember it), and `No, tell Codex what to do instead`. `No` and Escape fail that one call (`Computer Use was not approved to use Safari`, in error tint) and the turn goes on, Codex deciding what to do next; the first such dialog in a session is preceded by Codex's own risk notice. Every other elicitation (a form with fields, a URL prompt, another approval kind) and every permission request stays declined with a notice
- Sub-agents: when Codex hands work to a sub-agent, that agent's commands, edits, tool calls, and questions are the same rows with the agent's name in front in muted text (`alpha $ pytest -x`), and its approvals and questions open the same dialogs titled `<agent>: …`. Any row that is running answers any pending request, so an agent's dialog can appear before its own row; the row follows when the running one settles. An agent's own final message is not shown; the parent's answer carries it. Codex announces an agent before its first item (a `subAgentActivity` item, or the `collabAgentToolCall` item a code-mode model spawns through, which carries no name, so those rows and dialogs stay unprefixed) and Pi admits only announced threads, so Codex's internal agents (review, compaction, the guardian reviewer) draw nothing
- Steer and images: a message typed while Codex works reaches the running turn at its next step (`turn/steer`); if the turn has already ended it becomes the next turn. An image pasted on an image-capable Codex model reaches Codex as a data URL; text-only models refuse the paste
- Binding: one `rbf-codex-thread/v1` entry `{ threadId, cwd, sessionId }` in the session log, appended after the first `thread/start`, and one `rbf-codex-turn/v1` entry `{ threadId, turnId, status }` per Codex turn. Reopening the session resumes the thread. A Pi branch that diverged from its thread (`/fork`, `/clone`, `pi --fork`, or tree navigation back to an earlier point) gets its own Codex thread, forked at the branch's last turn (`thread/fork`), at that branch's next prompt, silently; the original branch keeps its thread. No Codex thread is ever truncated
- No turn survival: a turn running when Pi exits is interrupted in Codex; on reopen a notice asks you to send it again, whether the branch ends in your prompt or in a row whose tool never returned
- Escape sends `turn/interrupt` for the turn, then one for every announced sub-agent's turn, so nothing is left running. No interrupt kills a command that is already running, Codex keeps it (in v0.21.1 too), so a command row cut by Escape, or by its turn ending under it, reads `Cancelled; command still running in Codex` (a question, edit, or tool call row cut the same way reads `Cancelled`), and Pi says once when that command ends: `Codex's command finished after you cancelled (exit <code>): <command>`. Manual `/compact` intercepts before Pi's native short-session guard, verifies the branch against Codex history, and routes compaction directly to the bound Codex thread without altering Pi's transcript (v0.21.12); tree navigation supplies a fixed branch summary instead of asking Codex
- Stop and continue (v0.23.1): after Escape stops a first or later Codex turn, your next prompt starts exactly one new turn on the same Codex thread, including after you reopen the same Pi branch. Codex keeps what the stopped turn had already seen; the stopped prompt is not replayed, and no `/fork` or `/new` is needed. Before sending, Pi reads the thread's history from Codex; a failed, still-running, or unreadable history refuses the prompt with the history-unverified sentence, with no permissive fallback. Accepted limits: before a branch has its first completed turn, same-session branches on one thread can remember stopped input the selected branch no longer shows, and a sibling's completed turn makes the other such branch refuse (`/fork` there starts cold, as does `/new`); stopping a command row on Pi 0.85.1 and 1.0.2 shows `This operation was aborted` as an error, and the next prompt still continues. Known gaps, fix planned as `pi-10.8`, both seen only against the fake app-server: a prompt sent before Codex has ended the stopped turn joins that turn and ends aborted, so send it again; and if the stopped turn actually completed and you move to a sibling branch before your next prompt, that prompt is sent and Codex remembers one completed exchange the sibling does not show. Verified on Pi 0.85.1 and 1.0.2 with Codex CLI 0.160.0; the minimum stays 0.157.1
- Thinking levels (v0.23.2): a Codex model offers only the thinking levels Codex can run: `low`, `medium`, `high`, and `xhigh` or `max` where the model supports them. `off` and `minimal` are not offered, in shift+tab cycling, the `/thinking` list, or settings; a saved `off` or `minimal` shows as the lowest supported level, and `/thinking off` answers with Pi's own `Unknown thinking level`. Each turn runs at the level Pi shows. A level with no Codex effort refuses the turn before anything is sent, with `This thinking level is not available for this Codex model. Your message was not sent. Choose a level with /thinking, then send again.`; this can happen once, right after installing and `/reload`, in a session still showing `off`. Pi's menu descriptions still show token budgets, which do not apply to Codex: Codex receives the level's name. Non-Codex models keep `off`. Verified on Pi 0.85.1 and 1.0.2 with Codex CLI 0.160.0
- A Codex MCP server that fails to start is named once per Codex child in a warning notice with Codex's reason; the model sees Codex's own failure text in its next result
- Refusals are fixed sentences that never trigger Pi's auto-retry: Codex missing, not logged in, another directory, image on a text-only model, stopped, failed, no answer, unavailable. Details go to a notice
- `pi --sandbox` and this provider are mutually exclusive: with `--sandbox` in argv the extension registers nothing

## 🟠⋯ Setup & Verification
- Prerequisites: `codex --version` prints `codex-cli 0.157.1` (or higher) and `codex login status` shows a logged-in account; the extension looks for `codex` on `PATH`, then `/Users/tomhosiawa/.local/bin/codex`
- Local verification: `pi -p --no-extensions -e ./extensions/rbf-codex.ts --model codex-harness/codex "Reply exactly PI_CODEX_OK and nothing else." < /dev/null` prints `PI_CODEX_OK` (the `< /dev/null` matters from any script or agent shell: Pi reads a non-tty stdin to EOF before loading extensions); `bun run test -- extensions/rbf-codex.test.ts` runs the focused suite against a fake app-server; `bun run test -- extensions/rbf-codex-row-gate.test.ts` is the row gate: it boots a real Pi under a pty, bare and with the daily row extensions, replays each raw stream into the final screen, and asserts the rows of every Codex row kind (command, long output collapsed, edit, added file, failed command, declined, stopped, question answered, skipped, and secret, a `codex_command` called by hand, tool call rows with a text result, a code argument, and a failed call, a sub-agent's tagged command rows, and a command row cut by Escape against Pi's own bash row cut by Escape) against Pi's own bash and edit rows drawn in the same process, blank rows between lines included; needs `python3`, and fails its first test when a prerequisite is missing unless `RBF_ROW_GATE_OPTIONAL=1` (`RBF_ROW_GATE_KEEP=1` keeps the raw captures for a post-mortem). With a `CODEX_HOME` that configures an MCP server, `pi -p … --model codex-harness/gpt-5.6-sol "Call the bear_app MCP tool list_tags exactly once and the node_repl js tool exactly once with the code 21*2, then reply exactly TAGS=<count> JS=<value>." < /dev/null` answers with both values and the session log holds two `codex_tool` calls
- Global installation: `cp ./extensions/rbf-codex.ts ~/.pi/agent/extensions/rbf-codex.ts`
- Removal: `rm -f ~/.pi/agent/extensions/rbf-codex.ts`. Codex threads, credentials, and settings are untouched; `codex resume` still opens any thread. The provider's entry in Pi's model store stays behind and is inert


# 🔵⋯ rbf-path-labels

Introduced in pi-rbf v0.22.0 (pi-39.1). Shortens eligible assistant file references, native footer directory segments, `/session` File values and file-autocomplete descriptions by display cells. It keeps the filename first, omits whole interior directories with `…`, and restores more location when the pane widens. Spaced/CJK reference labels that native wrapping can split receive their own line. The existing pi-rbf basename footer remains unchanged.

Install the extension, then start Pi or run `/reload` in an existing session:
```sh
cp ./extensions/rbf-path-labels.ts ~/.pi/agent/extensions/rbf-path-labels.ts
pi
```
Once installed, it activates automatically. Remove only `~/.pi/agent/extensions/rbf-path-labels.ts` and reload/restart to roll back. For a per-process comparison, use `pi --no-extensions -e ./extensions/rbf-path-labels.ts` directly; macOS `script` can freeze the child terminal width and invalidate resize checks. Component compatibility is verified against checkout Pi 0.85.1 and daily Pi 1.0.2; private layout changes fall back to native output with a bounded warning.

Eligible references are local-file link labels, one path in inline code, or a strong-prefix bare path in explicit reference prose. Ambiguous instructions, commands, flags, wildcards, multiple operands, fenced/indented code, HTML literals, thinking, tools and user text retain native rendering. Unsupported syntax delegates. Terminal hyperlinks retain the original destination; without hyperlinks, the label is plain text. Same filenames can share shortened labels; nearby prose and original destinations distinguish them.

Terminal selection copies what is visible, including `…`. `/copy` retrieves the original last assistant response. For an older response, clear selection, open `/tree`, select the message and use the footer's copy action (default Ctrl+X), then Escape without Enter. It copies original text without navigating. Completion inserts its original full value. No new clipboard or per-path action is added.

Run `bun run test -- extensions/rbf-path-labels.test.ts` and `bun run typecheck` from a checkout with its pinned dependencies installed. The canonical pi-39 brief's verification receipts contain the isolated offline terminal probe and its captured source hashes. Both exercised human scenarios passed, user-reported. Offline daily-stack checks passed in regular/fullscreen mode with resize, reload, fork/resume and original source preserved. Optional additional color/assistive modes and continued daily use are separate evidence.

---

# 🔵⋯ rbf-cd

## 🟠⋯ Overview
Local Pi extension registering `/cd <path>`, which moves the running conversation to another directory inside the running Pi. Same session, same history: from the next prompt the agent's tools, your `!` shell, the project rules and the footer use the destination, and the conversation reopens there. Verified offline against checkout Pi 0.85.1 and daily Pi 1.0.3.

## 🟠⋯ Capabilities & Behavior
- Syntax: one literal path after the command
  - `/cd /Volumes/work/api` — absolute
  - `/cd ../api` — relative to the session's current directory
  - `/cd ~` and `/cd ~/src/api` — your home directory
  - `/cd "my project"` — one pair of outer quotes, single or double, for a path with spaces. A path with spaces also works unquoted
- Never a shell: `$HOME`, `$(…)`, `;`, `*` and backticks are ordinary characters in a name. Nothing is expanded or run. Symlinks resolve to the real directory
- Bare `/cd` shows `Working directory: <path>` and `Usage: /cd <path>`, and changes nothing. A path that resolves to the current directory answers `Already working in <path>.`
- What moves: the session ID, every history entry with its id and parent, the selected branch point, labels, the session name, the model and the thinking level
- What changes: Pi rebuilds its tools, project rules (`AGENTS.md`, the project's `.pi/` settings and extensions) and system prompt for the destination. The old project's rules stay in the history as quoted text. Only the live rules are the destination's
- What success looks like: `Working directory changed to <path>.` with the full path, shown once, after the move. No model turn starts by itself
- How it works: the session file is the only record of a session's directory. `/cd` writes the conversation into a new session file for the destination under the same session ID, switches Pi to it, then sends the old file to the system Trash with the `trash` command. One conversation, one copy. If the Trash step fails, the move still succeeds and the message names the file that was left
- Reopening: `pi -c` in the destination, or Pi's session list, opens the conversation in the last directory `/cd` reached. A refused, cancelled or failed `/cd` never becomes that directory
- A conversation with nothing saved yet (no reply so far) moves as a new, empty session in the destination, with a new session ID. The model and thinking level you picked come along
- Busy refusals: `/cd` refuses while a response or compaction runs, while another `/cd` is in progress, while a background task runs, and while a `!` command runs. The work keeps running, the warning says what to finish or stop, and the full typed `/cd <path>` goes back into the editor, so Enter retries it
- Path refusals: a missing path, a file, a directory you can't read and enter, or an unmatched outer quote is refused before anything is written, and the typed command goes back into the editor
- Sessions that can't move: one started with `--sandbox`, one that isn't being saved (`--no-session`), one whose session file has gone missing while Pi runs, and any session when `rbf-background-tasks` isn't loaded, because `/cd` asks it whether a command is running. Outside interactive mode `/cd` refuses: `/cd works in interactive mode only.`
- Codex conversations aren't supported yet: a session that has ever run a turn on the `codex-harness` provider is refused and left alone, whatever model is selected now. Support is slice `pi-41.3`
- Trust is Pi's own prompt: a destination with project `.pi/` resources raises Pi's `Trust project folder?` prompt during the move. Trusting loads them. Declining doesn't, and the move still completes. Trust isn't a sandbox, and `/cd` never widens one
- Cancelled by another extension: the conversation stays in the original directory, `Directory change cancelled.` shows, and the typed command goes back into the editor
- A switch that fails stops Pi: Pi exits when a session switch throws, and no extension can prevent that. The conversation is intact in the original directory, and the terminal's last lines are `/cd failed and Pi stopped. This conversation is saved in <path>.`, `Reopen it with:` and the `pi --session '<file>'` command that reopens it
- Leftovers from a Pi that died mid-move are judged by content, never deleted outright: an old copy that holds nothing new goes to the Trash the next time the conversation opens or the next `/cd` into its directory. A copy that holds turns the conversation lacks is kept and named in a warning. An unfinished copy opened by itself warns, names the directory the conversation is saved in, and gives the `pi --session <id>` command to run there
- Each finished move leaves one `rbf-cd-move/v1` entry `{ from, to, sessionId }` in the session file. Pi ignores it and it isn't sent to the model
- Not included: a directory picker, path completion, `/cd -`, moving running background tasks, and changing directory from print, JSON or RPC mode

## 🟠⋯ Setup & Verification
- `/cd` is refused while a `monitor` watch runs (`rbf-monitor`, v0.28.0). `/monitors stop all` clears it
- Needs two files: `rbf-cd.ts` and this checkout's `rbf-background-tasks.ts`. An older installed copy of `rbf-background-tasks.ts` can't answer `/cd`'s question, and `/cd` then refuses every move
- Local dogfood without installing, against a throwaway profile so the installed extensions don't load beside the checkout's: `PI_CODING_AGENT_DIR=<throwaway dir> pi --no-extensions -e ./extensions/rbf-cd.ts -e ./extensions/rbf-background-tasks.ts`, then `/cd`, `/cd <path>`, and ask for `pwd`. A throwaway profile has no login, so pick a model it can reach or copy `auth.json` into it
- Automated: `bun run test -- extensions/rbf-cd.test.ts` covers the path resolver, every refusal, the same-ID and copy-state rules and the exit hook
- In a real terminal, offline: `bash extensions/test-support/rbf-cd-verify.sh <pi-executable> <scenario>` types into an interactive Pi under a pseudo-terminal with a scripted provider and a fake `trash`, and prints `PASS` or `FAIL` with the reason. Scenarios: `move`, `reopen`, `branch`, `busy`, `cancel`, `fail`, `leftovers`, `fresh`, `trust`, `decline`, `load-error`, `vanish`. Needs `python3`. Roots go under `/Volumes/tom-ssd/tmp/pi-41.2`, or `$RBF_CD_VERIFY_TMP`
- Global installation: `cp ./extensions/rbf-cd.ts ~/.pi/agent/extensions/rbf-cd.ts` and `cp ./extensions/rbf-background-tasks.ts ~/.pi/agent/extensions/rbf-background-tasks.ts`, then start Pi or run `/reload`
- Removal: `rm -f ~/.pi/agent/extensions/rbf-cd.ts`. Moved conversations are ordinary Pi session files that stock Pi opens in their directory

# 🔵⋯ rbf-tool-parts-indent

Introduced in pi-rbf v0.25.0 (pi-45.1). Every line under a tool call's header starts 3 columns right of the header, and the first of them carries a dim `└` under the header's first character, so a header is the only thing at a row's left column. It covers the rows Pi draws for tool calls (shell, read, write, edit, grep, find, ls, Codex rows, and other extensions' tools that use Pi's row shapes) and the rows for commands typed with `!` or `!!`, collapsed and expanded alike. The text itself is unchanged, and the blank row between a header and its first line is gone.

Install both files, then quit Pi and start it again:
```sh
mkdir -p /Volumes/tom-ssd/tmp/pi-45/backup && command cp -f ~/.pi/agent/extensions/rbf-edit-glance.ts /Volumes/tom-ssd/tmp/pi-45/backup/
command cp -f ./extensions/rbf-tool-parts-indent.ts ./extensions/rbf-edit-glance.ts ~/.pi/agent/extensions/
```
Activation and rollback both need a restart of Pi. `/reload` is not enough: `rbf-edit-glance` keeps the copy it loaded when Pi started, so until a restart the edit summary's text sits one column left of the diff under it. To roll back, run `rm -f ~/.pi/agent/extensions/rbf-tool-parts-indent.ts && command cp -f /Volumes/tom-ssd/tmp/pi-45/backup/rbf-edit-glance.ts ~/.pi/agent/extensions/`, then restart Pi. The two files don't need each other, and either one alone leaves every row drawing without error.

What it leaves alone: headers, a `!` row's two border lines, the skill row, images in a tool result, and a tool row that has no renderer. In a pane narrower than 20 columns no row is indented. Text copied from the screen carries the indent, and `/copy` does not, because nothing drawn reaches the saved session. If a row can't be drawn indented without running past the pane's edge, or a piece throws, that row draws as it does without the extension.

To check it locally, start Pi with the extension, ask for `seq 1 12`, and type `!seq 1 30` yourself: in both rows the numbers hang under the `$` header with a `└` on the first. To try it without installing, and without touching your own Pi settings, run `PI_CODING_AGENT_DIR="$(mktemp -d)" node_modules/.bin/pi --no-extensions -e extensions/rbf-tool-execution-blended.ts -e extensions/rbf-edit-glance.ts -e extensions/rbf-clean-markdown-code.ts -e extensions/rbf-tool-parts-indent.ts` from the checkout, then type `!seq 1 30`. Pi writes its settings into its agent directory on start, so the command gives it a throwaway one. That profile has no model signed in, so only `!` commands can be tried this way. Run `bun run test -- extensions/rbf-tool-parts-indent.test.ts extensions/rbf-tool-parts-indent-pty.test.ts` and `bun run typecheck` from a checkout with its pinned dependencies installed. Rows are verified by captures from checkout Pi 0.85.1 and daily Pi 1.0.2 at 100 and 60 columns; other Pi versions are not.

# 🔵⋯ rbf-shell-command-groups

Introduced in pi-rbf v0.27.0 (pi-42.1). Shell commands an agent runs one after another show as one line with a count, and the commands themselves are hidden until you open it:
```
 ▸ ran 3 shell commands · 1 failed
```
```
 ▾ ran 3 shell commands · 1 failed
 $ pwd
 └  /Users/me/project
 $ printf SHELL-CHECK
 └  SHELL-CHECK
 $ exit 7
 └  (no output)
    Command exited with code 7
```
The open view is drawn with `rbf-tool-parts-indent` loaded. Without it the results sit flush under each command, with no `└`.

- The count is the number of shell commands the agent started in a row. Text from the agent, or any other tool call, ends a group and the next command starts a new one
- The closed line names what needs attention: `running 1 shell command`, `1 shell command · background` with a `Task ID:` line under it, `1 failed`, cancelled and not-run commands
- Open and close a group by clicking its line in fullscreen mode. Ctrl+O opens and closes every group and tool row, in fullscreen and regular mode. A click on a command inside an open group does nothing, so links and text selection work as they do on any row
- Opening a group shows Pi's own command rows and results, unchanged. Nothing about what runs, or what is saved in the session, changes
- After you quit and reopen a session, groups read `status unknown`, for example `3 shell commands · 1 error (status unknown) · 2 unknown`. Pi no longer holds proof of how those commands ended, so it doesn't claim they ran. A Codex command whose saved record carries a numeric exit code keeps its result
- Covered: Pi's own bash tool and Codex commands run through `rbf-codex`. Not covered, and drawn as before: a session started with `--sandbox`, commands you type with `!` or `!!`, and shell calls nested inside another tool
- Ctrl+B still sends Pi's own running bash command to the background. It does not control Codex commands
- If grouping can't attach to this Pi, rows stay as they were and one warning says `Shell command groups unavailable; showing native tool rows.`

Install the three files together, then quit Pi and start it again. The view needs this checkout's `rbf-background-tasks.ts` and `rbf-codex.ts`, which tell it how each command ended; with older copies of those two, rows stay as they were:
```sh
mkdir -p /Volumes/tom-ssd/tmp/pi-42/backup && command cp -f ~/.pi/agent/extensions/rbf-background-tasks.ts ~/.pi/agent/extensions/rbf-codex.ts /Volumes/tom-ssd/tmp/pi-42/backup/
command cp -f ./extensions/rbf-shell-command-groups.ts ./extensions/rbf-background-tasks.ts ./extensions/rbf-codex.ts ~/.pi/agent/extensions/
```
To roll back the display only, run `rm -f ~/.pi/agent/extensions/rbf-shell-command-groups.ts` and restart Pi. The two updated files can stay: without the view they only keep a small in-memory record that nothing reads. To roll back all three, also run `command cp -f /Volumes/tom-ssd/tmp/pi-42/backup/rbf-background-tasks.ts /Volumes/tom-ssd/tmp/pi-42/backup/rbf-codex.ts ~/.pi/agent/extensions/`, unless either file has been updated again since.

To try it without installing, and without touching your own Pi settings, run `PI_CODING_AGENT_DIR="$(mktemp -d)" node_modules/.bin/pi --no-extensions -e extensions/rbf-shell-command-groups.ts -e extensions/rbf-background-tasks.ts -e extensions/rbf-codex.ts -e extensions/rbf-tool-parts-indent.ts --tui-mode fullscreen` from the checkout. That profile has no model signed in; pick a `[codex-harness]` model if the Codex CLI is logged in.

Verified on Pi 0.85.1 and 1.0.3. Not yet run: `/rewind`, compaction, leaving a branch while a command runs, a sandbox session with running commands, and light or monochrome themes.

# 🔵⋯ rbf-monitor

Introduced in pi-rbf v0.28.0 (pi-44.1). The agent arms a shell command with `monitor`. Each line the command prints to stdout reaches the agent as an event. An event starts a turn when Pi is idle, and arrives mid-turn when Pi is working, so an agent waiting on something can end its turn and still hear about it:
```
 monitor event · gate watcher
 └  build finished
```

- Two tools, Pi's versions of Claude Code's `Monitor` and `TaskStop`:
  - `monitor`: `command` (the shell command), `description` (the label on every event and row), `timeout_ms` (the deadline: 300000 by default, raised to 1000 below it, capped at 3600000)
  - `task_stop`: `task_id`, the id `monitor` returned, such as `mon-fb2e`
- Lines that arrive within 200 ms of each other go to the agent as one event. An event carries 20 lines at most and says how many it left out
- A watch stops when its command exits, at its deadline, when `task_stop` or `/monitors stop` stops it, after more than 10 events in 60 seconds, and when Pi reloads, starts a new session, resumes another, or quits. The agent is told each time. Nothing re-arms a watch: the agent does that
- Five watches at most. A sixth is refused and the refusal names the five
- `/monitors` lists running watches with their id, description, event count and time left. `/monitors stop <id>` stops one, `/monitors stop all` stops every one. With nothing running it answers `No watches running.`
- The footer shows `1 watch`, or the count, while any runs. It joins the left half of the stats row, so in a narrow pane the model text on the right is cut first
- A row Pi has already drawn keeps the time it showed then. `/monitors` shows the time left now
- An event Pi cleared before showing it (Esc during a turn) arrives first with the watch's next event or with your next prompt. Esc starts no turn. Events wait while Pi compacts, and while a prompt you typed is on its way to its turn
- A failed command's notice carries its last stderr lines and the path of its log
- Watched text is cleaned of terminal escape sequences and control characters before the agent or the terminal sees it. The log keeps the raw bytes, at `/tmp/pi-monitors/session-<session id>/<task id>-<armed at>.log`
- `/cd` is refused while a watch runs. `/monitors stop all` first
- Not available to a `codex-harness` model, which can't call Pi tools. Use a Pi-loop provider such as `openai-codex`
- Not checked in a `--sandbox` session: that needs `rbf-sandbox` (pi-23), which isn't released
- cmux isn't told about a turn a watch started: the pane doesn't show as running, and no notification is raised when that turn ends
- On Pi 1.0.3 an event can arrive twice after an abort. Read in Pi's source, not run

Install both files together, then restart Pi or type `/reload`. `rbf-cd.ts` goes with it: with an older copy, `/cd` doesn't refuse for a watch.
```sh
command cp -f ./extensions/rbf-monitor.ts ./extensions/rbf-cd.ts ~/.pi/agent/extensions/
```
To check it, type `/monitors` (`No watches running.`), then ask the agent: `Call monitor with command "sleep 2; echo ready" and description "smoke test", then end your turn.` The footer shows `1 watch`. Two seconds later a ` monitor ended · smoke test` row appears with `ready` under it, and the agent replies without a prompt.

To roll back, run `rm -f ~/.pi/agent/extensions/rbf-monitor.ts`, then `/reload` or restart Pi. Running watches stop at that reload. The changed `rbf-cd.ts` can stay.

To try it without installing, run `pi -e ./extensions/rbf-monitor.ts`.

Automated: `bun run test -- extensions/rbf-monitor.test.ts` and `extensions/rbf-monitor-real.test.ts`; the second drives a real Pi with a local no-model provider, and takes `RBF_PI_BIN` to pick the Pi. Verified on Pi 0.85.1 and 1.0.4. By hand on 1.0.4 with `openai-codex`: a Pi agent in an `agent-group-chat` room armed a watch unasked and answered a Claude reviewer's verdict 10 seconds after it was posted, with nothing typed.

# 🔵⋯ rbf-effort

## 🟠⋯ Overview
Local Pi extension aliasing `/effort` and `/effort <level>` in prompt submissions to native `/thinking` and `/thinking <level>`, allowing muscle memory from other agent environments without modifying built-in thinking level state machines or storage.

## 🟠⋯ Capabilities & Behavior
- Command translation: prompt input trims surrounding whitespace first. Entering bare `/effort` (including trailing tab or newline whitespace such as `/effort\t` or `/effort\n` that trims to bare `/effort`) or `/effort` followed only by ASCII spaces translates to `/thinking`, opening Pi's native interactive Thinking Level selector menu.
- Thinking level arguments: entering `/effort <level>` (such as `/effort high`, `/effort medium`, `/effort low`, `/effort off` separated by ASCII space) translates to `/thinking <level>` with arguments preserved.
- Separator restrictions: an internal tab or newline separating the command token from its arguments (e.g. `/effort\thigh`) is explicitly rejected as an unsupported separator when the TUI adapter is installed, displaying the notice `Use /thinking in interactive Pi; /effort could not reach the native command.` and blocking unparsed submission.
- Model and level validation: argument validation and model reasoning compatibility are handled entirely by native Pi. For non-reasoning models, `/effort high` surfaces native `Unknown thinking level "high"` without custom error shims. Native and default selector authority remains unchanged.
- Native selector controls: inside the selector menu, pressing `Ctrl+S` saves the highlighted thinking level to settings as the persistent configuration default (not a session default), while pressing `Enter` sets the thinking level for the active session without updating saved settings.
- Editor factory compatibility & lifecycle: compatible with earlier custom editor factories via chained delegation (`ctx.ui.getEditorComponent()`). If a later owner replaces the editor factory (including `rbf-vim`), the accessor is not reclaimed; submissions then fall through to Pi's registered native grammar, where the fallback command handler displays `Use /thinking in interactive Pi; /effort could not reach the native command.` while leaving the thinking level unchanged.
- Passthrough: prose containing `/effort`, similar command names (`/effortful`, `/effortless`, `/effort-mode`), and non-matching text pass through to normal prompt submission completely unchanged.
- Non-TUI mode fallback: editor submission translation activates only when `ctx.mode === 'tui'`. In non-TUI modes (`rpc`, `print`, `json`) or environments without interactive editor components, the registered native grammar fallback for bare `/effort` or ASCII-space separated arguments displays `Use /thinking in interactive Pi; /effort could not reach the native command.` and performs no provider turns (scoped to bare and ASCII-space input only, not tab/newline lexical strings; the unsupported separator notice is displayed only when the TUI adapter is installed).

## 🟠⋯ Setup & Verification
- Explicit activation: launch Pi with `-e ./extensions/rbf-effort.ts` (e.g. `pi -e ./extensions/rbf-effort.ts`).
- Daily installation: `command cp -f ./extensions/rbf-effort.ts ~/.pi/agent/extensions/`, then restart Pi or type `/reload`. Introduced in pi-rbf v0.30.0 (pi-51).
- Rollback: remove `~/.pi/agent/extensions/rbf-effort.ts`, then restart Pi or `/reload`; for explicit activation, remove the `-e` argument. Native `/thinking` remains available.
- Tested versions: factual final pinned proof across 37 actual profiles on both hosts (Pi 0.85.1 and daily Pi 1.0.4); Tom passed alias-only human verification. Installed daily source matches the accepted hash; daily Pi 1.0.4 native menu, arguments and reload pass in standard editor mode with installed Vim/rewind in both orders. Later editor ownership remains the documented fallback limit.
- Automated tests: run local tests with `bun run test extensions/rbf-effort-pty.test.ts`. To exercise both host versions across all widths, provide the daily root explicitly: `PI_DAILY_ROOT='<dailyroot>' bun run test extensions/rbf-effort-pty.test.ts` (where `<dailyroot>` is the discovered host root containing `dist/bundle/cli.js`).
