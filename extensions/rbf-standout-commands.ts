import { Editor, visibleWidth, CURSOR_MARKER } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const STANDOUT_COMMANDS_PATCHED_KEY = Symbol.for("rbf.standoutCommands.patched");
export const ORIGINAL_RENDER_KEY = Symbol.for("rbf.standoutCommands.originalRender");

/**
 * Default fallback built-in slash command names (without leading slash).
 */
export const DEFAULT_BUILTIN_COMMANDS = new Set([
	"settings",
	"model",
	"tree",
	"thinking",
	"scoped-models",
	"export",
	"import",
	"share",
	"copy",
	"name",
	"session",
	"changelog",
	"hotkeys",
	"fork",
	"clone",
	"trust",
	"login",
	"logout",
	"new",
	"compact",
	"resume",
	"reload",
	"quit",
	"exit",
	"clear",
]);

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
 * Color a command token using the theme's mdLink color, with fallback to blue.
 */
export function styleCommandToken(token: string, theme?: any): string {
	if (!token) return "";
	const activeTheme = theme === null ? undefined : (theme ?? getActiveTheme());
	if (activeTheme && typeof activeTheme.fg === "function") {
		try {
			return activeTheme.fg("mdLink", token);
		} catch {
			// ignore fallback below
		}
	}
	// Fallback to Rosé Pine Foam (#56949f) in truecolor, or ANSI 34 (blue)
	return `\x1b[38;2;86;148;159m${token}\x1b[39m`;
}

/**
 * Inspect the editor and optional extras to collect all valid command and skill names.
 */
export function getRegisteredCommandNames(
	editor?: any,
	extraCommands?: Iterable<string>,
): Set<string> {
	const registry = new Set<string>();

	for (const cmd of DEFAULT_BUILTIN_COMMANDS) {
		registry.add(cmd.toLowerCase());
	}

	if (extraCommands) {
		for (const cmd of extraCommands) {
			if (!cmd) continue;
			const clean = cmd.startsWith("/") ? cmd.slice(1) : cmd;
			registry.add(clean.toLowerCase());
		}
	}

	// Dynamic check on editor autocomplete provider
	let provider = editor?.autocompleteProvider;
	let depth = 0;
	while (provider && depth < 5) {
		if (Array.isArray(provider.commands)) {
			for (const item of provider.commands) {
				if (item && typeof item.name === "string") {
					const name = item.name.trim();
					if (name) {
						const clean = name.startsWith("/") ? name.slice(1) : name;
						registry.add(clean.toLowerCase());
					}
				}
			}
		}
		provider = provider.inner ?? provider.provider ?? provider.wrappedProvider;
		depth++;
	}

	return registry;
}

export interface CommandToken {
	start: number;
	end: number;
	token: string;
	commandName: string;
}

/**
 * Candidate token regex matching:
 * - Slash commands: /command or /skill:name (e.g. /clear, /model, /skill:convo-one-at-a-time)
 * - Standalone skills: skill:name (e.g. skill:convo-one-at-a-time)
 * Uses lookbehind (?<=^|[^\w/]) so it matches immediately after whitespace, brackets, quotes, etc.
 */
const TOKEN_REGEX = /(?<=^|[^\w/])(\/(?:skill:)?[a-zA-Z0-9_.-]+|skill:[a-zA-Z0-9_.-]+)(?=[^\w/-]|$)/g;

/**
 * Find valid, registered command and skill tokens in a line of text.
 */
export function findCommandTokens(
	lineText: string,
	registry: Set<string>,
): CommandToken[] {
	if (!lineText) return [];

	const tokens: CommandToken[] = [];
	const regex = new RegExp(TOKEN_REGEX);
	let match: RegExpExecArray | null;

	while ((match = regex.exec(lineText)) !== null) {
		const captured = match[1];
		if (!captured) continue;

		// Don't match file paths with multiple slashes (e.g. /usr/bin/local)
		if (captured.slice(1).includes("/")) {
			continue;
		}

		let tokenStart = match.index;
		let matchedToken = captured;
		let cleanName = captured.startsWith("/") ? captured.slice(1) : captured;
		let cleanLower = cleanName.toLowerCase();

		let isMatch = registry.has(cleanLower);
		if (!isMatch && cleanLower.startsWith("skill:")) {
			// Check if skill is registered without the skill: prefix
			isMatch = registry.has(cleanLower.slice(6));
		}

		// If not an exact match, check if trailing punctuation should be trimmed
		if (!isMatch && /[.,;:!?)]$/.test(cleanName)) {
			let trimmed = cleanName;
			while (trimmed.length > 1 && /[.,;:!?)]$/.test(trimmed)) {
				trimmed = trimmed.slice(0, -1);
			}
			const trimmedLower = trimmed.toLowerCase();
			if (
				registry.has(trimmedLower) ||
				(trimmedLower.startsWith("skill:") && registry.has(trimmedLower.slice(6)))
			) {
				cleanName = trimmed;
				isMatch = true;
				matchedToken = captured.startsWith("/") ? `/${trimmed}` : trimmed;
			}
		}

		if (isMatch) {
			tokens.push({
				start: tokenStart,
				end: tokenStart + matchedToken.length,
				token: matchedToken,
				commandName: cleanName,
			});
		}
	}

	return tokens;
}

/**
 * Highlight command tokens in a text chunk with no cursor.
 */
export function highlightLineText(
	lineText: string,
	tokens: Array<{ start: number; end: number; token?: string }>,
	styleFn: (text: string) => string,
): string {
	if (tokens.length === 0 || !lineText) {
		return lineText;
	}

	let result = "";
	let lastIndex = 0;

	for (const token of tokens) {
		if (token.start > lastIndex) {
			result += lineText.slice(lastIndex, token.start);
		}
		result += styleFn(lineText.slice(token.start, token.end));
		lastIndex = token.end;
	}

	if (lastIndex < lineText.length) {
		result += lineText.slice(lastIndex);
	}

	return result;
}

/**
 * Render a layout line with syntax highlighted command tokens and cursor.
 */
export function renderLineWithHighlightsAndCursor(
	lineText: string,
	tokens: CommandToken[],
	cursorPos: number | undefined,
	emitCursorMarker: boolean,
	segmentFn: (text: string) => Array<{ segment: string }>,
	styleFn: (text: string) => string,
): string {
	const marker = emitCursorMarker ? CURSOR_MARKER : "";

	// Case 1: No cursor on this line
	if (cursorPos === undefined) {
		return highlightLineText(lineText, tokens, styleFn);
	}

	// Case 2: Cursor at end of line (or beyond)
	if (cursorPos >= lineText.length) {
		const highlighted = highlightLineText(lineText, tokens, styleFn);
		const cursor = "\x1b[7m \x1b[0m";
		return highlighted + marker + cursor;
	}

	// Case 3: Cursor is on a character inside the line
	const after = lineText.slice(cursorPos);
	const afterGraphemes = segmentFn(after);
	const firstGrapheme = afterGraphemes[0]?.segment || after[0] || " ";
	const gLen = firstGrapheme.length;
	const cursorEnd = cursorPos + gLen;

	// Check if cursor lands inside a highlighted token
	const activeToken = tokens.find((t) => cursorPos >= t.start && cursorPos < t.end);

	if (!activeToken) {
		// Cursor is outside all tokens
		const beforeCursor = lineText.slice(0, cursorPos);
		const afterCursor = lineText.slice(cursorEnd);

		const tokensBefore = tokens
			.filter((t) => t.end <= cursorPos)
			.map((t) => ({ ...t }));
		const tokensAfter = tokens
			.filter((t) => t.start >= cursorEnd)
			.map((t) => ({ ...t, start: t.start - cursorEnd, end: t.end - cursorEnd }));

		const highlightedBefore = highlightLineText(beforeCursor, tokensBefore, styleFn);
		const highlightedAfter = highlightLineText(afterCursor, tokensAfter, styleFn);
		const cursor = `\x1b[7m${firstGrapheme}\x1b[0m`;

		return highlightedBefore + marker + cursor + highlightedAfter;
	}

	// Cursor is INSIDE activeToken: [activeToken.start, activeToken.end]
	const prefix = highlightLineText(
		lineText.slice(0, activeToken.start),
		tokens.filter((t) => t.end <= activeToken.start),
		styleFn,
	);

	const tokenStr = lineText.slice(activeToken.start, activeToken.end);
	const relCursorPos = cursorPos - activeToken.start;
	const tokenBeforeCursor = tokenStr.slice(0, relCursorPos);
	const tokenAfterCursor = tokenStr.slice(relCursorPos + gLen);

	const styledBefore = tokenBeforeCursor ? styleFn(tokenBeforeCursor) : "";
	const styledCursor = `\x1b[7m${styleFn(firstGrapheme)}\x1b[0m`;
	const styledAfter = tokenAfterCursor ? styleFn(tokenAfterCursor) : "";
	const styledToken = `${styledBefore}${marker}${styledCursor}${styledAfter}`;

	const suffix = highlightLineText(
		lineText.slice(activeToken.end),
		tokens
			.filter((t) => t.start >= activeToken.end)
			.map((t) => ({
				...t,
				start: t.start - activeToken.end,
				end: t.end - activeToken.end,
			})),
		styleFn,
	);

	return prefix + styledToken + suffix;
}

/**
 * Re-render visible lines with standout command highlighting while preserving
 * line padding, visible column widths, and cursor markers.
 */
export function renderWithStandoutHighlights(
	editor: any,
	width: number,
	originalLines: string[],
	options?: {
		theme?: any;
		extraCommands?: Iterable<string>;
	},
): string[] {
	const renderedVisibleLineCount = editor.renderedVisibleLineCount;
	if (typeof renderedVisibleLineCount !== "number" || renderedVisibleLineCount <= 0) {
		return originalLines;
	}

	const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
	const paddingX = Math.min(editor.paddingX ?? 0, maxPadding);
	const contentWidth = Math.max(1, width - paddingX * 2);
	const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));

	const layoutLines =
		typeof editor.layoutText === "function" ? editor.layoutText(layoutWidth) : undefined;
	if (!layoutLines) {
		return originalLines;
	}

	const scrollOffset = editor.scrollOffset ?? 0;
	const visibleLines = layoutLines.slice(scrollOffset, scrollOffset + renderedVisibleLineCount);
	if (visibleLines.length !== renderedVisibleLineCount) {
		return originalLines;
	}

	const registry = getRegisteredCommandNames(editor, options?.extraCommands);
	const emitCursorMarker = Boolean(editor.focused);
	const segmentFn = (t: string): Array<{ segment: string }> => {
		if (typeof editor.segment === "function") {
			return Array.from(editor.segment(t, "grapheme")) as Array<{ segment: string }>;
		}
		return Array.from(
			new (Intl as any).Segmenter(undefined, { granularity: "grapheme" }).segment(t),
		) as Array<{ segment: string }>;
	};
	const styleFn = (str: string) => styleCommandToken(str, options?.theme);

	const leftPadding = " ".repeat(paddingX);
	const rightPadding = leftPadding;

	const result = [...originalLines];
	let modified = false;

	for (let i = 0; i < visibleLines.length; i++) {
		const layoutLine = visibleLines[i];
		const tokens = findCommandTokens(layoutLine.text, registry);
		if (tokens.length === 0) {
			continue;
		}

		const displayText = renderLineWithHighlightsAndCursor(
			layoutLine.text,
			tokens,
			layoutLine.hasCursor ? layoutLine.cursorPos : undefined,
			emitCursorMarker,
			segmentFn,
			styleFn,
		);

		let lineVisibleWidth = visibleWidth(layoutLine.text);
		let cursorInPadding = false;
		if (
			layoutLine.hasCursor &&
			layoutLine.cursorPos !== undefined &&
			layoutLine.cursorPos >= layoutLine.text.length
		) {
			lineVisibleWidth += 1;
			if (lineVisibleWidth > contentWidth && paddingX > 0) {
				cursorInPadding = true;
			}
		}

		const padding = " ".repeat(Math.max(0, contentWidth - lineVisibleWidth));
		const lineRightPadding = cursorInPadding ? rightPadding.slice(1) : rightPadding;

		result[i + 1] = `${leftPadding}${displayText}${padding}${lineRightPadding}`;
		modified = true;
	}

	return modified ? result : originalLines;
}

/**
 * Patch Editor.prototype.render to highlight registered slash commands and skills.
 */
export function applyStandoutCommands(options?: {
	theme?: any;
	extraCommands?: Iterable<string>;
}): boolean {
	const EditorClass = Editor as any;
	if (!EditorClass || !EditorClass.prototype) {
		return false;
	}

	if (EditorClass.prototype[STANDOUT_COMMANDS_PATCHED_KEY]) {
		return false;
	}

	const originalRender = EditorClass.prototype.render;
	EditorClass.prototype[ORIGINAL_RENDER_KEY] = originalRender;
	EditorClass.prototype[STANDOUT_COMMANDS_PATCHED_KEY] = true;

	EditorClass.prototype.render = function (width: number): string[] {
		const originalLines: string[] = originalRender.call(this, width);
		if (!Array.isArray(originalLines) || originalLines.length < 2) {
			return originalLines;
		}

		try {
			return renderWithStandoutHighlights(this, width, originalLines, options);
		} catch {
			return originalLines;
		}
	};

	return true;
}

/**
 * Restore original Editor.prototype.render method.
 */
export function restoreStandoutCommands(): boolean {
	const EditorClass = Editor as any;
	if (!EditorClass || !EditorClass.prototype) {
		return false;
	}

	if (!EditorClass.prototype[STANDOUT_COMMANDS_PATCHED_KEY]) {
		return false;
	}

	const originalRender = EditorClass.prototype[ORIGINAL_RENDER_KEY];
	if (typeof originalRender === "function") {
		EditorClass.prototype.render = originalRender;
	}
	delete EditorClass.prototype[STANDOUT_COMMANDS_PATCHED_KEY];
	delete EditorClass.prototype[ORIGINAL_RENDER_KEY];
	return true;
}

/**
 * Standout slash commands and skills extension for Pi.
 */
export default function rbfStandoutCommands(ctx: ExtensionAPI): void {
	const theme = (ctx as any)?.ui?.theme;
	applyStandoutCommands({ theme });
}
