import { Editor } from "@earendil-works/pi-tui";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const REWIND_COMMAND_NAME = "rewind";
export const REWIND_COMMAND_DESCRIPTION = "Navigate session tree (user messages first)";
export const REWIND_NON_INTERACTIVE_NOTICE = "Session tree navigation is only available in interactive mode.";
export const REWIND_UNSUPPORTED_NOTICE = "User-only rewind is unavailable in this Pi version. Use /tree to navigate.";
export const REWIND_LEGACY_ACTIVE_NOTICE = "Restart Pi to enable user-only /rewind. The previous rewind extension is still active.";

export const SUBMIT_INTERCEPTED_KEY = Symbol.for("rbf.rewind.submitIntercepted");
export const TREE_SELECTOR_PATCHED_KEY = Symbol.for("rbf.rewind.treeSelectorPatched");
export const CANDIDATE_OWNER = Symbol.for("rbf.rewind.candidateOwner");
export const REWIND_DISPATCH_STATE_KEY = Symbol.for("rbf.rewind.dispatchState");
export const LEGACY_WARNED_KEY = Symbol.for("rbf.rewind.legacyWarned");

export interface RewindSubmitPatchState {
	owner: unknown;
	enabled: boolean;
	originalSubmitValue: Function;
	wrapperSubmitValue: Function;
	context?: ExtensionContext;
}

export interface RewindTreeSelectorPatchState {
	owner: unknown;
	enabled: boolean;
	originalShowTreeSelector: Function;
	wrapperShowTreeSelector: Function;
	context?: ExtensionContext;
}

interface GlobalDispatchState {
	depth: number;
}

function getDispatchState(): GlobalDispatchState {
	let state = (globalThis as any)[REWIND_DISPATCH_STATE_KEY];
	if (!state || typeof state.depth !== "number") {
		state = { depth: 0 };
		(globalThis as any)[REWIND_DISPATCH_STATE_KEY] = state;
	}
	return state;
}

export function isRewindDispatchActive(): boolean {
	return getDispatchState().depth > 0;
}

function notifyWarning(ctx: ExtensionContext | undefined, message: string, host?: any): void {
	if (ctx?.ui?.notify) {
		ctx.ui.notify(message, "warning");
		return;
	}
	if (typeof host?.showWarning === "function") {
		host.showWarning(message);
		return;
	}
	if (typeof host?.showError === "function") {
		host.showError(message);
		return;
	}
}

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

export function checkTreeFilterSeam(host: any): { ok: true; prevDescriptor?: PropertyDescriptor } | { ok: false; reason: string } {
	if (!host || typeof host !== "object") {
		return { ok: false, reason: "host is not an object" };
	}
	const sm = host.settingsManager;
	if (!sm || typeof sm !== "object") {
		return { ok: false, reason: "settingsManager is not an object" };
	}
	if (typeof sm.getTreeFilterMode !== "function") {
		return { ok: false, reason: "getTreeFilterMode is not a function" };
	}
	const desc = Object.getOwnPropertyDescriptor(sm, "getTreeFilterMode");
	if (desc && !desc.configurable) {
		return { ok: false, reason: "getTreeFilterMode own property is not configurable" };
	}
	if (!desc && !Object.isExtensible(sm)) {
		return { ok: false, reason: "settingsManager is not extensible" };
	}
	return { ok: true, prevDescriptor: desc };
}

/**
 * Installs the submit interceptor on Editor.prototype so that prompt submission
 * of `/rewind` (with or without trailing arguments) forwards to `/tree` with
 * synchronous user-only rewind dispatch state while native onSubmit('/tree') runs.
 */
export function installRewindSubmitInterceptor(
	EditorClass: typeof Editor = Editor,
	ctx?: ExtensionContext,
	InteractiveModeClass: typeof InteractiveMode = InteractiveMode,
): void {
	if (!EditorClass || !EditorClass.prototype) return;
	const proto = EditorClass.prototype as any;

	if (proto[SUBMIT_INTERCEPTED_KEY] === true) {
		if (ctx?.hasUI && ctx.mode === "tui") {
			notifyWarning(ctx, REWIND_LEGACY_ACTIVE_NOTICE);
		}
		return;
	}

	const existing = proto[SUBMIT_INTERCEPTED_KEY] as RewindSubmitPatchState | undefined;
	if (existing && typeof existing === "object" && existing.owner === CANDIDATE_OWNER) {
		if (ctx !== undefined) {
			existing.context = ctx;
			existing.enabled = ctx.mode === "tui";
		} else {
			existing.enabled = true;
			existing.context = undefined;
		}
		return;
	}

	const originalSubmitValue = proto.submitValue;
	if (typeof originalSubmitValue !== "function") return;

	const patchState: RewindSubmitPatchState = {
		owner: CANDIDATE_OWNER,
		enabled: ctx ? ctx.mode === "tui" : true,
		originalSubmitValue,
		wrapperSubmitValue: () => {},
		context: ctx,
	};

	const wrapperSubmitValue = function (this: any, ...args: any[]) {
		if (!patchState.enabled) {
			return originalSubmitValue.apply(this, args);
		}

		const originalOnSubmit = this.onSubmit;
		if (typeof originalOnSubmit === "function") {
			this.onSubmit = (text: string) => {
				this.onSubmit = originalOnSubmit;
				if (!patchState.enabled) {
					return originalOnSubmit.call(this, text);
				}
				if (isRewindCommand(text)) {
					if (InteractiveModeClass && typeof (InteractiveModeClass.prototype as any)?.showTreeSelector !== "function") {
						notifyWarning(patchState.context, REWIND_UNSUPPORTED_NOTICE, this);
						return;
					}
					const dispatchState = getDispatchState();
					dispatchState.depth++;
					try {
						return originalOnSubmit.call(this, "/tree");
					} finally {
						dispatchState.depth = Math.max(0, dispatchState.depth - 1);
					}
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

	patchState.wrapperSubmitValue = wrapperSubmitValue;
	proto.submitValue = wrapperSubmitValue;
	proto[SUBMIT_INTERCEPTED_KEY] = patchState;
}

export function uninstallRewindSubmitInterceptor(EditorClass: typeof Editor = Editor): void {
	if (!EditorClass || !EditorClass.prototype) return;
	const proto = EditorClass.prototype as any;
	const state = proto[SUBMIT_INTERCEPTED_KEY] as RewindSubmitPatchState | undefined;
	if (!state || typeof state !== "object" || state.owner !== CANDIDATE_OWNER) return;

	state.enabled = false;
	state.context = undefined;

	if (proto.submitValue === state.wrapperSubmitValue) {
		proto.submitValue = state.originalSubmitValue;
		delete proto[SUBMIT_INTERCEPTED_KEY];
	}
}

/**
 * Installs the showTreeSelector wrapper on InteractiveMode.prototype so that during
 * synchronous rewind dispatch in an active TUI context, this instance's settingsManager.getTreeFilterMode
 * is temporarily shadowed to return 'user-only', restoring the exact previous descriptor in finally.
 */
export function installRewindTreeSelectorInterceptor(
	InteractiveModeClass: typeof InteractiveMode = InteractiveMode,
	ctx?: ExtensionContext,
): void {
	if (!InteractiveModeClass || !InteractiveModeClass.prototype) return;
	const proto = InteractiveModeClass.prototype as any;

	const existing = proto[TREE_SELECTOR_PATCHED_KEY] as RewindTreeSelectorPatchState | undefined;
	if (existing && typeof existing === "object" && existing.owner === CANDIDATE_OWNER) {
		if (ctx !== undefined) {
			existing.context = ctx;
			existing.enabled = ctx.mode === "tui";
		} else {
			existing.enabled = true;
			existing.context = undefined;
		}
		return;
	}

	const originalShowTreeSelector = proto.showTreeSelector;
	if (typeof originalShowTreeSelector !== "function") return;

	const patchState: RewindTreeSelectorPatchState = {
		owner: CANDIDATE_OWNER,
		enabled: ctx ? ctx.mode === "tui" : true,
		originalShowTreeSelector,
		wrapperShowTreeSelector: () => {},
		context: ctx,
	};

	const wrapperShowTreeSelector = function (this: any, ...args: any[]) {
		if (!patchState.enabled || !isRewindDispatchActive() || patchState.context?.mode !== "tui") {
			return originalShowTreeSelector.apply(this, args);
		}

		const seam = checkTreeFilterSeam(this);
		if (!seam.ok) {
			notifyWarning(patchState.context, REWIND_UNSUPPORTED_NOTICE, this);
			return;
		}

		const sm = this.settingsManager;
		try {
			Object.defineProperty(sm, "getTreeFilterMode", {
				value: () => "user-only",
				writable: true,
				configurable: true,
				enumerable: seam.prevDescriptor ? seam.prevDescriptor.enumerable : true,
			});
		} catch {
			notifyWarning(patchState.context, REWIND_UNSUPPORTED_NOTICE, this);
			return;
		}

		try {
			return originalShowTreeSelector.apply(this, args);
		} finally {
			if (seam.prevDescriptor) {
				Object.defineProperty(sm, "getTreeFilterMode", seam.prevDescriptor);
			} else {
				delete sm.getTreeFilterMode;
			}
		}
	};

	patchState.wrapperShowTreeSelector = wrapperShowTreeSelector;
	proto.showTreeSelector = wrapperShowTreeSelector;
	proto[TREE_SELECTOR_PATCHED_KEY] = patchState;
}

export function uninstallRewindTreeSelectorInterceptor(
	InteractiveModeClass: typeof InteractiveMode = InteractiveMode,
): void {
	if (!InteractiveModeClass || !InteractiveModeClass.prototype) return;
	const proto = InteractiveModeClass.prototype as any;
	const state = proto[TREE_SELECTOR_PATCHED_KEY] as RewindTreeSelectorPatchState | undefined;
	if (!state || typeof state !== "object" || state.owner !== CANDIDATE_OWNER) return;

	state.enabled = false;
	state.context = undefined;

	if (proto.showTreeSelector === state.wrapperShowTreeSelector) {
		proto.showTreeSelector = state.originalShowTreeSelector;
		delete proto[TREE_SELECTOR_PATCHED_KEY];
	}
}

export default function rbfRewind(pi: ExtensionAPI): void {
	// Register /rewind command for autocomplete, help listings, and standout syntax highlighting
	pi.registerCommand(REWIND_COMMAND_NAME, {
		description: REWIND_COMMAND_DESCRIPTION,
		handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
			ctx.ui?.notify?.(REWIND_NON_INTERACTIVE_NOTICE, "info");
		},
	});

	// Default startup patches prototypes; dispatch activates only after proper TUI context
	installRewindSubmitInterceptor(Editor);
	installRewindTreeSelectorInterceptor(InteractiveMode);
	const startupSubmitState = (Editor?.prototype as any)?.[SUBMIT_INTERCEPTED_KEY] as RewindSubmitPatchState | undefined;
	if (startupSubmitState && typeof startupSubmitState === "object") {
		startupSubmitState.enabled = false;
	}
	const startupTreeState = (InteractiveMode?.prototype as any)?.[TREE_SELECTOR_PATCHED_KEY] as RewindTreeSelectorPatchState | undefined;
	if (startupTreeState && typeof startupTreeState === "object") {
		startupTreeState.enabled = false;
	}

	let warnedLegacy = false;

	pi.on?.("session_start", async (_event, ctx: ExtensionContext) => {
		const proto = Editor?.prototype as any;
		if (proto?.[SUBMIT_INTERCEPTED_KEY] === true) {
			if (ctx?.hasUI && ctx?.mode === "tui" && !warnedLegacy) {
				warnedLegacy = true;
				ctx.ui?.notify?.(REWIND_LEGACY_ACTIVE_NOTICE, "warning");
			}
			return;
		}

		if (ctx?.mode === "tui") {
			installRewindSubmitInterceptor(Editor, ctx);
			installRewindTreeSelectorInterceptor(InteractiveMode, ctx);
		} else {
			const submitState = proto?.[SUBMIT_INTERCEPTED_KEY] as RewindSubmitPatchState | undefined;
			if (submitState && typeof submitState === "object") {
				submitState.enabled = false;
				submitState.context = undefined;
			}
			const treeProto = InteractiveMode?.prototype as any;
			const treeState = treeProto?.[TREE_SELECTOR_PATCHED_KEY] as RewindTreeSelectorPatchState | undefined;
			if (treeState && typeof treeState === "object") {
				treeState.enabled = false;
				treeState.context = undefined;
			}
		}
	});

	pi.on?.("session_shutdown", async () => {
		uninstallRewindSubmitInterceptor(Editor);
		uninstallRewindTreeSelectorInterceptor(InteractiveMode);
	});
}
