import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { replayScreen } from "./test-support/rbf-pty-screen.ts";

const ROOT = resolve(import.meta.dirname, "..");
const CANDIDATE_SRC = join(ROOT, "extensions/rbf-effort.ts");

export interface HostInfo {
	root: string;
	realPath: string;
	version: string;
}

/**
 * Dynamically resolves host roots:
 * - Local repo host (@earendil-works/pi-coding-agent)
 * - Optional explicit PI_DAILY_ROOT (required to include daily 1.0.4 host root)
 * - Optional explicit PI_ROOT / PI_CODING_AGENT_ROOT
 * Deduplicated via realpath to avoid repeating the same local root through private/symlinked paths.
 * No ephemeral machine-private file dependencies.
 */
function resolveHostRoots(): HostInfo[] {
	const candidatePaths: string[] = [];
	if (process.env.PI_ROOT && existsSync(join(process.env.PI_ROOT, "dist/bundle/cli.js"))) {
		candidatePaths.push(process.env.PI_ROOT);
	}
	if (process.env.PI_CODING_AGENT_ROOT && existsSync(join(process.env.PI_CODING_AGENT_ROOT, "dist/bundle/cli.js"))) {
		candidatePaths.push(process.env.PI_CODING_AGENT_ROOT);
	}
	const localAgent = join(ROOT, "node_modules/@earendil-works/pi-coding-agent");
	if (existsSync(join(localAgent, "dist/bundle/cli.js"))) {
		candidatePaths.push(localAgent);
	}
	if (process.env.PI_DAILY_ROOT && existsSync(join(process.env.PI_DAILY_ROOT, "dist/bundle/cli.js"))) {
		candidatePaths.push(process.env.PI_DAILY_ROOT);
	}

	const seenReal = new Set<string>();
	const hosts: HostInfo[] = [];

	for (const candidate of candidatePaths) {
		try {
			const real = realpathSync(candidate);
			if (seenReal.has(real)) {
				continue;
			}
			seenReal.add(real);

			let version = "unknown";
			const pkgPath = join(real, "package.json");
			if (existsSync(pkgPath)) {
				try {
					const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
					if (pkg.version) {
						version = pkg.version;
					}
				} catch {
					// ignore json parse error
				}
			}

			hosts.push({
				root: candidate,
				realPath: real,
				version,
			});
		} catch {
			// ignore inaccessible candidate
		}
	}

	return hosts;
}

interface Step {
	submit?: string;
	wait?: string;
	key?: string;
	snapshot?: string;
	sleep?: number;
}

interface RunOptions {
	host: string;
	width?: number;
	height?: number;
	steps: Step[];
	extensions?: string[];
	reasoning?: boolean;
	timeoutSeconds?: number;
}

interface RunResult {
	events: Array<Record<string, any>>;
	settings: Record<string, any>;
	raw: Buffer;
	plain: string;
	snapshots: Record<string, Buffer>;
}

function assertPositiveScenarioEvents(res: RunResult): void {
	const providerTurns = res.events.filter((e) => e.event === "provider");
	const agentStarts = res.events.filter((e) => e.event === "agent_start");
	const unexpectedInputs = res.events.filter((e) => e.event === "input");
	expect(providerTurns).toHaveLength(0);
	expect(agentStarts).toHaveLength(0);
	expect(unexpectedInputs).toHaveLength(0);
}

const PYTHON_PTY_DRIVER = `
import os, sys, json, pathlib, pty, fcntl, termios, struct, select, time, signal, re

ANSI = re.compile(rb'\\x1b\\[[0-9;?]*[ -/]*[@-~]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|\\x1b[()][A-Za-z0-9]|\\x1b[=>]|\\r')

def sig_handler(signum, frame):
    sys.exit(128 + signum)

def main():
    signal.signal(signal.SIGTERM, sig_handler)
    signal.signal(signal.SIGINT, sig_handler)

    plan = json.load(sys.stdin)
    d = pathlib.Path(plan['dir'])
    a = d / 'agent'
    a.mkdir(parents=True, exist_ok=True)

    timeout_seconds = float(plan.get('timeoutSeconds', 20.0))
    global_deadline = time.monotonic() + timeout_seconds

    model = {
        'providers': {
            'pi51-offline': {
                'baseUrl': 'http://127.0.0.1:1/v1',
                'api': 'openai-completions',
                'apiKey': 'pi51-dummy',
                'models': [{
                    'id': 'fixture',
                    'name': 'PI51 offline fixture',
                    'reasoning': plan.get('reasoning', True),
                    'input': ['text'],
                    'contextWindow': 32768,
                    'maxTokens': 4096,
                    'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}
                }]
            }
        }
    }
    (a / 'models.json').write_text(json.dumps(model))
    (a / 'settings.json').write_text(json.dumps({
        'defaultThinkingLevel': 'medium',
        'quietStartup': True,
        'editorMode': 'vim' if any('vim' in e for e in plan.get('extensions', [])) else 'standard'
    }))

    log = d / 'events.jsonl'
    log.write_text('')
    env = {
        **os.environ,
        'PI_CODING_AGENT_DIR': str(a),
        'PI_AGENT_DIR': str(a),
        'PI51_LOG': str(log),
        'TERM': 'xterm-256color',
        'PI_SKIP_VERSION_CHECK': '1'
    }

    argv = [
        'node',
        str(pathlib.Path(plan['host']) / 'dist/bundle/cli.js'),
        '--no-extensions',
        '--no-skills',
        '--no-themes',
        '--no-context-files',
        '--no-prompt-templates',
        '--provider', 'pi51-offline',
        '--model', 'fixture',
        '--session', str(d / 'session.jsonl')
    ]
    for ext in plan.get('extensions', []):
        argv += ['-e', ext]

    width = int(plan.get('width', 80))
    height = int(plan.get('height', 38))
    pid = None
    fd = None

    raw = bytearray()
    snapshots = {}

    def pump(duration, check_deadline=True):
        end = time.monotonic() + duration
        while time.monotonic() < end:
            if check_deadline and time.monotonic() > global_deadline:
                raise TimeoutError('Global Python deadline exceeded in pump')
            rem = min(0.05, end - time.monotonic())
            if check_deadline:
                rem = min(rem, max(0.0, global_deadline - time.monotonic()))
                if rem <= 0:
                    break
            if select.select([fd], [], [], max(0.0, rem))[0]:
                try:
                    chunk = os.read(fd, 65536)
                    if not chunk:
                        break
                    raw.extend(chunk)
                except OSError:
                    break

    def wait(text, timeout=20.0):
        end = min(time.monotonic() + timeout, global_deadline)
        encoded = text.encode('utf-8')
        while encoded not in ANSI.sub(b'', raw):
            if time.monotonic() >= end:
                if time.monotonic() >= global_deadline:
                    raise TimeoutError('Global Python deadline exceeded waiting for ' + text)
                raise TimeoutError('Timed out waiting for ' + text)
            pump(0.1)

    try:
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(str(d))
            os.execvpe(argv[0], argv, env)

        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', height, width, 0, 0))

        wait('PI51_READY')
        pump(0.4)
        for step in plan.get('steps', []):
            if time.monotonic() > global_deadline:
                raise TimeoutError('Global Python deadline exceeded')
            if 'submit' in step:
                # Bracketed paste + return
                payload = b'\\x1b[200~' + step['submit'].encode('utf-8') + b'\\x1b[201~\\r'
                os.write(fd, payload)
                pump(0.4)
            if 'key' in step:
                key_map = {
                    'esc': b'\\x1b',
                    'escape': b'\\x1b',
                    'down': b'\\x1b[B',
                    'up': b'\\x1b[A',
                    'enter': b'\\r',
                    'save': b'\\x13'
                }
                os.write(fd, key_map[step['key']])
                pump(0.4)
            if 'wait' in step:
                wait(step['wait'])
                pump(0.3)
            if 'snapshot' in step:
                snapshots[step['snapshot']] = bytes(raw)
            if 'sleep' in step:
                pump(float(step['sleep']))
        pump(0.2)
    finally:
        if pid:
            try:
                os.kill(pid, signal.SIGTERM)
                pump(0.1, check_deadline=False)
            except OSError:
                pass
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
            try:
                os.waitpid(pid, 0)
            except OSError:
                pass
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass

    # Save output artifacts
    (d / 'raw.bin').write_bytes(raw)
    (d / 'plain.txt').write_bytes(ANSI.sub(b'', raw))
    events = [json.loads(line) for line in log.read_text().splitlines() if line.strip()]

    result = {
        'settings': json.loads((a / 'settings.json').read_text()),
        'events': events,
        'snapshots': {k: v.hex() for k, v in snapshots.items()}
    }
    print(json.dumps(result))

if __name__ == '__main__':
    main()
`;

async function executePtyRun(opts: RunOptions): Promise<RunResult> {
	const dir = mkdtempSync(join(tmpdir(), "pi51-pty-run-"));
	const timeoutSec = opts.timeoutSeconds ?? 20;
	const outerTimeoutMs = (timeoutSec + 5) * 1000;

	let child: ReturnType<typeof spawn> | null = null;
	let isClosed = false;
	let timer: NodeJS.Timeout | null = null;
	let timedOut = false;

	try {
		// Prepare observer extension
		const observerPath = join(dir, "observer.ts");
		const observerCode = `
import { appendFileSync } from "node:fs";

export default function(pi: any) {
    const log = (data: any) => appendFileSync(process.env.PI51_LOG!, JSON.stringify(data) + "\\n");

    pi.on("session_start", (_e: any, ctx: any) => {
        log({ event: "ready", level: pi.getThinkingLevel() });
        ctx.ui.notify("PI51_READY", "info");
    });

    pi.on("input", (e: any) => {
        log({ event: "input", text: e.text, level: pi.getThinkingLevel() });
        return { action: "handled" };
    });

    pi.on("agent_start", () => {
        log({ event: "agent_start" });
    });

    pi.on("before_provider_request", () => {
        log({ event: "provider" });
        throw Error("PI51_NO_PROVIDER");
    });

    pi.registerCommand("probe", {
        handler: async (_a: any, c: any) => {
            const data = { event: "probe", level: pi.getThinkingLevel(), entries: c.sessionManager.getEntries() };
            log(data);
            c.ui.notify("PI51_PROBE " + data.level, "info");
        }
    });
}
`;
		writeFileSync(observerPath, observerCode.trim() + "\n", "utf8");

		const allExtensions = [observerPath, ...(opts.extensions ?? [])];
		const plan = {
			dir,
			host: opts.host,
			width: opts.width ?? 80,
			height: opts.height ?? 38,
			steps: opts.steps,
			extensions: allExtensions,
			reasoning: opts.reasoning !== false,
			timeoutSeconds: timeoutSec,
		};

		const proc = spawn("python3", ["-c", PYTHON_PTY_DRIVER], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		child = proc;

		let stdout = "";
		let stderr = "";

		proc.stdout?.on("data", (d) => {
			stdout += d.toString("utf8");
		});
		proc.stderr?.on("data", (d) => {
			stderr += d.toString("utf8");
		});

		proc.stdin?.on("error", () => {});
		proc.stdout?.on("error", () => {});
		proc.stderr?.on("error", () => {});

		const runPromise = new Promise<void>((resolve, reject) => {
			timer = setTimeout(async () => {
				timedOut = true;
				try {
					proc.kill("SIGTERM");
					const graceEnd = Date.now() + 1000;
					while (!isClosed && Date.now() < graceEnd) {
						await new Promise((r) => setTimeout(r, 50));
					}
					if (!isClosed) {
						proc.kill("SIGKILL");
					}
				} catch {
					// ignore kill errors
				}
				reject(new Error(`PTY execution timed out after ${outerTimeoutMs}ms`));
			}, outerTimeoutMs);

			proc.on("close", (code) => {
				isClosed = true;
				if (timer) {
					clearTimeout(timer);
					timer = null;
				}
				if (timedOut) return;
				if (code === 0) {
					resolve();
				} else {
					reject(new Error(`PTY driver exited with code ${code}: ${stderr.trim()}`));
				}
			});

			proc.on("error", (err) => {
				if (timer) {
					clearTimeout(timer);
					timer = null;
				}
				reject(err);
			});
		});

		proc.stdin?.end(JSON.stringify(plan));

		await runPromise;

		const parsed = JSON.parse(stdout.trim());
		const raw = readFileSync(join(dir, "raw.bin"));
		const plain = readFileSync(join(dir, "plain.txt"), "utf8");
		const snapshots: Record<string, Buffer> = {};
		for (const [k, v] of Object.entries(parsed.snapshots as Record<string, string>)) {
			snapshots[k] = Buffer.from(v, "hex");
		}

		return {
			events: parsed.events,
			settings: parsed.settings,
			raw,
			plain,
			snapshots,
		};
	} finally {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (child && !isClosed) {
			try {
				child.kill("SIGTERM");
				const graceEnd = Date.now() + 500;
				while (!isClosed && Date.now() < graceEnd) {
					await new Promise((r) => setTimeout(r, 50));
				}
				if (!isClosed) {
					child.kill("SIGKILL");
				}
			} catch {
				// ignore
			}
		}
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("rbf-effort runnable bounded actualhost tests", () => {
	const hostRoots = resolveHostRoots();
	const widths = [80, 120] as const;

	interface TestMatrixEntry {
		host: HostInfo;
		width: number;
		label: string;
	}

	const matrix: TestMatrixEntry[] = hostRoots.flatMap((host) =>
		widths.map((width) => ({
			host,
			width,
			label: `host ${host.version} @ ${width}col`,
		})),
	);

	it("confirms presence of at least one valid host root for pty testing", () => {
		expect(hostRoots.length).toBeGreaterThan(0);
		expect(existsSync(join(hostRoots[0]!.root, "dist/bundle/cli.js"))).toBe(true);
	});

	it("proves bounded timeout and clean process termination on unreachable wait", async () => {
		const host = hostRoots[0]?.root;
		expect(host).toBeDefined();
		const start = Date.now();
		await expect(
			executePtyRun({
				host: host!,
				timeoutSeconds: 2,
				steps: [{ wait: "NEVER_EMITTED_TEST_SENTINEL_STRING" }],
			}),
		).rejects.toThrow();
		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(10000);
	}, 15000);

	describe.each(matrix)("$label", ({ host, width }) => {
		it("translates /effort to /thinking interactively with zero provider turns", async () => {
			const steps: Step[] = [
				{ submit: "/effort high" },
				{ wait: "Thinking level: high" },
				{ submit: "/probe" },
				{ wait: "PI51_PROBE high" },
				{ submit: "/effort off" },
				{ wait: "Thinking level: off" },
				{ submit: "/probe" },
				{ wait: "PI51_PROBE off" },
			];

			const res = await executePtyRun({
				host: host.root,
				width,
				steps,
				extensions: [CANDIDATE_SRC],
			});

			const probeEvents = res.events.filter((e) => e.event === "probe");
			expect(probeEvents.map((e) => e.level)).toEqual(["high", "off"]);

			assertPositiveScenarioEvents(res);
		}, 60000);

		it("produces exact menu cells native /thinking vs alias /effort", async () => {
			const steps: Step[] = [
				{ submit: "/thinking" },
				{ wait: "Thinking Level" },
				{ snapshot: "native-menu" },
				{ key: "esc" },
				{ sleep: 0.3 },
				{ submit: "/effort" },
				{ wait: "Thinking Level" },
				{ snapshot: "alias-menu" },
				{ key: "esc" },
				{ submit: "/probe" },
			];

			const res = await executePtyRun({
				host: host.root,
				width,
				steps,
				extensions: [CANDIDATE_SRC],
			});

			expect(res.snapshots["native-menu"]).toBeDefined();
			expect(res.snapshots["alias-menu"]).toBeDefined();

			const nativeScreen = replayScreen(res.snapshots["native-menu"]!, width, 38);
			const aliasScreen = replayScreen(res.snapshots["alias-menu"]!, width, 38);

			const nativeMenuIndex = nativeScreen.lines.findIndex((l) => l.includes("Thinking Level"));
			const aliasMenuIndex = aliasScreen.lines.findIndex((l) => l.includes("Thinking Level"));

			expect(nativeMenuIndex).toBeGreaterThanOrEqual(0);
			expect(aliasMenuIndex).toBe(nativeMenuIndex);

			// Compare full cells from ThinkingLevel heading to bottom menu nativeborder/footer boundary (height 38 cells[i:-2])
			const nativeMenuCells = nativeScreen.cells.slice(nativeMenuIndex, -2);
			const aliasMenuCells = aliasScreen.cells.slice(aliasMenuIndex, -2);
			expect(aliasMenuCells).toEqual(nativeMenuCells);

			const nativeMenuLines = nativeScreen.lines.slice(nativeMenuIndex, -2);
			const aliasMenuLines = aliasScreen.lines.slice(aliasMenuIndex, -2);
			expect(aliasMenuLines).toEqual(nativeMenuLines);

			// Verify full choices and hints are included in the menu
			const joinedMenuText = nativeMenuLines.join("\n").toLowerCase();
			for (const choice of ["off", "low", "medium", "high"]) {
				expect(joinedMenuText).toContain(choice);
			}
			expect(joinedMenuText).toMatch(/enter|select/i);
			expect(joinedMenuText).toMatch(/ctrl\+s|save/i);
			expect(joinedMenuText).toMatch(/esc|cancel/i);

			assertPositiveScenarioEvents(res);
		}, 60000);

		it("validates mixed-case arguments and rejects invalid levels without provider turns", async () => {
			const steps: Step[] = [
				{ submit: "/effort HiGh" },
				{ wait: "Thinking level: high" },
				{ submit: "/probe" },
				{ wait: "PI51_PROBE high" },
				{ submit: "/effort nonsense" },
				{ wait: 'Unknown thinking level "nonsense"' },
				{ submit: "/probe" },
				{ wait: "PI51_PROBE high" },
			];

			const res = await executePtyRun({
				host: host.root,
				width,
				steps,
				extensions: [CANDIDATE_SRC],
			});

			const probeEvents = res.events.filter((e) => e.event === "probe");
			expect(probeEvents.map((e) => e.level)).toEqual(["high", "high"]);

			assertPositiveScenarioEvents(res);
		}, 60000);

		it("distinguishes Ctrl+S default save from Enter session-only effect", async () => {
			// 1. Enter applies session level without altering defaultThinkingLevel in settings.json
			const enterRun = await executePtyRun({
				host: host.root,
				width,
				steps: [
					{ submit: "/effort" },
					{ wait: "Thinking Level" },
					{ key: "down" },
					{ key: "enter" },
					{ wait: "Thinking level: high" },
					{ submit: "/probe" },
				],
				extensions: [CANDIDATE_SRC],
			});

			expect(enterRun.settings.defaultThinkingLevel).toBe("medium");
			const enterProbes = enterRun.events.filter((e) => e.event === "probe");
			expect(enterProbes[0]?.level).toBe("high");
			assertPositiveScenarioEvents(enterRun);

			// 2. Ctrl+S saves default thinking level in settings.json
			const saveRun = await executePtyRun({
				host: host.root,
				width,
				steps: [
					{ submit: "/effort" },
					{ wait: "Thinking Level" },
					{ key: "down" },
					{ key: "save" },
					{ wait: "Default thinking level: high" },
					{ submit: "/probe" },
				],
				extensions: [CANDIDATE_SRC],
			});

			expect(saveRun.settings.defaultThinkingLevel).toBe("high");
			const saveProbes = saveRun.events.filter((e) => e.event === "probe");
			expect(saveProbes[0]?.level).toBe("high");
			assertPositiveScenarioEvents(saveRun);
		}, 60000);

		it("documents honest baseline behavior when rbf-effort adapter is absent", async () => {
			// Running WITHOUT rbf-effort.ts
			const steps: Step[] = [
				{ submit: "/effort low" },
				{ submit: "/probe" },
				{ wait: "PI51_PROBE medium" },
			];

			const res = await executePtyRun({
				host: host.root,
				width,
				steps,
				extensions: [], // no adapter loaded
			});

			// When adapter is absent, native Pi does not recognize /effort as slash command,
			// so it flows to normal user input, consumed by the observer
			const inputEvents = res.events.filter((e) => e.event === "input");
			expect(inputEvents.map((e) => e.text)).toContain("/effort low");

			// Thinking level remained at initial default "medium"
			const probeEvents = res.events.filter((e) => e.event === "probe");
			expect(probeEvents[0]?.level).toBe("medium");

			// Assert observer prevented any real provider turn
			const providerTurns = res.events.filter((e) => e.event === "provider" || e.event === "agent_start");
			expect(providerTurns).toHaveLength(0);
		}, 60000);
	});
});
