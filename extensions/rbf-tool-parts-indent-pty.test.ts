// pi-45 Scenario 8: rows keep one indent after `/reload`, after `/new`, and after reopening a session.
//
// Why a pseudo-terminal: each of the three rebuilds rows or calls the extension's factory again inside a real Pi,
// and a unit test can only imitate that. `/reload` imports the module again, `/new` calls the cached factory with
// no import, and reopening a session builds every row from the saved conversation.
// The driver and the reload probe are the ones `rbf-status-line-resume.test.ts` uses.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const PI = process.env.RBF_PI_BIN ?? join(ROOT, "node_modules", ".bin", "pi");
const SUPPORT = resolve(import.meta.dirname, "test-support");
const DRIVER = join(SUPPORT, "rbf-row-gate-drive.py");
const COLS = 100;

/** The row extensions the captured rows of Scenarios 1 and 13 were drawn with, then the scripted provider and the reload probe. */
const EXTENSIONS = [
	...[
		"rbf-tool-execution-blended",
		"rbf-edit-glance",
		"rbf-clean-markdown-code",
		"rbf-path-labels",
		"rbf-user-message-padding",
		"rbf-background-tasks",
		"rbf-tool-parts-indent",
	].map((name) => join(ROOT, "extensions", `${name}.ts`)),
	join(SUPPORT, "rbf-row-gate-provider.ts"),
	join(SUPPORT, "rbf-reload-probe.ts"),
];
/** One tool call, then text. The provider starts it over on an empty conversation, which is why it runs again after `/new`. */
const SCRIPT = JSON.stringify([{ tool: "bash", args: { command: "seq 1 12" } }, { text: "SEQ_DONE" }]);

const PYTHON = spawnSync("python3", ["--version"]).status === 0;
const READY = existsSync(PI) && PYTHON;

type Step =
	| { wait: string; count?: number }
	| { reloadReady: { path: string; loads: number } }
	| { paste: string }
	| { key: string }
	| { sleep: number }
	| { snapshot: string };
type Capture = { raw: Buffer; snapshots: Record<string, string[]> };

const ESCAPES = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]|\r/g;

/** The screen a raw stream leaves, as plain rows with their leading columns kept. Rows scrolled off the top stay. */
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

class Workspace {
	readonly dir = mkdtempSync(join(tmpdir(), "pi45-indent-pty-"));
	readonly agent = join(this.dir, "agent");
	readonly sessions = join(this.dir, "sessions");
	readonly work = join(this.dir, "work");
	readonly receipt = join(this.dir, "probe-receipt.json");
	constructor() {
		for (const dir of [this.agent, this.sessions, this.work]) mkdirSync(dir);
	}
	cleanup() {
		rmSync(this.dir, { recursive: true, force: true });
	}
}

/** Boot one isolated Pi under a pseudo-terminal, run the steps, and replay the stream up to each snapshot. */
function drive(ws: Workspace, steps: Step[], args: string[] = []): Promise<Capture> {
	const out = join(ws.dir, "raw.bin");
	const plan = {
		argv: [PI, "--approve", "--no-extensions", "--no-skills", "--no-themes", "--no-context-files", "--no-prompt-templates", "--session-dir", ws.sessions, ...EXTENSIONS.flatMap((e) => ["-e", e]), "--model", "rbf-gate/gate", ...args],
		cwd: ws.work,
		env: { PI_CODING_AGENT_DIR: ws.agent, PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_HYPERLINKS: "0", PI_RELOAD_PROBE_RECEIPT: ws.receipt, RBF_ROW_GATE_SCRIPT: SCRIPT },
		cols: COLS,
		rows: 40,
		timeout: 60,
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
			resolvePromise({ raw, snapshots: Object.fromEntries(Object.entries(offsets).map(([name, offset]) => [name, screen(raw.subarray(0, offset))])) });
		});
		child.stdin.end(JSON.stringify(plan));
	});
}

// Scenario 1's collapsed shell row, with the timing digits neutralised.
const TOOL_ROW = [" $ seq 1 12", " └  ... (7 earlier lines, ctrl+o to expand)", "    8", "    9", "    10", "    11", "    12", "", "    Took N.Ns"];
// The same row rebuilt from the saved conversation: Pi never marks it as started, so it draws no blank row and no `Took` line.
const REBUILT_TOOL_ROW = TOOL_ROW.slice(0, 7);
// Scenario 13's first row.
const BORDER = "─".repeat(COLS);
const BANG_ROW = [BORDER, " $ printf 'alpha\\nbeta\\n'", " └  alpha", "    beta", "", BORDER];

/** The newest tool row on the screen: from its header down to the row above the next thing drawn, with blank rows at its end cut. */
function toolRow(lines: string[]): string[] {
	const at = lines.lastIndexOf(TOOL_ROW[0]!);
	expect(at, `a tool row header on screen:\n${lines.join("\n")}`).toBeGreaterThanOrEqual(0);
	let end = at + 1;
	while (end < lines.length && (lines[end] === "" || lines[end]!.startsWith("    ") || lines[end]!.startsWith(" └"))) end++;
	const rows = lines.slice(at, end).map((line) => line.replace(/Took \d+\.\ds/, "Took N.Ns"));
	while (rows[rows.length - 1] === "") rows.pop();
	return rows;
}

/** The newest `!` row on the screen, from its top border line to its bottom one. */
function bangRow(lines: string[]): string[] {
	const at = lines.lastIndexOf(BANG_ROW[1]!);
	expect(at, `a ! row header on screen:\n${lines.join("\n")}`).toBeGreaterThan(0);
	const end = lines.indexOf(BORDER, at);
	expect(end, "the ! row's bottom border").toBeGreaterThan(at);
	return lines.slice(at - 1, end + 1);
}

describe.skipIf(!READY)("pi-45: rows keep one indent after /reload, /new, and reopening a session (pty)", () => {
	it(
		"the tool row and the ! row draw once-indented live, after /reload, after /new, and in a new Pi that reopens the session",
		async () => {
			const ws = new Workspace();
			try {
				const first = await drive(ws, [
					{ wait: "ctrl\\+o more" },
					{ paste: "go" },
					{ key: "enter" },
					{ wait: "SEQ_DONE" },
					{ paste: "!printf 'alpha\\nbeta\\n'" },
					{ key: "enter" },
					{ wait: "└ +alpha" },
					{ sleep: 0.5 },
					{ snapshot: "live" },
					{ paste: "/reload" },
					{ key: "enter" },
					{ reloadReady: { path: ws.receipt, loads: 2 } },
					{ sleep: 0.5 },
					{ snapshot: "reloaded" },
					{ paste: "/new" },
					{ key: "enter" },
					{ sleep: 1.0 },
					{ paste: "go again" },
					{ key: "enter" },
					// The second run's own lines: nothing of the first run is drawn again once `/new` cleared the chat.
					{ wait: "go again[\\s\\S]*Took \\d[\\s\\S]*SEQ_DONE" },
					{ sleep: 0.5 },
					{ snapshot: "new" },
				]);

				// 1. Live rows.
				expect(toolRow(first.snapshots.live!)).toEqual(TOOL_ROW);
				expect(bangRow(first.snapshots.live!)).toEqual(BANG_ROW);

				// The probe counts each call of its factory: at start, on /reload, and on /new. The `reloadReady` step
				// waited for the second, so the "reloaded" snapshot was taken with the freshly imported module in place.
				expect(JSON.parse(readFileSync(ws.receipt, "utf8")).loads).toBe(3);

				// 2. After /reload: the module was imported again and Pi rebuilt both rows from the conversation.
				expect(toolRow(first.snapshots.reloaded!)).toEqual(REBUILT_TOOL_ROW);
				expect(bangRow(first.snapshots.reloaded!)).toEqual(BANG_ROW);

				// 3. After /new: Pi shut the session down and called the cached factory again, with no import.
				expect(toolRow(first.snapshots.new!)).toEqual(TOOL_ROW);

				// 4. A new Pi reopens the first session.
				const sessions = readdirSync(ws.sessions).filter((name) => name.endsWith(".jsonl")).sort();
				expect(sessions.length).toBe(2);
				const second = await drive(ws, [{ wait: "ctrl\\+o more" }, { wait: "seq 1 12" }, { sleep: 1.0 }, { snapshot: "reopened" }], ["--session", join(ws.sessions, sessions[0]!)]);
				expect(toolRow(second.snapshots.reopened!)).toEqual(REBUILT_TOOL_ROW);
				expect(bangRow(second.snapshots.reopened!)).toEqual(BANG_ROW);

				// One └ per row, in every step.
				for (const lines of [first.snapshots.live!, first.snapshots.reloaded!, second.snapshots.reopened!]) {
					expect(toolRow(lines).filter((line) => line.includes("└")).length).toBe(1);
					expect(bangRow(lines).filter((line) => line.includes("└")).length).toBe(1);
				}
				expect(toolRow(first.snapshots.new!).filter((line) => line.includes("└")).length).toBe(1);
			} finally {
				ws.cleanup();
			}
		},
		120000,
	);
});
