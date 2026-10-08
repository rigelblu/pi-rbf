import { describe, expect, it, vi } from "vitest";
import { Editor } from "@earendil-works/pi-tui";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import rbfEffort, {
	EFFORT_ACCESSOR_MARKER,
	EFFORT_COMMAND_DESCRIPTION,
	EFFORT_COMMAND_NAME,
	EFFORT_TRANSLATOR_MARKER,
	EFFORT_UNSUPPORTED_NOTICE,
	installEffortSubmitAccessor,
	isInteractiveMode,
	isTuiMode,
	translateEffortSubmission,
} from "./rbf-effort.ts";
import rbfRewind from "./rbf-rewind.ts";

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

describe("rbfEffort extension unit tests", () => {
	describe("Grammar and submission translation", () => {
		it("translates trimmed bare /effort to /thinking", () => {
			expect(translateEffortSubmission("/effort")).toEqual({
				kind: "translate",
				text: "/thinking",
			});
			expect(translateEffortSubmission("  /effort  ")).toEqual({
				kind: "translate",
				text: "/thinking",
			});
			expect(translateEffortSubmission("\t/effort\t")).toEqual({
				kind: "translate",
				text: "/thinking",
			});
		});

		it("translates /effort with ASCII-space arguments, preserving unchanged args", () => {
			expect(translateEffortSubmission("/effort high")).toEqual({
				kind: "translate",
				text: "/thinking high",
			});
			expect(translateEffortSubmission("  /effort   high  ")).toEqual({
				kind: "translate",
				text: "/thinking   high",
			});
			expect(translateEffortSubmission("/effort HIGH")).toEqual({
				kind: "translate",
				text: "/thinking HIGH",
			});
			expect(translateEffortSubmission("/effort off")).toEqual({
				kind: "translate",
				text: "/thinking off",
			});
			expect(translateEffortSubmission("/effort nonsense")).toEqual({
				kind: "translate",
				text: "/thinking nonsense",
			});
		});

		it("identifies tab or newline separated alias attempts as unsupported-separator", () => {
			expect(translateEffortSubmission("/effort\thigh")).toEqual({
				kind: "unsupported-separator",
			});
			expect(translateEffortSubmission("/effort\nhigh")).toEqual({
				kind: "unsupported-separator",
			});
			expect(translateEffortSubmission("/effort\rhigh")).toEqual({
				kind: "unsupported-separator",
			});
			expect(translateEffortSubmission("  /effort\tlevel  ")).toEqual({
				kind: "unsupported-separator",
			});
		});

		it("passes through similar names, embedded prose, and ordinary text unchanged", () => {
			expect(translateEffortSubmission("/effortful")).toEqual({ kind: "passthrough" });
			expect(translateEffortSubmission("/effortless")).toEqual({ kind: "passthrough" });
			expect(translateEffortSubmission("/effort-mode")).toEqual({ kind: "passthrough" });
			expect(translateEffortSubmission("what is /effort")).toEqual({ kind: "passthrough" });
			expect(translateEffortSubmission("/thinking high")).toEqual({ kind: "passthrough" });
			expect(translateEffortSubmission("hello world")).toEqual({ kind: "passthrough" });
			expect(translateEffortSubmission("")).toEqual({ kind: "passthrough" });
			expect(translateEffortSubmission(123)).toEqual({ kind: "passthrough" });
		});
	});

	describe("Mode checks", () => {
		it("accepts tui mode only", () => {
			expect(isTuiMode({ mode: "tui" })).toBe(true);
			expect(isInteractiveMode({ mode: "tui" })).toBe(true);
		});

		it("rejects interactive mode and non-interactive modes", () => {
			expect(isTuiMode({ mode: "interactive" })).toBe(false);
			expect(isTuiMode({ mode: "rpc", hasUI: true })).toBe(false);
			expect(isTuiMode({ mode: "print", hasUI: false })).toBe(false);
			expect(isTuiMode({ mode: "json", hasUI: false })).toBe(false);
			expect(isTuiMode({ mode: "unknown" })).toBe(false);
			expect(isTuiMode({})).toBe(false);
			expect(isTuiMode(null)).toBe(false);
			expect(isTuiMode(undefined)).toBe(false);
		});
	});

	describe("Registered slash command", () => {
		it("registers /effort with accurate metadata", () => {
			const mock = createMockExtensionAPI();
			rbfEffort(mock.api);

			expect(mock.registeredName).toBe(EFFORT_COMMAND_NAME);
			expect(mock.registeredOptions?.description).toBe(EFFORT_COMMAND_DESCRIPTION);
		});

		it("invokes notify with exact unsupported notice when called directly", async () => {
			const mock = createMockExtensionAPI();
			rbfEffort(mock.api);

			const notify = vi.fn();
			const ctx = {
				ui: { notify },
			} as unknown as ExtensionCommandContext;

			await mock.triggerCommand("", ctx);
			expect(notify).toHaveBeenCalledWith(EFFORT_UNSUPPORTED_NOTICE, "warning");
		});
	});

	describe("Accessor installation on editor instance", () => {
		it("wires onSubmit setter and getter, translating submissions to native callback", () => {
			const editor: any = { onSubmit: undefined };
			const notifyFallback = vi.fn();
			const installed = installEffortSubmitAccessor(editor, notifyFallback);

			expect(installed).not.toBeNull();
			expect(installed?.isOwned()).toBe(true);

			const nativeCallback = vi.fn();
			editor.onSubmit = nativeCallback;

			// Getter exposes translator function
			expect(typeof editor.onSubmit).toBe("function");
			expect((editor.onSubmit as any)[EFFORT_TRANSLATOR_MARKER]).toBe(true);

			// Submitting /effort
			editor.onSubmit("/effort");
			expect(nativeCallback).toHaveBeenCalledWith("/thinking");

			// Submitting /effort high
			editor.onSubmit("/effort high");
			expect(nativeCallback).toHaveBeenCalledWith("/thinking high");

			// Submitting ordinary text
			editor.onSubmit("plain message");
			expect(nativeCallback).toHaveBeenCalledWith("plain message");
			expect(notifyFallback).not.toHaveBeenCalled();
		});

		it("consumes tab/newline separated aliases and calls notify without invoking native callback", () => {
			const editor: any = { onSubmit: undefined };
			const notifyFallback = vi.fn();
			installEffortSubmitAccessor(editor, notifyFallback);

			const nativeCallback = vi.fn();
			editor.onSubmit = nativeCallback;

			editor.onSubmit("/effort\thigh");
			expect(nativeCallback).not.toHaveBeenCalled();
			expect(notifyFallback).toHaveBeenCalledWith(EFFORT_UNSUPPORTED_NOTICE);

			editor.onSubmit("/effort\nmedium");
			expect(nativeCallback).not.toHaveBeenCalled();
		});

		it("preserves actual receiver 'this' and forwards errors directly", () => {
			const editor: any = {
				id: "editor-instance-123",
				onSubmit: undefined,
			};
			installEffortSubmitAccessor(editor);

			let capturedThis: any;
			const nativeCallback = function (this: any, _text: string) {
				capturedThis = this;
				if (_text === "/thinking explode") {
					throw new Error("Native callback exploded");
				}
			};

			editor.onSubmit = nativeCallback;

			editor.onSubmit("/effort test");
			expect(capturedThis).toBe(editor);

			expect(() => editor.onSubmit("/effort explode")).toThrow("Native callback exploded");
		});

		it("guards non-configurable onSubmit property and refuses interception", () => {
			const editor: any = {};
			Object.defineProperty(editor, "onSubmit", {
				value: undefined,
				configurable: false,
				writable: true,
			});

			const notifyFallback = vi.fn();
			const installed = installEffortSubmitAccessor(editor, notifyFallback);

			expect(installed).toBeNull();
			expect(notifyFallback).toHaveBeenCalledWith(EFFORT_UNSUPPORTED_NOTICE);
		});

		it("guards non-extensible editor and refuses interception", () => {
			const editor: any = {};
			Object.preventExtensions(editor);

			const notifyFallback = vi.fn();
			const installed = installEffortSubmitAccessor(editor, notifyFallback);

			expect(installed).toBeNull();
			expect(notifyFallback).toHaveBeenCalledWith(EFFORT_UNSUPPORTED_NOTICE);
		});

		it("guards custom accessors and refuses interception", () => {
			const editor: any = {};
			Object.defineProperty(editor, "onSubmit", {
				get: () => () => {},
				set: () => {},
				configurable: true,
				enumerable: true,
			});

			const notifyFallback = vi.fn();
			const installed = installEffortSubmitAccessor(editor, notifyFallback);

			expect(installed).toBeNull();
			expect(notifyFallback).toHaveBeenCalledWith(EFFORT_UNSUPPORTED_NOTICE);
		});

		it("guards inherited non-configurable or custom accessor properties", () => {
			const proto = {};
			Object.defineProperty(proto, "onSubmit", {
				get: () => () => {},
				configurable: false,
			});
			const editor = Object.create(proto);

			const notifyFallback = vi.fn();
			const installed = installEffortSubmitAccessor(editor, notifyFallback);

			expect(installed).toBeNull();
			expect(notifyFallback).toHaveBeenCalledWith(EFFORT_UNSUPPORTED_NOTICE);
		});
	});

	describe("Finding 2: Per-assignment callback closure and composition regression tests", () => {
		it("handles callback wrapper composition assignnew=text=>old(text) with finite call and no loop", () => {
			let count = 0;
			const editor = {
				onSubmit: (text: string) => {
					count++;
					return text;
				},
			};
			installEffortSubmitAccessor(editor);

			const previous = editor.onSubmit;
			let wraps = 0;
			editor.onSubmit = (text: string) => {
				if (++wraps > 5) {
					throw new Error("recursive callback wrapper");
				}
				return previous(text);
			};

			const result = editor.onSubmit("/effort high");
			expect(result).toBe("/thinking high");
			expect(wraps).toBe(1);
			expect(count).toBe(1);
		});

		it("restores exact underlying callback when resetting earlier getter (rewind pattern)", () => {
			const editor: any = { onSubmit: undefined };
			installEffortSubmitAccessor(editor);

			const nativeSubmit = vi.fn();
			editor.onSubmit = nativeSubmit;

			const originalOnSubmit = editor.onSubmit;
			let tempCalls = 0;
			const temporaryWrapper = function (this: any, text: string) {
				tempCalls++;
				editor.onSubmit = originalOnSubmit;
				return originalOnSubmit.call(this, text);
			};

			editor.onSubmit = temporaryWrapper;
			editor.onSubmit("/effort medium");

			expect(nativeSubmit).toHaveBeenCalledWith("/thinking medium");
			expect(tempCalls).toBe(1);

			// Repeat to verify no wrap accumulation
			editor.onSubmit = temporaryWrapper;
			editor.onSubmit("/effort low");

			expect(nativeSubmit).toHaveBeenCalledWith("/thinking low");
			expect(tempCalls).toBe(2);
		});
	});

	describe("Finding 3: Teardown preserves normal callback flow without translation", () => {
		it("forwards ordinary text and does not translate alias after shutdown", () => {
			const editor: any = { onSubmit: undefined };
			const installed = installEffortSubmitAccessor(editor);
			const nativeCallback = vi.fn();
			editor.onSubmit = nativeCallback;

			const capturedTranslator = editor.onSubmit;
			installed?.restore();

			// Calling the restored or captured wrapper passes ordinary text directly
			capturedTranslator("ordinary user input");
			expect(nativeCallback).toHaveBeenCalledWith("ordinary user input");

			// Calling alias after teardown forwards without alias translation
			capturedTranslator("/effort high");
			expect(nativeCallback).toHaveBeenCalledWith("/effort high");
		});
	});

	describe("Finding 4: Exact descriptor identity ownership and idempotent restoration", () => {
		it("owns descriptor by exact identity so repeated cleanup does not affect subsequent installation", () => {
			const editor: any = { onSubmit: undefined };
			const instA = installEffortSubmitAccessor(editor);
			expect(instA?.isOwned()).toBe(true);

			instA?.restore();
			expect(instA?.isOwned()).toBe(false);

			const instB = installEffortSubmitAccessor(editor);
			expect(instB?.isOwned()).toBe(true);

			const descB = Object.getOwnPropertyDescriptor(editor, "onSubmit");

			// Calling restore on A again should NOT remove B's accessor
			instA?.restore();
			const descAfter = Object.getOwnPropertyDescriptor(editor, "onSubmit");

			expect(descAfter?.get).toBe(descB?.get);
			expect(instB?.isOwned()).toBe(true);
		});

		it("restores data descriptor preserving latest host-assigned callback and flags", () => {
			const editor: any = { onSubmit: undefined };
			const inst = installEffortSubmitAccessor(editor);

			const hostCallback = vi.fn();
			editor.onSubmit = hostCallback;

			inst?.restore();

			const desc = Object.getOwnPropertyDescriptor(editor, "onSubmit");
			expect(desc?.value).toBe(hostCallback);
			expect(desc?.configurable).toBe(true);
			expect(desc?.writable).toBe(true);
			expect(desc?.enumerable).toBe(true);
		});

		it("restores absent shape safely when host never assigned a callback", () => {
			const editor: any = {};
			const inst = installEffortSubmitAccessor(editor);
			expect(Object.prototype.hasOwnProperty.call(editor, "onSubmit")).toBe(true);

			inst?.restore();
			expect(Object.prototype.hasOwnProperty.call(editor, "onSubmit")).toBe(false);
		});
	});

	describe("Finding 1: Extension lifecycle and immutable priorFactory per session_start", () => {
		it("installs factory on session_start with (event, ctx) signature and composes prior factory", async () => {
			const mock = createMockExtensionAPI();
			rbfEffort(mock.api);

			let currentFactory: any = undefined;
			const notify = vi.fn();

			const priorEditor: any = { id: "prior-editor", onSubmit: undefined };
			const priorFactory = vi.fn(() => priorEditor);

			const ctx = {
				mode: "tui",
				ui: {
					getEditorComponent: () => currentFactory,
					setEditorComponent: (f: any) => {
						currentFactory = f;
					},
					notify,
				},
			} as unknown as ExtensionContext;

			currentFactory = priorFactory;

			await mock.triggerEvent("session_start", {}, ctx);

			expect(currentFactory).not.toBe(priorFactory);

			// Running the composed factory invokes priorFactory and wraps editor
			const createdEditor = currentFactory({}, {}, {});
			expect(createdEditor).toBe(priorEditor);
			expect(priorFactory).toHaveBeenCalled();

			const curDesc = Object.getOwnPropertyDescriptor(createdEditor, "onSubmit");
			expect(typeof curDesc?.get).toBe("function");

			// Clean shutdown restores priorFactory
			await mock.triggerEvent("session_shutdown", {}, ctx);
			expect(currentFactory).toBe(priorFactory);
		});

		it("handles factory re-wrapping across subsequent session_start without recursion", async () => {
			const mock = createMockExtensionAPI();
			rbfEffort(mock.api);

			let currentFactory: any = undefined;
			const ctx = {
				mode: "tui",
				ui: {
					getEditorComponent: () => currentFactory,
					setEditorComponent: (f: any) => {
						currentFactory = f;
					},
					notify: vi.fn(),
				},
			} as unknown as ExtensionContext;

			// First session_start
			await mock.triggerEvent("session_start", {}, ctx);
			const firstFactory = currentFactory;

			// Later owner wraps factory
			let wraps = 0;
			currentFactory = (...args: any[]) => {
				if (++wraps > 5) {
					throw new Error("recursive old factory composition");
				}
				return firstFactory(...args);
			};

			// Second session_start captures the wrapper
			await mock.triggerEvent("session_start", {}, ctx);

			// Instantiating editor through the new factory terminates cleanly
			const editor = currentFactory({}, {}, {});
			expect(editor).toBeDefined();
			expect(wraps).toBe(1);
		});

		it("keeps inactive retained old factory transparent without reactivating adapter", async () => {
			const mock = createMockExtensionAPI();
			rbfEffort(mock.api);

			let currentFactory: any = undefined;
			const ctx = {
				mode: "tui",
				ui: {
					getEditorComponent: () => currentFactory,
					setEditorComponent: (f: any) => {
						currentFactory = f;
					},
					notify: vi.fn(),
				},
			} as unknown as ExtensionContext;

			await mock.triggerEvent("session_start", {}, ctx);
			const oldFactory = currentFactory;

			// Shutdown deactivates activation
			await mock.triggerEvent("session_shutdown", {}, ctx);

			// Calling old factory should still produce editor, but without active effort accessor
			const editor = oldFactory({}, {}, {});
			const desc = Object.getOwnPropertyDescriptor(editor, "onSubmit");
			// Since oldFactory is inactive, it did not install the accessor
			expect(desc?.get).toBeUndefined();
		});

		it("does not overwrite a later factory owner during shutdown", async () => {
			const mock = createMockExtensionAPI();
			rbfEffort(mock.api);

			let currentFactory: any = undefined;
			const ctx = {
				mode: "tui",
				ui: {
					getEditorComponent: () => currentFactory,
					setEditorComponent: (f: any) => {
						currentFactory = f;
					},
				},
			} as unknown as ExtensionContext;

			await mock.triggerEvent("session_start", {}, ctx);

			// Another extension installs its factory afterwards
			const laterFactory = vi.fn();
			currentFactory = laterFactory;

			await mock.triggerEvent("session_shutdown", {}, ctx);

			// Later factory is kept intact
			expect(currentFactory).toBe(laterFactory);
		});
	});

	describe("Integration and coexistence with rbf-rewind and synthetic editor factories", () => {
		it("works seamlessly when rbf-rewind is loaded before rbf-effort", () => {
			const mockRewind = createMockExtensionAPI();
			rbfRewind(mockRewind.api);

			const mockEffort = createMockExtensionAPI();
			rbfEffort(mockEffort.api);

			class TestEditor extends Editor {}
			const editor = new TestEditor({} as any, {} as any);

			installEffortSubmitAccessor(editor);

			const nativeSubmit = vi.fn();
			editor.onSubmit = nativeSubmit;

			(editor as any).submitValue = function (this: any) {
				return (TestEditor.prototype as any).submitValue.call(this);
			};

			editor.setText("/effort");
			(editor as any).submitValue();
			expect(nativeSubmit).toHaveBeenCalledWith("/thinking");

			nativeSubmit.mockClear();
			editor.setText("/effort high");
			(editor as any).submitValue();
			expect(nativeSubmit).toHaveBeenCalledWith("/thinking high");

			nativeSubmit.mockClear();
			editor.setText("/rewind");
			(editor as any).submitValue();
			expect(nativeSubmit).toHaveBeenCalledWith("/tree");

			nativeSubmit.mockClear();
			editor.setText("just chatting");
			(editor as any).submitValue();
			expect(nativeSubmit).toHaveBeenCalledWith("just chatting");
		});

		it("works seamlessly when rbf-effort is loaded before rbf-rewind", () => {
			const mockEffort = createMockExtensionAPI();
			rbfEffort(mockEffort.api);

			const mockRewind = createMockExtensionAPI();
			rbfRewind(mockRewind.api);

			class TestEditor extends Editor {}
			const editor = new TestEditor({} as any, {} as any);

			installEffortSubmitAccessor(editor);

			const nativeSubmit = vi.fn();
			editor.onSubmit = nativeSubmit;

			editor.setText("/effort off");
			(editor as any).submitValue();
			expect(nativeSubmit).toHaveBeenCalledWith("/thinking off");

			nativeSubmit.mockClear();
			editor.setText("/rewind");
			(editor as any).submitValue();
			expect(nativeSubmit).toHaveBeenCalledWith("/tree");

			nativeSubmit.mockClear();
			editor.setText("hello");
			(editor as any).submitValue();
			expect(nativeSubmit).toHaveBeenCalledWith("hello");
		});

		it("coexists with synthetic custom editor factory (such as vim-like replacement)", async () => {
			let currentFactory: any = undefined;
			const ctx = {
				mode: "tui",
				sessionManager: { getCwd: () => "/tmp" },
				ui: {
					getEditorComponent: () => currentFactory,
					setEditorComponent: (f: any) => {
						currentFactory = f;
					},
					notify: vi.fn(),
				},
			} as unknown as ExtensionContext;

			const mockSyntheticEditor: any = { isSyntheticVim: true, onSubmit: undefined };
			currentFactory = vi.fn(() => mockSyntheticEditor);

			const mockEffort = createMockExtensionAPI();
			rbfEffort(mockEffort.api);

			await mockEffort.triggerEvent("session_start", {}, ctx);

			const editorInstance = currentFactory({}, {}, {});
			expect(editorInstance).toBe(mockSyntheticEditor);
			expect(editorInstance.isSyntheticVim).toBe(true);

			const nativeSubmit = vi.fn();
			editorInstance.onSubmit = nativeSubmit;

			editorInstance.onSubmit("/effort high");
			expect(nativeSubmit).toHaveBeenCalledWith("/thinking high");
		});
	});
});
