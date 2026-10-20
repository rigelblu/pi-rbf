// The shell-count view in a real interactive Pi, under a pseudo-terminal, on both hosts: the repository's Pi 0.85.1
// and the daily Pi binary when it is installed. No model and no network: Pi's own tools run behind the scripted
// provider, and Codex rows come from the real `rbf-codex` over the fake app-server.
//
// Every assertion reads a final screen replayed from the raw bytes, what the owners said on the display channel,
// or the session file. Each run's plan, raw bytes, screens, owner facts and session records are kept under the
// directory `eng-use-external-tmp` resolves for `pi-42`.
//
// Needs the local `pi` bundle and python3; their absence skips the suite. RBF_SHELL_GROUPS_DAILY_PI names the
// second host's binary when it is not at `~/Library/pnpm/bin/pi`; with neither, only the repository host runs.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { FakeScenario } from "./test-support/rbf-codex-fake-app-server.ts";
import { replayScreen, type Cell, type Screen } from "./test-support/rbf-pty-screen.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SUPPORT = resolve(import.meta.dirname, "test-support");
const DRIVER = join(SUPPORT, "rbf-row-gate-drive.py");
const PROVIDER = join(SUPPORT, "rbf-row-gate-provider.ts");
const CODEX = join(SUPPORT, "rbf-row-gate-codex.ts");
const PROBE = join(SUPPORT, "rbf-shell-display-probe.ts");
const VIEW = join(import.meta.dirname, "rbf-shell-command-groups.ts");
const OWNER = join(import.meta.dirname, "rbf-background-tasks.ts");
const INDENT = join(import.meta.dirname, "rbf-tool-parts-indent.ts");
const BLENDED = join(import.meta.dirname, "rbf-tool-execution-blended.ts");
const SANDBOX = join(import.meta.dirname, "rbf-sandbox", "index.ts");
/** The supported ordinary profile: the view, the Pi owner, and the two row extensions the layout is drawn for. */
const PROFILE = [VIEW, OWNER, INDENT, BLENDED];

const REPO_PI = join(ROOT, "node_modules", ".bin", "pi");
const DAILY_PI = process.env.RBF_SHELL_GROUPS_DAILY_PI ?? join(homedir(), "Library", "pnpm", "bin", "pi");
const versionOf = (bin: string) => spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout?.trim() || "unknown";
const HOSTS = [REPO_PI, DAILY_PI].filter((bin) => existsSync(bin)).map((bin) => ({ bin, name: `pi-${versionOf(bin)}` }));
const READY = existsSync(REPO_PI) && spawnSync("python3", ["--version"]).status === 0;

/** Where runs keep what they saw. Resolved when the suite runs; the resolver itself falls back to /tmp when the drive is away. */
function artifactRoot(): string {
	const script = join(homedir(), ".agents", "skills", "eng-use-external-tmp", "scripts", "resolve-external-tmp.sh");
	const resolved = existsSync(script) ? spawnSync("bash", [script, "pi-42"], { encoding: "utf8" }).stdout?.trim() : "";
	const root = process.env.RBF_SHELL_GROUPS_ARTIFACTS || join(resolved || join(tmpdir(), "pi-42"), "pty");
	mkdirSync(root, { recursive: true });
	return root;
}
const ARTIFACTS = READY ? artifactRoot() : "";

type Step = Record<string, unknown>;
type Fact = { kind: string; sessionId?: string; source?: string; ownerGeneration?: string; toolCallId?: string; revision?: number; fact?: Record<string, any> };
type Run = {
	scenario: string;
	host: (typeof HOSTS)[number];
	name: string;
	extensions: string[];
	model?: string;
	script?: unknown[];
	codex?: FakeScenario;
	env?: Record<string, string>;
	args?: string[];
	/** Another run's session directory and working directory, to reopen what it wrote: Pi finds a session by where it was started. */
	sessions?: string;
	work?: string;
	cols?: number;
	rows?: number;
	mode?: "fullscreen" | "regular";
	mcp?: object;
	steps: Step[];
};
type Result = { dir: string; marks: Record<string, any>; screen(mark: string): Screen; lines(mark: string): string[]; facts(): Fact[]; session(): any[] };

const START: Step[] = [{ wait: "\\[Extensions\\]" }, { sleep: 0.7 }];
const GO: Step[] = [{ paste: "go" }, { key: "enter" }];
const mark = (name: string): Step[] => [{ sleep: 0.5 }, { snapshot: name }];
/** A left click as the terminal reports it, on the row where `text` was last drawn (or `dy` rows below it). */
const click = (name: string, text: string, opts: { x?: number; dy?: number; button?: number } = {}): Step[] => {
	const row = `{${name}${opts.dy ? (opts.dy > 0 ? `+${opts.dy}` : String(opts.dy)) : ""}}`;
	const at = `${opts.button ?? 0};${opts.x ?? 6};${row}`;
	return [{ locate: { name, text } }, { bytes: `\x1b[<${at}M` }, { bytes: `\x1b[<${at}m` }, { sleep: 0.5 }];
};

/** Boot one isolated Pi (its own agent dir and sessions, only the extensions named) and drive it. */
function drive(run: Run): Promise<Result> {
	const dir = join(ARTIFACTS, run.scenario, run.host.name, run.name);
	rmSync(dir, { recursive: true, force: true });
	for (const sub of ["agent", "sessions", "work", "screens"]) mkdirSync(join(dir, sub), { recursive: true });
	if (run.mcp) writeFileSync(join(dir,"agent","mcp.json"),JSON.stringify(run.mcp));
	const cols = run.cols ?? 80;
	const rows = run.rows ?? 50;
	const out = join(dir, "raw.bin");
	const facts = join(dir, "owner-facts.jsonl");
	const sessions = run.sessions ?? join(dir, "sessions");
	const steps = run.steps.map((step) => (step.sessionSnapshot ? { sessionSnapshot: { ...(step.sessionSnapshot as object), dir: sessions } } : step));
	const plan = {
		argv: [
			run.host.bin,
			"--no-extensions",
			"--no-skills",
			"--no-themes",
			"--no-context-files",
			"--no-prompt-templates",
			"--session-dir",
			sessions,
			...[...run.extensions, ...(run.script ? [PROVIDER] : []), PROBE].flatMap((extension) => ["-e", extension]),
			"--model",
			run.model ?? "rbf-gate/gate",
			"--tui-mode",
			run.mode ?? "fullscreen",
			...(run.args ?? []),
		],
		cwd: run.work ?? join(dir, "work"),
		env: {
			PI_CODING_AGENT_DIR: join(dir, "agent"),
			PI_SKIP_VERSION_CHECK: "1",
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
			PI_HYPERLINKS: "0",
			RBF_SHELL_DISPLAY_LOG: facts,
			...(run.script ? { RBF_ROW_GATE_SCRIPT: JSON.stringify(run.script) } : {}),
			...(run.codex ? { RBF_FAKE_SCENARIO: JSON.stringify(run.codex), RBF_FAKE_LOG: join(dir, "codex-requests.jsonl") } : {}),
			...run.env,
		},
		cols,
		rows,
		timeout: 60,
		out,
		steps,
	};
	writeFileSync(join(dir, "plan.json"), JSON.stringify(plan, null, 2));
	return new Promise((resolvePromise, reject) => {
		const child = spawn("python3", [DRIVER], { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", reject);
		child.on("close", (code) => {
			const raw = existsSync(out) ? readFileSync(out) : Buffer.alloc(0);
			if (code !== 0) {
				writeFileSync(join(dir, "screens", "at-failure.txt"), replayScreen(raw, cols, rows).lines.join("\n"));
				return reject(new Error(`driver exited ${code}: ${stderr.trim()} (artifacts in ${dir})`));
			}
			const marks = JSON.parse(stdout) as Record<string, any>;
			// The driver notes the byte each resize happened at; the replay changes size there.
			const resizes = run.steps
				.filter((step) => step.resize)
				.map((step, i) => ({ at: marks[`resize:${i + 1}`] as number, ...(step.resize as { cols: number; rows: number }) }));
			const screen = (name: string) => {
				if (typeof marks[name] !== "number") throw new Error(`no snapshot ${name}`);
				const at = replayScreen(raw.subarray(0, marks[name]), cols, rows, resizes.filter((resize) => resize.at <= marks[name]!));
				writeFileSync(join(dir, "screens", `${name}.txt`), at.lines.join("\n"));
				if(run.scenario==="pi-52")writeFileSync(join(dir,"screens",`${name}.cells.json`),JSON.stringify(at));
				return at;
			};
			for (const name of Object.keys(marks)) if (typeof marks[name] === "number" && !name.includes(":")) screen(name);
			resolvePromise({
				dir,
				marks,
				screen,
				lines: (name) => screen(name).lines,
				facts: () => (existsSync(facts) ? readFileSync(facts, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []),
				session: () =>
					readdirSync(sessions, { recursive: true })
						.filter((file) => String(file).endsWith(".jsonl"))
						.flatMap((file) => readFileSync(join(sessions, String(file)), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))),
			});
		});
		child.stdin.end(JSON.stringify(plan));
	});
}

const bash = (command: string, extra: Record<string, unknown> = {}) => ({ tool: "bash", args: { command, ...extra } });
const text = (line: string) => ({ text: line });
const headers = (lines: string[]) => lines.filter((line) => /^ [▸▾] /.test(line));
/** The transcript between the prompt and the editor's top rule: what one turn drew. */
function transcript(lines: string[]): string[] {
	const from = lines.lastIndexOf(" go");
	const to = lines.findIndex((line, i) => i > from && line.startsWith("────"));
	const drawn = lines.slice(from + 1, to === -1 ? undefined : to);
	// The editor sits at the bottom of the pane; the blank rows above it are the pane's, not the turn's.
	while (drawn.length > 0 && drawn[drawn.length - 1] === "") drawn.pop();
	return drawn;
}
/** What the prompt editor holds: the row between the pane's last two rules. */
function editorLine(lines: string[]): string {
	const rules = lines.flatMap((line, i) => (line.startsWith("────") ? [i] : []));
	return lines[rules.at(-2)! + 1]!;
}
/** `Took` reads the clock: two runs of one command differ by a tenth of a second and by nothing else. */
const took = (lines: string[]) => lines.map((line) => line.replace(/Took \d+\.\ds/, "Took N.Ns"));
const settle = took;
const style = (cell: Cell) => `${cell.fg || "default"}${cell.bold ? " bold" : ""}${cell.dim ? " dim" : ""}`;
/** The facts an owner told, each once: the log also holds the copies it replays when the view asks for a snapshot. */
const factsOf = (facts: Fact[], toolCallId?: string) => {
	const told = new Set<string>();
	return facts.filter((message) => {
		if (message.kind !== "fact" || (toolCallId && message.toolCallId !== toolCallId)) return false;
		const key = `${message.ownerGeneration}\n${message.toolCallId}\n${message.revision}`;
		return told.has(key) ? false : (told.add(key), true);
	});
};
const kinds = (facts: Fact[]) => facts.map((message) => message.fact!.kind);
const toolResults = (session: any[]) => session.filter((entry) => entry.type === "message" && entry.message?.role === "toolResult").map((entry) => entry.message);
const resultText = (message: any) => (message.content ?? []).map((part: any) => part.text ?? "").join("");
const WORDS = Array.from({ length: 35 }, (_, i) => `word${String(i + 1).padStart(2, "0")}`).join(" ");
const PTY = 90_000;

describe.skipIf(!READY)("shell command groups in a real Pi (pty)", () => {
	it("has a repository host, and says which hosts it runs on", () => {
		console.log(`shell command groups pty hosts: ${HOSTS.map((host) => `${host.name} (${host.bin})`).join(", ")}; artifacts: ${ARTIFACTS}`);
		expect(HOSTS[0]?.bin).toBe(REPO_PI);
	});

	describe.each(HOSTS)("background lifetime on $name", (host) => {
		const scenario = "S3-background-lifetime";

		it(
			"Ctrl+B leaves the command one member in the background with its task id, and its real exit makes the group ran",
			async () => {
				const run = await drive({
					scenario,
					host,
					name: "detach-then-exit",
					extensions: PROFILE,
					script: [bash("echo first"), bash("sleep 3; printf BG-DONE"), text("BG_NOTED")],
					steps: [
						...START,
						...GO,
						{ wait: "2 shell commands · 1 running" },
						...mark("running"),
						{ key: "ctrl-b" },
						{ wait: "BG_NOTED" },
						...mark("background"),
						{ wait: "ran 2 shell commands" },
						...mark("ran"),
						...click("header", "ran 2 shell commands"),
						...mark("expanded"),
					],
				});
				expect(headers(run.lines("running"))).toEqual([" ▸ 2 shell commands · 1 running"]);
				// The count hides the row's own elapsed hint; Pi's working line still says how to background or cancel the one foreground command.
				expect(transcript(run.lines("running")).join("\n")).not.toContain("Elapsed");
				expect(run.lines("running").some((line) => line.includes("Working (ctrl+b to run in background · Esc to cancel)"))).toBe(true);

				const background = transcript(run.lines("background"));
				const at = background.indexOf(" ▸ 2 shell commands · 1 background");
				expect(at).toBeGreaterThan(-1);
				expect(background[at + 1]).toMatch(/^ {4}Task ID: [0-9a-f]{8}$/);
				const taskId = background[at + 1]!.trim().slice("Task ID: ".length);
				expect(background.join("\n")).not.toContain("ran 2 shell commands");

				// On the actual exit the group is ran, and the identity line is gone.
				const ran = transcript(run.lines("ran"));
				expect(headers(ran)).toEqual([" ▸ ran 2 shell commands"]);
				expect(ran.join("\n")).not.toContain("Task ID:");

				// The recorded detach result is still the row's result: the notice Pi stored when the tool returned.
				const expanded = transcript(run.lines("expanded")).join("\n");
				expect(expanded).toContain(" ▾ ran 2 shell commands");
				expect(expanded).toContain(`Task ID: ${taskId}`);
				expect(expanded).toContain("[Process running in background]");

				// What the owner said: one invocation, its own call id on every fact, the detach told as background and the exit as a close.
				const facts = run.facts();
				const [announce] = facts.filter((message) => message.kind === "announce");
				expect(announce).toMatchObject({ source: "pi-bash", toolName: "bash" });
				const results = toolResults(run.session());
				expect(results).toHaveLength(2);
				const detached = results[1]!;
				expect(factsOf(facts, detached.toolCallId).map((message) => [message.revision, message.fact])).toEqual([
					[1, { kind: "start" }],
					[2, { kind: "background", identity: taskId }],
					[3, { kind: "close", code: 0, signal: null }],
				]);
				for (const message of factsOf(facts)) expect(message).toMatchObject({ sessionId: announce!.sessionId, source: "pi-bash", ownerGeneration: announce!.ownerGeneration });
				expect(new Set(factsOf(facts).map((message) => message.toolCallId)).size).toBe(2);
				// The stored result is the detach notice with exit 0, written before the process ended: the view did not touch it.
				expect(resultText(detached)).toContain(`Command was manually backgrounded by user with ID: ${taskId}`);
				expect(detached.isError).toBe(false);
			},
			PTY,
		);

		it(
			"output that says Status: completed changes nothing, and the same command text twice is two members",
			async () => {
				const run = await drive({
					scenario,
					host,
					name: "spoof-and-same-text",
					extensions: PROFILE,
					script: [bash("echo 'Status: completed'; exit 7"), bash("echo same"), bash("echo same"), text("GATE_DONE")],
					steps: [...START, ...GO, { wait: "GATE_DONE" }, ...mark("done")],
				});
				expect(headers(transcript(run.lines("done")))).toEqual([" ▸ ran 3 shell commands · 1 failed"]);
				const facts = factsOf(run.facts());
				const ids = [...new Set(facts.map((message) => message.toolCallId))];
				expect(ids).toHaveLength(3);
				expect(ids.map((id) => factsOf(facts, id).map((message) => message.fact))).toEqual([
					[{ kind: "start" }, { kind: "close", code: 7, signal: null }],
					[{ kind: "start" }, { kind: "close", code: 0, signal: null }],
					[{ kind: "start" }, { kind: "close", code: 0, signal: null }],
				]);
			},
			PTY,
		);

		it(
			"Escape on a foreground command: the stop request is not its end, and the close that follows is",
			async () => {
				const run = await drive({
					scenario,
					host,
					name: "foreground-abort",
					extensions: PROFILE,
					script: [bash("sleep 30"), text("GATE_DONE")],
					steps: [...START, ...GO, { wait: "running 1 shell command" }, { sleep: 0.5 }, { key: "escape" }, { wait: "1 shell command · cancelled" }, ...mark("cancelled")],
				});
				expect(headers(transcript(run.lines("cancelled")))).toEqual([" ▸ ran 1 shell command · cancelled"]);
				const facts = factsOf(run.facts());
				expect(kinds(facts)).toEqual(["start", "stop-request", "close"]);
				expect(facts[1]!.fact).toEqual({ kind: "stop-request", reason: "cancel" });
				expect(facts[2]!.fact).toMatchObject({ kind: "close", code: null });
				expect(facts[2]!.fact!.signal).toMatch(/^SIG(TERM|KILL)$/);
			},
			PTY,
		);

		it(
			"a command that outlives its timeout failed, once its process is really gone",
			async () => {
				const run = await drive({
					scenario,
					host,
					name: "timeout",
					extensions: PROFILE,
					script: [bash("sleep 30", { timeout: 1 }), text("GATE_DONE")],
					steps: [...START, ...GO, { wait: "GATE_DONE" }, ...mark("done")],
				});
				expect(headers(transcript(run.lines("done")))).toEqual([" ▸ ran 1 shell command · 1 failed"]);
				const facts = factsOf(run.facts());
				expect(kinds(facts)).toEqual(["start", "stop-request", "close"]);
				expect(facts[1]!.fact).toEqual({ kind: "stop-request", reason: "timeout" });
			},
			PTY,
		);

		it(
			"C3: in fullscreen active Pi, clicking an expanded member during streaming collapses group without cancelling execution, header completes truthfully closed, and reopening reveals finished output",
			async () => {
				const run = await drive({
					scenario,
					host,
					name: "active-streaming-collapse",
					extensions: PROFILE,
					script: [
						bash("echo b3V0X2ZpcnN0Cg== | base64 -d"),
						bash("echo b3V0X2FscGhhCg== | base64 -d; sleep 3; echo b3V0X2JldGEK | base64 -d"),
						text("STREAM_DONE"),
					],
					steps: [
						...START,
						...GO,
						{ wait: "2 shell commands · 1 running" },
						...click("header_open", "2 shell commands · 1 running"),
						{ wait: "out_alpha" },
						...mark("streaming_expanded"),
						// Locate command 2 row to prove click mark is below command row
						{ locate: { name: "cmd2", text: "b3V0X2FscGhhCg==" } },
						// Plain click on streaming member output during stable sleep interval
						{ locate: { name: "stream_out_click", text: "out_alpha" } },
						{ bytes: "\x1b[<0;6;{stream_out_click}M" },
						{ bytes: "\x1b[<0;6;{stream_out_click}m" },
						...mark("streaming_collapsed"),
						// Verify command continues running without cancellation and finishes truthfully closed
						{ wait: "STREAM_DONE" },
						...mark("streaming_finished"),
						// Click header to reopen and verify complete finished output
						...click("header_reopen", "ran 2 shell commands"),
						...mark("streaming_reopened"),
					],
				});
				expect(headers(transcript(run.lines("streaming_expanded")))[0]).toContain("▾ 2 shell commands · 1 running");
				expect(headers(transcript(run.lines("streaming_collapsed")))[0]).toContain("▸ 2 shell commands · 1 running");
				// Verify click mark was on output row strictly below command row
				expect(run.marks["row:stream_out_click"]).toBeGreaterThan(run.marks["row:cmd2"]);
				// Crucial: not cancelled!
				expect(headers(transcript(run.lines("streaming_finished")))).toEqual([" ▸ ran 2 shell commands"]);
				expect(transcript(run.lines("streaming_finished")).join("\n")).not.toContain("cancelled");
				// Reopening shows distinct output rows and exact successful stored results
				const reopened = transcript(run.lines("streaming_reopened"));
				expect(reopened.filter((line) => line.startsWith(" $ "))).toEqual([
					" $ echo b3V0X2ZpcnN0Cg== | base64 -d",
					" $ echo b3V0X2FscGhhCg== | base64 -d; sleep 3; echo b3V0X2JldGEK | base64 -d",
				]);
				const cmd1Idx = reopened.indexOf(" $ echo b3V0X2ZpcnN0Cg== | base64 -d");
				const cmd2Idx = reopened.indexOf(" $ echo b3V0X2FscGhhCg== | base64 -d; sleep 3; echo b3V0X2JldGEK | base64 -d");
				const out1 = reopened.slice(cmd1Idx + 1, cmd2Idx);
				const out2 = reopened.slice(cmd2Idx + 1);

				expect(out1.map((l) => l.replace(/^[^a-zA-Z0-9]*/, "")).filter(Boolean)).toContain("out_first");
				expect(out2.map((l) => l.replace(/^[^a-zA-Z0-9]*/, "")).filter(Boolean)).toContain("out_alpha");
				expect(out2.map((l) => l.replace(/^[^a-zA-Z0-9]*/, "")).filter(Boolean)).toContain("out_beta");

				const results = toolResults(run.session());
				expect(results.map((r) => r.isError)).toEqual([false, false]);
				expect(resultText(results[0]).trim()).toBe("out_first");
				expect(resultText(results[1]).trim()).toBe("out_alpha\nout_beta");
			},
			PTY * 2,
		);
	});

	describe.each(HOSTS)("codex completion and interrupt on $name", (host) => {
		const scenario = "S4-codex";
		const codexRun = (name: string, codex: FakeScenario, steps: Step[], cols = 80) =>
			drive({ scenario, host, name, extensions: [VIEW, CODEX, INDENT, BLENDED], model: "codex-harness/codex", codex, cols, steps: [...START, ...GO, ...steps] });

		it(
			"a command that succeeds counts once and exit 7 stays visibly failed",
			async () => {
				const run = await codexRun(
					"success-and-exit-7",
					{ turn: [{ kind: "command", id: "c1", command: "/bin/zsh -lc 'pwd'", output: ["/work\n"] }, { kind: "command", id: "c2", command: "/bin/zsh -lc 'exit 7'", exitCode: 7, output: ["boom\n"] }, { kind: "answer", id: "m1", text: "CODEX_DONE" }, { kind: "complete" }] },
					[{ wait: "CODEX_DONE" }, ...mark("done"), ...click("header", "ran 2 shell commands"), ...mark("expanded")],
				);
				expect(headers(transcript(run.lines("done")))).toEqual([" ▸ ran 2 shell commands · 1 failed"]);
				const facts = run.facts();
				expect(facts.find((message) => message.kind === "announce")).toMatchObject({ source: "codex-command", toolName: "codex_command" });
				expect(factsOf(facts, "codex-c1").map((message) => message.fact)).toEqual([{ kind: "start" }, { kind: "completion", exitCode: 0, status: "completed" }]);
				expect(factsOf(facts, "codex-c2").map((message) => message.fact)).toEqual([{ kind: "start" }, { kind: "completion", exitCode: 7, status: "failed" }]);
				// Expanded, the rows are Codex's own: the login-shell wrapper is stripped from the title, and the stored arguments keep it.
				const expanded = transcript(run.lines("expanded")).join("\n");
				expect(expanded).toContain(" $ pwd");
				expect(expanded).toContain("Command exited with code 7");
				const calls = run.session().filter((entry) => entry.type === "message" && entry.message?.role === "assistant").flatMap((entry) => entry.message.content.filter((part: any) => part.type === "toolCall"));
				expect(calls.map((call: any) => call.arguments.command)).toEqual(["/bin/zsh -lc 'pwd'", "/bin/zsh -lc 'exit 7'"]);
				expect(calls.map((call: any) => call.arguments.threadId)).toEqual(["", ""]); // the root's display args name no thread
			},
			PTY,
		);

		it.each([80, 120])(
			"C2: at %i columns, in deterministic Codex-through-Pi, clicking an expanded command collapses the whole group immediately, and header reopens it",
			async (cols) => {
				const run = await codexRun(
					`codex-cmd-collapse-${cols}`,
					{ turn: [{ kind: "command", id: "c1", command: "/bin/zsh -lc 'echo first'", output: ["CODEX_OUT_FIRST\n"] }, { kind: "command", id: "c2", command: "/bin/zsh -lc 'echo second'", output: ["CODEX_OUT_SECOND\n"] }, { kind: "answer", id: "m1", text: "CODEX_DONE" }, { kind: "complete" }] },
					[
						{ wait: "CODEX_DONE" },
						...click("header", "ran 2 shell commands"),
						...mark("opened"),
						...click("cmd_click", "echo first"),
						...mark("cmd_collapsed"),
						...click("reopen", "ran 2 shell commands"),
						...mark("reopened"),
					],
					cols,
				);
				const hdrs = (name: string) => headers(transcript(run.lines(name)));
				expect(hdrs("opened")).toEqual([" ▾ ran 2 shell commands"]);
				expect(hdrs("cmd_collapsed")).toEqual([" ▸ ran 2 shell commands"]);
				expect(transcript(run.lines("cmd_collapsed")).filter((line) => line.startsWith(" $ "))).toEqual([]);
				expect(hdrs("reopened")).toEqual([" ▾ ran 2 shell commands"]);
				expect(settle(transcript(run.lines("reopened")))).toEqual(settle(transcript(run.lines("opened"))));
			},
			PTY,
		);

		it.each([80, 120])(
			"C2: at %i columns, in deterministic Codex-through-Pi, clicking an expanded output collapses the whole group immediately, and header reopens it",
			async (cols) => {
				const run = await codexRun(
					`codex-out-collapse-${cols}`,
					{ turn: [{ kind: "command", id: "c1", command: "/bin/zsh -lc 'echo first'", output: ["CODEX_OUT_FIRST\n"] }, { kind: "command", id: "c2", command: "/bin/zsh -lc 'echo second'", output: ["CODEX_OUT_SECOND\n"] }, { kind: "answer", id: "m1", text: "CODEX_DONE" }, { kind: "complete" }] },
					[
						{ wait: "CODEX_DONE" },
						...click("header", "ran 2 shell commands"),
						...mark("opened"),
						{ locate: { name: "cmd", text: "echo second" } },
						...click("out_click", "CODEX_OUT_SECOND"),
						...mark("out_collapsed"),
						...click("reopen", "ran 2 shell commands"),
						...mark("reopened"),
					],
					cols,
				);
				expect(run.marks["row:out_click"]).toBeGreaterThan(run.marks["row:cmd"]);
				const hdrs = (name: string) => headers(transcript(run.lines(name)));
				expect(hdrs("opened")).toEqual([" ▾ ran 2 shell commands"]);
				expect(hdrs("out_collapsed")).toEqual([" ▸ ran 2 shell commands"]);
				expect(transcript(run.lines("out_collapsed")).filter((line) => line.startsWith(" $ "))).toEqual([]);
				expect(hdrs("reopened")).toEqual([" ▾ ran 2 shell commands"]);
				expect(settle(transcript(run.lines("reopened")))).toEqual(settle(transcript(run.lines("opened"))));
			},
			PTY,
		);

		it(
			"C3: in deterministic Codex-through-Pi, stale member press after resize rejects collapse and keeps group expanded",
			async () => {
				const run = await codexRun(
					"codex-stale-press-resize",
					{ turn: [{ kind: "command", id: "c1", command: "/bin/zsh -lc 'echo first'", output: ["first\n"] }, { kind: "command", id: "c2", command: "/bin/zsh -lc 'echo second'", output: ["second\n"] }, { kind: "answer", id: "m1", text: "CODEX_DONE" }, { kind: "complete" }] },
					[
						{ wait: "CODEX_DONE" },
						...click("header", "ran 2 shell commands"),
						...mark("expanded"),
						// 1. Press on member row at cols=80
						{ locate: { name: "cmd", text: "echo first" } },
						{ bytes: "\x1b[<0;6;{cmd}M" },
						// 2. Terminal resize to 120 and back to 80
						{ resize: { cols: 120, rows: 40 } },
						{ sleep: 0.3 },
						{ resize: { cols: 80, rows: 40 } },
						{ sleep: 0.3 },
						// 3. Release and click at the original coordinates
						{ bytes: "\x1b[<0;6;{cmd}m" },
						{ sleep: 0.3 },
						...mark("after_stale"),
						// 4. Fresh member click collapses group
						...click("fresh_member", "echo first"),
						...mark("collapsed"),
						// 5. Header click reopens group
						...click("reopen", "ran 2 shell commands"),
						...mark("reopened"),
					],
				);
				expect(headers(transcript(run.lines("after_stale")))).toEqual([" ▾ ran 2 shell commands"]);
				expect(headers(transcript(run.lines("collapsed")))).toEqual([" ▸ ran 2 shell commands"]);
				expect(headers(transcript(run.lines("reopened")))).toEqual([" ▾ ran 2 shell commands"]);
				expect(settle(transcript(run.lines("reopened")))).toEqual(settle(transcript(run.lines("expanded"))));
			},
			PTY,
		);

		it(
			"Escape during a running command: it is shown still running under its item id, never killed or ran, until Codex reports it finished",
			async () => {
				const command = "/bin/zsh -lc 'sleep 3; printf CODEX-DONE'";
				const run = await codexRun(
					"interrupt-then-late-completion",
					{ turn: [{ kind: "command", id: "c1", command, incomplete: true }, { kind: "hang" }], afterInterrupt: [{ kind: "sleep", ms: 2500 }, { kind: "finishCommand", id: "c1", command, exitCode: 0 }] },
					[{ wait: "running 1 shell command" }, ...mark("running"), { key: "escape" }, { wait: "1 shell command · background" }, ...mark("cut"), { wait: "ran 1 shell command" }, ...mark("finished")],
				);
				expect(headers(transcript(run.lines("running")))).toEqual([" ▸ running 1 shell command"]);
				const cut = transcript(run.lines("cut"));
				const at = cut.indexOf(" ▸ 1 shell command · background");
				expect(at).toBeGreaterThan(-1);
				expect(cut[at + 1]).toBe("    Codex command ID: c1 · still running");
				const finished = transcript(run.lines("finished"));
				expect(headers(finished)).toEqual([" ▸ ran 1 shell command"]);
				expect(finished.join("\n")).not.toContain("Codex command ID");
				expect(factsOf(run.facts(), "codex-c1").map((message) => message.fact)).toEqual([{ kind: "start" }, { kind: "cut", identity: "c1" }, { kind: "completion", exitCode: 0, status: "completed" }]);
			},
			PTY,
		);

		it(
			"an approval that is open, then accepted, is waiting until Codex starts the command; a refused one is not run",
			async () => {
				const accepted = await codexRun(
					"approval-accepted",
					{ turn: [{ kind: "command", id: "c1", command: "/bin/zsh -lc 'echo hi'", output: ["hi\n"], approvals: [{ when: "before", command: "/bin/zsh -lc 'echo hi'" }] }, { kind: "answer", id: "m1", text: "CODEX_DONE" }, { kind: "complete" }] },
					[{ wait: "Codex wants to run" }, ...mark("asking"), { key: "enter" }, { wait: "CODEX_DONE" }, ...mark("done")],
				);
				expect(headers(accepted.lines("asking"))).toEqual([" ▸ waiting for 1 shell command"]);
				expect(headers(transcript(accepted.lines("done")))).toEqual([" ▸ ran 1 shell command"]);
				expect(factsOf(accepted.facts(), "codex-c1").map((message) => message.fact)).toEqual([{ kind: "start" }, { kind: "completion", exitCode: 0, status: "completed" }]);

				const refused = await codexRun(
					"approval-refused",
					{ turn: [{ kind: "command", id: "c1", command: "/bin/zsh -lc 'touch /etc/x'", approvals: [{ when: "before", command: "/bin/zsh -lc 'touch /etc/x'" }] }, { kind: "answer", id: "m1", text: "CODEX_DONE" }, { kind: "complete" }] },
					[{ wait: "Codex wants to run" }, { key: "down" }, { key: "down" }, { key: "enter" }, { wait: "1 shell command · not run" }, ...mark("refused")],
				);
				expect(headers(transcript(refused.lines("refused")))).toEqual([" ▸ 1 shell command · not run"]);
				// The refusal is told when it is made. Codex never completes the item, so when Pi exits the owner also says it can no longer vouch for it, which changes nothing for a command that was refused.
				const told = factsOf(refused.facts(), "codex-c1").map((message) => message.fact);
				expect(told[0]).toEqual({ kind: "not-run" });
				expect(told.slice(1).every((fact) => fact!.kind === "lost")).toBe(true);
				expect(told.some((fact) => fact!.kind === "start")).toBe(false);
			},
			PTY,
		);

		it(
			"a sub-agent's command is its own group beside the parent's: each counted once, the headers alike, and the agent's name on its expanded row",
			async () => {
				const run = await codexRun(
					"child-thread",
					{
						turn: [
							{ kind: "command", id: "c1", command: "/bin/zsh -lc 'pwd'", output: ["/work\n"] },
							{ kind: "subAgent", activity: "started", agentThreadId: "T2", agentPath: "/root/alpha" },
							{ kind: "childTurn", threadId: "T2", turnId: "T2-turn-1", events: [{ kind: "command", id: "c2", command: "/bin/zsh -lc 'echo child'", output: ["child\n"] }, { kind: "complete" }] },
							{ kind: "answer", id: "m1", text: "CODEX_DONE" },
							{ kind: "complete" },
						],
					},
					[{ wait: "CODEX_DONE" }, ...mark("done"), { key: "ctrl-o" }, { wait: "Tool output: expanded" }, ...mark("expanded")],
				);
				// Two agents, two groups: the parent's command and the child's are never counted together, and collapsed they read alike.
				expect(headers(transcript(run.lines("done")))).toEqual([" ▸ ran 1 shell command", " ▸ ran 1 shell command"]);
				const expanded = transcript(run.lines("expanded"));
				expect(headers(expanded)).toEqual([" ▾ ran 1 shell command", " ▾ ran 1 shell command"]);
				// Open, each row is Codex's own: the child's carries its agent's name before the command.
				expect(expanded.filter((line) => line.includes("$ "))).toEqual([" $ pwd", " alpha $ echo child"]);
				expect(expanded.indexOf(" alpha $ echo child")).toBeGreaterThan(expanded.lastIndexOf(" ▾ ran 1 shell command"));
				expect(expanded.indexOf(" $ pwd")).toBeLessThan(expanded.lastIndexOf(" ▾ ran 1 shell command"));
				const facts = run.facts();
				for (const id of ["codex-c1", "codex-c2"]) {
					expect(factsOf(facts, id).map((message) => message.fact)).toEqual([{ kind: "start" }, { kind: "completion", exitCode: 0, status: "completed" }]);
				}
				// Both report under the one owner and session; the child's thread is in its stored arguments, the root's are empty.
				expect(new Set(factsOf(facts).map((message) => `${message.sessionId} ${message.ownerGeneration}`)).size).toBe(1);
				const calls = run.session().filter((entry) => entry.type === "message" && entry.message?.role === "assistant").flatMap((entry) => entry.message.content.filter((part: any) => part.type === "toolCall"));
				expect(calls.map((call: any) => [call.arguments.itemId, call.arguments.threadId, call.arguments.agentPath])).toEqual([
					["c1", "", ""],
					["c2", "T2", "/root/alpha"],
				]);
			},
			PTY,
		);

		it(
			"a completion with no exit code, or one at odds with its status, is status unknown, whatever the row's own copy defaults to",
			async () => {
				const run = await codexRun(
					"missing-and-contradictory-fields",
					{
						turn: [
							{ kind: "command", id: "c1", command: "/bin/zsh -lc 'true'", output: ["one\n"], completion: { exitCode: null } },
							{ kind: "command", id: "c2", command: "/bin/zsh -lc 'true'", output: ["two\n"], omit: ["exitCode", "status"] },
							{ kind: "command", id: "c3", command: "/bin/zsh -lc 'true'", output: ["three\n"], completion: { exitCode: 0, status: "failed" } },
							{ kind: "answer", id: "m1", text: "CODEX_DONE" },
							{ kind: "complete" },
						],
					},
					[{ wait: "CODEX_DONE" }, ...mark("done")],
				);
				expect(headers(transcript(run.lines("done")))).toEqual([" ▸ 3 shell commands · 1 error (status unknown) · 2 unknown"]);
				const facts = run.facts();
				expect(factsOf(facts, "codex-c1")[1]!.fact).toEqual({ kind: "completion", exitCode: null, status: "completed" });
				expect(factsOf(facts, "codex-c2")[1]!.fact).toEqual({ kind: "completion" });
				expect(factsOf(facts, "codex-c3")[1]!.fact).toEqual({ kind: "completion", exitCode: 0, status: "failed" });
				// The native rows keep their own reading: the first two stored as successes with the defaulted fields.
				const results = toolResults(run.session());
				expect(results.map((message) => message.isError)).toEqual([false, false, true]);
				expect(results[1]!.details).toMatchObject({ exitCode: null, status: "completed" });
			},
			PTY,
		);
	});

	describe.each(HOSTS)("details mouse and width on $name", (host) => {
		const scenario = "S5-details-mouse-width";
		const HEREDOC = "cat <<'EOF'\nline \"one\" $HOME `x`\nEOF";
		const script = [bash("printf 'alpha\\nbeta\\n'"), bash(HEREDOC), bash(`echo before; echo '${WORDS}'; echo after`), text("GATE_DONE")];
		/** `Took` reads the clock; everything else in an expanded row must match cell for cell. */
		const settle = (lines: string[]) => lines.map((line) => line.replace(/Took \d+\.\ds/, "Took N.Ns"));
		const textOf = (cells: Cell[]) => cells.map((cell) => cell.ch).join("").trimEnd();

		it.each([
			[40, true],
			[80, true],
			[120, true],
			[40, false],
			[80, false],
			[120, false],
		])(
			"at %i columns (indent extension loaded: %s) an expanded group's members equal Pi's own expanded rows",
			async (cols, indent) => {
				const others = indent ? [OWNER, INDENT, BLENDED] : [OWNER, BLENDED];
				const name = `${cols}-${indent ? "indent" : "flush"}`;
				const grouped = await drive({
					scenario,
					host,
					name: `grouped-${name}`,
					extensions: [VIEW, ...others],
					script,
					cols,
					rows: 100,
					steps: [...START, ...GO, { wait: "GATE_DONE" }, ...mark("collapsed"), ...click("header", "ran 3 shell commands"), ...mark("expanded")],
				});
				const native = await drive({
					scenario,
					host,
					name: `native-${name}`,
					extensions: others,
					script,
					cols,
					rows: 100,
					steps: [...START, ...GO, { wait: "GATE_DONE" }, { key: "ctrl-o" }, { wait: "Tool output: expanded" }, ...mark("expanded")],
				});
				expect(headers(transcript(grouped.lines("collapsed")))).toEqual([" ▸ ran 3 shell commands"]);

				const ours = transcript(grouped.lines("expanded"));
				const theirs = transcript(native.lines("expanded"));
				const header = ours.indexOf(" ▾ ran 3 shell commands");
				expect(header).toBeGreaterThan(-1);
				expect(ours[header - 1]).toBe(""); // the group's own blank row above its header
				const members = settle(ours.slice(header + 1, ours.indexOf(" GATE_DONE")));
				const rowsOfPi = settle(theirs.slice(theirs.findIndex((line) => line.startsWith(" $ ")) - 2, theirs.indexOf(" GATE_DONE")));
				expect(members).toEqual(rowsOfPi);
				expect(members.filter((line) => line.startsWith(" $ ")).length).toBe(3);
				expect(members.filter((line) => line.startsWith(" └")).length).toBe(indent && cols >= 20 ? 3 : 0);
				// Not only the text: the same cells in the same colors, bold and fill.
				const cellsOf = (screen: Screen, first: string, count: number) => {
					const from = screen.lines.indexOf(first, screen.lines.lastIndexOf(" go"));
					return screen.cells.slice(from, from + count).map((cells) => cells.map((cell) => ({ ...cell, ch: /\d/.test(cell.ch) && textOf(cells).includes("Took") ? "N" : cell.ch })));
				};
				const first = members.find((line) => line.startsWith(" $ "))!;
				const span = members.length - members.indexOf(first);
				expect(cellsOf(grouped.screen("expanded"), first, span)).toEqual(cellsOf(native.screen("expanded"), first, span));
				// The stored arguments are the script's, byte for byte.
				const stored = (run: Result) => run.session().filter((entry) => entry.type === "message" && entry.message?.role === "assistant").flatMap((entry) => entry.message.content.filter((part: any) => part.type === "toolCall").map((part: any) => part.arguments.command));
				expect(stored(grouped)).toEqual(script.slice(0, 3).map((step: any) => step.args.command));
				expect(stored(grouped)).toEqual(stored(native));
			},
			PTY * 2,
		);

		it(
			"the header toggles once per click, a plain click on an expanded member collapses the whole group, and the keyboard reaches the same details",
			async () => {
				const run = await drive({
					scenario,
					host,
					name: "mouse-and-keyboard",
					extensions: PROFILE,
					script,
					cols: 100,
					rows: 60,
					steps: [
						...START,
						...GO,
						{ wait: "GATE_DONE" },
						...click("h1", "ran 3 shell commands"),
						...mark("opened"),
						// Plain click on a member: its output collapses the whole group immediately.
						...click("out", "alpha", { x: 8 }),
						...mark("member-collapsed"),
						// Reopening from header reveals all 3 commands again.
						...click("h2", "ran 3 shell commands"),
						...mark("reopened"),
						// Right click, wheel and a shift click on the header.
						...click("h3", "ran 3 shell commands", { button: 2 }),
						...click("h4", "ran 3 shell commands", { button: 4 }),
						{ bytes: "\x1b[<64;6;{h4}M" },
						{ bytes: "\x1b[<65;6;{h4}M" },
						...mark("other-buttons"),
						// A press that becomes a drag along the header, released elsewhere on it.
						{ locate: { name: "h5", text: "ran 3 shell commands" } },
						{ bytes: "\x1b[<0;6;{h5}M" },
						{ bytes: "\x1b[<32;12;{h5}M" },
						{ bytes: "\x1b[<0;12;{h5}m" },
						...mark("dragged"),
						// Two separate clicks, one after the other.
						...click("h6", "ran 3 shell commands"),
						...click("h7", "ran 3 shell commands"),
						...mark("two-clicks"),
						...click("h8", "ran 3 shell commands"),
						...mark("closed"),
						{ paste: "typed" },
						...mark("typed"),
						{ key: "ctrl-u" },
						{ key: "ctrl-o" },
						{ wait: "Tool output: expanded" },
						...mark("global-open"),
						...click("h9", "ran 3 shell commands"),
						...mark("local-close"),
						{ key: "ctrl-o" },
						{ wait: "Tool output: collapsed" },
						...mark("global-close"),
					],
				});
				const mark3 = (name: string) => headers(transcript(run.lines(name)));
				expect(mark3("opened")).toEqual([" ▾ ran 3 shell commands"]);
				expect(mark3("member-collapsed")).toEqual([" ▸ ran 3 shell commands"]);
				expect(transcript(run.lines("member-collapsed")).filter((line) => line.startsWith(" $ "))).toEqual([]);
				expect(mark3("reopened")).toEqual([" ▾ ran 3 shell commands"]);
				expect(transcript(run.lines("reopened")).filter((line) => line.startsWith(" $ "))).toHaveLength(3);
				expect(took(transcript(run.lines("reopened")))).toEqual(took(transcript(run.lines("opened"))));
				expect(mark3("other-buttons")).toEqual([" ▾ ran 3 shell commands"]);
				expect(mark3("dragged")).toEqual([" ▾ ran 3 shell commands"]);
				expect(mark3("two-clicks")).toEqual([" ▾ ran 3 shell commands"]); // closed by the first click, opened again by the second
				expect(mark3("closed")).toEqual([" ▸ ran 3 shell commands"]);
				// The clicks moved no focus: what is typed lands in the editor.
				expect(editorLine(run.lines("typed"))).toBe("typed");
				expect(mark3("global-open")).toEqual([" ▾ ran 3 shell commands"]);
				expect(mark3("local-close")).toEqual([" ▸ ran 3 shell commands"]);
				// The flag was already true when the group was closed by hand; the next global request still reaches it.
				expect(mark3("global-close")).toEqual([" ▸ ran 3 shell commands"]);
				expect(run.lines("global-close").join("\n")).not.toContain("unavailable");
			},
			PTY,
		);

		it.each([80, 120])(
			"C2: at %i columns, clicking an expanded command collapses the group, drag selection leaves it open, and header reopens it",
			async (cols) => {
				const run = await drive({
					scenario: "C2-member-cmd-click-cols",
					host,
					name: `member-cmd-click-${cols}`,
					extensions: PROFILE,
					script: [bash("echo alpha"), bash("echo beta"), text("GATE_DONE")],
					cols,
					rows: 40,
					steps: [
						...START,
						...GO,
						{ wait: "GATE_DONE" },
						...click("h1", "ran 2 shell commands"),
						...mark("opened"),
						// Drag over member text: selection highlight present and leaves group open
						{ locate: { name: "cmd", text: "echo beta" } },
						{ bytes: "\x1b[<0;6;{cmd}M" },
						{ bytes: "\x1b[<32;18;{cmd}M" },
						...mark("dragging"),
						{ bytes: "\x1b[<0;18;{cmd}m" },
						...mark("dragged"),
						// Plain click on member command: collapses whole group
						...click("cmd_click", "echo beta"),
						...mark("cmd_collapsed"),
						// Header click: reopens group
						...click("h_reopen", "ran 2 shell commands"),
						...mark("cmd_reopened"),
					],
				});
				const hdrs = (name: string) => headers(transcript(run.lines(name)));
				expect(hdrs("opened")).toEqual([" ▾ ran 2 shell commands"]);
				expect(hdrs("dragging")).toEqual([" ▾ ran 2 shell commands"]);
				expect(run.screen("dragging").cells.some((r) => r.some((c) => c.inverse)), "drag selection highlight active").toBe(true);
				expect(hdrs("dragged")).toEqual([" ▾ ran 2 shell commands"]);
				expect(hdrs("cmd_collapsed")).toEqual([" ▸ ran 2 shell commands"]);
				expect(transcript(run.lines("cmd_collapsed")).filter((line) => line.startsWith(" $ "))).toEqual([]);
				expect(hdrs("cmd_reopened")).toEqual([" ▾ ran 2 shell commands"]);
				expect(settle(transcript(run.lines("cmd_reopened")))).toEqual(settle(transcript(run.lines("opened"))));
			},
			PTY * 2,
		);

		it.each([80, 120])(
			"C2: at %i columns, clicking an expanded output collapses the group, and header reopens it",
			async (cols) => {
				const run = await drive({
					scenario: "C2-member-out-click-cols",
					host,
					name: `member-out-click-${cols}`,
					extensions: PROFILE,
					script: [
						bash("echo T1VUX1NFTlRJTkVMX0FMUEhBCg== | base64 -d"),
						bash("echo T1VUX1NFTlRJTkVMX0JFVEEK | base64 -d"),
						text("GATE_DONE"),
					],
					cols,
					rows: 40,
					steps: [
						...START,
						...GO,
						{ wait: "GATE_DONE" },
						...click("h1", "ran 2 shell commands"),
						...mark("opened"),
						{ locate: { name: "cmd", text: "T1VUX1NFTlRJTkVMX0FMUEhB" } },
						// Plain click on member output: collapses whole group
						...click("out_click", "OUT_SENTINEL_ALPHA"),
						...mark("out_collapsed"),
						// Header click: reopens group
						...click("h_reopen", "ran 2 shell commands"),
						...mark("out_reopened"),
					],
				});
				expect(run.marks["row:out_click"]).toBeGreaterThan(run.marks["row:cmd"]);
				const hdrs = (name: string) => headers(transcript(run.lines(name)));
				expect(hdrs("opened")).toEqual([" ▾ ran 2 shell commands"]);
				expect(hdrs("out_collapsed")).toEqual([" ▸ ran 2 shell commands"]);
				expect(transcript(run.lines("out_collapsed")).filter((line) => line.startsWith(" $ "))).toEqual([]);
				expect(hdrs("out_reopened")).toEqual([" ▾ ran 2 shell commands"]);
				expect(settle(transcript(run.lines("out_reopened")))).toEqual(settle(transcript(run.lines("opened"))));
			},
			PTY * 2,
		);

		it.each([80, 120])(
			"C2: at %i columns, native OSC 8 hyperlink click opens URL receipt and keeps group open, drag copy records exact text, and ungrouped reference matches",
			async (cols) => {
				const linkLog = join(ARTIFACTS, "C2-link-receipt", host.name, `link-${cols}.log`);
				const copyLog = join(ARTIFACTS, "C2-link-receipt", host.name, `copy-${cols}.log`);
				rmSync(linkLog, { force: true });
				rmSync(copyLog, { force: true });
				const run = await drive({
					scenario: "C2-link-receipt",
					host,
					name: `grouped-link-${cols}`,
					extensions: PROFILE,
					script: [bash("echo link-fixture"), bash("echo second-cmd"), text("GATE_DONE")],
					cols,
					rows: 40,
					env: {
						PI_HYPERLINKS: "1",
						RBF_PROBE_LINK_COMMAND: "link-fixture",
						RBF_PROBE_LINK_LOG: linkLog,
						RBF_PROBE_COPY_LOG: copyLog,
					},
					steps: [
						...START,
						...GO,
						{ wait: "GATE_DONE" },
						...click("header", "ran 2 shell commands"),
						...mark("opened"),
						// Click on the native hyperlink text row: opens URL via openUrl and keeps group open
						...click("link_click", "Full Output", { x: 10 }),
						...mark("link_clicked"),
						// Drag over second command output to copy exact text
						{ locate: { name: "out2", text: "second-cmd" } },
						{ bytes: "\x1b[<0;4;{out2}M" },
						{ bytes: "\x1b[<32;20;{out2}M" },
						...mark("drag_active"),
						{ bytes: "\x1b[<0;20;{out2}m" },
						...mark("drag_copied"),
						// Plain click on second command collapses group
						...click("cmd_collapse", "second-cmd"),
						...mark("collapsed"),
					],
				});
				expect(headers(transcript(run.lines("opened")))).toEqual([" ▾ ran 2 shell commands"]);
				expect(headers(transcript(run.lines("link_clicked"))), "link click keeps group expanded").toEqual([" ▾ ran 2 shell commands"]);
				expect(existsSync(linkLog), "link receipt log created").toBe(true);
				expect(readFileSync(linkLog, "utf8")).toBe("file:///tmp/rbf-test-full-output.log\n");
				expect(headers(transcript(run.lines("drag_copied"))), "drag copy keeps group expanded").toEqual([" ▾ ran 2 shell commands"]);
				expect(existsSync(copyLog), "copy receipt log created").toBe(true);
				expect(readFileSync(copyLog, "utf8")).toBe(" second-cmd\n");
				expect(headers(transcript(run.lines("collapsed"))), "plain member click collapses group").toEqual([" ▸ ran 2 shell commands"]);

				// Ungrouped reference matches receipt behavior
				const nativeLinkLog = join(ARTIFACTS, "C2-link-receipt", host.name, `native-link-${cols}.log`);
				const nativeCopyLog = join(ARTIFACTS, "C2-link-receipt", host.name, `native-copy-${cols}.log`);
				rmSync(nativeLinkLog, { force: true });
				rmSync(nativeCopyLog, { force: true });
				await drive({
					scenario: "C2-link-receipt",
					host,
					name: `native-link-${cols}`,
					extensions: [OWNER, INDENT, BLENDED],
					script: [bash("echo link-fixture"), bash("echo second-cmd"), text("GATE_DONE")],
					cols,
					rows: 40,
					env: {
						PI_HYPERLINKS: "1",
						RBF_PROBE_LINK_COMMAND: "link-fixture",
						RBF_PROBE_LINK_LOG: nativeLinkLog,
						RBF_PROBE_COPY_LOG: nativeCopyLog,
					},
					steps: [
						...START,
						...GO,
						{ wait: "GATE_DONE" },
						{ key: "ctrl-o" },
						{ wait: "Tool output: expanded" },
						...click("native_link_click", "Full Output", { x: 10 }),
						{ locate: { name: "out2", text: "second-cmd" } },
						{ bytes: "\x1b[<0;4;{out2}M" },
						{ bytes: "\x1b[<32;20;{out2}M" },
						{ bytes: "\x1b[<0;20;{out2}m" },
						...mark("native_done"),
					],
				});
				expect(existsSync(nativeLinkLog)).toBe(true);
				expect(readFileSync(nativeLinkLog, "utf8")).toBe("file:///tmp/rbf-test-full-output.log\n");
				expect(readFileSync(nativeLinkLog, "utf8")).toBe(readFileSync(linkLog, "utf8"));
				expect(existsSync(nativeCopyLog)).toBe(true);
				expect(readFileSync(nativeCopyLog, "utf8")).toBe(" second-cmd\n");
				expect(readFileSync(nativeCopyLog, "utf8")).toBe(readFileSync(copyLog, "utf8"));
			},
			PTY * 3,
		);

		it.each([80, 120])(
			"C3: at %i columns (indent loaded: false), clicking expanded member collapses group, wheel on member leaves it open, and prompt click does not collapse",
			async (cols) => {
				const run = await drive({
					scenario: "C3-no-indent-and-padding",
					host,
					name: `no-indent-cols-${cols}`,
					extensions: [VIEW, OWNER, BLENDED],
					script: [bash("echo alpha"), bash("echo beta"), text("GATE_DONE")],
					cols,
					rows: 40,
					steps: [
						...START,
						...GO,
						{ wait: "GATE_DONE" },
						...click("header", "ran 2 shell commands"),
						...mark("opened"),
						// Wheel on expanded member output leaves group open
						{ locate: { name: "out", text: "alpha" } },
						{ bytes: "\x1b[<64;8;{out}M" },
						{ bytes: "\x1b[<65;8;{out}M" },
						...mark("wheeled"),
						// Click on prompt line does not collapse group
						{ locate: { name: "prompt", text: "──" } },
						{ bytes: "\x1b[<0;10;{prompt+1}M" },
						{ bytes: "\x1b[<0;10;{prompt+1}m" },
						...mark("prompt_clicked"),
						// Plain click on expanded member collapses whole group
						...click("member_collapse", "alpha"),
						...mark("collapsed"),
						// Header reopens
						...click("reopen", "ran 2 shell commands"),
						...mark("reopened"),
					],
				});
				const cleanHdr = (name: string) => headers(transcript(run.lines(name))).map((l) => l.replace(/\s*┃.*$/, "").trimEnd());
				expect(cleanHdr("opened")).toEqual([" ▾ ran 2 shell commands"]);
				expect(cleanHdr("wheeled")).toEqual([" ▾ ran 2 shell commands"]);
				expect(cleanHdr("prompt_clicked")).toEqual([" ▾ ran 2 shell commands"]);
				expect(cleanHdr("collapsed")).toEqual([" ▸ ran 2 shell commands"]);
				expect(cleanHdr("reopened")).toEqual([" ▾ ran 2 shell commands"]);
			},
			PTY * 2,
		);

		it(
			"in the regular TUI, where the transcript takes no clicks, the group draws the same and the global shortcut opens and closes it",
			async () => {
				const run = await drive({
					scenario,
					host,
					name: "regular-mode",
					extensions: PROFILE,
					script,
					mode: "regular",
					cols: 100,
					rows: 110,
					steps: [...START, ...GO, { wait: "GATE_DONE" }, ...mark("collapsed"), { key: "ctrl-o" }, { wait: "Tool output: expanded" }, ...mark("opened"), { key: "ctrl-o" }, { wait: "Tool output: collapsed" }, ...mark("closed")],
				});
				expect(headers(run.lines("collapsed"))).toEqual([" ▸ ran 3 shell commands"]);
				const collapsed = transcript(run.lines("collapsed"));
				expect(collapsed.slice(collapsed.indexOf(" ▸ ran 3 shell commands") - 1, collapsed.indexOf(" GATE_DONE") + 1)).toEqual(["", " ▸ ran 3 shell commands", "", " GATE_DONE"]);
				const opened = transcript(run.lines("opened"));
				expect(headers(opened)).toEqual([" ▾ ran 3 shell commands"]);
				expect(opened.filter((line) => line.startsWith(" $ ")).map((line) => line.slice(0, 9))).toEqual([" $ printf", " $ cat <<", " $ echo b"]);
				expect(opened.filter((line) => line.startsWith(" └"))).toHaveLength(3);
				expect(headers(run.lines("closed"))).toEqual([" ▸ ran 3 shell commands"]);
				expect(transcript(run.lines("closed")).filter((line) => line.startsWith(" $ "))).toEqual([]);
				expect(run.lines("closed").join("\n")).not.toContain("unavailable");
			},
			PTY,
		);

		it(
			"a resize redraws the group at the new width, and a press held across it toggles nothing",
			async () => {
				const run = await drive({
					scenario,
					host,
					name: "resize",
					extensions: PROFILE,
					script: [bash("echo one"), bash("sleep 30"), text("GATE_DONE")],
					cols: 80,
					rows: 40,
					steps: [
						...START,
						...GO,
						{ wait: "2 shell commands · 1 running" },
						...mark("wide"),
						{ locate: { name: "header", text: "2 shell commands" } },
						{ bytes: "\x1b[<0;6;{header}M" },
						{ resize: { cols: 24, rows: 40 } },
						...mark("resized"),
						{ locate: { name: "narrow", text: "2 shell commands" } },
						{ bytes: "\x1b[<0;6;{narrow}m" },
						...mark("released"),
						{ key: "escape" },
						{ sleep: 0.5 },
					],
				});
				expect(headers(run.lines("wide"))).toEqual([" ▸ 2 shell commands · 1 running"]);
				const narrow = run.lines("resized");
				const at = narrow.indexOf(" ▸ 2 shell commands");
				expect(at).toBeGreaterThan(-1);
				expect(narrow[at + 1]).toBe("    1 running"); // the field wrapped to column 4, and the separator went with the break
				expect(run.lines("released").some((line) => line.startsWith(" ▾"))).toBe(false);
			},
			PTY,
		);
	});

	describe.each(HOSTS)("replay and reload on $name", (host) => {
		const scenario = "S6-replay-reload";

		it(
			"after two reloads the group is status unknown, no row is doubled, and one click still toggles once",
			async () => {
				const run = await drive({
					scenario,
					host,
					name: "reload-twice",
					extensions: PROFILE,
					script: [bash("echo one"), bash("echo two; exit 1"), bash("echo three"), text("GATE_DONE")],
					cols: 80,
					rows: 60,
					steps: [
						...START,
						...GO,
						{ wait: "GATE_DONE" },
						...mark("live"),
						{ sessionSnapshot: { name: "before" } },
						{ paste: "/reload" },
						{ key: "enter" },
						{ wait: "Reloaded" },
						{ sleep: 1 },
						{ paste: "/reload" },
						{ key: "enter" },
						{ wait: "Reloaded", count: 2 },
						{ sleep: 1 },
						...mark("reloaded"),
						...click("h1", "3 shell commands"),
						...mark("opened"),
						...click("h2", "3 shell commands"),
						...mark("closed"),
						{ sessionSnapshot: { name: "after" } },
					],
				});
				expect(headers(run.lines("live"))).toEqual([" ▸ ran 3 shell commands · 1 failed"]);
				// The owners' memory went with the old runtime: nothing proves how these calls ended, and the error row stays an error.
				expect(headers(run.lines("reloaded"))).toEqual([" ▸ 3 shell commands · 1 error (status unknown) · 2 unknown"]);
				const opened = run.lines("opened");
				expect(headers(opened)).toEqual([" ▾ 3 shell commands · 1 error (status unknown) · 2 unknown"]);
				expect(opened.filter((line) => line.startsWith(" $ echo"))).toEqual([" $ echo one", " $ echo two; exit 1", " $ echo three"]);
				// Every member is unknown, so no member repeats it; every member has a recorded result.
				expect(opened.join("\n")).not.toContain("Status unknown");
				expect(opened.join("\n")).not.toContain("No recorded result");
				expect(headers(run.lines("closed"))).toEqual([" ▸ 3 shell commands · 1 error (status unknown) · 2 unknown"]);
				// Showing it wrote nothing to the session.
				expect(run.marks.after).toEqual(run.marks.before);
				expect(run.lines("closed").join("\n")).not.toContain("unavailable");
			},
			PTY,
		);

		it(
			"C3: after reload, clicking an expanded member row collapses the restored group immediately, and header reopens it",
			async () => {
				const run = await drive({
					scenario,
					host,
					name: "reload-member-click",
					extensions: PROFILE,
					script: [bash("echo one"), bash("echo two"), text("GATE_DONE")],
					cols: 80,
					rows: 60,
					steps: [
						...START,
						...GO,
						{ wait: "GATE_DONE" },
						{ paste: "/reload" },
						{ key: "enter" },
						{ wait: "Reloaded" },
						{ sleep: 1 },
						...click("h_open", "2 shell commands"),
						...mark("reloaded_opened"),
						// Plain click on expanded member row collapses restored group
						...click("member_collapse", "echo two"),
						...mark("reloaded_collapsed"),
						// Reopen via header
						...click("h_reopen", "2 shell commands"),
						...mark("reloaded_reopened"),
					],
				});
				expect(headers(run.lines("reloaded_opened"))).toEqual([" ▾ 2 shell commands · status unknown"]);
				expect(headers(run.lines("reloaded_collapsed"))).toEqual([" ▸ 2 shell commands · status unknown"]);
				expect(headers(run.lines("reloaded_reopened"))).toEqual([" ▾ 2 shell commands · status unknown"]);
				const rep = run.lines("reloaded_reopened");
				expect(rep.filter((line) => line.startsWith(" $ "))).toEqual([" $ echo one", " $ echo two"]);
			},
			PTY,
		);

		it(
			"a session reopened in a new process restores its groups as status unknown, with a missing result named",
			async () => {
				const first = await drive({
					scenario,
					host,
					name: "resume-1-write",
					extensions: PROFILE,
					script: [bash("echo one"), bash("sleep 30"), text("GATE_DONE")],
					steps: [...START, ...GO, { wait: "2 shell commands · 1 running" }, ...mark("running")],
				});
				expect(headers(first.lines("running"))).toEqual([" ▸ 2 shell commands · 1 running"]);
				// Pi was killed mid-command: the session holds the second call and no result for it.
				const second = await drive({
					scenario,
					host,
					name: "resume-2-read",
					extensions: PROFILE,
					script: [text("GATE_DONE")],
					args: ["--continue"],
					sessions: join(first.dir, "sessions"),
					work: join(first.dir, "work"),
					cols: 80,
					rows: 60,
					steps: [...START, { sleep: 0.8 }, ...mark("restored"), ...click("header", "2 shell commands"), ...mark("opened")],
				});
				expect(headers(second.lines("restored"))).toEqual([" ▸ 2 shell commands · status unknown"]);
				const opened = second.lines("opened");
				expect(headers(opened)).toEqual([" ▾ 2 shell commands · status unknown"]);
				expect(opened.filter((line) => line.startsWith(" $ "))).toEqual([" $ echo one", " $ sleep 30"]);
				expect(opened.filter((line) => line.trim() === "No recorded result")).toHaveLength(1);
				expect(opened[opened.findIndex((line) => line.trim() === "No recorded result")]).toBe("    No recorded result");
				expect(opened.join("\n")).not.toContain("Status unknown");
				// No fact from the first process reached the second.
				expect(factsOf(second.facts())).toEqual([]);
			},
			PTY * 2,
		);

		it(
			"Pi's own tree navigation: the branch left behind is not drawn, what its owner proved is kept, and returning brings both groups back as they were",
			async () => {
				const prompt = (line: string): Step[] => [{ paste: line }, { key: "enter" }];
				const navigate = (keys: string[], count: number): Step[] => [
					{ key: "ctrl-u" },
					...prompt("/tree"),
					{ wait: "Session Tree", count },
					{ sleep: 0.5 },
					...keys.map((key) => ({ key })),
					{ key: "enter" },
					{ wait: "Summarize branch", count },
					{ key: "enter" },
					{ wait: "Navigated to selected point", count },
				];
				const run = await drive({
					scenario,
					host,
					name: "tree-navigation",
					extensions: PROFILE,
					script: [bash("echo one"), text("TURN_ONE"), bash("echo two; exit 2"), text("TURN_TWO")],
					rows: 60,
					steps: [
						...START,
						...prompt("first"),
						{ wait: "TURN_ONE" },
						{ sleep: 0.4 },
						...prompt("second"),
						{ wait: "TURN_TWO" },
						...mark("both"),
						// Up from the leaf, past the second turn's command and prompt, to the first turn's answer. The second turn is now a branch nobody is looking at.
						...navigate(["up", "up", "up"], 1),
						...mark("first-branch"),
						...click("header", "ran 1 shell command"),
						...mark("first-branch-open"),
						...navigate(["down", "down", "down"], 2),
						...mark("returned"),
					],
				});
				const groups = (name: string) => headers(run.lines(name));
				expect(groups("both")).toEqual([" ▸ ran 1 shell command", " ▸ ran 1 shell command · 1 failed"]);
				// Pi rebuilt the transcript from the selected branch. The owner is the same one, so the first group is still ran, not unknown.
				expect(groups("first-branch")).toEqual([" ▸ ran 1 shell command"]);
				expect(run.lines("first-branch").join("\n")).not.toContain("TURN_TWO");
				const open = run.lines("first-branch-open");
				expect(headers(open)).toEqual([" ▾ ran 1 shell command"]);
				expect(open.filter((line) => line.startsWith(" $ "))).toEqual([" $ echo one"]);
				// Back on the full branch: both groups, with what the owner proved for each, and collapsed again as a rebuilt transcript is.
				expect(groups("returned")).toEqual([" ▸ ran 1 shell command", " ▸ ran 1 shell command · 1 failed"]);
				expect(run.lines("returned").join("\n")).not.toContain("unavailable");
			},
			PTY,
		);

		it(
			"restored Codex commands: only a matched record with exit 0 and a completed status ran",
			async () => {
				const run = await drive({
					scenario,
					host,
					name: "codex-reload",
					extensions: [VIEW, CODEX, INDENT, BLENDED],
					model: "codex-harness/codex",
					codex: {
						turn: [
							{ kind: "command", id: "c1", command: "/bin/zsh -lc 'pwd'", output: ["/work\n"] },
							{ kind: "command", id: "c2", command: "/bin/zsh -lc 'exit 7'", exitCode: 7, output: ["boom\n"] },
							{ kind: "command", id: "c3", command: "/bin/zsh -lc 'true'", output: ["x\n"], completion: { exitCode: null } },
							{ kind: "answer", id: "m1", text: "CODEX_DONE" },
							{ kind: "complete" },
						],
					},
					steps: [...START, ...GO, { wait: "CODEX_DONE" }, ...mark("live"), { paste: "/reload" }, { key: "enter" }, { wait: "Reloaded" }, { sleep: 1 }, ...mark("reloaded")],
				});
				expect(headers(run.lines("live"))).toEqual([" ▸ 3 shell commands · 1 failed · 1 unknown"]);
				expect(headers(run.lines("reloaded"))).toEqual([" ▸ 3 shell commands · 1 error (status unknown) · 1 unknown"]);
			},
			PTY,
		);
	});

	describe.each(HOSTS)("neighbors fallback and scale on $name", (host) => {
		const scenario = "S7-neighbors-fallback";
		const script = [bash("echo one"), bash("echo two"), text("GATE_DONE")];
		const WARNING = " Warning: Tool call groups unavailable; showing native tool rows.";

		it(
			"with no owner loaded, or a sandbox launch, every row is Pi's own, silently",
			async () => {
				const native = await drive({ scenario, host, name: "no-view", extensions: [INDENT, BLENDED], script, steps: [...START, ...GO, { wait: "GATE_DONE" }, ...mark("done")] });
				const viewOnly = await drive({ scenario, host, name: "view-only", extensions: [VIEW, INDENT, BLENDED], script, steps: [...START, ...GO, { wait: "GATE_DONE" }, ...mark("done")] });
				expect(headers(viewOnly.lines("done"))).toEqual([]);
				expect(took(transcript(viewOnly.lines("done")))).toEqual(took(transcript(native.lines("done"))));
				expect(viewOnly.lines("done").join("\n")).not.toContain("Warning");
				expect(viewOnly.facts()).toEqual([{ kind: "snapshot-request", sessionId: expect.any(String) }]);

				// `--sandbox` is a flag only the sandbox extension registers; without it Pi refuses to start. With it, on this machine and
				// provider, the sandbox ends in its own blocked state. That state is the same with the view and the owner loaded as without,
				// and the launch guard came before any attachment: nothing was announced, reported or asked for.
				const sandboxed = (name: string, extensions: string[]) =>
					drive({ scenario, host, name, extensions: [...extensions, SANDBOX], script, args: ["--sandbox"], steps: [{ wait: "\\[Extensions\\]" }, { sleep: 3 }, ...GO, { wait: "GATE_DONE" }, ...mark("done")] });
				const alone = await sandboxed("sandbox-without-view", [INDENT, BLENDED]);
				const loaded = await sandboxed("sandbox-with-view-and-owner", PROFILE);
				expect(headers(loaded.lines("done"))).toEqual([]);
				expect(took(transcript(loaded.lines("done")))).toEqual(took(transcript(alone.lines("done"))));
				expect(loaded.lines("done").join("\n")).not.toContain("unavailable");
				expect(loaded.facts()).toEqual([]);
				console.log(`sandbox launch on ${host.name}: ${transcript(alone.lines("done")).filter((line) => line.trim()).join(" | ")} || ${alone.lines("done").filter((line) => line.includes("sandbox")).join(" | ")}`);
			},
			PTY * 4,
		);

		it(
			"the owner alone, with a display subscriber that throws on every message, runs and stores exactly what it does with none",
			async () => {
				const plain = await drive({ scenario, host, name: "owner-quiet", extensions: [OWNER, INDENT, BLENDED], script: [bash("echo one"), bash("echo two; exit 3"), text("GATE_DONE")], env: { RBF_SHELL_DISPLAY_LOG: "" }, steps: [...START, ...GO, { wait: "GATE_DONE" }, ...mark("done")] });
				const throwing = await drive({ scenario, host, name: "owner-throwing-subscriber", extensions: [OWNER, INDENT, BLENDED], script: [bash("echo one"), bash("echo two; exit 3"), text("GATE_DONE")], env: { RBF_SHELL_DISPLAY_THROW: "1" }, steps: [...START, ...GO, { wait: "GATE_DONE" }, ...mark("done")] });
				expect(factsOf(throwing.facts()).length).toBe(4); // the subscriber did hear, and throw on, every fact
				// What ran and what was stored are the same.
				const stored = (run: Result) => toolResults(run.session()).map((message) => [resultText(message), message.isError]);
				expect(stored(throwing)).toEqual(stored(plain));
				expect(stored(plain)).toEqual([
					["one\n", false],
					["two\n\n\nCommand exited with code 3", true],
				]);
				// The screen is not the same, and that is Pi's doing, not the owner's: Pi's event bus prints a handler's error to the terminal.
				expect(throwing.lines("done").some((line) => line.includes("Event handler error (rbf:shell-display:v1)"))).toBe(true);
				expect(plain.lines("done").join("\n")).not.toContain("Event handler error");
				expect(transcript(plain.lines("done")).filter((line) => line.startsWith(" $ "))).toEqual([" $ echo one", " $ echo two; exit 3"]);
			},
			PTY * 2,
		);

		it(
			"a fault in the view's own drawing shows Pi's rows and the one warning; Pi's own controls go on working",
			async () => {
				const expandNatively: Step[] = [{ key: "ctrl-o" }, { wait: "Tool output: expanded" }];
				const native = await drive({ scenario, host, name: "fault-reference", extensions: [OWNER, INDENT, BLENDED], script, rows: 60, steps: [...START, ...GO, { wait: "GATE_DONE" }, ...expandNatively, ...mark("expanded")] });
				const run = await drive({
					scenario,
					host,
					name: "render-fault",
					extensions: PROFILE,
					script,
					rows: 60,
					steps: [
						...START,
						...GO,
						{ wait: "GATE_DONE" },
						...mark("grouped"),
						{ paste: "/rbf-groups-fault render" },
						{ key: "enter" },
						{ sleep: 0.5 },
						// The fault is in the group's bookkeeping; the next frame that draws the transcript meets it.
						...expandNatively,
						{ wait: "Tool call groups unavailable" },
						...mark("fallen-back"),
						{ key: "ctrl-o" },
						{ wait: "Tool output: collapsed" },
						...mark("native-collapsed"),
					],
				});
				expect(headers(run.lines("grouped"))).toEqual([" ▸ ran 2 shell commands"]);
				const fallen = run.lines("fallen-back");
				expect(headers(fallen)).toEqual([]);
				expect(fallen.filter((line) => line.includes("Tool call groups unavailable"))).toEqual([WARNING]);
				// The rows the user sees are the ones Pi draws alone, expanded by Pi's own shortcut, in the same order.
				const rowsOf = (lines: string[]) => {
					const all = transcript(lines).map((line) => line.replace(/Took \d+\.\ds/, "Took N.Ns"));
					return all.slice(all.indexOf(" $ echo one"), all.indexOf(" GATE_DONE"));
				};
				expect(rowsOf(fallen)).toEqual(rowsOf(native.lines("expanded")));
				expect(rowsOf(fallen).filter((line) => line.startsWith(" └"))).toHaveLength(2);
				// Pi's own controls go on working, and the warning is not said again.
				const collapsed = run.lines("native-collapsed");
				expect(headers(collapsed)).toEqual([]);
				expect(collapsed.filter((line) => line.includes("Tool call groups unavailable"))).toEqual([WARNING]);
				expect(rowsOf(collapsed).length).toBeLessThan(rowsOf(fallen).length);
			},
			PTY * 2,
		);

		it(
			"a fault on a mouse event drops that event, changes no row, and the next click lands on Pi's own rows",
			async () => {
				const native = await drive({ scenario, host, name: "mouse-fault-reference", extensions: [OWNER, INDENT, BLENDED], script, rows: 60, steps: [...START, ...GO, { wait: "GATE_DONE" }, ...mark("done")] });
				const run = await drive({
					scenario,
					host,
					name: "mouse-fault",
					extensions: PROFILE,
					script,
					rows: 60,
					steps: [
						...START,
						...GO,
						{ wait: "GATE_DONE" },
						{ paste: "/rbf-groups-fault mouse" },
						{ key: "enter" },
						{ sleep: 0.5 },
						...mark("armed"),
						...click("header", "ran 2 shell commands"),
						{ wait: "Tool call groups unavailable" },
						...mark("dropped"),
						...click("row", "echo one"),
						...mark("native-click"),
					],
				});
				expect(headers(run.lines("armed"))).toEqual([" ▸ ran 2 shell commands"]);
				const dropped = run.lines("dropped");
				expect(headers(dropped)).toEqual([]);
				expect(dropped.filter((line) => line.includes("Tool call groups unavailable"))).toEqual([WARNING]);
				// Nothing opened: both rows are the collapsed rows Pi draws alone.
				const rowsOf = (lines: string[]) => {
					const all = took(transcript(lines));
					return all.slice(all.indexOf(" $ echo one"), all.indexOf(" GATE_DONE"));
				};
				expect(rowsOf(dropped)).toEqual(rowsOf(native.lines("done")));
				// A later click on a native row is Pi's own click-to-toggle: that row opens, and only that row.
				const clicked = rowsOf(run.lines("native-click"));
				expect(clicked.length).toBeGreaterThan(rowsOf(dropped).length);
				expect(clicked.slice(clicked.indexOf(" $ echo two"))).toEqual(rowsOf(dropped).slice(rowsOf(dropped).indexOf(" $ echo two")));
				expect(run.lines("native-click").filter((line) => line.includes("Tool call groups unavailable"))).toEqual([WARNING]);
			},
			PTY * 2,
		);

		it(
			"C3: projection fault from expanded member gesture drops failed input, detaches to native rows, and allows later native input",
			async () => {
				const faultScript = [
					bash("for i in $(seq 1 7); do echo item_$i; done"),
					bash("echo second"),
					text("GATE_DONE"),
				];
				const native = await drive({
					scenario,
					host,
					name: "member-fault-reference",
					extensions: [OWNER, INDENT, BLENDED],
					script: faultScript,
					rows: 60,
					steps: [
						...START,
						...GO,
						{ wait: "GATE_DONE" },
						...click("n1", "earlier lines"),
						...click("n2", "echo second"),
						...mark("native_expanded"),
					],
				});
				const run = await drive({
					scenario,
					host,
					name: "member-mouse-fault",
					extensions: PROFILE,
					script: faultScript,
					rows: 60,
					steps: [
						...START,
						...GO,
						{ wait: "GATE_DONE" },
						...click("header", "ran 2 shell commands"),
						...mark("expanded"),
						{ paste: "/rbf-groups-fault mouse" },
						{ key: "enter" },
						{ sleep: 0.5 },
						// Click on expanded member row with fault active
						...click("member_click", "item_1"),
						{ wait: "Tool call groups unavailable" },
						...mark("member_fault_dropped"),
						// Next click on native result row operates natively to collapse output
						...click("row_native", "item_7"),
						...mark("native_clicked"),
					],
				});
				expect(headers(run.lines("expanded"))).toEqual([" ▾ ran 2 shell commands"]);
				const dropped = run.lines("member_fault_dropped");
				expect(headers(dropped)).toEqual([]);
				expect(dropped.filter((line) => line.includes("Tool call groups unavailable"))).toEqual([WARNING]);
				const nativeClicked = run.lines("native_clicked");
				expect(nativeClicked.filter((line) => line.includes("Tool call groups unavailable"))).toEqual([WARNING]);

				const rowsOf = (lines: string[]) => {
					const all = took(transcript(lines));
					const start = all.findIndex((l) => l.includes("for i in $(seq 1 7)"));
					const end = all.indexOf(" GATE_DONE");
					return all.slice(start, end);
				};
				const droppedRows = rowsOf(dropped);
				const clickedRows = rowsOf(nativeClicked);
				const refRows = rowsOf(native.lines("native_expanded"));

				// Failed gesture preserves both native rows, matching ungrouped native reference
				expect(droppedRows).toEqual(refRows);

				// Subsequent native click on result row toggles disclosure of clicked row only
				expect(clickedRows).not.toEqual(droppedRows);
				const secondIdxDropped = droppedRows.findIndex((l) => l.includes("echo second"));
				const secondIdxClicked = clickedRows.findIndex((l) => l.includes("echo second"));
				expect(secondIdxDropped).toBeGreaterThan(-1);
				expect(secondIdxClicked).toBeGreaterThan(-1);

				const droppedOut = droppedRows.slice(1, secondIdxDropped);
				const clickedOut = clickedRows.slice(1, secondIdxClicked);
				expect(droppedOut.some((l) => l.includes("item_1"))).toBe(true);
				expect(clickedOut.some((l) => l.includes("item_1"))).toBe(false);
				expect(clickedOut.some((l) => l.includes("earlier lines"))).toBe(true);
				expect(droppedOut.some((l) => l.includes("earlier lines"))).toBe(false);

				// Keep exact second-row equality
				expect(clickedRows.slice(secondIdxClicked)).toEqual(droppedRows.slice(secondIdxDropped));
			},
			PTY * 2,
		);

		it(
			"a user ! command is not grouped, and Ctrl+B with nothing in the foreground is still the editor's",
			async () => {
				const run = await drive({
					scenario,
					host,
					name: "user-shell-and-ctrl-b",
					extensions: PROFILE,
					script,
					rows: 60,
					steps: [
						...START,
						...GO,
						{ wait: "GATE_DONE" },
						{ paste: "!echo mine" },
						{ key: "enter" },
						{ sleep: 1.5 },
						...mark("user-shell"),
						{ paste: "ab" },
						{ key: "ctrl-b" },
						{ paste: "X" },
						...mark("editor"),
					],
				});
				const lines = run.lines("user-shell");
				expect(headers(lines)).toEqual([" ▸ ran 2 shell commands"]);
				expect(lines.some((line) => line.includes("echo mine"))).toBe(true);
				expect(factsOf(run.facts())).toHaveLength(4); // two agent calls, two facts each; the ! command said nothing
				expect(editorLine(run.lines("editor"))).toBe("aXb");
			},
			PTY,
		);

		it(
			"colors: the count is drawn as Pi draws a tool title, the separator dim, a failure in the error color, unknown status muted",
			async () => {
				const run = await drive({
					scenario,
					host,
					name: "colors",
					extensions: PROFILE,
					script: [bash("echo one"), bash("exit 1"), text("GATE_DONE")],
					rows: 60,
					steps: [...START, ...GO, { wait: "GATE_DONE" }, ...click("header", "ran 2 shell commands"), ...mark("expanded"), { paste: "/reload" }, { key: "enter" }, { wait: "Reloaded" }, { sleep: 1 }, ...mark("reloaded")],
				});
				const screen = run.screen("expanded");
				const rowOf = (at: Screen, start: string) => at.cells[at.lines.findIndex((line) => line.startsWith(start))]!;
				const at = (cells: Cell[], needle: string, offset = 0) => style(cells[cells.map((c) => c.ch).join("").indexOf(needle) + offset]!);
				const header = rowOf(screen, " ▾ ran 2 shell commands · 1 failed");
				const title = rowOf(screen, " $ echo one");
				const branch = rowOf(screen, " └");
				// The mark and the count: exactly the style Pi gives a tool title, whatever this host's theme makes that.
				for (const needle of ["▾", "ran", "2 shell"]) expect(at(header, needle)).toBe(at(title, "$"));
				expect(at(title, "$")).toContain("bold");
				// The separator: dim, the style pi-45 gives its branch mark, and not the title's.
				expect(at(header, "·")).toBe(at(branch, "└"));
				expect(at(header, "·")).not.toBe(at(header, "ran"));
				// `1 failed`: one style across the digit and the word, and neither the title's nor the separator's.
				const failed = at(header, "1 failed");
				expect(at(header, "1 failed", 2)).toBe(failed);
				expect([at(header, "ran"), at(header, "·")]).not.toContain(failed);
				// After a reload: `1 error (status unknown)` takes that same error style through its brackets, and `1 unknown` is muted, a style of its own.
				const restored = rowOf(run.screen("reloaded"), " ▸ 2 shell commands · 1 error (status unknown) · 1 unknown");
				expect(at(restored, "1 error")).toBe(failed);
				expect(at(restored, "(status")).toBe(failed);
				expect(at(restored, "unknown)")).toBe(failed);
				const muted = at(restored, "1 unknown");
				expect([failed, at(restored, "2 shell")]).not.toContain(muted);
				expect(at(restored, "1 unknown", 2)).toBe(muted);
				console.log(`colors on ${host.name}: title ${at(title, "$")} | separator ${at(header, "·")} | error ${failed} | muted ${muted}`);
			},
			PTY,
		);
	});
});


describe.skipIf(!READY).each(HOSTS)("pi-52 real native host $name", (host) => {
	it("pi-52 details mouse and width: one generic mixed run retains all native members", async () => {
		const codex: FakeScenario = { turn: [
			{kind:"toolCall",id:"m1",server:"custom-server",tool:"invoke",appContext:{appName:"Acme Design",connectorId:"acme"},arguments:{query:"first"},result:{content:[{type:"text",text:"MCP-DRAG-CHECK"}]}},
			{kind:"command",id:"c1",command:"printf shell",output:["SHELL-CHECK"]},
			{kind:"toolCall",id:"m2",server:"notes",tool:"search",appContext:{appName:"Notes Lab",connectorId:"notes"},arguments:{query:"second"},result:{content:[{type:"text",text:"NOTES-CHECK"}]}},
			{kind:"toolCall",id:"m3",server:"custom-server",tool:"invoke",appContext:{appName:"Acme Design",connectorId:"acme"},arguments:{query:"third"},result:{content:[{type:"text",text:"LAST-CHECK"}]}},
			{kind:"answer",id:"done",text:"PI52_DONE"},{kind:"complete"},
		] };
		const run=await drive({scenario:"pi-52",host,name:"mixed-native",extensions:[VIEW,CODEX,INDENT,BLENDED,join(SUPPORT,"rbf-mcp-membership-probe.ts")],env:{RBF_PI52_BINDING_LOG:join(ARTIFACTS,"pi-52",host.name,"mixed-native","binding.jsonl")},model:"codex-harness/codex",codex,cols:120,rows:60,steps:[...START,...GO,{wait:"PI52_DONE"},...mark("collapsed"),...click("header","called Acme Design 2 times"),...mark("expanded"),...click("member","SHELL-CHECK"),...mark("member-closed"),...click("reopen","called Acme Design 2 times"),...mark("reopened")]});
		expect(headers(run.lines("collapsed"))).toEqual([" ▸ called Acme Design 2 times; ran 1 shell command; called Notes Lab 1 time"]);
		expect(headers(run.lines("expanded"))).toEqual([" ▾ called Acme Design 2 times; ran 1 shell command; called Notes Lab 1 time"]);
		expect(run.lines("expanded").join("\n")).toContain("MCP-DRAG-CHECK");
		expect(run.lines("expanded").join("\n")).toContain("LAST-CHECK");
		expect(headers(run.lines("member-closed"))).toEqual(headers(run.lines("collapsed")));
		expect(took(run.lines("reopened"))).toEqual(took(run.lines("expanded")));
		const memberships=run.facts().filter((fact)=>fact.kind==="membership");
		expect(new Set(memberships.map((fact)=>fact.toolCallId)).size).toBe(4);
		const observed=readFileSync(join(run.dir,"binding.jsonl"),"utf8").trim().split("\n").map((line)=>JSON.parse(line));
		const frames=observed.filter((record)=>record.kind==="frame");
		expect(frames.some((frame)=>frame.rows.some((row:any)=>!row.executionStarted&&row.projected))).toBe(true);
		for(const frame of frames)for(const row of frame.rows)if(row.projected){expect(row.bound).toBe(true);expect(row.threadId).toBe(row.expectedThreadId);expect(row.clientGeneration).toBe(row.expectedClientGeneration);}
		expect(observed.filter((record)=>record.kind==="validated-input").map((record)=>record.bound)).toEqual([false,false,false,false]);
		const calls=run.session().filter((entry)=>entry.type==="message"&&entry.message?.role==="assistant").flatMap((entry)=>entry.message.content.filter((part:any)=>part.type==="toolCall"));
		expect(calls.map((call:any)=>call.arguments.display?.appName)).toEqual(["Acme Design",undefined,"Notes Lab","Acme Design"]);
		expect(calls.every((call:any)=>call.arguments.clientGeneration===undefined&&call.arguments.threadId==="")).toBe(true);
	},180_000);
});


describe.skipIf(!READY || !HOSTS.some((host)=>host.name==="pi-1.3.0"))("pi-52 native built-in MCP",()=>{
	it("pi-52 MCP evidence: the real built-in adapter captures an arbitrary configured server without replacing execute",async()=>{
		const host=HOSTS.find((host)=>host.name==="pi-1.3.0")!;
		const run=await drive({scenario:"pi-52",host,name:"builtin-native",extensions:[...PROFILE,"builtin:mcp"],mcp:{mcpServers:{"Custom-Notes":{command:process.execPath,args:[join(SUPPORT,"rbf-mcp-local-server.ts")],exposure:"direct"}}},script:[{tool:"mcp__Custom_Notes__echo",args:{text:"first"}},bash("printf shell"),{tool:"mcp__Custom_Notes__echo",args:{text:"fail"}},text("NATIVE_MCP_DONE")],steps:[...START,{sleep:2},...GO,{wait:"NATIVE_MCP_DONE"},...mark("collapsed"),...click("header","called Custom-Notes 2 times"),...mark("expanded")]});
		expect(headers(run.lines("collapsed"))).toEqual([" ▸ called Custom-Notes 2 times · 1 failed; ran 1 shell command"]);
		expect(run.lines("expanded").join("\n")).toContain("LOCAL-MCP:first");
		expect(run.lines("expanded").join("\n")).toContain("LOCAL-MCP:fail");
		expect(toolResults(run.session()).filter((result)=>result.details?.server==="Custom-Notes")).toHaveLength(2);
	},180_000);
});


describe.skipIf(!READY).each(HOSTS)("pi-52 persistence and rendering $name",(host)=>{
	it("pi-52 replay and identity: recorded generic identities survive reload twice, reopen and tree navigation",async()=>{
		const codex:FakeScenario={retainHistory:true,turn:[
			{kind:"toolCall",id:"design1",server:"codex_apps",tool:"shared.tool",appContext:{appName:"Design",connectorId:"c1"},result:{content:[]}},
			{kind:"toolCall",id:"design2",server:"codex_apps",tool:"shared.tool",appContext:{appName:"Design",connectorId:"c2"},result:{content:[]}},
			{kind:"toolCall",id:"old",server:"custom.server",tool:"tool.with.dots",result:{content:[]}},
			{kind:"toolCall",id:"late",server:"late.server",tool:"invoke",completedAppContext:{appName:"Late Design"},result:{content:[]}},
			{kind:"answer",id:"answer",text:"IDENTITY_ONE"},{kind:"complete"}],laterTurns:[{kind:"toolCall",id:"second",server:"other",tool:"read",appContext:{appName:"Other Lab"},result:{content:[]}},{kind:"answer",id:"answer2",text:"IDENTITY_TWO"},{kind:"complete"}]};
		const reload=(count:number):Step[]=>[{paste:"/reload"},{key:"enter"},{wait:"Reloaded",count},{sleep:1},...mark(`reload${count}`)];
		const navigate=(keys:string[],count:number):Step[]=>[{key:"ctrl-u"},{paste:"/tree"},{key:"enter"},{wait:"Session Tree",count},{sleep:0.5},...keys.map((key)=>({key})),{key:"enter"},{wait:"Summarize branch",count},{key:"enter"},{wait:"Navigated to selected point",count}];
		const run=await drive({scenario:"pi-52",host,name:"identity-reload-tree",extensions:[VIEW,CODEX,INDENT,BLENDED,join(SUPPORT,"rbf-mcp-membership-probe.ts")],env:{RBF_PI52_BINDING_LOG:join(ARTIFACTS,"pi-52",host.name,"identity-reload-tree","binding.jsonl")},model:"codex-harness/codex",codex,cols:120,rows:70,steps:[...START,...GO,{wait:"IDENTITY_ONE"},...mark("live"),{paste:"second"},{key:"enter"},{wait:"IDENTITY_TWO"},...mark("both"),...navigate(["up","up","up"],1),...mark("first-branch"),...navigate(["down","down","down"],2),...mark("returned"),...reload(1),...reload(2)]});
		const check=(lines:string[])=>{const text=lines.join("\n");expect(text).toContain("Design [codex_apps/shared.tool] [connector: c1] 1 time");expect(text).toContain("Design [codex_apps/shared.tool] [connector: c2] 1 time");expect(text).toContain("called custom.server/tool.with.dots 1 time");expect(text).toContain("called late.server/invoke 1 time");expect(text).not.toContain("called Late Design");};
		for(const name of ["live","reload1","reload2","first-branch","returned"])check(run.lines(name));
		expect(run.lines("first-branch").join("\n")).not.toContain("IDENTITY_TWO");expect(run.lines("returned").join("\n")).toContain("IDENTITY_TWO");
		const reopen=await drive({scenario:"pi-52",host,name:"identity-reopen",extensions:[VIEW,CODEX,INDENT,BLENDED],model:"codex-harness/codex",codex,args:["--continue"],sessions:join(run.dir,"sessions"),work:join(run.dir,"work"),cols:120,rows:70,steps:[...START,...mark("reopened")]});check(reopen.lines("reopened"));
	},180_000);

	it("pi-52 details mouse and width: actual light and dark themes and native details at 40/80/120 columns",async()=>{
		const codex:FakeScenario={turn:[
			{kind:"toolCall",id:"a",server:"custom",tool:"invoke",appContext:{appName:"Acme Design"},arguments:{query:"example"},result:{content:[{type:"text",text:"MCP-DRAG-CHECK"}]}},
			{kind:"command",id:"s",command:"printf shell",output:["SHELL-CHECK"],completion:{exitCode:null}},
			{kind:"toolCall",id:"b",server:"notes",tool:"search",appContext:{appName:"Notes Lab"},arguments:{query:"example"},error:"NATIVE-FAILURE"},
			{kind:"answer",id:"done",text:"THEME_DONE"},{kind:"complete"}]};
		const themeSteps=(theme:string,count:number):Step[]=>[{paste:"/settings"},{key:"enter"},{sleep:0.3},{paste:"Theme"},{key:"enter"},{wait:"Select a theme",count},...mark(`${theme}-menu`),...(theme==="dark"?(host.name==="pi-1.3.0"?[{key:"down"},{key:"down"}]:[]):[{key:"down"}]),{key:"enter"},{sleep:0.3},{key:"escape"},{sleep:0.3}];
		const steps:Step[]=[...START,...GO,{wait:"THEME_DONE"}];
		for(const [i,theme] of ["dark","light"].entries()){
			steps.push(...themeSteps(theme,i+1));
			for(const cols of [40,80,120])steps.push({resize:{cols,rows:70}},...mark(`${theme}-${cols}-closed`),{key:"ctrl-o"},...mark(`${theme}-${cols}-open`),{key:"ctrl-o"},...mark(`${theme}-${cols}-closed-again`));
		}
		const candidate=await drive({scenario:"pi-52",host,name:"themes-widths",extensions:[VIEW,CODEX,INDENT,BLENDED],model:"codex-harness/codex",codex,cols:120,rows:70,steps});
		const nativeSteps=steps.filter((step)=>!(step.snapshot&&String(step.snapshot).includes("closed-again")));
		const native=await drive({scenario:"pi-52",host,name:"themes-native-control",extensions:[CODEX,INDENT,BLENDED],model:"codex-harness/codex",codex,cols:120,rows:70,steps:nativeSteps});
		const details=(lines:string[])=>{let at=transcript(lines);const first=at.findIndex((line)=>line.startsWith(" Acme Design.invoke"));at=at.slice(first).filter((line)=>line!=="    Status unknown");return took(at);};
		for(const theme of ["dark","light"])for(const cols of [40,80,120]){
			const name=`${theme}-${cols}`;const closed=candidate.lines(`${name}-closed`);expect(headers(closed)).toHaveLength(1);
			expect(closed.some((line)=>line.includes("failed"))).toBe(true);expect(closed.some((line)=>line.includes("unknown"))).toBe(true);
			expect(details(candidate.lines(`${name}-open`))).toEqual(details(native.lines(`${name}-open`)));
			expect(headers(candidate.lines(`${name}-closed-again`))).toEqual(headers(closed));
		}
		expect(JSON.parse(readFileSync(join(candidate.dir,"agent","settings.json"),"utf8")).theme).toBe("light");
	},180_000);
});


describe.skipIf(!READY).each(HOSTS)("pi-52 mixed native controls $name",(host)=>{
	const codex:FakeScenario={turn:[{kind:"toolCall",id:"a",server:"custom",tool:"invoke",appContext:{appName:"Notes Lab"},arguments:{query:"fixture"},result:{content:[{type:"text",text:"MCP-DRAG-CHECK"}]}},{kind:"command",id:"s",command:"printf link-fixture",output:["SHELL-CHECK"]},{kind:"answer",id:"done",text:"CONTROL_DONE"},{kind:"complete"}]};
	const extensions=[VIEW,CODEX,INDENT,BLENDED,join(import.meta.dirname,"rbf-edit-glance.ts")];
	it("pi-52 details mouse and width: mixed native link and exact MCP drag receipt preserve disclosure",async()=>{
		const base=join(ARTIFACTS,"pi-52",host.name,"mixed-link-drag");const linkLog=join(base,"link.log");const copyLog=join(base,"copy.log");
		const run=await drive({scenario:"pi-52",host,name:"mixed-link-drag",extensions,model:"codex-harness/codex",codex,cols:80,rows:60,env:{PI_HYPERLINKS:"1",RBF_PROBE_LINK_COMMAND:"link-fixture",RBF_PROBE_LINK_TARGET:"file:///private/tmp/pi52-link-test.txt",RBF_PROBE_LINK_LOG:linkLog,RBF_PROBE_COPY_LOG:copyLog},steps:[...START,...GO,{wait:"CONTROL_DONE"},...click("header","called Notes Lab 1 time"),...mark("opened"),...click("link","Full Output",{x:10}),...mark("link-clicked"),{locate:{name:"drag",text:"MCP-DRAG-CHECK"}},{bytes:"\x1b[<0;5;{drag}M"},{bytes:"\x1b[<32;24;{drag}M"},...mark("selecting"),{bytes:"\x1b[<0;24;{drag}m"},...mark("selected"),...click("member","SHELL-CHECK"),...mark("closed")]});
		expect(headers(run.lines("opened"))).toEqual([" ▾ called Notes Lab 1 time; ran 1 shell command"]);expect(headers(run.lines("link-clicked"))).toEqual(headers(run.lines("opened")));expect(headers(run.lines("selected"))).toEqual(headers(run.lines("opened")));
		expect(readFileSync(linkLog,"utf8")).toBe("file:///private/tmp/pi52-link-test.txt\n");expect(readFileSync(copyLog,"utf8")).toBe("MCP-DRAG-CHECK\n");expect(run.screen("selecting").cells.some((row)=>row.some((cell)=>cell.inverse))).toBe(true);expect(headers(run.lines("closed"))).toEqual([" ▸ called Notes Lab 1 time; ran 1 shell command"]);
	},180_000);
	it("pi-52 details mouse and width: regular TUI uses the original global disclosure shortcut",async()=>{
		const run=await drive({scenario:"pi-52",host,name:"mixed-regular",extensions,model:"codex-harness/codex",codex,cols:80,rows:60,mode:"regular",steps:[...START,...GO,{wait:"CONTROL_DONE"},...mark("closed"),{key:"ctrl-o"},...mark("open"),{key:"ctrl-o"},...mark("closed-again")]});
		expect(headers(run.lines("closed"))).toEqual([" ▸ called Notes Lab 1 time; ran 1 shell command"]);expect(headers(run.lines("open"))).toEqual([" ▾ called Notes Lab 1 time; ran 1 shell command"]);expect(run.lines("open").join("\n")).toContain("MCP-DRAG-CHECK");expect(headers(run.lines("closed-again"))).toEqual(headers(run.lines("closed")));
	},180_000);
});
