import { writeFileSync } from "node:fs";
import { FooterComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROBE_KEY = Symbol.for("@earendil-works/pi-rbf:reload-probe");

interface ProbeState {
	loads: number;
	previousRender?: any;
	identityChanges: number;
	readyLoad?: number;
	nativeAfterLoadInstalled?: boolean;
}

export default function rbfReloadProbe(pi: ExtensionAPI): void {
	const g = globalThis as any;
	if (!g[PROBE_KEY]) {
		g[PROBE_KEY] = {
			loads: 0,
			previousRender: undefined,
			identityChanges: 0,
		} as ProbeState;
	}

	const state: ProbeState = g[PROBE_KEY];
	state.loads += 1;

	// Test-only mutant: leave one stable render identity in place while making
	// the first footer row native after reload. The PTY assertion must catch it.
	const nativeAfterLoad = Number(process.env.PI_RELOAD_PROBE_NATIVE_AFTER_LOAD ?? 0);
	if (nativeAfterLoad > 0 && !state.nativeAfterLoadInstalled) {
		const previous = FooterComponent.prototype.render;
		FooterComponent.prototype.render = function (...args: Parameters<typeof previous>) {
			const lines = previous.apply(this, args);
			if (state.loads >= nativeAfterLoad) lines[0] = "NATIVE_AFTER_RELOAD";
			return lines;
		};
		state.nativeAfterLoadInstalled = true;
	}

	const currentRender = FooterComponent?.prototype?.render;
	if (state.previousRender !== undefined && currentRender !== state.previousRender) {
		state.identityChanges += 1;
	}
	state.previousRender = currentRender;

	const receiptPath = process.env.PI_RELOAD_PROBE_RECEIPT;
	const loaded = state.loads;
	const writeReceipt = () => {
		if (!receiptPath) return;
		try {
			writeFileSync(
				receiptPath,
				JSON.stringify({ loads: state.loads, identityChanges: state.identityChanges, readyLoad: state.readyLoad ?? 0 }, null, 2),
			);
		} catch {
			// ignore write errors in test environment
		}
	};
	writeReceipt();
	pi.registerCommand("rbf-reload-ready", {
		description: "Confirm the test-only reload probe is accepting commands",
		handler: async (args) => {
			if (Number(args.trim()) !== loaded || state.loads !== loaded) return;
			state.readyLoad = loaded;
			writeReceipt();
		},
	});
}
