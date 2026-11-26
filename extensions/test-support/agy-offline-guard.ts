// Test-only boundary. Never installed by the production AGY provider.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
const ALLOWED = new Set(["agy-harness", "pi21-fake-neighbor"]);
export function reserveAgyOfflineRoot(root: string): void {
	// Atomic exclusive mkdir rejects every existing directory/file/symlink.
	mkdirSync(root, { mode: 0o700 });
}
export function installAgyOfflineGuard(pi: ExtensionAPI, record: (event: string, data: Record<string, unknown>) => void): void {
	pi.on("model_select", async (event) => {
		try {
			record("test_model_select", { modelProvider: event.model.provider, modelId: event.model.id, choice: `${event.model.provider}/${event.model.id}` });
		}
		catch { }
	});
	pi.on("input", async (_event, ctx) => {
		// Pi continues input when an extension hook throws. No fault may escape here.
		try {
			const modelProvider = ctx.model?.provider, modelId = ctx.model?.id;
			if (!modelProvider || !ALLOWED.has(modelProvider)) {
				try {
					record("offline_provider_refused", { modelProvider: modelProvider ?? "missing", modelId: modelId ?? "missing" });
				}
				catch { }
				try {
					ctx.ui.notify("Offline test blocked a non-fake provider. No message was sent.", "error");
				}
				catch { }
				return { action: "handled" };
			}
			try {
				record("offline_input_admitted", { modelProvider, modelId: modelId ?? "missing" });
			}
			catch {
				return { action: "handled" };
			}
			return { action: "continue" };
		}
		catch {
			return { action: "handled" };
		}
	});
}
