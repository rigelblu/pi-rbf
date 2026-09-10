import { Editor, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SHELL_MODE_LABEL = "In shell mode";
export const SHELL_MODE_BADGE = " In shell mode ";
export const SHELL_MODE_INDICATOR = SHELL_MODE_LABEL;
export const SHELL_MODE_INDICATOR_WIDTH = SHELL_MODE_LABEL.length;
export const SHELL_MODE_BADGE_WIDTH = SHELL_MODE_BADGE.length;

export const SHELL_MODE_PATCHED_KEY = Symbol.for("rbf.shellModeIndicator.patched");
export const SHELL_MODE_ACTIVE_KEY = Symbol.for("rbf.shellModeIndicator.active");
export const ORIGINAL_RENDER_KEY = Symbol.for("rbf.shellModeIndicator.originalRender");
export const ORIGINAL_RENDER_TOP_BORDER_KEY = Symbol.for("rbf.shellModeIndicator.originalRenderTopBorder");
export const ORIGINAL_RENDER_BOTTOM_BORDER_KEY = Symbol.for("rbf.shellModeIndicator.originalRenderBottomBorder");
export const ORIGINAL_HANDLE_MOUSE_KEY = Symbol.for("rbf.shellModeIndicator.originalHandleMouse");

export const SHELL_MODE_WIDGET_KEY = "rbf-shell-mode-indicator";
export const SHELL_MODE_WIDGET_TEXT = "! In shell mode";

/**
 * Command mode border color (#FF0087):
 * Vivid deep pink / hot magenta.
 * RGB: 255, 0, 135
 * ANSI TrueColor: \x1b[38;2;255;0;135m
 */
export const SHELL_MODE_COLOR_HEX = "#FF0087";
export const SHELL_MODE_COLOR_ANSI = "\x1b[38;2;255;0;135m";

export const RED_COLORS = {
	dawn: SHELL_MODE_COLOR_HEX,
	moon: SHELL_MODE_COLOR_HEX,
	main: SHELL_MODE_COLOR_HEX,
} as const;

export const RED_ANSI = {
	dawn: SHELL_MODE_COLOR_ANSI,
	moon: SHELL_MODE_COLOR_ANSI,
	main: SHELL_MODE_COLOR_ANSI,
	standard: SHELL_MODE_COLOR_ANSI,
} as const;

// Backward-compatibility aliases
export const ROSE_COLORS = RED_COLORS;
export const ROSE_ANSI = RED_ANSI;

/**
 * Check if the input prompt text indicates shell command mode (! or !!).
 */
export function isShellCommandText(text: string): boolean {
	if (typeof text !== "string") return false;
	const trimmed = text.trimStart();
	return trimmed.startsWith("!");
}

/**
 * Checks if prompt text in shell mode needs visual prefix padding (a single space after ! or !!).
 * Returns true if text starts with ! or !! and does not already have whitespace immediately following the prefix.
 */
export function needsShellPrefixPadding(text: string): boolean {
	if (typeof text !== "string") return false;
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("!")) return false;
	const prefix = trimmed.startsWith("!!") ? "!!" : "!";
	const afterPrefix = trimmed.slice(prefix.length);
	return afterPrefix.length === 0 || !/^\s/.test(afterPrefix);
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
 * Get shell command mode border color function (#FF0087).
 */
export function getShellModeBorderColor(_theme?: any): (str: string) => string {
	return (s: string) => `${SHELL_MODE_COLOR_ANSI}${s}\x1b[39m`;
}

// Backward-compatibility aliases
export const getRedColor = getShellModeBorderColor;
export const getRoseColor = getShellModeBorderColor;

/**
 * Regex matching the shell command prefix on the prompt line:
 * Matches optional leading whitespace / cursor-on-whitespace, followed by one or more ! characters.
 */
export const SHELL_PREFIX_REGEX =
	/^((?:(?:\x1b_pi:c\x07)?\x1b\[7m \x1b\[0m|\s)*)((?:(?:\x1b_pi:c\x07)?\x1b\[7m!\x1b\[0m|!)+)/;

/**
 * Highlights the leading ! or !! command mode prefix in the prompt line with #FF0087 color.
 * Preserves cursor positioning (whether cursor is before, on, or after !) and visible line width.
 * Optionally adds a single space of visual prefix padding after the prefix if addPadding is true.
 */
export function highlightShellPrefixInLine(
	line: string,
	colorFn: (s: string) => string = getShellModeBorderColor(),
	addPadding: boolean = false,
): string {
	if (!line || typeof line !== "string") return line;
	let didAddPadding = false;
	let result = line.replace(SHELL_PREFIX_REGEX, (match, leading, excls) => {
		const UNIT_REGEX = /((\x1b_pi:c\x07)?\x1b\[7m!\x1b\[0m|!)/g;
		const styledExcls = excls.replace(
			UNIT_REGEX,
			(m: string, unit: string, marker: string | undefined) => {
				if (unit.includes("\x1b[7m")) {
					const mkr = marker || "";
					return `${mkr}\x1b[7m${colorFn("!")}\x1b[0m`;
				}
				return colorFn("!");
			},
		);
		if (addPadding) {
			didAddPadding = true;
			return leading + styledExcls + " ";
		}
		return leading + styledExcls;
	});

	if (didAddPadding) {
		if (result.endsWith(" ")) {
			result = result.slice(0, -1);
		} else {
			const trailingSpaceMatch = result.match(/ (?=(?:\x1b\[[0-9;]*m)*$)/);
			if (trailingSpaceMatch && trailingSpaceMatch.index !== undefined) {
				result = result.slice(0, trailingSpaceMatch.index) + result.slice(trailingSpaceMatch.index + 1);
			}
		}
	}

	return result;
}

/**
 * Format the widget line displayed below the editor in shell mode ("! In shell mode").
 * The ! is styled with #FF0087 and the label " In shell mode" is styled with dim/muted text.
 */
export function formatShellModeWidgetLine(text?: string, theme?: any): string {
	const trimmed = typeof text === "string" ? text.trimStart() : "";
	const prefix = trimmed.startsWith("!!") ? "!!" : "!";
	const colorFn = getShellModeBorderColor(theme);
	const label =
		theme && typeof theme.fg === "function"
			? theme.fg("dim", " In shell mode")
			: "\x1b[2m In shell mode\x1b[22m";
	return `${colorFn(prefix)}${label}`;
}

let currentThemeContext: any = undefined;
let currentUiContext: any = undefined;

export function setThemeContext(theme: any): void {
	currentThemeContext = theme;
}

export function getThemeContext(): any {
	return currentThemeContext;
}

export function setUiContext(ui: any): void {
	currentUiContext = ui;
}

export function getUiContext(): any {
	return currentUiContext;
}

/**
 * Update below-editor widget state (clears any widget since label is on the horizontal line).
 */
export function updateShellModeWidget(
	_editor: any,
	_isShell: boolean,
	ui?: any,
	_theme?: any,
	_text?: string,
): void {
	const activeUi = ui ?? currentUiContext;
	if (!activeUi || typeof activeUi.setWidget !== "function") {
		return;
	}
	activeUi.setWidget(SHELL_MODE_WIDGET_KEY, undefined, { placement: "belowEditor" });
}

/**
 * Render the top border with #FF0087 color.
 */
export function renderShellTopBorder(
	editor: any,
	width: number,
	hiddenLineCount: number,
	colorFn: (s: string) => string,
	origFn?: (width: number, hiddenLineCount: number) => string,
): string {
	const origBorderColor = editor?.borderColor;
	if (editor) editor.borderColor = colorFn;
	try {
		if (typeof origFn === "function") {
			return origFn.call(editor, width, hiddenLineCount);
		}
		if (hiddenLineCount > 0) {
			const text = `↑ ${hiddenLineCount} more`;
			const borderLen = Math.max(0, width - visibleWidth(text) - 1);
			return colorFn(`${"─".repeat(borderLen)} `) + text;
		}
		return colorFn("─".repeat(Math.max(0, width)));
	} finally {
		if (editor) editor.borderColor = origBorderColor;
	}
}

/**
 * Render the bottom border with #FF0087 color and "In shell mode" on the same line.
 * Seamlessly integrates with Vim mode badge if active on editor.
 */
export function renderShellBottomBorder(
	editor: any,
	width: number,
	hiddenLineCount: number,
	colorFn: (s: string) => string,
	_origFn?: (width: number, hiddenLineCount: number) => string,
): string {
	const origBorderColor = editor?.borderColor;
	if (editor) editor.borderColor = colorFn;
	try {
		const mode = editor?.mode;
		const label = SHELL_MODE_BADGE;
		const labelLen = visibleWidth(label);
		const scrollText = ` ↓ ${hiddenLineCount} more `;
		const scrollLen = hiddenLineCount > 0 ? visibleWidth(scrollText) : 0;
		const canFitScroll = hiddenLineCount > 0 && scrollLen + 2 <= width;
		const scrollPart = canFitScroll ? scrollText : "";
		const actualScrollLen = visibleWidth(scrollPart);

		if (mode === "normal" || mode === "insert") {
			const badge = mode === "normal" ? " NORMAL " : " INSERT ";
			const badgeLen = badge.length;
			const styledBadge =
				mode === "normal"
					? `\x1b[1;33m${badge}\x1b[0m`
					: `\x1b[2m${badge}\x1b[0m`;

			const vimShellPrefix = "──";
			const vimShellMid = "── In shell mode ";
			const minFullWidth =
				visibleWidth(vimShellPrefix) + badgeLen + visibleWidth(vimShellMid) + 2 + actualScrollLen;

			if (width >= minFullWidth) {
				const remaining = Math.max(
					0,
					width - (visibleWidth(vimShellPrefix) + badgeLen + visibleWidth(vimShellMid) + actualScrollLen),
				);
				return (
					colorFn(vimShellPrefix) +
					styledBadge +
					colorFn(vimShellMid + "─".repeat(remaining)) +
					scrollPart
				);
			}

			if (width >= badgeLen + 4 + actualScrollLen) {
				const remaining = Math.max(0, width - 2 - badgeLen - actualScrollLen);
				return colorFn("──") + styledBadge + colorFn("─".repeat(remaining)) + scrollPart;
			}

			return colorFn("─".repeat(Math.max(0, width)));
		}

		const leftBorder = "──";
		const minWidth = visibleWidth(leftBorder) + labelLen + 2 + actualScrollLen;
		if (width >= minWidth) {
			const remaining = Math.max(0, width - (visibleWidth(leftBorder) + labelLen + actualScrollLen));
			return colorFn(leftBorder + label + "─".repeat(remaining)) + scrollPart;
		}

		if (canFitScroll) {
			const borderLen = Math.max(0, width - actualScrollLen - 1);
			return colorFn(`${"─".repeat(borderLen)} `) + scrollText;
		}

		return colorFn("─".repeat(Math.max(0, width)));
	} finally {
		if (editor) editor.borderColor = origBorderColor;
	}
}

const patchedSubclasses = new Set<any>();

/**
 * Patch an editor subclass prototype (like VimEditor) for standalone bottom border calls.
 */
export function patchVimEditorPrototype(VimEditorClass: any): boolean {
	if (!VimEditorClass || !VimEditorClass.prototype) return false;
	if (Object.prototype.hasOwnProperty.call(VimEditorClass.prototype, SHELL_MODE_PATCHED_KEY)) return false;

	const origBottom = VimEditorClass.prototype.renderBottomBorder;
	VimEditorClass.prototype[SHELL_MODE_PATCHED_KEY] = true;
	VimEditorClass.prototype[ORIGINAL_RENDER_BOTTOM_BORDER_KEY] = origBottom;
	patchedSubclasses.add(VimEditorClass);

	VimEditorClass.prototype.renderBottomBorder = function (width: number, hiddenLineCount?: number): string {
		const text = typeof this.getText === "function" ? this.getText() : "";
		if (isShellCommandText(text)) {
			const colorFn = getShellModeBorderColor(currentThemeContext ?? getActiveTheme());
			return renderShellBottomBorder(this, width, hiddenLineCount ?? 0, colorFn, origBottom);
		}
		if (typeof origBottom === "function") {
			return origBottom.call(this, width, hiddenLineCount);
		}
		const proto = Object.getPrototypeOf(VimEditorClass.prototype);
		if (proto && typeof proto.renderBottomBorder === "function") {
			return proto.renderBottomBorder.call(this, width, hiddenLineCount);
		}
		return "";
	};
	return true;
}

/**
 * Apply shell mode indicator monkey-patches to Editor.prototype.
 */
export function applyShellModeIndicator(options?: { theme?: any; ui?: any }): boolean {
	const EditorClass = Editor as any;
	if (!EditorClass || !EditorClass.prototype) {
		return false;
	}

	if (options?.theme) {
		currentThemeContext = options.theme;
	}
	if (options?.ui) {
		currentUiContext = options.ui;
	}

	if (EditorClass.prototype[SHELL_MODE_PATCHED_KEY]) {
		return false;
	}

	const originalRender = EditorClass.prototype.render;
	const originalRenderTopBorder = EditorClass.prototype.renderTopBorder;
	const originalRenderBottomBorder = EditorClass.prototype.renderBottomBorder;
	const originalHandleMouse = EditorClass.prototype.handleMouse;

	EditorClass.prototype[ORIGINAL_RENDER_KEY] = originalRender;
	EditorClass.prototype[ORIGINAL_RENDER_TOP_BORDER_KEY] = originalRenderTopBorder;
	EditorClass.prototype[ORIGINAL_RENDER_BOTTOM_BORDER_KEY] = originalRenderBottomBorder;
	if (typeof originalHandleMouse === "function") {
		EditorClass.prototype[ORIGINAL_HANDLE_MOUSE_KEY] = originalHandleMouse;
	}
	EditorClass.prototype[SHELL_MODE_PATCHED_KEY] = true;

	// Check if active VimEditor exists and patch its prototype as well
	const activeVim = (globalThis as any)[Symbol.for("rbf.vim.activeEditor")];
	if (activeVim?.constructor) {
		patchVimEditorPrototype(activeVim.constructor);
	}

	if (typeof originalHandleMouse === "function") {
		EditorClass.prototype.handleMouse = function (event: any): any {
			if (
				event &&
				event.type === "click" &&
				event.button === "left" &&
				event.y === 1 &&
				(this.scrollOffset ?? 0) === 0
			) {
				const text = typeof this.getText === "function" ? this.getText() : "";
				if (needsShellPrefixPadding(text)) {
					const trimmed = text.trimStart();
					const leadingSpaces = text.length - trimmed.length;
					const prefixLen = trimmed.startsWith("!!") ? 2 : 1;
					const maxPadding = Math.max(0, Math.floor(((event.width ?? this.lastWidth ?? 80) - 1) / 2));
					const paddingX = Math.min(this.paddingX ?? 0, maxPadding);
					const visualPaddingCol = paddingX + leadingSpaces + prefixLen;
					if (event.x > visualPaddingCol) {
						const adjustedEvent = { ...event, x: event.x - 1 };
						return originalHandleMouse.call(this, adjustedEvent);
					}
				}
			}
			return originalHandleMouse.call(this, event);
		};
	}

	EditorClass.prototype.renderTopBorder = function (width: number, hiddenLineCount?: number): string {
		const text = typeof this.getText === "function" ? this.getText() : "";
		if (isShellCommandText(text)) {
			const colorFn = getShellModeBorderColor(currentThemeContext ?? options?.theme ?? getActiveTheme());
			return renderShellTopBorder(this, width, hiddenLineCount ?? 0, colorFn, originalRenderTopBorder);
		}
		return originalRenderTopBorder.call(this, width, hiddenLineCount);
	};

	EditorClass.prototype.renderBottomBorder = function (width: number, hiddenLineCount?: number): string {
		const text = typeof this.getText === "function" ? this.getText() : "";
		if (isShellCommandText(text)) {
			const colorFn = getShellModeBorderColor(currentThemeContext ?? options?.theme ?? getActiveTheme());
			return renderShellBottomBorder(this, width, hiddenLineCount ?? 0, colorFn, originalRenderBottomBorder);
		}
		return originalRenderBottomBorder.call(this, width, hiddenLineCount);
	};

	EditorClass.prototype.render = function (width: number): string[] {
		const text = typeof this.getText === "function" ? this.getText() : "";
		const isShell = isShellCommandText(text);

		// Synchronize below-editor widget state on prefix transitions
		const currentPrefix = isShell ? (text.trimStart().startsWith("!!") ? "!!" : "!") : "";
		const lastPrefix = this[SHELL_MODE_ACTIVE_KEY];
		if (currentPrefix !== lastPrefix) {
			this[SHELL_MODE_ACTIVE_KEY] = currentPrefix;
			const ui = options?.ui ?? currentUiContext;
			if (ui && typeof ui.setWidget === "function") {
				updateShellModeWidget(this, isShell, ui, currentThemeContext ?? options?.theme ?? getActiveTheme(), text);
			}
		}

		if (!isShell) {
			return originalRender.call(this, width);
		}

		// If this is a subclass like VimEditor, ensure its prototype has been patched too
		if (
			this.constructor &&
			this.constructor !== EditorClass &&
			!Object.prototype.hasOwnProperty.call(this.constructor.prototype, SHELL_MODE_PATCHED_KEY)
		) {
			patchVimEditorPrototype(this.constructor);
		}

		const origBorderColor = this.borderColor;
		const colorFn = getShellModeBorderColor(currentThemeContext ?? options?.theme ?? getActiveTheme());

		this.borderColor = colorFn;

		let lines: string[];
		try {
			lines = originalRender.call(this, width);
		} finally {
			this.borderColor = origBorderColor;
		}

		if (Array.isArray(lines) && lines.length >= 3 && (this.scrollOffset ?? 0) === 0) {
			const addPadding = needsShellPrefixPadding(text);
			lines[1] = highlightShellPrefixInLine(lines[1], colorFn, addPadding);
		}

		return lines;
	};

	return true;
}

/**
 * Restore original Editor.prototype methods.
 */
export function restoreShellModeIndicator(): boolean {
	if (currentUiContext && typeof currentUiContext.setWidget === "function") {
		currentUiContext.setWidget(SHELL_MODE_WIDGET_KEY, undefined, { placement: "belowEditor" });
	}
	currentUiContext = undefined;
	currentThemeContext = undefined;

	for (const Subclass of patchedSubclasses) {
		if (Subclass?.prototype) {
			const orig = Subclass.prototype[ORIGINAL_RENDER_BOTTOM_BORDER_KEY];
			if (typeof orig === "function") {
				Subclass.prototype.renderBottomBorder = orig;
			} else {
				delete Subclass.prototype.renderBottomBorder;
			}
			delete Subclass.prototype[SHELL_MODE_PATCHED_KEY];
			delete Subclass.prototype[ORIGINAL_RENDER_BOTTOM_BORDER_KEY];
		}
	}
	patchedSubclasses.clear();

	const EditorClass = Editor as any;
	if (!EditorClass || !EditorClass.prototype || !EditorClass.prototype[SHELL_MODE_PATCHED_KEY]) {
		return false;
	}

	const originalRender = EditorClass.prototype[ORIGINAL_RENDER_KEY];
	const originalRenderTop = EditorClass.prototype[ORIGINAL_RENDER_TOP_BORDER_KEY];
	const originalRenderBottom = EditorClass.prototype[ORIGINAL_RENDER_BOTTOM_BORDER_KEY];
	const originalHandleMouse = EditorClass.prototype[ORIGINAL_HANDLE_MOUSE_KEY];

	if (typeof originalRender === "function") {
		EditorClass.prototype.render = originalRender;
	}
	if (typeof originalRenderTop === "function") {
		EditorClass.prototype.renderTopBorder = originalRenderTop;
	}
	if (typeof originalRenderBottom === "function") {
		EditorClass.prototype.renderBottomBorder = originalRenderBottom;
	}
	if (typeof originalHandleMouse === "function") {
		EditorClass.prototype.handleMouse = originalHandleMouse;
	} else if (originalHandleMouse !== undefined) {
		delete EditorClass.prototype.handleMouse;
	}

	delete EditorClass.prototype[SHELL_MODE_PATCHED_KEY];
	delete EditorClass.prototype[ORIGINAL_RENDER_KEY];
	delete EditorClass.prototype[ORIGINAL_RENDER_TOP_BORDER_KEY];
	delete EditorClass.prototype[ORIGINAL_RENDER_BOTTOM_BORDER_KEY];
	delete EditorClass.prototype[ORIGINAL_HANDLE_MOUSE_KEY];

	return true;
}

/**
 * Shell mode visual indicator extension for Pi.
 */
export default function rbfShellModeIndicator(pi?: ExtensionAPI): void {
	applyShellModeIndicator();

	if (pi && typeof pi.on === "function") {
		pi.on("session_start", (_event, ctx) => {
			const theme = (ctx as any)?.ui?.theme;
			const ui = (ctx as any)?.ui;
			setUiContext(ui);
			applyShellModeIndicator({ theme, ui });
		});
		pi.on("session_shutdown", () => {
			if (currentUiContext && typeof currentUiContext.setWidget === "function") {
				currentUiContext.setWidget(SHELL_MODE_WIDGET_KEY, undefined, { placement: "belowEditor" });
			}
			setUiContext(undefined);
		});
	}
}
