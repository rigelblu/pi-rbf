import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { CustomEditorOptions, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

export const VIM_COMMAND_NAME = "vim";
export const ACTIVE_VIM_EDITOR_KEY = Symbol.for("rbf.vim.activeEditor");
export const VIM_SETTINGS_KEY = "editorMode";

export type VimMode = "insert" | "normal";
export type PendingOp = "d" | "c" | "y" | "g" | null;
export type PendingAction = "r" | "f" | "F" | null;
export type PendingModifier = "i" | "a" | null;

/**
 * Determine word boundaries for forward word motion (Vim 'w')
 */
export function findVimWordForward(line: string, col: number): number {
	if (col >= line.length) return line.length;
	let idx = col;
	const isWordChar = (ch: string) => /\w/.test(ch);
	const isSpaceChar = (ch: string) => /\s/.test(ch);

	const initialIsWord = isWordChar(line[idx] || "");
	const initialIsSpace = isSpaceChar(line[idx] || "");

	if (initialIsSpace) {
		while (idx < line.length && isSpaceChar(line[idx] || "")) idx++;
		return idx;
	}

	if (initialIsWord) {
		while (idx < line.length && isWordChar(line[idx] || "")) idx++;
	} else {
		while (idx < line.length && !isWordChar(line[idx] || "") && !isSpaceChar(line[idx] || "")) idx++;
	}

	// Skip trailing whitespace to land at start of next word
	while (idx < line.length && isSpaceChar(line[idx] || "")) idx++;
	return idx;
}

/**
 * Determine word boundaries for backward word motion (Vim 'b')
 */
export function findVimWordBackward(line: string, col: number): number {
	if (col <= 0) return 0;
	let idx = col - 1;
	const isWordChar = (ch: string) => /\w/.test(ch);
	const isSpaceChar = (ch: string) => /\s/.test(ch);

	// Skip whitespace backward
	while (idx > 0 && isSpaceChar(line[idx] || "")) idx--;

	const isWord = isWordChar(line[idx] || "");
	if (isWord) {
		while (idx > 0 && isWordChar(line[idx - 1] || "")) idx--;
	} else {
		while (idx > 0 && !isWordChar(line[idx - 1] || "") && !isSpaceChar(line[idx - 1] || "")) idx--;
	}
	return Math.max(0, idx);
}

/**
 * Determine end-of-word boundary (Vim 'e')
 */
export function findVimWordEnd(line: string, col: number): number {
	if (col >= line.length - 1) return Math.max(0, line.length - 1);
	let idx = col + 1;
	const isWordChar = (ch: string) => /\w/.test(ch);
	const isSpaceChar = (ch: string) => /\s/.test(ch);

	// Skip spaces
	while (idx < line.length && isSpaceChar(line[idx] || "")) idx++;
	if (idx >= line.length) return Math.max(0, line.length - 1);

	const isWord = isWordChar(line[idx] || "");
	while (idx < line.length - 1) {
		const next = line[idx + 1] || "";
		if (isWord ? !isWordChar(next) : (isWordChar(next) || isSpaceChar(next))) {
			break;
		}
		idx++;
	}
	return idx;
}

export function decodePrintableChar(data: string): string | undefined {
	if (data.length === 1 && data.charCodeAt(0) >= 32 && data !== "\x7f") {
		return data;
	}
	return undefined;
}

/**
 * Find range of inner word (Vim 'iw') around col.
 * Identifies contiguous word characters, contiguous whitespace, or contiguous punctuation.
 */
export function findInnerWordRange(
	line: string,
	col: number,
	count = 1,
): { startCol: number; endCol: number } | null {
	if (!line || line.length === 0) return null;
	const safeCol = Math.max(0, Math.min(col, line.length - 1));

	const isWordChar = (ch: string) => /\w/.test(ch);
	const isSpaceChar = (ch: string) => /\s/.test(ch);

	const charAt = line[safeCol] || "";
	const isWord = isWordChar(charAt);
	const isSpace = isSpaceChar(charAt);

	let start = safeCol;
	let end = safeCol + 1;

	if (isSpace) {
		while (start > 0 && isSpaceChar(line[start - 1] || "")) start--;
		while (end < line.length && isSpaceChar(line[end] || "")) end++;
	} else if (isWord) {
		while (start > 0 && isWordChar(line[start - 1] || "")) start--;
		while (end < line.length && isWordChar(line[end] || "")) end++;
	} else {
		// Punctuation
		while (start > 0 && !isWordChar(line[start - 1] || "") && !isSpaceChar(line[start - 1] || "")) start--;
		while (end < line.length && !isWordChar(line[end] || "") && !isSpaceChar(line[end] || "")) end++;
	}

	// If count > 1, expand forward over additional word/space pairs
	for (let c = 1; c < count; c++) {
		while (end < line.length && isSpaceChar(line[end] || "")) end++;
		if (end >= line.length) break;
		const nextChar = line[end] || "";
		if (isWordChar(nextChar)) {
			while (end < line.length && isWordChar(line[end] || "")) end++;
		} else {
			while (end < line.length && !isWordChar(line[end] || "") && !isSpaceChar(line[end] || "")) end++;
		}
	}

	return { startCol: start, endCol: end };
}

/**
 * Find range of a word (Vim 'aw') around col.
 * Expands inner word range to consume trailing whitespace (or leading if at EOL).
 */
export function findAWordRange(
	line: string,
	col: number,
	count = 1,
): { startCol: number; endCol: number } | null {
	const inner = findInnerWordRange(line, col, count);
	if (!inner) return null;

	let { startCol, endCol } = inner;
	const isSpaceChar = (ch: string) => /\s/.test(ch);

	// If the inner selection is already all spaces, return it
	const isAllSpaces = isSpaceChar(line[startCol] || "");
	if (isAllSpaces) {
		return { startCol, endCol };
	}

	// 1. Prefer consuming trailing whitespace
	if (endCol < line.length && isSpaceChar(line[endCol] || "")) {
		while (endCol < line.length && isSpaceChar(line[endCol] || "")) endCol++;
	} else {
		// 2. If at EOL or no trailing space, consume leading whitespace
		while (startCol > 0 && isSpaceChar(line[startCol - 1] || "")) startCol--;
	}

	return { startCol, endCol };
}

/**
 * Find quote range (Vim i", a", i', a', i`, a`) enclosing col or next on line.
 */
export function findQuoteRange(
	line: string,
	col: number,
	quote: string,
	around: boolean,
): { startCol: number; endCol: number } | null {
	if (!line || line.length < 2) return null;

	const indices: number[] = [];
	for (let i = 0; i < line.length; i++) {
		if (line[i] === quote) {
			let backslashes = 0;
			let j = i - 1;
			while (j >= 0 && line[j] === "\\") {
				backslashes++;
				j--;
			}
			if (backslashes % 2 === 0) {
				indices.push(i);
			}
		}
	}

	if (indices.length < 2) return null;

	let targetPair: [number, number] | null = null;

	// 1. Look for pair enclosing col: open <= col <= close
	for (let i = 0; i + 1 < indices.length; i += 2) {
		const open = indices[i];
		const close = indices[i + 1];
		if (open <= col && col <= close) {
			targetPair = [open, close];
			break;
		}
	}

	// 2. If not inside any pair, find first pair ahead of col
	if (!targetPair) {
		for (let i = 0; i + 1 < indices.length; i += 2) {
			const open = indices[i];
			const close = indices[i + 1];
			if (col < open) {
				targetPair = [open, close];
				break;
			}
		}
	}

	if (!targetPair) return null;

	const [open, close] = targetPair;
	if (!around) {
		return { startCol: open + 1, endCol: close };
	}

	return { startCol: open, endCol: close + 1 };
}

/**
 * Find matching bracket/pair range (Vim i(, a(, i[, a[, i{, a{, i<, a<).
 */
export function findPairRange(
	line: string,
	col: number,
	openChar: string,
	closeChar: string,
	around: boolean,
): { startCol: number; endCol: number } | null {
	if (!line) return null;

	const pairs: Array<{ open: number; close: number }> = [];
	const stack: number[] = [];

	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === openChar) {
			stack.push(i);
		} else if (ch === closeChar) {
			if (stack.length > 0) {
				const open = stack.pop()!;
				pairs.push({ open, close: i });
			}
		}
	}

	if (pairs.length === 0) return null;

	// Find enclosing pairs: open <= col <= close
	const enclosing = pairs.filter((p) => p.open <= col && col <= p.close);

	let targetPair: { open: number; close: number } | null = null;
	if (enclosing.length > 0) {
		// Innermost pair: smallest span (close - open)
		enclosing.sort((a, b) => a.close - a.open - (b.close - b.open));
		targetPair = enclosing[0];
	} else {
		// Look for next pair starting after col
		const upcoming = pairs
			.filter((p) => col < p.open)
			.sort((a, b) => a.open - b.open);
		if (upcoming.length > 0) {
			targetPair = upcoming[0];
		}
	}

	if (!targetPair) return null;

	const { open, close } = targetPair;
	if (!around) {
		return { startCol: open + 1, endCol: close };
	}

	return { startCol: open, endCol: close + 1 };
}

/**
 * VimEditor provides modal navigation and editing in Pi's prompt box.
 * Extends CustomEditor to maintain all app-level shortcuts, while adding
 * full vim motions, operators, and double-Esc safety.
 */
export class VimEditor extends CustomEditor {
	private mode: VimMode = "insert";
	private pendingOp: PendingOp = null;
	private pendingAction: PendingAction = null;
	private pendingModifier: PendingModifier = null;
	private count = 0;
	private lastFind: { char: string; direction: "f" | "F" } | null = null;
	private register = "";
	private kbManager: any;

	constructor(tui: TUI, theme: EditorTheme, keybindings: any, options?: CustomEditorOptions) {
		super(tui, theme, keybindings, options);
		this.kbManager = keybindings;
		(globalThis as any)[ACTIVE_VIM_EDITOR_KEY] = this;
	}

	getMode(): VimMode {
		return this.mode;
	}

	getPendingModifier(): PendingModifier {
		return this.pendingModifier;
	}

	getRegister(): string {
		return this.register;
	}

	setMode(mode: VimMode): void {
		this.mode = mode;
		this.pendingOp = null;
		this.pendingAction = null;
		this.pendingModifier = null;
		this.count = 0;
		this.tui?.requestRender?.();
	}

	setCursor(pos: { line: number; col: number }): void {
		const state = (this as any).state;
		if (!state) return;
		state.cursorLine = Math.max(0, Math.min(pos.line, state.lines.length - 1));
		const lineLen = state.lines[state.cursorLine]?.length || 0;
		(this as any).setCursorCol?.(Math.max(0, Math.min(pos.col, lineLen)));
		this.tui?.requestRender?.();
	}

	private getStateLines(): string[] {
		const state = (this as any).state;
		if (state && Array.isArray(state.lines)) {
			return state.lines;
		}
		return [];
	}

	renderBottomBorder(width: number, hiddenLineCount: number): string {
		if (width <= 0) return "";
		const badge = this.mode === "normal" ? " NORMAL " : " INSERT ";
		const badgeLen = badge.length;
		if (width < badgeLen + 4) {
			return super.renderBottomBorder(width, hiddenLineCount);
		}

		// Styled badge: yellow for NORMAL, dim for INSERT
		const styledBadge =
			this.mode === "normal"
				? `\x1b[1;33m${badge}\x1b[0m`
				: `\x1b[2m${badge}\x1b[0m`;

		const scrollPart = hiddenLineCount > 0 ? ` ↓ ${hiddenLineCount} more ` : "";
		const scrollLen = visibleWidth(scrollPart);

		const leftBorder = "──";
		const remaining = Math.max(0, width - 2 - badgeLen - scrollLen);
		const rightBorder = "─".repeat(remaining);

		return this.borderColor(leftBorder) + styledBadge + this.borderColor(rightBorder) + scrollPart;
	}

	handleInput(data: string): void {
		// Escape handling (The Esc Safety Guard)
		if (matchesKey(data, "escape") || this.kbManager?.matches?.(data, "app.interrupt")) {
			if (this.isShowingAutocomplete()) {
				(this as any).cancelAutocomplete?.();
				this.tui?.requestRender?.();
				return;
			}
			if (this.mode === "insert") {
				this.mode = "normal";
				this.pendingOp = null;
				this.pendingAction = null;
				this.pendingModifier = null;
				this.count = 0;
				// In Vim, returning to normal mode moves cursor back 1 col if possible
				const cursor = this.getCursor();
				if (cursor.col > 0) {
					(this as any).setCursorCol?.(cursor.col - 1);
				}
				this.tui?.requestRender?.();
				return;
			}
			// In NORMAL mode: clear pending state and SWALLOW. Never abort the agent!
			this.pendingOp = null;
			this.pendingAction = null;
			this.pendingModifier = null;
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}

		// INSERT MODE: delegate everything directly to CustomEditor
		if (this.mode === "insert") {
			super.handleInput(data);
			return;
		}

		// NORMAL MODE: Process motions, operators, counts, and verbs
		this.handleNormalInput(data);
	}

	private handleNormalInput(data: string): void {
		// Enter submits input in normal mode as well
		if (data === "\r" || data === "\n" || this.kbManager?.matches?.(data, "tui.input.submit")) {
			(this as any).submitValue?.();
			return;
		}

		// Pending action handling: r (replace char)
		if (this.pendingAction === "r") {
			const printable = decodePrintableChar(data);
			if (printable !== undefined && printable.charCodeAt(0) >= 32) {
				this.executeReplaceChar(printable);
			}
			this.pendingAction = null;
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}

		// Pending action handling: f / F (find char inline)
		if (this.pendingAction === "f" || this.pendingAction === "F") {
			const printable = decodePrintableChar(data);
			if (printable !== undefined) {
				const direction = this.pendingAction;
				this.lastFind = { char: printable, direction };
				this.executeFindChar(printable, direction, this.count || 1);
			}
			this.pendingAction = null;
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}

		// Repeat find: ';' or ','
		if (data === ";") {
			if (this.lastFind) {
				this.executeFindChar(this.lastFind.char, this.lastFind.direction, this.count || 1);
			}
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}
		if (data === ",") {
			if (this.lastFind) {
				const revDir = this.lastFind.direction === "f" ? "F" : "f";
				this.executeFindChar(this.lastFind.char, revDir, this.count || 1);
			}
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}

		// Count accumulation: numbers 1-9 start count; 0 appends if count > 0, else 0 is motion
		if (data >= "1" && data <= "9") {
			this.count = this.count * 10 + parseInt(data, 10);
			return;
		}
		if (data === "0") {
			if (this.count > 0) {
				this.count = this.count * 10;
				return;
			}
			// Motion '0': move to line start
			(this as any).setCursorCol?.(0);
			this.tui?.requestRender?.();
			return;
		}

		// Text object execution when pendingOp and pendingModifier are both active
		if (this.pendingOp && this.pendingModifier) {
			const op = this.pendingOp as "d" | "c" | "y";
			const modifier = this.pendingModifier;
			const around = modifier === "a";
			const count = this.count || 1;
			const cur = this.getCursor();
			const line = this.getLines()[cur.line] || "";

			let range: { startCol: number; endCol: number } | null = null;

			if (data === "w") {
				range = around ? findAWordRange(line, cur.col, count) : findInnerWordRange(line, cur.col, count);
			} else if (data === '"' || data === "'" || data === "`") {
				range = findQuoteRange(line, cur.col, data, around);
			} else if (data === "(" || data === ")" || data === "b") {
				range = findPairRange(line, cur.col, "(", ")", around);
			} else if (data === "[" || data === "]") {
				range = findPairRange(line, cur.col, "[", "]", around);
			} else if (data === "{" || data === "}" || data === "B") {
				range = findPairRange(line, cur.col, "{", "}", around);
			} else if (data === "<" || data === ">") {
				range = findPairRange(line, cur.col, "<", ">", around);
			}

			if (range) {
				this.applyRangeOp(op, range);
			}

			this.pendingOp = null;
			this.pendingModifier = null;
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}

		// Modifier initiator for pending operator ("i" or "a" after "d", "c", or "y")
		if (
			(this.pendingOp === "d" || this.pendingOp === "c" || this.pendingOp === "y") &&
			this.pendingModifier === null
		) {
			if (data === "i" || data === "a") {
				this.pendingModifier = data;
				return;
			}
		}

		// Pending operator handling: d (delete)
		if (this.pendingOp === "d") {
			const n = this.count || 1;
			if (data === "d") {
				this.executeDeleteLines(n);
			} else if (data === "w") {
				this.executeDeleteWord(n, false);
			} else if (data === "e") {
				this.executeDeleteWord(n, true);
			} else if (data === "b") {
				this.executeDeleteWordBackward(n);
			} else if (data === "$") {
				(this as any).pushUndoSnapshot?.();
				(this as any).deleteToEndOfLine?.();
			} else if (data === "0" || data === "^") {
				(this as any).pushUndoSnapshot?.();
				(this as any).deleteToStartOfLine?.();
			}
			this.pendingOp = null;
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}

		// Pending operator handling: c (change)
		if (this.pendingOp === "c") {
			const n = this.count || 1;
			if (data === "c") {
				(this as any).pushUndoSnapshot?.();
				const lines = this.getStateLines();
				const cur = this.getCursor();
				lines[cur.line] = "";
				(this as any).setCursorCol?.(0);
				(this as any).onChange?.(this.getText());
				this.mode = "insert";
			} else if (data === "w" || data === "e") {
				this.executeDeleteWord(n, data === "e");
				this.mode = "insert";
			} else if (data === "b") {
				this.executeDeleteWordBackward(n);
				this.mode = "insert";
			} else if (data === "$") {
				(this as any).pushUndoSnapshot?.();
				(this as any).deleteToEndOfLine?.();
				this.mode = "insert";
			} else if (data === "0" || data === "^") {
				(this as any).pushUndoSnapshot?.();
				(this as any).deleteToStartOfLine?.();
				this.mode = "insert";
			}
			this.pendingOp = null;
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}

		// Pending operator handling: y (yank)
		if (this.pendingOp === "y") {
			const n = this.count || 1;
			if (data === "y") {
				this.executeYankLines(n);
			} else if (data === "w") {
				this.executeYankWord(n);
			} else if (data === "$") {
				this.executeYankToEnd();
			}
			this.pendingOp = null;
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}

		// Operator initiators
		if (data === "d") {
			this.pendingOp = "d";
			return;
		}
		if (data === "c") {
			this.pendingOp = "c";
			return;
		}
		if (data === "y") {
			this.pendingOp = "y";
			return;
		}
		if (data === "r") {
			this.pendingAction = "r";
			return;
		}
		if (data === "f") {
			this.pendingAction = "f";
			return;
		}
		if (data === "F") {
			this.pendingAction = "F";
			return;
		}

		// Two-key motions: 'g' sequence ('gg')
		if (this.pendingOp === "g") {
			if (data === "g") {
				const state = (this as any).state;
				if (state) state.cursorLine = 0;
				(this as any).moveToLineStart?.();
			}
			this.pendingOp = null;
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "g") {
			this.pendingOp = "g";
			return;
		}

		// Insertion entry points
		if (data === "i") {
			this.mode = "insert";
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "I") {
			const line = this.getLines()[this.getCursor().line] || "";
			const firstNonBlank = line.search(/\S/);
			(this as any).setCursorCol?.(firstNonBlank !== -1 ? firstNonBlank : 0);
			this.mode = "insert";
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "a") {
			const line = this.getLines()[this.getCursor().line] || "";
			if (this.getCursor().col < line.length) {
				(this as any).setCursorCol?.(this.getCursor().col + 1);
			}
			this.mode = "insert";
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "A") {
			(this as any).moveToLineEnd?.();
			this.mode = "insert";
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "o") {
			(this as any).pushUndoSnapshot?.();
			const cur = this.getCursor();
			const lines = this.getStateLines();
			lines.splice(cur.line + 1, 0, "");
			const state = (this as any).state;
			if (state) state.cursorLine = cur.line + 1;
			(this as any).setCursorCol?.(0);
			(this as any).onChange?.(this.getText());
			this.mode = "insert";
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "O") {
			(this as any).pushUndoSnapshot?.();
			const cur = this.getCursor();
			const lines = this.getStateLines();
			lines.splice(cur.line, 0, "");
			const state = (this as any).state;
			if (state) state.cursorLine = cur.line;
			(this as any).setCursorCol?.(0);
			(this as any).onChange?.(this.getText());
			this.mode = "insert";
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}

		// Editing verbs
		if (data === "x") {
			(this as any).pushUndoSnapshot?.();
			const n = this.count || 1;
			for (let i = 0; i < n; i++) {
				(this as any).handleForwardDelete?.();
			}
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "X") {
			(this as any).pushUndoSnapshot?.();
			const n = this.count || 1;
			for (let i = 0; i < n; i++) {
				(this as any).handleBackspace?.();
			}
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "D") {
			(this as any).pushUndoSnapshot?.();
			(this as any).deleteToEndOfLine?.();
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "C") {
			(this as any).pushUndoSnapshot?.();
			(this as any).deleteToEndOfLine?.();
			this.mode = "insert";
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "u") {
			(this as any).undo?.();
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "p") {
			this.executePaste(false);
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "P") {
			this.executePaste(true);
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}

		// Motions
		const n = this.count || 1;
		if (data === "h" || matchesKey(data, "left")) {
			for (let i = 0; i < n; i++) (this as any).moveCursor?.(0, -1);
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "l" || matchesKey(data, "right")) {
			for (let i = 0; i < n; i++) (this as any).moveCursor?.(0, 1);
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "j" || matchesKey(data, "down")) {
			for (let i = 0; i < n; i++) (this as any).moveCursor?.(1, 0);
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "k" || matchesKey(data, "up")) {
			for (let i = 0; i < n; i++) (this as any).moveCursor?.(-1, 0);
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "w") {
			for (let i = 0; i < n; i++) this.executeMoveWordForward();
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "b") {
			for (let i = 0; i < n; i++) this.executeMoveWordBackward();
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "e") {
			for (let i = 0; i < n; i++) this.executeMoveWordEnd();
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "^") {
			const line = this.getLines()[this.getCursor().line] || "";
			const firstNonBlank = line.search(/\S/);
			(this as any).setCursorCol?.(firstNonBlank !== -1 ? firstNonBlank : 0);
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "$") {
			(this as any).moveToLineEnd?.();
			const lineLen = (this.getLines()[this.getCursor().line] || "").length;
			if (lineLen > 0) {
				(this as any).setCursorCol?.(lineLen - 1);
			}
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "G") {
			const lines = this.getLines();
			const target = this.count > 0 ? Math.min(this.count - 1, lines.length - 1) : lines.length - 1;
			const state = (this as any).state;
			if (state) state.cursorLine = Math.max(0, target);
			(this as any).moveToLineStart?.();
			this.count = 0;
			this.tui?.requestRender?.();
			return;
		}

		// Pass control keys (Ctrl+C, Ctrl+D, Ctrl+P, etc.) through to CustomEditor
		if (data.length > 1 || (data.charCodeAt(0) < 32 && data !== "\r" && data !== "\n")) {
			super.handleInput(data);
			return;
		}

		// Unmapped printable character in normal mode: reset count and swallow
		this.count = 0;
	}

	private executeMoveWordForward(): void {
		const cur = this.getCursor();
		const lines = this.getLines();
		const line = lines[cur.line] || "";
		const nextCol = findVimWordForward(line, cur.col);
		if (nextCol >= line.length && cur.line < lines.length - 1) {
			const state = (this as any).state;
			if (state) state.cursorLine = cur.line + 1;
			(this as any).setCursorCol?.(0);
		} else {
			(this as any).setCursorCol?.(Math.min(nextCol, line.length));
		}
	}

	private executeMoveWordBackward(): void {
		const cur = this.getCursor();
		const lines = this.getLines();
		if (cur.col === 0 && cur.line > 0) {
			const prevLine = lines[cur.line - 1] || "";
			const state = (this as any).state;
			if (state) state.cursorLine = cur.line - 1;
			(this as any).setCursorCol?.(prevLine.length);
			return;
		}
		const line = lines[cur.line] || "";
		const prevCol = findVimWordBackward(line, cur.col);
		(this as any).setCursorCol?.(prevCol);
	}

	private executeMoveWordEnd(): void {
		const cur = this.getCursor();
		const lines = this.getLines();
		const line = lines[cur.line] || "";
		if (cur.col >= line.length - 1 && cur.line < lines.length - 1) {
			const nextLine = lines[cur.line + 1] || "";
			const state = (this as any).state;
			if (state) state.cursorLine = cur.line + 1;
			(this as any).setCursorCol?.(findVimWordEnd(nextLine, 0));
			return;
		}
		const endCol = findVimWordEnd(line, cur.col);
		(this as any).setCursorCol?.(endCol);
	}

	private executeFindChar(targetChar: string, direction: "f" | "F", times: number): void {
		const cur = this.getCursor();
		const line = this.getLines()[cur.line] || "";
		let col = cur.col;
		for (let i = 0; i < times; i++) {
			if (direction === "f") {
				const idx = line.indexOf(targetChar, col + 1);
				if (idx === -1) break;
				col = idx;
			} else {
				const idx = line.lastIndexOf(targetChar, Math.max(0, col - 1));
				if (idx === -1) break;
				col = idx;
			}
		}
		(this as any).setCursorCol?.(col);
	}

	private executeReplaceChar(char: string): void {
		(this as any).pushUndoSnapshot?.();
		const cur = this.getCursor();
		const lines = this.getStateLines();
		const line = lines[cur.line] || "";
		if (cur.col < line.length) {
			lines[cur.line] = line.slice(0, cur.col) + char + line.slice(cur.col + 1);
			(this as any).onChange?.(this.getText());
		}
	}

	private applyRangeOp(
		op: "d" | "c" | "y",
		range: { startCol: number; endCol: number },
	): void {
		const cur = this.getCursor();
		const lines = this.getStateLines();
		const line = lines[cur.line] || "";
		const startCol = Math.max(0, Math.min(range.startCol, line.length));
		const endCol = Math.max(startCol, Math.min(range.endCol, line.length));

		const selectedText = line.slice(startCol, endCol);
		this.register = selectedText;

		if (op === "y") {
			return;
		}

		(this as any).pushUndoSnapshot?.();
		lines[cur.line] = line.slice(0, startCol) + line.slice(endCol);

		if (op === "c") {
			(this as any).setCursorCol?.(startCol);
			(this as any).onChange?.(this.getText());
			this.mode = "insert";
		} else if (op === "d") {
			const newLineLen = lines[cur.line].length;
			const targetCol = newLineLen === 0 ? 0 : Math.min(startCol, newLineLen - 1);
			(this as any).setCursorCol?.(targetCol);
			(this as any).onChange?.(this.getText());
			this.mode = "normal";
		}
	}

	private executeDeleteLines(count: number): void {
		(this as any).pushUndoSnapshot?.();
		const lines = this.getStateLines();
		const cur = this.getCursor();
		const startLine = cur.line;
		const deleteCount = Math.min(count, lines.length - startLine);

		const deletedLines = lines.slice(startLine, startLine + deleteCount);
		this.register = deletedLines.join("\n") + "\n";

		if (lines.length <= deleteCount) {
			lines.splice(0, lines.length, "");
			const state = (this as any).state;
			if (state) state.cursorLine = 0;
			(this as any).setCursorCol?.(0);
		} else {
			lines.splice(startLine, deleteCount);
			const state = (this as any).state;
			if (state && state.cursorLine >= lines.length) {
				state.cursorLine = lines.length - 1;
			}
			const lineLen = (lines[this.getCursor().line] || "").length;
			(this as any).setCursorCol?.(Math.min(cur.col, Math.max(0, lineLen - 1)));
		}
		(this as any).onChange?.(this.getText());
	}

	private executeDeleteWord(count: number, toEnd: boolean): void {
		(this as any).pushUndoSnapshot?.();
		const cur = this.getCursor();
		const lines = this.getStateLines();
		const line = lines[cur.line] || "";
		let endCol = cur.col;
		for (let i = 0; i < count; i++) {
			endCol = toEnd ? findVimWordEnd(line, endCol) + 1 : findVimWordForward(line, endCol);
		}
		const deleted = line.slice(cur.col, endCol);
		this.register = deleted;
		lines[cur.line] = line.slice(0, cur.col) + line.slice(endCol);
		(this as any).onChange?.(this.getText());
	}

	private executeDeleteWordBackward(count: number): void {
		(this as any).pushUndoSnapshot?.();
		const cur = this.getCursor();
		const lines = this.getStateLines();
		const line = lines[cur.line] || "";
		let startCol = cur.col;
		for (let i = 0; i < count; i++) {
			startCol = findVimWordBackward(line, startCol);
		}
		const deleted = line.slice(startCol, cur.col);
		this.register = deleted;
		lines[cur.line] = line.slice(0, startCol) + line.slice(cur.col);
		(this as any).setCursorCol?.(startCol);
		(this as any).onChange?.(this.getText());
	}

	private executeYankLines(count: number): void {
		const lines = this.getLines();
		const cur = this.getCursor();
		const startLine = cur.line;
		const yankCount = Math.min(count, lines.length - startLine);
		this.register = lines.slice(startLine, startLine + yankCount).join("\n") + "\n";
	}

	private executeYankWord(count: number): void {
		const cur = this.getCursor();
		const line = this.getLines()[cur.line] || "";
		let endCol = cur.col;
		for (let i = 0; i < count; i++) {
			endCol = findVimWordForward(line, endCol);
		}
		this.register = line.slice(cur.col, endCol);
	}

	private executeYankToEnd(): void {
		const cur = this.getCursor();
		const line = this.getLines()[cur.line] || "";
		this.register = line.slice(cur.col);
	}

	private executePaste(before: boolean): void {
		if (!this.register) return;
		(this as any).pushUndoSnapshot?.();
		const cur = this.getCursor();
		const lines = this.getStateLines();

		if (this.register.endsWith("\n")) {
			// Line-wise paste
			const pasteLines = this.register.slice(0, -1).split("\n");
			const insertAt = before ? cur.line : cur.line + 1;
			lines.splice(insertAt, 0, ...pasteLines);
			const state = (this as any).state;
			if (state) state.cursorLine = insertAt;
			(this as any).setCursorCol?.(0);
		} else {
			// Character-wise paste
			const line = lines[cur.line] || "";
			const insertCol = before ? cur.col : Math.min(line.length, cur.col + 1);
			lines[cur.line] = line.slice(0, insertCol) + this.register + line.slice(insertCol);
			(this as any).setCursorCol?.(insertCol + this.register.length - 1);
		}
		(this as any).onChange?.(this.getText());
	}
}

export function getSettingsPaths(cwd?: string): string[] {
	const paths: string[] = [];
	if (cwd) {
		paths.push(join(cwd, ".pi", "settings.json"));
	}
	const agentDir = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
	paths.push(join(agentDir, "settings.json"));
	return paths;
}

export function loadMergedSettings(cwd?: string): Record<string, any> {
	let merged: Record<string, any> = {};
	const paths = getSettingsPaths(cwd);
	for (let i = paths.length - 1; i >= 0; i--) {
		const p = paths[i];
		try {
			if (existsSync(p)) {
				const content = readFileSync(p, "utf-8");
				const parsed = JSON.parse(content);
				if (parsed && typeof parsed === "object") {
					merged = { ...merged, ...parsed };
				}
			}
		} catch {
			// Ignore parse errors
		}
	}
	return merged;
}

export function isVimEnabledInSettings(cwd?: string): boolean {
	const settings = loadMergedSettings(cwd);
	return settings.editorMode === "vim" || settings.vimMode === true;
}

export function persistVimSetting(enabled: boolean): void {
	const agentDir = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
	const settingsPath = join(agentDir, "settings.json");
	try {
		let current: Record<string, any> = {};
		if (existsSync(settingsPath)) {
			try {
				current = JSON.parse(readFileSync(settingsPath, "utf-8")) || {};
			} catch {
				current = {};
			}
		} else {
			mkdirSync(agentDir, { recursive: true });
		}
		current.editorMode = enabled ? "vim" : "standard";
		writeFileSync(settingsPath, JSON.stringify(current, null, 2), "utf-8");
	} catch {
		// Ignore write errors
	}
}

export default function rbfVim(pi: ExtensionAPI): void {
	// Autoload Vim mode if configured in settings
	pi.on("session_start", (_event, ctx) => {
		const cwd = ctx.sessionManager?.getCwd?.();
		if (isVimEnabledInSettings(cwd)) {
			ctx.ui?.setEditorComponent?.((tui, theme, kb) => new VimEditor(tui, theme, kb));
		}
	});

	// Register /vim slash command
	pi.registerCommand(VIM_COMMAND_NAME, {
		description: "Toggle vim modal editing in prompt editor (/vim, /vim on, /vim off)",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const normalized = (args || "").trim().toLowerCase();
			const active = Boolean((globalThis as any)[ACTIVE_VIM_EDITOR_KEY]);

			let enable: boolean;
			if (normalized === "on") {
				enable = true;
			} else if (normalized === "off") {
				enable = false;
			} else {
				// Toggle
				enable = !active;
			}

			if (enable) {
				ctx.ui?.setEditorComponent?.((tui, theme, kb) => new VimEditor(tui, theme, kb));
				persistVimSetting(true);
				ctx.ui?.notify?.("✓ Vim mode enabled", "info");
			} else {
				ctx.ui?.setEditorComponent?.(undefined);
				delete (globalThis as any)[ACTIVE_VIM_EDITOR_KEY];
				persistVimSetting(false);
				ctx.ui?.notify?.("✓ Vim mode disabled", "info");
			}
		},
	});
}
