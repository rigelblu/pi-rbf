import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

export const MARKDOWN_CLEAN_CODE_PATCHED_KEY = Symbol.for("rbf.cleanMarkdownCode.markdownPatched");
export const ORIGINAL_RENDER_TOKEN_KEY = Symbol.for("rbf.cleanMarkdownCode.originalRenderToken");
export const TOOL_EXECUTION_READ_PATCHED_KEY = Symbol.for("rbf.cleanMarkdownCode.toolExecutionPatched");
export const ORIGINAL_UPDATE_DISPLAY_KEY = Symbol.for("rbf.cleanMarkdownCode.originalUpdateDisplay");

/**
 * Highlight section headers and config syntax in read output and markdown code blocks.
 */
export function highlightConfigSections(text: string, theme?: any): string {
	if (!text) return text;
	const activeTheme =
		theme ??
		(typeof globalThis !== "undefined"
			? (globalThis as any)[Symbol.for("@earendil-works/pi-coding-agent:theme")]
			: undefined);

	const lines = text.split("\n");
	return lines
		.map((line) => {
			const plain = line.replace(/\x1b\[[0-9;]*m/g, "");

			// Section header: [section] or [[array-of-tables]]
			const sectionMatch = plain.match(/^(\s*)(\[[A-Za-z0-9_.-]+(?:(?:\s*,\s*|\s+)[A-Za-z0-9_.-]+)*\])(\s*(?:#.*)?)$/);
			if (sectionMatch) {
				const [, lead, header, trail] = sectionMatch;
				const styledHeader = activeTheme
					? activeTheme.fg("syntaxNumber", header)
					: `\x1b[38;2;144;122;169m${header}\x1b[39m`;
				const styledTrail = trail
					? activeTheme
						? activeTheme.fg("syntaxComment", trail)
						: `\x1b[38;2;40;105;131m${trail}\x1b[39m`
					: "";
				return `${lead}${styledHeader}${styledTrail}`;
			}

			// Key-value pair if unhighlighted: key = "value"
			const hasMultipleColors = (line.match(/\x1b\[38;2;[0-9;]+m/g) || []).length > 1;
			if (!hasMultipleColors) {
				const kvMatch = plain.match(/^(\s*)([A-Za-z0-9_.-]+)(\s*=\s*)([\s\S]*)$/);
				if (kvMatch) {
					const [, lead, key, eq, rest] = kvMatch;
					const styledKey = activeTheme
						? activeTheme.fg("syntaxVariable", key)
						: `\x1b[38;2;86;148;159m${key}\x1b[39m`;
					const restCommentMatch = rest.match(/^([\s\S]*?)(\s*#.*)$/);
					const valPart = restCommentMatch ? restCommentMatch[1] : rest;
					const commentPart = restCommentMatch ? restCommentMatch[2] : "";

					let styledVal = valPart;
					const trimmedVal = valPart.trim();
					if (/^["'].*["']$/.test(trimmedVal)) {
						styledVal = activeTheme
							? activeTheme.fg("syntaxString", valPart)
							: `\x1b[38;2;171;82;108m${valPart}\x1b[39m`;
					} else if (/^(true|false|[0-9]+(?:\.[0-9]+)?)$/.test(trimmedVal)) {
						styledVal = activeTheme
							? activeTheme.fg("syntaxNumber", valPart)
							: `\x1b[38;2;144;122;169m${valPart}\x1b[39m`;
					} else if (trimmedVal.startsWith("[") && trimmedVal.endsWith("]")) {
						styledVal = valPart.replace(/(["'][^"']*["'])/g, (str) =>
							activeTheme
								? activeTheme.fg("syntaxString", str)
								: `\x1b[38;2;171;82;108m${str}\x1b[39m`,
						);
					}

					const styledComment = commentPart
						? activeTheme
							? activeTheme.fg("syntaxComment", commentPart)
							: `\x1b[38;2;40;105;131m${commentPart}\x1b[39m`
						: "";
					return `${lead}${styledKey}${eq}${styledVal}${styledComment}`;
				}
			}

			return line;
		})
		.join("\n");
}

/**
 * Clean markdown code fences and leading empty lines from text.
 */
export function cleanReadOutputText(text: string): string {
	if (!text) return text;
	// Strip leading newlines so output sits directly below tool call header
	let cleaned = text.replace(/^\n+/, "");
	// Strip surrounding markdown code block fences if present in the raw text
	const fenceMatch = cleaned.match(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```\s*$/);
	if (fenceMatch) {
		cleaned = fenceMatch[1];
	}
	return cleaned;
}

/**
 * Patch Markdown.prototype.renderToken to omit opening and closing code fences (```<lang> and ```)
 * while preserving clean 2-space indentation and syntax highlighting.
 */
export function patchMarkdownRenderToken(): boolean {
	const proto = Markdown.prototype as any;
	if (proto[MARKDOWN_CLEAN_CODE_PATCHED_KEY]) {
		return false;
	}

	const originalRenderToken = proto.renderToken;
	proto[ORIGINAL_RENDER_TOKEN_KEY] = originalRenderToken;

	proto.renderToken = function (
		this: any,
		token: any,
		width: number,
		nextTokenType?: string,
		styleContext?: any,
	): string[] {
		if (token.type === "code") {
			const lines: string[] = [];
			const indent = this.theme?.codeBlockIndent ?? "  ";
			if (this.theme?.highlightCode) {
				const highlightedLines = this.theme.highlightCode(token.text, token.lang);
				for (const hlLine of highlightedLines) {
					lines.push(`${indent}${highlightConfigSections(hlLine, this.theme)}`);
				}
			} else {
				const codeLines = token.text.split("\n");
				for (const codeLine of codeLines) {
					const styled = typeof this.theme?.codeBlock === "function" ? this.theme.codeBlock(codeLine) : codeLine;
					lines.push(`${indent}${highlightConfigSections(styled, this.theme)}`);
				}
			}
			if (nextTokenType && nextTokenType !== "space") {
				lines.push("");
			}
			return lines;
		}

		return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
	};

	proto[MARKDOWN_CLEAN_CODE_PATCHED_KEY] = true;
	return true;
}

/**
 * Restore Markdown.prototype.renderToken to its unpatched implementation.
 */
export function restoreMarkdownRenderToken(): boolean {
	const proto = Markdown.prototype as any;
	if (!proto[MARKDOWN_CLEAN_CODE_PATCHED_KEY]) {
		return false;
	}

	if (proto[ORIGINAL_RENDER_TOKEN_KEY]) {
		proto.renderToken = proto[ORIGINAL_RENDER_TOKEN_KEY];
		delete proto[ORIGINAL_RENDER_TOKEN_KEY];
	}
	delete proto[MARKDOWN_CLEAN_CODE_PATCHED_KEY];
	return true;
}

/**
 * Patch ToolExecutionComponent.prototype.updateDisplay to clean read tool results:
 * strips leading newlines (so output sits flush beneath the tool call) and any
 * enclosing code fences.
 */
export function patchToolExecutionRead(): boolean {
	const proto = ToolExecutionComponent.prototype as any;
	if (proto[TOOL_EXECUTION_READ_PATCHED_KEY]) {
		return false;
	}

	const originalUpdateDisplay = proto.updateDisplay;
	proto[ORIGINAL_UPDATE_DISPLAY_KEY] = originalUpdateDisplay;

	proto.updateDisplay = function (this: any): void {
		originalUpdateDisplay.call(this);

		if (this.toolName === "read" && this.resultRendererComponent) {
			const comp = this.resultRendererComponent;
			if (typeof comp.text === "string") {
				let cleaned = cleanReadOutputText(comp.text);
				cleaned = highlightConfigSections(cleaned);
				if (cleaned !== comp.text) {
					if (typeof comp.setText === "function") {
						comp.setText(cleaned);
					} else {
						comp.text = cleaned;
						comp.invalidate?.();
					}
				}
			}
		}
	};

	proto[TOOL_EXECUTION_READ_PATCHED_KEY] = true;
	return true;
}

/**
 * Restore ToolExecutionComponent.prototype.updateDisplay to its unpatched implementation.
 */
export function restoreToolExecutionRead(): boolean {
	const proto = ToolExecutionComponent.prototype as any;
	if (!proto[TOOL_EXECUTION_READ_PATCHED_KEY]) {
		return false;
	}

	if (proto[ORIGINAL_UPDATE_DISPLAY_KEY]) {
		proto.updateDisplay = proto[ORIGINAL_UPDATE_DISPLAY_KEY];
		delete proto[ORIGINAL_UPDATE_DISPLAY_KEY];
	}
	delete proto[TOOL_EXECUTION_READ_PATCHED_KEY];
	return true;
}

/**
 * Apply both clean code block and read output patches.
 */
export function applyCleanMarkdownCode(): boolean {
	const p1 = patchMarkdownRenderToken();
	const p2 = patchToolExecutionRead();
	return p1 || p2;
}

/**
 * Restore both clean code block and read output patches.
 */
export function restoreCleanMarkdownCode(): boolean {
	const r1 = restoreMarkdownRenderToken();
	const r2 = restoreToolExecutionRead();
	return r1 || r2;
}

export default function rbfCleanMarkdownCode(_pi?: ExtensionAPI): void {
	applyCleanMarkdownCode();
}
