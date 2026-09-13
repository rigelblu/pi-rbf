import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { probeStaleSocketRecoveryRace } from "./rbf-codex-stale-socket-race-probe.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("rbf-codex stale socket recovery", () => {
	it("forces the two-contender stale-observation interleaving", async () => {
		const root = mkdtempSync("/private/tmp/rbf-codex-stale-race-");
		roots.push(root);

		const result = await probeStaleSocketRecoveryRace(root);

		expect(result).toEqual({
			contenderAObserved: "ECONNREFUSED",
			contenderBObserved: "ECONNREFUSED",
			contenderAFreshListenerMoved: true,
			originalPathOwner: "contender-b",
			renamedPathOwner: "contender-a",
			splitBrainOwners: 2,
		});
	});
});
