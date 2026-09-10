import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { realpathSync } from "node:fs";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createSandboxedBashOperations } from "./broker-client.js";
import { loadEffectivePolicy, type EffectivePolicy } from "./policy.js";
import { createSandboxedToolOperations } from "./tool-operations.js";
import { brokerRpc } from "./broker-rpc.js";
import { runLivePreflight } from "./preflight.js";

const packageRoot = new URL(".", import.meta.url).pathname;
const fdPath = realpathSync("/Users/tomhosiawa/homebrew/bin/fd");
const rgPath = realpathSync("/Users/tomhosiawa/homebrew/bin/rg");
const homebrewRoot = "/Users/tomhosiawa/homebrew";
let root: string;
let workspace: string;
let policy: EffectivePolicy;

beforeAll(async () => {
	root = await mkdtemp("/Volumes/tom-ssd/tmp/pi-rbf-pi-23/broker-test-");
	workspace = path.join(root, "workspace");
	const denied = path.join(root, "denied");
	const authorityRoot = path.join(root, "authority");
	await Promise.all([mkdir(workspace), mkdir(denied), mkdir(authorityRoot, { mode: 0o700 })]);
	await writeFile(path.join(workspace, "allowed.txt"), "allowed\n");
	await writeFile(path.join(denied, "secret.txt"), "secret\n");
	policy = await loadEffectivePolicy({
		workspace,
		authorityRoot,
		packageRoot,
		configPath: path.join(root, "missing.json"),
		toolPaths: [fdPath, rgPath, homebrewRoot],
	});
	const dependencies = await SandboxManager.checkDependenciesAsync();
	if (dependencies.errors.length > 0) throw new Error(dependencies.errors.join("; "));
	await SandboxManager.initialize(policy.srtConfig, undefined, false);
});

afterAll(async () => {
	await SandboxManager.reset();
	await rm(root, { recursive: true, force: true });
});

describe("sandbox broker", () => {
	test("passes fixed read, write, and network canaries", async () => {
		await expect(runLivePreflight({ brokerPath: path.join(packageRoot, "broker.mjs"), policy, workspace })).resolves.toBeUndefined();
	});

	test("waits for readiness then executes bash inside the policy", async () => {
		const operations = createSandboxedBashOperations({
			brokerPath: path.join(packageRoot, "broker.mjs"),
			policy,
			workspace,
		});
		let output = "";
		const result = await operations.exec("cat allowed.txt", workspace, {
			onData: (data) => { output += data.toString(); },
		});
		expect(result.exitCode).toBe(0);
		expect(output).toBe("allowed\n");
	});

	test("performs filesystem operations only through the broker", async () => {
		const operations = createSandboxedToolOperations({
			brokerPath: path.join(packageRoot, "broker.mjs"),
			fdPath,
			policy,
			workspace,
		});
		expect((await operations.read.readFile(path.join(workspace, "allowed.txt"))).toString()).toBe("allowed\n");
		await operations.write.writeFile(path.join(workspace, "written.txt"), "written\n");
		expect(await operations.ls.readdir(workspace)).toContain("written.txt");
		expect((await operations.ls.stat(workspace)).isDirectory()).toBe(true);
		expect(await operations.find.glob("written.txt", workspace, { ignore: [], limit: 100 })).toContain("./written.txt");
		const grep = await brokerRpc<string>({
			brokerPath: path.join(packageRoot, "broker.mjs"),
			policy,
			workspace,
			request: {
				operation: "grep",
				pattern: "written",
				path: path.join(workspace, "written.txt"),
				cwd: workspace,
				rgPath,
			},
		});
		expect(grep).toContain("written");
	});

	test("cancellation kills the sandbox process group", async () => {
		const operations = createSandboxedBashOperations({
			brokerPath: path.join(packageRoot, "broker.mjs"),
			policy,
			workspace,
		});
		const marker = path.join(workspace, "cancelled-marker.txt");
		const abort = new AbortController();
		const execution = operations.exec(`sleep 1; printf escaped > ${JSON.stringify(marker)}`, workspace, {
			onData: () => {},
			signal: abort.signal,
		});
		setTimeout(() => abort.abort(), 75);
		await expect(execution).rejects.toThrow("cancelled");
		await new Promise((resolve) => setTimeout(resolve, 1100));
		await expect(operations.exec(`test ! -e ${JSON.stringify(marker)}`, workspace, { onData: () => {} })).resolves.toEqual({ exitCode: 0 });
	});

	test("denies a file outside the policy", async () => {
		const operations = createSandboxedBashOperations({
			brokerPath: path.join(packageRoot, "broker.mjs"),
			policy,
			workspace,
		});
		let output = "";
		const secret = path.join(root, "denied", "secret.txt");
		const result = await operations.exec(`cat ${JSON.stringify(secret)}`, workspace, {
			onData: (data) => { output += data.toString(); },
		});
		expect(result.exitCode).not.toBe(0);
		expect(output).not.toContain("secret\n");
	});
});
