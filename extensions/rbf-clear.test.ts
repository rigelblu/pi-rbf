import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import rbfClear, {
	CLEAR_COMMAND_DESCRIPTION,
	CLEAR_COMMAND_NAME,
	CLEAR_SESSION_NOTICE,
} from "./rbf-clear.ts";

type ReplacedContext = Parameters<
	NonNullable<NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>["withSession"]>
>[0];

function createMockExtensionCommandContext(options?: { cancelled?: boolean }) {
	const notifyMock = vi.fn();
	const replacedCtx = {
		ui: {
			notify: notifyMock,
		},
	} as unknown as ReplacedContext;

	const newSessionMock = vi.fn(
		async (opts?: { withSession?: (ctx: ReplacedContext) => Promise<void> }) => {
			const cancelled = options?.cancelled ?? false;
			if (!cancelled && opts?.withSession) {
				await opts.withSession(replacedCtx);
			}
			return { cancelled };
		},
	);

	const ctx = {
		newSession: newSessionMock,
	} as unknown as ExtensionCommandContext;

	return {
		ctx,
		newSessionMock,
		notifyMock,
		replacedCtx,
	};
}

function createMockExtensionAPI() {
	let registeredCommandOptions: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
	let registeredName: string | undefined;

	const api = {
		registerCommand: vi.fn((name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			registeredName = name;
			registeredCommandOptions = options;
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
	};
}

describe("rbfClear extension", () => {
	it("registers the /clear command with exact name and description", () => {
		const mockAPI = createMockExtensionAPI();
		rbfClear(mockAPI.api);

		expect(mockAPI.api.registerCommand).toHaveBeenCalledTimes(1);
		expect(mockAPI.registeredName).toBe("clear");
		expect(CLEAR_COMMAND_NAME).toBe("clear");
		expect(mockAPI.registeredOptions?.description).toBe("Clear conversation and start a new session");
		expect(CLEAR_COMMAND_DESCRIPTION).toBe("Clear conversation and start a new session");
	});

	it("triggers ctx.newSession() when /clear is invoked with empty arguments", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfClear(mockAPI.api);
		const mockCtx = createMockExtensionCommandContext();

		await mockAPI.triggerCommand("", mockCtx.ctx);
		expect(mockCtx.newSessionMock).toHaveBeenCalledTimes(1);
		expect(mockCtx.notifyMock).toHaveBeenCalledWith(CLEAR_SESSION_NOTICE, "info");
	});

	it("triggers ctx.newSession() when /clear is invoked with whitespace arguments", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfClear(mockAPI.api);
		const mockCtx = createMockExtensionCommandContext();

		await mockAPI.triggerCommand("   \t  ", mockCtx.ctx);
		expect(mockCtx.newSessionMock).toHaveBeenCalledTimes(1);
		expect(mockCtx.notifyMock).toHaveBeenCalledWith(CLEAR_SESSION_NOTICE, "info");
	});

	it("triggers ctx.newSession() and tolerates arbitrary trailing arguments", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfClear(mockAPI.api);

		for (const arg of ["now", "-f", "--force", "new task", "123"]) {
			const mockCtx = createMockExtensionCommandContext();
			await mockAPI.triggerCommand(arg, mockCtx.ctx);
			expect(mockCtx.newSessionMock).toHaveBeenCalledTimes(1);
			expect(mockCtx.notifyMock).toHaveBeenCalledWith(CLEAR_SESSION_NOTICE, "info");
		}
	});

	it("handles cancellation from session_before_switch without throwing", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfClear(mockAPI.api);
		const mockCtx = createMockExtensionCommandContext({ cancelled: true });

		await expect(mockAPI.triggerCommand("", mockCtx.ctx)).resolves.toBeUndefined();
		expect(mockCtx.newSessionMock).toHaveBeenCalledTimes(1);
		expect(mockCtx.notifyMock).not.toHaveBeenCalled();
	});

	it("handles replacement context where ui is missing gracefully", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfClear(mockAPI.api);

		const newSessionMock = vi.fn(
			async (opts?: { withSession?: (ctx: ReplacedContext) => Promise<void> }) => {
				const ctxWithoutUi = {} as ReplacedContext;
				if (opts?.withSession) {
					await opts.withSession(ctxWithoutUi);
				}
				return { cancelled: false };
			},
		);

		const ctx = {
			newSession: newSessionMock,
		} as unknown as ExtensionCommandContext;

		await expect(mockAPI.triggerCommand("", ctx)).resolves.toBeUndefined();
		expect(newSessionMock).toHaveBeenCalledTimes(1);
	});

	it("has no side effects or leaks across separate instances", () => {
		const api1 = createMockExtensionAPI();
		const api2 = createMockExtensionAPI();

		rbfClear(api1.api);
		rbfClear(api2.api);

		expect(api1.registeredName).toBe("clear");
		expect(api2.registeredName).toBe("clear");
	});

	it("source code contains no unauthorized sinks or side-channel imports", () => {
		const sourcePath = resolve(__dirname, "rbf-clear.ts");
		const content = readFileSync(sourcePath, "utf-8");

		expect(content).not.toMatch(/node:child_process|child_process/);
		expect(content).not.toMatch(/node:fs|fs/);
		expect(content).not.toMatch(/node:net|node:http|fetch/);
		expect(content).not.toMatch(/process\.exit/);
	});
});
