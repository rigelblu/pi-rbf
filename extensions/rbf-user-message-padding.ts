import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const USER_MESSAGE_PADDING_KEY = Symbol.for("rbf.userMessagePadding.patched");
export const ORIGINAL_REBUILD_KEY = Symbol.for("rbf.userMessagePadding.originalRebuild");

/**
 * Patch UserMessageComponent to use a custom vertical padding (defaulting to 0)
 * instead of the hardcoded paddingY: 1.
 */
export function applyUserMessagePadding(targetPaddingY = 0): boolean {
	const proto = UserMessageComponent.prototype as any;
	if (proto[USER_MESSAGE_PADDING_KEY]) {
		return false;
	}

	const originalRebuild = proto.rebuild;
	proto[ORIGINAL_REBUILD_KEY] = originalRebuild;

	proto.rebuild = function (this: any): void {
		originalRebuild.call(this);
		const box = this.children?.[0];
		if (box && typeof box === "object" && "paddingY" in box) {
			box.paddingY = targetPaddingY;
		}
	};

	proto[USER_MESSAGE_PADDING_KEY] = true;
	return true;
}

/**
 * Restore UserMessageComponent.prototype.rebuild to its unpatched implementation.
 */
export function restoreUserMessagePadding(): boolean {
	const proto = UserMessageComponent.prototype as any;
	if (!proto[USER_MESSAGE_PADDING_KEY]) {
		return false;
	}

	if (proto[ORIGINAL_REBUILD_KEY]) {
		proto.rebuild = proto[ORIGINAL_REBUILD_KEY];
		delete proto[ORIGINAL_REBUILD_KEY];
	}
	delete proto[USER_MESSAGE_PADDING_KEY];
	return true;
}

export default function rbfUserMessagePadding(_pi?: ExtensionAPI): void {
	applyUserMessagePadding(0);
}
