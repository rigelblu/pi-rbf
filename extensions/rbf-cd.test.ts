import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import rbfCd, {
	CD_BUSY_QUERY_CHANNEL,
	CD_COMMAND_DESCRIPTION,
	CD_COMMAND_NAME,
	CD_MOVE_ENTRY_TYPE,
	CD_PENDING_MOVE_KEY,
	createRbfCd,
	decideFailedSwitch,
	FAILED_SWITCH_EXIT_WINDOW_MS,
	inspectCopy,
	launchedWithSandbox,
	reopenCommand,
	resolveCdPath,
	type MoveEntry,
} from "./rbf-cd.ts";

// Every root is a throwaway: two project directories, an isolated Pi agent directory, and a fake
// `trash` first on PATH that moves files into <root>/trash, so no test file reaches the real Trash.
let root: string;
let dirA: string;
let dirB: string;
let home: string;
let trashDir: string;
const saved = { path: process.env.PATH, agentDir: process.env.PI_CODING_AGENT_DIR, argv: process.argv, cwd: process.cwd() };
const shared = globalThis as Record<symbol, unknown>;
// The clock and the exit hook's output are injected: no test sleeps, and none writes to the real stderr.
const clock = { now: 0 };
let printedAtExit: string[];
const exitHooks = () => process.listeners("exit").filter((listener) => listener.name === "onFailedSwitchExit") as (() => void)[];

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "rbf-cd-test-")));
	dirA = join(root, "A");
	dirB = join(root, "B");
	home = join(root, "home");
	trashDir = join(root, "trash");
	for (const dir of [dirA, dirB, home, trashDir, join(root, "bin"), join(root, "agent")]) mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(root, "bin", "trash"),
		`#!/bin/sh\n[ -e "${root}/trash-fails" ] && exit 1\nfor f in "$@"; do mv "$f" "${trashDir}/" || exit 1; done\n`,
		{ mode: 0o755 },
	);
	process.env.PATH = `${join(root, "bin")}:${saved.path}`;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.argv = ["node", "/opt/pi/dist/cli.js"];
	process.chdir(dirA);
	clock.now = 1_000_000;
	printedAtExit = [];
});

afterEach(() => {
	process.chdir(saved.cwd);
	process.env.PATH = saved.path;
	if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
	process.argv = saved.argv;
	delete shared[CD_PENDING_MOVE_KEY];
	// A test that leaves the failed-switch hook armed must not have it fire when the test process exits.
	for (const listener of exitHooks()) process.removeListener("exit", listener);
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

const failTrash = () => writeFileSync(join(root, "trash-fails"), "");
const trashed = () => readdirSync(trashDir);
const sessionFilesIn = (folder: string) => (existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith(".jsonl")) : []);
const defaultFolder = (cwd: string) => SessionManager.create(cwd).getSessionDir();
const headerOf = (file: string) => JSON.parse(readFileSync(file, "utf8").split("\n")[0]);
const moveEntriesOf = (file: string): MoveEntry[] =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter((entry) => entry.customType === CD_MOVE_ENTRY_TYPE)
		.map((entry) => entry.data);

function addTurn(manager: SessionManager, text: string): void {
	manager.appendMessage({ role: "user", content: text, timestamp: Date.now() } as any);
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: `answer to ${text}` }],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	} as any);
}

/** A real, saved Pi session in `cwd` with `turns` turns. */
function savedSession(cwd: string, options: { folder?: string; turns?: number } = {}): SessionManager {
	const manager = SessionManager.create(cwd, options.folder);
	for (let turn = 1; turn <= (options.turns ?? 1); turn++) addTurn(manager, `prompt ${turn}`);
	return manager;
}

/** Session files are named by millisecond and ID, so two same-ID files need two different milliseconds. */
function tick(): void {
	const end = Date.now() + 2;
	while (Date.now() < end);
}

/** A same-ID copy with no move entry: what an interrupted `/cd` leaves. */
function sameIdCopy(source: SessionManager, to: string, folder?: string): SessionManager {
	tick();
	return SessionManager.forkFrom(source.getSessionFile()!, to, folder, { id: source.getSessionId() });
}

/** What a finished `/cd` leaves: a same-ID copy in `to` whose last move entry names `to`. */
function movedCopy(source: SessionManager, to: string, folder?: string): SessionManager {
	const copy = sameIdCopy(source, to, folder);
	copy.appendCustomEntry(CD_MOVE_ENTRY_TYPE, { from: source.getCwd(), to, sessionId: source.getSessionId() } satisfies MoveEntry);
	return copy;
}

type Harness = ReturnType<typeof createHarness>;

/** One loaded `rbf-cd.ts` over a real session manager, with Pi's command context mocked. */
function createHarness(
	manager: SessionManager,
	options: { hasUI?: boolean; mode?: string; answer?: object | false; prepareNext?: (next: any) => void } = {},
) {
	const events = createEventBus();
	if (options.answer !== false) {
		events.on(CD_BUSY_QUERY_CHANNEL, (query) => Object.assign(query as object, { answered: true }, options.answer ?? {}));
	}
	const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
	let command: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> } | undefined;
	const notify = vi.fn();
	const setEditorText = vi.fn();
	const navigateTree = vi.fn(async (_id: string) => ({ cancelled: false }));
	const idle = { answers: [] as boolean[] };
	let next: Harness | undefined;

	const switchSession = vi.fn(async (file: string, switchOptions?: { withSession?: (ctx: any) => Promise<void> }) => {
		// Pi's order: the re-created extension gets `session_start`, then `withSession` runs.
		next = createHarness(SessionManager.open(file), options);
		options.prepareNext?.(next);
		await next.handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, next.ctx);
		await switchOptions?.withSession?.(next.ctx);
		return { cancelled: false };
	});

	const pi = {
		events,
		on: vi.fn((event: string, handler: (event: any, ctx: any) => Promise<void>) => handlers.set(event, handler)),
		registerCommand: vi.fn((name: string, config: typeof command) => {
			if (name === CD_COMMAND_NAME) command = config;
		}),
		appendEntry: vi.fn((customType: string, data: unknown) => manager.appendCustomEntry(customType, data)),
		getThinkingLevel: () => "high",
		setModel: vi.fn(async (_model: unknown) => true),
		setThinkingLevel: vi.fn((_level: string) => {}),
	} as unknown as ExtensionAPI;
	const calls = pi as unknown as { setModel: ReturnType<typeof vi.fn>; setThinkingLevel: ReturnType<typeof vi.fn> };
	const ctx = {
		hasUI: options.hasUI ?? true,
		mode: options.mode ?? "tui",
		get cwd() {
			return manager.getCwd();
		},
		sessionManager: manager,
		model: { provider: "picked-provider", id: "picked-model" },
		modelRegistry: { find: (provider: string, id: string) => (provider === "gone" ? undefined : { provider, id, found: true }) },
		isIdle: vi.fn(() => idle.answers.shift() ?? true),
		ui: { notify, setEditorText },
		switchSession,
		navigateTree,
	} as unknown as ExtensionCommandContext;
	createRbfCd({ now: () => clock.now, printAtExit: (text) => printedAtExit.push(text) })(pi);

	return {
		calls,
		ctx,
		events,
		handlers,
		idle,
		navigateTree,
		notify,
		pi,
		setEditorText,
		switchSession,
		get description() {
			return command?.description;
		},
		get next() {
			return next;
		},
		run: (args: string) => {
			tick();
			return command!.handler(args, ctx);
		},
	};
}

/** Nothing was written for the destination and Pi was never asked to switch. */
function expectNothingWritten(harness: Harness, before: string[]): void {
	expect(harness.switchSession).not.toHaveBeenCalled();
	expect(sessionFilesIn(defaultFolder(dirB))).toEqual([]);
	expect(sessionFilesIn(dirname(harness.ctx.sessionManager.getSessionFile()!))).toEqual(before);
	expect(trashed()).toEqual([]);
	expect(process.cwd()).toBe(dirA);
}

// ─── Paths ───────────────────────────────────────────────────────────────────

describe("resolveCdPath", () => {
	it.each([
		["absolute", () => dirB, () => dirB],
		["relative to the session's directory", () => "../B", () => dirB],
		["a child directory", () => "sub", () => join(dirA, "sub")],
		["..", () => "..", () => root],
		["~", () => "~", () => home],
		["~/…", () => "~/projects", () => join(home, "projects")],
		["a symlink", () => join(root, "link-to-B"), () => dirB],
		["spaces", () => join(dirA, "with space"), () => join(dirA, "with space")],
		["double outer quotes", () => `"${join(dirA, "with space")}"`, () => join(dirA, "with space")],
		["single outer quotes", () => `'${join(dirA, "with space")}'`, () => join(dirA, "with space")],
		["surrounding whitespace", () => `   ${dirB}  `, () => dirB],
		["an inner quote kept as typed", () => "it's", () => join(dirA, "it's")],
	])("resolves %s", (_name, input, expected) => {
		for (const dir of [join(dirA, "sub"), join(home, "projects"), join(dirA, "with space"), join(dirA, "it's")]) mkdirSync(dir);
		symlinkSync(dirB, join(root, "link-to-B"));

		expect(resolveCdPath(input(), dirA, home)).toEqual({ ok: true, path: expected() });
	});

	it.each(["$HOME", "$(touch SENTINEL)", "; touch SENTINEL", "`touch SENTINEL`", "*"])(
		"treats %s as a literal name and runs nothing",
		(input) => {
			expect(resolveCdPath(input, dirA, home)).toEqual({
				ok: false,
				copy: `Can't change directory: path does not exist: ${join(dirA, input)}.`,
			});

			mkdirSync(join(dirA, input));
			expect(resolveCdPath(input, dirA, home)).toEqual({ ok: true, path: join(dirA, input) });
			expect(existsSync(join(dirA, "SENTINEL"))).toBe(false);
			expect(existsSync(join(dirA, input, "SENTINEL"))).toBe(false);
			expect(readdirSync(dirA)).toEqual([input]);
		},
	);

	it("refuses a missing path with its exact copy", () => {
		expect(resolveCdPath("missing", dirA, home)).toEqual({
			ok: false,
			copy: `Can't change directory: path does not exist: ${join(dirA, "missing")}.`,
		});
	});

	it("refuses a file with its exact copy", () => {
		writeFileSync(join(dirA, "marker.txt"), "x");

		expect(resolveCdPath("marker.txt", dirA, home)).toEqual({
			ok: false,
			copy: `Can't change directory: not a directory: ${join(dirA, "marker.txt")}.`,
		});
	});

	it.skipIf(process.getuid?.() === 0)("refuses a directory the process can't read and enter", () => {
		const locked = join(dirA, "locked");
		mkdirSync(locked);
		for (const mode of [0o000, 0o400, 0o100]) {
			chmodSync(locked, mode);
			expect(resolveCdPath("locked", dirA, home)).toEqual({ ok: false, copy: `Can't change directory: access denied: ${locked}.` });
		}
		chmodSync(locked, 0o700);
	});

	it.each([`"${"/tmp/x"}`, `'/tmp/x`, `/tmp/x"`, `/tmp/x'`, `"/tmp/x'`, `"`])("refuses the unmatched quote in %s", (input) => {
		expect(resolveCdPath(input, dirA, home)).toEqual({
			ok: false,
			copy: "Can't change directory: unmatched outer quote. Use /cd <path>.",
		});
	});
});

// ─── Command, no move ────────────────────────────────────────────────────────

describe("/cd without a move", () => {
	it("registers /cd with its exact description", () => {
		const harness = createHarness(savedSession(dirA));

		expect(CD_COMMAND_NAME).toBe("cd");
		// The same literal is pinned in rbf-background-tasks.test.ts: the two extensions can't import each other.
		expect(CD_BUSY_QUERY_CHANNEL).toBe("rbf-background-tasks:busy/v1");
		expect(harness.description).toBe("Change this session's working directory.");
		expect(CD_COMMAND_DESCRIPTION).toBe(harness.description);

		// The default export is what Pi loads: the same extension, on the real clock.
		const registerCommand = vi.fn();
		rbfCd({ on: vi.fn(), registerCommand } as unknown as ExtensionAPI);
		expect(registerCommand).toHaveBeenCalledWith("cd", expect.objectContaining({ description: CD_COMMAND_DESCRIPTION }));
	});

	it("shows the directory and usage as one two-line notification for a bare /cd", async () => {
		const harness = createHarness(savedSession(dirA));

		await harness.run("   ");

		expect(harness.notify.mock.calls).toEqual([[`Working directory: ${dirA}\nUsage: /cd <path>`, "info"]]);
		expect(harness.setEditorText).not.toHaveBeenCalled();
	});

	it("says so and changes nothing for the same directory, however it is spelled", async () => {
		const manager = savedSession(dirA);
		const before = sessionFilesIn(dirname(manager.getSessionFile()!));
		symlinkSync(dirA, join(root, "link-to-A"));

		for (const spelling of [dirA, ".", "../A", join(root, "link-to-A")]) {
			const harness = createHarness(manager);
			await harness.run(spelling);

			expect(harness.notify.mock.calls).toEqual([[`Already working in ${dirA}.`, "info"]]);
			expectNothingWritten(harness, before);
		}
	});

	it("shows a path refusal as an error and puts the typed command back", async () => {
		const harness = createHarness(savedSession(dirA));

		await harness.run("  missing ");

		expect(harness.notify.mock.calls).toEqual([[`Can't change directory: path does not exist: ${join(dirA, "missing")}.`, "error"]]);
		expect(harness.setEditorText.mock.calls).toEqual([["/cd   missing "]]);
		expect(harness.switchSession).not.toHaveBeenCalled();
	});
});

// ─── Refusals ────────────────────────────────────────────────────────────────

describe("/cd refusals", () => {
	it.each([
		["print mode", { hasUI: false, mode: "print" }],
		["RPC mode, which has dialogs but no exit-on-failure", { hasUI: true, mode: "rpc" }],
		["a context with no UI and no mode", { hasUI: false, mode: undefined }],
	])("refuses outside interactive mode: %s", async (_name, options) => {
		const manager = savedSession(dirA);
		const before = sessionFilesIn(dirname(manager.getSessionFile()!));
		const harness = createHarness(manager, options as any);

		await harness.run(dirB);

		expect(harness.notify.mock.calls).toEqual([["/cd works in interactive mode only.", "warning"]]);
		expect(harness.setEditorText).not.toHaveBeenCalled();
		expectNothingWritten(harness, before);
	});

	it.each<[string, (manager: SessionManager) => { options?: object; idle?: boolean[]; copy: string; level?: string; session?: SessionManager }]>([
		[
			"a response or compaction is running",
			() => ({ idle: [false], copy: "Can't change directory while a response or compaction is running. Finish or stop it, then retry /cd." }),
		],
		[
			"a move is in flight",
			(manager) => {
				shared[CD_PENDING_MOVE_KEY] = { file: "/elsewhere.jsonl", from: dirA, to: dirB, sessionId: manager.getSessionId() };
				return { copy: "A directory change is already in progress. Wait for it to finish, then retry /cd." };
			},
		],
		[
			"a tracked background task is running",
			() => ({
				options: { answer: { backgroundTask: true } },
				copy: "Can't change directory while a background task is running. Finish or stop it, then retry /cd.",
			}),
		],
		[
			"a ! or foreground command is running",
			() => ({
				options: { answer: { command: true } },
				copy: "Can't change directory while a command is running. Wait for it to finish or stop it, then retry /cd.",
			}),
		],
		[
			"the background-tasks listener doesn't answer",
			() => ({
				options: { answer: false },
				copy: `Can't change directory: the background-tasks extension didn't answer, so /cd can't tell whether a command is running. Working directory is still ${dirA}.`,
			}),
		],
		[
			"the session holds a Codex thread binding on an abandoned branch",
			(manager) => {
				const branchPoint = manager.getLeafId()!;
				manager.appendCustomEntry("rbf-codex-thread/v1", { threadId: "t-1", cwd: dirA, sessionId: manager.getSessionId() });
				manager.branch(branchPoint);
				addTurn(manager, "a turn on the other branch");
				return { copy: `Can't change directory: /cd doesn't support Codex conversations yet. Working directory is still ${dirA}.` };
			},
		],
		[
			"the session's file went missing after Pi saved a reply to it",
			(manager) => {
				rmSync(manager.getSessionFile()!);
				return { copy: `Can't change directory: this conversation's session file is missing. Working directory is still ${dirA}.`, level: "error" };
			},
		],
		[
			"the file went missing after Pi 1.0.2 saved a prompt that got no reply",
			() => {
				// Pi 1.0.2 writes the file with the first user message. This is that session with its file gone.
				const session = SessionManager.create(dirA);
				session.appendMessage({ role: "user", content: "a prompt whose turn was stopped", timestamp: Date.now() } as any);
				return { session, copy: `Can't change directory: this conversation's session file is missing. Working directory is still ${dirA}.`, level: "error" };
			},
		],
		[
			"the file went missing from a session whose only message is a reply",
			() => {
				const session = SessionManager.create(dirA);
				session.appendMessage({ role: "assistant", content: [{ type: "text", text: "a reply" }], stopReason: "stop", timestamp: Date.now() } as any);
				rmSync(session.getSessionFile()!);
				return { session, copy: `Can't change directory: this conversation's session file is missing. Working directory is still ${dirA}.`, level: "error" };
			},
		],
		[
			"Pi was started with --sandbox",
			() => {
				process.argv = ["node", "/opt/pi/dist/cli.js", "--model", "x/y", "--sandbox"];
				return { copy: `Can't change directory in a sandboxed session. Working directory is still ${dirA}.` };
			},
		],
	])("refuses when %s, writes nothing, and puts the typed command back", async (_name, arrange) => {
		const manager = savedSession(dirA);
		const { options, idle, copy, level, session } = arrange(manager);
		const before = sessionFilesIn(dirname(manager.getSessionFile()!));
		const harness = createHarness(session ?? manager, options);
		harness.idle.answers = idle ?? [];

		await harness.run(dirB);

		expect(harness.notify.mock.calls).toEqual([[copy, level ?? "warning"]]);
		expect(harness.setEditorText.mock.calls).toEqual([[`/cd ${dirB}`]]);
		expectNothingWritten(harness, before);
	});

	it("refuses a session that isn't being saved", async () => {
		const harness = createHarness(SessionManager.inMemory(dirA));

		await harness.run(dirB);

		expect(harness.notify.mock.calls).toEqual([
			[`Can't change directory in a session that isn't being saved. Working directory is still ${dirA}.`, "warning"],
		]);
		expect(harness.setEditorText.mock.calls).toEqual([[`/cd ${dirB}`]]);
		expect(harness.switchSession).not.toHaveBeenCalled();
		expect(sessionFilesIn(defaultFolder(dirB))).toEqual([]);
	});

	it("refuses when the new session file can't be written, and leaves nothing behind", async () => {
		const manager = savedSession(dirA);
		const before = sessionFilesIn(dirname(manager.getSessionFile()!));
		const harness = createHarness(manager);
		vi.spyOn(SessionManager, "forkFrom").mockImplementation(() => {
			throw new Error("EACCES: raw detail that must never reach the screen");
		});

		await harness.run(dirB);

		expect(harness.notify.mock.calls).toEqual([
			[`Can't change directory: the session file could not be written. Working directory is still ${dirA}.`, "error"],
		]);
		expect(harness.setEditorText.mock.calls).toEqual([[`/cd ${dirB}`]]);
		expectNothingWritten(harness, before);
		expect(shared[CD_PENDING_MOVE_KEY]).toBeUndefined();
	});

	it("deletes a half-written file its own failed write left in the destination folder", async () => {
		const manager = savedSession(dirA);
		const before = sessionFilesIn(dirname(manager.getSessionFile()!));
		const harness = createHarness(manager);
		const realFork = SessionManager.forkFrom.bind(SessionManager);
		vi.spyOn(SessionManager, "forkFrom").mockImplementation((...args) => {
			realFork(...args);
			throw new Error("ENOSPC: raw detail");
		});

		await harness.run(dirB);

		expect(harness.notify.mock.calls).toEqual([
			[`Can't change directory: the session file could not be written. Working directory is still ${dirA}.`, "error"],
		]);
		expectNothingWritten(harness, before);
	});

	it("reads the sandbox launch flag the way Pi parses it", () => {
		const cli = ["node", "/opt/pi/dist/cli.js"];

		expect(launchedWithSandbox([...cli, "--sandbox"])).toBe(true);
		expect(launchedWithSandbox([...cli, "--sandbox=false"])).toBe(true);
		expect(launchedWithSandbox([...cli, "--model", "x/y"])).toBe(false);
		expect(launchedWithSandbox([...cli, "--", "--sandbox"])).toBe(false);
	});
});

// ─── Same-ID rule ────────────────────────────────────────────────────────────

describe("same-ID rule for the destination folder", () => {
	const refusal = () => [`Can't change directory: this conversation already has a copy there. Working directory is still ${dirA}.`, "error"];

	it("refuses when a copy holds an entry this session lacks, and touches no file, not even a stale one beside it", async () => {
		const session = savedSession(dirA);
		const stale = sameIdCopy(session, dirB).getSessionFile()!;
		const drifted = sameIdCopy(session, dirB);
		addTurn(drifted, "a turn the session never saw");
		const before = [readFileSync(session.getSessionFile()!), readFileSync(drifted.getSessionFile()!)];
		const harness = createHarness(session);

		await harness.run(dirB);

		expect(harness.notify.mock.calls).toEqual([refusal()]);
		expect(harness.setEditorText.mock.calls).toEqual([[`/cd ${dirB}`]]);
		expect(harness.switchSession).not.toHaveBeenCalled();
		expect(readFileSync(session.getSessionFile()!).equals(before[0])).toBe(true);
		expect(readFileSync(drifted.getSessionFile()!).equals(before[1])).toBe(true);
		expect(sessionFilesIn(defaultFolder(dirB)).sort()).toEqual([basename(stale), basename(drifted.getSessionFile()!)].sort());
		expect(trashed()).toEqual([]);
	});

	it("refuses when the stale copy can't be sent to the Trash", async () => {
		const session = savedSession(dirA);
		const stale = sameIdCopy(session, dirB).getSessionFile()!;
		failTrash();
		const harness = createHarness(session);

		await harness.run(dirB);

		expect(harness.notify.mock.calls).toEqual([refusal()]);
		expect(harness.switchSession).not.toHaveBeenCalled();
		expect(sessionFilesIn(defaultFolder(dirB))).toEqual([basename(stale)]);
		expect(trashed()).toEqual([]);
	});

	it("sends a stale copy to the Trash, whatever its name, then moves", async () => {
		const session = savedSession(dirA);
		const stale = sameIdCopy(session, dirB).getSessionFile()!;
		spawnSync("mv", [stale, join(dirname(stale), "not-the-usual-name.jsonl")]);
		const harness = createHarness(session);

		await harness.run(dirB);

		const moved = harness.switchSession.mock.calls[0][0];
		expect(trashed().sort()).toEqual(["not-the-usual-name.jsonl", basename(session.getSessionFile()!)].sort());
		expect(sessionFilesIn(defaultFolder(dirB))).toEqual([basename(moved)]);
		expect(harness.next!.notify.mock.calls).toEqual([[`Working directory changed to ${dirB}.`, "info"]]);
	});

	it("writes the new file to the session's custom folder, where its own file and another session's aren't copies", async () => {
		const custom = join(root, "custom-sessions");
		const session = savedSession(dirA, { folder: custom });
		const other = savedSession(dirB, { folder: custom }).getSessionFile()!;
		const own = session.getSessionFile()!;
		const harness = createHarness(session);

		await harness.run(dirB);

		const moved = harness.switchSession.mock.calls[0][0];
		expect(dirname(moved)).toBe(custom);
		expect(sessionFilesIn(defaultFolder(dirB))).toEqual([]);
		expect(sessionFilesIn(custom).sort()).toEqual([basename(moved), basename(other)].sort());
		expect(headerOf(moved)).toMatchObject({ id: session.getSessionId(), cwd: dirB, parentSession: own });
		expect(trashed()).toEqual([basename(own)]);
		expect(harness.next!.notify.mock.calls).toEqual([[`Working directory changed to ${dirB}.`, "info"]]);
	});

	it("leaves no default folder behind for a session that uses a custom one", async () => {
		const harness = createHarness(savedSession(dirA, { folder: join(root, "custom-sessions") }));
		const sessionsRoot = join(root, "agent", "sessions");
		expect(existsSync(sessionsRoot)).toBe(false);

		await harness.run(dirB);

		// Asking Pi where A's default folder is creates it. Nothing is ever written there, so it goes again.
		expect(harness.next!.notify.mock.calls).toEqual([[`Working directory changed to ${dirB}.`, "info"]]);
		expect(readdirSync(sessionsRoot)).toEqual([]);
	});

	it("keeps a default folder that was there before the move, empty or not", async () => {
		const harness = createHarness(savedSession(dirA, { folder: join(root, "custom-sessions") }));
		const already = defaultFolder(dirA);

		await harness.run(dirB);

		expect(existsSync(already)).toBe(true);
	});
});

// ─── Copy state ──────────────────────────────────────────────────────────────

describe("inspectCopy", () => {
	it("is finished when a same-ID parent exists and the last move entry names the file's own directory", () => {
		const session = savedSession(dirA);

		expect(inspectCopy(movedCopy(session, dirB).getSessionFile()!)).toEqual({
			state: "finished",
			sessionId: session.getSessionId(),
			parentFile: session.getSessionFile(),
			parentCwd: dirA,
		});
	});

	it("is finished in A after A to B to A, where both move entries are in the file", () => {
		const first = savedSession(dirA);
		const inB = movedCopy(first, dirB);
		rmSync(first.getSessionFile()!);
		const backInA = movedCopy(inB, dirA).getSessionFile()!;

		expect(moveEntriesOf(backInA).map((entry) => [entry.from, entry.to])).toEqual([
			[dirA, dirB],
			[dirB, dirA],
		]);
		expect(inspectCopy(backInA).state).toBe("finished");
	});

	it("is unfinished when a same-ID parent exists and no move entry was written", () => {
		const session = savedSession(dirA);
		const copy = sameIdCopy(session, dirB);

		expect(inspectCopy(copy.getSessionFile()!).state).toBe("unfinished");
	});

	it("is unfinished when the last move entry names another directory", () => {
		const session = savedSession(dirA);
		const inB = movedCopy(session, dirB);
		const dirC = join(root, "C");
		mkdirSync(dirC);
		const interrupted = sameIdCopy(inB, dirC);

		expect(inspectCopy(interrupted.getSessionFile()!).state).toBe("unfinished");
	});

	it("is ordinary for a stock fork of a moved session, which has a new ID", () => {
		const session = savedSession(dirA);
		const inB = movedCopy(session, dirB);
		const fork = SessionManager.forkFrom(inB.getSessionFile()!, dirB);

		expect(fork.getSessionId()).not.toBe(session.getSessionId());
		expect(inspectCopy(fork.getSessionFile()!).state).toBe("ordinary");
	});

	it("is ordinary with no parent, and once the parent file is gone", () => {
		const session = savedSession(dirA);
		const copy = movedCopy(session, dirB).getSessionFile()!;

		expect(inspectCopy(session.getSessionFile()!).state).toBe("ordinary");
		rmSync(session.getSessionFile()!);
		expect(inspectCopy(copy).state).toBe("ordinary");
	});

	it("is ordinary for a file that isn't a session", () => {
		writeFileSync(join(root, "notes.jsonl"), "not json\n");

		expect(inspectCopy(join(root, "notes.jsonl")).state).toBe("ordinary");
		expect(inspectCopy(join(root, "missing.jsonl")).state).toBe("ordinary");
	});
});

// ─── Exit hook ───────────────────────────────────────────────────────────────

describe("decideFailedSwitch", () => {
	const facts = { from: "/work/A", to: "/work/B", oldFile: "/s/--work-A--/old.jsonl", newFile: "/s/--work-B--/new.jsonl" };

	it("deletes the new file and prints the original's lines while the old file exists", () => {
		expect(decideFailedSwitch({ ...facts, hadSavedFile: true, oldFileExists: true })).toEqual({
			deleteNewFile: true,
			lines: ["/cd failed and Pi stopped. This conversation is saved in /work/A.", "Reopen it with:", "pi --session '/s/--work-A--/old.jsonl'"],
		});
	});

	it("deletes the new file and prints the nothing-saved line when nothing was ever saved", () => {
		expect(decideFailedSwitch({ ...facts, hadSavedFile: false, oldFileExists: false })).toEqual({
			deleteNewFile: true,
			lines: ["/cd failed and Pi stopped. Nothing in this conversation had been saved yet."],
		});
	});

	it("keeps the new file and prints the destination's lines when the old file is gone", () => {
		expect(decideFailedSwitch({ ...facts, hadSavedFile: true, oldFileExists: false })).toEqual({
			deleteNewFile: false,
			lines: ["/cd failed and Pi stopped. This conversation is saved in /work/B.", "Reopen it with:", "pi --session '/s/--work-B--/new.jsonl'"],
		});
	});

	it("quotes the reopen path so a shell reads it as one word", () => {
		expect(reopenCommand("/s/--a b--/x.jsonl")).toBe("pi --session '/s/--a b--/x.jsonl'");
		expect(reopenCommand("/s/--it's--/x.jsonl")).toBe(`pi --session '/s/--it'\\''s--/x.jsonl'`);
	});
});

// ─── The move, against a mocked switch ───────────────────────────────────────

describe("/cd move", () => {
	it("keeps the session ID, records the move from the re-created instance, retires the old file last, and reports once", async () => {
		const session = savedSession(dirA, { turns: 2 });
		const own = session.getSessionFile()!;
		const entries = readFileSync(own, "utf8").split("\n").slice(1).filter(Boolean);
		const harness = createHarness(session);
		let duringSwitch: { pending: unknown; cwd: string; oldFileExists: boolean } | undefined;
		harness.switchSession.mockImplementationOnce(async (file, options) => {
			duringSwitch = { pending: shared[CD_PENDING_MOVE_KEY], cwd: process.cwd(), oldFileExists: existsSync(own) };
			return harness.switchSession.getMockImplementation()!(file, options);
		});

		await harness.run(dirB);

		const moved = harness.switchSession.mock.calls[0][0];
		expect(duringSwitch).toEqual({
			pending: { file: moved, from: dirA, to: dirB, sessionId: session.getSessionId() },
			cwd: dirB,
			oldFileExists: true,
		});
		expect(dirname(moved)).toBe(defaultFolder(dirB));
		expect(headerOf(moved)).toMatchObject({ id: session.getSessionId(), cwd: dirB, parentSession: own });
		expect(readFileSync(moved, "utf8").split("\n").slice(1, 1 + entries.length)).toEqual(entries);
		expect(moveEntriesOf(moved)).toEqual([{ from: dirA, to: dirB, sessionId: session.getSessionId() }]);
		expect(harness.pi.appendEntry).not.toHaveBeenCalled();
		expect(trashed()).toEqual([basename(own)]);
		expect(existsSync(own)).toBe(false);
		expect(process.cwd()).toBe(dirB);
		expect(shared[CD_PENDING_MOVE_KEY]).toBeUndefined();
		expect(process.listeners("exit").filter((listener) => listener.name === "onFailedSwitchExit")).toEqual([]);
		// One outcome, one notification: through the new context, after the switch, never the old one.
		expect(harness.notify).not.toHaveBeenCalled();
		expect(harness.next!.notify.mock.calls).toEqual([[`Working directory changed to ${dirB}.`, "info"]]);
		expect(harness.next!.navigateTree).not.toHaveBeenCalled();
		expect(harness.setEditorText).not.toHaveBeenCalled();
	});

	it("restores a selected earlier entry through the new context", async () => {
		const session = savedSession(dirA, { turns: 3 });
		const selected = session.getEntries()[1].id;
		session.branch(selected);
		const harness = createHarness(session);

		await harness.run(dirB);

		expect(harness.next!.navigateTree.mock.calls).toEqual([[selected, { summarize: false }]]);
		expect(harness.navigateTree).not.toHaveBeenCalled();
		expect(harness.next!.notify.mock.calls).toEqual([[`Working directory changed to ${dirB}.`, "info"]]);
	});

	it.each<[string, (session: SessionManager) => void, (next: Harness) => void]>([
		["the user rewound to before the first message", (session) => session.resetLeaf(), () => {}],
		[
			"navigateTree throws",
			(session) => session.branch(session.getEntries()[1].id),
			(next) => next.navigateTree.mockRejectedValueOnce(new Error("raw detail")),
		],
		[
			"another extension cancels the navigation",
			(session) => session.branch(session.getEntries()[1].id),
			(next) => next.navigateTree.mockResolvedValueOnce({ cancelled: true }),
		],
	])("still moves and says so when the selected point can't be restored: %s", async (_name, select, prepareNext) => {
		const session = savedSession(dirA, { turns: 2 });
		const own = session.getSessionFile()!;
		select(session);
		const harness = createHarness(session, { prepareNext });

		await harness.run(dirB);

		expect(harness.next!.notify.mock.calls).toEqual([
			[
				`Working directory changed to ${dirB}. The selected point in the conversation could not be restored, so it continues from the latest message.`,
				"warning",
			],
		]);
		expect(trashed()).toEqual([basename(own)]);
	});

	it("names the old file when it can't be sent to the Trash, and still moves", async () => {
		const session = savedSession(dirA);
		const own = session.getSessionFile()!;
		const harness = createHarness(session);
		harness.switchSession.mockImplementationOnce(async (file, options) => {
			failTrash();
			return harness.switchSession.getMockImplementation()!(file, options);
		});

		await harness.run(dirB);

		expect(harness.next!.notify.mock.calls).toEqual([
			[`Working directory changed to ${dirB}. The previous session file could not be moved to the Trash: ${own}`, "warning"],
		]);
		expect(existsSync(own)).toBe(true);
	});

	it("never retires the old file unless the new file is the running session's", async () => {
		const session = savedSession(dirA);
		const own = session.getSessionFile()!;
		const harness = createHarness(session);
		// Pi says the switch happened, but hands back a session that isn't running from the new file.
		const elsewhere = createHarness(savedSession(dirB));
		harness.switchSession.mockImplementationOnce(async (_file, options) => {
			await options?.withSession?.(elsewhere.ctx);
			return { cancelled: false };
		});

		await harness.run(dirB);

		expect(existsSync(own)).toBe(true);
		expect(trashed()).toEqual([]);
		expect(elsewhere.notify.mock.calls).toEqual([
			[`Working directory changed to ${dirB}. The previous session file could not be moved to the Trash: ${own}`, "warning"],
		]);
	});

	it("says both in one message when the point isn't restored and the old file is left: restore first, path last", async () => {
		const session = savedSession(dirA, { turns: 2 });
		const own = session.getSessionFile()!;
		session.resetLeaf();
		const harness = createHarness(session);
		harness.switchSession.mockImplementationOnce(async (file, options) => {
			failTrash();
			return harness.switchSession.getMockImplementation()!(file, options);
		});

		await harness.run(dirB);

		expect(harness.next!.notify.mock.calls).toEqual([
			[
				`Working directory changed to ${dirB}. The selected point in the conversation could not be restored, so it continues from the latest message. The previous session file could not be moved to the Trash: ${own}`,
				"warning",
			],
		]);
	});

	it("checks idle once and reaches the switch without yielding, so nothing can start in between", async () => {
		const harness = createHarness(savedSession(dirA));

		const done = harness.run(dirB);

		// Still inside the same synchronous run of the handler: an `await` before the switch would fail this.
		expect(harness.switchSession).toHaveBeenCalledTimes(1);
		expect(harness.ctx.isIdle).toHaveBeenCalledTimes(1);
		await done;
		expect(harness.ctx.isIdle).toHaveBeenCalledTimes(1);
	});

	it("refuses a second /cd while the first is inside the switch", async () => {
		const harness = createHarness(savedSession(dirA));
		const switchNow = harness.switchSession.getMockImplementation()!;
		let release = () => {};
		harness.switchSession.mockImplementationOnce(async (file, options) => {
			await new Promise<void>((resolve) => (release = resolve));
			return switchNow(file, options);
		});

		const first = harness.run(dirB);
		await harness.run(dirB);
		release();
		await first;

		expect(harness.notify.mock.calls).toEqual([["A directory change is already in progress. Wait for it to finish, then retry /cd.", "warning"]]);
		expect(harness.switchSession).toHaveBeenCalledTimes(1);
		expect(harness.next!.notify.mock.calls).toEqual([[`Working directory changed to ${dirB}.`, "info"]]);
		expect(shared[CD_PENDING_MOVE_KEY]).toBeUndefined();
	});

	it("refuses a /cd typed into the new session while the first is still restoring the branch point", async () => {
		const session = savedSession(dirA, { turns: 3 });
		session.branch(session.getEntries()[1].id);
		let release = () => {};
		const harness = createHarness(session, {
			prepareNext: (next) =>
				next.navigateTree.mockImplementationOnce(async () => {
					await new Promise<void>((resolve) => (release = resolve));
					return { cancelled: false };
				}),
		});

		const first = harness.run(dirB);
		await vi.waitFor(() => expect(harness.next?.navigateTree).toHaveBeenCalled());
		// The re-created extension instance: it shares nothing with the first but the process.
		await harness.next!.run(dirA);
		release();
		await first;

		expect(harness.next!.notify.mock.calls).toEqual([
			["A directory change is already in progress. Wait for it to finish, then retry /cd.", "warning"],
			[`Working directory changed to ${dirB}.`, "info"],
		]);
		expect(harness.next!.switchSession).not.toHaveBeenCalled();
		expect(shared[CD_PENDING_MOVE_KEY]).toBeUndefined();
	});

	it("leaves the conversation in the original directory when another extension cancels the switch", async () => {
		const session = savedSession(dirA);
		const own = session.getSessionFile()!;
		const bytes = readFileSync(own);
		const harness = createHarness(session);
		harness.switchSession.mockResolvedValueOnce({ cancelled: true });

		await harness.run(dirB);

		expect(harness.notify.mock.calls).toEqual([[`Directory change cancelled. Working directory is still ${dirA}.`, "info"]]);
		expect(harness.setEditorText.mock.calls).toEqual([[`/cd ${dirB}`]]);
		expect(sessionFilesIn(defaultFolder(dirB))).toEqual([]);
		expect(readFileSync(own).equals(bytes)).toBe(true);
		expect(trashed()).toEqual([]);
		expect(process.cwd()).toBe(dirA);
		expect(shared[CD_PENDING_MOVE_KEY]).toBeUndefined();
		expect(process.listeners("exit").filter((listener) => listener.name === "onFailedSwitchExit")).toEqual([]);
	});

	const reopenLines = (dir: string, file: string) => `\n/cd failed and Pi stopped. This conversation is saved in ${dir}.\nReopen it with:\npi --session '${file}'\n`;
	const printed = () => printedAtExit.map((text) => text.replaceAll("\r\x1b[K", ""));

	it("deletes the new file and prints the reopen lines when Pi exits inside the switch", async () => {
		const session = savedSession(dirA);
		const own = session.getSessionFile()!;
		const bytes = readFileSync(own);
		const harness = createHarness(session);
		let atExit: { newFiles: string[]; hooks: number } | undefined;
		harness.switchSession.mockImplementationOnce(async () => {
			// Pi's fatal handler calls `process.exit(1)` here: the hook runs and nothing after the switch does.
			const hooks = exitHooks();
			for (const hook of hooks) hook();
			atExit = { newFiles: sessionFilesIn(defaultFolder(dirB)), hooks: hooks.length };
			return new Promise<never>(() => {});
		});

		void harness.run(dirB);
		await vi.waitFor(() => expect(atExit).toBeDefined());

		expect(atExit).toEqual({ newFiles: [], hooks: 1 });
		expect(printed()).toEqual([reopenLines(dirA, own)]);
		expect(readFileSync(own).equals(bytes)).toBe(true);
		expect(trashed()).toEqual([]);
		delete shared[CD_PENDING_MOVE_KEY];
	});

	it("cleans up at once when the switch error is handed back instead of ending Pi", async () => {
		const session = savedSession(dirA);
		const own = session.getSessionFile()!;
		const bytes = readFileSync(own);
		const harness = createHarness(session);
		harness.switchSession.mockRejectedValueOnce(new Error("ENOENT: no such file or directory, uv_cwd"));

		await expect(harness.run(dirB)).rejects.toThrow("uv_cwd");

		expect(sessionFilesIn(defaultFolder(dirB))).toEqual([]);
		expect(readFileSync(own).equals(bytes)).toBe(true);
		expect(trashed()).toEqual([]);
		expect(process.cwd()).toBe(dirA);
		expect(shared[CD_PENDING_MOVE_KEY]).toBeUndefined();
		expect(harness.notify).not.toHaveBeenCalled();
		expect(printed()).toEqual([]);
	});

	it.each([
		["at the end of the window, Pi's exit still prints the reopen lines", FAILED_SWITCH_EXIT_WINDOW_MS, true],
		["a millisecond past it, the hook does nothing: Pi lived on, and this exit isn't the failed switch's", FAILED_SWITCH_EXIT_WINDOW_MS + 1, false],
	])("after a switch error that reached /cd: %s", async (_name, elapsed, prints) => {
		const session = savedSession(dirA);
		const harness = createHarness(session);
		let newFile = "";
		harness.switchSession.mockImplementationOnce(async (file) => {
			newFile = file;
			throw new Error("ENOENT: no such file or directory, uv_cwd");
		});
		await expect(harness.run(dirB)).rejects.toThrow("uv_cwd");
		// Something at the new file's path that the hook would delete if it acted.
		writeFileSync(newFile, "not ours to remove once the window has passed\n");

		expect(FAILED_SWITCH_EXIT_WINDOW_MS).toBe(10_000);
		clock.now += elapsed;
		for (const hook of exitHooks()) hook();

		expect(exitHooks()).toHaveLength(1);
		expect(printed()).toEqual(prints ? [reopenLines(dirA, session.getSessionFile()!)] : []);
		expect(existsSync(newFile)).toBe(!prints);
	});

	it("moves a conversation that has only run a ! command as a new session: Pi saves no file for one", async () => {
		const fresh = SessionManager.create(dirA);
		fresh.appendMessage({ role: "bashExecution", command: "pwd", output: `${dirA}\n`, exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now() } as any);
		const harness = createHarness(fresh);

		await harness.run(dirB);

		expect(existsSync(fresh.getSessionFile()!)).toBe(false);
		expect(harness.notify).not.toHaveBeenCalled();
		expect(harness.next!.notify.mock.calls).toEqual([[`Working directory changed to ${dirB}.`, "info"]]);
	});

	it("moves a conversation with nothing saved yet as a new session, and records the new session's ID", async () => {
		const fresh = SessionManager.create(dirA);
		const planned = fresh.getSessionFile()!;
		const harness = createHarness(fresh);

		await harness.run(dirB);

		const target = harness.switchSession.mock.calls[0][0];
		const opened = harness.next!.ctx.sessionManager;
		expect(existsSync(planned)).toBe(false);
		expect(dirname(target)).toBe(defaultFolder(dirB));
		expect(opened.getSessionId()).not.toBe(fresh.getSessionId());
		expect(opened.getEntries().filter((entry) => entry.type === "custom").map((entry: any) => entry.data)).toEqual([
			{ from: dirA, to: dirB, sessionId: opened.getSessionId() },
		]);
		expect(harness.next!.navigateTree).not.toHaveBeenCalled();
		expect(trashed()).toEqual([]);
		expect(harness.next!.notify.mock.calls).toEqual([[`Working directory changed to ${dirB}.`, "info"]]);
	});

	it("carries the picked model and thinking level into the new session when nothing was saved, model first", async () => {
		const harness = createHarness(SessionManager.create(dirA));

		await harness.run(dirB);

		const next = harness.next!.calls;
		expect(next.setModel.mock.calls).toEqual([[{ provider: "picked-provider", id: "picked-model", found: true }]]);
		expect(next.setThinkingLevel.mock.calls).toEqual([["high"]]);
		expect(next.setModel.mock.invocationCallOrder[0]).toBeLessThan(next.setThinkingLevel.mock.invocationCallOrder[0]);
		expect(harness.calls.setModel).not.toHaveBeenCalled();
	});

	it("leaves the model and thinking level to the copied entries when the conversation was saved", async () => {
		const harness = createHarness(savedSession(dirA));

		await harness.run(dirB);

		expect(harness.next!.calls.setModel).not.toHaveBeenCalled();
		expect(harness.next!.calls.setThinkingLevel).not.toHaveBeenCalled();
	});

	it.each<[string, (next: Harness) => void, number]>([
		["the model can't be selected", (next) => next.calls.setModel.mockRejectedValueOnce(new Error("No API key")), 1],
		["the model is no longer registered", (next) => ((next.ctx as any).modelRegistry.find = () => undefined), 0],
		[
			"the thinking level is refused",
			(next) =>
				next.calls.setThinkingLevel.mockImplementationOnce(() => {
					throw new Error("raw detail");
				}),
			1,
		],
	])("still moves, and still tries the other half of the pick, when %s", async (_name, prepareNext, setModelCalls) => {
		const harness = createHarness(SessionManager.create(dirA), { prepareNext });

		await harness.run(dirB);

		expect(harness.next!.calls.setModel).toHaveBeenCalledTimes(setModelCalls);
		expect(harness.next!.calls.setThinkingLevel).toHaveBeenCalledTimes(1);
		expect(harness.next!.notify.mock.calls).toEqual([[`Working directory changed to ${dirB}.`, "info"]]);
		expect(inMemoryMoveEntries(harness.next!)).toEqual([{ from: dirA, to: dirB, sessionId: harness.next!.ctx.sessionManager.getSessionId() }]);
	});
});

/** Move entries of a session that may not have been written to disk yet. */
function inMemoryMoveEntries(harness: Harness): unknown[] {
	return harness.ctx.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === CD_MOVE_ENTRY_TYPE)
		.map((entry) => (entry as { data?: unknown }).data);
}

// ─── Leftovers, found when a session opens ───────────────────────────────────

describe("leftover check on session_start", () => {
	const start = async (harness: Harness) => {
		await harness.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, harness.ctx);
		await vi.runAllTimersAsync();
	};

	beforeEach(() => {
		// Only the timers: the fixtures above need a real clock to tell two files apart.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("retires a finished move's old file when it holds nothing this file lacks", async () => {
		const old = savedSession(dirA);
		const harness = createHarness(movedCopy(old, dirB));

		await start(harness);

		expect(trashed()).toEqual([basename(old.getSessionFile()!)]);
		expect(harness.notify).not.toHaveBeenCalled();
	});

	it("warns and deletes nothing when the old file has turns this one doesn't", async () => {
		const old = savedSession(dirA);
		const moved = movedCopy(old, dirB);
		addTurn(old, "one more turn in the old copy");
		const harness = createHarness(moved);

		await start(harness);

		expect(harness.notify.mock.calls).toEqual([
			[
				`An older copy of this conversation has turns this one doesn't. Nothing was deleted. The older copy: ${old.getSessionFile()}`,
				"warning",
			],
		]);
		expect(trashed()).toEqual([]);
		expect(existsSync(old.getSessionFile()!)).toBe(true);
	});

	it("warns when an unfinished copy is opened directly, with the command that reopens the original alone on a second line", async () => {
		const old = savedSession(dirA);
		const unfinished = sameIdCopy(old, dirB);
		const harness = createHarness(unfinished);

		await start(harness);

		expect(harness.notify.mock.calls).toEqual([
			[
				`This is an unfinished copy from an interrupted /cd. The conversation is saved in ${dirA}. Quit Pi, go to that directory, and run:\npi --session ${old.getSessionId()}`,
				"warning",
			],
		]);
		expect(trashed()).toEqual([]);
	});

	it("shows its warning only after the caller's turn, so Pi can draw the conversation first", async () => {
		const old = savedSession(dirA);
		const harness = createHarness(sameIdCopy(old, dirB));

		await harness.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, harness.ctx);
		expect(harness.notify).not.toHaveBeenCalled();
		await vi.runAllTimersAsync();

		expect(harness.notify).toHaveBeenCalledOnce();
	});

	it("does nothing for a session that isn't being saved, even while a move is pending elsewhere", async () => {
		const harness = createHarness(SessionManager.inMemory(dirA));
		shared[CD_PENDING_MOVE_KEY] = { file: join(root, "elsewhere.jsonl"), from: dirA, to: dirB, sessionId: "other" };

		await expect(start(harness)).resolves.toBeUndefined();

		expect(harness.notify).not.toHaveBeenCalled();
		expect(harness.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("does nothing for an ordinary session, and nothing for the file a pending move names", async () => {
		const old = savedSession(dirA);
		const ordinary = createHarness(old);
		await start(ordinary);
		expect(ordinary.notify).not.toHaveBeenCalled();
		expect(ordinary.pi.appendEntry).not.toHaveBeenCalled();

		const copy = sameIdCopy(old, dirB);
		shared[CD_PENDING_MOVE_KEY] = { file: copy.getSessionFile(), from: dirA, to: dirB, sessionId: old.getSessionId() };
		const moving = createHarness(copy);
		await start(moving);

		expect(moving.notify).not.toHaveBeenCalled();
		expect(moveEntriesOf(copy.getSessionFile()!)).toEqual([{ from: dirA, to: dirB, sessionId: old.getSessionId() }]);
		expect(trashed()).toEqual([]);

		// Another session that starts while that move is pending isn't the move's, and gets none of its entry or pick.
		const bystander = createHarness(savedSession(dirA));
		await start(bystander);
		expect(bystander.pi.appendEntry).not.toHaveBeenCalled();
		expect(bystander.calls.setThinkingLevel).not.toHaveBeenCalled();
	});
});
