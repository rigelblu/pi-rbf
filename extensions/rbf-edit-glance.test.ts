import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import rbfEditGlance, {
	applyEditGlance,
	DEFAULT_MAX_GLANCE_CHANGED_LINES,
	DiffTextComponent,
	EDIT_GLANCE_PATCHED_KEY,
	formatEditSummaryLine,
	formatGlanceDiff,
	getDiffBgAnsi,
	isLightTheme,
	parseDiffLine,
	renderIntraLineDiff,
	replaceTabs,
	restoreEditGlance,
} from "./rbf-edit-glance.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

describe("rbf-edit-glance parsing and formatting helpers", () => {
	beforeEach(() => {
		initTheme();
	});

	it("parseDiffLine correctly parses +, -, context, and spacer lines", () => {
		expect(parseDiffLine("+370 const x = 1;")).toEqual({
			prefix: "+",
			lineNum: "370",
			content: "const x = 1;",
			raw: "+370 const x = 1;",
		});

		expect(parseDiffLine("- 42 oldFunction();")).toEqual({
			prefix: "-",
			lineNum: " 42",
			content: "oldFunction();",
			raw: "- 42 oldFunction();",
		});

		expect(parseDiffLine(" 100 unchanged();")).toEqual({
			prefix: " ",
			lineNum: "100",
			content: "unchanged();",
			raw: " 100 unchanged();",
		});

		expect(parseDiffLine("     ...")).toEqual({
			prefix: " ",
			lineNum: "   ",
			content: "...",
			raw: "     ...",
		});

		expect(parseDiffLine("invalid line without format")).toBeNull();
	});

	it("replaceTabs replaces tabs with 3 spaces", () => {
		expect(replaceTabs("\t\tcode;")).toBe("      code;");
	});

	it("formatEditSummaryLine handles singular and plural line counts", () => {
		const themeMock = {
			fg: (_col: string, s: string) => s,
			bold: (s: string) => s,
		};

		const line1 = formatEditSummaryLine(7, 3, themeMock);
		expect(stripAnsi(line1)).toBe("└ Added 7 lines, removed 3 lines");

		const line2 = formatEditSummaryLine(1, 1, themeMock);
		expect(stripAnsi(line2)).toBe("└ Added 1 line, removed 1 line");

		const line3 = formatEditSummaryLine(0, 0, themeMock);
		expect(stripAnsi(line3)).toBe("└ Added 0 lines, removed 0 lines");
	});

	it("isLightTheme correctly detects light themes by name and luminance", () => {
		// Name checks
		expect(isLightTheme({ name: "rose-pine-dawn" })).toBe(true);
		expect(isLightTheme({ name: "catppuccin-latte" })).toBe(true);
		expect(isLightTheme({ name: "solarized-light" })).toBe(true);
		expect(isLightTheme({ name: "quiet-light" })).toBe(true);
		expect(isLightTheme({ name: "dark" })).toBe(false);
		expect(isLightTheme({ name: "rose-pine-moon" })).toBe(false);

		// Luminance checks via userMessageBg / selectedBg
		const lightByBg = {
			name: "custom-theme",
			bgColors: new Map([["userMessageBg", "\x1b[48;2;250;244;237m"]]),
		};
		expect(isLightTheme(lightByBg)).toBe(true);

		const darkByBg = {
			name: "custom-dark",
			bgColors: new Map([["userMessageBg", "\x1b[48;2;30;30;30m"]]),
		};
		expect(isLightTheme(darkByBg)).toBe(false);

		// Luminance check via dark text foreground
		const lightByFg = {
			name: "custom-paper",
			fgColors: new Map([["text", "\x1b[38;2;80;80;80m"]]),
		};
		expect(isLightTheme(lightByFg)).toBe(true);
	});

	it("getDiffBgAnsi provides Claude Code pink and green background escape sequences", () => {
		const themeMockTruecolorDark = {
			getColorMode: () => "truecolor",
			name: "dark",
		};
		expect(getDiffBgAnsi("removed", themeMockTruecolorDark)).toBe("\x1b[48;2;55;20;20m");
		expect(getDiffBgAnsi("added", themeMockTruecolorDark)).toBe("\x1b[48;2;20;48;25m");

		// Light mode: Claude Code exact light pink (#ffdcdc) and light green (#dcffdc)
		const themeMockTruecolorLight = {
			getColorMode: () => "truecolor",
			name: "light",
		};
		expect(getDiffBgAnsi("removed", themeMockTruecolorLight)).toBe("\x1b[48;2;255;220;220m");
		expect(getDiffBgAnsi("added", themeMockTruecolorLight)).toBe("\x1b[48;2;220;255;220m");

		// rose-pine-dawn theme should also get Claude Code light pink and green
		const themeRosePineDawn = {
			getColorMode: () => "truecolor",
			name: "rose-pine-dawn",
		};
		expect(getDiffBgAnsi("removed", themeRosePineDawn)).toBe("\x1b[48;2;255;220;220m");
		expect(getDiffBgAnsi("added", themeRosePineDawn)).toBe("\x1b[48;2;220;255;220m");

		const themeMock256 = {
			getColorMode: () => "256color",
			name: "dark",
		};
		expect(getDiffBgAnsi("removed", themeMock256)).toBe("\x1b[48;5;52m");
		expect(getDiffBgAnsi("added", themeMock256)).toBe("\x1b[48;5;22m");

		const themeMock256Light = {
			getColorMode: () => "256color",
			name: "light",
		};
		expect(getDiffBgAnsi("removed", themeMock256Light)).toBe("\x1b[48;5;224m");
		expect(getDiffBgAnsi("added", themeMock256Light)).toBe("\x1b[48;5;194m");
	});

	it("DiffTextComponent spans background colors across full line width", () => {
		const removedLine = "\x1b[48;2;255;220;220m-11 const a = 1;\x1b[49m";
		const addedLine = "\x1b[48;2;220;255;220m+11 const a = 2;\x1b[49m";
		const contextLine = " 12 context";

		const diffText = [removedLine, addedLine, contextLine].join("\n");
		const comp = new DiffTextComponent(diffText, 0, 0);
		const rendered = comp.render(80);

		expect(rendered.length).toBe(3);

		// Removed line: background reset \x1b[49m should be at the very end of the line (after padding spaces)
		expect(rendered[0]).toMatch(/\x1b\[48;2;255;220;220m.* \x1b\[49m$/);
		// Added line: background reset \x1b[49m should be at the very end of the line
		expect(rendered[1]).toMatch(/\x1b\[48;2;220;255;220m.* \x1b\[49m$/);
		// Context line: no background escape sequence
		expect(rendered[2]).not.toContain("\x1b[48;");
	});

	it("formatGlanceDiff handles small diff without truncation in collapsed mode", () => {
		const diff = [
			" 10 context before",
			"-11 const a = 1;",
			"+11 const a = 2;",
			" 12 context after",
		].join("\n");

		const result = formatGlanceDiff(diff, {
			expanded: false,
			maxGlanceLines: 8,
		});

		expect(result.addedCount).toBe(1);
		expect(result.removedCount).toBe(1);
		expect(result.isTruncated).toBe(false);
		expect(result.remainingLines).toBe(0);
		expect(stripAnsi(result.summaryLine)).toBe("└ Added 1 line, removed 1 line");

		// Checks line-level background tinting is present on changed lines
		expect(result.diffText).toContain("\x1b[48;2;");
		// Check that the text contains context lines
		expect(stripAnsi(result.diffText)).toContain("context before");
		expect(stripAnsi(result.diffText)).toContain("context after");
	});

	it("formatGlanceDiff truncates large diffs in collapsed mode and appends expand hint", () => {
		// 15 changed lines
		const diffLines = [
			"  1 context start",
			"- 2 line 2",
			"- 3 line 3",
			"- 4 line 4",
			"- 5 line 5",
			"- 6 line 6",
			"+ 2 new 2",
			"+ 3 new 3",
			"+ 4 new 4",
			"+ 5 new 5",
			"+ 6 new 6",
			"+ 7 new 7",
			"+ 8 new 8",
			"+ 9 new 9",
			"+10 new 10",
			"+11 new 11",
			" 12 context end",
		];
		const diff = diffLines.join("\n");

		const collapsedResult = formatGlanceDiff(diff, {
			expanded: false,
			maxGlanceLines: 8,
		});

		expect(collapsedResult.addedCount).toBe(10);
		expect(collapsedResult.removedCount).toBe(5);
		expect(collapsedResult.isTruncated).toBe(true);
		expect(collapsedResult.remainingLines).toBeGreaterThan(0);
		expect(stripAnsi(collapsedResult.diffText)).toContain("more lines,");

		// When expanded, all lines are rendered without truncation hint
		const expandedResult = formatGlanceDiff(diff, {
			expanded: true,
			maxGlanceLines: 8,
		});

		expect(expandedResult.isTruncated).toBe(false);
		expect(expandedResult.remainingLines).toBe(0);
		expect(stripAnsi(expandedResult.diffText)).not.toContain("more lines,");
		expect(stripAnsi(expandedResult.diffText)).toContain("new 11");
		expect(stripAnsi(expandedResult.diffText)).toContain("context end");
	});

	it("renderIntraLineDiff applies inverse styling to changed tokens", () => {
		const themeMock = {
			inverse: (s: string) => `[INV]${s}[/INV]`,
		};
		const { removedLine, addedLine } = renderIntraLineDiff("const x = 10;", "const x = 20;", themeMock);
		expect(removedLine).toContain("[INV]10[/INV]");
		expect(addedLine).toContain("[INV]20[/INV]");
	});
});

describe("rbf-edit-glance ToolExecutionComponent patching", () => {
	const mockUi = { requestRender: () => {} };

	const createMockEditToolDef = (diffText: string) => {
		return {
			name: "edit",
			renderShell: "self",
			renderCall: (args: any) => {
				const box = new Box(1, 1, (t: string) => t);
				(box as any).preview = { diff: diffText };
				box.addChild(new Text(`edit ${args?.path ?? "file.ts"}`, 0, 0));
				return box;
			},
			renderResult: (_result: any) => {
				return new Box(1, 1, (t: string) => t);
			},
		};
	};

	beforeEach(() => {
		initTheme();
		restoreEditGlance();
	});

	afterEach(() => {
		restoreEditGlance();
	});

	it("applyEditGlance() keeps the edit container transparent with zero padding", () => {
		applyEditGlance();

		const diff = [
			" 1 context",
			"-2 oldLine();",
			"+2 newLine();",
			" 3 context end",
		].join("\n");

		const comp = new ToolExecutionComponent(
			"edit",
			"call_edit_1",
			{ path: "src/index.ts" },
			{},
			createMockEditToolDef(diff) as any,
			mockUi as any,
			"/cwd",
		);

		const callComp = (comp as any).callRendererComponent as any;
		expect(callComp).toBeDefined();
		expect(callComp.paddingY).toBe(0);
		expect(callComp.paddingX).toBe(0);
		expect(callComp.bgFn).toBeUndefined();

		const rendered = comp.render(80);
		const fullText = stripAnsi(rendered.join("\n"));

		// Must show header
		expect(fullText).toContain("edit src/index.ts");
		// Must show summary line
		expect(fullText).toContain("└ Added 1 line, removed 1 line");
		// Must show diff lines
		expect(fullText).toContain("newLine();");
	});

	it("toggles between collapsed glance and full expanded diff on setExpanded", () => {
		applyEditGlance();

		// Create diff with 12 changes
		const changes: string[] = [" 1 start"];
		for (let i = 2; i <= 13; i++) {
			changes.push(`+${i} line ${i}`);
		}
		changes.push(" 14 end");
		const diff = changes.join("\n");

		const comp = new ToolExecutionComponent(
			"edit",
			"call_edit_toggle",
			{ path: "src/big.ts" },
			{},
			createMockEditToolDef(diff) as any,
			mockUi as any,
			"/cwd",
		);

		// Initial: collapsed
		expect((comp as any).expanded).toBe(false);
		const collapsedOutput = stripAnsi(comp.render(80).join("\n"));
		expect(collapsedOutput).toContain("more lines,");
		expect(collapsedOutput).not.toContain("line 13");

		// Expand
		comp.setExpanded(true);
		expect((comp as any).expanded).toBe(true);
		const expandedOutput = stripAnsi(comp.render(80).join("\n"));
		expect(expandedOutput).not.toContain("more lines,");
		expect(expandedOutput).toContain("line 13");
		expect(expandedOutput).toContain("14 end");

		// Collapse back
		comp.setExpanded(false);
		const recollapsedOutput = stripAnsi(comp.render(80).join("\n"));
		expect(recollapsedOutput).toContain("more lines,");
		expect(recollapsedOutput).not.toContain("line 13");
	});

	it("glances a codex_patch row exactly as an edit row (#pi-10.3)", () => {
		applyEditGlance();
		const diff = [" 1 context", "-2 oldLine();", "+2 newLine();", " 3 context end"].join("\n");
		const codexDef = { ...createMockEditToolDef(diff), name: "codex_patch" };
		const comp = new ToolExecutionComponent("codex_patch", "codex-item-1", { itemId: "item-1", changes: [] }, {}, codexDef as any, mockUi as any, "/cwd");
		const callComp = (comp as any).callRendererComponent as any;
		expect(callComp.paddingY).toBe(0);
		expect(callComp.bgFn).toBeUndefined();
		const fullText = stripAnsi(comp.render(80).join("\n"));
		expect(fullText).toContain("└ Added 1 line, removed 1 line");
		expect(fullText).toContain("newLine();");
	});

	it("leaves non-edit tool executions untouched", () => {
		applyEditGlance();

		const bashToolDef = {
			name: "bash",
			renderShell: "default",
			renderCall: () => new Text("bash ls", 0, 0),
			renderResult: () => new Text("file1.txt", 0, 0),
		};

		const comp = new ToolExecutionComponent(
			"bash",
			"call_bash_1",
			{ command: "ls" },
			{},
			bashToolDef as any,
			mockUi as any,
			"/cwd",
		);

		// contentBox for non-edit tool retains standard behavior
		const contentBox = (comp as any).contentBox;
		expect(contentBox).toBeDefined();
	});

	it("applyEditGlance is idempotent and restoreEditGlance unpatches cleanly", () => {
		const applied1 = applyEditGlance();
		expect(applied1).toBe(true);

		const applied2 = applyEditGlance();
		expect(applied2).toBe(false);

		expect((ToolExecutionComponent.prototype as any)[EDIT_GLANCE_PATCHED_KEY]).toBe(true);

		const restored = restoreEditGlance();
		expect(restored).toBe(true);
		expect((ToolExecutionComponent.prototype as any)[EDIT_GLANCE_PATCHED_KEY]).toBeUndefined();

		const restoredAgain = restoreEditGlance();
		expect(restoredAgain).toBe(false);
	});

	it("default export rbfEditGlance applies the patch", () => {
		rbfEditGlance();
		expect((ToolExecutionComponent.prototype as any)[EDIT_GLANCE_PATCHED_KEY]).toBe(true);
	});

	it("source code contains no unauthorized sinks or network/child_process imports", () => {
		const sourcePath = resolve(__dirname, "rbf-edit-glance.ts");
		const content = readFileSync(sourcePath, "utf-8");

		expect(content).not.toMatch(/node:child_process|child_process/);
		expect(content).not.toMatch(/node:fs/);
		expect(content).not.toMatch(/(?:from\s+['"]fs['"]|require\(['"]fs['"]\))/);
		expect(content).not.toMatch(/node:net|node:http|fetch/);
		expect(content).not.toMatch(/process\.exit/);
	});
});
