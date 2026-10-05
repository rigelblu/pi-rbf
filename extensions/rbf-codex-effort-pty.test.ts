// Real-Pi terminal (PTY) test suite for pi-10.7 thinking levels and effort dispatch.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const PI = process.env.RBF_EFFORT_PTY_PI_BIN ?? join(ROOT, "node_modules/.bin/pi");
const EXTENSION = join(import.meta.dirname, "test-support/rbf-codex-effort-extension.ts");
const TMP = process.env.RBF_EFFORT_PTY_TMPDIR ?? tmpdir();
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]|\r/g;
const ESCAPES = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

type Step = Record<string, unknown>;
const submit = (text: string): Step[] => [{ paste: text }, { key: "enter" }];

function screen(raw: Buffer): Buffer[] {
	const rows: string[] = [""];
	let row = 0;
	let restart = false;
	const begin = () => {
		if (restart) {
			rows[row] = "";
			restart = false;
		}
	};
	const tokens = raw.toString("latin1").match(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^[\]]|[^\x1b]+/g) ?? [];
	for (const t of tokens) {
		if (t.startsWith("\x1b[")) {
			const m = /^\x1b\[([0-9;?<>=]*)[ -/]*([@-~])$/.exec(t);
			if (!m) continue;
			const n = parseInt(m[1]!, 10);
			switch (m[2]) {
				case "A": row = Math.max(0, row - (n || 1)); restart = false; break;
				case "B": row += n || 1; while (rows.length <= row) rows.push(""); restart = false; break;
				case "G": if (!n || n === 1) restart = true; break;
				case "K": if (n === 2) { rows[row] = ""; restart = false; } break;
				case "J": if (!n) rows.length = row + 1; break;
				case "m": begin(); rows[row] += t; break;
				default: break;
			}
		} else if (t.startsWith("\x1b]")) {
			begin(); rows[row] += t;
		} else if (t.startsWith("\x1b")) {
			// ignore other escape sequences
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

const plainText = (b: Buffer): string => b.toString("utf8").replace(ESCAPES, "").trimEnd();

const PYTHON_DRIVER = `
import fcntl, glob, json, os, pty, re, select, signal, struct, sys, termios, time

KEYS = {
    "enter": b"\\r",
    "tab": b"\\t",
    "shift-tab": b"\\x1b[Z",
    "shift+tab": b"\\x1b[Z",
    "escape": b"\\x1b",
    "up": b"\\x1b[A",
    "down": b"\\x1b[B",
    "ctrl-c": b"\\x03",
    "ctrl-d": b"\\x04",
    "ctrl-o": b"\\x0f",
    "ctrl-u": b"\\x15",
    "ctrl-p": b"\\x10",
    "ctrl-l": b"\\x0c",
}

ANSI = re.compile(rb"\\x1b\\[[0-9;?]*[ -/]*[@-~]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|\\x1b[()][A-Za-z0-9]|\\x1b[=>]|\\r")

def strip(raw: bytes) -> bytes:
    return ANSI.sub(b"", raw)

def main():
    plan = json.load(sys.stdin)
    cols = int(plan.get("cols", 80))
    rows = int(plan.get("rows", 38))
    deadline = time.monotonic() + float(plan.get("timeout", 60))
    env = {**os.environ, **plan.get("env", {}), "TERM": "xterm-256color", "COLUMNS": str(cols), "LINES": str(rows)}

    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.chdir(plan["cwd"])
            os.execvpe(plan["argv"][0], plan["argv"], env)
        except BaseException as e:
            print(f"exec failed: {e}", file=sys.stderr)
        finally:
            os._exit(127)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    raw = bytearray()
    failure = None

    def pump(until: float):
        while True:
            left = until - time.monotonic()
            if left <= 0:
                return
            ready, _, _ = select.select([fd], [], [], min(left, 0.05))
            if not ready:
                continue
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            raw.extend(chunk)

    try:
        for step in plan["steps"]:
            if "wait" in step:
                pattern = re.compile(step["wait"].encode())
                count = int(step.get("count", 1))
                wait_deadline = min(deadline, time.monotonic() + float(step.get("timeout", plan.get("timeout", 60))))
                while len(list(pattern.finditer(strip(bytes(raw))))) < count:
                    if time.monotonic() > wait_deadline:
                        failure = f"timed out waiting for {step['wait']!r} (count={count})"
                        break
                    pump(time.monotonic() + 0.1)
                if failure:
                    break
            elif "reloadReady" in step:
                receipt = step["reloadReady"]
                target = int(receipt["loads"])
                last_ping = 0.0
                wait_deadline = min(deadline, time.monotonic() + float(step.get("timeout", plan.get("timeout", 60))))
                while True:
                    try:
                        with open(receipt["path"], encoding="utf-8") as f:
                            state = json.load(f)
                    except (OSError, ValueError):
                        state = {}
                    if state.get("readyLoad") == target and state.get("loads") == target:
                        pump(time.monotonic() + 0.3)
                        break
                    if time.monotonic() > wait_deadline:
                        failure = f"timed out waiting for reload readiness (loads={target})"
                        break
                    if state.get("loads") == target and time.monotonic() - last_ping >= 0.75:
                        command = f"{receipt.get('command', '/rbf-effort-reload-ready')} {target}".encode()
                        os.write(fd, b"\\x1b[200~" + command + b"\\x1b[201~\\r")
                        last_ping = time.monotonic()
                    pump(time.monotonic() + 0.1)
                if failure:
                    break
            elif "createFile" in step:
                cf = step["createFile"]
                with open(cf["path"], "w", encoding="utf-8") as f:
                    f.write(cf.get("content", ""))
                pump(time.monotonic() + 0.1)
            elif "snapshotLog" in step:
                dest = step["snapshotLog"]
                log_file = plan.get("env", {}).get("RBF_FAKE_LOG")
                content = ""
                if log_file and os.path.exists(log_file):
                    with open(log_file, "r", encoding="utf-8") as f:
                        content = f.read()
                with open(dest, "w", encoding="utf-8") as f:
                    f.write(content)
                pump(time.monotonic() + 0.1)
            elif "paste" in step:
                os.write(fd, b"\\x1b[200~" + step["paste"].encode() + b"\\x1b[201~")
                pump(time.monotonic() + 0.2)
            elif "write" in step:
                delay = float(step.get("delay", 0.05))
                for ch in step["write"]:
                    os.write(fd, ch.encode())
                    if delay > 0:
                        pump(time.monotonic() + delay)
                pump(time.monotonic() + 0.2)
            elif "key" in step:
                k = step["key"]
                os.write(fd, KEYS[k])
                pump(time.monotonic() + 0.2)
            elif "raw" in step:
                os.write(fd, step["raw"].encode())
                pump(time.monotonic() + 0.2)
            elif "sleep" in step:
                pump(time.monotonic() + float(step["sleep"]))
            elif "waitSessionTurns" in step:
                target = step["waitSessionTurns"]
                wait_deadline = min(deadline, time.monotonic() + float(step.get("timeout", plan.get("timeout", 60))))
                while True:
                    files = glob.glob(os.path.join(target["dir"], "*.jsonl"))
                    try:
                        with open(files[0], "r", encoding="utf-8") as f:
                            count = sum(1 for line in f if '"customType":"rbf-codex-turn/v1"' in line)
                    except (IndexError, OSError):
                        count = 0
                    if count >= int(target["count"]):
                        pump(time.monotonic() + 0.3)
                        break
                    if time.monotonic() > wait_deadline:
                        failure = f"timed out waiting for {target['count']} Codex turns, saw {count}"
                        break
                    pump(time.monotonic() + 0.1)
                if failure:
                    break
    finally:
        pump(time.monotonic() + 0.3)
        try:
            os.kill(pid, signal.SIGTERM)
            pump(time.monotonic() + 0.2)
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        os.close(fd)
        with open(plan["out"], "wb") as f:
            f.write(raw)

    if failure:
        print(failure, file=sys.stderr)
        return 2
    return 0

if __name__ == "__main__":
    sys.exit(main())
`;

function setup(cols: number, customEnv?: Record<string, string>) {
	const dir = mkdtempSync(join(TMP, `pi-effort-${cols}-`));
	const sessions = join(dir, "sessions");
	const agent = join(dir, "agent");
	mkdirSync(sessions, { recursive: true });
	mkdirSync(agent, { recursive: true });
	const log = join(dir, "requests.jsonl");
	const history = join(dir, "history.json");
	let sequence = 0;

	async function drive(steps: Step[], opts?: { model?: string; session?: string; timeout?: number }) {
		const rawPath = join(dir, `terminal-${++sequence}.bin`);
		const reloadReceipt = join(dir, `reload-${sequence}.json`);
		const plan = {
			argv: [
				PI,
				"--no-extensions",
				"--no-skills",
				"--no-themes",
				"--no-context-files",
				"--no-prompt-templates",
				"--session-dir",
				sessions,
				...(opts?.session ? ["--session", opts.session] : []),
				"-e",
				EXTENSION,
				"--model",
				opts?.model ?? "codex-harness/codex",
			],
			cwd: ROOT,
			env: {
				...customEnv,
				HOME: dir,
				PI_CODING_AGENT_DIR: agent,
				CODEX_HOME: join(dir, ".codex"),
				PI_SKIP_VERSION_CHECK: "1",
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
				RBF_FAKE_LOG: log,
				RBF_FAKE_HISTORY: history,
				RBF_FAKE_SCENARIO: JSON.stringify({ retainHistory: true }),
				RBF_EFFORT_RELOAD_RECEIPT: reloadReceipt,
			},
			cols,
			rows: 38,
			timeout: opts?.timeout ?? 60,
			out: rawPath,
			steps,
		};
		writeFileSync(join(dir, `plan-${sequence}.json`), JSON.stringify(plan));

		const run = await new Promise<{ code: number | null; stderr: string }>((resolvePromise, rejectPromise) => {
			const child = spawn("python3", ["-c", PYTHON_DRIVER], { stdio: ["pipe", "pipe", "pipe"] });
			let stderr = "";
			child.stdout.resume();
			child.stderr.setEncoding("utf8").on("data", (text) => { stderr += text; });
			const timer = setTimeout(() => child.kill("SIGTERM"), (plan.timeout + 15) * 1000);
			child.on("error", rejectPromise);
			child.on("close", (code) => {
				clearTimeout(timer);
				resolvePromise({ code, stderr });
			});
			child.stdin.end(JSON.stringify(plan));
		});

		expect(run, `${run.stderr} (kept ${dir})`).toMatchObject({ code: 0 });
		const rawBuffer = readFileSync(rawPath);
		const rawText = rawBuffer.toString("utf8").replace(ANSI, "");
		const lines = screen(rawBuffer).map(plainText);
		return { rawBuffer, rawText, lines };
	}

	const calls = (customLogPath?: string): any[] => {
		const targetLog = customLogPath ?? log;
		if (!existsSync(targetLog)) return [];
		return readFileSync(targetLog, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter(Boolean);
	};

	const cleanup = () => rmSync(dir, { recursive: true, force: true });
	return { dir, sessions, agent, log, history, drive, calls, cleanup };
}

function extractDisplayedLevel(rawOrLines: string | string[], modelName = "codex"): string | undefined {
	const text = Array.isArray(rawOrLines) ? rawOrLines.join("\n") : rawOrLines;
	const regex = new RegExp(`(?:${modelName})\\s+[•·]\\s*(?:thinking\\s+)?(off|minimal|low|medium|high|xhigh|max)\\b`, "gi");
	const matches = [...text.matchAll(regex)];
	if (matches.length === 0) return undefined;
	return matches[matches.length - 1][1].toLowerCase();
}

beforeAll(() => {
	const version = execFileSync(PI, ["--version"], { encoding: "utf8" }).trim();
	console.log(`pi-10.7 effort PTY suite host Pi=${PI} version=${version}`);
});

describe("pi-10.7 real Pi effort and thinking levels", () => {
	it("(a) Saved default thinking level off in temp settings displays low and sends effort low", async () => {
		const p = setup(80);
		try {
			writeFileSync(join(p.agent, "settings.json"), JSON.stringify({ defaultThinkingLevel: "off" }));
			const { rawText } = await p.drive([
				{ wait: "codex" },
				{ sleep: 0.5 },
				...submit("prompt case a"),
				{ wait: "FAKE_OK" },
			]);

			const level = extractDisplayedLevel(rawText);
			expect(level).toBe("low");

			const starts = p.calls().filter((c) => c.method === "turn/start");
			expect(starts).toHaveLength(1);
			expect(starts[0].params).toMatchObject({ effort: "low" });
		} finally {
			p.cleanup();
		}
	}, 100_000);

	it("(b) Cycle the level with Pi's cycle key (shift+tab) through a full wrap: never shows off/minimal, effort equals displayed", async () => {
		const p = setup(80);
		let passed = false;
		try {
			writeFileSync(join(p.agent, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }));
			const expectedLevels = ["low", "medium", "high", "xhigh", "max", "low"];
			const steps: Step[] = [{ wait: "codex" }, { sleep: 0.5 }];

			for (let i = 0; i < expectedLevels.length; i++) {
				if (i > 0) {
					steps.push({ key: "shift-tab" });
					steps.push({ sleep: 0.5 });
				}
				steps.push(...submit(`prompt stop ${i}`));
				steps.push({ wait: "FAKE_OK", count: i + 1 });
				steps.push({ waitSessionTurns: { dir: p.sessions, count: i + 1 } });
				steps.push({ sleep: 0.5 });
			}

			const { rawText } = await p.drive(steps);

			expect(rawText).not.toMatch(/(?:codex)\s+[•·]\s*(?:thinking\s+)?(?:off|minimal)\b/i);

			const starts = p.calls().filter((c) => c.method === "turn/start");
			expect(starts).toHaveLength(expectedLevels.length);
			for (let i = 0; i < expectedLevels.length; i++) {
				expect(starts[i].params).toMatchObject({ effort: expectedLevels[i] });
			}
			passed = true;
		} finally {
			if (passed) p.cleanup();
			else console.error(`KEPT_B_DIR: ${p.dir}`);
		}
	}, 150_000);

	it("(c) Type /thinking and read the completion list: no off, no minimal", async () => {
		const p = setup(80);
		try {
			const { rawText, lines } = await p.drive([
				{ wait: "codex" },
				{ sleep: 0.5 },
				{ write: "/thinking ", delay: 0.05 },
				{ wait: "max" },
				{ sleep: 0.5 },
				{ key: "escape" },
			]);

			expect(rawText).toContain("low");
			expect(rawText).toContain("max");

			const completionItems = lines.filter((l) => /^\s*(?:→|\s{2,})\s*(?:off|minimal)\b/i.test(l));
			expect(completionItems).toHaveLength(0);
		} finally {
			p.cleanup();
		}
	}, 100_000);

	it("(d) Start on non-Codex model at off, switch to Codex displays low, switch back off is selectable", async () => {
		const p = setup(80);
		try {
			const { rawText } = await p.drive(
				[
					{ wait: "dummy-model" },
					{ sleep: 0.5 },
					...submit("/thinking off"),
					{ sleep: 0.5 },
					...submit("/model codex-harness/codex"),
					{ wait: "codex" },
					{ sleep: 0.8 },
					...submit("/model dummy-provider/dummy-model"),
					{ wait: "dummy-model" },
					{ sleep: 0.8 },
					...submit("/thinking off"),
					{ sleep: 0.5 },
				],
				{ model: "dummy-provider/dummy-model" },
			);

			const codexLevel = extractDisplayedLevel(rawText, "codex");
			expect(codexLevel).toBe("low");

			const dummyLevel = extractDisplayedLevel(rawText, "dummy-model");
			expect(dummyLevel).toBe("off");
		} finally {
			p.cleanup();
		}
	}, 100_000);

	it("(e) Session saved with level off on a Codex model: reopen displays low and sends low", async () => {
		const p = setup(80);
		try {
			const sessionFile = join(p.sessions, "session-e.jsonl");
			const timestamp = "2026-10-05T12:00:00.000Z";
			const entries = [
				{ type: "session", version: 3, id: "session-e", timestamp, cwd: ROOT },
				{ type: "model_change", id: "00000001", parentId: null, timestamp, provider: "codex-harness", modelId: "codex" },
				{ type: "thinking_level_change", id: "00000002", parentId: "00000001", timestamp, thinkingLevel: "off" },
				{ type: "message", id: "00000003", parentId: "00000002", timestamp, message: { role: "user", content: [{ type: "text", text: "prior user input" }] } },
			];
			writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

			const { rawText } = await p.drive(
				[
					{ wait: "codex" },
					{ sleep: 0.5 },
					...submit("prompt case e"),
					{ wait: "FAKE_OK" },
				],
				{ session: sessionFile },
			);

			const level = extractDisplayedLevel(rawText);
			expect(level).toBe("low");

			const starts = p.calls().filter((c) => c.method === "turn/start");
			expect(starts).toHaveLength(1);
			expect(starts[0].params).toMatchObject({ effort: "low" });
		} finally {
			p.cleanup();
		}
	}, 100_000);

	it("(f) Model cache: pre-write provider stored model cache without off key, select it, never shows off/minimal, saved off displays low", async () => {
		const p = setup(80);
		try {
			const modelsStoreFile = join(p.agent, "models-store.json");
			const cached = {
				"codex-harness": {
					models: [
						{
							id: "gpt-stored-no-off",
							name: "GPT Stored No Off (Codex agent)",
							api: "rbf-codex-app-server",
							provider: "codex-harness",
							baseUrl: "stdio://codex",
							reasoning: true,
							thinkingLevelMap: {
								minimal: null,
								low: "low",
								medium: "medium",
								high: "high",
								xhigh: null,
								max: null,
							},
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1_000_000_000,
							maxTokens: 1_000_000_000,
						},
					],
					checkedAt: Date.now(),
				},
			};
			writeFileSync(modelsStoreFile, JSON.stringify(cached, null, 2));
			writeFileSync(join(p.agent, "settings.json"), JSON.stringify({ defaultThinkingLevel: "off" }));

			const { rawText, lines } = await p.drive(
				[
					{ wait: "gpt-stored-no-off" },
					{ sleep: 0.5 },
					{ key: "shift-tab" },
					{ sleep: 0.3 },
					{ key: "shift-tab" },
					{ sleep: 0.3 },
					{ key: "shift-tab" },
					{ sleep: 0.3 },
					...submit("prompt case f"),
					{ wait: "FAKE_OK" },
					{ waitSessionTurns: { dir: p.sessions, count: 1 } },
					{ sleep: 0.5 },
					{ write: "/thinking ", delay: 0.05 },
					{ wait: "high" },
					{ sleep: 0.5 },
					{ key: "escape" },
				],
				{ model: "codex-harness/gpt-stored-no-off" },
			);

			expect(rawText).not.toMatch(/(?:gpt-stored-no-off)\s+[•·]\s*(?:thinking\s+)?(?:off|minimal)\b/i);

			const level = extractDisplayedLevel(rawText, "gpt-stored-no-off");
			expect(level).toBe("low");

			const starts = p.calls().filter((c) => c.method === "turn/start");
			expect(starts).toHaveLength(1);
			expect(starts[0].params).toMatchObject({ effort: level });

			const completionItems = lines.filter((l) => /^\s*(?:→|\s{2,})\s*(?:off|minimal)\b/i.test(l));
			expect(completionItems).toHaveLength(0);
		} finally {
			p.cleanup();
		}
	}, 100_000);

	it("(g) /thinking picker and settings list choices contain no off and no minimal", async () => {
		const p = setup(80);
		try {
			const { rawText } = await p.drive([
				{ wait: "codex" },
				{ sleep: 0.5 },
				...submit("/thinking"),
				{ wait: "Thinking Level" },
				{ sleep: 0.5 },
				{ key: "escape" },
				{ sleep: 0.5 },
				...submit("/settings"),
				{ wait: "Auto-compact" },
				{ sleep: 0.5 },
				{ write: "model", delay: 0.05 },
				{ sleep: 0.5 },
				{ key: "enter" },
				{ sleep: 0.5 },
				{ key: "enter" },
				{ wait: "Thinking Level for codex" },
				{ sleep: 0.5 },
				{ key: "escape" },
			]);

			const lines = rawText.split("\n");
			const thinkingRows = lines.filter((l) => /^\s*(?:→|\s{2,})\s*(?:✓\s*)?(?:off|minimal)\b/i.test(l));
			expect(thinkingRows).toHaveLength(0);
		} finally {
			p.cleanup();
		}
	}, 100_000);

	it("(h) /thinking off and /thinking minimal show Unknown thinking level and displayed level unchanged", async () => {
		const p = setup(80);
		try {
			writeFileSync(join(p.agent, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }));
			const { rawText } = await p.drive([
				{ wait: "codex" },
				{ sleep: 0.5 },
				...submit("/thinking off"),
				{ wait: 'Unknown thinking level "off"' },
				{ sleep: 0.5 },
				...submit("/thinking minimal"),
				{ wait: 'Unknown thinking level "minimal"' },
				{ sleep: 0.5 },
			]);

			expect(rawText).toContain('Unknown thinking level "off"');
			expect(rawText).toContain('Unknown thinking level "minimal"');

			expect(rawText).not.toMatch(/(?:codex)\s+[•·]\s*(?:thinking\s+)?(?:off|minimal)\b/i);

			const level = extractDisplayedLevel(rawText);
			expect(level).toBe("low");
		} finally {
			p.cleanup();
		}
	}, 100_000);

	describe.each([80, 120])("(i) Reload trigger at %i columns", (cols) => {
		it(`refuses off post-reload and accepts effort low after shift+tab at ${cols} columns`, async () => {
			const markerFile = join(TMP, `pi-effort-reload-marker-${cols}-${Date.now()}.txt`);
			if (existsSync(markerFile)) rmSync(markerFile);

			const p = setup(cols, { RBF_EFFORT_PRE_FIX_MARKER: markerFile });
			try {
				const promptText = "Hello effort check post-reload";
				const expectedSentence = "This thinking level is not available for this Codex model. Your message was not sent. Choose a level with /thinking, then send again.";

				const reloadLog = join(p.dir, `reload-calls-${cols}.jsonl`);
				const refusalLog = join(p.dir, `refusal-calls-${cols}.jsonl`);

				const { rawText, lines } = await p.drive([
					{ wait: "codex" },
					{ sleep: 0.8 },
					...submit("/thinking off"),
					{ sleep: 0.8 },
					{ createFile: { path: markerFile, content: "active\n" } },
					...submit("/reload"),
					{ wait: "Reloaded" },
					{ sleep: 0.8 },
					{ snapshotLog: reloadLog },
					...submit(promptText),
					{ wait: "This thinking level is not available" },
					{ sleep: 0.8 },
					{ snapshotLog: refusalLog },
					{ key: "shift-tab" },
					{ sleep: 0.8 },
					...submit(promptText),
					{ wait: "FAKE_OK" },
					{ waitSessionTurns: { dir: p.sessions, count: 1 } },
					{ sleep: 0.5 },
				]);

				// Still displays off directly after reload before prompt
				expect(rawText).toMatch(/(?:codex)\s+[•·]\s*(?:thinking\s+)?off\b/i);

				// Reconstructed screen lines must all fit terminal width
				for (const line of lines) {
					expect(line.length, `line exceeds ${cols} cols: ${JSON.stringify(line)}`).toBeLessThanOrEqual(cols);
				}

				// The refusal message must match the expected sentence after collapsing whitespace
				const collapsedScreen = lines.join(" ").replace(/\s+/g, " ");
				expect(collapsedScreen).toContain(expectedSentence);

				// Log checks since reload: record log length right after reload completes and slice from there
				const reloadCallCount = p.calls(reloadLog).length;

				// Immediately after refusal sentence appears (before shift+tab), log since reload contains ZERO requests starting with thread/ or turn/
				const callsSinceReloadBeforeShiftTab = p.calls(refusalLog).slice(reloadCallCount);
				const forbiddenBeforeShiftTab = callsSinceReloadBeforeShiftTab.filter((c) => c.method?.startsWith("thread/") || c.method?.startsWith("turn/"));
				expect(forbiddenBeforeShiftTab).toHaveLength(0);

				// After shift+tab and the resend, the thread/* and turn/* methods recorded since reload are exactly ["thread/start", "turn/start"] in that order
				const callsSinceReloadFinal = p.calls().slice(reloadCallCount);
				const threadAndTurnMethods = callsSinceReloadFinal
					.filter((c) => c.method?.startsWith("thread/") || c.method?.startsWith("turn/"))
					.map((c) => c.method);
				expect(threadAndTurnMethods).toEqual(["thread/start", "turn/start"]);

				// Exactly one turn/start in the entire run, carrying effort: "low"
				const turnStarts = p.calls().filter((c) => c.method === "turn/start");
				expect(turnStarts).toHaveLength(1);
				expect(turnStarts[0].params).toMatchObject({ effort: "low" });
			} finally {
				if (existsSync(markerFile)) rmSync(markerFile, { force: true });
				p.cleanup();
			}
		}, 120_000);
	});
});
