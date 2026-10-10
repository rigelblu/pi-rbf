import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	Key,
	KeybindingsManager,
	matchesKey,
	Text,
	StdinBuffer,
	truncateToWidth,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ─── Option types & chips ───────────────────────────────────────────────────

export interface NormalizedOption {
	index: number;
	label: string;
	description?: string;
	fullText: string;
}

export interface QuestionChip {
	key: string;
	type: "option" | "write-in" | "canned";
	label: string;
	fullText?: string;
	cannedCommand?: string;
}

export interface QuestionFormState {
	chips: QuestionChip[];
	selectedChipIndex: number;
	focus: "options" | "notes";
	notesText: string;
	notesCursorPos: number;
	theme: Theme;
}

// ─── Text detection heuristic ────────────────────────────────────────────────

/**
 * Extract numbered option lines from the tail of an assistant message.
 * Returns the option lines if a question pattern is detected, or null.
 *
 * Patterns detected:
 * 1. `Recommendation:` or `User Need Framing:` followed by a numbered list
 * 2. A line ending in `?` immediately preceding a numbered list
 * 3. Any numbered item containing `← recommended` or `(recommended)`
 *
 * Regular tutorial numbered lists do NOT trigger the form.
 */
export function detectQuestionOptions(text: string): string[] | null {
	const lines = text.split("\n");

	// Find all numbered list items (consecutive block at the end of the message)
	const numberedPattern = /^\s*(\d+)\.\s+(.+)/;
	let lastNumberedEnd = -1;
	let firstNumberedStart = -1;

	// Scan backward from end to find the last consecutive block of numbered items
	for (let i = lines.length - 1; i >= 0; i--) {
		const trimmed = lines[i].trim();
		if (trimmed === "") continue; // skip trailing blank lines
		if (numberedPattern.test(trimmed)) {
			if (lastNumberedEnd === -1) lastNumberedEnd = i;
			firstNumberedStart = i;
		} else {
			if (lastNumberedEnd !== -1) break; // we've left the numbered block
		}
	}

	if (lastNumberedEnd === -1 || firstNumberedStart === -1) return null;

	// Extract the numbered items
	const numberedItems: string[] = [];
	for (let i = firstNumberedStart; i <= lastNumberedEnd; i++) {
		const match = lines[i].match(numberedPattern);
		if (match) numberedItems.push(lines[i].trim());
	}

	if (numberedItems.length < 2) return null;

	// Check for question context patterns
	const textBefore = lines.slice(0, firstNumberedStart).join("\n");

	// Pattern 1: Recommendation: or User Need Framing:
	if (/Recommendation:/i.test(textBefore) || /User Need Framing:/i.test(textBefore)) {
		return numberedItems;
	}

	// Pattern 2: A line ending in ? immediately preceding the numbered list
	for (let i = firstNumberedStart - 1; i >= 0; i--) {
		const trimmed = lines[i].trim();
		if (trimmed === "") continue;
		if (trimmed.endsWith("?")) return numberedItems;
		break; // first non-empty line before numbered list doesn't end with ?
	}

	// Pattern 3: Any numbered item with ← recommended or (recommended)
	const recommendedPattern = /←\s*recommended|\(recommended\)/i;
	for (const item of numberedItems) {
		if (recommendedPattern.test(item)) return numberedItems;
	}

	return null;
}

/**
 * Parse a numbered option line into a NormalizedOption.
 */
export function parseNumberedOption(line: string, index: number): NormalizedOption {
	const match = line.match(/^\s*\d+\.\s+(.*)/);
	const label = match ? match[1] : line;
	return {
		index,
		label,
		description: undefined,
		fullText: line.trim(),
	};
}

// ─── Tool schema ─────────────────────────────────────────────────────────────

const OptionObjectSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const OptionSchema = Type.Union([
	Type.String({ description: "Simple option text" }),
	OptionObjectSchema,
]);

const QuestionParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Array(OptionSchema, { description: "Options for the user to choose from" }),
});

/**
 * Normalize a tool option into a NormalizedOption.
 */
export function normalizeToolOption(raw: string | { label: string; description?: string }, index: number): NormalizedOption {
	if (typeof raw === "string") {
		return {
			index,
			label: raw,
			description: undefined,
			fullText: `${index + 1}. ${raw}`,
		};
	}
	return {
		index,
		label: raw.label,
		description: raw.description,
		fullText: `${index + 1}. ${raw.label}`,
	};
}

// ─── Chips & submission helpers ──────────────────────────────────────────────

export function buildChips(options: NormalizedOption[]): QuestionChip[] {
	const chips: QuestionChip[] = options.map((opt, i) => ({
		key: String(i + 1),
		type: "option" as const,
		label: String(i + 1),
		fullText: opt.fullText,
	}));

	// Canned reply option
	chips.push({
		key: "c",
		type: "canned",
		label: "C. /convo-is-very-best",
		cannedCommand: "/skill:convo-is-very-best",
	});

	// Write-in option
	chips.push({
		key: "w",
		type: "write-in",
		label: "W. Write-in",
	});

	return chips;
}

export function buildSubmissionText(chip: QuestionChip, notes: string): string {
	const trimmedNotes = notes.trim();

	if (chip.type === "canned") {
		const cmd = chip.cannedCommand ?? "/skill:convo-is-very-best";
		if (!trimmedNotes) return cmd;
		return `${cmd}\n\n${trimmedNotes}`;
	}

	if (chip.type === "write-in") {
		if (!trimmedNotes) return "";
		return trimmedNotes;
	}

	const baseText = chip.fullText ?? chip.label;
	if (!trimmedNotes) return baseText;
	return `${baseText}\n\n${trimmedNotes}`;
}

/**
 * Retrieve active theme from Pi's global symbol registration or package export.
 */
export function getActiveTheme(): any {
	if (typeof globalThis !== "undefined") {
		const globalTheme =
			(globalThis as any)[Symbol.for("@earendil-works/pi-coding-agent:theme")] ??
			(globalThis as any)[Symbol.for("@mariozechner/pi-coding-agent:theme")];
		if (globalTheme) return globalTheme;
	}
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { theme } = require("@earendil-works/pi-coding-agent");
		if (theme) return theme;
	} catch {
		// ignore
	}
	return undefined;
}

/**
 * Style borders and labels using the active theme's border color.
 */
export function styleBorder(theme: any, text: string): string {
	const activeTheme = theme ?? getActiveTheme();
	if (typeof activeTheme?.fg === "function") {
		try {
			return activeTheme.fg("border", text);
		} catch {
			// fallback
		}
	}
	return `\x1b[38;5;75m${text}\x1b[0m`;
}

/**
 * Render active chip using theme colors.
 * Converts borderAccent (foam in rose-pine-dawn, #56949f) into a pill background with light text.
 */
export function renderActiveChip(theme: any, label: string): string {
	const activeTheme = theme ?? getActiveTheme();
	if (typeof activeTheme?.getFgAnsi === "function") {
		try {
			const fgAnsi = activeTheme.getFgAnsi("borderAccent");
			if (fgAnsi) {
				const bgAnsi = fgAnsi.replace("[38;", "[48;");
				return `${bgAnsi}\x1b[1;38;5;255m ${label} \x1b[0m`;
			}
		} catch {
			// fallback
		}
	}
	if (typeof activeTheme?.bg === "function") {
		try {
			return activeTheme.bg("selectedBg", ` ${label} `);
		} catch {
			// fallback
		}
	}
	return `\x1b[7m\x1b[1m ${label} \x1b[0m`;
}

// ─── Word-wrap helpers ───────────────────────────────────────────────────────

const cjkBreakRegex = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;

function isWhitespaceChar(char: string): boolean {
	return /\s/.test(char);
}

const PASTE_MARKER_SINGLE = /^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$/;

function isPasteMarker(segment: string): boolean {
	return segment.length >= 10 && PASTE_MARKER_SINGLE.test(segment);
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const wordPunctuation = /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/;

// The form uses only the plain-text branch of Pi TUI's private word-navigation
// module. Keep it local: Pi's extension loader resolves the public package root,
// but cannot resolve private package subpaths from ~/.pi/agent/extensions/.
function findFormWordBackward(text: string, cursor: number): number {
	if (cursor <= 0) return 0;
	const segments = [...wordSegmenter.segment(text.slice(0, cursor))];
	let nextCursor = cursor;
	while (segments.length > 0 && isWhitespaceChar(segments[segments.length - 1].segment)) {
		nextCursor -= segments.pop()!.segment.length;
	}
	if (segments.length === 0) return nextCursor;
	const last = segments[segments.length - 1];
	if (last.isWordLike) {
		const matches = [...last.segment.matchAll(new RegExp(wordPunctuation, "g"))];
		const end = matches.length ? matches[matches.length - 1].index! + matches[matches.length - 1][0].length : 0;
		nextCursor -= last.segment.length - end;
	} else {
		while (segments.length > 0 && !segments[segments.length - 1].isWordLike && !isWhitespaceChar(segments[segments.length - 1].segment)) {
			nextCursor -= segments.pop()!.segment.length;
		}
	}
	return nextCursor;
}

function findFormWordForward(text: string, cursor: number): number {
	if (cursor >= text.length) return text.length;
	const iterator = wordSegmenter.segment(text.slice(cursor))[Symbol.iterator]();
	let next = iterator.next();
	let nextCursor = cursor;
	while (!next.done && isWhitespaceChar(next.value.segment)) {
		nextCursor += next.value.segment.length;
		next = iterator.next();
	}
	if (next.done) return nextCursor;
	if (next.value.isWordLike) {
		nextCursor += wordPunctuation.exec(next.value.segment)?.index ?? next.value.segment.length;
	} else {
		while (!next.done && !next.value.isWordLike && !isWhitespaceChar(next.value.segment)) {
			nextCursor += next.value.segment.length;
			next = iterator.next();
		}
	}
	return nextCursor;
}

export interface TextChunk {
	text: string;
	startIndex: number;
	endIndex: number;
}

/**
 * Split a line into word-wrapped chunks.
 * Wraps at word boundaries when possible, falling back to character-level
 * wrapping for words longer than the available width.
 * Ported from @earendil-works/pi-tui/dist/components/editor.js.
 */
export function wordWrapLine(
	line: string,
	maxWidth: number,
	preSegmented?: Intl.SegmentData[],
): TextChunk[] {
	if (!line || maxWidth <= 0) {
		return [{ text: "", startIndex: 0, endIndex: 0 }];
	}
	const lineWidth = visibleWidth(line);
	if (lineWidth <= maxWidth) {
		return [{ text: line, startIndex: 0, endIndex: line.length }];
	}
	const chunks: TextChunk[] = [];
	const segments: Intl.SegmentData[] = preSegmented ?? [...graphemeSegmenter.segment(line)];
	let currentWidth = 0;
	let chunkStart = 0;
	let wrapOppIndex = -1;
	let wrapOppWidth = 0;

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const grapheme = seg.segment;
		const gWidth = visibleWidth(grapheme);
		const charIndex = seg.index;
		const isWs = !isPasteMarker(grapheme) && isWhitespaceChar(grapheme);

		if (currentWidth + gWidth > maxWidth) {
			if (wrapOppIndex >= 0 && currentWidth - wrapOppWidth + gWidth <= maxWidth) {
				chunks.push({
					text: line.slice(chunkStart, wrapOppIndex),
					startIndex: chunkStart,
					endIndex: wrapOppIndex,
				});
				chunkStart = wrapOppIndex;
				currentWidth -= wrapOppWidth;
			} else if (chunkStart < charIndex) {
				chunks.push({
					text: line.slice(chunkStart, charIndex),
					startIndex: chunkStart,
					endIndex: charIndex,
				});
				chunkStart = charIndex;
				currentWidth = 0;
			}
			wrapOppIndex = -1;
		}

		if (gWidth > maxWidth) {
			const subChunks = wordWrapLine(grapheme, maxWidth);
			for (let j = 0; j < subChunks.length - 1; j++) {
				const sc = subChunks[j];
				chunks.push({
					text: sc.text,
					startIndex: charIndex + sc.startIndex,
					endIndex: charIndex + sc.endIndex,
				});
			}
			const last = subChunks[subChunks.length - 1];
			chunkStart = charIndex + last.startIndex;
			currentWidth = visibleWidth(last.text);
			wrapOppIndex = -1;
			continue;
		}

		currentWidth += gWidth;

		const next = segments[i + 1];
		if (isWs && next && (isPasteMarker(next.segment) || !isWhitespaceChar(next.segment))) {
			wrapOppIndex = next.index;
			wrapOppWidth = currentWidth;
		} else if (!isWs && next && !isWhitespaceChar(next.segment)) {
			const isCjk = !isPasteMarker(grapheme) && cjkBreakRegex.test(grapheme);
			const nextIsCjk = !isPasteMarker(next.segment) && cjkBreakRegex.test(next.segment);
			if (isCjk || nextIsCjk) {
				wrapOppIndex = next.index;
				wrapOppWidth = currentWidth;
			}
		}
	}

	chunks.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length });
	return chunks;
}

function styleDim(theme: any, text: string): string {
	if (typeof theme?.fg === "function") {
		try {
			return theme.fg("dim", text);
		} catch {
			// fallback
		}
	}
	return text;
}

// ─── Component Rendering ────────────────────────────────────────────────────

interface ChipTarget {
	chipIndex: number;
	x: number;
	y: number;
	width: number;
}

function layoutChips(state: QuestionFormState, width: number, hoveredChipIndex?: number): { rows: string[]; targets: ChipTarget[] } {
	const rows: string[] = [];
	const targets: ChipTarget[] = [];
	let row = "  ";
	let x = 2;
	for (const [chipIndex, chip] of state.chips.entries()) {
		const label = visibleWidth(chip.label) + 4 > width - 2 && chip.type !== "option"
			? chip.key.toUpperCase() : chip.label;
		const chipWidth = visibleWidth(label) + 4;
		if (x > 2 && x + 3 + chipWidth > width) {
			rows.push(row);
			row = "  ";
			x = 2;
		}
		if (x > 2) { row += "   "; x += 3; }
		const rendered = chipIndex === state.selectedChipIndex
			? " " + renderActiveChip(state.theme, label) + " "
			: chipIndex === hoveredChipIndex
				? `\x1b[7m[ ${label} ]\x1b[0m`
				: state.theme?.fg ? state.theme.fg("muted", `[ ${label} ]`) : `[ ${label} ]`;
		row += rendered;
		if (x + chipWidth <= width) targets.push({ chipIndex, x, y: rows.length + 1, width: chipWidth });
		x += chipWidth;
	}
	rows.push(row);
	return { rows, targets };
}

export function renderQuestionFormLines(state: QuestionFormState, width: number, mouseEnabled = false): string[] {
	return renderQuestionForm(state, width, mouseEnabled, layoutChips(state, Math.max(1, width)));
}

function renderQuestionForm(
	state: QuestionFormState, width: number, mouseEnabled: boolean,
	layout: ReturnType<typeof layoutChips>,
): string[] {
	const { chips, selectedChipIndex, focus, notesText, notesCursorPos, theme } = state;
	const renderWidth = Math.max(1, width);
	const maxWidth = Math.max(1, renderWidth - 3);
	const lines: string[] = [];

	// Top border (theme border color)
	const title = " Select Answer ";
	const borderDashCount = Math.max(0, renderWidth - title.length - 1);
	lines.push(styleBorder(theme, "─" + title + "─".repeat(borderDashCount)));

	lines.push(...layout.rows);
	lines.push("");

	// Notes field
	const isWriteIn = chips[selectedChipIndex]?.type === "write-in";
	const label = isWriteIn ? "Write in your answer: " : "Add notes to selection: ";

	if (!notesText) {
		if (focus === "notes") {
			// Empty focused: label + cursor blank + ` (required)` (write-in) or label + cursor blank (notes)
			const requiredSuffix = isWriteIn ? " (required)" : "";
			const plainStr = label + " " + requiredSuffix;
			const cursorIndex = label.length;
			const chunks = wordWrapLine(plainStr, maxWidth);

			for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
				const chunk = chunks[chunkIndex];
				const isLastChunk = chunkIndex === chunks.length - 1;

				const labelChars = Math.max(0, Math.min(chunk.text.length, label.length - chunk.startIndex));
				const labelPart = chunk.text.slice(0, labelChars);
				const remainder = chunk.text.slice(labelChars);

				const hasCursor = isLastChunk
					? cursorIndex >= chunk.startIndex
					: cursorIndex >= chunk.startIndex && cursorIndex < chunk.endIndex;

				if (hasCursor) {
					const adjustedPos = Math.max(0, Math.min(chunk.text.length, cursorIndex - chunk.startIndex));
					const remainderCursorPos = Math.max(0, Math.min(remainder.length, adjustedPos - labelChars));
					const beforeCursor = remainder.slice(0, remainderCursorPos);
					const afterCursor = remainder.slice(remainderCursorPos);
					const cursorBlank = "\x1b[7m \x1b[0m";
					const hintPart = afterCursor.slice(1);
					const styledHint = hintPart ? styleDim(theme, hintPart) : "";
					const styledRemainder = beforeCursor + cursorBlank + styledHint;
					const styledLabel = labelPart ? styleBorder(theme, labelPart) : "";
					lines.push("  " + styledLabel + styledRemainder);
				} else {
					if (chunk.startIndex >= cursorIndex) {
						lines.push("  " + styleDim(theme, chunk.text.trimEnd()));
					} else {
						lines.push("  " + styleBorder(theme, chunk.text));
					}
				}
			}
		} else {
			// Empty unfocused: label + placeholder in dim, no cursor
			const placeholder = isWriteIn ? "(required, press Tab or ↓ to type)" : "(optional, press Tab or ↓ to type)";
			const plainStr = label + placeholder;
			const chunks = wordWrapLine(plainStr, maxWidth);

			for (const chunk of chunks) {
				const labelChars = Math.max(0, Math.min(chunk.text.length, label.length - chunk.startIndex));
				const labelPart = chunk.text.slice(0, labelChars);
				const placeholderPart = chunk.text.slice(labelChars);
				const styledLabel = labelPart ? styleBorder(theme, labelPart) : "";
				const styledPlaceholder = placeholderPart ? styleDim(theme, placeholderPart) : "";
				lines.push("  " + styledLabel + styledPlaceholder);
			}
		}
	} else {
		// Non-empty field: wrap per explicit logical line
		const logicalLines = notesText.split("\n");
		let cursorLine = -1;
		let cursorCol = -1;

		if (focus === "notes") {
			const clampedCursorPos = Math.max(0, Math.min(notesText.length, notesCursorPos));
			let lineStart = 0;
			for (let i = 0; i < logicalLines.length; i++) {
				const lineLen = logicalLines[i].length;
				const isLastLine = i === logicalLines.length - 1;
				const lineEnd = lineStart + lineLen;
				if (isLastLine) {
					if (clampedCursorPos >= lineStart && clampedCursorPos <= lineEnd) {
						cursorLine = i;
						cursorCol = clampedCursorPos - lineStart;
						break;
					}
				} else {
					if (clampedCursorPos >= lineStart && clampedCursorPos < lineEnd) {
						cursorLine = i;
						cursorCol = clampedCursorPos - lineStart;
						break;
					}
					if (clampedCursorPos === lineEnd) {
						cursorLine = i;
						cursorCol = lineLen;
						break;
					}
				}
				lineStart = lineEnd + 1;
			}
		}

		for (let i = 0; i < logicalLines.length; i++) {
			const isCurrentLine = i === cursorLine;
			const isFirstLine = i === 0;
			const lineLabel = isFirstLine ? label : "";
			const rawLine = lineLabel + logicalLines[i];
			const lineLabelLen = lineLabel.length;
			const effectiveCursorPos = isCurrentLine ? lineLabelLen + cursorCol : -1;

			if (rawLine === "") {
				// Empty logical line (e.g. \n\n)
				if (isCurrentLine) {
					lines.push("  \x1b[7m \x1b[0m");
				} else {
					lines.push("  ");
				}
				continue;
			}

			const chunks = wordWrapLine(rawLine, maxWidth);

			for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
				const chunk = chunks[chunkIndex];
				const isLastChunk = chunkIndex === chunks.length - 1;

				let hasCursorInChunk = false;
				let adjustedCursorPos = 0;

				if (isCurrentLine && effectiveCursorPos >= 0) {
					if (isLastChunk) {
						hasCursorInChunk = effectiveCursorPos >= chunk.startIndex;
						adjustedCursorPos = effectiveCursorPos - chunk.startIndex;
					} else {
						hasCursorInChunk = effectiveCursorPos >= chunk.startIndex && effectiveCursorPos < chunk.endIndex;
						if (hasCursorInChunk) {
							adjustedCursorPos = effectiveCursorPos - chunk.startIndex;
							if (adjustedCursorPos > chunk.text.length) {
								adjustedCursorPos = chunk.text.length;
							}
						}
					}
				}

				const labelChars = Math.max(0, Math.min(chunk.text.length, lineLabelLen - chunk.startIndex));
				const labelPart = chunk.text.slice(0, labelChars);
				const answerPart = chunk.text.slice(labelChars);

				let styledAnswer = "";
				if (hasCursorInChunk) {
					const answerCursorPos = Math.max(0, adjustedCursorPos - labelChars);
					const beforeCursor = answerPart.slice(0, answerCursorPos);
					const afterCursor = answerPart.slice(answerCursorPos);
					const graphemes = [...graphemeSegmenter.segment(answerPart)];
					// The cursor moves by code unit, so it can sit inside a grapheme;
					// wrap the whole containing grapheme, never a tail half.
					const containing = graphemes.find(
						(g) => answerCursorPos >= g.index && answerCursorPos < g.index + g.segment.length,
					);
					if (containing) {
						styledAnswer =
							answerPart.slice(0, containing.index) +
							`\x1b[7m${containing.segment}\x1b[0m` +
							answerPart.slice(containing.index + containing.segment.length);
					} else {
						styledAnswer = answerPart + "\x1b[7m \x1b[0m";
					}
				} else {
					if (focus === "options" && typeof theme?.fg === "function") {
						try {
							styledAnswer = theme.fg("text", answerPart);
						} catch {
							styledAnswer = answerPart;
						}
					} else {
						styledAnswer = answerPart;
					}
				}

				const styledLabel = labelPart ? styleBorder(theme, labelPart) : "";
				lines.push("  " + styledLabel + styledAnswer);
			}
		}
	}

	lines.push("");

	// Hints wrap without splitting key tokens at supported widths.
	let directDigitsHint = "";
	const optionChipsCount = chips.filter((c) => c.type === "option").length;
	const maxDigit = Math.min(optionChipsCount, 9);
	if (maxDigit === 1) {
		directDigitsHint = "1";
	} else if (maxDigit > 1) {
		directDigitsHint = `1-${maxDigit}`;
	}
	const keysHint = directDigitsHint ? `${directDigitsHint}, C, W` : "C, W";
	const hint = focus === "notes"
		? "[Tab/↑ top] choices · [Enter] submit · [Shift+Enter] / [Ctrl+J] line · [Esc] close"
		: `[${mouseEnabled ? "Click / " : ""}${keysHint} / ←→] select · [Tab/↓] notes · [Enter] submit · [Esc] dismiss`;
	let hintRow = "";
	for (const word of hint.split(" ")) {
		const next = hintRow ? `${hintRow} ${word}` : word;
		if (hintRow && visibleWidth(next) > Math.max(1, renderWidth - 2)) {
			lines.push("  " + styleDim(theme, hintRow));
			hintRow = word;
		} else hintRow = next;
	}
	if (hintRow) lines.push("  " + styleDim(theme, hintRow));

	// Bottom border (theme border color)
	lines.push(styleBorder(theme, "─".repeat(renderWidth)));

	return lines.map((line) => truncateToWidth(line, renderWidth));
}

// ─── Component Factory ──────────────────────────────────────────────────────

function stripTerminalControls(text: string): string {
	return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

export class FormKillRing {
	private ring: string[] = [];
	private maxEntries = 60;

	push(text: string, opts: { prepend: boolean; accumulate?: boolean }): void {
		if (!text) return;
		if (opts.accumulate && this.ring.length > 0) {
			const last = this.ring.pop()!;
			this.ring.push(opts.prepend ? text + last : last + text);
		} else {
			if (this.ring.length >= this.maxEntries) {
				this.ring.shift();
			}
			this.ring.push(text);
		}
	}

	peek(): string | undefined {
		return this.ring.length > 0 ? this.ring[this.ring.length - 1] : undefined;
	}

	rotate(): void {
		if (this.ring.length > 1) {
			const last = this.ring.pop()!;
			this.ring.unshift(last);
		}
	}

	get length(): number {
		return this.ring.length;
	}
}

export class FormUndoStack<S> {
	private stack: S[] = [];
	private maxEntries = 100;

	push(state: S): void {
		if (this.stack.length >= this.maxEntries) {
			this.stack.shift();
		}
		this.stack.push({ ...state });
	}

	pop(): S | undefined {
		return this.stack.pop();
	}

	clear(): void {
		this.stack.length = 0;
	}

	get length(): number {
		return this.stack.length;
	}
}

export interface FormVisualLine {
	logicalLine: number;
	startCol: number;
	length: number;
	globalStart: number;
}

export function buildVisualLines(notesText: string, width: number, isWriteIn: boolean): FormVisualLine[] {
	const renderWidth = Math.max(20, width);
	const maxWidth = renderWidth - 3;
	const label = isWriteIn ? "Write in your answer: " : "Add notes to selection: ";

	if (!notesText) {
		return [{ logicalLine: 0, startCol: 0, length: 0, globalStart: 0 }];
	}

	const logicalLines = notesText.split("\n");
	const visualLines: FormVisualLine[] = [];
	let globalOffset = 0;

	for (let i = 0; i < logicalLines.length; i++) {
		const isFirstLine = i === 0;
		const lineLabel = isFirstLine ? label : "";
		const rawLine = lineLabel + logicalLines[i];
		const lineLen = logicalLines[i].length;

		if (logicalLines[i] === "") {
			visualLines.push({
				logicalLine: i,
				startCol: 0,
				length: 0,
				globalStart: globalOffset,
			});
		} else {
			const chunks = wordWrapLine(rawLine, maxWidth);
			for (let c = 0; c < chunks.length; c++) {
				const chunk = chunks[c];
				const startCol = Math.max(0, chunk.startIndex - lineLabel.length);
				const endCol = Math.max(0, chunk.endIndex - lineLabel.length);
				const length = endCol - startCol;
				if (length > 0 || (chunks.length === 1 && lineLen === 0)) {
					visualLines.push({
						logicalLine: i,
						startCol,
						length,
						globalStart: globalOffset + startCol,
					});
				}
			}
		}
		globalOffset += lineLen + 1;
	}

	if (visualLines.length === 0) {
		visualLines.push({ logicalLine: 0, startCol: 0, length: 0, globalStart: 0 });
	}
	return visualLines;
}

// Observe complete native pointer coordinates only to clear feedback outside the
// component. Pi still owns dispatch; never consume, transform or select here.
function observeTerminalPointer(onPosition: (position?: { x: number; y: number }) => void): () => void {
	const configuredTimeout = Number(process.env.PI_TUI_ESC_TIMEOUT);
	const escapeTimeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
		? configuredTimeout : process.env.SSH_CONNECTION || process.env.SSH_TTY ? 100 : 10;
	const buffer = new StdinBuffer({ escapeTimeout });
	let lastPosition: { x: number; y: number } | undefined;
	let sawPosition = false;
	buffer.on("data", (sequence) => {
		if (sequence === "\x1b[O") { lastPosition = undefined; sawPosition = true; return; }
		const mouse = /^\x1b\[<\d+;(\d+);(\d+)[Mm]$/.exec(sequence);
		if (mouse) {
			lastPosition = { x: Number(mouse[1]) - 1, y: Number(mouse[2]) - 1 };
			sawPosition = true;
		}
	});
	const onData = (data: string | Buffer) => {
		sawPosition = false;
		buffer.process(data);
		// Pi has dispatched this whole chunk already. Replay only its final pointer
		// position, so an earlier outside move cannot clear a later inside hover.
		if (sawPosition) onPosition(lastPosition);
	};
	process.stdin.on("data", onData);
	return () => { process.stdin.removeListener("data", onData); buffer.destroy(); };
}

export function createQuestionFormComponent(
	options: NormalizedOption[],
	tui: TUI,
	theme: Theme,
	done: (result: string | null) => void,
	keybindings?: KeybindingsManager | any,
	observePointerPosition?: (onPosition: (position?: { x: number; y: number }) => void) => () => void,
) {
	const chips = buildChips(options);
	const state: QuestionFormState = {
		chips,
		selectedChipIndex: 0,
		focus: "options",
		notesText: "",
		notesCursorPos: 0,
		theme,
	};

	const kb: KeybindingsManager =
		(keybindings && typeof (keybindings as any).matches === "function")
			? keybindings
			: ((typeof getKeybindings === "function" ? getKeybindings() : undefined) ?? new KeybindingsManager(TUI_KEYBINDINGS));

	const killRing = new FormKillRing();
	const undoStack = new FormUndoStack<{ notesText: string; notesCursorPos: number }>();
	let lastAction: "kill" | "yank" | null = null;
	let lastYankLength = 0;
	let preferredVisualCol: number | null = null;
	let lastWidth = 80;
	let closed = false;
	let geometry: { width: number; height: number; targets: ChipTarget[] } | undefined;
	let generation = 0;
	let pending: { chipIndex: number; generation: number; cancelled: boolean } | undefined;
	const mouseEnabled = tui.mode === "fullscreen";
	let hoveredChipIndex: number | undefined;
	let mouseOrigin: { x: number; y: number } | undefined;
	const removeHoverListener = mouseEnabled ? observePointerPosition?.((position) => {
		if (closed || hoveredChipIndex === undefined) return;
		const hovered = geometry?.targets.find((target) => target.chipIndex === hoveredChipIndex);
		if (!position || !mouseOrigin || !hovered
			|| position.y - mouseOrigin.y !== hovered.y
			|| position.x - mouseOrigin.x < hovered.x
			|| position.x - mouseOrigin.x >= hovered.x + hovered.width) setHover(undefined);
	}) : undefined;

	function setHover(chipIndex: number | undefined): boolean {
		if (hoveredChipIndex === chipIndex) return false;
		hoveredChipIndex = chipIndex;
		tui.requestRender();
		return true;
	}

	function dispose(): void {
		closed = true;
		hoveredChipIndex = undefined;
		removeHoverListener?.();
		geometry = undefined;
		pending = undefined;
	}

	function complete(result: string | null): void {
		if (closed) return;
		dispose();
		done(result);
	}

	function handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (closed || !mouseEnabled) return;
		const unmodified = !event.shift && !event.alt && !event.ctrl;
		const boundsMatch = geometry && event.width === geometry.width && event.height === geometry.height;
		if (boundsMatch) mouseOrigin = { x: event.screenX - event.x, y: event.screenY - event.y };
		const target = boundsMatch && event.x >= 0 && event.y >= 0 && event.x < event.width && event.y < event.height
			? geometry?.targets.find((t) => event.y === t.y && event.x >= t.x && event.x < t.x + t.width)
			: undefined;
		if (event.type === "move") {
			const hoverTarget = unmodified && event.button === "none" ? target?.chipIndex : undefined;
			setHover(hoverTarget);
			return;
		}
		setHover(undefined);
		if (event.type === "press") {
			pending = undefined;
			if (!unmodified || event.button !== "left" || !target) return;
			pending = { chipIndex: target.chipIndex, generation, cancelled: false };
			return { handled: true, capture: true, render: false };
		}
		if (!pending || !["drag", "release", "click"].includes(event.type)) return;
		if (!unmodified || !boundsMatch || pending.generation !== generation || target?.chipIndex !== pending.chipIndex
			|| (event.button !== "left" && event.button !== "none") || event.type === "drag") pending.cancelled = true;
		if (event.type !== "click") return { handled: true, render: false };
		const gesture = pending;
		pending = undefined;
		if (gesture.cancelled) return { handled: true, render: false };
		state.selectedChipIndex = gesture.chipIndex;
		state.focus = state.chips[gesture.chipIndex].type === "write-in" ? "notes" : "options";
		tui.requestRender();
		return { handled: true, focus: true, render: true };
	}

	function pushUndo(): void {
		undoStack.push({
			notesText: state.notesText,
			notesCursorPos: state.notesCursorPos,
		});
	}

	function getLogicalLineStart(text: string, pos: number): number {
		const lastNl = text.lastIndexOf("\n", Math.max(0, pos - 1));
		return lastNl === -1 ? 0 : lastNl + 1;
	}

	function getLogicalLineEnd(text: string, pos: number): number {
		const nextNl = text.indexOf("\n", pos);
		return nextNl === -1 ? text.length : nextNl;
	}

	function getGraphemeAt(text: string, pos: number): string {
		return graphemeSegmenter.segment(text).containing(pos)?.segment ?? "";
	}

	function getGraphemeBefore(text: string, pos: number): string {
		return pos > 0 ? (graphemeSegmenter.segment(text).containing(pos - 1)?.segment ?? "") : "";
	}

	function moveWordBackwards(): number {
		const text = state.notesText;
		const pos = state.notesCursorPos;
		if (pos <= 0) return 0;
		const lineStart = getLogicalLineStart(text, pos);
		if (pos === lineStart) {
			return Math.max(0, lineStart - 1);
		}
		const currentLine = text.slice(lineStart, getLogicalLineEnd(text, pos));
		const colInLine = pos - lineStart;
		const newCol = findFormWordBackward(currentLine, colInLine);
		return lineStart + newCol;
	}

	function moveWordForwards(): number {
		const text = state.notesText;
		const pos = state.notesCursorPos;
		if (pos >= text.length) return text.length;
		const lineEnd = getLogicalLineEnd(text, pos);
		if (pos === lineEnd) {
			return Math.min(text.length, lineEnd + 1);
		}
		const lineStart = getLogicalLineStart(text, pos);
		const currentLine = text.slice(lineStart, lineEnd);
		const colInLine = pos - lineStart;
		const newCol = findFormWordForward(currentLine, colInLine);
		return lineStart + newCol;
	}

	function findCurrentVisualLine(vls: FormVisualLine[], pos: number): number {
		for (let i = 0; i < vls.length; i++) {
			const vl = vls[i];
			const offset = pos - vl.globalStart;
			const isLastSegmentOfLine = i === vls.length - 1 || vls[i + 1].logicalLine !== vl.logicalLine;
			if (offset >= 0 && (offset < vl.length || (isLastSegmentOfLine && offset === vl.length))) {
				return i;
			}
		}
		return vls.length - 1;
	}

	function computeVerticalMoveColumn(currentVisualCol: number, sourceMaxVisualCol: number, targetMaxVisualCol: number): number {
		const cursorInMiddle = currentVisualCol < sourceMaxVisualCol;
		const targetTooShort = targetMaxVisualCol < currentVisualCol;

		if (preferredVisualCol === null || cursorInMiddle) {
			if (targetTooShort) {
				preferredVisualCol = currentVisualCol;
				return targetMaxVisualCol;
			}
			preferredVisualCol = null;
			return currentVisualCol;
		}

		const targetCantFitPreferred = targetMaxVisualCol < preferredVisualCol;
		if (targetTooShort || targetCantFitPreferred) {
			return targetMaxVisualCol;
		}
		const result = preferredVisualCol;
		preferredVisualCol = null;
		return result;
	}

	function moveToVisualRow(vls: FormVisualLine[], fromVLIndex: number, toVLIndex: number): void {
		const fromVL = vls[fromVLIndex];
		const toVL = vls[toVLIndex];
		if (!fromVL || !toVL) return;

		const fromText = state.notesText.slice(fromVL.globalStart, fromVL.globalStart + fromVL.length);
		const toText = state.notesText.slice(toVL.globalStart, toVL.globalStart + toVL.length);
		const currentVisualCol = visibleWidth(state.notesText.slice(fromVL.globalStart, state.notesCursorPos));
		const isLastSourceSegment = fromVLIndex === vls.length - 1 || vls[fromVLIndex + 1]?.logicalLine !== fromVL.logicalLine;
		const sourceMaxVisualCol = visibleWidth(isLastSourceSegment ? fromText : fromText.slice(0, -getGraphemeBefore(fromText, fromText.length).length));
		const isLastTargetSegment = toVLIndex === vls.length - 1 || vls[toVLIndex + 1]?.logicalLine !== toVL.logicalLine;
		const targetMaxVisualCol = visibleWidth(isLastTargetSegment ? toText : toText.slice(0, -getGraphemeBefore(toText, toText.length).length));

		const targetVisualCol = computeVerticalMoveColumn(currentVisualCol, sourceMaxVisualCol, targetMaxVisualCol);
		let targetOffset = 0;
		let cells = 0;
		for (const { segment } of graphemeSegmenter.segment(toText)) {
			if (cells + visibleWidth(segment) > targetVisualCol) break;
			cells += visibleWidth(segment);
			targetOffset += segment.length;
		}
		state.notesCursorPos = toVL.globalStart + Math.min(targetOffset, toVL.length);
	}

	function handleInput(data: string): void {
		if (closed) return;
		setHover(undefined);
		// Bracketed paste: completed wrapped event from Pi TUI's Terminal
		const PASTE_START = "\x1b[200~";
		const PASTE_END = "\x1b[201~";
		if (data.startsWith(PASTE_START) && data.endsWith(PASTE_END)) {
			const payload = stripTerminalControls(data.slice(PASTE_START.length, -PASTE_END.length).replace(/\r\n|\r/g, "\n"));
			if (payload) {
				pushUndo();
				state.notesText = state.notesText.slice(0, state.notesCursorPos) + payload + state.notesText.slice(state.notesCursorPos);
				state.notesCursorPos += payload.length;
			}
			state.focus = "notes";
			lastAction = null;
			preferredVisualCol = null;
			tui.requestRender();
			return;
		}

		// Escape handling (Form Escape always wins)
		if (data === "\x1b" || matchesKey(data, Key.escape)) {
			if (state.focus === "notes" && state.notesText.length > 0) {
				pushUndo();
				state.notesText = "";
				state.notesCursorPos = 0;
				state.focus = "options";
				lastAction = null;
				preferredVisualCol = null;
				tui.requestRender();
				return;
			}
			complete(null);
			return;
		}

		// Tab handling (Form Tab always wins)
		if (data === "\t" || matchesKey(data, Key.tab)) {
			state.focus = state.focus === "notes" ? "options" : "notes";
			lastAction = null;
			preferredVisualCol = null;
			tui.requestRender();
			return;
		}

		// Newline vs Submit ordering in notes focus
		if (state.focus === "notes") {
			// Distinct Shift+Enter or Ctrl+J (\n) inserts a line
			if (
				(kb.matches(data, "tui.input.newLine") ||
					data === "\x1b[13;2~" ||
					data === "\x1b[13;2u" ||
					data === "\x1b\r" ||
					data === "\n") &&
				data !== "\r"
			) {
				pushUndo();
				state.notesText = state.notesText.slice(0, state.notesCursorPos) + "\n" + state.notesText.slice(state.notesCursorPos);
				state.notesCursorPos++;
				lastAction = null;
				preferredVisualCol = null;
				tui.requestRender();
				return;
			}
		}

		// Enter: submit (Form Enter always wins over conflicting configured editor action)
		if (data === "\r" || (data !== "\n" && matchesKey(data, Key.enter))) {
			const selectedChip = state.chips[state.selectedChipIndex];
			if (selectedChip.type === "write-in" && !state.notesText.trim()) {
				state.focus = "notes";
				tui.requestRender();
				return;
			}
			const result = buildSubmissionText(selectedChip, state.notesText);
			complete(result);
			return;
		}

		if (state.focus === "options") {
			// Number keys 1..9 (select matching offered option)
			if (data.length === 1 && data >= "1" && data <= "9") {
				const num = parseInt(data, 10);
				const targetIdx = state.chips.findIndex((c) => c.type === "option" && c.key === String(num));
				if (targetIdx !== -1) {
					state.selectedChipIndex = targetIdx;
					tui.requestRender();
					return;
				}
			}

			// C key for canned reply
			if (data === "c" || data === "C") {
				const targetIdx = state.chips.findIndex((c) => c.type === "canned");
				if (targetIdx !== -1) {
					state.selectedChipIndex = targetIdx;
					tui.requestRender();
					return;
				}
			}

			// W key for Write-in
			if (data === "w" || data === "W") {
				const targetIdx = state.chips.findIndex((c) => c.type === "write-in");
				if (targetIdx !== -1) {
					state.selectedChipIndex = targetIdx;
					state.focus = "notes";
					tui.requestRender();
					return;
				}
			}

			// Left / h
			if (data === "h" || data === "\x1b[D" || matchesKey(data, Key.left)) {
				state.selectedChipIndex = Math.max(0, state.selectedChipIndex - 1);
				if (state.chips[state.selectedChipIndex].type === "write-in") {
					state.focus = "notes";
				}
				tui.requestRender();
				return;
			}

			// Right / l
			if (data === "l" || data === "\x1b[C" || matchesKey(data, Key.right)) {
				state.selectedChipIndex = Math.min(state.chips.length - 1, state.selectedChipIndex + 1);
				if (state.chips[state.selectedChipIndex].type === "write-in") {
					state.focus = "notes";
				}
				tui.requestRender();
				return;
			}

			// Down / j -> move to notes
			if (data === "j" || data === "\x1b[B" || matchesKey(data, Key.down)) {
				state.focus = "notes";
				tui.requestRender();
				return;
			}
		} else {
			// focus === "notes"

			// Undo
			if (kb.matches(data, "tui.editor.undo")) {
				const snapshot = undoStack.pop();
				if (snapshot) {
					state.notesText = snapshot.notesText;
					state.notesCursorPos = Math.min(snapshot.notesCursorPos, state.notesText.length);
					lastAction = null;
					preferredVisualCol = null;
					tui.requestRender();
				}
				return;
			}

			// Yank
			if (kb.matches(data, "tui.editor.yank")) {
				const text = killRing.peek();
				if (text) {
					pushUndo();
					state.notesText = state.notesText.slice(0, state.notesCursorPos) + text + state.notesText.slice(state.notesCursorPos);
					lastYankLength = text.length;
					state.notesCursorPos += text.length;
					lastAction = "yank";
					preferredVisualCol = null;
					tui.requestRender();
				}
				return;
			}

			// Yank Pop
			if (kb.matches(data, "tui.editor.yankPop")) {
				if (lastAction === "yank" && killRing.length > 1) {
					pushUndo();
					state.notesText = state.notesText.slice(0, state.notesCursorPos - lastYankLength) + state.notesText.slice(state.notesCursorPos);
					state.notesCursorPos -= lastYankLength;
					killRing.rotate();
					const text = killRing.peek();
					if (text) {
						state.notesText = state.notesText.slice(0, state.notesCursorPos) + text + state.notesText.slice(state.notesCursorPos);
						lastYankLength = text.length;
						state.notesCursorPos += text.length;
						lastAction = "yank";
						preferredVisualCol = null;
						tui.requestRender();
					}
				}
				return;
			}

			// Delete to line start (Ctrl+U)
			if (kb.matches(data, "tui.editor.deleteToLineStart")) {
				const lineStart = getLogicalLineStart(state.notesText, state.notesCursorPos);
				if (state.notesCursorPos > lineStart) {
					pushUndo();
					const deleted = state.notesText.slice(lineStart, state.notesCursorPos);
					killRing.push(deleted, { prepend: true, accumulate: lastAction === "kill" });
					lastAction = "kill";
					state.notesText = state.notesText.slice(0, lineStart) + state.notesText.slice(state.notesCursorPos);
					state.notesCursorPos = lineStart;
					preferredVisualCol = null;
					tui.requestRender();
				} else if (state.notesCursorPos === lineStart && lineStart > 0) {
					pushUndo();
					killRing.push("\n", { prepend: true, accumulate: lastAction === "kill" });
					lastAction = "kill";
					state.notesText = state.notesText.slice(0, lineStart - 1) + state.notesText.slice(lineStart);
					state.notesCursorPos = lineStart - 1;
					preferredVisualCol = null;
					tui.requestRender();
				}
				return;
			}

			// Delete to line end (Ctrl+K)
			if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
				const lineEnd = getLogicalLineEnd(state.notesText, state.notesCursorPos);
				if (state.notesCursorPos < lineEnd) {
					pushUndo();
					const deleted = state.notesText.slice(state.notesCursorPos, lineEnd);
					killRing.push(deleted, { prepend: false, accumulate: lastAction === "kill" });
					lastAction = "kill";
					state.notesText = state.notesText.slice(0, state.notesCursorPos) + state.notesText.slice(lineEnd);
					preferredVisualCol = null;
					tui.requestRender();
				} else if (state.notesCursorPos === lineEnd && lineEnd < state.notesText.length) {
					pushUndo();
					killRing.push("\n", { prepend: false, accumulate: lastAction === "kill" });
					lastAction = "kill";
					state.notesText = state.notesText.slice(0, lineEnd) + state.notesText.slice(lineEnd + 1);
					preferredVisualCol = null;
					tui.requestRender();
				}
				return;
			}

			// Delete word backward (Ctrl+W, Alt+Backspace)
			if (kb.matches(data, "tui.editor.deleteWordBackward")) {
				const lineStart = getLogicalLineStart(state.notesText, state.notesCursorPos);
				if (state.notesCursorPos === lineStart) {
					if (lineStart > 0) {
						pushUndo();
						killRing.push("\n", { prepend: true, accumulate: lastAction === "kill" });
						lastAction = "kill";
						state.notesText = state.notesText.slice(0, lineStart - 1) + state.notesText.slice(lineStart);
						state.notesCursorPos = lineStart - 1;
						preferredVisualCol = null;
						tui.requestRender();
					}
				} else {
					pushUndo();
					const wasKill = lastAction === "kill";
					const newPos = moveWordBackwards();
					const deleted = state.notesText.slice(newPos, state.notesCursorPos);
					killRing.push(deleted, { prepend: true, accumulate: wasKill });
					lastAction = "kill";
					state.notesText = state.notesText.slice(0, newPos) + state.notesText.slice(state.notesCursorPos);
					state.notesCursorPos = newPos;
					preferredVisualCol = null;
					tui.requestRender();
				}
				return;
			}

			// Delete word forward (Alt+D, Alt+Delete)
			if (kb.matches(data, "tui.editor.deleteWordForward")) {
				const lineEnd = getLogicalLineEnd(state.notesText, state.notesCursorPos);
				if (state.notesCursorPos === lineEnd) {
					if (lineEnd < state.notesText.length) {
						pushUndo();
						killRing.push("\n", { prepend: false, accumulate: lastAction === "kill" });
						lastAction = "kill";
						state.notesText = state.notesText.slice(0, lineEnd) + state.notesText.slice(lineEnd + 1);
						preferredVisualCol = null;
						tui.requestRender();
					}
				} else {
					pushUndo();
					const wasKill = lastAction === "kill";
					const newPos = moveWordForwards();
					const deleted = state.notesText.slice(state.notesCursorPos, newPos);
					killRing.push(deleted, { prepend: false, accumulate: wasKill });
					lastAction = "kill";
					state.notesText = state.notesText.slice(0, state.notesCursorPos) + state.notesText.slice(newPos);
					preferredVisualCol = null;
					tui.requestRender();
				}
				return;
			}

			// Delete character backward (Backspace, Shift+Backspace)
			if (kb.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, "shift+backspace")) {
				if (state.notesCursorPos > 0) {
					pushUndo();
					const grapheme = getGraphemeBefore(state.notesText, state.notesCursorPos);
					const len = grapheme.length || 1;
					state.notesText = state.notesText.slice(0, state.notesCursorPos - len) + state.notesText.slice(state.notesCursorPos);
					state.notesCursorPos -= len;
					lastAction = null;
					preferredVisualCol = null;
					tui.requestRender();
				}
				return;
			}

			// Delete character forward (Delete, Ctrl+D, Shift+Delete)
			if (kb.matches(data, "tui.editor.deleteCharForward") || matchesKey(data, "shift+delete")) {
				if (state.notesCursorPos < state.notesText.length) {
					pushUndo();
					const grapheme = getGraphemeAt(state.notesText, state.notesCursorPos);
					const len = grapheme.length || 1;
					state.notesText = state.notesText.slice(0, state.notesCursorPos) + state.notesText.slice(state.notesCursorPos + len);
					lastAction = null;
					preferredVisualCol = null;
					tui.requestRender();
				}
				return;
			}

			// Line start (Ctrl+A, Home)
			if (kb.matches(data, "tui.editor.cursorLineStart")) {
				state.notesCursorPos = getLogicalLineStart(state.notesText, state.notesCursorPos);
				lastAction = null;
				preferredVisualCol = null;
				tui.requestRender();
				return;
			}

			// Line end (Ctrl+E, End)
			if (kb.matches(data, "tui.editor.cursorLineEnd")) {
				state.notesCursorPos = getLogicalLineEnd(state.notesText, state.notesCursorPos);
				lastAction = null;
				preferredVisualCol = null;
				tui.requestRender();
				return;
			}

			// Word left (Alt+B, Alt+Left, Ctrl+Left)
			if (kb.matches(data, "tui.editor.cursorWordLeft")) {
				state.notesCursorPos = moveWordBackwards();
				lastAction = null;
				preferredVisualCol = null;
				tui.requestRender();
				return;
			}

			// Word right (Alt+F, Alt+Right, Ctrl+Right)
			if (kb.matches(data, "tui.editor.cursorWordRight")) {
				state.notesCursorPos = moveWordForwards();
				lastAction = null;
				preferredVisualCol = null;
				tui.requestRender();
				return;
			}

			// Char left (Left arrow, Ctrl+B)
			if (kb.matches(data, "tui.editor.cursorLeft")) {
				if (state.notesCursorPos > 0) {
					const grapheme = getGraphemeBefore(state.notesText, state.notesCursorPos);
					state.notesCursorPos -= (grapheme.length || 1);
					lastAction = null;
					preferredVisualCol = null;
					tui.requestRender();
				}
				return;
			}

			// Char right (Right arrow, Ctrl+F)
			if (kb.matches(data, "tui.editor.cursorRight")) {
				if (state.notesCursorPos < state.notesText.length) {
					const grapheme = getGraphemeAt(state.notesText, state.notesCursorPos);
					state.notesCursorPos += (grapheme.length || 1);
					lastAction = null;
					preferredVisualCol = null;
					tui.requestRender();
				}
				return;
			}

			// Up: multiline-aware visual row traversal
			if (kb.matches(data, "tui.editor.cursorUp")) {
				lastAction = null;
				const isWriteIn = state.chips[state.selectedChipIndex]?.type === "write-in";
				const vls = buildVisualLines(state.notesText, lastWidth, isWriteIn);
				const curVL = findCurrentVisualLine(vls, state.notesCursorPos);
				if (curVL === 0) {
					// Up on first visual row returns to choices
					state.focus = "options";
					preferredVisualCol = null;
					tui.requestRender();
					return;
				}
				moveToVisualRow(vls, curVL, curVL - 1);
				tui.requestRender();
				return;
			}

			// Down: multiline-aware visual row traversal
			if (kb.matches(data, "tui.editor.cursorDown")) {
				lastAction = null;
				const isWriteIn = state.chips[state.selectedChipIndex]?.type === "write-in";
				const vls = buildVisualLines(state.notesText, lastWidth, isWriteIn);
				const curVL = findCurrentVisualLine(vls, state.notesCursorPos);
				if (curVL === vls.length - 1) {
					// Last visual row: stay at end of row, cannot submit or leave
					const lastVL = vls[vls.length - 1];
					state.notesCursorPos = Math.min(state.notesText.length, lastVL.globalStart + lastVL.length);
					tui.requestRender();
					return;
				}
				moveToVisualRow(vls, curVL, curVL + 1);
				tui.requestRender();
				return;
			}

			// Printable character
			if (data.length === 1 && data >= " " && stripTerminalControls(data) === data) {
				pushUndo();
				state.notesText = state.notesText.slice(0, state.notesCursorPos) + data + state.notesText.slice(state.notesCursorPos);
				state.notesCursorPos++;
				lastAction = null;
				preferredVisualCol = null;
				tui.requestRender();
				return;
			}

			// Multi-char text (raw paste without bracketed markers)
			if (data.length > 1 && !data.startsWith("\x1b")) {
				const clean = stripTerminalControls(data.replace(/\r\n?|\n/g, "\n"));
				if (!clean) return;
				pushUndo();
				state.notesText = state.notesText.slice(0, state.notesCursorPos) + clean + state.notesText.slice(state.notesCursorPos);
				state.notesCursorPos += clean.length;
				lastAction = null;
				preferredVisualCol = null;
				tui.requestRender();
				return;
			}
		}
	}

	return {
		render(width: number): string[] {
			lastWidth = width;
			if (closed) return [];
			if (geometry && geometry.width !== width) hoveredChipIndex = undefined;
			const layout = layoutChips(state, Math.max(1, width), hoveredChipIndex);
			const lines = renderQuestionForm(state, width, mouseEnabled, layout);
			const next = { width, height: lines.length, targets: layout.targets };
			if (JSON.stringify(next) !== JSON.stringify(geometry)) {
				generation++;
				if (pending) pending.cancelled = true;
			}
			geometry = next;
			return lines;
		},
		handleInput,
		handleMouse,
		invalidate() {
			hoveredChipIndex = undefined;
			geometry = undefined;
			generation++;
			if (pending) pending.cancelled = true;
		},
		dispose,
	};
}

// ─── Extension entry point ──────────────────────────────────────────────────

export default function rbfQuestionForm(pi: ExtensionAPI): void {
	let lastAssistantText = "";
	let pendingToolOptions: NormalizedOption[] | null = null;
	let lastDetectedOptions: NormalizedOption[] | null = null;
	let isFormOpen = false;

	/**
	 * Open the question form replacing the input box via ctx.ui.custom().
	 */
	async function openQuestionForm(options: NormalizedOption[], ctx: ExtensionContext): Promise<void> {
		if (isFormOpen || options.length === 0) return;
		if (ctx.mode !== "tui") return;

		// Cache for accidental ESC recovery
		lastDetectedOptions = options;
		isFormOpen = true;

		try {
			const customFn = (ctx.ui as any).custom;
			if (typeof customFn === "function") {
				const result = await (ctx.ui as any).custom((tui: TUI, theme: Theme, kb: any, done: (res: string | null) => void) => {
					return createQuestionFormComponent(options, tui, theme, done, kb, observeTerminalPointer);
				});

				if (result) {
					pi.sendUserMessage(result);
				}
			}
		} finally {
			isFormOpen = false;
		}
	}

	// ─── Event handlers ──────────────────────────────────────────────────────

	pi.on("agent_end", async (event, _ctx) => {
		lastAssistantText = "";
		if (!event.messages) return;

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const msg = event.messages[i] as any;
			if (msg.role === "assistant") {
				if (typeof msg.content === "string") {
					lastAssistantText = msg.content;
				} else if (Array.isArray(msg.content)) {
					lastAssistantText = msg.content
						.filter((block: any) => block.type === "text")
						.map((block: any) => block.text)
						.join("\n");
				}
				break;
			}
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		// Priority 1: tool-provided options
		if (pendingToolOptions) {
			const options = pendingToolOptions;
			pendingToolOptions = null;
			await openQuestionForm(options, ctx);
			return;
		}

		// Priority 2: text detection heuristic
		if (lastAssistantText) {
			const detectedLines = detectQuestionOptions(lastAssistantText);
			if (detectedLines) {
				const options = detectedLines.map((line, i) => parseNumberedOption(line, i));
				await openQuestionForm(options, ctx);
			}
		}
	});

	// ─── Slash Commands & Shortcut to re-open after ESC ───────────────────────

	pi.registerCommand("answer-question", {
		description: "Re-open the selection form for the last agent question",
		handler: async (_args, ctx) => {
			if (!lastDetectedOptions || lastDetectedOptions.length === 0) {
				ctx.ui.notify("No recent question options to pick from", "warning");
				return;
			}
			await openQuestionForm(lastDetectedOptions, ctx);
		},
	});

	pi.registerShortcut("ctrl+q", {
		description: "Re-open the selection form for the last agent question",
		handler: async (ctx) => {
			if (!lastDetectedOptions || lastDetectedOptions.length === 0) {
				return;
			}
			await openQuestionForm(lastDetectedOptions, ctx);
		},
	});

	// ─── Tool registration ───────────────────────────────────────────────────

	const toolDef = {
		name: "question",
		label: "Question",
		description: "Ask the user a question and let them pick from options. Use when you need user input to proceed.",
		parameters: QuestionParams,
		executionMode: "sequential" as const,

		async execute(
			_toolCallId: string,
			params: { question: string; options: Array<string | { label: string; description?: string }> },
			_signal: AbortSignal,
			_onUpdate: any,
			ctx: any,
		) {
			const normalized = params.options.map((opt, i) => normalizeToolOption(opt, i));

			if (ctx.mode === "tui") {
				pendingToolOptions = normalized;
			}

			const optionsText = normalized.map((opt) => opt.fullText).join("\n");
			return {
				content: [{ type: "text" as const, text: `${params.question}\n\n${optionsText}\n\nWaiting for user selection...` }],
				details: {
					question: params.question,
					options: normalized.map((o) => o.label),
				},
			};
		},

		renderCall(args: any, theme: any, _context: any) {
			let text = theme.fg("toolTitle", theme.bold("question ")) + theme.fg("muted", args.question);
			const opts = Array.isArray(args.options) ? args.options : [];
			if (opts.length) {
				const labels = opts.map((o: any) => typeof o === "string" ? o : o.label);
				const numbered = labels.map((o: string, i: number) => `${i + 1}. ${o}`);
				text += `\n${theme.fg("dim", `  Options: ${numbered.join(", ")}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result: any, _options: any, theme: any, _context: any) {
			const details = result.details as { question: string; options: string[]; answer?: string } | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			return new Text(theme.fg("muted", "Waiting for selection…"), 0, 0);
		},
	};

	pi.registerTool(toolDef);

	pi.registerTool({
		...toolDef,
		name: "ask_question",
		label: "Ask Question",
	});
}
