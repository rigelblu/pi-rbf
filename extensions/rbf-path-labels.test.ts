import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssistantMessageComponent, FooterComponent, getMarkdownTheme, getSelectListTheme, initTheme, InteractiveMode, TreeSelectorComponent } from "@earendil-works/pi-coding-agent";
import { Container, Editor, getCapabilities, getKeybindings, KeybindingsManager, Markdown, setCapabilities, setKeybindings, Text, visibleWidth } from "@earendil-works/pi-tui";
import pathLabels, { formatPathLabel, installPathLabels, isLocalFileReference, projectInlineReferences } from "./rbf-path-labels.ts";
import { patchMarkdownRenderToken, restoreMarkdownRenderToken } from "./rbf-clean-markdown-code.ts";
import { patchFooterComponent, setCachedStatusLine, STATUS_LINE_PATCHED_KEY, ORIGINAL_STATUS_LINE_RENDER_KEY, invalidateStatusLineCache } from "./rbf-status-line.ts";

const PATH = "~/src/rb/tom-home-branches/tom.home.main/dotfiles/rb-agents/rb-drive/projects/v0.x/03_design-feat/15_verification.md";
const ABS = "/src/rb/tom-home-branches/tom.home.main/dotfiles/rb-agents/rb-drive/projects/v0.x/03_design-feat/15_verification.md";
const capabilities = getCapabilities();
const keybindings = getKeybindings();
const disposers: (() => void)[] = [];
const plain = (text: string) => text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[\d;]*[A-Za-z]/g, "");
function message(text: string, extra: any[] = []): any {
	return { role: "assistant", content: [{ type: "text", text }, ...extra], api: "fixture", provider: "fixture", model: "pi39-fixture", stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 1 };
}
function assistant(source: string): AssistantMessageComponent {
	return new AssistantMessageComponent(message(source), false, getMarkdownTheme());
}
function enable(notify?: (surface: string) => void): void { disposers.push(installPathLabels(notify)); }
function body(component: AssistantMessageComponent): any {
	return (component as any).contentContainer.children.find((child: any) => child instanceof Markdown);
}

beforeEach(() => { initTheme("rose-pine-dawn"); setCapabilities({ ...capabilities, hyperlinks: true }); });
afterEach(() => { while (disposers.length) disposers.pop()!(); restoreMarkdownRenderToken(); setCapabilities(capabilities); setKeybindings(keybindings); });

describe("fit and identity", () => {
	it("fits actual cells and preserves whole directories and filename priority", () => {
		expect(formatPathLabel(PATH, 118)).toBe(PATH);
		expect(formatPathLabel(PATH, 78)).toBe("~/src/rb/tom-home-branches/tom.home.main/dotfiles/…/15_verification.md");
		expect(formatPathLabel(PATH, 16)).toBe("15_verificat….md");
		expect(formatPathLabel(PATH, 8)).toBe("15_v….md");
		expect(formatPathLabel(PATH, 1)).toBe("…");
		expect(formatPathLabel(PATH, 0)).toBe("");
		expect(formatPathLabel("/a/b/c/", 6)).toBe("/…/c/");
		expect(formatPathLabel("/a/b.txt", 8)).toBe("/a/b.txt");
		for (const path of [PATH, "~/资料/设计/验证.md", "~/a/e\u0301-👩‍💻.md", "~/a/a folder/spaced name.md", "abcdef", "~/dir/"]) {
			for (let width = 0; width <= 130; width++) {
				const formatted = formatPathLabel(path, width);
				expect(visibleWidth(formatted)).toBeLessThanOrEqual(width);
				expect(formatted).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
				if (visibleWidth(path) <= width) expect(formatted).toBe(path);
			}
		}
		expect(formatPathLabel("~/a/👩‍💻.md", 6)).toBe("👩‍💻.md");
	});
	it.each([80, 40, 120])("uses real assistant body/list/quote budgets at %i", (width) => {
		const sources = [`\`${PATH}\``, `- \`${PATH}\``, `> \`${PATH}\``, `- > \`${PATH}\``, `### \`${PATH}\``];
		enable();
		for (const source of sources) {
			const component = assistant(source);
			const original = JSON.stringify((component as any).lastMessage);
			const output = component.render(width);
			expect(output.every((line) => visibleWidth(line) <= width)).toBe(true);
			const content = plain(output.join("\n"));
			expect(content).toContain("15_verification.md");
			if (width < 120) expect(content).toContain("…");
			expect(JSON.stringify((component as any).lastMessage)).toBe(original);
			expect(body(component).text).toBe(source);
		}
	});
	it("allocates table columns from originals, then projects at final cell widths", () => {
		const source = `| File | State |\n| --- | --- |\n| [${PATH}](file://${ABS}) | ready |\n| \`${PATH}\` | done |`;
		const native = assistant(source).render(80);
		enable();
		const component = assistant(source);
		const md = body(component);
		const originalWrap = md.wrapCellText;
		const calls: { text: string; width: number }[] = [];
		md.wrapCellText = function (text: string, width: number, ...rest: any[]) { calls.push({ text: plain(text), width }); return originalWrap.call(this, text, width, ...rest); };
		const callback = md.wrapCellText;
		const output = component.render(80);
		expect(md.wrapCellText).toBe(callback);
		expect(plain(output.find((line) => plain(line).includes("┌"))!)).toBe(plain(native.find((line) => plain(line).includes("┌"))!));
		expect(calls.filter((cell) => cell.text.includes("15_verification.md"))).toHaveLength(2);
		for (const cell of calls.filter((cell) => cell.text.includes("15_verification.md"))) {
			expect(cell.text).toContain("…");
			expect(visibleWidth(cell.text)).toBeLessThanOrEqual(cell.width);
		}
		expect(md.text).toBe(source);
		expect(output.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});
	it("restores the temporary table seam when wrapping throws", () => {
		enable();
		const component = assistant(`| File |\n| --- |\n| \`${PATH}\` |`);
		const md = body(component);
		const fail = () => { throw new Error("fixture failure"); };
		md.wrapCellText = fail;
		expect(() => component.render(80)).toThrow("fixture failure");
		expect(md.wrapCellText).toBe(fail);
	});
});

describe("literal and target integrity", () => {
	it.each([
		[`/repo/file.ts:240:7`, `file:///repo/file.ts#L240`, true],
		[`/repo/file.ts:240:7`, `file:///repo/file.ts#L240C7`, true],
		[`/repo/file.ts:240:7`, `file:///repo/file.ts#L241`, false],
		[`/repo/file.ts:240:7`, `file:///repo/file.ts#L240C8`, false],
		[`/repo/other.ts:240:7`, `file:///repo/file.ts#L240`, false],
		[`/repo/report:2026`, `file:///repo/report%3A2026`, true],
		[`/repo/file.ts:0`, `file:///repo/file.ts`, false],
		[`/repo/file.ts:240:bad`, `file:///repo/file.ts`, false],
		[`/repo/file.ts`, `file://remote/repo/file.ts`, false],
		[`/repo/file.ts`, `https://example.com/repo/file.ts`, false],
	])("checks filename and position separately: %s → %s", (label, href, eligible) => expect(isLocalFileReference(label, href)).toBe(eligible));
	it("preserves original href bytes and handles no-OSC8 without a long fallback URL", () => {
		const href = `file://${ABS}#L240`;
		const tokens = [{ type: "link", raw: `[${PATH}](${href})`, text: PATH, href, tokens: [{ type: "text", text: PATH }] }];
		const snapshot = JSON.stringify(tokens);
		const projected = projectInlineReferences(tokens, 40, `[${PATH}](${href})`);
		expect(projected[0].href).toBe(href);
		expect(projected[0].text).toContain("…");
		expect(JSON.stringify(tokens)).toBe(snapshot);
		enable();
		const output = assistant(`[${PATH}](${href})`).render(40).join("\n");
		expect(output).toContain(href);
		setCapabilities({ ...capabilities, hyperlinks: false });
		const plainOutput = plain(assistant(`[${PATH}](${href})`).render(40).join("\n"));
		expect(plainOutput).toContain("…");
		expect(plainOutput).not.toContain("file:");
		expect(plainOutput).not.toContain("(");
	});
	it.each([`Run ${ABS}`, `Run \`${ABS}\``, `\`cat ${ABS}\``, `\`\`\`sh\ncat ${ABS}\n\`\`\``, `    cat ${ABS}`, `- Run this command:\n\n  \`${ABS}\``])("delegates literal instructions: %s", (source) => {
		const native = assistant(source).render(80);
		enable();
		expect(assistant(source).render(80)).toEqual(native);
	});
	it("does not change unrelated Markdown instances or thinking", () => {
		const literal = new Markdown(`\`${PATH}\``, 1, 0, getMarkdownTheme());
		const before = literal.render(40);
		const component = new AssistantMessageComponent(message("No references.", [{ type: "thinking", thinking: `\`${PATH}\`` }]));
		const native = component.render(40);
		enable();
		literal.invalidate(); component.invalidate();
		expect(literal.render(40)).toEqual(before);
		expect(component.render(40)).toEqual(native);
	});
	it("copies an older stored response through the real tree selector without navigating", () => {
		setKeybindings(new KeybindingsManager({ "app.message.copy": { defaultKeys: "ctrl+x", description: "Copy message" } }));
		const older = { id: "old", parentId: null, type: "message", timestamp: "2026-10-04T00:00:00Z", message: message(`\`${PATH}\``) };
		const newer = { id: "new", parentId: "old", type: "message", timestamp: "2026-10-04T00:00:01Z", message: message("Latest response") };
		const selected: string[] = []; const copied: (string | undefined)[] = [];
		enable(); assistant(older.message.content[0].text).render(40);
		const tree = new TreeSelectorComponent([{ entry: older, children: [{ entry: newer, children: [] }] }] as any, "new", 24, (id) => selected.push(id), () => {}, undefined, "old", "all");
		tree.onCopy = (text) => copied.push(text);
		tree.handleInput("\x18");
		expect(copied).toEqual([`\`${PATH}\``]);
		expect(selected).toEqual([]);
		expect((tree.getTreeList() as any).currentLeafId).toBe("new");
	});
});

describe("resize and lifecycle", () => {
	it("recomputes 80→40→120→160 from original content and delegates incomplete streams", () => {
		enable();
		const component = assistant(`\`${PATH}\``);
		for (const width of [80, 40, 120, 160]) {
			const rendered = plain(component.render(width).join("\n"));
			expect(rendered).toContain(width >= 120 ? PATH : formatPathLabel(PATH, width - 2));
		}
		for (const source of [`See \`${PATH}`, `See \`\`${PATH}`, `See \`\`\`${PATH}`, `See [${PATH}](`]) {
			expect(plain(assistant(source).render(40).join("\n"))).not.toContain("…");
		}
	});
	it("replaces its owner on reload and leaves later wrappers intact on teardown", () => {
		const proto = AssistantMessageComponent.prototype as any;
		const baseline = proto.render;
		enable();
		const first = assistant(`\`${PATH}\``).render(40);
		enable();
		expect(assistant(`\`${PATH}\``).render(40)).toEqual(first);
		const owned = proto.render;
		const later = function (this: any, width: number) { return owned.call(this, width); };
		proto.render = later;
		while (disposers.length) disposers.pop()!();
		expect(proto.render).toBe(later);
		expect(plain(assistant(`\`${PATH}\``).render(40).join("\n"))).not.toContain("…");
		proto.render = baseline;
	});
	it("keeps public transformation assistant-only and disables every seam outside TUI", () => {
		const handlers: any = {}; let transform: any;
		pathLabels({ registerMarkdownTransformer: (fn: any) => transform = fn, on: (event: string, fn: any) => handlers[event] = fn } as any);
		const source = `\`${PATH}\``;
		handlers.session_start({}, { hasUI: false });
		expect(transform(source, { messageType: "assistant", availableWidth: 40 })).toBe(source);
		handlers.session_start({}, { hasUI: true, ui: { notify: () => {} } });
		for (const messageType of ["user", "assistant-thinking", "tool-result"]) expect(transform(source, { messageType, availableWidth: 40 })).toBe(source);
		expect(transform(source, { messageType: "assistant", availableWidth: 40 })).toBe(source);
		expect(plain(assistant(source).render(40).join("\n"))).toContain("…");
		handlers.session_shutdown();
		expect(transform(source, { messageType: "assistant", availableWidth: 40 })).toBe(source);
	});
});

describe("structured label surfaces", () => {
	it("delegates a changed session File row with one diagnostic", () => {
		const proto = InteractiveMode.prototype as any;
		const original = proto.handleSessionCommand;
		proto.handleSessionCommand = function () { this.chatContainer.addChild(new Text(`Session File: ${ABS}`)); };
		const warnings: string[] = [];
		try {
			enable((surface) => warnings.push(surface));
			const context = { session: { getSessionStats: () => ({ sessionFile: ABS }) }, chatContainer: new Container() };
			proto.handleSessionCommand.call(context);
			const row = context.chatContainer.children[0];
			expect(row.render(40)).toEqual(new Text(`Session File: ${ABS}`).render(40));
			row.render(80);
			expect(warnings).toEqual(["session layout"]);
		} finally { while (disposers.length) disposers.pop()!(); proto.handleSessionCommand = original; }
	});
	it("delegates a missing autocomplete item renderer with one diagnostic", () => {
		const proto = Editor.prototype as any;
		const original = proto.createAutocompleteList;
		const list = { truncatePrimary: () => "", renderItem: undefined, render: () => ["Native completion"] };
		proto.createAutocompleteList = () => list;
		const warnings: string[] = [];
		try {
			enable((surface) => warnings.push(surface));
			const editor = Object.create(Editor.prototype);
			expect(editor.createAutocompleteList("@file", []).render(80)).toEqual(["Native completion"]);
			editor.createAutocompleteList("@file", []);
			expect(warnings).toEqual(["autocomplete layout"]);
		} finally { while (disposers.length) disposers.pop()!(); proto.createAutocompleteList = original; }
	});
	it("keeps native footer metadata/stats and original cwd while shortening only its path", () => {
		const manager = { getEntries: () => [], getEntryCount: () => 0, getSessionId: () => "fixture", getLeafId: () => null, getCwd: () => ABS.slice(0, -19), getSessionName: () => "design" };
		const session = { state: {}, sessionManager: manager, getContextUsage: () => undefined };
		const data = { getGitBranch: () => "main", getAvailableProviderCount: () => 1, getExtensionStatuses: () => new Map() };
		const footer = new FooterComponent(session as any, data as any);
		const native = footer.render(80);
		enable();
		const output = footer.render(80);
		expect(plain(output[0])).toContain("…");
		expect(plain(output[0])).toContain(" (main) • design");
		expect(output.slice(1)).toEqual(native.slice(1));
		expect(manager.getCwd()).toBe(ABS.slice(0, -19));
		expect(output.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});
	it("projects only the real /session File row and retains the original stats", () => {
		enable();
		const stats = { sessionFile: ABS, sessionId: "session", totalMessages: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
		const context = { session: { getSessionStats: () => stats, modelRuntime: {} }, settingsManager: { getCacheWarmingMode: () => "off" }, sessionManager: { getSessionName: () => "fixture", getEntries: () => [] }, chatContainer: new Container(), ui: { requestRender: () => {} } };
		(InteractiveMode.prototype as any).handleSessionCommand.call(context);
		const text = (context.chatContainer.children.find((c) => c instanceof Text) as any);
		const output = plain(text.render(80).join("\n"));
		const original = text.text;
		expect(output).toContain(`File: ${formatPathLabel(ABS, 72)}`);
		expect(output).toContain("ID: session");
		expect(text.text).toBe(original);
		text.invalidate();
		expect(plain(text.render(40).join("\n"))).toContain(`File: ${formatPathLabel(ABS, 32)}`);
		expect(text.text).toBe(original);
		expect(stats.sessionFile).toBe(ABS);
	});
	it("preserves selection and insertion values on a real editor autocomplete list", () => {
		enable();
		const editor: any = Object.create(Editor.prototype);
		editor.theme = { selectList: getSelectListTheme() }; editor.autocompleteMaxVisible = 5;
		const items = [{ value: `@${ABS}`, label: "15_verification.md", description: ABS }];
		const original = JSON.stringify(items);
		const list = editor.createAutocompleteList("@15", items);
		const output = plain(list.render(80).join("\n"));
		expect(output).toContain("15_verification.md");
		expect(output).toContain("…");
		const selected: string[] = [];
		list.onSelect = (item: any) => selected.push(item.value);
		list.handleInput("\r");
		expect(selected).toEqual([`@${ABS}`]);
		expect(JSON.stringify(items)).toBe(original);
	});
});

describe("native parsing and coexistence", () => {
	it.each([true, false])("preserves the actual basename footer in both load orders, status first=%s", (statusFirst) => {
		const proto = FooterComponent.prototype as any;
		const original = proto.render;
		const manager = { getEntries: () => [], getEntryCount: () => 0, getSessionId: () => "fixture", getLeafId: () => null, getCwd: () => ABS, getSessionName: () => "design" };
		const session = { state: {}, sessionManager: manager, getContextUsage: () => undefined };
		const data = { getGitBranch: () => "main", getAvailableProviderCount: () => 1, getExtensionStatuses: () => new Map() };
		const footer = new FooterComponent(session as any, data as any);
		const stats = footer.render(80).slice(1);
		const warnings: string[] = [];
		try {
			if (statusFirst) patchFooterComponent();
			enable((surface) => warnings.push(surface));
			if (!statusFirst) patchFooterComponent();
			setCachedStatusLine({ cwd: ABS, sessionName: "design", line: "📁 work • design", timestamp: Date.now() });
			const output = footer.render(80);
			expect(plain(output[0])).toContain("📁 work • design");
			expect(output.slice(1)).toEqual(stats);
			expect(warnings).toEqual([]);
		} finally {
			while (disposers.length) disposers.pop()!();
			proto.render = original;
			delete proto[STATUS_LINE_PATCHED_KEY]; delete proto[ORIGINAL_STATUS_LINE_RENDER_KEY];
			invalidateStatusLineCache();
		}
	});
	it.each(["spaced filename long.md", "重要資料設計検証資料.md", "ㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎ.md", "ーーーーーーーー.md"])("keeps the complete filename on one line amid prose: %s", (filename) => {
		enable();
		const path = `/repo/very/deep/directory/${filename}`;
		for (const source of [`See \`${path}\``, `See [${path}](file:///repo/very/deep/directory/${encodeURIComponent(filename)})`]) {
			const lines = assistant(source).render(40).map(plain);
			expect(lines.some((line) => line.includes(filename))).toBe(true);
			expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
		}
	});
	it.each([
		`See \`${ABS} /other/very/deep/directory/other.ts\``,
		"See `src/very/deep/filename.ts test/very/deep/other.ts`",
		`See \`${ABS.replace(/15_verification.md$/, "*.ts")}\``,
		`See \`${ABS} && echo done\``,
		`Try \`${ABS}\``,
		`Run this command:\n\n\`${ABS}\``,
		`Run this command.\n\n\`${ABS}\``,
		`Run this command:\n\n\`${ABS}\`\n\n\`${ABS}\``,
		`> Run this command:\n>\n> \`${ABS}\``,
		`\`\`\`sh\necho first\n\`\`\`not-closing\n\n\`${ABS}\`\n\n\`\`\``,
		`<pre>\n\n\`${ABS}\`\n\n</pre>`,
	])("keeps ambiguous/literal native source exact: %s", (source) => {
		const native = assistant(source).render(40);
		enable();
		expect(assistant(source).render(40)).toEqual(native);
	});
	it("keeps repeated command operands literal after an eligible reference", () => {
		enable();
		const source = `See \`${ABS}\`.\n\nRun this command:\n\n\`${ABS}\``;
		const output = plain(assistant(source).render(160).join("\n"));
		expect(output.split(ABS)).toHaveLength(3);
		const narrow = plain(assistant(source).render(40).join("\n"));
		expect((narrow.match(/…/g) ?? [])).toHaveLength(1);
	});
	it.each([true, false])("observes clean Markdown in either install order, clean first=%s", (cleanFirst) => {
		if (cleanFirst) patchMarkdownRenderToken();
		enable();
		const component = assistant(`See \`${PATH}\`\n\n\`\`\`sh\ncat ${ABS}\n\`\`\``);
		component.render(80);
		if (!cleanFirst) patchMarkdownRenderToken();
		component.invalidate(); body(component).invalidate();
		const output = plain(component.render(80).join("\n"));
		expect(output).not.toContain("```sh");
		expect(output).toContain(formatPathLabel(PATH, 78));
		expect(body(component).text).toContain(ABS);
	});
	it("refreshes link display when terminal capability changes at unchanged width", () => {
		enable();
		const href = `file://${ABS}`;
		const component = assistant(`[${PATH}](${href})`);
		expect(component.render(40).join("\n")).toContain(href);
		setCapabilities({ ...capabilities, hyperlinks: false });
		const output = component.render(40).join("\n");
		expect(output).not.toContain(href);
		expect(plain(output)).toContain("…");
	});
	it("compares location digits without numeric rounding", () => {
		expect(isLocalFileReference("/repo/file.ts:9007199254740993", "file:///repo/file.ts#L9007199254740992")).toBe(false);
	});
	it("delegates unknown assistant ownership with one diagnostic", () => {
		const component = assistant(`\`${PATH}\``);
		body(component).setText("Custom display owner");
		const native = component.render(40);
		const nativeWide = component.render(80);
		const warnings: string[] = [];
		enable((surface) => warnings.push(surface));
		expect(component.render(40)).toEqual(native);
		expect(component.render(80)).toEqual(nativeWide);
		expect(warnings).toEqual(["assistant layout"]);
	});
	it("delegates unsupported table ownership while recognizing native narrow fallback", () => {
		const warnings: string[] = [];
		enable((surface) => warnings.push(surface));
		const component = assistant(`| File |\n| --- |\n| \`${PATH}\` |`);
		const md = body(component);
		component.render(4);
		expect(warnings).toEqual([]);
		md.renderTable = () => ["Foreign table renderer"];
		// Reacquire the changed instance seam as a real reload would.
		enable((surface) => warnings.push(surface));
		md.invalidate();
		expect(plain(component.render(80).join("\n"))).toContain("Foreign table renderer");
		md.invalidate(); component.render(80);
		expect(warnings).toEqual(["table layout"]);
	});
});
