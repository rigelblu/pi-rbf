import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import rbfVim, {
	ACTIVE_VIM_EDITOR_KEY,
	findVimWordBackward,
	findVimWordEnd,
	findVimWordForward,
	isVimEnabledInSettings,
	persistVimSetting,
	VIM_COMMAND_NAME,
	VimEditor,
} from "./rbf-vim.ts";

function createMockTui() {
	return {
		terminal: { rows: 24, columns: 80 },
		requestRender: vi.fn(),
		clearTextSelection: vi.fn(),
	};
}

const mockTheme = {
	borderColor: (s: string) => s,
	selectList: {
		selectedPrefix: () => "> ",
		selectedText: (s: string) => s,
		unselectedPrefix: () => "  ",
		unselectedText: (s: string) => s,
		description: (s: string) => s,
		scrollInfo: (s: string) => s,
		noMatches: (s: string) => s,
	},
};

function createMockKeybindings() {
	return {
		matches: vi.fn((data: string, id: string) => {
			if (id === "app.interrupt") return data === "\x1b";
			if (id === "tui.input.submit") return data === "\r" || data === "\n";
			return false;
		}),
	};
}

describe("rbf-vim extension", () => {
	beforeEach(() => {
		delete (globalThis as any)[ACTIVE_VIM_EDITOR_KEY];
	});

	afterEach(() => {
		delete (globalThis as any)[ACTIVE_VIM_EDITOR_KEY];
	});

	describe("word motion algorithms", () => {
		it("findVimWordForward jumps across words and punctuation", () => {
			const text = "hello, world! 123";
			expect(findVimWordForward(text, 0)).toBe(5); // to ','
			expect(findVimWordForward(text, 5)).toBe(7); // to 'world'
			expect(findVimWordForward(text, 7)).toBe(12); // to '!'
			expect(findVimWordForward(text, 12)).toBe(14); // to '123'
		});

		it("findVimWordBackward jumps to preceding word start", () => {
			const text = "hello, world! 123";
			expect(findVimWordBackward(text, 14)).toBe(12); // to '!'
			expect(findVimWordBackward(text, 12)).toBe(7); // to 'world'
			expect(findVimWordBackward(text, 7)).toBe(5); // to ','
			expect(findVimWordBackward(text, 5)).toBe(0); // to 'hello'
		});

		it("findVimWordEnd jumps to end of token", () => {
			const text = "hello world";
			expect(findVimWordEnd(text, 0)).toBe(4); // end of 'hello'
			expect(findVimWordEnd(text, 4)).toBe(10); // end of 'world'
		});
	});

	describe("VimEditor modal behavior", () => {
		it("starts in INSERT mode and accepts text entry", () => {
			const tui = createMockTui();
			const kb = createMockKeybindings();
			const editor = new VimEditor(tui as any, mockTheme as any, kb as any);

			expect(editor.getMode()).toBe("insert");
			editor.handleInput("a");
			editor.handleInput("b");
			editor.handleInput("c");
			expect(editor.getText()).toBe("abc");
		});

		it("transitions from INSERT to NORMAL with Escape", () => {
			const tui = createMockTui();
			const kb = createMockKeybindings();
			const editor = new VimEditor(tui as any, mockTheme as any, kb as any);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("y");
			expect(editor.getCursor()).toEqual({ line: 0, col: 3 });

			editor.handleInput("\x1b"); // Esc
			expect(editor.getMode()).toBe("normal");
			// Cursor steps back one position when exiting insert mode
			expect(editor.getCursor()).toEqual({ line: 0, col: 2 });
		});

		it("swallows Escape in NORMAL mode without triggering app.interrupt", () => {
			const tui = createMockTui();
			const kb = createMockKeybindings();
			const editor = new VimEditor(tui as any, mockTheme as any, kb as any);
			const onEscape = vi.fn();
			editor.onEscape = onEscape;

			editor.setMode("normal");
			editor.handleInput("\x1b"); // Esc in normal mode
			expect(editor.getMode()).toBe("normal");
			// MUST NOT trigger onEscape (which aborts agent turns)
			expect(onEscape).not.toHaveBeenCalled();
		});

		it("handles basic hjkl motions in NORMAL mode", () => {
			const tui = createMockTui();
			const kb = createMockKeybindings();
			const editor = new VimEditor(tui as any, mockTheme as any, kb as any);

			editor.setText("line1\nline2\nline3");
			editor.setCursor({ line: 0, col: 0 });
			editor.setMode("normal");
			expect(editor.getCursor()).toEqual({ line: 0, col: 0 });

			editor.handleInput("l"); // right
			expect(editor.getCursor()).toEqual({ line: 0, col: 1 });

			editor.handleInput("j"); // down
			expect(editor.getCursor()).toEqual({ line: 1, col: 1 });

			editor.handleInput("h"); // left
			expect(editor.getCursor()).toEqual({ line: 1, col: 0 });

			editor.handleInput("k"); // up
			expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
		});

		it("handles w, b, e motions and count multipliers", () => {
			const tui = createMockTui();
			const kb = createMockKeybindings();
			const editor = new VimEditor(tui as any, mockTheme as any, kb as any);

			editor.setText("one two three four");
			editor.setCursor({ line: 0, col: 0 });
			editor.setMode("normal");

			editor.handleInput("w");
			expect(editor.getCursor()).toEqual({ line: 0, col: 4 }); // 'two'

			editor.handleInput("2");
			editor.handleInput("w");
			expect(editor.getCursor()).toEqual({ line: 0, col: 14 }); // 'four'

			editor.handleInput("b");
			expect(editor.getCursor()).toEqual({ line: 0, col: 8 }); // 'three'

			editor.handleInput("e");
			expect(editor.getCursor()).toEqual({ line: 0, col: 12 }); // end of 'three'
		});

		it("handles 0, ^, $ line boundary motions", () => {
			const tui = createMockTui();
			const kb = createMockKeybindings();
			const editor = new VimEditor(tui as any, mockTheme as any, kb as any);

			editor.setText("   indent words");
			editor.setMode("normal");

			editor.handleInput("$");
			expect(editor.getCursor().col).toBe(14); // 's'

			editor.handleInput("^");
			expect(editor.getCursor().col).toBe(3); // 'i'

			editor.handleInput("0");
			expect(editor.getCursor().col).toBe(0); // col 0
		});

		it("handles gg and G buffer motions", () => {
			const tui = createMockTui();
			const kb = createMockKeybindings();
			const editor = new VimEditor(tui as any, mockTheme as any, kb as any);

			editor.setText("line1\nline2\nline3\nline4");
			editor.setMode("normal");

			editor.handleInput("G");
			expect(editor.getCursor().line).toBe(3);

			editor.handleInput("g");
			editor.handleInput("g");
			expect(editor.getCursor().line).toBe(0);

			editor.handleInput("2");
			editor.handleInput("G");
			expect(editor.getCursor().line).toBe(1);
		});

		it("handles insertion entry points (i, I, a, A, o, O)", () => {
			const tui = createMockTui();
			const kb = createMockKeybindings();
			const editor = new VimEditor(tui as any, mockTheme as any, kb as any);

			editor.setText("  middle");
			editor.setCursor({ line: 0, col: 0 });
			editor.setMode("normal");

			// 'a' appends after cursor
			editor.handleInput("a");
			expect(editor.getMode()).toBe("insert");
			expect(editor.getCursor().col).toBe(1);

			// 'I' inserts at first non-blank
			editor.setMode("normal");
			editor.handleInput("I");
			expect(editor.getMode()).toBe("insert");
			expect(editor.getCursor().col).toBe(2);

			// 'A' appends at end of line
			editor.setMode("normal");
			editor.handleInput("A");
			expect(editor.getMode()).toBe("insert");
			expect(editor.getCursor().col).toBe(8);

			// 'o' opens line below
			editor.setMode("normal");
			editor.handleInput("o");
			expect(editor.getMode()).toBe("insert");
			expect(editor.getCursor()).toEqual({ line: 1, col: 0 });
			expect(editor.getLines().length).toBe(2);

			// 'O' opens line above
			editor.setMode("normal");
			editor.handleInput("O");
			expect(editor.getMode()).toBe("insert");
			expect(editor.getCursor()).toEqual({ line: 1, col: 0 });
			expect(editor.getLines().length).toBe(3);
		});

		it("handles deletion verbs (x, dd, dw, D, cc, cw)", () => {
			const tui = createMockTui();
			const kb = createMockKeybindings();
			const editor = new VimEditor(tui as any, mockTheme as any, kb as any);

			// 'x' deletes char
			editor.setText("abc");
			editor.setCursor({ line: 0, col: 0 });
			editor.setMode("normal");
			editor.handleInput("x");
			expect(editor.getText()).toBe("bc");

			// 'D' deletes to line end
			editor.setText("hello world");
			editor.setCursor({ line: 0, col: 0 });
			editor.setMode("normal");
			editor.handleInput("w"); // to 'world'
			editor.handleInput("D");
			expect(editor.getText()).toBe("hello ");

			// 'dd' deletes entire line
			editor.setText("first\nsecond\nthird");
			editor.setCursor({ line: 0, col: 0 });
			editor.setMode("normal");
			editor.handleInput("d");
			editor.handleInput("d");
			expect(editor.getLines()).toEqual(["second", "third"]);

			// 'dw' deletes word
			editor.setText("delete me please");
			editor.setCursor({ line: 0, col: 0 });
			editor.setMode("normal");
			editor.handleInput("d");
			editor.handleInput("w");
			expect(editor.getText()).toBe("me please");

			// 'cw' deletes word and enters insert mode
			editor.handleInput("c");
			editor.handleInput("w");
			expect(editor.getMode()).toBe("insert");
			expect(editor.getText()).toBe("please");

			// 'cc' clears line and enters insert mode
			editor.handleInput("not relevant");
			editor.setMode("normal");
			editor.handleInput("c");
			editor.handleInput("c");
			expect(editor.getMode()).toBe("insert");
			expect(editor.getText()).toBe("");
		});

		it("handles character replacement (r<char>)", () => {
			const tui = createMockTui();
			const kb = createMockKeybindings();
			const editor = new VimEditor(tui as any, mockTheme as any, kb as any);

			editor.setText("cat");
			editor.setCursor({ line: 0, col: 0 });
			editor.setMode("normal");
			editor.handleInput("r");
			editor.handleInput("b");
			expect(editor.getText()).toBe("bat");
			expect(editor.getMode()).toBe("normal");
		});

		it("handles character find (f, F, ;, ,)", () => {
			const tui = createMockTui();
			const kb = createMockKeybindings();
			const editor = new VimEditor(tui as any, mockTheme as any, kb as any);

			editor.setText("banana");
			editor.setCursor({ line: 0, col: 0 });
			editor.setMode("normal");

			editor.handleInput("f");
			editor.handleInput("a");
			expect(editor.getCursor().col).toBe(1);

			editor.handleInput(";");
			expect(editor.getCursor().col).toBe(3);

			editor.handleInput(";");
			expect(editor.getCursor().col).toBe(5);

			editor.handleInput(",");
			expect(editor.getCursor().col).toBe(3);
		});

		it("handles yank and paste (yy, yw, p, P)", () => {
			const tui = createMockTui();
			const kb = createMockKeybindings();
			const editor = new VimEditor(tui as any, mockTheme as any, kb as any);

			editor.setText("first\nsecond");
			editor.setCursor({ line: 0, col: 0 });
			editor.setMode("normal");

			editor.handleInput("y");
			editor.handleInput("y"); // yank 'first\n'

			editor.handleInput("p"); // paste below
			expect(editor.getLines()).toEqual(["first", "first", "second"]);

			// Word yank & paste
			editor.setText("word another");
			editor.setCursor({ line: 0, col: 0 });
			editor.setMode("normal");
			editor.handleInput("y");
			editor.handleInput("w");
			editor.handleInput("$");
			editor.handleInput("p");
			expect(editor.getText()).toBe("word anotherword ");
		});

		it("submits prompt with Enter in normal mode", () => {
			const tui = createMockTui();
			const kb = createMockKeybindings();
			const editor = new VimEditor(tui as any, mockTheme as any, kb as any);
			const onSubmit = vi.fn();
			editor.onSubmit = onSubmit;

			editor.setText("test submit");
			editor.setMode("normal");

			editor.handleInput("\r");
			expect(onSubmit).toHaveBeenCalledWith("test submit");
		});

		it("renders bottom border mode badge cleanly", () => {
			const tui = createMockTui();
			const kb = createMockKeybindings();
			const editor = new VimEditor(tui as any, mockTheme as any, kb as any);

			const insertBorder = editor.renderBottomBorder(80, 0);
			expect(insertBorder).toContain("INSERT");

			editor.setMode("normal");
			const normalBorder = editor.renderBottomBorder(80, 0);
			expect(normalBorder).toContain("NORMAL");
		});
	});

	describe("/vim command and settings", () => {
		it("registers /vim command with ExtensionAPI", () => {
			const registeredCommands: Record<string, any> = {};
			const mockApi: any = {
				on: vi.fn(),
				registerCommand: vi.fn((name: string, config: any) => {
					registeredCommands[name] = config;
				}),
			};

			rbfVim(mockApi);
			expect(mockApi.registerCommand).toHaveBeenCalledWith(VIM_COMMAND_NAME, expect.any(Object));
			expect(registeredCommands[VIM_COMMAND_NAME]).toBeDefined();
		});

		it("toggles vim mode via command handler", async () => {
			const registeredCommands: Record<string, any> = {};
			const mockApi: any = {
				on: vi.fn(),
				registerCommand: vi.fn((name: string, config: any) => {
					registeredCommands[name] = config;
				}),
			};
			rbfVim(mockApi);

			const mockCtx: any = {
				ui: {
					setEditorComponent: vi.fn(),
					notify: vi.fn(),
				},
			};

			const cmd = registeredCommands[VIM_COMMAND_NAME];

			// Toggle on
			await cmd.handler("on", mockCtx);
			expect(mockCtx.ui.setEditorComponent).toHaveBeenCalledWith(expect.any(Function));
			expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("enabled"), "info");

			// Toggle off
			await cmd.handler("off", mockCtx);
			expect(mockCtx.ui.setEditorComponent).toHaveBeenCalledWith(undefined);
			expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("disabled"), "info");
		});
	});
});
