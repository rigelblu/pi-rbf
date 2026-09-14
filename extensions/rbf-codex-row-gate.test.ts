// The row gate for #pi-10: every Codex row kind, rendered by a real interactive Pi under a
// pseudo-terminal, against Pi's own bash and edit rows in the same process, theme, and width.
//
// Why this exists: pi-10.3's human run found seven rendering defects that 586 green tests and
// three cold reviews had passed, because the fake app-server returns whatever the extension
// expects and no test ever looked at the bytes Pi draws. This test does. It drives Pi twice per
// configuration: once with a scripted provider that makes Pi run its own `bash` and `edit`
// (the reference), once with `rbf-codex` pointed at the fake app-server (the candidate), then
// asserts the terminal bytes of matching lines are identical, or carry identical styling where the
// text differs by design (an added file has no Pi twin; a question row has none either).
//
// Runs in two configurations: bare Pi, and Pi with the daily extensions that touch rows
// (`rbf-tool-execution-blended`, `rbf-edit-glance`), because three of the seven defects showed only
// with the glance loaded. Skips when the local `pi` bundle or python3 is missing.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeScenario } from "./test-support/rbf-codex-fake-app-server.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PI = join(ROOT, "node_modules", ".bin", "pi");
const SUPPORT = resolve(import.meta.dirname, "test-support");
const DRIVER = join(SUPPORT, "rbf-row-gate-drive.py");
const PROVIDER = join(SUPPORT, "rbf-row-gate-provider.ts");
const CODEX = join(SUPPORT, "rbf-row-gate-codex.ts");
const DAILY = [join(ROOT, "extensions", "rbf-tool-execution-blended.ts"), join(ROOT, "extensions", "rbf-edit-glance.ts")];
const PYTHON = spawnSync("python3", ["--version"]).status === 0;
const READY = existsSync(PI) && PYTHON;
const KEEP = !!process.env.RBF_ROW_GATE_KEEP;

type Step = { wait: string } | { paste: string } | { key: string } | { sleep: number };
type Run = { extensions: string[]; model: string; env: Record<string, string>; steps: Step[] };
type Capture = { raw: Buffer; lines: Buffer[] };

const READY_STEPS: Step[] = [{ wait: "ctrl\\+o more" }, { paste: "go" }, { key: "enter" }];

/** Pi's TUI redraws a line as `ESC[2K` (erase line) then the content, ending in CR; the last redraw of a line is its final state. */
function renderedLines(raw: Buffer): Buffer[] {
	const lines: Buffer[] = [];
	const ERASE = Buffer.from("\x1b[2K");
	let at = raw.indexOf(ERASE);
	while (at !== -1) {
		const start = at + ERASE.length;
		const next = raw.indexOf(ERASE, start);
		let end = next === -1 ? raw.length : next;
		for (const stop of ["\r", "\n"]) {
			const i = raw.indexOf(stop, start);
			if (i !== -1 && i < end) end = i;
		}
		lines.push(raw.subarray(start, end));
		at = next;
	}
	return lines;
}

/** The final redraw of the line carrying `marker`; `not` skips lines that also carry another text (a row's title repeats its command). */
function line(cap: Capture, marker: string, not?: string): Buffer {
	const hits = cap.lines.filter((l) => l.includes(marker) && !(not && l.includes(not)));
	if (hits.length === 0) throw new Error(`no rendered line carries ${JSON.stringify(marker)}`);
	return hits[hits.length - 1]!;
}
/** A command row's output line: the command's echo, not the `$ …` title that also names it. */
const output = (cap: Capture, text: string) => line(cap, text, "$ ");

const show = (b: Buffer) => JSON.stringify(b.toString("latin1"));
/** Bytes with only the timing digits neutralised, so `Took 0.0s` and `Took 0.1s` compare equal. */
const exact = (b: Buffer) => show(b).replace(/(Took|Elapsed) \d+\.\ds/, "$1 N.Ns");
/** The escapes around a line's text, with the text and its padding removed: what a line looks like, not what it says. */
const styling = (b: Buffer, text: string) => show(Buffer.from(b.toString("latin1").replace(text, "").replace(/ {2,}/g, " "), "latin1"));

class Workspace {
	readonly dir = mkdtempSync(join(tmpdir(), "rbf-row-gate-"));
	readonly work = join(this.dir, "work");
	constructor() {
		mkdirSync(this.work);
		mkdirSync(join(this.dir, "agent"));
		mkdirSync(join(this.dir, "sessions"));
		writeFileSync(join(this.work, "gate.txt"), "GATE_OLD\n");
		writeFileSync(join(this.work, "gate2.txt"), "GATE_OLD\n");
	}
	path(name: string) {
		return join(this.work, name);
	}
}

/** Boot one isolated Pi (own agent dir, sessions, no user extensions, skills, themes, or context files) and drive it. */
function drive(ws: Workspace, run: Run): Promise<Capture> {
	const out = join(ws.dir, "raw.bin");
	const plan = {
		argv: [PI, "--no-extensions", "--no-skills", "--no-themes", "--no-context-files", "--no-prompt-templates", "--session-dir", join(ws.dir, "sessions"), ...run.extensions.flatMap((e) => ["-e", e]), "--model", run.model],
		cwd: ws.work,
		env: { PI_CODING_AGENT_DIR: join(ws.dir, "agent"), PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_HYPERLINKS: "0", ...run.env },
		cols: 100,
		rows: 40,
		timeout: 40,
		out,
		steps: run.steps,
	};
	return new Promise((resolvePromise, reject) => {
		const child = spawn("python3", [DRIVER], { stdio: ["pipe", "pipe", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) return reject(new Error(`row-gate driver exited ${code}: ${stderr.trim()} (raw bytes in ${out})`));
			const raw = readFileSync(out);
			resolvePromise({ raw, lines: renderedLines(raw) });
		});
		child.stdin.end(JSON.stringify(plan));
	});
}

// ── the two sides of each pair ────────────────────────────────────────────────

/** Pi's own rows: a command, a replacing edit, an appending edit, a failing command, then text. */
function piRun(ws: Workspace, extensions: string[]): Run {
	const script = [
		{ tool: "bash", args: { command: "echo GATE_CMD" } },
		{ tool: "edit", args: { path: ws.path("gate.txt"), oldText: "GATE_OLD", newText: "GATE_NEW" } },
		{ tool: "edit", args: { path: ws.path("gate2.txt"), oldText: "GATE_OLD\n", newText: "GATE_OLD\nGATE_APP\n" } },
		{ tool: "bash", args: { command: "echo GATE_ERR; exit 3" } },
		{ text: "GATE_DONE" },
	];
	return { extensions: [...extensions, PROVIDER], model: "rbf-gate/gate", env: { RBF_ROW_GATE_SCRIPT: JSON.stringify(script) }, steps: [...READY_STEPS, { wait: "GATE_DONE" }] };
}

function codexRun(ws: Workspace, extensions: string[], scenario: FakeScenario, steps: Step[]): Run {
	return { extensions: [...extensions, CODEX], model: "codex-harness/codex", env: { RBF_FAKE_SCENARIO: JSON.stringify(scenario) }, steps: [...READY_STEPS, ...steps] };
}

/** The Codex twins of the Pi rows, plus an added file, which Pi's edit row cannot produce. */
function codexRows(ws: Workspace): FakeScenario {
	return {
		turn: [
			{ kind: "command", id: "c1", command: "echo GATE_CMD", cwd: ws.work, output: ["GATE_CMD\n"], exitCode: 0 },
			{ kind: "patch", id: "p1", changes: [{ path: ws.path("gate.txt"), kind: { type: "update" }, diff: "@@ -1 +1 @@\n-GATE_OLD\n+GATE_NEW\n" }] },
			{ kind: "patch", id: "p2", changes: [{ path: ws.path("gate2.txt"), kind: { type: "update" }, diff: "@@ -1 +1,2 @@\n GATE_OLD\n+GATE_APP\n" }] },
			{ kind: "patch", id: "p3", changes: [{ path: ws.path("gate-add.txt"), kind: { type: "add" }, diff: "GATE_ADD\n" }] },
			{ kind: "command", id: "c2", command: "echo GATE_ERR; exit 3", cwd: ws.work, output: ["GATE_ERR\n"], exitCode: 3 },
			{ kind: "answer", id: "a1", text: "GATE_DONE" },
			{ kind: "complete" },
		],
	};
}
const DECLINED: FakeScenario = { turn: [{ kind: "command", id: "c1", command: "echo GATE_ASK", output: ["GATE_ASK\n"], approvals: [{ when: "before", command: "echo GATE_ASK", reason: "needs a nod" }] }, { kind: "answer", id: "a1", text: "GATE_DONE" }, { kind: "complete" }] };
const STOPPED: FakeScenario = { turn: [{ kind: "command", id: "c1", command: "echo GATE_HANG", incomplete: true }, { kind: "complete", status: "failed", errorMessage: "boom" }] };
const QUESTION: FakeScenario = {
	turn: [
		{ kind: "question", id: "q1", questions: [{ id: "color", header: "Choice", question: "Which color do you choose?", options: [{ label: "RED", description: "Choose RED." }, { label: "BLUE", description: "Choose BLUE." }], isOther: false }] },
		{ kind: "answer", id: "a1", text: "GATE_DONE" },
		{ kind: "complete" },
	],
};

const CONFIGS = [
	{ name: "bare Pi", extensions: [] as string[] },
	{ name: "Pi with the daily row extensions", extensions: DAILY },
];

describe.skipIf(!READY)("rbf-codex row gate: Codex rows against Pi's own, byte for byte, in a real Pi under a pty", () => {
	const workspaces: Workspace[] = [];
	const caps = new Map<string, Capture>();
	const cap = (config: string, run: string) => caps.get(`${config}/${run}`)!;

	beforeAll(async () => {
		const jobs: Promise<void>[] = [];
		for (const config of CONFIGS) {
			const runs: Record<string, (ws: Workspace) => Run> = {
				pi: (ws) => piRun(ws, config.extensions),
				codex: (ws) => codexRun(ws, config.extensions, codexRows(ws), [{ wait: "GATE_DONE" }]),
				declined: (ws) => codexRun(ws, config.extensions, DECLINED, [{ wait: "Yes for this session" }, { key: "down" }, { key: "down" }, { key: "enter" }, { wait: "Operation aborted" }]),
				stopped: (ws) => codexRun(ws, config.extensions, STOPPED, [{ wait: "Codex could not complete" }]),
				question: (ws) => codexRun(ws, config.extensions, QUESTION, [{ wait: "Choose BLUE" }, { key: "down" }, { key: "enter" }, { wait: "GATE_DONE" }]),
			};
			for (const [name, make] of Object.entries(runs)) {
				const ws = new Workspace();
				workspaces.push(ws);
				jobs.push(drive(ws, make(ws)).then((c) => void caps.set(`${config.name}/${name}`, c)));
			}
		}
		await Promise.all(jobs);
	}, 120_000);

	afterAll(() => {
		if (KEEP) return console.log(`row-gate captures kept:\n${workspaces.map((w) => w.dir).join("\n")}`);
		for (const ws of workspaces) rmSync(ws.dir, { recursive: true, force: true });
	});

	describe.each(CONFIGS)("$name", ({ name }) => {
		const pi = () => cap(name, "pi");
		const codex = () => cap(name, "codex");

		it("a command row's title is Pi's bash title", () => {
			expect(exact(line(codex(), "$ echo GATE_CMD"))).toBe(exact(line(pi(), "$ echo GATE_CMD")));
		});
		it("a command row's output line is Pi's bash output line", () => {
			expect(exact(output(codex(), "GATE_CMD"))).toBe(exact(output(pi(), "GATE_CMD")));
		});
		it("a command row's Took line is Pi's", () => {
			expect(exact(line(codex(), "Took "))).toBe(exact(line(pi(), "Took ")));
		});
		it("a replacing edit's removed and added lines are Pi's edit lines, intra-line highlight included", () => {
			expect(exact(line(codex(), "GATE_OLD"))).toBe(exact(line(pi(), "GATE_OLD")));
			expect(exact(line(codex(), "GATE_NEW"))).toBe(exact(line(pi(), "GATE_NEW")));
		});
		it("an appending edit's added line is Pi's", () => {
			expect(exact(line(codex(), "GATE_APP"))).toBe(exact(line(pi(), "GATE_APP")));
		});
		it("an added file's line is styled as Pi's added line (Pi has no add row; the text differs by design)", () => {
			expect(styling(line(codex(), "GATE_ADD"), "+1 GATE_ADD")).toBe(styling(line(pi(), "GATE_APP"), "+2 GATE_APP"));
		});
		it("a failed command's title is Pi's failed bash title", () => {
			expect(exact(line(codex(), "$ echo GATE_ERR"))).toBe(exact(line(pi(), "$ echo GATE_ERR")));
		});
		it("a failed command's output line is Pi's failed bash output line", () => {
			expect(exact(output(codex(), "GATE_ERR"))).toBe(exact(output(pi(), "GATE_ERR")));
		});
		it("a failed command's exit-code line is Pi's", () => {
			expect(exact(line(codex(), "Command exited with code 3"))).toBe(exact(line(pi(), "Command exited with code 3")));
		});
		it("a declined row reads as Pi's failed bash row", () => {
			const d = cap(name, "declined");
			expect(styling(line(d, "$ echo GATE_ASK"), "$ echo GATE_ASK")).toBe(styling(line(pi(), "$ echo GATE_ERR"), "$ echo GATE_ERR; exit 3"));
			expect(styling(line(d, "Declined"), "Declined")).toBe(styling(output(pi(), "GATE_ERR"), "GATE_ERR"));
		});
		it("a row Codex stopped mid-way reads as Pi's failed bash row", () => {
			const s = cap(name, "stopped");
			expect(styling(line(s, "Codex stopped"), "Codex stopped")).toBe(styling(output(pi(), "GATE_ERR"), "GATE_ERR"));
		});
		it("a question row carries the bash title and output styling (Pi has no question row)", () => {
			const q = cap(name, "question");
			expect(styling(line(q, "? Choice"), "? Choice")).toBe(styling(line(pi(), "$ echo GATE_CMD"), "$ echo GATE_CMD"));
			expect(styling(line(q, "Choice: BLUE"), "Choice: BLUE")).toBe(styling(output(pi(), "GATE_CMD"), "GATE_CMD"));
		});
	});

	it("under the glance, the edit summary lines are Pi's", () => {
		// The glance styles the counts inside the line, so match on the label and compare every distinct summary drawn:
		// Pi draws two (the replace, the append) and Codex three (the same two plus the add, whose summary equals the append's).
		const summaries = (c: Capture) => [...new Set(c.lines.filter((l) => l.includes("Added ")).map(exact))].sort();
		const name = CONFIGS[1]!.name;
		expect(summaries(cap(name, "codex"))).toEqual(summaries(cap(name, "pi")));
		expect(summaries(cap(name, "pi"))).toHaveLength(2);
	});
});
