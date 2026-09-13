import { describe, expect, it } from "vitest";
import { assertOutputInsideRoot, parseArgs, redactCanaries } from "./rbf-codex-native-context-probe.js";

describe("rbf-codex-native-context-probe", () => {
	it("accepts only the bounded direct-mode arguments", () => {
		expect(
			parseArgs([
				"--mode",
				"direct",
				"--root",
				"/private/tmp/pi-10",
				"--codex",
				"/usr/local/bin/codex",
				"--output",
				"/private/tmp/pi-10/receipt.json",
			]),
		).toEqual({
			mode: "direct",
			root: "/private/tmp/pi-10",
			codex: "/usr/local/bin/codex",
			output: "/private/tmp/pi-10/receipt.json",
		});
		expect(() => parseArgs(["--mode", "candidate"])).toThrow("only --mode direct");
		expect(() =>
			parseArgs([
				"--mode",
				"direct",
				"--root",
				"relative",
				"--codex",
				"/usr/local/bin/codex",
				"--output",
				"/private/tmp/pi-10/receipt.json",
			]),
		).toThrow("must be absolute");
	});

	it("rejects receipt paths outside or equal to the probe root", () => {
		expect(() => assertOutputInsideRoot("/private/tmp/pi-10", "/private/tmp/pi-10/receipt.json")).not.toThrow();
		expect(() => assertOutputInsideRoot("/private/tmp/pi-10", "/private/tmp/receipt.json")).toThrow("below the probe root");
		expect(() => assertOutputInsideRoot("/private/tmp/pi-10", "/private/tmp/pi-10")).toThrow("below the probe root");
	});

	it("redacts both canaries before hashing the prompt-input projection", () => {
		const redacted = redactCanaries("dev-secret then agents-secret", {
			developer_instructions: "dev-secret",
			nested_agents: "agents-secret",
		});
		expect(redacted).toBe("<developer-instructions-canary> then <nested-agents-canary>");
		expect(redacted).not.toContain("secret");
	});
});
