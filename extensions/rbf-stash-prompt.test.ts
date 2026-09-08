import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import rbfStashPrompt, { nextDraftState } from "./rbf-stash-prompt.ts";

function createMockExtensionContext(initialEditorText = "") {
	let editorText = initialEditorText;

	const ctx = {
		ui: {
			getEditorText: vi.fn(() => editorText),
			setEditorText: vi.fn((text: string) => {
				editorText = text;
			}),
			setWidget: vi.fn(),
			theme: {
				fg: vi.fn((_color: string, text: string) => `[dim]${text}[/dim]`),
			},
		},
	} as unknown as ExtensionContext;

	return {
		ctx,
		get editorText() {
			return editorText;
		},
		set editorText(value: string) {
			editorText = value;
		},
	};
}

function createMockExtensionAPI() {
	let shortcutHandler: ((ctx: ExtensionContext) => void) | undefined;

	const api = {
		registerShortcut: vi.fn((shortcut: string, options: { description?: string; handler: (ctx: ExtensionContext) => void }) => {
			if (shortcut === "ctrl+s") {
				shortcutHandler = options.handler;
			}
		}),
	} as unknown as ExtensionAPI;

	return {
		api,
		triggerShortcut(ctx: ExtensionContext) {
			if (!shortcutHandler) {
				throw new Error("ctrl+s shortcut was not registered");
			}
			shortcutHandler(ctx);
		},
	};
}

describe("nextDraftState pure transition", () => {
	describe("Case 1: no stash + empty or whitespace-only active -> no-op", () => {
		it("leaves empty editor unchanged when no stash exists", () => {
			const result = nextDraftState("", undefined);
			expect(result.nextActive).toBe("");
			expect(result.nextStash).toBeUndefined();
		});

		it("leaves whitespace-only text unchanged when no stash exists", () => {
			const whitespace = "   \n\t  ";
			const result = nextDraftState(whitespace, undefined);
			expect(result.nextActive).toBe(whitespace);
			expect(result.nextStash).toBeUndefined();
		});
	});

	describe("Case 2: no stash + non-empty active -> stash active; clear editor", () => {
		it("stashes active draft and clears editor", () => {
			const result = nextDraftState("Follow up on failing test", undefined);
			expect(result.nextActive).toBe("");
			expect(result.nextStash).toBe("Follow up on failing test");
		});

		it("preserves multi-line prompt text and image links intact", () => {
			const prompt = "Inspect image /tmp/test.png\nFix the crash on line 42";
			const result = nextDraftState(prompt, undefined);
			expect(result.nextActive).toBe("");
			expect(result.nextStash).toBe(prompt);
		});
	});

	describe("Case 3: stash + empty or whitespace-only active -> restore stash; discard active; clear slot", () => {
		it("restores stash to editor when active is empty", () => {
			const result = nextDraftState("", "stashed prompt content");
			expect(result.nextActive).toBe("stashed prompt content");
			expect(result.nextStash).toBeUndefined();
		});

		it("discards whitespace-only editor text when restoring stash", () => {
			const result = nextDraftState("   \t\n  ", "stashed prompt content");
			expect(result.nextActive).toBe("stashed prompt content");
			expect(result.nextStash).toBeUndefined();
		});
	});

	describe("Case 4: stash + non-empty active -> swap drafts", () => {
		it("swaps editor text with stashed text", () => {
			const result = nextDraftState("beta draft", "alpha draft");
			expect(result.nextActive).toBe("alpha draft");
			expect(result.nextStash).toBe("beta draft");
		});

		it("preserves both drafts on consecutive round-trip swaps without data loss", () => {
			const firstSwap = nextDraftState("beta", "alpha");
			expect(firstSwap.nextActive).toBe("alpha");
			expect(firstSwap.nextStash).toBe("beta");

			const secondSwap = nextDraftState(firstSwap.nextActive, firstSwap.nextStash);
			expect(secondSwap.nextActive).toBe("beta");
			expect(secondSwap.nextStash).toBe("alpha");
		});
	});
});

describe("rbfStashPrompt shortcut handler and factory isolation", () => {
	it("registers ctrl+s shortcut on initialization", () => {
		const mockAPI = createMockExtensionAPI();
		rbfStashPrompt(mockAPI.api);

		expect(mockAPI.api.registerShortcut).toHaveBeenCalledTimes(1);
		expect(mockAPI.api.registerShortcut).toHaveBeenCalledWith(
			"ctrl+s",
			expect.objectContaining({
				description: expect.any(String),
				handler: expect.any(Function),
			}),
		);
	});

	it("does nothing when editor is empty and no stash exists", () => {
		const mockAPI = createMockExtensionAPI();
		rbfStashPrompt(mockAPI.api);
		const mockCtx = createMockExtensionContext("");

		mockAPI.triggerShortcut(mockCtx.ctx);

		expect(mockCtx.ctx.ui.setEditorText).not.toHaveBeenCalled();
		expect(mockCtx.ctx.ui.setWidget).not.toHaveBeenCalled();
		expect(mockCtx.editorText).toBe("");
	});

	it("does nothing and leaves whitespace-only text unchanged when no stash exists", () => {
		const mockAPI = createMockExtensionAPI();
		rbfStashPrompt(mockAPI.api);
		const whitespace = "   \n\t ";
		const mockCtx = createMockExtensionContext(whitespace);

		mockAPI.triggerShortcut(mockCtx.ctx);

		expect(mockCtx.ctx.ui.setEditorText).not.toHaveBeenCalled();
		expect(mockCtx.ctx.ui.setWidget).not.toHaveBeenCalled();
		expect(mockCtx.editorText).toBe(whitespace);
	});

	it("stashes prompt, clears editor, and shows below-editor status widget", () => {
		const mockAPI = createMockExtensionAPI();
		rbfStashPrompt(mockAPI.api);
		const mockCtx = createMockExtensionContext("alpha");

		mockAPI.triggerShortcut(mockCtx.ctx);

		expect(mockCtx.ctx.ui.setEditorText).toHaveBeenCalledWith("");
		expect(mockCtx.editorText).toBe("");
		expect(mockCtx.ctx.ui.setWidget).toHaveBeenCalledWith(
			"rbf-stash-prompt",
			[expect.stringContaining("Draft stashed · Ctrl+S restore")],
			{ placement: "belowEditor" },
		);
	});

	it("restores prompt, clears stash, and removes widget when triggered with empty editor", () => {
		const mockAPI = createMockExtensionAPI();
		rbfStashPrompt(mockAPI.api);
		const mockCtx = createMockExtensionContext("alpha");

		mockAPI.triggerShortcut(mockCtx.ctx);
		expect(mockCtx.editorText).toBe("");

		mockAPI.triggerShortcut(mockCtx.ctx);
		expect(mockCtx.ctx.ui.setEditorText).toHaveBeenLastCalledWith("alpha");
		expect(mockCtx.editorText).toBe("alpha");
		expect(mockCtx.ctx.ui.setWidget).toHaveBeenLastCalledWith(
			"rbf-stash-prompt",
			undefined,
			{ placement: "belowEditor" },
		);
	});

	it("restores stashed draft intact after simulated editor use between shortcut invocations", () => {
		const mockAPI = createMockExtensionAPI();
		rbfStashPrompt(mockAPI.api);
		const mockCtx = createMockExtensionContext("alpha draft");

		mockAPI.triggerShortcut(mockCtx.ctx);
		expect(mockCtx.editorText).toBe("");

		mockCtx.editorText = "Reply only: beta";
		mockCtx.editorText = "";

		mockAPI.triggerShortcut(mockCtx.ctx);
		expect(mockCtx.editorText).toBe("alpha draft");
		expect(mockCtx.ctx.ui.setWidget).toHaveBeenLastCalledWith(
			"rbf-stash-prompt",
			undefined,
			{ placement: "belowEditor" },
		);
	});

	it("swaps active editor text with stashed text without data loss", () => {
		const mockAPI = createMockExtensionAPI();
		rbfStashPrompt(mockAPI.api);
		const mockCtx = createMockExtensionContext("alpha");

		mockAPI.triggerShortcut(mockCtx.ctx);
		expect(mockCtx.editorText).toBe("");

		mockCtx.editorText = "beta";

		mockAPI.triggerShortcut(mockCtx.ctx);
		expect(mockCtx.editorText).toBe("alpha");

		mockAPI.triggerShortcut(mockCtx.ctx);
		expect(mockCtx.editorText).toBe("beta");

		mockCtx.editorText = "";
		mockAPI.triggerShortcut(mockCtx.ctx);
		expect(mockCtx.editorText).toBe("alpha");
	});

	it("two factory instances cannot observe each other's stash (session isolation)", () => {
		const apiInstance1 = createMockExtensionAPI();
		const apiInstance2 = createMockExtensionAPI();

		rbfStashPrompt(apiInstance1.api);
		rbfStashPrompt(apiInstance2.api);

		const ctx1 = createMockExtensionContext("instance 1 private draft");
		const ctx2 = createMockExtensionContext("");

		apiInstance1.triggerShortcut(ctx1.ctx);
		expect(ctx1.editorText).toBe("");

		apiInstance2.triggerShortcut(ctx2.ctx);

		expect(ctx2.ctx.ui.setEditorText).not.toHaveBeenCalled();
		expect(ctx2.ctx.ui.setWidget).not.toHaveBeenCalled();
		expect(ctx2.editorText).toBe("");

		apiInstance1.triggerShortcut(ctx1.ctx);
		expect(ctx1.editorText).toBe("instance 1 private draft");
	});
});
