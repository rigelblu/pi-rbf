import { describe, expect, it, vi } from "vitest";
import { Key, visibleWidth } from "@earendil-works/pi-tui";
import { wordWrapLine as editorWordWrapLine } from "@earendil-works/pi-tui/dist/components/editor.js";
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
		expect(chips[4]).toEqual({ key: "4", type: "write-in", label: "4. Write-in" });
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
		expect(chips[2].label).toBe("2. Write-in");
	});
});

// ─── buildSubmissionText ────────────────────────────────────────────────────

describe("buildSubmissionText", () => {
	const optChip = { key: "1", type: "option" as const, label: "1", fullText: "1. First choice" };
	const writeInChip = { key: "4", type: "write-in" as const, label: "4. Write-in" };
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
		const positions = ["[ 2 ]", "[ C. /convo-is-very-best ]", "[ 3. Write-in ]"].map((s) => chipRow.indexOf(s));
		expect(positions.every((p) => p >= 0)).toBe(true);
		expect(positions[0]).toBeLessThan(positions[1]);
		expect(positions[1]).toBeLessThan(positions[2]);
		expect(chipRow.indexOf("[ 3. Write-in ]")).toBe(chipRow.length - "[ 3. Write-in ]".length);
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

	it("selects write-in option and focuses notes", () => {
		const { comp, done } = createComponent();

		// 3 is Write-in (2 options + 1)
		comp.handleInput("3");
		// Directly type custom text since write-in auto-focuses notes
		comp.handleInput("M");
		comp.handleInput("y");
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("My");
	});

	it("blocks Enter submission when write-in notes are empty and requires text", () => {
		const { comp, done } = createComponent();

		// 3 is Write-in
		comp.handleInput("3");
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
		comp3.handleInput("3");
		comp3.handleInput("M");
		comp3.handleInput("y");
		comp3.handleInput("\r");
		expect(done3).toHaveBeenCalledWith("My");

		const { comp: comp4, done: done4 } = createComponent();
		comp4.handleInput("3");
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

		// 1. Select Write-in (key '3' for 2 options)
		comp.handleInput("3");

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
		comp.handleInput("3");
		for (const ch of "abcd") comp.handleInput(ch);
		comp.handleInput("\x1b[H"); // Home

		comp.handleInput(wrapPaste("PASTE"));
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("PASTEabcd");
	});

	it("paste at middle of existing notes", () => {
		const { comp, done } = createComponent();
		comp.handleInput("3");
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
		comp.handleInput("3");
		for (const ch of "abcd") comp.handleInput(ch);

		comp.handleInput(wrapPaste("PASTE"));
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("abcdPASTE");
	});

	it("cursor lands immediately after the payload", () => {
		const { comp } = createComponent();
		comp.handleInput("3");
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
		comp.handleInput("3");
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
		comp.handleInput("3");
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
		comp.handleInput("3");
		comp.handleInput(wrapPaste("first\r\nsecond"));
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("first\nsecond");
	});

	it("lone CR normalizes to LF", () => {
		const { comp, done } = createComponent();
		comp.handleInput("3");
		comp.handleInput(wrapPaste("first\rsecond"));
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("first\nsecond");
	});

	it("internal blank lines are preserved", () => {
		const { comp, done } = createComponent();
		comp.handleInput("3");
		comp.handleInput(wrapPaste("first\n\nthird"));
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("first\n\nthird");
	});

	it("paste into empty write-in", () => {
		const { comp, done } = createComponent();
		comp.handleInput("3");
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
		comp.handleInput("3");

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
				comp.handleInput("2");
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
			comp.handleInput("2");
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
		comp.handleInput("2");
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
		comp.handleInput("3");
		comp.handleInput(wrapPaste("  hello world  "));
		comp.handleInput("\r");

		// buildSubmissionText trims for write-in
		expect(done).toHaveBeenCalledWith("hello world");
	});

	it("leading LF on paste is trimmed by buildSubmissionText", () => {
		const { comp, done } = createComponent();
		comp.handleInput("3");
		comp.handleInput(wrapPaste("\nhello"));
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("hello");
	});

	it("trailing LF on paste is trimmed by buildSubmissionText", () => {
		const { comp, done } = createComponent();
		comp.handleInput("3");
		comp.handleInput(wrapPaste("hello\n"));
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("hello");
	});

	it("internal blank lines survive submission", () => {
		const { comp, done } = createComponent();
		comp.handleInput("3");
		comp.handleInput(wrapPaste("first\n\nthird"));
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("first\n\nthird");
	});

	it("Left arrow works after paste", () => {
		const { comp, done } = createComponent();
		comp.handleInput("3");
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
		comp.handleInput("3");
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
		comp.handleInput("3");
		comp.handleInput(wrapPaste("hello"));
		comp.handleInput("\x1b[H");
		comp.handleInput("X");
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("Xhello");
	});

	it("End after paste moves to end", () => {
		const { comp, done } = createComponent();
		comp.handleInput("3");
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
		comp.handleInput("3");
		comp.handleInput(wrapPaste("abc"));
		comp.handleInput("\x7f"); // Backspace
		comp.handleInput("\r");

		expect(done).toHaveBeenCalledWith("ab");
	});

	it("Escape after paste clears notes, second Esc dismisses", () => {
		const { comp, done } = createComponent();
		comp.handleInput("3");
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
		comp.handleInput("3");
		comp.handleInput(wrapPaste("hello"));
		// Esc clears
		comp.handleInput("\x1b");
		// Now in options with empty notes, select write-in again
		comp.handleInput("3");
		// Enter should block
		comp.handleInput("\r");
		expect(done).not.toHaveBeenCalled();
	});

	it("ordinary typing after paste works", () => {
		const { comp, done } = createComponent();
		comp.handleInput("3");
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
