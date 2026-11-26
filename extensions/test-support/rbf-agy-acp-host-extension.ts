// Actual Pi host probe for the AGY ACP route (#pi-21.3, A21.3-4). Fake native boundary only: the provider is given agy-host-shim.cjs, never AGY. Never used by preview/install.
// The provider decides its own route, exactly as in daily Pi.
// It does not reserve its offline root with reserveAgyOfflineRoot as the brief's command would: /reload and a restart load it again against the same root, and an exclusive mkdir would refuse them.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRbfAgy } from "../rbf-agy.js";
import { installAgyOfflineGuard } from "./agy-offline-guard.js";
export default function probe(pi: ExtensionAPI) {
	const root = process.env.PI213_OFFLINE_ROOT;
	if (!root || !existsSync(root)) throw new Error("PI213_OFFLINE_ROOT must name an existing directory");
	const record = (event: string, data: any = {}) => appendFileSync(join(root, "host.jsonl"), JSON.stringify({ event, ...data }) + "\n");
	installAgyOfflineGuard(pi, record);
	// Every call Pi makes to the provider is logged (`provider_call`), then passed through unchanged, so a test can tell Pi's own retry from a prompt AGY received.
	const counted: ExtensionAPI = new Proxy(pi, {
		get(target: any, prop) {
			if (prop === "registerProvider") return (name: string, config: any) => target.registerProvider(name, { ...config, streamSimple: (model: any, context: any, options: any) => { record("provider_call", { roles: context.messages.map((m: any) => m.role), t: Date.now() }); return config.streamSimple(model, context, options); } });
			const value = target[prop];
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	createRbfAgy({ executable: join(import.meta.dirname, "agy-host-shim.cjs"), trace: record, wakeQuietMs: process.env.PI213_WAKE_QUIET_MS ? Number(process.env.PI213_WAKE_QUIET_MS) : undefined })(counted);
	pi.on("session_start", (event, ctx) => {
		record("loaded", { reason: event.reason, hashes: Object.fromEntries(["rbf-agy.ts", "lib/agy-acp.ts", "lib/agy-acp-session.ts", "lib/agy-recovery.ts", "lib/agy-history.ts", "lib/agy-acp-approval.ts"].map(file => [file, createHash("sha256").update(readFileSync(join(import.meta.dirname, "..", file))).digest("hex")])) });
		ctx.ui.notify("ACP_READY_" + event.reason, "info");
	});
	// /note <text> saves a custom_message entry, as another extension's pi.sendMessage does. It starts no turn.
	pi.registerCommand("note", { description: "Save a custom message entry, as another extension's pi.sendMessage does", handler: async (args, ctx) => { pi.sendMessage({ customType: "acp-test-note", content: args || "note", display: true }); ctx.ui.notify("ACP_NOTE_SENT", "info"); } });
	// /toggle-tool <name> switches one tool on or off for the session, as another extension's pi.setActiveTools would. Pi then declares the tool change in a system message it saves with the next prompt.
	pi.registerCommand("toggle-tool", { description: "Switch one tool on or off", handler: async (args, ctx) => {
		const name = args.trim(), active = pi.getActiveTools(), on = !active.includes(name);
		pi.setActiveTools(on ? [...active, name] : active.filter(n => n !== name));
		ctx.ui.notify(`ACP_TOOL_${name}_${on ? "ON" : "OFF"}`, "info");
	} });
	// Runs after the provider's own agent_end handler, so what it reads is what the provider saved.
	pi.on("agent_end", (_event, ctx) => {
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return;
		const saved = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
		const count = (type: string) => saved.filter(e => e.customType === type).length;
		const counts = {
			conversation: count("rbf-agy-acp-conversation/v1"),
			dispatch: count("rbf-agy-acp-dispatch/v1"),
			completion: count("rbf-agy-acp-completion/v1"),
			refusal: count("rbf-agy-acp-refusal/v1"),
			activity: count("rbf-agy-acp-activity/v1"),
			permission: count("rbf-agy-acp-permission/v1"),
			question: count("rbf-agy-acp-question/v1"),
			wake: count("rbf-agy-acp-wake/v1"),
		};
		record("saved", { file, counts, types: saved.filter(e => String(e.customType).startsWith("rbf-agy-")).map(e => e.customType) });
		ctx.ui.notify(`ACP_SAVED_C${counts.completion}_R${counts.refusal}`, "info");
	});
}
