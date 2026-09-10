import { Editor } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const REWIND_COMMAND_NAME = "rewind";
export const REWIND_COMMAND_DESCRIPTION = "Navigate session tree (switch branches) (alias for /tree)";
export const REWIND_NON_INTERACTIVE_NOTICE = "Session tree navigation is only available in interactive mode.";

export const SUBMIT_INTERCEPTED_KEY = Symbol.for("rbf.rewind.submitIntercepted");

/**
 * Checks whether an input string is a `/rewind` command invocation.
 * Matches `/rewind` alone or `/rewind` followed by whitespace (tolerating trailing args/spaces),
 * while rejecting `/rewind-something` or `/rewinder`.
 */
export function isRewindCommand(text: unknown): boolean {
	if (typeof text !== "string") return false;
	const trimmed = text.trim();
	return trimmed === "/rewind" || /^\/rewind\s/.test(trimmed);
}

/**
 * Installs the submit interceptor on Editor.prototype so that any
 * prompt submission of `/rewind` (with or without trailing arguments) is translated to `/tree`
 * before Pi's native submit handler processes it.
 */
export function installRewindSubmitInterceptor(EditorClass: typeof Editor = Editor): void {
	if (!EditorClass || !EditorClass.prototype) return;
	const proto = EditorClass.prototype as any;
	if (proto[SUBMIT_INTERCEPTED_KEY]) return;

	const originalSubmitValue = proto.submitValue;
	if (typeof originalSubmitValue !== "function") return;

	proto.submitValue = function (this: any, ...args: any[]) {
		const originalOnSubmit = this.onSubmit;
		if (typeof originalOnSubmit === "function") {
			this.onSubmit = (text: string) => {
				this.onSubmit = originalOnSubmit;
				if (isRewindCommand(text)) {
					return originalOnSubmit.call(this, "/tree");
				}
				return originalOnSubmit.call(this, text);
			};
		}
		try {
			return originalSubmitValue.apply(this, args);
		} finally {
			if (typeof originalOnSubmit === "function" && this.onSubmit !== originalOnSubmit) {
				this.onSubmit = originalOnSubmit;
			}
		}
	};

	proto[SUBMIT_INTERCEPTED_KEY] = true;
}

export default function rbfRewind(pi: ExtensionAPI): void {
	// Install interceptor immediately on extension load
	installRewindSubmitInterceptor();

	// Also ensure interceptor is present when a session starts or re-starts
	pi.on?.("session_start", async () => {
		installRewindSubmitInterceptor();
	});

	// Register /rewind command for autocomplete, help listings, and standout syntax highlighting
	pi.registerCommand(REWIND_COMMAND_NAME, {
		description: REWIND_COMMAND_DESCRIPTION,
		handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
			ctx.ui?.notify?.(REWIND_NON_INTERACTIVE_NOTICE, "info");
		},
	});
}
