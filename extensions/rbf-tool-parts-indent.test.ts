import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	initTheme,
	ToolExecutionComponent,
	BashExecutionComponent,
	SkillInvocationMessageComponent,
	createBashToolDefinition,
	createEditToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import rbfToolPartsIndent, {
	applyToolPartsIndent,
	getActiveTheme,
	IndentedParts,
	isBlankRow,
	ORIG_TOOL_RENDER_KEY,
	PANE_WIDE_KEY,
	PIECE_KEY,
	restoreToolPartsIndent,
	rowWidth,
	SplitText,
	TOOL_RENDER_WRAPPED_KEY,
	BASH_RENDER_WRAPPED_KEY,
} from "./rbf-tool-parts-indent.ts";
import { applyEditGlance, restoreEditGlance } from "./rbf-edit-glance.ts";
import {
	applyToolExecutionBlended,
	restoreToolExecutionBlended,
} from "./rbf-tool-execution-blended.ts";
import {
	patchBashExecutionComponent,
	unpatchBashExecutionComponent,
} from "./rbf-background-tasks.ts";

// Lets a test see which rows the extension hands to pi-tui's `visibleWidth`. The function itself is pi-tui's own.
const measured = vi.hoisted(() => ({ rows: undefined as string[] | undefined }));
vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
	return {
		...actual,
		visibleWidth: (row: string) => {
			measured.rows?.push(row);
			return actual.visibleWidth(row);
		},
	};
});

function clean(str: string): string {
	return stripTerminalSequences(str).trimEnd();
}

/** A row's drawn lines as plain text, with the blank rows around them cut. */
function visibleLines(comp: any, width = 80): string[] {
	const lines = comp.render(width).map(clean);
	let start = 0;
	while (start < lines.length && lines[start] === "") start++;
	let end = lines.length;
	while (end > start && lines[end - 1] === "") end--;
	return lines.slice(start, end);
}

const mockUi = { requestRender: () => {} };
const hasOwn = (target: any, key: PropertyKey) => Object.prototype.hasOwnProperty.call(target, key);

function makeResult(text: string, isError = false, details?: any) {
	return {
		content: [{ type: "text" as const, text }],
		isError,
		details,
	};
}

function toolRow(name: string, args: any, def: any, setup?: (row: any) => void): any {
	const row = new ToolExecutionComponent(name, `call-${name}`, args, {}, def as any, mockUi as any, "/cwd");
	setup?.(row);
	(row as any).updateDisplay();
	return row;
}

function createBashToolDef(defaultOutput = "") {
	return {
		name: "bash",
		renderShell: "default",
		renderCall: (args: any) => new Text(`$ ${args?.command ?? "ls"}`, 0, 0),
		renderResult: (result: any) => {
			const text =
				result?.content?.[0]?.text ??
				(typeof result?.content === "string" ? result.content : defaultOutput);
			return new Text(text, 0, 0);
		},
	};
}

/** An edit row built as Pi builds it: a call box with a header, a spacer, and the diff, and a result that is a spacer and a text padded 1. */
function createEditToolDef(diffText: string, previewDiff = diffText) {
	return {
		name: "edit",
		renderShell: "self",
		renderCall: (args: any) => {
			const box = new Box(1, 1, (t: string) => t);
			if (previewDiff) {
				(box as any).preview = { diff: previewDiff };
			}
			box.addChild(new Text(`edit ${args?.path ?? "file.ts"}`, 0, 0));
			if (previewDiff) {
				box.addChild(new Spacer(1));
				box.addChild(new Text(previewDiff, 0, 0));
			}
			return box;
		},
		renderResult: (result: any) => {
			const container = new Container();
			const text = result?.content?.[0]?.text ?? "";
			if (text) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(text, 1, 0));
			}
			return container;
		},
	};
}

/** A tool call row built as `rbf-codex` builds `codex_tool`: a container holding the title and the argument lines, and a result after a blank line. */
const codexToolDef = {
	name: "codex_tool",
	renderShell: "default",
	renderCall: (args: any) => {
		const container = new Container();
		container.addChild(new Text("node_repl.js", 0, 0));
		container.addChild(new Text(args.code, 0, 0));
		return container;
	},
	renderResult: (result: any) => new Text(`\n${result?.content?.[0]?.text ?? ""}`, 0, 0),
};

const LONG = "word ".repeat(40).trim();
const DIFF = " 1 start\n-2 old\n+2 new\n 3 end";
const EDIT_ARGS = { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] };

/** Pi's own shell row. */
function shellRow(output: string, expanded = false, command = "ls"): any {
	return toolRow("bash", { command }, createBashToolDefinition("/cwd"), (row) => {
		row.expanded = expanded;
		row.isPartial = false;
		row.result = makeResult(output);
	});
}

/** Pi's own write row, failed when `error` is given. */
function writeRow(content: string, error?: string, expanded = false, path = "src/a.txt"): any {
	return toolRow("write", { path, content }, createWriteToolDefinition("/cwd"), (row) => {
		row.argsComplete = true;
		row.expanded = expanded;
		if (error) {
			row.isPartial = false;
			row.result = makeResult(error, true);
		}
	});
}

/** Pi's own edit row with a diff preview. */
function editDiffRow(diff = DIFF): any {
	const row = toolRow("edit", EDIT_ARGS, createEditToolDefinition("/cwd"));
	(row as any).callRendererComponent.preview = { diff, firstChangedLine: 2 };
	(row as any).updateDisplay();
	return row;
}

/** Pi's own edit row with a diff preview and then an error result: the diff stays and the error follows it. */
function editDiffErrorRow(error = "The file changed on disk"): any {
	const row = editDiffRow();
	(row as any).isPartial = false;
	(row as any).result = makeResult(error, true);
	(row as any).updateDisplay();
	return row;
}

/** Pi's own edit row whose call box holds the header alone and whose result is an error. */
function editFailRow(error = "Could not find the exact text in src/a.ts"): any {
	return toolRow("edit", EDIT_ARGS, createEditToolDefinition("/cwd"), (row) => {
		row.isPartial = false;
		row.result = makeResult(error, true);
	});
}

function codexToolRow(code = "GATE_J1\nGATE_J2", output = "GATE_R1"): any {
	return toolRow("codex_tool", { code }, codexToolDef, (row) => {
		row.isPartial = false;
		row.result = makeResult(output);
	});
}

/** Pi's row for a `!` command, finished unless `exitCode` is "running". */
function bangRow(command: string, output = "", exitCode: number | "running" = 0): any {
	const row = new BashExecutionComponent(command, mockUi as any, false);
	if (output) row.appendOutput(output);
	if (exitCode !== "running") row.setComplete(exitCode, false);
	return row;
}

/** The rows a builder draws with the indent not installed. */
function drawnWithout(build: () => any, width = 80): string[] {
	restoreToolPartsIndent();
	const rows = build().render(width);
	applyToolPartsIndent();
	return rows;
}

describe("extensions/rbf-tool-parts-indent", () => {
	beforeEach(() => {
		initTheme();
		restoreToolPartsIndent();
		restoreEditGlance();
		restoreToolExecutionBlended();
		unpatchBashExecutionComponent();
	});

	afterEach(() => {
		restoreToolPartsIndent();
		restoreEditGlance();
		restoreToolExecutionBlended();
		unpatchBashExecutionComponent();
	});

	describe("Rows and states", () => {
		it("a header-only row draws unchanged", () => {
			const readToolDef = {
				name: "read",
				renderShell: "default",
				renderCall: (args: any) => new Text(`read ${args?.path ?? "file.ts"}`, 0, 0),
				renderResult: () => undefined,
			};
			const baseLines = toolRow("read", { path: "src/file.ts" }, readToolDef).render(80);

			applyToolPartsIndent();
			const rendered = toolRow("read", { path: "src/file.ts" }, readToolDef).render(80);
			expect(rendered).toEqual(baseLines);
			expect(rendered.join("")).not.toContain("└");
		});

		it("a streaming row keeps └ on its first visible line", () => {
			applyToolPartsIndent();
			const comp = toolRow("bash", { command: "tail -f" }, createBashToolDef());

			// Stream 1
			(comp as any).result = makeResult("line1\nline2");
			(comp as any).isPartial = true;
			(comp as any).updateDisplay();
			let lines = visibleLines(comp, 80);
			expect(lines[0]).toBe(" $ tail -f");
			expect(lines[1]).toBe(" └  line1");
			expect(lines[2]).toBe("    line2");

			// Stream 2
			(comp as any).result = makeResult("line1\nline2\nline3");
			(comp as any).updateDisplay();
			lines = visibleLines(comp, 80);
			expect(lines[0]).toBe(" $ tail -f");
			expect(lines[1]).toBe(" └  line1");
			expect(lines[2]).toBe("    line2");
			expect(lines[3]).toBe("    line3");
		});

		it("a cancelled row's status line is indented", () => {
			applyToolPartsIndent();
			const comp = toolRow("bash", { command: "sleep 100" }, createBashToolDef(), (row) => {
				row.result = makeResult("Command aborted", true);
			});
			const lines = visibleLines(comp, 80);
			expect(lines[0]).toBe(" $ sleep 100");
			expect(lines[1]).toBe(" └  Command aborted");
		});

		it("a shell command with line breaks is all header", () => {
			applyToolPartsIndent();
			const comp = toolRow("bash", { command: "echo hello \\\n  && echo world" }, createBashToolDef("output"), (row) => {
				row.result = makeResult("output");
			});
			const lines = visibleLines(comp, 80);
			expect(lines[0]).toBe(" $ echo hello \\");
			expect(lines[1]).toBe("   && echo world");
			expect(lines[0]).not.toContain("└");
			expect(lines[1]).not.toContain("└");
			expect(lines[2]).toBe(" └  output");
		});

		it("echo; echo hi shows hi on the branch line", () => {
			applyToolPartsIndent();
			const comp = toolRow("bash", { command: "echo; echo hi" }, createBashToolDef("\nhi"), (row) => {
				row.result = makeResult("\nhi");
			});
			const lines = visibleLines(comp, 80);
			expect(lines[0]).toBe(" $ echo; echo hi");
			expect(lines[1]).toBe(" └  hi");
		});

		it("a blank row is recognized as an empty string, a run of spaces, and escape codes around spaces", () => {
			expect(isBlankRow("")).toBe(true);
			expect(isBlankRow("   ")).toBe(true);
			expect(isBlankRow("\x1b[31m   \x1b[0m")).toBe(true);
			expect(isBlankRow("\x1b[48;2;20;48;25m  \x1b[49m")).toBe(true);
			expect(isBlankRow("  x ")).toBe(false);
			expect(isBlankRow("\x1b[32m hi \x1b[0m")).toBe(false);
		});
	});

	describe("Shapes", () => {
		it("a row with no renderer draws unchanged", () => {
			const build = () =>
				toolRow("custom_unknown", { foo: "bar" }, undefined, (row) => {
					row.result = makeResult("raw output");
				});
			applyToolPartsIndent();
			const lines = build().render(80);
			expect(lines.map(clean)).toContain(" raw output");
			expect(lines).toEqual(drawnWithout(build));
		});

		it("a tool that draws in the unpadded container and is not edit or codex_patch draws unchanged", () => {
			// Built like the edit row, so only the tool's name keeps it out of the edit shape.
			const def = { ...createEditToolDef(DIFF), name: "custom_unpadded" };
			const build = () =>
				toolRow("custom_unpadded", { path: "f.ts" }, def, (row) => {
					row.result = makeResult("unpadded result");
				});
			applyToolPartsIndent();
			const lines = build().render(80);
			expect(lines.map(clean)).toContain(" edit f.ts");
			expect(lines).toEqual(drawnWithout(build));
		});

		it("a part that pads itself 2 columns leaves its row unchanged", () => {
			const def = {
				name: "custom_pad2",
				renderShell: "default",
				renderCall: () => new Text("title", 0, 0),
				renderResult: (res: any) => new Text(res?.content?.[0]?.text ?? "", 2, 0),
			};
			const build = () =>
				toolRow("custom_pad2", {}, def, (row) => {
					row.result = makeResult("padded2 result");
				});
			applyToolPartsIndent();
			const lines = build().render(80);
			expect(lines.map(clean)).toContain("   padded2 result");
			expect(lines).toEqual(drawnWithout(build));
		});

		it("a tool registered the way rbf-question-form registers question, with a two-line text call part and a text result, keeps both call lines at column 1 and puts its result at column 4", () => {
			applyToolPartsIndent();
			const questionDef = {
				name: "question",
				renderShell: "default",
				renderCall: (args: any) => new Text(`? ${args.question}\nOptions: ${args.options}`, 0, 0),
				renderResult: (result: any) => new Text(result?.content?.[0]?.text ?? "", 0, 0),
			};
			const comp = toolRow("question", { question: "Choose color", options: "Red, Blue" }, questionDef, (row) => {
				row.result = makeResult("Choice: Blue");
			});
			const lines = visibleLines(comp, 80);
			expect(lines[0]).toBe(" ? Choose color");
			expect(lines[1]).toBe(" Options: Red, Blue");
			expect(lines[2]).toBe(" └  Choice: Blue");
		});

		it("an edit row that draws in the padded box takes the default shape", () => {
			applyToolPartsIndent();
			const def = { ...createBashToolDef(), name: "edit" };
			const comp = toolRow("edit", { command: "edit f.ts" }, def, (row) => {
				row.result = makeResult("applied\ndone");
			});
			expect(visibleLines(comp, 80)).toEqual([" $ edit f.ts", " └  applied", "    done"]);
		});
	});

	describe("One branch", () => {
		it("a row with lines in its call part and its result part has one └", () => {
			applyToolPartsIndent();
			// Pi's write row: the content is in the call part, the error in the result part.
			expect(visibleLines(writeRow("a\nb\nc", "EEXIST: nope"), 80)).toEqual([
				" write src/a.txt",
				" └  a",
				"    b",
				"    c",
				"",
				"    EEXIST: nope",
			]);
			// A codex_tool row: the arguments are in the call part, the output in the result part.
			expect(visibleLines(codexToolRow(), 80)).toEqual([
				" node_repl.js",
				" └  GATE_J1",
				"    GATE_J2",
				"",
				"    GATE_R1",
			]);
		});

		it("a summary that already starts with └ gets none added, with two spaces after it and with one", () => {
			const partTwoSpaces = new IndentedParts([new Text("└  Added 1, removed 1", 0, 0)], 3, "└  ", "   ");
			const renderedTwo = partTwoSpaces.render(80).map(clean);
			expect(renderedTwo.filter((l) => l.includes("└")).length).toBe(1);
			expect(renderedTwo[0]).toBe("   └  Added 1, removed 1");

			const partOneSpace = new IndentedParts([new Text("└ Added 1, removed 1", 0, 0)], 3, "└  ", "   ");
			const renderedOne = partOneSpace.render(80).map(clean);
			expect(renderedOne.filter((l) => l.includes("└")).length).toBe(1);
			expect(renderedOne[0]).toBe("   └ Added 1, removed 1");
		});

		it("a part that draws after one that drew keeps its leading blank rows and takes spaces only", () => {
			const first = new IndentedParts([{ render: () => ["", "one"] } as any], 3, "└  ", "   ");
			const second = new IndentedParts([{ render: () => ["", "", "two"] } as any], 3, "└  ", "   ", first);
			expect(first.render(40)).toEqual(["└  one"]);
			expect(second.render(40)).toEqual(["   ", "   ", "   two"]);
		});

		it("a part that draws after one that fell back still takes no └ and keeps its blank row", () => {
			// Fits 50 columns and not 47: the part falls back to the full width, and it did draw a row.
			const first = new IndentedParts([{ render: () => ["x".repeat(50)] } as any], 3, "└  ", "   ");
			const second = new IndentedParts([{ render: () => ["", "error text"] } as any], 3, "└  ", "   ", first);
			expect(first.render(50)).toEqual(["x".repeat(50)]);
			expect(first.drew()).toBe(true);
			expect(second.render(50)).toEqual(["   ", "   error text"]);
		});
	});

	describe("Edit rows the captures can't reach", () => {
		it("an edit row whose call box holds the header alone and whose result is an error draws the error as the branch line, with no blank row above it", () => {
			applyToolPartsIndent();
			applyEditGlance();
			// Pi's own edit row: its result part is a spacer row and then the error text.
			const lines = editFailRow().render(80).map(clean);
			expect(lines).toEqual(["", " edit src/a.ts", " └  Could not find the exact text in src/a.ts"]);
		});

		it("an edit row with a diff and a result that differs from the preview draws that result after one blank row at column 4, with no second └", () => {
			applyToolPartsIndent();
			applyEditGlance();
			// Pi's own edit row: a diff preview, then an error result. Its result part is a spacer row and the error text.
			expect(editDiffErrorRow().render(80).map(clean)).toEqual([
				"",
				" edit src/a.ts",
				" └  Added 1 line, removed 1 line",
				"     1 start",
				"    -2 old",
				"    +2 new",
				"     3 end",
				"",
				"    The file changed on disk",
			]);
		});

		it("an edit row whose diff part draws no rows still gives its result no └, because the summary before it drew one", () => {
			applyToolPartsIndent();
			applyEditGlance();
			const row = editDiffErrorRow();
			row.render(80);
			// The call box now holds the header's margin, the summary's margin, and the diff's part. Empty the diff.
			const diffPart = row.selfRenderContainer.children[0].child.children[2];
			expect(diffPart[PIECE_KEY]).toBe(true);
			diffPart.children[0].setText("");
			expect(row.render(80).map(clean)).toEqual(["", " edit src/a.ts", " └  Added 1 line, removed 1 line", "", "    The file changed on disk"]);
		});

		it("an edit row whose call box holds the header alone draws that header at column 1", () => {
			applyToolPartsIndent();
			applyEditGlance();
			const comp = toolRow("edit", EDIT_ARGS, createEditToolDefinition("/cwd"));
			expect(comp.render(80).map(clean)).toEqual(["", " edit src/a.ts"]);
		});
	});

	describe("Width", () => {
		/** A tool whose result fits Pi's box exactly at `pane` columns and can't be drawn 3 columns narrower. */
		const exactFitRow = (pane: number) =>
			toolRow(
				"fixed",
				{},
				{
					name: "fixed",
					renderShell: "default",
					renderCall: () => new Text("fixed", 0, 0),
					renderResult: () => ({ render: () => ["x".repeat(pane - 2)], invalidate: () => {} }),
				},
				(row) => {
					row.result = makeResult("x");
				},
			);
		const indentedShapes: Record<string, () => any> = {
			"shell row, collapsed": () => shellRow(`${LONG}\n2\n3\n4\n5\n6\n7`),
			"shell row, expanded": () => shellRow(`${LONG}\n2\n3`, true, `echo ${LONG}`),
			"write row": () => writeRow(`${LONG}\nb\nc`),
			"failed write row": () => writeRow(`${LONG}\nb\nc`, `EEXIST ${LONG}`),
			"edit row with a diff": () => editDiffRow(` 1 start\n-2 ${LONG}\n+2 ${LONG} x\n 3 end`),
			"failed edit row": () => editFailRow(`Could not find ${LONG}`),
			"codex_tool row": () => codexToolRow(`GATE_J1\n${LONG}`, LONG),
			"! row": () => bangRow(`echo ${LONG}`, `${LONG}\nbeta\n`, 3),
		};

		it("no row is wider than the pane at every width from 20 to 200", () => {
			applyToolPartsIndent();
			applyEditGlance();
			const tooWide: string[] = [];
			const notIndented: string[] = [];
			for (let width = 20; width <= 200; width++) {
				for (const [name, build] of Object.entries({ ...indentedShapes, "a tool that fits the box exactly": () => exactFitRow(width) })) {
					const rows: string[] = build().render(width);
					if (rows.some((row) => visibleWidth(row) > width)) tooWide.push(`${name} at ${width}`);
					if (name in indentedShapes && !rows.some((row) => /^ └ {2}\S/.test(clean(row)))) notIndented.push(`${name} at ${width}`);
				}
			}
			expect(tooWide).toEqual([]);
			expect(notIndented).toEqual([]);
		});

		const paneShapes: Record<string, () => any> = {
			"shell row": () => shellRow("one\ntwo\nthree"),
			"write row": () => writeRow("a\nb\nc"),
			"edit row, failed": () => editFailRow("no match found here"),
			"edit row with a diff": () => editDiffRow(),
			"! row": () => bangRow("true", "alpha\nbeta\n"),
		};

		it("at 19 columns every row equals the row drawn without the extension", () => {
			applyEditGlance();
			applyToolPartsIndent();
			for (const [name, build] of Object.entries(paneShapes)) {
				const row = build();
				// Regrouped and drawn indented first, so the pieces are in place when the pane narrows.
				const wide = row.render(80);
				expect(wide.map(clean).join("\n"), name).toContain("└");
				expect(row.render(19), name).toEqual(drawnWithout(build, 19));
				expect(build().render(19), name).toEqual(drawnWithout(build, 19));
				expect(row.render(80), name).toEqual(wide);
			}
		});

		it("at pane 20, 21, and 22 a shell row, a write row, an edit row, and a ! row are indented", () => {
			applyEditGlance();
			applyToolPartsIndent();
			for (const [name, build] of Object.entries(paneShapes)) {
				for (const width of [20, 21, 22]) {
					const rows: string[] = build().render(width);
					const lines = rows.map(clean);
					const branch = lines.findIndex((line) => line.startsWith(" └  "));
					expect(branch, `${name} at ${width}:\n${lines.join("\n")}`).toBeGreaterThan(0);
					expect(lines.filter((line) => line.includes("└")).length, `${name} at ${width}`).toBe(1);
					// Every line under the branch line starts at column 4, or is blank, up to a `!` row's bottom border.
					// The edit summary is the one line that wraps at its margin, so its row is left out here.
					const under = lines.slice(branch + 1).filter((line) => line !== "" && !line.startsWith("─") && line !== " removed 1 line");
					expect(under.length, `${name} at ${width}`).toBeGreaterThan(0);
					// A diff's context line holds a space at column 4, where a changed line holds its `-` or `+`.
					for (const line of under) expect(line, `${name} at ${width}`).toMatch(name === "edit row with a diff" ? /^ {4}[ +-]\d/ : /^ {4}\S/);
					for (const row of rows) expect(visibleWidth(row), `${name} at ${width}`).toBeLessThanOrEqual(width);
				}
			}
		});

		it("a child that returns a row one column wider than the width it was given leaves its part drawn at the full width with no prefix, and no row wider than the pane", () => {
			const width = 50;
			// Asked for 47 columns it still returns 48: it fits the full width and not 3 less.
			const child = { render: (w: number) => ["x".repeat(Math.max(w, 48))] };
			const parts = new IndentedParts([child as any], 3, "└  ", "   ");
			const lines = parts.render(width);
			expect(lines).toEqual(["x".repeat(50)]);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);

			// The same with wide characters: 24 of them are 48 columns, though the string is 24 long.
			// They sit on the second row, whose prefix is spaces, so nothing else on that row needs pi-tui to measure it.
			const wide = new IndentedParts([{ render: () => ["ok", "日".repeat(24)] } as any], 3, "└  ", "   ");
			expect(wide.render(width)).toEqual(["ok", "日".repeat(24)]);
			// One fewer fits the indented width, and is indented.
			const fitting = new IndentedParts([{ render: () => ["ok", "日".repeat(23)] } as any], 3, "└  ", "   ");
			expect(fitting.render(width)).toEqual(["└  ok", `   ${"日".repeat(23)}`]);
		});
	});

	describe("Row width", () => {
		const ESC = "\x1b";
		// Every SGR form Pi's theme emits, and the colon form of a colour.
		const SGR = [
			`${ESC}[0m`,
			`${ESC}[m`,
			`${ESC}[1m`,
			`${ESC}[22m`,
			`${ESC}[39m`,
			`${ESC}[49m`,
			...[0, 7, 244, 255].flatMap((n) => [`${ESC}[38;5;${n}m`, `${ESC}[48;5;${n}m`]),
			`${ESC}[38;2;212;212;212m`,
			`${ESC}[48;2;40;50;40m`,
			`${ESC}[38;2;0;0;0m`,
			`${ESC}[38:2:1:2:3m`,
		];
		const ascii = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i));
		/** Rows the fast path measures: printable ASCII and SGR escapes only. */
		const plainRows = (): string[] => [
			"",
			...ascii,
			...ascii.map((ch) => ch.repeat(3)),
			ascii.join(""),
			"export const x1 = 1;   ",
			...SGR.flatMap((sgr) => [sgr, `${sgr}abc`, `ab${sgr}cd`, `abc${sgr}`, `${sgr}${sgr}ab${sgr}`]),
			...SGR.flatMap((a, i) => [`${a}${SGR[(i + 1) % SGR.length]}one ${SGR[(i + 2) % SGR.length]}two${a}  `]),
			SGR.join("") + "all" + SGR.join(""),
		];
		/** Rows that must go to pi-tui: the fast path can't measure them. */
		const otherRows = [
			"a\tb",
			"\t",
			"日本語",
			"ab日cd",
			"a😀b",
			"e\u0301",
			"\u200d",
			"└  branch",
			"caf\u00e9",
			`${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\`,
			`${ESC}]8;;https://example.com\x07link${ESC}]8;;\x07`,
			`a${ESC}b`,
			ESC,
			`abc${ESC}`,
			`${ESC}[2Kabc`,
			`${ESC}[2Kam`, // 2 cells: the escape ends at its K, and the m after it is text
			`${ESC}[5Gabc`,
			`${ESC}[3Aabc`,
			`${ESC}[38;5;1`,
			`${ESC}[1mbold${ESC}[22m\t`,
			`${ESC}[31m日本${ESC}[39m`,
			"a\x07b",
			"a\x7fb",
			"a\rb",
		];
		const realRows = (): string[] => {
			applyEditGlance();
			applyToolPartsIndent();
			const rows = [shellRow(`${LONG}\n2\n3`, true), editDiffRow(), bangRow("printf x", "alpha\nbeta\n", 3)].flatMap((row) => row.render(100) as string[]);
			expect(rows.length).toBeGreaterThan(15);
			expect(rows.filter((row) => row.includes(ESC)).length).toBeGreaterThan(8);
			return rows;
		};

		it("the width function equals pi-tui's visibleWidth on plain rows, coloured rows, rows from real components, and rows only pi-tui can measure", () => {
			const rows = [...plainRows(), ...realRows(), ...otherRows];
			expect(rows.length).toBeGreaterThan(300);
			const wrong = rows.filter((row) => rowWidth(row) !== visibleWidth(row)).map((row) => `${JSON.stringify(row)}: ${rowWidth(row)}, not ${visibleWidth(row)}`);
			expect(wrong).toEqual([]);
			// The set is not all one width, and the escapes are not counted.
			expect(rowWidth(`${ESC}[38;2;212;212;212mabc${ESC}[39m`)).toBe(3);
			expect(rowWidth("日本語")).toBe(6);
			expect(rowWidth("a\tb")).toBe(5);
		});

		it("plain and coloured rows are measured without pi-tui, and every other row reaches pi-tui's visibleWidth", () => {
			measured.rows = [];
			try {
				for (const row of plainRows()) rowWidth(row);
				expect(measured.rows).toEqual([]);
				for (const row of otherRows) rowWidth(row);
				expect(measured.rows).toEqual(otherRows);

				// Through the piece: of three coloured rows, only the branch line holds a character the fast path can't measure.
				measured.rows = [];
				const coloured = ["one", "two", "three"].map((text) => `${ESC}[38;2;128;128;128m${text}${ESC}[39m`);
				const parts = new IndentedParts([{ render: () => coloured } as any], 3, "└  ", "   ");
				expect(parts.render(40).map(clean)).toEqual(["└  one", "   two", "   three"]);
				expect(measured.rows).toEqual([`└  ${coloured[0]}`]);
			} finally {
				measured.rows = undefined;
			}
		});
	});

	describe("Throws", () => {
		it("a child whose render throws at the narrowed width, placed under an IndentedParts, leaves its row drawn unprefixed and nothing thrown", () => {
			const throwAtNarrow = {
				render: (w: number) => {
					if (w < 80) throw new Error("Too narrow!");
					return ["wide line"];
				},
			};
			const parts = new IndentedParts([throwAtNarrow as any], 3, "└  ", "   ");
			let lines: string[] = [];
			expect(() => {
				lines = parts.render(80);
			}).not.toThrow();
			expect(lines).toEqual(["wide line"]);
		});

		it("a child that always throws contributes no rows and nothing is thrown", () => {
			const alwaysThrow = {
				render: () => {
					throw new Error("Fatal failure");
				},
			};
			const safeChild = new Text("safe text", 0, 0);
			const parts = new IndentedParts([alwaysThrow as any, safeChild], 3, "└  ", "   ");
			let lines: string[] = [];
			expect(() => {
				lines = parts.render(80);
			}).not.toThrow();
			expect(lines.length).toBe(1);
			expect(clean(lines[0]!)).toBe("safe text");
		});

		it("a throw in handleMouse and in invalidate goes no further", () => {
			const badChild = {
				render: () => ["line"],
				handleMouse: () => {
					throw new Error("Mouse error");
				},
				invalidate: () => {
					throw new Error("Invalidate error");
				},
			};
			const parts = new IndentedParts([badChild as any], 3, "└  ", "   ");
			parts.render(80);

			expect(() => parts.handleMouse({ x: 10, y: 0 })).not.toThrow();
			expect(parts.handleMouse({ x: 10, y: 0 })).toBeUndefined();

			expect(() => parts.invalidate()).not.toThrow();
		});

		it("a throw while regrouping leaves the row as Pi built it", () => {
			// Reading the result part's padding is the first thing regrouping does with it. Pi never reads it.
			let reads = 0;
			const def = {
				name: "throws_on_read",
				renderShell: "default",
				renderCall: () => new Text("title", 0, 0),
				renderResult: () => ({
					render: () => ["result line"],
					invalidate: () => {},
					get paddingX(): number {
						reads++;
						throw new Error("regroup failed");
					},
				}),
			};
			const build = () =>
				toolRow("throws_on_read", {}, def, (row) => {
					row.result = makeResult("x");
				});
			applyToolPartsIndent();
			const row = build();
			let lines: string[] = [];
			expect(() => {
				lines = row.render(80);
			}).not.toThrow();
			expect(reads).toBeGreaterThan(0);
			expect(lines.map(clean)).toContain(" result line");
			expect(lines).toEqual(drawnWithout(build));
			expect(row.contentBox.children[1].child[PIECE_KEY]).toBeUndefined();
		});
	});

	describe("Mouse", () => {
		it("a left click on a prefix column of a tool row toggles it", () => {
			applyToolPartsIndent();
			const comp = toolRow("bash", { command: "ls" }, createBashToolDef("file1.txt"), (row) => {
				row.result = makeResult("file1.txt");
			});
			const lines = comp.render(80).map(clean);
			// Row 0 is the spacer, 1 the box's padding row, 2 the header, 3 the branch line.
			expect(lines[3]).toBe(" └  file1.txt");
			const piece = comp.contentBox.children[1].child;
			const seen: number[] = [];
			const handleMouse = piece.handleMouse.bind(piece);
			piece.handleMouse = (event: any) => {
				seen.push(event.x);
				return handleMouse(event);
			};

			let expanded = false;
			for (const x of [1, 2, 3]) {
				comp.handleMouse({ x, y: 3, width: 80, height: 10, button: "left", type: "click" } as any);
				expanded = !expanded;
				expect((comp as any).expanded, `click at x=${x}`).toBe(expanded);
				// A toggle rebuilds the row's parts. Draw again, as Pi does, and watch the new piece.
				comp.render(80);
				const next = comp.contentBox.children[1].child;
				const nextHandle = next.handleMouse.bind(next);
				next.handleMouse = (event: any) => {
					seen.push(event.x);
					return nextHandle(event);
				};
			}
			// The box took its one padding column off: the clicks reached the piece on its prefix columns 0, 1, 2.
			expect(seen).toEqual([0, 1, 2]);
		});

		it("a click on the second child's row of an IndentedParts whose first child lost a leading blank row reaches the second child", () => {
			const events: Record<string, any> = {};
			const child = (name: string, rows: string[]) => ({
				render: () => rows,
				handleMouse: (e: any) => {
					events[name] = e;
					return { handled: true };
				},
			});
			const parts = new IndentedParts([child("first", ["", "first line"]) as any, child("second", ["second line"]) as any], 3, "└  ", "   ");
			expect(parts.render(80)).toEqual(["└  first line", "   second line"]);

			expect(parts.handleMouse({ x: 10, y: 1, width: 80, height: 2, button: "left", type: "click" })).toEqual({ handled: true });
			expect(events.second).toMatchObject({ x: 7, y: 0, width: 77, height: 1 });
			expect(events.first).toBeUndefined();

			// The first child's own row 1 is the screen's row 0: its dropped row is counted back in.
			parts.handleMouse({ x: 10, y: 0, width: 80, height: 2, button: "left", type: "click" });
			expect(events.first).toMatchObject({ x: 7, y: 1, width: 77, height: 2 });
		});

		it("a click forwards the child's own row count as height when rows were dropped from more than one child", () => {
			// `!echo; false`: a blank output row, then the status text's blank row and its line.
			let event: any;
			const output = { render: () => [""] };
			const status = {
				render: () => ["", "(exit 1)"],
				handleMouse: (e: any) => {
					event = e;
					return undefined;
				},
			};
			const parts = new IndentedParts([output as any, status as any], 3, "└  ", "   ");
			expect(parts.render(80)).toEqual(["└  (exit 1)"]);
			parts.handleMouse({ x: 10, y: 0, width: 80, height: 1, button: "left", type: "click" });
			expect(event).toMatchObject({ x: 7, y: 1, width: 77, height: 2 });
		});

		it("a click lands on the right child after a wide draw, a narrow draw, and a wide draw again", () => {
			const clicks: string[] = [];
			const child = (name: string, rows: (w: number) => string[]) => ({
				render: rows,
				handleMouse: (e: any) => {
					clicks.push(`${name} x=${e.x} y=${e.y} width=${e.width}`);
					return { handled: true };
				},
			});
			const pane = { [PANE_WIDE_KEY]: true };
			// The first child is two rows at the indented width and one at the full width.
			const parts = new IndentedParts([child("first", (w) => (w < 40 ? ["a1", "a2"] : ["a1"])) as any, child("second", () => ["b1"]) as any], 3, "└  ", "   ", undefined, pane);
			const click = { x: 10, y: 1, width: 40, height: 3 };

			const wide = parts.render(40);
			expect(wide).toEqual(["└  a1", "   a2", "   b1"]);
			pane[PANE_WIDE_KEY] = false;
			expect(parts.render(40)).toEqual(["a1", "b1"]);
			parts.handleMouse(click);
			pane[PANE_WIDE_KEY] = true;
			expect(parts.render(40)).toEqual(wide);
			parts.handleMouse(click);
			// Row 1 is the second child with nothing in front while narrow, and the first child's second row, 3 columns in, once wide again.
			expect(clicks).toEqual(["second x=10 y=0 width=40", "first x=7 y=1 width=37"]);
		});

		it("a click on a part drawn with no prefix swallows no column and shifts no x", () => {
			const events: any[] = [];
			const child = (rows: (w: number) => string[]) => ({
				render: rows,
				handleMouse: (e: any) => {
					events.push(e);
					return { handled: true };
				},
			});
			// A pane narrower than 20 columns.
			const narrow = new IndentedParts([child(() => ["abc"]) as any], 3, "└  ", "   ", undefined, { [PANE_WIDE_KEY]: false });
			expect(narrow.render(18)).toEqual(["abc"]);
			expect(narrow.handleMouse({ x: 1, y: 0, width: 18, height: 1 })).toEqual({ handled: true });
			expect(events[0]).toMatchObject({ x: 1, y: 0, width: 18, height: 1 });

			// An overflow.
			const overflow = new IndentedParts([child(() => ["x".repeat(50)]) as any], 3, "└  ", "   ");
			expect(overflow.render(50)).toEqual(["x".repeat(50)]);
			expect(overflow.handleMouse({ x: 2, y: 0, width: 50, height: 1 })).toEqual({ handled: true });
			expect(events[1]).toMatchObject({ x: 2, y: 0, width: 50, height: 1 });

			// With the prefix drawn, its columns are not the child's.
			const indented = new IndentedParts([child(() => ["abc"]) as any], 3, "└  ", "   ");
			expect(indented.render(50)).toEqual(["└  abc"]);
			expect(indented.handleMouse({ x: 2, y: 0, width: 50, height: 1 })).toBeUndefined();
			expect(events.length).toBe(2);
		});

		it("a click under a write row's header reaches the content with the header's rows taken off y", () => {
			const split = new SplitText(new Text("head one\nhead two\n\nbody one\nbody two", 0, 0), "└  ", "   ");
			expect(split.render(40).map(clean)).toEqual(["head one", "head two", "└  body one", "   body two"]);
			const events: any[] = [];
			split.indentedParts.handleMouse = (event: any) => {
				events.push(event);
				return { handled: true };
			};
			expect(split.handleMouse({ x: 10, y: 1, width: 40, height: 4 })).toBeUndefined();
			expect(events).toEqual([]);
			expect(split.handleMouse({ x: 10, y: 3, width: 40, height: 4 })).toEqual({ handled: true });
			expect(events[0]).toMatchObject({ x: 10, y: 1, width: 40, height: 2 });
		});

		it("a click on a ! row returns nothing", () => {
			applyToolPartsIndent();
			const bashComp = bangRow("echo test", "output line\n");
			bashComp.render(80);

			const mouseResult = bashComp.handleMouse({ x: 5, y: 2, button: "left", type: "click" } as any);
			expect(mouseResult).toBeUndefined();
		});
	});

	describe("Order and neighbours", () => {
		it("the rows are identical with the extensions applied in two opposite orders", () => {
			const shapes: Record<string, () => any> = {
				"shell row": () => shellRow("1\n2\n3"),
				"write row": () => writeRow("a\nb\nc", "EEXIST: nope"),
				"edit row with a diff": () => editDiffRow(),
				"failed edit row": () => editFailRow(),
				"! row, running": () => bangRow("sleep 9", "started\n", "running"),
			};
			const neighbours = [
				[applyToolExecutionBlended, restoreToolExecutionBlended],
				[applyEditGlance, restoreEditGlance],
				[patchBashExecutionComponent, unpatchBashExecutionComponent],
				[applyToolPartsIndent, restoreToolPartsIndent],
			] as const;
			const proto = ToolExecutionComponent.prototype as any;
			const piUpdateDisplay = proto.updateDisplay;
			const draw = (order: (typeof neighbours)[number][]) => {
				for (const [apply] of order) apply();
				const rows = Object.fromEntries(Object.entries(shapes).map(([name, build]) => [name, build().render(80)]));
				// Last on, first off: the neighbours put back what they replaced without checking it is still theirs.
				for (const [, restore] of [...order].reverse()) restore();
				expect(proto.updateDisplay).toBe(piUpdateDisplay);
				return rows;
			};
			const forward = draw([...neighbours]);
			const backward = draw([...neighbours].reverse());
			expect(backward).toEqual(forward);
			// Every neighbour was at work in what was compared: the glance summary, the ctrl+b hint, the indent.
			expect(forward["edit row with a diff"]!.map(clean)).toContain(" └  Added 1 line, removed 1 line");
			expect(forward["! row, running"]!.map(clean).join("\n")).toContain("ctrl+b");
			expect(forward["shell row"]!.map(clean)).toContain(" └  1");
		});

		it("a ! row draws the same with and without rbf-background-tasks applied apart from the running line's wording, and tearing rbf-background-tasks down leaves ! rows indented", () => {
			applyToolPartsIndent();
			const build = (): string[] => bangRow("sleep 10", "started\n", "running").render(80).map(clean);
			// The running line's wording is all that may differ: what its brackets hold.
			const unworded = (lines: string[]) => lines.map((line: string) => line.replace(/(Running\.\.\.) \(.*\)$/, "$1"));

			const alone = build();
			expect(alone.slice(2, 4)).toEqual([" $ sleep 10", " └  started"]);
			const running = alone.findIndex((line) => line.includes("Running..."));
			expect(alone[running]).toMatch(/^ {4}\S+ Running\.\.\. \(.*to cancel\)$/);
			expect(alone[running]).not.toContain("ctrl+b");

			patchBashExecutionComponent();
			const withTasks = build();
			expect(withTasks[running]).toContain("ctrl+b to run in background");
			expect(unworded(withTasks)).toEqual(unworded(alone));

			unpatchBashExecutionComponent();
			expect(build()).toEqual(alone);
		});

		it("with the indent not applied, every row equals today's apart from the summary's second space", () => {
			applyEditGlance();
			const shapes = [() => shellRow("1\n2\n3"), () => writeRow("a\nb\nc", "EEXIST: nope"), () => editDiffRow(), () => bangRow("true", "alpha\nbeta\n")];
			const today = shapes.map((build) => build().render(80));

			// The edit row as it draws today, with two spaces after the summary's └ where it had one.
			expect(today[2]!.map(clean)).toEqual(["", "edit src/a.ts", "└  Added 1 line, removed 1 line", " 1 start", "-2 old", "+2 new", " 3 end"]);

			// Applied, used, and taken off again, the indent leaves nothing behind.
			applyToolPartsIndent();
			for (const build of shapes) expect(build().render(80).map(clean).join("\n")).toContain(" └  ");
			restoreToolPartsIndent();
			expect(shapes.map((build) => build().render(80))).toEqual(today);
		});
	});

	describe("! rows", () => {
		it("a row with only its running line puts └ on that line", () => {
			applyToolPartsIndent();
			const comp = new BashExecutionComponent("sleep 5", mockUi as any, false);
			const lines = comp.render(80).map(clean);
			expect(lines[0]).toBe("");
			expect(lines[1]).toMatch(/─+/);
			expect(lines[2]).toBe(" $ sleep 5");
			expect(lines[3]).toMatch(/└.*Running\.\.\./);
			expect(lines[4]).toMatch(/─+/);
		});

		it("!false puts └ on (exit 1) with no blank row above it", () => {
			applyToolPartsIndent();
			const comp = new BashExecutionComponent("false", mockUi as any, false);
			comp.setComplete(1, false);
			const lines = comp.render(80).map(clean);
			expect(lines[1]).toMatch(/─+/);
			expect(lines[2]).toBe(" $ false");
			expect(lines[3]).toBe(" └  (exit 1)");
			expect(lines[4]).toMatch(/─+/);
		});

		it("a cancelled row shows (cancelled) at column 4", () => {
			applyToolPartsIndent();
			const comp = new BashExecutionComponent("sleep 10", mockUi as any, false);
			comp.appendOutput("start output\n");
			comp.setComplete(null as any, true);
			const lines = comp.render(80).map(clean);
			expect(lines[2]).toBe(" $ sleep 10");
			expect(lines[3]).toBe(" └  start output");
			const cancelledLine = lines.find((l) => l.includes("(cancelled)"))!;
			expect(cancelledLine).toBe("    (cancelled)");
		});

		it("a truncation warning shows at column 4", () => {
			applyToolPartsIndent();
			const comp = new BashExecutionComponent("seq 1 3", mockUi as any, false);
			comp.appendOutput("1\n2\n3\n");
			comp.setComplete(0, false, { truncated: true } as any, "/tmp/full-output.log");
			const lines = comp.render(80).map(clean);
			expect(lines.slice(2, 4)).toEqual([" $ seq 1 3", " └  1"]);
			expect(lines).toContain("    Output truncated. Full output: /tmp/full-output.log");
		});

		it("!echo shows its header alone, and !echo; false puts └ on (exit 1)", () => {
			applyToolPartsIndent();

			// !echo
			const compEcho = new BashExecutionComponent("echo", mockUi as any, false);
			compEcho.appendOutput("\n");
			compEcho.setComplete(0, false);
			const linesEcho = compEcho.render(80).map(clean);
			expect(linesEcho[1]).toMatch(/─+/);
			expect(linesEcho[2]).toBe(" $ echo");
			expect(linesEcho[3]).toMatch(/─+/);
			expect(linesEcho.length).toBe(4);

			// !echo; false
			const compEchoFail = new BashExecutionComponent("echo; false", mockUi as any, false);
			compEchoFail.appendOutput("\n");
			compEchoFail.setComplete(1, false);
			const linesFail = compEchoFail.render(80).map(clean);
			expect(linesFail[1]).toMatch(/─+/);
			expect(linesFail[2]).toBe(" $ echo; false");
			expect(linesFail[3]).toBe(" └  (exit 1)");
			expect(linesFail[4]).toMatch(/─+/);
		});

		it("the blank row, border lines, and header draw the same strings with and without the extension", () => {
			for (const excludeFromContext of [false, true]) {
				const build = () => {
					const row = new BashExecutionComponent("printf x", mockUi as any, excludeFromContext);
					row.appendOutput("alpha\nbeta\n");
					row.setComplete(0, false);
					return row;
				};
				applyToolPartsIndent();
				const indLines = build().render(80);
				const rawLines = drawnWithout(build);
				expect(clean(indLines[3]!)).toBe(" └  alpha");
				expect(indLines.slice(0, 3)).toEqual(rawLines.slice(0, 3));
				expect(indLines[indLines.length - 1]).toBe(rawLines[rawLines.length - 1]);
			}
		});
	});

	describe("Install", () => {
		const toolProto = ToolExecutionComponent.prototype as any;
		const bashProto = BashExecutionComponent.prototype as any;
		const session = () => {
			const listeners: (() => void)[] = [];
			return {
				api: { on: (_event: string, fn: () => void) => listeners.push(fn) } as any,
				shutdown: () => {
					for (const fn of listeners.splice(0)) fn();
				},
			};
		};
		const shellLines = () => visibleLines(shellRow("1\n2\n3"), 80);
		const bangLines = () => bangRow("true", "alpha\nbeta\n").render(80).map(clean).slice(2, 5);
		const INDENTED_SHELL = [" $ ls", " └  1", "    2", "    3"];
		const INDENTED_BANG = [" $ true", " └  alpha", "    beta"];

		it("calling the extension's factory function three times in a row, with a session_shutdown between calls, leaves one wrapper on each prototype and rows indented once", () => {
			const piRender = toolProto.render;
			const flushShell = shellLines();
			const flushBang = bangLines();
			expect(hasOwn(bashProto, "render")).toBe(false);

			const pi = session();
			for (let i = 0; i < 3; i++) {
				rbfToolPartsIndent(pi.api);
				// One wrapper, and the render under it is Pi's own, not an earlier wrapper of ours.
				expect(toolProto.render).toBe(toolProto[TOOL_RENDER_WRAPPED_KEY]);
				expect(toolProto[ORIG_TOOL_RENDER_KEY]).toBe(piRender);
				expect(bashProto.render).toBe(bashProto[BASH_RENDER_WRAPPED_KEY]);
				expect(shellLines()).toEqual(INDENTED_SHELL);
				expect(bangLines()).toEqual(INDENTED_BANG);
				if (i < 2) pi.shutdown();
			}

			// After the last shutdown both prototypes are as Pi made them.
			pi.shutdown();
			expect(toolProto.render).toBe(piRender);
			expect(hasOwn(toolProto, TOOL_RENDER_WRAPPED_KEY)).toBe(false);
			expect(hasOwn(toolProto, ORIG_TOOL_RENDER_KEY)).toBe(false);
			expect(hasOwn(bashProto, "render")).toBe(false);
			expect(hasOwn(bashProto, BASH_RENDER_WRAPPED_KEY)).toBe(false);
			expect(shellLines()).toEqual(flushShell);
			expect(bangLines()).toEqual(flushBang);
		});

		it("calling the factory twice with no shutdown between leaves one wrapper", () => {
			const piRender = toolProto.render;
			const pi = session();
			rbfToolPartsIndent(pi.api);
			const first = toolProto.render;
			rbfToolPartsIndent(pi.api);
			expect(toolProto.render).toBe(first);
			expect(toolProto[ORIG_TOOL_RENDER_KEY]).toBe(piRender);
			expect(shellLines()).toEqual(INDENTED_SHELL);
			pi.shutdown();
			expect(toolProto.render).toBe(piRender);
		});

		it("with another extension's wrapper on top, a shutdown and then a new factory call leave every draw working, with no recursion", () => {
			const piRender = toolProto.render;
			const flushShell = shellLines();
			const pi = session();
			rbfToolPartsIndent(pi.api);
			const ours = toolProto.render;
			const other = function (this: any, width: number): string[] {
				return ours.call(this, width);
			};
			toolProto.render = other;
			try {
				const live = shellRow("1\n2\n3");
				expect(visibleLines(live, 80)).toEqual(INDENTED_SHELL);

				// Shutdown: the other wrapper stays, and ours under it still reaches Pi's render.
				pi.shutdown();
				expect(toolProto.render).toBe(other);
				expect(() => live.render(80)).not.toThrow();
				expect(shellLines()).toEqual(flushShell);

				// A new factory call: no second wrapper of ours, nothing wraps itself, rows indented once.
				rbfToolPartsIndent(pi.api);
				expect(toolProto.render).toBe(other);
				expect(toolProto[TOOL_RENDER_WRAPPED_KEY]).toBe(ours);
				expect(toolProto[ORIG_TOOL_RENDER_KEY]).toBe(piRender);
				expect(shellLines()).toEqual(INDENTED_SHELL);
				expect(visibleLines(live, 80)).toEqual(INDENTED_SHELL);
				pi.shutdown();
				expect(shellLines()).toEqual(flushShell);
			} finally {
				// The other extension leaves, then ours comes off whole.
				toolProto.render = ours;
				restoreToolPartsIndent();
			}
			expect(toolProto.render).toBe(piRender);
		});

		it("a render already on the ! row's prototype is called, not replaced, and is put back on teardown", () => {
			const parent = Object.getPrototypeOf(bashProto);
			let calls = 0;
			const theirs = function (this: any, width: number): string[] {
				calls++;
				return parent.render.call(this, width);
			};
			bashProto.render = theirs;
			try {
				applyToolPartsIndent();
				expect(bangLines()).toEqual(INDENTED_BANG);
				expect(calls).toBe(1);
				restoreToolPartsIndent();
				expect(hasOwn(bashProto, "render")).toBe(true);
				expect(bashProto.render).toBe(theirs);
			} finally {
				delete bashProto.render;
			}
		});

		it("rows regrouped by an earlier import of the module keep one indent when a new import takes over", async () => {
			applyEditGlance();
			applyToolPartsIndent();
			const rows = [shellRow("1\n2\n3"), writeRow("a\nb\nc", "EEXIST: nope"), codexToolRow(), editDiffRow(), editFailRow(), bangRow("true", "alpha\nbeta\n")];
			const first = rows.map((row) => row.render(80));
			expect(first.map((lines) => lines.map(clean).filter((line: string) => line.includes("└")).length)).toEqual([1, 1, 1, 1, 1, 1]);

			// What /reload does: shut the session down, import the module again, call the new factory.
			vi.resetModules();
			const reloaded = await import("./rbf-tool-parts-indent.ts");
			expect(reloaded.IndentedParts).not.toBe(IndentedParts);
			restoreToolPartsIndent();
			reloaded.applyToolPartsIndent();
			try {
				expect(rows.map((row) => row.render(80))).toEqual(first);
				// The pieces in place are still the first import's: recognized by their mark, not by their class.
				const piece = rows[0].contentBox.children[1].child;
				expect(piece).toBeInstanceOf(IndentedParts);
				expect(piece).not.toBeInstanceOf(reloaded.IndentedParts);
			} finally {
				reloaded.restoreToolPartsIndent();
			}
		});
	});

	describe("Unchanged things", () => {
		it("a skill row draws the same strings with and without the extension", () => {
			const skillRaw = new SkillInvocationMessageComponent({ name: "cmux", content: "custom description" } as any);
			const rawLines = skillRaw.render(80);

			applyToolPartsIndent();
			const skillInd = new SkillInvocationMessageComponent({ name: "cmux", content: "custom description" } as any);
			const indLines = skillInd.render(80);

			expect(indLines).toEqual(rawLines);
		});

		it("every header's drawn string is the same with and without it, escape sequences included, apart from the edit row's one-column margin", () => {
			applyToolPartsIndent();
			const shapes: [string, string, () => any][] = [
				["shell row", " $ ls", () => shellRow("out")],
				["write row", " write src/a.txt", () => writeRow("a\nb")],
				["codex_tool row", " node_repl.js", () => codexToolRow()],
				["! row", " $ true", () => bangRow("true", "alpha\n")],
			];
			for (const [name, header, build] of shapes) {
				const indented: string[] = build().render(80);
				const plain = drawnWithout(build);
				const at = plain.findIndex((row) => clean(row) === header);
				expect(at, name).toBeGreaterThan(0);
				// The header and every row above it. The row under it is where the two part ways.
				expect(indented.slice(0, at + 1), name).toEqual(plain.slice(0, at + 1));
				expect(clean(indented[at + 1]!), name).toMatch(/^ └ {2}\S/);
				expect(clean(plain[at + 1]!), name).not.toContain("└");
			}

			// The edit row's header gains one column on its left and wraps one column earlier, and nothing else.
			applyEditGlance();
			const indented: string[] = editDiffRow().render(80);
			const plain = drawnWithout(editDiffRow, 79);
			expect(clean(plain[1]!)).toBe("edit src/a.ts");
			expect(indented[1]).toBe(` ${plain[1]}`);
		});

		it("a row's result and arguments are deep-equal before and after it is drawn", () => {
			applyToolPartsIndent();
			const args = { command: "git status", flags: ["-s"] };
			const result = makeResult("M file.txt", false, { code: 0 });
			const comp = toolRow("bash", args, createBashToolDef("M file.txt"), (row) => {
				row.result = result;
			});

			const argsBefore = JSON.parse(JSON.stringify((comp as any).args));
			const resBefore = JSON.parse(JSON.stringify((comp as any).result));

			comp.render(80);

			expect((comp as any).args).toEqual(argsBefore);
			expect((comp as any).result).toEqual(resBefore);
		});
	});

	describe("Colour", () => {
		it("the branch prefix equals the theme's dim colour applied to └, on a padded row, an edit row, and a ! row", () => {
			applyToolPartsIndent();
			applyEditGlance();
			const theme = getActiveTheme();
			const dim: string = theme.fg("dim", "└");
			// The theme colours, and dim is its own colour, so a branch in another one can't pass.
			expect(dim).not.toBe("└");
			expect(dim).not.toBe(theme.fg("muted", "└"));
			const branchRow = (comp: any): string => comp.render(80).find((line: string) => line.includes("└"))!;

			// 1. Padded row: the box's one padding column, the branch, two spaces.
			expect(branchRow(shellRow("out"))).toContain(` ${dim}  `);

			// 2. Edit row. A failed edit has no summary, so this └ is the one the indent adds, not rbf-edit-glance's.
			const editBranch = branchRow(editFailRow());
			expect(clean(editBranch)).toBe(" └  Could not find the exact text in src/a.ts");
			expect(editBranch.startsWith(` ${dim}  `)).toBe(true);

			// 3. ! row
			const bangBranch = branchRow(bangRow("false", "", 1));
			expect(clean(bangBranch)).toBe(" └  (exit 1)");
			expect(bangBranch.startsWith(` ${dim}  `)).toBe(true);
		});
	});

	describe("Drawn rows are kept", () => {
		const fixed = (rows: string[]) => {
			const child = { rows, draws: 0, render: () => (child.draws++, child.rows.slice()) };
			return child;
		};

		it("a draw with the same width, the same part before, and the same child rows returns the last output", () => {
			const child = fixed(["one", "two"]);
			const parts = new IndentedParts([child as any], 3, "└  ", "   ");
			const first = parts.render(40);
			expect(first).toEqual(["└  one", "   two"]);
			// The child is asked again and returns equal rows in a new array. The output is the same array, not a rebuilt one.
			expect(parts.render(40)).toBe(first);
			expect(child.draws).toBe(2);
		});

		it("a changed width is drawn again, and measured again", () => {
			// Draws 40 columns whatever it is given: 43 with the prefix, which fits 50 and not 41.
			const parts = new IndentedParts([fixed(["x".repeat(40)]) as any], 3, "└  ", "   ");
			expect(parts.render(50)).toEqual([`└  ${"x".repeat(40)}`]);
			expect(parts.render(41)).toEqual(["x".repeat(40)]);
			expect(parts.render(50)).toEqual([`└  ${"x".repeat(40)}`]);
		});

		it("a change in whether the part before drew a line is drawn again", () => {
			const before = { drawn: false, drew: () => before.drawn };
			const parts = new IndentedParts([fixed(["", "one"]) as any], 3, "└  ", "   ", before);
			expect(parts.render(40)).toEqual(["└  one"]);
			before.drawn = true;
			expect(parts.render(40)).toEqual(["   ", "   one"]);
			before.drawn = false;
			expect(parts.render(40)).toEqual(["└  one"]);
		});

		it("a changed child row is drawn again, and measured again", () => {
			const child = fixed(["one", "two"]);
			const parts = new IndentedParts([child as any], 3, "└  ", "   ");
			expect(parts.render(40)).toEqual(["└  one", "   two"]);
			child.rows = ["one", "2"];
			expect(parts.render(40)).toEqual(["└  one", "   2"]);
			// Same count, and one row now too wide for the indented width: the part falls back.
			child.rows = ["one", "x".repeat(40)];
			expect(parts.render(40)).toEqual(["one", "x".repeat(40)]);
		});

		it("a child that reuses one array and changes it in place is drawn again", () => {
			const child = { rows: ["one", "two"], render: () => child.rows };
			const parts = new IndentedParts([child as any], 3, "└  ", "   ");
			expect(parts.render(40)).toEqual(["└  one", "   two"]);
			child.rows[1] = "2";
			expect(parts.render(40)).toEqual(["└  one", "   2"]);
		});

		it("two rows, one that fits and one that is too wide, take the overflow path together", () => {
			const child = fixed(["one", "two"]);
			const parts = new IndentedParts([child as any], 3, "└  ", "   ");
			expect(parts.render(40)).toEqual(["└  one", "   two"]);
			// "one" fits. The new last row does not fit 37 columns, so the whole part is drawn with no prefix.
			child.rows = ["one", "x".repeat(38)];
			expect(parts.render(40)).toEqual(["one", "x".repeat(38)]);
			// Once the wide row is gone the part is indented again.
			child.rows = ["one", "two"];
			expect(parts.render(40)).toEqual(["└  one", "   two"]);
		});

		it("a fallback output is never reused: full-width rows that change while the narrowed rows do not are drawn again", () => {
			// Narrowed, it returns one row that overflows. At the full width it returns whatever `wide` holds.
			const child = { wide: "first", render: (w: number) => (w < 50 ? ["x".repeat(48)] : [child.wide]) };
			const parts = new IndentedParts([child as any], 3, "└  ", "   ");
			expect(parts.render(50)).toEqual(["first"]);
			child.wide = "second";
			expect(parts.render(50)).toEqual(["second"]);
		});

		it("a changed row count is drawn again", () => {
			const child = fixed(["one", "two"]);
			const parts = new IndentedParts([child as any], 3, "└  ", "   ");
			expect(parts.render(40)).toEqual(["└  one", "   two"]);
			child.rows = ["one", "two", "three"];
			expect(parts.render(40)).toEqual(["└  one", "   two", "   three"]);
			child.rows = ["one"];
			expect(parts.render(40)).toEqual(["└  one"]);
		});

		it("invalidate clears the kept rows", () => {
			const parts = new IndentedParts([fixed(["one"]) as any], 3, "└  ", "   ");
			const first = parts.render(40);
			parts.invalidate();
			const second = parts.render(40);
			expect(second).toEqual(first);
			expect(second).not.toBe(first);
		});

		it("a write row's split sets its own two texts only when the source string changed, and never changes Pi's text", () => {
			const source = new Text("write a.txt\n\none\ntwo", 0, 0);
			const split = new SplitText(source, "└  ", "   ") as any;
			const sets: string[] = [];
			for (const text of [split.header, split.content, source]) {
				const setText = text.setText.bind(text);
				text.setText = (value: string) => {
					sets.push(text === source ? "pi" : text === split.header ? "header" : "content");
					setText(value);
				};
			}
			const parts = split.indentedParts;

			const first = split.render(40).map(clean);
			expect(first).toEqual(["write a.txt", "└  one", "   two"]);
			expect(split.render(40).map(clean)).toEqual(first);
			expect(split.render(40).map(clean)).toEqual(first);
			expect(sets).toEqual(["header", "content"]);
			expect(split.indentedParts).toBe(parts);

			// Pi sets a new string on its reused text: the next draw shows it.
			source.setText("write a.txt\n\none\ntwo\nthree");
			expect(split.render(40).map(clean)).toEqual(["write a.txt", "└  one", "   two", "   three"]);
			expect(sets).toEqual(["header", "content", "pi", "header", "content"]);
			expect(split.indentedParts).toBe(parts);
			expect((source as any).text).toBe("write a.txt\n\none\ntwo\nthree");
		});
	});

	describe("Cost", () => {
		// Retried because this is a timing check: on a loaded machine one case's mean can swing by more than the budget.
		// A real cost fails every try: without the row reuse, or without the plain-row width, at least one case reads 12 ms or more.
		it("drawing 1,000 lines 100 times after 10 warm-up draws costs a mean of under 2 ms more per draw than without the indent", { retry: 2, timeout: 240000 }, async () => {
			// Scenario 17: with PI_TUI_DIST set, every box and plain text of a measured row is that package's, Pi 1.0.2's.
			// The row is still Pi 0.85.1's, built and regrouped as usual: a host box stands in its place and shows its children.
			const hostPath = process.env.PI_TUI_DIST;
			const host: { Box: any; Text: any } | undefined = hostPath ? await import(/* @vite-ignore */ hostPath) : undefined;
			const hosted = (part: any): any => {
				if (!host || !part || typeof part !== "object") return part;
				const own: any = part; // read past the fields pi-tui declares private
				if (part instanceof Text && part.render === Text.prototype.render) return new host.Text(own.text, own.paddingX, own.paddingY, own.customBgFn);
				if (Array.isArray(own.children)) own.children = own.children.map(hosted);
				if (own.child) own.child = hosted(own.child);
				if (own.indentedParts) hosted(own.indentedParts);
				if (part.constructor !== Box) return part;
				// Pi rebuilds a row into its own box, so the host box reads that box's children each time it draws.
				return Object.defineProperty(new host.Box(own.paddingX, own.paddingY, own.bgFn), "children", { get: () => own.children });
			};

			const lines = Array.from({ length: 1000 }, (_, i) => `export const x${i} = ${i};`);
			const content = lines.join("\n");
			/** A row to measure, and what changes it before each draw, if anything does. */
			type Shape = { row: any; tick?: () => void };
			const shapes: Record<string, () => Shape> = {
				"shell row, 1,000 lines expanded": () => ({ row: shellRow(content, true, "big") }),
				"write row, 1,000 lines expanded": () => ({ row: writeRow(content, undefined, true, "src/a.ts") }),
				"! row, 1,000 lines expanded": () => {
					const row = bangRow("big", `${content}\n`);
					row.setExpanded(true);
					return { row };
				},
				"200 collapsed shell rows": () => {
					const transcript = new Container();
					for (let n = 0; n < 200; n++) {
						transcript.addChild(
							toolRow("bash", { command: `seq ${n} ${n + 12}` }, createBashToolDefinition("/cwd"), (row) => {
								row.executionStarted = true;
								row.isPartial = false;
								row.result = makeResult(Array.from({ length: 12 }, (_, i) => `row ${n} line ${i}`).join("\n"));
							}),
						);
					}
					return { row: transcript };
				},
				"running ! row, 1,000 lines expanded, its spinner moving on every draw": () => {
					const row = bangRow("big", `${content}\n`, "running");
					row.setExpanded(true);
					const loader = row.loader;
					loader.stop(); // the test moves the spinner itself, one frame per draw
					return {
						row,
						tick: () => {
							loader.currentFrame = (loader.currentFrame + 1) % loader.frames.length;
							loader.updateDisplay();
						},
					};
				},
				"shell row, 1,000 lines expanded, gaining a line on every draw": () => {
					const row = shellRow(content, true, "big");
					const output = [...lines];
					return {
						row,
						tick: () => {
							output.push(`export const added${output.length} = ${output.length};`);
							row.updateResult(makeResult(output.join("\n")), true);
							hosted(row.contentBox);
						},
					};
				},
				// Longer than half the pane and not plain, so pi-tui has to measure every row: only reusing the output keeps this cheap.
				"shell row, 1,000 long non-ASCII lines expanded": () => ({ row: shellRow(Array.from({ length: 1000 }, (_, i) => `✓ ${"passes ".repeat(8)}${i}`).join("\n"), true, "big") }),
			};
			/** Ten draws of a row, each after whatever changes it, and how long they took. */
			const tenDraws = ({ row, tick }: Shape): number => {
				const start = performance.now();
				for (let i = 0; i < 10; i++) {
					tick?.();
					row.render(100);
				}
				return performance.now() - start;
			};

			const deltas: Record<string, number> = {};
			for (const [name, build] of Object.entries(shapes)) {
				restoreToolPartsIndent();
				const plain = build();
				const flush: string[] = plain.row.render(100);
				hosted(plain.row);

				applyToolPartsIndent();
				const shape = build();
				// The first draw regroups the row. What is measured is real rows: coloured, and indented.
				const drawn: string[] = shape.row.render(100);
				expect(drawn.filter((line) => /^ {4}\S/.test(clean(line)) && line.includes("\x1b[38;")).length, name).toBeGreaterThanOrEqual(999);
				expect(drawn.some((line) => clean(line).startsWith(" └  ")), name).toBe(true);
				hosted(shape.row);

				// 10 warm-up draws and 100 measured ones for each row. The two take turns ten draws at a time, so a slow
				// moment on the machine lands on both and not on one.
				let base = 0;
				let indented = 0;
				for (let turn = 0; turn <= 10; turn++) {
					restoreToolPartsIndent();
					const plainTime = tenDraws(plain);
					applyToolPartsIndent();
					const indentedTime = tenDraws(shape);
					if (turn > 0) {
						base += plainTime / 100;
						indented += indentedTime / 100;
					}
				}
				restoreToolPartsIndent();
				plain.tick?.();
				const grown = plain.row.render(100).length - flush.length;
				applyToolPartsIndent();
				if (shape.tick) {
					// The row really changes from one draw to the next, and the same way on both sides.
					const last: string[] = shape.row.render(100);
					shape.tick();
					const after: string[] = shape.row.render(100);
					expect(after, name).not.toEqual(last);
					expect(after.length - drawn.length, name).toBe(grown);
					expect(after.some((line) => clean(line).startsWith(" └  ")), name).toBe(true);
				}

				deltas[name] = indented - base;
				console.log(`cost [${host ? "PI_TUI_DIST" : "Pi 0.85.1"}] ${name}: base=${base.toFixed(3)}ms indented=${indented.toFixed(3)}ms delta=${deltas[name]!.toFixed(3)}ms`);
			}
			for (const [name, delta] of Object.entries(deltas)) expect(delta, name).toBeLessThan(2.0);
		});
	});
});
