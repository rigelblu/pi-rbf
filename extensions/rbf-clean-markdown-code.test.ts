import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMarkdownTheme, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { getCapabilities, Markdown, setCapabilities, Text, type MarkdownTheme } from "@earendil-works/pi-tui";
import rbfCleanMarkdownCode, {
	applyCleanMarkdownCode,
	cleanReadOutputText,
	highlightConfigSections,
	MARKDOWN_CLEAN_CODE_PATCHED_KEY,
	patchMarkdownRenderToken,
	patchToolExecutionRead,
	restoreCleanMarkdownCode,
	restoreMarkdownRenderToken,
	restoreToolExecutionRead,
	TOOL_EXECUTION_READ_PATCHED_KEY,
} from "./rbf-clean-markdown-code.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

describe("rbf-clean-markdown-code string cleaning helpers", () => {
	it("cleanReadOutputText strips leading newlines", () => {
		const raw = '\n  {\n    "name": "pi-rbf"\n  }';
		expect(cleanReadOutputText(raw)).toBe('  {\n    "name": "pi-rbf"\n  }');

		const multipleNewlines = '\n\n\n  {\n    "name": "pi-rbf"\n  }';
		expect(cleanReadOutputText(multipleNewlines)).toBe('  {\n    "name": "pi-rbf"\n  }');
	});

	it("cleanReadOutputText strips surrounding markdown code fences if present", () => {
		const fenced = '```json\n{\n  "name": "pi-rbf"\n}\n```';
		expect(cleanReadOutputText(fenced)).toBe('{\n  "name": "pi-rbf"\n}');

		const fencedWithLeadingNewlines = '\n```typescript\nconst x = 42;\n```';
		expect(cleanReadOutputText(fencedWithLeadingNewlines)).toBe("const x = 42;");
	});

	it("cleanReadOutputText leaves normal text unchanged", () => {
		const normal = 'line 1\nline 2';
		expect(cleanReadOutputText(normal)).toBe(normal);
		expect(cleanReadOutputText("")).toBe("");
	});
});

describe("rbf-clean-markdown-code highlightConfigSections", () => {
	beforeEach(() => {
		initTheme("rose-pine-dawn");
	});

	it("highlights section headers like [repo] and [project] in iris purple", () => {
		const input = "[repo]\nproduct = \"@pi\"\n\n[project]";
		const highlighted = highlightConfigSections(input);

		// [repo] must have iris purple ANSI escape sequence (\x1b[38;2;144;122;169m)
		expect(highlighted).toContain("\x1b[38;2;144;122;169m[repo]\x1b[39m");
		expect(highlighted).toContain("\x1b[38;2;144;122;169m[project]\x1b[39m");
	});

	it("highlights section headers with trailing comments", () => {
		const input = "[repo] # repo settings";
		const highlighted = highlightConfigSections(input);

		expect(highlighted).toContain("\x1b[38;2;144;122;169m[repo]\x1b[39m");
		expect(highlighted).toContain("\x1b[38;2;40;105;131m # repo settings\x1b[39m");
	});

	it("highlights unhighlighted key-value pairs with foam keys and love strings", () => {
		const input = "product = \"@pi\"";
		const highlighted = highlightConfigSections(input);

		// product should be foam teal (\x1b[38;2;86;148;159m)
		expect(highlighted).toContain("\x1b[38;2;86;148;159mproduct\x1b[39m");
		// "@pi" should be love pink (\x1b[38;2;171;82;108m)
		expect(highlighted).toContain("\x1b[38;2;171;82;108m\"@pi\"\x1b[39m");
	});

	it("is idempotent when applied to already highlighted text", () => {
		const input = "[repo]\nproduct = \"@pi\"";
		const firstPass = highlightConfigSections(input);
		const secondPass = highlightConfigSections(firstPass);

		expect(secondPass).toBe(firstPass);
	});
});

describe("rbf-clean-markdown-code Markdown.prototype.renderToken patching", () => {
	const piThemeKey = Symbol.for("@earendil-works/pi-coding-agent:theme");
	const mockTheme: MarkdownTheme = {
		heading: (s: string) => s,
		link: (s: string) => s,
		linkUrl: (s: string) => s,
		code: (s: string) => s,
		codeBlock: (s: string) => s,
		codeBlockBorder: (s: string) => s,
		quote: (s: string) => s,
		quoteBorder: (s: string) => s,
		hr: (s: string) => s,
		listBullet: (s: string) => s,
		bold: (s: string) => s,
		italic: (s: string) => s,
		strikethrough: (s: string) => s,
		underline: (s: string) => s,
		codeBlockIndent: "  ",
	};

	beforeEach(() => {
		initTheme();
		restoreMarkdownRenderToken();
	});

	afterEach(() => {
		restoreMarkdownRenderToken();
	});

	it("omits markdown code fences from code blocks while keeping indented content", () => {
		patchMarkdownRenderToken();

		const markdownText = '```json\n{\n  "name": "pi-rbf"\n}\n```';
		const md = new Markdown(markdownText, 0, 0, mockTheme);
		const rendered = md.render(80);
		const plain = stripAnsi(rendered.join("\n"));

		// Must NOT contain ```json or ```
		expect(plain).not.toContain("```json");
		expect(plain).not.toContain("```");

		// Must contain code content indented
		expect(plain).toContain('"name": "pi-rbf"');
		expect(plain).toContain("  {");
		expect(plain).toContain("  }");
	});

	it.each([
		["truecolor", true, "\x1b[38;2;"],
		["256-color", false, "\x1b[38;5;"],
	])("renders a real %s fenced assignment with Pi's MarkdownTheme", (_mode, trueColor, ansiPrefix) => {
		patchMarkdownRenderToken();

		const originalCapabilities = getCapabilities();
		try {
			setCapabilities({ ...originalCapabilities, trueColor });
			initTheme("rose-pine-dawn");
			const markdownTheme = getMarkdownTheme();
			expect("fg" in markdownTheme).toBe(false);

			const md = new Markdown('```lua\nvim.opt.foldmethod = "manual"\n```', 0, 0, markdownTheme);
			let rendered: string[] = [];
			expect(() => {
				rendered = md.render(80);
			}).not.toThrow();

			const output = rendered.join("\n");
			expect(stripAnsi(output)).toContain('  vim.opt.foldmethod = "manual"');
			expect(output).toContain(ansiPrefix);
			expect(output).not.toContain("```");
		} finally {
			setCapabilities(originalCapabilities);
			initTheme();
		}
	});

	it.each([
		["missing", undefined],
		["non-callable", { fg: undefined }],
	])("uses fixed colors when Pi's global theme is %s", (_case, replacement) => {
		patchMarkdownRenderToken();

		const originalTheme: unknown = Reflect.get(globalThis, piThemeKey);
		try {
			if (replacement === undefined) {
				Reflect.deleteProperty(globalThis, piThemeKey);
			} else {
				Reflect.set(globalThis, piThemeKey, replacement);
			}

			const md = new Markdown('```lua\nvim.opt.foldmethod = "manual"\n```', 0, 0, mockTheme);
			let rendered: string[] = [];
			expect(() => {
				rendered = md.render(80);
			}).not.toThrow();

			const output = rendered.join("\n");
			expect(output).toContain("\x1b[38;2;86;148;159mvim.opt.foldmethod\x1b[39m");
			expect(output).toContain('\x1b[38;2;171;82;108m"manual"\x1b[39m');
		} finally {
			Reflect.set(globalThis, piThemeKey, originalTheme);
		}
	});

	it.each([
		[
			"truecolor",
			'\x1b[38;2;86;148;159mvim.opt.foldmethod\x1b[39m = \x1b[38;2;171;82;108m"manual"\x1b[39m',
		],
		["256-color", '\x1b[38;5;73mvim.opt.foldmethod\x1b[39m = \x1b[38;5;168m"manual"\x1b[39m'],
	])("preserves an already-highlighted %s fenced assignment", (_mode, highlightedAssignment) => {
		patchMarkdownRenderToken();

		const markdownTheme: MarkdownTheme = {
			...getMarkdownTheme(),
			codeBlockIndent: "  ",
			highlightCode: () => [highlightedAssignment],
		};
		const md = new Markdown('```lua\nvim.opt.foldmethod = "manual"\n```', 0, 0, markdownTheme);
		let rendered: string[] = [];
		expect(() => {
			rendered = md.render(80);
		}).not.toThrow();

		const output = rendered.join("\n");
		expect(output).toContain(highlightedAssignment);
		expect(stripAnsi(output)).toContain('  vim.opt.foldmethod = "manual"');
		expect(output).not.toContain("```");
	});

	it("preserves normal markdown paragraphs and headings", () => {
		patchMarkdownRenderToken();

		const markdownText = "# Title\n\nThis is a paragraph with **bold** text.";
		const md = new Markdown(markdownText, 0, 0, mockTheme);
		const rendered = md.render(80);
		const plain = stripAnsi(rendered.join("\n"));

		expect(plain).toContain("Title");
		expect(plain).toContain("This is a paragraph with bold text.");
	});

	it("patchMarkdownRenderToken is idempotent and restore restores original fences", () => {
		expect(patchMarkdownRenderToken()).toBe(true);
		expect(patchMarkdownRenderToken()).toBe(false);
		expect((Markdown.prototype as any)[MARKDOWN_CLEAN_CODE_PATCHED_KEY]).toBe(true);

		// While patched: no fences
		const mdPatched = new Markdown("```js\nconsole.log(1);\n```", 0, 0, mockTheme);
		expect(stripAnsi(mdPatched.render(80).join("\n"))).not.toContain("```");

		// Restore
		expect(restoreMarkdownRenderToken()).toBe(true);
		expect((Markdown.prototype as any)[MARKDOWN_CLEAN_CODE_PATCHED_KEY]).toBeUndefined();

		// After restore: fences are rendered again by upstream
		const mdRestored = new Markdown("```js\nconsole.log(1);\n```", 0, 0, mockTheme);
		expect(stripAnsi(mdRestored.render(80).join("\n"))).toContain("```");
	});
});

describe("rbf-clean-markdown-code ToolExecutionComponent patching", () => {
	const mockUi = { requestRender: () => {} };

	const createMockReadToolDef = (outputText: string) => {
		return {
			name: "read",
			renderShell: "default",
			renderCall: (args: any) => new Text(`read ${args?.path ?? "file.json"}`, 0, 0),
			renderResult: () => new Text(outputText, 0, 0),
		};
	};

	beforeEach(() => {
		initTheme();
		restoreToolExecutionRead();
	});

	afterEach(() => {
		restoreToolExecutionRead();
	});

	it("strips leading newline from read tool output so it sits directly below call header", () => {
		patchToolExecutionRead();

		// Upstream read renderer returns text with leading \n
		const upstreamOutput = '\n  {\n    "name": "pi-rbf"\n  }';
		const comp = new ToolExecutionComponent(
			"read",
			"call_read_1",
			{ path: "package.json" },
			{},
			createMockReadToolDef(upstreamOutput) as any,
			mockUi as any,
			"/cwd",
		);

		// Trigger result update
		comp.updateResult({
			content: [{ type: "text", text: upstreamOutput }],
			isError: false,
		});

		const resultComp = (comp as any).resultRendererComponent as any;
		expect(resultComp).toBeDefined();
		expect(resultComp.text).toBe('  {\n    "name": "pi-rbf"\n  }');
		expect(resultComp.text.startsWith("\n")).toBe(false);
	});

	it("does not modify non-read tools", () => {
		patchToolExecutionRead();

		const bashOutput = "\noutput line 1\noutput line 2";
		const bashToolDef = {
			name: "bash",
			renderShell: "default",
			renderCall: () => new Text("bash ls", 0, 0),
			renderResult: () => new Text(bashOutput, 0, 0),
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

		comp.updateResult({
			content: [{ type: "text", text: bashOutput }],
			isError: false,
		});

		const resultComp = (comp as any).resultRendererComponent as any;
		expect(resultComp.text).toBe(bashOutput);
	});

	it("patchToolExecutionRead is idempotent and restore unpatches cleanly", () => {
		expect(patchToolExecutionRead()).toBe(true);
		expect(patchToolExecutionRead()).toBe(false);
		expect((ToolExecutionComponent.prototype as any)[TOOL_EXECUTION_READ_PATCHED_KEY]).toBe(true);

		expect(restoreToolExecutionRead()).toBe(true);
		expect((ToolExecutionComponent.prototype as any)[TOOL_EXECUTION_READ_PATCHED_KEY]).toBeUndefined();
	});

	it("applyCleanMarkdownCode applies both and restoreCleanMarkdownCode restores both", () => {
		applyCleanMarkdownCode();
		expect((Markdown.prototype as any)[MARKDOWN_CLEAN_CODE_PATCHED_KEY]).toBe(true);
		expect((ToolExecutionComponent.prototype as any)[TOOL_EXECUTION_READ_PATCHED_KEY]).toBe(true);

		restoreCleanMarkdownCode();
		expect((Markdown.prototype as any)[MARKDOWN_CLEAN_CODE_PATCHED_KEY]).toBeUndefined();
		expect((ToolExecutionComponent.prototype as any)[TOOL_EXECUTION_READ_PATCHED_KEY]).toBeUndefined();
	});

	it("default export rbfCleanMarkdownCode applies patches", () => {
		rbfCleanMarkdownCode();
		expect((Markdown.prototype as any)[MARKDOWN_CLEAN_CODE_PATCHED_KEY]).toBe(true);
		expect((ToolExecutionComponent.prototype as any)[TOOL_EXECUTION_READ_PATCHED_KEY]).toBe(true);

		restoreCleanMarkdownCode();
	});

	it("source code contains no unauthorized sinks or network/child_process imports", () => {
		const sourcePath = resolve(__dirname, "rbf-clean-markdown-code.ts");
		const content = readFileSync(sourcePath, "utf-8");

		expect(content).not.toMatch(/node:child_process|child_process/);
		expect(content).not.toMatch(/node:fs/);
		expect(content).not.toMatch(/(?:from\s+['"]fs['"]|require\(['"]fs['"]\))/);
		expect(content).not.toMatch(/node:net|node:http|fetch/);
		expect(content).not.toMatch(/process\.exit/);
	});
});
