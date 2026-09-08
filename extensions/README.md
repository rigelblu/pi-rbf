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
