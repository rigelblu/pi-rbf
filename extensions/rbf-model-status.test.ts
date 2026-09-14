import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import rbfModelStatus, {
	PATCHED_SYMBOL,
	decorateStatus,
	patchShowStatus,
	unpatchShowStatus,
} from "./rbf-model-status.ts";

describe("decorateStatus", () => {
	it("prefixes the provider on a model pick when more than one provider is configured", () => {
		expect(decorateStatus("Model: gpt-5.6-luna", "codex-harness", 2)).toBe("Model: (codex-harness) gpt-5.6-luna");
	});

	it("prefixes the provider on a model cycle and leaves the rest of Pi's copy untouched", () => {
		expect(decorateStatus("Switched to gpt-5.6-luna (Codex agent) (thinking: high)", "codex-harness", 3)).toBe(
			"Switched to (codex-harness) gpt-5.6-luna (Codex agent) (thinking: high)",
		);
	});

	it("leaves both lines bare with a single provider, as the footer does", () => {
		expect(decorateStatus("Model: gpt-5.6-luna", "openai-codex", 1)).toBe("Model: gpt-5.6-luna");
		expect(decorateStatus("Switched to gpt-5.6-luna", "openai-codex", 1)).toBe("Switched to gpt-5.6-luna");
		expect(decorateStatus("Model: gpt-5.6-luna", "openai-codex", 0)).toBe("Model: gpt-5.6-luna");
	});

	it("leaves every other status line untouched", () => {
		for (const line of [
			"Default model: openai-codex/gpt-5.6-luna",
			"Forked to new session",
			"Only one model available",
			"Thinking level: high",
			"",
		]) {
			expect(decorateStatus(line, "openai-codex", 2)).toBe(line);
		}
	});

	it("leaves a line without a provider untouched", () => {
		expect(decorateStatus("Model: gpt-5.6-luna", undefined, 2)).toBe("Model: gpt-5.6-luna");
	});

	it("passes a non-string message through untouched instead of throwing", () => {
		for (const value of [undefined, null, 42, {}]) {
			expect(decorateStatus(value as unknown as string, "codex-harness", 2)).toBe(value);
		}
	});

	it("does not double the prefix on an already decorated line", () => {
		expect(decorateStatus("Model: (codex-harness) gpt-5.6-luna", "codex-harness", 2)).toBe(
			"Model: (codex-harness) gpt-5.6-luna",
		);
	});
});

function makeHost(provider: string | undefined, count: number) {
	class FakeMode {
		session = { model: provider ? { provider } : undefined };
		footerDataProvider = { getAvailableProviderCount: () => count };
		shown: string[] = [];
		showStatus(message: string): void {
			this.shown.push(message);
		}
	}
	return FakeMode;
}

describe("patchShowStatus", () => {
	it("rewrites through the prototype and calls the original with the decorated message", () => {
		const FakeMode = makeHost("codex-harness", 2);
		expect(patchShowStatus(FakeMode.prototype)).toBe(true);
		const mode = new FakeMode();
		mode.showStatus("Model: gpt-5.6-luna");
		mode.showStatus("Switched to gpt-5.6-luna (thinking: high)");
		mode.showStatus("Forked to new session");
		expect(mode.shown).toEqual([
			"Model: (codex-harness) gpt-5.6-luna",
			"Switched to (codex-harness) gpt-5.6-luna (thinking: high)",
			"Forked to new session",
		]);
	});

	it("stays bare when one provider is configured", () => {
		const FakeMode = makeHost("openai-codex", 1);
		patchShowStatus(FakeMode.prototype);
		const mode = new FakeMode();
		mode.showStatus("Model: gpt-5.6-luna");
		expect(mode.shown).toEqual(["Model: gpt-5.6-luna"]);
	});

	it("passes a non-string notification through the wrapper", () => {
		const FakeMode = makeHost("codex-harness", 2);
		patchShowStatus(FakeMode.prototype);
		const mode = new FakeMode();
		(mode as any).showStatus(42);
		(mode as any).showStatus(undefined);
		expect(mode.shown).toEqual([42, undefined]);
	});

	it("survives a host with no footer data or model", () => {
		class Bare {
			shown: string[] = [];
			showStatus(message: string): void {
				this.shown.push(message);
			}
		}
		patchShowStatus(Bare.prototype);
		const mode = new Bare();
		mode.showStatus("Model: gpt-5.6-luna");
		expect(mode.shown).toEqual(["Model: gpt-5.6-luna"]);
	});

	it("is idempotent across reloads and unpatches cleanly", () => {
		const FakeMode = makeHost("codex-harness", 2);
		const original = FakeMode.prototype.showStatus;
		expect(patchShowStatus(FakeMode.prototype)).toBe(true);
		const wrapped = FakeMode.prototype.showStatus;
		expect(patchShowStatus(FakeMode.prototype)).toBe(false);
		expect(FakeMode.prototype.showStatus).toBe(wrapped);
		unpatchShowStatus(FakeMode.prototype);
		expect(FakeMode.prototype.showStatus).toBe(original);
		expect((FakeMode.prototype as any)[PATCHED_SYMBOL]).toBeUndefined();
	});

	it("refuses a prototype without showStatus", () => {
		expect(patchShowStatus({})).toBe(false);
		expect(patchShowStatus(null)).toBe(false);
		expect(patchShowStatus(undefined)).toBe(false);
	});
});

describe("rbfModelStatus", () => {
	it("patches Pi's real InteractiveMode prototype on load", () => {
		const proto = InteractiveMode.prototype as any;
		unpatchShowStatus(proto);
		const real = proto.showStatus;
		expect(typeof real).toBe("function");
		const spy = vi.fn();
		proto.showStatus = spy;
		try {
			rbfModelStatus({} as any);
			expect(proto[PATCHED_SYMBOL]).toBe(true);
			expect(proto.showStatus).not.toBe(spy);
			const host = {
				session: { model: { provider: "codex-harness" } },
				footerDataProvider: { getAvailableProviderCount: () => 2 },
			};
			proto.showStatus.call(host, "Model: gpt-5.6-luna");
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.instances[0]).toBe(host);
			expect(spy).toHaveBeenCalledWith("Model: (codex-harness) gpt-5.6-luna");
		} finally {
			unpatchShowStatus(proto);
			const restored = proto.showStatus;
			proto.showStatus = real;
			expect(restored).toBe(spy);
		}
	});
});
