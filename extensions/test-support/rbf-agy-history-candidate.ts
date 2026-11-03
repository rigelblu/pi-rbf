// Isolated fake-native candidate only. Never install this wrapper.
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRbfAgy } from "../rbf-agy.js";
import { installAgyOfflineGuard } from "./agy-offline-guard.js";

export default function (pi: ExtensionAPI) {
	if (!process.env.PI_CODING_AGENT_DIR) throw new Error("History candidate requires its isolated profile");
	const root = dirname(realpathSync(process.env.PI_CODING_AGENT_DIR)), log = join(root, "host-events.jsonl");
	const record = (kind: string, data: Record<string, unknown> = {}) => appendFileSync(log, JSON.stringify({ kind, ...data }) + "\n");
	installAgyOfflineGuard(pi, record);
	const loadKey = Symbol.for("rbf.agy.history-fixture-loads"), global = globalThis as any;
	const load = global[loadKey] = (global[loadKey] ?? 0) + 1;
	const readiness = join(root, "editor-ready.json");
	const extensions = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	record("loaded-source", { piVersion: VERSION, hashes: Object.fromEntries(["rbf-agy.ts", "lib/agy-native.ts", "lib/agy-history.ts"].map(file => [file, createHash("sha256").update(readFileSync(join(extensions, file))).digest("hex")])) });
	createRbfAgy({ executable: join(root, "fake-agy.cjs"), trace: record })(pi);
	pi.on("session_start", (_event, ctx) => { writeFileSync(readiness, JSON.stringify({loads:load,readyLoad:0})); record("ready", { sessionId: ctx.sessionManager.getSessionId(), runtime: process.version, provider: ctx.model?.provider, model: ctx.model?.id }); });
	pi.registerCommand("history-ready", { description: "Acknowledge isolated history candidate", handler: async (args, ctx) => { if (Number(args.trim()) !== load) return; writeFileSync(readiness, JSON.stringify({loads:load,readyLoad:load})); record("editor-ready"); ctx.ui.notify("HISTORY_FIXTURE_READY", "info"); } });
}
