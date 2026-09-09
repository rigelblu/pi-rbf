import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import rbfUserMessagePadding, {
	applyUserMessagePadding,
	restoreUserMessagePadding,
	USER_MESSAGE_PADDING_KEY,
} from "./rbf-user-message-padding.ts";

describe("rbf-user-message-padding extension", () => {
	beforeEach(() => {
		initTheme();
		restoreUserMessagePadding();
	});

	afterEach(() => {
		restoreUserMessagePadding();
	});

	it("default unpatched UserMessageComponent renders 3 lines for a 1-line prompt", () => {
		const comp = new UserMessageComponent("hello world");
		const lines = comp.render(80);
		expect(lines.length).toBe(3);
	});

	it("applyUserMessagePadding(0) reduces 1-line prompt to 1 rendered line", () => {
		const applied = applyUserMessagePadding(0);
		expect(applied).toBe(true);

		const comp = new UserMessageComponent("hello world");
		const lines = comp.render(80);
		expect(lines.length).toBe(1);
	});

	it("applyUserMessagePadding(0) renders 2 lines for a 2-line prompt", () => {
		applyUserMessagePadding(0);

		const comp = new UserMessageComponent("line 1\nline 2");
		const lines = comp.render(80);
		expect(lines.length).toBe(2);
	});

	it("preserves paddingY = 0 when setOutputPad is invoked", () => {
		applyUserMessagePadding(0);

		const comp = new UserMessageComponent("hello world");
		comp.setOutputPad(2);

		const lines = comp.render(80);
		expect(lines.length).toBe(1);
	});

	it("applyUserMessagePadding is idempotent and does not double-wrap", () => {
		const first = applyUserMessagePadding(0);
		expect(first).toBe(true);

		const second = applyUserMessagePadding(0);
		expect(second).toBe(false);

		const comp = new UserMessageComponent("hello world");
		expect(comp.render(80).length).toBe(1);
	});

	it("restoreUserMessagePadding restores unpatched behavior", () => {
		applyUserMessagePadding(0);
		expect((UserMessageComponent.prototype as any)[USER_MESSAGE_PADDING_KEY]).toBe(true);

		const restored = restoreUserMessagePadding();
		expect(restored).toBe(true);
		expect((UserMessageComponent.prototype as any)[USER_MESSAGE_PADDING_KEY]).toBeUndefined();

		const comp = new UserMessageComponent("hello world");
		expect(comp.render(80).length).toBe(3);
	});

	it("extension entrypoint rbfUserMessagePadding applies paddingY = 0", () => {
		rbfUserMessagePadding();

		const comp = new UserMessageComponent("hello world");
		expect(comp.render(80).length).toBe(1);
	});

	it("source code contains no unauthorized sinks or network/child_process imports", () => {
		const sourcePath = resolve(__dirname, "rbf-user-message-padding.ts");
		const content = readFileSync(sourcePath, "utf-8");

		expect(content).not.toMatch(/node:child_process|child_process/);
		expect(content).not.toMatch(/node:fs|fs/);
		expect(content).not.toMatch(/node:net|node:http|fetch/);
		expect(content).not.toMatch(/process\.exit/);
	});
});
