import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export const TOOL_EXECUTION_BLENDED_KEY = Symbol.for("rbf.toolExecutionBlended.patched");
export const ORIGINAL_UPDATE_DISPLAY_KEY = Symbol.for("rbf.toolExecutionBlended.originalUpdateDisplay");

/**
 * Retrieve active theme from Pi's global symbol registration.
 */
export function getActiveTheme(): any {
	return (
		(typeof globalThis !== "undefined"
			? (globalThis as any)[Symbol.for("@earendil-works/pi-coding-agent:theme")] ??
				(globalThis as any)[Symbol.for("@mariozechner/pi-coding-agent:theme")]
			: undefined) ?? {
			name: "dark",
			getColorMode: () => "truecolor",
		}
	);
}

/**
 * Return a background coloring function that renders the active theme's Rosé Pine `base` color:
 * - Dawn: #faf4ed (\x1b[48;2;250;244;237m or \x1b[48;5;255m)
 * - Moon: #232136 (\x1b[48;2;35;33;54m or \x1b[48;5;235m)
 * - Main: #191724 (\x1b[48;2;25;23;36m or \x1b[48;5;234m)
 */
export function getBaseBgFn(theme?: any): (text: string) => string {
	const activeTheme = theme ?? getActiveTheme();
	const themeName = (activeTheme?.name ?? "").toLowerCase();
	const mode = typeof activeTheme?.getColorMode === "function" ? activeTheme.getColorMode() : "truecolor";

	if (themeName.includes("dawn")) {
		return mode === "256color"
			? (text: string) => `\x1b[48;5;255m${text}\x1b[49m`
			: (text: string) => `\x1b[48;2;250;244;237m${text}\x1b[49m`;
	}
	if (themeName.includes("moon")) {
		return mode === "256color"
			? (text: string) => `\x1b[48;5;235m${text}\x1b[49m`
			: (text: string) => `\x1b[48;2;35;33;54m${text}\x1b[49m`;
	}
	if (themeName.includes("rose-pine")) {
		return mode === "256color"
			? (text: string) => `\x1b[48;5;234m${text}\x1b[49m`
			: (text: string) => `\x1b[48;2;25;23;36m${text}\x1b[49m`;
	}

	if (typeof activeTheme?.bg === "function") {
		try {
			return (text: string) => activeTheme.bg("toolSuccessBg", text);
		} catch {
			// fallback
		}
	}

	return (text: string) => text;
}

/**
 * Patch ToolExecutionComponent so collapsed file tool calls (read, edit, write) render
 * with the active theme's Rose Pine `base` background, while routine non-file tools
 * (bash, etc.) blend transparently into the terminal background (bgFn = undefined),
 * all with zero vertical padding (paddingY = 0).
 */
export function applyToolExecutionBlended(): boolean {
	const proto = ToolExecutionComponent.prototype as any;
	if (proto[TOOL_EXECUTION_BLENDED_KEY]) {
		return false;
	}

	const originalUpdateDisplay = proto.updateDisplay;
	proto[ORIGINAL_UPDATE_DISPLAY_KEY] = originalUpdateDisplay;

	proto.updateDisplay = function (this: any): void {
		originalUpdateDisplay.call(this);

		const isFileTool = this.toolName === "read" || this.toolName === "edit" || this.toolName === "write";

		if (!this.expanded) {
			const bgFn = isFileTool ? getBaseBgFn(getActiveTheme()) : undefined;

			if (this.contentBox && this.contentBox instanceof Box) {
				this.contentBox.setBgFn(bgFn);
				this.contentBox.paddingY = 0;
				this.contentBox.invalidateCache();
			}
			if (this.contentText && this.contentText instanceof Text) {
				this.contentText.setCustomBgFn(bgFn);
				this.contentText.paddingY = 0;
				this.contentText.invalidate();
			}
		} else {
			if (this.contentBox && this.contentBox instanceof Box) {
				if (isFileTool) {
					this.contentBox.setBgFn(getBaseBgFn(getActiveTheme()));
				}
				this.contentBox.paddingY = 1;
				this.contentBox.invalidateCache();
			}
			if (this.contentText && this.contentText instanceof Text) {
				if (isFileTool) {
					this.contentText.setCustomBgFn(getBaseBgFn(getActiveTheme()));
				}
				this.contentText.paddingY = 1;
				this.contentText.invalidate();
			}
		}
	};

	proto[TOOL_EXECUTION_BLENDED_KEY] = true;
	return true;
}

/**
 * Restore ToolExecutionComponent.prototype.updateDisplay to its unpatched implementation.
 */
export function restoreToolExecutionBlended(): boolean {
	const proto = ToolExecutionComponent.prototype as any;
	if (!proto[TOOL_EXECUTION_BLENDED_KEY]) {
		return false;
	}

	if (proto[ORIGINAL_UPDATE_DISPLAY_KEY]) {
		proto.updateDisplay = proto[ORIGINAL_UPDATE_DISPLAY_KEY];
		delete proto[ORIGINAL_UPDATE_DISPLAY_KEY];
	}
	delete proto[TOOL_EXECUTION_BLENDED_KEY];
	return true;
}

export default function rbfToolExecutionBlended(_pi?: ExtensionAPI): void {
	applyToolExecutionBlended();
}
