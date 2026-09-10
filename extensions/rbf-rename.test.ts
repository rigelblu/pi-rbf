import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import rbfRename, {
	RENAME_COMMAND_DESCRIPTION,
	RENAME_COMMAND_NAME,
	RENAME_USAGE,
} from "./rbf-rename.ts";

function createMockExtensionCommandContext() {
	const notify = vi.fn();
	const ctx = {
		ui: { notify },
	} as unknown as ExtensionCommandContext;
	return { ctx, notify };
}

function createMockExtensionAPI(initialName?: string) {
	let currentName = initialName;
	let registeredCommandOptions: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
	let registeredName: string | undefined;

	const setSessionName = vi.fn((name: string) => {
		currentName = name.replace(/[\r\n]+/g, " ").trim();
	});
	const getSessionName = vi.fn(() => currentName);
	const registerCommand = vi.fn(
		(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			registeredName = name;
			registeredCommandOptions = options;
		},
	);
	const api = {
		registerCommand,
		setSessionName,
		getSessionName,
	} as unknown as ExtensionAPI;

	return {
		api,
		get currentName() {
			return currentName;
		},
		get registeredName() {
			return registeredName;
		},
		get registeredOptions() {
			return registeredCommandOptions;
		},
		setSessionName,
		getSessionName,
		async triggerCommand(args: string, ctx: ExtensionCommandContext) {
			if (!registeredCommandOptions) throw new Error("No command registered");
			await registeredCommandOptions.handler(args, ctx);
		},
	};
}

describe("rbfRename extension", () => {
	it("registers only /rename with the exact description", () => {
		const mockAPI = createMockExtensionAPI();
		rbfRename(mockAPI.api);

		expect(mockAPI.api.registerCommand).toHaveBeenCalledTimes(1);
		expect(mockAPI.registeredName).toBe("rename");
		expect(RENAME_COMMAND_NAME).toBe("rename");
		expect(mockAPI.registeredOptions?.description).toBe(RENAME_COMMAND_DESCRIPTION);
		expect(RENAME_COMMAND_DESCRIPTION).toBe("Name or rename current session (alias for /name)");
	});

	it("shows alias-specific usage when bare /rename has no current name", async () => {
		const mockAPI = createMockExtensionAPI();
		const { ctx, notify } = createMockExtensionCommandContext();
		rbfRename(mockAPI.api);

		await mockAPI.triggerCommand("", ctx);

		expect(mockAPI.setSessionName).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith(RENAME_USAGE, "warning");
	});

	it("shows the current name when bare /rename is used in a named session", async () => {
		const mockAPI = createMockExtensionAPI("api-contract");
		const { ctx, notify } = createMockExtensionCommandContext();
		rbfRename(mockAPI.api);

		await mockAPI.triggerCommand("  \t ", ctx);

		expect(mockAPI.setSessionName).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("Session name: api-contract", "info");
	});

	it("sets a supplied session name and reports the stored value", async () => {
		const mockAPI = createMockExtensionAPI();
		const { ctx, notify } = createMockExtensionCommandContext();
		rbfRename(mockAPI.api);

		await mockAPI.triggerCommand("api-contract", ctx);

		expect(mockAPI.setSessionName).toHaveBeenCalledWith("api-contract");
		expect(mockAPI.currentName).toBe("api-contract");
		expect(notify).toHaveBeenCalledWith("Session name set: api-contract", "info");
	});

	it("replaces an existing session name", async () => {
		const mockAPI = createMockExtensionAPI("first-name");
		const { ctx, notify } = createMockExtensionCommandContext();
		rbfRename(mockAPI.api);

		await mockAPI.triggerCommand("second-name", ctx);

		expect(mockAPI.currentName).toBe("second-name");
		expect(notify).toHaveBeenCalledWith("Session name set: second-name", "info");
	});

	it("trims surrounding whitespace like native /name", async () => {
		const mockAPI = createMockExtensionAPI();
		const { ctx, notify } = createMockExtensionCommandContext();
		rbfRename(mockAPI.api);

		await mockAPI.triggerCommand("  release planning  ", ctx);

		expect(mockAPI.setSessionName).toHaveBeenCalledWith("release planning");
		expect(notify).toHaveBeenCalledWith("Session name set: release planning", "info");
	});

	it("reports Pi normalization and confirms the normalized name", async () => {
		const mockAPI = createMockExtensionAPI();
		const { ctx, notify } = createMockExtensionCommandContext();
		rbfRename(mockAPI.api);

		await mockAPI.triggerCommand("release\nplanning", ctx);

		expect(mockAPI.currentName).toBe("release planning");
		expect(notify).toHaveBeenNthCalledWith(
			1,
			'Session name was normalized from "release\\nplanning" to "release planning"',
			"warning",
		);
		expect(notify).toHaveBeenNthCalledWith(2, "Session name set: release planning", "info");
	});

	it("treats newline-only input as blank instead of clearing the name", async () => {
		const mockAPI = createMockExtensionAPI("keep-me");
		const { ctx, notify } = createMockExtensionCommandContext();
		rbfRename(mockAPI.api);

		await mockAPI.triggerCommand("\n\r\n", ctx);

		expect(mockAPI.setSessionName).not.toHaveBeenCalled();
		expect(mockAPI.currentName).toBe("keep-me");
		expect(notify).toHaveBeenCalledWith("Session name: keep-me", "info");
	});

	it("contains no unauthorized sinks or side-channel imports", () => {
		const source = readFileSync(resolve(__dirname, "rbf-rename.ts"), "utf-8");

		expect(source).not.toMatch(/node:child_process|child_process/);
		expect(source).not.toMatch(/node:fs|fs/);
		expect(source).not.toMatch(/node:net|node:http|fetch/);
		expect(source).not.toMatch(/process\.exit/);
	});
});
