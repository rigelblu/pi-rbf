# pi-rbf

Rigelblu flavor of Pi coding agent extensions and capabilities.

## Extensions

- [`rbf-rename`](extensions/rbf-rename.ts) (v0.17.0) — Use `/rename` to name or rename the current Pi session while preserving native `/name`.
- [`rbf-rewind`](extensions/rbf-rewind.ts) (v0.16.0) — Use `/rewind` to navigate session branches with user messages first while retaining native `/tree` and filter switching.
- [`rbf-question-form`](extensions/rbf-question-form.ts) (introduced v0.15.0; safe paste v0.21.7) — Select answers to agent questions in an inline quick-pick form, with wrapped write-in text and multiline paste that removes terminal controls before display and submission.
- [`rbf-vim`](extensions/rbf-vim.ts) (v0.14.1) — Use vim motions and text objects (ciw, diw, caw, daw, yiw, quotes, brackets) in input box with modal state machine, bottom-border mode badge, /vim toggle, and double-Esc safety.
- [`rbf-standout-commands`](extensions/rbf-standout-commands.ts) (v0.13.0) — See skills and slash commands standout in prompt as I type with vivid theme link blue highlighting and strict registry validation.
- [`rbf-click-cursor`](extensions/rbf-click-cursor.ts) (v0.12.0) — Place the prompt cursor where I click in fullscreen TUI mode with immediate screen repaint and selection prevention.
- [`rbf-image-short-text`](extensions/rbf-image-short-text.ts) (v0.11.1) — See short text (i.e. `[Image #1]`, `[Image #2]`) for pasted images instead of verbose temp file paths, delivering images natively as multimodal attachments.
- [`rbf-status-line`](extensions/rbf-status-line.ts) (v0.10.0) — See on my status line what I see in Claude Code (workspace, repository, worktree, agent divergence, branch, commit).
- [`rbf-cache-guardian`](extensions/rbf-cache-guardian.ts) (v0.9.0) — See when prompt cache reuse is no longer guaranteed with countdown, 10% critical alerts, and Claude Code styled /clear CTA.
- [`rbf-skill-loaded-blended`](extensions/rbf-skill-loaded-blended.ts) (v0.8.0) — Routine loaded skills blend transparently into terminal background matching Claude Code.
- [`rbf-clear`](extensions/rbf-clear.ts) (v0.7.0) — Use `/clear` to start a new chat session cleanly, matching native `/new`.
- [`rbf-clean-markdown-code`](extensions/rbf-clean-markdown-code.ts) (v0.6.0) — Clean read output without markdown fences/blank lines, and syntax highlighting matching Claude Code.
- [`rbf-edit-glance`](extensions/rbf-edit-glance.ts) (v0.5.0) — See first few lines of each edit at a glance with Claude Code background tints.
- [`rbf-tool-execution-blended`](extensions/rbf-tool-execution-blended.ts) (v0.4.0) — Routine collapsed tool calls blend into terminal background.
- [`rbf-user-message-padding`](extensions/rbf-user-message-padding.ts) (v0.3.0) — Compact user prompt display with reduced vertical padding.
- [`rbf-exit`](extensions/rbf-exit.ts) (v0.2.0) — Use `/exit` to quit Pi cleanly, matching native `/quit`.
- [`rbf-stash-prompt`](extensions/rbf-stash-prompt.ts) (v0.1.0) — Set aside current prompt in the main editor with `Ctrl+S` and restore or swap it intact.
