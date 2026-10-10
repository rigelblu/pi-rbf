// Real Pi's tree redraw, not a fake ExtensionContext, decides whether compaction notices survive.
// Run with RBF_COMPACT_PTY_PI_BIN set to the other installed Pi binary to check both versions.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const PI = process.env.RBF_COMPACT_PTY_PI_BIN ?? join(ROOT, "node_modules", ".bin", "pi");
const DRIVER = join(import.meta.dirname, "test-support", "rbf-row-gate-drive.py");
const FAKE = join(import.meta.dirname, "test-support", "rbf-row-gate-codex.ts");
const REWIND = join(import.meta.dirname, "rbf-rewind.ts");
const RELOAD_PROBE = join(import.meta.dirname, "test-support", "rbf-reload-probe.ts");
const TMP = process.env.RBF_COMPACT_PTY_TMPDIR ?? tmpdir();
const ansi = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]|\r/g;

async function driveNavigation(phase: "checking" | "running" | "draft" | "snapshot" | "return" | "terminal-first" | "failed" | "unknown" | "refused" | "queued", target: "user" | "assistant" = "user", reloads = 0) {
	const dir = mkdtempSync(join(TMP, `pi-10.5-${phase}-`));
	const sessions = join(dir, "sessions");
	const agent = join(dir, "agent");
	mkdirSync(sessions);
	mkdirSync(agent);
	const log = join(dir, "fake.jsonl");
	const rawPath = join(dir, "terminal.bin");
	const reloadReceipt = join(dir, "reload.json");
	const scenario = { resumeTurns: target === "assistant" ? [{ id: "turn-fake-1", status: "completed" }, { id: "turn-fake-2", status: "completed" }] : [{ id: "turn-fake-1", status: "completed" }], dynamicResumeTurns: target === "assistant", ...(phase === "checking" || phase === "draft" ? { turnsListDelayMs: 2500 } : { compactDelayMs: phase === "return" || phase === "queued" ? 7000 : phase === "terminal-first" ? 10 : 5000 }), ...(phase === "failed" ? { compactTurn: { status: "failed", includeItem: true } } : phase === "unknown" ? { compactTurn: { status: "completed", includeItem: false } } : phase === "refused" ? { compactStartError: "sensitive internal refusal" } : {}) };
	const ready = [
		{ wait: "\\[Extensions\\]" }, { sleep: 0.5 }, { paste: "Reply exactly FAKE_OK." }, { key: "enter" },
		{ waitSessionTurns: { dir: sessions, count: 1 } },
		...(target === "assistant" ? [{ sleep: 0.5 }, { paste: "Reply exactly FAKE_OK again." }, { key: "enter" }, { waitSessionTurns: { dir: sessions, count: 2 } }] : []),
		{ sleep: 0.8 },
		...Array.from({ length: reloads }, (_, index) => [
			{ paste: "/reload" }, { key: "enter" }, { reloadReady: { path: reloadReceipt, loads: index + 2 } },
		]).flat(),
		...(phase === "snapshot" ? [{ sessionSnapshot: { name: "before", dir: sessions } }] : []),
		{ paste: "/compact" }, { key: "enter" },
	];
	const navigation = [
		{ paste: "/tree" }, { key: "enter" }, { sleep: 0.5 },
		...(target === "user" ? [{ key: "up" }] : [{ key: "up" }, { key: "up" }]), { key: "enter" },
		{ wait: "Summarize branch" }, { key: "enter" }, { wait: "Navigated to selected point" },
	];
	const steps = phase === "checking"
		? [...ready, { wait: "Checking Codex branch" }, { key: "ctrl-u" }, ...navigation, { wait: "Codex conversation moved or changed while checking" }, { sleep: 0.5 }]
		: phase === "draft"
			? [...ready, { wait: "Checking Codex branch" }, { paste: " changed" }, { wait: "Command changed while Codex checked this branch" }, { sleep: 0.5 }]
			: phase === "snapshot"
				? [...ready, { wait: "Codex context compacted" }, { sleep: 0.5 }, { sessionSnapshot: { name: "after", dir: sessions } }]
				: phase === "terminal-first"
					? [...ready, { wait: "Codex context compacted" },
						{ paste: "/tree" }, { key: "enter" }, { key: "up" }, { key: "enter" },
						{ wait: "Summarize branch" }, { key: "enter" },
						{ wait: "Navigated to selected point" }, { wait: "Codex compacted the branch where /compact started" }]
				: phase === "refused"
					? [...ready, { wait: "Codex context was not compacted: Codex refused this thread." }]
				: phase === "queued"
					? [...ready, { wait: "Compacting Codex context" }, ...navigation,
						{ wait: "Navigated to selected point" }, { paste: "Reply with one word: READY" }, { key: "enter" },
						{ waitSessionTurns: { dir: sessions, count: 2 } },
						{ wait: "Codex compacted the branch where /compact started" }]
				: phase === "return"
					? [...ready, { wait: "Compacting Codex context" }, ...navigation,
						{ wait: "Navigated to selected point" }, { paste: "/tree" }, { key: "enter" },
						{ sleep: 0.5 }, { key: "down" }, { key: "down" }, { key: "enter" },
						{ wait: "Summarize branch", count: 2 }, { key: "enter" },
						{ wait: "Navigated to selected point", count: 2 },
						{ wait: "Codex compacted the branch where /compact started" }, { sleep: 0.5 }]
					: [...ready, { wait: "Compacting Codex context" }, ...navigation,
						{ wait: phase === "failed" ? "Codex context was not compacted on the branch where /compact started" : phase === "unknown" ? "Codex context may have changed on the branch where /compact started" : "Codex compacted the branch where /compact started" }, { sleep: 0.5 }];
	const plan = {
		argv: [PI, "--no-extensions", "--no-skills", "--no-themes", "--no-context-files", "--no-prompt-templates", "--session-dir", sessions, "-e", FAKE, "-e", REWIND, ...(reloads ? ["-e", RELOAD_PROBE] : []), "--model", "codex-harness/codex"],
		cwd: ROOT,
		env: { PI_CODING_AGENT_DIR: agent, PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0", RBF_FAKE_LOG: log, RBF_FAKE_SCENARIO: JSON.stringify(scenario), ...(reloads ? { PI_RELOAD_PROBE_RECEIPT: reloadReceipt } : {}) },
		cols: 105, rows: 38, timeout: 50, out: rawPath, steps,
	};
	writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
	const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn("python3", [DRIVER], { stdio: ["pipe", "pipe", "pipe"] });
		let stderr = "";
		let stdout = "";
		child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
		child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
		const timer = setTimeout(() => child.kill("SIGTERM"), 100_000);
		child.on("error", reject);
		child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
		child.stdin.end(JSON.stringify(plan));
	});
	if (run.code !== 0) throw new Error(`Pi PTY ${phase} failed: ${run.stderr || run.code} (kept ${dir})`);
	try {
		const raw = readFileSync(rawPath, "utf8").replace(ansi, "");
		const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method?: string; params?: { threadId?: string } });
		const file = readdirSync(sessions).find((name) => name.endsWith(".jsonl"));
		if (!file) throw new Error("Pi produced no session JSONL");
		const entries = readFileSync(join(sessions, file), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type?: string; customType?: string; message?: { role?: string } });
		return { raw, calls, entries, snapshots: JSON.parse(run.stdout) as Record<string, { sha256: string; bytes: number }> };
	} finally {
		if (!process.env.RBF_COMPACT_PTY_KEEP) rmSync(dir, { recursive: true, force: true });
	}
}

describe("pi-10.5 real Pi navigation during Codex compaction", () => {
	it("checking cancels on /tree, preserves Pi's user-leaf prefill, and warns after navigation", async () => {
		expect(existsSync(PI)).toBe(true);
		const { raw, calls, entries } = await driveNavigation("checking");
		const navigated = raw.indexOf("Navigated to selected point");
		const warned = raw.indexOf("Codex conversation moved or changed while checking");
		expect(navigated).toBeGreaterThanOrEqual(0);
		expect(warned).toBeGreaterThan(navigated);
		expect(raw.slice(warned)).toContain("Reply exactly FAKE_OK.");
		expect(calls.filter((m) => m.method === "thread/compact/start")).toHaveLength(0);
		expect(entries.filter((e) => e.type === "compaction")).toHaveLength(0);
	}, 75_000);

	it("running stays on the captured thread and reports branch-qualified success after Pi's redraw", async () => {
		expect(existsSync(PI)).toBe(true);
		const { raw, calls, entries } = await driveNavigation("running");
		const navigated = raw.indexOf("Navigated to selected point");
		const progress = raw.indexOf("Compacting Codex context on the branch where /compact started");
		const complete = raw.indexOf("Codex compacted the branch where /compact started");
		expect(navigated).toBeGreaterThanOrEqual(0);
		expect(progress).toBeGreaterThan(navigated);
		expect(complete).toBeGreaterThan(progress);
		expect(raw.slice(complete)).toContain("Reply exactly FAKE_OK.");
		expect(calls.filter((m) => m.method === "thread/compact/start").map((m) => m.params?.threadId)).toEqual(["thread-fake-1"]);
		expect(entries.filter((e) => e.type === "compaction")).toHaveLength(0);
	}, 75_000);

	it("checking cancellation after selecting an assistant leaf preserves Pi's cleared editor", async () => {
		const { raw, calls, entries } = await driveNavigation("checking", "assistant");
		const navigated = raw.indexOf("Navigated to selected point");
		const warned = raw.indexOf("Codex conversation moved or changed while checking");
		expect(navigated).toBeGreaterThanOrEqual(0);
		expect(warned).toBeGreaterThan(navigated);
		// The warning contains one /compact; a second occurrence would be a restored editor draft.
		expect(raw.slice(warned).match(/\/compact/g)).toHaveLength(1);
		expect(calls.filter((m) => m.method === "thread/compact/start")).toHaveLength(0);
		expect(entries.filter((e) => e.type === "compaction")).toHaveLength(0);
	}, 75_000);

	it("two /reload cycles leave one active compact dispatcher on the selected Codex branch", async () => {
		const { raw, calls, entries } = await driveNavigation("running", "user", 2);
		expect(raw).toContain("Codex compacted the branch where /compact started");
		expect(calls.filter((m) => m.method === "thread/compact/start").map((m) => m.params?.threadId)).toEqual(["thread-fake-1"]);
		expect(entries.filter((e) => e.type === "compaction")).toHaveLength(0);
	}, 90_000);

	it("editing /compact during a slow check retains the new draft without dispatch", async () => {
		const { raw, calls, entries } = await driveNavigation("draft");
		const warned = raw.indexOf("Command changed while Codex checked this branch");
		expect(warned).toBeGreaterThanOrEqual(0);
		expect(raw.slice(warned)).toContain("/compact changed");
		expect(calls.filter((m) => m.method === "thread/compact/start")).toHaveLength(0);
		expect(entries.filter((e) => e.type === "compaction")).toHaveLength(0);
	}, 75_000);

	it("manual /compact leaves Pi's persisted session bytes unchanged", async () => {
		const { calls, entries, snapshots } = await driveNavigation("snapshot");
		expect(snapshots.before.bytes).toBeGreaterThan(0);
		expect(snapshots.after).toEqual(snapshots.before);
		expect(calls.filter((m) => m.method === "thread/compact/start")).toHaveLength(1);
		expect(entries.filter((e) => e.type === "compaction")).toHaveLength(0);
	}, 75_000);

	it("return navigation while running never switches the captured compact thread", async () => {
		const { raw, calls, entries } = await driveNavigation("return", "assistant");
		expect(raw.match(/Navigated to selected point/g)?.length).toBeGreaterThanOrEqual(2);
		expect(raw).toContain("Codex compacted the branch where /compact started");
		expect(calls.filter((m) => m.method === "thread/compact/start").map((m) => m.params?.threadId)).toEqual(["thread-fake-1"]);
		expect(entries.filter((e) => e.type === "compaction")).toHaveLength(0);
	}, 75_000);

	it("a terminal result just before /tree redraw is re-announced for the branch where compact started", async () => {
		const { raw, calls, entries } = await driveNavigation("terminal-first");
		expect(raw.indexOf("Codex compacted the branch where /compact started")).toBeGreaterThan(raw.indexOf("Navigated to selected point"));
		expect(calls.filter((m) => m.method === "thread/compact/start")).toHaveLength(1);
		expect(entries.filter((e) => e.type === "compaction")).toHaveLength(0);
	}, 75_000);

	it.each([
		["failed", "Codex context was not compacted on the branch where /compact started"],
		["unknown", "Codex context may have changed on the branch where /compact started"],
	] as const)("%s compact outcome after navigation stays branch-qualified", async (phase, notice) => {
		const { raw, calls, entries } = await driveNavigation(phase);
		expect(raw.indexOf(notice)).toBeGreaterThan(raw.indexOf("Navigated to selected point"));
		expect(raw).not.toContain("sensitive internal refusal");
		expect(calls.filter((m) => m.method === "thread/compact/start")).toHaveLength(1);
		expect(entries.filter((e) => e.type === "compaction")).toHaveLength(0);
	}, 75_000);

	it("a synchronous refusal in real Pi shows only the safe reason", async () => {
		const { raw, calls, entries } = await driveNavigation("refused");
		expect(raw).toContain("Codex context was not compacted: Codex refused this thread.");
		expect(raw).not.toContain("sensitive internal refusal");
		expect(calls.filter((m) => m.method === "thread/compact/start")).toHaveLength(1);
		expect(entries.filter((e) => e.type === "compaction")).toHaveLength(0);
	}, 75_000);

	it("a prompt on the navigated leaf waits for old-branch compaction and starts only once", async () => {
		const { raw, calls, entries } = await driveNavigation("queued");
		expect(raw).toContain("Codex compacted the branch where /compact started");
		const methods = calls.map((m) => m.method);
		expect(methods.filter((m) => m === "thread/compact/start")).toHaveLength(1);
		expect(methods.filter((m) => m === "turn/start")).toHaveLength(2);
		expect(methods.lastIndexOf("turn/start")).toBeGreaterThan(methods.indexOf("thread/compact/start"));
		expect(entries.filter((e) => e.type === "compaction")).toHaveLength(0);
	}, 75_000);

	it("a non-Codex model still takes Pi's native /compact route", async () => {
		const dir = mkdtempSync(join(TMP, "pi-10.5-native-"));
		const agent = join(dir, "agent");
		const sessions = join(dir, "sessions");
		mkdirSync(agent);
		mkdirSync(sessions);
		const rawPath = join(dir, "terminal.bin");
		const plan = {
			argv: [PI, "--no-extensions", "--no-skills", "--no-themes", "--no-context-files", "--no-prompt-templates", "--session-dir", sessions, "-e", FAKE, "--model", "openai-codex/gpt-5.6-luna"],
			cwd: ROOT,
			env: { PI_CODING_AGENT_DIR: agent, PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1" },
			cols: 105, rows: 38, timeout: 20, out: rawPath,
			steps: [{ wait: "\\[Extensions\\]" }, { sleep: 0.5 }, { paste: "/compact" }, { key: "enter" }, { wait: "Nothing to compact \\(session too small\\)" }],
		};
		const run = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
			const child = spawn("python3", [DRIVER], { stdio: ["pipe", "pipe", "pipe"] });
			let stderr = "";
			child.stdout.resume();
			child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
			child.on("error", reject);
			child.on("close", (code) => resolve({ code, stderr }));
			child.stdin.end(JSON.stringify(plan));
		});
		try {
			expect(run, run.stderr).toMatchObject({ code: 0 });
			const raw = readFileSync(rawPath, "utf8").replace(ansi, "");
			expect(raw).toContain("Compaction failed: Nothing to compact (session too small)");
			expect(raw).not.toContain("Codex manages its own context");
		} finally {
			if (!process.env.RBF_COMPACT_PTY_KEEP) rmSync(dir, { recursive: true, force: true });
		}
	}, 40_000);
});
