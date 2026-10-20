import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Offline native-Pi staging only: the production factory with the existing fake server. */
export default async function agentsProbe(pi: ExtensionAPI): Promise<void> {
	const { createRbfCodex } = await import(process.env.RBF_AGENTS_SOURCE ?? "../rbf-codex.ts");
	let open: ((args: string, ctx: any) => Promise<void>) | undefined;
	const probe: ExtensionAPI = { ...pi, registerCommand(name, options) { if (name === "agents-codex") open = options.handler; pi.registerCommand(name, options); } };
	createRbfCodex({ command: { bin: process.execPath, args: [resolve(import.meta.dirname, "rbf-codex-fake-app-server.ts")] }, argv: [] })(probe);
	pi.registerShortcut("alt+a", { description: "Offline test: open the agent overview without submitting the draft", handler: async ctx => { void open?.("", ctx); } });
}
