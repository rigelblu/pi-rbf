import { constants } from "node:fs";
import type {
	EditOperations,
	FindOperations,
	LsOperations,
	ReadOperations,
	WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { brokerRpc } from "./broker-rpc.js";
import type { EffectivePolicy } from "./policy.js";

export function createSandboxedToolOperations(options: {
	readonly brokerPath: string;
	readonly fdPath: string;
	readonly policy: EffectivePolicy;
	readonly workspace: string;
}): {
	readonly edit: EditOperations;
	readonly find: FindOperations;
	readonly ls: LsOperations;
	readonly read: ReadOperations;
	readonly write: WriteOperations;
} {
	const call = <T>(request: Readonly<Record<string, unknown>>) => brokerRpc<T>({ ...options, request });
	const readFile = async (absolutePath: string) => {
		const value = await call<{ base64: string }>({ operation: "readFile", path: absolutePath });
		return Buffer.from(value.base64, "base64");
	};
	const access = async (absolutePath: string) => {
		await call({ operation: "access", path: absolutePath, mode: constants.R_OK });
	};
	const writeFile = async (absolutePath: string, content: string) => {
		await call({ operation: "writeFile", path: absolutePath, content });
	};
	return {
		read: { readFile, access },
		write: {
			writeFile,
			mkdir: async (dir) => { await call({ operation: "mkdir", path: dir }); },
		},
		edit: {
			readFile,
			writeFile,
			access: async (absolutePath) => {
				await call({ operation: "access", path: absolutePath, mode: constants.R_OK | constants.W_OK });
			},
		},
		ls: {
			exists: (absolutePath) => call<boolean>({ operation: "exists", path: absolutePath }),
			stat: async (absolutePath) => {
				const value = await call<{ isDirectory: boolean }>({ operation: "stat", path: absolutePath });
				return { isDirectory: () => value.isDirectory };
			},
			readdir: (absolutePath) => call<string[]>({ operation: "readdir", path: absolutePath }),
		},
		find: {
			exists: (absolutePath) => call<boolean>({ operation: "exists", path: absolutePath }),
			glob: (pattern, cwd, globOptions) => call<string[]>({
				operation: "glob",
				pattern,
				cwd,
				limit: globOptions.limit,
				fdPath: options.fdPath,
			}),
		},
	};
}
