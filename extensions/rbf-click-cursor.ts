import { Editor, visibleWidth } from "@earendil-works/pi-tui";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CLICK_CURSOR_PATCHED_KEY = Symbol.for("rbf.clickCursor.patched");
export const ORIGINAL_HANDLE_MOUSE_KEY = Symbol.for("rbf.clickCursor.originalHandleMouse");

/**
 * Calculate the target logical line and column for a mouse coordinate within an Editor instance.
 */
export function calculateEditorCursorFromMouse(
	editor: any,
	event: Pick<TuiMouseEvent, "x" | "y" | "width">,
): { line: number; col: number } | undefined {
	if (event.y <= 0 || event.y > (editor.renderedVisibleLineCount ?? 1)) {
		return undefined;
	}

	const width = editor.lastWidth > 0 ? editor.lastWidth : Math.max(1, event.width || 80);
	const visualLines = typeof editor.buildVisualLineMap === "function"
		? editor.buildVisualLineMap(width)
		: undefined;

	if (!visualLines || visualLines.length === 0) {
		return undefined;
	}

	const visualLineIndex = (editor.scrollOffset ?? 0) + event.y - 1;
	const visualLine = visualLines[visualLineIndex];
	if (!visualLine) {
		return undefined;
	}

	const logicalLine = editor.state?.lines?.[visualLine.logicalLine] ?? "";
	const chunkEnd = visualLine.startCol + visualLine.length;
	const chunk = logicalLine.slice(visualLine.startCol, chunkEnd);

	const maxPadding = Math.max(0, Math.floor(((event.width || width) - 1) / 2));
	const paddingX = Math.min(editor.paddingX ?? 0, maxPadding);
	const targetColumn = Math.max(0, event.x - paddingX);

	let visibleColumn = 0;
	let targetIndex = chunk.length;
	let lastGraphemeIndex = 0;

	const segments: Array<{ segment: string; index: number }> =
		typeof editor.segment === "function"
			? Array.from(editor.segment(chunk, "grapheme"))
			: Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(chunk));

	for (const grapheme of segments) {
		const nextColumn = visibleColumn + visibleWidth(grapheme.segment);
		lastGraphemeIndex = grapheme.index;
		if (targetColumn < nextColumn) {
			targetIndex = grapheme.index;
			break;
		}
		visibleColumn = nextColumn;
	}

	const isLastSegment =
		visualLineIndex === visualLines.length - 1 ||
		visualLines[visualLineIndex + 1]?.logicalLine !== visualLine.logicalLine;

	if (!isLastSegment && targetIndex === chunk.length && chunk.length > 0) {
		targetIndex = lastGraphemeIndex;
	}

	return {
		line: visualLine.logicalLine,
		col: visualLine.startCol + targetIndex,
	};
}

/**
 * Patch Editor.prototype.handleMouse so left clicks and presses accurately place the cursor,
 * clear stray text selections, and immediately trigger a screen repaint.
 */
export function applyClickCursor(): boolean {
	const proto = Editor.prototype as any;
	if (proto[CLICK_CURSOR_PATCHED_KEY]) {
		return false;
	}

	const originalHandleMouse = proto.handleMouse;
	proto[ORIGINAL_HANDLE_MOUSE_KEY] = originalHandleMouse;

	proto.handleMouse = function (this: any, event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// 1. Forward clicks in active autocomplete menu
		const autocompleteStartRow = (this.renderedVisibleLineCount ?? 1) + 2;
		if (
			this.autocompleteState &&
			this.autocompleteList &&
			event.y >= autocompleteStartRow &&
			event.y < autocompleteStartRow + (this.renderedAutocompleteHeight ?? 0)
		) {
			const maxPadding = Math.max(0, Math.floor((event.width - 1) / 2));
			const paddingX = Math.min(this.paddingX ?? 0, maxPadding);
			const contentWidth = Math.max(1, event.width - paddingX * 2);
			const result = this.autocompleteList.handleMouse?.({
				...event,
				x: event.x - paddingX,
				y: event.y - autocompleteStartRow,
				width: contentWidth,
				height: this.renderedAutocompleteHeight,
			});
			if (result) {
				this.tui?.requestRender?.();
				return { ...result, focus: true, render: true };
			}
			return undefined;
		}

		// 2. Only handle left button clicks or release/click where button is none
		const isLeft = event.button === "left";
		const isReleaseOrClickNone =
			event.button === "none" && (event.type === "click" || event.type === "release");
		if (!isLeft && !isReleaseOrClickNone) {
			return undefined;
		}

		// 3. Filter event types: handle press, click, drag, and release
		if (
			event.type !== "press" &&
			event.type !== "click" &&
			event.type !== "drag" &&
			event.type !== "release"
		) {
			return undefined;
		}

		// Acknowledge release events cleanly
		if (event.type === "release") {
			this.tui?.requestRender?.();
			return { handled: true, focus: true, render: true };
		}

		// 4. Boundary clicks on top or bottom border focus the editor and trigger repaint
		if (event.y <= 0 || event.y > (this.renderedVisibleLineCount ?? 1)) {
			this.tui?.requestRender?.();
			return { handled: true, focus: true, render: true };
		}

		// 5. Calculate cursor position and update editor state
		const pos = calculateEditorCursorFromMouse(this, event);
		if (pos) {
			this.state.cursorLine = pos.line;
			if (typeof this.setCursorCol === "function") {
				this.setCursorCol(pos.col);
			} else {
				this.state.cursorCol = pos.col;
			}

			this.lastAction = null;
			this.exitHistoryBrowsing?.();

			if (this.autocompleteState) {
				this.updateAutocomplete?.();
			}
		}

		// Clear any accidental selection in TUI
		if (typeof this.tui?.clearTextSelection === "function") {
			this.tui.clearTextSelection();
		}

		// Immediately trigger screen repaint so the cursor movement is visible
		this.tui?.requestRender?.();

		return { handled: true, focus: true, render: true };
	};

	proto[CLICK_CURSOR_PATCHED_KEY] = true;
	return true;
}

/**
 * Restore Editor.prototype.handleMouse to its unpatched original implementation.
 */
export function restoreClickCursor(): boolean {
	const proto = Editor.prototype as any;
	if (!proto[CLICK_CURSOR_PATCHED_KEY]) {
		return false;
	}

	if (proto[ORIGINAL_HANDLE_MOUSE_KEY]) {
		proto.handleMouse = proto[ORIGINAL_HANDLE_MOUSE_KEY];
		delete proto[ORIGINAL_HANDLE_MOUSE_KEY];
	}
	delete proto[CLICK_CURSOR_PATCHED_KEY];
	return true;
}

export default function rbfClickCursor(_pi?: ExtensionAPI): void {
	applyClickCursor();
}
