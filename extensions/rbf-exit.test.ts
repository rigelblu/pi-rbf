import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import rbfExit, { EXIT_COMMAND_DESCRIPTION, EXIT_COMMAND_NAME } from "./rbf-exit.ts";

function createMockExtensionCommandContext() {
	const shutdownMock = vi.fn();
	const ctx = {
		shutdown: shutdownMock,
	} as unknown as ExtensionCommandContext;

	return {
		ctx,
		shutdownMock,
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

describe("rbfExit extension", () => {
	it("registers the /exit command with exact name and description", () => {
		const mockAPI = createMockExtensionAPI();
		rbfExit(mockAPI.api);

		expect(mockAPI.api.registerCommand).toHaveBeenCalledTimes(1);
		expect(mockAPI.registeredName).toBe("exit");
		expect(EXIT_COMMAND_NAME).toBe("exit");
		expect(mockAPI.registeredOptions?.description).toBe("Exit pi");
		expect(EXIT_COMMAND_DESCRIPTION).toBe("Exit pi");
	});

	it("triggers ctx.shutdown() when /exit is invoked with empty arguments", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfExit(mockAPI.api);
		const mockCtx = createMockExtensionCommandContext();

		await mockAPI.triggerCommand("", mockCtx.ctx);
		expect(mockCtx.shutdownMock).toHaveBeenCalledTimes(1);
	});

	it("triggers ctx.shutdown() when /exit is invoked with whitespace arguments", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfExit(mockAPI.api);
		const mockCtx = createMockExtensionCommandContext();

		await mockAPI.triggerCommand("   \t  ", mockCtx.ctx);
		expect(mockCtx.shutdownMock).toHaveBeenCalledTimes(1);
	});

	it("triggers ctx.shutdown() and tolerates arbitrary trailing arguments", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfExit(mockAPI.api);

		for (const arg of ["now", "-f", "--force", "quit please", "123"]) {
			const mockCtx = createMockExtensionCommandContext();
			await mockAPI.triggerCommand(arg, mockCtx.ctx);
			expect(mockCtx.shutdownMock).toHaveBeenCalledTimes(1);
		}
	});

	it("has no side effects or leaks across separate instances", () => {
		const api1 = createMockExtensionAPI();
		const api2 = createMockExtensionAPI();

		rbfExit(api1.api);
		rbfExit(api2.api);

		expect(api1.registeredName).toBe("exit");
		expect(api2.registeredName).toBe("exit");
	});

	it("source code contains no unauthorized sinks or side-channel imports", () => {
		const sourcePath = resolve(__dirname, "rbf-exit.ts");
		const content = readFileSync(sourcePath, "utf-8");

		expect(content).not.toMatch(/node:child_process|child_process/);
		expect(content).not.toMatch(/node:fs|fs/);
		expect(content).not.toMatch(/node:net|node:http|fetch/);
		expect(content).not.toMatch(/process\.exit/);
	});
});
