import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import net, { type Server } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function listen(socketPath: string, label: string): Promise<Server> {
	const server = net.createServer((connection) => connection.end(label));
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	return server;
}

async function close(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function connect(socketPath: string): Promise<string> {
	return await new Promise((resolve, reject) => {
		const client = net.createConnection(socketPath);
		let output = "";
		client.setEncoding("utf8");
		client.on("data", (chunk) => (output += chunk));
		client.once("error", reject);
		client.once("end", () => resolve(output));
	});
}

async function connectionError(socketPath: string): Promise<string> {
	return await new Promise((resolve) => {
		const client = net.createConnection(socketPath);
		client.once("connect", () => {
			client.destroy();
			resolve("CONNECTED");
		});
		client.once("error", (error) => resolve((error as NodeJS.ErrnoException).code ?? "UNKNOWN"));
	});
}

async function createStaleSocket(socketPath: string): Promise<void> {
	const ready = `${socketPath}.ready`;
	const child = spawn(process.execPath, ["run", fileURLToPath(import.meta.url), "--stale-owner", socketPath, ready], {
		stdio: "ignore",
	});
	try {
		await waitFor(() => existsSync(ready), "stale owner readiness");
		child.kill("SIGKILL");
		await waitForExit(child);
		await waitFor(() => existsSync(socketPath), "stale socket pathname");
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		rmSync(ready, { force: true });
	}
}

export interface StaleSocketRaceResult {
	readonly contenderAObserved: "ECONNREFUSED";
	readonly contenderBObserved: "ECONNREFUSED";
	readonly contenderAFreshListenerMoved: boolean;
	readonly originalPathOwner: "contender-b";
	readonly renamedPathOwner: "contender-a";
	readonly splitBrainOwners: 2;
}

export async function probeStaleSocketRecoveryRace(root: string): Promise<StaleSocketRaceResult> {
	if (!path.isAbsolute(root) || realpathSync.native(root) !== root) throw new Error("Race root must be an exact native realpath");
	const socketPath = path.join(root, "owner.sock");
	const staleA = path.join(root, ".stale-a.sock");
	const staleB = path.join(root, ".stale-b.sock");
	await createStaleSocket(socketPath);

	// Both contenders make the design's only stale observation before either mutates the pathname.
	const [contenderAObserved, contenderBObserved] = await Promise.all([
		connectionError(socketPath),
		connectionError(socketPath),
	]);
	if (contenderAObserved !== "ECONNREFUSED" || contenderBObserved !== "ECONNREFUSED") {
		throw new Error("The fixture did not establish two stale observations");
	}

	// A performs the designed rename-and-bind recovery while B is paused after its stale observation.
	renameSync(socketPath, staleA);
	const contenderA = await listen(socketPath, "contender-a");
	let contenderB: Server | undefined;
	try {
		// B now acts on its earlier ECONNREFUSED. The unqualified rename moves A's new live socket.
		renameSync(socketPath, staleB);
		contenderB = await listen(socketPath, "contender-b");
		const [originalPathOwner, renamedPathOwner] = await Promise.all([connect(socketPath), connect(staleB)]);
		return {
			contenderAObserved,
			contenderBObserved,
			contenderAFreshListenerMoved: existsSync(staleB),
			originalPathOwner: originalPathOwner as "contender-b",
			renamedPathOwner: renamedPathOwner as "contender-a",
			splitBrainOwners: 2,
		};
	} finally {
		if (contenderB) await close(contenderB);
		await close(contenderA);
		for (const target of [socketPath, staleA, staleB]) rmSync(target, { force: true });
	}
}

if (process.argv[2] === "--stale-owner") {
	const socketPath = process.argv[3];
	const ready = process.argv[4];
	if (!socketPath || !ready) throw new Error("Missing stale-owner paths");
	const server = await listen(socketPath, "stale");
	writeFileSync(ready, "ready\n");
	await new Promise(() => undefined);
	server.close();
}
