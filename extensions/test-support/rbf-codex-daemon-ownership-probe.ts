import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CODEX_VERSION = "0.154.0";
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const TURN_TIMEOUT_MS = 45_000;

interface ProbeOptions {
	root: string;
	codex: string;
	output: string;
}

interface JsonRpcMessage {
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: unknown;
}

export interface DaemonOwnershipReceipt {
	schema: "rbf-codex-daemon-ownership-probe/v1";
	codexVersion: string;
	daemonBackend: string;
	daemonPidSha256: string;
	socketPathSha256: string;
	threadIdSha256: string;
	turnIdSha256: string;
	commandStartedBeforeDisconnect: boolean;
	firstProxyExited: boolean;
	rejoinedSameThread: boolean;
	rejoinedRunningTurn: boolean;
	terminalTurnStatus: string;
	sameTurnOccurrences: number;
	completionCanaryMatches: number;
	daemonStopReported: boolean;
	daemonPidAbsent: boolean;
	socketAbsent: boolean;
	finalDaemonProcesses: number;
	pass: boolean;
}

export function parseArgs(argv: readonly string[]): ProbeOptions {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag?.startsWith("--") || value === undefined || values.has(flag)) throw new Error("Invalid probe arguments");
		values.set(flag, value);
	}
	for (const flag of values.keys()) {
		if (!["--root", "--codex", "--output"].includes(flag)) throw new Error(`Unknown argument: ${flag}`);
	}
	const root = values.get("--root");
	const codex = values.get("--codex");
	const output = values.get("--output");
	if (!root || !codex || !output) throw new Error("Required arguments: --root PATH --codex PATH --output PATH");
	if (![root, codex, output].every(path.isAbsolute)) throw new Error("Probe paths must be absolute");
	return { root, codex, output };
}

export function assertOutputInsideRoot(root: string, output: string): void {
	const relative = path.relative(root, output);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error("Output must be below the probe root");
	}
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Codex returned an invalid object");
	return value as Record<string, unknown>;
}

function run(executable: string, args: string[], env: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
	return spawnSync(executable, args, { encoding: "utf8", env, maxBuffer: MAX_CAPTURE_BYTES });
}

function parseJsonOutput(result: ReturnType<typeof spawnSync>, label: string): Record<string, unknown> {
	if (result.error || result.status !== 0) {
		const detail = String(result.stderr || result.error?.message || "unknown error").trim().slice(0, 1_024);
		throw new Error(`${label} failed: ${detail}`);
	}
	try {
		return record(JSON.parse(String(result.stdout)));
	} catch {
		throw new Error(`${label} did not return JSON`);
	}
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = 5_000): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return true;
	return await new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.off("exit", exited);
			resolve(false);
		}, timeoutMs);
		const exited = () => {
			clearTimeout(timer);
			resolve(true);
		};
		child.once("exit", exited);
	});
}

async function processAbsent(pid: number): Promise<boolean> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
			throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return false;
}

class AppServerProxyClient {
	readonly child: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private capturedBytes = 0;
	private received = Buffer.alloc(0);
	private handshakeComplete = false;
	private expectedWebSocketAccept = "";
	private handshakeResolve?: () => void;
	private handshakeReject?: (error: Error) => void;
	private fragmentedText = "";
	private readonly notifications: JsonRpcMessage[] = [];
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private readonly waiters = new Set<() => void>();

	private constructor(child: ChildProcessWithoutNullStreams) {
		this.child = child;
		child.stdout.on("data", (chunk: Buffer) => this.receiveBytes(chunk));
		child.stderr.on("data", (chunk: Buffer | string) => {
			this.capturedBytes += Buffer.byteLength(chunk);
			if (this.capturedBytes > MAX_CAPTURE_BYTES) this.child.kill("SIGKILL");
		});
		child.on("exit", () => {
			this.handshakeReject?.(new Error("Codex proxy exited during WebSocket handshake"));
			for (const pending of this.pending.values()) pending.reject(new Error("Codex proxy exited before replying"));
			this.pending.clear();
			this.wake();
		});
	}

	static async connect(codex: string, socketPath: string, cwd: string, env: NodeJS.ProcessEnv): Promise<AppServerProxyClient> {
		const child = spawn(codex, ["app-server", "proxy", "--sock", socketPath], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
		const client = new AppServerProxyClient(child);
		await client.handshake();
		return client;
	}

	private async handshake(): Promise<void> {
		const key = randomBytes(16).toString("base64");
		this.expectedWebSocketAccept = createHash("sha1")
			.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
			.digest("base64");
		const result = new Promise<void>((resolve, reject) => {
			this.handshakeResolve = resolve;
			this.handshakeReject = reject;
		});
		this.child.stdin.write(
			[`GET / HTTP/1.1`, `Host: localhost`, `Upgrade: websocket`, `Connection: Upgrade`, `Sec-WebSocket-Key: ${key}`, `Sec-WebSocket-Version: 13`, "", ""].join("\r\n"),
		);
		const timer = setTimeout(() => this.handshakeReject?.(new Error("Timed out waiting for WebSocket upgrade")), REQUEST_TIMEOUT_MS);
		try {
			await result;
		} finally {
			clearTimeout(timer);
			this.handshakeResolve = undefined;
			this.handshakeReject = undefined;
		}
	}

	private receiveBytes(chunk: Buffer): void {
		this.capturedBytes += chunk.length;
		if (this.capturedBytes > MAX_CAPTURE_BYTES) {
			this.child.kill("SIGKILL");
			return;
		}
		this.received = Buffer.concat([this.received, chunk]);
		if (!this.handshakeComplete) {
			const headerEnd = this.received.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;
			const headers = this.received.subarray(0, headerEnd).toString("utf8");
			this.received = this.received.subarray(headerEnd + 4);
			const accept = /^sec-websocket-accept:\s*(\S+)\s*$/im.exec(headers)?.[1];
			if (!/^HTTP\/1\.1 101\b/m.test(headers) || accept !== this.expectedWebSocketAccept) {
				this.handshakeReject?.(new Error("Codex proxy rejected the WebSocket upgrade"));
				return;
			}
			this.handshakeComplete = true;
			this.handshakeResolve?.();
		}
		this.consumeFrames();
	}

	private consumeFrames(): void {
		while (this.received.length >= 2) {
			const first = this.received[0];
			const second = this.received[1];
			const fin = (first & 0x80) !== 0;
			const opcode = first & 0x0f;
			const masked = (second & 0x80) !== 0;
			let length = second & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (this.received.length < 4) return;
				length = this.received.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (this.received.length < 10) return;
				const wide = this.received.readBigUInt64BE(2);
				if (wide > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame is too large");
				length = Number(wide);
				offset = 10;
			}
			const maskLength = masked ? 4 : 0;
			if (this.received.length < offset + maskLength + length) return;
			const mask = masked ? this.received.subarray(offset, offset + 4) : undefined;
			offset += maskLength;
			const payload = Buffer.from(this.received.subarray(offset, offset + length));
			this.received = this.received.subarray(offset + length);
			if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
			if (opcode === 0x8) {
				this.child.stdin.end();
				return;
			}
			if (opcode === 0x9) {
				this.writeFrame(payload, 0x0a);
				continue;
			}
			if (opcode === 0x1) this.fragmentedText = payload.toString("utf8");
			else if (opcode === 0x0) this.fragmentedText += payload.toString("utf8");
			else continue;
			if (fin) {
				const text = this.fragmentedText;
				this.fragmentedText = "";
				this.receiveMessage(text);
			}
		}
	}

	private receiveMessage(text: string): void {
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(text) as JsonRpcMessage;
		} catch {
			this.child.kill("SIGKILL");
			return;
		}
		if (message.id !== undefined && message.method) {
			this.write({ id: message.id, error: { code: -32601, message: "Probe does not answer server requests" } });
			return;
		}
		if (typeof message.id === "number") {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.error) pending.reject(new Error("Codex app-server returned an RPC error"));
			else pending.resolve(message.result);
			return;
		}
		if (message.method) {
			this.notifications.push(message);
			this.wake();
		}
	}

	private write(message: JsonRpcMessage): void {
		this.writeFrame(Buffer.from(JSON.stringify(message)), 0x01);
	}

	private writeFrame(payload: Buffer, opcode: number): void {
		const mask = randomBytes(4);
		let header: Buffer;
		if (payload.length < 126) {
			header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
		} else if (payload.length <= 0xffff) {
			header = Buffer.alloc(4);
			header[0] = 0x80 | opcode;
			header[1] = 0x80 | 126;
			header.writeUInt16BE(payload.length, 2);
		} else {
			header = Buffer.alloc(10);
			header[0] = 0x80 | opcode;
			header[1] = 0x80 | 127;
			header.writeBigUInt64BE(BigInt(payload.length), 2);
		}
		const masked = Buffer.alloc(payload.length);
		for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index] ^ mask[index % 4];
		this.child.stdin.write(Buffer.concat([header, mask, masked]));
	}

	private wake(): void {
		for (const wake of this.waiters) wake();
		this.waiters.clear();
	}

	async request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
		const id = this.nextId++;
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for ${method}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.write({ id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		this.write({ method, params });
	}

	async initialize(name: string): Promise<void> {
		await this.request("initialize", { clientInfo: { name, version: "1.0.0" }, capabilities: { experimentalApi: true } });
		this.notify("initialized", {});
	}

	async waitFor(method: string, predicate: (message: JsonRpcMessage) => boolean, timeoutMs = TURN_TIMEOUT_MS): Promise<JsonRpcMessage> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const index = this.notifications.findIndex((message) => message.method === method && predicate(message));
			if (index !== -1) return this.notifications.splice(index, 1)[0];
			if (this.child.exitCode !== null || this.child.signalCode !== null) throw new Error(`Proxy exited while waiting for ${method}`);
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					this.waiters.delete(done);
					resolve();
				}, Math.min(250, Math.max(1, deadline - Date.now())));
				const done = () => {
					clearTimeout(timer);
					resolve();
				};
				this.waiters.add(done);
			});
		}
		throw new Error(`Timed out waiting for ${method}`);
	}

	async disconnect(signal: NodeJS.Signals): Promise<boolean> {
		this.child.kill(signal);
		return await waitForExit(this.child);
	}
}

async function atomicWriteNew(output: string, value: unknown): Promise<void> {
	try {
		await lstat(output);
		throw new Error("Output already exists");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const temporary = `${output}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
	const descriptor = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
	try {
		await descriptor.writeFile(`${JSON.stringify(value, null, 2)}\n`);
		await descriptor.sync();
	} finally {
		await descriptor.close();
	}
	await rename(temporary, output);
	const directory = await open(path.dirname(output), constants.O_RDONLY);
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

function turnsFrom(value: unknown): Record<string, unknown>[] {
	const thread = record(record(value).thread);
	if (!Array.isArray(thread.turns)) throw new Error("Codex thread omitted turns");
	return thread.turns.map(record);
}

export function assessReceipt(receipt: Omit<DaemonOwnershipReceipt, "pass">): boolean {
	return (
		receipt.codexVersion === CODEX_VERSION &&
		receipt.daemonBackend === "pid" &&
		receipt.commandStartedBeforeDisconnect &&
		receipt.firstProxyExited &&
		receipt.rejoinedSameThread &&
		receipt.rejoinedRunningTurn &&
		receipt.terminalTurnStatus === "completed" &&
		receipt.sameTurnOccurrences === 1 &&
		receipt.completionCanaryMatches === 1 &&
		receipt.daemonStopReported &&
		receipt.daemonPidAbsent &&
		receipt.socketAbsent &&
		receipt.finalDaemonProcesses === 0
	);
}

async function runProbe(options: ProbeOptions): Promise<DaemonOwnershipReceipt> {
	await mkdir(options.root, { recursive: true, mode: 0o700 });
	const root = await realpath(options.root);
	const output = path.resolve(options.output);
	assertOutputInsideRoot(root, output);
	const codexHome = path.join(root, "c");
	const workspace = path.join(root, "w");
	if (output === codexHome || output.startsWith(`${codexHome}${path.sep}`) || output === workspace || output.startsWith(`${workspace}${path.sep}`)) {
		throw new Error("Output must not be inside the probe's temporary Codex home or workspace");
	}
	await mkdir(path.join(codexHome, "packages", "standalone"), { recursive: true, mode: 0o700 });
	await mkdir(workspace, { recursive: true, mode: 0o700 });
	const codexRealpath = await realpath(options.codex);
	const standaloneRoot = path.dirname(path.dirname(codexRealpath));
	await symlink(standaloneRoot, path.join(codexHome, "packages", "standalone", "current"));
	const sourceCodexHome = process.env.CODEX_HOME ? await realpath(process.env.CODEX_HOME) : path.join(homedir(), ".codex");
	const sourceAuth = path.join(sourceCodexHome, "auth.json");
	if (!(await lstat(sourceAuth)).isFile()) throw new Error("Codex authentication source is not a regular file");
	await symlink(sourceAuth, path.join(codexHome, "auth.json"));
	await writeFile(
		path.join(codexHome, "config.toml"),
		[
			'model = "gpt-5.6-sol"',
			'model_reasoning_effort = "low"',
			'approval_policy = "never"',
			'sandbox_mode = "workspace-write"',
			"",
		].join("\n"),
		{ encoding: "utf8", mode: 0o600 },
	);
	const env = { ...process.env, CODEX_HOME: codexHome };
	const versionResult = run(options.codex, ["--version"], env);
	if (versionResult.error || versionResult.status !== 0) throw new Error("Codex version check failed");
	const versionMatch = /^codex-cli (\S+)\s*$/.exec(String(versionResult.stdout));
	if (!versionMatch) throw new Error("Unexpected Codex version output");
	let daemonPid = 0;
	let socketPath = "";
	let daemonBackend = "";
	let firstClient: AppServerProxyClient | undefined;
	let secondClient: AppServerProxyClient | undefined;
	let daemonStopReported = false;
	let daemonStartAttempted = false;
	let daemonPidAbsent = false;
	let socketAbsent = false;
	try {
		daemonStartAttempted = true;
		const started = parseJsonOutput(run(options.codex, ["app-server", "daemon", "start"], env), "Codex daemon start");
		if (started.status !== "started" || typeof started.pid !== "number" || typeof started.socketPath !== "string") {
			throw new Error("Codex daemon start returned an unexpected result");
		}
		daemonPid = started.pid;
		socketPath = started.socketPath;
		daemonBackend = String(started.backend ?? "");
		const completionCanary = `RBF_DAEMON_${randomBytes(18).toString("hex")}`;
		firstClient = await AppServerProxyClient.connect(options.codex, socketPath, workspace, env);
		await firstClient.initialize("rbf-codex-daemon-owner-a");
		const startedThread = record(
			await firstClient.request("thread/start", {
				cwd: workspace,
				ephemeral: false,
				approvalPolicy: "never",
				sandbox: "workspace-write",
			}),
		);
		const thread = record(startedThread.thread);
		if (typeof thread.id !== "string") throw new Error("Codex thread/start omitted its thread ID");
		const turnStarted = record(
			await firstClient.request("turn/start", {
				threadId: thread.id,
				input: [
					{
						type: "text",
						text: `Use the shell tool to run /bin/sleep 8. After it exits, reply exactly ${completionCanary}. Do nothing else.`,
						text_elements: [],
					},
				],
			}),
		);
		const turn = record(turnStarted.turn);
		if (typeof turn.id !== "string") throw new Error("Codex turn/start omitted its turn ID");
		await firstClient.waitFor("item/started", (message) => {
			const params = record(message.params);
			if (params.threadId !== thread.id || params.turnId !== turn.id) return false;
			const item = record(params.item);
			return item.type === "commandExecution" && typeof item.command === "string" && item.command.includes("/bin/sleep 8");
		});
		const firstProxyExited = await firstClient.disconnect("SIGKILL");
		firstClient = undefined;
		secondClient = await AppServerProxyClient.connect(options.codex, socketPath, workspace, env);
		await secondClient.initialize("rbf-codex-daemon-owner-b");
		const resumed = record(
			await secondClient.request("thread/resume", {
				threadId: thread.id,
				excludeTurns: false,
			}),
		);
		const resumedThread = record(resumed.thread);
		const resumedTurns = Array.isArray(resumedThread.turns) ? resumedThread.turns.map(record) : [];
		const resumedTurn = resumedTurns.find((candidate) => candidate.id === turn.id);
		const rejoinedSameThread = resumedThread.id === thread.id;
		const rejoinedRunningTurn = resumedTurn?.status === "inProgress";
		let latestTurns = resumedTurns;
		const deadline = Date.now() + TURN_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const current = latestTurns.find((candidate) => candidate.id === turn.id);
			if (current && current.status !== "inProgress") break;
			await new Promise((resolve) => setTimeout(resolve, 250));
			latestTurns = turnsFrom(await secondClient.request("thread/read", { threadId: thread.id, includeTurns: true }));
		}
		const sameTurns = latestTurns.filter((candidate) => candidate.id === turn.id);
		const terminal = sameTurns[0];
		if (!terminal || terminal.status === "inProgress") throw new Error("Codex turn did not reach a terminal state after rejoin");
		const items = Array.isArray(terminal.items) ? terminal.items.map(record) : [];
		const response = items
			.filter((item) => item.type === "agentMessage" && typeof item.text === "string")
			.map((item) => String(item.text))
			.join("\n");
		const base: Omit<DaemonOwnershipReceipt, "pass"> = {
			schema: "rbf-codex-daemon-ownership-probe/v1",
			codexVersion: versionMatch[1],
			daemonBackend,
			daemonPidSha256: sha256(String(daemonPid)),
			socketPathSha256: sha256(socketPath),
			threadIdSha256: sha256(thread.id),
			turnIdSha256: sha256(turn.id),
			commandStartedBeforeDisconnect: true,
			firstProxyExited,
			rejoinedSameThread,
			rejoinedRunningTurn,
			terminalTurnStatus: String(terminal.status),
			sameTurnOccurrences: sameTurns.length,
			completionCanaryMatches: response.split(completionCanary).length - 1,
			daemonStopReported: false,
			daemonPidAbsent: false,
			socketAbsent: false,
			finalDaemonProcesses: 1,
		};
		await secondClient.disconnect("SIGTERM");
		secondClient = undefined;
		const stopped = parseJsonOutput(run(options.codex, ["app-server", "daemon", "stop"], env), "Codex daemon stop");
		daemonStopReported = stopped.status === "stopped";
		daemonPidAbsent = await processAbsent(daemonPid);
		for (let attempt = 0; attempt < 20; attempt += 1) {
			try {
				await lstat(socketPath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					socketAbsent = true;
					break;
				}
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const finished = {
			...base,
			daemonStopReported,
			daemonPidAbsent,
			socketAbsent,
			finalDaemonProcesses: daemonPidAbsent && socketAbsent ? 0 : 1,
		};
		return { ...finished, pass: assessReceipt(finished) };
	} finally {
		if (firstClient) await firstClient.disconnect("SIGKILL");
		if (secondClient) await secondClient.disconnect("SIGTERM");
		if (daemonStartAttempted && !daemonStopReported) {
			run(options.codex, ["app-server", "daemon", "stop"], env);
			if (daemonPid) await processAbsent(daemonPid);
		}
		await rm(codexHome, { recursive: true, force: true });
		await rm(workspace, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const receipt = await runProbe(options);
	await atomicWriteNew(options.output, receipt);
	process.stdout.write(
		`daemon_rejoin=${receipt.rejoinedRunningTurn ? "true" : "false"} turn_status=${receipt.terminalTurnStatus} duplicate_turns=${Math.max(0, receipt.sameTurnOccurrences - 1)} final_daemon_processes=${receipt.finalDaemonProcesses}\n`,
	);
	if (!receipt.pass) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : "Daemon ownership probe failed"}\n`);
		process.exitCode = 1;
	});
}
