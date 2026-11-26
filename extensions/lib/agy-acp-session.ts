// One `agy acp` child and the one ACP session it serves for one Pi conversation (ACP 1.5.3).
// Pi owns the child: it starts it, speaks to it through AcpClient, and is the only thing that stops it.
// Nothing here knows about Pi's session file, records or UI; rbf-agy.ts joins them.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AcpClient, AcpLostError, AcpRpcError, type RpcId } from "./agy-acp.js";
import { BOUNDS, type CleanupOutcome } from "./agy-native.js";

// Wording is the brief's copy table (12_design-experience.md). A line that is not the table's own is marked: where it comes from, or that it is not in the table.
export const ACP_COPY = {
	unsupported: "AGY cannot change to this setting in the same conversation. Your message was not sent. Select the previous setting to continue, or use /new.",
	notConfirmed: "AGY could not confirm this setting. Your message was not sent. Select a supported setting and send again, or use /new.",
	lostBeforeSend: "AGY could not verify the conversation with this setting. Your message was not sent. Use /new to start a new conversation.",
	changeCancelled: "AGY change cancelled. Your message was not sent.",
	changeCancelledLost: "AGY change cancelled. Your message was not sent. This conversation cannot continue. Use /new after AGY cleanup completes.",
	diverged: "AGY reported different settings for this turn. The task may have run. Review its results before sending again.",
	lost: "AGY could not confirm this turn. The task outcome is unknown. No automatic retry was sent.",
	listMissing: (name: string) => `AGY's command list didn't arrive, so Pi can't check /${name}. Your message was not sent. Send it again.`,
	agyCommand: (name: string) => `AGY would run /${name} as its own command. Pi doesn't send AGY commands yet. Your message was not sent.`,
	policyKeys: (keys: string[]) => `AGY over ACP can't apply these settings: ${keys.join(", ")}. Your message was not sent. Remove them from the file, or start Pi without --agy-settings.`,
	/** The CLI route's copy: the table says a failed start reads the same on both routes. */
	startup: "AGY could not start. Your message was not sent. Check native AGY, then use /new and send a new task.",
	signIn: "AGY needs you to sign in. Your message was not sent. Sign in with AGY itself, then send again.",
	cancelTimeout: "AGY did not stop within 3 seconds, so Pi stopped it. This conversation cannot continue. Use /new to start a new conversation.",
	/** After a verified clean stop: AGY 1.5.10 and later stop a session's subagents and background tasks on cancel and close (Decisions 2026-11-22). Not yet measured on a real run. */
	stopped: "AGY stopped, along with its subagents and background tasks.",
	/** The marker line Pi saves when AGY wakes between turns (the table's row, Decisions 2026-11-22). */
	woke: "AGY continued on its own.",
	/** A wake run is Pi's own: Tom sent nothing, so a refusal of one never says a message was not sent. It says what happened to AGY's work. */
	wakeGone: "AGY's work after its turn couldn't be shown in time, so Pi stopped AGY. The chat continues.",
	wakeRefused: "AGY's work after its turn couldn't be shown. Use /new to start a new AGY conversation.",
	/** Tom's 2026-11-09 decision after probe P1 (02_decisions.md); the table's row repeats it. */
	question: "AGY asked a question Pi can't show yet, so AGY asks it in the chat instead.",
	/** Not in the table: an unrecognised stop reason is treated as uncertain. */
	unsupportedStop: (reason: string) => `AGY ended the turn with a result Pi does not handle yet (${reason}). The task outcome is unknown. Use /new after this conversation stops.`,
} as const;

export const ACP_DEFINITE_STOP_REASONS: Record<string, "stop" | "length" | "error" | "aborted"> = {
	end_turn: "stop",
	max_tokens: "length",
	max_turn_requests: "length",
	refusal: "error",
	cancelled: "aborted",
};

/**
 * How long a retire waits for AGY's reply to `session/close`. AGY 1.5.10's changelog: "canceling or closing now stops them [a session's subagents and background tasks],
 * and closing does so even when no prompt is running". Measured on real AGY 1.5.14 with no prompt (2026-11-22, zero-prompt check
 * `agy-1.5.14-noprompt/close-check.mjs`): the reply is `{}` in 9 ms, a second close is harmless, and the child exits 0 when stdin closes.
 * Whether a close during a running turn also stops that turn's work was not measured.
 */
export const SESSION_CLOSE_REPLY_MS = 2_000;

export interface AcpConfigOption { id: string; currentValue: string; options: { value: string; name?: string }[] }
/** The model and thinking level Pi wants AGY to run. `thought` is absent for a fixed-effort model row. */
export interface AcpSelection { model: string; thought?: string }
export interface AcpToolUpdate {
	sessionUpdate: "tool_call" | "tool_call_update";
	toolCallId: string;
	name?: string;
	kind?: string;
	title?: string;
	status?: string;
	rawInput?: Record<string, unknown>;
	args?: Record<string, unknown>;
	rawOutput?: Record<string, unknown>;
	content?: unknown[];
}
export interface AcpPromptHandlers {
	text(delta: string): void;
	thought(delta: string): void;
	tool?(update: AcpToolUpdate): void;
}
export interface AcpOwnerRequestHandlers {
	permission?(params: any, id: RpcId): unknown | Promise<unknown>;
	question?(params: any, id: RpcId): void | Promise<void>;
}
export interface AcpPromptResult { stopReason: string; /** AGY changed model or thinking level during this turn, and no call of Pi's explains it. */ diverged: boolean; usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number } | undefined }
export type AcpState = "idle" | "prompting" | "waking" | "ineligible" | "retired";
/** How a wake turn ended: AGY went quiet, or Pi cancelled it (Esc). */
export interface AcpWakeResult { ended: "quiet" | "cancelled"; /** AGY changed model or thinking level during the wake, and no call of Pi's explains it. */ diverged: boolean }
export interface AcpWakeOptions {
	signal?: AbortSignal;
	/** How long AGY must stay silent before the wake ends. 3 s unless a test shortens it. */
	quietMs?: number;
	/** True while something that must finish first is open (an approval dialog): the wake does not end then. */
	busy?: () => boolean;
}
/** The default silence that ends a wake turn (Decisions 2026-11-22). */
export const WAKE_QUIET_MS = 3_000;
/** A wake that no turn picks up within this long is abandoned: AGY must not wait on a Pi that never started the run. */
const WAKE_ATTACH_MS = 15_000;
/** After Esc stops a wake, frames AGY had already sent do not start another one for this long. */
const WAKE_HOLDOFF_MS = 1_000;
/** A frame between turns that is bookkeeping, not AGY working: it never starts a wake. */
const NOT_A_WAKE_UPDATE = new Set(["usage_update", "config_option_update", "available_commands_update"]);
type BufferedFrame =
	| { kind: "update"; update: any }
	| { kind: "request"; method: string; params: any; id: RpcId; resolve(value: unknown): void; reject(error: unknown): void };

/** A selection AGY does not offer (`unsupported`) or one its replies did not confirm (`not-confirmed`). Nothing was sent. */
export class AcpConfigError extends Error {
	constructor(readonly kind: "unsupported" | "not-confirmed") { super(kind); this.name = "AcpConfigError"; }
}
export class AcpStartError extends Error {
	constructor(readonly kind: "startup" | "sign-in" = "startup") {
		super(kind === "sign-in" ? "AGY ACP requires sign-in" : "AGY ACP could not be started");
		this.name = "AcpStartError";
	}
}
export class AcpCancelTimeoutError extends Error {
	constructor() {
		super(ACP_COPY.cancelTimeout);
		this.name = "AcpCancelTimeoutError";
	}
}

export function isAcpSignInError(error: unknown): boolean {
	return error instanceof AcpRpcError
		&& error.code === -32000
		&& typeof error.wireMessage === "string"
		&& /\b(auth|authenticate|authentication|log\s*in|logged\s*in|sign\s*in|signed\s*in|credential|credentials)\b/i.test(error.wireMessage);
}

const isObject = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
const tokens = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;

function readConfig(value: unknown): AcpConfigOption[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: AcpConfigOption[] = [];
	for (const o of value) {
		if (!isObject(o) || typeof o.id !== "string" || typeof o.currentValue !== "string" || !Array.isArray(o.options)) return undefined;
		out.push({ id: o.id, currentValue: o.currentValue, options: o.options.filter(isObject).filter(x => typeof x.value === "string").map(x => ({ value: x.value, name: typeof x.name === "string" ? x.name : undefined })) });
	}
	return out;
}

/** What Pi has seen of the child's life, attached at spawn so an early exit is never missed. */
interface ChildWatch { exit?: { code: number | null; signal: NodeJS.Signals | null }; closed: boolean }
function watchChild(child: ChildProcessWithoutNullStreams): ChildWatch {
	const seen: ChildWatch = { closed: false };
	child.once("exit", (code, signal) => { seen.exit = { code, signal }; });
	child.once("close", () => { seen.closed = true; });
	return seen;
}

export class AcpOwner {
	private _state: AcpState = "idle";
	private commands: Set<string> | undefined;
	private commandWaiters = new Set<() => void>();
	private snapshot: AcpConfigOption[];
	/** What AGY's replies confirmed for the next send. Cleared by any config update that no call of Pi's explains. */
	private ack: { model: string; thought: string; selection: AcpSelection } | undefined;
	/** `reply` while the latest snapshot came from a reply of AGY to Pi; `unsolicited` once an update Pi did not cause replaced it. */
	private configSource: "reply" | "unsolicited" = "reply";
	private unsolicitedSeq = 0;
	/** One entry per set_config_option of this configure-and-prompt cycle: the pair its reply reported, which its echo will repeat. */
	private expectedEchoes: Array<{ model: string; thought: string }> = [];
	private _diverged = false;
	/** The pair AGY had acknowledged when this turn's prompt was sent. Divergence is measured against it, so one update that repeats the pair cannot hide a later move. Set only while a prompt runs. */
	private turnPair: { model: string; thought: string } | undefined;
	private active: AcpPromptHandlers | undefined;
	private requestHandlers: AcpOwnerRequestHandlers | undefined;
	/** True from the moment a prompt is sent until its result arrives: a stop in between cannot be verified. */
	private turnOpen = false;
	private closing: Promise<CleanupOutcome> | undefined;
	private lostReason: AcpLostError | undefined;
	/** Fails the running `prompt()` or wake as lost; set only while one runs. */
	private failPrompt: ((error: AcpLostError) => void) | undefined;
	/** Called once when AGY starts talking between turns. Without one, between-turn frames are ignored as before. */
	private wakeListener: (() => void) | undefined;
	/** Called once when the attach timer drops a wake no turn picked up: the provider stops AGY and says so when it never sent the marker. */
	private wakeDropped: (() => void) | undefined;
	/** A wake turn in progress. Its frames wait in `buffer` until the provider attaches, then flow as in a prompt. */
	private wake: { buffer: BufferedFrame[]; attached: boolean; lastFrameAt: number; timer?: ReturnType<typeof setTimeout> } | undefined;
	/** A wake can only follow a turn: set when the first prompt's result arrives. Frames that follow `session/new` or `session/resume` are not AGY waking. */
	private armed = false;
	private wakeHoldUntil = 0;
	/** How long a wake waits for the provider's turn before the owner gives it up. WAKE_ATTACH_MS in use; a test seam otherwise. */
	wakeAttachMs = WAKE_ATTACH_MS;

	private constructor(readonly child: ChildProcessWithoutNullStreams, private readonly seen: ChildWatch, readonly cwd: string, readonly acpSessionId: string, snapshot: AcpConfigOption[], private readonly client: AcpClient, readonly onLost: (error: AcpLostError) => void, requests?: AcpOwnerRequestHandlers, private readonly offersClose = false) {
		this.snapshot = snapshot;
		this.requestHandlers = requests;
	}

	get state(): AcpState { return this._state; }
	/** True from AGY's first between-turn frame until the wake turn has ended. */
	get waking(): boolean { return this._state === "waking"; }
	/** True while a turn (a prompt or a wake) is running: its frames reach the handlers. */
	private get inTurn(): boolean { return this._state === "prompting" || this._state === "waking"; }
	get lostError(): AcpLostError | undefined { return this.lostReason; }
	config(): readonly AcpConfigOption[] { return this.snapshot; }
	setRequestHandlers(handlers: AcpOwnerRequestHandlers | undefined): void { this.requestHandlers = handlers; }

	/** Starts `<executable> acp [args]` in `cwd`, then `initialize` and `session/new`. Throws AcpStartError; the child is retired first. */
	static open(options: { executable: string; cwd: string; args: string[]; onLost?: (error: AcpLostError) => void; requests?: AcpOwnerRequestHandlers; wakeAttachMs?: number }): Promise<AcpOwner> { return AcpOwner.start(options); }

	/** The same, but `session/resume` of a session an earlier Pi process created. AGY resets its model and thinking level on resume; configure() sets them again. */
	static resume(options: { executable: string; cwd: string; args: string[]; acpSessionId: string; onLost?: (error: AcpLostError) => void; requests?: AcpOwnerRequestHandlers; wakeAttachMs?: number }): Promise<AcpOwner> { return AcpOwner.start(options, options.acpSessionId); }

	private static async start(options: { executable: string; cwd: string; args: string[]; onLost?: (error: AcpLostError) => void; requests?: AcpOwnerRequestHandlers; wakeAttachMs?: number }, resumeId?: string): Promise<AcpOwner> {
		let child: ChildProcessWithoutNullStreams;
		try { child = spawn(options.executable, ["acp", ...options.args], { shell: false, detached: false, cwd: options.cwd, env: { ...process.env, PWD: options.cwd }, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams; }
		catch { throw new AcpStartError(); }
		const seen = watchChild(child);
		let owner: AcpOwner | undefined;
		const early: Array<[string, any]> = [];
		const client = new AcpClient(child, {
			notification: (method, params) => {
				if (owner) owner.onNotification(method, params);
				else if (early.length < 64) early.push([method, params]);
			},
			request: (method, params, id) => owner ? owner.onRequest(method, params, id) : Promise.reject(new AcpRpcError(-32601)),
			lost: error => owner?.markLost(error),
		});
		const abandon = async (kind: "startup" | "sign-in" = "startup"): Promise<never> => {
			await new AcpOwner(child, seen, options.cwd, "", [], client, () => { }).close();
			throw new AcpStartError(kind);
		};
		try {
			const init = await client.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } }, clientInfo: { name: "pi-rbf-agy", version: "1" } });
			if (!isObject(init) || init.protocolVersion !== 1 || !isObject(init.agentCapabilities?.sessionCapabilities) || !isObject(init.agentCapabilities.sessionCapabilities.resume)) return await abandon();
			let created: unknown;
			try { created = await client.request(resumeId ? "session/resume" : "session/new", resumeId ? { sessionId: resumeId, cwd: options.cwd, mcpServers: [] } : { cwd: options.cwd, mcpServers: [] }); }
			catch (error) { return await abandon(isAcpSignInError(error) ? "sign-in" : "startup"); }
			const config = readConfig(isObject(created) ? created.configOptions : undefined);
			if (!isObject(created) || typeof created.sessionId !== "string" || !created.sessionId || (resumeId !== undefined && created.sessionId !== resumeId) || !config) return await abandon();
			owner = new AcpOwner(child, seen, options.cwd, created.sessionId, config, client, options.onLost ?? (() => { }), options.requests, isObject(init.agentCapabilities.sessionCapabilities.close));
			if (options.wakeAttachMs !== undefined) owner.wakeAttachMs = options.wakeAttachMs;
			for (const [method, params] of early) owner.onNotification(method, params);
			return owner;
		}
		catch (error) {
			if (error instanceof AcpStartError) throw error;
			return await abandon();
		}
	}

	private markLost(error: AcpLostError): void {
		if (this.lostReason) return;
		this.lostReason = error;
		if (this._state !== "retired") this._state = "ineligible";
		this.failPrompt?.(error); // a wake has no request of its own to fail
		try { this.onLost(error); } catch { }
	}

	private onNotification(method: string, params: any): void {
		if (this._state === "retired") return; // AGY may still talk while it answers session/close; none of it reaches Pi's turn, config or UI
		if (method !== "session/update" || !isObject(params) || params.sessionId !== this.acpSessionId || !isObject(params.update)) return;
		const u = params.update;
		if (this.wake) {
			this.wake.lastFrameAt = Date.now();
			if (!this.wake.attached) { this.wake.buffer.push({ kind: "update", update: u }); return; } // every frame from the wake's first one waits for the provider
		}
		else if (this._state === "idle" && this.canWake() && typeof u.sessionUpdate === "string" && !NOT_A_WAKE_UPDATE.has(u.sessionUpdate)) {
			this.startWake().buffer.push({ kind: "update", update: u });
			return;
		}
		this.applyUpdate(u);
	}

	private applyUpdate(u: any): void {
		switch (u.sessionUpdate) {
			case "agent_message_chunk": if (u.content?.type === "text" && typeof u.content.text === "string") this.active?.text(u.content.text); break;
			case "agent_thought_chunk": if (u.content?.type === "text" && typeof u.content.text === "string") this.active?.thought(u.content.text); break;
			case "tool_call":
			case "tool_call_update":
				if (this.inTurn && this.active !== undefined && typeof u.toolCallId === "string" && u.toolCallId.length > 0) this.active.tool?.(u as AcpToolUpdate);
				break;
			case "available_commands_update": {
				if (!Array.isArray(u.availableCommands)) break;
				this.commands = new Set(u.availableCommands.filter((c: any) => isObject(c) && typeof c.name === "string").map((c: any) => c.name));
				for (const wake of [...this.commandWaiters]) wake();
				break;
			}
			case "config_option_update": this.onConfigUpdate(readConfig(u.configOptions)); break;
			default: break;
		}
	}

	/**
	 * Each set_config_option gets a reply and, separately, an echo. An update that repeats a pair an unmatched call of this cycle reported is that call's echo: it changes
	 * nothing, and it may arrive before or after the prompt. Any other update is AGY's own change: it replaces the snapshot, and Pi stops trusting what it had confirmed.
	 */
	private onConfigUpdate(next: AcpConfigOption[] | undefined): void {
		if (!next) return;
		const pair = this.pairOf(next), at = this.expectedEchoes.findIndex(e => e.model === pair.model && e.thought === pair.thought);
		if (at >= 0) { this.expectedEchoes.splice(0, at + 1); return; }
		this.snapshot = next;
		this.configSource = "unsolicited";
		this.unsolicitedSeq++;
		if (this.inTurn && this.turnPair && (this.turnPair.model !== pair.model || this.turnPair.thought !== pair.thought)) this._diverged = true;
		this.ack = undefined;
	}

	private pairOf(config: readonly AcpConfigOption[]): { model: string; thought: string } {
		return { model: config.find(o => o.id === "model")?.currentValue ?? "", thought: config.find(o => o.id === "thought_level")?.currentValue ?? "" };
	}

	/** Routes AGY's permission and question requests. Client powers (`fs/*`, `terminal/*`, unknown) are never offered. */
	private async onRequest(method: string, params: any, id: RpcId): Promise<unknown> {
		if (this._state === "retired") {
			if (method === "session/request_permission") return { outcome: { outcome: "cancelled" } }; // nothing is shown for a chat Pi has retired
			throw new AcpRpcError(-32601);
		}
		const own = isObject(params) && params.sessionId === this.acpSessionId;
		if (own && (method === "session/request_permission" || method === "elicitation/create")) {
			// A request between turns is AGY waking too: it waits, with the frames after it, for the provider to attach. Its reply goes out once the wake turn handles it.
			if (this.wake) this.wake.lastFrameAt = Date.now();
			const wake = this.wake ?? (this._state === "idle" && this.canWake() ? this.startWake() : undefined);
			if (wake && !wake.attached) return await new Promise<unknown>((resolve, reject) => { wake.buffer.push({ kind: "request", method, params, id, resolve, reject }); });
		}
		return await this.handleRequest(method, params, id, own);
	}

	private async handleRequest(method: string, params: any, id: RpcId, own: boolean): Promise<unknown> {
		if (method === "session/request_permission") {
			if (this.requestHandlers?.permission) return await this.requestHandlers.permission(params, id);
			const reject = own && Array.isArray(params.options) ? params.options.find((o: any) => isObject(o) && o.kind === "reject_once" && typeof o.optionId === "string") : undefined;
			return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
		}
		if (method === "elicitation/create") {
			if (own && this.requestHandlers?.question) {
				try { await this.requestHandlers.question(params, id); } catch { }
			}
			throw new AcpRpcError(-32603, "Pi could not show the question");
		}
		throw new AcpRpcError(-32601);
	}

	/** The pair AGY holds now, for the record of a wake turn: a wake sends no `set_config_option`, so nothing was confirmed for it. `effort` is null where AGY shows no thinking level. */
	heldPair(): { model: string; effort: string | null } { const p = this.pairOf(this.snapshot); return { model: p.model, effort: p.thought || null }; }

	/**
	 * Sets the one function called when AGY starts talking between turns. It must start a Pi turn that calls `attachWake`.
	 * `onDropped` is called after the attach timer has abandoned a wake that no turn picked up, and only then (not for a wake the provider abandons itself).
	 */
	setWakeListener(listener: (() => void) | undefined, onDropped?: () => void): void { this.wakeListener = listener; this.wakeDropped = onDropped; }

	private canWake(): boolean { return this.armed && this.wakeListener !== undefined && Date.now() >= this.wakeHoldUntil && this.lostReason === undefined; }

	private startWake() {
		const wake: NonNullable<typeof this.wake> = { buffer: [], attached: false, lastFrameAt: Date.now() };
		wake.timer = setTimeout(() => {
			if (this.wake !== wake || wake.attached) return;
			this.abandonWake();
			try { this.wakeDropped?.(); } catch { /* the wake is gone either way */ }
		}, this.wakeAttachMs);
		wake.timer.unref?.();
		this.wake = wake;
		this._state = "waking";
		this.turnOpen = true; // a stop in the middle of a wake cannot be verified either
		queueMicrotask(() => { try { this.wakeListener?.(); } catch { /* the provider abandons the wake itself when it cannot start the turn */ } });
		return wake;
	}

	/**
	 * For a wake run Pi started after the owner had already given up on the wake: tells AGY to stop (session/cancel; AGY 1.5.10 and later also stop the conversation's subagents and background tasks) and holds
	 * off the next wake for a moment, as Esc does. The owner stays idle and usable.
	 */
	stopAbandonedWake(): void {
		this.wakeHoldUntil = Date.now() + WAKE_HOLDOFF_MS;
		this.client.notify("session/cancel", { sessionId: this.acpSessionId });
	}

	/** Answers every buffered request as Pi would for a turn that is over, applies the settings and command-list updates it held, and forgets the wake. For a wake Pi could not start, and for a retire. */
	abandonWake(): void {
		const wake = this.wake;
		if (!wake) return;
		clearTimeout(wake.timer);
		this.wake = undefined;
		this.turnOpen = false;
		this.move("waking", "idle");
		for (const frame of wake.buffer.splice(0)) {
			// No turn owns a settings or command-list update that arrived between turns, so it takes effect even though the wake that held it never ran: a snapshot that kept an old pair would let the next
			// send skip its settings calls while AGY runs another one. The answer chunks and tool frames are dropped with the wake.
			if (frame.kind === "update" && (frame.update.sessionUpdate === "config_option_update" || frame.update.sessionUpdate === "available_commands_update")) { this.applyUpdate(frame.update); continue; }
			if (frame.kind !== "request") continue;
			if (frame.method === "session/request_permission") frame.resolve({ outcome: { outcome: "cancelled" } });
			else frame.reject(new AcpRpcError(-32603, "Pi could not show the question"));
		}
	}

	/**
	 * The provider's side of a wake turn: replays what AGY sent since it started talking, in order, then maps every later frame as during a prompt (answer chunks, tool calls, requests).
	 * Ends when AGY has been silent for `quietMs` and nothing is `busy`, or when `signal` aborts (Esc: `session/cancel` goes to AGY, and no result comes back). Sends AGY nothing else.
	 */
	async attachWake(handlers: AcpPromptHandlers, options: AcpWakeOptions = {}): Promise<AcpWakeResult> {
		const wake = this.wake;
		if (!wake || wake.attached || this._state !== "waking") throw new AcpLostError("no wake to attach");
		wake.attached = true;
		clearTimeout(wake.timer);
		this.active = handlers;
		this._diverged = false;
		// The pair the wake is measured against is frozen here, when the provider attaches, not when AGY first spoke: Pi's own settings step can still be running when a wake starts, and its calls (and their echoes, held
		// in the buffer) explain the change to the pair. It is the acknowledged pair, or the snapshot when an update nobody asked for cleared the acknowledgement. Frames held in the buffer are not in it yet, so a move
		// AGY made while the wake waited still reads as divergence when they replay.
		this.turnPair = this.ack ? { model: this.ack.model, thought: this.ack.thought } : this.pairOf(this.snapshot);
		const quietMs = options.quietMs ?? WAKE_QUIET_MS, busy = options.busy ?? (() => false), signal = options.signal;
		let timer: ReturnType<typeof setTimeout> | undefined, onAbort: (() => void) | undefined;
		try {
			const ended = await new Promise<"quiet" | "cancelled">((resolve, reject) => {
				let settled = false;
				const done = (fn: () => void) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (signal && onAbort) signal.removeEventListener("abort", onAbort);
					fn();
				};
				this.failPrompt = error => done(() => reject(error));
				const check = () => {
					if (settled) return;
					// While something is open (an approval dialog) the wake cannot end, and the silence starts again when it closes: AGY answers within moments of the reply.
					if (busy()) { wake.lastFrameAt = Date.now(); timer = setTimeout(check, 50); return; }
					const silent = Date.now() - wake.lastFrameAt;
					if (silent >= quietMs) return done(() => resolve("quiet"));
					timer = setTimeout(check, Math.max(5, Math.min(50, quietMs - silent)));
				};
				if (signal) {
					onAbort = () => { if (settled) return; this.cancel(); done(() => resolve("cancelled")); };
					if (signal.aborted) {
						// Esc came before the provider got here. The requests AGY held still go through the handler, which answers them for a stopped turn and records a permission as rejected because the turn stopped. Only the
						// requests leave the buffer: the settings and command-list updates in it belong to nobody, and abandonWake applies them below. The answer chunks and tool frames are dropped with the wake.
						const requests = wake.buffer.filter(frame => frame.kind === "request");
						wake.buffer = wake.buffer.filter(frame => frame.kind !== "request");
						for (const frame of requests) if (frame.kind === "request") void this.handleRequest(frame.method, frame.params, frame.id, true).then(frame.resolve, frame.reject);
						onAbort();
						return;
					}
					signal.addEventListener("abort", onAbort, { once: true });
				}
				for (const frame of wake.buffer.splice(0)) {
					if (frame.kind === "update") this.applyUpdate(frame.update);
					else void this.handleRequest(frame.method, frame.params, frame.id, true).then(frame.resolve, frame.reject);
				}
				check();
			});
			if (ended === "cancelled") this.wakeHoldUntil = Date.now() + WAKE_HOLDOFF_MS;
			this.expectedEchoes = [];
			const diverged = this._diverged;
			this.abandonWake(); // a request still waiting (Esc came before it was handled) gets the reply for a stopped turn; the owner is idle again
			return { ended, diverged };
		}
		catch (error) {
			this.move("waking", "ineligible"); // before abandonWake, which would put an owner back to idle
			this.abandonWake();
			throw error;
		}
		finally {
			clearTimeout(timer);
			this.active = undefined;
			this.failPrompt = undefined;
			this.turnPair = undefined;
		}
	}

	/** Names in AGY's command list, or undefined if the list has not arrived within `ms`. */
	async commandList(ms: number): Promise<Set<string> | undefined> {
		if (this.commands) return this.commands;
		await new Promise<void>(resolve => {
			const done = () => { clearTimeout(timer); this.commandWaiters.delete(done); resolve(); };
			const timer = setTimeout(done, ms);
			this.commandWaiters.add(done);
		});
		return this.commands;
	}

	/**
	 * Sets model, then thinking level, and trusts only AGY's replies. Throws AcpConfigError before anything is sent to the model.
	 * A fixed-effort model (no `thought`) sets the model only and reports the thinking level AGY holds.
	 */
	async configure(selection: AcpSelection): Promise<{ model: string; effort: string | null }> {
		if (this.ack && this.ack.selection.model === selection.model && this.ack.selection.thought === selection.thought) return this.report(selection);
		this.ack = undefined;
		this.expectedEchoes = [];
		const wanted: Array<[string, string]> = [["model", selection.model], ...(selection.thought !== undefined ? [["thought_level", selection.thought] as [string, string]] : [])];
		const current = (id: string) => this.snapshot.find(o => o.id === id)?.currentValue;
		// A second pass re-sends both settings once, when an update no call of Pi's explains landed during the first.
		for (let pass = 1; pass <= 2; pass++) {
			const before = this.unsolicitedSeq, force = this.configSource === "unsolicited" || pass === 2;
			for (const [id, value] of wanted) {
				// Each value is checked against the latest snapshot right before it is sent: the model against the current one, the effort against the one the model's reply returned.
				// AGY offers the thinking levels of the model it holds (Flash has no xhigh, an Orchestrator no thought_level at all), so a check made before the model call would use the model being left.
				if (!this.snapshot.find(o => o.id === id)?.options.some(o => o.value === value)) throw new AcpConfigError("unsupported");
				if (!force && current(id) === value) continue;
				let reply: unknown;
				// The reply's snapshot and its expected echo are noted when the reply is read (onResult), not here: AGY writes the echo right behind the reply, often in the same read, and the client handles the
				// whole read before this continuation runs, so an echo noted only here would meet no expectation and count as AGY's own change.
				try { reply = await this.client.request("session/set_config_option", { sessionId: this.acpSessionId, configId: id, value }, { onResult: result => this.noteConfigReply(result) }); }
				catch (error) { if (error instanceof AcpLostError) throw error; throw new AcpConfigError("not-confirmed"); }
				if (!readConfig(isObject(reply) ? reply.configOptions : undefined)) throw new AcpConfigError("not-confirmed");
			}
			if (this.unsolicitedSeq !== before) continue;
			for (const [id, value] of wanted) if (current(id) !== value) throw new AcpConfigError("not-confirmed");
			const pair = this.pairOf(this.snapshot);
			this.ack = { model: pair.model, thought: pair.thought, selection: { ...selection } };
			return this.report(selection);
		}
		throw new AcpConfigError("not-confirmed");
	}

	/** A `set_config_option` reply, in wire order: its snapshot is what AGY now holds, and an update that repeats its pair is that call's echo. */
	private noteConfigReply(result: unknown): void {
		const next = readConfig(isObject(result) ? result.configOptions : undefined);
		if (!next) return;
		this.snapshot = next;
		this.configSource = "reply";
		this.expectedEchoes.push(this.pairOf(next));
	}

	private report(selection: AcpSelection): { model: string; effort: string | null } {
		return { model: selection.model, effort: selection.thought ?? this.snapshot.find(o => o.id === "thought_level")?.currentValue ?? null };
	}

	/** Checks that the `session/prompt` frame fits under the outbound byte cap before dispatch evidence is written. */
	checkPromptSize(text: string, maxOutboundBytes?: number): void {
		this.client.checkOutboundSize("session/prompt", { sessionId: this.acpSessionId, prompt: [{ type: "text", text }] }, maxOutboundBytes);
	}

	/** Sends `session/cancel` for the running turn if one is in flight. */
	cancel(): void {
		if (this.inTurn) this.client.notify("session/cancel", { sessionId: this.acpSessionId });
	}

	/** Sends one `session/prompt`. Resolves with AGY's own result; rejects on connection loss or cancel grace timeout (the outcome is then unknown). */
	async prompt(text: string, handlers: AcpPromptHandlers, options?: { signal?: AbortSignal; cancelGraceMs?: number; maxOutboundBytes?: number }): Promise<AcpPromptResult> {
		if (this._state !== "idle") throw new AcpLostError("not idle");
		this._state = "prompting";
		this.turnOpen = true;
		this._diverged = false;
		this.turnPair = this.ack && { model: this.ack.model, thought: this.ack.thought };
		this.active = handlers;
		const signal = options?.signal;
		const cancelGraceMs = options?.cancelGraceMs ?? 3000;
		let cancelTimer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		try {
			const req = this.client.request("session/prompt", { sessionId: this.acpSessionId, prompt: [{ type: "text", text }] }, { timeoutMs: null, maxOutboundBytes: options?.maxOutboundBytes });
			const result = await new Promise<any>((resolve, reject) => {
				let settled = false;
				const done = (fn: () => void) => {
					if (settled) return;
					settled = true;
					clearTimeout(cancelTimer);
					cancelTimer = undefined;
					if (signal && onAbort) signal.removeEventListener("abort", onAbort);
					fn();
				};
				req.then(v => done(() => resolve(v)), e => done(() => reject(e)));
				this.failPrompt = error => done(() => reject(error));
				if (signal) {
					onAbort = () => {
						if (settled || cancelTimer !== undefined) return;
						this.cancel();
						cancelTimer = setTimeout(() => done(() => reject(new AcpCancelTimeoutError())), cancelGraceMs);
					};
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
			});
			if (!isObject(result) || typeof result.stopReason !== "string") throw new AcpLostError("invalid prompt result");
			const u = result.usage;
			this.turnOpen = false;
			this.armed = true; // from here on, frames between turns can be AGY waking
			this.expectedEchoes = []; // an echo that lands after the result is an update nobody asked for
			this.move("prompting", "idle");
			return { stopReason: result.stopReason, diverged: this._diverged, usage: isObject(u) ? { input: tokens(u.inputTokens), output: tokens(u.outputTokens), cacheRead: tokens(u.cachedReadTokens), cacheWrite: tokens(u.cachedWriteTokens), totalTokens: tokens(u.totalTokens) } : undefined };
		}
		catch (error) {
			this.move("prompting", "ineligible");
			throw error;
		}
		finally {
			clearTimeout(cancelTimer);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
			this.active = undefined;
			this.failPrompt = undefined;
			this.turnPair = undefined;
		}
	}

	/** Marks the owner unusable without touching the child (an uncertain outcome, a failed save). */
	markIneligible(): void { if (this._state !== "retired") this._state = "ineligible"; }

	/** A retire during the prompt must stay retired when the prompt settles. */
	private move(from: AcpState, to: AcpState): void { if (this._state === from) this._state = to; }

	/**
	 * Ask AGY to close the session (so it stops its subagents and background tasks) and wait up to 2 s for the reply; then close stdin, TERM after 2 s, KILL 1 s later,
	 * all inside the 15 s settlement deadline. A running turn fails as lost at once, whatever AGY answers. Idempotent.
	 */
	close(): Promise<CleanupOutcome> {
		if (this.closing) return this.closing;
		const midTurn = this.turnOpen;
		this._state = "retired";
		this.failPrompt?.(new AcpLostError("closed by Pi"));
		this.abandonWake();
		// Deferred one tick so `closing` is set before anything below can call back into close() (a write that fails reports the loss).
		return this.closing = Promise.resolve().then(async () => {
			const deadline = performance.now() + BOUNDS.SETTLEMENT_DEADLINE_MS;
			const waitFor = async (ready: () => boolean, ms: number) => {
				const end = Math.min(deadline, performance.now() + ms);
				while (!ready() && performance.now() < end) await new Promise(r => setTimeout(r, 10));
				return ready();
			};
			await this.closeSession(Math.min(SESSION_CLOSE_REPLY_MS, deadline - performance.now()));
			this.client.closeInput();
			let escalated = false;
			if (this.child.pid !== undefined) {
				if (!await waitFor(() => this.seen.exit !== undefined, BOUNDS.IDLE_CLOSE_GRACE_MS)) {
					escalated = true;
					try { this.child.kill("SIGTERM"); } catch { }
					if (!await waitFor(() => this.seen.exit !== undefined, BOUNDS.SIGTERM_GRACE_MS)) {
						try { this.child.kill("SIGKILL"); } catch { }
						await waitFor(() => this.seen.exit !== undefined, BOUNDS.SIGTERM_GRACE_MS);
					}
				}
				await waitFor(() => this.seen.closed, BOUNDS.PIPE_DRAIN_MS);
			}
			const complete = this.child.pid === undefined || (this.seen.exit !== undefined && this.seen.closed);
			let classification: CleanupOutcome["classification"] = "stop-unverified";
			if (this.child.pid === undefined && complete) classification = "not-started";
			else if (complete && !escalated && !midTurn && this.seen.exit?.code === 0 && this.seen.exit.signal === null) classification = "clean";
			return Object.freeze({ classification, retirement: complete ? "complete" : performance.now() >= deadline ? "expired" : "unknown" } as CleanupOutcome);
		});
	}

	/** Sends `session/close` and resolves on the reply, an error, the loss of the link or after `ms`, whichever comes first. Sends nothing to a child that is gone or did not advertise `close`. */
	private async closeSession(ms: number): Promise<void> {
		if (!this.offersClose || !this.acpSessionId || this.client.lostError || this.child.pid === undefined || this.seen.exit !== undefined) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const reply = this.client.request("session/close", { sessionId: this.acpSessionId }, { timeoutMs: null }).then(() => undefined, () => undefined);
		await Promise.race([reply, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, ms)); })]);
		clearTimeout(timer);
	}
}
