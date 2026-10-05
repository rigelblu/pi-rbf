import { spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmdirSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir, parseArgs, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionHeader } from "@earendil-works/pi-coding-agent";

// `/cd <path>` moves the running conversation to another directory inside the running Pi.
// The session file is the only record of a session's directory, so the move writes the
// conversation into a new file whose header names the destination, under the same session ID
// (`SessionManager.forkFrom`), switches Pi to it (`ctx.switchSession`), and only then sends the
// old file to the Trash. Stock Pi reopens the new file in the destination with no help from us.
//
// Three facts about Pi shape everything below:
// - A switch that throws ends an interactive Pi with exit code 1 before any `catch` here runs,
//   so a `process.once("exit")` hook does the cleanup and prints how to reopen the conversation.
// - Every extension is re-created on the switch and the old `pi` and command `ctx` throw
//   afterwards. Only plain data on `globalThis` survives, so the re-created instance appends the
//   move entry on `session_start`, and `withSession` does nothing but hand the new `ctx` back.
// - Pi paints "Resumed session" when the switch resolves, and one informational notification
//   replaces the one before it. So each outcome is one notification, sent after the switch.

export const CD_COMMAND_NAME = "cd";
export const CD_COMMAND_DESCRIPTION = "Change this session's working directory.";
const CD_USAGE = "Usage: /cd <path>";

/** One custom entry per finished move, in the new file. Read per file, in file order, last one wins. */
export const CD_MOVE_ENTRY_TYPE = "rbf-cd-move/v1";
export type MoveEntry = { from: string; to: string; sessionId: string };

/** `rbf-codex.ts` stores a session's Codex thread binding under this type. */
const CODEX_THREAD_ENTRY_TYPE = "rbf-codex-thread/v1";

/** Answered by `rbf-background-tasks.ts`, which fills the payload in before `emit` returns. */
export const CD_BUSY_QUERY_CHANNEL = "rbf-background-tasks:busy/v1";
export type BusyQuery = { answered?: boolean; backgroundTask?: boolean; command?: boolean };

/**
 * The move in flight, from just before the switch until `/cd` returns. It belongs to the process, so it
 * outlives the extension instance that set it: the re-created instance reads it, and refuses a second move.
 */
export const CD_PENDING_MOVE_KEY = Symbol.for("rbf.cd.pendingMove");
export type PendingMove = {
	file: string;
	from: string;
	to: string;
	sessionId: string;
	/** Only for a conversation with nothing saved yet: its pick lives in entries Pi hasn't written, so nothing else carries it. */
	model?: { provider: string; id: string };
	thinkingLevel?: string;
};

export type CopyState =
	| "ordinary" // no parentSession, or the parent file is gone, or it has another session ID
	| "finished" // parent exists with the same ID, and the last move entry's `to` is this file's cwd
	| "unfinished"; // parent exists with the same ID, and the last move entry doesn't name this file's cwd

// ─── Copy ────────────────────────────────────────────────────────────────────
// Exact, from the brief's Content Design. Pi adds `Warning: ` and `Error: ` itself.
// A message that carries a file path or a command ends with it, with no period after.

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
	// Pi hard-wraps a notification, so a session file's path would break mid-word. The ID fits on a line of its own.
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

/**
 * Resolve the typed argument as one literal path. No shell: trim, strip one balanced pair of
 * outer quotes, expand a leading `~`, resolve against the session's directory, then `realpath`.
 * Variables, substitutions, globs and operators are ordinary characters in a name.
 */
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

	const refuse = (error: unknown): ResolvedPath => {
		const code = (error as NodeJS.ErrnoException)?.code;
		return { ok: false, copy: code === "EACCES" || code === "EPERM" ? COPY.pathDenied(full) : COPY.pathMissing(full) };
	};
	let path: string;
	try {
		path = realpathSync(full);
		if (!statSync(path).isDirectory()) return { ok: false, copy: COPY.pathNotDirectory(full) };
	} catch (error) {
		return refuse(error);
	}
	try {
		// Pi's tools must be able to list the directory and enter it.
		accessSync(path, constants.R_OK | constants.X_OK);
	} catch {
		return { ok: false, copy: COPY.pathDenied(full) };
	}
	return { ok: true, path };
}

/** One spelling per directory or file: the real path when it exists, the resolved one when it doesn't. */
function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

// ─── Session files ───────────────────────────────────────────────────────────
// A file belongs to a session by the `id` in its header line, never by its name.

/** The header is the file's first line. Read only that much: session files grow large. */
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

/** Every line after the header, parsed. `undefined` for a line that isn't an entry, so a caller can't mistake it for a known one. */
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

type Copy = { state: "ordinary" } | { state: "finished" | "unfinished"; sessionId: string; parentFile: string; parentCwd: string };

/** Where a file stands after a move that may have been interrupted, and the file it was copied from. Judged by content, never by age or name. */
function inspectCopy(file: string): Copy {
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

export function copyStateOf(file: string): CopyState {
	return inspectCopy(file).state;
}

/** True when every entry in `file` is one the caller already has, so nothing is lost if the file goes to the Trash. */
function holdsNothingNew(file: string, knownIds: ReadonlySet<string>): boolean {
	try {
		return readEntries(file).every((entry) => typeof entry?.id === "string" && knownIds.has(entry.id));
	} catch {
		return false;
	}
}

/** Other files in `folder` whose header carries `sessionId`, whatever they are named. */
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

/** Send a file to the system Trash with the `trash` command, as stock Pi's session delete does. Never deletes. */
function moveToTrash(file: string): boolean {
	try {
		const result = spawnSync("trash", [file], { stdio: "ignore", timeout: 10_000 });
		return result.status === 0 && !existsSync(file);
	} catch {
		return false;
	}
}

/**
 * The same-ID rule, applied before a move writes into `folder`. A copy that holds nothing the
 * session lacks goes to the Trash. One that holds more refuses the move, and so does a Trash
 * step that fails. Every copy is judged before any is touched.
 */
function clearDestinationCopies(folder: string, sessionId: string, ownFile: string, knownIds: ReadonlySet<string>): boolean {
	const copies = findSessionCopies(folder, sessionId, ownFile);
	return copies.every((copy) => holdsNothingNew(copy, knownIds)) && copies.every((copy) => moveToTrash(copy));
}

/**
 * The folder for the new file: Pi's default folder for the destination, unless the session's own
 * file sits outside Pi's default folder for its directory, as with `--session-dir`. Then that
 * same folder, where a Pi started the same way will find it.
 */
function pickSessionFolder(ownFile: string, sessionCwd: string, destination: string): string {
	// Pi only says where a directory's default folder is by creating it.
	const defaultFolder = (cwd: string) => SessionManager.create(cwd).getSessionDir();
	const ownFolder = dirname(ownFile);
	const sessionsRoot = join(getAgentDir(), "sessions");
	const before = new Set(existsSync(sessionsRoot) ? readdirSync(sessionsRoot) : []);
	const ownDefault = defaultFolder(sessionCwd);
	if (canonical(ownFolder) === canonical(ownDefault)) return defaultFolder(destination);

	// The session doesn't use that folder. If asking created it, take it away again: `rmdir` refuses one that holds anything.
	if (resolve(dirname(ownDefault)) === resolve(sessionsRoot) && !before.has(basename(ownDefault))) {
		try {
			rmdirSync(ownDefault);
		} catch {}
	}
	return ownFolder;
}

// ─── Refusals ────────────────────────────────────────────────────────────────

/** `pi.getFlag` only sees flags the calling extension registered, so read the launch flag the way `rbf-sandbox/launch-authority.ts` does. */
export function launchedWithSandbox(argv: readonly string[] = process.argv): boolean {
	return parseArgs([...argv.slice(2)]).unknownFlags.has("sandbox");
}

/** Print, JSON and RPC modes don't exit when a switch throws, which the failure path relies on. */
function isInteractive(ctx: ExtensionContext): boolean {
	return ctx.hasUI === true && (ctx.mode === undefined || ctx.mode === "tui");
}

// ─── Failed switch ───────────────────────────────────────────────────────────

export type FailedSwitchFacts = { from: string; to: string; oldFile: string; newFile: string; hadSavedFile: boolean; oldFileExists: boolean };

/**
 * What the exit hook does once Pi has stopped on a failed switch. The new file is deleted only
 * while the conversation is safe elsewhere, or when there was never anything to save.
 */
export function decideFailedSwitch(facts: FailedSwitchFacts): { deleteNewFile: boolean; lines: string[] } {
	if (!facts.hadSavedFile) return { deleteNewFile: true, lines: [COPY.failedSwitchNothingSaved] };
	if (facts.oldFileExists) return { deleteNewFile: true, lines: COPY.failedSwitch(facts.from, facts.oldFile) };
	return { deleteNewFile: false, lines: COPY.failedSwitch(facts.to, facts.newFile) };
}

// ─── Extension Entry Point ───────────────────────────────────────────────────

export default function rbfCd(pi: ExtensionAPI): void {
	const shared = globalThis as { [CD_PENDING_MOVE_KEY]?: PendingMove };

	function findRefusal(ctx: ExtensionCommandContext): Refusal | undefined {
		const warn = (copy: string): Refusal => ({ copy, level: "warning" });
		// One check covers a response and a compaction: Pi offers nothing that tells them apart.
		if (!ctx.isIdle()) return warn(COPY.busyResponse);
		if (shared[CD_PENDING_MOVE_KEY]) return warn(COPY.busyMove);
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return warn(COPY.notSaved(ctx.cwd));

		// Pi writes the file with the first assistant message. A session that has one and no file has lost its
		// file, and the conversation on screen is the only copy left: a move would replace it with an empty session.
		const entries = ctx.sessionManager.getEntries();
		if (!existsSync(file) && entries.some((entry) => entry.type === "message" && entry.message.role === "assistant")) {
			return { copy: COPY.refused(REASON_FILE_MISSING, ctx.cwd), level: "error" };
		}

		// The switch stops every tracked task and aborts a running `!` command, and `isIdle()` is true
		// while one runs. No answer means the extension is missing or older, so `/cd` can't know.
		const busy: BusyQuery = {};
		pi.events.emit(CD_BUSY_QUERY_CHANNEL, busy);
		if (!busy.answered) return warn(COPY.noAnswer(ctx.cwd));
		if (busy.backgroundTask) return warn(COPY.busyBackgroundTask);
		if (busy.command) return warn(COPY.busyCommand);

		// On any branch, whatever model is selected now: the next Codex turn would fail with `workspace-mismatch`.
		if (entries.some((entry) => entry.type === "custom" && entry.customType === CODEX_THREAD_ENTRY_TYPE)) return warn(COPY.codex(ctx.cwd));
		// `pi-23`'s sandbox fails closed when its directory changes, which would leave the session's tools blocked.
		if (launchedWithSandbox()) return warn(COPY.sandbox(ctx.cwd));
		return undefined;
	}

	/** A finished move's old file, or an unfinished copy opened directly. */
	function checkLeftover(file: string, ctx: ExtensionContext): void {
		const copy = inspectCopy(file);
		if (copy.state === "ordinary") return;

		let warning: string;
		if (copy.state === "finished") {
			// The parent is left over from a move Pi died in, after the entry was written and before the Trash step.
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
			} catch {
				// The session was replaced before the timer fired; its next `session_start` checks again.
			}
		}, 0);
		timer.unref?.();
	}

	pi.on("session_start", async (_event, ctx) => {
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return;

		const pending = shared[CD_PENDING_MOVE_KEY];
		if (pending && canonical(pending.file) === canonical(file)) {
			// This instance was created by the move. The old `pi` is dead, so the entry is written from here,
			// with the session ID this session really has: a conversation with nothing saved gets a new one.
			try {
				pi.appendEntry<MoveEntry>(CD_MOVE_ENTRY_TYPE, { from: pending.from, to: pending.to, sessionId: ctx.sessionManager.getSessionId() });
			} catch {
				// The move still completes. Without the entry the old file is retired by `/cd` as usual.
			}
			// A new, empty session starts from Pi's defaults. Put back what was picked before the move,
			// model first because a model change resets the thinking level. A pick that can't be put back never fails the move.
			try {
				const model = pending.model && ctx.modelRegistry.find(pending.model.provider, pending.model.id);
				if (model) await pi.setModel(model);
			} catch {}
			try {
				if (pending.thinkingLevel) pi.setThinkingLevel(pending.thinkingLevel as ThinkingLevel);
			} catch {}
			return;
		}
		try {
			checkLeftover(file, ctx);
		} catch {
			// A file that can't be read is left exactly as it is.
		}
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
			// Every refusal from here on puts the full typed command back, so a retry needs no retyping.
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
		// No file means nothing is saved yet, so there is nothing to copy: `findRefusal` has ruled out a file that went missing.
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
			// A missing path opens as a new session in the process directory with a new ID, so a conversation
			// with nothing saved lands in the destination only because the process directory changes below.
			const written = hadSavedFile ? SessionManager.forkFrom(oldFile, to, folder, { id: sessionId }) : SessionManager.create(to, folder);
			const file = written.getSessionFile();
			if (!file) throw new Error("Pi gave the new session no file");
			newFile = file;
		} catch {
			// No copy was left in the folder by the check above, so any that is there now is a half-written one of ours.
			for (const partial of findSessionCopies(folder, sessionId, oldFile)) rmSync(partial, { force: true });
			return refuse({ copy: COPY.refused(REASON_NOT_WRITTEN, from), level: "error" });
		}
		const removeNewFile = (): void => rmSync(newFile, { force: true });

		// `rbf-codex.ts`'s catalog fetch, `rbf-background-tasks.ts`'s bash tool and the status line's
		// fallback read the process directory, so it moves with the session and moves back on a cancel.
		const processDir = process.cwd();
		const backToOrigin = (): void => {
			try {
				process.chdir(processDir);
			} catch {
				// The original directory is gone; the session's own directory still drives Pi's tools.
			}
			removeNewFile();
		};
		const failedSwitch = () => decideFailedSwitch({ from, to, oldFile, newFile, hadSavedFile, oldFileExists: existsSync(oldFile) });
		const onFailedSwitchExit = (): void => {
			try {
				const decision = failedSwitch();
				if (decision.deleteNewFile) removeNewFile();
				// Pi's screen is gone by now, so these are plain terminal lines with the command alone on the last.
				// Each starts on a cleared row: Pi 1.0.2 can stop with part of its last frame still under the cursor.
				const clear = process.stderr.isTTY ? "\r\x1b[K" : "";
				writeSync(2, `\n${decision.lines.map((line) => clear + line).join("\n")}\n${clear}`);
			} catch {
				// Nothing more can be done from an exit hook.
			}
		};

		// A saved conversation carries its model and thinking level in its copied entries.
		const pick = hadSavedFile ? {} : { model: ctx.model && { provider: ctx.model.provider, id: ctx.model.id }, thinkingLevel: pi.getThinkingLevel() };
		shared[CD_PENDING_MOVE_KEY] = { file: newFile, from, to, sessionId, ...pick };
		process.once("exit", onFailedSwitchExit);
		const next: { ctx?: ExtensionCommandContext } = {};
		let cancelled: boolean;
		try {
			process.chdir(to);
			({ cancelled } = await ctx.switchSession(newFile, {
				// Nothing here can throw: a throw inside `withSession` ends Pi like any other failed switch.
				withSession: async (replaced) => {
					next.ctx = replaced;
				},
			}));
			process.removeListener("exit", onFailedSwitchExit);
		} catch (error) {
			// Pi normally exits inside the switch and never gets here. Pi 1.0.2 does when its own fatal handler
			// throws, as with a destination deleted mid-switch, and then stops a moment later. So clean up now,
			// and leave the exit hook armed to print the reopen lines once Pi's screen is gone.
			if (failedSwitch().deleteNewFile) backToOrigin();
			throw error;
		}

		if (cancelled) {
			// Another extension's `session_before_switch` said no. The old `ctx` is still valid here.
			backToOrigin();
			return refuse({ copy: COPY.cancelled(from), level: "info" });
		}

		// The switch succeeded. Three steps, each catching its own error, so a failed restore can't skip
		// the Trash step or the message. Session-bound work goes through the new `ctx` only.
		let restored = true;
		if (hadSavedFile && !selectedIsLast) {
			// The new file opens at its last entry. A session rewound to before its very first entry has none to select.
			restored = false;
			try {
				if (selected && next.ctx) restored = !(await next.ctx.navigateTree(selected, { summarize: false })).cancelled;
			} catch {
				// Reported below.
			}
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
		} catch {
			// The move itself succeeded.
		}
	}
}
