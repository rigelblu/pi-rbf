/** Offline Pi preview: real extension and native UI, fake stdio Codex only. */
import { resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRbfCodex } from "../rbf-codex.ts";

export default function preview(pi: ExtensionAPI) {
	const receipt = process.env.RBF_FAST_PREVIEW_RECEIPT;
	if (receipt) {
		const key = Symbol.for("rbf.fast-preview.loads");
		const globals = globalThis as Record<symbol, number>;
		const loads = globals[key] = (globals[key] ?? 0) + 1;
		const sourceSha256 = createHash("sha256").update(readFileSync(resolve(import.meta.dirname, "../rbf-codex.ts"))).digest("hex");
		const write = (readyLoad = 0) => writeFileSync(receipt, JSON.stringify({ loads, readyLoad, sourceSha256 }));
		pi.on("session_start", async () => { write(); });
		pi.registerCommand("rbf-fast-ready", { description: "Acknowledge offline preview readiness", handler: async args => { if (Number(args) === loads) write(loads); } });
	}
	createRbfCodex({ command: { bin: process.execPath, args: [resolve(import.meta.dirname, "rbf-codex-fake-app-server.ts")] } })(pi);
}
