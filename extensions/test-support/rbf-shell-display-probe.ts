// Test-only companion for the shell-count PTY cases. It writes every message on the owners' display channel
// to RBF_SHELL_DISPLAY_LOG, one JSON object per line, so a case can assert on what an owner said and when.
// With RBF_SHELL_DISPLAY_THROW set it then throws, the way a broken subscriber would.
// `/rbf-groups-fault render|mouse` breaks the live view's own bookkeeping so its fail-open path runs in a real Pi.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CHANNEL = "rbf:shell-display:v1";
const VIEW_KEY = Symbol.for("rbf.shellCommandGroups.view");

export default function rbfShellDisplayProbe(pi: ExtensionAPI): void {
	const log = process.env.RBF_SHELL_DISPLAY_LOG;
	if (log && typeof pi.events?.on === "function") {
		pi.events.on(CHANNEL, (data) => {
			appendFileSync(log, `${JSON.stringify(data, (_key, value) => (typeof value === "function" ? "[function]" : value))}\n`);
			if (process.env.RBF_SHELL_DISPLAY_THROW) throw new Error("probe subscriber failure");
		});
	}
	pi.registerCommand("rbf-groups-fault", {
		description: "Test only: break the shell-count view's own bookkeeping",
		handler: async (args) => {
			const view = (globalThis as any)[VIEW_KEY];
			const state = view?.state;
			const fault = () => {
				throw new Error("injected grouping fault");
			};
			// The view reads a group's members while drawing, and the regroup count only when a header takes a press.
			if (args.trim() === "mouse") Object.defineProperty(state, "reconciliations", { configurable: true, get: fault });
			else if (state?.groups?.[0]) Object.defineProperty(state.groups[0], "memberIds", { configurable: true, get: fault });
		},
	});
}
