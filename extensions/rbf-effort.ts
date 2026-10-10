import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;
export type EditorComponent = ReturnType<EditorFactory>;

export const EFFORT_COMMAND_NAME = "effort";
export const EFFORT_COMMAND_DESCRIPTION = "Set thinking level (alias for /thinking)";
export const EFFORT_UNSUPPORTED_NOTICE = "Use /thinking in interactive Pi; /effort could not reach the native command.";

export const EFFORT_ACCESSOR_MARKER = Symbol.for("rbf.effort.accessor");
export const EFFORT_TRANSLATOR_MARKER = Symbol.for("rbf.effort.translator");

export type EffortTranslationResult =
	| { kind: "translate"; text: string }
	| { kind: "unsupported-separator" }
	| { kind: "passthrough" };

/**
 * Checks and translates prompt submission text for /effort.
 * Native submit handler trims surrounding whitespace; recognizes bare /thinking or ASCII-space args only.
 * - Trimmed bare /effort -> /thinking
 * - Trimmed /effort followed by ASCII space -> /thinking + unchanged args
 * - Trimmed /effort followed by tab/newline whitespace -> unsupported-separator notice
 * - Similar names (/effortful, /effort-mode) and embedded /effort -> passthrough unchanged
 */
export function translateEffortSubmission(text: unknown): EffortTranslationResult {
	if (typeof text !== "string") {
		return { kind: "passthrough" };
	}
	const trimmed = text.trim();
	if (trimmed === "/effort") {
		return { kind: "translate", text: "/thinking" };
	}
	if (trimmed.startsWith("/effort ")) {
		return { kind: "translate", text: "/thinking" + trimmed.slice(7) };
	}
	if (/^\/effort[\t\r\n\v\f]/.test(trimmed)) {
		return { kind: "unsupported-separator" };
	}
	return { kind: "passthrough" };
}

/**
 * Strict TUI mode guard.
 * Only ctx.mode === "tui" is supported; rejects rpc, print, json, unknown, or non-TUI environments.
 */
export function isTuiMode(ctx?: { mode?: string; [key: string]: any } | null): boolean {
	if (!ctx || typeof ctx !== "object") {
		return false;
	}
	return ctx.mode === "tui";
}

export const isInteractiveMode = isTuiMode;

export interface InstalledAccessor {
	editor: any;
	restore: () => void;
	isOwned: () => boolean;
}

/**
 * Installs an owned onSubmit accessor on the given editor instance.
 *
 * Uses per-assignment callback wrappers capturing their underlying callback target in closure.
 * An internal unwrap mapping allows subsequent setter assignments of captured wrappers
 * (such as rewind or composition) to restore the underlying callback rather than nesting loops.
 * After cleanup/shutdown, captured wrappers forward calls directly to their underlying callback
 * without alias translation.
 *
 * Ownership is decided by exact getter/setter function identity, guaranteeing that repeated
 * or out-of-order cleanups do not clobber later installations or data descriptors.
 */
export function installEffortSubmitAccessor(
	editor: any,
	notifyFallback?: (msg: string) => void,
): InstalledAccessor | null {
	if (!editor || typeof editor !== "object") {
		return null;
	}

	const desc = Object.getOwnPropertyDescriptor(editor, "onSubmit");
	if (desc && !desc.configurable) {
		notifyFallback?.(EFFORT_UNSUPPORTED_NOTICE);
		return null;
	}
	if (!Object.isExtensible(editor)) {
		notifyFallback?.(EFFORT_UNSUPPORTED_NOTICE);
		return null;
	}
	if (desc && (desc.get || desc.set)) {
		notifyFallback?.(EFFORT_UNSUPPORTED_NOTICE);
		return null;
	}

	// Guard against inherited non-configurable or custom accessor properties
	let proto = Object.getPrototypeOf(editor);
	while (proto && proto !== Object.prototype) {
		const pDesc = Object.getOwnPropertyDescriptor(proto, "onSubmit");
		if (pDesc) {
			if (!pDesc.configurable || pDesc.get || pDesc.set) {
				notifyFallback?.(EFFORT_UNSUPPORTED_NOTICE);
				return null;
			}
		}
		proto = Object.getPrototypeOf(proto);
	}

	const originalDesc = desc;
	const hadOwnProperty = Boolean(desc);
	let hostAssigned = false;
	let isActive = true;
	let restored = false;

	let currentUnderlying: any = typeof desc?.value === "function" ? desc.value : undefined;
	if (currentUnderlying === undefined && typeof editor.onSubmit === "function") {
		currentUnderlying = editor.onSubmit;
	}

	const unwrapMap = new WeakMap<object, any>();

	function unwrap(fn: any): any {
		let current = fn;
		while (current && typeof current === "function" && unwrapMap.has(current)) {
			current = unwrapMap.get(current);
		}
		return current;
	}

	function createWrapper(target: any) {
		const wrapper = function (this: any, text: string) {
			if (!isActive) {
				return target?.call(this, text);
			}
			if (typeof text !== "string") {
				return target?.call(this, text);
			}
			const result = translateEffortSubmission(text);
			if (result.kind === "translate") {
				return target?.call(this, result.text);
			}
			if (result.kind === "unsupported-separator") {
				notifyFallback?.(EFFORT_UNSUPPORTED_NOTICE);
				return;
			}
			return target?.call(this, text);
		};
		(wrapper as any)[EFFORT_TRANSLATOR_MARKER] = true;
		if (typeof target === "function") {
			unwrapMap.set(wrapper, target);
		}
		return wrapper;
	}

	let currentWrapper = createWrapper(currentUnderlying);

	const getter = function (this: any) {
		return currentWrapper;
	};
	(getter as any)[EFFORT_ACCESSOR_MARKER] = true;

	const setter = function (this: any, newCallback: any) {
		hostAssigned = true;
		const underlying = unwrap(newCallback);
		currentUnderlying = typeof underlying === "function" ? underlying : undefined;
		currentWrapper = createWrapper(currentUnderlying);
	};

	try {
		Object.defineProperty(editor, "onSubmit", {
			configurable: true,
			enumerable: true,
			get: getter,
			set: setter,
		});
	} catch {
		notifyFallback?.(EFFORT_UNSUPPORTED_NOTICE);
		return null;
	}

	const isOwned = () => {
		const cur = Object.getOwnPropertyDescriptor(editor, "onSubmit");
		return Boolean(cur && cur.get === getter && cur.set === setter);
	};

	const restore = () => {
		isActive = false;
		if (restored) {
			return;
		}
		restored = true;
		if (!isOwned()) {
			return;
		}

		if (hadOwnProperty && originalDesc) {
			Object.defineProperty(editor, "onSubmit", {
				configurable: originalDesc.configurable ?? true,
				enumerable: originalDesc.enumerable ?? true,
				writable: originalDesc.writable ?? true,
				value: currentUnderlying,
			});
		} else if (hostAssigned) {
			Object.defineProperty(editor, "onSubmit", {
				configurable: true,
				enumerable: true,
				writable: true,
				value: currentUnderlying,
			});
		} else {
			delete editor.onSubmit;
		}
	};

	return { editor, restore, isOwned };
}

export default function rbfEffort(pi: ExtensionAPI): void {
	// Register /effort command for autocomplete, help listings, and fallback notification
	pi.registerCommand(EFFORT_COMMAND_NAME, {
		description: EFFORT_COMMAND_DESCRIPTION,
		handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
			ctx.ui?.notify?.(EFFORT_UNSUPPORTED_NOTICE, "warning");
		},
	});

	let currentActivation: {
		factory: EditorFactory;
		priorFactory: EditorFactory | undefined;
		deactivate: () => void;
	} | null = null;

	pi.on?.("session_start", async (_event: any, ctx: ExtensionContext) => {
		if (!isTuiMode(ctx) || !ctx?.ui?.setEditorComponent || !ctx?.ui?.getEditorComponent) {
			return;
		}

		if (currentActivation && ctx.ui.getEditorComponent() === currentActivation.factory) {
			return;
		}

		// Deactivate prior activation if any
		if (currentActivation) {
			currentActivation.deactivate();
			currentActivation = null;
		}

		const immutablePriorFactory = ctx.ui.getEditorComponent();
		let isActive = true;
		const activeAccessors = new Set<InstalledAccessor>();

		const ownedFactory: EditorFactory = (tui, theme, keybindings) => {
			const editor = immutablePriorFactory
				? immutablePriorFactory(tui, theme, keybindings)
				: new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });

			if (!isActive) {
				return editor;
			}

			const notifyFallback = (msg: string) => {
				ctx.ui?.notify?.(msg, "warning");
			};

			const installed = installEffortSubmitAccessor(editor, notifyFallback);
			if (installed) {
				activeAccessors.add(installed);
			}
			return editor;
		};

		const deactivate = () => {
			isActive = false;
			for (const item of activeAccessors) {
				item.restore();
			}
			activeAccessors.clear();
		};

		currentActivation = {
			factory: ownedFactory,
			priorFactory: immutablePriorFactory,
			deactivate,
		};

		ctx.ui.setEditorComponent(ownedFactory);
	});

	pi.on?.("session_shutdown", async (_event: any, ctx: ExtensionContext) => {
		if (!ctx) {
			return;
		}
		if (currentActivation) {
			const { factory, priorFactory, deactivate } = currentActivation;
			deactivate();
			if (ctx.ui?.getEditorComponent?.() === factory) {
				ctx.ui.setEditorComponent(priorFactory);
			}
			currentActivation = null;
		}
	});
}
