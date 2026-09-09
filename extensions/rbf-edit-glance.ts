import * as Diff from "diff";
import { keyHint, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export const EDIT_GLANCE_PATCHED_KEY = Symbol.for("rbf.editGlance.patched");
export const ORIGINAL_UPDATE_DISPLAY_KEY = Symbol.for("rbf.editGlance.originalUpdateDisplay");

const FALLBACK_THEME = {
	fg: (_col: string, s: string) => s,
	bg: (_col: string, s: string) => s,
	bold: (s: string) => s,
	inverse: (s: string) => s,
	getColorMode: () => "truecolor",
	name: "dark",
};

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

/** Default cap for changed lines (+ / -) in collapsed glance mode */
export const DEFAULT_MAX_GLANCE_CHANGED_LINES = 8;

export interface EditDiffStats {
	addedLines: number;
	removedLines: number;
	contextLines: number;
}

export interface ParsedDiffLine {
	prefix: "+" | "-" | " ";
	lineNum: string;
	content: string;
	raw: string;
}

export interface FormatGlanceDiffOptions {
	expanded: boolean;
	theme?: any;
	maxGlanceLines?: number;
}

export interface FormatGlanceDiffResult {
	addedCount: number;
	removedCount: number;
	summaryLine: string;
	diffText: string;
	isTruncated: boolean;
	remainingLines: number;
}

/**
 * Parse diff line to extract prefix (+, -, or space), line number, and content.
 * Matches Pi's native diff format: "+123 content" | "-123 content" | " 123 content" | "     ..."
 */
export function parseDiffLine(line: string): ParsedDiffLine | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	const rawPrefix = match[1];
	const prefix = rawPrefix === "+" ? "+" : rawPrefix === "-" ? "-" : " ";
	return {
		prefix,
		lineNum: match[2],
		content: match[3],
		raw: line,
	};
}

/**
 * Replace tabs with 3 spaces for consistent terminal alignment.
 */
export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * Compute word-level diff and highlight changed tokens with reverse video.
 */
export function renderIntraLineDiff(
	oldContent: string,
	newContent: string,
	activeTheme: any,
): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);
	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) {
				removedLine += activeTheme.inverse(value);
			}
		} else if (part.added) {
			let value = part.value;
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) {
				addedLine += activeTheme.inverse(value);
			}
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}

	return { removedLine, addedLine };
}

/**
 * Generate ANSI background color sequence for line-level diff tinting.
 */
export function getDiffBgAnsi(kind: "added" | "removed", activeTheme: any): string {
	const mode = typeof activeTheme.getColorMode === "function" ? activeTheme.getColorMode() : "truecolor";
	const isLight = typeof activeTheme.name === "string" ? activeTheme.name.toLowerCase().includes("light") : false;

	if (mode === "truecolor") {
		if (kind === "removed") {
			return isLight ? "\x1b[48;2;255;235;235m" : "\x1b[48;2;55;20;20m";
		}
		return isLight ? "\x1b[48;2;230;255;235m" : "\x1b[48;2;20;48;25m";
	}

	// 256color fallback
	if (kind === "removed") {
		return isLight ? "\x1b[48;5;224m" : "\x1b[48;5;52m";
	}
	return isLight ? "\x1b[48;5;194m" : "\x1b[48;5;22m";
}

/**
 * Format the summary line matching Claude Code / CleanShot reference:
 * `└ Added <A> lines, removed <R> lines`
 */
export function formatEditSummaryLine(added: number, removed: number, activeTheme: any): string {
	const addedWord = added === 1 ? "line" : "lines";
	const removedWord = removed === 1 ? "line" : "lines";

	return (
		activeTheme.fg("dim", "└ ") +
		activeTheme.fg("dim", "Added ") +
		activeTheme.bold(activeTheme.fg("text", String(added))) +
		activeTheme.fg("dim", ` ${addedWord}, removed `) +
		activeTheme.bold(activeTheme.fg("text", String(removed))) +
		activeTheme.fg("dim", ` ${removedWord}`)
	);
}

/**
 * Format diff text with line counts, glance truncation cap, and per-line background tints.
 */
export function formatGlanceDiff(
	diffText: string,
	options: FormatGlanceDiffOptions,
): FormatGlanceDiffResult {
	const activeTheme = options.theme ?? getActiveTheme();
	const maxGlanceLines = options.maxGlanceLines ?? DEFAULT_MAX_GLANCE_CHANGED_LINES;
	const isExpanded = options.expanded;

	const rawLines = diffText.split("\n");

	// First pass: count added and removed lines
	let addedCount = 0;
	let removedCount = 0;
	for (const rawLine of rawLines) {
		const parsed = parseDiffLine(rawLine);
		if (parsed) {
			if (parsed.prefix === "+") addedCount++;
			else if (parsed.prefix === "-") removedCount++;
		} else {
			if (rawLine.startsWith("+")) addedCount++;
			else if (rawLine.startsWith("-")) removedCount++;
		}
	}

	const summaryLine = formatEditSummaryLine(addedCount, removedCount, activeTheme);

	if (!diffText.trim()) {
		return {
			addedCount,
			removedCount,
			summaryLine,
			diffText: "",
			isTruncated: false,
			remainingLines: 0,
		};
	}

	const removedBg = getDiffBgAnsi("removed", activeTheme);
	const addedBg = getDiffBgAnsi("added", activeTheme);
	const bgReset = "\x1b[49m";

	const formattedLines: string[] = [];
	let changedLinesShown = 0;
	let diffLinesShown = 0;
	let isTruncated = false;
	let i = 0;

	while (i < rawLines.length) {
		const line = rawLines[i];
		const parsed = parseDiffLine(line);

		if (!parsed) {
			formattedLines.push(activeTheme.fg("toolDiffContext", line));
			diffLinesShown++;
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			// Collect consecutive removed lines
			const removedLines: ParsedDiffLine[] = [];
			while (i < rawLines.length) {
				const p = parseDiffLine(rawLines[i]);
				if (!p || p.prefix !== "-") break;
				removedLines.push(p);
				i++;
			}

			// Collect consecutive added lines
			const addedLines: ParsedDiffLine[] = [];
			while (i < rawLines.length) {
				const p = parseDiffLine(rawLines[i]);
				if (!p || p.prefix !== "+") break;
				addedLines.push(p);
				i++;
			}

			// Check if single-line modification (intra-line diff)
			if (removedLines.length === 1 && addedLines.length === 1) {
				if (!isExpanded && changedLinesShown >= maxGlanceLines) {
					isTruncated = true;
					break;
				}

				const removed = removedLines[0];
				const added = addedLines[0];
				const { removedLine, addedLine } = renderIntraLineDiff(
					replaceTabs(removed.content),
					replaceTabs(added.content),
					activeTheme,
				);

				const remText = `-${removed.lineNum} ${removedLine} `;
				const addText = `+${added.lineNum} ${addedLine} `;

				formattedLines.push(`${removedBg}${activeTheme.fg("toolDiffRemoved", remText)}${bgReset}`);
				diffLinesShown++;
				changedLinesShown++;

				if (!isExpanded && changedLinesShown >= maxGlanceLines) {
					isTruncated = true;
					break;
				}

				formattedLines.push(`${addedBg}${activeTheme.fg("toolDiffAdded", addText)}${bgReset}`);
				diffLinesShown++;
				changedLinesShown++;
			} else {
				// Show removed lines
				for (const removed of removedLines) {
					if (!isExpanded && changedLinesShown >= maxGlanceLines) {
						isTruncated = true;
						break;
					}
					const remText = `-${removed.lineNum} ${replaceTabs(removed.content)} `;
					formattedLines.push(`${removedBg}${activeTheme.fg("toolDiffRemoved", remText)}${bgReset}`);
					diffLinesShown++;
					changedLinesShown++;
				}

				if (isTruncated) break;

				// Show added lines
				for (const added of addedLines) {
					if (!isExpanded && changedLinesShown >= maxGlanceLines) {
						isTruncated = true;
						break;
					}
					const addText = `+${added.lineNum} ${replaceTabs(added.content)} `;
					formattedLines.push(`${addedBg}${activeTheme.fg("toolDiffAdded", addText)}${bgReset}`);
					diffLinesShown++;
					changedLinesShown++;
				}

				if (isTruncated) break;
			}
		} else if (parsed.prefix === "+") {
			// Standalone added line
			if (!isExpanded && changedLinesShown >= maxGlanceLines) {
				isTruncated = true;
				break;
			}
			const addText = `+${parsed.lineNum} ${replaceTabs(parsed.content)} `;
			formattedLines.push(`${addedBg}${activeTheme.fg("toolDiffAdded", addText)}${bgReset}`);
			diffLinesShown++;
			changedLinesShown++;
			i++;
		} else {
			// Context line
			formattedLines.push(activeTheme.fg("toolDiffContext", ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			diffLinesShown++;
			i++;
		}
	}

	const remainingLines = isTruncated ? Math.max(0, rawLines.length - diffLinesShown) : 0;
	if (isTruncated && remainingLines > 0) {
		const lineWord = remainingLines === 1 ? "line" : "lines";
		const expandHint = keyHint("app.tools.expand", "to expand");
		const hintLine = `${activeTheme.fg("muted", `... (${remainingLines} more ${lineWord},`)} ${expandHint}${activeTheme.fg("muted", ")")}`;
		formattedLines.push(hintLine);
	}

	return {
		addedCount,
		removedCount,
		summaryLine,
		diffText: formattedLines.join("\n"),
		isTruncated,
		remainingLines,
	};
}

/**
 * Patch ToolExecutionComponent instance specifically when executing `edit`.
 */
export function patchEditComponent(comp: any): void {
	const callComponent = comp.callRendererComponent;
	if (!callComponent || !(callComponent instanceof Box)) {
		return;
	}

	const callBox = callComponent as any;

	// 1. Unbox container so it blends directly into the terminal background
	callBox.setBgFn(undefined);
	callBox.paddingY = 0;
	callBox.paddingX = 0;

	// 2. If preview diff exists, format unboxed glance view
	const preview = callBox.preview;
	if (!preview || !("diff" in preview) || typeof preview.diff !== "string") {
		callBox.invalidateCache?.();
		return;
	}

	const formatted = formatGlanceDiff(preview.diff, {
		expanded: !!comp.expanded,
		theme: getActiveTheme(),
		maxGlanceLines: DEFAULT_MAX_GLANCE_CHANGED_LINES,
	});

	// Preserve initial header Text (child 0)
	const headerComponent = callComponent.children[0];

	callComponent.clear();
	if (headerComponent) {
		callComponent.addChild(headerComponent);
	}
	callComponent.addChild(new Text(formatted.summaryLine, 0, 0));
	if (formatted.diffText) {
		callComponent.addChild(new Text(formatted.diffText, 0, 0));
	}
	callBox.invalidateCache?.();
}

/**
 * Patch ToolExecutionComponent to blend edit tool executions into the background,
 * show an immediate summary of lines added and removed, cap large diffs to a glance,
 * and provide line-level background tinting.
 */
export function applyEditGlance(): boolean {
	const proto = ToolExecutionComponent.prototype as any;
	if (proto[EDIT_GLANCE_PATCHED_KEY]) {
		return false;
	}

	const originalUpdateDisplay = proto.updateDisplay;
	proto[ORIGINAL_UPDATE_DISPLAY_KEY] = originalUpdateDisplay;

	proto.updateDisplay = function (this: any): void {
		originalUpdateDisplay.call(this);

		if (this.toolName === "edit") {
			patchEditComponent(this);
		}
	};

	proto[EDIT_GLANCE_PATCHED_KEY] = true;
	return true;
}

/**
 * Restore ToolExecutionComponent.prototype.updateDisplay to its unpatched implementation.
 */
export function restoreEditGlance(): boolean {
	const proto = ToolExecutionComponent.prototype as any;
	if (!proto[EDIT_GLANCE_PATCHED_KEY]) {
		return false;
	}

	if (proto[ORIGINAL_UPDATE_DISPLAY_KEY]) {
		proto.updateDisplay = proto[ORIGINAL_UPDATE_DISPLAY_KEY];
		delete proto[ORIGINAL_UPDATE_DISPLAY_KEY];
	}
	delete proto[EDIT_GLANCE_PATCHED_KEY];
	return true;
}

export default function rbfEditGlance(_pi?: ExtensionAPI): void {
	applyEditGlance();
}
