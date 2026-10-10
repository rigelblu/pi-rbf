// Real Escape and persisted SessionManager branches; fake native history survives reopen.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { writeInterruptionFixture } from "./test-support/rbf-codex-interruption-fixture.ts";
import type { FakeScenario, FakeTurnEvent } from "./test-support/rbf-codex-fake-app-server.ts";
import { COPY, ENTRY_TYPE, TURN_ENTRY_TYPE } from "./rbf-codex.ts";
import { binding, inspect } from "./test-support/rbf-codex-interruption-inspect.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PI = process.env.RBF_INTERRUPTION_PTY_PI_BIN ?? join(ROOT, "node_modules/.bin/pi");
const DRIVER = join(import.meta.dirname, "test-support/rbf-row-gate-drive.py");
const EXTENSION = join(import.meta.dirname, "test-support/rbf-codex-interruption-extension.ts");
const SOURCE_SHA256 = createHash("sha256").update(readFileSync(join(import.meta.dirname, "rbf-codex.ts"))).digest("hex");
const TMP = process.env.RBF_INTERRUPTION_PTY_TMPDIR ?? tmpdir();
const ansi = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]|\r/g;
type Step = Record<string, unknown>;
type RecordEntry = { id: string; parentId?: string; type: string; customType?: string; data?: { threadId?: string; turnId?: string; status?: string }; message?: { role: string; stopReason?: string; errorMessage?: string; content: any } };
const readLines = (path: string): any[] => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const answer: FakeTurnEvent[] = [{ kind: "answer", id: "answer", text: "FAKE_OK" }, { kind: "complete" }];
const submit = (text: string): Step[] => [{ paste: text }, { key: "enter" }];

function setup(cols: number, nativeEnv?: Record<string, string>) {
	const dir = mkdtempSync(join(TMP, `pi-10.6-${cols}-`));
	const cwd = nativeEnv ? join(dir, "work") : ROOT;
	if (nativeEnv) mkdirSync(cwd);
	const sessions = join(dir, "sessions");
	const agent = join(dir, "agent");
	mkdirSync(sessions); mkdirSync(agent);
	const log = join(dir, "requests.jsonl");
	const history = join(dir, "history.json");
	let sequence = 0;
	const session = () => {
		const files = readdirSync(sessions).filter((name) => name.endsWith(".jsonl"));
		expect(files).toHaveLength(1);
		return join(sessions, files[0]);
	};
	const entries = (): RecordEntry[] => readLines(session());
	async function drive(steps: Step[], scenario: FakeScenario, reopen = false, leaf?: string) {
		const rawPath = join(dir, `terminal-${++sequence}.bin`);
		const plan = {
			argv: [PI, "--no-extensions", "--no-skills", "--no-themes", "--no-context-files", "--no-prompt-templates", "--session-dir", sessions, ...(reopen ? ["--session", session()] : []), "-e", EXTENSION, "--model", "codex-harness/codex"],
			cwd,
			env: { ...nativeEnv, RBF_INTERRUPTION_PTY_REAL_CODEX: nativeEnv ? "1" : "0", RBF_INTERRUPTION_REQUEST_LOG: log, RBF_INTERRUPTION_OWNED_LOG: join(dir, "owned.jsonl"), RBF_INTERRUPTION_BENCH_RECEIPT: join(dir, "bench.json"), RBF_INTERRUPTION_INSPECT_RECEIPT: join(dir, "inspect.json"), RBF_INTERRUPTION_CRASH_RECEIPT: join(dir, "crash.json"), PI_CODING_AGENT_DIR: agent, PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0", RBF_FAKE_LOG: log, RBF_FAKE_HISTORY: history, RBF_FAKE_SCENARIO: JSON.stringify(scenario), RBF_INTERRUPTION_STREAM_LOG: join(dir, "provider-calls.jsonl"), RBF_INTERRUPTION_READY_RECEIPT: join(dir, "ready.json"), RBF_INTERRUPTION_READY_LOAD: String(sequence), RBF_INTERRUPTION_LEAF: leaf ?? "" },
			cols, rows: 38, timeout: nativeEnv ? 1170 : 35, out: rawPath,
			steps: [{ reloadReady: { path: join(dir, "ready.json"), loads: sequence, command: "/rbf-interruption-ready" }, timeout: 30 }, ...steps],
		};
		writeFileSync(join(dir, `plan-${sequence}.json`), JSON.stringify(plan));
		const run = await new Promise<{ code: number | null; stderr: string }>((done, reject) => {
			const child = spawn("python3", [DRIVER], { stdio: ["pipe", "pipe", "pipe"] });
			let stderr = "";
			child.stdout.resume(); child.stderr.setEncoding("utf8").on("data", (text) => { stderr += text; });
			const timer = setTimeout(() => child.kill("SIGTERM"), (plan.timeout + 15) * 1000);
			child.on("error", reject);
			child.on("close", (code) => { clearTimeout(timer); done({ code, stderr }); });
			child.stdin.end(JSON.stringify(plan));
		});
		expect(run, `${run.stderr} (kept ${dir})`).toMatchObject({ code: 0 });
		expect(JSON.parse(readFileSync(join(dir, "ready.json"), "utf8")).sourceSha256).toBe(SOURCE_SHA256);
		return readFileSync(rawPath, "utf8").replace(ansi, "");
	}
	const calls = () => readLines(log);
	const cleanup = () => rmSync(dir, { recursive: true, force: true });
	return { dir, sessions, history, drive, entries, calls, cleanup, session };
}

function lastCallIndex(calls: any[], method: string, before = calls.length): number {
	for (let i = before - 1; i >= 0; i--) if (calls[i].method === method) return i;
	return -1;
}

function expectHistoryGate(p: ReturnType<typeof setup>, startIndex: number, requireSteer = false) {
	const calls = p.calls();
	const previousStart = lastCallIndex(calls, "turn/start", startIndex);
	let after = previousStart;
	if (requireSteer) {
		after = lastCallIndex(calls, "turn/steer", startIndex);
		expect(after).toBeGreaterThan(previousStart);
		expect(calls.slice(previousStart + 1, startIndex).filter((m) => m.method === "turn/steer")).toHaveLength(1);
	}
	const gate = calls.slice(after + 1, startIndex);
	const resumed = gate.findIndex((m) => m.method === "thread/resume");
	const listed = gate.findIndex((m) => m.method === "thread/turns/list");
	expect(resumed, "fresh resume must follow refused steer/previous dispatch").toBeGreaterThanOrEqual(0);
	expect(listed, "full scan must follow fresh resume before new input").toBeGreaterThan(resumed);
	expect(gate[listed].params).toMatchObject({ itemsView: "full", sortDirection: "desc", limit: 5 });
}

function expectProviderCalls(p: ReturnType<typeof setup>) {
	const calls = readLines(join(p.dir, "provider-calls.jsonl"));
	expect(calls.some((m) => m.lastRole === "user" && !m.aborted)).toBe(true);
	// Both supported hosts reject the aborted post-tool re-call before this provider.
	expect(calls.some((m) => m.aborted)).toBe(false);
}

function expectRecovery(p: ReturnType<typeof setup>, total: number, thread = "thread-fake-1", starts = 1, requireSteer = false) {
	const calls = p.calls();
	expect(calls.filter((m) => m.method === "turn/start")).toHaveLength(total);
	expect(calls.filter((m) => m.method === "turn/start").at(-1).params).toMatchObject({ threadId: thread, input: [{ type: "text", text: "NEW_ONLY", text_elements: [] }] });
	expect(calls.filter((m) => m.method === "thread/start")).toHaveLength(starts);
	expect(calls.filter((m) => m.method === "thread/fork")).toHaveLength(0);
	expect(p.entries().filter((e) => e.customType === ENTRY_TYPE)).toHaveLength(1);
	expectHistoryGate(p, lastCallIndex(calls, "turn/start"), requireSteer);
	expectProviderCalls(p);
}

beforeAll(() => { console.log(`interruption host Pi=${PI} version=${execFileSync(PI, ["--version"], { encoding: "utf8" }).trim()} source_sha256=${SOURCE_SHA256}`); });

describe.each([80, 120])("pi-10.6 real Pi interruption at %i columns", (cols) => {
	for (const kind of ["text-stream", "command"] as const) {
		it.each([false, true].flatMap((later) => [false, true].map((reopen) => ({ later, reopen }))))(`${kind} interruption later=$later reopen=$reopen`, async ({ later, reopen }) => {
			const p = setup(cols);
			let passed = false;
			try {
				const hanging: FakeTurnEvent[] = kind === "command" ? [{ kind: "command", id: "sleep", command: "sleep 8", incomplete: true }, { kind: "hang" }] : [{ kind: "answer", id: "stream", text: "TEXT_STREAM" }, { kind: "hang" }];
				const scenario: FakeScenario = { retainHistory: true, turnScripts: [...(later ? [answer] : []), hanging, answer] };
				const count = later ? 2 : 1;
				const continued = [...submit("NEW_ONLY"), { waitSessionTurns: { dir: p.sessions, count: kind === "command" && reopen ? count : count + 1 } }, { wait: "FAKE_OK" }];
				const raw = await p.drive([
					...(later ? [...submit("BASELINE"), { waitSessionTurns: { dir: p.sessions, count: 1 } }] : []),
					...submit("STOPPED"), { wait: kind === "command" ? "sleep 8" : "TEXT_STREAM" }, { sleep: 0.5 }, { key: "escape" },
					...(kind === "command" ? [{ wait: "Cancelled; command still running in Codex" }, { sleep: 0.8 }] : [{ waitSessionTurns: { dir: p.sessions, count } }]),
					...(reopen ? [] : continued),
				], scenario);
				// Accepted unchanged host limit, not evidence that native history is safe.
				const stopRecorded = p.entries().some((e) => kind === "command"
					? e.message?.stopReason === "error" && e.message.errorMessage === "This operation was aborted"
					: e.message?.stopReason === "aborted");
				expect(stopRecorded).toBe(true);
				expect(JSON.parse(readFileSync(p.history, "utf8"))[count - 1].status).toBe("interrupted");
				const finalRaw = reopen ? await p.drive(continued, scenario, true) : raw;
				expect(finalRaw).not.toContain(COPY["history-unverified"]);
				expectRecovery(p, count + 1, "thread-fake-1", 1, kind === "command" && !reopen);
				if (kind === "text-stream") expect(p.entries().some((e) => e.message?.role === "toolResult" || (e.message?.role === "assistant" && e.message.content.some((b: any) => b.type === "toolCall")))).toBe(false);
				passed = stopRecorded;
			} finally { if (passed) p.cleanup(); else console.error(`kept ${p.dir}`); }
		}, 100_000);
	}

	it.each(["00000003", "00000008"])("sibling interrupted context at selected leaf %s", async (leaf) => {
		const p = setup(cols); let passed = false;
		try {
			writeInterruptionFixture(join(p.sessions, "fixture.jsonl"), ROOT);
			const raw = await p.drive([...submit("NEW_ONLY"), { wait: "FAKE_OK" }, { sleep: 0.5 }], { turnsList: [{ id: "interrupted-1", status: "interrupted", items: [{ type: "userMessage", content: [{ type: "text", text: "STOPPED" }] }] }] }, true, leaf);
			expect(raw).not.toContain(COPY["history-unverified"]);
			expectRecovery(p, 1, "fixture-thread", 0);
			const entries = p.entries();
			const newInput = entries.find((e) => e.message?.role === "user" && JSON.stringify(e.message.content).includes("NEW_ONLY"))!;
			const parent = entries.find((e) => e.id === newInput.parentId)!;
			// Pi 1.0.2 persists its system projection before the user. It must descend
			// directly from the selected leaf, not from the interrupted sibling.
			if (parent.message?.role === "system") expect(parent.parentId).toBe(leaf);
			else expect(newInput.parentId).toBe(leaf);
			passed = true;
		} finally { if (passed) p.cleanup(); else console.error(`kept ${p.dir}`); }
	}, 60_000);

	it("completed sibling history without U refuses", async () => {
		const p = setup(cols); let passed = false;
		try {
			writeInterruptionFixture(join(p.sessions, "fixture.jsonl"), ROOT);
			await p.drive([...submit("NEW_ONLY"), { wait: "Codex history for this branch could not be verified" }], { turnsList: [{ id: "completed-sibling", status: "completed", items: [{ type: "userMessage", content: [{ type: "text", text: "OLD" }] }] }] }, true, "00000003");
			expect(p.calls().filter((m) => ["turn/start", "thread/start", "thread/fork"].includes(m.method))).toHaveLength(0);
			expect(p.entries().filter((e) => e.customType === ENTRY_TYPE)).toHaveLength(1);
			expect(p.entries().some((e) => e.message?.role === "user" && JSON.stringify(e.message.content).includes("NEW_ONLY"))).toBe(true);
			passed = true;
		} finally { if (passed) p.cleanup(); else console.error(`kept ${p.dir}`); }
	}, 60_000);

	it.each(["failed", "inProgress", "unreadable"])("undrained command refuses native %s before fresh dispatch", async (status) => {
		const p = setup(cols); let passed = false;
		try {
			const scenario: FakeScenario = { retainHistory: true,
				...(status === "failed" ? { ignoreInterrupt: true } : status === "unreadable" ? { turnsListError: "unreadable" } : { turnsList: [{ id: "active", status: "inProgress", items: [] }] }),
				turnScripts: [[{ kind: "command", id: "sleep", command: "sleep 8", incomplete: true }, ...(status === "failed" ? [{ kind: "sleep", ms: 1200 }, { kind: "complete", status: "failed" }] as FakeTurnEvent[] : [{ kind: "hang" }] as FakeTurnEvent[])], answer],
			};
			await p.drive([...submit("STOPPED"), { wait: "sleep 8" }, { sleep: .5 }, { key: "escape" }, { wait: "Cancelled; command still running in Codex" }, { sleep: 1.5 }, ...submit("NEW_ONLY"), { wait: "Codex history for this branch could not be verified" }], scenario);
			expect(p.entries().some((e) => e.message?.stopReason === "error" && e.message.errorMessage === "This operation was aborted")).toBe(true);
			if (status === "failed") expect(JSON.parse(readFileSync(p.history, "utf8"))[0].status).toBe("failed");
			const calls = p.calls();
			expect(calls.filter((m) => m.method === "turn/start")).toHaveLength(1);
			expect(calls.filter((m) => m.method === "thread/start")).toHaveLength(1);
			expect(calls.filter((m) => m.method === "thread/fork")).toHaveLength(0);
			expect(calls.filter((m) => m.method === "turn/steer")).toHaveLength(1);
			expect(p.entries().some((e) => e.message?.role === "user" && JSON.stringify(e.message.content).includes("NEW_ONLY"))).toBe(true);
			const steer = lastCallIndex(calls, "turn/steer");
			expect(steer).toBeGreaterThan(0);
			expect(calls.slice(steer + 1).map((m) => m.method)).toContain("thread/resume");
			expect(calls.slice(steer + 1).map((m) => m.method)).toContain("thread/turns/list");
			expectProviderCalls(p);
			passed = true;
		} finally { if (passed) p.cleanup(); else console.error(`kept ${p.dir}`); }
	}, 90_000);

	it.each(["interrupted", "inProgress", "unreadable"])("forced-close fallback reopens native %s", async (status) => {
		const p = setup(cols); let passed = false;
		try {
			await p.drive([...submit("STOPPED"), { wait: "TEXT_STREAM" }, { key: "escape" }, { waitSessionTurns: { dir: p.sessions, count: 1 } }], { retainHistory: true, ignoreInterrupt: true, turn: [{ kind: "answer", id: "stream", text: "TEXT_STREAM" }, { kind: "hang" }] });
			expect(p.entries().some((e) => e.message?.stopReason === "aborted")).toBe(true);
			const native = JSON.parse(readFileSync(p.history, "utf8"));
			expect(native[0].status).toBe("inProgress");
			native[0].status = status; writeFileSync(p.history, JSON.stringify(native));
			await p.drive([...submit("NEW_ONLY"), { wait: status === "interrupted" ? "FAKE_OK" : "Codex history for this branch could not be verified" }], { retainHistory: true, ...(status === "unreadable" ? { turnsListError: "unreadable" } : {}) }, true);
			if (status === "interrupted") expectRecovery(p, 2);
			else {
				expect(p.calls().filter((m) => m.method === "turn/start")).toHaveLength(1);
				expect(p.calls().filter((m) => m.method === "thread/start")).toHaveLength(1);
				expect(p.calls().filter((m) => m.method === "thread/fork")).toHaveLength(0);
			}
			passed = true;
		} finally { if (passed) p.cleanup(); else console.error(`kept ${p.dir}`); }
	}, 90_000);
});

const nativeEnabled = process.env.RBF_INTERRUPTION_PTY_REAL_CODEX === "1";
const CODEX = process.env.RBF_INTERRUPTION_PTY_CODEX_BIN ?? join(homedir(), ".local/bin/codex");
const recall = "Do not repeat the previous command. Reply only with the nonce from my earlier message.";
const commandStarted = (p: ReturnType<typeof setup>, count: number): Step => ({ waitJsonl: { path: join(p.dir, "requests.jsonl"), field: "method", value: "probe/command-start", unique: "params", count }, timeout: 180 });
function expectNativeCounts(result: Awaited<ReturnType<typeof inspect>>, later = false) {
	expect(result).toEqual({ same_thread: true, bindings: 1, user_turns: later ? 4 : 2, interrupted: later ? 2 : 1, completed: later ? 2 : 1, nonce_inputs: 1, nonce_recall: true, sleep_commands: later ? 2 : 1 });
}
async function waitOwnedExit(p: ReturnType<typeof setup>) {
	const path = join(p.dir, "owned.jsonl");
	const deadline = Date.now() + 7000;
	while (Date.now() < deadline) {
		const events = readLines(path);
		const spawned = events.filter((e) => e.event === "spawn");
		if (spawned.length && spawned.every((e) => events.some((end) => end.event === "exit" && end.pid === e.pid))) return;
		await new Promise((done) => setTimeout(done, 100));
	}
	throw new Error("Test-owned Codex child exit not observed");
}
function nativeSetup() {
	const nonce = `CONTINUE-${randomUUID()}`;
	const oldHome = process.env.CODEX_HOME;
	const auth = join(oldHome ?? join(homedir(), ".codex"), "auth.json");
	if (!existsSync(auth)) throw new Error("Native probe requires existing Codex login");
	const env = { RBF_INTERRUPTION_PTY_CODEX_BIN: CODEX, RBF_INTERRUPTION_NONCE: nonce, CODEX_HOME: "" };
	const p = setup(80, env);
	const home = join(p.dir, "codex-home");
	mkdirSync(home);
	writeFileSync(join(home, "config.toml"), 'approval_policy = "never"\nsandbox_mode = "workspace-write"\n');
	const authCopy = join(home, "auth.json");
	const removeAuth = () => rmSync(authCopy, { force: true });
	onTestFinished(removeAuth);
	process.once("exit", removeAuth);
	copyFileSync(auth, authCopy);
	env.CODEX_HOME = home;
	process.env.CODEX_HOME = home;
	return { p, nonce, async finish(passed: boolean) {
		try {
			// Only PIDs recorded by this probe, never a broad process scan.
			const events = readLines(join(p.dir, "owned.jsonl"));
			for (const entry of events.filter((e) => e.event === "spawn" && !events.some((end) => end.event === "exit" && end.pid === e.pid))) {
				try {
					const command = execFileSync("ps", ["-p", String(entry.pid), "-o", "command="], { encoding: "utf8" }).trim();
					if (command.includes("codex") && command.includes("app-server")) process.kill(entry.pid, "SIGKILL");
				} catch { /* captured child already exited */ }
			}
		} finally {
			removeAuth();
			process.removeListener("exit", removeAuth);
			if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
			if (passed) p.cleanup(); else console.error(`kept native receipts without auth: ${p.dir}`);
		}
	} };
}
function expectNativeDispatch(p: ReturnType<typeof setup>, inputs: string[], commands: number) {
	const saved = binding(p.session());
	const calls = p.calls();
	expect(calls.filter((m) => m.method === "thread/start")).toHaveLength(1);
	expect(calls.filter((m) => m.method === "thread/fork")).toHaveLength(0);
	const started = calls.filter((m) => m.method === "probe/command-start");
	expect(started).toHaveLength(commands);
	expect(new Set(started.map((m) => m.params.itemId)).size).toBe(commands);
	for (const item of started) {
		expect(item.params.threadId).toBe(saved.threadId);
		expect(item.params.command).toMatch(/\/bin\/sleep\s+8(?=$|[\s'"])/);
	}
	expect(calls.filter((m) => m.method === "turn/start").map((m) => ({ threadId: m.params.threadId, input: m.params.input }))).toEqual(inputs.map((text) => ({ threadId: saved.threadId, input: [{ type: "text", text, text_elements: [] }] })));
}

describe.runIf(nativeEnabled)("pi-10.6 opt-in real Codex", () => {
	it("retained-context round trip", async () => {
		const n = nativeSetup(); const { p, nonce } = n; let passed = false;
		const first = `Remember nonce ${nonce}. Run /bin/sleep 8 once, then reply DONE.`;
		try {
			const raw = await p.drive([
				...submit(first), commandStarted(p, 1), { wait: "\\$ .*sleep 8", timeout: 180 }, { sleep: .25 }, { key: "escape" }, { wait: "Cancelled; command still running in Codex", timeout: 30 }, { sleep: 1 },
				...submit("/rbf-test-bench"), { wait: "RBF_BENCH_DONE", timeout: 360 },
				...submit(recall), { waitSessionTurns: { dir: p.sessions, count: 2 }, timeout: 180 }, { sleep: .5 },
				...submit("/rbf-test-inspect"), { wait: "RBF_INSPECT_DONE", timeout: 60 },
				...submit("Run /bin/sleep 8 once, then reply DONE."), commandStarted(p, 2), { sleep: .25 }, { key: "escape" }, { sleep: 1 },
			], {});
			expect(raw).not.toContain(COPY["history-unverified"]);
			await waitOwnedExit(p);
			const timing = JSON.parse(readFileSync(join(p.dir, "bench.json"), "utf8"));
			expect(timing.error, timing.error).toBeUndefined();
			expect(timing.samples).toBeGreaterThanOrEqual(10); expect(timing.p95_ms).toBeLessThanOrEqual(2000); expect(timing.turn_starts).toBe(0);
			console.log(`native Pi=${PI} ${Object.entries(timing).map(([key, value]) => `${key}=${value}`).join(" ")}`);
			expectNativeCounts(JSON.parse(readFileSync(join(p.dir, "inspect.json"), "utf8")));
			const reopened = await p.drive([...submit(recall), { waitSessionTurns: { dir: p.sessions, count: 3 }, timeout: 180 }], {}, true);
			expect(reopened).not.toContain(COPY["history-unverified"]);
			const counts = await inspect(p.session(), CODEX, nonce);
			expectNativeCounts(counts, true);
			expectNativeDispatch(p, [first, recall, "Run /bin/sleep 8 once, then reply DONE.", recall], 2);
			const starts = p.calls().flatMap((m, i) => m.method === "turn/start" ? [i] : []);
			// The earlier benchmark scan cannot satisfy this post-steer gate.
			expectHistoryGate(p, starts[1], true);
			expectHistoryGate(p, starts[2]);
			expectHistoryGate(p, starts[3]);
			expectProviderCalls(p);
			await waitOwnedExit(p);
			console.log(`${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(" ")} turn_starts=${starts.length} direct_post_steer_gate=true owned_servers_exited=true`);
			passed = true;
		} finally { await n.finish(passed); }
	}, 2_400_000);

	it("first-turn child loss", async () => {
		const n = nativeSetup(); const { p, nonce } = n; let passed = false;
		const first = `Remember nonce ${nonce}. Run /bin/sleep 8 once, then reply DONE.`;
		try {
			await p.drive([...submit(first), commandStarted(p, 1), { wait: "\\$ .*sleep 8", timeout: 180 }, ...submit("/rbf-test-crash"), { sleep: 1 }], {});
			expect(JSON.parse(readFileSync(join(p.dir, "crash.json"), "utf8"))).toMatchObject({ saved: true, no_completed_U: true });
			await waitOwnedExit(p);
			const before = await inspect(p.session(), CODEX, nonce);
			expect(before).toMatchObject({ user_turns: 1, interrupted: 1, completed: 0, nonce_inputs: 1 });
			const raw = await p.drive([...submit(recall), { waitSessionTurns: { dir: p.sessions, count: 1 }, timeout: 180 }], {}, true);
			expect(raw).not.toContain(COPY["history-unverified"]);
			const counts = await inspect(p.session(), CODEX, nonce);
			expectNativeCounts(counts);
			expectNativeDispatch(p, [first, recall], 1);
			expectHistoryGate(p, lastCallIndex(p.calls(), "turn/start"));
			expectProviderCalls(p);
			await waitOwnedExit(p);
			console.log(`child_loss=true ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(" ")} turn_starts=${p.calls().filter((m) => m.method === "turn/start").length} owned_servers_exited=true`);
			passed = true;
		} finally { await n.finish(passed); }
	}, 2_400_000);
});
