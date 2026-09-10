import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { assertPackageIntegrity, digestPackage } from "./integrity.js";

const created: string[] = [];

afterEach(async () => {
	await Promise.all(created.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("package integrity", () => {
	test("detects a changed trusted source", async () => {
		const source = new URL(".", import.meta.url).pathname;
		const root = await mkdtemp("/Volumes/tom-ssd/tmp/pi-rbf-pi-23/integrity-test-");
		created.push(root);
		await cp(source, root, { recursive: true });
		const digest = digestPackage(root);
		expect(() => assertPackageIntegrity(root, digest)).not.toThrow();
		await writeFile(path.join(root, "state.ts"), "changed\n");
		expect(() => assertPackageIntegrity(root, digest)).toThrow("package changed");
	});
});
