// Test wrapper extension for pi-10.7 effort and thinking level PTY suite.
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { createRbfCodex } from "../rbf-codex.ts";

const LOAD_KEY = Symbol.for("@earendil-works/pi-rbf:effort-probe-loads");
const READY_KEY = Symbol.for("@earendil-works/pi-rbf:effort-probe-ready");

export default function effortProbe(pi: ExtensionAPI): void {
	const g = globalThis as any;
	g[LOAD_KEY] = (g[LOAD_KEY] ?? 0) + 1;
	const currentLoad = g[LOAD_KEY];

	const reloadReceipt = process.env.RBF_EFFORT_RELOAD_RECEIPT;
	const updateReceipt = (ready?: number) => {
		if (!reloadReceipt) return;
		try {
			writeFileSync(
				reloadReceipt,
				JSON.stringify({ loads: currentLoad, readyLoad: ready ?? (g[READY_KEY] ?? 0) }),
			);
		} catch {
			// ignore write errors in test environment
		}
	};
	pi.on("session_start", async () => {
		updateReceipt();
	});

	pi.registerCommand("rbf-effort-reload-ready", {
		description: "Acknowledge effort reload readiness",
		handler: async (args) => {
			if (Number(args?.trim()) === currentLoad) {
				g[READY_KEY] = currentLoad;
				updateReceipt(currentLoad);
			}
		},
	});

	// Register a trivial non-Codex provider that supports reasoning with default thinking levels (off included)
	pi.registerProvider("dummy-provider", {
		api: "dummy-api",
		apiKey: "dummy-key",
		baseUrl: "http://localhost",
		models: [
			{
				id: "dummy-model",
				name: "Dummy Reasoning Model",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 4096,
			},
		],
		streamSimple(model: Model<any>, context: Context, options?: any) {
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "DUMMY_OK" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: Date.now(),
			};
			queueMicrotask(async () => {
				await options?.onPayload?.({ model: model.id, messages: context.messages }, model);
				await options?.onResponse?.({ status: 200, headers: {} }, model);
				stream.push({ type: "start", partial: message });
				stream.push({ type: "text_start", contentIndex: 0, partial: message });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "DUMMY_OK", partial: message });
				stream.push({ type: "text_end", contentIndex: 0, content: "DUMMY_OK", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			});
			return stream;
		},
	});

	const markerPath = process.env.RBF_EFFORT_PRE_FIX_MARKER;
	const forcePreFix = process.env.RBF_EFFORT_MUTATION_PRE_FIX === "1";
	const isPreFix = forcePreFix || (markerPath !== undefined && !existsSync(markerPath));

	function stripOff(models: any[] | undefined): any[] | undefined {
		if (!models) return models;
		return models.map((m) => {
			if (!m) return m;
			const map = m.thinkingLevelMap ? { ...m.thinkingLevelMap } : undefined;
			if (map) {
				delete map.off;
			}
			return { ...m, thinkingLevelMap: map };
		});
	}

	function registerProvider(nameOrProvider: any, config?: ProviderConfig): void {
		if (typeof nameOrProvider !== "string") {
			return pi.registerProvider(nameOrProvider);
		}
		if (!config) throw new Error("ProviderConfig missing");

		const targetConfig: ProviderConfig = { ...config };
		if (isPreFix) {
			targetConfig.models = stripOff(targetConfig.models) as any;
		}

		if (targetConfig.refreshModels) {
			const originalRefresh = targetConfig.refreshModels;
			targetConfig.refreshModels = async (context) => {
				const refreshed = await originalRefresh(context);
				const currentMarker = process.env.RBF_EFFORT_PRE_FIX_MARKER;
				const currentForce = process.env.RBF_EFFORT_MUTATION_PRE_FIX === "1";
				const currentIsPreFix = currentForce || (currentMarker !== undefined && !existsSync(currentMarker));
				if (currentIsPreFix) {
					return stripOff(refreshed) as any;
				}
				return refreshed;
			};
		}

		return pi.registerProvider(nameOrProvider, targetConfig);
	}

	const probe: ExtensionAPI = { ...pi, registerProvider };

	createRbfCodex({
		command: {
			bin: process.execPath,
			args: [resolve(import.meta.dirname, "rbf-codex-fake-app-server.ts")],
		},
	})(probe);
}
