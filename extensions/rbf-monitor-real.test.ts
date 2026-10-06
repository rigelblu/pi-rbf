import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import readline from "node:readline";

const ROOT = resolve(import.meta.dirname, "..");
const SUPPORT = resolve(import.meta.dirname, "test-support");
const DRIVER = join(SUPPORT, "rbf-row-gate-drive.py");
const PI = process.env.RBF_PI_BIN ?? join(ROOT, "node_modules", ".bin", "pi");
const COLS = 100;

const ESCAPES = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]|\r/g;

function screen(raw: Buffer): string[] {
	const rows: string[] = [""];
	let row = 0;
	let restart = false;
	const begin = () => {
		if (restart) {
			rows[row] = "";
			restart = false;
		}
	};
	const tokens = raw.toString("utf8").match(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^[\]]|[^\x1b]+/gu) ?? [];
	for (const t of tokens) {
		if (t.startsWith("\x1b[")) {
			const m = /^\x1b\[([0-9;?<>=]*)[ -/]*([@-~])$/.exec(t)!;
			const n = parseInt(m[1]!, 10);
			switch (m[2]) {
				case "H":
				case "f": {
					const [line, column] = m[1]!.split(";").map((part) => parseInt(part, 10) || 1);
					row = Math.max(0, (line ?? 1) - 1);
					while (rows.length <= row) rows.push("");
					restart = (column ?? 1) === 1;
					break;
				}
				case "A":
					row = Math.max(0, row - (n || 1));
					restart = false;
					break;
				case "B":
					row += n || 1;
					while (rows.length <= row) rows.push("");
					restart = false;
					break;
				case "G":
					if (!n || n === 1) restart = true;
					break;
				case "K":
					if (n === 2) {
						rows[row] = "";
						restart = false;
					}
					break;
				case "J":
					if (n === 2) {
						rows.length = 1;
						rows[0] = "";
						row = 0;
						restart = false;
					} else if (!n) rows.length = row + 1;
					break;
				default:
					break;
			}
		} else if (!t.startsWith("\x1b")) {
			for (const ch of t) {
				if (ch === "\r") restart = true;
				else if (ch === "\n") {
					row++;
					while (rows.length <= row) rows.push("");
					restart = true;
				} else {
					begin();
					rows[row] += ch;
				}
			}
		}
	}
	return rows.map((r) => r.replace(ESCAPES, "").trimEnd());
}

class TestWorkspace {
	readonly dir: string;
	readonly agent: string;
	readonly sessions: string;
	readonly work: string;
	readonly watched: string;

	constructor() {
		this.dir = mkdtempSync(join(tmpdir(), "pi44-real-"));
		this.agent = this.dir; // PI_CODING_AGENT_DIR is this.dir per shared setup
		this.sessions = join(this.dir, "sessions");
		this.work = join(this.dir, "work");
		this.watched = join(this.dir, "watched.txt");
		for (const d of [this.sessions, this.work]) mkdirSync(d, { recursive: true });
		writeFileSync(this.watched, "");
	}

	appendWatched(line: string): void {
		writeFileSync(this.watched, readFileSync(this.watched, "utf8") + line + "\n");
	}

	readSessionEntries(): any[] {
		if (!existsSync(this.sessions)) return [];
		const files = readdirSync(this.sessions).filter((f) => f.endsWith(".jsonl"));
		if (files.length === 0) return [];
		const content = readFileSync(join(this.sessions, files[0]!), "utf8");
		return content
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.filter(Boolean);
	}

	findCustomMessages(): any[] {
		return this.readSessionEntries().filter(
			(e) => e.type === "custom_message" && e.customType === "rbf-monitor",
		);
	}

	findUserMessages(text?: string): any[] {
		return this.readSessionEntries().filter(
			(e) =>
				e.type === "message" &&
				e.message?.role === "user" &&
				(!text || e.message?.content?.some((b: any) => b.type === "text" && b.text === text)),
		);
	}

	cleanup(): void {
		if (process.env.RBF_KEEP_TMP === "1") {
			console.log(`[RBF_KEEP_TMP=1] Preserved test workspace: ${this.dir}`);
			return;
		}
		try {
			rmSync(this.dir, { recursive: true, force: true });
		} catch {}
	}
}

// ─── RPC Client ────────────────────────────────────────────────────────────

class RpcClient {
	readonly events: any[] = [];
	private child: any;
	private rl: any;

	constructor(
		readonly bin: string,
		readonly ws: TestWorkspace,
		readonly script: any[],
		readonly extraExtensions: string[] = [],
		readonly extraEnv: Record<string, string> = {},
		readonly extraArgs: string[] = [],
	) {
		activeClients.push(this);
	}

	start(): Promise<void> {
		return new Promise((resolve, reject) => {
			const argv = [
				"--no-extensions",
				"--no-skills",
				"--no-themes",
				"--no-context-files",
				"--no-prompt-templates",
				"--session-dir",
				this.ws.sessions,
				"-e",
				join(SUPPORT, "rbf-row-gate-provider.ts"),
				"-e",
				join(ROOT, "extensions", "rbf-monitor.ts"),
				...this.extraExtensions.flatMap((e) => ["-e", e]),
				"--model",
				"rbf-gate/gate",
				"--mode",
				"rpc",
				...this.extraArgs,
			];

			const env = {
				...process.env,
				PI_CODING_AGENT_DIR: this.ws.agent,
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
				PI_HYPERLINKS: "0",
				PI_TELEMETRY: "0",
				RBF_ROW_GATE_SCRIPT: JSON.stringify(this.script),
				...this.extraEnv,
			};

			this.child = spawn(this.bin, argv, { cwd: this.ws.work, env, stdio: ["pipe", "pipe", "pipe"] });
			this.child.on("error", reject);

			this.rl = readline.createInterface({ input: this.child.stdout });
			this.rl.on("line", (line: string) => {
				try {
					const ev = JSON.parse(line);
					this.events.push(ev);
				} catch {}
			});

			// Wait for RPC server to be ready
			setTimeout(resolve, 2000);
		});
	}

	send(data: object): void {
		this.child.stdin.write(JSON.stringify(data) + "\n");
	}

	prompt(text: string, streaming?: string): void {
		const o: any = { type: "prompt", message: text };
		if (streaming) o.streamingBehavior = streaming;
		this.send(o);
	}

	async waitForEvent(pred: (e: any, index: number) => boolean, timeoutMs: number = 10000): Promise<any> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			const found = this.events.find(pred);
			if (found) return found;
			await new Promise((r) => setTimeout(r, 50));
		}
		throw new Error(`Timeout waiting for RPC event after ${timeoutMs}ms`);
	}

	async waitForSettled(count: number = 1, timeoutMs: number = 15000): Promise<void> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			const settled = this.events.filter((e) => e.type === "agent_settled");
			if (settled.length >= count) return;
			await new Promise((r) => setTimeout(r, 50));
		}
		throw new Error(`Timeout waiting for ${count} agent_settled events`);
	}

	async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
		if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
		await new Promise<void>((resolve) => {
			let done = false;
			const onExit = () => {
				if (!done) {
					done = true;
					resolve();
				}
			};
			this.child.once("close", onExit);
			this.child.once("exit", onExit);
			try {
				this.child.kill(signal);
			} catch {
				onExit();
			}
			setTimeout(() => {
				if (!done) {
					try {
						this.child.kill("SIGKILL");
					} catch {}
				}
			}, 1500);
			setTimeout(onExit, 2500);
		});
	}
}

// ─── PTY Driver Helper ─────────────────────────────────────────────────────

type Step =
	| { wait: string; count?: number }
	| { reloadReady: { path: string; loads: number } }
	| { paste: string }
	| { key: string }
	| { sleep: number }
	| { snapshot: string };

function drivePty(
	bin: string,
	ws: TestWorkspace,
	script: any[],
	steps: Step[],
	extraExtensions: string[] = [],
	extraEnv: Record<string, string> = {},
	extraArgs: string[] = [],
): Promise<{ raw: Buffer; snapshots: Record<string, string[]> }> {
	const out = join(ws.dir, "raw.bin");
	const plan = {
		argv: [
			bin,
			"--approve",
			"--tui-mode",
			"regular",
			"--no-extensions",
			"--no-skills",
			"--no-themes",
			"--no-context-files",
			"--no-prompt-templates",
			"--session-dir",
			ws.sessions,
			"-e",
			join(SUPPORT, "rbf-row-gate-provider.ts"),
			"-e",
			join(ROOT, "extensions", "rbf-monitor.ts"),
			...extraExtensions.flatMap((e) => ["-e", e]),
			"--model",
			"rbf-gate/gate",
			...extraArgs,
		],
		cwd: ws.work,
		env: {
			PI_CODING_AGENT_DIR: ws.agent,
			PI_SKIP_VERSION_CHECK: "1",
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
			PI_HYPERLINKS: "0",
			RBF_ROW_GATE_SCRIPT: JSON.stringify(script),
			...extraEnv,
		},
		cols: COLS,
		rows: 40,
		timeout: 30,
		out,
		steps,
	};
	return new Promise((resolvePromise, reject) => {
		const child = spawn("python3", [DRIVER], { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", reject);
		child.on("close", (code) => {
			const raw = existsSync(out) ? readFileSync(out) : Buffer.alloc(0);
			if (code !== 0) return reject(new Error(`pty driver exited ${code}: ${stderr.trim()}\n${screen(raw).slice(-40).join("\n")}`));
			const offsets = JSON.parse(stdout) as Record<string, number>;
			resolvePromise({
				raw,
				snapshots: Object.fromEntries(Object.entries(offsets).map(([name, offset]) => [name, screen(raw.subarray(0, offset))])),
			});
		});
		child.stdin.end(JSON.stringify(plan));
	});
}

// ─── Real-Pi Delivery Scenarios 10, 16, 19, 20, 21, 22 ─────────────────────

let activeClients: RpcClient[] = [];

describe("rbf-monitor real-Pi delivery scenarios", () => {
	const bin = PI;
	let ws: TestWorkspace;

	beforeEach(() => {
		ws = new TestWorkspace();
		activeClients = [];
	});

	afterEach(async () => {
		for (const client of activeClients) {
			try {
				await client.stop();
			} catch {}
		}
		activeClients = [];
		ws.cleanup();
	});

	// ─── Scenario 10: Esc keeps the event (Real Pi) ──────────────────────────
	describe("Scenario 10: esc keeps the event", () => {
		it("RPC, a line first: clear_queue + abort drops steer, next line delivers both in order", async () => {
			const script = [
				{ tool: "monitor", args: { command: `tail -n +1 -F ${ws.watched}`, description: "gate watch" } },
				{ tool: "bash", args: { command: "sleep 10" } },
				{ text: "GATE_R1" },
				{ text: "GATE_R2" },
				{ text: "GATE_R3" },
				{ text: "GATE_R4" },
			];
			const client = new RpcClient(bin, ws, script);
			await client.start();

			client.prompt("go");
			await client.waitForEvent((e) => e.type === "tool_execution_start" && e.toolName === "bash");
			await new Promise((r) => setTimeout(r, 1000));
			ws.appendWatched("GATE_LINE_1");

			await new Promise((r) => setTimeout(r, 1000));
			client.send({ type: "clear_queue" });
			client.send({ type: "abort" });
			await new Promise((r) => setTimeout(r, 3000));

			// Append second line
			ws.appendWatched("GATE_LINE_2");
			await client.waitForSettled(2);
			client.prompt("next");
			await client.waitForSettled(3);

			await client.stop();

			// Assert on custom messages
			const customMsgs = client.events.filter((e) => e.type === "message_start" && e.message?.customType === "rbf-monitor");
			expect(customMsgs.length, "expected custom monitor messages on event stream").toBe(1);
			expect(customMsgs[0]?.message?.content).toContain("GATE_LINE_1");
			expect(customMsgs[0]?.message?.content).toContain("GATE_LINE_2");
		}, 35000);

		it("RPC, a prompt first: prompt next gives GATE_LINE_1, then GATE_LINE_2 alone", async () => {
			const script = [
				{ tool: "monitor", args: { command: `tail -n +1 -F ${ws.watched}`, description: "gate watch" } },
				{ tool: "bash", args: { command: "sleep 10" } },
				{ text: "GATE_R1" },
				{ text: "GATE_R2" },
				{ text: "GATE_R3" },
				{ text: "GATE_R4" },
			];
			const client = new RpcClient(bin, ws, script);
			await client.start();

			client.prompt("go");
			await client.waitForEvent((e) => e.type === "tool_execution_start" && e.toolName === "bash");
			await new Promise((r) => setTimeout(r, 1000));
			ws.appendWatched("GATE_LINE_1");

			await new Promise((r) => setTimeout(r, 1000));
			client.send({ type: "clear_queue" });
			client.send({ type: "abort" });
			await new Promise((r) => setTimeout(r, 3000));

			client.prompt("next");
			await client.waitForSettled(2);

			ws.appendWatched("GATE_LINE_2");
			await client.waitForSettled(3);
			await client.stop();

			const customEntries = ws.findCustomMessages();
			expect(customEntries.length, "expected 2 custom monitor messages in session file").toBe(2);
			expect(customEntries[0]?.content).toContain("GATE_LINE_1");
			expect(customEntries[1]?.content).toContain("GATE_LINE_2");
		}, 35000);

		it("RPC, plain abort with no clear_queue: custom message arrives right after aborted bash", async () => {
			const script = [
				{ tool: "monitor", args: { command: `tail -n +1 -F ${ws.watched}`, description: "gate watch" } },
				{ tool: "bash", args: { command: "sleep 10" } },
				{ text: "GATE_R1" },
				{ text: "GATE_R2" },
			];
			const client = new RpcClient(bin, ws, script);
			await client.start();

			client.prompt("go");
			await client.waitForEvent((e) => e.type === "tool_execution_start" && e.toolName === "bash");
			await new Promise((r) => setTimeout(r, 1000));
			ws.appendWatched("GATE_LINE_1");

			client.send({ type: "abort" });
			await client.waitForSettled(1);

			client.prompt("next");
			await client.waitForSettled(2);
			await client.stop();

			const customMsgs = client.events.filter((e) => e.type === "message_start" && e.message?.customType === "rbf-monitor");
			expect(customMsgs.length, "custom message should arrive after abort").toBe(1);
		}, 35000);

		it("PTY, Escape key in place of clear_queue and abort: snapshot shows both rows", async () => {
			const script = [
				{ tool: "monitor", args: { command: `tail -n +1 -F ${ws.watched}`, description: "gate watch" } },
				{ tool: "bash", args: { command: "sleep 10" } },
				{ text: "GATE_R1" },
				{ text: "GATE_R2" },
			];
			(async () => {
				const start = Date.now();
				while (Date.now() - start < 15000) {
					const entries = ws.readSessionEntries();
					const hasBash = entries.some(
						(e) => (e.type === "message" && e.message?.content?.some((c: any) => c.type === "tool_call" && c.name === "bash"))
							|| (e.type === "tool_call" && e.name === "bash"),
					);
					if (hasBash) break;
					await new Promise((r) => setTimeout(r, 50));
				}
				await new Promise((r) => setTimeout(r, 1000));
				ws.appendWatched("GATE_LINE_1");

				const rawPath = join(ws.dir, "raw.bin");
				const start2 = Date.now();
				while (Date.now() - start2 < 15000) {
					if (existsSync(rawPath)) {
						const raw = readFileSync(rawPath, "utf8");
						if (raw.includes("Command aborted") || raw.includes("aborted")) break;
					}
					await new Promise((r) => setTimeout(r, 50));
				}
				await new Promise((r) => setTimeout(r, 4000));
				ws.appendWatched("GATE_LINE_2");
			})().catch(() => {});

			const { snapshots } = await drivePty(bin, ws, script, [
				{ wait: "ctrl\\+o more" },
				{ paste: "go" },
				{ key: "enter" },
				{ wait: "sleep 10" },
				{ sleep: 2.5 },
				{ key: "escape" },
				{ sleep: 1.5 },
				{ snapshot: "after_esc" },
				{ sleep: 3.5 },
				{ wait: "GATE_LINE_2" },
				{ snapshot: "after_line2" },
			]);

			expect(snapshots["after_esc"]?.join("\n")).not.toContain("monitor event");
			expect(snapshots["after_line2"]?.join("\n")).toContain("GATE_LINE_1");
			expect(snapshots["after_line2"]?.join("\n")).toContain("GATE_LINE_2");
		}, 35000);
	});

	// ─── Scenario 16: Compaction hold (Real Pi) ──────────────────────────────
	describe("Scenario 16: compaction hold", () => {
		it("RPC: line appended during compact-started is delivered after compaction_end", async () => {
			const slowCompactPath = join(ws.dir, "slow-compact.ts");
			writeFileSync(
				slowCompactPath,
				`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
export default function slowCompact(pi: ExtensionAPI): void {
	pi.on("session_before_compact", async (event: any) => {
		const dir = process.env.PI_CODING_AGENT_DIR!;
		fs.writeFileSync(path.join(dir, "compact-started"), "1");
		const releasePath = path.join(dir, "release");
		while (!fs.existsSync(releasePath)) {
			await new Promise(r => setTimeout(r, 50));
		}
		return { compaction: { summary: "GATE_SUMMARY", firstKeptEntryId: event.preparation?.firstKeptEntryId, tokensBefore: event.preparation?.tokensBefore } };
	});
}`,
			);
			writeFileSync(join(ws.dir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));

			const script = [
				{ tool: "monitor", args: { command: `tail -n +1 -F ${ws.watched}`, description: "gate watch" } },
				...Array.from({ length: 8 }, (_, i) => ({ text: `GATE_R${i + 1}` })),
			];

			const client = new RpcClient(bin, ws, script, [slowCompactPath]);
			await client.start();

			client.prompt("go");
			await client.waitForSettled(1);
			client.prompt("more");
			await client.waitForSettled(2);
			client.prompt("more");
			await client.waitForSettled(3);

			client.send({ type: "compact" });
			const compactStarted = join(ws.dir, "compact-started");
			const start = Date.now();
			while (!existsSync(compactStarted) && Date.now() - start < 10000) {
				await new Promise((r) => setTimeout(r, 50));
			}
			if (!existsSync(compactStarted)) throw new Error("Timed out waiting for compact-started");

			ws.appendWatched("GATE_LINE_1");
			await new Promise((r) => setTimeout(r, 1000));
			writeFileSync(join(ws.dir, "release"), "1");

			await client.waitForSettled(4);
			await client.stop();

			const customMsg = ws.findCustomMessages()[0];
			expect(customMsg, "expected custom message after compaction in session file").toBeDefined();
			expect(customMsg?.content).toContain("GATE_LINE_1");
		}, 35000);

		it("RPC, with slow-peer.ts added: compaction_end comes after release", async () => {
			const slowCompactPath = join(ws.dir, "slow-compact.ts");
			writeFileSync(
				slowCompactPath,
				`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
export default function slowCompact(pi: ExtensionAPI): void {
	pi.on("session_before_compact", async (event: any) => {
		const dir = process.env.PI_CODING_AGENT_DIR!;
		fs.writeFileSync(path.join(dir, "compact-started"), "1");
		const releasePath = path.join(dir, "release");
		while (!fs.existsSync(releasePath)) {
			await new Promise(r => setTimeout(r, 50));
		}
		return { compaction: { summary: "GATE_SUMMARY", firstKeptEntryId: event.preparation?.firstKeptEntryId, tokensBefore: event.preparation?.tokensBefore } };
	});
}`,
			);
			const slowPeerPath = join(ws.dir, "slow-peer.ts");
			writeFileSync(
				slowPeerPath,
				`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function slowPeer(pi: ExtensionAPI): void {
	pi.on("session_compact", async () => {
		await new Promise(r => setTimeout(r, 1500));
	});
}`,
			);
			writeFileSync(join(ws.dir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));

			const script = [
				{ tool: "monitor", args: { command: `tail -n +1 -F ${ws.watched}`, description: "gate watch" } },
				...Array.from({ length: 8 }, (_, i) => ({ text: `GATE_R${i + 1}` })),
			];

			const client = new RpcClient(bin, ws, script, [slowCompactPath, slowPeerPath]);
			await client.start();

			client.prompt("go");
			await client.waitForSettled(1);
			client.send({ type: "compact" });

			const compactStarted = join(ws.dir, "compact-started");
			const start = Date.now();
			while (!existsSync(compactStarted) && Date.now() - start < 10000) {
				await new Promise((r) => setTimeout(r, 50));
			}
			if (!existsSync(compactStarted)) throw new Error("Timed out waiting for compact-started");

			ws.appendWatched("GATE_LINE_1");
			await new Promise((r) => setTimeout(r, 500));
			writeFileSync(join(ws.dir, "release"), "1");

			await client.waitForSettled(2);
			await client.stop();

			const customMsgs = client.events.filter((e) => e.type === "message_start" && e.message?.customType === "rbf-monitor");
			expect(customMsgs.length).toBe(1);
		}, 35000);

		it("RPC, slow-peer run with second line: both lines delivered after compaction", async () => {
			const slowCompactPath = join(ws.dir, "slow-compact.ts");
			writeFileSync(
				slowCompactPath,
				`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
export default function slowCompact(pi: ExtensionAPI): void {
	pi.on("session_before_compact", async (event: any) => {
		const dir = process.env.PI_CODING_AGENT_DIR!;
		fs.writeFileSync(path.join(dir, "compact-started"), "1");
		const releasePath = path.join(dir, "release");
		while (!fs.existsSync(releasePath)) {
			await new Promise(r => setTimeout(r, 50));
		}
		return { compaction: { summary: "GATE_SUMMARY", firstKeptEntryId: event.preparation?.firstKeptEntryId, tokensBefore: event.preparation?.tokensBefore } };
	});
}`,
			);
			const slowPeerPath = join(ws.dir, "slow-peer.ts");
			writeFileSync(
				slowPeerPath,
				`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function slowPeer(pi: ExtensionAPI): void {
	pi.on("session_compact", async () => {
		await new Promise(r => setTimeout(r, 1500));
	});
}`,
			);
			writeFileSync(join(ws.dir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));

			const script = [
				{ tool: "monitor", args: { command: `tail -n +1 -F ${ws.watched}`, description: "gate watch" } },
				...Array.from({ length: 8 }, (_, i) => ({ text: `GATE_R${i + 1}` })),
			];

			const client = new RpcClient(bin, ws, script, [slowCompactPath, slowPeerPath]);
			await client.start();

			client.prompt("go");
			await client.waitForSettled(1);
			client.send({ type: "compact" });

			const compactStarted = join(ws.dir, "compact-started");
			const start = Date.now();
			while (!existsSync(compactStarted) && Date.now() - start < 10000) {
				await new Promise((r) => setTimeout(r, 50));
			}
			if (!existsSync(compactStarted)) throw new Error("Timed out waiting for compact-started");

			ws.appendWatched("GATE_LINE_1");
			writeFileSync(join(ws.dir, "release"), "1");
			await new Promise((r) => setTimeout(r, 500));
			ws.appendWatched("GATE_LINE_2");

			await client.waitForSettled(2);
			await client.stop();

			const customMsg = ws.findCustomMessages()[0];
			expect(customMsg?.content).toContain("GATE_LINE_1");
			expect(customMsg?.content).toContain("GATE_LINE_2");
		}, 35000);

		it("PTY, Esc on compaction: holds custom message until prompt next", async () => {
			const slowCompactPath = join(ws.dir, "slow-compact.ts");
			writeFileSync(
				slowCompactPath,
				`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
export default function slowCompact(pi: ExtensionAPI): void {
	pi.on("session_before_compact", async (event: any) => {
		const dir = process.env.PI_CODING_AGENT_DIR!;
		fs.writeFileSync(path.join(dir, "compact-started"), "1");
		const releasePath = path.join(dir, "release");
		while (!fs.existsSync(releasePath)) {
			await new Promise(r => setTimeout(r, 50));
		}
		return { compaction: { summary: "GATE_SUMMARY", firstKeptEntryId: event.preparation?.firstKeptEntryId, tokensBefore: event.preparation?.tokensBefore } };
	});
}`,
			);
			writeFileSync(join(ws.dir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));

			const script = [
				{ tool: "monitor", args: { command: `tail -n +1 -F ${ws.watched}`, description: "gate watch" } },
				...Array.from({ length: 8 }, (_, i) => ({ text: `GATE_R${i + 1}` })),
			];

			setTimeout(() => {
				const check = setInterval(() => {
					if (existsSync(join(ws.dir, "compact-started"))) {
						clearInterval(check);
						ws.appendWatched("GATE_LINE_1");
						setTimeout(() => writeFileSync(join(ws.dir, "release"), "1"), 2500);
					}
				}, 100);
			}, 2000);

			await drivePty(
				bin,
				ws,
				script,
				[
					{ wait: "ctrl\\+o more" },
					{ paste: "go" },
					{ key: "enter" },
					{ wait: "GATE_R1" },
					{ paste: "/compact" },
					{ key: "enter" },
					{ sleep: 2 },
					{ key: "escape" },
					{ sleep: 5 },
					{ paste: "next" },
					{ key: "enter" },
					{ wait: "GATE_R2" },
				],
				[slowCompactPath],
			);

			const customMsg = ws.findCustomMessages()[0];
			expect(customMsg?.content).toContain("GATE_LINE_1");
		}, 35000);
	});

	// ─── Scenario 19: Compaction before a prompt (Real Pi) ───────────────────
	describe("Scenario 19: compaction before a prompt", () => {
		it("RPC: compaction before prompt four keeps prompt four, custom message arrives once after", async () => {
			const slowCompactPath = join(ws.dir, "slow-compact.ts");
			writeFileSync(
				slowCompactPath,
				`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
export default function slowCompact(pi: ExtensionAPI): void {
	let postrun = false;
	pi.on("agent_end", () => { postrun = true; });
	pi.on("input", () => { postrun = false; });
	pi.on("session_before_compact", async (event: any) => {
		if (process.env.GATE_CANCEL_POSTRUN === "1" && postrun) {
			return { cancel: true };
		}
		const dir = process.env.PI_CODING_AGENT_DIR!;
		fs.writeFileSync(path.join(dir, "compact-started"), "1");
		const releasePath = path.join(dir, "release");
		while (!fs.existsSync(releasePath)) {
			await new Promise(r => setTimeout(r, 50));
		}
		return { compaction: { summary: "GATE_SUMMARY", firstKeptEntryId: event.preparation?.firstKeptEntryId, tokensBefore: event.preparation?.tokensBefore } };
	});
}`,
			);
			writeFileSync(join(ws.dir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));

			const script = [
				{ tool: "monitor", args: { command: `tail -n +1 -F ${ws.watched}`, description: "gate watch" } },
				{ text: "GATE_ARMED" },
				{ text: "GATE_BIG", usage: { input: 995000, totalTokens: 995000 } },
				{ text: "GATE_R3" },
				{ text: "GATE_R4" },
				{ text: "GATE_R5" },
			];

			const client = new RpcClient(bin, ws, script, [slowCompactPath], { GATE_CANCEL_POSTRUN: "1" });
			await client.start();

			client.prompt("go");
			await client.waitForSettled(1);
			client.prompt("more");
			await client.waitForSettled(2);

			client.prompt("four");
			const compactStarted = join(ws.dir, "compact-started");
			const start = Date.now();
			while (!existsSync(compactStarted) && Date.now() - start < 10000) {
				await new Promise((r) => setTimeout(r, 50));
			}
			if (!existsSync(compactStarted)) throw new Error("Timed out waiting for compact-started");

			ws.appendWatched("GATE_LINE_1");
			await new Promise((r) => setTimeout(r, 1000));
			writeFileSync(join(ws.dir, "release"), "1");

			await client.waitForSettled(3);
			await client.stop();

			const fourPrompt = ws.findUserMessages("four")[0];
			expect(fourPrompt).toBeDefined();
			const customMsg = ws.findCustomMessages()[0];
			expect(customMsg?.content).toContain("GATE_LINE_1");
		}, 35000);

		it("PTY: prompt four runs after compaction with monitor event row below it, no 'already processing'", async () => {
			const slowCompactPath = join(ws.dir, "slow-compact.ts");
			writeFileSync(
				slowCompactPath,
				`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
export default function slowCompact(pi: ExtensionAPI): void {
	let postrun = false;
	pi.on("agent_end", () => { postrun = true; });
	pi.on("input", () => { postrun = false; });
	pi.on("session_before_compact", async (event: any) => {
		if (process.env.GATE_CANCEL_POSTRUN === "1" && postrun) {
			return { cancel: true };
		}
		const dir = process.env.PI_CODING_AGENT_DIR!;
		fs.writeFileSync(path.join(dir, "compact-started"), "1");
		const releasePath = path.join(dir, "release");
		while (!fs.existsSync(releasePath)) {
			await new Promise(r => setTimeout(r, 50));
		}
		return { compaction: { summary: "GATE_SUMMARY", firstKeptEntryId: event.preparation?.firstKeptEntryId, tokensBefore: event.preparation?.tokensBefore } };
	});
}`,
			);
			writeFileSync(join(ws.dir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));

			const script = [
				{ tool: "monitor", args: { command: `tail -n +1 -F ${ws.watched}`, description: "gate watch" } },
				{ text: "GATE_ARMED" },
				{ text: "GATE_BIG", usage: { input: 995000, totalTokens: 995000 } },
				{ text: "GATE_R3" },
				{ text: "GATE_R4" },
			];

			setTimeout(() => {
				const check = setInterval(() => {
					if (existsSync(join(ws.dir, "compact-started"))) {
						clearInterval(check);
						ws.appendWatched("GATE_LINE_1");
						setTimeout(() => writeFileSync(join(ws.dir, "release"), "1"), 1000);
					}
				}, 100);
			}, 3000);

			const { snapshots } = await drivePty(
				bin,
				ws,
				script,
				[
					{ wait: "ctrl\\+o more" },
					{ paste: "go" },
					{ key: "enter" },
					{ wait: "GATE_ARMED" },
					{ paste: "more" },
					{ key: "enter" },
					{ wait: "GATE_BIG" },
					{ sleep: 2 },
					{ paste: "four" },
					{ key: "enter" },
					{ sleep: 1 },
					{ snapshot: "during_compact" },
					{ wait: "GATE_LINE_1" },
					{ sleep: 3 },
					{ snapshot: "after_turn" },
				],
				[slowCompactPath],
				{ GATE_CANCEL_POSTRUN: "1" },
			);

			const screenText = snapshots["after_turn"]?.join("\n") ?? "";
			expect(screenText).not.toContain("Agent is already processing");
			expect(screenText).toContain("GATE_LINE_1");
		}, 35000);
	});

	// ─── Scenario 20: Typed prompt hold (Real Pi) ────────────────────────────
	describe("Scenario 20: typed prompt hold", () => {
		it("RPC: slow-start keeps prompt four and delivers event as steer inside it", async () => {
			const slowStartPath = join(ws.dir, "slow-start.ts");
			writeFileSync(
				slowStartPath,
				`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
export default function slowStart(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async () => {
		const dir = process.env.PI_CODING_AGENT_DIR!;
		fs.writeFileSync(path.join(dir, "start-seen"), "1");
		await new Promise(r => setTimeout(r, 1500));
	});
}`,
			);

			const script = [
				{ tool: "monitor", args: { command: `tail -n +1 -F ${ws.watched}`, description: "gate watch" } },
				{ text: "GATE_ARMED" },
				{ tool: "bash", args: { command: "sleep 4" } },
				{ text: "GATE_AFTER" },
				{ text: "GATE_R4" },
			];

			const client = new RpcClient(bin, ws, script, [slowStartPath]);
			await client.start();

			client.prompt("go");
			await client.waitForSettled(1);

			const startSeen = join(ws.dir, "start-seen");
			if (existsSync(startSeen)) rmSync(startSeen, { force: true });

			client.prompt("four");
			const start = Date.now();
			while (!existsSync(startSeen) && Date.now() - start < 10000) {
				await new Promise((r) => setTimeout(r, 50));
			}
			if (!existsSync(startSeen)) throw new Error("Timed out waiting for start-seen");

			ws.appendWatched("GATE_LINE_1");
			await client.waitForSettled(2);
			await client.stop();

			const fourPrompt = ws.findUserMessages("four")[0];
			expect(fourPrompt).toBeDefined();
			const customMsg = ws.findCustomMessages()[0];
			expect(customMsg?.content).toContain("GATE_LINE_1");
		}, 35000);

		it("PTY: slow-start screen never shows 'Agent is already processing'", async () => {
			const slowStartPath = join(ws.dir, "slow-start.ts");
			writeFileSync(
				slowStartPath,
				`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
export default function slowStart(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async () => {
		const dir = process.env.PI_CODING_AGENT_DIR!;
		fs.writeFileSync(path.join(dir, "start-seen"), "1");
		await new Promise(r => setTimeout(r, 1500));
	});
}`,
			);

			const script = [
				{ tool: "monitor", args: { command: `tail -n +1 -F ${ws.watched}`, description: "gate watch" } },
				{ text: "GATE_ARMED" },
				{ tool: "bash", args: { command: "sleep 4" } },
				{ text: "GATE_AFTER" },
			];

			const startSeen = join(ws.dir, "start-seen");
			const pollArmed = setInterval(() => {
				if (existsSync(join(ws.dir, "raw.bin"))) {
					const raw = readFileSync(join(ws.dir, "raw.bin"), "utf8");
					if (raw.includes("GATE_ARMED")) {
						clearInterval(pollArmed);
						if (existsSync(startSeen)) rmSync(startSeen, { force: true });
						const checkFour = setInterval(() => {
							if (existsSync(startSeen)) {
								clearInterval(checkFour);
								ws.appendWatched("GATE_LINE_1");
							}
						}, 50);
					}
				}
			}, 100);

			const { snapshots } = await drivePty(
				bin,
				ws,
				script,
				[
					{ wait: "ctrl\\+o more" },
					{ paste: "go" },
					{ key: "enter" },
					{ wait: "GATE_ARMED" },
					{ paste: "four" },
					{ key: "enter" },
					{ wait: "GATE_AFTER" },
					{ snapshot: "final" },
				],
				[slowStartPath],
			);

			const screenText = snapshots["final"]?.join("\n") ?? "";
			expect(screenText).not.toContain("Agent is already processing");
			expect(screenText).toContain("GATE_LINE_1");
		}, 35000);

		it("RPC: eat-input prompt holds event for 15 seconds before wake", async () => {
			const eatInputPath = join(ws.dir, "eat-input.ts");
			writeFileSync(
				eatInputPath,
				`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function eatInput(pi: ExtensionAPI): void {
	pi.on("input", async (event: any) => {
		if (event.text === "GATE_EAT") {
			return { action: "handled" };
		}
	});
}`,
			);

			const script = [
				{ tool: "monitor", args: { command: `tail -n +1 -F ${ws.watched}`, description: "gate watch" } },
				{ text: "GATE_ARMED" },
				{ text: "GATE_WOKE" },
			];

			const client = new RpcClient(bin, ws, script, [eatInputPath]);
			await client.start();

			client.prompt("go");
			await client.waitForSettled(1);

			const startIndex = client.events.length;
			const t0 = Date.now();
			client.prompt("GATE_EAT");
			await new Promise((r) => setTimeout(r, 500));
			ws.appendWatched("GATE_LINE_1");

			// Assert no agent_start for at least 14.5s
			await new Promise((r) => setTimeout(r, 14500));
			const earlyStart = client.events.slice(startIndex).find((e) => e.type === "agent_start");
			expect(earlyStart, "no agent_start during 14.5s hold").toBeUndefined();

			// Wait for agent_start to fire when 15s hold expires
			await client.waitForEvent(
				(e, idx) => idx >= startIndex && e.type === "agent_start",
				10000,
			);
			const elapsed = Date.now() - t0;
			expect(elapsed).toBeGreaterThanOrEqual(14500);
			expect(elapsed).toBeLessThanOrEqual(17500);

			const customMsg = client.events.slice(startIndex).find((e) => e.type === "message_start" && e.message?.customType === "rbf-monitor");
			expect(customMsg?.message?.content).toContain("GATE_LINE_1");
			await client.stop();
		}, 60000);
	});

	// ─── Scenario 21: Stop during a turn (Real Pi) ───────────────────────────
	describe("Scenario 21: stop during a turn", () => {
		it("RPC: /monitors stop all during turn delivers notice as steer before next reply, kills watch", async () => {
			const script = [
				{ tool: "monitor", args: { command: `tail -n +1 -F ${ws.watched}`, description: "gate watch" } },
				{ text: "GATE_ARMED" },
				{ tool: "bash", args: { command: "sleep 6" } },
				{ text: "GATE_AFTER" },
				{ text: "GATE_R4" },
				{ text: "GATE_R5" },
			];

			const client = new RpcClient(bin, ws, script);
			await client.start();

			client.prompt("go");
			await client.waitForSettled(1);

			client.prompt("work");
			await client.waitForEvent((e) => e.type === "tool_execution_start" && e.toolName === "bash");
			await new Promise((r) => setTimeout(r, 1500));

			client.prompt("/monitors stop all");
			await new Promise((r) => setTimeout(r, 1000));
			ws.appendWatched("GATE_LINE_1");

			await client.waitForSettled(2);

			client.prompt("next");
			await client.waitForSettled(3);
			client.prompt("next");
			await client.waitForSettled(4);
			await client.stop();

			const customMsgs = client.events.filter((e) => e.type === "message_start" && e.message?.customType === "rbf-monitor");
			expect(customMsgs.length).toBe(1);
			expect(customMsgs[0]?.message?.content).toContain('was stopped by Tomek from /monitors after 0 events. Ask him before you re-arm it.');
		}, 35000);

		it("RPC: session file holds ended entry between bash call and result, announced after result", async () => {
			const script = [
				{ tool: "monitor", args: { command: `tail -n +1 -F ${ws.watched}`, description: "gate watch" } },
				{ text: "GATE_ARMED" },
				{ tool: "bash", args: { command: "sleep 6" } },
				{ text: "GATE_AFTER" },
			];

			const client = new RpcClient(bin, ws, script);
			await client.start();

			client.prompt("go");
			await client.waitForSettled(1);

			client.prompt("work");
			await client.waitForEvent((e) => e.type === "tool_execution_start" && e.toolName === "bash");
			await new Promise((r) => setTimeout(r, 1500));
			client.prompt("/monitors stop all");

			await client.waitForSettled(2);
			await client.stop();

			const entries = ws.readSessionEntries();
			const ended = entries.find((e) => e.data?.kind === "ended" && e.data?.reason === "user_stop");
			expect(ended, "ended entry in session file").toBeDefined();
			const announced = entries.find((e) => e.data?.kind === "announced" && e.data?.reason === "user_stop");
			expect(announced, "announced entry in session file").toBeDefined();
		}, 35000);

		it("PTY: /monitors stop all during turn draws Stopped notice and stopped row", async () => {
			const script = [
				{ tool: "monitor", args: { command: `tail -n +1 -F ${ws.watched}`, description: "gate watch" } },
				{ text: "GATE_ARMED" },
				{ tool: "bash", args: { command: "sleep 6" } },
				{ text: "GATE_AFTER" },
			];

			const { snapshots } = await drivePty(bin, ws, script, [
				{ wait: "ctrl\\+o more" },
				{ paste: "go" },
				{ key: "enter" },
				{ wait: "GATE_ARMED" },
				{ paste: "work" },
				{ key: "enter" },
				{ wait: "sleep 6" },
				{ sleep: 1.5 },
				{ paste: "/monitors stop all" },
				{ key: "enter" },
				{ snapshot: "during_turn" },
				{ wait: "GATE_AFTER" },
				{ snapshot: "after_turn" },
			]);

			expect(snapshots["during_turn"]?.join("\n")).toContain("Stopped 1 watch.");
			expect(snapshots["after_turn"]?.join("\n")).toContain("monitor stopped · gate watch");
		}, 35000);

		it("RPC: /monitors stop all while idle starts no turn, delivers notice with next prompt", async () => {
			const script = [
				{ tool: "monitor", args: { command: `tail -n +1 -F ${ws.watched}`, description: "gate watch" } },
				{ text: "GATE_ARMED" },
				{ text: "GATE_NEXT_1" },
				{ text: "GATE_NEXT_2" },
			];

			const client = new RpcClient(bin, ws, script);
			await client.start();

			client.prompt("go");
			await client.waitForSettled(1);

			client.prompt("/monitors stop all");
			await new Promise((r) => setTimeout(r, 3000));

			const turnsBeforeNext = client.events.filter((e) => e.type === "agent_start").length;
			expect(turnsBeforeNext).toBe(1); // No new turn started!

			client.prompt("next");
			await client.waitForSettled(2);
			client.prompt("next");
			await client.waitForSettled(3);
			await client.stop();

			const customMsgs = ws.findCustomMessages();
			expect(customMsgs.length).toBe(1);
			expect(customMsgs[0]?.content).toContain("was stopped by Tomek from /monitors after 0 events");
		}, 35000);
	});

	// ─── Scenario 22: Owed across a quit (Real Pi) ───────────────────────────
	describe("Scenario 22: owed across a quit", () => {
		it("RPC: deadline notice cleared by Esc survives quit, announced once on session resume", async () => {
			const script = [
				{ tool: "monitor", args: { command: `tail -n +1 -F ${ws.watched}`, description: "gate watch", timeout_ms: 3000 } },
				{ text: "GATE_ARMED" },
				{ tool: "bash", args: { command: "sleep 10" } },
				{ text: "GATE_R3" },
				{ text: "GATE_R4" },
				{ text: "GATE_R5" },
				{ text: "GATE_R6" },
			];

			// First run
			const client1 = new RpcClient(bin, ws, script);
			await client1.start();
			client1.prompt("go");
			await client1.waitForSettled(1);

			client1.prompt("work");
			await client1.waitForEvent((e) => e.type === "tool_execution_start" && e.toolName === "bash");

			// Poll session file for ended entry
			const start = Date.now();
			let foundEnded = false;
			while (Date.now() - start < 10000) {
				const entries = ws.readSessionEntries();
				if (entries.some((e) => e.data?.kind === "ended")) {
					foundEnded = true;
					break;
				}
				await new Promise((r) => setTimeout(r, 50));
			}
			if (!foundEnded) throw new Error("Timed out waiting for ended entry in session file");

			await new Promise((r) => setTimeout(r, 1000));
			client1.send({ type: "clear_queue" });
			client1.send({ type: "abort" });
			await new Promise((r) => setTimeout(r, 2000));
			await client1.stop();

			const entriesRun1 = ws.readSessionEntries();
			const endedRun1 = entriesRun1.find((e) => e.data?.kind === "ended" && e.data?.reason === "deadline");
			expect(endedRun1, "ended entry after run 1").toBeDefined();
			expect(entriesRun1.find((e) => e.data?.kind === "announced")).toBeUndefined();

			// Second run with --continue
			const client2 = new RpcClient(bin, ws, script, [], {}, ["--continue"]);
			await client2.start();
			client2.prompt("back");
			await client2.waitForSettled(1);
			client2.prompt("back");
			await client2.waitForSettled(2);
			await client2.stop();

			const entriesRun2 = ws.readSessionEntries();
			const customMsgs = entriesRun2.filter((e) => e.type === "custom_message" && e.customType === "rbf-monitor");
			expect(customMsgs.length, "custom deadline notice in run 2").toBe(1);
			expect(customMsgs[0]?.content).toContain("reached its 3-second deadline and stopped after 0 events");
			const announced = entriesRun2.filter((e) => e.data?.kind === "announced" && e.data?.reason === "deadline");
			expect(announced.length, "announced entry in run 2").toBe(1);

			// Third run with --continue
			const client3 = new RpcClient(bin, ws, script, [], {}, ["--continue"]);
			await client3.start();
			client3.prompt("back");
			await client3.waitForSettled(1);
			await client3.stop();

			const entriesRun3 = ws.readSessionEntries();
			const customMsgs3 = entriesRun3.filter((e) => e.type === "custom_message" && e.customType === "rbf-monitor");
			expect(customMsgs3.length).toBe(1);
		}, 45000);

		it("PTY: deadline notice cleared by Esc draws on resume screen", async () => {
			const script = [
				{ tool: "monitor", args: { command: `tail -n +1 -F ${ws.watched}`, description: "gate watch", timeout_ms: 3000 } },
				{ text: "GATE_ARMED" },
				{ tool: "bash", args: { command: "sleep 10" } },
				{ text: "GATE_R3" },
				{ text: "GATE_R4" },
			];

			await drivePty(bin, ws, script, [
				{ wait: "ctrl\\+o more" },
				{ paste: "go" },
				{ key: "enter" },
				{ wait: "GATE_ARMED" },
				{ paste: "work" },
				{ key: "enter" },
				{ sleep: 4.5 },
				{ key: "escape" },
				{ sleep: 2 },
				{ paste: "/quit" },
				{ key: "enter" },
			]);

			const { snapshots } = await drivePty(
				bin,
				ws,
				script,
				[
					{ wait: "ctrl\\+o more" },
					{ paste: "back" },
					{ key: "enter" },
					{ wait: "Reached its 3-second deadline" },
					{ snapshot: "resume" },
				],
				[],
				{},
				["--continue"],
			);

			const screenText = snapshots["resume"]?.join("\n") ?? "";
			expect(screenText).toContain("Reached its 3-second deadline after 0 events");
		}, 60000);
	});
});
