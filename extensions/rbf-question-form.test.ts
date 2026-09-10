import { describe, expect, it, vi } from "vitest";
import { Key } from "@earendil-works/pi-tui";
import rbfQuestionForm, {
	buildChips,
	buildSubmissionText,
	createQuestionFormComponent,
	detectQuestionOptions,
	normalizeToolOption,
	parseNumberedOption,
	renderQuestionFormLines,
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
		expect(chips[3]).toEqual({ key: "4", type: "write-in", label: "4. Write-in" });
		expect(chips[4]).toEqual({
			key: "c",
			type: "canned",
			label: "C. /convo-is-very-best",
			cannedCommand: "/skill:convo-is-very-best",
		});
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
