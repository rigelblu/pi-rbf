import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const PI = process.env.RBF_PI_BIN ?? join(ROOT, "node_modules", ".bin", "pi");
const SUPPORT = resolve(import.meta.dirname, "test-support");
const DRIVER = join(SUPPORT, "rbf-row-gate-drive.py");

const EXTENSIONS = [
	join(ROOT, "extensions", "rbf-background-tasks.ts"),
	join(ROOT, "extensions", "rbf-todos.ts"),
	join(ROOT, "extensions", "rbf-status-line.ts"),
	join(ROOT, "extensions", "rbf-cache-guardian.ts"),
];

const RELOAD_EXTENSIONS = [...EXTENSIONS, join(SUPPORT, "rbf-reload-probe.ts")];
const TOOL_EXTENSIONS = [
	join(ROOT, "extensions", "rbf-background-tasks.ts"),
	join(ROOT, "extensions", "rbf-todos.ts"),
	join(ROOT, "extensions", "rbf-clean-markdown-code.ts"),
	join(ROOT, "extensions", "rbf-edit-glance.ts"),
	join(ROOT, "extensions", "rbf-tool-execution-blended.ts"),
	join(SUPPORT, "rbf-row-gate-provider.ts"),
];

const PYTHON = spawnSync("python3", ["--version"]).status === 0;
const READY = existsSync(PI) && PYTHON;

type Step = { wait: string; count?: number } | { paste: string } | { key: string } | { sleep: number } | { snapshot: string };
type Run = {
	extensions: string[];
	model?: string;
	cwd?: string;
	env?: Record<string, string>;
	steps: Step[];
};
type Capture = { raw: Buffer; lines: string[]; offsets: Record<string, number>; snapshots: Record<string, string[]> };

function plainTerminal(raw: Buffer): string[] {
	const ESCAPES =
		/\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]|\r/g;
	return raw.toString("utf8").replace(ESCAPES, "").split("\n");
}

function screen(raw: Buffer, styled = false): string[] {
	const rows: string[] = [""];
	let row = 0;
	let restart = false;
	const begin = () => {
		if (restart) {
			rows[row] = "";
			restart = false;
		}
	};
	const tokens =
		raw
			.toString("utf8")
			.match(
				/\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^[\]]|[^\x1b]+/gu,
			) ?? [];
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
				case "m":
					begin();
					rows[row] += t;
					break;
				default:
					break;
			}
		} else if (t.startsWith("\x1b]")) {
			begin();
			rows[row] += t;
		} else if (t.startsWith("\x1b")) {
			// ignore ESC sequence
		} else {
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
	const ESCAPES =
		/\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]|\r/g;
	return rows.map((r) => (styled ? r : r.replace(ESCAPES, "")).trim());
}

class TestWorkspace {
	readonly dir = mkdtempSync(join(tmpdir(), "pi17-resume-test-"));
	readonly agent = join(this.dir, "agent");
	readonly sessions = join(this.dir, "sessions");
	constructor() {
		mkdirSync(this.agent);
		mkdirSync(this.sessions);
	}
	cleanup() {
		try {
			rmSync(this.dir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
}

function seedSession(ws: TestWorkspace, name: string, cwd = ROOT): void {
	const timestamp = new Date(Date.now() - 60000).toISOString();
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	const sessionId = `session-${name}-disposable`;
	const filePath = join(ws.sessions, `${fileTimestamp}_${sessionId}.jsonl`);
	const entries = [
		{ type: "session", version: 3, id: sessionId, timestamp, cwd },
		{ type: "session_info", id: "info1", parentId: null, name, timestamp },
		{
			type: "message",
			id: "m1",
			parentId: "info1",
			message: { role: "user", content: [{ type: "text", text: "hello old session" }] },
			timestamp,
		},
		{
			type: "message",
			id: "m2",
			parentId: "m1",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "ready" }],
				usage: { input: 10, output: 5, cost: { total: 0.001 } },
			},
			timestamp,
		},
	];
	writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

function expectFooter(lines: string[], name: string, guardian = false): void {
	const row = lines.findIndex((line) => line.includes(`• ${name}`) && line.includes("📁"));
	expect(row, `rich footer for ${name}:\n${lines.slice(-15).join("\n")}`).toBeGreaterThanOrEqual(0);
	expect(lines[row]).toContain("🌴");
	const metrics = lines[row + 1] ?? "";
	expect(metrics, "native metrics directly below rich row").toMatch(/\d+\.\d+%\/[\d.]+[kM] \(auto\).*(?:medium|gate)/);
	if (guardian) expect(lines[row]).toMatch(/5m TTL.*1\.0k cached/);
	else expect(lines[row]).not.toContain("TTL");
}

function expectToolRows(raw: Buffer, fileName: string, body: string): void {
	const transcript = plainTerminal(raw).map((line) => line.trimEnd());
	const readIndex = transcript.findIndex((line) => line.trimStart().startsWith("read ") && line.includes(fileName));
	const readBodyIndex = transcript.findIndex((line) => line.trim() === body);
	const editIndex = transcript.findIndex((line, index) => index > readBodyIndex && line.trimStart().startsWith("edit "));
	expect(readIndex).toBeGreaterThanOrEqual(0);
	expect(readBodyIndex).toBeGreaterThan(readIndex);
	expect(editIndex).toBeGreaterThan(readBodyIndex);
	expect(transcript.slice(readIndex, editIndex).some((line) => /^```/.test(line.trim()))).toBe(false);
	expect(transcript.slice(editIndex).some((line) => line.includes("Added 1 line") && line.includes("removed 1 line"))).toBe(true);
}

function expectTransparentCollapsedRows(raw: Buffer, offset: number, fileName: string, editName: string): void {
	const rows = screen(raw.subarray(0, offset), true);
	const unstyled = (row: string) => row.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "");
	for (const [kind, name] of [["read", fileName], ["edit", editName]]) {
		const row = rows.find((candidate) => {
			const line = unstyled(candidate);
			return line.includes(`${kind} `) && line.includes(name);
		});
		expect(row, `collapsed ${kind} ${name} row`).toBeDefined();
		expect(row, `no full-width background on collapsed ${kind} row`).not.toMatch(/\x1b\[(?:4[0-9]|10[0-7]|48;|49)(?:;|m)/);
	}
}

function drive(ws: TestWorkspace, run: Run, options?: { timeout?: number }): Promise<Capture> {
	const out = join(ws.dir, "raw.bin");
	const plan = {
		argv: [
			PI,
			"--approve",
			"--no-extensions",
			"--no-skills",
			"--no-themes",
			"--no-context-files",
			"--no-prompt-templates",
			"--session-dir",
			ws.sessions,
			...run.extensions.flatMap((e) => ["-e", e]),
			...(run.model ? ["--model", run.model] : []),
		],
		cwd: run.cwd ?? ROOT,
		env: {
			PI_CODING_AGENT_DIR: ws.agent,
			PI_SKIP_VERSION_CHECK: "1",
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
			PI_HYPERLINKS: "0",
			...run.env,
		},
		cols: 120,
		rows: 40,
		timeout: options?.timeout ?? 25,
		out,
		steps: run.steps,
	};

	return new Promise((resolvePromise, reject) => {
		const child = spawn("python3", [DRIVER], { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				return reject(
					new Error(`row-gate driver exited ${code}: ${stderr.trim()}\n${plainTerminal(readFileSync(out)).slice(-40).join("\n")}`),
				);
			}
			const raw = readFileSync(out);
			const offsets = JSON.parse(stdout) as Record<string, number>;
			const snapshots = Object.fromEntries(
				Object.entries(offsets).map(([name, offset]) => [name, screen(raw.subarray(0, offset))]),
			);
			resolvePromise({ raw, lines: screen(raw), offsets, snapshots });
		});
		child.stdin.end(JSON.stringify(plan));
	});
}

describe.skipIf(!READY)("pi-17.2: interactive Pi /resume and /reload pty verification", () => {
	it("rejects a closing read fence after the body", () => {
		const mutant = Buffer.from("read /tmp/fenced-resume.txt\nFENCED_AFTER_RESUME\n```\nedit /tmp/edit-target.txt\nAdded 1 line, removed 1 line\n");
		expect(() => expectToolRows(mutant, "fenced-resume.txt", "FENCED_AFTER_RESUME")).toThrow();
	});

	it(
		"retains rich first footer row and session name after /resume",
		async () => {
			const ws = new TestWorkspace();
			try {
				seedSession(ws, "pi17-old");

				const capture = await drive(ws, {
					extensions: EXTENSIONS,
					steps: [
						{ wait: "ctrl\\+o more" },
						{ paste: "/name pi17-current" },
						{ key: "enter" },
						{ wait: "pi17-current" },
						{ paste: "/resume" },
						{ key: "enter" },
						{ wait: "pi17-old" },
						{ key: "enter" },
						{ wait: "Resumed session" },
						{ sleep: 1.0 },
						{ snapshot: "after-resume" },
					],
				});

				expectFooter(capture.snapshots["after-resume"]!, "pi17-old");
			} finally {
				ws.cleanup();
			}
		},
		30000,
	);

	it(
		"smoke check: double /reload causes no regression on rich row 0 or native row 1, with zero wrapper-stack growth",
		async () => {
			const ws = new TestWorkspace();
			const receiptPath = join(ws.dir, "probe-receipt.json");
			try {
				const capture = await drive(ws, {
					extensions: RELOAD_EXTENSIONS,
					env: {
						PI_RELOAD_PROBE_RECEIPT: receiptPath,
					},
					steps: [
						{ wait: "ctrl\\+o more" },
						{ paste: "/name pi17-smoke" },
						{ key: "enter" },
						{ wait: "pi17-smoke" },
						{ paste: "/reload" },
						{ key: "enter" },
						{ wait: "Reloaded", count: 1 },
						{ sleep: 1.0 },
						{ snapshot: "after-reload-1" },
						{ paste: "/reload" },
						{ key: "enter" },
						{ wait: "Reloaded", count: 2 },
						{ sleep: 1.0 },
						{ snapshot: "after-reload-2" },
					],
				});

				// Verify driver waited until second reload actually completed
				const reloads = (capture.raw.toString("utf8").match(/Reloaded/g) ?? []).length;
				expect(reloads).toBeGreaterThanOrEqual(2);

				// Verify reload probe captured 3 activations with zero render identity changes across reloads
				expect(existsSync(receiptPath)).toBe(true);
				const probeData = JSON.parse(readFileSync(receiptPath, "utf8"));
				expect(probeData.loads).toBe(3);
				expect(probeData.identityChanges).toBe(0);

				expectFooter(capture.snapshots["after-reload-1"]!, "pi17-smoke");
				expectFooter(capture.snapshots["after-reload-2"]!, "pi17-smoke");
			} finally {
				ws.cleanup();
			}
		},
		35000,
	);

	it(
		"sensitivity: a stable wrapper returning a native row after reload fails the footer assertion",
		async () => {
			const ws = new TestWorkspace();
			const receiptPath = join(ws.dir, "probe-receipt-native.json");
			try {
				const capture = await drive(ws, {
					extensions: RELOAD_EXTENSIONS,
					env: {
						PI_RELOAD_PROBE_RECEIPT: receiptPath,
						PI_RELOAD_PROBE_NATIVE_AFTER_LOAD: "2",
					},
					steps: [
						{ wait: "ctrl\\+o more" },
						{ paste: "/name pi17-native-mutant" },
						{ key: "enter" },
						{ wait: "pi17-native-mutant" },
						{ paste: "/reload" },
						{ key: "enter" },
						{ wait: "Reloaded", count: 1 },
						{ sleep: 1.0 },
						{ snapshot: "after-reload-1" },
						{ paste: "/reload" },
						{ key: "enter" },
						{ wait: "Reloaded", count: 2 },
						{ sleep: 1.0 },
						{ snapshot: "after-reload-2" },
					],
				});
				const probeData = JSON.parse(readFileSync(receiptPath, "utf8"));
				expect(probeData.loads).toBe(3);
				expect(probeData.identityChanges).toBe(0);
				expect(() => expectFooter(capture.snapshots["after-reload-1"]!, "pi17-native-mutant")).toThrow();
				expect(() => expectFooter(capture.snapshots["after-reload-2"]!, "pi17-native-mutant")).toThrow();
			} finally {
				ws.cleanup();
			}
		},
		35000,
	);

	it(
		"sensitivity: driver times out if second reload does not occur",
		async () => {
			const ws = new TestWorkspace();
			try {
				// Plan issues only ONE /reload, but specifies wait count: 2 with a short timeout.
				// Proves that a single reload cannot satisfy the two-reload check.
				await expect(
					drive(
						ws,
						{
							extensions: EXTENSIONS,
							steps: [
								{ wait: "ctrl\\+o more" },
								{ paste: "/reload" },
								{ key: "enter" },
								{ wait: "Reloaded", count: 1 },
								{ wait: "Reloaded", count: 2 },
							],
						},
						{ timeout: 3 },
					),
				).rejects.toThrow(/timed out waiting for 'Reloaded' \(count=2\)/);
			} finally {
				ws.cleanup();
			}
		},
		15000,
	);

	it(
		"sensitivity: reload probe captures exactly 2 loads after a single reload (mutant check)",
		async () => {
			const ws = new TestWorkspace();
			const receiptPath = join(ws.dir, "probe-receipt-single.json");
			try {
				await drive(ws, {
					extensions: RELOAD_EXTENSIONS,
					env: {
						PI_RELOAD_PROBE_RECEIPT: receiptPath,
					},
					steps: [
						{ wait: "ctrl\\+o more" },
						{ paste: "/reload" },
						{ key: "enter" },
						{ wait: "Reloaded", count: 1 },
						{ sleep: 1.0 },
					],
				});

				expect(existsSync(receiptPath)).toBe(true);
				const probeData = JSON.parse(readFileSync(receiptPath, "utf8"));
				// Initial boot (load 1) + 1 reload (load 2) = exactly 2 loads, not 3
				expect(probeData.loads).toBe(2);
				expect(probeData.identityChanges).toBe(0);
			} finally {
				ws.cleanup();
			}
		},
		20000,
	);

	it(
		"tool rows stay transparent and readable after real /resume and two /reload module replacements",
		async () => {
			const ws = new TestWorkspace();
			const resumedEdit = join(ws.dir, "edit-resume.txt");
			const reloadedEdit = join(ws.dir, "edit-reload.txt");
			const resumedRead = join(ws.dir, "fenced-resume.txt");
			const reloadedRead = join(ws.dir, "fenced-reload.txt");
			seedSession(ws, "pi17-tools-old", ws.dir);
			writeFileSync(resumedEdit, "BEFORE\n");
			writeFileSync(reloadedEdit, "AFTER\n");
			writeFileSync(resumedRead, "```text\nFENCED_AFTER_RESUME\n```\n");
			writeFileSync(reloadedRead, "```text\nFENCED_AFTER_RELOAD\n```\n");

			try {
				const capture = await drive(ws, {
					extensions: TOOL_EXTENSIONS,
					model: "rbf-gate/gate",
					cwd: ws.dir,
					env: {
						RBF_ROW_GATE_SCRIPT: JSON.stringify([
							{ text: "unused before resume" },
							{ tool: "read", args: { path: resumedRead } },
							{ tool: "edit", args: { path: resumedEdit, oldText: "BEFORE", newText: "AFTER" } },
							{ text: "TOOLS_AFTER_RESUME" },
							{ tool: "read", args: { path: reloadedRead } },
							{ tool: "edit", args: { path: reloadedEdit, oldText: "AFTER", newText: "FINAL" } },
							{ text: "TOOLS_AFTER_RELOAD" },
						]),
					},
					steps: [
						{ wait: "rbf-gate" },
						{ paste: "/name pi17-tools" },
						{ key: "enter" },
						{ wait: "pi17-tools" },
						{ paste: "/resume" },
						{ key: "enter" },
						{ wait: "No sessions in current folder" },
						{ key: "tab" },
						{ wait: "pi17-tools-old" },
						{ key: "enter" },
						{ wait: "Resumed session" },
						{ sleep: 0.5 },
						{ snapshot: "after-resume" },
						{ paste: "show tools after resume" },
						{ key: "enter" },
						{ wait: "TOOLS_AFTER_RESUME" },
						{ snapshot: "collapsed-after-resume" },
						{ key: "ctrl-o" },
						{ wait: "FENCED_AFTER_RESUME" },
						{ sleep: 0.5 },
						{ snapshot: "after-resume-tools" },
						{ key: "ctrl-o" },
						{ paste: "/reload" },
						{ key: "enter" },
						{ wait: "Reloaded", count: 1 },
						{ sleep: 0.5 },
						{ paste: "/reload" },
						{ key: "enter" },
						{ wait: "Reloaded", count: 2 },
						{ sleep: 0.5 },
						{ snapshot: "after-reload-2" },
						{ paste: "show tools after reload" },
						{ key: "enter" },
						{ wait: "TOOLS_AFTER_RELOAD" },
						{ snapshot: "collapsed-after-reload" },
						{ key: "ctrl-o" },
						{ sleep: 0.5 },
						{ snapshot: "after-reload-tools" },
					],
				}, { timeout: 45 });

				const afterResume = capture.raw.subarray(capture.offsets["after-resume"]!, capture.offsets["after-resume-tools"]!);
				const afterReload = capture.raw.subarray(capture.offsets["after-reload-2"]!, capture.offsets["after-reload-tools"]!);
				expectToolRows(afterResume, "fenced-resume.txt", "FENCED_AFTER_RESUME");
				expectToolRows(afterReload, "fenced-reload.txt", "FENCED_AFTER_RELOAD");
				expectTransparentCollapsedRows(capture.raw, capture.offsets["collapsed-after-resume"]!, "fenced-resume.txt", "edit-resume.txt");
				expectTransparentCollapsedRows(capture.raw, capture.offsets["collapsed-after-reload"]!, "fenced-reload.txt", "edit-reload.txt");
			} finally {
				ws.cleanup();
			}
		},
		60000,
	);

	it(
		"guardian countdown after /reload appears only on eligible cached turn under scripted gate provider",
		async () => {
			const ws = new TestWorkspace();
			const receiptPath = join(ws.dir, "probe-receipt-guardian.json");
			seedSession(ws, "pi17-guardian-old", ws.dir);
			mkdirSync(join(ws.dir, ".pi"), { recursive: true });
			writeFileSync(join(ws.dir, ".pi", "settings.json"), JSON.stringify({ cacheTtl: { "rbf-gate": "5m" } }));

			const guardianExtensions = [
				...RELOAD_EXTENSIONS,
				join(SUPPORT, "rbf-row-gate-provider.ts"),
			];

			try {
				const capture = await drive(ws, {
					extensions: guardianExtensions,
					model: "rbf-gate/gate",
					cwd: ws.dir,
					env: {
						PI_RELOAD_PROBE_RECEIPT: receiptPath,
						PI_AGENT_DIR: ws.agent,
						RBF_ROW_GATE_SCRIPT: JSON.stringify([
							{ text: "first response", cacheRead: 1024 },
							{ text: "second response", cacheRead: 1024 },
						]),
					},
					steps: [
						{ wait: "rbf-gate" },
						{ paste: "/name pi17-guardian" },
						{ key: "enter" },
						{ wait: "pi17-guardian" },
						{ paste: "hello cache 1" },
						{ key: "enter" },
						{ wait: "first response" },
						{ wait: "5m TTL" },
						{ sleep: 0.5 },
						{ snapshot: "before-resume" },
						{ paste: "/resume" },
						{ key: "enter" },
						{ wait: "No sessions in current folder" },
						{ key: "tab" },
						{ wait: "pi17-guardian-old" },
						{ paste: "pi17-guardian-old" },
						{ sleep: 0.3 },
						{ key: "enter" },
						{ wait: "Resumed session" },
						{ sleep: 0.5 },
						{ snapshot: "after-resume" },
						{ paste: "/reload" },
						{ key: "enter" },
						{ wait: "Reloaded", count: 1 },
						{ sleep: 1.0 },
						{ snapshot: "after-reload-1" },
						{ paste: "/reload" },
						{ key: "enter" },
						{ wait: "Reloaded", count: 2 },
						{ sleep: 1.0 },
						{ snapshot: "after-reload-2" },
						{ paste: "hello cache 2" },
						{ key: "enter" },
						{ wait: "second response" },
						{ sleep: 0.5 },
						{ snapshot: "after-new-cache" },
					],
				}, { timeout: 45 });

				expect(existsSync(receiptPath)).toBe(true);
				const probeData = JSON.parse(readFileSync(receiptPath, "utf8"));
				expect(probeData.loads).toBe(4); // initial boot + /resume + two /reload activations
				expect(probeData.identityChanges).toBe(0);

				const rawStr = capture.raw.toString("utf8");
				const reloads = (rawStr.match(/Reloaded/g) ?? []).length;
				expect(reloads).toBeGreaterThanOrEqual(2);

				expectFooter(capture.snapshots["before-resume"]!, "pi17-guardian", true);
				expectFooter(capture.snapshots["after-resume"]!, "pi17-guardian-old");
				expectFooter(capture.snapshots["after-reload-1"]!, "pi17-guardian-old");
				expectFooter(capture.snapshots["after-reload-2"]!, "pi17-guardian-old");
				expectFooter(capture.snapshots["after-new-cache"]!, "pi17-guardian-old", true);
			} finally {
				ws.cleanup();
			}
		},
		60000,
	);
});
