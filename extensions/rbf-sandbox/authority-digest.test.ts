import { describe, expect, test } from "vitest";
import { digestAuthority, type AuthorityDigestV1 } from "./authority-digest.js";

function fixture(): AuthorityDigestV1 {
	return {
		version: 1,
		workspace: "/workspace",
		readRoots: ["/usr", "/workspace"],
		writeRoots: ["/workspace"],
		environmentNamesAndLaunchValues: { PATH: "/usr/bin:/bin" },
		runtimeRoots: ["/usr", "/System"],
		protectedPaths: ["/workspace/.pi"],
		admittedToolSourcesAndDigests: { read: "abc" },
		versions: { pi: "0.85.1", srt: "0.0.75" },
		srtConfig: { network: { allowedDomains: [] } },
		authorityRoot: "/private/tmp/rbf-sandbox/process-1",
	};
}

describe("digestAuthority", () => {
	test("is stable across object-key and set ordering", () => {
		const first = fixture();
		const reordered: AuthorityDigestV1 = {
			...first,
			readRoots: [...first.readRoots].reverse(),
			versions: { srt: "0.0.75", pi: "0.85.1" },
		};
		expect(digestAuthority(reordered)).toBe(digestAuthority(first));
	});

	test.each([
		["workspace", (value: AuthorityDigestV1) => ({ ...value, workspace: "/other" })],
		["write root", (value: AuthorityDigestV1) => ({ ...value, writeRoots: ["/workspace", "/other"] })],
		["environment", (value: AuthorityDigestV1) => ({ ...value, environmentNamesAndLaunchValues: { PATH: "/evil" } })],
		["tool digest", (value: AuthorityDigestV1) => ({ ...value, admittedToolSourcesAndDigests: { read: "changed" } })],
		["SRT config", (value: AuthorityDigestV1) => ({ ...value, srtConfig: { network: { allowedDomains: ["example.com"] } } })],
	])("changes when authority changes: %s", (_name, mutate) => {
		const original = fixture();
		expect(digestAuthority(mutate(original))).not.toBe(digestAuthority(original));
	});
});
