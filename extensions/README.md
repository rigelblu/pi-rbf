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
Local Pi extension that provides a clean, unboxed glance presentation for the `edit` tool matching Claude Code's diff UI: blends into the terminal background, displays an immediate line-count summary (`└ Added <A> lines, removed <R> lines`), caps collapsed diffs to 8 changed lines with an expansion hint, and highlights added and removed lines with subtle line-level background tints.

## 🟠⋯ Capabilities & Behavior
- Unboxed background: removes the solid colored card background and vertical padding from `edit` executions (`bgFn = undefined`, `paddingY = 0`, `paddingX = 0`), allowing edits to blend directly into the terminal background
- Line-count summary: calculates added and removed lines from the diff and displays `└ Added <A> line(s), removed <R> line(s)` immediately beneath the file path header
- Glance truncation cap: in collapsed mode (default), displays context lines plus up to 8 changed lines; diffs exceeding this cap append `... (<N> more lines, ctrl+o to expand)`
- Expanded full diff: pressing `Ctrl+O` or clicking expands the component to display the entire diff with all context and changed lines
- Line-level tinting: context lines remain plain with dim line numbers on transparent background; removed lines `-` receive subtle red background tinting with red text; added lines `+` receive subtle green background tinting with green text; single-line replacements retain word-level reverse video highlighting
- Idempotent: wraps `ToolExecutionComponent.prototype.updateDisplay` safely, guarded by a unique Symbol, and cleanly restores via `restoreEditGlance()`

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
- Preserves native metrics: keeps Pi's Line 2 (cumulative tokens, cache reads/writes, cost, context percentage, model, thinking level) and Line 3 (extension statuses) completely untouched
- Seamless Cache Guardian integration: coordinates with `rbf-cache-guardian` to right-align the passive cache guardian countdown on Line 0 alongside the status line
- Sub-millisecond TUI rendering: in-memory caching with 2-second TTL ensures zero subprocess latency during typing or streaming responses, invalidating reactively on session, turn, and bash events
- Zero external dependencies: pure TypeScript extension utilizing standard Node built-ins (`node:child_process`, `node:fs`, `node:path`, `node:os`), `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui`

## 🟠⋯ Setup & Verification
- Local verification: launch `pi -e ./extensions/rbf-status-line.ts` and inspect Line 1 of the footer (e.g. `📁 pi-rbf | 📦 pi-rbf |  main | 🌴 .claude @mm`)
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

