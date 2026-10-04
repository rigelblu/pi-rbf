// Test-only loader. Selects a persisted synthetic leaf; never loaded by daily Pi.
import { resolve } from "node:path";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { benchmark, binding, inspect } from "./rbf-codex-interruption-inspect.ts";
import { AppServerClient, createRbfCodex, TURN_ENTRY_TYPE } from "../rbf-codex.ts";
import type { ExtensionAPI, ProviderConfig, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Api, Provider } from "@earendil-works/pi-ai";

export default function interruptionProbe(pi: ExtensionAPI) {
	function registerProvider(provider: Provider<Api>): void;
	function registerProvider(name: string, config: ProviderConfig): void;
	function registerProvider(provider: string | Provider<Api>, config?: ProviderConfig): void {
		if (typeof provider !== "string") return pi.registerProvider(provider);
		if (!config) throw new Error("Test provider config is missing");
		const stream = config.streamSimple;
		pi.registerProvider(provider, { ...config, ...(stream ? { streamSimple(model, context, options) {
			if (process.env.RBF_INTERRUPTION_STREAM_LOG) appendFileSync(process.env.RBF_INTERRUPTION_STREAM_LOG, `${JSON.stringify({ aborted: options?.signal?.aborted ?? false, lastRole: context.messages.at(-1)?.role })}\n`);
			return stream(model, context, options);
		} } : {}) });
	}
	const readyReceipt = process.env.RBF_INTERRUPTION_READY_RECEIPT;
	const readyLoad = Number(process.env.RBF_INTERRUPTION_READY_LOAD);
	if (!readyReceipt || !Number.isInteger(readyLoad) || readyLoad < 1) throw new Error("Isolated readiness receipt required");
	const sourceSha256 = createHash("sha256").update(readFileSync(resolve(import.meta.dirname, "../rbf-codex.ts"))).digest("hex");
	pi.on("session_start", async () => { writeFileSync(readyReceipt, JSON.stringify({ loads: readyLoad, sourceSha256 })); });
	pi.registerCommand("rbf-interruption-ready", { description: "Acknowledge isolated test input readiness", handler: async (args) => {
		if (Number(args) === readyLoad) writeFileSync(readyReceipt, JSON.stringify({ loads: readyLoad, readyLoad, sourceSha256 }));
	} });
	const probe: ExtensionAPI = { ...pi, registerProvider };
	const real = process.env.RBF_INTERRUPTION_PTY_REAL_CODEX === "1";
	const proxy = resolve(import.meta.dirname, "rbf-codex-interruption-proxy.ts");
	const codex = process.env.RBF_INTERRUPTION_PTY_CODEX_BIN;
	if (real && !codex) throw new Error("Opt-in probe requires a Codex executable");
	createRbfCodex({ command: real
		? { bin: "bun", args: [proxy, codex!, "app-server"], versionArgs: [proxy, codex!, "--version"] }
		: { bin: process.execPath, args: [resolve(import.meta.dirname, "rbf-codex-fake-app-server.ts")] } })(probe);
	if (real) {
		// Observe the genuine provider client, without replacing its requests or
		// adding a production hook. A second resume client cannot own this live T.
		const start = AppServerClient.start;
		let providerClient: AppServerClient | undefined;
		const observedStart: typeof start = async (cwd, command) => {
			const client = await start(cwd, command);
			if (command.args[0] === proxy) providerClient = client;
			return client;
		};
		AppServerClient.start = observedStart;
		pi.on("session_shutdown", async () => { if (AppServerClient.start === observedStart) AppServerClient.start = start; });
		pi.registerCommand("rbf-test-bench", { description: "Read-only interruption timing probe", handler: async (_args, ctx) => {
			const file = ctx.sessionManager.getSessionFile();
			if (!file || !process.env.RBF_INTERRUPTION_BENCH_RECEIPT) throw new Error("Isolated receipt required");
			try {
				if (!providerClient || providerClient.exited) throw new Error("Live warm provider client required");
				const result = await benchmark(file, providerClient, Number(process.env.RBF_INTERRUPTION_BENCH_SAMPLES ?? 10));
				writeFileSync(process.env.RBF_INTERRUPTION_BENCH_RECEIPT, JSON.stringify(result));
			} catch (error) {
				writeFileSync(process.env.RBF_INTERRUPTION_BENCH_RECEIPT, JSON.stringify({ error: error instanceof Error ? error.message : "unknown error" }));
			}
			ctx.ui.notify("RBF_BENCH_DONE", "info");
		} });
		pi.registerCommand("rbf-test-inspect", { description: "Read-only interruption count probe", handler: async (_args, ctx) => {
			const file = ctx.sessionManager.getSessionFile();
			if (!file || !process.env.RBF_INTERRUPTION_INSPECT_RECEIPT || !process.env.RBF_INTERRUPTION_NONCE) throw new Error("Isolated inspector receipt required");
			try {
				writeFileSync(process.env.RBF_INTERRUPTION_INSPECT_RECEIPT, JSON.stringify(await inspect(file, codex!, process.env.RBF_INTERRUPTION_NONCE)));
			} catch (error) {
				writeFileSync(process.env.RBF_INTERRUPTION_INSPECT_RECEIPT, JSON.stringify({ error: error instanceof Error ? error.message : "unknown error" }));
			}
			ctx.ui.notify("RBF_INSPECT_DONE", "info");
		} });
		pi.registerCommand("rbf-test-crash", { description: "Crash only this isolated test-owned Pi", handler: async (_args, ctx) => {
			const file = ctx.sessionManager.getSessionFile();
			if (!file || !process.env.RBF_INTERRUPTION_CRASH_RECEIPT) throw new Error("Isolated receipt required");
			const saved = binding(file);
			if (saved.entries.some((e) => e.type === "custom" && e.customType === TURN_ENTRY_TYPE && (e.data as { status?: string })?.status === "completed") || !saved.entries.some((e) => e.type === "message" && e.message.role === "user")) throw new Error("First saved T/input without U required");
			writeFileSync(process.env.RBF_INTERRUPTION_CRASH_RECEIPT, JSON.stringify({ saved: true, no_completed_U: true, pi_pid: process.pid }));
			process.kill(process.pid, "SIGKILL");
		} });
	}
	if (process.env.RBF_INTERRUPTION_LEAF) pi.on("session_start", async (_event, ctx) => {
		(ctx.sessionManager as SessionManager).branch(process.env.RBF_INTERRUPTION_LEAF!);
	});
}
