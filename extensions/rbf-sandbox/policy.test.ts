import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadEffectivePolicy } from "./policy.js";

const created: string[] = [];

async function fixture() {
	const root = await mkdtemp("/Volumes/tom-ssd/tmp/pi-rbf-pi-23/policy-test-");
	created.push(root);
	const workspace = path.join(root, "workspace");
	const authorityRoot = path.join(root, "authority");
	await mkdir(workspace);
	await mkdir(authorityRoot, { mode: 0o700 });
	return { root, workspace, authorityRoot, configPath: path.join(root, "sandbox.json") };
}

afterEach(async () => {
	await Promise.all(created.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("loadEffectivePolicy", () => {
	test("defaults to workspace-only authority", async () => {
		const value = await fixture();
		const policy = await loadEffectivePolicy(value);
		expect(policy.authority.readRoots).toEqual([value.workspace]);
		expect(policy.authority.writeRoots).toEqual([value.workspace]);
		expect(policy.environment).not.toHaveProperty("PI_SESSION_ID");
		expect(policy.srtConfig.filesystem.denyRead).toEqual(["/"]);
	});

	test("admits canonical owner-configured roots and environment", async () => {
		const value = await fixture();
		const granted = path.join(value.root, "granted");
		await mkdir(granted);
		await writeFile(value.configPath, JSON.stringify({
			version: 1,
			workspaces: { [value.workspace]: { read: [granted], write: [granted], environment: ["RB_TEST_VALUE"] } },
		}));
		await chmod(value.configPath, 0o600);
		process.env.RB_TEST_VALUE = "allowed";
		const policy = await loadEffectivePolicy(value);
		expect(policy.authority.readRoots).toContain(granted);
		expect(policy.environment.RB_TEST_VALUE).toBe("allowed");
		delete process.env.RB_TEST_VALUE;
	});

	test("rejects group-readable authority config", async () => {
		const value = await fixture();
		await writeFile(value.configPath, JSON.stringify({ version: 1, workspaces: {} }));
		await chmod(value.configPath, 0o640);
		await expect(loadEffectivePolicy(value)).rejects.toThrow("owner-only");
	});

	test("rejects reserved environment grants", async () => {
		const value = await fixture();
		await writeFile(value.configPath, JSON.stringify({
			version: 1,
			workspaces: { [value.workspace]: { environment: ["OPENAI_API_KEY"] } },
		}));
		await chmod(value.configPath, 0o600);
		await expect(loadEffectivePolicy(value)).rejects.toThrow("reserved");
	});

	test("changes digest when a trusted grant changes", async () => {
		const value = await fixture();
		const first = await loadEffectivePolicy(value);
		const granted = path.join(value.root, "granted");
		await mkdir(granted);
		await writeFile(value.configPath, JSON.stringify({
			version: 1,
			workspaces: { [value.workspace]: { read: [granted] } },
		}));
		await chmod(value.configPath, 0o600);
		const second = await loadEffectivePolicy(value);
		expect(second.authorityDigest).not.toBe(first.authorityDigest);
	});
});
