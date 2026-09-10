import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const WIDGET_KEY = "rbf-question-form";

// ─── Option types ────────────────────────────────────────────────────────────

interface NormalizedOption {
	index: number;
	label: string;
	description?: string;
	fullText: string;
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
 * Parse a numbered option line like "1. Codex retries internally — one execution owner ← recommended"
 * into a NormalizedOption.
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
 * Normalize a tool option (string or { label, description }) into a NormalizedOption.
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

// ─── Inline selector widget ─────────────────────────────────────────────────

interface SelectorState {
	options: NormalizedOption[];
	highlightIndex: number;
	theme: Theme;
}

/**
 * Render the inline selector as widget lines.
 */
export function renderSelectorLines(state: SelectorState, width: number): string[] {
	const { options, highlightIndex, theme } = state;
	const lines: string[] = [];
	const renderWidth = Math.max(1, width);

	lines.push(theme.fg("accent", "─".repeat(renderWidth)));

	for (let i = 0; i < options.length; i++) {
		const opt = options[i];
		const selected = i === highlightIndex;
		const prefix = selected ? theme.fg("accent", "▸ ") : "  ";
		const optText = opt.fullText;
		const color = selected ? "accent" : "text";

		// Truncate option text to fit width
		const maxTextWidth = renderWidth - 4; // prefix + padding
		const truncated = visibleWidth(optText) > maxTextWidth
			? truncateToWidth(optText, maxTextWidth) + "…"
			: optText;

		lines.push(`${prefix}${theme.fg(color as any, truncated)}`);

		if (opt.description) {
			const descPrefix = "     ";
			const maxDescWidth = renderWidth - visibleWidth(descPrefix);
			const descLines = wrapTextWithAnsi(opt.description, Math.max(1, maxDescWidth));
			for (const dl of descLines) {
				lines.push(`${descPrefix}${theme.fg("muted", dl)}`);
			}
		}
	}

	lines.push("");
	const hint = options.length <= 9
		? `[1-${options.length}] select · [↑↓/jk] navigate · [Enter] confirm · [Esc] dismiss`
		: `[↑↓/jk] navigate · [Enter] confirm · [Esc] dismiss`;
	const hintWrapped = wrapTextWithAnsi(theme.fg("dim", `  ${hint}`), renderWidth);
	lines.push(...hintWrapped);
	lines.push(theme.fg("accent", "─".repeat(renderWidth)));

	return lines;
}

/**
 * Truncate a string to fit within a visible width.
 */
function truncateToWidth(text: string, maxWidth: number): string {
	let result = "";
	let currentWidth = 0;
	for (const char of text) {
		const charWidth = visibleWidth(char);
		if (currentWidth + charWidth > maxWidth) break;
		result += char;
		currentWidth += charWidth;
	}
	return result;
}

// ─── Extension entry point ──────────────────────────────────────────────────

export default function rbfQuestionForm(pi: ExtensionAPI): void {
	// State shared between event handlers
	let lastAssistantText = "";
	let pendingToolOptions: NormalizedOption[] | null = null;
	let activeSelector: {
		state: SelectorState;
		unsubscribe: () => void;
		dismiss: () => void;
	} | null = null;

	/**
	 * Show the inline selector widget with options.
	 */
	function showSelector(options: NormalizedOption[], ctx: ExtensionContext): void {
		// Don't show if already active or no options
		if (activeSelector || options.length === 0) return;
		if (ctx.mode !== "tui") return;

		const theme = ctx.ui.theme;
		const state: SelectorState = {
			options,
			highlightIndex: 0,
			theme,
		};

		function updateWidget() {
			ctx.ui.setWidget(WIDGET_KEY, (_tui: TUI, _theme: Theme) => {
				return {
					render(w: number): string[] {
						return renderSelectorLines(state, w);
					},
					invalidate() {},
				};
			}, { placement: "belowEditor" });
		}

		function dismiss() {
			if (!activeSelector) return;
			activeSelector.unsubscribe();
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			activeSelector = null;
		}

		function submitOption(opt: NormalizedOption) {
			dismiss();
			pi.sendUserMessage(opt.fullText);
		}

		// Intercept keyboard input
		const unsubscribe = ctx.ui.onTerminalInput((data: string) => {
			if (!activeSelector) return undefined;

			// Number keys 1-9: instant select
			if (data.length === 1 && data >= "1" && data <= "9") {
				const idx = parseInt(data, 10) - 1;
				if (idx < state.options.length) {
					submitOption(state.options[idx]);
					return { consume: true };
				}
			}

			// Arrow up or k: move highlight up
			if (data === "k" || data === "\x1b[A" || matchesKey(data, Key.up)) {
				state.highlightIndex = Math.max(0, state.highlightIndex - 1);
				updateWidget();
				return { consume: true };
			}

			// Arrow down or j: move highlight down
			if (data === "j" || data === "\x1b[B" || matchesKey(data, Key.down)) {
				state.highlightIndex = Math.min(state.options.length - 1, state.highlightIndex + 1);
				updateWidget();
				return { consume: true };
			}

			// Enter: submit highlighted option
			if (data === "\r" || data === "\n" || matchesKey(data, Key.enter)) {
				submitOption(state.options[state.highlightIndex]);
				return { consume: true };
			}

			// Escape: dismiss without submitting
			if (data === "\x1b" || matchesKey(data, Key.escape)) {
				dismiss();
				return { consume: true };
			}

			// Any other printable character: dismiss and let it pass through to editor
			if (data.length === 1 && data >= " " && data <= "~") {
				dismiss();
				return undefined; // let the character pass through to the editor
			}

			return undefined;
		});

		activeSelector = { state, unsubscribe, dismiss };
		updateWidget();
	}

	// ─── Event handlers ──────────────────────────────────────────────────────

	// Capture the last assistant message text on agent_end
	pi.on("agent_end", async (event, _ctx) => {
		lastAssistantText = "";
		if (!event.messages) return;

		// Find the last assistant message
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const msg = event.messages[i] as any;
			if (msg.role === "assistant") {
				// Extract text content from the assistant message
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

	// On agent_settled, check for pending tool options or text detection
	pi.on("agent_settled", async (_event, ctx) => {
		// Priority 1: tool-provided options
		if (pendingToolOptions) {
			const options = pendingToolOptions;
			pendingToolOptions = null;
			showSelector(options, ctx);
			return;
		}

		// Priority 2: text detection heuristic
		if (lastAssistantText) {
			const detectedLines = detectQuestionOptions(lastAssistantText);
			if (detectedLines) {
				const options = detectedLines.map((line, i) => parseNumberedOption(line, i));
				showSelector(options, ctx);
			}
		}
	});

	// Dismiss selector on new agent start
	pi.on("agent_start", async (_event, _ctx) => {
		if (activeSelector) {
			activeSelector.dismiss();
		}
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
				// Store options for presentation on agent_settled
				pendingToolOptions = normalized;
			}

			// Return the question text so it appears in the transcript
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

	// Register alias
	pi.registerTool({
		...toolDef,
		name: "ask_question",
		label: "Ask Question",
	});
}
