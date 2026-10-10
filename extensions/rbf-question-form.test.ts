import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Key, visibleWidth, Container, Text, TuiAltScreen, VStack } from "@earendil-works/pi-tui";
import { wordWrapLine as editorWordWrapLine } from "@earendil-works/pi-tui/dist/components/editor.js";
import { findWordBackward, findWordForward } from "@earendil-works/pi-tui/dist/word-navigation.js";
import rbfQuestionForm, {
	buildChips,
	buildSubmissionText,
	createQuestionFormComponent,
	detectQuestionOptions,
	normalizeToolOption,
	parseNumberedOption,
	renderQuestionFormLines,
	wordWrapLine,
} from "./rbf-question-form.ts";

// ─── detectQuestionOptions ───────────────────────────────────────────────────

describe("detectQuestionOptions", () => {
	it("returns null for plain text without numbered lists", () => {
		expect(detectQuestionOptions("Hello world\nThis is a paragraph.")).toBeNull();
	});

	it("returns null for a single numbered item (needs at least 2)", () => {
		expect(detectQuestionOptions("Which one?\n1. Only option")).toBeNull();
	});

	it("returns null for a tutorial-style numbered list without question context", () => {
		const text = `
Here are the steps:

1. Install the package
2. Configure the settings
3. Run the server
`;
		expect(detectQuestionOptions(text)).toBeNull();
	});

	it("detects options after Recommendation:", () => {
		const text = `• Recommendation: Let Codex own retries inside its active turn.

1. Codex retries internally — one execution owner ← recommended
2. Pi automatically resends — smoother recovery / can duplicate
3. Do nothing — simplest / user must re-prompt`;

		const result = detectQuestionOptions(text);
		expect(result).not.toBeNull();
		expect(result).toHaveLength(3);
		expect(result![0]).toContain("Codex retries internally");
	});

	it("detects options after User Need Framing:", () => {
		const text = `User Need Framing: Recover from transient failures.

1. Option A
2. Option B`;

		const result = detectQuestionOptions(text);
		expect(result).not.toBeNull();
		expect(result).toHaveLength(2);
	});

	it("detects options after a line ending with ?", () => {
		const text = `Which approach do you prefer?

1. Approach A — fast but fragile
2. Approach B — slow but robust
3. Approach C — balanced`;

		const result = detectQuestionOptions(text);
		expect(result).not.toBeNull();
		expect(result).toHaveLength(3);
	});

	it("detects options containing ← recommended marker", () => {
		const text = `Here are the choices:

1. Keep it simple ← recommended
2. Add complexity
3. Go all-in`;

		const result = detectQuestionOptions(text);
		expect(result).not.toBeNull();
		expect(result).toHaveLength(3);
	});

	it("detects options containing (recommended) marker", () => {
		const text = `The available strategies:

1. Strategy A (recommended)
2. Strategy B
3. Strategy C`;

		const result = detectQuestionOptions(text);
		expect(result).not.toBeNull();
		expect(result).toHaveLength(3);
	});

	it("handles trailing blank lines", () => {
		const text = `What should we do?

1. First option
2. Second option

`;
		const result = detectQuestionOptions(text);
		expect(result).not.toBeNull();
		expect(result).toHaveLength(2);
	});
});

// ─── parseNumberedOption ─────────────────────────────────────────────────────

describe("parseNumberedOption", () => {
	it("extracts label from numbered line", () => {
		const opt = parseNumberedOption("1. Codex retries internally — one execution owner", 0);
		expect(opt.label).toBe("Codex retries internally — one execution owner");
		expect(opt.index).toBe(0);
		expect(opt.fullText).toBe("1. Codex retries internally — one execution owner");
	});

	it("handles indented numbered lines", () => {
		const opt = parseNumberedOption("  2. Pi automatically resends", 1);
		expect(opt.label).toBe("Pi automatically resends");
		expect(opt.index).toBe(1);
	});

	it("preserves recommended markers in label", () => {
		const opt = parseNumberedOption("1. Option A ← recommended", 0);
		expect(opt.label).toBe("Option A ← recommended");
	});
});

// ─── normalizeToolOption ─────────────────────────────────────────────────────

describe("normalizeToolOption", () => {
	it("normalizes a string option", () => {
		const opt = normalizeToolOption("Simple option", 0);
		expect(opt.label).toBe("Simple option");
		expect(opt.description).toBeUndefined();
		expect(opt.fullText).toBe("1. Simple option");
		expect(opt.index).toBe(0);
	});

	it("normalizes an object option with description", () => {
		const opt = normalizeToolOption({ label: "Rich option", description: "Extra details" }, 2);
		expect(opt.label).toBe("Rich option");
		expect(opt.description).toBe("Extra details");
		expect(opt.fullText).toBe("3. Rich option");
		expect(opt.index).toBe(2);
	});

	it("normalizes an object option without description", () => {
		const opt = normalizeToolOption({ label: "Plain object" }, 1);
		expect(opt.label).toBe("Plain object");
		expect(opt.description).toBeUndefined();
		expect(opt.fullText).toBe("2. Plain object");
	});
});

// ─── buildChips ─────────────────────────────────────────────────────────────

describe("buildChips", () => {
	it("creates chips for options plus Write-in and Canned reply", () => {
		const options = [
			{ index: 0, label: "A", fullText: "1. A" },
			{ index: 1, label: "B", fullText: "2. B" },
			{ index: 2, label: "C", fullText: "3. C" },
		];
		const chips = buildChips(options);

		expect(chips).toHaveLength(5);
		expect(chips[0]).toEqual({ key: "1", type: "option", label: "1", fullText: "1. A" });
		expect(chips[1]).toEqual({ key: "2", type: "option", label: "2", fullText: "2. B" });
		expect(chips[2]).toEqual({ key: "3", type: "option", label: "3", fullText: "3. C" });
		expect(chips[3]).toEqual({
			key: "c",
			type: "canned",
			label: "C. /convo-is-very-best",
			cannedCommand: "/skill:convo-is-very-best",
		});
		expect(chips[4]).toEqual({ key: "w", type: "write-in", label: "W. Write-in" });
	});

	it("creates one-option case correctly", () => {
		const options = [
			{ index: 0, label: "A", fullText: "1. A" },
		];
		const chips = buildChips(options);

		expect(chips).toHaveLength(3);
		expect(chips[0].key).toBe("1");
		expect(chips[1].type).toBe("canned");
		expect(chips[2].type).toBe("write-in");
		expect(chips[2].key).toBe("w");
		expect(chips[2].label).toBe("W. Write-in");
	});
});

// ─── buildSubmissionText ────────────────────────────────────────────────────

describe("buildSubmissionText", () => {
	const optChip = { key: "1", type: "option" as const, label: "1", fullText: "1. First choice" };
	const writeInChip = { key: "w", type: "write-in" as const, label: "W. Write-in" };
	const cannedChip = {
		key: "c",
		type: "canned" as const,
		label: "C. /convo-is-very-best",
		cannedCommand: "/skill:convo-is-very-best",
	};

	it("returns base fullText when notes are empty", () => {
		expect(buildSubmissionText(optChip, "")).toBe("1. First choice");
		expect(buildSubmissionText(optChip, "   ")).toBe("1. First choice");
	});

	it("appends notes directly without prefix when notes are provided", () => {
		const result = buildSubmissionText(optChip, "make sure tests pass");
		expect(result).toBe("1. First choice\n\nmake sure tests pass");
	});

	it("handles write-in option", () => {
		expect(buildSubmissionText(writeInChip, "")).toBe("");
		expect(buildSubmissionText(writeInChip, "my custom answer")).toBe("my custom answer");
	});

	it("handles canned reply with and without notes", () => {
		expect(buildSubmissionText(cannedChip, "")).toBe("/skill:convo-is-very-best");
		expect(buildSubmissionText(cannedChip, "focus on edge cases")).toBe(
			"/skill:convo-is-very-best\n\nfocus on edge cases",
		);
	});
});

// ─── renderQuestionFormLines ────────────────────────────────────────────────

describe("renderQuestionFormLines", () => {
	it("renders the chip row in numbered, canned, Write-in order", () => {
		const chips = buildChips([
			{ index: 0, label: "Alpha", fullText: "1. Alpha" },
			{ index: 1, label: "Beta", fullText: "2. Beta" },
		]);
		const lines = renderQuestionFormLines(
			{
				chips,
				selectedChipIndex: 0,
				focus: "options",
				notesText: "",
				notesCursorPos: 0,
				theme: mockThemeFallback,
			},
			80,
		);
		const chipRow = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).find((l) => l.includes("Write-in"))!;
		const positions = ["[ 2 ]", "[ C. /convo-is-very-best ]", "[ W. Write-in ]"].map((s) => chipRow.indexOf(s));
		expect(positions.every((p) => p >= 0)).toBe(true);
		expect(positions[0]).toBeLessThan(positions[1]);
		expect(positions[1]).toBeLessThan(positions[2]);
		expect(chipRow.indexOf("[ W. Write-in ]")).toBe(chipRow.length - "[ W. Write-in ]".length);
	});

	const mockThemeWithAnsi: any = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		getFgAnsi: (color: string) => (color === "borderAccent" ? "\x1b[38;2;86;148;159m" : "\x1b[38;2;40;105;131m"),
	};

	const mockThemeFallback: any = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};

	it("renders theme borderAccent background and light text for active selection", () => {
		const chips = [
			{ key: "1", type: "option" as const, label: "1" },
			{ key: "2", type: "option" as const, label: "2" },
		];
		const lines = renderQuestionFormLines(
			{
				chips,
				selectedChipIndex: 0,
				focus: "options",
				notesText: "",
				notesCursorPos: 0,
				theme: mockThemeWithAnsi,
			},
			80,
		);

		const joined = lines.join("\n");
		// Active chip 1 has theme borderAccent background ANSI code (converted to 48;)
		expect(joined).toContain("\x1b[48;2;86;148;159m\x1b[1;38;5;255m 1 \x1b[0m");
		// Unselected chip 2 has brackets
		expect(joined).toContain("[ 2 ]");
		// Top border has Select Answer
		expect(joined).toContain("Select Answer");
		// Has notes label
		expect(joined).toContain("Add notes to selection:");
	});

	it("falls back to inverse when theme lacks getFgAnsi", () => {
		const chips = [{ key: "1", type: "option" as const, label: "1" }];
		const lines = renderQuestionFormLines(
			{
				chips,
				selectedChipIndex: 0,
				focus: "options",
				notesText: "",
				notesCursorPos: 0,
				theme: mockThemeFallback,
			},
			80,
		);

		const joined = lines.join("\n");
		expect(joined).toContain("\x1b[7m\x1b[1m 1 \x1b[0m");
	});

	it("renders required indicator and write in label when write-in is selected", () => {
		const chips = [
			{ key: "1", type: "option" as const, label: "1" },
			{ key: "2", type: "write-in" as const, label: "2. Write-in" },
		];
		const lines = renderQuestionFormLines(
			{
				chips,
				selectedChipIndex: 1,
				focus: "notes",
				notesText: "",
				notesCursorPos: 0,
				theme: mockThemeWithAnsi,
			},
			80,
		);

		const joined = lines.join("\n");
		expect(joined).toContain("Write in your answer:");
		expect(joined).toContain("(required)");
	});

	it("renders cursor and typed notes when focus is on notes", () => {
		const chips = [{ key: "1", type: "option" as const, label: "1" }];
		const lines = renderQuestionFormLines(
			{
				chips,
				selectedChipIndex: 0,
				focus: "notes",
				notesText: "hello",
				notesCursorPos: 5,
				theme: mockThemeWithAnsi,
			},
			80,
		);

		const joined = lines.join("\n");
		expect(joined).toContain("hello");
		expect(joined).toContain("\x1b[7m"); // inverse cursor
	});
});

// ─── createQuestionFormComponent input handling ──────────────────────────────

describe("createQuestionFormComponent input handling", () => {
	const mockTheme: any = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};

	function createComponent() {
		const options = [
			{ index: 0, label: "Alpha", fullText: "1. Alpha" },
			{ index: 1, label: "Beta", fullText: "2. Beta" },
		];
		const tui = {
			requestRender: vi.fn(),
		};
		const done = vi.fn();
		const comp = createQuestionFormComponent(options, tui as any, mockTheme, done);
		return { comp, tui, done };
	}

	it("navigates options with arrow keys and submits on Enter", () => {
		const { comp, done } = createComponent();

		// Move right to option 2
		comp.handleInput("\x1b[C");
		// Submit with Enter
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("2. Beta");
	});

	it("switches to notes with Tab and types text", () => {
		const { comp, done } = createComponent();

		// Select option 1
		comp.handleInput("1");
		// Tab to notes
		comp.handleInput("\t");
		// Type 'h', 'i'
		comp.handleInput("h");
		comp.handleInput("i");
		// Submit with Enter
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("1. Alpha\n\nhi");
	});

	it("clears notes on Esc first, then dismisses on second Esc", () => {
		const { comp, done } = createComponent();

		// Tab to notes and type
		comp.handleInput("\t");
		comp.handleInput("x");

		// First Esc clears notes text
		comp.handleInput("\x1b");
		expect(done).not.toHaveBeenCalled();

		// Second Esc dismisses
		comp.handleInput("\x1b");
		expect(done).toHaveBeenCalledWith(null);
	});

	it("selects canned reply with 'c' key", () => {
		const { comp, done } = createComponent();

		// Press 'c' to select canned reply
		comp.handleInput("c");
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("/skill:convo-is-very-best");
	});

	it("selects write-in option and focuses notes with 'w' and 'W'", () => {
		const { comp, done } = createComponent();

		// 'w' selects Write-in
		comp.handleInput("w");
		// Directly type custom text since write-in auto-focuses notes
		comp.handleInput("M");
		comp.handleInput("y");
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("My");

		// 'W' also selects Write-in
		const { comp: compW, done: doneW } = createComponent();
		compW.handleInput("W");
		compW.handleInput("O");
		compW.handleInput("k");
		compW.handleInput("\r");
		expect(doneW).toHaveBeenCalledWith("Ok");
	});

	it("former N+1 digit is not a write-in alias when option does not exist", () => {
		const { comp, done } = createComponent();

		// '3' was the former N+1 Write-in key for 2 options, but now has no effect
		comp.handleInput("3");
		// Should still be on option 1
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("1. Alpha");
	});

	it("blocks Enter submission when write-in notes are empty and requires text", () => {
		const { comp, done } = createComponent();

		// 'w' is Write-in
		comp.handleInput("w");
		// Hit Enter immediately while notes are empty
		comp.handleInput("\r");
		expect(done).not.toHaveBeenCalled();

		// Type custom text and hit Enter
		comp.handleInput("W");
		comp.handleInput("o");
		comp.handleInput("r");
		comp.handleInput("k");
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("Work");
	});

	it("right-arrow from the last numbered option selects C with chip focus", () => {
		const { comp, done } = createComponent();

		// Start on option 1 (index 0). Move right to option 2 (index 1).
		comp.handleInput("\x1b[C");
		// Move right again -> should go to canned 'C' (index 2).
		comp.handleInput("\x1b[C");

		// Submit to verify it's the canned chip.
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("/skill:convo-is-very-best");

		// Chip-focus probe: pressing a letter must navigate chips, not type into notes.
		const { comp: chipFocusComp, done: chipFocusDone } = createComponent();
		chipFocusComp.handleInput("\x1b[C"); // option 2
		chipFocusComp.handleInput("\x1b[C"); // canned C
		chipFocusComp.handleInput("h"); // vim-left: back to option 2 if chip focus; ignored text if notes focus
		chipFocusComp.handleInput("\r");
		expect(chipFocusDone).toHaveBeenCalledWith("2. Beta");
	});

	it("after arrowing onto Write-in, focus is notes, left-arrow moves text cursor, Tab/up returns to chips, left-arrow reaches C", () => {
		const { comp, done } = createComponent();

		// Move right to 2, then C, then Write-in
		comp.handleInput("\x1b[C");
		comp.handleInput("\x1b[C");
		comp.handleInput("\x1b[C");

		// Now on Write-in, focus is notes. Type 'hi'
		comp.handleInput("h");
		comp.handleInput("i");

		// Left arrow should move the text cursor; prove it by typing between the letters
		comp.handleInput("\x1b[D");
		comp.handleInput("X");

		// Tab to go back to chips
		comp.handleInput("\t");

		// Left arrow on chips goes to C
		comp.handleInput("\x1b[D");

		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("/skill:convo-is-very-best\n\nhXi");
	});

	it("up-arrow also returns from the Write-in answer field to the chips", () => {
		const { comp, done } = createComponent();

		// Arrow onto Write-in (option 1, option 2, C, Write-in)
		comp.handleInput("\x1b[C");
		comp.handleInput("\x1b[C");
		comp.handleInput("\x1b[C");

		// Up-arrow returns to chips; left reaches C
		comp.handleInput("\x1b[A");
		comp.handleInput("\x1b[D");
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("/skill:convo-is-very-best");
	});

	it("exact submissions on the existing two-option helper", () => {
		const { comp, done } = createComponent();
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("1. Alpha");

		const { comp: comp2, done: done2 } = createComponent();
		comp2.handleInput("c");
		comp2.handleInput("\r");
		expect(done2).toHaveBeenCalledWith("/skill:convo-is-very-best");

		const { comp: comp3, done: done3 } = createComponent();
		comp3.handleInput("w");
		comp3.handleInput("M");
		comp3.handleInput("y");
		comp3.handleInput("\r");
		expect(done3).toHaveBeenCalledWith("My");

		const { comp: comp4, done: done4 } = createComponent();
		comp4.handleInput("w");
		comp4.handleInput("\r");
		expect(done4).not.toHaveBeenCalled();
	});
});

// ─── rbfQuestionForm Extension Lifecycle & Commands ─────────────────────────

describe("rbfQuestionForm extension integration & commands", () => {
	function createMockExtensionContext(mode = "tui") {
		let customComponent: any = null;

		const ctx = {
			mode,
			hasUI: true,
			cwd: "/test",
			ui: {
				theme: {
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				},
				notify: vi.fn(),
				custom: vi.fn((factory: (tui: any, theme: any, kb: any, done: any) => any) => {
					return new Promise((resolve) => {
						const comp = factory({ requestRender: vi.fn() }, ctx.ui.theme, {}, (result: any) => {
							resolve(result);
						});
						customComponent = comp;
					});
				}),
			},
		};

		return {
			ctx,
			get customComponent() {
				return customComponent;
			},
		};
	}

	function createMockExtensionAPI() {
		const registeredTools = new Map<string, any>();
		const registeredCommands = new Map<string, any>();
		const registeredShortcuts = new Map<string, any>();
		const listeners = new Map<string, Array<(...args: any[]) => any>>();
		const sendUserMessageMock = vi.fn();

		const api = {
			registerTool: vi.fn((tool: any) => {
				registeredTools.set(tool.name, tool);
			}),
			registerCommand: vi.fn((name: string, def: any) => {
				registeredCommands.set(name, def);
			}),
			registerShortcut: vi.fn((shortcut: string, def: any) => {
				registeredShortcuts.set(shortcut, def);
			}),
			on: vi.fn((event: string, handler: (...args: any[]) => any) => {
				const list = listeners.get(event) ?? [];
				list.push(handler);
				listeners.set(event, list);
			}),
			sendUserMessage: sendUserMessageMock,
		};

		return {
			api,
			registeredTools,
			registeredCommands,
			registeredShortcuts,
			sendUserMessageMock,
			emit: async (event: string, ...args: any[]) => {
				const handlers = listeners.get(event) ?? [];
				for (const handler of handlers) {
					await handler(...args);
				}
			},
		};
	}

	it("registers /answer-question command and ctrl+q shortcut", () => {
		const mockAPI = createMockExtensionAPI();
		rbfQuestionForm(mockAPI.api as any);

		expect(mockAPI.registeredCommands.has("answer-question")).toBe(true);
		expect(mockAPI.registeredShortcuts.has("ctrl+q")).toBe(true);
	});

	it("opens form on agent_settled and allows /answer-question after Esc to re-open", async () => {
		const mockAPI = createMockExtensionAPI();
		const mockCtx = createMockExtensionContext("tui");
		rbfQuestionForm(mockAPI.api as any);

		const assistantMessage = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: `• Recommendation: Which strategy?

1. Fast strategy ← recommended
2. Slow strategy`,
				},
			],
		};

		// 1. Deliver message on agent_end
		await mockAPI.emit("agent_end", { messages: [assistantMessage] }, mockCtx.ctx);

		// 2. Settle agent -> opens custom form
		const settlePromise = mockAPI.emit("agent_settled", {}, mockCtx.ctx);

		expect(mockCtx.ctx.ui.custom).toHaveBeenCalled();
		expect(mockCtx.customComponent).toBeDefined();

		// 3. User accidentally presses Esc
		mockCtx.customComponent.handleInput("\x1b");
		await settlePromise;

		// No message submitted
		expect(mockAPI.sendUserMessageMock).not.toHaveBeenCalled();

		// 4. User runs /answer-question to restore the question form!
		const answerCmd = mockAPI.registeredCommands.get("answer-question");
		const answerPromise = answerCmd.handler("", mockCtx.ctx);

		expect(mockCtx.customComponent).toBeDefined();

		// 5. User selects option 1 with notes
		mockCtx.customComponent.handleInput("1");
		mockCtx.customComponent.handleInput("\t");
		mockCtx.customComponent.handleInput("u");
		mockCtx.customComponent.handleInput("r");
		mockCtx.customComponent.handleInput("g");
		mockCtx.customComponent.handleInput("e");
		mockCtx.customComponent.handleInput("n");
		mockCtx.customComponent.handleInput("t");
		mockCtx.customComponent.handleInput("\r");

		await answerPromise;

		expect(mockAPI.sendUserMessageMock).toHaveBeenCalledWith(
			"1. Fast strategy ← recommended\n\nurgent",
		);
	});

	it("renders tool representations", () => {
		const mockAPI = createMockExtensionAPI();
		rbfQuestionForm(mockAPI.api as any);

		const qTool = mockAPI.registeredTools.get("question");
		const theme = {
			fg: (_col: string, s: string) => s,
			bold: (s: string) => s,
		};

		const callText = qTool.renderCall({ question: "Pick one?", options: ["A", "B"] }, theme);
		expect(callText).toBeDefined();

		const resultText = qTool.renderResult(
			{ content: [{ type: "text", text: "Waiting..." }], details: { question: "Pick one?", options: ["A", "B"] } },
			{},
			theme,
		);
		expect(resultText).toBeDefined();
	});
});

// ─── Scenario 13: All form rows stay within supplied width ──────────────────

describe("Scenario 13: All form rows stay within supplied width", () => {
	const mockTheme: any = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		getFgAnsi: (color: string) => (color === "borderAccent" ? "\x1b[38;2;86;148;159m" : "\x1b[38;2;40;105;131m"),
	};

	const oneOption = [{ index: 0, label: "First Option", fullText: "1. First Option" }];
	const eightOptions = Array.from({ length: 8 }, (_, i) => ({
		index: i,
		label: `Option ${i + 1} with long descriptive title`,
		fullText: `${i + 1}. Option ${i + 1} with long descriptive title`,
	}));

	const testCases = [
		{
			name: "empty field, write-in, focused",
			isWriteIn: true,
			focus: "notes" as const,
			notesText: "",
			notesCursorPos: 0,
		},
		{
			name: "empty field, write-in, unfocused",
			isWriteIn: true,
			focus: "options" as const,
			notesText: "",
			notesCursorPos: 0,
		},
		{
			name: "empty field, notes, focused",
			isWriteIn: false,
			focus: "notes" as const,
			notesText: "",
			notesCursorPos: 0,
		},
		{
			name: "empty field, notes, unfocused",
			isWriteIn: false,
			focus: "options" as const,
			notesText: "",
			notesCursorPos: 0,
		},
		{
			name: "long prose",
			isWriteIn: true,
			focus: "notes" as const,
			notesText:
				"This is a long write-in answer that easily exceeds forty columns and wraps across visual rows naturally while maintaining cursor position and data integrity across the pane.",
			notesCursorPos: 35,
		},
		{
			name: "overlong token/URL",
			isWriteIn: true,
			focus: "notes" as const,
			notesText:
				"https://subdomain.example.com/very/long/unbreakable/path/without/spaces/that/definitely/exceeds/the/width/of/the/pane/completely/and/forces/hard/wrapping",
			notesCursorPos: 10,
		},
		{
			name: "CJK string",
			isWriteIn: true,
			focus: "notes" as const,
			notesText:
				"日本語のテスト文章です。これは非常に長いテキストであり、複数の行に適切に折り返される必要があります。句読点や漢字も含まれます。",
			notesCursorPos: 15,
		},
		{
			name: "emoji + combining marks",
			isWriteIn: true,
			focus: "notes" as const,
			notesText:
				"Family 👨‍👩‍👧‍👦 rocket 🚀 accents e\u0301 a\u0300 flags 🏳️‍🌈 and lots of extra text to force multiple visual wrapped lines in narrow panes.",
			notesCursorPos: 20,
		},
		{
			name: "multi-space runs",
			isWriteIn: true,
			focus: "notes" as const,
			notesText:
				"Word1       with      many        consecutive           spaces        between     words       and    runs",
			notesCursorPos: 12,
		},
	];

	for (const width of [20, 40, 80]) {
		for (const optCount of [1, 8]) {
			const options = optCount === 1 ? oneOption : eightOptions;
			const chips = buildChips(options);

			for (const tc of testCases) {
				it(`rows <= ${width} width with ${optCount} option(s) for ${tc.name}`, () => {
					const selectedChipIndex = tc.isWriteIn
						? chips.findIndex((c) => c.type === "write-in")
						: 0;

					const lines = renderQuestionFormLines(
						{
							chips,
							selectedChipIndex,
							focus: tc.focus,
							notesText: tc.notesText,
							notesCursorPos: tc.notesCursorPos,
							theme: mockTheme,
						},
						width,
					);

					expect(lines.length).toBeGreaterThan(0);
					for (let i = 0; i < lines.length; i++) {
						const w = visibleWidth(lines[i]);
						expect(w).toBeLessThanOrEqual(width);
					}
				});
			}
		}
	}

	it("wraps label at narrow width 20 like ordinary words", () => {
		const chips = buildChips(oneOption);
		const selectedChipIndex = chips.findIndex((c) => c.type === "write-in");
		const lines = renderQuestionFormLines(
			{
				chips,
				selectedChipIndex,
				focus: "notes",
				notesText: "Custom",
				notesCursorPos: 0,
				theme: mockTheme,
			},
			20,
		);

		// Label "Write in your answer: " should be split across lines at width 20 (maxWidth = 17)
		expect(lines.some((l) => l.includes("Write in your"))).toBe(true);
		expect(lines.some((l) => l.includes("answer:"))).toBe(true);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		}
	});

	it("parity vs wordWrapLine from editor.js over corpus", () => {
		const corpusTexts = [
			"",
			"short text",
			"This is a long write-in answer that easily exceeds forty columns and wraps across visual rows naturally while maintaining cursor position.",
			"https://subdomain.example.com/very/long/unbreakable/path/without/spaces/that/definitely/exceeds/the/width",
			"日本語のテスト文章です。これは非常に長いテキストであり、適切に折り返される必要があります。",
			"Family 👨‍👩‍👧‍👦 rocket 🚀 accents e\u0301 a\u0300 flags 🏳️‍🌈 and lots of extra text",
			"Word1       with      many        consecutive           spaces        between     words",
		];

		const labels = ["Write in your answer: ", "Add notes to selection: "];
		const maxWs = [17, 37, 77]; // corresponding to widths 20, 40, 80 (maxWidth = width - 3)

		for (const maxW of maxWs) {
			for (const label of labels) {
				for (const text of corpusTexts) {
					const fullText = label + text;
					const ourChunks = wordWrapLine(fullText, maxW);
					const editorChunks = editorWordWrapLine(fullText, maxW);

					expect(ourChunks).toEqual(editorChunks);
				}
			}
		}
	});
});

// ─── Fold: non-empty notes/other-label coverage and ANSI-aware width math ───

describe("Wrap coverage beyond focused write-in", () => {
	const mockTheme: any = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		getFgAnsi: (color: string) => (color === "borderAccent" ? "\x1b[38;2;86;148;159m" : "\x1b[38;2;40;105;131m"),
	};
	const chips = buildChips([
		{ index: 0, label: "Alpha", fullText: "1. Alpha" },
		{ index: 1, label: "Beta", fullText: "2. Beta" },
	]);
	const prose =
		"This note is intentionally long enough to wrap across several visual rows when the pane narrows.";

	it("non-empty answer under the Add notes label stays within width", () => {
		for (const width of [20, 40, 80]) {
			const lines = renderQuestionFormLines(
				{ chips, selectedChipIndex: 0, focus: "notes", notesText: prose, notesCursorPos: 12, theme: mockTheme },
				width,
			);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			// The label may wrap across rows at narrow widths; the words stay intact
			const flat = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
			expect(flat).toContain("Add notes");
			expect(flat).toContain("selection:");
		}
	});

	it("non-empty answer while unfocused stays within width and shows no cursor cell", () => {
		for (const width of [20, 40, 80]) {
			const lines = renderQuestionFormLines(
				{ chips, selectedChipIndex: 0, focus: "options", notesText: prose, notesCursorPos: 12, theme: mockTheme },
				width,
			);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			expect(lines.join("\n")).not.toContain("\x1b[7m");
		}
	});

	it("ANSI-styled labels never enter width math", () => {
		const ansiTheme: any = {
			fg: (color: string, text: string) => `\x1b[38;2;40;105;131m${text}\x1b[0m`,
			bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
			getFgAnsi: (color: string) => (color === "borderAccent" ? "\x1b[38;2;86;148;159m" : "\x1b[38;2;40;105;131m"),
		};
		const state: any = {
			chips,
			selectedChipIndex: chips.findIndex((c) => c.type === "write-in"),
			focus: "notes",
			notesText: prose,
			notesCursorPos: 12,
		};
		const plain = renderQuestionFormLines({ ...state, theme: mockTheme }, 40);
		const styled = renderQuestionFormLines({ ...state, theme: ansiTheme }, 40);

		// Same number of visual rows, and each styled row fits after ANSI-stripping
		expect(styled.length).toBe(plain.length);
		const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
		for (let i = 0; i < styled.length; i++) {
			expect(visibleWidth(styled[i])).toBeLessThanOrEqual(40);
			// Layout identical to the plain baseline (cursor row excluded: cursor styling differs by design)
			if (!styled[i].includes("\x1b[7m")) {
				expect(strip(styled[i]).replace(/ +$/, "")).toBe(strip(plain[i]).replace(/ +$/, ""));
			}
		}
	});
});

// ─── Scenario 14: Cursor mapping survives wrap boundaries and resize ─────────

describe("Scenario 14: Cursor mapping survives wrap boundaries and resize", () => {
	const mockTheme: any = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		getFgAnsi: (color: string) => (color === "borderAccent" ? "\x1b[38;2;86;148;159m" : "\x1b[38;2;40;105;131m"),
	};

	const options = [
		{ index: 0, label: "Alpha", fullText: "1. Alpha" },
		{ index: 1, label: "Beta", fullText: "2. Beta" },
	];
	const chips = buildChips(options);
	const writeInIndex = chips.findIndex((c) => c.type === "write-in");

	function getCursorPosition(lines: string[]): { lineIndex: number; column: number; row: string } {
		let foundLine = -1;
		let foundCol = -1;
		let foundRow = "";
		let matchCount = 0;

		for (let i = 0; i < lines.length; i++) {
			const idx = lines[i].indexOf("\x1b[7m");
			if (idx !== -1) {
				matchCount++;
				foundLine = i;
				foundCol = visibleWidth(lines[i].slice(0, idx));
				foundRow = lines[i];
			}
		}

		expect(matchCount).toBe(1);
		return { lineIndex: foundLine, column: foundCol, row: foundRow };
	}

	it("cursor column matches wordWrapLine chunk mapping across widths 20/40/80", () => {
		const label = "Write in your answer: ";
		const text = "This answer wraps naturally across the pane and keeps the cursor.";
		const positions = [0, 2, 12, 33, text.length];

		for (const width of [20, 40, 80]) {
			const maxW = width - 3;
			const chunks = wordWrapLine(label + text, maxW);

			for (const pos of positions) {
				const lines = renderQuestionFormLines(
					{
						chips,
						selectedChipIndex: writeInIndex,
						focus: "notes",
						notesText: text,
						notesCursorPos: pos,
						theme: mockTheme,
					},
					width,
				);
				const { column, lineIndex } = getCursorPosition(lines);

				const abs = label.length + pos;
				let ci = chunks.findIndex((c) => abs >= c.startIndex && abs < c.endIndex);
				if (ci === -1) ci = chunks.length - 1; // end-of-text or chunk-edge → last chunk
				const expectedCol = 2 + visibleWidth(chunks[ci].text.slice(0, abs - chunks[ci].startIndex));
				expect({ width, pos, column, lineIndex }).toMatchObject({ width, pos, column: expectedCol });
			}
		}
	});

	it("focused empty write-in at 20 columns: label wraps, cursor blank after it, hint unreachable", () => {
		const lines = renderQuestionFormLines(
			{
				chips,
				selectedChipIndex: writeInIndex,
				focus: "notes",
				notesText: "",
				notesCursorPos: 0,
				theme: mockTheme,
			},
			20,
		);

		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		}
		expect(lines.some((l) => l.includes("Write in your"))).toBe(true);
		const { column, row } = getCursorPosition(lines);
		// Second chunk carries "answer: " then the cursor blank: 2 (inset) + 8 ("answer: ") = 10
		expect(column).toBe(10);
		expect(row).toContain("answer:");
		expect(row).toContain("\x1b[7m \x1b[0m");
	});

	it("cursor at 0 (start of answer)", () => {
		const lines = renderQuestionFormLines(
			{
				chips,
				selectedChipIndex: writeInIndex,
				focus: "notes",
				notesText: "Hello world",
				notesCursorPos: 0,
				theme: mockTheme,
			},
			80,
		);

		const { column, row } = getCursorPosition(lines);
		// Inset (2) + "Write in your answer: " (22) = 24
		expect(column).toBe(24);
		expect(row).toContain("\x1b[7mH\x1b[0m");
	});

	it("cursor inside a word", () => {
		const lines = renderQuestionFormLines(
			{
				chips,
				selectedChipIndex: writeInIndex,
				focus: "notes",
				notesText: "Hello world",
				notesCursorPos: 2,
				theme: mockTheme,
			},
			80,
		);

		const { column, row } = getCursorPosition(lines);
		// Inset (2) + "Write in your answer: " (22) + 2 = 26
		expect(column).toBe(26);
		expect(row).toContain("\x1b[7ml\x1b[0m");
	});

	it("cursor at wrap boundary moves to next chunk start", () => {
		// At width 40, maxWidth = 37.
		// "Write in your answer: " is 22 chars.
		// "Write in your answer: This answer " is 34 chars <= 37.
		// Next word "wraps" pushes it to wrap at index 34.
		// Cursor at 34 - 22 = 12 (at 'w' of 'wraps')
		const text = "This answer wraps naturally across the pane and keeps the cursor.";
		const lines = renderQuestionFormLines(
			{
				chips,
				selectedChipIndex: writeInIndex,
				focus: "notes",
				notesText: text,
				notesCursorPos: 12, // 'w' in "wraps"
				theme: mockTheme,
			},
			40,
		);

		const { column, row } = getCursorPosition(lines);
		expect(column).toBe(2); // Inset column on row 2
		expect(row).toContain("\x1b[7mw\x1b[0m");
	});

	it("cursor at exact end of full row", () => {
		// Create a line where text exact-fits maxWidth (37 at width 40).
		// "Write in your answer: " (22) + 15 chars = 37 chars.
		const text = "123456789012345";
		const lines = renderQuestionFormLines(
			{
				chips,
				selectedChipIndex: writeInIndex,
				focus: "notes",
				notesText: text,
				notesCursorPos: text.length,
				theme: mockTheme,
			},
			40,
		);

		const { column, row } = getCursorPosition(lines);
		expect(column).toBe(2 + 22 + text.length); // 39 <= 40
		expect(row).toContain("\x1b[7m \x1b[0m");
		expect(visibleWidth(row)).toBeLessThanOrEqual(40);
	});

	it("cursor on LF position renders as inverse blank ending its line", () => {
		const text = "first\nsecond";
		const lines = renderQuestionFormLines(
			{
				chips,
				selectedChipIndex: writeInIndex,
				focus: "notes",
				notesText: text,
				notesCursorPos: 5, // on '\n'
				theme: mockTheme,
			},
			80,
		);

		const { column, row } = getCursorPosition(lines);
		expect(column).toBe(2 + 22 + 5); // 29: after "first"
		expect(row).toContain("first\x1b[7m \x1b[0m");
	});

	it("cursor at start of line after LF", () => {
		const text = "first\nsecond";
		const lines = renderQuestionFormLines(
			{
				chips,
				selectedChipIndex: writeInIndex,
				focus: "notes",
				notesText: text,
				notesCursorPos: 6, // 's' in "second"
				theme: mockTheme,
			},
			80,
		);

		const { column, row } = getCursorPosition(lines);
		expect(column).toBe(2); // start of line after LF, inset 2
		expect(row).toContain("\x1b[7ms\x1b[0m");
	});

	it("cursor in an empty logical line (\\n\\n)", () => {
		const text = "first\n\nthird";
		const lines = renderQuestionFormLines(
			{
				chips,
				selectedChipIndex: writeInIndex,
				focus: "notes",
				notesText: text,
				notesCursorPos: 6, // empty line index
				theme: mockTheme,
			},
			80,
		);

		const { column, row } = getCursorPosition(lines);
		expect(column).toBe(2);
		expect(row).toBe("  \x1b[7m \x1b[0m");
	});

	it("cursor at answer end", () => {
		const text = "finished answer";
		const lines = renderQuestionFormLines(
			{
				chips,
				selectedChipIndex: writeInIndex,
				focus: "notes",
				notesText: text,
				notesCursorPos: text.length,
				theme: mockTheme,
			},
			80,
		);

		const { column, row } = getCursorPosition(lines);
		expect(column).toBe(2 + 22 + text.length);
		expect(row).toContain("\x1b[7m \x1b[0m");
	});

	it("cursor on focused empty write-in (inverse blank between label and (required))", () => {
		const lines = renderQuestionFormLines(
			{
				chips,
				selectedChipIndex: writeInIndex,
				focus: "notes",
				notesText: "",
				notesCursorPos: 0,
				theme: mockTheme,
			},
			80,
		);

		const { column, row } = getCursorPosition(lines);
		expect(column).toBe(2 + 22); // 24
		expect(row).toContain("\x1b[7m \x1b[0m");
		expect(row).toContain("(required)");
	});

	it("reflow 40 -> 20 keeps the mark on the same logical character", () => {
		const text = "This answer wraps across lines nicely.";
		// 'w' of "wraps" is at index 12
		const lines40 = renderQuestionFormLines(
			{
				chips,
				selectedChipIndex: writeInIndex,
				focus: "notes",
				notesText: text,
				notesCursorPos: 12,
				theme: mockTheme,
			},
			40,
		);

		const lines20 = renderQuestionFormLines(
			{
				chips,
				selectedChipIndex: writeInIndex,
				focus: "notes",
				notesText: text,
				notesCursorPos: 12,
				theme: mockTheme,
			},
			20,
		);

		const pos40 = getCursorPosition(lines40);
		const pos20 = getCursorPosition(lines20);

		// Both highlight 'w'
		expect(pos40.row).toContain("\x1b[7mw\x1b[0m");
		expect(pos20.row).toContain("\x1b[7mw\x1b[0m");
	});

	it("unicode cursor covers the whole grapheme (CJK and emoji)", () => {
		// CJK (2 cells)
		const linesCJK = renderQuestionFormLines(
			{
				chips,
				selectedChipIndex: writeInIndex,
				focus: "notes",
				notesText: "日本語テスト",
				notesCursorPos: 0,
				theme: mockTheme,
			},
			80,
		);
		const posCJK = getCursorPosition(linesCJK);
		expect(posCJK.row).toContain("\x1b[7m日\x1b[0m");

		// Complex emoji (multi-codepoint grapheme cluster)
		const linesEmoji = renderQuestionFormLines(
			{
				chips,
				selectedChipIndex: writeInIndex,
				focus: "notes",
				notesText: "👨‍👩‍👧‍👦 family",
				notesCursorPos: 0,
				theme: mockTheme,
			},
			80,
		);
		const posEmoji = getCursorPosition(linesEmoji);
		expect(posEmoji.row).toContain("\x1b[7m👨‍👩‍👧‍👦\x1b[0m");
	});

	it("unicode cursor mid-grapheme covers the whole containing grapheme", () => {
		// Cursor BETWEEN the surrogate halves of 🚀 (code-unit Left: 2 -> 1)
		const linesMidSurrogate = renderQuestionFormLines(
			{
				chips,
				selectedChipIndex: writeInIndex,
				focus: "notes",
				notesText: "a🚀b",
				notesCursorPos: 2, // inside the 🚀 surrogate pair
				theme: mockTheme,
			},
			80,
		);
		const posMid = getCursorPosition(linesMidSurrogate);
		expect(posMid.row).toContain("\x1b[7m🚀\x1b[0m");

		// Cursor ON a zero-width combining mark
		const linesCombining = renderQuestionFormLines(
			{
				chips,
				selectedChipIndex: writeInIndex,
				focus: "notes",
				notesText: "café",
				notesCursorPos: 4, // on the combining mark
				theme: mockTheme,
			},
			80,
		);
		const posComb = getCursorPosition(linesCombining);
		expect(posComb.row).toContain("\x1b[7mé\x1b[0m");
		expect(posComb.row).not.toContain("\x1b[7m\u0301\x1b[0m");

		// Cursor INSIDE a ZWJ family cluster
		const family = "👨‍👩‍👧‍👦";
		const linesZwj = renderQuestionFormLines(
			{
				chips,
				selectedChipIndex: writeInIndex,
				focus: "notes",
				notesText: family,
				notesCursorPos: 3, // between members inside the cluster
				theme: mockTheme,
			},
			80,
		);
		const posZwj = getCursorPosition(linesZwj);
		expect(posZwj.row).toContain(`\x1b[7m${family}\x1b[0m`);
		// The marker must never split the cluster; exactly one marker on the row
		expect(posZwj.row.match(/\x1b\[7m/g)).toHaveLength(1);
	});
});

// ─── Scenario 15: Editing and submission preserve the logical answer ─────────

describe("Scenario 15: Editing and submission preserve the logical answer", () => {
	const mockTheme: any = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};

	it("preserves exact answer text through cursor movement, edits across wrap boundary, and Enter", () => {
		const options = [
			{ index: 0, label: "Opt1", fullText: "1. Opt1" },
			{ index: 1, label: "Opt2", fullText: "2. Opt2" },
		];
		const tui = { requestRender: vi.fn() };
		const done = vi.fn();
		const comp = createQuestionFormComponent(options, tui as any, mockTheme, done);

		// 1. Select Write-in (key 'w')
		comp.handleInput("w");

		// 2. Type text that spans across a wrap boundary at width 40
		const initialText = "This is a custom answer for the form that spans across boundaries";
		for (const ch of initialText) {
			comp.handleInput(ch);
		}

		// Verify component render at 40 columns fits all rows
		const lines = comp.render(40);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		}

		// 3. Move cursor back 25 characters (crosses a wrap boundary)
		for (let i = 0; i < 25; i++) {
			comp.handleInput("\x1b[D"); // Left
		}

		// 4. Delete 4 characters with Backspace
		for (let i = 0; i < 4; i++) {
			comp.handleInput("\x7f");
		}

		// 5. Insert replacement text
		for (const ch of "neat ") {
			comp.handleInput(ch);
		}

		// 6. Second edit on the other side of the wrap boundary: cursor at 41 (after "neat "), insert one character after moving right ten
		for (let i = 0; i < 10; i++) {
			comp.handleInput("\x1b[C"); // Right — lands on the far side of the wrap boundary
		}
		for (const ch of "!") {
			comp.handleInput(ch);
		}

		// 7. Submit with Enter
		comp.handleInput("\r");

		// Expected text: initialText with 4 chars before index (length - 25) replaced with "neat "
		// index: 65 - 25 = 40.
		// chars 36..39 (" tha") were deleted, replaced with "neat "
		// In the new string the cursor sat at 41 after "neat "; +10 lands at 51, and "!" inserts there
		const expectedText = initialText.slice(0, 36) + "neat " + initialText.slice(40, 50) + "!" + initialText.slice(50);
		expect(done).toHaveBeenCalledWith(expectedText);
		// Verify no wrap-generated newlines or trailing spaces entered the answer
		expect(done.mock.calls[0][0]).not.toContain("\n");
	});
});

// ─── Scenario 10: Completed bracketed paste inserts once at the cursor ──────

describe("Scenario 10: Completed bracketed paste inserts once at the cursor", () => {
	const mockTheme: any = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};

	function createComponent() {
		const options = [
			{ index: 0, label: "Alpha", fullText: "1. Alpha" },
			{ index: 1, label: "Beta", fullText: "2. Beta" },
		];
		const tui = { requestRender: vi.fn() };
		const done = vi.fn();
		const comp = createQuestionFormComponent(options, tui as any, mockTheme, done);
		return { comp, tui, done };
	}

	function wrapPaste(payload: string): string {
		return `\x1b[200~${payload}\x1b[201~`;
	}

	it("paste at start of existing notes", () => {
		const { comp, done } = createComponent();
		// Select write-in, type "abcd", move cursor to start
		comp.handleInput("w");
		for (const ch of "abcd") comp.handleInput(ch);
		comp.handleInput("\x1b[H"); // Home

		comp.handleInput(wrapPaste("PASTE"));
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("PASTEabcd");
	});

	it("paste at middle of existing notes", () => {
		const { comp, done } = createComponent();
		comp.handleInput("w");
		for (const ch of "abcd") comp.handleInput(ch);
		// Cursor at 4 (end), move left twice → cursor at 2 (between b and c)
		comp.handleInput("\x1b[D");
		comp.handleInput("\x1b[D");

		comp.handleInput(wrapPaste("PASTE"));
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("abPASTEcd");
	});

	it("paste at end of existing notes", () => {
		const { comp, done } = createComponent();
		comp.handleInput("w");
		for (const ch of "abcd") comp.handleInput(ch);

		comp.handleInput(wrapPaste("PASTE"));
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("abcdPASTE");
	});

	it("cursor lands immediately after the payload", () => {
		const { comp } = createComponent();
		comp.handleInput("w");
		for (const ch of "abcd") comp.handleInput(ch);
		comp.handleInput("\x1b[H"); // Home

		comp.handleInput(wrapPaste("XY"));
		// Cursor should be at 2, so typing 'Z' inserts between payload and original
		comp.handleInput("Z");
		comp.handleInput("\x1b[F"); // End
		const lines = comp.render(80);
		const flat = lines.map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
		expect(flat).toContain("XYZabcd");
	});

	it("cursor advances by the normalized payload length, not the raw one", () => {
		const { comp, done } = createComponent();
		comp.handleInput("w");
		for (const ch of "abcd") comp.handleInput(ch);
		comp.handleInput("\x1b[D");
		comp.handleInput("\x1b[D");

		comp.handleInput(wrapPaste("first\r\nsecond"));
		comp.handleInput("Z");
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("abfirst\nsecondZcd");
	});

	it("markers never appear in state or submission", () => {
		const { comp, done } = createComponent();
		comp.handleInput("w");
		comp.handleInput(wrapPaste("hello"));

		// Check render doesn't contain markers
		const lines = comp.render(80);
		const flat = lines.join("\n");
		expect(flat).not.toContain("200~");
		expect(flat).not.toContain("201~");

		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("hello");
		expect(done.mock.calls[0][0]).not.toContain("200~");
		expect(done.mock.calls[0][0]).not.toContain("201~");
	});

	it("CRLF normalizes to LF", () => {
		const { comp, done } = createComponent();
		comp.handleInput("w");
		comp.handleInput(wrapPaste("first\r\nsecond"));
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("first\nsecond");
	});

	it("lone CR normalizes to LF", () => {
		const { comp, done } = createComponent();
		comp.handleInput("w");
		comp.handleInput(wrapPaste("first\rsecond"));
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("first\nsecond");
	});

	it("internal blank lines are preserved", () => {
		const { comp, done } = createComponent();
		comp.handleInput("w");
		comp.handleInput(wrapPaste("first\n\nthird"));
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("first\n\nthird");
	});

	it("paste into empty write-in", () => {
		const { comp, done } = createComponent();
		comp.handleInput("w");
		comp.handleInput(wrapPaste("pasted text"));
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("pasted text");
	});

	it("paste while focus is on options moves focus to notes", () => {
		const { comp, done } = createComponent();
		// Chip 1 is selected and focus stays on the chips row
		comp.handleInput(wrapPaste("pasted"));

		// Left and printable input must edit notes, not navigate the chips.
		comp.handleInput("\x1b[D");
		comp.handleInput("Z");
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("1. Alpha\n\npasteZd");
	});
});

// ─── Scenario 11: Pi TUI owns raw split chunks and post-paste input ─────────

describe("Scenario 11: Pi TUI owns raw split chunks and post-paste input", () => {
	it("StdinBuffer emits one paste payload from split chunks, then normal data", async () => {
		const { StdinBuffer } = await import("@earendil-works/pi-tui");
		const buf = new StdinBuffer({ timeout: 50, escapeTimeout: 10 });

		const pastePayloads: string[] = [];
		const dataPayloads: string[] = [];

		buf.on("paste", (content: string) => pastePayloads.push(content));
		buf.on("data", (content: string) => dataPayloads.push(content));

		// Simulate raw chunks arriving in three pieces
		buf.process("\x1b[200~first\r\n");
		buf.process("second");
		buf.process("\x1b[201~X");

		// One paste payload with the raw content (no wrappers)
		expect(pastePayloads).toHaveLength(1);
		expect(pastePayloads[0]).toBe("first\r\nsecond");

		// Normal data follows
		expect(dataPayloads).toContain("X");

		buf.destroy();
	});

	it("form receives the paste through the real ProcessTerminal boundary, then handles X normally", async () => {
		const { ProcessTerminal } = await import("@earendil-works/pi-tui");

		const mockTheme: any = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		const options = [
			{ index: 0, label: "Alpha", fullText: "1. Alpha" },
			{ index: 1, label: "Beta", fullText: "2. Beta" },
		];
		const tui = { requestRender: vi.fn() };
		const done = vi.fn();
		const comp = createQuestionFormComponent(options, tui as any, mockTheme, done);

		// Select write-in so paste goes into notes
		comp.handleInput("w");

		// Drive the real boundary: Terminal re-wraps StdinBuffer paste payloads
		const terminal = new ProcessTerminal() as any;
		terminal.inputHandler = (data: string) => comp.handleInput(data);
		terminal.setupStdinBuffer();
		terminal.stdinBuffer.process("\x1b[200~first\r\n");
		terminal.stdinBuffer.process("second");
		terminal.stdinBuffer.process("\x1b[201~X");

		comp.handleInput("\r");

		// "first\r\nsecond" is CRLF in the raw payload, normalized to LF by handleInput;
		// "X" follows as ordinary typing after the paste
		expect(done).toHaveBeenCalledWith("first\nsecondX");
	});
});

// ─── Scenario 17: Pasted terminal controls remain inert ─────────────────────

describe("Scenario 17: Pasted terminal controls stay out of the answer and terminal", () => {
	async function createRecordingForm() {
		const { ProcessTerminal } = await import("@earendil-works/pi-tui");
		const { TuiMainScreen } = await import("@earendil-works/pi-tui/dist/tui-main-screen.js");
		const writes: string[] = [];
		const terminal = {
			columns: 80,
			rows: 24,
			write: (text: string) => writes.push(text),
			hideCursor() {},
			showCursor() {},
		};
		const tui = new TuiMainScreen(terminal as any);
		const done = vi.fn();
		const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const comp = createQuestionFormComponent([{ index: 0, label: "Alpha", fullText: "1. Alpha" }], tui as any, theme, done);
		tui.addChild(comp);
		const source = new ProcessTerminal() as any;
		source.inputHandler = (data: string) => comp.handleInput(data);
		source.setupStdinBuffer();
		return { comp, done, source, tui, writes };
	}

	it.each(["options", "notes"])("blocks an OSC paste before Enter with %s focus", async (focus) => {
		const { comp, done, source, tui, writes } = await createRecordingForm();
		try {
			if (focus === "notes") {
				comp.handleInput("w");
				for (const char of "abcd") comp.handleInput(char);
				comp.handleInput("\x1b[D");
				comp.handleInput("\x1b[D");
			}
			const payload = "a\x1b]52;c;WA==\x07b";
			source.stdinBuffer.process(`\x1b[200~${payload}\x1b[201~`);
			tui.renderNow();
			expect(writes.length).toBeGreaterThan(0);
			const outputBeforeEnter = writes.join("");
			expect(outputBeforeEnter).not.toContain(payload);
			expect(outputBeforeEnter).not.toContain("\x1b]52");
			expect(outputBeforeEnter).not.toContain("WA==\x07b");
			expect(done).not.toHaveBeenCalled();
			if (focus === "notes") comp.handleInput("Z");
			comp.handleInput("\r");
			expect(done).toHaveBeenCalledWith(focus === "notes" ? "aba]52;c;WA==bZcd" : "1. Alpha\n\na]52;c;WA==b");
		} finally {
			source.stdinBuffer.destroy();
		}
	});

	it("filters C0, DEL, and C1 while preserving LF, tab, Unicode, and cursor position", async () => {
		const { comp, done, source, tui, writes } = await createRecordingForm();
		try {
			comp.handleInput("w");
			for (const char of "abcd") comp.handleInput(char);
			comp.handleInput("\x1b[D");
			comp.handleInput("\x1b[D");
			const payload = "A\x00\x08\x0b\x1b\x1f\x7f\x80\x9b\x9f\tΩ\r\nB";
			source.stdinBuffer.process(`\x1b[200~${payload}\x1b[201~`);
			tui.renderNow();
			expect(writes.length).toBeGreaterThan(0);
			const outputBeforeEnter = writes.join("");
			for (const control of ["\x00", "\x08", "\x0b", "\x1f", "\x7f", "\x80", "\x9b", "\x9f"]) {
				expect(outputBeforeEnter).not.toContain(control);
			}
			comp.handleInput("Z");
			comp.handleInput("\r");
			expect(done).toHaveBeenCalledWith("abA\tΩ\nBZcd");
		} finally {
			source.stdinBuffer.destroy();
		}
	});

	it("also filters controls delivered as ordinary input", () => {
		const done = vi.fn();
		const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const comp = createQuestionFormComponent(
			[{ index: 0, label: "Alpha", fullText: "1. Alpha" }],
			{ requestRender: vi.fn() } as any,
			theme,
			done,
		);
		comp.handleInput("w");
		comp.handleInput("\x9b");
		comp.handleInput("a\x00b\x7f\x80c");
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("abc");
	});
});

// ─── Scenario 12: Existing trim and controls remain explicit ────────────────

describe("Scenario 12: Existing trim and controls remain explicit", () => {
	const mockTheme: any = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};

	function createComponent() {
		const options = [
			{ index: 0, label: "Alpha", fullText: "1. Alpha" },
			{ index: 1, label: "Beta", fullText: "2. Beta" },
		];
		const tui = { requestRender: vi.fn() };
		const done = vi.fn();
		const comp = createQuestionFormComponent(options, tui as any, mockTheme, done);
		return { comp, tui, done };
	}

	function wrapPaste(payload: string): string {
		return `\x1b[200~${payload}\x1b[201~`;
	}

	it("leading/trailing whitespace on paste is trimmed by buildSubmissionText", () => {
		const { comp, done } = createComponent();
		comp.handleInput("w");
		comp.handleInput(wrapPaste("  hello world  "));
		comp.handleInput("\r");

		// buildSubmissionText trims for write-in
		expect(done).toHaveBeenCalledWith("hello world");
	});

	it("leading LF on paste is trimmed by buildSubmissionText", () => {
		const { comp, done } = createComponent();
		comp.handleInput("w");
		comp.handleInput(wrapPaste("\nhello"));
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("hello");
	});

	it("trailing LF on paste is trimmed by buildSubmissionText", () => {
		const { comp, done } = createComponent();
		comp.handleInput("w");
		comp.handleInput(wrapPaste("hello\n"));
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("hello");
	});

	it("internal blank lines survive submission", () => {
		const { comp, done } = createComponent();
		comp.handleInput("w");
		comp.handleInput(wrapPaste("first\n\nthird"));
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("first\n\nthird");
	});

	it("Left arrow works after paste", () => {
		const { comp, done } = createComponent();
		comp.handleInput("w");
		comp.handleInput(wrapPaste("abc"));
		// Cursor at 3, move left
		comp.handleInput("\x1b[D");
		// Type 'X' — should insert between b and c
		comp.handleInput("X");
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("abXc");
	});

	it("Right arrow works after paste", () => {
		const { comp, done } = createComponent();
		comp.handleInput("w");
		for (const ch of "ab") comp.handleInput(ch);
		comp.handleInput("\x1b[H"); // Home
		comp.handleInput(wrapPaste("XY"));
		// Cursor at 2, move right
		comp.handleInput("\x1b[C");
		comp.handleInput("Z");
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("XYaZb");
	});

	it("Home after paste moves to start", () => {
		const { comp, done } = createComponent();
		comp.handleInput("w");
		comp.handleInput(wrapPaste("hello"));
		comp.handleInput("\x1b[H");
		comp.handleInput("X");
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("Xhello");
	});

	it("End after paste moves to end", () => {
		const { comp, done } = createComponent();
		comp.handleInput("w");
		for (const ch of "ab") comp.handleInput(ch);
		comp.handleInput("\x1b[H"); // Home
		comp.handleInput(wrapPaste("XY"));
		comp.handleInput("\x1b[F"); // End
		comp.handleInput("Z");
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("XYabZ");
	});

	it("Backspace after paste works", () => {
		const { comp, done } = createComponent();
		comp.handleInput("w");
		comp.handleInput(wrapPaste("abc"));
		comp.handleInput("\x7f"); // Backspace
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("ab");
	});

	it("Escape after paste clears notes, second Esc dismisses", () => {
		const { comp, done } = createComponent();
		comp.handleInput("w");
		comp.handleInput(wrapPaste("hello"));

		// First Esc: clears notes and returns to options
		comp.handleInput("\x1b");
		expect(done).not.toHaveBeenCalled();

		// Second Esc: dismisses
		comp.handleInput("\x1b");
		expect(done).toHaveBeenCalledWith(null);
	});

	it("Enter on empty write-in after cleared paste still blocks", () => {
		const { comp, done } = createComponent();
		comp.handleInput("w");
		comp.handleInput(wrapPaste("hello"));
		// Esc clears
		comp.handleInput("\x1b");
		// Now in options with empty notes, select write-in again
		comp.handleInput("w");
		// Enter should block
		comp.handleInput("\r");
		expect(done).not.toHaveBeenCalled();
	});

	it("ordinary typing after paste works", () => {
		const { comp, done } = createComponent();
		comp.handleInput("w");
		comp.handleInput(wrapPaste("ab"));
		comp.handleInput("c");
		comp.handleInput("d");
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("abcd");
	});

	it("option selection is unaffected by paste support", () => {
		const { comp, done } = createComponent();
		// Select option 2 and submit
		comp.handleInput("2");
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("2. Beta");
	});

	it("option notes (non-write-in) with paste works", () => {
		const { comp, done } = createComponent();
		// Select option 1
		comp.handleInput("1");
		// Tab to notes
		comp.handleInput("\t");
		// Paste into notes
		comp.handleInput(wrapPaste("my note"));
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("1. Alpha\n\nmy note");
	});
});

// ─── Scenario 19: Named Write-in shortcut is exact in source ────────────────

describe("Scenario 19: Named Write-in shortcut is exact in source", () => {
	const mockTheme: any = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		getFgAnsi: (color: string) => (color === "borderAccent" ? "\x1b[38;2;86;148;159m" : "\x1b[38;2;40;105;131m"),
	};

	function createFormHelper(count: number) {
		const options = Array.from({ length: count }, (_, i) => ({
			index: i,
			label: `Choice ${i + 1}`,
			fullText: `${i + 1}. Choice ${i + 1}`,
		}));
		const tui = { requestRender: vi.fn() };
		const done = vi.fn();
		const comp = createQuestionFormComponent(options, tui as any, mockTheme, done);
		return { options, comp, tui, done };
	}

	it("buildChips() emits offered digits, C, then W. Write-in for one, three, and nine answers", () => {
		// 1 option
		const chips1 = buildChips([{ index: 0, label: "Choice 1", fullText: "1. Choice 1" }]);
		expect(chips1).toHaveLength(3);
		expect(chips1.map((c) => c.key)).toEqual(["1", "c", "w"]);
		expect(chips1.map((c) => c.label)).toEqual(["1", "C. /convo-is-very-best", "W. Write-in"]);
		expect(chips1[0].type).toBe("option");
		expect(chips1[1].type).toBe("canned");
		expect(chips1[2].type).toBe("write-in");

		// 3 options
		const chips3 = buildChips([
			{ index: 0, label: "A", fullText: "1. A" },
			{ index: 1, label: "B", fullText: "2. B" },
			{ index: 2, label: "C", fullText: "3. C" },
		]);
		expect(chips3).toHaveLength(5);
		expect(chips3.map((c) => c.key)).toEqual(["1", "2", "3", "c", "w"]);
		expect(chips3.map((c) => c.label)).toEqual(["1", "2", "3", "C. /convo-is-very-best", "W. Write-in"]);
		expect(chips3[4].type).toBe("write-in");

		// 9 options
		const chips9 = buildChips(
			Array.from({ length: 9 }, (_, i) => ({
				index: i,
				label: `Option ${i + 1}`,
				fullText: `${i + 1}. Option ${i + 1}`,
			})),
		);
		expect(chips9).toHaveLength(11);
		expect(chips9.map((c) => c.key)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "c", "w"]);
		expect(chips9.map((c) => c.label)).toEqual([
			"1",
			"2",
			"3",
			"4",
			"5",
			"6",
			"7",
			"8",
			"9",
			"C. /convo-is-very-best",
			"W. Write-in",
		]);
		expect(chips9[10].type).toBe("write-in");
	});

	it("derives direct-key hint and respects render width at 40 and 80 columns", () => {
		for (const count of [1, 3, 9]) {
			const { comp } = createFormHelper(count);

			for (const width of [40, 80]) {
				const lines = comp.render(width);
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}

				const plainText = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
				const hintLine = plainText;
				const directDigits = count === 1 ? "1" : `1-${count}`;
				expect(hintLine).toContain(`[${directDigits}, C, W / ←→]`);
				if (width === 80) {
					if (count === 1) {
						expect(plainText).toContain("[1, C, W / ←→] select · [Tab/↓] notes · [Enter] submit · [Esc] dismiss");
					} else if (count === 3) {
						expect(plainText).toContain("[1-3, C, W / ←→] select · [Tab/↓] notes · [Enter] submit · [Esc] dismiss");
					} else if (count === 9) {
						expect(plainText).toContain("[1-9, C, W / ←→] select · [Tab/↓] notes · [Enter] submit · [Esc] dismiss");
					}
				}
			}
		}

		// Also check focused Write-in and notes hint at 40 and 80 columns
		const { comp: writeInComp } = createFormHelper(3);
		writeInComp.handleInput("w");
		for (const width of [40, 80]) {
			const lines = writeInComp.render(width);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
			const plainText = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
			if (width === 80) {
				expect(plainText.replace(/\s+/g, " ")).toContain("[Tab/↑ top] choices · [Enter] submit · [Shift+Enter] / [Ctrl+J] line · [Esc] close");
			} else if (width === 40) {
				expect(plainText).toContain("[Tab/↑ top] choices · [Enter] submit");
			}
		}

		// Check optional-notes field focus also displays field-focused hint
		const { comp: notesComp } = createFormHelper(3);
		notesComp.handleInput("1"); // Select option 1
		notesComp.handleInput("\t"); // Tab to notes field
		const notesLines80 = notesComp.render(80);
		const notesPlain80 = notesLines80.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
		expect(notesPlain80.replace(/\s+/g, " ")).toContain("[Tab/↑ top] choices · [Enter] submit · [Shift+Enter] / [Ctrl+J] line · [Esc] close");
	});

	it("both 'w' and 'W' on chip focus select Write-in and focus the answer field", () => {
		// Test lowercase 'w'
		const { comp: comp1, done: done1 } = createFormHelper(3);
		comp1.handleInput("w");
		// Verify focus is in answer field by typing without pressing Tab
		comp1.handleInput("h");
		comp1.handleInput("e");
		comp1.handleInput("l");
		comp1.handleInput("l");
		comp1.handleInput("o");
		comp1.handleInput("\r");
		expect(done1).toHaveBeenCalledWith("hello");

		// Test uppercase 'W'
		const { comp: comp2, done: done2 } = createFormHelper(3);
		comp2.handleInput("W");
		comp2.handleInput("c");
		comp2.handleInput("u");
		comp2.handleInput("s");
		comp2.handleInput("t");
		comp2.handleInput("o");
		comp2.handleInput("m");
		comp2.handleInput("\r");
		expect(done2).toHaveBeenCalledWith("custom");
	});

	it("in field focus, 'w' and 'W' type normally instead of re-triggering chip selection", () => {
		// 1. From Write-in field focus
		const { comp: comp1, done: done1 } = createFormHelper(3);
		comp1.handleInput("w"); // Selects Write-in and enters field focus
		comp1.handleInput("w"); // Types 'w'
		comp1.handleInput("W"); // Types 'W'
		comp1.handleInput("o");
		comp1.handleInput("r");
		comp1.handleInput("l");
		comp1.handleInput("d");
		comp1.handleInput("\r");
		expect(done1).toHaveBeenCalledWith("wWorld");

		// 2. From notes focus on an offered answer
		const { comp: comp2, done: done2 } = createFormHelper(3);
		comp2.handleInput("1"); // Selects option 1
		comp2.handleInput("\t"); // Tab to notes
		comp2.handleInput("w"); // Types 'w'
		comp2.handleInput("W"); // Types 'W'
		comp2.handleInput("\r");
		expect(done2).toHaveBeenCalledWith("1. Choice 1\n\nwW");
	});

	it("former N+1 digit does not select Write-in, but selects offered answer if present", () => {
		// With 3 offered answers, former N+1 was 4:
		const { comp: comp3, done: done3 } = createFormHelper(3);
		comp3.handleInput("4"); // Not a valid direct key for 3 options
		comp3.handleInput("\r");
		// Form did not select Write-in; remained on option 1
		expect(done3).toHaveBeenCalledWith("1. Choice 1");

		// With 1 offered answer, former N+1 was 2:
		const { comp: comp1, done: done1 } = createFormHelper(1);
		comp1.handleInput("2"); // Not a valid direct key for 1 option
		comp1.handleInput("\r");
		// Form did not select Write-in; remained on option 1
		expect(done1).toHaveBeenCalledWith("1. Choice 1");

		// With 4 offered answers, 4 names a real offered answer:
		const { comp: comp4, done: done4 } = createFormHelper(4);
		comp4.handleInput("4");
		comp4.handleInput("\r");
		expect(done4).toHaveBeenCalledWith("4. Choice 4");
	});

	it("offered digits 1-9 and C/c select their targets across one, three, and nine options", () => {
		// 1 option: digit 1 and C
		const { comp: c1, done: d1 } = createFormHelper(1);
		c1.handleInput("1");
		c1.handleInput("\r");
		expect(d1).toHaveBeenCalledWith("1. Choice 1");

		const { comp: c1C, done: d1C } = createFormHelper(1);
		c1C.handleInput("C");
		c1C.handleInput("\r");
		expect(d1C).toHaveBeenCalledWith("/skill:convo-is-very-best");

		// 3 options: digit 2, 3, and c
		const { comp: c3_2, done: d3_2 } = createFormHelper(3);
		c3_2.handleInput("2");
		c3_2.handleInput("\r");
		expect(d3_2).toHaveBeenCalledWith("2. Choice 2");

		const { comp: c3_c, done: d3_c } = createFormHelper(3);
		c3_c.handleInput("c");
		c3_c.handleInput("\r");
		expect(d3_c).toHaveBeenCalledWith("/skill:convo-is-very-best");

		// 9 options: test all digits 1..9
		for (let i = 1; i <= 9; i++) {
			const { comp: c9, done: d9 } = createFormHelper(9);
			c9.handleInput(String(i));
			c9.handleInput("\r");
			expect(d9).toHaveBeenCalledWith(`${i}. Choice ${i}`);
		}
	});

	it("empty Write-in blocks Enter submission, non-empty custom text submits exactly", () => {
		const { comp, done } = createFormHelper(3);

		// Select Write-in via 'w'
		comp.handleInput("w");
		// Hit Enter with empty field
		comp.handleInput("\r");
		expect(done).not.toHaveBeenCalled();

		// Hit Enter with whitespace-only field
		comp.handleInput("   ");
		comp.handleInput("\r");
		expect(done).not.toHaveBeenCalled();

		// Type real custom answer and submit
		comp.handleInput("custom answer for pi-19.7");
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("custom answer for pi-19.7");
	});
});

// ─── pi-36: Configured editor actions (movement, deletion, kill ring, undo) ───

describe("pi-36: Configured editor actions (char/word/line movement, deletion, kill ring, undo)", () => {
	it("runtime uses only the public Pi TUI package path so installed extensions can load", () => {
		const source = readFileSync(new URL("./rbf-question-form.ts", import.meta.url), "utf8");
		expect(source).not.toMatch(/from ["']@earendil-works\/pi-tui\/dist\//);
	});

	const mockTheme: any = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};

	function createHelper(opts?: { keybindings?: any }) {
		const options = [
			{ index: 0, label: "Alpha", fullText: "1. Alpha" },
			{ index: 1, label: "Beta", fullText: "2. Beta" },
		];
		const tui = { requestRender: vi.fn() };
		const done = vi.fn();
		const comp = createQuestionFormComponent(options, tui as any, mockTheme, done, opts?.keybindings);
		return { comp, tui, done };
	}

	const stripAnsi = (str: string) => str.replace(/\x1b\[[0-9;]*m/g, "");

	it("word motions match Pi's plain-text word navigation at every grapheme boundary", () => {
		const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
		for (const text of ["one two", "a,b.c", "hey... there", "let’s go", "naïve café", "alpha--beta", "a (b) c", "界字 next", "👨‍👩‍👧‍👦 x", "one\t two"]) {
			const graphemes = [...segmenter.segment(text)].map((part) => part.segment);
			for (let n = 0; n <= graphemes.length; n++) {
				const cursor = graphemes.slice(0, n).join("").length;
				for (const [key, navigate] of [["\x1bb", findWordBackward], ["\x1bf", findWordForward]] as const) {
					const { comp, done } = createHelper();
					comp.handleInput("w");
					comp.handleInput(`\x1b[200~${text}\x1b[201~`);
					comp.handleInput("\x01"); // Start of this one-line answer.
					for (let i = 0; i < n; i++) comp.handleInput("\x06");
					comp.handleInput(key);
					comp.handleInput("§");
					comp.handleInput("\r");
					const next = navigate(text, cursor);
					expect(done, `${JSON.stringify(text)}, cursor ${cursor}, key ${JSON.stringify(key)}`).toHaveBeenCalledWith(
						(text.slice(0, next) + "§" + text.slice(next)).trim(),
					);
				}
			}
		}
	});

	it("Scenario 1: Move and kill a line in Write-in focus", () => {
		const { comp, done } = createHelper();
		// Select Write-in
		comp.handleInput("w");
		// Type alpha\nbeta using completed paste
		comp.handleInput("\x1b[200~alpha\nbeta\x1b[201~");

		// Move cursor to after "be" in "beta": beta starts at index 6, so after "be" is index 8.
		// Move to line start with Ctrl+A, then right twice with Ctrl+F
		comp.handleInput("\x01"); // Ctrl+A (cursorLineStart) -> start of "beta" (index 6)
		comp.handleInput("\x06"); // Ctrl+F -> index 7 ("b")
		comp.handleInput("\x06"); // Ctrl+F -> index 8 ("be")

		// Ctrl+E reaches end of line
		comp.handleInput("\x05"); // Ctrl+E -> end of "beta" (index 10)
		// Move back to after "be" (Left twice)
		comp.handleInput("\x1b[D");
		comp.handleInput("\x1b[D");

		// From after "be", Ctrl+U leaves alpha\nta
		comp.handleInput("\x15"); // Ctrl+U (deleteToLineStart)
		const linesAfterKill = stripAnsi(comp.render(80).join("\n"));
		expect(linesAfterKill).toContain("alpha\n");
		expect(linesAfterKill).toContain("ta");
		expect(linesAfterKill).not.toContain("beta");

		// Ctrl+Y restores alpha\nbeta
		comp.handleInput("\x19"); // Ctrl+Y (yank)
		const linesAfterYank = stripAnsi(comp.render(80).join("\n"));
		expect(linesAfterYank).toContain("beta");

		// Submit with Enter
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("alpha\nbeta");
	});

	it("Scenario 1: Move and kill a line in optional-notes focus", () => {
		const { comp, done } = createHelper();
		// Select Option 1
		comp.handleInput("1");
		// Tab to optional notes
		comp.handleInput("\t");
		// Paste alpha\nbeta
		comp.handleInput("\x1b[200~alpha\nbeta\x1b[201~");

		// Move to line start with Ctrl+A, then right twice
		comp.handleInput("\x01"); // start of "beta"
		comp.handleInput("\x06");
		comp.handleInput("\x06"); // after "be"

		// Ctrl+U leaves alpha\nta
		comp.handleInput("\x15");
		const linesAfterKill = stripAnsi(comp.render(80).join("\n"));
		expect(linesAfterKill).toContain("alpha\n");
		expect(linesAfterKill).toContain("ta");
		expect(linesAfterKill).not.toContain("beta");

		// Ctrl+Y restores alpha\nbeta
		comp.handleInput("\x19");
		const linesAfterYank = stripAnsi(comp.render(80).join("\n"));
		expect(linesAfterYank).toContain("beta");

		// Submit with Enter
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("1. Alpha\n\nalpha\nbeta");
	});

	it("Ctrl+K deletes to line end, second Ctrl+K deletes newline to merge lines", () => {
		const { comp, done } = createHelper();
		comp.handleInput("w");
		comp.handleInput("\x1b[200~alpha\nbeta\x1b[201~");

		// Move to start of beta
		comp.handleInput("\x01");
		// Right twice (after "be")
		comp.handleInput("\x06");
		comp.handleInput("\x06");

		// Ctrl+K removes "ta" to end of line
		comp.handleInput("\x0b");

		// Second Ctrl+K: already at end of line "be", but there is no next line here.
		// Let's test with 3 lines: alpha\nbeta\ngamma
		const { comp: c3, done: d3 } = createHelper();
		c3.handleInput("w");
		c3.handleInput("\x1b[200~alpha\nbeta\ngamma\x1b[201~");
		// Cursor is at end of line 3 ("gamma"). Up arrow moves to line 2 ("beta")
		c3.handleInput("\x1b[A");
		// Move to start of beta
		c3.handleInput("\x01");
		c3.handleInput("\x06");
		c3.handleInput("\x06"); // after "be"
		c3.handleInput("\x0b"); // removes "ta", leaves alpha\nbe\ngamma
		c3.handleInput("\x0b"); // at end of "be", removes "\n", leaves alpha\nbegamma
		c3.handleInput("\r");
		expect(d3).toHaveBeenCalledWith("alpha\nbegamma");
	});

	it("word movement, word deletion, forward delete, and undo on 'one two'", () => {
		const { comp, done } = createHelper();
		comp.handleInput("w");
		comp.handleInput("\x1b[200~one two\x1b[201~");

		// Cursor at end (index 7). Ctrl+B moves by one
		comp.handleInput("\x02"); // cursor at 6 (between w and o)
		comp.handleInput("\x06"); // cursor at 7 (after o)

		// Alt+B moves word backward to start of "two" (index 4)
		comp.handleInput("\x1bb");
		// Alt+B again moves word backward to start of "one" (index 0)
		comp.handleInput("\x1bb");
		// Alt+F moves word forward to end of "one" (index 3)
		comp.handleInput("\x1bf");
		// Alt+F moves word forward to end of "two" (index 7)
		comp.handleInput("\x1bf");

		// Ctrl+W deletes "two", leaving "one "
		comp.handleInput("\x17");
		let plain = stripAnsi(comp.render(80).join("\n"));
		expect(plain).toContain("one ");
		expect(plain).not.toContain("one two");

		// Undo (Ctrl+-) restores "one two"
		comp.handleInput("\x1f");
		plain = stripAnsi(comp.render(80).join("\n"));
		expect(plain).toContain("one two");

		// Move to start of "two" (Alt+B)
		comp.handleInput("\x1bb");
		// Alt+D deletes word forward "two", leaving "one "
		comp.handleInput("\x1bd");
		plain = stripAnsi(comp.render(80).join("\n"));
		expect(plain).toContain("one ");
		expect(plain).not.toContain("one two");

		// Undo restores "one two"
		comp.handleInput("\x1f");
		plain = stripAnsi(comp.render(80).join("\n"));
		expect(plain).toContain("one two");

		// Move to start (Ctrl+A), Delete / Ctrl+D deletes 'o', leaving "ne two"
		comp.handleInput("\x01");
		comp.handleInput("\x04"); // Ctrl+D
		plain = stripAnsi(comp.render(80).join("\n"));
		expect(plain).toContain("ne two");
		expect(plain).not.toContain("one two");

		// Undo restores 'o'
		comp.handleInput("\x1f");
		plain = stripAnsi(comp.render(80).join("\n"));
		expect(plain).toContain("one two");

		// Submit
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("one two");
	});

	it("yank-pop (Alt+Y) cycles through kill ring entries", () => {
		const { comp, done } = createHelper();
		comp.handleInput("w");
		// Type first kill
		comp.handleInput("\x1b[200~first\x1b[201~");
		comp.handleInput("\x01"); // line start
		comp.handleInput("\x0b"); // kill "first"

		// Type second kill
		comp.handleInput("\x1b[200~second\x1b[201~");
		comp.handleInput("\x01");
		comp.handleInput("\x0b"); // kill "second"

		// Yank (Ctrl+Y) inserts most recent: "second"
		comp.handleInput("\x19");
		// Yank-pop (Alt+Y) replaces "second" with "first"
		comp.handleInput("\x1by");

		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("first");
	});

	it("respects custom keybinding manager injected into component", () => {
		const { KeybindingsManager, TUI_KEYBINDINGS } = require("@earendil-works/pi-tui");
		const customKb = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.editor.cursorWordLeft": "ctrl+x",
		});
		const { comp, done } = createHelper({ keybindings: customKb });
		comp.handleInput("w");
		comp.handleInput("\x1b[200~alpha beta\x1b[201~"); // cursor at 10

		// Press custom key Ctrl+X ("\x18") to trigger cursorWordLeft
		comp.handleInput("\x18");
		// Now cursor is at start of beta (index 6). Delete forward (Ctrl+D) deletes 'b'
		comp.handleInput("\x04");

		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("alpha eta");
	});

	it("Scenario 2: multiline visual row navigation with sticky visual column and Up-to-choices exit", () => {
		const { comp, done } = createHelper();
		comp.handleInput("w");
		// Text: "alpha\nb\nlonger"
		// Line 1: alpha (indices 0..4, len 5). Cursor after alph is index 4 (col 4).
		// Line 2: b (index 6, len 1). Max col is 1 (index 7).
		// Line 3: longer (indices 8..13, len 6). Col 4 is index 12 (after "long").
		comp.handleInput("\x1b[200~alpha\nb\nlonger\x1b[201~");

		// Move to start of text:
		// Cursor is currently at end of text (index 14).
		// Up arrow twice moves to line 1
		comp.handleInput("\x1b[A"); // moves to line 2 (b)
		comp.handleInput("\x1b[A"); // moves to line 1 (alpha)
		// Move to start of line with Ctrl+A, then right 4 times to column 4 (after alph)
		comp.handleInput("\x01");
		comp.handleInput("\x06");
		comp.handleInput("\x06");
		comp.handleInput("\x06");
		comp.handleInput("\x06");

		// Verify cursor on line 1: render at 80 cols has cursor on 'a' (index 4)
		let plain = comp.render(80).join("\n");
		expect(plain).toContain("Write in your answer: alph\x1b[7ma\x1b[0m");

		// Down clamps at column 1 of 'b'
		comp.handleInput("\x1b[B"); // Down
		plain = comp.render(80).join("\n");
		expect(plain).toContain("  b\x1b[7m \x1b[0m");

		// Another Down restores column 4 of 'longer'
		comp.handleInput("\x1b[B"); // Down
		plain = comp.render(80).join("\n");
		expect(plain).toContain("  long\x1b[7me\x1b[0mr");

		// Up clamps at column 1 of 'b'
		comp.handleInput("\x1b[A"); // Up
		plain = comp.render(80).join("\n");
		expect(plain).toContain("  b\x1b[7m \x1b[0m");

		// Another Up restores column 4 of 'alpha'
		comp.handleInput("\x1b[A"); // Up
		plain = comp.render(80).join("\n");
		expect(plain).toContain("Write in your answer: alph\x1b[7ma\x1b[0m");

		// Then Up on line 1 returns to choices
		comp.handleInput("\x1b[A"); // Up
		// Now focus should be "options" (chip-focused hint is rendered, no cursor in field)
		plain = comp.render(80).join("\n");
		expect(plain).toContain("select · [Tab/↓] notes · [Enter] submit");

		// Submit with Enter submits the choice with "alpha\nb\nlonger"
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("alpha\nb\nlonger");
	});

	it("Scenario 2: Tab returns directly to choices from any visual row", () => {
		const { comp } = createHelper();
		comp.handleInput("w");
		comp.handleInput("\x1b[200~alpha\nb\nlonger\x1b[201~");
		// Currently on line 3 ("longer")
		comp.handleInput("\t");
		let plain = comp.render(80).join("\n");
		expect(plain).toContain("select · [Tab/↓] notes · [Enter] submit");

		// Tab back to notes, move Up to line 2 ("b")
		comp.handleInput("\t");
		comp.handleInput("\x1b[A");
		// Tab again returns to choices
		comp.handleInput("\t");
		plain = comp.render(80).join("\n");
		expect(plain).toContain("select · [Tab/↓] notes · [Enter] submit");
	});

	it("Scenario 2: Unbroken long line at width 40 wraps and Up traverses visual rows before leaving", () => {
		const { comp } = createHelper();
		comp.handleInput("w");
		// 100-character unbroken line wraps into 3 visual rows at width 40 (maxWidth 37)
		const longText = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz";
		comp.handleInput("\x1b[200~" + longText + "\x1b[201~");

		// Render at 40 cols to establish visual lines
		comp.render(40);

		// Cursor starts at end (on the last visual segment).
		// Pressing Up once moves to the previous visual segment (not choices)
		comp.handleInput("\x1b[A");
		let plain = comp.render(40).join("\n");
		expect(plain).toContain("[Tab/↑ top] choices"); // still in field!

		// Pressing Up again moves to the first visual segment
		comp.handleInput("\x1b[A");
		plain = comp.render(40).join("\n");
		expect(plain).toContain("[Tab/↑ top] choices"); // still in field!

		// Pressing Up on the first visual segment returns to choices
		comp.handleInput("\x1b[A");
		plain = comp.render(40).join("\n");
		expect(plain).toContain("select · [Tab/↓]"); // now in choices!
	});

	it("vertical travel never splits a Unicode grapheme", () => {
		const { comp, done } = createHelper();
		comp.handleInput("w");
		comp.handleInput("\x1b[200~😀\nx\x1b[201~");
		comp.render(80);
		comp.handleInput("\x1b[A"); // The target row has a two-cell emoji, not two editable characters.
		comp.handleInput("\x7f"); // Column 1 falls inside the emoji: clamp left; don't remove a surrogate.
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("😀\nx");
	});

	it("vertical travel measures display cells and restores the requested column", () => {
		const { comp, done } = createHelper();
		comp.handleInput("w");
		comp.handleInput("\x1b[200~界az\nx\nabcd\x1b[201~");
		comp.render(80);
		comp.handleInput("\x1b[D");
		comp.handleInput("\x1b[D"); // Display column 2 on the last row.
		comp.handleInput("\x1b[A"); // Short x row clamps to column 1.
		comp.handleInput("\x1b[A"); // Restore display column 2, just after 界.
		comp.handleInput("!");
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("界!az\nx\nabcd");
	});

	it("Scenario 3: W, a, Ctrl+J, b, Enter submits exactly a\\nb once", () => {
		const { comp, done } = createHelper();
		comp.handleInput("w");
		comp.handleInput("a");
		comp.handleInput("\n"); // Ctrl+J
		comp.handleInput("b");
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledTimes(1);
		expect(done).toHaveBeenCalledWith("a\nb");
	});

	it("Scenario 3: distinct Shift+Enter adds LF but never submits", () => {
		const { comp, done } = createHelper();
		comp.handleInput("w");
		comp.handleInput("a");
		comp.handleInput("\x1b[13;2u"); // Kitty Shift+Enter
		comp.handleInput("b");
		comp.handleInput("\x1b[13;2~"); // CSI Shift+Enter
		comp.handleInput("c");
		expect(done).not.toHaveBeenCalled();

		comp.handleInput("\r");
		expect(done).toHaveBeenCalledTimes(1);
		expect(done).toHaveBeenCalledWith("a\nb\nc");
	});

	it("Scenario 3: paste with terminal control sequences strips ESC and BEL before render and submission", () => {
		const { comp, done } = createHelper();
		comp.handleInput("w");
		// a\x1b]52;c;WA==\x07b
		comp.handleInput("\x1b[200~a\x1b]52;c;WA==\x07b\x1b[201~");
		const rendered = comp.render(80).join("\n");
		expect(rendered).not.toContain("\x1b]52;c;WA==");
		expect(rendered).not.toContain("\x07");

		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("a]52;c;WA==b");
	});

	it("Scenario 3: empty Write-in blocks Enter; Esc clears text then dismisses", () => {
		const { comp, done } = createHelper();
		comp.handleInput("w");
		// Empty Write-in: Enter does not call done
		comp.handleInput("\r");
		expect(done).not.toHaveBeenCalled();

		// Type "x"
		comp.handleInput("x");
		// First Esc clears text and returns to choices
		comp.handleInput("\x1b");
		expect(done).not.toHaveBeenCalled();
		let plain = comp.render(80).join("\n");
		expect(plain).toContain("select · [Tab/↓] notes · [Enter] submit");

		// Second Esc dismisses form (calls done(null))
		comp.handleInput("\x1b");
		expect(done).toHaveBeenCalledWith(null);
	});

	it("Scenario 3: notes selection with 1, Tab, x, Enter submits exactly '1. Alpha\\n\\nx'", () => {
		const { comp, done } = createHelper();
		comp.handleInput("1");
		comp.handleInput("\t");
		comp.handleInput("x");
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("1. Alpha\n\nx");
	});

	it("Scenario 3: Form Enter, Tab, and Escape win collisions with remapped editor actions", () => {
		const { KeybindingsManager, TUI_KEYBINDINGS } = require("@earendil-works/pi-tui");
		// Remap editor actions to enter, tab, and escape
		const collidingKb = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.editor.deleteCharForward": "enter",
			"tui.editor.cursorWordForward": "tab",
			"tui.editor.undo": "escape",
		});
		const { comp, done } = createHelper({ keybindings: collidingKb });
		comp.handleInput("w");
		comp.handleInput("test");

		// Tab should return to choices, not trigger cursorWordForward
		comp.handleInput("\t");
		let plain = comp.render(80).join("\n");
		expect(plain).toContain("select · [Tab/↓] notes · [Enter] submit");

		// Tab back to notes
		comp.handleInput("\t");

		// Escape should clear text and return to choices, not trigger undo
		comp.handleInput("\x1b");
		plain = comp.render(80).join("\n");
		expect(plain).toContain("select · [Tab/↓] notes · [Enter] submit");

		// Retype "hello"
		comp.handleInput("\t");
		comp.handleInput("hello");

		// Enter should submit, not trigger deleteCharForward
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("hello");
	});

	it("an empty sanitized paste does not consume the next undo", () => {
		const { comp, done } = createHelper();
		comp.handleInput("w");
		comp.handleInput("a");
		comp.handleInput("\x1b[200~\x1b\x07\x1b[201~");
		comp.handleInput("\x1f"); // Undo must revert the last actual edit, not an empty paste.
		comp.handleInput("b");
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("b");
	});

	it("a configured input submit chord cannot steal an editor action or submit from options", () => {
		const { KeybindingsManager, TUI_KEYBINDINGS } = require("@earendil-works/pi-tui");
		const kb = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.submit": "ctrl+u" });
		const { comp, done } = createHelper({ keybindings: kb });
		comp.handleInput("\n"); // Ctrl+J has no editing target while choices are focused.
		expect(done).not.toHaveBeenCalled();
		comp.handleInput("w");
		comp.handleInput("alpha");
		comp.handleInput("\x15"); // Ctrl+U deletes the answer instead of submitting it.
		expect(done).not.toHaveBeenCalled();
		comp.handleInput("beta");
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("beta");
	});

	it("unknown escape with CR cannot silently insert a line", () => {
		const { comp, done } = createHelper();
		comp.handleInput("w");
		comp.handleInput("a");
		comp.handleInput("\x1b[999~\r");
		comp.handleInput("b");
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("ab");
	});

	it("Scenario 3: unknown Pi app/history/autocomplete actions and control characters are ignored", () => {
		const { comp, done } = createHelper();
		comp.handleInput("w");
		comp.handleInput("a");
		// Send unknown control characters or app chords: e.g. Ctrl+P (up/prev history in readline), Ctrl+N (next history)
		// which are not bound in TUI_KEYBINDINGS for editor
		comp.handleInput("\x10"); // Ctrl+P
		comp.handleInput("\x0e"); // Ctrl+N
		// Send unknown ANSI sequence
		comp.handleInput("\x1b[999~");
		comp.handleInput("b");
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith("ab");
	});
});


describe("pi-40: mouse question-form selection", () => {
	const theme: any = { fg: (_: string, text: string) => text, bold: (text: string) => text };
	const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
	function form(count = 3, mode = "fullscreen") {
		const done = vi.fn();
		const tui: any = { mode, requestRender: vi.fn() };
		const options = Array.from({ length: count }, (_, i) => normalizeToolOption(["Alpha", "Beta", "Gamma"][i] ?? `Option ${i + 1}`, i));
		const comp = createQuestionFormComponent(options, tui, theme, done);
		return { comp, done, tui };
	}
	type Form = ReturnType<typeof form>;
	function position(f: Form, key: string, width = 80) {
		const lines = plain(f.comp.render(width));
		const label = key === "c" ? (width < 27 ? "C" : "C. /convo-is-very-best") : key === "w" ? "W. Write-in" : key;
		for (const [y, line] of lines.entries()) {
			const x = line.indexOf(`[ ${label} ]`);
			if (x >= 0) return { x, y, width, height: lines.length, cells: visibleWidth(label) + 4 };
		}
		// Initially selected 1 has the exact five-cell footprint in the approved frame.
		if (key === "1" && lines[1].startsWith("    1  ")) return { x: 2, y: 1, width, height: lines.length, cells: 5 };
		throw new Error(`No visible chip ${key}: ${lines.join("\n")}`);
	}
	function event(p: { x: number; y: number; width: number; height: number }, type: string, extras: any = {}) {
		return { ...p, type, button: "left", screenX: p.x, screenY: p.y, shift: false, alt: false, ctrl: false, ...extras } as any;
	}
	function click(f: Form, key: string, width = 80, offset = 0, button = "none") {
		const p = position(f, key, width);
		p.x += offset;
		expect(f.comp.handleMouse(event(p, "press"))).toMatchObject({ handled: true, capture: true });
		f.comp.handleMouse(event(p, "release", { button }));
		expect(f.comp.handleMouse(event(p, "click", { button }))).toMatchObject({ handled: true, focus: true });
	}
	for (const count of [1, 3, 9]) for (const width of [20, 40, 80, 120]) {
		it(`every cell of each complete chip selects once: ${count} options, ${width} columns`, () => {
			for (const key of [...Array.from({ length: count }, (_, i) => String(i + 1)), "c", "w"]) {
				const sample = form(count);
				const target = position(sample, key, width);
				expect(plain(sample.comp.render(width)).every((line) => visibleWidth(line) <= width)).toBe(true);
				for (let cell = 0; cell < target.cells; cell++) {
					const f = form(count);
					click(f, key, width, cell);
					expect(f.done).not.toHaveBeenCalled();
					if (key === "w") f.comp.handleInput("written");
					f.comp.handleInput("\r");
					const expected = key === "c" ? "/skill:convo-is-very-best" : key === "w" ? "written"
						: `${key}. ${["Alpha", "Beta", "Gamma"][Number(key) - 1] ?? `Option ${key}`}`;
					expect(f.done.mock.calls).toEqual([[expected]]);
				}
			}
		});
	}
	it("retains exact multiline payloads from notes focus for numbered, C and W", () => {
		for (const [key, expected] of [["2", "2. Beta\n\nkeep this\n雪🙂"], ["c", "/skill:convo-is-very-best\n\nkeep this\n雪🙂"], ["w", "keep this\n雪🙂"]]) {
			const f = form();
			f.comp.handleInput("\t");
			f.comp.handleInput("\x1b[200~keep this\n雪🙂\x1b[201~");
			click(f, key);
			expect(f.done).not.toHaveBeenCalled();
			f.comp.handleInput("\r");
			expect(f.done.mock.calls).toEqual([[expected]]);
		}
	});
	it("preserves cursor, undo and kill/yank state across mouse focus changes", () => {
		const f = form();
		f.comp.handleInput("\t");
		f.comp.handleInput("abc");
		f.comp.handleInput("\x02"); // cursor between b/c
		click(f, "c");
		click(f, "w");
		f.comp.handleInput("!");
		expect(plain(f.comp.render(80)).join("\n")).toContain("ab!c");
		f.comp.handleInput("\x1f");
		f.comp.handleInput("\x0b"); // kill c, preserving the cursor
		click(f, "2");
		click(f, "w");
		f.comp.handleInput("\x19");
		f.comp.handleInput("\r");
		expect(f.done.mock.calls).toEqual([["abc"]]);
	});
	it("already-selected W focuses its retained field and whitespace W cannot submit", () => {
		const f = form();
		click(f, "w");
		f.comp.handleInput("   ");
		f.comp.handleInput("\r");
		expect(f.done).not.toHaveBeenCalled();
		f.comp.handleInput("\t");
		const lines = plain(f.comp.render(80));
		const y = lines.findIndex((line) => line.includes("W. Write-in"));
		const x = lines[y].indexOf("W. Write-in") - 2;
		const p = { x, y, width: 80, height: lines.length };
		for (const type of ["press", "release", "click"]) f.comp.handleMouse(event(p, type));
		f.comp.handleInput("x");
		f.comp.handleInput("\r");
		expect(f.done.mock.calls).toEqual([["x"]]);
	});
	it("accepts left and none release/click after press, preserving eligibility through unchanged repaint", () => {
		for (const button of ["left", "none"]) {
			const f = form(); const p = position(f, "2");
			f.comp.handleMouse(event(p, "press"));
			f.comp.render(80);
			f.comp.handleMouse(event(p, "release", { button }));
			f.comp.handleMouse(event(p, "click", { button }));
			f.comp.handleMouse(event(p, "click", { button }));
			expect(f.tui.requestRender).toHaveBeenCalledTimes(1);
			f.comp.handleInput("\r");
			expect(f.done.mock.calls).toEqual([["2. Beta"]]);
		}
	});
	it("ignores standalone clicks, other buttons/modifiers, gaps, field, stale and clipped bounds", () => {
		for (const extras of [{ button: "right" }, { button: "middle" }, { shift: true }, { ctrl: true }, { alt: true }, { width: 40 }, { height: 2 }, { x: 0 }, { y: 0 }, { y: 4 }, { x: 7 }]) {
			const f = form(); const p = position(f, "2");
			for (const type of ["press", "release", "click"]) expect(f.comp.handleMouse(event(p, type, extras))).toBeUndefined();
			f.comp.handleInput("\r"); expect(f.done.mock.calls).toEqual([["1. Alpha"]]);
		}
		const f = form(); const p = position(f, "2");
		for (const button of ["left", "none"]) for (const type of ["release", "click", "move", "wheel"]) expect(f.comp.handleMouse(event(p, type, { button }))).toBeUndefined();
	});
	it("cancels drag even after returning, resize even after returning and invalidation", () => {
		for (const cancel of ["drag", "resize", "invalidate", "modifier", "different-target"]) {
			const f = form(); const p = position(f, "2");
			f.comp.handleMouse(event(p, "press"));
			if (cancel === "drag") f.comp.handleMouse(event(p, "drag", { x: p.x + 1 }));
			if (cancel === "resize") { f.comp.render(40); f.comp.render(80); }
			if (cancel === "invalidate") { f.comp.invalidate(); f.comp.render(80); }
			f.comp.handleMouse(event(p, "release", cancel === "modifier" ? { shift: true } : cancel === "different-target" ? { x: 2 } : {}));
			expect(f.comp.handleMouse(event(p, "click"))).toMatchObject({ handled: true });
			f.comp.handleInput("\r"); expect(f.done.mock.calls).toEqual([["1. Alpha"]]);
		}
	});
	it("rejects pre-render, closed and disposed input; reopening has fresh ownership", () => {
		const f = form(); const p = { x: 10, y: 1, width: 80, height: 7 };
		expect(f.comp.handleMouse(event(p, "press"))).toBeUndefined();
		const target = position(f, "2");
		f.comp.handleMouse(event(target, "press")); f.comp.handleInput("\x1b");
		for (const type of ["release", "click"]) expect(f.comp.handleMouse(event(target, type))).toBeUndefined();
		f.comp.handleInput("\r"); expect(f.done.mock.calls).toEqual([[null]]);
		const fresh = form(); click(fresh, "2"); fresh.comp.handleInput("\r");
		expect(fresh.done.mock.calls).toEqual([["2. Beta"]]);
		const disposed = form(); position(disposed, "2"); disposed.comp.dispose();
		expect(disposed.comp.handleMouse(event(target, "press"))).toBeUndefined();
	});
	it("regular mode keeps keyboard operation without a Click hint and width10 fits", () => {
		const f = form(3, "regular"); const p = position(f, "2");
		expect(plain(f.comp.render(80)).join("\n")).not.toContain("Click");
		expect(f.comp.handleMouse(event(p, "press"))).toBeUndefined();
		expect(plain(f.comp.render(10)).every((line) => visibleWidth(line) <= 10)).toBe(true);
		f.comp.handleInput("2"); f.comp.handleInput("\r"); expect(f.done.mock.calls).toEqual([["2. Beta"]]);
	});
	it("matches the 10 active-form frames; dismissal is checked separately", () => {
		const names = ["01-default-80", "02-numbered-with-notes-80", "03-canned-120", "04-write-in-empty-80", "05-write-in-filled-40", "06-default-40", "07-nine-options-40", "08-compact-20", "09-regular-mode-80", "10-dismissed-80", "11-numbered-notes-focused-80"];
		const states = [
			[3, 0, "options", "", 0], [3, 1, "options", "keep this", 9], [3, 3, "options", "keep this", 9],
			[3, 4, "notes", "", 0], [3, 4, "notes", "keep this", 9], [3, 0, "options", "", 0],
			[9, 8, "options", "", 0], [3, 4, "notes", "", 0], [3, 0, "options", "", 0],
			[3, 0, "options", "", 0], [3, 1, "notes", "keep this", 4],
		] as const;
		for (const [i, name] of names.entries()) {
			if (name === "10-dismissed-80") continue; // restored prompt is owned by Pi, not the closed form
			const [count, selectedChipIndex, focus, notesText, notesCursorPos] = states[i];
			const width = Number(name.split("-").at(-1));
			const expected = (JSON.parse(readFileSync(new URL("./fixtures/rbf-question-form/pi40-frames.json", import.meta.url), "utf8")) as Record<string, string>)[name].trimEnd();
			const actual = plain(renderQuestionFormLines({ chips: buildChips(Array.from({ length: count }, (_, j) => normalizeToolOption(`Option ${j + 1}`, j))), selectedChipIndex, focus, notesText, notesCursorPos, theme }, width, name !== "09-regular-mode-80")).join("\n");
			expect(actual.trimEnd(), name).toBe(expected);
		}
	});
});

describe("pi-40: native fullscreen dispatch and custom-UI restoration", () => {
	it.each([20, 40, 80, 120])("routes SGR gestures through the real host at width %i", async (width) => {
		const { InteractiveMode, initTheme } = await import("@earendil-works/pi-coding-agent");
		initTheme("dark", false);
		let input: (data: string) => void = () => {};
		const terminal: any = {
			columns: width, rows: 50, kittyProtocolActive: false,
			start: (onInput: (data: string) => void) => { input = onInput; },
			stop() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
			clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
		};
		const ui = new TuiAltScreen(terminal);
		const editor = { render: () => ["restored prompt"], getText: () => "retained prompt", setText: vi.fn(), handleInput: vi.fn(), invalidate() {} };
		const editorContainer = new Container(); editorContainer.addChild(editor);
		ui.setLayoutRoot(new VStack([{ component: new Text("question transcript", 0, 0), grow: 1 }, editorContainer]));
		const host: any = { ui, editor, editorContainer, keybindings: undefined, disposeActiveSelector() {} };
		const done = vi.fn();
		let comp: ReturnType<typeof createQuestionFormComponent>;
		const result = (InteractiveMode.prototype as any).showExtensionCustom.call(host, (tui: any, theme: any, kb: any, close: any) => {
			comp = createQuestionFormComponent(["Alpha", "Beta", "Gamma"].map(normalizeToolOption), tui, theme, (text) => { done(text); close(text); }, kb);
			return comp;
		});
		await Promise.resolve();
		ui.start();
		try {
			const find = (label: string) => {
				ui.renderNow(true);
				const lines: string[] = (ui as any).currentLayout.lines.map((line: string) => line.replace(/\x1b\[[0-9;]*m/g, ""));
				const y = lines.findIndex((line) => line.includes(label));
				expect(y, label).toBeGreaterThanOrEqual(0);
				return { x: lines[y].indexOf(label), y };
			};
			const send = (p: { x: number; y: number }, button: number, release = false) => input(`\x1b[<${button};${p.x + 1};${p.y + 1}${release ? "m" : "M"}`);
			const mouseSpy = vi.spyOn(comp!, "handleMouse");
			const two = find("[ 2 ]");
			send(two, 0); ui.renderNow(true); send(two, 3, true);
			expect(done).not.toHaveBeenCalled();
			expect(ui.hasActiveSelection()).toBe(false);
			input("\t"); input("keep this\n雪🙂");
			const w = find("[ W. Write-in ]"); send(w, 0); send(w, 0, true);
			input("!");
			const canned = find(width === 20 ? "[ C ]" : "[ C. /convo-is-very-best ]");
			send(canned, 0); send({ ...canned, x: canned.x + 1 }, 32); send(canned, 3, true);
			// A drag does not leave Write-in; Enter still submits the retained custom text.
			input("\r");
			expect(await result, JSON.stringify(mouseSpy.mock.calls)).toBe("keep this\n雪🙂!");
			expect(done.mock.calls).toEqual([["keep this\n雪🙂!"]]);
			expect(editorContainer.children).toEqual([editor]);
			expect(editor.setText).toHaveBeenCalledWith("retained prompt");
			expect(comp!.render(width)).toEqual([]);
			input("x"); expect(editor.handleInput).toHaveBeenCalledWith("x");
		} finally { ui.stop(); }
	});
});

describe("pi-40: temporary hover feedback", () => {
	function setup(mode = "fullscreen") {
		let inputListener: ((position?: { x: number; y: number }) => void) | undefined;
		const removeListener = vi.fn();
		const tui: any = { mode, requestRender: vi.fn(), addInputListener: vi.fn((listener) => { inputListener = listener; return removeListener; }) };
		const theme: any = { fg: (_: string, text: string) => text, bold: (text: string) => text };
		const done = vi.fn();
		const comp = createQuestionFormComponent(["Alpha", "Beta", "Gamma"].map(normalizeToolOption), tui, theme, done, undefined, (listener) => { inputListener = listener; return removeListener; });
		const lines = comp.render(80);
		const x = lines[1].replace(/\x1b\[[0-9;]*m/g, "").indexOf("[ 2 ]");
		const move: any = { type: "move", button: "none", x, y: 1, screenX: x, screenY: 1, width: 80, height: lines.length, shift: false, alt: false, ctrl: false };
		const hovered = () => comp.render(80).some((line) => line.includes("\x1b[7m[ 2 ]\x1b[0m"));
		return { comp, tui, done, move, hovered, removeListener, input: (point?: { x: number; y: number }) => inputListener?.(point) };
	}
	it("highlights the whole chip without selecting, focusing or submitting", () => {
		const f = setup();
		expect(f.comp.handleMouse(f.move)).toBeUndefined();
		expect(f.hovered()).toBe(true);
		expect(f.comp.render(80)[1]).toContain("\x1b[1m 1 ");
		f.comp.handleInput("a");
		expect(f.hovered()).toBe(false);
		f.comp.handleInput("\r");
		expect(f.done).toHaveBeenCalledWith("1. Alpha");
	});
	it("does not redraw unchanged hover and clears on gaps and field movement", () => {
		const f = setup();f.comp.handleMouse(f.move);f.tui.requestRender.mockClear();
		expect(f.comp.handleMouse(f.move)).toBeUndefined();
		expect(f.tui.requestRender).not.toHaveBeenCalled();
		f.comp.handleMouse({ ...f.move, x: f.move.x - 1 });expect(f.hovered()).toBe(false);
		f.comp.handleMouse(f.move);f.comp.handleMouse({ ...f.move, y: 3 });expect(f.hovered()).toBe(false);
	});
	it("clears on an observed pointer outside the entire component, without consuming it", async () => {
		const f = setup();f.comp.handleMouse(f.move);f.input(f.move);expect(f.hovered()).toBe(true);
		expect(f.input()).toBeUndefined();await Promise.resolve();expect(f.hovered()).toBe(false);
	});
	it("preserves hover when the observed pointer stays within the chip", async () => {
		const f = setup();f.comp.handleMouse(f.move);f.input(f.move);f.comp.handleMouse(f.move);
		await Promise.resolve();expect(f.hovered()).toBe(true);
	});
	it("preserves notes, cursor and write-in focus when hovering other choices", () => {
		const f = setup();f.comp.handleInput("w");f.comp.handleInput("keep this");
		const height = f.comp.render(80).length;f.comp.handleMouse({ ...f.move, height });
		f.comp.handleInput("!");f.comp.handleInput("\r");expect(f.done).toHaveBeenCalledWith("keep this!");
	});
	it("clears on resize, invalidation and disposal and removes its passive listener", async () => {
		const f = setup();f.comp.handleMouse(f.move);f.comp.render(40);expect(f.hovered()).toBe(false);
		f.comp.handleMouse(f.move);f.comp.invalidate();expect(f.hovered()).toBe(false);
		f.comp.handleMouse(f.move);f.input();f.comp.dispose();await Promise.resolve();
		expect(f.removeListener).toHaveBeenCalledTimes(1);expect(f.comp.render(80)).toEqual([]);expect(f.comp.handleMouse(f.move)).toBeUndefined();
	});
	it("retains click ownership and cancels drag without hover selecting", () => {
		const f = setup();f.comp.handleMouse(f.move);
		const press = { ...f.move, type: "press", button: "left" };f.comp.handleMouse(press);
		f.comp.handleMouse({ ...press, type: "drag" });f.comp.handleMouse({ ...press, type: "release", button: "none" });f.comp.handleMouse({ ...press, type: "click", button: "none" });
		f.comp.handleInput("\r");expect(f.done).toHaveBeenCalledWith("1. Alpha");
	});
	it("ignores pre-render, stale bounds, modifier motion and regular mode", () => {
		const f = setup();f.comp.invalidate();f.comp.handleMouse(f.move);expect(f.hovered()).toBe(false);
		f.comp.handleMouse({ ...f.move, width: 40 });expect(f.hovered()).toBe(false);
		f.comp.handleMouse({ ...f.move, shift: true });expect(f.hovered()).toBe(false);
		const regular = setup("regular");expect(regular.removeListener).not.toHaveBeenCalled();expect(regular.comp.handleMouse(regular.move)).toBeUndefined();expect(regular.hovered()).toBe(false);
	});
});
