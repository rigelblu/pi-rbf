import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@earendil-works/pi-tui";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import rbfRewind, {
	CANDIDATE_OWNER,
	checkTreeFilterSeam,
	installRewindSubmitInterceptor,
	installRewindTreeSelectorInterceptor,
	isRewindCommand,
	isRewindDispatchActive,
	REWIND_COMMAND_DESCRIPTION,
	REWIND_COMMAND_NAME,
	REWIND_DISPATCH_STATE_KEY,
	REWIND_LEGACY_ACTIVE_NOTICE,
	REWIND_NON_INTERACTIVE_NOTICE,
	REWIND_UNSUPPORTED_NOTICE,
	SUBMIT_INTERCEPTED_KEY,
	TREE_SELECTOR_PATCHED_KEY,
	uninstallRewindSubmitInterceptor,
	uninstallRewindTreeSelectorInterceptor,
} from "./rbf-rewind.ts";

function createMockExtensionAPI() {
	let registeredCommandOptions: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
	let registeredName: string | undefined;
	const eventHandlers = new Map<string, Array<(...args: any[]) => Promise<void>>>();

	const api = {
		registerCommand: vi.fn((name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			registeredName = name;
			registeredCommandOptions = options;
		}),
		on: vi.fn((event: string, handler: (...args: any[]) => Promise<void>) => {
			const list = eventHandlers.get(event) ?? [];
			list.push(handler);
			eventHandlers.set(event, list);
		}),
	} as unknown as ExtensionAPI;

	return {
		api,
		get registeredName() {
			return registeredName;
		},
		get registeredOptions() {
			return registeredCommandOptions;
		},
		async triggerCommand(args: string, ctx: ExtensionCommandContext) {
			if (!registeredCommandOptions) {
				throw new Error("No command registered");
			}
			await registeredCommandOptions.handler(args, ctx);
		},
		async triggerEvent(event: string, ...args: any[]) {
			const handlers = eventHandlers.get(event) ?? [];
			for (const handler of handlers) {
				await handler(...args);
			}
		},
	};
}

function createMockExtensionContext(options?: { mode?: "tui" | "rpc"; hasUI?: boolean }) {
	return {
		mode: options?.mode ?? "tui",
		hasUI: options?.hasUI ?? true,
		ui: {
			notify: vi.fn(),
		},
	} as unknown as ExtensionContext;
}

describe("rbfRewind extension", () => {
	beforeEach(() => {
		uninstallRewindSubmitInterceptor(Editor);
		uninstallRewindTreeSelectorInterceptor(InteractiveMode);
		delete (Editor.prototype as any)[SUBMIT_INTERCEPTED_KEY];
		delete (InteractiveMode.prototype as any)[TREE_SELECTOR_PATCHED_KEY];
		const dispatchState = (globalThis as any)[REWIND_DISPATCH_STATE_KEY];
		if (dispatchState) dispatchState.depth = 0;
	});

	afterEach(() => {
		uninstallRewindSubmitInterceptor(Editor);
		uninstallRewindTreeSelectorInterceptor(InteractiveMode);
		delete (Editor.prototype as any)[SUBMIT_INTERCEPTED_KEY];
		delete (InteractiveMode.prototype as any)[TREE_SELECTOR_PATCHED_KEY];
		const dispatchState = (globalThis as any)[REWIND_DISPATCH_STATE_KEY];
		if (dispatchState) dispatchState.depth = 0;
	});

	describe("isRewindCommand", () => {
		it("detects exact /rewind", () => {
			expect(isRewindCommand("/rewind")).toBe(true);
			expect(isRewindCommand("  /rewind  ")).toBe(true);
		});

		it("detects /rewind with trailing arguments and spaces", () => {
			expect(isRewindCommand("/rewind 2")).toBe(true);
			expect(isRewindCommand("/rewind now")).toBe(true);
			expect(isRewindCommand("/rewind   foo bar")).toBe(true);
			expect(isRewindCommand("/rewind\t1")).toBe(true);
		});

		it("rejects non-rewind commands and prefixes", () => {
			expect(isRewindCommand("/rewind-branch")).toBe(false);
			expect(isRewindCommand("/rewinder")).toBe(false);
			expect(isRewindCommand("/rewind_test")).toBe(false);
			expect(isRewindCommand("/tree")).toBe(false);
			expect(isRewindCommand("/clear")).toBe(false);
			expect(isRewindCommand("hello /rewind")).toBe(false);
			expect(isRewindCommand("")).toBe(false);
			expect(isRewindCommand(null)).toBe(false);
			expect(isRewindCommand(undefined)).toBe(false);
			expect(isRewindCommand(123)).toBe(false);
		});
	});

	describe("installRewindSubmitInterceptor", () => {
		it("intercepts submitValue on Editor prototype and rewrites /rewind to /tree with owned state shape", () => {
			class MockEditor {
				onSubmit?: (text: string) => void;
				lastText = "";

				setText(text: string) {
					this.lastText = text;
				}

				submitValue() {
					if (this.onSubmit) {
						this.onSubmit(this.lastText);
					}
				}
			}

			installRewindSubmitInterceptor(MockEditor as any);
			const state = (MockEditor.prototype as any)[SUBMIT_INTERCEPTED_KEY];
			expect(state).toBeDefined();
			expect(state.owner).toBe(CANDIDATE_OWNER);
			expect(state.enabled).toBe(true);
			expect(typeof state.originalSubmitValue).toBe("function");
			expect(typeof state.wrapperSubmitValue).toBe("function");

			const editor = new MockEditor();
			const received: string[] = [];
			editor.onSubmit = (text) => {
				received.push(text);
			};

			editor.setText("/rewind");
			editor.submitValue();
			expect(received).toEqual(["/tree"]);

			editor.setText("/rewind 3");
			editor.submitValue();
			expect(received).toEqual(["/tree", "/tree"]);

			editor.setText("  /rewind  ");
			editor.submitValue();
			expect(received).toEqual(["/tree", "/tree", "/tree"]);

			editor.setText("normal prompt");
			editor.submitValue();
			expect(received).toEqual(["/tree", "/tree", "/tree", "normal prompt"]);

			editor.setText("/clear");
			editor.submitValue();
			expect(received).toEqual(["/tree", "/tree", "/tree", "normal prompt", "/clear"]);
		});

		it("is idempotent when called multiple times without stacking wrappers", () => {
			class IdempotentEditor {
				onSubmit?: (text: string) => void;
				submitValue() {}
			}

			installRewindSubmitInterceptor(IdempotentEditor as any);
			const firstPatchedSubmitValue = IdempotentEditor.prototype.submitValue;
			const firstState = (IdempotentEditor.prototype as any)[SUBMIT_INTERCEPTED_KEY];

			installRewindSubmitInterceptor(IdempotentEditor as any);
			expect(IdempotentEditor.prototype.submitValue).toBe(firstPatchedSubmitValue);
			expect((IdempotentEditor.prototype as any)[SUBMIT_INTERCEPTED_KEY]).toBe(firstState);
		});

		it("safely handles class without prototype or submitValue", () => {
			expect(() => installRewindSubmitInterceptor(null as any)).not.toThrow();
			expect(() => installRewindSubmitInterceptor({} as any)).not.toThrow();
			expect(() => installRewindSubmitInterceptor(class Empty {} as any)).not.toThrow();
		});

		it("restores onSubmit even if submitValue throws", () => {
			class ErrorEditor {
				onSubmit?: (text: string) => void;
				submitValue() {
					throw new Error("Simulated submit error");
				}
			}

			installRewindSubmitInterceptor(ErrorEditor as any);
			const editor = new ErrorEditor();
			const originalOnSubmit = (_text: string) => {};
			editor.onSubmit = originalOnSubmit;

			expect(() => editor.submitValue()).toThrow("Simulated submit error");
			expect(editor.onSubmit).toBe(originalOnSubmit);
		});

		it("works with actual imported Editor class", () => {
			installRewindSubmitInterceptor();
			const state = (Editor.prototype as any)[SUBMIT_INTERCEPTED_KEY];
			expect(state).toBeDefined();
			expect(state.owner).toBe(CANDIDATE_OWNER);
		});
	});

	describe("forwarding + transient native initial filter/user state and /tree isolation", () => {
		it("provides transient 'user-only' filter during /rewind dispatch and restores configured filter", () => {
			class MockSettingsManager {
				private mode = "default";
				getTreeFilterMode() {
					return this.mode;
				}
				setTreeFilterMode(mode: string) {
					this.mode = mode;
				}
			}

			class MockInteractiveMode {
				settingsManager = new MockSettingsManager();
				observedFilterDuringSelector?: string;
				showTreeSelectorCallCount = 0;

				showTreeSelector() {
					this.showTreeSelectorCallCount++;
					this.observedFilterDuringSelector = this.settingsManager.getTreeFilterMode();
				}
			}

			class MockEditor {
				onSubmit?: (text: string) => void;
				lastText = "";
				setText(text: string) {
					this.lastText = text;
				}
				submitValue() {
					if (this.onSubmit) this.onSubmit(this.lastText);
				}
			}

			const mockCtx = createMockExtensionContext({ mode: "tui" });
			installRewindSubmitInterceptor(MockEditor as any, mockCtx, MockInteractiveMode as any);
			installRewindTreeSelectorInterceptor(MockInteractiveMode as any, mockCtx);

			const interactive = new MockInteractiveMode();
			const editor = new MockEditor();
			editor.onSubmit = (text: string) => {
				if (text === "/tree") {
					interactive.showTreeSelector();
				}
			};

			// 1. Submit /rewind: should observe 'user-only' inside selector, then return to 'default'
			editor.setText("/rewind");
			editor.submitValue();

			expect(interactive.showTreeSelectorCallCount).toBe(1);
			expect(interactive.observedFilterDuringSelector).toBe("user-only");
			expect(interactive.settingsManager.getTreeFilterMode()).toBe("default");
			expect(isRewindDispatchActive()).toBe(false);

			// 2. /tree isolation: calling /tree directly opens with configured filter
			editor.setText("/tree");
			editor.submitValue();
			expect(interactive.showTreeSelectorCallCount).toBe(2);
			expect(interactive.observedFilterDuringSelector).toBe("default");
			expect(interactive.settingsManager.getTreeFilterMode()).toBe("default");
			expect(isRewindDispatchActive()).toBe(false);
		});

		it("preserves configured 'all' filter for direct /tree and restores it after /rewind", () => {
			class MockSettingsManager {
				getTreeFilterMode() {
					return "all";
				}
			}

			class MockInteractiveMode {
				settingsManager = new MockSettingsManager();
				observedFilter?: string;
				showTreeSelector() {
					this.observedFilter = this.settingsManager.getTreeFilterMode();
				}
			}

			class MockEditor {
				onSubmit?: (text: string) => void;
				submitValue(text: string) {
					if (this.onSubmit) this.onSubmit(text);
				}
			}

			const mockCtx = createMockExtensionContext({ mode: "tui" });
			installRewindSubmitInterceptor(MockEditor as any, mockCtx, MockInteractiveMode as any);
			installRewindTreeSelectorInterceptor(MockInteractiveMode as any, mockCtx);

			const interactive = new MockInteractiveMode();
			const editor = new MockEditor();
			editor.onSubmit = (text: string) => {
				if (text === "/tree") interactive.showTreeSelector();
			};

			// Direct /tree opens with 'all'
			editor.submitValue("/tree");
			expect(interactive.observedFilter).toBe("all");
			expect(interactive.settingsManager.getTreeFilterMode()).toBe("all");

			// /rewind opens with 'user-only' and restores 'all'
			editor.submitValue("/rewind");
			expect(interactive.observedFilter).toBe("user-only");
			expect(interactive.settingsManager.getTreeFilterMode()).toBe("all");
		});

		it("does not call settingsManager saving setter (setTreeFilterMode) during rewind", () => {
			const setTreeFilterModeSpy = vi.fn();
			class MockSettingsManager {
				getTreeFilterMode() {
					return "default";
				}
				setTreeFilterMode = setTreeFilterModeSpy;
			}

			class MockInteractiveMode {
				settingsManager = new MockSettingsManager();
				showTreeSelector() {
					this.settingsManager.getTreeFilterMode();
				}
			}

			class MockEditor {
				onSubmit?: (text: string) => void;
				submitValue(text: string) {
					if (this.onSubmit) this.onSubmit(text);
				}
			}

			const mockCtx = createMockExtensionContext({ mode: "tui" });
			installRewindSubmitInterceptor(MockEditor as any, mockCtx, MockInteractiveMode as any);
			installRewindTreeSelectorInterceptor(MockInteractiveMode as any, mockCtx);

			const interactive = new MockInteractiveMode();
			const editor = new MockEditor();
			editor.onSubmit = (text: string) => {
				if (text === "/tree") interactive.showTreeSelector();
			};

			editor.submitValue("/rewind");
			expect(setTreeFilterModeSpy).not.toHaveBeenCalled();
		});
	});

	describe("getter own/accessor descriptor exact restore and non-shadowable checks", () => {
		it("exact restore for inherited getter on prototype (deletes own shadow property)", () => {
			class BaseSettingsManager {
				getTreeFilterMode() {
					return "default";
				}
			}
			class MockInteractiveMode {
				settingsManager = new BaseSettingsManager();
				showTreeSelector() {
					expect(this.settingsManager.getTreeFilterMode()).toBe("user-only");
				}
			}

			const mockCtx = createMockExtensionContext({ mode: "tui" });
			installRewindTreeSelectorInterceptor(MockInteractiveMode as any, mockCtx);

			const interactive = new MockInteractiveMode();
			// Before: no own property
			expect(Object.prototype.hasOwnProperty.call(interactive.settingsManager, "getTreeFilterMode")).toBe(false);

			// Invoke showTreeSelector while dispatch is simulated active
			const dispatchState = (globalThis as any)[REWIND_DISPATCH_STATE_KEY];
			dispatchState.depth = 1;
			try {
				interactive.showTreeSelector();
			} finally {
				dispatchState.depth = 0;
			}

			// After: own property deleted, resolves to prototype method
			expect(Object.prototype.hasOwnProperty.call(interactive.settingsManager, "getTreeFilterMode")).toBe(false);
			expect(interactive.settingsManager.getTreeFilterMode()).toBe("default");
		});

		it("exact restore for own value property with specific descriptor", () => {
			const originalFn = () => "custom-own";
			const sm = {
				otherProp: 123,
			};
			Object.defineProperty(sm, "getTreeFilterMode", {
				value: originalFn,
				writable: false,
				enumerable: false,
				configurable: true,
			});

			class MockInteractiveMode {
				settingsManager = sm as any;
				showTreeSelector() {
					expect(this.settingsManager.getTreeFilterMode()).toBe("user-only");
				}
			}

			const mockCtx = createMockExtensionContext({ mode: "tui" });
			installRewindTreeSelectorInterceptor(MockInteractiveMode as any, mockCtx);

			const interactive = new MockInteractiveMode();
			const dispatchState = (globalThis as any)[REWIND_DISPATCH_STATE_KEY];
			dispatchState.depth = 1;
			try {
				interactive.showTreeSelector();
			} finally {
				dispatchState.depth = 0;
			}

			const restoredDesc = Object.getOwnPropertyDescriptor(interactive.settingsManager, "getTreeFilterMode");
			expect(restoredDesc).toBeDefined();
			expect(restoredDesc?.value).toBe(originalFn);
			expect(restoredDesc?.writable).toBe(false);
			expect(restoredDesc?.enumerable).toBe(false);
			expect(restoredDesc?.configurable).toBe(true);
		});

		it("exact restore for own accessor (getter) property", () => {
			const filterFn = () => "accessor-filter";
			const getterFn = () => filterFn;
			const sm = {};
			Object.defineProperty(sm, "getTreeFilterMode", {
				get: getterFn,
				configurable: true,
				enumerable: true,
			});

			class MockInteractiveMode {
				settingsManager = sm as any;
				showTreeSelector() {
					expect(this.settingsManager.getTreeFilterMode()).toBe("user-only");
				}
			}

			const mockCtx = createMockExtensionContext({ mode: "tui" });
			installRewindTreeSelectorInterceptor(MockInteractiveMode as any, mockCtx);

			const interactive = new MockInteractiveMode();
			const dispatchState = (globalThis as any)[REWIND_DISPATCH_STATE_KEY];
			dispatchState.depth = 1;
			try {
				interactive.showTreeSelector();
			} finally {
				dispatchState.depth = 0;
			}

			const restoredDesc = Object.getOwnPropertyDescriptor(interactive.settingsManager, "getTreeFilterMode");
			expect(restoredDesc).toBeDefined();
			expect(restoredDesc?.get).toBe(getterFn);
			expect(restoredDesc?.configurable).toBe(true);
			expect(interactive.settingsManager.getTreeFilterMode()).toBe("accessor-filter");
		});

		it("refuses opening and warns when own property is non-configurable", () => {
			const sm = {};
			Object.defineProperty(sm, "getTreeFilterMode", {
				value: () => "non-configurable",
				writable: true,
				configurable: false,
			});

			const originalShowTreeSelector = vi.fn();
			class MockInteractiveMode {
				settingsManager = sm as any;
				showTreeSelector(...args: any[]) {
					originalShowTreeSelector.apply(this, args);
				}
			}

			const mockCtx = createMockExtensionContext({ mode: "tui" });
			installRewindTreeSelectorInterceptor(MockInteractiveMode as any, mockCtx);

			const interactive = new MockInteractiveMode();
			const dispatchState = (globalThis as any)[REWIND_DISPATCH_STATE_KEY];
			dispatchState.depth = 1;
			try {
				interactive.showTreeSelector();
			} finally {
				dispatchState.depth = 0;
			}

			// Must notify warning and REFUSE calling original showTreeSelector
			expect(mockCtx.ui.notify).toHaveBeenCalledWith(REWIND_UNSUPPORTED_NOTICE, "warning");
			expect(originalShowTreeSelector).not.toHaveBeenCalled();
			expect(interactive.settingsManager.getTreeFilterMode()).toBe("non-configurable");
		});

		it("refuses opening and warns when settingsManager is non-extensible without own property", () => {
			class BaseSettingsManager {
				getTreeFilterMode() {
					return "default";
				}
			}
			const sm = new BaseSettingsManager();
			Object.preventExtensions(sm);

			const originalShowTreeSelector = vi.fn();
			class MockInteractiveMode {
				settingsManager = sm;
				showTreeSelector(...args: any[]) {
					originalShowTreeSelector.apply(this, args);
				}
			}

			const mockCtx = createMockExtensionContext({ mode: "tui" });
			installRewindTreeSelectorInterceptor(MockInteractiveMode as any, mockCtx);

			const interactive = new MockInteractiveMode();
			const dispatchState = (globalThis as any)[REWIND_DISPATCH_STATE_KEY];
			dispatchState.depth = 1;
			try {
				interactive.showTreeSelector();
			} finally {
				dispatchState.depth = 0;
			}

			expect(mockCtx.ui.notify).toHaveBeenCalledWith(REWIND_UNSUPPORTED_NOTICE, "warning");
			expect(originalShowTreeSelector).not.toHaveBeenCalled();
		});
	});

	describe("exception safety, thrown restore, and nested dispatch", () => {
		it("restores property descriptor and decrements dispatch state when native showTreeSelector throws", () => {
			class MockSettingsManager {
				getTreeFilterMode() {
					return "default";
				}
			}
			class MockInteractiveMode {
				settingsManager = new MockSettingsManager();
				showTreeSelector() {
					throw new Error("Native showTreeSelector error");
				}
			}
			class MockEditor {
				onSubmit?: (text: string) => void;
				submitValue(text: string) {
					if (this.onSubmit) this.onSubmit(text);
				}
			}

			const mockCtx = createMockExtensionContext({ mode: "tui" });
			installRewindSubmitInterceptor(MockEditor as any, mockCtx, MockInteractiveMode as any);
			installRewindTreeSelectorInterceptor(MockInteractiveMode as any, mockCtx);

			const interactive = new MockInteractiveMode();
			const editor = new MockEditor();
			editor.onSubmit = (text: string) => {
				if (text === "/tree") interactive.showTreeSelector();
			};

			expect(() => editor.submitValue("/rewind")).toThrow("Native showTreeSelector error");
			expect(isRewindDispatchActive()).toBe(false);
			expect(Object.prototype.hasOwnProperty.call(interactive.settingsManager, "getTreeFilterMode")).toBe(false);
			expect(interactive.settingsManager.getTreeFilterMode()).toBe("default");
		});

		it("handles nested dispatch states correctly without leaking partial markers", () => {
			let innerObservedFilter: string | undefined;
			let outerObservedFilter: string | undefined;

			class MockSettingsManager {
				getTreeFilterMode() {
					return "default";
				}
			}

			class MockInteractiveMode {
				settingsManager = new MockSettingsManager();
				showTreeSelector(isInner = false) {
					if (isInner) {
						innerObservedFilter = this.settingsManager.getTreeFilterMode();
					} else {
						outerObservedFilter = this.settingsManager.getTreeFilterMode();
						// Simulate re-entrant or nested submit
						editor.submitValue("/rewind-nested");
					}
				}
			}

			class MockEditor {
				onSubmit?: (text: string) => void;
				submitValue(text: string) {
					if (this.onSubmit) this.onSubmit(text);
				}
			}

			const mockCtx = createMockExtensionContext({ mode: "tui" });
			installRewindSubmitInterceptor(MockEditor as any, mockCtx, MockInteractiveMode as any);
			installRewindTreeSelectorInterceptor(MockInteractiveMode as any, mockCtx);

			const interactive = new MockInteractiveMode();
			const editor = new MockEditor();
			editor.onSubmit = (text: string) => {
				if (text === "/tree") interactive.showTreeSelector(false);
				else if (text === "/rewind-nested") {
					// nested invocation
					const dispatchState = (globalThis as any)[REWIND_DISPATCH_STATE_KEY];
					dispatchState.depth++;
					try {
						interactive.showTreeSelector(true);
					} finally {
						dispatchState.depth = Math.max(0, dispatchState.depth - 1);
					}
				}
			};

			editor.submitValue("/rewind");
			expect(outerObservedFilter).toBe("user-only");
			expect(innerObservedFilter).toBe("user-only");
			expect(isRewindDispatchActive()).toBe(false);
			expect(interactive.settingsManager.getTreeFilterMode()).toBe("default");
		});
	});

	describe("candidate lifecycle, reload, shutdown, and third-party wrapper preservation", () => {
		it("removes candidate wrappers on shutdown when candidate is topmost", () => {
			class MockEditor {
				submitValue() {}
			}
			class MockInteractiveMode {
				showTreeSelector() {}
			}

			const origSubmit = MockEditor.prototype.submitValue;
			const origShowTree = MockInteractiveMode.prototype.showTreeSelector;

			installRewindSubmitInterceptor(MockEditor as any);
			installRewindTreeSelectorInterceptor(MockInteractiveMode as any);

			expect(MockEditor.prototype.submitValue).not.toBe(origSubmit);
			expect(MockInteractiveMode.prototype.showTreeSelector).not.toBe(origShowTree);

			uninstallRewindSubmitInterceptor(MockEditor as any);
			uninstallRewindTreeSelectorInterceptor(MockInteractiveMode as any);

			expect(MockEditor.prototype.submitValue).toBe(origSubmit);
			expect(MockInteractiveMode.prototype.showTreeSelector).toBe(origShowTree);
			expect((MockEditor.prototype as any)[SUBMIT_INTERCEPTED_KEY]).toBeUndefined();
			expect((MockInteractiveMode.prototype as any)[TREE_SELECTOR_PATCHED_KEY]).toBeUndefined();
		});

		it("preserves third-party wrappers installed after candidate on shutdown, but disables candidate state", () => {
			class MockEditor {
				submitValue() {}
			}

			installRewindSubmitInterceptor(MockEditor as any);
			const candidateSubmitWrapper = MockEditor.prototype.submitValue;

			// Third party wraps over candidate
			const thirdPartySubmit = function (this: any) {
				return "third-party";
			};
			MockEditor.prototype.submitValue = thirdPartySubmit;

			uninstallRewindSubmitInterceptor(MockEditor as any);

			// Prototype method must remain the third-party method!
			expect(MockEditor.prototype.submitValue).toBe(thirdPartySubmit);

			// Candidate patch state must be disabled and context cleared
			const state = (MockEditor.prototype as any)[SUBMIT_INTERCEPTED_KEY];
			expect(state).toBeDefined();
			expect(state.enabled).toBe(false);
			expect(state.context).toBeUndefined();
		});

		it("actually invokes a delegating third-party wrapper through disable and reacquire without dropping or stacking", () => {
			class MockEditor {
				onSubmit?: (text: string) => void;
				lastText = "";

				setText(text: string) {
					this.lastText = text;
				}

				submitValue() {
					if (this.onSubmit) {
						this.onSubmit(this.lastText);
					}
				}
			}

			const ctx1 = createMockExtensionContext({ mode: "tui" });
			installRewindSubmitInterceptor(MockEditor as any, ctx1);
			const candidateSubmit = MockEditor.prototype.submitValue;

			let thirdPartyCalls = 0;
			const thirdPartySubmit = function (this: any, ...args: any[]) {
				thirdPartyCalls++;
				return (candidateSubmit as any).apply(this, args);
			};
			MockEditor.prototype.submitValue = thirdPartySubmit;

			const editor = new MockEditor();
			const received: string[] = [];
			editor.onSubmit = (text) => {
				received.push(text);
			};

			// 1. Before shutdown: /rewind forwards /tree through delegating wrapper
			editor.setText("/rewind");
			editor.submitValue();
			expect(thirdPartyCalls).toBe(1);
			expect(received).toEqual(["/tree"]);

			// 2. On shutdown: candidate is buried under third-party wrapper
			uninstallRewindSubmitInterceptor(MockEditor as any);
			expect(MockEditor.prototype.submitValue).toBe(thirdPartySubmit);

			// Invoke through shutdown: buried candidate is disabled, delegates directly without rewriting /rewind to /tree
			editor.setText("/rewind");
			editor.submitValue();
			expect(thirdPartyCalls).toBe(2);
			expect(received).toEqual(["/tree", "/rewind"]);

			// 3. On reacquire (install with new context): re-enables same buried candidate state
			const ctx2 = createMockExtensionContext({ mode: "tui" });
			installRewindSubmitInterceptor(MockEditor as any, ctx2);
			// Prototype still holds third-party wrapper (not stacked or dropped)
			expect(MockEditor.prototype.submitValue).toBe(thirdPartySubmit);

			// Invoke through reacquire: forwards /tree again
			editor.setText("/rewind");
			editor.submitValue();
			expect(thirdPartyCalls).toBe(3);
			expect(received).toEqual(["/tree", "/rewind", "/tree"]);
		});

		it("retained submit wrapper remains inert after topmost shutdown and fresh reinstallation without borrowing new context or forwarding", () => {
			class MockEditor {
				onSubmit?: (text: string) => void;
				lastText = "";

				setText(text: string) {
					this.lastText = text;
				}

				submitValue() {
					if (this.onSubmit) {
						this.onSubmit(this.lastText);
					}
				}
			}

			const ctx1 = createMockExtensionContext({ mode: "tui" });
			installRewindSubmitInterceptor(MockEditor as any, ctx1);
			const retainedSubmitWrapper = MockEditor.prototype.submitValue;
			const state1 = (MockEditor.prototype as any)[SUBMIT_INTERCEPTED_KEY];

			// Topmost shutdown disables state1 and removes symbol
			uninstallRewindSubmitInterceptor(MockEditor as any);
			expect((MockEditor.prototype as any)[SUBMIT_INTERCEPTED_KEY]).toBeUndefined();

			const editor = new MockEditor();
			const received: string[] = [];
			editor.onSubmit = (text) => {
				received.push(text);
			};

			// 1. Invoke retained wrapper after topmost shutdown: must NOT forward /tree
			editor.setText("/rewind");
			retainedSubmitWrapper.call(editor);
			expect(received).toEqual(["/rewind"]);
			expect(state1.enabled).toBe(false);

			// 2. Fresh reinstallation with candidate 2 and ctx2
			const ctx2 = createMockExtensionContext({ mode: "tui" });
			installRewindSubmitInterceptor(MockEditor as any, ctx2);
			const state2 = (MockEditor.prototype as any)[SUBMIT_INTERCEPTED_KEY];
			expect(state2).toBeDefined();
			expect(state2).not.toBe(state1);

			// 3. Invoke old retained wrapper again: must remain inert and NOT borrow ctx2 or forward /tree
			editor.setText("/rewind");
			retainedSubmitWrapper.call(editor);
			expect(received).toEqual(["/rewind", "/rewind"]);
			expect(ctx2.ui.notify).not.toHaveBeenCalled();

			// 4. Fresh active wrapper does forward /tree
			editor.setText("/rewind");
			editor.submitValue();
			expect(received).toEqual(["/rewind", "/rewind", "/tree"]);
		});

		it("retained tree wrapper remains inert after topmost shutdown and fresh reinstallation without borrowing new context or filter", () => {
			class MockSettingsManager {
				getTreeFilterMode() {
					return "default";
				}
			}
			class MockInteractiveMode {
				settingsManager = new MockSettingsManager();
				observedFilter?: string;
				showTreeSelector() {
					this.observedFilter = this.settingsManager.getTreeFilterMode();
				}
			}

			const ctx1 = createMockExtensionContext({ mode: "tui" });
			installRewindTreeSelectorInterceptor(MockInteractiveMode as any, ctx1);
			const retainedTreeWrapper = MockInteractiveMode.prototype.showTreeSelector;
			const treeState1 = (MockInteractiveMode.prototype as any)[TREE_SELECTOR_PATCHED_KEY];

			// Topmost shutdown disables state and deletes symbol
			uninstallRewindTreeSelectorInterceptor(MockInteractiveMode as any);
			expect((MockInteractiveMode.prototype as any)[TREE_SELECTOR_PATCHED_KEY]).toBeUndefined();

			const interactive = new MockInteractiveMode();
			const dispatchState = (globalThis as any)[REWIND_DISPATCH_STATE_KEY];

			// 1. Invoke retained tree wrapper after shutdown with simulated dispatch
			dispatchState.depth = 1;
			try {
				retainedTreeWrapper.call(interactive);
			} finally {
				dispatchState.depth = 0;
			}
			// Must NOT shadow user-only; remains default
			expect(interactive.observedFilter).toBe("default");

			// 2. Fresh reinstallation with candidate 2 and ctx2
			const ctx2 = createMockExtensionContext({ mode: "tui" });
			installRewindTreeSelectorInterceptor(MockInteractiveMode as any, ctx2);
			const treeState2 = (MockInteractiveMode.prototype as any)[TREE_SELECTOR_PATCHED_KEY];
			expect(treeState2).toBeDefined();
			expect(treeState2).not.toBe(treeState1);

			// 3. Invoke old retained tree wrapper again: must remain inert and NOT borrow ctx2
			dispatchState.depth = 1;
			try {
				retainedTreeWrapper.call(interactive);
			} finally {
				dispatchState.depth = 0;
			}
			expect(interactive.observedFilter).toBe("default");
			expect(ctx2.ui.notify).not.toHaveBeenCalled();

			// 4. Fresh active tree wrapper does shadow user-only
			dispatchState.depth = 1;
			try {
				interactive.showTreeSelector();
			} finally {
				dispatchState.depth = 0;
			}
			expect(interactive.observedFilter).toBe("user-only");
		});
	});

	describe("stale context disabled, session replacement, and legacy boolean diagnosis", () => {
		it("disables user-only shadowing when context is stale/shutdown and re-enables on session replacement", () => {
			class MockSettingsManager {
				getTreeFilterMode() {
					return "default";
				}
			}
			class MockInteractiveMode {
				settingsManager = new MockSettingsManager();
				observedFilter?: string;
				showTreeSelector() {
					this.observedFilter = this.settingsManager.getTreeFilterMode();
				}
			}

			const mockCtx1 = createMockExtensionContext({ mode: "tui" });
			installRewindTreeSelectorInterceptor(MockInteractiveMode as any, mockCtx1);

			const interactive = new MockInteractiveMode();
			const dispatchState = (globalThis as any)[REWIND_DISPATCH_STATE_KEY];

			// 1. In active TUI context: shadows user-only
			dispatchState.depth = 1;
			interactive.showTreeSelector();
			dispatchState.depth = 0;
			expect(interactive.observedFilter).toBe("user-only");

			// 2. On shutdown / disabled: does NOT shadow
			uninstallRewindTreeSelectorInterceptor(MockInteractiveMode as any);
			dispatchState.depth = 1;
			interactive.showTreeSelector();
			dispatchState.depth = 0;
			expect(interactive.observedFilter).toBe("default");

			// 3. New session_start with new context: re-enables shadowing
			const mockCtx2 = createMockExtensionContext({ mode: "tui" });
			installRewindTreeSelectorInterceptor(MockInteractiveMode as any, mockCtx2);
			dispatchState.depth = 1;
			interactive.showTreeSelector();
			dispatchState.depth = 0;
			expect(interactive.observedFilter).toBe("user-only");
		});

		it("diagnoses legacy boolean Symbol.for('rbf.rewind.submitIntercepted') true without wrapping again, and warns on session_start", async () => {
			class LegacyEditor {
				submitValue() {}
			}
			(LegacyEditor.prototype as any)[SUBMIT_INTERCEPTED_KEY] = true;

			const origSubmit = LegacyEditor.prototype.submitValue;
			const mockCtx = createMockExtensionContext({ mode: "tui" });

			installRewindSubmitInterceptor(LegacyEditor as any, mockCtx);
			// Does NOT wrap again
			expect(LegacyEditor.prototype.submitValue).toBe(origSubmit);
			expect((LegacyEditor.prototype as any)[SUBMIT_INTERCEPTED_KEY]).toBe(true);

			// Extension session_start warns user about legacy wrapper requiring restart
			const mockAPI = createMockExtensionAPI();
			(Editor.prototype as any)[SUBMIT_INTERCEPTED_KEY] = true;

			rbfRewind(mockAPI.api);
			await mockAPI.triggerEvent("session_start", {}, mockCtx);

			expect(mockCtx.ui.notify).toHaveBeenCalledWith(REWIND_LEGACY_ACTIVE_NOTICE, "warning");
		});
	});

	describe("unsupported seam visible refusal and RPC/headless fallback", () => {
		it("visibly refuses rewind opening and warns when showTreeSelector has missing/invalid settingsManager seam", () => {
			const originalShow = vi.fn();
			class BrokenInteractiveMode {
				settingsManager = null; // broken seam!
				showTreeSelector(...args: any[]) {
					originalShow.apply(this, args);
				}
			}

			const mockCtx = createMockExtensionContext({ mode: "tui" });
			installRewindTreeSelectorInterceptor(BrokenInteractiveMode as any, mockCtx);

			const interactive = new BrokenInteractiveMode();
			const dispatchState = (globalThis as any)[REWIND_DISPATCH_STATE_KEY];
			dispatchState.depth = 1;
			try {
				interactive.showTreeSelector();
			} finally {
				dispatchState.depth = 0;
			}

			expect(mockCtx.ui.notify).toHaveBeenCalledWith(REWIND_UNSUPPORTED_NOTICE, "warning");
			expect(originalShow).not.toHaveBeenCalled();
		});

		it("visibly refuses rewind opening and warns when getTreeFilterMode is missing", () => {
			const originalShow = vi.fn();
			class BrokenInteractiveMode {
				settingsManager = {}; // no getTreeFilterMode function
				showTreeSelector(...args: any[]) {
					originalShow.apply(this, args);
				}
			}

			const mockCtx = createMockExtensionContext({ mode: "tui" });
			installRewindTreeSelectorInterceptor(BrokenInteractiveMode as any, mockCtx);

			const interactive = new BrokenInteractiveMode();
			const dispatchState = (globalThis as any)[REWIND_DISPATCH_STATE_KEY];
			dispatchState.depth = 1;
			try {
				interactive.showTreeSelector();
			} finally {
				dispatchState.depth = 0;
			}

			expect(mockCtx.ui.notify).toHaveBeenCalledWith(REWIND_UNSUPPORTED_NOTICE, "warning");
			expect(originalShow).not.toHaveBeenCalled();
		});

		it("falls back cleanly when ctx.mode is 'rpc' without attempting terminal UI", async () => {
			class MockSettingsManager {
				getTreeFilterMode() {
					return "default";
				}
			}
			class MockInteractiveMode {
				settingsManager = new MockSettingsManager();
				observedFilter?: string;
				showTreeSelector() {
					this.observedFilter = this.settingsManager.getTreeFilterMode();
				}
			}

			const rpcCtx = createMockExtensionContext({ mode: "rpc" });
			installRewindTreeSelectorInterceptor(MockInteractiveMode as any, rpcCtx);

			const interactive = new MockInteractiveMode();
			const dispatchState = (globalThis as any)[REWIND_DISPATCH_STATE_KEY];
			dispatchState.depth = 1;
			try {
				interactive.showTreeSelector();
			} finally {
				dispatchState.depth = 0;
			}

			// In RPC mode, does NOT shadow 'user-only'
			expect(interactive.observedFilter).toBe("default");

			// Registered command handler notifies informational fallback
			const mockAPI = createMockExtensionAPI();
			rbfRewind(mockAPI.api);
			const cmdCtx = {
				ui: {
					notify: vi.fn(),
				},
			} as unknown as ExtensionCommandContext;

			await mockAPI.triggerCommand("", cmdCtx);
			expect(cmdCtx.ui.notify).toHaveBeenCalledWith(REWIND_NON_INTERACTIVE_NOTICE, "info");
		});
	});

	describe("rbfRewind registration & lifecycle", () => {
		it("registers the /rewind command with exact name and updated description", () => {
			const mockAPI = createMockExtensionAPI();
			rbfRewind(mockAPI.api);

			expect(mockAPI.api.registerCommand).toHaveBeenCalledTimes(1);
			expect(mockAPI.registeredName).toBe("rewind");
			expect(REWIND_COMMAND_NAME).toBe("rewind");
			expect(mockAPI.registeredOptions?.description).toBe(
				"Navigate session tree (user messages first)",
			);
			expect(REWIND_COMMAND_DESCRIPTION).toBe(
				"Navigate session tree (user messages first)",
			);
			expect(mockAPI.api.on).toHaveBeenCalledWith("session_start", expect.any(Function));
			expect(mockAPI.api.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
		});

		it("updates context on session_start and uninstalls on session_shutdown", async () => {
			const mockAPI = createMockExtensionAPI();
			rbfRewind(mockAPI.api);

			const mockCtx = createMockExtensionContext({ mode: "tui" });
			await mockAPI.triggerEvent("session_start", {}, mockCtx);

			const editorState = (Editor.prototype as any)[SUBMIT_INTERCEPTED_KEY];
			expect(editorState).toBeDefined();
			expect(editorState.enabled).toBe(true);
			expect(editorState.context).toBe(mockCtx);

			await mockAPI.triggerEvent("session_shutdown");
			expect((Editor.prototype as any)[SUBMIT_INTERCEPTED_KEY]).toBeUndefined();
			expect((InteractiveMode.prototype as any)[TREE_SELECTOR_PATCHED_KEY]).toBeUndefined();
		});

		it("does not activate dispatch during startup until proper TUI context is established on session_start", async () => {
			const mockAPI = createMockExtensionAPI();
			rbfRewind(mockAPI.api);

			const editorState = (Editor.prototype as any)[SUBMIT_INTERCEPTED_KEY];
			const treeState = (InteractiveMode.prototype as any)[TREE_SELECTOR_PATCHED_KEY];
			expect(editorState).toBeDefined();
			expect(treeState).toBeDefined();
			expect(editorState.enabled).toBe(false);
			expect(treeState.enabled).toBe(false);

			const mockCtx = createMockExtensionContext({ mode: "tui" });
			await mockAPI.triggerEvent("session_start", {}, mockCtx);
			expect(editorState.enabled).toBe(true);
			expect(treeState.enabled).toBe(true);
		});
	});

	describe("source code safety checks", () => {
		it("source code contains no unauthorized sinks or side-channel imports", () => {
			const sourcePath = resolve(__dirname, "rbf-rewind.ts");
			const content = readFileSync(sourcePath, "utf-8");

			expect(content).not.toMatch(/node:child_process|child_process/);
			expect(content).not.toMatch(/node:fs|fs/);
			expect(content).not.toMatch(/node:net|node:http|fetch/);
			expect(content).not.toMatch(/process\.exit/);
		});
	});
});
