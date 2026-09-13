// Real-Codex probe for #pi-10's topology assumptions (brief, automated Scenario 2).
// Proves, against the installed Codex CLI in an isolated CODEX_HOME:
//   1. a stdio `codex app-server` exits on its own when its parent is SIGKILLed mid-turn,
//      and the command it was running dies with it;
//   2. a fresh app-server can `thread/resume` that thread and sees the cut turn as `interrupted`;
//   3. a new turn on the resumed thread completes and carries a nonce;
//   4. stdin EOF then SIGTERM leaves no app-server behind.
// Prints one line: parent_kill_child_exit_ms=<n> sleep_orphaned=<bool> resume_ok=<bool>
// cut_turn_status=<s> new_turn_status=<s> reply_has_nonce=<bool> sigterm_orphans=<n>
//
//   bun run extensions/test-support/rbf-codex-child-lifecycle-probe.ts --codex /Users/tomhosiawa/.local/bin/codex
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

type Rpc = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } };

export function parseProbeArgs(argv: string[]): { codex: string } {
	let codex = "codex";
	for (let i = 0; i < argv.length; i++) if (argv[i] === "--codex" && argv[i + 1]) codex = argv[++i];
	return { codex };
}

class Client {
	private nextId = 1;
	private readonly pending = new Map<number, (m: Rpc) => void>();
	readonly notifications: Rpc[] = [];
	private readonly waiters = new Set<() => void>();
	constructor(readonly child: ChildProcessWithoutNullStreams) {
		createInterface({ input: child.stdout }).on("line", (line) => {
			let m: Rpc;
			try {
				m = JSON.parse(line);
			} catch {
				return;
			}
			if (m.id !== undefined && m.method) {
				this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "probe declines" } })}\n`);
				return;
			}
			if (typeof m.id === "number") {
				this.pending.get(m.id)?.(m);
				this.pending.delete(m.id);
				return;
			}
			if (m.method) {
				this.notifications.push(m);
				for (const w of this.waiters) w();
			}
		});
	}
	static async start(codex: string, cwd: string, env: NodeJS.ProcessEnv): Promise<Client> {
		const child = spawn(codex, ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
		const c = new Client(child);
		await c.request("initialize", { clientInfo: { name: "pi-rbf-lifecycle-probe", version: "1" }, capabilities: { experimentalApi: true } });
		c.notify("initialized", {});
		return c;
	}
	request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => reject(new Error(`timeout ${method}`)), timeoutMs);
			this.pending.set(id, (m) => {
				clearTimeout(t);
				if (m.error) reject(new Error(m.error.message));
				else resolve(m.result);
			});
			this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	}
	notify(method: string, params: unknown): void {
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}
	async waitFor(pred: (m: Rpc) => boolean, timeoutMs: number): Promise<Rpc> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const hit = this.notifications.find(pred);
			if (hit) return hit;
			await new Promise<void>((r) => {
				const t = setTimeout(() => {
					this.waiters.delete(w);
					r();
				}, 200);
				const w = () => {
					clearTimeout(t);
					this.waiters.delete(w);
					r();
				};
				this.waiters.add(w);
			});
		}
		throw new Error("timeout waiting for notification");
	}
}

function pids(pattern: string): number[] {
	try {
		return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number);
	} catch {
		return [];
	}
}

const rec = (v: unknown) => v as Record<string, unknown>;

async function main(): Promise<void> {
	const { codex } = parseProbeArgs(process.argv.slice(2));
	const root = mkdtempSync(join(tmpdir(), "pi10-lifecycle-"));
	const home = join(root, "codex-home");
	const work = join(root, "work");
	execFileSync("mkdir", ["-p", home, work]);
	writeFileSync(join(home, "config.toml"), 'approval_policy = "never"\nsandbox_mode = "workspace-write"\n');
	const env = { ...process.env, CODEX_HOME: home };
	const sleepTag = `pi10-probe-${process.pid}`;
	const nonce = `NONCE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

	// 1. A parent process that spawns the app-server and starts a long command, then gets SIGKILLed.
	const parentScript = `
		const { spawn } = require("node:child_process");
		const { createInterface } = require("node:readline");
		const child = spawn(${JSON.stringify(codex)}, ["app-server"], { cwd: ${JSON.stringify(work)}, env: process.env, stdio: ["pipe","pipe","pipe"] });
		let id = 0; const pending = new Map();
		createInterface({ input: child.stdout }).on("line", (l) => { try { const m = JSON.parse(l); if (m.id !== undefined && m.method) { child.stdin.write(JSON.stringify({ jsonrpc:"2.0", id:m.id, error:{code:-32601,message:"decline"} })+"\\n"); return; } if (typeof m.id === "number") { pending.get(m.id)?.(m); } else if (m.method === "item/started" && m.params?.item?.type === "commandExecution") { process.stdout.write("RUNNING " + child.pid + "\\n"); } } catch {} });
		const req = (method, params) => new Promise((r) => { const i = ++id; pending.set(i, r); child.stdin.write(JSON.stringify({ jsonrpc:"2.0", id:i, method, params })+"\\n"); });
		(async () => {
			await req("initialize", { clientInfo: { name: "probe-parent", version: "1" }, capabilities: { experimentalApi: true } });
			child.stdin.write(JSON.stringify({ jsonrpc:"2.0", method:"initialized", params:{} })+"\\n");
			const t = await req("thread/start", { cwd: ${JSON.stringify(work)}, ephemeral: false });
			process.stdout.write("THREAD " + t.result.thread.id + "\\n");
			await req("turn/start", { threadId: t.result.thread.id, input: [{ type: "text", text: "Run exactly this shell command and nothing else, without asking: /bin/sleep 30 # ${sleepTag}", text_elements: [] }] });
		})();
		setInterval(() => {}, 1000);
	`;
	const parent = spawn(process.execPath, ["-e", parentScript], { env, stdio: ["ignore", "pipe", "inherit"] });
	let threadId = "";
	let appServerPid = 0;
	await new Promise<void>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("parent never reached a running command")), 90_000);
		createInterface({ input: parent.stdout }).on("line", (line) => {
			if (line.startsWith("THREAD ")) threadId = line.slice(7).trim();
			if (line.startsWith("RUNNING ")) {
				appServerPid = Number(line.slice(8).trim());
				clearTimeout(t);
				resolve();
			}
		});
	});
	await new Promise((r) => setTimeout(r, 500));
	const sleepBefore = pids(sleepTag).length > 0;
	const killedAt = Date.now();
	process.kill(parent.pid!, "SIGKILL");
	let childExitMs = -1;
	while (Date.now() - killedAt < 5_000) {
		try {
			process.kill(appServerPid, 0);
		} catch {
			childExitMs = Date.now() - killedAt;
			break;
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	await new Promise((r) => setTimeout(r, 500));
	const sleepOrphaned = sleepBefore && pids(sleepTag).length > 0;
	for (const p of pids(sleepTag)) process.kill(p, "SIGKILL");

	// 2 and 3. Resume from a fresh app-server; the cut turn is interrupted; a new turn completes with the nonce.
	const client = await Client.start(codex, work, env);
	let resumeOk = false;
	let cutTurnStatus = "none";
	let newTurnStatus = "none";
	let replyHasNonce = false;
	try {
		const resumed = rec(await client.request("thread/resume", { threadId, excludeTurns: false }));
		const turns = rec(resumed.thread).turns as Record<string, unknown>[];
		resumeOk = rec(resumed.thread).id === threadId;
		cutTurnStatus = String(turns[turns.length - 1]?.status ?? "none");
		const started = rec(await client.request("turn/start", { threadId, input: [{ type: "text", text: `Reply exactly ${nonce} and nothing else.`, text_elements: [] }] }));
		const turnId = String(rec(started.turn).id);
		const done = await client.waitFor((m) => m.method === "turn/completed" && rec(rec(m.params).turn).id === turnId, 120_000);
		newTurnStatus = String(rec(rec(done.params).turn).status);
		replyHasNonce = client.notifications.some((m) => m.method === "item/completed" && rec(rec(m.params).item).type === "agentMessage" && String(rec(rec(m.params).item).text).includes(nonce));
	} finally {
		// 4. Pi's close order: stdin EOF, 2 s, SIGTERM, 1 s, SIGKILL.
		client.child.stdin.end();
		await Promise.race([new Promise((r) => client.child.once("exit", r)), new Promise((r) => setTimeout(r, 2_000))]);
		if (client.child.exitCode === null) client.child.kill("SIGTERM");
		await Promise.race([new Promise((r) => client.child.once("exit", r)), new Promise((r) => setTimeout(r, 1_000))]);
		if (client.child.exitCode === null) client.child.kill("SIGKILL");
	}
	await new Promise((r) => setTimeout(r, 300));
	const sigtermOrphans = pids(`codex app-server`).filter((p) => p === client.child.pid || p === appServerPid).length;
	rmSync(root, { recursive: true, force: true });
	console.log(`parent_kill_child_exit_ms=${childExitMs} sleep_orphaned=${sleepOrphaned} resume_ok=${resumeOk} cut_turn_status=${cutTurnStatus} new_turn_status=${newTurnStatus} reply_has_nonce=${replyHasNonce} sigterm_orphans=${sigtermOrphans}`);
}

if (import.meta.main) {
	main().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
