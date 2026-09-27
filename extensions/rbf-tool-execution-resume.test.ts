import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function createMockExtensionAPI() {
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	return {
		api: {
			on: (event: string, handler: (...args: any[]) => any) => {
				const existing = handlers.get(event) ?? [];
				existing.push(handler);
				handlers.set(event, existing);
			},
			registerCommand: vi.fn(),
			registerTool: vi.fn(),
			registerProvider: vi.fn(),
			exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 }),
		},
		emit: async (event: string, ...args: any[]) => {
			const list = handlers.get(event) ?? [];
			for (const h of list) {
				await h(...args);
			}
		},
		handlers,
	};
}

describe("pi-17.2: tool execution lifecycle across shutdown and fresh module loads", () => {
	const mockUi = { requestRender: vi.fn() };
	let originalUpdateDisplay: any;

	const createMockTodoToolDef = () => ({
		name: "todo",
		renderShell: "default",
		renderCall: (args: any) => new Text(`todo ${args?.action ?? "list"}`, 0, 0),
		renderResult: () => new Text("todo items", 0, 0),
	});

	const createMockReadToolDef = (outputText: string) => ({
		name: "read",
		renderShell: "default",
		renderCall: (args: any) => new Text(`read ${args?.path ?? "file.json"}`, 0, 0),
		renderResult: () => new Text(outputText, 0, 0),
	});

	const createMockEditToolDef = (diffText: string) => ({
		name: "edit",
		renderShell: "self",
		renderCall: (args: any) => {
			const box = new Box(1, 1, (t: string) => t);
			(box as any).preview = { diff: diffText };
			box.addChild(new Text(`edit ${args?.path ?? "file.ts"}`, 0, 0));
			return box;
		},
		renderResult: () => new Box(1, 1, (t: string) => t),
	});

	beforeEach(() => {
		initTheme();
		originalUpdateDisplay = (ToolExecutionComponent.prototype as any).updateDisplay;
	});

	afterEach(() => {
		(ToolExecutionComponent.prototype as any).updateDisplay = originalUpdateDisplay;
		delete (ToolExecutionComponent.prototype as any)[Symbol.for("rbf.backgroundTasks.toolExecutionPatched")];
		delete (ToolExecutionComponent.prototype as any)[Symbol.for("rbf.backgroundTasks.origToolExecutionUpdateDisplay")];
		delete (ToolExecutionComponent.prototype as any)[Symbol.for("rbf.cleanMarkdownCode.toolExecutionPatched")];
		delete (ToolExecutionComponent.prototype as any)[Symbol.for("rbf.cleanMarkdownCode.originalUpdateDisplay")];
		delete (ToolExecutionComponent.prototype as any)[Symbol.for("rbf.editGlance.patched")];
		delete (ToolExecutionComponent.prototype as any)[Symbol.for("rbf.editGlance.originalUpdateDisplay")];
		delete (ToolExecutionComponent.prototype as any)[Symbol.for("rbf.toolExecutionBlended.patched")];
		delete (ToolExecutionComponent.prototype as any)[Symbol.for("rbf.toolExecutionBlended.originalUpdateDisplay")];
	});

	it("preserves blended, read, and edit tool behavior after background-tasks shutdown and fresh module reloads", async () => {
		const diff = [" 1 context", "-2 oldLine();", "+2 newLine();", " 3 context end"].join("\n");

		// Round 1: Load in installed order: background-tasks -> clean-markdown-code -> edit-glance -> tool-execution-blended
		const bg1 = await import("./rbf-background-tasks.ts");
		const clean1 = await import("./rbf-clean-markdown-code.ts");
		const edit1 = await import("./rbf-edit-glance.ts");
		const blend1 = await import("./rbf-tool-execution-blended.ts");

		const pi1 = createMockExtensionAPI();
		bg1.default(pi1.api as any);
		clean1.default(pi1.api as any);
		edit1.default(pi1.api as any);
		blend1.default(pi1.api as any);
		await pi1.emit("session_start", {}, {});
		const firstDisplay = (ToolExecutionComponent.prototype as any).updateDisplay;

		// Verify Round 1 initial behavior
		const todo1 = new ToolExecutionComponent("todo", "c1", { action: "list" }, {}, createMockTodoToolDef() as any, mockUi as any, "/cwd");
		expect((todo1 as any).contentBox.paddingY).toBe(0);
		expect((todo1 as any).contentBox.bgFn).toBeUndefined();

		const read1 = new ToolExecutionComponent("read", "c2", { path: "f.txt" }, {}, createMockReadToolDef("```markdown\nexample\n```") as any, mockUi as any, "/cwd");
		read1.updateResult({ content: [{ type: "text", text: "```markdown\nexample\n```" }], isError: false });
		expect((read1 as any).resultRendererComponent.text).toBe("example");

		const edit1Comp = new ToolExecutionComponent("edit", "c3", { path: "f.ts" }, {}, createMockEditToolDef(diff) as any, mockUi as any, "/cwd");
		expect((edit1Comp as any).callRendererComponent.paddingY).toBe(0);
		expect(stripAnsi(edit1Comp.render(80).join("\n"))).toContain("└ Added 1 line, removed 1 line");

		// Invoke real background-tasks session shutdown
		await pi1.emit("session_shutdown", {}, {});

		// Cycle 2: Load fresh module factories
		vi.resetModules();
		const bg2 = await import("./rbf-background-tasks.ts");
		const clean2 = await import("./rbf-clean-markdown-code.ts");
		const edit2 = await import("./rbf-edit-glance.ts");
		const blend2 = await import("./rbf-tool-execution-blended.ts");

		const pi2 = createMockExtensionAPI();
		bg2.default(pi2.api as any);
		clean2.default(pi2.api as any);
		edit2.default(pi2.api as any);
		blend2.default(pi2.api as any);
		await pi2.emit("session_start", {}, {});
		expect(
			(ToolExecutionComponent.prototype as any).updateDisplay,
			"fresh modules must not add another updateDisplay layer",
		).toBe(firstDisplay);

		// Check newly constructed components in Cycle 2
		const todo2 = new ToolExecutionComponent("todo", "c4", { action: "list" }, {}, createMockTodoToolDef() as any, mockUi as any, "/cwd");
		expect((todo2 as any).contentBox.paddingY, "collapsed todo must have zero vertical padding").toBe(0);
		expect((todo2 as any).contentBox.bgFn, "collapsed todo must have transparent background").toBeUndefined();

		const read2 = new ToolExecutionComponent("read", "c5", { path: "f.txt" }, {}, createMockReadToolDef("```markdown\nexample\n```") as any, mockUi as any, "/cwd");
		read2.updateResult({ content: [{ type: "text", text: "```markdown\nexample\n```" }], isError: false });
		expect((read2 as any).resultRendererComponent.text, "read output must have surrounding markdown fences stripped").toBe("example");

		const edit2Comp = new ToolExecutionComponent("edit", "c6", { path: "f.ts" }, {}, createMockEditToolDef(diff) as any, mockUi as any, "/cwd");
		expect((edit2Comp as any).callRendererComponent.paddingY, "collapsed edit must have zero padding").toBe(0);
		expect((edit2Comp as any).callRendererComponent.bgFn, "collapsed edit must have transparent background").toBeUndefined();
		expect(stripAnsi(edit2Comp.render(80).join("\n")), "collapsed edit must show unboxed glance summary").toContain("└ Added 1 line, removed 1 line");

		// Expanded row keeps Pi's card
		edit2Comp.setExpanded(true);
		expect(stripAnsi(edit2Comp.render(80).join("\n"))).toContain("context end");

		// Cycle 3: Repeat once more to prove stability across multiple reloads
		await pi2.emit("session_shutdown", {}, {});

		vi.resetModules();
		const bg3 = await import("./rbf-background-tasks.ts");
		const clean3 = await import("./rbf-clean-markdown-code.ts");
		const edit3 = await import("./rbf-edit-glance.ts");
		const blend3 = await import("./rbf-tool-execution-blended.ts");

		const pi3 = createMockExtensionAPI();
		bg3.default(pi3.api as any);
		clean3.default(pi3.api as any);
		edit3.default(pi3.api as any);
		blend3.default(pi3.api as any);
		await pi3.emit("session_start", {}, {});
		expect(
			(ToolExecutionComponent.prototype as any).updateDisplay,
			"second reload must keep the same effective updateDisplay chain",
		).toBe(firstDisplay);

		const todo3 = new ToolExecutionComponent("todo", "c7", { action: "list" }, {}, createMockTodoToolDef() as any, mockUi as any, "/cwd");
		expect((todo3 as any).contentBox.paddingY).toBe(0);
		expect((todo3 as any).contentBox.bgFn).toBeUndefined();

		const read3 = new ToolExecutionComponent("read", "c8", { path: "f.txt" }, {}, createMockReadToolDef("```markdown\nexample\n```") as any, mockUi as any, "/cwd");
		read3.updateResult({ content: [{ type: "text", text: "```markdown\nexample\n```" }], isError: false });
		expect((read3 as any).resultRendererComponent.text).toBe("example");

		const edit3Comp = new ToolExecutionComponent("edit", "c9", { path: "f.ts" }, {}, createMockEditToolDef(diff) as any, mockUi as any, "/cwd");
		expect((edit3Comp as any).callRendererComponent.paddingY).toBe(0);
		expect(stripAnsi(edit3Comp.render(80).join("\n"))).toContain("└ Added 1 line, removed 1 line");
	});
});
