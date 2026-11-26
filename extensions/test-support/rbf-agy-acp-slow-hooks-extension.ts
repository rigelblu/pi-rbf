// Actual Pi host probe for the two races of a wake turn (#pi-21.3): AGY wakes while Pi is busy for a reason that is not a run. Fake AGY only; never used by preview/install.
// It is the ACP host extension plus two slow hooks. Each hook lets the fake AGY wake (mode `wake-hold`: it speaks once `wake-go` exists), waits until the fake logged that it began, and then keeps Pi busy for
// at least 1.5 s in all, so the wake begins inside the hook:
//   - an `input` handler for a prompt starting `[slow]`: Pi has not started the prompt's run yet, but `isIdle()` is already true (the typed-prompt race)
//   - a `session_before_compact` handler, loaded before the provider's own so it runs first: Pi is compacting, so `isIdle()` is false and no run ends afterwards (the stranded-wake race)
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import host from "./rbf-agy-acp-host-extension.js";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const MIN_MS = 1500;

export default function probe(pi: ExtensionAPI) {
	const root = process.env.PI213_OFFLINE_ROOT ?? "";
	if (!root) throw new Error("PI213_OFFLINE_ROOT required");
	const record = (event: string, data: any = {}) => appendFileSync(join(root, "host.jsonl"), JSON.stringify({ event, ...data }) + "\n");
	const wakeBegan = () => existsSync(join(root, "acp.jsonl")) && readFileSync(join(root, "acp.jsonl"), "utf8").includes('"wakeBegan"');
	async function holdThroughWake(label: string) {
		const start = Date.now();
		writeFileSync(join(root, "wake-go"), "");
		record(label + "_start");
		while (!wakeBegan() && Date.now() - start < 20000) await sleep(20);
		await sleep(400); // the owner has seen the first frame and told the provider
		await sleep(Math.max(0, MIN_MS - (Date.now() - start)));
		record(label + "_end", { wakeBegan: wakeBegan(), ms: Date.now() - start });
	}
	pi.on("session_before_compact", async () => { await holdThroughWake("slow_compact"); return undefined; });
	host(pi);
	pi.on("input", async event => { if (event.text.startsWith("[slow]")) await holdThroughWake("slow_input"); return undefined; });
}
