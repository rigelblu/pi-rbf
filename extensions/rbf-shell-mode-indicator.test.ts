import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor, visibleWidth } from "@earendil-works/pi-tui";
import { VimEditor } from "./rbf-vim.ts";
import { applyStandoutCommands, restoreStandoutCommands } from "./rbf-standout-commands.ts";
import rbfShellModeIndicator, {
	applyShellModeIndicator,
	formatShellModeWidgetLine,
	getRedColor,
	getRoseColor,
	getShellModeBorderColor,
	getUiContext,
	highlightShellPrefixInLine,
	isShellCommandText,
	renderShellBottomBorder,
	renderShellTopBorder,
	restoreShellModeIndicator,
	setUiContext,
	SHELL_MODE_ACTIVE_KEY,
	SHELL_MODE_COLOR_ANSI,
	SHELL_MODE_COLOR_HEX,
	SHELL_MODE_INDICATOR,
	SHELL_MODE_PATCHED_KEY,
	SHELL_MODE_WIDGET_KEY,
	SHELL_MODE_WIDGET_TEXT,
	updateShellModeWidget,
} from "./rbf-shell-mode-indicator.ts";

describe("rbf-shell-mode-indicator", () => {
	afterEach(() => {
		restoreShellModeIndicator();
		restoreStandoutCommands();
	});

	describe("isShellCommandText", () => {
		it("detects single exclamation mark commands", () => {
			expect(isShellCommandText("!ls")).toBe(true);
			expect(isShellCommandText("!git status")).toBe(true);
			expect(isShellCommandText("!npm test")).toBe(true);
			expect(isShellCommandText("!")).toBe(true);
			expect(isShellCommandText("! ")).toBe(true);
		});

		it("detects double exclamation mark commands (no-context parity)", () => {
			expect(isShellCommandText("!!ls")).toBe(true);
			expect(isShellCommandText("!!git status")).toBe(true);
			expect(isShellCommandText("!!")).toBe(true);
			expect(isShellCommandText("!! ")).toBe(true);
		});

		it("handles leading whitespace", () => {
			expect(isShellCommandText("   !git status")).toBe(true);
			expect(isShellCommandText("  !!ls")).toBe(true);
			expect(isShellCommandText("\t!echo hi")).toBe(true);
		});

		it("returns false for non-shell inputs", () => {
			expect(isShellCommandText("")).toBe(false);
			expect(isShellCommandText("help me fix the build")).toBe(false);
			expect(isShellCommandText("/rename new-name")).toBe(false);
			expect(isShellCommandText("/tree")).toBe(false);
			expect(isShellCommandText("hello")).toBe(false);
			expect(isShellCommandText(null as any)).toBe(false);
			expect(isShellCommandText(undefined as any)).toBe(false);
		});
	});

	describe("getShellModeBorderColor", () => {
		it("returns #FF0087 ANSI truecolor for any theme", () => {
			const colorFn = getShellModeBorderColor({ name: "rose-pine-dawn" });
			const output = colorFn("test");
			expect(output).toBe(`${SHELL_MODE_COLOR_ANSI}test\x1b[39m`);
		});

		it("aliases getRedColor and getRoseColor to getShellModeBorderColor", () => {
			expect(getRedColor).toBe(getShellModeBorderColor);
			expect(getRoseColor).toBe(getShellModeBorderColor);
		});

		it("exposes SHELL_MODE_COLOR_HEX as #FF0087", () => {
			expect(SHELL_MODE_COLOR_HEX).toBe("#FF0087");
			expect(SHELL_MODE_COLOR_ANSI).toBe("\x1b[38;2;255;0;135m");
		});
	});

	describe("highlightShellPrefixInLine", () => {
		const colorFn = (s: string) => `${SHELL_MODE_COLOR_ANSI}${s}\x1b[39m`;

		it("highlights leading ! in #FF0087 for standard command", () => {
			const highlighted = highlightShellPrefixInLine("!ls", colorFn);
			expect(highlighted.startsWith(`${SHELL_MODE_COLOR_ANSI}!\x1b[39mls`)).toBe(true);
			expect(visibleWidth(highlighted)).toBe(visibleWidth("!ls"));
		});

		it("highlights double exclamation prefix !! in #FF0087", () => {
			const highlighted = highlightShellPrefixInLine("!!docker ps", colorFn);
			expect(highlighted.startsWith(`${SHELL_MODE_COLOR_ANSI}!\x1b[39m${SHELL_MODE_COLOR_ANSI}!\x1b[39mdocker ps`)).toBe(true);
			expect(visibleWidth(highlighted)).toBe(visibleWidth("!!docker ps"));
		});

		it("highlights leading ! when preceded by whitespace", () => {
			const highlighted = highlightShellPrefixInLine("   !git status", colorFn);
			expect(highlighted.startsWith(`   ${SHELL_MODE_COLOR_ANSI}!\x1b[39mgit status`)).toBe(true);
			expect(visibleWidth(highlighted)).toBe(visibleWidth("   !git status"));
		});

		it("highlights ! when cursor is actively on the exclamation mark", () => {
			const cursorOnExcl = "\x1b[7m!\x1b[0mls";
			const highlighted = highlightShellPrefixInLine(cursorOnExcl, colorFn);
			expect(highlighted.includes(`\x1b[7m${SHELL_MODE_COLOR_ANSI}!\x1b[39m\x1b[0m`)).toBe(true);
			expect(visibleWidth(highlighted)).toBe(visibleWidth(cursorOnExcl));
		});

		it("highlights ! when focused hardware cursor marker is present", () => {
			const focusedCursorOnExcl = "\x1b_pi:c\x07\x1b[7m!\x1b[0mls";
			const highlighted = highlightShellPrefixInLine(focusedCursorOnExcl, colorFn);
			expect(highlighted.includes(`\x1b_pi:c\x07\x1b[7m${SHELL_MODE_COLOR_ANSI}!\x1b[39m\x1b[0m`)).toBe(true);
			expect(visibleWidth(highlighted)).toBe(visibleWidth(focusedCursorOnExcl));
		});

		it("leaves non-shell input completely untouched", () => {
			expect(highlightShellPrefixInLine("npm test", colorFn)).toBe("npm test");
			expect(highlightShellPrefixInLine("echo hello!", colorFn)).toBe("echo hello!");
			expect(highlightShellPrefixInLine("", colorFn)).toBe("");
		});

		it("is idempotent when called multiple times", () => {
			const once = highlightShellPrefixInLine("!npm test", colorFn);
			const twice = highlightShellPrefixInLine(once, colorFn);
			expect(twice).toBe(once);
		});
	});

	describe("widget helpers", () => {
		it("formats widget line containing ! in #FF0087 and In shell mode label", () => {
			const line = formatShellModeWidgetLine("!ls");
			expect(line.includes(`${SHELL_MODE_COLOR_ANSI}!\x1b[39m`)).toBe(true);
			expect(line.includes("In shell mode")).toBe(true);
			expect(line.includes("! In shell mode")).toBe(false); // Has ANSI between ! and In shell mode
		});

		it("formats widget line for !! with double exclamation marks", () => {
			const line = formatShellModeWidgetLine("!!docker compose up");
			expect(line.includes(`${SHELL_MODE_COLOR_ANSI}!!\x1b[39m`)).toBe(true);
			expect(line.includes("In shell mode")).toBe(true);
		});

		it("uses theme.fg dim when theme is provided", () => {
			const theme = {
				fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
			};
			const line = formatShellModeWidgetLine("!ls", theme);
			expect(line.includes(`${SHELL_MODE_COLOR_ANSI}!\x1b[39m`)).toBe(true);
			expect(line.includes("[dim] In shell mode[/dim]")).toBe(true);
		});

		it("exposes SHELL_MODE_WIDGET_KEY and SHELL_MODE_WIDGET_TEXT", () => {
			expect(SHELL_MODE_WIDGET_KEY).toBe("rbf-shell-mode-indicator");
			expect(SHELL_MODE_WIDGET_TEXT).toBe("! In shell mode");
		});

		it("updateShellModeWidget clears belowEditor widget when isShell is true (label is on horizontal line)", () => {
			const mockUi = { setWidget: vi.fn() };
			updateShellModeWidget({}, true, mockUi, undefined, "!ls");
			expect(mockUi.setWidget).toHaveBeenCalledWith(
				SHELL_MODE_WIDGET_KEY,
				undefined,
				{ placement: "belowEditor" },
			);
		});

		it("updateShellModeWidget clears belowEditor widget when isShell is false", () => {
			const mockUi = { setWidget: vi.fn() };
			updateShellModeWidget({}, false, mockUi, undefined, "hello");
			expect(mockUi.setWidget).toHaveBeenCalledWith(
				SHELL_MODE_WIDGET_KEY,
				undefined,
				{ placement: "belowEditor" },
			);
		});
	});

	describe("renderShellTopBorder", () => {
		const colorFn = (s: string) => `${SHELL_MODE_COLOR_ANSI}${s}\x1b[39m`;

		it("renders horizontal line without ! indicator and preserves exact width", () => {
			const border = renderShellTopBorder({}, 80, 0, colorFn);
			expect(border.includes("!")).toBe(false);
			expect(visibleWidth(border)).toBe(80);
			expect(border).toBe(`${SHELL_MODE_COLOR_ANSI}${"─".repeat(80)}\x1b[39m`);
		});

		it("handles various terminal widths correctly", () => {
			for (const width of [20, 40, 60, 80, 120]) {
				const border = renderShellTopBorder({}, width, 0, colorFn);
				expect(visibleWidth(border)).toBe(width);
				expect(border.includes("!")).toBe(false);
			}
		});

		it("handles scroll offset indicator (↑ N more)", () => {
			const border = renderShellTopBorder({}, 80, 3, colorFn);
			expect(visibleWidth(border)).toBe(80);
			expect(border.includes("!")).toBe(false);
			expect(border.includes("↑ 3 more")).toBe(true);
		});

		it("handles narrow width gracefully", () => {
			const border = renderShellTopBorder({}, 2, 0, colorFn);
			expect(visibleWidth(border)).toBe(2);
			expect(border).toBe(`${SHELL_MODE_COLOR_ANSI}──\x1b[39m`);
		});
	});

	describe("renderShellBottomBorder", () => {
		const colorFn = (s: string) => `${SHELL_MODE_COLOR_ANSI}${s}\x1b[39m`;

		it("renders bottom border with 'In shell mode' on the horizontal line without ! indicator for standard Editor", () => {
			const border = renderShellBottomBorder({}, 80, 0, colorFn);
			expect(border.includes("!")).toBe(false);
			expect(border.includes("In shell mode")).toBe(true);
			expect(border.startsWith(`${SHELL_MODE_COLOR_ANSI}── In shell mode `)).toBe(true);
			expect(border.endsWith("\x1b[39m")).toBe(true);
			expect(visibleWidth(border)).toBe(80);
		});

		it("handles various terminal widths correctly with exact visible width", () => {
			for (const width of [10, 18, 19, 20, 25, 40, 60, 80, 120]) {
				const border = renderShellBottomBorder({}, width, 0, colorFn);
				expect(visibleWidth(border)).toBe(width);
				expect(border.includes("!")).toBe(false);
				if (width >= 19) {
					expect(border.includes("In shell mode")).toBe(true);
				}
			}
		});

		it("handles scroll offset indicator for standard Editor (↓ N more)", () => {
			const border = renderShellBottomBorder({}, 80, 5, colorFn);
			expect(border.includes("!")).toBe(false);
			expect(border.includes("In shell mode")).toBe(true);
			expect(border.includes("↓ 5 more")).toBe(true);
			expect(visibleWidth(border)).toBe(80);
		});

		it("renders bottom border without ! and includes INSERT badge and 'In shell mode' in Vim mode", () => {
			const vimEditor = { mode: "insert" };
			const border = renderShellBottomBorder(vimEditor, 80, 0, colorFn);
			expect(border.includes("!")).toBe(false);
			expect(border.includes("INSERT")).toBe(true);
			expect(border.includes("In shell mode")).toBe(true);
			expect(visibleWidth(border)).toBe(80);
		});

		it("renders bottom border without ! and includes NORMAL badge and 'In shell mode' in Vim mode", () => {
			const vimEditor = { mode: "normal" };
			const border = renderShellBottomBorder(vimEditor, 80, 0, colorFn);
			expect(border.includes("!")).toBe(false);
			expect(border.includes("NORMAL")).toBe(true);
			expect(border.includes("In shell mode")).toBe(true);
			expect(visibleWidth(border)).toBe(80);
		});

		it("preserves Vim badge styling (yellow for NORMAL, dim for INSERT)", () => {
			const vimNormal = { mode: "normal" };
			const borderNormal = renderShellBottomBorder(vimNormal, 80, 0, colorFn);
			expect(borderNormal.includes("\x1b[1;33m NORMAL \x1b[0m")).toBe(true);
			expect(borderNormal.includes("In shell mode")).toBe(true);

			const vimInsert = { mode: "insert" };
			const borderInsert = renderShellBottomBorder(vimInsert, 80, 0, colorFn);
			expect(borderInsert.includes("\x1b[2m INSERT \x1b[0m")).toBe(true);
			expect(borderInsert.includes("In shell mode")).toBe(true);
		});

		it("handles narrow terminal widths in Vim mode gracefully", () => {
			for (const width of [10, 15, 28, 29, 40, 80]) {
				const border = renderShellBottomBorder({ mode: "normal" }, width, 0, colorFn);
				expect(visibleWidth(border)).toBe(width);
				if (width >= 29) {
					expect(border.includes("NORMAL")).toBe(true);
					expect(border.includes("In shell mode")).toBe(true);
				} else if (width >= 12) {
					expect(border.includes("NORMAL")).toBe(true);
				}
			}
		});
	});

	describe("applyShellModeIndicator & restoreShellModeIndicator", () => {
		it("patches Editor.prototype.render and restores cleanly", () => {
			const originalRender = Editor.prototype.render;
			const applied = applyShellModeIndicator();
			expect(applied).toBe(true);
			expect((Editor.prototype as any)[SHELL_MODE_PATCHED_KEY]).toBe(true);
			expect(Editor.prototype.render).not.toBe(originalRender);

			// Idempotent
			const reapplied = applyShellModeIndicator();
			expect(reapplied).toBe(false);

			// Restore
			const restored = restoreShellModeIndicator();
			expect(restored).toBe(true);
			expect(Editor.prototype.render).toBe(originalRender);
			expect((Editor.prototype as any)[SHELL_MODE_PATCHED_KEY]).toBeUndefined();
		});
	});

	describe("Interactive Editor rendering", () => {
		const tui = { terminal: { rows: 24, columns: 80 } } as any;
		const defaultTheme = {
			name: "rose-pine-dawn",
			borderColor: (s: string) => `\x1b[34m${s}\x1b[39m`,
		} as any;

		it("renders default border when input text is normal prompt", () => {
			applyShellModeIndicator({ theme: defaultTheme });
			const editor = new Editor(tui, defaultTheme);
			editor.setText("help me fix the build error");

			const lines = editor.render(80);
			expect(lines.length).toBeGreaterThanOrEqual(3);

			const topBorder = lines[0];
			const bottomBorder = lines[lines.length - 1];

			expect(topBorder.includes("\x1b[34m")).toBe(true);
			expect(topBorder.includes(SHELL_MODE_COLOR_ANSI)).toBe(false);
			expect(bottomBorder.includes(SHELL_MODE_COLOR_ANSI)).toBe(false);
			expect(visibleWidth(topBorder)).toBe(80);
			expect(visibleWidth(bottomBorder)).toBe(80);
		});

		it("renders #FF0087 border without ! indicator when prompt starts with !, with 'In shell mode' on bottom border", () => {
			applyShellModeIndicator({ theme: defaultTheme });
			const editor = new Editor(tui, defaultTheme);
			editor.setText("!git status");

			const lines = editor.render(80);
			expect(lines.length).toBe(3);
			const topBorder = lines[0];
			const bottomBorder = lines[lines.length - 1];

			expect(topBorder.includes("!")).toBe(false);
			expect(bottomBorder.includes("!")).toBe(false);
			expect(topBorder.includes(SHELL_MODE_COLOR_ANSI)).toBe(true);
			expect(bottomBorder.includes(SHELL_MODE_COLOR_ANSI)).toBe(true);
			expect(bottomBorder.includes("In shell mode")).toBe(true);
			expect(visibleWidth(topBorder)).toBe(80);
			expect(visibleWidth(bottomBorder)).toBe(80);
		});

		it("renders #FF0087 border without ! indicator for !! (no-context bash) with 'In shell mode' on bottom border", () => {
			applyShellModeIndicator({ theme: defaultTheme });
			const editor = new Editor(tui, defaultTheme);
			editor.setText("!!docker compose ps");

			const lines = editor.render(80);
			expect(lines.length).toBe(3);
			const topBorder = lines[0];
			const bottomBorder = lines[lines.length - 1];

			expect(topBorder.includes("!")).toBe(false);
			expect(bottomBorder.includes("!")).toBe(false);
			expect(topBorder.includes(SHELL_MODE_COLOR_ANSI)).toBe(true);
			expect(bottomBorder.includes(SHELL_MODE_COLOR_ANSI)).toBe(true);
			expect(bottomBorder.includes("In shell mode")).toBe(true);
			expect(visibleWidth(topBorder)).toBe(80);
			expect(visibleWidth(bottomBorder)).toBe(80);
		});

		it("reacts live on the very first keystroke !", () => {
			applyShellModeIndicator({ theme: defaultTheme });
			const editor = new Editor(tui, defaultTheme);

			// Step 1: user types '!'
			editor.setText("!");
			let lines = editor.render(80);
			expect(lines[0].includes(SHELL_MODE_COLOR_ANSI)).toBe(true);
			expect(lines[0].includes("!")).toBe(false);
			expect(lines[lines.length - 1].includes(SHELL_MODE_COLOR_ANSI)).toBe(true);

			// Step 2: user deletes '!'
			editor.setText("");
			lines = editor.render(80);
			expect(lines[0].includes(SHELL_MODE_COLOR_ANSI)).toBe(false);
			expect(lines[0].includes("\x1b[34m")).toBe(true);
			expect(lines[lines.length - 1].includes(SHELL_MODE_COLOR_ANSI)).toBe(false);

			// Step 3: user types '!ls'
			editor.setText("!ls");
			lines = editor.render(80);
			expect(lines[0].includes(SHELL_MODE_COLOR_ANSI)).toBe(true);
			expect(lines[0].includes("!")).toBe(false);
			expect(lines[lines.length - 1].includes(SHELL_MODE_COLOR_ANSI)).toBe(true);
		});

		it("highlights leading ! in #FF0087 on the prompt line in editor.render", () => {
			applyShellModeIndicator({ theme: defaultTheme });
			const editor = new Editor(tui, defaultTheme);
			editor.setText("!git status");

			const lines = editor.render(80);
			const promptLine = lines[1];

			expect(promptLine.includes(`${SHELL_MODE_COLOR_ANSI}!\x1b[39m`)).toBe(true);
			expect(visibleWidth(promptLine)).toBe(80);
		});

		it("highlights leading !! in #FF0087 on the prompt line for !! commands", () => {
			applyShellModeIndicator({ theme: defaultTheme });
			const editor = new Editor(tui, defaultTheme);
			editor.setText("!!docker compose ps");

			const lines = editor.render(80);
			const promptLine = lines[1];

			expect(promptLine.includes(`${SHELL_MODE_COLOR_ANSI}!\x1b[39m${SHELL_MODE_COLOR_ANSI}!\x1b[39m`)).toBe(true);
			expect(visibleWidth(promptLine)).toBe(80);
		});

		it("highlights leading ! with #FF0087 when cursor is actively on the !", () => {
			applyShellModeIndicator({ theme: defaultTheme });
			const editor = new Editor(tui, defaultTheme);
			editor.setText("!ls");
			(editor as any).state.cursorCol = 0;

			const lines = editor.render(80);
			const promptLine = lines[1];

			expect(promptLine.includes(`\x1b[7m${SHELL_MODE_COLOR_ANSI}!\x1b[39m\x1b[0m`)).toBe(true);
			expect(visibleWidth(promptLine)).toBe(80);
		});

		it("renders single-space padding between ! and cursor block on bare !", () => {
			applyShellModeIndicator({ theme: defaultTheme });
			const editor = new Editor(tui, defaultTheme);
			editor.setText("!");

			const lines = editor.render(80);
			const promptLine = lines[1];

			// Visually: pink '!' followed immediately by space ' ', followed by cursor block
			expect(promptLine.includes(`${SHELL_MODE_COLOR_ANSI}!\x1b[39m \x1b[7m \x1b[0m`)).toBe(true);
			expect(visibleWidth(promptLine)).toBe(80);

			// Also when focused with hardware cursor marker \x1b_pi:c\x07
			editor.focused = true;
			const focusedLines = editor.render(80);
			expect(focusedLines[1].includes(`${SHELL_MODE_COLOR_ANSI}!\x1b[39m \x1b_pi:c\x07\x1b[7m \x1b[0m`)).toBe(true);
			expect(visibleWidth(focusedLines[1])).toBe(80);
		});

		it("renders single-space padding between ! and command text on !git status", () => {
			applyShellModeIndicator({ theme: defaultTheme });
			const editor = new Editor(tui, defaultTheme);
			editor.setText("!git status");

			const lines = editor.render(80);
			const promptLine = lines[1];

			expect(promptLine.includes(`${SHELL_MODE_COLOR_ANSI}!\x1b[39m git status`)).toBe(true);
			expect(visibleWidth(promptLine)).toBe(80);
		});

		it("preserves single space without duplicating when user already typed ! git status", () => {
			applyShellModeIndicator({ theme: defaultTheme });
			const editor = new Editor(tui, defaultTheme);
			editor.setText("! git status");

			const lines = editor.render(80);
			const promptLine = lines[1];

			expect(promptLine.includes(`${SHELL_MODE_COLOR_ANSI}!\x1b[39m git status`)).toBe(true);
			expect(promptLine.includes(`${SHELL_MODE_COLOR_ANSI}!\x1b[39m  git status`)).toBe(false);
			expect(visibleWidth(promptLine)).toBe(80);
		});

		it("renders single-space padding between !! and cursor block on bare !!", () => {
			applyShellModeIndicator({ theme: defaultTheme });
			const editor = new Editor(tui, defaultTheme);
			editor.setText("!!");

			const lines = editor.render(80);
			const promptLine = lines[1];

			expect(promptLine.includes(`${SHELL_MODE_COLOR_ANSI}!\x1b[39m${SHELL_MODE_COLOR_ANSI}!\x1b[39m \x1b[7m \x1b[0m`)).toBe(true);
			expect(visibleWidth(promptLine)).toBe(80);
		});

		it("adjusts mouse click coordinates when clicking after visual padding space", () => {
			applyShellModeIndicator({ theme: defaultTheme });
			const editor = new Editor(tui, defaultTheme);
			editor.setText("!ls");
			editor.render(80);

			// Clicking at x = 0 (on '!'): cursor lands at index 0
			editor.handleMouse({ type: "click", button: "left", x: 0, y: 1, width: 80 } as any);
			expect((editor as any).state.cursorCol).toBe(0);

			// Clicking at x = 2 (visually on 'l' because col 1 is visual padding space):
			// should map to index 1 ('l') in the buffer
			editor.handleMouse({ type: "click", button: "left", x: 2, y: 1, width: 80 } as any);
			expect((editor as any).state.cursorCol).toBe(1);

			// Clicking at x = 3 (visually on 's'):
			// should map to index 2 ('s') in the buffer
			editor.handleMouse({ type: "click", button: "left", x: 3, y: 1, width: 80 } as any);
			expect((editor as any).state.cursorCol).toBe(2);
		});

		it("does not highlight #FF0087 in normal non-shell prompt line", () => {
			applyShellModeIndicator({ theme: defaultTheme });
			const editor = new Editor(tui, defaultTheme);
			editor.setText("npm test");

			const lines = editor.render(80);
			const promptLine = lines[1];

			expect(promptLine.includes(SHELL_MODE_COLOR_ANSI)).toBe(false);
			expect(visibleWidth(promptLine)).toBe(80);
		});

		it("ensures belowEditor widget is cleared on transitions so no extra terminal line is taken", () => {
			const mockUi = { setWidget: vi.fn() };
			applyShellModeIndicator({ theme: defaultTheme, ui: mockUi });
			const editor = new Editor(tui, defaultTheme);

			// Keystroke 1: type '!'
			editor.setText("!");
			const lines1 = editor.render(80);
			expect(lines1.length).toBe(3);
			expect(lines1[lines1.length - 1].includes("In shell mode")).toBe(true);
			expect(mockUi.setWidget).toHaveBeenCalledTimes(1);
			expect(mockUi.setWidget).toHaveBeenLastCalledWith(
				SHELL_MODE_WIDGET_KEY,
				undefined,
				{ placement: "belowEditor" },
			);

			// Keystroke 2: type 'ls' (still in shell mode, no redundant call)
			editor.setText("!ls");
			const lines2 = editor.render(80);
			expect(lines2.length).toBe(3);
			expect(lines2[lines2.length - 1].includes("In shell mode")).toBe(true);
			expect(mockUi.setWidget).toHaveBeenCalledTimes(1);

			// Keystroke 3: delete all text
			editor.setText("");
			const lines3 = editor.render(80);
			expect(lines3.length).toBe(3);
			expect(lines3[lines3.length - 1].includes("In shell mode")).toBe(false);
			expect(mockUi.setWidget).toHaveBeenCalledTimes(2);
			expect(mockUi.setWidget).toHaveBeenLastCalledWith(
				SHELL_MODE_WIDGET_KEY,
				undefined,
				{ placement: "belowEditor" },
			);
		});

		it("restores this.borderColor after render completes without leaks", () => {
			applyShellModeIndicator({ theme: defaultTheme });
			const editor = new Editor(tui, defaultTheme);
			const initialBorderColor = editor.borderColor;

			editor.setText("!test");
			editor.render(80);

			// After render completes, editor.borderColor must match initial
			expect(editor.borderColor).toBe(initialBorderColor);
		});
	});

	describe("Coordination with Vim mode (VimEditor)", () => {
		const tui = { terminal: { rows: 24, columns: 80 } } as any;
		const defaultTheme = {
			name: "rose-pine-dawn",
			borderColor: (s: string) => `\x1b[34m${s}\x1b[39m`,
		} as any;

		it("renders #FF0087 border alongside Vim INSERT mode badge and 'In shell mode' without ! indicator", () => {
			applyShellModeIndicator({ theme: defaultTheme });
			const vimEditor = new VimEditor(tui, defaultTheme, {});
			(vimEditor as any).mode = "insert";
			vimEditor.setText("!git commit -m 'feat'");

			const lines = vimEditor.render(80);
			const topBorder = lines[0];
			const bottomBorder = lines[lines.length - 1];

			expect(topBorder.includes("!")).toBe(false);
			expect(bottomBorder.includes("!")).toBe(false);
			expect(topBorder.includes(SHELL_MODE_COLOR_ANSI)).toBe(true);
			expect(bottomBorder.includes(SHELL_MODE_COLOR_ANSI)).toBe(true);
			expect(bottomBorder.includes("INSERT")).toBe(true);
			expect(bottomBorder.includes("In shell mode")).toBe(true);
			expect(visibleWidth(topBorder)).toBe(80);
			expect(visibleWidth(bottomBorder)).toBe(80);
		});

		it("renders #FF0087 border alongside Vim NORMAL mode badge and 'In shell mode' without ! indicator", () => {
			applyShellModeIndicator({ theme: defaultTheme });
			const vimEditor = new VimEditor(tui, defaultTheme, {});
			(vimEditor as any).mode = "normal";
			vimEditor.setText("!docker compose up -d");

			const lines = vimEditor.render(80);
			const topBorder = lines[0];
			const bottomBorder = lines[lines.length - 1];

			expect(topBorder.includes("!")).toBe(false);
			expect(bottomBorder.includes("!")).toBe(false);
			expect(topBorder.includes(SHELL_MODE_COLOR_ANSI)).toBe(true);
			expect(bottomBorder.includes(SHELL_MODE_COLOR_ANSI)).toBe(true);
			expect(bottomBorder.includes("NORMAL")).toBe(true);
			expect(bottomBorder.includes("In shell mode")).toBe(true);
			expect(visibleWidth(topBorder)).toBe(80);
			expect(visibleWidth(bottomBorder)).toBe(80);
		});

		it("preserves Vim bottom border when text is not shell command", () => {
			applyShellModeIndicator({ theme: defaultTheme });
			const vimEditor = new VimEditor(tui, defaultTheme, {});
			(vimEditor as any).mode = "normal";
			vimEditor.setText("regular editing in vim");

			const lines = vimEditor.render(80);
			const topBorder = lines[0];
			const bottomBorder = lines[lines.length - 1];

			expect(topBorder.includes(SHELL_MODE_COLOR_ANSI)).toBe(false);
			expect(bottomBorder.includes(SHELL_MODE_COLOR_ANSI)).toBe(false);
			expect(bottomBorder.includes("NORMAL")).toBe(true);
			expect(visibleWidth(topBorder)).toBe(80);
			expect(visibleWidth(bottomBorder)).toBe(80);
		});
	});

	describe("Coordination with standout-commands", () => {
		const tui = { terminal: { rows: 24, columns: 80 } } as any;
		const defaultTheme = {
			name: "rose-pine-dawn",
			borderColor: (s: string) => `\x1b[34m${s}\x1b[39m`,
		} as any;

		it("chains cleanly when standout-commands and shell-mode-indicator are both applied", () => {
			applyStandoutCommands();
			applyShellModeIndicator({ theme: defaultTheme });

			const editor = new Editor(tui, defaultTheme);
			editor.setText("!echo /clear");

			const lines = editor.render(80);
			const topBorder = lines[0];
			const bottomBorder = lines[lines.length - 1];

			expect(topBorder.includes(SHELL_MODE_COLOR_ANSI)).toBe(true);
			expect(bottomBorder.includes(SHELL_MODE_COLOR_ANSI)).toBe(true);
			expect(topBorder.includes("!")).toBe(false);
			expect(bottomBorder.includes("!")).toBe(false);
			expect(visibleWidth(topBorder)).toBe(80);
			expect(visibleWidth(bottomBorder)).toBe(80);
		});
	});

	describe("Extension lifecycle", () => {
		it("initializes via default export and registers session_start and session_shutdown listeners", () => {
			let sessionStartHandler: any;
			let sessionShutdownHandler: any;
			const mockPi: any = {
				on: (event: string, handler: any) => {
					if (event === "session_start") {
						sessionStartHandler = handler;
					} else if (event === "session_shutdown") {
						sessionShutdownHandler = handler;
					}
				},
			};

			rbfShellModeIndicator(mockPi);
			expect((Editor.prototype as any)[SHELL_MODE_PATCHED_KEY]).toBe(true);
			expect(sessionStartHandler).toBeDefined();
			expect(sessionShutdownHandler).toBeDefined();

			const mockUi = { setWidget: vi.fn() };
			sessionStartHandler({}, { ui: mockUi });
			expect(getUiContext()).toBe(mockUi);

			sessionShutdownHandler({}, {});
			expect(mockUi.setWidget).toHaveBeenCalledWith(
				SHELL_MODE_WIDGET_KEY,
				undefined,
				{ placement: "belowEditor" },
			);
			expect(getUiContext()).toBeUndefined();
		});

		it("clears widget on restoreShellModeIndicator", () => {
			const mockUi = { setWidget: vi.fn() };
			setUiContext(mockUi);

			restoreShellModeIndicator();
			expect(mockUi.setWidget).toHaveBeenCalledWith(
				SHELL_MODE_WIDGET_KEY,
				undefined,
				{ placement: "belowEditor" },
			);
			expect(getUiContext()).toBeUndefined();
		});
	});
});
