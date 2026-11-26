// JSON-RPC 2.0 over the stdio of one `agy acp` child (ACP 1.5.3, newline-delimited frames).
// This is the transport only: no Pi, no session state, no policy. A bad frame, a lost child or an
// expired request ends the connection ("lost"); nothing is ever resent.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { wireLog, wireLogOn } from "./agy-wire-log.js";

export const ACP_BOUNDS = {
	/** AGY sends each tool output twice (`rawOutput.output` and the text content), so one ~1 MB output is a ~2 MB frame. Same ceiling as the CLI route's 1 MiB per output. */
	MAX_FRAME_BYTES: 2 * 1024 * 1024,
	MAX_OUTBOUND_BYTES: 4 * 1024 * 1024,
	REQUEST_TIMEOUT_MS: 30_000,
	MAX_INBOUND_REQUESTS: 32,
} as const;

export type RpcId = number | string;

/** The connection can no longer be trusted or used. `reason` is Pi-written text, never AGY's. */
export class AcpLostError extends Error {
	constructor(readonly reason: string) {
		super(`AGY ACP link ended: ${reason}`);
		this.name = "AcpLostError";
	}
}

/**
 * An error AGY answered with, or one Pi answers an AGY request with. `wireMessage` is never put into Error.message.
 * Pi's automatic retry takes a 429, 500, 502, 503, 504, 520 or 524 in an error text for an HTTP status (Pi 0.85 finds it anywhere in the text, Pi 1.6 when nothing alphanumeric touches it) and retries. The provider never
 * resends a prompt AGY may have run, so Tom would end on that refusal instead of AGY's error. A code that holds one of those numbers anywhere (429, -32500) is therefore written with its digits apart, `4 2 9`;
 * every other code, AGY's usual -32603 among them, is written as it is.
 */
export class AcpRpcError extends Error {
	constructor(readonly code: number, readonly wireMessage?: string) {
		const plain = String(code), digits = plain.replace("-", "");
		super(`AGY ACP request failed (code ${/429|500|502|503|504|520|524/.test(plain) ? (plain.startsWith("-") ? "-" : "") + [...digits].join(" ") : plain})`);
		this.name = "AcpRpcError";
	}
}

/** An outbound request would exceed the frame byte ceiling, so nothing was written. */
export class AcpOversizeRequestError extends Error {
	constructor() {
		super("AGY ACP request is too large");
		this.name = "AcpOversizeRequestError";
	}
}

/**
 * A reply that wants to know whether it reached the link. A handler of AGY's requests returns one when something must be recorded only for a reply AGY was actually sent
 * (a permission answer). `written` runs once the reply's fate is known: `true` after the bytes were handed to the child's stdin, `false` when the reply was dropped (the link was lost or
 * closed, the reply was too large or not JSON) or the write failed. It never runs for a handler that throws.
 */
export class AcpReply {
	constructor(readonly value: unknown, readonly written: (delivered: boolean) => void) {}
}

export interface AcpHandlers {
	notification?(method: string, params: any): void;
	/** Answer one AGY request. Return the JSON result, or throw `AcpRpcError` for a typed error; anything else becomes -32603. Unset means -32601. */
	request?(method: string, params: any, id: RpcId): unknown | Promise<unknown>;
	/** Called once, with the reason, when the connection is lost. Not called after a deliberate `closeInput()`. */
	lost?(error: AcpLostError): void;
}

export interface AcpClientOptions {
	maxFrameBytes?: number;
	maxOutboundBytes?: number;
	requestTimeoutMs?: number;
}

type Pending = { resolve(value: any): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout>; onResult?: (result: unknown) => void };
const isObject = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is RpcId => typeof v === "string" || (typeof v === "number" && Number.isSafeInteger(v));

/** What the message log keeps of a frame AGY sent: its kind, method, id, and the ids and states in it. Never a text, a command or an output. */
function wireIn(kind: "request" | "notification" | "response", frame: Record<string, any>): void {
	if (!wireLogOn()) return;
	const params = isObject(frame.params) ? frame.params : undefined, update = params && isObject(params.update) ? params.update : undefined, toolCall = params && isObject(params.toolCall) ? params.toolCall : undefined;
	wireLog("in", {
		kind, method: frame.method, id: frame.id, code: isObject(frame.error) ? frame.error.code : undefined,
		sessionUpdate: update?.sessionUpdate, status: update?.status,
		toolCallId: update?.toolCallId ?? toolCall?.toolCallId ?? params?.toolCallId,
	});
}

export class AcpClient {
	private readonly pending = new Map<number, Pending>();
	private readonly inbound = new Set<RpcId>();
	private readonly maxFrame: number;
	private readonly maxOutbound: number;
	private readonly timeoutMs: number;
	private readonly utf8 = new TextDecoder("utf-8", { fatal: true });
	private buffered: Buffer = Buffer.alloc(0);
	private nextId = 1;
	private closing = false;
	private failure: AcpLostError | undefined;

	constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly handlers: AcpHandlers = {}, options: AcpClientOptions = {}) {
		this.maxFrame = options.maxFrameBytes ?? ACP_BOUNDS.MAX_FRAME_BYTES;
		this.maxOutbound = options.maxOutboundBytes ?? ACP_BOUNDS.MAX_OUTBOUND_BYTES;
		this.timeoutMs = options.requestTimeoutMs ?? ACP_BOUNDS.REQUEST_TIMEOUT_MS;
		child.stdout.on("data", this.onData);
		child.stdout.on("error", () => this.lose("output stream failed"));
		child.stdout.on("end", () => this.lose("AGY closed its output"));
		child.stdin.on("error", () => this.lose("input stream failed"));
		child.stderr.on("data", () => { /* drained and dropped: AGY's diagnostics may hold account text */ });
		child.stderr.on("error", () => { });
		child.on("error", () => this.lose("AGY could not be started"));
		child.on("exit", () => this.lose("AGY exited"));
	}

	get lostError(): AcpLostError | undefined { return this.failure; }

	checkOutboundSize(method: string, params: unknown, maxOutboundBytes?: number): void {
		this.encode({ jsonrpc: "2.0", id: this.nextId, method, params }, maxOutboundBytes);
	}

	/**
	 * `onResult` runs in wire order: the moment the reply is read, before any later line of the same read is handled. A caller that must know about a reply before it sees what AGY sent right after it
	 * (an echo in the same read) cannot wait for the promise: its continuation runs only after the whole read has been handled.
	 */
	request<T = any>(method: string, params: unknown, options: { timeoutMs?: number | null; maxOutboundBytes?: number; onResult?: (result: unknown) => void } = {}): Promise<T> {
		if (this.failure) return Promise.reject(this.failure);
		const id = this.nextId;
		let text: string;
		try { text = this.encode({ jsonrpc: "2.0", id, method, params }, options.maxOutboundBytes); }
		catch (error) { return Promise.reject(error); }
		this.nextId = id + 1;
		return new Promise<T>((resolve, reject) => {
			const entry: Pending = { resolve, reject, onResult: options.onResult };
			const timeout = options.timeoutMs === undefined ? this.timeoutMs : options.timeoutMs;
			if (timeout !== null) entry.timer = setTimeout(() => this.lose("request timed out"), timeout);
			this.pending.set(id, entry);
			this.write(text, delivered => wireLog("out", { kind: "request", method, id, delivered }));
		});
	}

	notify(method: string, params?: unknown): void {
		if (this.failure) return;
		try { this.write(this.encode({ jsonrpc: "2.0", method, params }), delivered => wireLog("out", { kind: "notification", method, delivered })); }
		catch { /* An oversized notification is dropped; the connection stays usable. */ }
	}

	/** Deliberate end of this side's input. Pending requests fail; the child's exit is no longer a loss. */
	closeInput(): void {
		this.closing = true;
		this.failAll(new AcpLostError("closed by Pi"));
		try { this.child.stdin.end(); } catch { }
	}

	private encode(frame: object, maxOutboundBytes?: number): string {
		const text = JSON.stringify(frame) + "\n";
		if (Buffer.byteLength(text) > (maxOutboundBytes ?? this.maxOutbound)) throw new AcpOversizeRequestError();
		return text;
	}

	private write(text: string, done?: (delivered: boolean) => void): void {
		let told = false;
		const tell = (delivered: boolean) => { if (told) return; told = true; try { done?.(delivered); } catch { } };
		try { this.child.stdin.write(text, error => { if (error) this.lose("write failed"); tell(!error); }); }
		catch { this.lose("write failed"); tell(false); }
	}

	private lose(reason: string): void {
		if (this.failure || this.closing) return;
		const error = this.failure = new AcpLostError(reason);
		this.failAll(error);
		try { this.handlers.lost?.(error); } catch { }
	}

	private failAll(error: Error): void {
		for (const [id, entry] of this.pending) {
			clearTimeout(entry.timer);
			this.pending.delete(id);
			entry.reject(error);
		}
	}

	private readonly onData = (chunk: Buffer): void => {
		if (this.failure || this.closing) return;
		const buf = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
		let start = 0;
		for (;;) {
			const end = buf.indexOf(0x0a, start);
			if (end < 0) break;
			this.line(buf.subarray(start, end));
			if (this.failure || this.closing) return;
			start = end + 1;
		}
		const rest = buf.subarray(start);
		if (rest.length > this.maxFrame) { this.lose("frame too large"); return; }
		this.buffered = Buffer.from(rest);
	};

	private line(bytes: Buffer): void {
		if (bytes.length > this.maxFrame) { this.lose("frame too large"); return; }
		if (bytes.at(-1) === 0x0d) bytes = bytes.subarray(0, -1);
		if (!bytes.length) return;
		let frame: unknown;
		try { frame = JSON.parse(this.utf8.decode(bytes)); }
		catch { this.lose("invalid frame"); return; }
		if (!isObject(frame) || frame.jsonrpc !== "2.0" || ("params" in frame && frame.params !== undefined && frame.params !== null && typeof frame.params !== "object")) { this.lose("invalid frame"); return; }
		const hasMethod = typeof frame.method === "string", hasId = "id" in frame, outcome = ("result" in frame ? 1 : 0) + ("error" in frame ? 1 : 0);
		if (hasMethod && outcome === 0) {
			if (!hasId) { wireIn("notification", frame); try { this.handlers.notification?.(frame.method, frame.params); } catch { } return; }
			if (!isId(frame.id)) { this.lose("invalid frame"); return; }
			wireIn("request", frame);
			this.serve(frame.method, frame.params, frame.id);
			return;
		}
		if (hasId && outcome === 1 && !("method" in frame)) { wireIn("response", frame); this.respond(frame); return; }
		this.lose("invalid frame");
	}

	private respond(frame: Record<string, any>): void {
		const entry = typeof frame.id === "number" ? this.pending.get(frame.id) : undefined;
		if (!entry) { this.lose("response to an unknown request"); return; }
		this.pending.delete(frame.id);
		clearTimeout(entry.timer);
		if ("error" in frame) {
			const code = isObject(frame.error) && Number.isSafeInteger(frame.error.code) ? frame.error.code : -32603;
			const msg = isObject(frame.error) && typeof frame.error.message === "string" ? frame.error.message : undefined;
			entry.reject(new AcpRpcError(code, msg));
		}
		else {
			try { entry.onResult?.(frame.result); } catch { /* a caller's bookkeeping must not break the link */ }
			entry.resolve(frame.result);
		}
	}

	private serve(method: string, params: any, id: RpcId): void {
		if (this.inbound.has(id) || this.inbound.size >= ACP_BOUNDS.MAX_INBOUND_REQUESTS) { this.lose("too many requests from AGY"); return; }
		this.inbound.add(id);
		const reply = (frame: object, written?: (delivered: boolean) => void) => {
			this.inbound.delete(id);
			const tell = (delivered: boolean) => {
				if (wireLogOn()) {
					const outcome = isObject((frame as any).result) && isObject((frame as any).result.outcome) ? (frame as any).result.outcome : undefined;
					wireLog("out", { kind: "reply", id, outcome: outcome?.outcome, optionId: outcome?.optionId, code: isObject((frame as any).error) ? (frame as any).error.code : undefined, delivered });
				}
				try { written?.(delivered); } catch { }
			};
			if (this.failure || this.closing) return tell(false);
			let text: string;
			try { text = this.encode({ jsonrpc: "2.0", id, ...frame }); }
			catch { this.lose("reply too large"); return tell(false); }
			this.write(text, tell);
		};
		const answer = async () => {
			if (!this.handlers.request) return reply({ error: { code: -32601, message: "Method not found" } });
			let handed: AcpReply | undefined;
			try {
				const answer = await this.handlers.request(method, params, id), result = answer instanceof AcpReply ? answer.value : answer;
				if (answer instanceof AcpReply) handed = answer;
				if (JSON.stringify(result) === undefined && result !== undefined) throw new Error("not JSON");
				reply({ result: result === undefined ? null : result }, handed?.written);
			}
			catch (error) {
				if (handed) try { handed.written(false); } catch { } // its value could not be sent, so the error below goes instead
				// Neither Pi's generic exception text nor AGY's request text goes back over the wire; only an explicit AcpRpcError wireMessage does.
				if (error instanceof AcpRpcError) reply({ error: { code: error.code, message: error.wireMessage ?? (error.code === -32601 ? "Method not found" : "Request refused") } });
				else reply({ error: { code: -32603, message: "Internal error" } });
			}
		};
		void answer();
	}
}
