// Actual Pi host probe, fake native boundary only. Never used by preview/install.
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRbfAgy } from "../rbf-agy.js";
import { installAgyOfflineGuard } from "./agy-offline-guard.js";
export default function probe(pi: ExtensionAPI) {
	const root = process.env.PI214_OFFLINE_ROOT;
	if (!root) throw new Error("Offline root required");
	const record = (event: string, data: any = {}) => appendFileSync(join(root, "host.jsonl"), JSON.stringify({ event, ...data }) + "\n");
	installAgyOfflineGuard(pi, record);
	const providerPi: ExtensionAPI = process.env.PI214_OFFLINE_FAIL_COMPLETION ? { ...pi, appendEntry(type, data) { if (type === "rbf-agy-completion/v1") throw new Error("Offline completion persistence fault"); pi.appendEntry(type, data); } } : pi;
	createRbfAgy({ executable: join(import.meta.dirname, "agy-recovery-fake.cjs"), trace: record })(providerPi);
	pi.on("session_start", (_event, ctx) => {
		record("loaded", { hashes: Object.fromEntries(["rbf-agy.ts", "lib/agy-native.ts", "lib/agy-recovery.ts"].map(file => [file, createHash("sha256").update(readFileSync(join(import.meta.dirname, "..", file))).digest("hex")])) });
		ctx.ui.notify("OFFLINE_READY", "info");
	});
	pi.on("agent_end", (_event, ctx) => {
		const file = ctx.sessionManager.getSessionFile();
		if (file) {
			const saved = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
			const completions = saved.filter(e => e.customType === "rbf-agy-completion/v1");
			record("saved", { count: completions.length, file, completion: completions.at(-1)?.data });
			ctx.ui.notify("OFFLINE_SAVED_" + completions.length, "info");
		}
	});
}
