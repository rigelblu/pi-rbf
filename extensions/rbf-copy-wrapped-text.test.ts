import { patchMarkdownRenderToken, restoreMarkdownRenderToken, ORIGINAL_RENDER_TOKEN_KEY as CLEAN_ORIGINAL_TOKEN } from "./rbf-clean-markdown-code.ts";
import { IndentedParts } from "./rbf-tool-parts-indent.ts";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	Box,
	Container,
	Markdown,
	ScrollView,
	Text,
	TuiAltScreen,
	TuiMainScreen,
	stripTerminalSequences,
	visibleWidth,
} from "@earendil-works/pi-tui";
import rbfCopyWrappedText, {
	COPY_WRAPPED_TEXT_PATCHED_KEY,
	ORIGINAL_TEXT_RENDER_KEY,
	ORIGINAL_MARKDOWN_RENDER_KEY,
	ORIGINAL_GET_ACTIVE_SELECTION_TEXT_KEY,
	MARKER_END,
	MARKER_REGEX,
	MARKER_START,
	applyCopyWrappedText,
	createMarker,
	getActiveInstanceNonce,
	parseMarker,
	restoreCopyWrappedText,
	scrubOwnedMarkers,
} from "./rbf-copy-wrapped-text.ts";

const command =
	'cd /Volumes/tom-ssd/src/worktrees/pi-rbf/pi-42.2 && agy --add-dir /Volumes/tom-ssd/src/worktrees/pi-rbf/pi-42.2 --model "Gemini 3.8 Flash (High)" --prompt-interactive "$(cat /Volumes/tom-ssd/src/rb/rb-shop/pi-rbf/rb-drive/agents/v0.x/pi-42.2-gemini-executor-prompt.md)"';

const identity = (x: string) => x;
const theme = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
	codeBlockIndent: "  ",
};

function mount(
	component: any,
	width = 80,
	height = 32,
	copyOnSelect = true,
	scrollTop = 0,
	ok = true,
) {
	const writes: string[] = [];
	const copies: string[] = [];
	const flashes: string[] = [];
	const terminal: any = {
		columns: width,
		rows: height,
		write: (s: string) => {
			writes.push(s);
		},
		start() {},
		stop() {},
		hideCursor() {},
		showCursor() {},
		drainInput() {},
	};
	const tui = new TuiAltScreen(terminal, false, undefined, {
		copyOnSelect,
		copySelection: async (text: string) => {
			copies.push(text);
			return ok;
		},
	});
	tui.flash = (text: string) => {
		flashes.push(text);
	};
	const scroll = new ScrollView(component, {
		follow: "none",
		primary: true,
		scrollbar: "hidden",
	});
	tui.setLayoutRoot(scroll);
	(tui as any).beforeTerminalStart();
	tui.renderNow(true);
	scroll.scrollTo(scrollTop);
	tui.renderNow(true);
	return { tui, terminal, writes, copies, flashes, scroll, component };
}

async function mouse(t: any, start: { row: number; col: number }, end: { row: number; col: number }, release = true) {
	const seq = (button: number, p: { row: number; col: number }, up = false) =>
		`\x1b[<${button};${p.col + 1};${p.row + 1}${up ? "m" : "M"}`;
	t.tui.handleTerminalInput(seq(0, start));
	t.tui.handleTerminalInput(seq(32, end));
	if (release) t.tui.handleTerminalInput(seq(0, end, true));
	await new Promise((r) => setImmediate(r));
	t.tui.renderNow();
}

function points(t: any, startNeedle: string, endNeedle: string) {
	const rows: string[] = t.tui.previousScreen.map(stripTerminalSequences);
	const first = rows.findIndex((x: string) => x.includes(startNeedle));
	let last = -1;
	for (let i = rows.length - 1; i >= 0; i--) {
		if (rows[i].includes(endNeedle)) {
			last = i;
			break;
		}
	}
	assert(first >= 0 && last >= first, JSON.stringify(rows));
	const firstLine = rows[first];
	const lastLine = rows[last];
	return [
		{ row: first, col: visibleWidth(firstLine.slice(0, firstLine.indexOf(startNeedle))) },
		{
			row: last,
			col: visibleWidth(lastLine.slice(0, lastLine.lastIndexOf(endNeedle) + endNeedle.length)) - 1,
		},
	];
}

function finish(t: any) {
	t.tui.stop({ preserveScreen: false });
	return t.writes.join("");
}

describe("rbf-copy-wrapped-text lifecycle & encoding", () => {
	beforeEach(() => {
		applyCopyWrappedText();
	});

	afterEach(() => {
		restoreCopyWrappedText();
	});

	it("creates and parses valid markers matching active nonce", () => {
		const nonce = getActiveInstanceNonce();
		expect(nonce).toBeGreaterThan(0);
		const marker = createMarker(nonce, 42);
		expect(marker.startsWith(MARKER_START)).toBe(true);
		expect(marker.endsWith(MARKER_END)).toBe(true);

		const parsed = parseMarker(marker);
		expect(parsed).not.toBeNull();
		expect(parsed?.instanceNonce).toBe(nonce);
		expect(parsed?.recordId).toBe(42);
	});

	it("scrubOwnedMarkers strips active markers but retains forged markers", () => {
		const nonce = getActiveInstanceNonce();
		const validMarker = createMarker(nonce, 1);
		const forgedMarker = createMarker(nonce + 1, 2);

		const textWithValid = `Hello${validMarker} World`;
		expect(scrubOwnedMarkers(textWithValid)).toBe("Hello World");

		const textWithForged = `Hello${forgedMarker} World`;
		expect(scrubOwnedMarkers(textWithForged)).toBe(textWithForged);
	});

	it("is idempotent on repeated apply and cleanly restores", () => {
		expect(applyCopyWrappedText()).toBe(false); // already applied
		expect((Text.prototype as any)[COPY_WRAPPED_TEXT_PATCHED_KEY]).toBe(true);

		expect(restoreCopyWrappedText()).toBe(true);
		expect((Text.prototype as any)[COPY_WRAPPED_TEXT_PATCHED_KEY]).toBeUndefined();
		expect(restoreCopyWrappedText()).toBe(false); // already restored

		// Re-apply generates fresh nonce
		const oldNonce = getActiveInstanceNonce();
		expect(oldNonce).toBe(0);
		expect(applyCopyWrappedText()).toBe(true);
		expect(getActiveInstanceNonce()).toBeGreaterThan(0);
	});
});

describe("A1: Supplied command fidelity", () => {
	beforeEach(() => {
		applyCopyWrappedText();
	});

	afterEach(() => {
		restoreCopyWrappedText();
	});

	for (const width of [64, 80, 120]) {
		it(`A1 Text command at width ${width}`, async () => {
			const t = mount(new Text(command, 0, 0), width);
			const [a, b] = points(t, "cd", 'md)"');
			await mouse(t, a, b);
			const actual = t.copies.at(-1);
			const raw = finish(t);

			expect(actual).toBe(command);
			expect(raw).not.toContain(MARKER_START);
			expect(raw).not.toContain(MARKER_END);
		});

		it(`A1 native Markdown command at width ${width}`, async () => {
			const md = new Markdown(`\`\`\`sh\n${command}\n\`\`\``, 0, 0, theme);
			const t = mount(md, width);
			const [a, b] = points(t, "cd", 'md)"');
			await mouse(t, a, b);
			const actual = t.copies.at(-1);
			const raw = finish(t);

			expect(actual).toBe(command);
			expect(raw).not.toContain(MARKER_START);
			expect(raw).not.toContain(MARKER_END);
		});
	}
});

describe("A2: Hard lines and blank lines", () => {
	beforeEach(() => {
		applyCopyWrappedText();
	});

	afterEach(() => {
		restoreCopyWrappedText();
	});

	it("A2 exact brief hard multiline", async () => {
		const exactHard = 'printf "%s" "first"\n    printf "%s" "second"';
		const t = mount(new Text(exactHard, 0, 0), 80);
		const [a, b] = points(t, "printf", '"second"');
		await mouse(t, a, b);
		const actual = t.copies.at(-1);
		finish(t);
		expect(actual).toBe(exactHard);
	});

	it("A2 exact brief Markdown hard multiline with code block indent", async () => {
		const exactHard = 'printf "%s" "first"\n    printf "%s" "second"';
		const md = new Markdown(`\`\`\`sh\n${exactHard}\n\`\`\``, 0, 0, theme);
		const t = mount(md, 80);
		const [a, b] = points(t, "printf", '"second"');
		await mouse(t, a, b);
		const actual = t.copies.at(-1);
		finish(t);
		expect(actual).toBe(exactHard);
	});

	it("A2 blank source line", async () => {
		const blankSource = "first source line\n\nlast source line";
		const t = mount(new Text(blankSource, 0, 0), 80);
		const [a, b] = points(t, "first", "last source line");
		await mouse(t, a, b);
		const actual = t.copies.at(-1);
		finish(t);
		expect(actual).toBe(blankSource);
	});

	it("A2 full-width equal hard lines", async () => {
		const fullWidth = `${"x".repeat(24)}\n${"x".repeat(24)}`;
		const t = mount(new Text(fullWidth, 0, 0), 24);
		const [a, b] = points(t, "xxx", "xxx");
		await mouse(t, a, b);
		const actual = t.copies.at(-1);
		finish(t);
		expect(actual).toBe(fullWidth);
	});
});

describe("A3: Selection variations, Unicode, elided whitespace", () => {
	beforeEach(() => {
		applyCopyWrappedText();
	});

	afterEach(() => {
		restoreCopyWrappedText();
	});

	it("A3 Unicode ANSI reverse", async () => {
		const unicode = `start 中國 e\u0301 😀 ${"longtoken".repeat(7)}  finish`;
		const t = mount(new Text(`\x1b[31m${unicode}\x1b[0m`, 0, 0), 24);
		let [a, b] = points(t, "start", "finish");
		[a, b] = [b, a]; // reverse
		await mouse(t, a, b);
		const actual = t.copies.at(-1);
		finish(t);
		expect(actual).toBe(unicode);
	});

	it("A3 exact elided whitespace", async () => {
		const elidedText = `alpha${" ".repeat(9)}beta${" ".repeat(8)}gamma end`;
		const t = mount(new Text(elidedText, 0, 0), 12);
		const [a, b] = points(t, "alpha", "end");
		await mouse(t, a, b);
		const actual = t.copies.at(-1);
		finish(t);
		expect(actual).toBe(elidedText);
	});

	it("A3 partial and reverse source span", async () => {
		const partialText = "outside BEGIN alpha beta gamma delta epsilon zeta END outside";
		const expectedSpan = "BEGIN alpha beta gamma delta epsilon zeta END";

		// Forward partial
		const t1 = mount(new Text(partialText, 0, 0), 18);
		const [a1, b1] = points(t1, "BEGIN", "END");
		await mouse(t1, a1, b1);
		expect(t1.copies.at(-1)).toBe(expectedSpan);
		finish(t1);

		// Reverse partial
		const t2 = mount(new Text(partialText, 0, 0), 18);
		const [a2, b2] = points(t2, "BEGIN", "END");
		await mouse(t2, b2, a2);
		expect(t2.copies.at(-1)).toBe(expectedSpan);
		finish(t2);
	});

	it("A3 tab normalization to 3 spaces", async () => {
		const tabText = "alpha\tbeta end";
		const t = mount(new Text(tabText, 0, 0), 12);
		const [a, b] = points(t, "alpha", "end");
		await mouse(t, a, b);
		expect(t.copies.at(-1)).toBe("alpha   beta end");
		finish(t);
	});
});

describe("A4: Runtime modes and scrolling", () => {
	beforeEach(() => {
		applyCopyWrappedText();
	});

	afterEach(() => {
		restoreCopyWrappedText();
	});

	it("A4 explicit copy (copyOnSelect = false)", async () => {
		const t = mount(new Text(command, 0, 0), 80, 32, false);
		const [a, b] = points(t, "cd", 'md)"');
		await mouse(t, a, b);
		expect(t.copies.length).toBe(0); // not yet copied
		await t.tui.copyActiveSelectionToClipboard();
		expect(t.copies.at(-1)).toBe(command);
		finish(t);
	});

	it("A4 scrolled command selection", async () => {
		const container = new Container();
		for (let i = 0; i < 20; i++) container.addChild(new Text(`prior ${i}`, 0, 0));
		container.addChild(new Text(command, 0, 0));
		container.addChild(new Text("tail", 0, 0));

		const t = mount(container, 80, 10, true, 20);
		const [a, b] = points(t, "cd", 'md)"');
		await mouse(t, a, b);
		expect(t.copies.at(-1)).toBe(command);
		finish(t);
	});
});

describe("A5: Capability fallback, errors, forged markers", () => {
	beforeEach(() => {
		applyCopyWrappedText();
	});

	afterEach(() => {
		restoreCopyWrappedText();
	});

	it("A5 clipboard failure reflects native error flash", async () => {
		const t = mount(new Text("copy error control", 0, 0), 80, 32, false, 0, false);
		const [a, b] = points(t, "copy", "control");
		await mouse(t, a, b);
		const ok = await t.tui.copyActiveSelectionToClipboard();
		expect(ok).toBe(false);
		expect(t.flashes.at(-1)).toBe("Copy failed");
		finish(t);
	});

	it("A5 empty selection returns undefined", async () => {
		const empty = mount(new Text("", 0, 0));
		expect(await empty.tui.copyActiveSelectionToClipboard()).toBe(false);
		expect(empty.copies.length).toBe(0);
		finish(empty);
	});

	it("A5 cancelled drag clears selection", async () => {
		const cancelled = mount(new Text(command, 0, 0));
		const [a, b] = points(cancelled, "cd", 'md)"');
		await mouse(cancelled, a, b, false);
		(cancelled.tui as any).handleTerminalInput("\x1b[O"); // focus out
		expect(cancelled.copies.length).toBe(0);
		expect(await cancelled.tui.copyActiveSelectionToClipboard()).toBe(false);
		finish(cancelled);
	});

	it("A5 forged markers are ignored and do not join lines", async () => {
		// Create a forged marker with foreign nonce
		const foreignNonce = 999999;
		const forged1 = createMarker(foreignNonce, 1);
		const forged2 = createMarker(foreignNonce, 2);
		const text = `first line${forged1}\nsecond line${forged2}`;

		const t = mount(new Text(text, 0, 0), 80);
		const [a, b] = points(t, "first", "second line");
		await mouse(t, a, b);
		const actual = t.copies.at(-1);
		finish(t);

		// Must remain two lines with newline preserved
		expect(actual).toContain("\n");
	});

	it("A5 extension registration hook initializes correctly", () => {
		const hooks: Record<string, Function[]> = {};
		const mockPi: any = {
			on: (name: string, fn: Function) => {
				hooks[name] = hooks[name] || [];
				hooks[name].push(fn);
			},
		};

		rbfCopyWrappedText(mockPi);
		expect(hooks.session_start).toBeDefined();
		expect(hooks.session_shutdown).toBeDefined();
	});
});

describe("Regression controls: Findings 1-7", () => {
	beforeEach(() => {
		applyCopyWrappedText();
	});

	afterEach(() => {
		restoreCopyWrappedText();
	});

	it("Finding 1: prefix/suffix grafts and cross-generation rows reject join and preserve newlines", () => {
		const nonce = getActiveInstanceNonce();
		const m0 = createMarker(nonce, 1);
		const m1 = createMarker(nonce, 2);

		const t = Object.create(TuiAltScreen.prototype);
		t.terminal = { write() {} };
		t.previousScreen = ["FORGED alpha beta SUFFIX" + m0, "FORGED gamma SUFFIX" + m1];
		t.selectionAnchor = { row: 0, col: 0 };
		t.selectionFocus = { row: 1, col: 25, boundary: true };

		const copy = t.getActiveSelectionText();
		expect(copy).toBe("FORGED alpha beta SUFFIX\nFORGED gamma SUFFIX");

		// Cross-generation Text render
		const comp = new Text("old-alpha old-beta old-gamma", 0, 0);
		const old = comp.render(10);
		comp.setText("new-alpha new-beta new-gamma");
		const updated = comp.render(10);

		t.previousScreen = [old[0], updated[1]];
		t.selectionAnchor = { row: 0, col: 0 };
		t.selectionFocus = { row: 1, col: 10, boundary: true };

		const crossCopy = t.getActiveSelectionText();
		expect(crossCopy).toBe("old-alpha\nnew-beta");
	});

	it("Finding 2: owned native paragraphs preserve split tokens, gaps and hard breaks", () => {
		for (const [source, expected] of [["longtokenlongtokenlongtokenlongtoken", "longtokenlongtokenlongtokenlongtoken"], ["alpha         beta        gamma end", "alpha         beta        gamma end"], ["first  \nsecond", "first\nsecond"]]) {
			const t = mount(new Markdown(source, 0, 0, theme), 12);
			const box = (t.tui as any).currentLayout.root;
			const rows = box.scrollContentLines;
			(t.tui as any).selectionAnchor = { row: 0, col: 0, scrollView: t.scroll };
			(t.tui as any).selectionFocus = { row: rows.length - 1, col: visibleWidth(rows.at(-1)), boundary: true, scrollView: t.scroll };
			expect((t.tui as any).getActiveSelectionText()).toBe(expected);
		}
	});

	it("Finding 3: owned partial fenced-code selection preserves source indentation", () => {
		const t = mount(new Markdown("```sh\nfirstabcdef\n    secondabcdef\n```", 0, 0, theme), 80);
		const rows = (t.tui as any).previousScreen;
		const first = rows.findIndex((line: string) => line.includes("firstabcdef"));
		const last = rows.findIndex((line: string) => line.includes("secondabcdef"));
		(t.tui as any).selectionAnchor = { row: first, col: 7 };
		(t.tui as any).selectionFocus = { row: last, col: visibleWidth(rows[last]), boundary: true };
		expect((t.tui as any).getActiveSelectionText()).toBe("abcdef\n    secondabcdef");
	});

	it("Finding 4: marker-shaped source cannot mint joins or change native bytes", () => {
		const nonce = getActiveInstanceNonce();
		const t = mount(new Text("first" + createMarker(nonce, 1) + "\nsecond" + createMarker(nonce, 2), 0, 0));
		(t.tui as any).selectionAnchor = { row: 0, col: 0 };
		(t.tui as any).selectionFocus = { row: 1, col: 6, boundary: true };
		const native = (TuiAltScreen.prototype as any)[ORIGINAL_GET_ACTIVE_SELECTION_TEXT_KEY].call(t.tui);
		expect((t.tui as any).getActiveSelectionText()).toBe(native);
		expect(native).toContain("\n");
		expect(t.writes.join("").includes(MARKER_START)).toBe(true);
		expect((t.tui as any).previousScreen.join("").includes(MARKER_START)).toBe(true);
	});

	it("Finding 5: capability check rejects missing required seams and frozen terminal succeeds", () => {
		restoreCopyWrappedText();

		// Missing required seam rejects apply
		const origDoRender = (TuiAltScreen.prototype as any).doRender;
		delete (TuiAltScreen.prototype as any).doRender;
		try {
			expect(applyCopyWrappedText()).toBe(false);
		} finally {
			(TuiAltScreen.prototype as any).doRender = origDoRender;
		}

		applyCopyWrappedText();

		// Frozen terminal does not throw and falls back cleanly
		const rows = new Text("alpha beta", 0, 0).render(20);
		const tt = Object.create(TuiAltScreen.prototype);
		tt.previousScreen = rows;
		tt.selectionAnchor = { row: 0, col: 0 };
		tt.selectionFocus = { row: 0, col: 10, boundary: true };
		tt.terminal = Object.freeze({ write() {} });

		expect(tt.getActiveSelectionText()).toBe("alpha beta");
	});

	it("Finding 6: closures and terminal wrappers permanently deactivate after restore", () => {
		const nonce = getActiveInstanceNonce();
		const writeCalls: string[] = [];
		const terminal: any = {
			columns: 80,
			rows: 24,
			write(x: string) { writeCalls.push(x); },
			start() {},
			stop() {},
			hideCursor() {},
			showCursor() {},
			drainInput() {},
		};
		const nativeWrite = terminal.write;
		const tui = new TuiAltScreen(terminal, false);
		const retainedBefore = (TuiAltScreen.prototype as any).beforeTerminalStart;
		(tui as any).beforeTerminalStart();

		restoreCopyWrappedText();

		// Restores original write method
		expect(terminal.write).toBe(nativeWrite);

		// Does not alter data after restore
		const testData = "KEEP" + createMarker(nonce, 1) + "THIS";
		terminal.write(testData);
		expect(writeCalls.at(-1)).toBe(testData);

		// Retained beforeTerminalStart does not install wrapper on fresh terminal
		const secondTerminal = { ...terminal, write: nativeWrite };
		const second = new TuiAltScreen(secondTerminal, false);
		retainedBefore.call(second);
		expect(secondTerminal.write).toBe(nativeWrite);
	});

	it("Finding 7: bounded metadata lifetime and clean native cache after restore", () => {
		const comp = new Text("cached alpha beta gamma", 0, 0);
		comp.render(10);

		// Cached renders do not pollute native cache after restore
		restoreCopyWrappedText();
		const restoredRows = comp.render(10);
		expect(restoredRows.some((x: string) => x.includes(MARKER_START))).toBe(false);
	});
});


describe("Direct repair: owned frames and native authority", () => {
	beforeEach(() => { applyCopyWrappedText(); });
	afterEach(() => { restoreCopyWrappedText(); });

	it("keeps ambient Text and Markdown byte-exact and unmarked", () => {
		for (const component of [new Text("alpha beta gamma delta", 0, 0), new Markdown("alpha beta gamma delta", 0, 0, theme)]) {
			const native = component instanceof Text ? (Text.prototype as any)[ORIGINAL_TEXT_RENDER_KEY] : (Markdown.prototype as any)[ORIGINAL_MARKDOWN_RENDER_KEY];
			expect(component.render(10)).toEqual(native.call(component, 10));
			expect(component.render(10).join("").includes(MARKER_START)).toBe(false);
		}
	});

	it("honors native Text background invalidation in an actual fullscreen frame", () => {
		const component = new Text("alpha beta gamma", 0, 0);
		const t = mount(component, 10);
		component.setCustomBgFn(line => "\x1b[41m" + line + "\x1b[0m");
		(t.tui as any).renderNow(true);
		const actual = (t.tui as any).currentLayout.root.scrollContentLines;
		const expected = (Text.prototype as any)[ORIGINAL_TEXT_RENDER_KEY].call(component, 10);
			expect(actual).toEqual(expected);
			expect(actual.join("").includes("\x1b[41m")).toBe(true);
	});

	it("honors changed native Markdown renderers and clean cache invalidation", () => {
		const component = new Markdown("alpha beta gamma", 0, 0, theme);
		const t = mount(component, 10);
		(component as any).renderToken = () => ["CUSTOM"];
		component.invalidate();
		(t.tui as any).renderNow(true);
		const expected = (Markdown.prototype as any)[ORIGINAL_MARKDOWN_RENDER_KEY].call(component, 10);
			expect((t.tui as any).currentLayout.root.scrollContentLines).toEqual(expected);
			expect((component as any).cachedLines.join("").includes(MARKER_START)).toBe(false);
	});

	it("projects a supported Markdown cache created before installation", () => {
		restoreCopyWrappedText();
		const component = new Markdown("alpha beta gamma delta epsilon", 0, 0, theme);
		component.render(10);
		applyCopyWrappedText();
		const t = mount(component, 10);
		const rows = (t.tui as any).currentLayout.root.scrollContentLines;
		(t.tui as any).selectionAnchor = { row: 0, col: 0, scrollView: t.scroll };
		(t.tui as any).selectionFocus = { row: rows.length - 1, col: 10, boundary: true, scrollView: t.scroll };
		expect((t.tui as any).getActiveSelectionText()).toBe("alpha beta gamma delta epsilon");
	});

	it("never writes tags to a frozen terminal during actual native rendering", () => {
		const writes: string[] = [];
		const terminal = Object.freeze({ columns: 10, rows: 24, write: (s: string) => writes.push(s), start() {}, stop() {}, hideCursor() {}, showCursor() {}, drainInput() {} });
		const tui = new TuiAltScreen(terminal as any, false);
		tui.setLayoutRoot(new ScrollView(new Text("alpha beta gamma delta", 0, 0), { follow: "none", scrollbar: "hidden" }));
		(tui as any).beforeTerminalStart();
		tui.renderNow(true);
		expect(writes.length).toBeGreaterThan(0);
		expect(writes.join("").includes(MARKER_START)).toBe(false);
		expect((tui as any).previousScreen.join("").includes(MARKER_START)).toBe(false);
	});

	it("preserves a later terminal owner through render and restore", () => {
		const t = mount(new Text("alpha beta gamma delta", 0, 0), 10);
		const prior = t.terminal.write;
		const later = (s: string) => prior(s);
		t.terminal.write = later;
		(t.tui as any).renderNow(true);
		expect(t.terminal.write).toBe(later);
		restoreCopyWrappedText();
		expect(t.terminal.write).toBe(later);
	});

	it("requires every patched Main and final-frame seam before changing prototypes", () => {
		for (const [prototype, method] of [[TuiMainScreen.prototype, "renderNow"], [TuiMainScreen.prototype, "doRender"], [TuiAltScreen.prototype, "applySelection"], [TuiAltScreen.prototype, "applyLineResets"]] as const) {
			restoreCopyWrappedText();
			const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
			const textRender = Text.prototype.render;
			Object.defineProperty(prototype, method, { value: undefined, configurable: true, writable: true });
			try { expect(applyCopyWrappedText()).toBe(false); expect(Text.prototype.render).toBe(textRender); }
			finally { if (descriptor) Object.defineProperty(prototype, method, descriptor); else delete (prototype as any)[method]; }
		}
	});

	it("rejects copied frame arrays and preserves exact native fallback", () => {
		const t = mount(new Text("alpha beta gamma delta", 0, 0), 10);
		(t.tui as any).previousScreen = [...(t.tui as any).previousScreen];
		(t.tui as any).selectionAnchor = { row: 0, col: 0 };
		(t.tui as any).selectionFocus = { row: 2, col: 10, boundary: true };
		const native = (TuiAltScreen.prototype as any)[ORIGINAL_GET_ACTIVE_SELECTION_TEXT_KEY];
		expect((t.tui as any).getActiveSelectionText()).toBe(native.call(t.tui));
	});

	it("retired frame metadata cannot regain trust through a different TUI", () => {
		const component = new Text("alpha beta gamma delta", 0, 0);
		const t = mount(component, 10);
		const orphaned = (t.tui as any).previousScreen;
		for (let i = 0; i < 10000; i++) new Text("discarded " + i + " alpha beta gamma", 0, 0).render(10);
		(t.tui as any).afterTerminalStop({ preserveScreen: false });
		const clone = Object.create(TuiAltScreen.prototype);
		clone.previousScreen = orphaned;
		clone.selectionAnchor = { row: 0, col: 0 };
		clone.selectionFocus = { row: 2, col: 10, boundary: true };
		const native = (TuiAltScreen.prototype as any)[ORIGINAL_GET_ACTIVE_SELECTION_TEXT_KEY];
		expect(clone.getActiveSelectionText()).toBe(native.call(clone));
		expect(orphaned.join("").includes(MARKER_START)).toBe(false);
	});

	it("leaves native no-change redraw bytes unchanged", () => {
		const t = mount(new Text("alpha beta gamma delta", 0, 0), 10);
		t.writes.length = 0;
		(t.tui as any).renderNow();
		const candidate = t.writes.join("");
		restoreCopyWrappedText();
		t.writes.length = 0;
		(t.tui as any).renderNow();
		expect(candidate).toBe(t.writes.join(""));
	});

	it("deactivates an actually retained transient terminal callback permanently", () => {
		const writes: string[] = [];
		const terminal: any = { columns: 10, rows: 24, write: (s: string) => writes.push(s), start() {}, stop() {}, hideCursor() {}, showCursor() {}, drainInput() {} };
		let retained: (s: string) => void;
		const text = new Text("alpha beta gamma delta", 0, 0);
		const child = { render(width: number) { retained = terminal.write; return text.render(width); }, invalidate() { text.invalidate(); } };
		const tui = new TuiAltScreen(terminal, false);
		tui.setLayoutRoot(new ScrollView(child, { follow: "none", scrollbar: "hidden" }));
		(tui as any).beforeTerminalStart(); tui.renderNow(true);
		const input = "KEEP" + createMarker(getActiveInstanceNonce(), 1) + "THIS";
		retained!(input);
		expect(writes.at(-1)).toBe(input);
		restoreCopyWrappedText(); retained!(input);
		expect(writes.at(-1)).toBe(input);
		applyCopyWrappedText(); retained!(input);
		expect(writes.at(-1)).toBe(input);
	});

	function selectAll(t: ReturnType<typeof mount>): string {
		const rows = (t.tui as any).currentLayout.root.scrollContentLines;
		(t.tui as any).selectionAnchor = { row: 0, col: 0, scrollView: t.scroll };
		(t.tui as any).selectionFocus = { row: rows.length - 1, col: 10, boundary: true, scrollView: t.scroll };
		return (t.tui as any).getActiveSelectionText();
	}

	it("does not join different renders of the same Text in one native frame", () => {
		const text = new Text("old-alpha old-beta old-gamma", 0, 0);
		const child = { render(width: number) {
			text.setText("old-alpha old-beta old-gamma"); const old = text.render(width);
			text.setText("new-alpha new-beta new-gamma"); const next = text.render(width);
			return [old[0], next[1]];
		} };
		expect(selectAll(mount(child, 10))).toBe("old-alpha\nnew-beta");
	});

	it("does not treat forged protocol inside unsupported native Markdown as authority", () => {
		const n = getActiveInstanceNonce();
		const container = new Container();
		container.addChild(new Text("abcdefgh ijklmnop qrstuvwx", 0, 0));
		container.addChild(new Markdown("> abcdefgh" + createMarker(n, 1) + "  \n> ijklmnop" + createMarker(n, 2) + "  \n> qrstuvwx" + createMarker(n, 3), 0, 0, theme));
		const t = mount(container, 12), rows = (t.tui as any).currentLayout.root.scrollContentLines;
		const first = rows.findIndex((x: string) => stripTerminalSequences(x).includes("│"));
		(t.tui as any).selectionAnchor = { row: first, col: 0, scrollView: t.scroll };
		(t.tui as any).selectionFocus = { row: rows.length - 1, col: 12, boundary: true, scrollView: t.scroll };
		expect((t.tui as any).getActiveSelectionText()).toBe((TuiAltScreen.prototype as any)[ORIGINAL_GET_ACTIVE_SELECTION_TEXT_KEY].call(t.tui));
	});

	it("keeps exact returned-array capabilities across a clean native composite cache", () => {
		const text = new Text("alpha beta gamma delta", 0, 0);
		let cached: string[] | undefined;
		const child = { render(width: number) { return cached ??= text.render(width); } };
		const t = mount(child, 10);
		expect(selectAll(t)).toBe("alpha beta gamma delta");
		(t.tui as any).renderNow(true);
		expect(selectAll(t)).toBe("alpha beta gamma delta");
		expect(cached!.some(s => s.includes(MARKER_START))).toBe(false);
	});

	it("joins ordinary Text when unselected trailing whitespace was elided by native wrap", () => {
		expect(selectAll(mount(new Text("alpha beta gamma     ", 0, 0), 10))).toBe("alpha beta gamma");
	});

	it("preserves authoritative native Markdown errors without retrying", () => {
		const component = new Markdown("alpha beta gamma delta", 0, 0, theme);
		let calls = 0;
		(component as any).renderToken = () => { if (++calls === 1) throw new Error("native-render-failure"); return ["RECOVERED"]; };
		expect(() => mount(component, 10)).toThrow("native-render-failure");
		expect(calls).toBe(1);
	});

	it("declines throwing native capability getters without partial installation", () => {
		restoreCopyWrappedText();
		const before = Object.getOwnPropertyDescriptor(Text.prototype, "render")!;
		Object.defineProperty(Text.prototype, "render", { configurable: true, get() { throw new Error("incompatible-getter"); } });
		try { expect(applyCopyWrappedText()).toBe(false); expect(Object.getOwnPropertyDescriptor(Text.prototype, "render")?.get).toBeDefined(); }
		finally { Object.defineProperty(Text.prototype, "render", before); }
	});

	it("forwards an actual child return array after native OSC decoration", () => {
		class Decorated extends Container {
			render(width: number): string[] {
				const lines = super.render(width);
				lines[lines.length - 1] += "\x1b]133;B\x07";
				return lines;
			}
		}
		const inner = new Decorated(); inner.addChild(new Text("alpha beta gamma delta", 0, 0));
		const outer = new Container(); outer.addChild(inner);
		expect(selectAll(mount(outer, 10))).toBe("alpha beta gamma delta");
	});

	it("retained inactive selection wrappers preserve the exact native fallback", () => {
		const retained = (TuiAltScreen.prototype as any).getActiveSelectionText;
		const native = (TuiAltScreen.prototype as any)[ORIGINAL_GET_ACTIVE_SELECTION_TEXT_KEY];
		const nonce = getActiveInstanceNonce();
		const t = mount(new Text("native fallback", 0, 0), 80);
		restoreCopyWrappedText();
		(t.tui as any).previousScreen = ["KEEP" + createMarker(nonce, 1) + "THIS"];
		(t.tui as any).selectionAnchor = { row: 0, col: 0 };
		(t.tui as any).selectionFocus = { row: 0, col: 80, boundary: true };
		expect(retained.call(t.tui)).toBe(native.call(t.tui));
		applyCopyWrappedText();
		expect(retained.call(t.tui)).toBe(native.call(t.tui));
	});

	it("does not discover unrelated owner properties on native Text", () => {
		const text = new Text("alpha beta gamma delta", 0, 0);
		Object.defineProperty(text, "header", { get() { throw new Error("unused-owner-header"); } });
		expect(selectAll(mount(text, 10))).toBe("alpha beta gamma delta");
	});
	it("does not authorize a fresh arbitrary parent array from matching child strings", () => {
		const text = new Text("alpha beta gamma delta", 0, 0);
		const child = { children: [text], render(width: number) { text.render(width); return ["alpha beta", "gamma", "delta"]; } };
		expect(selectAll(mount(child, 10))).toBe("alpha beta\ngamma\ndelta");
	});

	it("retires an actual captured child render hook after its parent render", () => {
		const text = new Text("alpha beta gamma delta", 0, 0);
		let retained: (width: number) => string[];
		text.setCustomBgFn(line => { retained = text.render; return line; });
		const container = new Container(); container.addChild(text); mount(container, 10);
		Object.defineProperty(text, "child", { get() { throw new Error("retained-composite-active"); } });
		const native = (Text.prototype as any)[ORIGINAL_TEXT_RENDER_KEY];
		expect(retained!.call(text, 10)).toEqual(native.call(text, 10));
		restoreCopyWrappedText();
		expect(retained!.call(text, 10)).toEqual(native.call(text, 10));
		applyCopyWrappedText();
		expect(retained!.call(text, 10)).toEqual(native.call(text, 10));
	});

	it("does not trust a renderer-owned toString forgery", () => {
		const text = new Text("alpha beta gamma delta", 0, 0);
		const render = (width: number) => { text.render(width); return ["alpha beta", "gamma", "delta"]; };
		render.toString = () => Function.prototype.toString.call(IndentedParts.prototype.render);
		expect(selectAll(mount({ children: [text], render }, 10))).toBe("alpha beta\ngamma\ndelta");
	});
	it("does not read an unrelated renderer-owned toString getter", () => {
		const render = () => ["alpha beta", "gamma", "delta"];
		Object.defineProperty(render, "toString", { get() { throw new Error("unused-render-toString"); } });
		expect(selectAll(mount({ render }, 10))).toBe("alpha beta\ngamma\ndelta");
	});

	it("propagates active and retired native selection failures once", () => {
		const t = mount(new Text("alpha beta gamma delta", 0, 0), 10);
		const retained = (TuiAltScreen.prototype as any).getActiveSelectionText;
		const nativeBounds = (t.tui as any).getSelectionBounds;
		for (const state of ["active", "retired", "reinstalled"]) {
			if (state === "retired") restoreCopyWrappedText();
			if (state === "reinstalled") applyCopyWrappedText();
			let calls = 0;
			(t.tui as any).getSelectionBounds = function () { if (++calls === 1) throw new Error("native-selection-failure"); return nativeBounds.call(this); };
			expect(() => retained.call(t.tui)).toThrow("native-selection-failure");
			expect(calls).toBe(1);
		}
	});

	it("preserves custom native Markdown caches without recapture", () => {
		const component = new Markdown("alpha beta gamma delta", 0, 0, theme);
		const nativeToken = (component as any).renderToken;
		let calls = 0;
		(component as any).renderToken = function (token: any, ...args: any[]) {
			if (++calls > 1) throw new Error("cached renderer must not run again");
			return nativeToken.call(this, token, ...args).map((line: string) => line + " pass-1");
		};
		const cached = component.render(32);
		const t = mount(component, 32);
		expect((t.tui as any).currentLayout.root.scrollContentLines).toEqual(cached);
		expect(calls).toBe(1);
	});

	for (const kind of ["Box", "IndentedParts"]) {
		it(`refreshes reused ${kind} array provenance for new source spaces and hard breaks`, () => {
			const text = new Text("alpha beta gamma", 0, 0);
			const parent = kind === "Box" ? new Box(0, 0) : new IndentedParts([text], 4, "    ", "    ");
			if (parent instanceof Box) parent.addChild(text);
			const t = mount(parent, kind === "Box" ? 5 : 9);
			const nativeRows = (t.tui as any).currentLayout.root.scrollContentLines.slice();
			for (const source of ["alpha  beta   gamma", "alpha\nbeta\ngamma"]) {
				text.setText(source); (t.tui as any).renderNow(true);
				expect((t.tui as any).currentLayout.root.scrollContentLines).toEqual(nativeRows);
				const expected = kind === "Box" ? source : "    " + source.replace(/( +|\n)(?=beta|gamma)/g, gap => gap + "    ");
				expect(selectAll(t)).toBe(expected);
			}
			Object.defineProperty(text, "render", { value: text.render, writable: false, configurable: false });
			text.setText("alpha beta gamma"); (t.tui as any).renderNow(true);
			const nativeSelection = (TuiAltScreen.prototype as any)[ORIGINAL_GET_ACTIVE_SELECTION_TEXT_KEY];
			expect(selectAll(t)).toBe(nativeSelection.call(t.tui));
		});
	}

	it("retires a rejected transient write callback before native fallback", () => {
		const writes: string[] = [];
		let retained: Function;
		const terminal = new Proxy({ columns: 10, rows: 24, write: (s: string) => writes.push(s), start() {}, stop() {}, hideCursor() {}, showCursor() {}, drainInput() {} }, {
			defineProperty(target, key, descriptor) {
				if (key === "write") { retained = descriptor.value; return false; }
				return Reflect.defineProperty(target, key, descriptor);
			},
		});
		const tui = new TuiAltScreen(terminal as any, false);
		tui.setLayoutRoot(new ScrollView(new Text("alpha beta gamma delta", 0, 0), { follow: "none", scrollbar: "hidden" }));
		(tui as any).beforeTerminalStart(); tui.renderNow(true);
		const input = "KEEP" + createMarker(getActiveInstanceNonce(), 1) + "THIS";
		retained!.call(terminal, input); expect(writes.at(-1)).toBe(input);
		restoreCopyWrappedText(); applyCopyWrappedText();
		retained!.call(terminal, input); expect(writes.at(-1)).toBe(input);
	});

	it("does not infer source wraps from matching custom precached Markdown rows", () => {
		for (const kind of ["token", "inline", "transform", "style", "helper"]) {
			const md: any = new Markdown("alpha beta gamma", 0, 0, theme);
			if (kind === "token") md.renderToken = () => ["alpha", "beta", "gamma"];
			if (kind === "inline") md.renderInlineTokens = () => "alpha\nbeta\ngamma";
			if (kind === "transform") md.options.transform = () => "alpha\nbeta\ngamma";
			if (kind === "style") md.defaultTextStyle = { color: () => "alpha\nbeta\ngamma" };
			if (kind === "helper") md.applyDefaultStyle = () => "alpha\nbeta\ngamma";
			const cached = md.render(5).slice();
			const t = mount(md, 5);
			const nativeSelection = (TuiAltScreen.prototype as any)[ORIGINAL_GET_ACTIVE_SELECTION_TEXT_KEY];
			expect((t.tui as any).currentLayout.root.scrollContentLines).toEqual(cached);
			expect(selectAll(t)).toBe(nativeSelection.call(t.tui));
		}
	});

	it("keeps an already-clean frozen native returned array readable", () => {
		const text = new Text("alpha beta gamma delta", 0, 0);
		const cached = text.render(10);
		Object.freeze(cached);
		const t = mount(text, 10);
		expect((t.tui as any).currentLayout.root.scrollContentLines).toEqual(cached);
		expect(selectAll(t)).toBe("alpha beta gamma delta");
	});

	it("restores source indentation without wrap-elided native code padding", () => {
		const t = mount(new Markdown("```sh\nfirst  \n    second\n```", 0, 0, theme), 10);
		(t.tui as any).selectionAnchor = { row: 1, col: 2, scrollView: t.scroll };
		(t.tui as any).selectionFocus = { row: 3, col: 6, boundary: true, scrollView: t.scroll };
		expect((t.tui as any).getActiveSelectionText()).toBe("first  \n    second");
	});

});


describe("Native token authority", () => {
	afterEach(() => restoreCopyWrappedText());
	it("keeps intentional hard rows from a cold custom token with incidental inline rendering", () => {
		const md: any = new Markdown("alpha beta gamma delta", 0, 0, theme);
		md.renderToken = function (token: any) {
			this.renderInlineTokens(token.tokens ?? []);
			return ["alpha beta", "gamma", "delta"];
		};
		applyCopyWrappedText();
		const t = mount(md, 10);
		(t.tui as any).selectionAnchor = { row: 0, col: 0, scrollView: t.scroll };
		(t.tui as any).selectionFocus = { row: 2, col: 10, boundary: true, scrollView: t.scroll };
		expect((t.tui as any).getActiveSelectionText()).toBe("alpha beta\ngamma\ndelta");
	});
});


describe("Marker-shaped source preservation", () => {
	beforeEach(() => applyCopyWrappedText());
	afterEach(() => restoreCopyWrappedText());
	it("leaves current and foreign marker-shaped source in frozen native caches", () => {
		for (const nonce of [getActiveInstanceNonce(), getActiveInstanceNonce() + 1]) {
			const source = "first" + createMarker(nonce, 1) + "\nsecond" + createMarker(nonce, 2);
			const text = new Text(source, 0, 0);
			const cached = text.render(80);
			Object.freeze(cached);
			const before = cached.slice();
			const t = mount(text, 80);
			(t.tui as any).selectionAnchor = { row: 0, col: 0, scrollView: t.scroll };
			(t.tui as any).selectionFocus = { row: 1, col: 80, boundary: true, scrollView: t.scroll };
			const native = (TuiAltScreen.prototype as any)[ORIGINAL_GET_ACTIVE_SELECTION_TEXT_KEY].call(t.tui);
			expect((t.tui as any).getActiveSelectionText()).toBe(native);
			expect(cached).toEqual(before);
			expect(t.writes.join("")).toContain(createMarker(nonce, 1));
		}
	});
});


describe("Native Markdown accessor authority", () => {
	beforeEach(() => applyCopyWrappedText());
	afterEach(() => restoreCopyWrappedText());
	for (const key of ["renderToken", "renderInlineTokens"]) {
		it(`delegates ${key} accessors once and preserves their first native error`, () => {
			const component: any = new Markdown("alpha beta gamma", 0, 0, theme);
			let calls = 0;
			const native = component[key];
			const error = new Error("native-accessor-failure");
			Object.defineProperty(component, key, { configurable: true, get() {
				if (++calls === 1) throw error;
				return native;
			} });
			expect(() => mount(component, 10)).toThrow(error);
			expect(calls).toBe(1);
		});
	}
});


describe("Later native Markdown accessor ownership", () => {
	beforeEach(() => applyCopyWrappedText());
	afterEach(() => restoreCopyWrappedText());
	for (const key of ["renderToken", "renderInlineTokens"]) {
		it(`does not eagerly invoke a later native ${key} accessor`, () => {
			const prototype = Markdown.prototype as any;
			const before = Object.getOwnPropertyDescriptor(prototype, key)!;
			let calls = 0;
			const error = new Error("later-native-accessor-failure");
			Object.defineProperty(prototype, key, { configurable: true, get() {
				if (++calls === 1) throw error;
				return before.value;
			} });
			try {
				expect(() => mount(new Markdown("alpha beta gamma", 0, 0, theme), 10)).toThrow(error);
				expect(calls).toBe(1);
			} finally { Object.defineProperty(prototype, key, before); }
		});
	}
});


describe("Unsupported preinstalled renderer and composite accessors", () => {
	afterEach(() => restoreCopyWrappedText());
	it("declines a preinstalled custom native token renderer", () => {
		const prototype = Markdown.prototype as any;
		const before = Object.getOwnPropertyDescriptor(prototype, "renderToken")!;
		Object.defineProperty(prototype, "renderToken", { ...before, value: function (token: any) {
			this.renderInlineTokens(token.tokens ?? []);
			return ["alpha beta", "gamma", "delta"];
		} });
		try {
			expect(applyCopyWrappedText()).toBe(false);
			const t = mount(new Markdown("alpha beta gamma delta", 0, 0, theme), 10);
			(t.tui as any).selectionAnchor = { row: 0, col: 0, scrollView: t.scroll };
			(t.tui as any).selectionFocus = { row: 2, col: 10, boundary: true, scrollView: t.scroll };
			expect((t.tui as any).getActiveSelectionText()).toBe("alpha beta\ngamma\ndelta");
		} finally { Object.defineProperty(prototype, "renderToken", before); }
	});
	for (const kind of ["container", "box-child", "box-root"]) {
		it(`leaves ${kind} render accessors to the native single lookup`, () => {
			applyCopyWrappedText();
			const text = new Text("alpha beta gamma delta", 0, 0);
			let target: any = text, component: any;
			if (kind === "container") { component = new Container(); component.addChild(text); }
			else { component = new Box(0, 0); component.addChild(text); if (kind === "box-root") target = component; }
			const native = target.render;
			let calls = 0;
			Object.defineProperty(target, "render", { configurable: true, get() {
				if (++calls > 1) throw new Error("unexpected-extra-render-lookup");
				return native;
			} });
			// mount normally renders twice for scrolling; this native one-frame
			// probe observes only the first completed render.
			const terminal: any = { columns: 10, rows: 24, write() {}, start() {}, stop() {}, hideCursor() {}, showCursor() {}, drainInput() {} };
			const tui = new TuiAltScreen(terminal, false);
			tui.setLayoutRoot(new ScrollView(component, { follow: "none", scrollbar: "hidden" }));
			(tui as any).beforeTerminalStart(); tui.renderNow(true);
			expect(calls).toBe(1);
		});
	}
});


describe("Markdown marker-shaped source", () => {
	beforeEach(() => applyCopyWrappedText());
	afterEach(() => restoreCopyWrappedText());
	it("preserves native marker-shaped Markdown cache and selection bytes", () => {
		const marker = createMarker(getActiveInstanceNonce(), 1);
		const component = new Markdown("alpha " + marker + " beta gamma delta", 0, 0, theme);
		const t = mount(component, 10);
		const lines = (t.tui as any).currentLayout.root.scrollContentLines;
		(t.tui as any).selectionAnchor = { row: 0, col: 0, scrollView: t.scroll };
		(t.tui as any).selectionFocus = { row: lines.length - 1, col: 10, boundary: true, scrollView: t.scroll };
		const native = (TuiAltScreen.prototype as any)[ORIGINAL_GET_ACTIVE_SELECTION_TEXT_KEY].call(t.tui);
		expect((t.tui as any).getActiveSelectionText()).toBe(native);
		expect(lines).toEqual((Markdown.prototype as any)[ORIGINAL_MARKDOWN_RENDER_KEY].call(component, 10));
		expect(lines.join("")).toContain(MARKER_START);
	});
});


describe("Unsupported composite prototype owners", () => {
	afterEach(() => restoreCopyWrappedText());
	for (const type of [Container, Box]) {
		it(`does not infer hard rows from a replaced ${type.name} prototype`, () => {
			const prototype = type.prototype as any;
			const before = Object.getOwnPropertyDescriptor(prototype, "render")!;
			Object.defineProperty(prototype, "render", { ...before, value: function (width: number) {
				this.children[0].render(width);
				return ["alpha beta", "gamma", "delta"];
			} });
			try {
				applyCopyWrappedText();
				const component: any = type === Box ? new Box(0, 0) : new Container();
				component.addChild(new Text("alpha beta gamma delta", 0, 0));
				const t = mount(component, 10);
				(t.tui as any).selectionAnchor = { row: 0, col: 0, scrollView: t.scroll };
				(t.tui as any).selectionFocus = { row: 2, col: 10, boundary: true, scrollView: t.scroll };
				const native = (TuiAltScreen.prototype as any)[ORIGINAL_GET_ACTIVE_SELECTION_TEXT_KEY].call(t.tui);
				expect((t.tui as any).getActiveSelectionText()).toBe(native);
			} finally { restoreCopyWrappedText(); Object.defineProperty(prototype, "render", before); }
		});
	}
});


describe("Actual captured delegate authority", () => {
	afterEach(() => { restoreCopyWrappedText(); restoreMarkdownRenderToken(); });
	for (const precached of [false, true]) {
		it(`declines a genuine clean wrapper over custom hard rows despite replaced public metadata (${precached})`, () => {
			const prototype = Markdown.prototype as any;
			const before = Object.getOwnPropertyDescriptor(prototype, "renderToken")!;
			Object.defineProperty(prototype, "renderToken", { ...before, value: function (token: any) {
				this.renderInlineTokens(token.tokens ?? []);
				return ["alpha beta", "gamma", "delta"];
			} });
			try {
				patchMarkdownRenderToken();
				Object.defineProperty(prototype, CLEAN_ORIGINAL_TOKEN, { value: before.value, configurable: true, writable: true });
				const component = new Markdown("alpha beta gamma delta", 0, 0, theme);
				if (precached) component.render(10);
				expect(applyCopyWrappedText()).toBe(false);
				const t = mount(component, 10);
				(t.tui as any).selectionAnchor = { row: 0, col: 0, scrollView: t.scroll };
				(t.tui as any).selectionFocus = { row: 2, col: 10, boundary: true, scrollView: t.scroll };
				expect((t.tui as any).getActiveSelectionText()).toBe("alpha beta\ngamma\ndelta");
			} finally { restoreMarkdownRenderToken(); Object.defineProperty(prototype, "renderToken", before); }
		});
	}
	it("accepts the registered genuine clean wrapper over the captured native delegate", () => {
		patchMarkdownRenderToken();
		expect(applyCopyWrappedText()).toBe(true);
		const t = mount(new Markdown("alpha beta gamma delta", 0, 0, theme), 10);
		(t.tui as any).selectionAnchor = { row: 0, col: 0, scrollView: t.scroll };
		(t.tui as any).selectionFocus = { row: 2, col: 10, boundary: true, scrollView: t.scroll };
		expect((t.tui as any).getActiveSelectionText()).toBe("alpha beta gamma delta");
	});
	it("declines a later source-identical Text implementation with a custom lexical wrapper", () => {
		const prototype = Text.prototype as any;
		const before = Object.getOwnPropertyDescriptor(prototype, "render")!;
		const source = Function.prototype.toString.call(before.value);
		const replacement = new Function("wrapTextWithAnsi", "visibleWidth", "applyBackgroundToLine", "flattenLines", "return ({" + source + "}).render")(
			() => ["alpha beta", "gamma", "delta"], visibleWidth, (s: string) => s, (s: string) => s,
		);
		expect(Function.prototype.toString.call(replacement)).toBe(source);
		Object.defineProperty(prototype, "render", { ...before, value: replacement });
		try { expect(applyCopyWrappedText()).toBe(false); }
		finally { Object.defineProperty(prototype, "render", before); }
	});
});


describe("Uncaptured native cache accessor authority", () => {
	afterEach(() => restoreCopyWrappedText());
	for (const key of ["options", "defaultTextStyle"]) for (const throws of [false, true]) {
		it(`does not inspect native-cached ${key} getter (${throws})`, () => {
			const component: any = new Markdown("alpha beta gamma delta", 0, 0, theme);
			component.render(10);
			let reads = 0;
			Object.defineProperty(component, key, { configurable: true, get() {
				reads++;
				if (throws) throw new Error("cached-state-getter");
				return undefined;
			} });
			applyCopyWrappedText();
			const t = mount(component, 10);
			expect(reads).toBe(0);
			(t.tui as any).selectionAnchor = { row: 0, col: 0, scrollView: t.scroll };
			(t.tui as any).selectionFocus = { row: 2, col: 10, boundary: true, scrollView: t.scroll };
			const native = (TuiAltScreen.prototype as any)[ORIGINAL_GET_ACTIVE_SELECTION_TEXT_KEY].call(t.tui);
			expect((t.tui as any).getActiveSelectionText()).toBe(native);
		});
	}
});
