import { ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCleanTokenDelegate } from "./rbf-clean-markdown-code.ts";
import { isPathLabelTokenRenderer } from "./rbf-path-labels.ts";
import { getPartForwarderKeys, getToolRenderDelegate } from "./rbf-tool-parts-indent.ts";
import { Box, Container, Markdown, MouseRegion, ScrollView, Text, TuiAltScreen, TuiMainScreen, sliceByColumn, stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const COPY_WRAPPED_TEXT_PATCHED_KEY = Symbol.for("rbf.copyWrappedText.patched");
export const ORIGINAL_TEXT_RENDER_KEY = Symbol.for("rbf.copyWrappedText.originalTextRender");
export const ORIGINAL_MARKDOWN_RENDER_KEY = Symbol.for("rbf.copyWrappedText.originalMarkdownRender");
export const ORIGINAL_GET_ACTIVE_SELECTION_TEXT_KEY = Symbol.for("rbf.copyWrappedText.originalGetActiveSelectionText");
export const MARKER_START = "\uFEFF\u200D\u200B\u200C";
export const MARKER_END = "\u200C\u200B\u200D\uFEFF";
export const MARKER_REGEX = /\uFEFF\u200D\u200B\u200C([\u200B\u200C]+)\u200D([\u200B\u200C]+)\u200C\u200B\u200D\uFEFF?/g;

// ─────────────────────────────────────────────────────────────────────────────
// Ephemeral render provenance; native caches and completed frames stay clean

type Native = any;
interface RowProvenance {
	componentId: number;
	nativeRender: string[];
	logicalLineId: number;
	partIndex: number;
	elidedBefore: string;
	componentPadding: number;
	blockIndent: number;
	visibleText: string;
}
interface Binding { raw: string; record: RowProvenance }
interface Frame {
	bindings: WeakMap<string[], Map<number, Binding>>;
	layout?: Native;
	screen?: string[];
	pendingScreen?: Map<number, Binding>;
}
interface Patch {
	target: Native;
	key: PropertyKey;
	before?: PropertyDescriptor;
	owned: PropertyDescriptor;
}
interface Session {
	active: boolean;
	nonce: number;
	patches: Patch[];
	frames: WeakMap<object, Frame>;
	arrays: WeakMap<string[], Map<number, Binding>>;
}
interface RenderScope { session: Session; frame: Frame; tui: Native; terminal: Native; write: Function }
interface Projection { native: string[]; rows: Map<number, RowProvenance> }
let activeSession: Session | undefined;
let renderScope: RenderScope | undefined;
const components = new WeakMap<object, number>();
let nextComponent = 0;
const nonceKey = Symbol.for("rbf.copyWrappedText.nextNonce");

function encodeInt(n: number): string { return n.toString(2).replace(/0/g, "\u200B").replace(/1/g, "\u200C"); }
function decodeInt(s: string): number { return Number.parseInt(s.replace(/\u200B/g, "0").replace(/\u200C/g, "1"), 2); }
export function createMarker(nonce: number, id: number): string { return MARKER_START + encodeInt(nonce) + "\u200D" + encodeInt(id) + MARKER_END; }
export function parseMarker(s: string): { instanceNonce: number; recordId: number } | null {
	const m = new RegExp(MARKER_REGEX.source).exec(s);
	if (!m) return null;
	const instanceNonce = decodeInt(m[1]), recordId = decodeInt(m[2]);
	return Number.isSafeInteger(instanceNonce) && instanceNonce > 0 && Number.isSafeInteger(recordId) && recordId > 0 ? { instanceNonce, recordId } : null;
}
export function getActiveInstanceNonce(): number { return activeSession?.active ? activeSession.nonce : 0; }
export function scrubOwnedMarkers(s: string, nonce = getActiveInstanceNonce()): string {
	if (!nonce || !s.includes(MARKER_START)) return s;
	let previous: string;
	do {
		previous = s;
		s = s.replace(MARKER_REGEX, (raw, encoded) => decodeInt(encoded) === nonce ? "" : raw);
	} while (s !== previous);
	return s;
}
function componentId(component: object): number {
	let id = components.get(component);
	if (!id) { id = ++nextComponent; components.set(component, id); }
	return id;
}
// Retained temporary callbacks own only a native delegate after retirement.
// Keep this factory outside render/capture scopes so its lexical environment
// cannot retain a completed frame or its component tree.
function transientHook(native: Function, capture: Function | undefined): { wrapper: Function; retire: () => void } {
	let delegate = capture;
	capture = undefined;
	return {
		wrapper: function (this: Native, ...args: Native[]) { return (delegate ?? native).apply(this, args); },
		retire: () => { delegate = undefined; },
	};
}
function inNativeRender<T>(fn: () => T): T {
	const previous = renderScope;
	renderScope = undefined;
	try { return fn(); } finally { renderScope = previous; }
}
// Inspect lookup descriptors without invoking unsupported accessor owners.
function dataValue(target: Native, key: PropertyKey): Native {
	let owner = target;
	while (owner) {
		const descriptor = Object.getOwnPropertyDescriptor(owner, key);
		if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
		owner = Object.getPrototypeOf(owner);
	}
}
function hasDataLookup(target: Native, key: PropertyKey): boolean {
	let owner = target;
	while (owner) {
		const descriptor = Object.getOwnPropertyDescriptor(owner, key);
		if (descriptor) return "value" in descriptor;
		owner = Object.getPrototypeOf(owner);
	}
	return true;
}
// The trusted native module supplies identities at initialization. Function
// source is only an initial compatibility check, never authority for a later
// replacement with the same body but different lexical dependencies.
function initialNative(type: Native, key: string): Function | undefined {
	const method = dataValue(type.prototype, key);
	if (typeof method !== "function") return undefined;
	const source = Function.prototype.toString.call(method);
	return source.startsWith(key + "(") && Function.prototype.toString.call(type).includes(source) ? method : undefined;
}
const initialTextRender = initialNative(Text, "render");
const initialMarkdownRender = initialNative(Markdown, "render");
const initialSelection = initialNative(TuiAltScreen, "getActiveSelectionText");
const initialMarkdownToken = (() => {
	const token = dataValue(Markdown.prototype, "renderToken");
	const delegate = typeof token === "function" ? getCleanTokenDelegate(token) ?? token : undefined;
	if (typeof delegate !== "function") return undefined;
	const source = Function.prototype.toString.call(delegate);
	return source.startsWith("renderToken(") && Function.prototype.toString.call(Markdown).includes(source) ? delegate : undefined;
})();
function supportedNativeToken(token: Native): boolean {
	return !!initialMarkdownToken && (token === initialMarkdownToken ||
		(typeof token === "function" && getCleanTokenDelegate(token) === initialMarkdownToken));
}
function scopeFor(session: Session): RenderScope | undefined {
	const scope = renderScope;
	return session.active && scope?.session === session && Object.getOwnPropertyDescriptor(scope.terminal, "write")?.value === scope.write ? scope : undefined;
}
function rememberArray(session: Session, lines: string[], rows: Map<number, RowProvenance>): string[] {
	const bindings = new Map<number, Binding>();
	for (const [row, record] of rows) bindings.set(row, { raw: lines[row], record });
	if (bindings.size) session.arrays.set(lines, bindings);
	else session.arrays.delete(lines);
	return lines;
}
function annotate(session: Session, native: string[], rows: Map<number, RowProvenance>): string[] {
	return scopeFor(session) ? rememberArray(session, native, rows) : native;
}

// Match the authoritative visible wrap to a logical native source. Only spaces
// may be omitted between consecutive spans; a mismatch delegates the whole block.
function mapParts(source: string[], parts: string[], offset: number, padding: number, indent: number, id: number, nativeRender: string[]): Map<number, RowProvenance> {
	const rows = new Map<number, RowProvenance>();
	let logical = 0, cursor = 0, partIndex = 0;
	for (let row = 0; row < parts.length; row++) {
		const part = stripTerminalSequences(parts[row]);
		if (logical >= source.length) break; // Native inter-token spacing is not source.
		const line = stripTerminalSequences(source[logical]);
		const start = line.indexOf(part, cursor);
		if (start < cursor || !/^[ \t]*$/.test(line.slice(cursor, start))) return new Map();
		rows.set(offset + row, { componentId: id, nativeRender, logicalLineId: logical, partIndex: partIndex++, elidedBefore: line.slice(Math.max(cursor, Math.min(indent, start)), start), componentPadding: padding, blockIndent: indent, visibleText: part });
		cursor = start + part.length;
		if (/^[ \t]*$/.test(line.slice(cursor))) { logical++; cursor = 0; partIndex = 0; }
	}
	return logical === source.length ? rows : new Map();
}
function validNativeRows(native: string[], rows: Map<number, RowProvenance>): boolean {
	for (const [row, record] of rows) {
		const plain = stripTerminalSequences(native[row] ?? "");
		const expected = " ".repeat(record.componentPadding) + record.visibleText;
		if (!plain.startsWith(expected) || plain.slice(expected.length).trim() !== "") return false;
	}
	return true;
}
function textProjection(component: Native, native: string[], width: number): Map<number, RowProvenance> {
	if (!["text", "paddingX", "paddingY"].every(key => hasDataLookup(component, key))) return new Map();
	if (!component.text?.trim() || component.text.includes(MARKER_START)) return new Map();
	const padding = Math.min(component.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
	const source = component.text.replace(/\t/g, "   ").split(/\r\n|\r|\n/);
	const parts = wrapTextWithAnsi(component.text.replace(/\t/g, "   "), Math.max(1, width - padding * 2));
	const rows = mapParts(source, parts, component.paddingY, padding, 0, componentId(component), native);
	return validNativeRows(native, rows) ? rows : new Map();
}

class NativeRenderFailure { constructor(readonly cause: unknown) {} }
interface TokenRender { token: Native; lines: string[]; inline?: string }
function captureMarkdown(component: Native, original: Function, width: number, nativeToken: Function): { native: string[]; tokens: TokenRender[]; unsupported?: boolean } {
	let tokens: TokenRender[] | undefined = [];
	let scope = renderScope;
	let capturing = true;
	let tokenDepth = 0, inlineDepth = 0;
	let current: TokenRender | undefined;
	const tokenBefore = Object.getOwnPropertyDescriptor(component, "renderToken");
	const inlineBefore = Object.getOwnPropertyDescriptor(component, "renderInlineTokens");
	for (const key of ["renderToken", "renderInlineTokens"]) {
		let owner = component;
		let descriptor: PropertyDescriptor | undefined;
		while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, key))) owner = Object.getPrototypeOf(owner);
		if (descriptor && !("value" in descriptor)) {
			try { return { native: original.call(component, width), tokens: [], unsupported: true }; }
			catch (error) { throw new NativeRenderFailure(error); }
		}
	}
	const tokenNative = component.renderToken, inlineNative = component.renderInlineTokens;
	const supportedToken = typeof nativeToken === "function" && (tokenNative === nativeToken || isPathLabelTokenRenderer(tokenNative, nativeToken));
	const tokenHook = transientHook(tokenNative, function (this: Native, token: Native, ...args: Native[]) {
		if (!capturing || !scope?.session.active || renderScope !== scope) return tokenNative.call(this, token, ...args);
		const root = tokenDepth++ === 0;
		const previous = current;
		const capture = { token, lines: [] } as TokenRender;
		if (root) current = capture;
		try {
			const lines = tokenNative.call(this, token, ...args);
			if (root && supportedToken) { capture.lines = lines; tokens?.push(capture); }
			return lines;
		} finally { tokenDepth--; current = previous; }
	});
	const tokenWrapper = tokenHook.wrapper;
	const inlineHook = transientHook(inlineNative, function (this: Native, ...args: Native[]) {
		if (!capturing || !scope?.session.active || renderScope !== scope) return inlineNative.apply(this, args);
		const root = inlineDepth++ === 0;
		try {
			const text = inlineNative.apply(this, args);
			if (root && tokenDepth === 1 && current && current.inline === undefined) current.inline = text;
			return text;
		} finally { inlineDepth--; }
	});
	const inlineWrapper = inlineHook.wrapper;
	const installed: Array<{ key: string; before?: PropertyDescriptor; owned: PropertyDescriptor }> = [];
	try {
		for (const [key, before, value] of [["renderToken", tokenBefore, tokenWrapper], ["renderInlineTokens", inlineBefore, inlineWrapper]] as const) {
			if (before && !("value" in before)) throw new Error("Accessor render hook");
			const owned = { ...before, value, configurable: before?.configurable ?? true, writable: before?.writable ?? true, enumerable: before?.enumerable ?? false };
			Object.defineProperty(component, key, owned);
			installed.push({ key, before, owned });
		}
		try { return { native: original.call(component, width), tokens: tokens! }; }
		catch (error) { throw new NativeRenderFailure(error); }
	} finally {
		capturing = false; tokenHook.retire(); inlineHook.retire();
		scope = undefined; current = undefined; tokens = undefined;
		for (const { key, before, owned } of installed.reverse()) {
			if (!sameDescriptor(Object.getOwnPropertyDescriptor(component, key), owned)) continue;
			if (before) Object.defineProperty(component, key, before); else delete component[key];
		}
	}
}
function markdownProjection(component: Native, native: string[], tokens: TokenRender[], width: number): Map<number, RowProvenance> {
	if (native.some(line => line.includes(MARKER_START)) || !["paddingX", "paddingY", "theme"].every(key => hasDataLookup(component, key))) return new Map();
	if (component.theme && !hasDataLookup(component.theme, "codeBlockIndent")) return new Map();
	const rows = new Map<number, RowProvenance>();
	const contentWidth = Math.max(1, width - component.paddingX * 2);
	let offset = component.paddingY, logicalBase = 0;
	const id = componentId(component);
	for (const { token, lines, inline } of tokens) {
		const parts = lines.flatMap(line => line.startsWith("\x1b_G") ? [line] : wrapTextWithAnsi(line, contentWidth));
		let mapped = new Map<number, RowProvenance>();
		if (["paragraph", "text", "heading"].includes(token.type) && inline !== undefined) {
			const prefix = token.type === "heading" && token.depth >= 3 ? "#".repeat(token.depth) + " " : "";
			mapped = mapParts((prefix + inline).split(/\r\n|\r|\n/), parts, offset, component.paddingX, 0, id, native);
		} else if (token.type === "code") {
			let start = 0, end = lines.length;
			if (/^[~`]{3}/.test(stripTerminalSequences(lines[0] ?? "").trim())) start++;
			if (lines[end - 1] === "") end--;
			if (/^[~`]{3}/.test(stripTerminalSequences(lines[end - 1] ?? "").trim())) end--;
			const source = lines.slice(start, end);
			const leading = lines.slice(0, start).flatMap(line => wrapTextWithAnsi(line, contentWidth)).length;
			mapped = mapParts(source, source.flatMap(line => wrapTextWithAnsi(line, contentWidth)), offset + leading, component.paddingX, visibleWidth(component.theme?.codeBlockIndent ?? "  "), id, native);
		}
		for (const [row, record] of mapped) rows.set(row, { ...record, logicalLineId: record.logicalLineId + logicalBase });
		logicalBase += mapped.size + 1;
		offset += parts.length;
	}
	return validNativeRows(native, rows) ? rows : new Map();
}

// ─────────────────────────────────────────────────────────────────────────────
// Bind actual completed native frame arrays without changing native bytes

function findScrollViewBox(frame: Native, scroll: Native): Native {
	function visit(box: Native): Native {
		if (box?.scrollView === scroll) return box;
		for (const child of box?.children ?? []) { const found = visit(child); if (found) return found; }
	}
	return visit(frame?.root);
}
function validatedRecord(raw: string, record: RowProvenance): boolean {
	const plain = stripTerminalSequences(raw), index = plain.indexOf(record.visibleText);
	return index >= 0 && /^[ \t└│─]*$/.test(plain.slice(0, index)) && plain.slice(index + record.visibleText.length).trim() === "";
}
// The capability is the exact native returned array. Known composites forward
// only actual child return arrays; no annotation ever enters native strings.
// Source text containing a copied protocol token cannot mint authority.
const nativeCompositeIdentities = new WeakMap<Function, string[]>();
for (const [type, keys] of [
	[Container, ["children"]], [Box, ["children"]], [MouseRegion, ["child"]],
	[ScrollView, ["child"]], [ToolExecutionComponent, ["children", "selfRenderContainer"]],
] as Array<[Native, string[]]>) {
	const method = initialNative(type, "render");
	if (method) nativeCompositeIdentities.set(method, keys);
}
function nativeCompositeKeys(native: Native): string[] {
	return typeof native === "function" ? nativeCompositeIdentities.get(native) ?? [] : [];
}
function compositeKeys(component: Native, native = dataValue(component, "render")): string[] {
	if (component instanceof Text || component instanceof Markdown) return [];
	return nativeCompositeKeys(native).length ? nativeCompositeKeys(native)
		: typeof native === "function" ? getPartForwarderKeys(native) ?? [] : [];
}
function supportedToolRender(native: Function): boolean {
	return !!nativeCompositeKeys(native).length || !!nativeCompositeKeys(getToolRenderDelegate(native)).length;
}

function compositeChildren(component: Native, keys: string[]): Native[] {
	const children = keys.flatMap(key => {
		const value = dataValue(component, key);
		return key === "children" ? (Array.isArray(value) ? value : []) : [value];
	});
	return children.filter(child => {
		if (!child) return false;
		if (typeof dataValue(child, "render") !== "function") throw new Error("Unsupported child render descriptor");
		return true;
	});
}
function renderComposite(session: Session, component: Native, original: Function, args: Native[], keys: string[]): string[] {
	if (!scopeFor(session)) return original.apply(component, args);
	const returned: Array<{ raw: string; record?: RowProvenance }> = [];
	let frame = renderScope?.frame;
	let capturing = true;
	let nativeFailure = false;
	const installed: Array<{ child: Native; before?: PropertyDescriptor; owned: PropertyDescriptor; retire: () => void }> = [];
	try {
		const children = new Set<Native>(compositeChildren(component, keys));
		for (const child of children) {
			const before = Object.getOwnPropertyDescriptor(child, "render"), native = dataValue(child, "render");
			if (typeof native !== "function" || (before && (!("value" in before) || (!before.writable && !before.configurable)))) throw new Error("Unwritable child render");
			const hook = transientHook(native, function (this: Native, ...childArgs: Native[]) {
				if (!capturing || !session.active || renderScope?.frame !== frame) return native.apply(this, childArgs);
				const keys = compositeKeys(this, native);
				const lines = keys.length ? renderComposite(session, this, native, childArgs, keys) : native.apply(this, childArgs);
				const bindings = session.arrays.get(lines);
				for (let row = 0; row < lines.length; row++) {
					const raw = lines[row], binding = bindings?.get(row);
					returned.push({ raw, record: binding && stripTerminalSequences(binding.raw) === stripTerminalSequences(raw) && validatedRecord(raw, binding.record) ? binding.record : undefined });
				}
				return lines;
			});
			const wrapper = hook.wrapper;
			const owned = { ...before, value: wrapper, writable: before?.writable ?? true, configurable: before?.configurable ?? true, enumerable: before?.enumerable ?? false };
			installed.push({ child, before, owned, retire: hook.retire });
			Object.defineProperty(child, "render", owned);
		}
		let lines: string[];
		try { lines = original.apply(component, args); } catch (error) { nativeFailure = true; throw error; }
		const rows = new Map<number, RowProvenance>();
		let cursor = 0;
		for (let row = 0; row < lines.length; row++) {
			const plain = stripTerminalSequences(lines[row]).trimEnd();
			while (cursor < returned.length && !stripTerminalSequences(returned[cursor].raw).trim() && plain.trim()) cursor++;
			const source = returned[cursor];
			if (!source) break;
			const expected = stripTerminalSequences(source.raw).trimEnd();
			if (!plain.endsWith(expected) || !/^[ \t└│─]*$/.test(plain.slice(0, plain.length - expected.length))) continue;
			if (source.record && validatedRecord(lines[row], source.record)) rows.set(row, source.record);
			cursor++;
		}
		return rememberArray(session, lines, rows);
	} catch (error) {
		if (nativeFailure) throw error;
		capturing = false;
		for (const item of installed) item.retire();
		const lines = inNativeRender(() => original.apply(component, args));
		session.arrays.delete(lines);
		return lines;
	}
	finally {
		capturing = false; frame = undefined; returned.length = 0;
		for (const item of installed) item.retire();
		for (const { child, before, owned } of installed.reverse()) {
			if (!sameDescriptor(Object.getOwnPropertyDescriptor(child, "render"), owned)) continue;
			if (before) Object.defineProperty(child, "render", before); else delete child.render;
		}
	}
}
function bindFrame(session: Session, frame: Frame, layout: Native, screen: string[]): void {
	const seen = new Set<string[]>();
	function bind(lines: string[] | undefined) {
		if (!Array.isArray(lines) || seen.has(lines)) return;
		seen.add(lines);
		const bindings = new Map<number, Binding>();
		const capability = session.arrays.get(lines);
		for (let row = 0; row < lines.length; row++) {
			const clean = lines[row], binding = capability?.get(row);
			if (binding && stripTerminalSequences(binding.raw) === stripTerminalSequences(clean) && validatedRecord(clean, binding.record)) bindings.set(row, { raw: clean, record: binding.record });
		}
		if (bindings.size) frame.bindings.set(lines, bindings);
	}
	const screenBindings = new Map<number, Binding>();
	function visit(box: Native) {
		if (!box) return;
		bind(box.lines); bind(box.scrollContentLines);
		// Match the native full-width paint path to its exact source array. Clipped
		// horizontal composites delegate; substring equality is not an authority.
		if (box.lines && box.rect?.x === 0 && box.rect.width >= (renderScope?.terminal.columns ?? Infinity)) {
			for (const [sourceRow, binding] of frame.bindings.get(box.lines) ?? []) {
				const row = sourceRow - (box.lineOffset ?? 0) + box.rect.y;
				if (row >= Math.max(0, box.clip.y) && row < Math.min(screen.length, box.clip.y + box.clip.height) && validatedRecord(screen[row], binding.record)) screenBindings.set(row, { raw: screen[row], record: binding.record });
			}
		}
		for (const child of box.children ?? []) visit(child);
	}
	visit(layout?.root);
	frame.pendingScreen = screenBindings;
}
function renderFrame(session: Session, tui: Native, original: Function, args: Native[]): Native {
	if (!session.active || tui.stopped || !tui.altScreenActive) return inNativeRender(() => original.apply(tui, args));
	const terminal = tui.terminal;
	const before = Object.getOwnPropertyDescriptor(terminal, "write");
	const nativeWrite = dataValue(terminal, "write");
	if (typeof nativeWrite !== "function" || (before && (!("value" in before) || (!before.writable && !before.configurable))) || (!before && !Object.isExtensible(terminal))) {
		session.frames.delete(tui);
		return inNativeRender(() => original.apply(tui, args));
	}
	const frame: Frame = { bindings: new WeakMap() };
	let writing = true;
	const writeHook = transientHook(nativeWrite, function (this: Native, data: Native, ...rest: Native[]) {
		return nativeWrite.call(this, data, ...rest);
	});
	const write = writeHook.wrapper;
	const ownedWrite = { ...before, value: write, configurable: before?.configurable ?? true, writable: before?.writable ?? true, enumerable: before?.enumerable ?? false };
	try { Object.defineProperty(terminal, "write", ownedWrite); }
	catch {
		writing = false; writeHook.retire();
		if (sameDescriptor(Object.getOwnPropertyDescriptor(terminal, "write"), ownedWrite)) {
			if (before) Object.defineProperty(terminal, "write", before); else delete terminal.write;
		}
		session.frames.delete(tui);
		return inNativeRender(() => original.apply(tui, args));
	}
	const previous = renderScope;
	renderScope = { session, frame, tui, terminal, write };
	const rootHooks: Array<{ component: Native; before?: PropertyDescriptor; owned: PropertyDescriptor; retire: () => void }> = [];
	const seen = new Set<object>();
	function visit(component: Native) {
		if (!component || seen.has(component)) return;
		seen.add(component);
		if (component instanceof Text || component instanceof Markdown) return;
		const keys = compositeKeys(component);
		let children: Native[];
		try { children = compositeChildren(component, component instanceof Container ? ["children"] : keys); }
		catch { return; } // Native rendering observes unsupported getters itself.
		for (const child of children) visit(child);
		if (!keys.length || !children.length || component instanceof Container) return;
		const before = Object.getOwnPropertyDescriptor(component, "render"), native = dataValue(component, "render");
		if (before && (!("value" in before) || (!before.writable && !before.configurable))) return;
		const hook = transientHook(native, function (this: Native, ...args: Native[]) { return writing && session.active ? renderComposite(session, this, native, args, keys) : native.apply(this, args); });
		const owned = { ...before, value: hook.wrapper, writable: before?.writable ?? true, configurable: before?.configurable ?? true, enumerable: before?.enumerable ?? false };
		rootHooks.push({ component, before, owned, retire: hook.retire });
		try { Object.defineProperty(component, "render", owned); } catch { hook.retire(); }
	}
	try {
		visit(tui.layoutRoot);
		const result = original.apply(tui, args);
		if (!frame.pendingScreen) bindFrame(session, frame, tui.currentLayout, tui.previousScreen);
		frame.screen = tui.previousScreen;
		frame.layout = tui.currentLayout;
		const bindings = new Map<number, Binding>();
		for (const [row, binding] of frame.pendingScreen ?? []) if (binding.raw === tui.previousScreen[row]) bindings.set(row, binding);
		frame.bindings.set(tui.previousScreen, bindings);
		frame.pendingScreen = undefined;
		if (session.active) session.frames.set(tui, frame);
		return result;
	} catch (error) {
		bindFrame(session, frame, tui.currentLayout, tui.previousScreen);
		session.frames.delete(tui);
		throw error;
	} finally {
		writing = false; writeHook.retire();
		for (const hook of rootHooks) hook.retire();
		seen.clear();
		renderScope = previous;
		for (const { component, before, owned } of rootHooks.reverse()) {
			if (!sameDescriptor(Object.getOwnPropertyDescriptor(component, "render"), owned)) continue;
			if (before) Object.defineProperty(component, "render", before); else delete component.render;
		}
		rootHooks.length = 0;
		if (sameDescriptor(Object.getOwnPropertyDescriptor(terminal, "write"), ownedWrite)) {
			if (before) Object.defineProperty(terminal, "write", before); else delete terminal.write;
		}
	}
}
function selectionText(session: Session, tui: Native, original: Function): string | undefined {
	const native = () => {
		const text = original.call(tui);
		return !session.active || text === undefined ? text : text;
	};
	const frame = session.frames.get(tui);
	if (!session.active || !frame || frame.screen !== tui.previousScreen || frame.layout !== tui.currentLayout) return native();
	const selection = tui.getSelectionBounds();
	if (!selection) return undefined;
	const lines = selection.start.scrollView ? findScrollViewBox(tui.currentLayout, selection.start.scrollView)?.scrollContentLines : tui.previousScreen;
	const bindings = lines && frame.bindings.get(lines);
	if (!bindings) return native();
	let result = "", previous: RowProvenance | undefined;
	for (let row = selection.start.row; row <= selection.end.row; row++) {
		const raw = lines[row] ?? "", binding = bindings.get(row);
		const record = binding?.raw === raw ? binding.record : undefined;
		const columns = tui.getSelectionColumns(raw, row, selection);
		const plain = stripTerminalSequences(raw);
		const index = record ? plain.indexOf(record.visibleText) : -1;
		const contentStart = index >= 0 ? visibleWidth(plain.slice(0, index)) : 0;
		const end = record ? Math.min(columns.end, contentStart + visibleWidth(record.visibleText)) : columns.end;
		const joined = !!record && !!previous && record.componentId === previous.componentId && record.nativeRender === previous.nativeRender && record.logicalLineId === previous.logicalLineId && record.partIndex === previous.partIndex + 1;
		let start = columns.start;
		if (row !== selection.start.row && record) {
			if (joined) start = Math.max(start, record.componentPadding);
			else if (record.blockIndent) start = Math.max(start, contentStart + record.blockIndent);
		}
		let text = stripTerminalSequences(sliceByColumn(raw, start, Math.max(0, end - start), true));
		if (!record) text = text.trimEnd(); // Exact native fallback for unproven rows.
		if (record?.visibleText === "") text = "";
		result += row === selection.start.row ? text : joined ? record!.elidedBefore + text : "\n" + text;
		previous = record;
	}
	return result.length ? result : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transactional installation and exact-owner restoration

function sameDescriptor(a: PropertyDescriptor | undefined, b: PropertyDescriptor): boolean {
	return !!a && a.value === b.value && a.writable === b.writable && a.configurable === b.configurable && a.enumerable === b.enumerable;
}
function restore(session: Session): void {
	session.active = false;
	session.frames = new WeakMap();
	session.arrays = new WeakMap();
	for (const patch of [...session.patches].reverse()) {
		if (!sameDescriptor(Object.getOwnPropertyDescriptor(patch.target, patch.key), patch.owned)) continue;
		if (patch.before) Object.defineProperty(patch.target, patch.key, patch.before); else delete patch.target[patch.key];
	}
	session.patches.length = 0;
}
function installCopyWrappedText(): boolean {
	if (activeSession?.active) return false;
	const text = Text.prototype as Native, md = Markdown.prototype as Native;
	const alt = TuiAltScreen.prototype as Native, main = TuiMainScreen.prototype as Native;
	const composites = [Container.prototype, ToolExecutionComponent.prototype] as Native[];
	const methods: Array<[Native, string]> = [[text, "render"], [md, "render"], [md, "renderToken"], [md, "renderInlineTokens"], [alt, "getActiveSelectionText"], [alt, "getSelectionBounds"], [alt, "getSelectionColumns"], [alt, "beforeTerminalStart"], [alt, "renderNow"], [alt, "doRender"], [alt, "afterTerminalStop"], [alt, "applySelection"], [alt, "applyLineResets"], [main, "renderNow"], [main, "doRender"]];
	methods.push(...composites.map(target => [target, "render"] as [Native, string]));
	if (methods.some(([target, key]) => typeof dataValue(target, key) !== "function")) return false;
	if (!supportedNativeToken(dataValue(md, "renderToken"))) return false;
	if (!initialTextRender || dataValue(text, "render") !== initialTextRender ||
		!initialMarkdownRender || dataValue(md, "render") !== initialMarkdownRender ||
		!initialSelection || dataValue(alt, "getActiveSelectionText") !== initialSelection) return false;
	const counter = (globalThis as Native)[nonceKey] ?? 10000;
	(globalThis as Native)[nonceKey] = counter + 1;
	const session: Session = { active: false, nonce: counter + 1, patches: [], frames: new WeakMap(), arrays: new WeakMap() };
	const projections = new WeakMap<object, Projection>();
	const textProjections = new WeakMap<object, Projection>();
	const installs: Array<[Native, PropertyKey, Native]> = [];
	const originalText = text.render, originalMarkdown = md.render, originalSelection = alt.getActiveSelectionText;
	const markdownToken = md.renderToken, markdownInline = md.renderInlineTokens;
	installs.push([text, ORIGINAL_TEXT_RENDER_KEY, originalText], [md, ORIGINAL_MARKDOWN_RENDER_KEY, originalMarkdown], [alt, ORIGINAL_GET_ACTIVE_SELECTION_TEXT_KEY, originalSelection]);
	for (const target of [text, md, alt, main]) installs.push([target, COPY_WRAPPED_TEXT_PATCHED_KEY, true]);
	installs.push([text, "render", function (this: Native, width: number) {
		const native = originalText.call(this, width);
		if (!scopeFor(session)) return native;
		try {
			let projection = textProjections.get(this);
			if (!projection || projection.native !== native) { projection = { native, rows: textProjection(this, native, width) }; textProjections.set(this, projection); }
			return annotate(session, native, projection.rows);
		} catch { return native; }
	}]);
	installs.push([md, "render", function (this: Native, width: number) {
		if (!scopeFor(session)) return originalMarkdown.call(this, width);
		let rendered: string[] | undefined;
		try {
			const currentToken = Object.getOwnPropertyDescriptor(md, "renderToken")?.value;
			const supportedNative = supportedNativeToken(currentToken) ? currentToken : undefined;
			let { native, tokens, unsupported } = captureMarkdown(this, originalMarkdown, width, supportedNative);
			rendered = native;
			if (unsupported) { projections.delete(this); session.arrays.delete(native); return native; }
			let projection = projections.get(this);
			if (projection?.native !== native) {
				// An uncaptured cache stays authoritative. Plain source can be checked
				// against its existing rows without invoking any renderer again;
				// styled/custom cached output without proof delegates natively.
				const plainNativeCache = supportedNativeToken(markdownToken) && Object.getPrototypeOf(this) === md
					&& dataValue(this, "renderToken") === markdownToken && dataValue(this, "renderInlineTokens") === markdownInline
					&& !["renderToken", "renderInlineTokens", "applyDefaultStyle", "getDefaultInlineStyleContext", "getDefaultStylePrefix"].some(key => Object.hasOwn(this, key))
					&& ["text", "options", "defaultTextStyle", "paddingX", "paddingY"].every(key => hasDataLookup(this, key))
					&& (!dataValue(this, "options") || hasDataLookup(dataValue(this, "options"), "transform"))
					&& !dataValue(dataValue(this, "options"), "transform") && !dataValue(this, "defaultTextStyle")
					&& /^[\p{L}\p{N}][\p{L}\p{M}\p{N} ,.!?;'-]*$/u.test(dataValue(this, "text"));
				projection = { native, rows: tokens.length ? markdownProjection(this, native, tokens, width) : plainNativeCache ? textProjection(this, native, width) : new Map() };
				projections.set(this, projection);
			}
			return annotate(session, native, projection.rows);
		} catch (error) {
			if (error instanceof NativeRenderFailure) throw error.cause;
			projections.delete(this);
			if (rendered) { session.arrays.delete(rendered); return rendered; }
			return originalMarkdown.call(this, width);
		}
	}]);
	for (const target of composites) {
		const original = target.render;
		const supported = target === ToolExecutionComponent.prototype ? supportedToolRender(original) : !!nativeCompositeKeys(original).length;
		installs.push([target, "render", function (this: Native, ...args: Native[]) {
			if (!supported) {
				const lines = inNativeRender(() => original.apply(this, args));
				session.arrays.delete(lines);
				return lines;
			}
			return renderComposite(session, this, original, args, target === ToolExecutionComponent.prototype ? ["children", "selfRenderContainer"] : ["children"]);
		}]);
	}
	for (const key of ["renderNow", "doRender"]) {
		const original = main[key];
		installs.push([main, key, function (this: Native, ...args: Native[]) { return inNativeRender(() => original.apply(this, args)); }]);
	}
	for (const key of ["beforeTerminalStart", "renderNow", "afterTerminalStop"]) {
		const original = alt[key];
		installs.push([alt, key, function (this: Native, ...args: Native[]) {
			if (!session.active) return inNativeRender(() => original.apply(this, args));
			try { return original.apply(this, args); }
			finally { if (key === "afterTerminalStop") session.frames.delete(this); }
		}]);
	}
	const originalApplySelection = alt.applySelection;
	installs.push([alt, "applySelection", function (this: Native, screen: string[], layout: Native = this.currentLayout) {
		const scope = scopeFor(session);
		if (scope && scope.tui === this) scope.frame.layout = layout;
		return originalApplySelection.call(this, screen, layout);
	}]);
	const originalLineResets = alt.applyLineResets;
	installs.push([alt, "applyLineResets", function (this: Native, ...args: Native[]) {
		const screen = originalLineResets.apply(this, args);
		const scope = scopeFor(session);
		if (scope && scope.tui === this) bindFrame(session, scope.frame, scope.frame.layout, screen);
		return screen;
	}]);
	const originalDoRender = alt.doRender;
	installs.push([alt, "doRender", function (this: Native, ...args: Native[]) { return renderFrame(session, this, originalDoRender, args); }]);
	installs.push([alt, "getActiveSelectionText", function (this: Native) {
		return session.active ? selectionText(session, this, originalSelection) : originalSelection.call(this);
	}]);
	for (const [target, key] of installs) {
		const before = Object.getOwnPropertyDescriptor(target, key);
		if (before ? !("value" in before) || (!before.configurable && !before.writable) : !Object.isExtensible(target)) return false;
	}
	try {
		for (const [target, key, value] of installs) {
			const before = Object.getOwnPropertyDescriptor(target, key);
			const owned = { ...before, value, writable: before?.writable ?? true, configurable: before?.configurable ?? true, enumerable: before?.enumerable ?? false };
			session.patches.push({ target, key, before, owned });
			Object.defineProperty(target, key, owned);
		}
		session.active = true;
		activeSession = session;
		return true;
	} catch { restore(session); return false; }
}
export function applyCopyWrappedText(): boolean {
	try { return installCopyWrappedText(); } catch { return false; }
}
export function restoreCopyWrappedText(): boolean {
	if (!activeSession?.active) return false;
	const session = activeSession;
	activeSession = undefined;
	restore(session);
	return true;
}
export default function rbfCopyWrappedText(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => { if (ctx.hasUI) applyCopyWrappedText(); });
	pi.on("session_shutdown", () => { restoreCopyWrappedText(); });
}
