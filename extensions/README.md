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

---

# 🔵⋯ rbf-question-form

## 🟠⋯ Overview
Local Pi extension providing an inline, non-modal selector at the prompt line for agent questions with numbered options. Keeps recommendation and framing context in the transcript above as readable markdown, letting users pick an option with single number keys (`1`–`9`), arrow or vim keys (`j`/`k`), or `Enter`.

## 🟠⋯ Capabilities & Behavior
- Transcript Separation: The agent's full question, recommendation text, user need framing, and context paragraphs stay in the transcript as regular markdown. Only the numbered options appear in the compact interactive form.
- Input Box Overlap: Uses `ctx.ui.custom()` to temporarily occupy the input box area directly, eliminating double borders and visual separation.
- Compact Number Selection: Renders compact number chips (`[ 1 ]`, `[ 2 ]`, `[ 3 ]`, `[ 4. Write-in ]`, `[ C. /convo-is-very-best ]`) without repeating the full text that already sits right above in the transcript.
- Dark Background & Light Text: The active selection chip is highlighted with a prominent dark background and bold bright white text.
- Additional Notes Input: Embedded `Add notes to selection:` field allows typing extra instructions or modifications to append to the chosen option before submitting.
- Write-in Option: Dedicated write-in option as the last numbered option (`N+1`). Selecting it auto-focuses the notes field so any custom text can be submitted directly.
- Canned Reply: Quick chip `[ C. /convo-is-very-best ]` (or pressing `c` / `C`) immediately selects `/skill:convo-is-very-best` (with optional notes).
- Accidental ESC Recovery: If dismissed with `Esc`, the options are cached. Typing `/answer-question`, or pressing `Ctrl+Q`, re-opens the selector instantly.
- Keyboard Navigation:
  - `1`–`9` / `c`: Jump directly to option chip
  - `←` / `→` or `h` / `l`: Move selection between chips
  - `Tab` or `↓` / `j`: Move focus down to `Add notes to selection:`
  - `Shift+Tab` or `↑` / `k`: Move focus back up to options row
  - `Enter`: Confirm and submit highlighted option + notes
  - `Esc`: Clear notes or dismiss selector without submitting
- Dual Tool Registration: Exposes both `question` and `ask_question` tools accepting string options or structured `{ label, description }` objects.
- Text Detection Heuristic: Automatically activates the selector on `agent_settled` when assistant messages end with numbered options following `Recommendation:`, `User Need Framing:`, preceding `?`, or containing `← recommended` / `(recommended)` tags. Regular tutorial lists are never misidentified.

## 🟠⋯ Setup & Verification
- Local verification: launch `pi -e ./extensions/rbf-question-form.ts`, ask a question with options, select using numbers or arrows, add optional notes, or run `/answer-question`.
- Global installation: `cp ./extensions/rbf-question-form.ts ~/.pi/agent/extensions/rbf-question-form.ts`
- Removal: `rm -f ~/.pi/agent/extensions/rbf-question-form.ts`

---

# 🔵⋯ rbf-rewind

## 🟠⋯ Overview
Local Pi extension registering `/rewind` as a first-class alias for Pi's session tree navigator `/tree`. Allows users accustomed to Claude Code muscle memory to navigate checkpoints and switch session branches cleanly by typing `/rewind`.

## 🟠⋯ Capabilities & Behavior
- First-Class Alias: Typing `/rewind` in Pi's prompt editor immediately launches Pi's native session tree selector modal (`showTreeSelector()`) and clears the prompt editor.
- Argument Tolerance: Ignores trailing whitespace and arguments (e.g. `/rewind 2`, `/rewind now`, `  /rewind  `), matching native `/tree` behavior.
- Autocomplete: Registered in Pi's command list with description `"Navigate session tree (switch branches) (alias for /tree)"`, making it discoverable when typing `/re`.
- Standout Syntax Highlighting: Supported by `rbf-standout-commands`, highlighting `/rewind` as a valid keyword in the prompt.
- Non-Interactive / RPC Fallback: If executed in headless or non-interactive environments where interactive UI is unavailable, outputs an informational notification explaining that tree navigation requires interactive mode.

## 🟠⋯ Setup & Verification
- Local verification: launch `pi -e ./extensions/rbf-rewind.ts`, type `/re` to inspect autocomplete, press Enter on `/rewind` to verify tree navigation modal opens.
- Global installation: `cp ./extensions/rbf-rewind.ts ~/.pi/agent/extensions/rbf-rewind.ts`
- Removal: `rm -f ~/.pi/agent/extensions/rbf-rewind.ts`

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

# 🔵⋯ rbf-codex

## 🟠⋯ Overview
Local Pi extension that registers Codex as a model provider, so a Pi conversation runs on Codex's full agent harness with Pi as the only visible interface. Verified against Pi 0.85.1 and Codex CLI 0.154.0 on Node.

## 🟠⋯ Capabilities & Behavior
- Who owns what: Codex owns context, instructions, tools, sandbox, approval policy, compaction, and auth; Pi owns input, display, the conversation binding, and cancellation. Pi passes no policy and injects nothing
- Runtime: Pi spawns `codex app-server` over stdio as a direct child, one per Pi session, and closes it with the session (stdin EOF, then SIGTERM, then SIGKILL). No daemon, socket, or lock
- Models and effort: `/model` lists Codex's real models tagged `(Codex agent)` next to the bootstrap `codex` row; Pi's thinking selector sets the effort. Both go on every turn. The bootstrap row means Codex's default model at the picked effort. The catalog refreshes when the picker opens, at most once a day, and persists in Pi's model store
- Activity: the current command shows in the working line under the prompt; commands, exit codes, reasoning summaries, and commentary persist as thinking; the answer streams
- Binding: one `rbf-codex-thread/v1` entry `{ threadId, cwd, sessionId }` in the session log, appended after the first `thread/start`. Reopening the session resumes the thread; `/fork`, `/clone`, and `pi --fork` start a cold thread
- No turn survival: a turn running when Pi exits is interrupted in Codex; on reopen a notice asks you to send it again
- Escape sends `turn/interrupt`; manual `/compact` is cancelled with a notice; tree navigation supplies a fixed branch summary instead of asking Codex
- Refusals are fixed sentences that never trigger Pi's auto-retry: Codex missing, not logged in, another directory, image input, stopped, failed, no answer, unavailable. Details go to a notice
- `pi --sandbox` and this provider are mutually exclusive: with `--sandbox` in argv the extension registers nothing

## 🟠⋯ Setup & Verification
- Prerequisites: `codex --version` prints `codex-cli 0.154.0` and `codex login status` shows a logged-in account; the extension looks for `codex` on `PATH`, then `/Users/tomhosiawa/.local/bin/codex`
- Local verification: `pi -p --no-extensions -e ./extensions/rbf-codex.ts --model rbf-codex/codex "Reply exactly PI_CODEX_OK and nothing else."` prints `PI_CODEX_OK`; `bun run test -- extensions/rbf-codex.test.ts` runs the focused suite against a fake app-server
- Global installation: `cp ./extensions/rbf-codex.ts ~/.pi/agent/extensions/rbf-codex.ts`
- Removal: `rm -f ~/.pi/agent/extensions/rbf-codex.ts`. Codex threads, credentials, and settings are untouched; `codex resume` still opens any thread. The provider's entry in Pi's model store stays behind and is inert
