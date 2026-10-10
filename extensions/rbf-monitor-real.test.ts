// pi-44.1: the delivery rules of `monitor`, in a real Pi with a scripted provider (no model, no paid call).
// Scenarios 10, 16, 19, 20, 21 and 22 of the pi-44 brief's `15_verification.md`; a test name's `15:N` is the
// line of the bullet it checks. Run once per Pi version: the project's, and RBF_PI_BIN for the daily one.
//
// How a test waits:
// - `marker` and `seen` find a moment the test itself sets up. They throw `setup: …` when they run out.
// - A wait only the feature can satisfy is an assertion: it returns nothing when it runs out, and the
//   `expect` under it names the bullet. In a pty plan such a wait carries `needs`.
// RBF_KEEP_TMP=1 leaves each test's temp folder, with the RPC events and the pty bytes, and prints its path.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import readline from "node:readline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const SUPPORT = resolve(import.meta.dirname, "test-support");
const DRIVER = join(SUPPORT, "rbf-row-gate-drive.py");
const PROVIDER = join(SUPPORT, "rbf-row-gate-provider.ts");
const MONITOR = join(ROOT, "extensions", "rbf-monitor.ts");
const PI = process.env.RBF_PI_BIN ?? join(ROOT, "node_modules", ".bin", "pi");
const READY = existsSync(PI) && spawnSync("python3", ["--version"]).status === 0;
const VERSION = READY ? spawnSync(PI, ["--version"], { encoding: "utf8" }).stdout.trim() : "missing";
const KEEP = process.env.RBF_KEEP_TMP === "1";
const COLS = 100;
const CUSTOM_TYPE = "rbf-monitor";
/** The shared setup's limit for a real-Pi test. */
const LIMIT = 30_000;
const ISOLATED = ["--no-extensions", "--no-skills", "--no-themes", "--no-context-files", "--no-prompt-templates"];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sleepUntil = (at: number) => sleep(Math.max(0, at - Date.now()));

/** A setup check: what the test arranged didn't happen. Never a verdict on the feature. */
function setup(condition: unknown, what: string): asserts condition {
	if (!condition) throw new Error(`setup: ${what}`);
}

/** A marker poll given up because the run it belonged to had already ended. */
class RunOver extends Error {}

/** Poll for a moment the test sets up. It throws when it runs out; it never falls through. */
async function marker<T>(what: string, look: () => T | undefined | null | false, timeoutMs = 10_000, over: () => boolean = () => false): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const got = look();
		if (got) return got;
		if (over()) throw new RunOver(`setup: ${what} not seen before the run ended`);
		if (Date.now() > end) throw new Error(`setup: ${what} not seen within ${timeoutMs} ms`);
		await sleep(25);
	}
}

/** Poll for something only the feature gives, until `deadline`. Returns nothing when it runs out: the caller's `expect` names the bullet. */
async function awaited<T>(look: () => T | undefined | null | false, deadline: number): Promise<T | undefined> {
	for (;;) {
		const got = look();
		if (got) return got;
		if (Date.now() > deadline) return undefined;
		await sleep(25);
	}
}

// ─── What the tests look for ───────────────────────────────────────────────

type Entry = Record<string, any>;
type Seen = Record<string, any> & { __at: number; __i: number };

const texts = (m: any): string[] => (Array.isArray(m?.content) ? m.content : []).filter((b: any) => b?.type === "text").map((b: any) => b.text as string);
/** A custom message's content, as one string. */
const said = (content: unknown): string => (typeof content === "string" ? content : texts({ content }).join("\n"));

// In the session file.
const isUser = (text: string) => (e: Entry) => e.type === "message" && e.message?.role === "user" && texts(e.message).includes(text);
const isToolCall = (name: string, command?: string) => (e: Entry) =>
	e.type === "message" && e.message?.role === "assistant" && (e.message.content ?? []).some((b: any) => b.type === "toolCall" && b.name === name && (command === undefined || b.arguments?.command === command));
const isToolResult = (name: string) => (e: Entry) => e.type === "message" && e.message?.role === "toolResult" && e.message.toolName === name;
const isReply = (e: Entry) => e.type === "message" && e.message?.role === "assistant" && texts(e.message).length > 0;
const isNotice = (e: Entry) => e.type === "custom_message" && e.customType === CUSTOM_TYPE;
const isRecord = (kind: string) => (e: Entry) => e.type === "custom" && e.customType === CUSTOM_TYPE && e.data?.kind === kind;
const isCompaction = (e: Entry) => e.type === "compaction";
/** The task id is random: it's read from the `armed` entry. */
const armedId = (entries: Entry[]): string | undefined => entries.find(isRecord("armed"))?.data?.id;
/** Every place a watched line sits in the file's custom messages: [entry index, offset in its content]. */
function places(entries: Entry[], line: string): Array<[number, number]> {
	const found: Array<[number, number]> = [];
	entries.forEach((e, i) => {
		if (!isNotice(e)) return;
		const content = said(e.content);
		for (let at = content.indexOf(line); at !== -1; at = content.indexOf(line, at + 1)) found.push([i, at]);
	});
	return found;
}
const before = (a: [number, number], b: [number, number]) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

// On the RPC event stream.
const onAgentStart = (e: Seen) => e.type === "agent_start";
const onAgentEnd = (e: Seen) => e.type === "agent_end";
const onSettled = (e: Seen) => e.type === "agent_settled";
const onToolStart = (name: string) => (e: Seen) => e.type === "tool_execution_start" && e.toolName === name;
const onToolResult = (name: string) => (e: Seen) => e.type === "message_end" && e.message?.role === "toolResult" && e.message?.toolName === name;
const onAssistant = (e: Seen) => e.type === "message_end" && e.message?.role === "assistant";
const onNotice = (e: Seen) => e.type === "message_end" && e.message?.role === "custom" && e.message?.customType === CUSTOM_TYPE;
const onNotify = (message: string) => (e: Seen) => e.type === "extension_ui_request" && e.method === "notify" && e.message === message;

// What the design says each message reads.
const eventText = (id: unknown, line: string) => `Monitor event from "gate watch" (task ${id}):\n${line}`;
const stoppedText = (id: unknown) => `Monitor "gate watch" (task ${id}) was stopped by Tomek from /monitors after 0 events. Ask him before you re-arm it.`;
const deadlineText = (id: unknown) => `Monitor "gate watch" (task ${id}) reached its 3-second deadline and stopped after 0 events. Re-arm it if you still need the watch.`;
const EVENT_ROW = "monitor event · gate watch";
const STOPPED_ROW = "monitor stopped · gate watch";
/** A scripted reply's row. After an abort which step answers isn't fixed, so no test names one. */
const ANY_REPLY = /GATE_(R\d|END)\b/;

// ─── The helper extensions of the shared setup ─────────────────────────────

const HELPERS = {
	// Writes $T/compact-started, waits for $T/release, then returns the summary. With GATE_CANCEL_POSTRUN=1 it
	// cancels an automatic compaction that starts before the run's agent_settled.
	"slow-compact.ts": `import * as fs from "node:fs";
import * as path from "node:path";
export default function slowCompact(pi: any): void {
	const dir = process.env.PI_CODING_AGENT_DIR!;
	let postrun = false;
	pi.on("agent_end", () => { postrun = true; });
	pi.on("agent_settled", () => { postrun = false; });
	pi.on("session_before_compact", async (event: any) => {
		if (process.env.GATE_CANCEL_POSTRUN === "1" && postrun) return { cancel: true };
		fs.writeFileSync(path.join(dir, "compact-started"), "1");
		while (!fs.existsSync(path.join(dir, "release"))) await new Promise((r) => setTimeout(r, 25));
		return { compaction: { summary: "GATE_SUMMARY", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
	});
}
`,
	"slow-peer.ts": `export default function slowPeer(pi: any): void {
	pi.on("session_compact", async () => { await new Promise((r) => setTimeout(r, 1500)); });
}
`,
	"slow-start.ts": `import * as fs from "node:fs";
import * as path from "node:path";
export default function slowStart(pi: any): void {
	pi.on("before_agent_start", async () => {
		fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "start-seen"), "1");
		await new Promise((r) => setTimeout(r, 1500));
	});
}
`,
	"eat-input.ts": `export default function eatInput(pi: any): void {
	pi.on("input", (event: any) => { if (event.text === "GATE_EAT") return { action: "handled" }; });
}
`,
};

/** One isolated Pi's folder: `$T` of the shared setup. */
class Workspace {
	readonly dir = mkdtempSync(join(tmpdir(), "pi44-real-"));
	readonly sessions = join(this.dir, "sessions");
	readonly work = join(this.dir, "work");
	readonly watched = join(this.dir, "watched.txt");
	private runs = 0;

	constructor() {
		for (const d of [this.sessions, this.work]) mkdirSync(d);
		writeFileSync(this.watched, "");
	}

	path(name: string): string {
		return join(this.dir, name);
	}
	has(name: string): boolean {
		return existsSync(this.path(name));
	}
	touch(name: string): void {
		writeFileSync(this.path(name), "1");
	}
	/** Append one watched line. Appended, never rewritten: `tail -F` reads a rewritten file again from its top. */
	append(line: string): void {
		appendFileSync(this.watched, `${line}\n`);
	}
	helper(name: keyof typeof HELPERS): string {
		writeFileSync(this.path(name), HELPERS[name]);
		return this.path(name);
	}
	/** Keep the last reply through a compaction, so the provider's count is 1 after it and step 0 isn't picked again. */
	keepLastReply(): void {
		writeFileSync(this.path("settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
	}
	/** The session file's lines. A run and its `--continue` runs share one file. */
	entries(): Entry[] {
		const files = readdirSync(this.sessions).filter((f) => f.endsWith(".jsonl"));
		setup(files.length <= 1, `one session file expected, found ${files.length}`);
		if (files.length === 0) return [];
		return readFileSync(join(this.sessions, files[0]!), "utf8")
			.split("\n")
			.filter(Boolean)
			.flatMap((line) => {
				try {
					return [JSON.parse(line) as Entry];
				} catch {
					return []; // the line Pi is writing right now
				}
			});
	}
	nextRun(): number {
		return ++this.runs;
	}
	cleanup(): void {
		if (KEEP) console.log(`[RBF_KEEP_TMP=1] kept ${this.dir}`);
		else rmSync(this.dir, { recursive: true, force: true });
	}
}

const monitorStep = (ws: Workspace, extra: Record<string, unknown> = {}) => ({ tool: "monitor", args: { command: `tail -n +1 -F ${ws.watched}`, description: "gate watch", ...extra } });
const replies = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ text: `GATE_R${from + i}` }));
const pgrep = (ws: Workspace) => spawnSync("pgrep", ["-f", ws.watched], { encoding: "utf8" }).stdout.trim();

type PiOptions = { extensions?: string[]; env?: Record<string, string>; args?: string[] };

const piEnv = (ws: Workspace, script: unknown[], extra: Record<string, string> = {}) => ({
	PI_CODING_AGENT_DIR: ws.dir,
	PI_OFFLINE: "1",
	PI_SKIP_VERSION_CHECK: "1",
	PI_HYPERLINKS: "0",
	PI_TELEMETRY: "0",
	RBF_ROW_GATE_SCRIPT: JSON.stringify(script),
	...extra,
});
const piArgs = (ws: Workspace, o: PiOptions) => [...ISOLATED, "--session-dir", ws.sessions, "-e", PROVIDER, "-e", MONITOR, ...(o.extensions ?? []).flatMap((e) => ["-e", e]), "--model", "rbf-gate/gate", ...(o.args ?? [])];

// ─── A real Pi in RPC mode ─────────────────────────────────────────────────

class RpcPi {
	/** Every event Pi wrote, stamped with when it arrived and where it sits in the stream. */
	readonly events: Seen[] = [];
	private child?: ChildProcess;
	private closed?: Promise<void>;
	private stderr = "";

	constructor(
		private readonly ws: Workspace,
		private readonly script: unknown[],
		private readonly options: PiOptions = {},
	) {}

	async start(): Promise<void> {
		const child = spawn(PI, [...piArgs(this.ws, this.options), "--mode", "rpc"], { cwd: this.ws.work, env: { ...process.env, ...piEnv(this.ws, this.script, this.options.env) }, stdio: ["pipe", "pipe", "pipe"] });
		this.child = child;
		this.closed = new Promise((done) => child.once("close", () => done()));
		child.on("error", (e) => (this.stderr += `\nspawn error: ${e.message}`));
		child.stderr!.on("data", (d) => (this.stderr += d));
		readline.createInterface({ input: child.stdout! }).on("line", (line) => {
			try {
				const e = JSON.parse(line);
				this.events.push(Object.assign(e, { __at: Date.now(), __i: this.events.length }));
			} catch {}
		});
		// Ready when Pi answers a command, not after a fixed sleep.
		this.send({ type: "get_state", id: "ready" });
		await this.seen("Pi's answer to get_state", (e) => e.type === "response" && e.command === "get_state", 0, 20_000);
	}

	send(command: object): void {
		this.child!.stdin!.write(`${JSON.stringify(command)}\n`);
	}
	/** A prompt with no `streamingBehavior`. A slash command is sent the same way. */
	prompt(message: string): void {
		this.send({ type: "prompt", message });
	}
	/** Esc in RPC: clear the queue, then abort. Returns where the stream stood. */
	esc(): number {
		const at = this.mark;
		this.send({ type: "clear_queue" });
		this.send({ type: "abort" });
		return at;
	}
	/** Where the stream stands now: events from here on are the ones that follow. */
	get mark(): number {
		return this.events.length;
	}
	since(from: number, pred: (e: Seen) => boolean, to = this.events.length): Seen[] {
		return this.events.slice(from, to).filter(pred);
	}
	/** A moment the test sets up, on the stream. Throws when it doesn't come. */
	seen(what: string, pred: (e: Seen) => boolean, from = 0, timeoutMs = 10_000): Promise<Seen> {
		return marker(`${what} on the RPC stream${this.stderr ? ` (stderr: ${this.stderr.trim().slice(-300)})` : ""}`, () => this.events.slice(from).find(pred), timeoutMs);
	}
	/** Send a prompt and wait for its run to settle. Returns where the stream stood when it was sent. */
	async run(message: string, timeoutMs = 10_000): Promise<number> {
		const at = this.mark;
		this.prompt(message);
		await this.seen(`agent_settled after the prompt ${JSON.stringify(message)}`, onSettled, at, timeoutMs);
		return at;
	}
	/** Something only the feature sends, awaited until `deadline` plus the time a stream line takes to arrive. */
	until(pred: (e: Seen) => boolean, from: number, deadline: number): Promise<Seen | undefined> {
		return awaited(() => this.events.slice(from).find(pred), deadline + 150);
	}

	/** End Pi and wait for it to exit. */
	async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
		const child = this.child;
		if (!child) return;
		if (child.exitCode === null && child.signalCode === null) {
			child.kill(signal);
			const force = setTimeout(() => child.kill("SIGKILL"), 3000);
			await this.closed;
			clearTimeout(force);
		}
		if (KEEP) writeFileSync(this.ws.path(`rpc-events-${this.ws.nextRun()}.jsonl`), this.events.map((e) => JSON.stringify(e)).join("\n"));
	}
}

/** Start one Pi in RPC mode, run the body, and stop Pi whatever the body did. */
async function withRpc<T>(ws: Workspace, script: unknown[], options: PiOptions, body: (pi: RpcPi) => Promise<T>): Promise<T> {
	const pi = new RpcPi(ws, script, options);
	try {
		await pi.start();
		return await body(pi);
	} finally {
		await pi.stop();
	}
}

// ─── A real Pi under a pty ─────────────────────────────────────────────────

/** A plan step. A `wait` only the feature can satisfy carries `needs`: the bullet it checks. */
type Step = { wait: string; count?: number; timeout?: number; needs?: string } | { paste: string } | { key: string } | { sleep: number } | { snapshot: string };
type PtyRun = { raw: Buffer; stream: string; snapshots: Record<string, string[]>; missed?: string };
type PtyOptions = PiOptions & { timeout?: number; beside?: (over: () => boolean) => Promise<void> };

const ESCAPES = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]|\r/g;

/** Replay the stream into screen rows, as `rbf-tool-parts-indent-pty.test.ts` does. */
function screen(raw: Buffer): string[] {
	const rows: string[] = [""];
	let row = 0;
	let restart = false; // after CR, LF, or a move to column 1 the next thing written replaces the row
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

/** The rows where `header` is the whole row, in screen order. */
const rowsAt = (rows: string[], header: string) => rows.flatMap((r, i) => (r.trim() === header ? [i] : []));
const lastRow = (rows: string[], pred: (row: string) => boolean) => rows.reduce((at, r, i) => (pred(r) ? i : at), -1);

/**
 * Run one plan against an isolated Pi in regular screen mode, with the test's own work `beside` it.
 * The driver ends Pi and waits for it. A `needs` wait that runs out comes back as `missed`; any other
 * failure, the driver's or the beside task's, throws as a setup error.
 */
async function drive(ws: Workspace, script: unknown[], steps: Step[], options: PtyOptions = {}): Promise<PtyRun> {
	const out = ws.path(`pty-${ws.nextRun()}.bin`);
	const plan = {
		// Both versions take --tui-mode; 1.0.3 would start fullscreen without it.
		argv: [PI, "--approve", "--tui-mode", "regular", ...piArgs(ws, options)],
		cwd: ws.work,
		env: piEnv(ws, script, options.env),
		cols: COLS,
		rows: 40,
		timeout: options.timeout ?? 26, // under the test's own limit, so the driver always ends Pi itself
		out,
		steps: steps.map((s) => ("needs" in s ? { wait: s.wait, count: s.count, timeout: s.timeout ?? 6 } : s)),
	};
	let over = false;
	const beside = (options.beside?.(() => over) ?? Promise.resolve()).then(
		() => undefined,
		(e: unknown) => e as Error,
	);
	const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
		const child = spawn("python3", [DRIVER], { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", reject);
		child.on("close", (code) => done({ code, stdout, stderr }));
		child.stdin.end(JSON.stringify(plan));
	});
	over = true;
	const besideError = await beside;
	const raw = existsSync(out) ? readFileSync(out) : Buffer.alloc(0);
	const stream = raw.toString("utf8").replace(ESCAPES, "");
	if (code !== 0) {
		const failed = stderr.trim();
		const feature = steps.find((s): s is Extract<Step, { wait: string }> => "needs" in s && s.needs !== undefined && failed.includes(`timed out waiting for ${pythonRepr(s.wait)}`));
		// A beside task that only gave up because this wait ended the run says nothing more than the wait does.
		if (feature && besideError && !(besideError instanceof RunOver)) throw besideError;
		if (feature) return { raw, stream, snapshots: {}, missed: `${feature.needs}: the screen never showed ${JSON.stringify(feature.wait)} (${failed})` };
		throw besideError ?? new Error(`setup: pty driver exited ${code}: ${failed}\n${screen(raw).slice(-40).join("\n")}`);
	}
	if (besideError) throw besideError;
	const offsets = JSON.parse(stdout) as Record<string, number>;
	return { raw, stream, snapshots: Object.fromEntries(Object.entries(offsets).map(([name, offset]) => [name, screen(raw.subarray(0, offset))])) };
}
/** How the driver's failure line quotes a wait: Python's repr of a str. */
const pythonRepr = (s: string) => (s.includes("'") && !s.includes('"') ? `"${s}"` : `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`);

const START: Step[] = [{ wait: "ctrl\\+o more" }];
const typed = (text: string): Step[] => [{ paste: text }, { key: "enter" }];

// ─── Scenarios 10, 16, 19, 20, 21, 22 ──────────────────────────────────────

describe.skipIf(!READY)(`rbf-monitor real-Pi delivery scenarios, Pi ${VERSION}`, () => {
	let ws: Workspace;

	beforeEach(() => {
		ws = new Workspace();
	});
	afterEach(() => {
		// Pi is gone by now. A watch command it left behind is still this test's: its arguments name this test's own temp file.
		const left = pgrep(ws);
		if (left) {
			spawnSync("pkill", ["-9", "-f", ws.watched]);
			console.warn(`[rbf-monitor-real] Pi left a watch command running, killed: pid ${left.split("\n").join(", ")}`);
		}
		ws.cleanup();
	});

	// ─── Scenario 10 ─────────────────────────────────────────────────────────
	describe("Scenario 10: esc keeps the event", () => {
		const script = () => [monitorStep(ws), { tool: "bash", args: { command: "sleep 10" } }, ...replies(1, 4)];

		/** Send `go` and wait until the scripted `sleep 10` runs, with the `monitor` call behind it. */
		async function untilBashRuns(pi: RpcPi): Promise<void> {
			pi.prompt("go");
			await pi.seen("the monitor tool call", onToolStart("monitor"));
			await pi.seen("tool_execution_start for bash", onToolStart("bash"));
		}
		/** The shared RPC steps: a line during `sleep 10`, Esc a second later, then 3 quiet seconds. */
		async function lineThenEsc(pi: RpcPi): Promise<number> {
			await untilBashRuns(pi);
			await sleep(1000);
			ws.append("GATE_LINE_1");
			await sleep(1000);
			const esc = pi.esc();
			await pi.seen("the aborted bash result", (e) => e.type === "tool_execution_end" && e.toolName === "bash" && e.isError === true, esc);
			const end = await pi.seen("agent_end after the abort", onAgentEnd, esc);
			await pi.seen("agent_settled after the abort", onSettled, esc);
			await sleepUntil(end.__at + 3000);
			expect(pi.since(0, onNotice), "15:192 after clear_queue and abort the stream shows agent_end and no custom message").toHaveLength(0);
			expect(pi.since(esc, onAgentStart), "15:192 and for 3 seconds no agent_start: Esc starts no turn").toHaveLength(0);
			return esc;
		}

		it(
			"15:192 RPC, a line first: the next line wakes Pi with the kept event first, in one message, once",
			() =>
				withRpc(ws, script(), {}, async (pi) => {
					await lineThenEsc(pi);

					const line2 = pi.mark;
					const line2At = Date.now();
					ws.append("GATE_LINE_2");
					const start = await pi.until(onAgentStart, line2, line2At + 1000);
					expect(start, "15:192 within 1 second of appending GATE_LINE_2: agent_start").toBeDefined();
					expect(start!.__at - line2At, "15:192 within 1 second").toBeLessThanOrEqual(1000);
					const notice = await pi.until(onNotice, start!.__i, line2At + 1000);
					expect(notice, "15:192 then a custom message, within that second").toBeDefined();
					const id = armedId(ws.entries());
					expect(said(notice!.message.content), "15:192 GATE_LINE_1's event text, a blank line, then GATE_LINE_2's").toBe(`${eventText(id, "GATE_LINE_1")}\n\n${eventText(id, "GATE_LINE_2")}`);
					await pi.seen("agent_settled after the wake", onSettled, line2);
					expect(pi.since(0, onNotice), "15:192 exactly one custom message").toHaveLength(1);

					const next = await pi.run("next");
					await sleep(1000);
					expect(pi.since(next, onNotice), "15:192 after the prompt next, no custom message follows").toHaveLength(0);

					const entries = ws.entries();
					const [one, two] = [places(entries, "GATE_LINE_1"), places(entries, "GATE_LINE_2")];
					expect(one, "15:192 the session file holds GATE_LINE_1 once").toHaveLength(1);
					expect(two, "15:192 and GATE_LINE_2 once").toHaveLength(1);
					expect(before(one[0]!, two[0]!), "15:192 GATE_LINE_1 before GATE_LINE_2").toBe(true);
					expect(entries.filter(isUser("next")), "15:192 the user message next, once").toHaveLength(1);
					expect(two[0]![0], "15:192 both before the user message next").toBeLessThan(entries.findIndex(isUser("next")));
				}),
			LIMIT,
		);

		it(
			"15:193 RPC, a prompt first: next carries the kept event, and the later line arrives alone",
			() =>
				withRpc(ws, script(), {}, async (pi) => {
					await lineThenEsc(pi);

					await pi.run("next");
					let entries = ws.entries();
					const id = armedId(entries);
					const nextAt = entries.findIndex(isUser("next"));
					setup(entries.filter(isUser("next")).length === 1, "the user message next is in the session file once");
					expect(entries.filter(isNotice), "15:193 after next: one custom message with GATE_LINE_1").toHaveLength(1);
					const noticeAt = entries.findIndex(isNotice);
					expect(said(entries[noticeAt]!.content), "15:193 with GATE_LINE_1").toBe(eventText(id, "GATE_LINE_1"));
					expect(noticeAt, "15:193 the user message next, then the custom message").toBeGreaterThan(nextAt);
					expect(entries.slice(noticeAt + 1).some(isReply), "15:193 then a reply").toBe(true);

					const line2 = pi.mark;
					ws.append("GATE_LINE_2");
					const notice = await pi.until(onNotice, line2, Date.now() + 3000);
					expect(notice, "15:193 appending GATE_LINE_2 after that gives a custom message").toBeDefined();
					expect(said(notice!.message.content), "15:193 with GATE_LINE_2 alone").toBe(eventText(id, "GATE_LINE_2"));
					await pi.seen("agent_settled after the wake", onSettled, line2);
					await sleep(1000);
					expect(pi.since(line2, onNotice), "15:193 one custom message").toHaveLength(1);

					entries = ws.entries();
					expect(places(entries, "GATE_LINE_1"), "15:193 GATE_LINE_1 is in the file once").toHaveLength(1);
					expect(places(entries, "GATE_LINE_2"), "15:193 GATE_LINE_2 is in the file once").toHaveLength(1);
					expect(entries.filter(isNotice)).toHaveLength(2);
				}),
			LIMIT,
		);

		it(
			"15:194 RPC, a plain abort with no clear_queue: the event arrives right after the aborted bash result, once",
			() =>
				withRpc(ws, script(), {}, async (pi) => {
					await untilBashRuns(pi);
					await sleep(1000);
					ws.append("GATE_LINE_1");
					await sleep(1000);
					const abort = pi.mark;
					pi.send({ type: "abort" });
					const result = await pi.seen("the aborted bash result", onToolResult("bash"), abort);
					setup(texts(result.message).includes("Command aborted"), "the bash result reads Command aborted");

					const after = await pi.seen("a message after the aborted bash result", (e) => e.type === "message_end" && e.__i > result.__i, abort);
					expect(onNotice(after), "15:194 right after the aborted bash result: the custom message").toBe(true);
					expect(said(after.message.content), "15:194 with GATE_LINE_1").toBe(eventText(armedId(ws.entries()), "GATE_LINE_1"));
					await pi.seen("agent_settled after the abort", onSettled, abort);
					expect(pi.since(0, onNotice), "15:194 one custom message").toHaveLength(1);

					await pi.run("next");
					await sleep(1000);
					expect(pi.since(0, onNotice), "15:194 after the prompt next, no second copy appears").toHaveLength(1);
					expect(places(ws.entries(), "GATE_LINE_1"), "15:194 nor in the session file").toHaveLength(1);
				}),
			LIMIT,
		);

		it(
			"15:195 pty, a line first, Escape: no event row after the Esc, then both rows above the reply",
			async () => {
				const run = await drive(
					ws,
					script(),
					[
						...START,
						...typed("go"),
						{ wait: "sleep 10" },
						{ sleep: 2.5 },
						{ key: "escape" },
						{ sleep: 1.5 },
						{ snapshot: "after_esc" },
						{ sleep: 3.5 },
						{ wait: "GATE_LINE_2", needs: "15:195 the second append draws its row" },
						// The reply the rows sit above. Which step answers after an abort isn't fixed, so any reply will do.
						{ wait: ANY_REPLY.source, needs: "15:195 the wake's reply draws" },
						{ snapshot: "after_line_2" },
					],
					{
						beside: async (over) => {
							// GATE_LINE_1 a second after the bash call is in the session file; GATE_LINE_2 four seconds after its abort is.
							await marker("the bash call in the session file", () => ws.entries().some(isToolCall("bash", "sleep 10")), 15_000, over);
							await sleep(1000);
							ws.append("GATE_LINE_1");
							await marker("Command aborted in the session file", () => ws.entries().some((e) => isToolResult("bash")(e) && texts(e.message).includes("Command aborted")), 15_000, over);
							await sleep(4000);
							ws.append("GATE_LINE_2");
						},
					},
				);
				if (run.missed) expect.fail(run.missed);

				expect(run.snapshots.after_esc!.filter((r) => r.includes("monitor event")), "15:195 1.5 seconds after the Esc: no monitor event row").toEqual([]);
				const rows = run.snapshots.after_line_2!;
				const headers = rowsAt(rows, EVENT_ROW);
				expect(headers, "15:195 after the second append: two event rows").toHaveLength(2);
				expect(rows[headers[0]! + 1], "15:195 the first with GATE_LINE_1").toContain("GATE_LINE_1");
				expect(rows[headers[0]! + 2], "15:195 a blank row").toBe("");
				expect(headers[1], "15:195 then the second").toBe(headers[0]! + 3);
				expect(rows[headers[1]! + 1], "15:195 with GATE_LINE_2").toContain("GATE_LINE_2");
				expect(lastRow(rows, (r) => ANY_REPLY.test(r)), "15:195 both above the reply").toBeGreaterThan(headers[1]! + 1);
			},
			LIMIT,
		);
	});

	// ─── Scenario 16 ─────────────────────────────────────────────────────────
	describe("Scenario 16: compaction hold", () => {
		const script = () => [monitorStep(ws), ...replies(1, 8)];
		type Held = { pi: RpcPi; compact: number; started: Seen; ended: Seen; releasedAt: number };

		/** The shared RPC steps: three runs, a manual compaction held open while GATE_LINE_1 is printed, then its end. */
		function compactionHold(o: { slowPeer: boolean; secondLine: boolean }, body: (held: Held) => Promise<void>): Promise<void> {
			ws.keepLastReply();
			const extensions = [ws.helper("slow-compact.ts"), ...(o.slowPeer ? [ws.helper("slow-peer.ts")] : [])];
			return withRpc(ws, script(), { extensions }, async (pi) => {
				await pi.run("go");
				setup(pi.since(0, onToolStart("monitor")).length === 1, "the monitor tool was called once");
				await pi.run("more");
				await pi.run("more");

				const compact = pi.mark;
				pi.send({ type: "compact" });
				await marker("$T/compact-started", () => ws.has("compact-started"));
				const started = await pi.seen("compaction_start", (e) => e.type === "compaction_start", compact);
				ws.append("GATE_LINE_1");
				await sleep(1000);
				ws.touch("release");
				const releasedAt = Date.now();
				if (o.secondLine) {
					await sleep(500);
					ws.append("GATE_LINE_2");
				}
				const ended = await pi.seen("compaction_end", (e) => e.type === "compaction_end", compact);
				setup(ended.aborted === false && ended.result?.summary === "GATE_SUMMARY", "the compaction finished with the helper's summary");
				await body({ pi, compact, started, ended, releasedAt });
			});
		}

		/** 15:274, and "the same" of 15:275. */
		async function oneLineHeldThroughTheCompaction({ pi, started, ended }: Held, bullet: string): Promise<void> {
			expect(pi.since(started.__i, onAgentStart, ended.__i), `${bullet} between compaction_start and compaction_end: no agent_start`).toHaveLength(0);
			expect(pi.since(started.__i, onNotice, ended.__i), `${bullet} and no custom message`).toHaveLength(0);

			const start = await pi.until(onAgentStart, ended.__i, ended.__at + 1000);
			expect(start, `${bullet} within 1 second of compaction_end: agent_start`).toBeDefined();
			const notice = await pi.until(onNotice, start!.__i, ended.__at + 1000);
			expect(notice, `${bullet} then one custom message, within that second`).toBeDefined();
			expect(said(notice!.message.content), `${bullet} containing GATE_LINE_1`).toContain("GATE_LINE_1");
			const reply = await pi.until(onAssistant, notice!.__i, ended.__at + 1000);
			expect(reply, `${bullet} then an assistant message`).toBeDefined();
			for (const e of [start!, notice!, reply!]) expect(e.__at - ended.__at, `${bullet} within 1 second of compaction_end`).toBeLessThanOrEqual(1000);

			await pi.seen("agent_settled after the wake", onSettled, ended.__i);
			await sleep(1000);
			expect(pi.since(0, onNotice), `${bullet} no second copy follows`).toHaveLength(1);

			const entries = ws.entries();
			expect(entries.filter(isCompaction), `${bullet} the session file holds one compaction entry`).toHaveLength(1);
			expect(entries.filter(isNotice), `${bullet} that custom message once`).toHaveLength(1);
			expect(places(entries, "GATE_LINE_1")).toHaveLength(1);
			expect(entries.findIndex(isNotice), `${bullet} after the compaction entry`).toBeGreaterThan(entries.findIndex(isCompaction));
			expect(entries.filter(isRecord("armed")), `${bullet} exactly one armed entry: step 0 wasn't replayed`).toHaveLength(1);
		}

		it(
			"15:274 RPC: a line printed during a compaction starts nothing until compaction_end, then wakes Pi once",
			() => compactionHold({ slowPeer: false, secondLine: false }, (held) => oneLineHeldThroughTheCompaction(held, "15:274")),
			LIMIT,
		);

		it(
			"15:275 RPC, with slow-peer.ts: the same, and compaction_end comes 1.5 s after the release with no agent_start before it",
			() =>
				compactionHold({ slowPeer: true, secondLine: false }, async (held) => {
					const { pi, compact, ended, releasedAt } = held;
					expect(ended.__at - releasedAt, "15:275 compaction_end comes at least 1.5 seconds after $T/release was created").toBeGreaterThanOrEqual(1500);
					expect(pi.since(compact, onAgentStart, ended.__i), "15:275 with no agent_start before it").toHaveLength(0);
					await oneLineHeldThroughTheCompaction(held, "15:275 the same:");
				}),
			LIMIT,
		);

		it(
			"15:276 RPC, slow-peer with a second line: both lines wait for compaction_end and go out in one message",
			() =>
				compactionHold({ slowPeer: true, secondLine: true }, async ({ pi, compact, ended, releasedAt }) => {
					setup(ended.__at - releasedAt >= 1500, "the slow peer held compaction_end back, so GATE_LINE_2 was printed before it");
					expect(pi.since(compact, onAgentStart, ended.__i), "15:276 no agent_start comes before compaction_end").toHaveLength(0);

					const start = await pi.until(onAgentStart, ended.__i, ended.__at + 1000);
					expect(start, "15:276 within 1 second of compaction_end: agent_start").toBeDefined();
					const notice = await pi.until(onNotice, start!.__i, ended.__at + 1000);
					expect(notice, "15:276 then one custom message, within that second").toBeDefined();
					const id = armedId(ws.entries());
					expect(said(notice!.message.content), "15:276 GATE_LINE_1's event text, a blank line, then GATE_LINE_2's").toBe(`${eventText(id, "GATE_LINE_1")}\n\n${eventText(id, "GATE_LINE_2")}`);
					for (const e of [start!, notice!]) expect(e.__at - ended.__at, "15:276 within 1 second of compaction_end").toBeLessThanOrEqual(1000);

					await pi.seen("agent_settled after the wake", onSettled, ended.__i);
					await sleep(1000);
					expect(pi.since(ended.__i, onAgentStart), "15:276 one agent_start").toHaveLength(1);
					expect(pi.since(0, onNotice), "15:276 one custom message").toHaveLength(1);

					const entries = ws.entries();
					const compactionAt = entries.findIndex(isCompaction);
					const [one, two] = [places(entries, "GATE_LINE_1"), places(entries, "GATE_LINE_2")];
					expect(one, "15:276 the session file holds GATE_LINE_1 once").toHaveLength(1);
					expect(two, "15:276 and GATE_LINE_2 once").toHaveLength(1);
					expect(Math.min(one[0]![0], two[0]![0]), "15:276 both after the compaction entry").toBeGreaterThan(compactionAt);
					expect(entries.filter(isRecord("armed")), "15:41 exactly one armed entry: step 0 wasn't replayed").toHaveLength(1);
				}),
			LIMIT,
		);

		it(
			"15:277 pty, Esc on the compaction: the held event waits for the next prompt, and arrives with it once",
			async () => {
				ws.keepLastReply();
				let noticesThreeSecondsAfterRelease: number | undefined;
				const run = await drive(
					ws,
					script(),
					[
						...START,
						...typed("go"),
						{ wait: "GATE_R1" },
						...typed("more"),
						{ wait: "GATE_R2" },
						...typed("more"),
						{ wait: "GATE_R3" },
						...typed("/compact"),
						{ sleep: 2 },
						{ key: "escape" },
						{ sleep: 5 },
						...typed("next"),
						{ wait: "GATE_R4" }, // no turn was aborted, so the count is fixed: three replies and one tool result
					],
					{
						extensions: [ws.helper("slow-compact.ts")],
						beside: async (over) => {
							await marker("$T/compact-started", () => ws.has("compact-started"), 20_000, over);
							ws.append("GATE_LINE_1");
							await sleep(2500);
							ws.touch("release");
							await sleep(3000);
							noticesThreeSecondsAfterRelease = ws.entries().filter(isNotice).length;
							setup(!ws.entries().some(isUser("next")), "the session file was read before the prompt next");
						},
					},
				);
				if (run.missed) expect.fail(run.missed);
				const entries = ws.entries();
				setup(entries.filter(isToolCall("monitor")).length === 1, "the monitor tool was called once");
				setup(!entries.some(isCompaction), "Escape aborted the compaction: the session file holds no compaction entry");

				expect(noticesThreeSecondsAfterRelease, "15:277 no custom message 3 seconds after $T/release was created").toBe(0);
				const nextAt = entries.findIndex(isUser("next"));
				expect(entries.filter(isUser("next")), "15:277 after the prompt next: the user message next").toHaveLength(1);
				expect(entries.filter(isNotice), "15:277 then one custom message").toHaveLength(1);
				expect(said(entries.find(isNotice)!.content), "15:277 containing GATE_LINE_1").toContain("GATE_LINE_1");
				expect(places(entries, "GATE_LINE_1"), "15:277 once").toHaveLength(1);
				expect(entries.findIndex(isNotice), "15:277 after the user message next").toBeGreaterThan(nextAt);
				expect(entries.filter(isRecord("armed")), "15:41 exactly one armed entry: step 0 wasn't replayed").toHaveLength(1);
			},
			LIMIT,
		);
	});

	// ─── Scenario 19 ─────────────────────────────────────────────────────────
	describe("Scenario 19: compaction before a prompt", () => {
		const script = () => [monitorStep(ws), { text: "GATE_ARMED" }, { text: "GATE_BIG", usage: { input: 995000, totalTokens: 995000 } }, ...replies(3, 5)];
		const options = () => {
			ws.keepLastReply();
			return { extensions: [ws.helper("slow-compact.ts")], env: { GATE_CANCEL_POSTRUN: "1" } };
		};
		/** What the test does beside the prompt `four`: the line during the compaction, then its release. */
		async function lineDuringTheCompaction(over: () => boolean = () => false): Promise<void> {
			await marker("$T/compact-started", () => ws.has("compact-started"), 20_000, over);
			ws.append("GATE_LINE_1");
			await sleep(1000);
			ws.touch("release");
		}
		/** 15:307's session file, and "the same session file" of 15:308. */
		function expectThePromptKeptAndTheEventOnce(entries: Entry[], bullet: string): void {
			expect(entries.filter(isUser("four")), `${bullet} the session file holds the user message four exactly once`).toHaveLength(1);
			expect(entries.filter(isNotice), `${bullet} and one custom message`).toHaveLength(1);
			expect(said(entries.find(isNotice)!.content), `${bullet} containing GATE_LINE_1`).toContain("GATE_LINE_1");
			expect(places(entries, "GATE_LINE_1"), `${bullet} exactly once`).toHaveLength(1);
			expect(entries.findIndex(isNotice), `${bullet} after the user message four`).toBeGreaterThan(entries.findIndex(isUser("four")));
			expect(entries.filter(isRecord("armed")), `${bullet} exactly one armed entry: step 0 wasn't replayed`).toHaveLength(1);
		}

		it(
			"15:307 RPC: the prompt four runs after its compaction, and the event arrives once, after it",
			() =>
				withRpc(ws, script(), options(), async (pi) => {
					await pi.run("go");
					setup(pi.since(0, onToolStart("monitor")).length === 1, "the monitor tool was called once");
					const more = await pi.run("more");
					setup(pi.since(more, (e) => e.type === "compaction_end" && e.aborted === true).length === 1, "the helper cancelled the compaction at the end of GATE_BIG's run");
					setup(!ws.has("compact-started"), "no compaction has been held open yet");

					const four = pi.mark;
					pi.prompt("four");
					await lineDuringTheCompaction();
					const started = await pi.seen("the compaction_start that followed the prompt four", (e) => e.type === "compaction_start", four);
					const ended = await pi.seen("its compaction_end", (e) => e.type === "compaction_end" && e.aborted === false, four);
					await pi.seen("agent_settled after the prompt four", onSettled, four);
					await sleep(3000);

					expect(pi.since(started.__i, onAgentStart, ended.__i), "15:307 no agent_start between the compaction_start that followed four and its compaction_end").toHaveLength(0);
					expectThePromptKeptAndTheEventOnce(ws.entries(), "15:307");
				}),
			LIMIT,
		);

		it(
			"15:308 pty: the same session file, four drawn as a user message with one event row below it, never `Agent is already processing`",
			async () => {
				const run = await drive(
					ws,
					script(),
					[
						...START,
						...typed("go"),
						{ wait: "GATE_ARMED" },
						...typed("more"),
						{ wait: "GATE_BIG" },
						{ sleep: 2 },
						...typed("four"),
						{ sleep: 1 },
						{ snapshot: "during_compaction" },
						{ wait: "GATE_LINE_1", needs: "15:308 one monitor event row with GATE_LINE_1 draws" },
						{ sleep: 3 },
						{ snapshot: "after_the_turn" },
					],
					{ ...options(), beside: lineDuringTheCompaction },
				);
				if (run.missed) expect.fail(run.missed);
				const entries = ws.entries();
				setup(entries.filter(isCompaction).length === 1, "the compaction before four finished");

				expectThePromptKeptAndTheEventOnce(entries, "15:308 the same session file:");
				const rows = run.snapshots.after_the_turn!;
				const fourAt = lastRow(rows, (r) => r.trim() === "four");
				expect(fourAt, "15:308 the last snapshot shows the prompt four as a user message").toBeGreaterThan(-1);
				const headers = rowsAt(rows, EVENT_ROW);
				expect(headers, "15:308 and one monitor event · gate watch row").toHaveLength(1);
				expect(rows[headers[0]! + 1], "15:308 with GATE_LINE_1").toContain("GATE_LINE_1");
				expect(headers[0], "15:308 below it").toBeGreaterThan(fourAt);
				for (const [name, snapshot] of Object.entries(run.snapshots)) expect(snapshot.join("\n"), `15:308 no snapshot shows Agent is already processing (${name})`).not.toContain("Agent is already processing");
			},
			LIMIT,
		);
	});

	// ─── Scenario 20 ─────────────────────────────────────────────────────────
	describe("Scenario 20: typed prompt hold", () => {
		const script = () => [monitorStep(ws), { text: "GATE_ARMED" }, { tool: "bash", args: { command: "sleep 4" } }, { text: "GATE_AFTER" }, { text: "GATE_R4" }];

		/** 15:322's session file, and "the same session file" of 15:323. */
		function expectThePromptRanWithTheEventInside(entries: Entry[], bullet: string): void {
			expect(entries.filter(isUser("four")), `${bullet} the user message four is there once`).toHaveLength(1);
			expect(entries.filter(isNotice), `${bullet} the custom message is there once`).toHaveLength(1);
			expect(said(entries.find(isNotice)!.content), `${bullet} containing GATE_LINE_1`).toContain("GATE_LINE_1");
			expect(places(entries, "GATE_LINE_1")).toHaveLength(1);
			const fourAt = entries.findIndex(isUser("four"));
			const callAt = entries.findIndex(isToolCall("bash", "sleep 4"));
			const resultAt = entries.findIndex(isToolResult("bash"));
			const noticeAt = entries.findIndex(isNotice);
			const replyAt = entries.findIndex((e, i) => i > noticeAt && isReply(e));
			expect([fourAt, callAt, resultAt, noticeAt, replyAt].every((at) => at >= 0), `${bullet} four, the bash call for sleep 4, its result, the custom message and a reply are all there`).toBe(true);
			expect([fourAt, callAt, resultAt, noticeAt, replyAt], `${bullet} in that order`).toEqual([fourAt, callAt, resultAt, noticeAt, replyAt].sort((a, b) => a - b));
		}

		it(
			"15:322 RPC, with slow-start.ts: a line printed while four is on its way to its turn joins that turn",
			() =>
				withRpc(ws, script(), { extensions: [ws.helper("slow-start.ts")] }, async (pi) => {
					await pi.run("go");
					setup(pi.since(0, onToolStart("monitor")).length === 1, "the monitor tool was called once");
					setup(ws.has("start-seen"), "slow-start.ts wrote $T/start-seen for go");
					rmSync(ws.path("start-seen"));

					const four = pi.mark;
					pi.prompt("four");
					await marker("$T/start-seen for four", () => ws.has("start-seen"));
					setup(pi.since(four, onAgentStart).length === 0, "four is still in its pre-run handler");
					ws.append("GATE_LINE_1");
					const settled = await pi.seen("agent_settled after the prompt four", onSettled, four, 15_000);

					expect(pi.since(four, onAgentStart, settled.__i), "15:322 one agent_start between the prompt and its agent_settled").toHaveLength(1);
					expectThePromptRanWithTheEventInside(ws.entries(), "15:322");
				}),
			LIMIT,
		);

		it(
			"15:323 pty: the same session file, and the screen never shows `Agent is already processing`",
			async () => {
				const run = await drive(
					ws,
					script(),
					[
						...START,
						...typed("go"),
						{ wait: "GATE_ARMED" },
						{ sleep: 0.5 }, // room for the test to delete go's $T/start-seen before four writes its own
						...typed("four"),
						{ wait: "GATE_AFTER" },
						{ snapshot: "after" },
					],
					{
						extensions: [ws.helper("slow-start.ts")],
						beside: async (over) => {
							await marker("the reply GATE_ARMED in the session file", () => ws.entries().some((e) => isReply(e) && texts(e.message).includes("GATE_ARMED")), 20_000, over);
							setup(ws.has("start-seen"), "slow-start.ts wrote $T/start-seen for go");
							rmSync(ws.path("start-seen"));
							await marker("$T/start-seen for four", () => ws.has("start-seen"), 20_000, over);
							setup(!ws.entries().some(isUser("four")), "four is still in its pre-run handler");
							ws.append("GATE_LINE_1");
						},
					},
				);
				if (run.missed) expect.fail(run.missed);

				expect(run.stream, "15:323 the screen never shows Agent is already processing").not.toContain("Agent is already processing");
				expectThePromptRanWithTheEventInside(ws.entries(), "15:323 the same session file:");
			},
			LIMIT,
		);

		it(
			"15:324 RPC, with eat-input.ts: a prompt that starts no turn holds the event 15 seconds, then Pi wakes",
			() =>
				withRpc(ws, script(), { extensions: [ws.helper("eat-input.ts")] }, async (pi) => {
					await pi.run("go");
					setup(pi.since(0, onToolStart("monitor")).length === 1, "the monitor tool was called once");

					const eat = pi.mark;
					const eatAt = Date.now();
					pi.prompt("GATE_EAT");
					await sleep(500);
					ws.append("GATE_LINE_1");

					await sleepUntil(eatAt + 14_500);
					setup(!ws.entries().some(isUser("GATE_EAT")), "eat-input.ts handled GATE_EAT: it started no turn");
					expect(pi.since(eat, onAgentStart), "15:324 no agent_start arrives for 14.5 seconds").toHaveLength(0);

					const start = await pi.until(onAgentStart, eat, eatAt + 16_500);
					expect(start, "15:324 between 15 and 16.5 seconds after the prompt: one agent_start").toBeDefined();
					expect(start!.__at - eatAt, "15:324 not before 15 seconds").toBeGreaterThanOrEqual(15_000);
					expect(start!.__at - eatAt, "15:324 not after 16.5 seconds").toBeLessThanOrEqual(16_500);
					const notice = await pi.until(onNotice, start!.__i, eatAt + 16_500);
					expect(notice, "15:324 and one custom message, in that window").toBeDefined();
					expect(said(notice!.message.content), "15:324 containing GATE_LINE_1").toContain("GATE_LINE_1");
					expect(notice!.__at - eatAt, "15:324 not after 16.5 seconds").toBeLessThanOrEqual(16_500);

					await sleepUntil(eatAt + 17_000); // the stream is watched for 17 seconds
					expect(pi.since(eat, onAgentStart), "15:324 one agent_start").toHaveLength(1);
					expect(pi.since(eat, onNotice), "15:324 one custom message").toHaveLength(1);
				}),
			60_000, // 15:325: this half waits 17 seconds on purpose
		);
	});

	// ─── Scenario 21 ─────────────────────────────────────────────────────────
	describe("Scenario 21: stop during a turn", () => {
		const script = () => [monitorStep(ws), { text: "GATE_ARMED" }, { tool: "bash", args: { command: "sleep 6" } }, { text: "GATE_AFTER" }, { text: "GATE_R4" }, { text: "GATE_R5" }];
		type Stopped = { pi: RpcPi; work: number; settled: Seen; result: Seen; notify: Seen | undefined; runningBefore: string; goneWithinASecond: boolean };

		/**
		 * The shared RPC steps: arm, start `sleep 6`, 1.5 seconds in send `/monitors stop all` as a plain prompt,
		 * a second later print GATE_LINE_1, and wait for the turn to settle.
		 */
		function stopDuringTheTurn(body: (stopped: Stopped) => Promise<void>): Promise<void> {
			return withRpc(ws, script(), {}, async (pi) => {
				await pi.run("go");
				setup(pi.since(0, onToolStart("monitor")).length === 1, "the monitor tool was called once");
				const work = pi.mark;
				pi.prompt("work");
				await pi.seen("tool_execution_start for bash", onToolStart("bash"), work);
				await sleep(1500);
				const runningBefore = pgrep(ws);
				const stop = pi.mark;
				const stopAt = Date.now();
				pi.prompt("/monitors stop all");
				// Both need the feature, so neither throws here: the tests assert on what they returned.
				const notify = await pi.until(onNotify("Stopped 1 watch."), stop, stopAt + 1000);
				const goneWithinASecond = (await awaited(() => pgrep(ws) === "", stopAt + 1000)) === true;
				await sleepUntil(stopAt + 1000);
				ws.append("GATE_LINE_1");
				const settled = await pi.seen("agent_settled after the prompt work", onSettled, work);
				const result = pi.since(work, onToolResult("bash"))[0];
				const anyNotify = pi.since(stop, (e) => e.type === "extension_ui_request" && e.method === "notify")[0];
				setup(result && anyNotify && anyNotify.__i < result.__i, "/monitors ran while sleep 6 was still running");
				await body({ pi, work, settled, result, notify, runningBefore, goneWithinASecond });
			});
		}

		it(
			"15:332 RPC, during a turn: the stop is said at once, the command is killed, and one notice joins the turn after the bash result",
			() =>
				stopDuringTheTurn(async ({ pi, work, settled, result, notify, runningBefore, goneWithinASecond }) => {
					expect(notify, "15:332 the extension_ui_request with message `Stopped 1 watch.` arrives").toBeDefined();
					expect(notify!.__i, "15:332 before the bash result for sleep 6").toBeLessThan(result.__i);
					expect(runningBefore, "15:332 the watch's command was running until the stop").not.toBe("");
					expect(goneWithinASecond, "15:332 within 1 second pgrep -f $T/watched.txt prints nothing").toBe(true);
					expect(pi.since(0, onNotice).filter((e) => said(e.message.content).includes("GATE_LINE_1")), "15:332 GATE_LINE_1, appended 1 second after the stop, gives no custom message").toHaveLength(0);

					const after = pi.since(result.__i + 1, (e) => e.type === "message_end")[0]!;
					expect(onNotice(after), "15:332 right after the bash result, before the next assistant message: a custom message").toBe(true);
					expect(said(after.message.content), "15:332 with the stopped-by-Tomek text").toBe(stoppedText(armedId(ws.entries())));
					expect(pi.since(work, onNotice, settled.__i), "15:332 exactly one custom message").toHaveLength(1);
					expect(pi.since(work, onAgentStart, settled.__i), "15:332 only one agent_start is seen in that turn").toHaveLength(1);
				}),
			LIMIT,
		);

		it(
			"15:333 RPC, during a turn: ended sits between the bash call and its result, announced after it, and two more prompts add neither",
			() =>
				stopDuringTheTurn(async ({ pi }) => {
					let entries = ws.entries();
					const ended = entries.filter(isRecord("ended"));
					expect(ended, "15:333 the session file holds an ended entry").toHaveLength(1);
					expect(ended[0]!.data.reason, "15:333 with reason user_stop").toBe("user_stop");
					const callAt = entries.findIndex(isToolCall("bash", "sleep 6"));
					const resultAt = entries.findIndex(isToolResult("bash"));
					const endedAt = entries.indexOf(ended[0]!);
					setup(callAt >= 0 && resultAt > callAt, "the bash call for sleep 6 and its result are in the session file");
					expect(endedAt > callAt && endedAt < resultAt, "15:333 between the bash call and its result").toBe(true);
					const announced = entries.filter(isRecord("announced"));
					expect(announced, "15:333 and one announced entry").toHaveLength(1);
					expect(announced[0]!.data, "15:333 with the same id and armedAt").toMatchObject({ id: ended[0]!.data.id, armedAt: ended[0]!.data.armedAt });
					expect(entries.indexOf(announced[0]!), "15:333 after the result").toBeGreaterThan(resultAt);

					await pi.run("next");
					await pi.run("next");
					entries = ws.entries();
					setup(entries.filter(isUser("next")).length === 2, "both prompts next ran");
					const notices = entries.filter(isNotice);
					expect(notices, "15:333 after two more prompts next: that notice once").toHaveLength(1);
					expect(said(notices[0]!.content)).toBe(stoppedText(ended[0]!.data.id));
					expect(entries.filter(isRecord("announced")), "15:333 and one announced entry").toHaveLength(1);
				}),
			LIMIT,
		);

		it(
			"15:334 pty, during a turn: `Stopped 1 watch.` while sleep 6 runs, then the stopped row below the sleep 6 row and above the reply",
			async () => {
				const run = await drive(ws, script(), [
					...START,
					...typed("go"),
					{ wait: "GATE_ARMED" },
					...typed("work"),
					{ wait: "sleep 6" },
					{ sleep: 1.5 },
					...typed("/monitors stop all"),
					{ wait: "Stopped 1 watch\\.", timeout: 3, needs: "15:334 `Stopped 1 watch.` is on screen while the sleep 6 row is still running" },
					{ snapshot: "during_the_turn" },
					{ wait: "GATE_AFTER" },
					{ snapshot: "after_the_turn" },
				]);
				if (run.missed) expect.fail(run.missed);

				const during = run.snapshots.during_the_turn!;
				expect(during.join("\n"), "15:334 Stopped 1 watch. is on screen").toContain("Stopped 1 watch.");
				expect(during.some((r) => r.includes("sleep 6")), "15:334 with the sleep 6 row").toBe(true);
				expect(during.join("\n"), "15:334 still running: its turn's reply hasn't drawn").not.toContain("GATE_AFTER");

				const rows = run.snapshots.after_the_turn!;
				const headers = rowsAt(rows, STOPPED_ROW);
				expect(headers, "15:334 afterwards a monitor stopped · gate watch row").toHaveLength(1);
				expect(rows[headers[0]! + 1], "15:334 with Stopped from /monitors after 0 events").toContain("Stopped from /monitors after 0 events");
				expect(headers[0], "15:334 below the sleep 6 row").toBeGreaterThan(lastRow(rows, (r) => r.includes("sleep 6")));
				expect(headers[0], "15:334 above the reply").toBeLessThan(lastRow(rows, (r) => r.includes("GATE_AFTER")));
			},
			LIMIT,
		);

		it(
			"15:335 RPC, while Pi is idle: the stop starts no turn, and the notice goes with the next prompt, once",
			() =>
				withRpc(ws, script(), {}, async (pi) => {
					await pi.run("go");
					setup(pi.since(0, onToolStart("monitor")).length === 1, "the monitor tool was called once");

					const stop = pi.mark;
					pi.prompt("/monitors stop all");
					await pi.seen("the command's notify", (e) => e.type === "extension_ui_request" && e.method === "notify", stop);
					await sleep(3000);
					expect(pi.since(stop, onAgentStart), "15:335 after /monitors stop all, no agent_start arrives for 3 seconds").toHaveLength(0);
					let entries = ws.entries();
					const ended = entries.filter(isRecord("ended"));
					expect(ended, "15:335 the session file holds an ended entry").toHaveLength(1);
					expect(entries.filter(isRecord("announced")), "15:335 and no announced entry").toHaveLength(0);
					expect(entries.filter(isNotice), "15:335 nothing was sent to the agent yet").toHaveLength(0);

					await pi.run("next");
					entries = ws.entries();
					const nextAt = entries.findIndex(isUser("next"));
					setup(entries.filter(isUser("next")).length === 1, "the prompt next ran");
					const notices = entries.filter(isNotice);
					expect(notices, "15:335 after the prompt next: that notice once").toHaveLength(1);
					expect(said(notices[0]!.content)).toBe(stoppedText(ended[0]!.data.id));
					expect(entries.indexOf(notices[0]!), "15:335 the user message next, then the notice").toBeGreaterThan(nextAt);
					const announced = entries.filter(isRecord("announced"));
					expect(announced, "15:335 and one announced entry").toHaveLength(1);
					expect(announced[0]!.data).toMatchObject({ id: ended[0]!.data.id, armedAt: ended[0]!.data.armedAt, reason: "user_stop" });

					await pi.run("next");
					entries = ws.entries();
					setup(entries.filter(isUser("next")).length === 2, "the second prompt next ran");
					expect(entries.filter(isNotice), "15:335 a second next adds no notice").toHaveLength(1);
					expect(entries.filter(isRecord("announced")), "15:335 and no announced entry").toHaveLength(1);
				}),
			LIMIT,
		);
	});

	// ─── Scenario 22 ─────────────────────────────────────────────────────────
	describe("Scenario 22: owed across a quit", () => {
		const script = () => [monitorStep(ws, { timeout_ms: 3000 }), { text: "GATE_ARMED" }, { tool: "bash", args: { command: "sleep 10" } }, ...replies(3, 6)];
		const isDeadlineEnd = (e: Entry) => isRecord("ended")(e) && e.data.reason === "deadline";

		it(
			"15:343 15:344 15:345 RPC: a deadline notice Esc cleared is owed after the quit, said once with the next prompt, and never again",
			async () => {
				// First run: the 3-second deadline fires during sleep 10, Esc clears its notice, and Pi is ended.
				await withRpc(ws, script(), {}, async (pi) => {
					await pi.run("go");
					setup(pi.since(0, onToolStart("monitor")).length === 1, "the monitor tool was called once");
					const work = pi.mark;
					pi.prompt("work");
					await pi.seen("tool_execution_start for bash", onToolStart("bash"), work);

					const ended = await awaited(() => ws.entries().some(isDeadlineEnd), Date.now() + 6000);
					expect(ended, "15:343 first run: an ended entry with reason deadline appears in the session file while sleep 10 runs").toBe(true);
					await sleep(1000);
					const esc = pi.esc();
					await pi.seen("the aborted bash result", (e) => e.type === "tool_execution_end" && e.toolName === "bash" && e.isError === true, esc);
					await sleep(2000);
				});
				let entries = ws.entries();
				const id = armedId(entries);
				expect(entries.filter(isDeadlineEnd), "15:343 after the first run: an ended entry with reason deadline").toHaveLength(1);
				expect(entries.filter(isRecord("announced")), "15:343 no announced entry").toHaveLength(0);
				expect(entries.filter(isNotice), "15:343 and no custom message").toHaveLength(0);
				const end = entries.find(isDeadlineEnd)!.data;

				/** 15:344's record, which 15:345 says no later prompt and no later run adds to. */
				const expectSaidOnce = (bullet: string): Entry[] => {
					const now = ws.entries();
					const notices = now.filter(isNotice);
					expect(notices, `${bullet} one custom message`).toHaveLength(1);
					expect(said(notices[0]!.content), `${bullet} with the deadline notice's content`).toBe(deadlineText(id));
					const announced = now.filter(isRecord("announced"));
					expect(announced, `${bullet} one announced entry`).toHaveLength(1);
					expect(announced[0]!.data, `${bullet} with reason deadline`).toMatchObject({ id: end.id, armedAt: end.armedAt, reason: "deadline" });
					return now;
				};

				// Second run, --continue: the notice goes with the first `back`, and the second adds nothing.
				await withRpc(ws, script(), { args: ["--continue"] }, async (pi) => {
					await pi.run("back");
					entries = expectSaidOnce("15:344 after the prompt back in the second run:");
					setup(entries.filter(isUser("back")).length === 1, "the prompt back ran");
					expect(entries.findIndex(isNotice), "15:344 the user message back, then the custom message").toBeGreaterThan(entries.findIndex(isUser("back")));
					expect(entries.filter(isNotice).some((e) => said(e.content).includes("restarted its runtime")), "15:344 no restart notice is there").toBe(false);

					await pi.run("back");
					setup(ws.entries().filter(isUser("back")).length === 2, "the second prompt back ran");
					expectSaidOnce("15:345 after a second back:");
				});

				// Third run.
				await withRpc(ws, script(), { args: ["--continue"] }, async (pi) => {
					await pi.run("back");
					setup(ws.entries().filter(isUser("back")).length === 3, "the third run's prompt back ran");
					expectSaidOnce("15:345 after a third run's back:");
				});
			},
			LIMIT,
		);

		it(
			"15:346 pty: the second run draws the stopped row with the deadline line above the reply to back",
			async () => {
				await drive(
					ws,
					script(),
					[...START, ...typed("go"), { wait: "GATE_ARMED" }, ...typed("work"), { sleep: 4.5 }, { key: "escape" }, { sleep: 2 }, ...typed("/quit"), { sleep: 0.5 }],
					{ timeout: 15 },
				);
				const entries = ws.entries();
				setup(entries.filter(isToolCall("monitor")).length === 1, "the monitor tool was called once");
				setup(entries.some((e) => isToolResult("bash")(e) && texts(e.message).includes("Command aborted")), "Escape aborted sleep 10 in the first run");

				const run = await drive(
					ws,
					script(),
					[
						...START,
						...typed("back"),
						{ wait: "Reached its 3-second deadline after 0 events", needs: "15:346 the second run's screen shows the deadline line" },
						{ wait: ANY_REPLY.source, timeout: 3 }, // the reply to back; after the first run's abort which step answers isn't fixed
						{ snapshot: "second_run" },
					],
					{ args: ["--continue"], timeout: 12 },
				);
				if (run.missed) expect.fail(run.missed);

				const rows = run.snapshots.second_run!;
				const headers = rowsAt(rows, STOPPED_ROW);
				expect(headers, "15:346 a monitor stopped · gate watch row").toHaveLength(1);
				expect(rows[headers[0]! + 1], "15:346 with Reached its 3-second deadline after 0 events").toContain("Reached its 3-second deadline after 0 events");
				expect(headers[0], "15:346 below the prompt back").toBeGreaterThan(lastRow(rows, (r) => r.trim() === "back"));
				expect(headers[0], "15:346 above the reply to back").toBeLessThan(lastRow(rows, (r) => ANY_REPLY.test(r)));
			},
			LIMIT,
		);
	});
});

describe.skipIf(!READY)(`rbf-monitor real-Pi remaining scenarios, Pi ${VERSION}`, () => {
	let ws: Workspace;

	beforeEach(() => {
		ws = new Workspace();
	});
	afterEach(() => {
		const left = pgrep(ws);
		if (left) {
			spawnSync("pkill", ["-9", "-f", ws.watched]);
			console.warn(`[rbf-monitor-real] Pi left a watch command running, killed: pid ${left.split("\n").join(", ")}`);
		}
		ws.cleanup();
	});

	describe("Scenario 6: Rows, the half-typed prompt, and the badge in a real terminal", () => {
		for (const tuiMode of ["regular", "fullscreen"] as const) {
			for (const withIndent of [false, true]) {
				const label = `${tuiMode} mode${withIndent ? " with indent" : " without indent"}`;
				it(
					label,
					async () => {
						const script = [
							monitorStep(ws),
							{ text: "GATE_ARMED" },
							{ text: "GATE_WOKE" },
							{ text: "GATE_END" },
						];
						const indentExt = join(ROOT, "extensions", "rbf-tool-parts-indent.ts");
						const extensions = withIndent ? [indentExt] : [];

						const steps: Step[] = [
							...START,
							...typed("go"),
							{ wait: "GATE_ARMED", timeout: 10 },
							{ paste: "half typed" },
							{ wait: "GATE_WOKE", timeout: 12, needs: "15:140 scripted reply GATE_WOKE arrives after append" },
							{ snapshot: "half_typed" },
							{ key: "enter" },
							{ wait: "GATE_END", timeout: 10, needs: "15:141 reply GATE_END follows" },
							...typed("/monitors stop all"),
							{ wait: "Stopped 1 watch.", timeout: 6, needs: "15:142 Stopped 1 watch. notification" },
							{ snapshot: "stopped" },
							...typed("/monitors"),
							{ wait: "No watches running.", timeout: 6, needs: "15:143 No watches running. replaces previous" },
							{ snapshot: "empty" },
						];

						const run = await drive(ws, script, steps, {
							args: ["--tui-mode", tuiMode],
							extensions,
							beside: async (over) => {
								await marker("GATE_ARMED in session", () => isReply(ws.entries().slice(-1)[0] ?? {}) && texts((ws.entries().slice(-1)[0] as any).message).includes("GATE_ARMED"), 10_000, over);
								await sleep(2000);
								ws.append("GATE_LINE_1");
							},
						});
						if (run.missed) expect.fail(run.missed);

						const snap1 = run.snapshots.half_typed!;
						const snap2 = run.snapshots.stopped!;
						const snap3 = run.snapshots.empty!;

						// 15:138 monitor gate watch and under it a line containing Watching · stops in 5m · task mon-
						const armedHeaderIdx = snap1.findIndex((r) => r.includes("monitor gate watch"));
						expect(armedHeaderIdx, "15:138 monitor gate watch row").toBeGreaterThanOrEqual(0);
						const underArmed = snap1[armedHeaderIdx + 1] ?? "";
						expect(underArmed, "15:138 line containing Watching · stops in 5m · task mon-").toContain("Watching · stops in 5m · task mon-");

						// 15:139 the footer's stats row contains · 1 watch
						const statsRow1 = snap1.find((r) => r.includes("· 1 watch"));
						expect(statsRow1, "15:139 footer stats row contains · 1 watch").toBeDefined();

						// 15:140 after the append: a blank row, monitor event · gate watch, then  └  GATE_LINE_1, then GATE_WOKE
						const eventHeaderIdx = snap1.findIndex((r) => r.startsWith(" monitor event · gate watch"));
						expect(eventHeaderIdx, "15:140 monitor event · gate watch row").toBeGreaterThan(armedHeaderIdx);
						expect(snap1[eventHeaderIdx - 1]?.trim(), "15:140 blank row before event").toBe("");
						expect(snap1[eventHeaderIdx + 1], "15:140  └  GATE_LINE_1").toContain(" └  GATE_LINE_1");
						const wokeIdx = snap1.findIndex((r) => r.includes("GATE_WOKE"));
						expect(wokeIdx, "15:140 scripted reply GATE_WOKE").toBeGreaterThan(eventHeaderIdx);

						// 15:141 editor still shows half typed in snap1, and transcript in snap2 shows half typed above GATE_END
						expect(run.raw.toString("utf8"), "15:141 half typed in editor").toContain("half typed");
						const endIdx = snap2.findIndex((r) => r.includes("GATE_END"));
						expect(endIdx, "15:141 GATE_END in snap2").toBeGreaterThanOrEqual(0);
						const halfTypedIdx = snap2.findIndex((r) => r.trim() === "half typed");
						expect(halfTypedIdx, "15:141 half typed user message above GATE_END").toBeLessThan(endIdx);

						// 15:142 after /monitors stop all: Stopped 1 watch., and stats row no longer contains watch
						expect(snap2.some((r) => r.includes("Stopped 1 watch.")), "15:142 Stopped 1 watch.").toBe(true);
						const statsRow2 = snap2[snap2.length - 1] ?? "";
						expect(statsRow2, "15:142 stats row no longer contains watch").not.toContain("watch");

						// 15:143 after second /monitors: No watches running. is on screen and Stopped 1 watch. is not
						expect(snap3.some((r) => r.includes("No watches running.")), "15:143 No watches running. on screen").toBe(true);
						expect(snap3.some((r) => r.includes("Stopped 1 watch.")), "15:143 Stopped 1 watch. replaced").toBe(false);

						// 15:144 no row is wider than 100 columns
						for (const s of [snap1, snap2, snap3]) {
							for (const r of s) {
								expect(r.length, "15:144 row <= 100 cols").toBeLessThanOrEqual(COLS);
							}
						}

						// 15:145 with indent, row starts with  └  Watching; without it starts at col 1 with no └
						if (withIndent) {
							expect(underArmed.startsWith(" └  "), "15:145 starts with  └  ").toBe(true);
						} else {
							expect(underArmed.includes("└"), "15:145 no └ without indent").toBe(false);
						}
					},
					LIMIT,
				);
			}
		}
	});

	describe("Scenario 7: An idle Pi wakes on one line, and stays quiet after a stop", () => {
		it(
			"RPC stream: idle wake, stop quiet",
			async () => {
				const counterScript = ws.path("count-requests.ts");
				const requestsLog = ws.path("requests.log");
				writeFileSync(
					counterScript,
					`import * as fs from "node:fs";
export default function countRequests(pi: any): void {
	pi.on("before_provider_request", () => {
		fs.appendFileSync(${JSON.stringify(requestsLog)}, "req\\n");
	});
}
`,
				);

				const script = [
					monitorStep(ws),
					{ tool: "task_stop", args: { task_id: "mon-0000" } },
					{ text: "GATE_ARMED" },
					{ text: "GATE_WOKE" },
				];

				await withRpc(ws, script, { extensions: [counterScript] }, async (pi) => {
					// 15:153 arming turn makes three provider calls
					await pi.run("go");

					// 15:154 arming turn ends, agent_settled, watch still running 2s later
					const id = armedId(ws.entries());
					expect(id, "armed id exists").toBeDefined();
					const firstSettled = pi.events.find(onSettled);
					expect(firstSettled, "first settled event exists").toBeDefined();
					await sleep(2000);
					expect(pgrep(ws), "15:154 watch still running 2s later").not.toBe("");

					// 15:155 monitor tool result arrives within 1s and contains Watching "gate watch" as task mon-
					const monStart = pi.events.find(onToolStart("monitor"));
					const monEnd = pi.events.find((e) => e.type === "tool_execution_end" && e.toolName === "monitor") ?? pi.events.find(onToolResult("monitor"));
					expect(monStart, "15:155 monitor tool call found").toBeDefined();
					expect(monEnd, "15:155 monitor tool result found").toBeDefined();
					expect(monEnd!.__at - monStart!.__at, "15:155 arrives within 1s").toBeLessThanOrEqual(1000);
					const monResult = ws.entries().find(isToolResult("monitor"));
					expect(monResult, "15:155 monitor tool result in session").toBeDefined();
					expect(said(monResult?.message?.content), "15:155 Watching gate watch").toContain('Watching "gate watch" as task mon-');

					// 15:156 task_stop tool result is No running watch has task id mon-0000. Running: gate watch (task <id>)
					const stopResult = ws.entries().find(isToolResult("task_stop"));
					expect(stopResult, "15:156 task_stop tool result").toBeDefined();
					expect(said(stopResult?.message?.content), "15:156 not running").toBe(`No running watch has task id "mon-0000". Running: "gate watch" (task ${id}).`);
					expect(stopResult?.message?.isError, "15:156 not flagged as error").toBeFalsy();

					// 15:157 for 2s after first settled, no event arrives, and requests.log holds 3 lines
					const eventsIn2s = pi.since(firstSettled!.__i, onNotice);
					expect(eventsIn2s.length, "15:157 no event arrives for 2s").toBe(0);
					const reqs1 = existsSync(requestsLog) ? readFileSync(requestsLog, "utf8").trim().split("\n") : [];
					expect(reqs1.length, "15:157 3 lines in requests.log").toBe(3);

					// 15:158 within 1s of append: agent_start, custom message, assistant GATE_WOKE, agent_end, agent_settled
					const markBeforeAppend = pi.mark;
					const appendAt = Date.now();
					ws.append("GATE_LINE_1");
					const wakeStart = await pi.seen("agent_start for wake", onAgentStart, markBeforeAppend, 1000);
					const wakeNotice = await pi.seen("custom message for wake", onNotice, markBeforeAppend, 1000);
					expect(wakeStart.__at - appendAt, "15:158 agent_start within 1s").toBeLessThanOrEqual(1000);
					expect(wakeNotice.__at - appendAt, "15:158 custom message within 1s").toBeLessThanOrEqual(1000);
					expect(wakeNotice.message.role, "15:158 role custom").toBe("custom");
					expect(wakeNotice.message.customType, "15:158 customType rbf-monitor").toBe(CUSTOM_TYPE);
					expect(said(wakeNotice.message.content), "15:158 content matches").toBe(`Monitor event from "gate watch" (task ${id}):\nGATE_LINE_1`);
					const wakeAssist = await pi.seen("assistant GATE_WOKE", (e) => onAssistant(e) && texts(e.message).includes("GATE_WOKE"), markBeforeAppend, 3000);
					const wakeEnd = await pi.seen("agent_end for wake", onAgentEnd, markBeforeAppend, 3000);
					const wakeSettled = await pi.seen("agent_settled for wake", onSettled, markBeforeAppend, 3000);

					expect(wakeStart.__i, "15:158 order start < notice").toBeLessThan(wakeNotice.__i);
					expect(wakeNotice.__i, "15:158 order notice < assist").toBeLessThan(wakeAssist.__i);
					expect(wakeAssist.__i, "15:158 order assist < end").toBeLessThan(wakeEnd.__i);
					expect(wakeEnd.__i, "15:158 order end < settled").toBeLessThan(wakeSettled.__i);

					// 15:159 wake made exactly one provider call: requests.log holds 4 lines, stream holds 4 assistant messages total
					const reqs2 = readFileSync(requestsLog, "utf8").trim().split("\n");
					expect(reqs2.length, "15:159 4 lines in requests.log").toBe(4);
					const allAssistants = pi.events.filter(onAssistant);
					expect(allAssistants.length, "15:159 4 assistant messages in total").toBe(4);

					// 15:160 after /monitors stop all: notify Stopped 1 watch., no agent_start
					const markBeforeStop = pi.mark;
					pi.prompt("/monitors stop all");
					const notify = await pi.seen("notify Stopped 1 watch.", onNotify("Stopped 1 watch."), markBeforeStop, 3000);
					expect(notify, "15:160 notify Stopped 1 watch.").toBeDefined();
					const lateStart = pi.since(markBeforeStop, onAgentStart);
					expect(lateStart.length, "15:160 no agent_start from /monitors").toBe(0);

					// 15:161 after that, appending GATE_LINE_2 gives no agent_start for 3s, requests.log still holds 4 lines
					const markBeforeLine2 = pi.mark;
					ws.append("GATE_LINE_2");
					await sleep(3000);
					const noWake = pi.since(markBeforeLine2, onAgentStart);
					expect(noWake.length, "15:161 no agent_start after stop").toBe(0);
					const reqs3 = readFileSync(requestsLog, "utf8").trim().split("\n");
					expect(reqs3.length, "15:161 requests.log still 4 lines").toBe(4);

					// 15:162 pgrep prints nothing
					expect(pgrep(ws), "15:162 pgrep prints nothing").toBe("");
				});
			},
			LIMIT,
		);
	});

	describe("Scenario 8: A line during a running turn arrives once, at the tool boundary", () => {
		it(
			"RPC stream: line during turn arrives once at tool boundary",
			async () => {
				const script = [
					monitorStep(ws),
					{ tool: "bash", args: { command: "sleep 3" } },
					{ text: "GATE_AFTER" },
				];

				await withRpc(ws, script, {}, async (pi) => {
					pi.prompt("go");
					await pi.seen("bash tool start", onToolStart("bash"), 0, 10_000);
					await sleep(1000);
					ws.append("GATE_LINE_1");
					await pi.seen("agent_settled", onSettled, 0, 15_000);
					await sleep(3000);

					const id = armedId(ws.entries());
					expect(id, "armed id").toBeDefined();

					const bashResultIdx = pi.events.findIndex(onToolResult("bash"));
					expect(bashResultIdx, "bash tool result seen").toBeGreaterThanOrEqual(0);

					const customEvents = pi.events.filter(onNotice);
					expect(customEvents.length, "15:169 exactly one custom message").toBe(1);
					const custom = customEvents[0]!;
					expect(said(custom.message.content), "15:169 custom message content").toBe(`Monitor event from "gate watch" (task ${id}):\nGATE_LINE_1`);

					const assistAfterIdx = pi.events.findIndex((e) => onAssistant(e) && texts(e.message).includes("GATE_AFTER"));
					expect(assistAfterIdx, "assistant GATE_AFTER seen").toBeGreaterThanOrEqual(0);

					expect(custom.__i, "15:169 custom after bash result").toBeGreaterThan(bashResultIdx);
					expect(custom.__i, "15:169 custom before assistant").toBeLessThan(assistAfterIdx);

					const starts = pi.events.filter(onAgentStart);
					expect(starts.length, "15:169 only one agent_start").toBe(1);
				});
			},
			LIMIT,
		);
	});

	describe("Scenario 9: The room's own watch line, unmodified", () => {
		it(
			"RPC stream: room watch line wakes Pi",
			async () => {
				const templatePath = join(process.env.HOME!, ".agents/skills/agent-group-chat/references/room-template.md");
				const templateContent = readFileSync(templatePath, "utf8");
				const waitMatch = templateContent.match(/tail -n \+\$\(\(<read position> \+ 1\)\) -F \/tmp\/claude\/agent-chat\/@@ROOM@@\/chat\.md \| [^\n]+/);
				setup(waitMatch, "wait command in room template");
				const rawCommand = waitMatch[0]!;

				const roomDir = ws.path("room");
				mkdirSync(roomDir);
				const chatFile = join(roomDir, "chat.md");
				writeFileSync(chatFile, "## Initial room header\n");
				const readPos = 1;

				const filledCommand = rawCommand
					.replace("<read position>", String(readPos))
					.replace("/tmp/claude/agent-chat/@@ROOM@@/chat.md", chatFile)
					.replace("@your-handle", "@pi-a7");

				const restored = filledCommand
					.replace(String(readPos), "<read position>")
					.replace(chatFile, "/tmp/claude/agent-chat/@@ROOM@@/chat.md")
					.replace("@pi-a7", "@your-handle");
				expect(restored, "15:182 template line restored character for character").toBe(rawCommand);

				const script = [
					{ tool: "monitor", args: { command: filledCommand, description: "room", timeout_ms: 1_800_000 } },
					{ text: "GATE_ARMED" },
				];

				await withRpc(ws, script, {}, async (pi) => {
					await pi.run("go");
					const monResult = ws.entries().find(isToolResult("monitor"));
					expect(monResult, "15:181 monitor result").toBeDefined();
					expect(said(monResult?.message?.content), "15:181 It stops in 30 minutes").toContain("It stops in 30 minutes");

					const post = (from: string, to: string, body: string) => {
						const header = to === "@all" ? `\`${from}\`` : `\`${from}\` → \`${to}\``;
						const cmd = `perl -0777 -ne 'use POSIX; syswrite STDOUT, "\\n## 🟠⋯ ".strftime("%Y-%m-%d %H:%M:%S", localtime)." $_"' >> ${chatFile} <<'CHAT_EOF'\n${header}\n${body}\nCHAT_EOF\n`;
						spawnSync("bash", ["-c", cmd]);
					};

					let m = pi.mark;
					post("@claude-c3", "@pi-a7", "Hello Pi");
					const wake1 = await pi.seen("wake for @pi-a7", onNotice, m, 5000);
					const lines1 = said(wake1.message.content).split("\n");
					expect(lines1[1], "15:177 header with backticks removed").toContain("@claude-c3 → @pi-a7");
					expect(lines1[1], "15:177 no backticks").not.toContain("`");
					await sleep(3000);

					m = pi.mark;
					post("@claude-c3", "@all", "Hello everyone");
					const wake2 = await pi.seen("wake for @all", onNotice, m, 5000);
					expect(wake2, "15:178 custom message for everyone").toBeDefined();
					await sleep(3000);

					m = pi.mark;
					post("@pi-a7", "@claude-c3", "From Pi");
					await sleep(3000);
					expect(pi.since(m, onNotice).length, "15:179 no message for own post").toBe(0);

					m = pi.mark;
					post("@claude-c3", "@codex-b9", "For Codex");
					await sleep(3000);
					expect(pi.since(m, onNotice).length, "15:180 no message for third party").toBe(0);
				});
			},
			LIMIT,
		);
	});

	describe("Scenario 11: /reload with a live watch", () => {
		it(
			"PTY: /reload cleans up watch and recovers on restart",
			async () => {
				const probeExt = join(SUPPORT, "rbf-reload-probe.ts");
				const receipt = ws.path("reload.json");
				const assertMarker = ws.path("asserted-15-207.jsonl");
				const script = [
					monitorStep(ws),
					{ text: "GATE_ARMED" },
					{ text: "GATE_AGAIN_1" },
					{ text: "GATE_AGAIN_2" },
					monitorStep(ws),
					{ text: "GATE_REARMED" },
					{ text: "GATE_REWOKE" },
				];

				const steps: Step[] = [
					...START,
					...typed("go"),
					{ wait: "GATE_ARMED", timeout: 10 },
					...typed("/reload"),
					{ waitJsonl: { path: assertMarker, field: "asserted", value: true, count: 1 }, timeout: 15 } as any,
					...typed("again"),
					{ wait: "GATE_AGAIN_1", timeout: 8, needs: "15:206 reply GATE_AGAIN_1" },
					{ snapshot: "after_again_1" },
					...typed("again"),
					{ wait: "GATE_AGAIN_2", timeout: 8, needs: "15:208 reply GATE_AGAIN_2" },
					{ snapshot: "after_again_2" },
					...typed("arm"),
					{ wait: "GATE_REARMED", timeout: 8, needs: "15:209 reply GATE_REARMED" },
					{ wait: "GATE_REWOKE", timeout: 10, needs: "15:210 reply GATE_REWOKE" },
					{ snapshot: "after_rewoke" },
				];

				const run = await drive(ws, script, steps, {
					extensions: [probeExt],
					env: { PI_RELOAD_PROBE_RECEIPT: receipt },
					beside: async (over) => {
						await marker("reload receipt", () => existsSync(receipt) && JSON.parse(readFileSync(receipt, "utf8")).loads >= 2, 15_000, over);
						await sleep(1000);
						expect(pgrep(ws), "15:203 pgrep prints nothing").toBe("");
						ws.append("GATE_LINE_1");
						await sleep(3000);
						expect(ws.entries().filter(isReply).length, "15:205 appending GATE_LINE_1 starts no turn in 3s").toBe(1);
						expect(ws.entries().filter(isRecord("announced")).length, "15:207 no announced before first again").toBe(0);
						writeFileSync(assertMarker, JSON.stringify({ asserted: true }) + "\n");
					},
				});
				if (run.missed) expect.fail(run.missed);

				const snap1 = run.snapshots.after_again_1!;
				const snap2 = run.snapshots.after_again_2!;
				const snap3 = run.snapshots.after_rewoke!;

				const statsRow1 = snap1[snap1.length - 1] ?? "";
				expect(statsRow1, "15:204 stats row has no watch").not.toContain("watch");

				const stoppedIdx = snap1.findIndex((r) => r.includes(STOPPED_ROW));
				const replyIdx = snap1.findIndex((r) => r.includes("GATE_AGAIN_1"));
				expect(stoppedIdx, "15:206 stopped row on screen").toBeGreaterThanOrEqual(0);
				expect(replyIdx, "15:206 stopped row above reply").toBeGreaterThan(stoppedIdx);
				expect(snap1.some((r) => r.includes("Pi restarted its runtime. Not re-armed:")), "15:206 restarted runtime notice").toBe(true);
				expect(snap1.some((r) => r.includes("gate watch (task mon-")), "15:206 lists gate watch task").toBe(true);

				const entries1 = ws.entries();
				const restartNotice = entries1.find((e) => isNotice(e) && said(e.content).includes("These watches stopped when Pi restarted its runtime"));
				expect(restartNotice, "15:206 custom message in session file").toBeDefined();

				const announced1 = entries1.filter(isRecord("announced"));
				expect(announced1.length, "15:207 one announced entry").toBe(1);
				expect(announced1[0]?.data?.reason, "15:207 reason shutdown").toBe("shutdown");

				const entries2 = ws.entries();
				const restartNotices2 = entries2.filter((e) => isNotice(e) && said(e.content).includes("These watches stopped when Pi restarted its runtime"));
				expect(restartNotices2.length, "15:208 restart notice held once").toBe(1);
				expect(entries2.filter(isRecord("announced")).length, "15:208 still one announced entry").toBe(1);

				const gateWatchRowsBefore = snap2.filter((r) => r.includes("monitor gate watch"));
				const gateWatchRowsAfter = snap3.filter((r) => r.includes("monitor gate watch"));
				expect(gateWatchRowsAfter.length, "15:209 new monitor gate watch row added on screen").toBe(gateWatchRowsBefore.length + 1);
				const reply2Idx = lastRow(snap3, (r) => r.includes("GATE_AGAIN_2"));
				const rearmedIdx = lastRow(snap3, (r) => r.includes("monitor gate watch"));
				expect(rearmedIdx, "15:209 new monitor gate watch row appears below second again reply").toBeGreaterThan(reply2Idx);
				const statsRow3 = snap3[snap3.length - 1] ?? "";
				expect(statsRow3, "15:209 stats row contains · 1 watch again").toContain("· 1 watch");

				const eventIdx = snap3.findIndex((r) => r.includes(EVENT_ROW) && snap3[snap3.indexOf(r) + 1]?.includes("GATE_LINE_1"));
				expect(eventIdx, "15:210 event row on screen").toBeGreaterThanOrEqual(0);
				const entries3 = ws.entries();
				const line1Notices = entries3.filter((e) => isNotice(e) && said(e.content).includes("GATE_LINE_1"));
				expect(line1Notices.length, "15:210 holds exactly one event message with GATE_LINE_1").toBe(1);
			},
			LIMIT,
		);
	});

	describe("Scenario 12: Cleanup and fault tolerance (Real Pi)", () => {
		it(
			"15:220 pty: process group killed on /quit",
			async () => {
				const pidFile = ws.path("watch.pid");
				const script = [
					{ tool: "monitor", args: { command: `echo $$ > ${pidFile}; while :; do echo x; sleep 30; done`, description: "pg" } },
					{ text: "GATE_ARMED" },
				];
				const steps: Step[] = [
					...START,
					...typed("go"),
					{ wait: "GATE_ARMED", timeout: 10 },
					...typed("/quit"),
				];
				await drive(ws, script, steps, { timeout: 15 });
				await sleep(1500);
				const pidStr = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "";
				setup(pidStr, "pid written to pidFile");
				const pgrepOut = spawnSync("pgrep", ["-g", pidStr], { encoding: "utf8" }).stdout.trim();
				expect(pgrepOut, "15:220 process group exited").toBe("");
			},
			LIMIT,
		);

		it(
			"15:221 pty: log permissions and file content",
			async () => {
				const script = [
					{ tool: "monitor", args: { command: "echo out; echo err >&2; sleep 5", description: "logcheck" } },
					{ text: "GATE_ARMED" },
				];
				const steps: Step[] = [
					...START,
					...typed("go"),
					{ wait: "GATE_ARMED", timeout: 10 },
					{ sleep: 1 },
					...typed("/quit"),
				];
				await drive(ws, script, steps, { timeout: 15 });
				const entries = ws.entries();
				const armed = entries.find(isRecord("armed"))?.data;
				setup(armed && armed.id, "armed entry found in session file");
				const sessionHeader = entries.find((e) => e.type === "session");
				const sessionId = sessionHeader?.id ?? "default";
				const sessionDir = join("/tmp/pi-monitors", `session-${sessionId}`);
				setup(existsSync(sessionDir), `session dir ${sessionDir} found`);
				const fs = await import("node:fs");
				const dirStat = fs.statSync(sessionDir);
				expect(dirStat.mode & 0o777, "15:221 dir mode 0700").toBe(0o700);

				const expectedLogFileName = `${armed.id}-${armed.at}.log`;
				const logFile = join(sessionDir, expectedLogFileName);
				setup(existsSync(logFile), `log file ${expectedLogFileName} found`);
				const fileStat = fs.statSync(logFile);
				expect(fileStat.mode & 0o777, "15:221 file mode 0600").toBe(0o600);
				const content = fs.readFileSync(logFile, "utf8");
				expect(content, "15:221 holds out").toContain("out");
				expect(content, "15:221 holds err").toContain("err");
			},
			LIMIT,
		);

		it(
			"15:222 pty: 1000 lines capped and /monitors answered within 1s",
			async () => {
				const script = [
					{ tool: "monitor", args: { command: "seq 1 1000; sleep 5", description: "seqcheck" } },
					{ text: "GATE_ARMED" },
				];
				const steps: Step[] = [
					...START,
					...typed("go"),
					{ wait: "(980 more lines not shown)", timeout: 12, needs: "15:222 20 lines and 980 more lines line" },
					...typed("/monitors"),
					{ wait: "seqcheck", timeout: 2, needs: "15:222 /monitors answered within 1 second" },
					...typed("/quit"),
				];
				const run = await drive(ws, script, steps, { timeout: 18 });
				if (run.missed) expect.fail(run.missed);
			},
			LIMIT,
		);

		it(
			"15:223 pty: urandom cleaned in session, raw in log",
			async () => {
				const script = [
					{ tool: "monitor", args: { command: "head -c 200000 /dev/urandom; sleep 5", description: "randcheck" } },
					{ text: "GATE_ARMED" },
				];
				const steps: Step[] = [
					...START,
					...typed("go"),
					{ wait: "GATE_ARMED", timeout: 10 },
					{ sleep: 2 },
					...typed("/monitors"),
					{ wait: "randcheck", timeout: 3, needs: "15:223 /monitors answered" },
					...typed("/quit"),
				];
				const run = await drive(ws, script, steps, { timeout: 20 });
				if (run.missed) expect.fail(run.missed);

				const entries = ws.entries();
				for (const e of entries) {
					if (isNotice(e)) {
						const c = said(e.content);
						for (const ch of c) {
							const code = ch.charCodeAt(0);
							if (code < 0x20) {
								expect(code === 9 || code === 10, "15:223 no char < 0x20 except tab/newline").toBe(true);
							}
						}
						expect(c, "15:223 no escape char").not.toContain("\x1b");
					}
				}

				const fs = await import("node:fs");
				const sessions = readdirSync("/tmp/pi-monitors")
					.filter((d) => d.startsWith("session-") && d !== "session-fake-session")
					.sort((a, b) => fs.statSync(join("/tmp/pi-monitors", a)).mtimeMs - fs.statSync(join("/tmp/pi-monitors", b)).mtimeMs);
				const sessionDir = join("/tmp/pi-monitors", sessions[sessions.length - 1]!);
				const logFiles = fs.readdirSync(sessionDir);
				const logFile = join(sessionDir, logFiles[logFiles.length - 1]!);
				const raw = fs.readFileSync(logFile);
				expect(raw.length, "15:223 200000 raw bytes").toBe(200_000);
			},
			LIMIT,
		);
	});

	describe("Scenario 15: Neighbouring features' contracts (Real Pi)", () => {
		it(
			"15:255 pty: /cd refused while watch running",
			async () => {
				const other = ws.path("other");
				mkdirSync(other);
				const script = [
					monitorStep(ws),
					{ text: "GATE_ARMED" },
				];
				const steps: Step[] = [
					...START,
					...typed("go"),
					{ wait: "GATE_ARMED", timeout: 10 },
					...typed(`/cd ${other}`),
					{ wait: "Can't change directory while a watch is running.", timeout: 6, needs: "15:255 /cd refused with exact line" },
					{ snapshot: "cd_refused" },
					...typed("/monitors"),
					{ wait: "gate watch", timeout: 4, needs: "15:255 /monitors still lists watch" },
					{ snapshot: "monitors_list" },
					...typed("/monitors stop all"),
					...typed("/quit"),
				];
				const run = await drive(ws, script, steps, {
					extensions: [
						join(ROOT, "extensions", "rbf-background-tasks.ts"),
						join(ROOT, "extensions", "rbf-cd.ts"),
					],
					timeout: 20,
				});
				if (run.missed) expect.fail(run.missed);

				const snap = run.snapshots.cd_refused!;
				expect(snap.join(" ").replace(/\s+/g, " "), "15:255 exact refusal line").toContain("Can't change directory while a watch is running. Stop it with /monitors stop all, then retry /cd.");
				const stats = snap[snap.length - 1] ?? "";
				expect(stats, "15:255 stats row still contains · 1 watch").toContain("· 1 watch");
			},
			LIMIT,
		);

		it(
			"15:257 real Pi: codex-harness prompt and /monitors",
			async () => {
				const codexExt = join(SUPPORT, "rbf-row-gate-codex.ts");
				const log = ws.path("codex.jsonl");
				const scenario = { resumeTurns: [{ id: "turn-fake-1", status: "completed" }] };

				const steps: Step[] = [
					{ wait: "ctrl\\+o more" },
					...typed("hello codex"),
					{ wait: "FAKE_OK", timeout: 10 },
					...typed("/monitors"),
					{ wait: "No watches running.", timeout: 15 },
				];
				const run = await drive(ws, [], steps, {
					args: ["--model", "codex-harness/codex"],
					extensions: [codexExt],
					env: { RBF_FAKE_LOG: log, RBF_FAKE_SCENARIO: JSON.stringify(scenario) },
					timeout: 20,
				});
				expect(run.raw.toString("utf8"), "15:257 No watches running.").toContain("No watches running.");
			},
			LIMIT,
		);
	});

	describe("Scenario 17: The session file records each watch, and a notice owed survives a quit", () => {
		it(
			"PTY: session file record and notice survival across quit",
			async () => {
				const script = [
					monitorStep(ws),
					{ text: "GATE_ARMED" },
					{ text: "GATE_WOKE" },
					{ text: "GATE_BACK_1" },
					{ text: "GATE_BACK_2" },
				];

				const steps1: Step[] = [
					...START,
					...typed("go"),
					{ wait: "GATE_ARMED", timeout: 10 },
					{ wait: "GATE_WOKE", timeout: 12, needs: "15:285 GATE_WOKE arrives" },
					...typed("/monitors stop all"),
					{ wait: "Stopped 1 watch.", timeout: 6, needs: "15:285 Stopped 1 watch." },
					...typed("/quit"),
				];

				const run1 = await drive(ws, script, steps1, {
					beside: async (over) => {
						await marker("GATE_ARMED in session", () => isReply(ws.entries().slice(-1)[0] ?? {}) && texts((ws.entries().slice(-1)[0] as any).message).includes("GATE_ARMED"), 10_000, over);
						ws.append("GATE_LINE_1");
					},
					timeout: 20,
				});
				if (run1.missed) expect.fail(run1.missed);

				const entries1 = ws.entries();
				const armedEntry = entries1.find(isRecord("armed"));
				expect(armedEntry, "15:285 armed entry exists").toBeDefined();
				expect(armedEntry?.data?.description, "15:285 description gate watch").toBe("gate watch");
				expect(armedEntry?.data?.command, "15:285 command matches").toBe(`tail -n +1 -F ${ws.watched}`);
				expect(armedEntry?.data?.timeoutMs, "15:285 timeoutMs 300000").toBe(300_000);
				expect(armedEntry?.data?.id?.startsWith("mon-"), "15:285 id starts with mon-").toBe(true);
				expect(typeof armedEntry?.data?.at, "15:285 numeric at").toBe("number");

				const id = armedEntry!.data.id;
				const at = armedEntry!.data.at;

				const eventMsg = entries1.find((e) => isNotice(e) && said(e.content).includes("GATE_LINE_1"));
				expect(eventMsg, "15:285 event message exists").toBeDefined();
				expect(said(eventMsg?.content), "15:285 event message content").toBe(`Monitor event from "gate watch" (task ${id}):\nGATE_LINE_1`);
				expect(eventMsg?.details?.taskId, "15:285 details.taskId matches").toBe(id);
				expect(eventMsg?.details?.armedAt, "15:285 details.armedAt matches").toBe(at);

				const armedIdx = entries1.findIndex(isRecord("armed"));
				const eventIdx = entries1.findIndex((e) => isNotice(e) && said(e.content).includes("GATE_LINE_1"));
				const endedIdx = entries1.findIndex(isRecord("ended"));
				expect(armedIdx, "15:285 armed entry index").toBeGreaterThanOrEqual(0);
				expect(eventIdx, "15:285 event entry after armed entry").toBeGreaterThan(armedIdx);
				expect(endedIdx, "15:285 ended entry after event entry").toBeGreaterThan(eventIdx);

				const endedEntry = entries1[endedIdx];
				expect(endedEntry?.data?.id, "15:285 ended id matches").toBe(id);
				expect(endedEntry?.data?.armedAt, "15:285 ended armedAt matches").toBe(at);
				expect(endedEntry?.data?.reason, "15:285 ended reason user_stop").toBe("user_stop");
				expect(endedEntry?.data?.events, "15:285 ended events 1").toBe(1);
				expect(endedEntry?.data?.notice, "15:285 notice details present").toBeDefined();

				expect(entries1.filter(isRecord("announced")).length, "15:286 no announced entry before prompt").toBe(0);

				const steps2: Step[] = [
					...START,
					{ wait: "GATE_LINE_1", timeout: 8, needs: "15:287 screen shows old row with GATE_LINE_1" },
					{ snapshot: "reopened" },
					...typed("back"),
					{ wait: "GATE_BACK_1", timeout: 10, needs: "15:288 reply GATE_BACK_1 follows" },
					{ snapshot: "after_back_1" },
					...typed("back"),
					{ wait: "GATE_BACK_2", timeout: 10, needs: "15:289 reply GATE_BACK_2 follows" },
					{ snapshot: "after_back_2" },
				];

				const run2 = await drive(ws, script, steps2, {
					args: ["--continue"],
					timeout: 25,
				});
				if (run2.missed) expect.fail(run2.missed);

				const snapReopened = run2.snapshots.reopened!;
				const oldHeaderIdx = snapReopened.findIndex((r) => r.includes(EVENT_ROW));
				expect(oldHeaderIdx, "15:287 old event row on screen").toBeGreaterThanOrEqual(0);
				expect(snapReopened[oldHeaderIdx + 1], "15:287  └  GATE_LINE_1").toContain(" └  GATE_LINE_1");

				const snapBack1 = run2.snapshots.after_back_1!;
				const stoppedHeaderIdx = snapBack1.findIndex((r) => r.includes(STOPPED_ROW));
				expect(stoppedHeaderIdx, "15:288 stopped row on screen").toBeGreaterThanOrEqual(0);
				expect(snapBack1[stoppedHeaderIdx + 1], "15:288 Stopped from /monitors after 1 event").toContain("Stopped from /monitors after 1 event");
				const back1Idx = snapBack1.findIndex((r) => r.includes("GATE_BACK_1"));
				expect(stoppedHeaderIdx, "15:288 stopped row above GATE_BACK_1").toBeLessThan(back1Idx);

				const entries2 = ws.entries();
				const announcedList = entries2.filter(isRecord("announced"));
				expect(announcedList.length, "15:288 one announced entry").toBe(1);
				expect(announcedList[0]?.data?.reason, "15:288 reason user_stop").toBe("user_stop");
				const stoppedNotice = entries2.find((e) => isNotice(e) && said(e.content).includes("was stopped by Tomek from /monitors after 1 event. Ask him before you re-arm it."));
				expect(stoppedNotice, "15:288 stopped notice message in session file").toBeDefined();

				const entries3 = ws.entries();
				expect(entries3.filter(isRecord("announced")).length, "15:289 announced count unchanged").toBe(1);
				const stoppedNotices3 = entries3.filter((e) => isNotice(e) && said(e.content).includes("was stopped by Tomek from /monitors after 1 event"));
				expect(stoppedNotices3.length, "15:289 stopped notice count unchanged").toBe(1);
			},
			LIMIT,
		);
	});

	describe("Scenario 18: The command runs as a bash call does", () => {
		it(
			"RPC stream: same user, shell, and working directory",
			async () => {
				const script = [
					{ tool: "monitor", args: { command: 'echo "$(id -un)|$0|$PWD"; sleep 5', description: "who" } },
					{ tool: "bash", args: { command: 'echo "$(id -un)|$0|$PWD"; sleep 1' } },
					{ text: "GATE_DONE" },
				];

				await withRpc(ws, script, {}, async (pi) => {
					await pi.run("go");
					await sleep(2000);

					const entries = ws.entries();
					const bashResult = entries.find(isToolResult("bash"));
					expect(bashResult, "bash result found").toBeDefined();
					const bashLine = said(bashResult?.message?.content).trim().split("\n")[0]!;

					const eventMsg = entries.find((e) => isNotice(e) && e.details?.description === "who");
					expect(eventMsg, "monitor event message found").toBeDefined();
					const eventLines = said(eventMsg?.content).trim().split("\n");
					const monitorLine = eventLines[1]!;

					expect(monitorLine, "15:296 event line equals bash line").toBe(bashLine);
					const parts = monitorLine.split("|");
					expect(parts.length, "15:296 3 parts").toBe(3);
					const fs = await import("node:fs");
					expect(fs.realpathSync(parts[2]!), "15:296 directory is $T/work").toBe(fs.realpathSync(ws.work));
				});
			},
			LIMIT,
		);
	});
});
