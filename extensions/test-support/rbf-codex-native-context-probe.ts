import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	lstat,
	mkdir,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 180_000;

type NativeSourceKind = "developer_instructions" | "nested_agents";

interface DirectOptions {
	mode: "direct";
	root: string;
	codex: string;
	output: string;
}

interface NativeSourceReceipt {
	kind: NativeSourceKind;
	sourceSha256: string;
	canarySha256: string;
	promptInputMatches: number;
	responseMatches: number;
}

export interface NativeContextReceipt {
	schema: "rbf-codex-native-context-probe/v1";
	mode: "direct";
	codexVersion: string;
	nativeSources: NativeSourceReceipt[];
	promptInputProjectionSha256: string;
	responseSha256: string;
	probePermitSha256: null;
	finalOwnedProcesses: 0;
}

interface JsonRpcMessage {
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: unknown;
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function countOccurrences(value: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let offset = 0;
	while ((offset = value.indexOf(needle, offset)) !== -1) {
		count += 1;
		offset += needle.length;
	}
	return count;
}

function quoteToml(value: string): string {
	return JSON.stringify(value);
}

function boundedUtf8(value: string, label: string): string {
	if (Buffer.byteLength(value) > MAX_CAPTURE_BYTES) throw new Error(`${label} exceeded the bounded capture limit`);
	return value;
}

export function redactCanaries(value: string, canaries: Readonly<Record<NativeSourceKind, string>>): string {
	return value
		.replaceAll(canaries.developer_instructions, "<developer-instructions-canary>")
		.replaceAll(canaries.nested_agents, "<nested-agents-canary>");
}

export function parseArgs(argv: readonly string[]): DirectOptions {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag?.startsWith("--") || value === undefined) throw new Error("Arguments must be --name value pairs");
		if (values.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
		values.set(flag, value);
	}
	const mode = values.get("--mode");
	if (mode !== "direct") throw new Error("Task zero supports only --mode direct");
	for (const flag of values.keys()) {
		if (!["--mode", "--root", "--codex", "--output"].includes(flag)) throw new Error(`Unknown argument: ${flag}`);
	}
	const root = values.get("--root");
	const codex = values.get("--codex");
	const output = values.get("--output");
	if (!root || !codex || !output) throw new Error("Required arguments: --mode direct --root PATH --codex PATH --output PATH");
	if (!path.isAbsolute(root) || !path.isAbsolute(codex) || !path.isAbsolute(output)) {
		throw new Error("Root, Codex, and output paths must be absolute");
	}
	return { mode, root, codex, output };
}

export function assertOutputInsideRoot(root: string, output: string): void {
	const relative = path.relative(root, output);
	if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
		throw new Error("Output must be a file below the probe root");
	}
}

function runBounded(executable: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
	const result = spawnSync(executable, args, {
		cwd: options.cwd,
		env: options.env,
		encoding: "utf8",
		maxBuffer: MAX_CAPTURE_BYTES,
	});
	if (result.error) throw new Error(`Could not run ${path.basename(executable)}`);
	if (result.status !== 0) throw new Error(`${path.basename(executable)} exited unsuccessfully`);
	return boundedUtf8(result.stdout, `${path.basename(executable)} stdout`);
}

function codexVersion(codex: string): string {
	const stdout = runBounded(codex, ["--version"]).trim();
	const match = /^codex-cli (\S+)$/.exec(stdout);
	if (!match) throw new Error("Codex returned an unexpected version string");
	return match[1];
}

function processIds(): number[] {
	const stdout = runBounded("/bin/ps", ["-axo", "pid="]);
	return stdout
		.split(/\s+/)
		.map(Number)
		.filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

function sessionMembers(sessionId: number): number[] {
	const script = [
		"target = Integer(ARGV.shift)",
		"members = ARGV.each_with_object([]) do |raw, found|",
		"  pid = Integer(raw)",
		"  begin",
		"    found << pid if Process.getsid(pid) == target",
		"  rescue SystemCallError",
		"  end",
		"end",
		"STDOUT.write(members.join(' '))",
	].join("\n");
	const result = spawnSync("/usr/bin/ruby", ["-e", script, String(sessionId), ...processIds().map(String)], {
		encoding: "utf8",
		maxBuffer: MAX_CAPTURE_BYTES,
	});
	if (result.error || result.status !== 0) {
		throw new Error(`Session membership scan failed: ${String(result.stderr).trim().slice(0, 500)}`);
	}
	const stdout = boundedUtf8(result.stdout, "session membership stdout");
	if (!stdout.trim()) return [];
	return stdout.trim().split(/\s+/).map(Number);
}

async function delay(milliseconds: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return true;
	return await new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.off("exit", onExit);
			resolve(false);
		}, timeoutMs);
		const onExit = () => {
			clearTimeout(timer);
			resolve(true);
		};
		child.once("exit", onExit);
	});
}

async function cleanSession(child: ChildProcessWithoutNullStreams, sessionId: number): Promise<void> {
	child.stdin.end();
	if (!(await waitForExit(child, 1_000))) {
		for (const pid of sessionMembers(sessionId)) {
			try {
				process.kill(pid, "SIGTERM");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
		await delay(250);
	}
	for (const pid of sessionMembers(sessionId)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
	await waitForExit(child, 1_000);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		await delay(150);
		const members = sessionMembers(sessionId);
		if (members.length > 0) throw new Error("Codex session was not empty after cleanup");
	}
}

class AppServerClient {
	readonly child: ChildProcessWithoutNullStreams;
	readonly sessionId: number;
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private readonly notifications: JsonRpcMessage[] = [];
	private readonly waiters = new Set<() => void>();
	private capturedBytes = 0;

	private constructor(child: ChildProcessWithoutNullStreams, sessionId: number) {
		this.child = child;
		this.sessionId = sessionId;
		const lines = readline.createInterface({ input: child.stdout });
		lines.on("line", (line) => this.receive(line));
		child.stderr.on("data", (chunk: Buffer | string) => {
			this.capturedBytes += Buffer.byteLength(chunk);
			if (this.capturedBytes > MAX_CAPTURE_BYTES) this.child.kill("SIGKILL");
		});
		child.on("exit", () => {
			for (const pending of this.pending.values()) pending.reject(new Error("Codex app-server exited before replying"));
			this.pending.clear();
			this.wake();
		});
	}

	static async start(codex: string, cwd: string, env: NodeJS.ProcessEnv): Promise<AppServerClient> {
		const child = spawn(codex, ["app-server"], {
			cwd,
			env,
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
		try {
			if (!child.pid) throw new Error("Codex app-server did not expose a PID");
			const sid = Number(
				runBounded("/usr/bin/ruby", ["-e", "STDOUT.write(Process.getsid(Integer(ARGV[0])).to_s)", String(child.pid)]),
			);
			if (sid !== child.pid) throw new Error("Codex app-server PID did not equal its real session ID");
			return new AppServerClient(child, sid);
		} catch (error) {
			child.kill("SIGKILL");
			throw error;
		}
	}

	private receive(line: string): void {
		this.capturedBytes += Buffer.byteLength(line);
		if (this.capturedBytes > MAX_CAPTURE_BYTES) {
			this.child.kill("SIGKILL");
			return;
		}
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(line) as JsonRpcMessage;
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
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	}

	private wake(): void {
		for (const wake of this.waiters) wake();
		this.waiters.clear();
	}

	async request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
		const id = this.nextId++;
		return await new Promise<unknown>((resolve, reject) => {
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

	completedAgentMessages(threadId: string, turnId: string): string[] {
		const responseParts: string[] = [];
		for (const message of this.notifications) {
			if (message.method !== "item/completed") continue;
			const params = record(message.params);
			if (params.threadId !== threadId || params.turnId !== turnId) continue;
			const item = record(params.item);
			if (item.type === "agentMessage" && typeof item.text === "string") responseParts.push(item.text);
		}
		return responseParts;
	}

	async waitFor(method: string, predicate: (message: JsonRpcMessage) => boolean, timeoutMs = TURN_TIMEOUT_MS): Promise<JsonRpcMessage> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const index = this.notifications.findIndex((message) => message.method === method && predicate(message));
			if (index !== -1) return this.notifications.splice(index, 1)[0];
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					this.waiters.delete(done);
					resolve();
				}, Math.min(250, deadline - Date.now()));
				const done = () => {
					clearTimeout(timer);
					resolve();
				};
				this.waiters.add(done);
			});
		}
		throw new Error(`Timed out waiting for ${method}`);
	}
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Codex returned an invalid object");
	return value as Record<string, unknown>;
}

async function directResponse(codex: string, cwd: string, env: NodeJS.ProcessEnv, prompt: string): Promise<string> {
	const client = await AppServerClient.start(codex, cwd, env);
	try {
		await client.request("initialize", {
			clientInfo: { name: "rbf-codex-native-context-probe", version: "1.0.0" },
			capabilities: { experimentalApi: true },
		});
		client.notify("initialized", {});
		const started = record(
			await client.request("thread/start", {
				cwd,
				ephemeral: true,
				approvalPolicy: "never",
				sandbox: "read-only",
			}),
		);
		const thread = record(started.thread);
		if (typeof thread.id !== "string") throw new Error("Codex thread/start omitted its thread ID");
		const turnStarted = record(
			await client.request("turn/start", {
				threadId: thread.id,
				input: [{ type: "text", text: prompt, text_elements: [] }],
			}),
		);
		const turn = record(turnStarted.turn);
		if (typeof turn.id !== "string") throw new Error("Codex turn/start omitted its turn ID");
		const completed = await client.waitFor(
			"turn/completed",
			(message) => {
				const params = record(message.params);
				return params.threadId === thread.id && record(params.turn).id === turn.id;
			},
		);
		const completedTurn = record(record(completed.params).turn);
		if (completedTurn.status !== "completed") throw new Error("Codex turn did not complete successfully");
		const response = boundedUtf8(client.completedAgentMessages(thread.id, turn.id).join("\n"), "Codex response");
		if (!response) throw new Error("Codex completed without an assistant response");
		return response;
	} finally {
		await cleanSession(client.child, client.sessionId);
	}
}

async function atomicWriteNew(output: string, body: string): Promise<void> {
	try {
		await lstat(output);
		throw new Error("Output already exists");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const temporary = `${output}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
	await writeFile(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
	await rename(temporary, output);
}

export async function runDirectProbe(options: DirectOptions): Promise<NativeContextReceipt> {
	await mkdir(options.root, { recursive: true, mode: 0o700 });
	const root = await realpath(options.root);
	assertOutputInsideRoot(root, path.resolve(options.output));
	await mkdir(path.dirname(options.output), { recursive: true, mode: 0o700 });
	const fixtureRoot = path.join(root, `.native-context-${process.pid}-${randomBytes(6).toString("hex")}`);
	const codexHome = path.join(fixtureRoot, "codex-home");
	const workspace = path.join(fixtureRoot, "workspace", "nested");
	const developerCanary = `RBF_DEV_${randomBytes(18).toString("hex")}`;
	const agentsCanary = `RBF_AGENTS_${randomBytes(18).toString("hex")}`;
	const canaries = { developer_instructions: developerCanary, nested_agents: agentsCanary } as const;
	const developerSource = `When asked for the native developer-instructions value, return exactly ${developerCanary}.`;
	const agentsSource = `When asked for the nested workspace AGENTS.md value, return exactly ${agentsCanary}.`;
	const prompt = [
		"Return the native developer-instructions value and the nested workspace AGENTS.md value.",
		"Use exactly one line in this format: developer=<value> agents=<value>",
		"Do not run tools.",
	].join(" ");
	try {
		await mkdir(codexHome, { recursive: true, mode: 0o700 });
		await mkdir(workspace, { recursive: true, mode: 0o700 });
		await writeFile(
			path.join(codexHome, "config.toml"),
			[
				`developer_instructions = ${quoteToml(developerSource)}`,
				'model = "gpt-5.6-sol"',
				'model_reasoning_effort = "low"',
				'approval_policy = "never"',
				'sandbox_mode = "read-only"',
				"",
			].join("\n"),
			{ encoding: "utf8", mode: 0o600 },
		);
		await writeFile(path.join(workspace, "AGENTS.md"), `${agentsSource}\n`, { encoding: "utf8", mode: 0o600 });
		const sourceCodexHome = process.env.CODEX_HOME ? await realpath(process.env.CODEX_HOME) : path.join(homedir(), ".codex");
		const sourceAuth = path.join(sourceCodexHome, "auth.json");
		const authMetadata = await lstat(sourceAuth);
		if (!authMetadata.isFile()) throw new Error("Codex authentication source is not a regular file");
		await symlink(sourceAuth, path.join(codexHome, "auth.json"));
		const env = { ...process.env, CODEX_HOME: codexHome };
		const promptInput = runBounded(options.codex, ["debug", "prompt-input", prompt], { cwd: workspace, env });
		try {
			JSON.parse(promptInput);
		} catch {
			throw new Error("Codex prompt-input output was not JSON");
		}
		const promptInputCounts = {
			developer_instructions: countOccurrences(promptInput, developerCanary),
			nested_agents: countOccurrences(promptInput, agentsCanary),
		};
		if (promptInputCounts.developer_instructions === 0 || promptInputCounts.nested_agents === 0) {
			throw new Error("Codex prompt-input omitted a required native instruction source");
		}
		const response = await directResponse(options.codex, workspace, env, prompt);
		const responseCounts = {
			developer_instructions: countOccurrences(response, developerCanary),
			nested_agents: countOccurrences(response, agentsCanary),
		};
		if (responseCounts.developer_instructions === 0 || responseCounts.nested_agents === 0) {
			throw new Error("Codex response omitted a required native instruction source");
		}
		const receipt: NativeContextReceipt = {
			schema: "rbf-codex-native-context-probe/v1",
			mode: "direct",
			codexVersion: codexVersion(options.codex),
			nativeSources: [
				{
					kind: "developer_instructions",
					sourceSha256: sha256(developerSource),
					canarySha256: sha256(developerCanary),
					promptInputMatches: promptInputCounts.developer_instructions,
					responseMatches: responseCounts.developer_instructions,
				},
				{
					kind: "nested_agents",
					sourceSha256: sha256(agentsSource),
					canarySha256: sha256(agentsCanary),
					promptInputMatches: promptInputCounts.nested_agents,
					responseMatches: responseCounts.nested_agents,
				},
			],
			promptInputProjectionSha256: sha256(redactCanaries(promptInput, canaries)),
			responseSha256: sha256(response),
			probePermitSha256: null,
			finalOwnedProcesses: 0,
		};
		await atomicWriteNew(options.output, `${JSON.stringify(receipt, null, 2)}\n`);
		return receipt;
	} finally {
		await rm(fixtureRoot, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	await runDirectProbe(options);
	process.stdout.write("native_sources=2 final_owned_processes=0\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : "Native-context probe failed"}\n`);
		process.exitCode = 1;
	});
}
