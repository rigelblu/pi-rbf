import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@earendil-works/pi-tui";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import rbfClickCursor, {
	applyClickCursor,
	calculateEditorCursorFromMouse,
	CLICK_CURSOR_PATCHED_KEY,
	ORIGINAL_HANDLE_MOUSE_KEY,
	restoreClickCursor,
} from "./rbf-click-cursor.ts";

function createMockTui() {
	return {
		terminal: { rows: 24, columns: 80 },
		requestRender: vi.fn(),
		clearTextSelection: vi.fn(),
	};
}

const mockTheme = {
	borderColor: (s: string) => s,
};

describe("rbf-click-cursor extension", () => {
	beforeEach(() => {
		restoreClickCursor();
	});

	afterEach(() => {
		restoreClickCursor();
	});

	describe("calculateEditorCursorFromMouse helper", () => {
		it("calculates start, middle, and end of single-line text", () => {
			const mockTui = createMockTui();
			const editor = new Editor(mockTui as any, mockTheme as any);
			editor.setText("Hello world");
			editor.render(80);

			// y = 1 is the first text line (y = 0 is top border)
			const atStart = calculateEditorCursorFromMouse(editor, { x: 0, y: 1, width: 80 });
			expect(atStart).toEqual({ line: 0, col: 0 });

			const atMiddle = calculateEditorCursorFromMouse(editor, { x: 5, y: 1, width: 80 });
			expect(atMiddle).toEqual({ line: 0, col: 5 });

			const atEnd = calculateEditorCursorFromMouse(editor, { x: 11, y: 1, width: 80 });
			expect(atEnd).toEqual({ line: 0, col: 11 });

			// Click past the end of line clamps to line length
			const pastEnd = calculateEditorCursorFromMouse(editor, { x: 40, y: 1, width: 80 });
			expect(pastEnd).toEqual({ line: 0, col: 11 });
		});

		it("returns undefined for clicks on border or outside visible lines", () => {
			const mockTui = createMockTui();
			const editor = new Editor(mockTui as any, mockTheme as any);
			editor.setText("Sample");
			editor.render(80);

			// y = 0 is top border
			expect(calculateEditorCursorFromMouse(editor, { x: 0, y: 0, width: 80 })).toBeUndefined();

			// y = 2 is bottom border (single line editor has renderedVisibleLineCount = 1)
			expect(calculateEditorCursorFromMouse(editor, { x: 0, y: 2, width: 80 })).toBeUndefined();
		});

		it("handles multiline prompts across distinct rows", () => {
			const mockTui = createMockTui();
			const editor = new Editor(mockTui as any, mockTheme as any);
			editor.setText("First line\nSecond line\nThird line");
			editor.render(80);

			// Line 1 (y = 1)
			const line1 = calculateEditorCursorFromMouse(editor, { x: 2, y: 1, width: 80 });
			expect(line1).toEqual({ line: 0, col: 2 });

			// Line 2 (y = 2)
			const line2 = calculateEditorCursorFromMouse(editor, { x: 7, y: 2, width: 80 });
			expect(line2).toEqual({ line: 1, col: 7 });

			// Line 3 (y = 3)
			const line3 = calculateEditorCursorFromMouse(editor, { x: 5, y: 3, width: 80 });
			expect(line3).toEqual({ line: 2, col: 5 });
		});

		it("accounts for horizontal padding (paddingX)", () => {
			const mockTui = createMockTui();
			const editor = new Editor(mockTui as any, mockTheme as any, { paddingX: 3 });
			editor.setText("Padded text");
			editor.render(80);

			// x = 3 corresponds to the first character because paddingX = 3
			const atStart = calculateEditorCursorFromMouse(editor, { x: 3, y: 1, width: 80 });
			expect(atStart).toEqual({ line: 0, col: 0 });

			// x = 0 (clicked inside left padding) clamps to column 0
			const inPadding = calculateEditorCursorFromMouse(editor, { x: 1, y: 1, width: 80 });
			expect(inPadding).toEqual({ line: 0, col: 0 });

			// x = 7 corresponds to column 4
			const atCol4 = calculateEditorCursorFromMouse(editor, { x: 7, y: 1, width: 80 });
			expect(atCol4).toEqual({ line: 0, col: 4 });
		});

		it("handles fullwidth multi-column graphemes accurately", () => {
			const mockTui = createMockTui();
			const editor = new Editor(mockTui as any, mockTheme as any);
			editor.setText("🚀 rocket");
			editor.render(80);

			// Clicking at x = 0 or 1 selects before the 2-column emoji
			expect(calculateEditorCursorFromMouse(editor, { x: 0, y: 1, width: 80 })).toEqual({
				line: 0,
				col: 0,
			});
			expect(calculateEditorCursorFromMouse(editor, { x: 1, y: 1, width: 80 })).toEqual({
				line: 0,
				col: 0,
			});

			// Clicking at x = 2 selects immediately after the emoji (before space)
			// Note: "🚀" is 2 UTF-16 code units (surrogate pair)
			const afterEmoji = calculateEditorCursorFromMouse(editor, { x: 2, y: 1, width: 80 });
			expect(afterEmoji?.col).toBe("🚀".length);
		});
	});

	describe("lifecycle and idempotency", () => {
		it("applies patch and sets symbols on Editor.prototype", () => {
			expect((Editor.prototype as any)[CLICK_CURSOR_PATCHED_KEY]).toBeUndefined();
			const applied = applyClickCursor();
			expect(applied).toBe(true);
			expect((Editor.prototype as any)[CLICK_CURSOR_PATCHED_KEY]).toBe(true);
			expect((Editor.prototype as any)[ORIGINAL_HANDLE_MOUSE_KEY]).toBeDefined();

			// Idempotent: second call returns false
			expect(applyClickCursor()).toBe(false);
		});

		it("restores original prototype cleanly", () => {
			const original = (Editor.prototype as any).handleMouse;
			applyClickCursor();
			expect((Editor.prototype as any).handleMouse).not.toBe(original);

			const restored = restoreClickCursor();
			expect(restored).toBe(true);
			expect((Editor.prototype as any).handleMouse).toBe(original);
			expect((Editor.prototype as any)[CLICK_CURSOR_PATCHED_KEY]).toBeUndefined();

			// Second restore returns false
			expect(restoreClickCursor()).toBe(false);
		});

		it("default extension export activates applyClickCursor", () => {
			rbfClickCursor();
			expect((Editor.prototype as any)[CLICK_CURSOR_PATCHED_KEY]).toBe(true);
		});
	});

	describe("patched handleMouse integration", () => {
		it("positions cursor and requests render on left mouse press", () => {
			applyClickCursor();
			const mockTui = createMockTui();
			const editor = new Editor(mockTui as any, mockTheme as any);
			editor.setText("First line\nSecond line");
			editor.render(80);

			const result = editor.handleMouse({
				type: "press",
				button: "left",
				x: 4,
				y: 2,
				screenX: 4,
				screenY: 10,
				width: 80,
				height: 4,
				shift: false,
				alt: false,
				ctrl: false,
			});

			expect(result).toEqual({ handled: true, focus: true, render: true });
			expect(editor.getCursor()).toEqual({ line: 1, col: 4 });
			expect(mockTui.requestRender).toHaveBeenCalled();
			expect(mockTui.clearTextSelection).toHaveBeenCalled();
		});

		it("positions cursor and requests render on left mouse click", () => {
			applyClickCursor();
			const mockTui = createMockTui();
			const editor = new Editor(mockTui as any, mockTheme as any);
			editor.setText("Testing click position");
			editor.render(80);

			const result = editor.handleMouse({
				type: "click",
				button: "left",
				x: 8,
				y: 1,
				screenX: 8,
				screenY: 15,
				width: 80,
				height: 3,
				shift: false,
				alt: false,
				ctrl: false,
			});

			expect(result).toEqual({ handled: true, focus: true, render: true });
			expect(editor.getCursor()).toEqual({ line: 0, col: 8 });
			expect(mockTui.requestRender).toHaveBeenCalled();
		});

		it("updates cursor on mouse drag", () => {
			applyClickCursor();
			const mockTui = createMockTui();
			const editor = new Editor(mockTui as any, mockTheme as any);
			editor.setText("Drag to reposition");
			editor.render(80);

			const result = editor.handleMouse({
				type: "drag",
				button: "left",
				x: 6,
				y: 1,
				screenX: 6,
				screenY: 15,
				width: 80,
				height: 3,
				shift: false,
				alt: false,
				ctrl: false,
			});

			expect(result).toEqual({ handled: true, focus: true, render: true });
			expect(editor.getCursor()).toEqual({ line: 0, col: 6 });
		});

		it("acknowledges mouse release cleanly with render: true", () => {
			applyClickCursor();
			const mockTui = createMockTui();
			const editor = new Editor(mockTui as any, mockTheme as any);
			editor.setText("Release event");
			editor.render(80);

			const result = editor.handleMouse({
				type: "release",
				button: "left",
				x: 3,
				y: 1,
				screenX: 3,
				screenY: 15,
				width: 80,
				height: 3,
				shift: false,
				alt: false,
				ctrl: false,
			});

			expect(result).toEqual({ handled: true, focus: true, render: true });
			expect(mockTui.requestRender).toHaveBeenCalled();
		});

		it("handles button: 'none' on release and click", () => {
			applyClickCursor();
			const mockTui = createMockTui();
			const editor = new Editor(mockTui as any, mockTheme as any);
			editor.setText("Release button none");
			editor.render(80);

			const result = editor.handleMouse({
				type: "click",
				button: "none",
				x: 4,
				y: 1,
				screenX: 4,
				screenY: 15,
				width: 80,
				height: 3,
				shift: false,
				alt: false,
				ctrl: false,
			});

			expect(result).toEqual({ handled: true, focus: true, render: true });
			expect(editor.getCursor()).toEqual({ line: 0, col: 4 });
		});

		it("returns undefined for right click so paste/context menu is not broken", () => {
			applyClickCursor();
			const mockTui = createMockTui();
			const editor = new Editor(mockTui as any, mockTheme as any);
			editor.setText("Right click test");
			editor.render(80);

			const result = editor.handleMouse({
				type: "press",
				button: "right",
				x: 4,
				y: 1,
				screenX: 4,
				screenY: 15,
				width: 80,
				height: 3,
				shift: false,
				alt: false,
				ctrl: false,
			});

			expect(result).toBeUndefined();
		});

		it("clicks on top border focus editor and request render without error", () => {
			applyClickCursor();
			const mockTui = createMockTui();
			const editor = new Editor(mockTui as any, mockTheme as any);
			editor.setText("Border click");
			editor.render(80);

			const result = editor.handleMouse({
				type: "click",
				button: "left",
				x: 5,
				y: 0,
				screenX: 5,
				screenY: 14,
				width: 80,
				height: 3,
				shift: false,
				alt: false,
				ctrl: false,
			});

			expect(result).toEqual({ handled: true, focus: true, render: true });
			expect(mockTui.requestRender).toHaveBeenCalled();
		});

		it("forwards autocomplete clicks to autocompleteList and returns render: true", () => {
			applyClickCursor();
			const mockTui = createMockTui();
			const editor = new Editor(mockTui as any, mockTheme as any) as any;
			editor.setText("Autocomplete test");
			editor.renderedVisibleLineCount = 1;
			editor.renderedAutocompleteHeight = 4;
			editor.autocompleteState = { active: true };
			editor.autocompleteList = {
				handleMouse: vi.fn().mockReturnValue({ handled: true }),
			};

			// Autocomplete starts at row renderedVisibleLineCount + 2 = 1 + 2 = 3
			const result = editor.handleMouse({
				type: "click",
				button: "left",
				x: 10,
				y: 3,
				screenX: 10,
				screenY: 17,
				width: 80,
				height: 7,
				shift: false,
				alt: false,
				ctrl: false,
			});

			expect(editor.autocompleteList.handleMouse).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "click",
					button: "left",
					y: 0, // 3 - 3 = 0
				}),
			);
			expect(result).toEqual({ handled: true, focus: true, render: true });
			expect(mockTui.requestRender).toHaveBeenCalled();
		});
	});

	describe("CustomEditor inheritance", () => {
		it("CustomEditor instances automatically benefit from click cursor placement", () => {
			applyClickCursor();
			const mockTui = createMockTui();
			const mockKeybindings = {
				matches: vi.fn().mockReturnValue(false),
			};

			const customEditor = new CustomEditor(
				mockTui as any,
				mockTheme as any,
				mockKeybindings as any,
			);
			customEditor.setText("CustomEditor test");
			customEditor.render(80);

			const result = customEditor.handleMouse({
				type: "click",
				button: "left",
				x: 6,
				y: 1,
				screenX: 6,
				screenY: 15,
				width: 80,
				height: 3,
				shift: false,
				alt: false,
				ctrl: false,
			});

			expect(result).toEqual({ handled: true, focus: true, render: true });
			expect(customEditor.getCursor()).toEqual({ line: 0, col: 6 });
			expect(mockTui.requestRender).toHaveBeenCalled();
		});
	});
});
