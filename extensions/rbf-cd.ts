import { spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmdirSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir, parseArgs, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionHeader } from "@earendil-works/pi-coding-agent";

// `/cd <path>` moves the running conversation to another directory: it writes the conversation into a new session file
// for the destination under the same session ID, switches Pi to it, then sends the old file to the Trash. Three Pi facts:
// - A switch that throws ends an interactive Pi before any `catch` here runs, so an exit hook cleans up and prints how to reopen.
// - The switch re-creates every extension, and the old `pi` and command `ctx` throw afterwards. Only plain data on `globalThis` survives.
// - Pi paints "Resumed session" when the switch resolves, and an informational notification replaces the one before it.

export const CD_COMMAND_NAME = "cd";
export const CD_COMMAND_DESCRIPTION = "Change this session's working directory.";
const CD_USAGE = "Usage: /cd <path>";

/** One per finished move, in the new file. Read in file order, last one wins. */
export const CD_MOVE_ENTRY_TYPE = "rbf-cd-move/v1";
export type MoveEntry = { from: string; to: string; sessionId: string };

const CODEX_THREAD_ENTRY_TYPE = "rbf-codex-thread/v1";

/** Answered by `rbf-background-tasks.ts`, which fills the payload in before `emit` returns. */
export const CD_BUSY_QUERY_CHANNEL = "rbf-background-tasks:busy/v1";
export type BusyQuery = { answered?: boolean; backgroundTask?: boolean; command?: boolean; watch?: boolean };

/** The move in flight, from just before the switch until `/cd` returns. The re-created extension instance reads it. */
export const CD_PENDING_MOVE_KEY = Symbol.for("rbf.cd.pendingMove");
export type PendingMove = {
	file: string;
	from: string;
	to: string;
	sessionId: string;
	/** Only when nothing was saved yet: no copied entry carries the pick then. */
	model?: { provider: string; id: string };
	thinkingLevel?: string;
};

/** A switch error that reaches `catch` means Pi may live on. Its exit counts as the failed switch's only this long after. */
export const FAILED_SWITCH_EXIT_WINDOW_MS = 10_000;

export type CdDeps = { now: () => number; printAtExit: (text: string) => void };
const DEFAULT_DEPS: CdDeps = {
	now: Date.now,
	printAtExit: (text) => {
		writeSync(2, text);
	},
};

// ─── Copy ────────────────────────────────────────────────────────────────────
// Exact, from the brief's Content Design. Pi adds `Warning: ` and `Error: ` itself.

const REASON_NOT_WRITTEN = "the session file could not be written";
const REASON_COPY_EXISTS = "this conversation already has a copy there";
const REASON_FILE_MISSING = "this conversation's session file is missing";
const NOT_RESTORED = "The selected point in the conversation could not be restored, so it continues from the latest message.";

const COPY = {
	noArgument: (path: string) => `Working directory: ${path}\n${CD_USAGE}`,
	moved: (path: string) => `Working directory changed to ${path}.`,
	sameDirectory: (path: string) => `Already working in ${path}.`,
	busyResponse: "Can't change directory while a response or compaction is running. Finish or stop it, then retry /cd.",
	busyMove: "A directory change is already in progress. Wait for it to finish, then retry /cd.",
	busyBackgroundTask: "Can't change directory while a background task is running. Finish or stop it, then retry /cd.",
	busyWatch: "Can't change directory while a watch is running. Stop it with /monitors stop all, then retry /cd.",
	busyCommand: "Can't change directory while a command is running. Wait for it to finish or stop it, then retry /cd.",
	pathMissing: (path: string) => `Can't change directory: path does not exist: ${path}.`,
	pathNotDirectory: (path: string) => `Can't change directory: not a directory: ${path}.`,
	pathDenied: (path: string) => `Can't change directory: access denied: ${path}.`,
	pathQuote: "Can't change directory: unmatched outer quote. Use /cd <path>.",
	codex: (path: string) => `Can't change directory: /cd doesn't support Codex conversations yet. Working directory is still ${path}.`,
	sandbox: (path: string) => `Can't change directory in a sandboxed session. Working directory is still ${path}.`,
	notSaved: (path: string) => `Can't change directory in a session that isn't being saved. Working directory is still ${path}.`,
	noAnswer: (path: string) =>
		`Can't change directory: the background-tasks extension didn't answer, so /cd can't tell whether a command is running. Working directory is still ${path}.`,
	notInteractive: "/cd works in interactive mode only.",
	cancelled: (path: string) => `Directory change cancelled. Working directory is still ${path}.`,
	refused: (reason: string, path: string) => `Can't change directory: ${reason}. Working directory is still ${path}.`,
	failedSwitch: (path: string, file: string) => [`/cd failed and Pi stopped. This conversation is saved in ${path}.`, "Reopen it with:", reopenCommand(file)],
	failedSwitchNothingSaved: "/cd failed and Pi stopped. Nothing in this conversation had been saved yet.",
	trashLeft: (oldFile: string) => `The previous session file could not be moved to the Trash: ${oldFile}`,
	olderCopy: (oldFile: string) => `An older copy of this conversation has turns this one doesn't. Nothing was deleted. The older copy: ${oldFile}`,
	// Pi hard-wraps a notification, so a file path would break mid-word. The session ID fits on a line of its own.
	unfinishedCopy: (path: string, sessionId: string) =>
		`This is an unfinished copy from an interrupted /cd. The conversation is saved in ${path}. Quit Pi, go to that directory, and run:\npi --session ${sessionId}`,
};

type Level = "info" | "warning" | "error";
type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];
type Refusal = { copy: string; level: Level };

/** `pi --session '<file>'`, quoted so a shell reads the path as one word. */
export function reopenCommand(file: string): string {
	return `pi --session '${file.replaceAll("'", "'\\''")}'`;
}

// ─── Path ────────────────────────────────────────────────────────────────────

export type ResolvedPath = { ok: true; path: string } | { ok: false; copy: string };

/** One literal path, never a shell: `$VAR`, `$(…)`, globs and operators are ordinary characters in a name. */
export function resolveCdPath(argument: string, cwd: string, home = homedir()): ResolvedPath {
	let typed = argument.trim();
	const isQuote = (char: string | undefined) => char === '"' || char === "'";
	if (isQuote(typed[0]) || isQuote(typed.at(-1))) {
		if (typed.length < 2 || typed[0] !== typed.at(-1)) return { ok: false, copy: COPY.pathQuote };
		typed = typed.slice(1, -1);
	}
	if (typed === "~") typed = home;
	else if (typed.startsWith("~/")) typed = join(home, typed.slice(2));
	const full = resolve(cwd, typed);

	let path: string;
	try {
		path = realpathSync(full);
		if (!statSync(path).isDirectory()) return { ok: false, copy: COPY.pathNotDirectory(full) };
		accessSync(path, constants.R_OK | constants.X_OK);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		return { ok: false, copy: code === "EACCES" || code === "EPERM" ? COPY.pathDenied(full) : COPY.pathMissing(full) };
	}
	return { ok: true, path };
}

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

// ─── Session files ───────────────────────────────────────────────────────────
// A file belongs to a session by the `id` in its header line, never by its name.

/** Reads only the first line: session files grow large. */
function readHeader(file: string): SessionHeader | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const chunks: Buffer[] = [];
		for (let size = 0; size < 1024 * 1024; ) {
			const chunk = Buffer.alloc(64 * 1024);
			const read = readSync(fd, chunk);
			chunks.push(chunk.subarray(0, read));
			size += read;
			if (read === 0 || chunk.includes(0x0a)) break;
		}
		const header = JSON.parse(Buffer.concat(chunks).toString("utf8").split("\n")[0]);
		return header?.type === "session" && typeof header.id === "string" ? header : undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** A line that isn't an entry comes back `undefined`, so no caller can mistake it for one it knows. */
function readEntries(file: string): ({ id?: string; type?: string; customType?: string; data?: unknown } | undefined)[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.slice(1)
		.filter((line) => line.trim())
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return undefined;
			}
		});
}

export type Copy =
	| { state: "ordinary" } // no parentSession, or the parent file is gone, or it has another session ID
	| { state: "finished" | "unfinished"; sessionId: string; parentFile: string; parentCwd: string };

/** `finished` when the file's last move entry names its own directory, `unfinished` when a same-ID parent exists and it doesn't. */
export function inspectCopy(file: string): Copy {
	const header = readHeader(file);
	const parentFile = header?.parentSession;
	const parent = parentFile ? readHeader(parentFile) : undefined;
	if (!header || !parentFile || parent?.id !== header.id) return { state: "ordinary" };

	const lastMove = readEntries(file)
		.filter((entry) => entry?.type === "custom" && entry.customType === CD_MOVE_ENTRY_TYPE)
		.at(-1);
	const state = (lastMove?.data as MoveEntry | undefined)?.to === header.cwd ? "finished" : "unfinished";
	return { state, sessionId: header.id, parentFile, parentCwd: parent.cwd };
}

function holdsNothingNew(file: string, knownIds: ReadonlySet<string>): boolean {
	try {
		return readEntries(file).every((entry) => typeof entry?.id === "string" && knownIds.has(entry.id));
	} catch {
		return false;
	}
}

function findSessionCopies(folder: string, sessionId: string, ownFile: string): string[] {
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => join(folder, name))
		.filter((file) => canonical(file) !== canonical(ownFile) && readHeader(file)?.id === sessionId);
}

function moveToTrash(file: string): boolean {
	try {
		const result = spawnSync("trash", [file], { stdio: "ignore", timeout: 10_000 });
		return result.status === 0 && !existsSync(file);
	} catch {
		return false;
	}
}

/** The same-ID rule: every copy is judged before any is touched. One that holds more, or won't go to the Trash, refuses the move. */
function clearDestinationCopies(folder: string, sessionId: string, ownFile: string, knownIds: ReadonlySet<string>): boolean {
	const copies = findSessionCopies(folder, sessionId, ownFile);
	return copies.every((copy) => holdsNothingNew(copy, knownIds)) && copies.every((copy) => moveToTrash(copy));
}

/** Pi's default folder for the destination, unless the session's own file sits outside its default, as with `--session-dir`. Then that folder. */
function pickSessionFolder(ownFile: string, sessionCwd: string, destination: string): string {
	// Pi only says where a directory's default folder is by creating it. One created for nothing goes again below.
	const defaultFolder = (cwd: string) => SessionManager.create(cwd).getSessionDir();
	const ownFolder = dirname(ownFile);
	const sessionsRoot = join(getAgentDir(), "sessions");
	const before = new Set(existsSync(sessionsRoot) ? readdirSync(sessionsRoot) : []);
	const ownDefault = defaultFolder(sessionCwd);
	if (canonical(ownFolder) === canonical(ownDefault)) return defaultFolder(destination);

	if (resolve(dirname(ownDefault)) === resolve(sessionsRoot) && !before.has(basename(ownDefault))) {
		try {
			rmdirSync(ownDefault);
		} catch {}
	}
	return ownFolder;
}

// ─── Refusals ────────────────────────────────────────────────────────────────

/** `pi.getFlag` only sees flags the calling extension registered, so this parses the launch arguments as `rbf-sandbox/launch-authority.ts` does. */
export function launchedWithSandbox(argv: readonly string[] = process.argv): boolean {
	return parseArgs([...argv.slice(2)]).unknownFlags.has("sandbox");
}

/** Print, JSON and RPC modes don't exit when a switch throws, and the failure path relies on that exit. */
function isInteractive(ctx: ExtensionContext): boolean {
	return ctx.hasUI === true && (ctx.mode === undefined || ctx.mode === "tui");
}

// ─── Failed switch ───────────────────────────────────────────────────────────

export type FailedSwitchFacts = { from: string; to: string; oldFile: string; newFile: string; hadSavedFile: boolean; oldFileExists: boolean };

/** The new file is deleted only while the conversation is safe elsewhere, or when there was never anything to save. */
export function decideFailedSwitch(facts: FailedSwitchFacts): { deleteNewFile: boolean; lines: string[] } {
	if (!facts.hadSavedFile) return { deleteNewFile: true, lines: [COPY.failedSwitchNothingSaved] };
	if (facts.oldFileExists) return { deleteNewFile: true, lines: COPY.failedSwitch(facts.from, facts.oldFile) };
	return { deleteNewFile: false, lines: COPY.failedSwitch(facts.to, facts.newFile) };
}

// ─── Extension Entry Point ───────────────────────────────────────────────────

export function createRbfCd(deps: CdDeps = DEFAULT_DEPS): (pi: ExtensionAPI) => void {
	return (pi) => rbfCd(pi, deps);
}

export default createRbfCd();

function rbfCd(pi: ExtensionAPI, deps: CdDeps): void {
	const shared = globalThis as { [CD_PENDING_MOVE_KEY]?: PendingMove };

	function findRefusal(ctx: ExtensionCommandContext): Refusal | undefined {
		const warn = (copy: string): Refusal => ({ copy, level: "warning" });
		// False during a response and during a compaction. Pi offers nothing that tells them apart.
		if (!ctx.isIdle()) return warn(COPY.busyResponse);
		if (shared[CD_PENDING_MOVE_KEY]) return warn(COPY.busyMove);
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return warn(COPY.notSaved(ctx.cwd));

		// Pi 1.0.2 writes the file with the first user or assistant message, 0.85.1 with the first assistant message.
		// A session that has one and no file has lost it, and a move would replace the only copy left with an empty session.
		const entries = ctx.sessionManager.getEntries();
		const hasConversation = entries.some((entry) => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"));
		if (hasConversation && !existsSync(file)) return { copy: COPY.refused(REASON_FILE_MISSING, ctx.cwd), level: "error" };

		// `isIdle()` is true while a `!` command runs, and the switch would abort it. No answer: the extension is missing or older.
		const busy: BusyQuery = {};
		pi.events.emit(CD_BUSY_QUERY_CHANNEL, busy);
		if (!busy.answered) return warn(COPY.noAnswer(ctx.cwd));
		if (busy.backgroundTask) return warn(COPY.busyBackgroundTask);
		if (busy.watch) return warn(COPY.busyWatch);
		if (busy.command) return warn(COPY.busyCommand);

		if (entries.some((entry) => entry.type === "custom" && entry.customType === CODEX_THREAD_ENTRY_TYPE)) return warn(COPY.codex(ctx.cwd));
		// `pi-23`'s sandbox fails closed when its directory changes.
		if (launchedWithSandbox()) return warn(COPY.sandbox(ctx.cwd));
		return undefined;
	}

	function checkLeftover(file: string, ctx: ExtensionContext): void {
		const copy = inspectCopy(file);
		if (copy.state === "ordinary") return;

		let warning: string;
		if (copy.state === "finished") {
			const knownIds = new Set(ctx.sessionManager.getEntries().map((entry) => entry.id));
			if (holdsNothingNew(copy.parentFile, knownIds)) {
				moveToTrash(copy.parentFile);
				return;
			}
			warning = COPY.olderCopy(copy.parentFile);
		} else {
			warning = COPY.unfinishedCopy(copy.parentCwd, copy.sessionId);
		}
		// On process start Pi draws the conversation right after `session_start`, so a warning sent now would scroll above it.
		const timer = setTimeout(() => {
			try {
				ctx.ui.notify(warning, "warning");
			} catch {}
		}, 0);
		timer.unref?.();
	}

	pi.on("session_start", async (_event, ctx) => {
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return;

		const pending = shared[CD_PENDING_MOVE_KEY];
		if (!pending || canonical(pending.file) !== canonical(file)) {
			try {
				checkLeftover(file, ctx);
			} catch {}
			return;
		}
		// The old `pi` is dead, so the instance the move created writes the entry, with its own session's ID: a fresh move got a new one.
		try {
			pi.appendEntry<MoveEntry>(CD_MOVE_ENTRY_TYPE, { from: pending.from, to: pending.to, sessionId: ctx.sessionManager.getSessionId() });
		} catch {}
		// Model first: a model change resets the thinking level. A pick that can't be put back never fails the move.
		try {
			const model = pending.model && ctx.modelRegistry.find(pending.model.provider, pending.model.id);
			if (model) await pi.setModel(model);
		} catch {}
		try {
			if (pending.thinkingLevel) pi.setThinkingLevel(pending.thinkingLevel as ThinkingLevel);
		} catch {}
	});

	pi.registerCommand(CD_COMMAND_NAME, {
		description: CD_COMMAND_DESCRIPTION,
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			if (!isInteractive(ctx)) {
				ctx.ui.notify(COPY.notInteractive, "warning");
				return;
			}
			const from = ctx.cwd;
			if (!args.trim()) {
				ctx.ui.notify(COPY.noArgument(from), "info");
				return;
			}
			const refuse = ({ copy, level }: Refusal): void => {
				ctx.ui.notify(copy, level);
				ctx.ui.setEditorText(`/${CD_COMMAND_NAME} ${args}`);
			};

			const resolved = resolveCdPath(args, from);
			if (!resolved.ok) return refuse({ copy: resolved.copy, level: "error" });
			const to = resolved.path;
			if (to === canonical(from)) {
				ctx.ui.notify(COPY.sameDirectory(to), "info");
				return;
			}
			// Idle is checked once. From here to the `ctx.switchSession` call in `move` nothing awaits, so nothing
			// can start in between. Keep it that way: an `await` on that path needs a second check after it.
			const refusal = findRefusal(ctx);
			if (refusal) return refuse(refusal);

			try {
				await move(ctx, from, to, refuse);
			} finally {
				delete shared[CD_PENDING_MOVE_KEY];
			}
		},
	});

	async function move(ctx: ExtensionCommandContext, from: string, to: string, refuse: (refusal: Refusal) => void): Promise<void> {
		const manager = ctx.sessionManager;
		const oldFile = manager.getSessionFile()!;
		const sessionId = manager.getSessionId();
		// No file means nothing is saved yet: `findRefusal` has ruled out a file that went missing.
		const hadSavedFile = existsSync(oldFile);
		const entries = manager.getEntries();
		const selected = manager.getLeafId();
		const selectedIsLast = selected === (entries.at(-1)?.id ?? null);

		let folder: string;
		try {
			folder = pickSessionFolder(oldFile, manager.getCwd(), to);
		} catch {
			return refuse({ copy: COPY.refused(REASON_NOT_WRITTEN, from), level: "error" });
		}
		if (!clearDestinationCopies(folder, sessionId, oldFile, new Set(entries.map((entry) => entry.id)))) {
			return refuse({ copy: COPY.refused(REASON_COPY_EXISTS, from), level: "error" });
		}

		let newFile: string;
		try {
			// Pi opens a missing path as a new session, with a new ID, in the process directory. So a conversation
			// with nothing saved lands in the destination only because the process directory changes below.
			const written = hadSavedFile ? SessionManager.forkFrom(oldFile, to, folder, { id: sessionId }) : SessionManager.create(to, folder);
			const file = written.getSessionFile();
			if (!file) throw new Error("Pi gave the new session no file");
			newFile = file;
		} catch {
			// The check above left no copy in the folder, so one that is there now is a half-written file of ours.
			for (const partial of findSessionCopies(folder, sessionId, oldFile)) rmSync(partial, { force: true });
			return refuse({ copy: COPY.refused(REASON_NOT_WRITTEN, from), level: "error" });
		}
		const removeNewFile = (): void => rmSync(newFile, { force: true });

		// Other extensions read the process directory, so it moves with the session and moves back on a cancel.
		const processDir = process.cwd();
		const backToOrigin = (): void => {
			try {
				process.chdir(processDir);
			} catch {}
			removeNewFile();
		};
		const failedSwitch = () => decideFailedSwitch({ from, to, oldFile, newFile, hadSavedFile, oldFileExists: existsSync(oldFile) });
		let caughtAt: number | undefined;
		const onFailedSwitchExit = (): void => {
			try {
				if (caughtAt !== undefined && deps.now() - caughtAt > FAILED_SWITCH_EXIT_WINDOW_MS) return;
				const decision = failedSwitch();
				if (decision.deleteNewFile) removeNewFile();
				// Each line starts on a cleared row: Pi 1.0.2 can stop with part of its last frame still under the cursor.
				const clear = process.stderr.isTTY ? "\r\x1b[K" : "";
				deps.printAtExit(`\n${decision.lines.map((line) => clear + line).join("\n")}\n${clear}`);
			} catch {}
		};

		const pick = hadSavedFile ? {} : { model: ctx.model && { provider: ctx.model.provider, id: ctx.model.id }, thinkingLevel: pi.getThinkingLevel() };
		shared[CD_PENDING_MOVE_KEY] = { file: newFile, from, to, sessionId, ...pick };
		process.once("exit", onFailedSwitchExit);
		const next: { ctx?: ExtensionCommandContext } = {};
		let cancelled: boolean;
		try {
			process.chdir(to);
			({ cancelled } = await ctx.switchSession(newFile, {
				// Nothing here may throw: a throw inside `withSession` ends Pi like any other failed switch.
				withSession: async (replaced) => {
					next.ctx = replaced;
				},
			}));
			process.removeListener("exit", onFailedSwitchExit);
		} catch (error) {
			// Pi normally exits inside the switch and never gets here. Pi 1.0.2 does when its own fatal handler throws, as with
			// a destination deleted mid-switch, and stops a moment later. So the hook stays armed, but only for that moment.
			caughtAt = deps.now();
			if (failedSwitch().deleteNewFile) backToOrigin();
			throw error;
		}

		if (cancelled) {
			// Another extension's `session_before_switch` said no. The old `ctx` is still valid here.
			backToOrigin();
			return refuse({ copy: COPY.cancelled(from), level: "info" });
		}

		// Three steps, each catching its own error, so a failed restore can't skip the Trash step or the message.
		let restored = true;
		if (hadSavedFile && !selectedIsLast) {
			// The new file opens at its last entry. A session rewound to before its very first entry has none to select.
			restored = false;
			try {
				if (selected && next.ctx) restored = !(await next.ctx.navigateTree(selected, { summarize: false })).cancelled;
			} catch {}
		}

		let leftBehind: string | undefined;
		if (hadSavedFile && existsSync(oldFile)) {
			// The one destructive step, last, and only once the new file is the running session's.
			const running = canonical(next.ctx?.sessionManager.getSessionFile() ?? "") === canonical(newFile) && existsSync(newFile);
			if (!running || !moveToTrash(oldFile)) leftBehind = oldFile;
		}

		const sentences = [COPY.moved(to), ...(restored ? [] : [NOT_RESTORED]), ...(leftBehind ? [COPY.trashLeft(leftBehind)] : [])];
		try {
			next.ctx?.ui.notify(sentences.join(" "), sentences.length > 1 ? "warning" : "info");
		} catch {}
	}
}
