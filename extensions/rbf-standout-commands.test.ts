import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor, visibleWidth, CURSOR_MARKER } from "@earendil-works/pi-tui";
import rbfStandoutCommands, {
	applyStandoutCommands,
	DEFAULT_BUILTIN_COMMANDS,
	findCommandTokens,
	getRegisteredCommandNames,
	highlightLineText,
	renderLineWithHighlightsAndCursor,
	restoreStandoutCommands,
	STANDOUT_COMMANDS_PATCHED_KEY,
	styleCommandToken,
} from "./rbf-standout-commands.ts";
import * as fs from "node:fs";
import * as path from "node:path";

function createMockTui() {
	return {
		terminal: { rows: 24, columns: 80 },
		requestRender: vi.fn(),
		clearTextSelection: vi.fn(),
	};
}

const mockTheme = {
	borderColor: (s: string) => s,
	selectList: {
		selectedPrefix: (s: string) => s,
		selectedText: (s: string) => s,
		description: (s: string) => s,
		scrollInfo: (s: string) => s,
		noMatch: (s: string) => s,
	},
};

const customMockTheme = {
	fg: (color: string, text: string) => `[STYLE:${color}]${text}[/STYLE]`,
};

describe("rbf-standout-commands extension", () => {
	beforeEach(() => {
		restoreStandoutCommands();
	});

	afterEach(() => {
		restoreStandoutCommands();
	});

	describe("styleCommandToken", () => {
		it("styles token using theme.fg mdLink when available", () => {
			const styled = styleCommandToken("/clear", customMockTheme);
			expect(styled).toBe("[STYLE:mdLink]/clear[/STYLE]");
		});

		it("falls back to default ANSI truecolor blue when theme is absent", () => {
			const styled = styleCommandToken("/clear", null);
			expect(styled).toContain("\x1b[38;2;86;148;159m/clear\x1b[39m");
		});

		it("returns empty string for empty input", () => {
			expect(styleCommandToken("")).toBe("");
		});
	});

	describe("getRegisteredCommandNames", () => {
		it("includes all default built-in commands", () => {
			const registry = getRegisteredCommandNames();
			expect(registry.has("clear")).toBe(true);
			expect(registry.has("model")).toBe(true);
			expect(registry.has("exit")).toBe(true);
			expect(registry.has("compact")).toBe(true);
			expect(registry.has("settings")).toBe(true);
		});

		it("absorbs extra commands and normalizes slashes", () => {
			const registry = getRegisteredCommandNames(undefined, [
				"/custom-command",
				"skill:convo-one-at-a-time",
				"my-template",
			]);
			expect(registry.has("custom-command")).toBe(true);
			expect(registry.has("skill:convo-one-at-a-time")).toBe(true);
			expect(registry.has("my-template")).toBe(true);
		});

		it("extracts commands dynamically from editor autocompleteProvider", () => {
			const mockEditor = {
				autocompleteProvider: {
					commands: [
						{ name: "provider-cmd", description: "Test command" },
						{ name: "skill:dynamic-skill", description: "Skill command" },
					],
				},
			};
			const registry = getRegisteredCommandNames(mockEditor);
			expect(registry.has("provider-cmd")).toBe(true);
			expect(registry.has("skill:dynamic-skill")).toBe(true);
		});

		it("traverses wrapped autocomplete providers", () => {
			const mockEditor = {
				autocompleteProvider: {
					inner: {
						commands: [{ name: "deep-command" }],
					},
				},
			};
			const registry = getRegisteredCommandNames(mockEditor);
			expect(registry.has("deep-command")).toBe(true);
		});
	});

	describe("findCommandTokens", () => {
		const registry = new Set([
			"clear",
			"model",
			"exit",
			"compact",
			"skill:convo-one-at-a-time",
			"skill:call-friend-agent",
		]);

		it("detects slash command at the start of a line", () => {
			const tokens = findCommandTokens("/clear", registry);
			expect(tokens).toHaveLength(1);
			expect(tokens[0]).toEqual({
				start: 0,
				end: 6,
				token: "/clear",
				commandName: "clear",
			});
		});

		it("detects slash command followed by arguments without highlighting arguments", () => {
			const tokens = findCommandTokens("/model gpt-5.6-luna", registry);
			expect(tokens).toHaveLength(1);
			expect(tokens[0]).toEqual({
				start: 0,
				end: 6,
				token: "/model",
				commandName: "model",
			});
		});

		it("detects inline skill token matching Claude Code reference", () => {
			const line = "run this /skill:convo-one-at-a-time after";
			const tokens = findCommandTokens(line, registry);
			expect(tokens).toHaveLength(1);
			expect(tokens[0]).toEqual({
				start: 9,
				end: 35,
				token: "/skill:convo-one-at-a-time",
				commandName: "skill:convo-one-at-a-time",
			});
		});

		it("detects standalone skill:name without leading slash if registered", () => {
			const line = "use skill:call-friend-agent now";
			const tokens = findCommandTokens(line, registry);
			expect(tokens).toHaveLength(1);
			expect(tokens[0]).toEqual({
				start: 4,
				end: 27,
				token: "skill:call-friend-agent",
				commandName: "skill:call-friend-agent",
			});
		});

		it("ignores unrecognized commands and partial typos (Option B)", () => {
			expect(findCommandTokens("/not-a-command", registry)).toHaveLength(0);
			expect(findCommandTokens("/clearr", registry)).toHaveLength(0);
			expect(findCommandTokens("/mode", registry)).toHaveLength(0);
			expect(findCommandTokens("/skill:unknown-skill", registry)).toHaveLength(0);
		});

		it("ignores file paths with multiple slashes", () => {
			expect(findCommandTokens("/usr/local/bin", registry)).toHaveLength(0);
			expect(findCommandTokens("/Users/tom/project/file.ts", registry)).toHaveLength(0);
			expect(findCommandTokens("src/components/editor.ts", registry)).toHaveLength(0);
			expect(findCommandTokens("./extensions/test.ts", registry)).toHaveLength(0);
		});

		it("ignores standalone single slash or url protocols", () => {
			expect(findCommandTokens("/", registry)).toHaveLength(0);
			expect(findCommandTokens("//", registry)).toHaveLength(0);
			expect(findCommandTokens("http://example.com", registry)).toHaveLength(0);
			expect(findCommandTokens("file:///path/to/file", registry)).toHaveLength(0);
		});

		it("handles multiple command tokens on the same line", () => {
			const line = "first run /clear and then /model gpt-5.6-luna";
			const tokens = findCommandTokens(line, registry);
			expect(tokens).toHaveLength(2);
			expect(tokens[0].token).toBe("/clear");
			expect(tokens[1].token).toBe("/model");
		});

		it("recognizes commands enclosed in brackets or punctuation", () => {
			const line = "Please run (/exit) or /clear.";
			const tokens = findCommandTokens(line, registry);
			expect(tokens).toHaveLength(2);
			expect(tokens[0].token).toBe("/exit");
			expect(tokens[1].token).toBe("/clear");
		});

		it("matches case-insensitively", () => {
			const tokens = findCommandTokens("/CLEAR", registry);
			expect(tokens).toHaveLength(1);
			expect(tokens[0].token).toBe("/CLEAR");
		});
	});

	describe("highlightLineText", () => {
		it("returns unchanged text when tokens list is empty", () => {
			expect(highlightLineText("plain text", [], (s) => `[${s}]`)).toBe("plain text");
		});

		it("wraps token with styleFn", () => {
			const text = "run /clear now";
			const tokens = [{ start: 4, end: 10, token: "/clear" }];
			const result = highlightLineText(text, tokens, (s) => `<BLUE>${s}</BLUE>`);
			expect(result).toBe("run <BLUE>/clear</BLUE> now");
		});

		it("handles token at very start and very end", () => {
			const text = "/clear";
			const tokens = [{ start: 0, end: 6, token: "/clear" }];
			const result = highlightLineText(text, tokens, (s) => `<B>${s}</B>`);
			expect(result).toBe("<B>/clear</B>");
		});
	});

	describe("renderLineWithHighlightsAndCursor", () => {
		const styleFn = (s: string) => `<COLOR>${s}</COLOR>`;
		const segmentFn = (text: string) =>
			Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text));

		it("renders line without cursor", () => {
			const line = "hello /clear world";
			const tokens = [{ start: 6, end: 12, token: "/clear", commandName: "clear" }];
			const res = renderLineWithHighlightsAndCursor(line, tokens, undefined, false, segmentFn, styleFn);
			expect(res).toBe("hello <COLOR>/clear</COLOR> world");
		});

		it("renders cursor at end of line", () => {
			const line = "/clear";
			const tokens = [{ start: 0, end: 6, token: "/clear", commandName: "clear" }];
			const res = renderLineWithHighlightsAndCursor(line, tokens, 6, false, segmentFn, styleFn);
			expect(res).toBe("<COLOR>/clear</COLOR>\x1b[7m \x1b[0m");
		});

		it("renders cursor outside of highlighted tokens", () => {
			const line = "run /clear now";
			const tokens = [{ start: 4, end: 10, token: "/clear", commandName: "clear" }];
			// Cursor on 'r' at index 0
			const res = renderLineWithHighlightsAndCursor(line, tokens, 0, false, segmentFn, styleFn);
			expect(res).toBe("\x1b[7mr\x1b[0mun <COLOR>/clear</COLOR> now");
		});

		it("renders cursor inside highlighted token (middle letter)", () => {
			const line = "run /clear now";
			const tokens = [{ start: 4, end: 10, token: "/clear", commandName: "clear" }];
			// Cursor on 'l' at index 6 (inside /clear)
			const resL = renderLineWithHighlightsAndCursor(line, tokens, 6, false, segmentFn, styleFn);
			expect(resL).toBe(
				"run <COLOR>/c</COLOR>\x1b[7m<COLOR>l</COLOR>\x1b[0m<COLOR>ear</COLOR> now",
			);

			// Cursor on 'e' at index 7 (inside /clear)
			const resE = renderLineWithHighlightsAndCursor(line, tokens, 7, false, segmentFn, styleFn);
			expect(resE).toBe(
				"run <COLOR>/cl</COLOR>\x1b[7m<COLOR>e</COLOR>\x1b[0m<COLOR>ar</COLOR> now",
			);
		});

		it("renders cursor on first character ('/') of highlighted token", () => {
			const line = "/clear";
			const tokens = [{ start: 0, end: 6, token: "/clear", commandName: "clear" }];
			// Cursor at index 0 ('/')
			const res = renderLineWithHighlightsAndCursor(line, tokens, 0, false, segmentFn, styleFn);
			expect(res).toBe("\x1b[7m<COLOR>/</COLOR>\x1b[0m<COLOR>clear</COLOR>");
		});

		it("renders cursor on last character of highlighted token", () => {
			const line = "/clear";
			const tokens = [{ start: 0, end: 6, token: "/clear", commandName: "clear" }];
			// Cursor at index 5 ('r')
			const res = renderLineWithHighlightsAndCursor(line, tokens, 5, false, segmentFn, styleFn);
			expect(res).toBe("<COLOR>/clea</COLOR>\x1b[7m<COLOR>r</COLOR>\x1b[0m");
		});

		it("emits hardware CURSOR_MARKER when emitCursorMarker is true", () => {
			const line = "/clear";
			const tokens = [{ start: 0, end: 6, token: "/clear", commandName: "clear" }];
			const res = renderLineWithHighlightsAndCursor(line, tokens, 2, true, segmentFn, styleFn);
			expect(res).toContain(CURSOR_MARKER);
		});
	});

	describe("Editor integration & prototype monkey-patching", () => {
		it("applies patch idempotently and unpatches cleanly", () => {
			expect(applyStandoutCommands()).toBe(true);
			// Already patched: returns false
			expect(applyStandoutCommands()).toBe(false);

			expect((Editor.prototype as any)[STANDOUT_COMMANDS_PATCHED_KEY]).toBe(true);

			expect(restoreStandoutCommands()).toBe(true);
			expect((Editor.prototype as any)[STANDOUT_COMMANDS_PATCHED_KEY]).toBeUndefined();
			expect(restoreStandoutCommands()).toBe(false);
		});

		it("renders highlighted command tokens in Editor.render output", () => {
			applyStandoutCommands({
				theme: customMockTheme,
				extraCommands: ["skill:convo-one-at-a-time"],
			});

			const mockTui = createMockTui();
			const editor = new Editor(mockTui as any, mockTheme as any);
			editor.setText("run this /skill:convo-one-at-a-time after");

			const lines = editor.render(80);
			// lines[0] is top border, lines[1] is the text line, lines[2] is bottom border
			expect(lines.length).toBeGreaterThanOrEqual(3);
			const contentLine = lines[1];

			expect(contentLine).toContain("[STYLE:mdLink]/skill:convo-one-at-a-time[/STYLE]");
			expect(contentLine).toContain("run this ");
			expect(contentLine).toContain(" after");
		});

		it("keeps visibleWidth and border layout completely identical", () => {
			const mockTui = createMockTui();
			const editor = new Editor(mockTui as any, mockTheme as any);
			editor.setText("/model gpt-5.6-luna");

			// Render unpatched
			const unpatchedLines = editor.render(80);
			const unpatchedContentWidth = visibleWidth(unpatchedLines[1]);

			// Apply patch
			applyStandoutCommands();
			const patchedLines = editor.render(80);
			const patchedContentWidth = visibleWidth(patchedLines[1]);

			// ANSI color codes must not alter the visible column width
			expect(patchedContentWidth).toBe(unpatchedContentWidth);
			expect(patchedLines[0]).toBe(unpatchedLines[0]); // Top border unchanged
			expect(patchedLines[2]).toBe(unpatchedLines[2]); // Bottom border unchanged
		});

		it("leaves lines without recognized commands untouched", () => {
			const mockTui = createMockTui();
			const editor = new Editor(mockTui as any, mockTheme as any);
			editor.setText("just plain conversation text without commands");

			const beforeLines = editor.render(80);

			applyStandoutCommands();
			const afterLines = editor.render(80);

			// Should be identical since no commands are present
			expect(afterLines[1]).toBe(beforeLines[1]);
		});

		it("default export rbfStandoutCommands applies patch", () => {
			const mockApi = {
				ui: {
					theme: customMockTheme,
				},
			};
			rbfStandoutCommands(mockApi as any);
			expect((Editor.prototype as any)[STANDOUT_COMMANDS_PATCHED_KEY]).toBe(true);
		});
	});

	describe("Source code safety and zero-dependency verification", () => {
		it("source code contains no unauthorized sinks or network/child_process imports", () => {
			const filePath = path.join(__dirname, "rbf-standout-commands.ts");
			const source = fs.readFileSync(filePath, "utf-8");

			expect(source).not.toMatch(/\bchild_process\b/);
			expect(source).not.toMatch(/\bexecSync\b/);
			expect(source).not.toMatch(/\bspawn\b/);
			expect(source).not.toMatch(/\beval\s*\(/);
			expect(source).not.toMatch(/\bFunction\s*\(/);
			expect(source).not.toMatch(/\bfetch\s*\(/);
			expect(source).not.toMatch(/\bhttp\b/);
			expect(source).not.toMatch(/\bnet\b/);
			expect(source).not.toMatch(/\bws\b/);
		});
	});
});
