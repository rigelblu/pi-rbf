import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { brokerRpc } from "./broker-rpc.js";
import type { EffectivePolicy } from "./policy.js";

export async function runLivePreflight(options: {
	readonly brokerPath: string;
	readonly policy: EffectivePolicy;
	readonly workspace: string;
}): Promise<void> {
	const allowed = path.join(options.policy.authority.authorityRoot, "preflight-allowed.txt");
	const deniedRead = `/private/tmp/rbf-sandbox-denied-read-${process.pid}.txt`;
	const deniedWrite = `/private/tmp/rbf-sandbox-denied-write-${process.pid}.txt`;
	await writeFile(allowed, "allowed-canary\n", { mode: 0o600 });
	await writeFile(deniedRead, "denied-canary\n", { mode: 0o600 });
	await rm(deniedWrite, { force: true });
	const request = <T>(value: Readonly<Record<string, unknown>>) => brokerRpc<T>({ ...options, request: value });
	try {
		const allowedResult = await request<{ base64: string }>({ operation: "readFile", path: allowed });
		if (Buffer.from(allowedResult.base64, "base64").toString() !== "allowed-canary\n") {
			throw new Error("Sandbox allowed-read canary returned wrong content");
		}
		let readDenied = false;
		try {
			await request({ operation: "readFile", path: deniedRead });
		} catch {
			readDenied = true;
		}
		if (!readDenied) throw new Error("Sandbox denied-read canary unexpectedly succeeded");
		let writeDenied = false;
		try {
			await request({ operation: "writeFile", path: deniedWrite, content: "escape" });
		} catch {
			writeDenied = true;
		}
		if (!writeDenied) throw new Error("Sandbox denied-write canary unexpectedly succeeded");
		const network = await request<{ exitCode: number | null }>({
			operation: "bash",
			command: "/usr/bin/curl -fsS --max-time 2 https://example.com >/dev/null",
			cwd: options.workspace,
		});
		if (network.exitCode === 0) throw new Error("Sandbox network canary unexpectedly succeeded");
	} finally {
		await Promise.all([rm(allowed, { force: true }), rm(deniedRead, { force: true }), rm(deniedWrite, { force: true })]);
	}
}
