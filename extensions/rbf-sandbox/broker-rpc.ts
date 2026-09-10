import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import readline from "node:readline";
import type { Readable } from "node:stream";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { EffectivePolicy } from "./policy.js";

interface Frame {
	error?: string;
	nonce: string;
	phase: "ready" | "completion";
	value?: unknown;
	version: 1;
}

export async function brokerRpc<T>(options: {
	readonly brokerPath: string;
	readonly policy: EffectivePolicy;
	readonly request: Readonly<Record<string, unknown>>;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly workspace: string;
}): Promise<T> {
	const nonce = randomBytes(24).toString("hex");
	const wrapped = await SandboxManager.wrapWithSandboxArgv(
		`${JSON.stringify(process.execPath)} ${JSON.stringify(options.brokerPath)}`,
		"/bin/bash",
		options.policy.srtConfig,
		undefined,
		options.workspace,
		{ commandId: nonce, commandText: "rbf sandbox broker" },
	);
	return new Promise((resolve, reject) => {
		const child = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
			cwd: options.workspace,
			detached: true,
			env: {
				...options.policy.environment,
				RBF_SANDBOX_ENV: JSON.stringify(options.policy.environment),
				RBF_SANDBOX_NONCE: nonce,
			},
			stdio: ["pipe", "ignore", "pipe", "pipe"],
		});
		let settled = false;
		let completed = false;
		const killProcessGroup = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			killProcessGroup();
			reject(error);
		};
		const abort = () => fail(new Error("Sandbox operation aborted"));
		const timer = options.timeoutMs ? setTimeout(() => fail(new Error("Sandbox operation timed out")), options.timeoutMs) : undefined;
		options.signal?.addEventListener("abort", abort, { once: true });
		readline.createInterface({ input: child.stdio[3] as Readable }).on("line", (line) => {
			let frame: Frame;
			try {
				frame = JSON.parse(line) as Frame;
			} catch {
				fail(new Error("Malformed sandbox control frame"));
				return;
			}
			if (frame.version !== 1 || frame.nonce !== nonce) {
				fail(new Error("Mismatched sandbox control frame"));
				return;
			}
			if (frame.phase === "ready") {
				child.stdin!.end(JSON.stringify({ version: 1, nonce, ...options.request }));
				return;
			}
			if (completed) {
				fail(new Error("Duplicate sandbox completion"));
				return;
			}
			completed = true;
			if (frame.error) fail(new Error(frame.error));
			else {
				settled = true;
				cleanup();
				resolve(frame.value as T);
			}
		});
		child.on("error", fail);
		child.on("close", (code) => {
			if (!settled) fail(new Error(`Sandbox broker exited before completion (${code ?? "signal"})`));
		});
	});
}
