import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import rbfToolExecutionBlended, {
	applyToolExecutionBlended,
	restoreToolExecutionBlended,
	TOOL_EXECUTION_BLENDED_KEY,
} from "./rbf-tool-execution-blended.ts";

describe("rbf-tool-execution-blended extension", () => {
	const mockUi = { requestRender: () => {} };
	const dummyToolDef = {
		renderCall: (args: any) => new Text(`read ${args?.path ?? "test.txt"}`, 0, 0),
		renderResult: (result: any, options: any) => {
			const text = options.expanded || options.isError ? (result?.content?.[0]?.text ?? "") : "";
			return new Text(text, 0, 0);
		},
	};

	beforeEach(() => {
		initTheme();
		restoreToolExecutionBlended();
	});

	afterEach(() => {
		restoreToolExecutionBlended();
	});

	it("default unpatched ToolExecutionComponent has paddingY = 1 and bgFn in collapsed mode", () => {
		const comp = new ToolExecutionComponent(
			"read",
			"call_1",
			{ path: "test.txt" },
			{},
			dummyToolDef as any,
			mockUi as any,
			"/cwd",
		);

		const contentBox = (comp as any).contentBox as any;
		expect(contentBox.paddingY).toBe(1);
		expect(contentBox.bgFn).toBeDefined();

		// Total lines: 1 top spacer + 1 top padding + 1 content line + 1 bottom padding = 4 lines
		const lines = comp.render(80);
		expect(lines.length).toBe(4);
	});

	it("applyToolExecutionBlended() sets paddingY = 0 and bgFn = undefined for non-file tools in collapsed mode", () => {
		const applied = applyToolExecutionBlended();
		expect(applied).toBe(true);

		const comp = new ToolExecutionComponent(
			"bash",
			"call_1",
			{ command: "ls" },
			{},
			dummyToolDef as any,
			mockUi as any,
			"/cwd",
		);

		const contentBox = (comp as any).contentBox as any;
		expect(contentBox.paddingY).toBe(0);
		expect(contentBox.bgFn).toBeUndefined();

		// Total lines: 1 top spacer + 1 content line = 2 lines
		const lines = comp.render(80);
		expect(lines.length).toBe(2);
		expect(lines[1]).toContain("read test.txt");
		// Unboxed transparent text contains no background ANSI color escape codes (\x1b[4...)
		expect(lines[1]).not.toMatch(/\x1b\[4\d/);
	});

	it("applyToolExecutionBlended() makes file tools (read, edit, write) transparent with paddingY = 0 in collapsed mode", () => {
		applyToolExecutionBlended();

		for (const toolName of ["read", "edit", "write"]) {
			const comp = new ToolExecutionComponent(
				toolName,
				`call_${toolName}`,
				{ path: "test.txt" },
				{},
				dummyToolDef as any,
				mockUi as any,
				"/cwd",
			);

			const contentBox = (comp as any).contentBox as any;
			expect(contentBox.paddingY).toBe(0);
			expect(contentBox.bgFn).toBeUndefined();

			// Compact 2 lines (1 spacer + 1 content line) with transparent background
			const lines = comp.render(80);
			expect(lines.length).toBe(2);
			expect(lines[1]).not.toMatch(/\x1b\[4/);
		}
	});

	it("restores standard Box styling (paddingY = 1 and bgFn) when expanded", () => {
		applyToolExecutionBlended();

		const comp = new ToolExecutionComponent(
			"read",
			"call_1",
			{ path: "test.txt" },
			{},
			dummyToolDef as any,
			mockUi as any,
			"/cwd",
		);

		comp.updateResult({
			content: [{ type: "text", text: "file content line 1\nfile content line 2" }],
			isError: false,
		});

		// Expand component
		comp.setExpanded(true);

		const contentBox = (comp as any).contentBox as any;
		expect(contentBox.paddingY).toBe(1);
		expect(contentBox.bgFn).toBeDefined();

		const lines = comp.render(80);
		// In expanded mode: top spacer + top padding + call line + 2 result lines + bottom padding = 6 lines
		expect(lines.length).toBe(6);
		// Background color ANSI sequences are present in expanded mode
		expect(lines.some((l) => /\x1b\[4\d/.test(l))).toBe(true);
	});

	it("toggles cleanly between collapsed and expanded modes for non-file tool", () => {
		applyToolExecutionBlended();

		const comp = new ToolExecutionComponent(
			"bash",
			"call_1",
			{ command: "echo ok" },
			{},
			dummyToolDef as any,
			mockUi as any,
			"/cwd",
		);
		comp.updateResult({
			content: [{ type: "text", text: "output" }],
			isError: false,
		});

		const contentBox = (comp as any).contentBox as any;

		// Initial: collapsed
		expect((comp as any).expanded).toBe(false);
		expect(contentBox.paddingY).toBe(0);
		expect(contentBox.bgFn).toBeUndefined();
		expect(comp.render(80).length).toBe(2);

		// Expand
		comp.setExpanded(true);
		expect(contentBox.paddingY).toBe(1);
		expect(contentBox.bgFn).toBeDefined();
		expect(comp.render(80).length).toBe(5); // 1 spacer + 1 top pad + 1 call + 1 result + 1 bottom pad

		// Collapse back
		comp.setExpanded(false);
		expect(contentBox.paddingY).toBe(0);
		expect(contentBox.bgFn).toBeUndefined();
		expect(comp.render(80).length).toBe(2);
	});

	it("handles fallback mode without tool definition cleanly", () => {
		applyToolExecutionBlended();

		// No toolDefinition provided -> uses contentText fallback
		const comp = new ToolExecutionComponent(
			"custom_tool",
			"call_2",
			{ foo: "bar" },
			{},
			undefined,
			mockUi as any,
			"/cwd",
		);

		const contentText = (comp as any).contentText as any;
		expect(contentText.paddingY).toBe(0);
		expect(contentText.customBgFn).toBeUndefined();

		comp.setExpanded(true);
		expect(contentText.paddingY).toBe(1);
		expect(contentText.customBgFn).toBeDefined();
	});

	it("collapsed error state renders with paddingY = 0", () => {
		applyToolExecutionBlended();

		const comp = new ToolExecutionComponent(
			"bash",
			"call_err",
			{ command: "false" },
			{},
			dummyToolDef as any,
			mockUi as any,
			"/cwd",
		);

		comp.updateResult({
			content: [{ type: "text", text: "Command failed" }],
			isError: true,
		});

		const contentBox = (comp as any).contentBox as any;
		expect(contentBox.paddingY).toBe(0);
		expect(contentBox.bgFn).toBeUndefined();
		expect(comp.render(80).length).toBe(2);
	});

	it("applyToolExecutionBlended is idempotent and does not double-wrap", () => {
		const first = applyToolExecutionBlended();
		expect(first).toBe(true);

		const second = applyToolExecutionBlended();
		expect(second).toBe(false);

		const comp = new ToolExecutionComponent(
			"read",
			"call_1",
			{ path: "test.txt" },
			{},
			dummyToolDef as any,
			mockUi as any,
			"/cwd",
		);
		expect(((comp as any).contentBox as any).paddingY).toBe(0);
	});

	it("restoreToolExecutionBlended restores unpatched behavior", () => {
		applyToolExecutionBlended();
		expect((ToolExecutionComponent.prototype as any)[TOOL_EXECUTION_BLENDED_KEY]).toBe(true);

		const restored = restoreToolExecutionBlended();
		expect(restored).toBe(true);
		expect((ToolExecutionComponent.prototype as any)[TOOL_EXECUTION_BLENDED_KEY]).toBeUndefined();

		const comp = new ToolExecutionComponent(
			"read",
			"call_1",
			{ path: "test.txt" },
			{},
			dummyToolDef as any,
			mockUi as any,
			"/cwd",
		);
		expect(((comp as any).contentBox as any).paddingY).toBe(1);
		expect(((comp as any).contentBox as any).bgFn).toBeDefined();
	});

	it("extension entrypoint rbfToolExecutionBlended applies the patch", () => {
		rbfToolExecutionBlended();

		const compBash = new ToolExecutionComponent(
			"bash",
			"call_1",
			{ command: "ls" },
			{},
			dummyToolDef as any,
			mockUi as any,
			"/cwd",
		);
		expect(((compBash as any).contentBox as any).paddingY).toBe(0);
		expect(((compBash as any).contentBox as any).bgFn).toBeUndefined();

		const compRead = new ToolExecutionComponent(
			"read",
			"call_2",
			{ path: "test.txt" },
			{},
			dummyToolDef as any,
			mockUi as any,
			"/cwd",
		);
		expect(((compRead as any).contentBox as any).paddingY).toBe(0);
		expect(((compRead as any).contentBox as any).bgFn).toBeUndefined();
	});

	it("source code contains no unauthorized sinks or network/child_process imports", () => {
		const sourcePath = resolve(__dirname, "rbf-tool-execution-blended.ts");
		const content = readFileSync(sourcePath, "utf-8");

		expect(content).not.toMatch(/node:child_process|child_process/);
		expect(content).not.toMatch(/node:fs|fs/);
		expect(content).not.toMatch(/node:net|node:http|fetch/);
		expect(content).not.toMatch(/process\.exit/);
	});
});
