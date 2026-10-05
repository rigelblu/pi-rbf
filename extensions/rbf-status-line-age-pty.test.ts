// pi-43: last-message age in a real interactive Pi under a pty, with a scripted provider (no
// model, no paid call). Run once per Pi version: the project's, and RBF_PI_BIN for the daily one.
// These wait on the wall clock for a real minute boundary, so each case takes over a minute.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const PI = process.env.RBF_PI_BIN ?? join(ROOT, "node_modules", ".bin", "pi");
const SUPPORT = resolve(import.meta.dirname, "test-support");
const DRIVER = join(SUPPORT, "rbf-row-gate-drive.py");
const ext = (name: string) => join(ROOT, "extensions", name);
const PROVIDER = join(SUPPORT, "rbf-row-gate-provider.ts");
const DAILY = [ext("rbf-background-tasks.ts"), ext("rbf-todos.ts")];
const STATUS_THEN_GUARDIAN = [...DAILY, ext("rbf-status-line.ts"), ext("rbf-cache-guardian.ts"), PROVIDER];
const GUARDIAN_THEN_STATUS = [...DAILY, ext("rbf-cache-guardian.ts"), ext("rbf-status-line.ts"), PROVIDER];
const READY = existsSync(PI) && spawnSync("python3", ["--version"]).status === 0;
const VERSION = READY ? spawnSync(PI, ["--version"], { encoding: "utf8" }).stdout.trim() : "missing";

type Step = { wait: string; count?: number } | { paste: string } | { key: string } | { sleep: number } | { snapshot: string } | { reloadReady: { path: string; loads: number } };
type Run = { extensions: string[]; mode: "regular" | "fullscreen"; cols: number; env?: Record<string, string>; steps: Step[]; timeout: number };

/** Screen text up to `offset`: styling removed, every cursor move a line break. */
function text(raw: Buffer, offset = raw.length): string[] {
	return raw
		.subarray(0, offset)
		.toString("utf8")
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]|\r/g, "\n")
		.split("\n");
}
const cueRows = (raw: Buffer, offset?: number) => text(raw, offset).filter((line) => line.includes("💬"));
const lastCueRow = (raw: Buffer, offset?: number) => cueRows(raw, offset).at(-1)?.trim() ?? "";

async function drive(run: Run) {
	const dir = mkdtempSync(join(tmpdir(), "pi43-age-pty-"));
	const sessions = join(dir, "sessions");
	mkdirSync(join(dir, "agent"));
	mkdirSync(sessions);
	const out = join(dir, "raw.bin");
	const plan = {
		argv: [
			PI, "--approve", "--no-extensions", "--no-skills", "--no-themes", "--no-context-files", "--no-prompt-templates",
			"--session-dir", sessions, "--tui-mode", run.mode,
			...run.extensions.flatMap((e) => ["-e", e]),
			"--model", "rbf-gate/gate",
		],
		cwd: ROOT,
		env: { PI_CODING_AGENT_DIR: join(dir, "agent"), PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_HYPERLINKS: "0", ...run.env },
		cols: run.cols,
		rows: 40,
		timeout: run.timeout,
		out,
		steps: run.steps,
	};
	try {
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
		const raw = existsSync(out) ? readFileSync(out) : Buffer.alloc(0);
		if (code !== 0) throw new Error(`driver exited ${code}: ${stderr.trim()}\n${text(raw).filter(Boolean).slice(-30).join("\n")}`);
		const userTimestamps = readdirSync(sessions, { recursive: true })
			.map(String)
			.filter((name) => name.endsWith(".jsonl"))
			.flatMap((name) => readFileSync(join(sessions, name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)))
			.filter((entry) => entry.type === "message" && entry.message?.role === "user")
			.map((entry) => entry.message.timestamp as number);
		return { raw, offsets: JSON.parse(stdout) as Record<string, number>, userTimestamps };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const script = (...steps: unknown[]) => ({ RBF_ROW_GATE_SCRIPT: JSON.stringify(steps) });
const TOKEN_ROW = (age: string) => new RegExp(`^💬 ${age} \\| .*\\(auto\\) {2,}\\(rbf-gate\\) gate$`);

describe.skipIf(!READY)(`pi-43: last-message age in real Pi ${VERSION}`, () => {
	describe("age native redraw", () => {
		for (const [mode, cols, extensions, order] of [
			["regular", 120, STATUS_THEN_GUARDIAN, "status line then Guardian"],
			["fullscreen", 80, GUARDIAN_THEN_STATUS, "Guardian then status line"],
			["regular", 80, GUARDIAN_THEN_STATUS, "Guardian then status line"],
			["fullscreen", 120, STATUS_THEN_GUARDIAN, "status line then Guardian"],
		] as const) {
			it.concurrent(
				`${mode} at ${cols} columns, ${order}: <1m holds for a minute, then 1m, with no typing`,
				async () => {
					const started = Date.now();
					const run = await drive({
						extensions: [...extensions],
						mode,
						cols,
						timeout: 100,
						env: script({ text: "FIRST_DONE" }),
						steps: [
							{ wait: "gate" },
							{ snapshot: "before" },
							{ paste: "first message" },
							{ key: "enter" },
							{ wait: "💬 <1m" },
							{ wait: "FIRST_DONE" },
							{ sleep: 50 },
							{ snapshot: "at-50s" },
							{ wait: "💬 1m" },
							{ sleep: 1 },
							{ snapshot: "after-minute" },
						],
					});
					expect(cueRows(run.raw, run.offsets.before), "no cue on an empty session").toEqual([]);
					expect(lastCueRow(run.raw, run.offsets["at-50s"])).toMatch(TOKEN_ROW("<1m"));
					expect(cueRows(run.raw, run.offsets["at-50s"]).some((row) => /💬 \d/.test(row)), "no minute label inside the first minute").toBe(false);
					expect(lastCueRow(run.raw, run.offsets["after-minute"])).toMatch(TOKEN_ROW("1m"));
					expect(Date.now() - started, "the change waited for the real minute").toBeGreaterThan(58_000);
					for (const row of cueRows(run.raw)) expect(row.match(/💬/g)?.length, row).toBe(1);
					expect(text(run.raw).some((line) => line.includes("📁"))).toBe(true);
				},
				130_000,
			);
		}
	});

	describe("age native queues", () => {
		// The turn keeps running for 4 s after the queued message is delivered. Without that the
		// scripted turn settles at once and a wrongly timed label would never reach the screen.
		const SLEEP_70 = { tool: "bash", args: { command: "sleep 70" } };
		const SLEEP_4 = { tool: "bash", args: { command: "sleep 4" } };
		for (const [mode, key, kind, steps, done] of [
			["regular", "enter", "steer", [SLEEP_70, SLEEP_4, { text: "ALL_DONE" }], "ALL_DONE"],
			["fullscreen", "alt-enter", "follow-up", [SLEEP_70, { text: "FIRST_DONE" }, SLEEP_4, { text: "ALL_DONE" }], "ALL_DONE"],
		] as const) {
			it.concurrent(
				`${mode}: a queued ${kind} keeps the earlier age, then shows its own age with the wait included`,
				async () => {
					const run = await drive({
						extensions: STATUS_THEN_GUARDIAN,
						mode,
						cols: 120,
						timeout: 130,
						env: script(...steps),
						steps: [
							{ wait: "gate" },
							{ paste: "first message" },
							{ key: "enter" },
							{ wait: "💬 <1m" },
							{ sleep: 5 },
							{ paste: "second message, queued" },
							{ key },
							{ sleep: 57 },
							{ snapshot: "queued-62s" },
							{ wait: done },
							{ sleep: 1 },
							{ snapshot: "delivered" },
						],
					});
					// 62 s in: the first message is 1m old, the queued one under a minute. A cue that
					// reset at queue time would read <1m here.
					expect(lastCueRow(run.raw, run.offsets["queued-62s"])).toMatch(TOKEN_ROW("1m"));
					// After delivery the queued message is over a minute old by its saved timestamp.
					// A cue timed from delivery or event arrival would have drawn <1m again.
					const afterQueue = cueRows(run.raw.subarray(run.offsets["queued-62s"]!, run.offsets.delivered));
					expect(afterQueue.some((row) => row.includes("💬 <1m")), afterQueue.join(" / ")).toBe(false);
					expect(lastCueRow(run.raw, run.offsets.delivered)).toMatch(TOKEN_ROW("1m"));
					expect(run.userTimestamps.length).toBe(2);
					const gap = run.userTimestamps[1]! - run.userTimestamps[0]!;
					expect(gap, "saved timestamp is the queue time, not delivery").toBeGreaterThan(3_000);
					expect(gap).toBeLessThan(15_000);
				},
				160_000,
			);
		}
	});

	describe("age native lifecycle", () => {
		it.concurrent(
			"two /reloads keep one current cue",
			async () => {
				const receipt = join(mkdtempSync(join(tmpdir(), "pi43-reload-")), "receipt.json");
				const run = await drive({
					extensions: [...STATUS_THEN_GUARDIAN, join(SUPPORT, "rbf-reload-probe.ts")],
					mode: "regular",
					cols: 120,
					timeout: 60,
					env: { ...script({ text: "FIRST_DONE" }), PI_RELOAD_PROBE_RECEIPT: receipt },
					steps: [
						{ wait: "gate" },
						{ paste: "first message" },
						{ key: "enter" },
						{ wait: "FIRST_DONE" },
						{ wait: "💬 <1m" },
						{ paste: "/reload" },
						{ key: "enter" },
						{ reloadReady: { path: receipt, loads: 2 } },
						{ paste: "/reload" },
						{ key: "enter" },
						{ reloadReady: { path: receipt, loads: 3 } },
						{ sleep: 1 },
						{ snapshot: "reloaded" },
					],
				});
				expect(lastCueRow(run.raw, run.offsets.reloaded)).toMatch(TOKEN_ROW("<1m"));
				for (const row of cueRows(run.raw)) expect(row.match(/💬/g)?.length, row).toBe(1);
				expect(text(run.raw).join("\n")).not.toContain("needs a Pi restart");
			},
			90_000,
		);

		it.concurrent(
			"over a wrapper from before the feature: no cue, one warning, also after /new",
			async () => {
				const run = await drive({
					extensions: [join(SUPPORT, "rbf-age-probe.ts"), ...STATUS_THEN_GUARDIAN],
					mode: "regular",
					cols: 120,
					timeout: 40,
					env: { ...script({ text: "FIRST_DONE" }), RBF_AGE_PROBE: "legacy" },
					steps: [
						{ wait: "gate" },
						{ wait: "Last msg needs a Pi restart to appear" },
						{ paste: "first message" },
						{ key: "enter" },
						{ wait: "FIRST_DONE" },
						{ paste: "/new" },
						{ key: "enter" },
						{ sleep: 2 },
						{ paste: "again" },
						{ key: "enter" },
						{ wait: "FIRST_DONE", count: 2 },
						{ sleep: 1 },
					],
				});
				expect(cueRows(run.raw)).toEqual([]);
			},
			70_000,
		);

		it.concurrent(
			"an unusable delivered timestamp shows ? with the token row intact",
			async () => {
				const run = await drive({
					extensions: [join(SUPPORT, "rbf-age-probe.ts"), ...STATUS_THEN_GUARDIAN],
					mode: "regular",
					cols: 120,
					timeout: 40,
					env: { ...script({ text: "FIRST_DONE" }), RBF_AGE_PROBE: "bad-timestamp" },
					steps: [{ wait: "gate" }, { paste: "first message" }, { key: "enter" }, { wait: "💬 \\?" }, { wait: "FIRST_DONE" }, { sleep: 1 }, { snapshot: "end" }],
				});
				expect(lastCueRow(run.raw, run.offsets.end)).toMatch(TOKEN_ROW("\\?"));
			},
			70_000,
		);

		it.concurrent(
			"print mode draws no cue and exits",
			async () => {
				const dir = mkdtempSync(join(tmpdir(), "pi43-print-"));
				try {
					const result = spawnSync(
						PI,
						["--no-extensions", "--no-skills", "--no-themes", "--no-context-files", "--no-prompt-templates", "--no-session",
							...STATUS_THEN_GUARDIAN.flatMap((e) => ["-e", e]), "--model", "rbf-gate/gate", "-p", "hello"],
						{
							cwd: ROOT,
							encoding: "utf8",
							timeout: 30_000,
							env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0", ...script({ text: "PRINT_DONE" }) },
						},
					);
					expect(result.status, result.stderr).toBe(0);
					expect(result.stdout).toContain("PRINT_DONE");
					expect(result.stdout + result.stderr).not.toContain("💬");
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			},
			60_000,
		);

		it.concurrent(
			"RPC mode sends no age status request and draws no cue",
			async () => {
				const dir = mkdtempSync(join(tmpdir(), "pi43-rpc-"));
				try {
					const result = spawnSync(
						PI,
						["--no-extensions", "--no-skills", "--no-themes", "--no-context-files", "--no-prompt-templates", "--no-session",
							...STATUS_THEN_GUARDIAN.flatMap((e) => ["-e", e]), "--model", "rbf-gate/gate", "--mode", "rpc"],
						{
							cwd: ROOT,
							encoding: "utf8",
							timeout: 30_000,
							input: `${JSON.stringify({ type: "prompt", message: "hello" })}\n`,
							env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0", ...script({ text: "RPC_DONE" }) },
						},
					);
					expect(result.stdout).toContain("RPC_DONE");
					expect(result.stdout).not.toContain("💬");
					expect(result.stdout, "the redraw request must not reach an RPC client").not.toContain("rbf-status-line-age-redraw");
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			},
			60_000,
		);
	});
});
