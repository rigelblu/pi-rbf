# pi-rbf

Rigelblu flavor of Pi coding agent extensions and capabilities.

## Extensions

- [`rbf-path-labels`](extensions/rbf-path-labels.ts) (pi-39.1 candidate, unreleased) — Fit assistant file references and native full-path labels within their pane; keep original targets, source text and completion values. [Activation and recovery](extensions/README.md#-rbf-path-labels-candidate).
- [`rbf-rename`](extensions/rbf-rename.ts) (v0.17.0) — Use `/rename` to name or rename the current Pi session while preserving native `/name`.
- [`rbf-rewind`](extensions/rbf-rewind.ts) (v0.16.0) — Use `/rewind` as a first-class alias for `/tree` to navigate session branches and checkpoints.
- [`rbf-question-form`](extensions/rbf-question-form.ts) (introduced v0.15.0; answer editing v0.21.10) — Select answers to agent questions in an inline quick-pick form. Press `W` for Write-in; use familiar Pi editor keys in Write-in or notes, `Ctrl+J` for a new line, Up through wrapped rows, Tab for choices, and Enter to submit. Pasted text has terminal controls removed before display and submission.
- [`rbf-vim`](extensions/rbf-vim.ts) (v0.14.1) — Use vim motions and text objects (ciw, diw, caw, daw, yiw, quotes, brackets) in input box with modal state machine, bottom-border mode badge, /vim toggle, and double-Esc safety.
- [`rbf-standout-commands`](extensions/rbf-standout-commands.ts) (v0.13.0) — See skills and slash commands standout in prompt as I type with vivid theme link blue highlighting and strict registry validation.
- [`rbf-click-cursor`](extensions/rbf-click-cursor.ts) (v0.12.0) — Place the prompt cursor where I click in fullscreen TUI mode with immediate screen repaint and selection prevention.
- [`rbf-image-short-text`](extensions/rbf-image-short-text.ts) (v0.11.1) — See short text (i.e. `[Image #1]`, `[Image #2]`) for pasted images instead of verbose temp file paths, delivering images natively as multimodal attachments.
- [`rbf-status-line`](extensions/rbf-status-line.ts) (introduced v0.10.0; session continuity v0.21.11) — See on my status line what I see in Claude Code (workspace, repository, worktree, agent divergence, branch, commit); footer, collapsed tool rows, clean read output, and cache cues survive session resume and reload.
- [`rbf-codex`](extensions/rbf-codex.ts) (introduced v0.21.0; manual compaction v0.21.12) — Use Codex's full agent harness through Pi: real model picker, streaming, tool rows, dialogs, steer, images, sub-agents, and manual `/compact` directly on the bound Codex thread without touching Pi transcript.
- [`rbf-cache-guardian`](extensions/rbf-cache-guardian.ts) (v0.9.0) — See when prompt cache reuse is no longer guaranteed with countdown, 10% critical alerts, and Claude Code styled /clear CTA.
- [`rbf-skill-loaded-blended`](extensions/rbf-skill-loaded-blended.ts) (v0.8.0) — Routine loaded skills blend transparently into terminal background matching Claude Code.
- [`rbf-clear`](extensions/rbf-clear.ts) (v0.7.0) — Use `/clear` to start a new chat session cleanly, matching native `/new`.
- [`rbf-clean-markdown-code`](extensions/rbf-clean-markdown-code.ts) (v0.6.0) — Clean read output without markdown fences/blank lines, and syntax highlighting matching Claude Code.
- [`rbf-edit-glance`](extensions/rbf-edit-glance.ts) (v0.5.0) — See first few lines of each edit at a glance with Claude Code background tints.
- [`rbf-tool-execution-blended`](extensions/rbf-tool-execution-blended.ts) (v0.4.0) — Routine collapsed tool calls blend into terminal background.
- [`rbf-user-message-padding`](extensions/rbf-user-message-padding.ts) (v0.3.0) — Compact user prompt display with reduced vertical padding.
- [`rbf-exit`](extensions/rbf-exit.ts) (v0.2.0) — Use `/exit` to quit Pi cleanly, matching native `/quit`.
- [`rbf-stash-prompt`](extensions/rbf-stash-prompt.ts) (v0.1.0) — Set aside current prompt in the main editor with `Ctrl+S` and restore or swap it intact.
