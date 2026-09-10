import { describe, expect, it, vi } from "vitest";
import { Key } from "@earendil-works/pi-tui";
import rbfQuestionForm, {
	detectQuestionOptions,
	normalizeToolOption,
	parseNumberedOption,
	renderSelectorLines,
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

// ─── renderSelectorLines ─────────────────────────────────────────────────────

describe("renderSelectorLines", () => {
	const mockTheme: any = {
		fg: (_color: string, text: string) => text,
	};

	function makeOptions(labels: string[]) {
		return labels.map((label, i) => ({
			index: i,
			label,
			description: undefined,
			fullText: `${i + 1}. ${label}`,
		}));
	}

	it("renders all options with highlight on first", () => {
		const options = makeOptions(["Option A", "Option B", "Option C"]);
		const lines = renderSelectorLines({ options, highlightIndex: 0, theme: mockTheme }, 80);

		// Should contain all option texts
		const joined = lines.join("\n");
		expect(joined).toContain("1. Option A");
		expect(joined).toContain("2. Option B");
		expect(joined).toContain("3. Option C");
	});

	it("renders highlight marker on selected option", () => {
		const options = makeOptions(["A", "B"]);
		const lines = renderSelectorLines({ options, highlightIndex: 1, theme: mockTheme }, 80);

		const joined = lines.join("\n");
		// Option B should have the ▸ prefix
		expect(joined).toContain("▸ ");
	});

	it("includes hint line with key instructions", () => {
		const options = makeOptions(["A", "B"]);
		const lines = renderSelectorLines({ options, highlightIndex: 0, theme: mockTheme }, 80);

		const joined = lines.join("\n");
		expect(joined).toContain("[1-2] select");
		expect(joined).toContain("[Enter] confirm");
		expect(joined).toContain("[Esc] dismiss");
	});

	it("renders descriptions when present", () => {
		const options = [{
			index: 0,
			label: "Option A",
			description: "This is a detailed description",
			fullText: "1. Option A",
		}];
		const lines = renderSelectorLines({ options, highlightIndex: 0, theme: mockTheme }, 80);

		const joined = lines.join("\n");
		expect(joined).toContain("This is a detailed description");
	});

	it("starts and ends with separator lines", () => {
		const options = makeOptions(["A"]);
		// Need at least 2 options for the real flow, but rendering works with 1
		const lines = renderSelectorLines({ options, highlightIndex: 0, theme: mockTheme }, 40);

		// First and last lines should be separator dashes
		expect(lines[0]).toMatch(/─+/);
		expect(lines[lines.length - 1]).toMatch(/─+/);
	});
});

// ─── rbfQuestionForm Extension Lifecycle & Interaction ──────────────────────

describe("rbfQuestionForm extension integration", () => {
	function createMockExtensionContext(mode = "tui") {
		let terminalInputListener: ((data: string) => any) | undefined;
		let currentWidget: any = undefined;
		let currentWidgetOptions: any = undefined;

		const ctx = {
			mode,
			hasUI: true,
			cwd: "/test",
			ui: {
				theme: {
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				},
				setWidget: vi.fn((key: string, content: any, options?: any) => {
					currentWidget = content;
					currentWidgetOptions = options;
				}),
				onTerminalInput: vi.fn((listener: (data: string) => any) => {
					terminalInputListener = listener;
					return () => {
						if (terminalInputListener === listener) {
							terminalInputListener = undefined;
						}
					};
				}),
			},
		};

		return {
			ctx,
			get currentWidget() {
				return currentWidget;
			},
			get currentWidgetOptions() {
				return currentWidgetOptions;
			},
			sendTerminalInput(data: string) {
				if (!terminalInputListener) return undefined;
				return terminalInputListener(data);
			},
			hasInputListener() {
				return terminalInputListener !== undefined;
			},
		};
	}

	function createMockExtensionAPI() {
		const registeredTools = new Map<string, any>();
		const listeners = new Map<string, Array<(...args: any[]) => any>>();
		const sendUserMessageMock = vi.fn();

		const api = {
			registerTool: vi.fn((tool: any) => {
				registeredTools.set(tool.name, tool);
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
			sendUserMessageMock,
			emit: async (event: string, ...args: any[]) => {
				const handlers = listeners.get(event) ?? [];
				for (const handler of handlers) {
					await handler(...args);
				}
			},
		};
	}

	it("registers question and ask_question tools with the same schema", () => {
		const mockAPI = createMockExtensionAPI();
		rbfQuestionForm(mockAPI.api as any);

		expect(mockAPI.registeredTools.has("question")).toBe(true);
		expect(mockAPI.registeredTools.has("ask_question")).toBe(true);

		const qTool = mockAPI.registeredTools.get("question");
		const askTool = mockAPI.registeredTools.get("ask_question");

		expect(qTool.name).toBe("question");
		expect(askTool.name).toBe("ask_question");
		expect(qTool.description).toContain("Ask the user a question");
		expect(askTool.description).toContain("Ask the user a question");
	});

	it("executes question tool and presents selector on agent_settled", async () => {
		const mockAPI = createMockExtensionAPI();
		const mockCtx = createMockExtensionContext("tui");
		rbfQuestionForm(mockAPI.api as any);

		const qTool = mockAPI.registeredTools.get("question");
		const result = await qTool.execute(
			"call_1",
			{
				question: "Pick a strategy",
				options: [
					"Option 1: Quick fix",
					{ label: "Option 2: Proper refactor", description: "Takes longer" },
				],
			},
			new AbortController().signal,
			vi.fn(),
			mockCtx.ctx,
		);

		// Returns formatted markdown response for transcript
		expect(result.content[0].text).toContain("Pick a strategy");
		expect(result.content[0].text).toContain("1. Option 1: Quick fix");
		expect(result.content[0].text).toContain("2. Option 2: Proper refactor");
		expect(result.content[0].text).toContain("Waiting for user selection...");

		// Not shown until agent_settled
		expect(mockCtx.ctx.ui.setWidget).not.toHaveBeenCalled();

		// Agent settles
		await mockAPI.emit("agent_settled", {}, mockCtx.ctx);

		expect(mockCtx.ctx.ui.setWidget).toHaveBeenCalledWith(
			"rbf-question-form",
			expect.any(Function),
			{ placement: "belowEditor" },
		);
		expect(mockCtx.hasInputListener()).toBe(true);

		// Renders widget lines correctly
		const widget = mockCtx.currentWidget({ width: 80 }, mockCtx.ctx.ui.theme);
		const rendered = widget.render(80);
		expect(rendered.join("\n")).toContain("1. Option 1: Quick fix");
		expect(rendered.join("\n")).toContain("2. Option 2: Proper refactor");
	});

	it("selects option 1 instantly with number key '1'", async () => {
		const mockAPI = createMockExtensionAPI();
		const mockCtx = createMockExtensionContext("tui");
		rbfQuestionForm(mockAPI.api as any);

		const qTool = mockAPI.registeredTools.get("question");
		await qTool.execute(
			"call_1",
			{
				question: "Choose",
				options: ["Alpha", "Beta"],
			},
			new AbortController().signal,
			vi.fn(),
			mockCtx.ctx,
		);

		await mockAPI.emit("agent_settled", {}, mockCtx.ctx);

		const inputResult = mockCtx.sendTerminalInput("1");
		expect(inputResult).toEqual({ consume: true });

		// Submitted full option text
		expect(mockAPI.sendUserMessageMock).toHaveBeenCalledWith("1. Alpha");

		// Widget dismissed
		expect(mockCtx.ctx.ui.setWidget).toHaveBeenLastCalledWith("rbf-question-form", undefined);
		expect(mockCtx.hasInputListener()).toBe(false);
	});

	it("navigates with 'j' and confirms with Enter", async () => {
		const mockAPI = createMockExtensionAPI();
		const mockCtx = createMockExtensionContext("tui");
		rbfQuestionForm(mockAPI.api as any);

		const qTool = mockAPI.registeredTools.get("question");
		await qTool.execute(
			"call_1",
			{
				question: "Choose",
				options: ["First choice", "Second choice"],
			},
			new AbortController().signal,
			vi.fn(),
			mockCtx.ctx,
		);

		await mockAPI.emit("agent_settled", {}, mockCtx.ctx);

		// Press 'j' to move highlight down to option 2
		const moveDown = mockCtx.sendTerminalInput("j");
		expect(moveDown).toEqual({ consume: true });

		// Press Enter to confirm highlighted option
		const enter = mockCtx.sendTerminalInput("\r");
		expect(enter).toEqual({ consume: true });

		expect(mockAPI.sendUserMessageMock).toHaveBeenCalledWith("2. Second choice");
		expect(mockCtx.hasInputListener()).toBe(false);
	});

	it("navigates up and down with arrow keys", async () => {
		const mockAPI = createMockExtensionAPI();
		const mockCtx = createMockExtensionContext("tui");
		rbfQuestionForm(mockAPI.api as any);

		const qTool = mockAPI.registeredTools.get("question");
		await qTool.execute(
			"call_1",
			{
				question: "Choose",
				options: ["A", "B", "C"],
			},
			new AbortController().signal,
			vi.fn(),
			mockCtx.ctx,
		);

		await mockAPI.emit("agent_settled", {}, mockCtx.ctx);

		mockCtx.sendTerminalInput("\x1b[B"); // to B (index 1)
		mockCtx.sendTerminalInput("\x1b[B"); // to C (index 2)
		mockCtx.sendTerminalInput("\x1b[A"); // back to B (index 1)
		mockCtx.sendTerminalInput("\r");

		expect(mockAPI.sendUserMessageMock).toHaveBeenCalledWith("2. B");
	});

	it("dismisses without submitting when Escape is pressed", async () => {
		const mockAPI = createMockExtensionAPI();
		const mockCtx = createMockExtensionContext("tui");
		rbfQuestionForm(mockAPI.api as any);

		const qTool = mockAPI.registeredTools.get("question");
		await qTool.execute(
			"call_1",
			{
				question: "Choose",
				options: ["Opt 1", "Opt 2"],
			},
			new AbortController().signal,
			vi.fn(),
			mockCtx.ctx,
		);

		await mockAPI.emit("agent_settled", {}, mockCtx.ctx);

		const escResult = mockCtx.sendTerminalInput("\x1b");
		expect(escResult).toEqual({ consume: true });

		// Did not submit message
		expect(mockAPI.sendUserMessageMock).not.toHaveBeenCalled();

		// Widget cleared
		expect(mockCtx.ctx.ui.setWidget).toHaveBeenLastCalledWith("rbf-question-form", undefined);
		expect(mockCtx.hasInputListener()).toBe(false);
	});

	it("dismisses and lets character pass through when user types printable char", async () => {
		const mockAPI = createMockExtensionAPI();
		const mockCtx = createMockExtensionContext("tui");
		rbfQuestionForm(mockAPI.api as any);

		const qTool = mockAPI.registeredTools.get("question");
		await qTool.execute(
			"call_1",
			{
				question: "Choose",
				options: ["Opt 1", "Opt 2"],
			},
			new AbortController().signal,
			vi.fn(),
			mockCtx.ctx,
		);

		await mockAPI.emit("agent_settled", {}, mockCtx.ctx);

		// Typing 'w' (e.g. user starts typing freeform)
		const charResult = mockCtx.sendTerminalInput("w");
		expect(charResult).toBeUndefined(); // NOT consumed, passes through to editor

		// Did not submit message
		expect(mockAPI.sendUserMessageMock).not.toHaveBeenCalled();

		// Widget cleared
		expect(mockCtx.ctx.ui.setWidget).toHaveBeenLastCalledWith("rbf-question-form", undefined);
		expect(mockCtx.hasInputListener()).toBe(false);
	});

	it("auto-detects question from assistant message on agent_settled", async () => {
		const mockAPI = createMockExtensionAPI();
		const mockCtx = createMockExtensionContext("tui");
		rbfQuestionForm(mockAPI.api as any);

		const assistantMessage = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: `• Recommendation: Let Codex own retries inside its active turn.

1. Codex retries internally — one execution owner ← recommended
2. Pi automatically resends — smoother recovery / can duplicate partially completed work
3. Do nothing — simplest / user must re-prompt on any transient error`,
				},
			],
		};

		// agent_end delivers messages
		await mockAPI.emit("agent_end", { messages: [assistantMessage] }, mockCtx.ctx);

		// agent_settled activates selector
		await mockAPI.emit("agent_settled", {}, mockCtx.ctx);

		expect(mockCtx.ctx.ui.setWidget).toHaveBeenCalledWith(
			"rbf-question-form",
			expect.any(Function),
			{ placement: "belowEditor" },
		);

		// Select option 1 via key '1'
		mockCtx.sendTerminalInput("1");
		expect(mockAPI.sendUserMessageMock).toHaveBeenCalledWith(
			"1. Codex retries internally — one execution owner ← recommended",
		);
	});

	it("dismisses active selector when agent_start fires", async () => {
		const mockAPI = createMockExtensionAPI();
		const mockCtx = createMockExtensionContext("tui");
		rbfQuestionForm(mockAPI.api as any);

		const qTool = mockAPI.registeredTools.get("question");
		await qTool.execute(
			"call_1",
			{ question: "Q", options: ["A", "B"] },
			new AbortController().signal,
			vi.fn(),
			mockCtx.ctx,
		);

		await mockAPI.emit("agent_settled", {}, mockCtx.ctx);
		expect(mockCtx.hasInputListener()).toBe(true);

		// New agent turn starts
		await mockAPI.emit("agent_start", {}, mockCtx.ctx);

		expect(mockCtx.ctx.ui.setWidget).toHaveBeenLastCalledWith("rbf-question-form", undefined);
		expect(mockCtx.hasInputListener()).toBe(false);
	});

	it("renders tool call and result representations", () => {
		const mockAPI = createMockExtensionAPI();
		rbfQuestionForm(mockAPI.api as any);

		const qTool = mockAPI.registeredTools.get("question");
		const theme = {
			fg: (_col: string, s: string) => s,
			bold: (s: string) => s,
		};

		const callText = qTool.renderCall({ question: "Which one?", options: ["A", "B"] }, theme);
		expect(callText).toBeDefined();

		const resultText = qTool.renderResult({ content: [{ type: "text", text: "Waiting..." }], details: { question: "Which one?", options: ["A", "B"] } }, {}, theme);
		expect(resultText).toBeDefined();
	});
});

