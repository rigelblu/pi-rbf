import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export const TOOL_EXECUTION_BLENDED_KEY = Symbol.for("rbf.toolExecutionBlended.patched");
export const ORIGINAL_UPDATE_DISPLAY_KEY = Symbol.for("rbf.toolExecutionBlended.originalUpdateDisplay");

/**
 * Patch ToolExecutionComponent so every collapsed tool call blends into the terminal
 * background with zero vertical padding (bgFn = undefined, paddingY = 0).
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

		if (!this.expanded) {
			const bgFn = undefined;

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
				this.contentBox.paddingY = 1;
				this.contentBox.invalidateCache();
			}
			if (this.contentText && this.contentText instanceof Text) {
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
