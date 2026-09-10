import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createSandboxedBashOperations } from "./broker-client.js";
import { brokerRpc } from "./broker-rpc.js";
import type { EffectivePolicy } from "./policy.js";
import { createSandboxedToolOperations } from "./tool-operations.js";

export function registerSandboxedTools(pi: ExtensionAPI, options: {
	readonly brokerPath: string;
	readonly fdPath: string;
	readonly policy: EffectivePolicy;
	readonly rgPath: string;
	readonly workspace: string;
}): void {
	const operations = createSandboxedToolOperations(options);
	pi.registerTool(createBashToolDefinition(options.workspace, {
		operations: createSandboxedBashOperations(options),
		shellPath: "/bin/bash",
		exposeSessionEnvironment: false,
	}));
	pi.registerTool(createReadToolDefinition(options.workspace, { operations: operations.read }));
	pi.registerTool(createWriteToolDefinition(options.workspace, { operations: operations.write }));
	pi.registerTool(createEditToolDefinition(options.workspace, { operations: operations.edit }));
	pi.registerTool(createLsToolDefinition(options.workspace, { operations: operations.ls }));
	pi.registerTool(createFindToolDefinition(options.workspace, { operations: operations.find }));

	const grep = createGrepToolDefinition(options.workspace);
	grep.execute = async (_toolCallId, input, signal, _onUpdate, ctx) => {
		if (signal?.aborted) throw new Error("Operation aborted");
		const searchPath = input.path ?? ctx?.cwd ?? options.workspace;
		const text = await brokerRpc<string>({
			brokerPath: options.brokerPath,
			signal,
			policy: options.policy,
			workspace: options.workspace,
			request: {
				operation: "grep",
				pattern: input.pattern,
				path: searchPath,
				cwd: options.workspace,
				glob: input.glob,
				ignoreCase: input.ignoreCase,
				literal: input.literal,
				rgPath: options.rgPath,
			},
		});
		const limit = Math.max(1, input.limit ?? 100);
		const lines = text.split("\n").filter(Boolean);
		const visible = lines.slice(0, limit).join("\n");
		return {
			content: [{ type: "text", text: visible || "No matches found" }],
			details: lines.length > limit ? { matchLimitReached: limit } : undefined,
		};
	};
	pi.registerTool(grep);
}
