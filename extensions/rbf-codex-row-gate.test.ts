// The row gate for #pi-10: every Codex row kind, rendered by a real interactive Pi under a
// pseudo-terminal, against Pi's own bash and edit rows in the same process, theme, and width.
//
// Why this exists: pi-10.3's human run found seven rendering defects that 586 green tests and
// three cold reviews had passed, because the fake app-server returns whatever the extension
// expects and no test ever looked at the bytes Pi draws. This test does. Per configuration it
// launches Pi seven times: once with a scripted provider that makes Pi run its own `bash` and
// `edit` (the reference), five times with `rbf-codex` pointed at the fake app-server (the
// candidate: the row set, a declined command, a row Codex stopped, an answered question, a
// skipped question, a secret question), and once with both, the scripted provider calling
// `codex_command` by hand. It replays each raw stream into a final screen, then asserts the
// screen rows of matching lines are identical, or identical column for column with the text
// blanked where the text differs by design (an added file has no Pi twin; a question row has
// none either), and that the blank rows between a row's lines match.
//
// v0.21.4 adds, per configuration: a run of tool call rows (`codex_tool`: a text result, a code
// argument, a failed call) with a sub-agent's tagged command rows, a Codex command row cut by
// Escape, and Pi's own bash row cut by Escape as its reference; the tag is stripped and the
// width ignored before a tagged title is compared.
//
// Runs in two configurations: bare Pi, and Pi with the daily extensions that touch rows
// (`rbf-tool-execution-blended`, `rbf-edit-glance`), because three of the seven defects showed only
// with the glance loaded. Limits: one theme (Pi's default dark, where `toolOutput` and `muted`
// share a gray) and one width (100 columns); it proves rendered bytes, not token names.
// Needs the local `pi` bundle and python3; their absence fails the first test unless
// RBF_ROW_GATE_OPTIONAL=1 says a skip is deliberate.
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
const DAILY = [
	join(ROOT, "extensions", "rbf-tool-execution-blended.ts"),
	join(ROOT, "extensions", "rbf-edit-glance.ts"),
	join(ROOT, "extensions", "rbf-tool-parts-indent.ts"),
];
const PYTHON = spawnSync("python3", ["--version"]).status === 0;
const READY = existsSync(PI) && PYTHON;
const KEEP = !!process.env.RBF_ROW_GATE_KEEP;

type Step = { wait: string } | { paste: string } | { key: string } | { sleep: number };
type Run = { extensions: string[]; model: string; env: Record<string, string>; steps: Step[] };
type Capture = { raw: Buffer; lines: Buffer[] };

const READY_STEPS: Step[] = [{ wait: "ctrl\\+o more" }, { paste: "go" }, { key: "enter" }];

/**
 * The final screen, one entry per terminal row with its escapes kept: a line-level terminal emulator for what Pi's
 * TUI emits. Pi redraws a row as `ESC[2K` (erase line) then its full content, moves with relative cursor sequences,
 * and rewrites only the rows that changed, so the last redraw of a row in the stream is its final state but the
 * stream's order is not the screen's; replaying the stream is. Rows scrolled off the top are kept.
 */
function screen(raw: Buffer): Buffer[] {
	const rows: string[] = [""];
	let row = 0;
	let restart = false; // after CR, LF, or a move to column 1 the next thing written replaces the row
	const begin = () => {
		if (restart) {
			rows[row] = "";
			restart = false;
		}
	};
	const tokens = raw.toString("latin1").match(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^[\]]|[^\x1b]+/g) ?? [];
	for (const t of tokens) {
		if (t.startsWith("\x1b[")) {
			const m = /^\x1b\[([0-9;?<>=]*)[ -/]*([@-~])$/.exec(t)!;
			const n = parseInt(m[1]!, 10);
			switch (m[2]) {
				case "A": // cursor up
					row = Math.max(0, row - (n || 1));
					restart = false;
					break;
				case "B": // cursor down
					row += n || 1;
					while (rows.length <= row) rows.push("");
					restart = false;
					break;
				case "G": // column
					if (!n || n === 1) restart = true;
					break;
				case "K": // erase line
					if (n === 2) {
						rows[row] = "";
						restart = false;
					}
					break;
				case "J": // erase below
					if (!n) rows.length = row + 1;
					break;
				case "m": // SGR: part of the row
					begin();
					rows[row] += t;
					break;
				default: // cursor show/hide, synchronized output, keyboard protocol: no effect on rows
					break;
			}
		} else if (t.startsWith("\x1b]")) {
			begin();
			rows[row] += t; // OSC (hyperlink boundaries): part of the row
		} else if (t.startsWith("\x1b")) {
			// ESC + one char (charset, keypad): no effect on rows
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
	return rows.map((r) => Buffer.from(r, "latin1"));
}

/** The screen row carrying `marker`; `not` skips rows that also carry another text (a row's title repeats its command). Markers are unique per row; where they are not, `distinct` compares the set. */
function line(cap: Capture, marker: string, not?: string): Buffer {
	const hits = cap.lines.filter((l) => l.includes(marker) && !(not && l.includes(not)));
	if (hits.length === 0) throw new Error(`no screen row carries ${JSON.stringify(marker)}`);
	return hits[hits.length - 1]!;
}
/** A command row's output line: the command's echo, not the `$ …` title that also names it. */
const output = (cap: Capture, text: string) => line(cap, text, "$ ");
/** How many empty screen rows sit directly above the row carrying `marker`: the row's vertical shape, which single-line equality cannot see. */
function blanksAbove(cap: Capture, marker: string, not?: string): number {
	let i = cap.lines.length - 1;
	while (i >= 0 && !(cap.lines[i]!.includes(marker) && !(not && cap.lines[i]!.includes(not)))) i--;
	if (i < 0) throw new Error(`no screen row carries ${JSON.stringify(marker)}`);
	let blanks = 0;
	while (i > 0 && cap.lines[--i]!.toString("latin1").replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, "").trim() === "") blanks++;
	return blanks;
}

const show = (b: Buffer) => JSON.stringify(b.toString("latin1"));
const ESCAPES = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** The visible text of a screen row. */
const text = (b: Buffer) => b.toString("latin1").replace(ESCAPES, "").trimEnd();
/** The `... (N earlier lines,` a collapsed row's hint carries, with its own count, so two hints of different counts compare by styling. */
function hint(cap: Capture): { line: Buffer; text: string } {
	const l = line(cap, "earlier lines");
	const m = /\.\.\. \(\d+ earlier lines,/.exec(text(l));
	if (!m) throw new Error(`no hint in ${show(l)}`);
	return { line: l, text: m[0] };
}
/** Bytes with only the timing digits neutralised, so `Took 0.0s` and `Took 0.1s` compare equal. */
const exact = (b: Buffer) => show(b).replace(/(Took|Elapsed) \d+\.\ds/, "$1 N.Ns");
/** Every distinct final line carrying `marker`, for a marker that several rows share (`Took`, the glance summaries). */
const distinct = (c: Capture, marker: string) => [...new Set(c.lines.filter((l) => l.includes(marker)).map(exact))].sort();

function cutFirst4Cols(b: Buffer): Buffer {
	const s = b.toString("utf8");
	const tokens = s.match(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|[\s\S]/gu) ?? [];
	let col = 0;
	let cutIdx = 0;
	for (let i = 0; i < tokens.length; i++) {
		if (!tokens[i]!.startsWith("\x1b")) {
			col++;
			if (col === 4) {
				cutIdx = i + 1;
				break;
			}
		}
	}
	return Buffer.from(tokens.slice(cutIdx).join(""), "utf8");
}

function firstCharCol(b: Buffer): number {
	const t = b.toString("utf8").replace(ESCAPES, "");
	return t.search(/\S/);
}
/**
 * What a line looks like, column for column, not what it says. Every escape sequence is listed with where it sits:
 * a column from the left before the text (`L`), an offset inside it (`T`), right after it before any padding (`E`),
 * or a column from the right edge once the padding has begun (`R`); plus the text's start column and the line's
 * visible width. Two lines padded to the pty width with different words compare equal; an extra column anywhere
 * (the one-column gap of pi-10.3's review row 55) or a moved escape does not.
 */
function styling(b: Buffer, text: string): string {
	const s = b.toString("latin1");
	const at = s.indexOf(text);
	if (at === -1) throw new Error(`line does not carry ${JSON.stringify(text)}`);
	const tokens = s.match(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|[^\x1b]/g) ?? [];
	const escapes: { esc: string; col: number; zone: "L" | "T" | "E" | "R" }[] = [];
	let byte = 0;
	let col = 0;
	let start = -1;
	let zone: "L" | "T" | "E" | "R" = "L";
	for (const t of tokens) {
		if (t.startsWith("\x1b")) escapes.push({ esc: t, col, zone });
		else {
			if (byte === at) {
				start = col;
				zone = "T";
			} else if (zone === "E") zone = "R";
			col++;
			if (byte + 1 === at + text.length) zone = "E";
		}
		byte += t.length;
	}
	const width = col;
	const anchor = (e: (typeof escapes)[number]) => (e.zone === "L" ? `L${e.col}` : e.zone === "T" ? `T${e.col - start}` : e.zone === "E" ? "E" : `R${width - e.col}`);
	return JSON.stringify({ left: start, width, escapes: escapes.map((e) => `${anchor(e)} ${JSON.stringify(e.esc)}`) }, null, 1);
}

/**
 * A sub-agent's title line without its tag: the muted escape, the name, the space, and the escape closing it (Decision 2026-09-14: one
 * `muted` escape, the text, one space, then the unchanged title). What is left compares against Pi's untagged title with the width ignored,
 * because the visible line is that many columns shorter and its padding shorter with it.
 */
function untagged(b: Buffer, name: string): Buffer {
	const s = b.toString("latin1");
	const m = new RegExp(`^((?:\\x1b\\[[0-9;]*m)* ?(?:\\x1b\\[[0-9;]*m)*)\\x1b\\[[0-9;]*m${name} (?:\\x1b\\[[0-9;]*m)?`).exec(s); // the row shell's one padding column may precede the tag
	if (!m) throw new Error(`line does not start with the tag ${JSON.stringify(name)}: ${show(b)}`);
	return Buffer.from(m[1]! + s.slice(m[0].length), "latin1");
}
const stylingNoWidth = (b: Buffer, t: string) => styling(b, t).replace(/\n "width": \d+,/, "");

class Workspace {
	readonly dir = mkdtempSync(join(tmpdir(), "rbf-row-gate-"));
	readonly work = join(this.dir, "work");
	failed = false;
	constructor() {
		mkdirSync(this.work);
		mkdirSync(join(this.dir, "agent"));
		mkdirSync(join(this.dir, "sessions"));
		writeFileSync(join(this.work, "gate.txt"), "GATE_OLD\n");
		writeFileSync(join(this.work, "gate2.txt"), "GATE_CTX\n");
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
			if (code !== 0) {
				ws.failed = true; // keep the raw bytes for the post-mortem
				return reject(new Error(`row-gate driver exited ${code}: ${stderr.trim()} (raw bytes kept in ${out})`));
			}
			const raw = readFileSync(out);
			resolvePromise({ raw, lines: screen(raw) });
		});
		child.stdin.end(JSON.stringify(plan));
	});
}

// ── the two sides of each pair ────────────────────────────────────────────────

/** Eight output lines, the fourth wider than the 100-column pty, so the collapsed preview and its "earlier lines" hint render. */
const LONG_LINES = ["GATE_P1", "GATE_P2", "GATE_P3", `GATE_P4_${"w".repeat(110)}`, "GATE_P5", "GATE_P6", "GATE_P7", "GATE_P8"];
/** Commands whose titles fill the row's 98 content columns exactly (the shell pads one column each side of the 100-column pty): `$ echo <91>` for Pi, `alpha $ echo <85>` for the tagged child row. Pi wraps a title at words, so a longer one moves whole to a second row. */
const FULL_PI = `echo GATE_FULL_${"p".repeat(76)}`;
const FULL_CHILD = `echo GATE_FULL_${"c".repeat(70)}`;
/** Six result lines: one more than the collapsed preview shows, so the hint renders with a count of one. */
const TOOL_LINES = ["GATE_T1", "GATE_T2", "GATE_T3", "GATE_T4", "GATE_T5", "GATE_T6"];

/** Pi's own rows: a command, a replacing edit, an appending edit, a failing command, a long-output command, then text. */
function piRun(ws: Workspace, extensions: string[]): Run {
	const script = [
		{ tool: "bash", args: { command: "echo GATE_CMD" } },
		{ tool: "edit", args: { path: ws.path("gate.txt"), oldText: "GATE_OLD", newText: "GATE_NEW" } },
		{ tool: "edit", args: { path: ws.path("gate2.txt"), oldText: "GATE_CTX\n", newText: "GATE_CTX\nGATE_APP\n" } },
		{ tool: "bash", args: { command: "echo GATE_ERR; exit 3" } },
		{ tool: "bash", args: { command: `printf '%s\\n' ${LONG_LINES.join(" ")}` } },
		{ tool: "bash", args: { command: FULL_PI } },
		{ text: "GATE_DONE" },
	];
	return { extensions: [...extensions, PROVIDER], model: "rbf-gate/gate", env: { RBF_ROW_GATE_SCRIPT: JSON.stringify(script) }, steps: [...READY_STEPS, { wait: "GATE_DONE" }] };
}

/** Pi's own bash row cut by Escape while its command runs: the reference for a Codex row cut the same way (the text differs by design; Pi's bash killed its process, Codex keeps it). */
function piCutRun(_ws: Workspace, extensions: string[]): Run {
	const script = [{ tool: "bash", args: { command: "echo GATE_SLEEP; sleep 30" } }, { text: "GATE_DONE" }];
	return { extensions: [...extensions, PROVIDER], model: "rbf-gate/gate", env: { RBF_ROW_GATE_SCRIPT: JSON.stringify(script) }, steps: [...READY_STEPS, { wait: "Elapsed" }, { key: "escape" }, { wait: "abort" }, { sleep: 0.6 }] };
}

/** A model calling `codex_command` by hand (Pi's `registerTool` is global, so every model sees it): the row must refuse as an error. */
function directCallRun(ws: Workspace, extensions: string[]): Run {
	const script = [{ tool: "codex_command", args: { itemId: "by-hand", threadId: "", agentPath: "", command: "echo GATE_DIRECT", cwd: ws.work } }, { text: "GATE_DONE" }];
	return { extensions: [...extensions, CODEX, PROVIDER], model: "rbf-gate/gate", env: { RBF_ROW_GATE_SCRIPT: JSON.stringify(script) }, steps: [...READY_STEPS, { wait: "GATE_DONE" }] };
}

function codexRun(ws: Workspace, extensions: string[], scenario: FakeScenario, steps: Step[]): Run {
	return { extensions: [...extensions, CODEX], model: "codex-harness/codex", env: { RBF_FAKE_SCENARIO: JSON.stringify(scenario) }, steps: [...READY_STEPS, ...steps] };
}

/** The Codex twins of the Pi rows, plus an added file, which Pi's edit row cannot produce. The add carries file content as its diff, as real Codex sends it. */
function codexRows(ws: Workspace): FakeScenario {
	return {
		turn: [
			{ kind: "command", id: "c1", command: "echo GATE_CMD", cwd: ws.work, output: ["GATE_CMD\n"], exitCode: 0 },
			{ kind: "patch", id: "p1", changes: [{ path: ws.path("gate.txt"), kind: { type: "update" }, diff: "@@ -1 +1 @@\n-GATE_OLD\n+GATE_NEW\n" }] },
			{ kind: "patch", id: "p2", changes: [{ path: ws.path("gate2.txt"), kind: { type: "update" }, diff: "@@ -1 +1,2 @@\n GATE_CTX\n+GATE_APP\n" }] },
			{ kind: "patch", id: "p3", changes: [{ path: ws.path("gate-add.txt"), kind: { type: "add" }, diff: "GATE_ADD\n" }] },
			{ kind: "command", id: "c2", command: "echo GATE_ERR; exit 3", cwd: ws.work, output: ["GATE_ERR\n"], exitCode: 3 },
			{ kind: "command", id: "c3", command: `printf '%s\\n' ${LONG_LINES.join(" ")}`, cwd: ws.work, output: [`${LONG_LINES.join("\n")}\n`], exitCode: 0 },
			{ kind: "answer", id: "a1", text: "GATE_DONE" },
			{ kind: "complete" },
		],
	};
}
/** v0.21.4: three tool call rows (a text result, a code argument, a failed call), then a sub-agent's two command rows, one of them a full-width title. */
function toolRows(ws: Workspace): FakeScenario {
	return {
		turn: [
			{ kind: "toolCall", id: "t1", server: "bear_app", tool: "list_tags", arguments: {}, result: { content: [{ type: "text", text: `${TOOL_LINES.join("\n")}\n` }] } },
			{ kind: "toolCall", id: "t2", server: "node_repl", tool: "js", arguments: { code: "GATE_J1\nGATE_J2\nGATE_J3" } },
			{ kind: "toolCall", id: "t3", server: "bear_app", tool: "fail", arguments: {}, error: "GATE_TOOL_FAIL" },
			{ kind: "subAgent", activity: "started", agentThreadId: "T2", agentPath: "/root/alpha" },
			{ kind: "childTurn", threadId: "T2", turnId: "T2-turn", events: [{ kind: "command", id: "cc", command: "echo GATE_CMD", cwd: ws.work, output: ["GATE_CMD\n"], exitCode: 0 }, { kind: "command", id: "cf", command: FULL_CHILD, cwd: ws.work, output: ["GATE_FULL\n"], exitCode: 0 }, { kind: "complete" }] },
			{ kind: "answer", id: "a1", text: "GATE_DONE" },
			{ kind: "complete" },
		],
	};
}
/** A Codex command row cut by Escape while the fake holds its item open: the row reads the honest v0.21.4 text and takes the styling Pi gives its own cut row. */
const CUT: FakeScenario = { turn: [{ kind: "command", id: "c1", command: "echo GATE_SLEEP; sleep 30", output: ["GATE_SLEEP\n"], incomplete: true }, { kind: "hang" }] };
const DECLINED: FakeScenario = { turn: [{ kind: "command", id: "c1", command: "echo GATE_ASK", output: ["GATE_ASK\n"], approvals: [{ when: "before", command: "echo GATE_ASK", reason: "needs a nod" }] }, { kind: "answer", id: "a1", text: "GATE_DONE" }, { kind: "complete" }] };
const STOPPED: FakeScenario = { turn: [{ kind: "command", id: "c1", command: "echo GATE_HANG", incomplete: true }, { kind: "complete", status: "failed", errorMessage: "boom" }] };
const QUESTION: FakeScenario = {
	turn: [
		{ kind: "question", id: "q1", questions: [{ id: "color", header: "Choice", question: "Which color do you choose?", options: [{ label: "RED", description: "Choose RED." }, { label: "BLUE", description: "Choose BLUE." }], isOther: false }] },
		{ kind: "answer", id: "a1", text: "GATE_DONE" },
		{ kind: "complete" },
	],
};
/** A secret question is declined whole, without a dialog: the one question row that settles as an error (brief Flow #6). */
const QUESTION_SECRET: FakeScenario = {
	turn: [
		{ kind: "question", id: "q1", questions: [{ id: "token", header: "Secret", question: "Paste the token", isSecret: true }] },
		{ kind: "answer", id: "a1", text: "GATE_DONE" },
		{ kind: "complete" },
	],
};

const CONFIGS = [
	{ name: "bare Pi", extensions: [] as string[] },
	{ name: "Pi with the daily row extensions", extensions: DAILY },
];

it("the row gate's prerequisites are present (RBF_ROW_GATE_OPTIONAL=1 makes their absence a deliberate skip)", () => {
	if (process.env.RBF_ROW_GATE_OPTIONAL) return;
	expect({ pi: existsSync(PI), python3: PYTHON }).toEqual({ pi: true, python3: true });
});

describe.skipIf(!READY)("rbf-codex row gate: Codex rows against Pi's own, byte for byte, in a real Pi under a pty", () => {
	const workspaces: Workspace[] = [];
	const caps = new Map<string, Capture>();
	const cap = (config: string, run: string) => caps.get(`${config}/${run}`)!;

	beforeAll(async () => {
		const jobs: Promise<void>[] = [];
		for (const config of CONFIGS) {
			const runs: Record<string, (ws: Workspace) => Run> = {
				pi: (ws) => piRun(ws, config.extensions),
				"pi-cut": (ws) => piCutRun(ws, config.extensions),
				codex: (ws) => codexRun(ws, config.extensions, codexRows(ws), [{ wait: "GATE_DONE" }]),
				tools: (ws) => codexRun(ws, config.extensions, toolRows(ws), [{ wait: "GATE_DONE" }]),
				cut: (ws) => codexRun(ws, config.extensions, CUT, [{ wait: "Elapsed" }, { key: "escape" }, { wait: "still running in Codex" }, { sleep: 0.6 }]),
				declined: (ws) => codexRun(ws, config.extensions, DECLINED, [{ wait: "Yes for this session" }, { key: "down" }, { key: "down" }, { key: "enter" }, { wait: "Operation aborted" }]),
				stopped: (ws) => codexRun(ws, config.extensions, STOPPED, [{ wait: "Codex could not complete" }]),
				question: (ws) => codexRun(ws, config.extensions, QUESTION, [{ wait: "Choose BLUE" }, { key: "down" }, { key: "enter" }, { wait: "GATE_DONE" }]),
				"question-skipped": (ws) => codexRun(ws, config.extensions, QUESTION, [{ wait: "Choose BLUE" }, { key: "escape" }, { wait: "GATE_DONE" }]),
				"question-secret": (ws) => codexRun(ws, config.extensions, QUESTION_SECRET, [{ wait: "GATE_DONE" }]),
				direct: (ws) => directCallRun(ws, config.extensions),
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
		const kept = workspaces.filter((w) => KEEP || w.failed);
		for (const ws of workspaces) if (!kept.includes(ws)) rmSync(ws.dir, { recursive: true, force: true });
		if (kept.length) console.log(`row-gate captures kept:\n${kept.map((w) => w.dir).join("\n")}`);
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
		it("every command row's Took line is Pi's (the succeeded and the failed row)", () => {
			expect(distinct(codex(), "Took ")).toEqual(distinct(pi(), "Took "));
			expect(distinct(pi(), "Took ").length).toBeGreaterThan(0);
		});
		it("a replacing edit's removed and added lines are Pi's edit lines, intra-line highlight included", () => {
			expect(exact(line(codex(), "GATE_OLD"))).toBe(exact(line(pi(), "GATE_OLD")));
			expect(exact(line(codex(), "GATE_NEW"))).toBe(exact(line(pi(), "GATE_NEW")));
			expect(exact(line(pi(), "GATE_OLD"))).toContain("\\u001b[7m"); // the reference really carries the highlight
		});
		it("an appending edit's context and added lines are Pi's", () => {
			expect(exact(line(codex(), "GATE_CTX"))).toBe(exact(line(pi(), "GATE_CTX")));
			expect(exact(line(codex(), "GATE_APP"))).toBe(exact(line(pi(), "GATE_APP")));
		});
		it("an added file's line is styled as Pi's added line, column for column (Pi has no add row; the text differs by design)", () => {
			expect(styling(line(codex(), "GATE_ADD"), "+1 GATE_ADD")).toBe(styling(line(pi(), "GATE_APP"), "+2 GATE_APP"));
		});
		it("a failed command's title is Pi's failed bash title", () => {
			expect(exact(line(codex(), "$ echo GATE_ERR"))).toBe(exact(line(pi(), "$ echo GATE_ERR")));
		});
		it("a failed command's output line is Pi's failed bash output line", () => {
			expect(exact(output(codex(), "GATE_ERR"))).toBe(exact(output(pi(), "GATE_ERR")));
		});
		it("a failed command's exit-code line is Pi's, blank lines above it included", () => {
			expect(exact(line(codex(), "Command exited with code 3"))).toBe(exact(line(pi(), "Command exited with code 3")));
			expect(blanksAbove(codex(), "Command exited with code 3")).toBe(blanksAbove(pi(), "Command exited with code 3"));
			expect(blanksAbove(pi(), "Command exited with code 3")).toBeGreaterThan(0); // Pi's bash leaves the output's trailing newline in, then a blank line, then the status
		});
		it("a row's vertical shape is Pi's: the blank lines above the output and above Took", () => {
			for (const marker of ["GATE_CMD", "GATE_ERR"]) expect(blanksAbove(codex(), marker, "$ ")).toBe(blanksAbove(pi(), marker, "$ "));
			expect(blanksAbove(codex(), "Took ")).toBe(blanksAbove(pi(), "Took "));
		});
		it("a long output's collapsed preview is Pi's: the earlier-lines hint and the first shown line", () => {
			expect(exact(line(codex(), "earlier lines"))).toBe(exact(line(pi(), "earlier lines")));
			expect(exact(line(codex(), "GATE_P8"))).toBe(exact(line(pi(), "GATE_P8")));
		});
		it("a declined command reads as Pi's failed bash row, column for column", () => {
			const d = cap(name, "declined");
			expect(styling(line(d, "$ echo GATE_ASK"), "$ echo GATE_ASK")).toBe(styling(line(pi(), "$ echo GATE_ERR"), "$ echo GATE_ERR; exit 3"));
			expect(styling(line(d, "Declined"), "Declined")).toBe(styling(output(pi(), "GATE_ERR"), "GATE_ERR"));
		});
		it("a row Codex stopped mid-way reads as Pi's failed bash row, column for column", () => {
			const s = cap(name, "stopped");
			expect(styling(line(s, "Codex stopped"), "Codex stopped")).toBe(styling(output(pi(), "GATE_ERR"), "GATE_ERR"));
		});
		it("a question row carries the bash title and output styling, column for column (Pi has no question row)", () => {
			const q = cap(name, "question");
			expect(styling(line(q, "? Choice"), "? Choice")).toBe(styling(line(pi(), "$ echo GATE_CMD"), "$ echo GATE_CMD"));
			expect(styling(line(q, "Choice: BLUE"), "Choice: BLUE")).toBe(styling(output(pi(), "GATE_CMD"), "GATE_CMD"));
		});
		it("a question skipped with Escape completes as a row, its answer line styled as bash output (brief Flow #6: skip, not decline)", () => {
			const q = cap(name, "question-skipped");
			expect(styling(line(q, "? Choice"), "? Choice")).toBe(styling(line(pi(), "$ echo GATE_CMD"), "$ echo GATE_CMD"));
			expect(styling(line(q, "Choice: Declined"), "Choice: Declined")).toBe(styling(output(pi(), "GATE_CMD"), "GATE_CMD"));
		});
		it("a codex_command called by hand refuses as Pi's failed bash row, column for column", () => {
			const d = cap(name, "direct");
			expect(styling(line(d, "$ echo GATE_DIRECT"), "$ echo GATE_DIRECT")).toBe(styling(line(pi(), "$ echo GATE_ERR"), "$ echo GATE_ERR; exit 3"));
			expect(styling(line(d, "cannot be called directly"), "No active Codex turn holds this item; this tool cannot be called directly.")).toBe(styling(output(pi(), "GATE_ERR"), "GATE_ERR"));
		});
		it("a secret question is declined whole and reads as Pi's failed bash row, column for column", () => {
			const q = cap(name, "question-secret");
			expect(styling(line(q, "? Secret"), "? Secret")).toBe(styling(line(pi(), "$ echo GATE_ERR"), "$ echo GATE_ERR; exit 3"));
			expect(styling(line(q, "Declined"), "Declined")).toBe(styling(output(pi(), "GATE_ERR"), "GATE_ERR"));
		});

		// v0.21.4 (Scenario 20)
		const tools = () => cap(name, "tools");
		it("a tool call row's title is styled as Pi's bash title, its result lines as bash output, its hint and blank line as Pi's collapsed preview", () => {
			expect(styling(line(tools(), "bear_app.list_tags"), "bear_app.list_tags")).toBe(styling(line(pi(), "$ echo GATE_CMD"), "$ echo GATE_CMD"));
			if (name === CONFIGS[1]!.name) {
				expect(styling(output(tools(), "GATE_T6"), "GATE_T6")).toBe(styling(output(pi(), "GATE_P8"), "GATE_P8"));
				const [t, p] = [hint(tools()), hint(pi())];
				expect(t.text).toBe("... (1 earlier lines,");
				expect(t.line.toString("utf8").replace(ESCAPES, "").indexOf(t.text)).toBe(4);
				expect(p.line.toString("utf8").replace(ESCAPES, "").indexOf(p.text)).toBe(4);
				expect(styling(cutFirst4Cols(t.line), t.text)).toBe(styling(cutFirst4Cols(p.line), p.text));
				expect(blanksAbove(tools(), "earlier lines")).toBe(1);
				expect(blanksAbove(pi(), "earlier lines")).toBe(0);
			} else {
				expect(styling(output(tools(), "GATE_T6"), "GATE_T6")).toBe(styling(output(pi(), "GATE_CMD"), "GATE_CMD"));
				const [t, p] = [hint(tools()), hint(pi())];
				expect(t.text).toBe("... (1 earlier lines,");
				expect(styling(t.line, t.text)).toBe(styling(p.line, p.text));
				expect(blanksAbove(tools(), "earlier lines")).toBe(blanksAbove(pi(), "earlier lines"));
			}
			expect(blanksAbove(tools(), "GATE_T2")).toBe(0); // the first shown line sits right under the hint
		});
		it("a code argument's lines sit directly under a bold title, styled as bash output, with no hint for three lines", () => {
			expect(styling(line(tools(), "node_repl.js"), "node_repl.js")).toBe(styling(line(pi(), "$ echo GATE_CMD"), "$ echo GATE_CMD"));
			if (name === CONFIGS[1]!.name) {
				expect(styling(line(tools(), "GATE_J1"), "GATE_J1")).toBe(styling(output(pi(), "GATE_CMD"), "GATE_CMD"));
				for (const marker of ["GATE_J2", "GATE_J3"]) {
					expect(styling(line(tools(), marker), marker)).toBe(styling(output(pi(), "GATE_P8"), "GATE_P8"));
				}
			} else {
				for (const marker of ["GATE_J1", "GATE_J2", "GATE_J3"]) expect(styling(line(tools(), marker), marker)).toBe(styling(output(pi(), "GATE_CMD"), "GATE_CMD"));
			}
			expect(blanksAbove(tools(), "GATE_J1")).toBe(0);
		});
		it("a failed tool call row reads as Pi's failed bash row, column for column", () => {
			expect(styling(line(tools(), "bear_app.fail"), "bear_app.fail")).toBe(styling(line(pi(), "$ echo GATE_ERR"), "$ echo GATE_ERR; exit 3"));
			if (name === CONFIGS[1]!.name) {
				expect(styling(line(tools(), "GATE_TOOL_FAIL"), "GATE_TOOL_FAIL")).toBe(styling(line(pi(), "Command exited with code 3"), "Command exited with code 3"));
			} else {
				expect(styling(line(tools(), "GATE_TOOL_FAIL"), "GATE_TOOL_FAIL")).toBe(styling(output(pi(), "GATE_ERR"), "GATE_ERR"));
			}
		});
		if (name === CONFIGS[1]!.name) {
			it("for codex_command, codex_patch, and codex_tool rows the header's first character is at column 1 and every line under it has its first character at column 4", () => {
				// codex_command
				const cmdHeader = line(codex(), "$ echo GATE_CMD");
				expect(firstCharCol(cmdHeader)).toBe(1);
				const cmdOut = output(codex(), "GATE_CMD");
				expect(firstCharCol(cmdOut)).toBe(1);
				expect(cmdOut.toString("utf8").replace(ESCAPES, "").indexOf("GATE_CMD")).toBe(4);
				const cmdTook = line(codex(), "Took ");
				expect(firstCharCol(cmdTook)).toBe(4);
				expect(text(cmdTook)).not.toContain("└");

				// codex_patch
				const patchHeader = line(codex(), "gate.txt");
				expect(firstCharCol(patchHeader)).toBe(1);
				const patchSummary = line(codex(), "Added ");
				expect(firstCharCol(patchSummary)).toBe(1);
				expect(patchSummary.toString("utf8").replace(ESCAPES, "").indexOf("Added")).toBe(4);
				expect(firstCharCol(line(codex(), "GATE_OLD"))).toBe(4);
				expect(firstCharCol(line(codex(), "GATE_NEW"))).toBe(4);
				// GATE_CTX is a diff context line: column 4 is the context space prefix, line number at column 5
				const ctxLine = line(codex(), "GATE_CTX").toString("utf8").replace(ESCAPES, "");
				expect(ctxLine.startsWith("     1 GATE_CTX")).toBe(true);
				expect(firstCharCol(line(codex(), "GATE_APP"))).toBe(4);
				expect(firstCharCol(line(codex(), "GATE_ADD"))).toBe(4);

				// codex_tool
				// text result
				expect(firstCharCol(line(tools(), "bear_app.list_tags"))).toBe(1);
				expect(firstCharCol(output(tools(), "GATE_T6"))).toBe(4);
				// code argument: GATE_J1 is on the branch line and its Took line starts at column 4 with no └
				expect(firstCharCol(line(tools(), "node_repl.js"))).toBe(1);
				const j1 = line(tools(), "GATE_J1");
				expect(firstCharCol(j1)).toBe(1);
				expect(j1.toString("utf8").replace(ESCAPES, "").indexOf("GATE_J1")).toBe(4);
				expect(firstCharCol(line(tools(), "GATE_J2"))).toBe(4);
				expect(firstCharCol(line(tools(), "GATE_J3"))).toBe(4);
				// its own Took line: the first one under GATE_J3 and above the next row's title, not the screen's last
				const toolLines = tools().lines;
				const j3 = toolLines.findIndex((l) => l.includes("GATE_J3"));
				const nextTitle = toolLines.findIndex((l) => l.includes("bear_app.fail"));
				expect(nextTitle).toBeGreaterThan(j3);
				const took = toolLines.slice(j3 + 1, nextTitle).find((l) => l.includes("Took "));
				expect(took, "a Took line between GATE_J3 and the failed call's title").toBeDefined();
				expect(firstCharCol(took!)).toBe(4);
				expect(text(took!)).not.toContain("└");
				// failed call
				expect(firstCharCol(line(tools(), "bear_app.fail"))).toBe(1);
				expect(firstCharCol(line(tools(), "GATE_TOOL_FAIL"))).toBe(4);
			});
		}
		it("a sub-agent's command row is Pi's bash row byte for byte below the title; the title, tag stripped, is Pi's title with the width ignored", () => {
			expect(exact(output(tools(), "GATE_CMD"))).toBe(exact(output(pi(), "GATE_CMD")));
			expect(blanksAbove(tools(), "GATE_CMD", "$ ")).toBe(blanksAbove(pi(), "GATE_CMD", "$ "));
			expect(distinct(tools(), "Took ")).toEqual(distinct(pi(), "Took "));
			const title = line(tools(), "$ echo GATE_CMD");
			expect(text(title).trim()).toBe("alpha $ echo GATE_CMD");
			expect(stylingNoWidth(untagged(title, "alpha"), "$ echo GATE_CMD")).toBe(stylingNoWidth(line(pi(), "$ echo GATE_CMD"), "$ echo GATE_CMD"));
		});
		it("a tagged title that fills the pty is styled as Pi's full-width title, tag stripped", () => {
			const [title, piTitle] = [line(tools(), "$ echo GATE_FULL_ccc"), line(pi(), "$ echo GATE_FULL_ppp")]; // the `$ ` keeps the echo's own output line out
			expect(text(title).trim()).toBe(`alpha $ ${FULL_CHILD}`); // one row, not wrapped
			expect(text(piTitle).trim()).toBe(`$ ${FULL_PI}`);
			expect(text(title).length).toBe(text(piTitle).length);
			expect(stylingNoWidth(untagged(title, "alpha"), `$ ${FULL_CHILD}`)).toBe(stylingNoWidth(piTitle, `$ ${FULL_PI}`));
		});
		it("a command row cut by Escape reads as Pi's own cut bash row, column for column, with the honest text", () => {
			const [c, p] = [cap(name, "cut"), cap(name, "pi-cut")];
			const piCut = p.lines.find((l) => /abort/i.test(text(l)) && !text(l).includes("$ "));
			expect(piCut).toBeDefined();
			expect(styling(line(c, "$ echo GATE_SLEEP"), "$ echo GATE_SLEEP; sleep 30")).toBe(styling(line(p, "$ echo GATE_SLEEP"), "$ echo GATE_SLEEP; sleep 30"));
			expect(text(piCut!).trim()).toBe("Command aborted"); // Pi's bash keeps the output so far and appends its status after a blank line, as it does an exit code
			expect(exact(output(c, "GATE_SLEEP"))).toBe(exact(output(p, "GATE_SLEEP")));
			expect(styling(line(c, "still running in Codex"), "Cancelled; command still running in Codex")).toBe(styling(piCut!, "Command aborted"));
			expect(blanksAbove(c, "still running in Codex")).toBe(blanksAbove(p, "Command aborted"));
			expect(blanksAbove(p, "Command aborted")).toBe(2); // the output's trailing newline, then the blank line before the status
			expect(distinct(c, "Took ")).toEqual(distinct(p, "Took "));
		});
	});

	it("under the glance, the edit summary lines are Pi's", () => {
		// The glance styles the counts inside the line, so match on the label and compare every distinct summary drawn:
		// Pi draws two (the replace, the append) and Codex three (the same two plus the add, whose summary equals the append's).
		const name = CONFIGS[1]!.name;
		expect(distinct(cap(name, "codex"), "Added ")).toEqual(distinct(cap(name, "pi"), "Added "));
		expect(distinct(cap(name, "pi"), "Added ")).toHaveLength(2);
	});
});
