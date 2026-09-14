import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";

// Pi's transient status line after a model change prints the bare model
// (`Model: <id>` from `/model` and the picker, `Switched to <name>` from the
// cycle keys), while the footer prepends `(<provider>) ` whenever more than one
// provider is configured. This extension makes the status line follow the
// footer's count rule. The three call sites all go through
// `InteractiveMode.prototype.showStatus`, which is the one seam that covers
// them (the picker's `selectModel` is a closure).

export const PATCHED_SYMBOL = Symbol.for("rbf.modelStatus.patched");
export const ORIGINAL_SHOW_STATUS_KEY = Symbol.for("rbf.modelStatus.originalShowStatus");

const PREFIXES = ["Model: ", "Switched to "] as const;

/** Insert `(<provider>) ` after a model-change prefix when more than one provider is configured. */
export function decorateStatus(message: string, provider: string | undefined, providerCount: number): string {
	// Extension notifications also land here (`showExtensionNotify`), and not every caller passes a string.
	if (typeof message !== "string" || !provider || providerCount <= 1) {
		return message;
	}
	const label = `(${provider}) `;
	for (const prefix of PREFIXES) {
		if (message.startsWith(prefix)) {
			const rest = message.slice(prefix.length);
			return rest.startsWith(label) ? message : `${prefix}${label}${rest}`;
		}
	}
	return message;
}

type ShowStatusHost = {
	session?: { model?: { provider?: string } };
	footerDataProvider?: { getAvailableProviderCount?: () => number };
};

/** Wrap `showStatus` on the given prototype. Idempotent across `/reload` and a second install. */
export function patchShowStatus(proto: any): boolean {
	if (!proto || proto[PATCHED_SYMBOL]) {
		return false;
	}
	const original = proto.showStatus;
	if (typeof original !== "function") {
		return false;
	}
	proto[PATCHED_SYMBOL] = true;
	proto[ORIGINAL_SHOW_STATUS_KEY] = original;
	proto.showStatus = function (this: ShowStatusHost, message: string) {
		const provider = this.session?.model?.provider;
		const count = this.footerDataProvider?.getAvailableProviderCount?.() ?? 0;
		return original.call(this, decorateStatus(message, provider, count));
	};
	return true;
}

export function unpatchShowStatus(proto: any): void {
	if (!proto || !proto[PATCHED_SYMBOL]) {
		return;
	}
	proto.showStatus = proto[ORIGINAL_SHOW_STATUS_KEY];
	delete proto[ORIGINAL_SHOW_STATUS_KEY];
	delete proto[PATCHED_SYMBOL];
}

export default function rbfModelStatus(_pi: ExtensionAPI): void {
	patchShowStatus(InteractiveMode?.prototype);
}
