import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import readline from "node:readline";
import type { Readable } from "node:stream";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { EffectivePolicy } from "./policy.js";

interface ControlFrame {
	error?: string;
	nonce: string;
	phase: "ready" | "completion";
	value?: { exitCode?: number | null };
	version: 1;
}

export function createSandboxedBashOperations(options: {
	readonly brokerPath: string;
	readonly policy: EffectivePolicy;
	readonly workspace: string;
}): BashOperations {
	return {
		exec: async (command, cwd, execution) => {
			const nonce = randomBytes(24).toString("hex");
			const brokerCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(options.brokerPath)}`;
			const wrapped = await SandboxManager.wrapWithSandboxArgv(
				brokerCommand,
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
					stdio: ["pipe", "pipe", "pipe", "pipe"],
				});
				let settled = false;
				let ready = false;
				let completion: ControlFrame | undefined;
				const killProcessGroup = () => {
					try {
						if (child.pid) process.kill(-child.pid, "SIGKILL");
					} catch {
						child.kill("SIGKILL");
					}
				};
				const finishError = (error: Error) => {
					if (settled) return;
					settled = true;
					killProcessGroup();
					reject(error);
				};
				const timer = execution.timeout
					? setTimeout(() => finishError(new Error("Sandboxed command timed out")), execution.timeout * 1000)
					: undefined;
				const abort = () => finishError(new Error("Sandboxed command cancelled"));
				execution.signal?.addEventListener("abort", abort, { once: true });
				child.stdout.on("data", execution.onData);
				child.stderr.on("data", execution.onData);
				readline.createInterface({ input: child.stdio[3] as Readable }).on("line", (line) => {
					let frame: ControlFrame;
					try {
						frame = JSON.parse(line) as ControlFrame;
					} catch {
						finishError(new Error("Malformed sandbox control frame"));
						return;
					}
					if (frame.version !== 1 || frame.nonce !== nonce) {
						finishError(new Error("Mismatched sandbox control frame"));
						return;
					}
					if (frame.phase === "ready" && !ready) {
						ready = true;
						child.stdin!.end(JSON.stringify({ version: 1, nonce, operation: "bash", command, cwd }));
					} else if (frame.phase === "completion" && ready && !completion) {
						completion = frame;
					} else {
						finishError(new Error("Unexpected sandbox control sequence"));
					}
				});
				child.on("error", finishError);
				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					execution.signal?.removeEventListener("abort", abort);
					if (settled) return;
					settled = true;
					if (!ready || !completion || code !== 0) {
						reject(new Error("Sandbox broker exited without valid completion"));
						return;
					}
					if (completion.error) {
						reject(new Error(completion.error));
						return;
					}
					resolve({ exitCode: completion.value?.exitCode ?? null });
				});
			});
		},
	};
}
