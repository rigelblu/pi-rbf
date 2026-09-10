import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Editor } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import rbfRewind, {
	installRewindSubmitInterceptor,
	isRewindCommand,
	REWIND_COMMAND_DESCRIPTION,
	REWIND_COMMAND_NAME,
	REWIND_NON_INTERACTIVE_NOTICE,
	SUBMIT_INTERCEPTED_KEY,
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

describe("rbfRewind extension", () => {
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
		it("intercepts submitValue on Editor prototype and rewrites /rewind to /tree", () => {
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
			expect((MockEditor.prototype as any)[SUBMIT_INTERCEPTED_KEY]).toBe(true);

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

		it("is idempotent when called multiple times", () => {
			class IdempotentEditor {
				onSubmit?: (text: string) => void;
				submitValue() {}
			}

			installRewindSubmitInterceptor(IdempotentEditor as any);
			const firstPatchedSubmitValue = IdempotentEditor.prototype.submitValue;

			installRewindSubmitInterceptor(IdempotentEditor as any);
			expect(IdempotentEditor.prototype.submitValue).toBe(firstPatchedSubmitValue);
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
			expect((Editor.prototype as any)[SUBMIT_INTERCEPTED_KEY]).toBe(true);
		});
	});

	describe("rbfRewind registration & command fallback", () => {
		it("registers the /rewind command with exact name and description", () => {
			const mockAPI = createMockExtensionAPI();
			rbfRewind(mockAPI.api);

			expect(mockAPI.api.registerCommand).toHaveBeenCalledTimes(1);
			expect(mockAPI.registeredName).toBe("rewind");
			expect(REWIND_COMMAND_NAME).toBe("rewind");
			expect(mockAPI.registeredOptions?.description).toBe(
				"Navigate session tree (switch branches) (alias for /tree)",
			);
			expect(REWIND_COMMAND_DESCRIPTION).toBe(
				"Navigate session tree (switch branches) (alias for /tree)",
			);
			expect(mockAPI.api.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		});

		it("re-ensures interceptor on session_start", async () => {
			const mockAPI = createMockExtensionAPI();
			rbfRewind(mockAPI.api);

			await expect(mockAPI.triggerEvent("session_start")).resolves.toBeUndefined();
			expect((Editor.prototype as any)[SUBMIT_INTERCEPTED_KEY]).toBe(true);
		});

		it("notifies user when executed in non-interactive / RPC context", async () => {
			const mockAPI = createMockExtensionAPI();
			rbfRewind(mockAPI.api);

			const notifyMock = vi.fn();
			const mockCtx = {
				ui: {
					notify: notifyMock,
				},
			} as unknown as ExtensionCommandContext;

			await mockAPI.triggerCommand("", mockCtx);
			expect(notifyMock).toHaveBeenCalledWith(REWIND_NON_INTERACTIVE_NOTICE, "info");

			await mockAPI.triggerCommand("2", mockCtx);
			expect(notifyMock).toHaveBeenCalledWith(REWIND_NON_INTERACTIVE_NOTICE, "info");
		});

		it("gracefully tolerates missing ui.notify in non-interactive context", async () => {
			const mockAPI = createMockExtensionAPI();
			rbfRewind(mockAPI.api);

			const mockCtx = {} as unknown as ExtensionCommandContext;
			await expect(mockAPI.triggerCommand("", mockCtx)).resolves.toBeUndefined();
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
