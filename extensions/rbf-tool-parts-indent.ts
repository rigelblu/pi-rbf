import { BashExecutionComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Container, MouseRegion, Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

const FALLBACK_THEME = {
	fg: (_col: string, s: string) => s,
	bg: (_col: string, s: string) => s,
	bold: (s: string) => s,
};

/** Below this many pane columns no row is indented: every piece this extension adds draws as a pass-through. */
export const MIN_PANE_COLUMNS = 20;

/**
 * The one mark that answers "already regrouped". It is a `Symbol.for` property and never an `instanceof`,
 * so a piece made by an earlier import of this module is still recognized after `/reload`.
 */
export const PIECE_KEY = Symbol.for("rbf.toolPartsIndent.piece");

/** Where a row's render wrapper records whether the pane is at least 20 columns wide. A symbol, so it can't clash with a field of Pi's. */
export const PANE_WIDE_KEY = Symbol.for("rbf.toolPartsIndent.paneWide");

/** The row a piece belongs to. */
type Pane = { [PANE_WIDE_KEY]?: boolean };
/** A part of a row that can say whether it drew a line under the header. */
type Drawn = { drew(): boolean };
type Render = (this: any, width: number) => string[];

/**
 * Retrieve the active theme from Pi's global symbol registration.
 */
export function getActiveTheme(): any {
	return (
		(globalThis as any)[Symbol.for("@earendil-works/pi-coding-agent:theme")] ??
		(globalThis as any)[Symbol.for("@mariozechner/pi-coding-agent:theme")] ??
		FALLBACK_THEME
	);
}

/**
 * A drawn row is blank when it has no visible cell other than a space
 * once escape sequences are stripped.
 */
export function isBlankRow(line: string): boolean {
	return stripTerminalSequences(line).trim().length === 0;
}

const SGR_ESCAPES = /\x1b\[[0-9;:]*m/g;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * A row's width in terminal cells, exact. A row of printable ASCII and SGR colour escapes is as wide as its length
 * with those escapes cut, which is what pi-tui's `visibleWidth` returns for it, at a fraction of the cost.
 * Any other row goes to `visibleWidth` unchanged: a tab, a control character, a wide or combining character,
 * an emoji, a hyperlink, any other escape sequence, a lone ESC.
 */
export function rowWidth(row: string): number {
	const bare = row.includes("\x1b") ? row.replace(SGR_ESCAPES, "") : row;
	return PRINTABLE_ASCII.test(bare) ? bare.length : visibleWidth(row);
}

function startsWithBranch(line: string): boolean {
	return stripTerminalSequences(line).trimStart().startsWith("└");
}

function isPiece(part: any): boolean {
	return !!part && part[PIECE_KEY] === true;
}

/** A piece with no row to ask, as in a unit test, is indented. */
function paneIsWide(pane: Pane | undefined): boolean {
	return !pane || pane[PANE_WIDE_KEY] !== false;
}

function sameRows(a: string[][], b: string[][]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i]!;
		const y = b[i]!;
		if (x.length !== y.length) return false;
		for (let j = 0; j < x.length; j++) {
			if (x[j] !== y[j]) return false;
		}
	}
	return true;
}

/**
 * Reads horizontal padding from a component (Text paddingX or first text child paddingX).
 * Returns 0 if none found.
 */
export function getPartPaddingX(part: any): number {
	if (!part) return 0;
	if (part instanceof Text || (typeof part.paddingX === "number" && !(part instanceof Box))) {
		return (part as any).paddingX ?? 0;
	}
	if (part instanceof Container && Array.isArray((part as any).children)) {
		for (const child of (part as any).children) {
			if (child instanceof Text) {
				return (child as any).paddingX ?? 0;
			}
			const p = getPartPaddingX(child);
			if (p !== 0) return p;
		}
	}
	return 0;
}

/**
 * `parts`: the lines under a header. `header` and `summary`: the edit row's left margin, which drops no row and
 * adds no branch. A header margin never counts as a drawn line. A summary margin counts when its first row starts with `└`.
 */
type PartsMode = "parts" | "header" | "summary";

type ChildRows = { start: number; height: number; dropped: number; rows: number };

/**
 * Component that draws lines under a header with an indent prefix and branch symbol.
 * Contains every throw and overflow.
 */
export class IndentedParts implements Component {
	readonly [PIECE_KEY] = true;
	children: Component[];
	prefixWidth: number;
	branchPrefix: string;
	otherPrefix: string;
	before?: Drawn;
	pane?: Pane;
	mode: PartsMode;

	/** Rows returned by the last draw, fallback draws included. */
	private rowCount = 0;
	private firstIsBranch = false;
	/** The last draw added no prefix: a narrow pane, an overflow, or a throw. */
	private flat = false;
	private childRows: ChildRows[] = [];
	/** The last output and what it was drawn from. A draw that finds all three unchanged returns `out` and measures nothing. */
	private cache?: { width: number; before: boolean; rendered: string[][]; out: string[] };

	constructor(
		children: Component[],
		prefixWidth: number,
		branchPrefix: string,
		otherPrefix: string,
		before?: Drawn,
		pane?: Pane,
		mode: PartsMode = "parts",
	) {
		this.children = children;
		this.prefixWidth = prefixWidth;
		this.branchPrefix = branchPrefix;
		this.otherPrefix = otherPrefix;
		this.before = before;
		this.pane = pane;
		this.mode = mode;
	}

	drew(): boolean {
		if (this.mode === "header") return false;
		if (this.mode === "summary") return this.rowCount > 0 && this.firstIsBranch;
		return this.rowCount > 0 || (this.before ? this.before.drew() : false);
	}

	invalidate(): void {
		this.cache = undefined;
		this.rowCount = 0;
		this.firstIsBranch = false;
		this.childRows = [];
		for (const child of this.children) {
			try {
				child.invalidate?.();
			} catch {}
		}
	}

	/** As `Box.handleMouse`: shift by what the last draw put in front, pick the child by its drawn rows, pass its own row count as `height`. */
	handleMouse(event: any): any {
		try {
			const shift = this.flat ? 0 : this.prefixWidth;
			if (event.x < shift) return undefined;
			for (let i = 0; i < this.children.length; i++) {
				const at = this.childRows[i];
				if (!at || event.y < at.start || event.y >= at.start + at.height) continue;
				return (this.children[i] as any).handleMouse?.({
					...event,
					x: event.x - shift,
					y: event.y - at.start + at.dropped,
					width: event.width !== undefined ? event.width - shift : undefined,
					height: at.rows,
				});
			}
			return undefined;
		} catch {
			return undefined;
		}
	}

	render(width: number): string[] {
		try {
			const childWidth = width - this.prefixWidth;
			if (!paneIsWide(this.pane) || this.prefixWidth === 0 || childWidth <= 0) {
				return this.drawFlat(width);
			}

			const before = this.mode === "parts" && !!this.before?.drew();
			const rendered: string[][] = [];
			for (const child of this.children) {
				rendered.push(child.render(childWidth));
			}
			const cache = this.cache;
			if (cache && cache.width === width && cache.before === before && sameRows(cache.rendered, rendered)) {
				return cache.out;
			}
			const key = { width, before, rendered: rendered.map((rows) => rows.slice()) };

			// A margin drops no row and adds no branch. A part after one that drew keeps its blank rows and takes spaces only.
			let dropping = this.mode === "parts" && !before;
			let branchTaken = this.mode !== "parts" || before;
			const out: string[] = [];
			const childRows: ChildRows[] = [];
			for (const rows of rendered) {
				const start = out.length;
				let dropped = 0;
				for (const row of rows) {
					if (dropping) {
						if (isBlankRow(row)) {
							dropped++;
							continue;
						}
						dropping = false;
					}
					let prefix = this.otherPrefix;
					if (!branchTaken) {
						branchTaken = true;
						if (!startsWithBranch(row)) prefix = this.branchPrefix;
					}
					out.push(prefix + row);
				}
				childRows.push({ start, height: out.length - start, dropped, rows: rows.length });
			}

			for (const row of out) {
				if (rowWidth(row) > width) {
					return this.drawFlat(width);
				}
			}

			this.flat = false;
			this.childRows = childRows;
			this.record(out);
			this.cache = { ...key, out };
			return out;
		} catch {
			return this.drawFlat(width);
		}
	}

	/** The children's rows at the full width with no prefix. A child that throws here contributes no rows. Nothing of it is kept for the next draw. */
	private drawFlat(width: number): string[] {
		const out: string[] = [];
		const childRows: ChildRows[] = [];
		for (const child of this.children) {
			let rows: string[] = [];
			try {
				rows = child.render(width);
			} catch {}
			childRows.push({ start: out.length, height: rows.length, dropped: 0, rows: rows.length });
			for (const row of rows) out.push(row);
		}
		this.flat = true;
		this.childRows = childRows;
		this.record(out);
		this.cache = undefined;
		return out;
	}

	private record(out: string[]): void {
		this.rowCount = out.length;
		this.firstIsBranch = this.mode === "summary" && out.length > 0 && startsWithBranch(out[0]!);
	}
}

/** The two prefixes for lines that start `width` columns in: `lead`, a dim `└`, and spaces on the branch line, spaces on the rest. */
function createParts(children: Component[], width: number, lead: string, before?: Drawn, pane?: Pane): IndentedParts {
	const branch = lead + getActiveTheme().fg("dim", "└") + " ".repeat(Math.max(0, width - lead.length - 1));
	return new IndentedParts(children, width, branch, " ".repeat(width), before, pane);
}

/**
 * Creates a margin component for edit header or summary.
 */
export function createMargin(child: Component, m: number, isSummary: boolean, pane?: Pane): IndentedParts {
	const spaces = " ".repeat(Math.max(0, m));
	return new IndentedParts([child], m, spaces, spaces, undefined, pane, isSummary ? "summary" : "header");
}

/**
 * Puts a result region's part under the header, `columns` in, less what the part pads itself.
 * Does nothing when the region is already regrouped or its part pads itself by something other than 0 or 1.
 */
function indentResultRegion(region: any, columns: number, lead: string, before: Drawn | undefined, pane: Pane): void {
	if (!(region instanceof MouseRegion) || isPiece((region as any).child)) return;
	const pad = getPartPaddingX((region as any).child);
	if (pad !== 0 && pad !== 1) return;
	(region as any).child = createParts([(region as any).child], columns - pad, lead, before, pane);
}

/**
 * SplitText for the write tool row: holds the reused Text, cuts at the first blank line,
 * drawing the first piece at full width and the rest through an IndentedParts.
 * It keeps its own two texts and sets them only when the source string changed, so their wrapped rows stay cached.
 */
export class SplitText implements Component {
	readonly [PIECE_KEY] = true;
	textComponent: Text;
	indentedParts: IndentedParts;
	pane?: Pane;

	private header = new Text("", 0, 0);
	private content = new Text("", 0, 0);
	private source?: string;
	/** The source string holds a blank line to cut at. */
	private split = false;
	/** The last draw cut the text: the content went through `indentedParts`. */
	private cut = false;
	private headerRows = 0;
	private contentRows = 0;

	constructor(textComponent: Text, branchPrefix: string, otherPrefix: string, pane?: Pane) {
		this.textComponent = textComponent;
		this.pane = pane;
		this.indentedParts = new IndentedParts([this.content], 3, branchPrefix, otherPrefix, undefined, pane);
	}

	drew(): boolean {
		return this.cut && this.indentedParts.drew();
	}

	invalidate(): void {
		this.source = undefined;
		try {
			this.textComponent.invalidate?.();
		} catch {}
		this.header.invalidate();
		this.indentedParts.invalidate();
	}

	handleMouse(event: any): any {
		try {
			if (!this.cut || event.y < this.headerRows) return undefined;
			return this.indentedParts.handleMouse({ ...event, y: event.y - this.headerRows, height: this.contentRows });
		} catch {
			return undefined;
		}
	}

	render(width: number): string[] {
		this.cut = false;
		try {
			if (!paneIsWide(this.pane)) {
				return this.textComponent.render(width);
			}
			const source: string = (this.textComponent as any).text ?? "";
			if (source !== this.source) {
				const lines = source.split("\n");
				const at = lines.findIndex(isBlankRow);
				if (at !== -1) {
					this.header.setText(lines.slice(0, at).join("\n"));
					this.content.setText(lines.slice(at + 1).join("\n"));
				}
				this.split = at !== -1;
				this.source = source;
			}
			if (!this.split) {
				return this.textComponent.render(width);
			}
			const headerLines = this.header.render(width);
			const contentLines = this.indentedParts.render(width);
			this.headerRows = headerLines.length;
			this.contentRows = contentLines.length;
			this.cut = true;
			return headerLines.concat(contentLines);
		} catch {
			this.source = undefined;
			try {
				return this.textComponent.render(width);
			} catch {
				return [];
			}
		}
	}
}

/**
 * Regroup a ToolExecutionComponent instance according to the row-shape specification.
 */
export function regroupRow(row: any): void {
	if (!row || typeof row.hasRendererDefinition !== "function" || !row.hasRendererDefinition()) {
		return;
	}
	const selfShell = row.getRenderShell() === "self";

	// 1. edit and codex_patch, drawn in the unpadded container
	if (selfShell && (row.toolName === "edit" || row.toolName === "codex_patch")) {
		const container = row.selfRenderContainer;
		if (!container || !Array.isArray(container.children)) {
			return;
		}
		const callRegion = container.children[0] as any;
		if (!(callRegion instanceof MouseRegion)) {
			return;
		}
		const callBox = (callRegion as any).child as any;
		if (!(callBox instanceof Box) || callBox.children.length === 0) {
			return;
		}
		const paddingX = (callBox as any).paddingX;
		if (paddingX !== 0 && paddingX !== 1) {
			return;
		}

		let lastPartUnderHeader: Drawn | undefined;
		if (isPiece(callBox.children[0])) {
			lastPartUnderHeader = callBox.children.length > 1 ? (callBox.children[callBox.children.length - 1] as any) : undefined;
		} else {
			const m = 1 - paddingX;
			const [header, second, ...others] = callBox.children as any[];
			const regrouped: Component[] = [createMargin(header, m, false, row)];
			if (second) {
				const isSummary = second instanceof Text && startsWithBranch((second as any).text ?? "");
				if (isSummary) {
					const summary = createMargin(second, m, true, row);
					regrouped.push(summary);
					lastPartUnderHeader = summary;
					if (others.length > 0) {
						const diff = createParts(others, 4, " ", summary, row);
						regrouped.push(diff);
						lastPartUnderHeader = diff;
					}
				} else {
					const parts = createParts([second, ...others], 3 + m, m === 1 ? " " : "", undefined, row);
					regrouped.push(parts);
					lastPartUnderHeader = parts;
				}
			}
			callBox.children = regrouped;
		}
		indentResultRegion(container.children[1], 4, " ", lastPartUnderHeader, row);
		return;
	}

	// Any other tool that draws in the unpadded container is not in the row-shape list.
	if (selfShell) {
		return;
	}

	const contentBox = row.contentBox;
	if (!contentBox || !(contentBox instanceof Box) || !Array.isArray(contentBox.children)) {
		return;
	}
	if (contentBox.children.length === 0 || contentBox.children.length > 2) {
		return;
	}
	const callRegion = contentBox.children[0] as any;
	if (!(callRegion instanceof MouseRegion)) {
		return;
	}
	const callChild = (callRegion as any).child as any;
	const resultRegion = contentBox.children[1];

	// 2. write: the call text splits at its first blank line
	if (row.toolName === "write") {
		let splitText: Drawn | undefined = isPiece(callChild) ? callChild : undefined;
		if (!splitText && callChild instanceof Text && !(callChild as any).customBgFn) {
			const dimBranch = getActiveTheme().fg("dim", "└") + "  ";
			splitText = (callRegion as any).child = new SplitText(callChild, dimBranch, "   ", row);
		}
		if (splitText) {
			indentResultRegion(resultRegion, 3, "", splitText, row);
			return;
		}
	}

	// 3. codex_tool: the call container's first child is the header
	if (row.toolName === "codex_tool" && callChild instanceof Container && !(callChild instanceof Box) && callChild.children.length > 1) {
		let callParts = callChild.children[1] as any;
		if (!isPiece(callParts)) {
			const [header, ...rest] = callChild.children;
			callParts = createParts(rest, 3, "", undefined, row);
			callChild.children = [header!, callParts];
		}
		indentResultRegion(resultRegion, 3, "", callParts, row);
		return;
	}

	// 4. Default tool row (including codex_command, codex_question, bash, and an edit drawn in the padded box)
	indentResultRegion(resultRegion, 3, "", undefined, row);
}

/**
 * Regroup a BashExecutionComponent (! or !!) instance.
 */
export function regroupUserShellRow(row: any): void {
	if (!row || !(row instanceof BashExecutionComponent)) {
		return;
	}
	const content = (row as any).contentContainer;
	if (!content || !Array.isArray(content.children) || content.children.length <= 1) {
		return;
	}
	if (isPiece(content.children[1])) {
		return;
	}
	const [header, ...rest] = content.children;
	content.children = [header, createParts(rest, 3, " ", undefined, row as Pane)];
}

export const TOOL_PARTS_INDENT_IMPL_KEY = Symbol.for("rbf.toolPartsIndent.toolImpl");
export const BASH_PARTS_INDENT_IMPL_KEY = Symbol.for("rbf.toolPartsIndent.bashImpl");
export const ORIG_TOOL_RENDER_KEY = Symbol.for("rbf.toolPartsIndent.origToolRender");
export const ORIG_BASH_RENDER_KEY = Symbol.for("rbf.toolPartsIndent.origBashRender");
export const TOOL_RENDER_WRAPPED_KEY = Symbol.for("rbf.toolPartsIndent.toolWrapped");
export const BASH_RENDER_WRAPPED_KEY = Symbol.for("rbf.toolPartsIndent.bashWrapped");

const hasOwn = (target: any, key: PropertyKey) => Object.prototype.hasOwnProperty.call(target, key);

/** What a wrapper runs while the extension is loaded: record the pane on the row, regroup it, draw the render it replaced. */
function createImpl(regroup: (row: any) => void) {
	return function (this: any, width: number, original: Render): string[] {
		this[PANE_WIDE_KEY] = width >= MIN_PANE_COLUMNS;
		try {
			regroup(this);
		} catch {}
		return original.call(this, width);
	};
}

/**
 * Puts one wrapper on `proto.render`. The wrapper holds the render it replaced, so it can always call a real one:
 * with the extension torn down, under another extension's wrapper, or after a new factory call.
 * A prototype with no `render` of its own, the user shell row, reaches the inherited one through its parent.
 */
function installWrapper(proto: any, wrappedKey: symbol, origKey: symbol, implKey: symbol): void {
	// Ours is in place, or sits under another wrapper that still calls it. Wrapping again would stack.
	if (hasOwn(proto, wrappedKey) && hasOwn(proto, "render")) {
		return;
	}
	const own: Render | undefined = hasOwn(proto, "render") ? proto.render : undefined;
	const original: Render =
		own ??
		function (this: any, width: number): string[] {
			return Object.getPrototypeOf(proto).render.call(this, width);
		};
	const wrapper = function (this: any, width: number): string[] {
		const impl = (globalThis as any)[implKey];
		return typeof impl === "function" ? impl.call(this, width, original) : original.call(this, width);
	};
	proto.render = wrapper;
	proto[wrappedKey] = wrapper;
	proto[origKey] = own;
}

/** Puts back the render the wrapper replaced, only when the function in place is still the wrapper. Otherwise the wrapper stays whole. */
function removeWrapper(proto: any, wrappedKey: symbol, origKey: symbol): void {
	if (!hasOwn(proto, wrappedKey) || proto.render !== proto[wrappedKey]) {
		return;
	}
	if (proto[origKey]) {
		proto.render = proto[origKey];
	} else {
		delete proto.render;
	}
	delete proto[wrappedKey];
	delete proto[origKey];
}

/**
 * Install render wrappers on ToolExecutionComponent and BashExecutionComponent.
 */
export function applyToolPartsIndent(): boolean {
	(globalThis as any)[TOOL_PARTS_INDENT_IMPL_KEY] = createImpl(regroupRow);
	(globalThis as any)[BASH_PARTS_INDENT_IMPL_KEY] = createImpl(regroupUserShellRow);
	installWrapper(ToolExecutionComponent.prototype, TOOL_RENDER_WRAPPED_KEY, ORIG_TOOL_RENDER_KEY, TOOL_PARTS_INDENT_IMPL_KEY);
	installWrapper(BashExecutionComponent.prototype, BASH_RENDER_WRAPPED_KEY, ORIG_BASH_RENDER_KEY, BASH_PARTS_INDENT_IMPL_KEY);
	return true;
}

/**
 * Remove render wrappers and implementation handlers.
 */
export function restoreToolPartsIndent(): boolean {
	delete (globalThis as any)[TOOL_PARTS_INDENT_IMPL_KEY];
	delete (globalThis as any)[BASH_PARTS_INDENT_IMPL_KEY];
	removeWrapper(ToolExecutionComponent.prototype, TOOL_RENDER_WRAPPED_KEY, ORIG_TOOL_RENDER_KEY);
	removeWrapper(BashExecutionComponent.prototype, BASH_RENDER_WRAPPED_KEY, ORIG_BASH_RENDER_KEY);
	return true;
}

export default function rbfToolPartsIndent(pi?: ExtensionAPI): void {
	applyToolPartsIndent();
	if (pi && typeof pi.on === "function") {
		pi.on("session_shutdown", () => {
			restoreToolPartsIndent();
		});
	}
}
