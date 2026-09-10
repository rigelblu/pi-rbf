import { describe, expect, test } from "vitest";
import { deriveLaunchAuthority } from "./launch-authority.js";

const piCli = new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url).pathname;

describe("deriveLaunchAuthority", () => {
	test.each([
		["bare", ["--sandbox"]],
		["equals false still follows Pi boolean semantics", ["--sandbox=false"]],
		["separate false still follows Pi boolean semantics", ["--sandbox", "false"]],
	])("detects sandbox before extension factories: %s", (_name, args) => {
		expect(deriveLaunchAuthority([process.execPath, piCli, ...args]).sandboxRequested).toBe(true);
	});

	test("does not treat a positional argument after -- as a flag", () => {
		expect(deriveLaunchAuthority([process.execPath, piCli, "--", "--sandbox"]).sandboxRequested).toBe(false);
	});

	test("rejects a non-Pi programmatic entry", () => {
		expect(() => deriveLaunchAuthority(process.argv)).toThrow("canonical Pi CLI");
	});

	test("binds the latch to the original argument vector", () => {
		const first = deriveLaunchAuthority([process.execPath, piCli, "--sandbox"]);
		const second = deriveLaunchAuthority([process.execPath, piCli, "--sandbox", "extra"]);
		expect(first.argvDigest).not.toBe(second.argvDigest);
	});
});
