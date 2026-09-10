import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ─── Option types & chips ───────────────────────────────────────────────────

export interface NormalizedOption {
	index: number;
	label: string;
	description?: string;
	fullText: string;
}

export interface QuestionChip {
	key: string;
	type: "option" | "write-in" | "canned";
	label: string;
	fullText?: string;
	cannedCommand?: string;
}

export interface QuestionFormState {
	chips: QuestionChip[];
	selectedChipIndex: number;
	focus: "options" | "notes";
	notesText: string;
	notesCursorPos: number;
	theme: Theme;
}

// ─── Text detection heuristic ────────────────────────────────────────────────

/**
 * Extract numbered option lines from the tail of an assistant message.
 * Returns the option lines if a question pattern is detected, or null.
 *
 * Patterns detected:
 * 1. `Recommendation:` or `User Need Framing:` followed by a numbered list
 * 2. A line ending in `?` immediately preceding a numbered list
 * 3. Any numbered item containing `← recommended` or `(recommended)`
 *
 * Regular tutorial numbered lists do NOT trigger the form.
 */
export function detectQuestionOptions(text: string): string[] | null {
	const lines = text.split("\n");

	// Find all numbered list items (consecutive block at the end of the message)
	const numberedPattern = /^\s*(\d+)\.\s+(.+)/;
	let lastNumberedEnd = -1;
	let firstNumberedStart = -1;

	// Scan backward from end to find the last consecutive block of numbered items
	for (let i = lines.length - 1; i >= 0; i--) {
		const trimmed = lines[i].trim();
		if (trimmed === "") continue; // skip trailing blank lines
		if (numberedPattern.test(trimmed)) {
			if (lastNumberedEnd === -1) lastNumberedEnd = i;
			firstNumberedStart = i;
		} else {
			if (lastNumberedEnd !== -1) break; // we've left the numbered block
		}
	}

	if (lastNumberedEnd === -1 || firstNumberedStart === -1) return null;

	// Extract the numbered items
	const numberedItems: string[] = [];
	for (let i = firstNumberedStart; i <= lastNumberedEnd; i++) {
		const match = lines[i].match(numberedPattern);
		if (match) numberedItems.push(lines[i].trim());
	}

	if (numberedItems.length < 2) return null;

	// Check for question context patterns
	const textBefore = lines.slice(0, firstNumberedStart).join("\n");

	// Pattern 1: Recommendation: or User Need Framing:
	if (/Recommendation:/i.test(textBefore) || /User Need Framing:/i.test(textBefore)) {
		return numberedItems;
	}

	// Pattern 2: A line ending in ? immediately preceding the numbered list
	for (let i = firstNumberedStart - 1; i >= 0; i--) {
		const trimmed = lines[i].trim();
		if (trimmed === "") continue;
		if (trimmed.endsWith("?")) return numberedItems;
		break; // first non-empty line before numbered list doesn't end with ?
	}

	// Pattern 3: Any numbered item with ← recommended or (recommended)
	const recommendedPattern = /←\s*recommended|\(recommended\)/i;
	for (const item of numberedItems) {
		if (recommendedPattern.test(item)) return numberedItems;
	}

	return null;
}

/**
 * Parse a numbered option line into a NormalizedOption.
 */
export function parseNumberedOption(line: string, index: number): NormalizedOption {
	const match = line.match(/^\s*\d+\.\s+(.*)/);
	const label = match ? match[1] : line;
	return {
		index,
		label,
		description: undefined,
		fullText: line.trim(),
	};
}

// ─── Tool schema ─────────────────────────────────────────────────────────────

const OptionObjectSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const OptionSchema = Type.Union([
	Type.String({ description: "Simple option text" }),
	OptionObjectSchema,
]);

const QuestionParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Array(OptionSchema, { description: "Options for the user to choose from" }),
});

/**
 * Normalize a tool option into a NormalizedOption.
 */
export function normalizeToolOption(raw: string | { label: string; description?: string }, index: number): NormalizedOption {
	if (typeof raw === "string") {
		return {
			index,
			label: raw,
			description: undefined,
			fullText: `${index + 1}. ${raw}`,
		};
	}
	return {
		index,
		label: raw.label,
		description: raw.description,
		fullText: `${index + 1}. ${raw.label}`,
	};
}

// ─── Chips & submission helpers ──────────────────────────────────────────────

export function buildChips(options: NormalizedOption[]): QuestionChip[] {
	const chips: QuestionChip[] = options.map((opt, i) => ({
		key: String(i + 1),
		type: "option" as const,
		label: String(i + 1),
		fullText: opt.fullText,
	}));

	// Write-in option
	const writeInKey = String(options.length + 1);
	chips.push({
		key: writeInKey,
		type: "write-in",
		label: `${writeInKey}. Write-in`,
	});

	// Canned reply option
	chips.push({
		key: "c",
		type: "canned",
		label: "C. /convo-is-very-best",
		cannedCommand: "/skill:convo-is-very-best",
	});

	return chips;
}

export function buildSubmissionText(chip: QuestionChip, notes: string): string {
	const trimmedNotes = notes.trim();

	if (chip.type === "canned") {
		const cmd = chip.cannedCommand ?? "/skill:convo-is-very-best";
		if (!trimmedNotes) return cmd;
		return `${cmd}\n\n${trimmedNotes}`;
	}

	if (chip.type === "write-in") {
		if (!trimmedNotes) return "Write-in";
		return trimmedNotes;
	}

	const baseText = chip.fullText ?? chip.label;
	if (!trimmedNotes) return baseText;
	return `${baseText}\n\n${trimmedNotes}`;
}

/**
 * Retrieve active theme from Pi's global symbol registration or package export.
 */
export function getActiveTheme(): any {
	if (typeof globalThis !== "undefined") {
		const globalTheme =
			(globalThis as any)[Symbol.for("@earendil-works/pi-coding-agent:theme")] ??
			(globalThis as any)[Symbol.for("@mariozechner/pi-coding-agent:theme")];
		if (globalTheme) return globalTheme;
	}
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { theme } = require("@earendil-works/pi-coding-agent");
		if (theme) return theme;
	} catch {
		// ignore
	}
	return undefined;
}

/**
 * Style borders and labels using the active theme's border color.
 */
export function styleBorder(theme: any, text: string): string {
	const activeTheme = theme ?? getActiveTheme();
	if (typeof activeTheme?.fg === "function") {
		try {
			return activeTheme.fg("border", text);
		} catch {
			// fallback
		}
	}
	return `\x1b[38;5;75m${text}\x1b[0m`;
}

/**
 * Render active chip using theme colors.
 * Converts borderAccent (foam in rose-pine-dawn, #56949f) into a pill background with light text.
 */
export function renderActiveChip(theme: any, label: string): string {
	const activeTheme = theme ?? getActiveTheme();
	if (typeof activeTheme?.getFgAnsi === "function") {
		try {
			const fgAnsi = activeTheme.getFgAnsi("borderAccent");
			if (fgAnsi) {
				const bgAnsi = fgAnsi.replace("[38;", "[48;");
				return `${bgAnsi}\x1b[1;38;5;255m ${label} \x1b[0m`;
			}
		} catch {
			// fallback
		}
	}
	if (typeof activeTheme?.bg === "function") {
		try {
			return activeTheme.bg("selectedBg", ` ${label} `);
		} catch {
			// fallback
		}
	}
	return `\x1b[7m\x1b[1m ${label} \x1b[0m`;
}

// ─── Component Rendering ────────────────────────────────────────────────────

export function renderQuestionFormLines(state: QuestionFormState, width: number): string[] {
	const { chips, selectedChipIndex, focus, notesText, notesCursorPos, theme } = state;
	const renderWidth = Math.max(20, width);
	const lines: string[] = [];

	// Top border (theme border color)
	const title = " Select Answer ";
	const borderDashCount = Math.max(0, renderWidth - title.length - 1);
	lines.push(styleBorder(theme, "─" + title + "─".repeat(borderDashCount)));

	// Chips row
	const chipRenders = chips.map((chip, idx) => {
		const isSelected = idx === selectedChipIndex;
		if (isSelected) {
			return renderActiveChip(theme, chip.label);
		}
		return theme?.fg ? theme.fg("muted", `[ ${chip.label} ]`) : `[ ${chip.label} ]`;
	});
	lines.push(`  ${chipRenders.join("   ")}`);
	lines.push("");

	// Notes field
	const notesLabel = "  Add notes to selection: ";
	if (focus === "notes") {
		const beforeCursor = notesText.slice(0, notesCursorPos);
		const atCursor = notesText.slice(notesCursorPos, notesCursorPos + 1) || " ";
		const afterCursor = notesText.slice(notesCursorPos + 1);
		const cursorChar = `\x1b[7m${atCursor}\x1b[0m`;
		lines.push(styleBorder(theme, notesLabel) + beforeCursor + cursorChar + afterCursor);
	} else {
		const displayNotes = notesText
			? (theme?.fg ? theme.fg("text", notesText) : notesText)
			: (theme?.fg ? theme.fg("dim", "(optional, press Tab or ↓ to type)") : "(optional, press Tab or ↓ to type)");
		lines.push(styleBorder(theme, notesLabel) + displayNotes);
	}

	lines.push("");

	// Hint line
	const hint = "  [1-4, C / ←→] select · [Tab/↓] notes · [Enter] submit · [Esc] dismiss";
	lines.push(theme?.fg ? theme.fg("dim", hint) : hint);

	// Bottom border (theme border color)
	lines.push(styleBorder(theme, "─".repeat(renderWidth)));

	return lines;
}

// ─── Component Factory ──────────────────────────────────────────────────────

export function createQuestionFormComponent(
	options: NormalizedOption[],
	tui: TUI,
	theme: Theme,
	done: (result: string | null) => void,
) {
	const chips = buildChips(options);
	const state: QuestionFormState = {
		chips,
		selectedChipIndex: 0,
		focus: "options",
		notesText: "",
		notesCursorPos: 0,
		theme,
	};

	function handleInput(data: string): void {
		// Escape handling
		if (data === "\x1b" || matchesKey(data, Key.escape)) {
			if (state.focus === "notes" && state.notesText.length > 0) {
				state.notesText = "";
				state.notesCursorPos = 0;
				state.focus = "options";
				tui.requestRender();
				return;
			}
			done(null);
			return;
		}

		// Enter: submit
		if (data === "\r" || data === "\n" || matchesKey(data, Key.enter)) {
			const selectedChip = state.chips[state.selectedChipIndex];
			const result = buildSubmissionText(selectedChip, state.notesText);
			done(result);
			return;
		}

		if (state.focus === "options") {
			// Number keys 1..9
			if (data.length === 1 && data >= "1" && data <= "9") {
				const num = parseInt(data, 10);
				const targetIdx = state.chips.findIndex((c) => c.key === String(num));
				if (targetIdx !== -1) {
					state.selectedChipIndex = targetIdx;
					if (state.chips[targetIdx].type === "write-in") {
						state.focus = "notes";
					}
					tui.requestRender();
					return;
				}
			}

			// C key for canned reply
			if (data === "c" || data === "C") {
				const targetIdx = state.chips.findIndex((c) => c.type === "canned");
				if (targetIdx !== -1) {
					state.selectedChipIndex = targetIdx;
					tui.requestRender();
					return;
				}
			}

			// Left / h
			if (data === "h" || data === "\x1b[D" || matchesKey(data, Key.left)) {
				state.selectedChipIndex = Math.max(0, state.selectedChipIndex - 1);
				tui.requestRender();
				return;
			}

			// Right / l
			if (data === "l" || data === "\x1b[C" || matchesKey(data, Key.right)) {
				state.selectedChipIndex = Math.min(state.chips.length - 1, state.selectedChipIndex + 1);
				tui.requestRender();
				return;
			}

			// Tab or Down / j -> move to notes
			if (data === "\t" || data === "j" || data === "\x1b[B" || matchesKey(data, Key.tab) || matchesKey(data, Key.down)) {
				state.focus = "notes";
				tui.requestRender();
				return;
			}
		} else {
			// focus === "notes"

			// Tab or Up -> move to options
			if (data === "\t" || data === "\x1b[A" || matchesKey(data, Key.tab) || matchesKey(data, Key.up)) {
				state.focus = "options";
				tui.requestRender();
				return;
			}

			// Backspace
			if (data === "\x7f" || data === "\b" || matchesKey(data, Key.backspace)) {
				if (state.notesCursorPos > 0) {
					state.notesText = state.notesText.slice(0, state.notesCursorPos - 1) + state.notesText.slice(state.notesCursorPos);
					state.notesCursorPos--;
					tui.requestRender();
				}
				return;
			}

			// Left
			if (data === "\x1b[D" || matchesKey(data, Key.left)) {
				state.notesCursorPos = Math.max(0, state.notesCursorPos - 1);
				tui.requestRender();
				return;
			}

			// Right
			if (data === "\x1b[C" || matchesKey(data, Key.right)) {
				state.notesCursorPos = Math.min(state.notesText.length, state.notesCursorPos + 1);
				tui.requestRender();
				return;
			}

			// Home
			if (data === "\x1b[H" || matchesKey(data, Key.home)) {
				state.notesCursorPos = 0;
				tui.requestRender();
				return;
			}

			// End
			if (data === "\x1b[F" || matchesKey(data, Key.end)) {
				state.notesCursorPos = state.notesText.length;
				tui.requestRender();
				return;
			}

			// Printable character
			if (data.length === 1 && data >= " ") {
				state.notesText = state.notesText.slice(0, state.notesCursorPos) + data + state.notesText.slice(state.notesCursorPos);
				state.notesCursorPos++;
				tui.requestRender();
				return;
			}

			// Multi-char text (paste)
			if (data.length > 1 && !data.startsWith("\x1b")) {
				const clean = data.replace(/\r?\n/g, " ");
				state.notesText = state.notesText.slice(0, state.notesCursorPos) + clean + state.notesText.slice(state.notesCursorPos);
				state.notesCursorPos += clean.length;
				tui.requestRender();
				return;
			}
		}
	}

	return {
		render(width: number): string[] {
			return renderQuestionFormLines(state, width);
		},
		handleInput,
		invalidate() {},
	};
}

// ─── Extension entry point ──────────────────────────────────────────────────

export default function rbfQuestionForm(pi: ExtensionAPI): void {
	let lastAssistantText = "";
	let pendingToolOptions: NormalizedOption[] | null = null;
	let lastDetectedOptions: NormalizedOption[] | null = null;
	let isFormOpen = false;

	/**
	 * Open the question form replacing the input box via ctx.ui.custom().
	 */
	async function openQuestionForm(options: NormalizedOption[], ctx: ExtensionContext): Promise<void> {
		if (isFormOpen || options.length === 0) return;
		if (ctx.mode !== "tui") return;

		// Cache for accidental ESC recovery
		lastDetectedOptions = options;
		isFormOpen = true;

		try {
			const customFn = (ctx.ui as any).custom;
			if (typeof customFn === "function") {
				const result = await (ctx.ui as any).custom((tui: TUI, theme: Theme, _kb: any, done: (res: string | null) => void) => {
					return createQuestionFormComponent(options, tui, theme, done);
				});

				if (result) {
					pi.sendUserMessage(result);
				}
			}
		} finally {
			isFormOpen = false;
		}
	}

	// ─── Event handlers ──────────────────────────────────────────────────────

	pi.on("agent_end", async (event, _ctx) => {
		lastAssistantText = "";
		if (!event.messages) return;

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const msg = event.messages[i] as any;
			if (msg.role === "assistant") {
				if (typeof msg.content === "string") {
					lastAssistantText = msg.content;
				} else if (Array.isArray(msg.content)) {
					lastAssistantText = msg.content
						.filter((block: any) => block.type === "text")
						.map((block: any) => block.text)
						.join("\n");
				}
				break;
			}
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		// Priority 1: tool-provided options
		if (pendingToolOptions) {
			const options = pendingToolOptions;
			pendingToolOptions = null;
			await openQuestionForm(options, ctx);
			return;
		}

		// Priority 2: text detection heuristic
		if (lastAssistantText) {
			const detectedLines = detectQuestionOptions(lastAssistantText);
			if (detectedLines) {
				const options = detectedLines.map((line, i) => parseNumberedOption(line, i));
				await openQuestionForm(options, ctx);
			}
		}
	});

	// ─── Slash Commands & Shortcut to re-open after ESC ───────────────────────

	pi.registerCommand("answer-question", {
		description: "Re-open the selection form for the last agent question",
		handler: async (_args, ctx) => {
			if (!lastDetectedOptions || lastDetectedOptions.length === 0) {
				ctx.ui.notify("No recent question options to pick from", "warning");
				return;
			}
			await openQuestionForm(lastDetectedOptions, ctx);
		},
	});

	pi.registerShortcut("ctrl+q", {
		description: "Re-open the selection form for the last agent question",
		handler: async (ctx) => {
			if (!lastDetectedOptions || lastDetectedOptions.length === 0) {
				return;
			}
			await openQuestionForm(lastDetectedOptions, ctx);
		},
	});

	// ─── Tool registration ───────────────────────────────────────────────────

	const toolDef = {
		name: "question",
		label: "Question",
		description: "Ask the user a question and let them pick from options. Use when you need user input to proceed.",
		parameters: QuestionParams,
		executionMode: "sequential" as const,

		async execute(
			_toolCallId: string,
			params: { question: string; options: Array<string | { label: string; description?: string }> },
			_signal: AbortSignal,
			_onUpdate: any,
			ctx: any,
		) {
			const normalized = params.options.map((opt, i) => normalizeToolOption(opt, i));

			if (ctx.mode === "tui") {
				pendingToolOptions = normalized;
			}

			const optionsText = normalized.map((opt) => opt.fullText).join("\n");
			return {
				content: [{ type: "text" as const, text: `${params.question}\n\n${optionsText}\n\nWaiting for user selection...` }],
				details: {
					question: params.question,
					options: normalized.map((o) => o.label),
				},
			};
		},

		renderCall(args: any, theme: any, _context: any) {
			let text = theme.fg("toolTitle", theme.bold("question ")) + theme.fg("muted", args.question);
			const opts = Array.isArray(args.options) ? args.options : [];
			if (opts.length) {
				const labels = opts.map((o: any) => typeof o === "string" ? o : o.label);
				const numbered = labels.map((o: string, i: number) => `${i + 1}. ${o}`);
				text += `\n${theme.fg("dim", `  Options: ${numbered.join(", ")}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result: any, _options: any, theme: any, _context: any) {
			const details = result.details as { question: string; options: string[]; answer?: string } | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			return new Text(theme.fg("muted", "Waiting for selection…"), 0, 0);
		},
	};

	pi.registerTool(toolDef);

	pi.registerTool({
		...toolDef,
		name: "ask_question",
		label: "Ask Question",
	});
}
