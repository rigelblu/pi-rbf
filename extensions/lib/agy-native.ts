// Native stream-json framing, owned process and bounded cleanup reused from the
// retained pi-21 tool candidate. No Pi registration, tool grammar or recovery API.
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";

export interface ControllerTracer { record(event: string, payload: Record<string, unknown>): void }
export interface ResolvedSettings { nativeModel: string; nativeEffort?: string }
const FIXED_NOTICES = { emptySuccess:"AGY returned SUCCESS with no answer text.", taskErrorFallback:"AGY returned an error.", freshDisclosure:"Commands the earlier conversation started may still run alongside this one." };
function formatRow(state: string, _preview?: string, _body?: string): string { return `AGY — ${state}`; }
export const BOUNDS = {
	MAX_PROMPT_BYTES: 256 * 1024,
	MAX_FRAME_BYTES: 1024 * 1024,
	MAX_STDOUT_REQUEST_BYTES: 2 * 1024 * 1024,
	MAX_IDLE_STDOUT_BYTES: 64 * 1024,
	STDERR_RING_BYTES: 512 * 1024,
	SETUP_TIMEOUT_MS: 45_000,
	VERSION_PROBE_MS: 5_000,
	INTERRUPT_GRACE_MS: 3_000,
	IDLE_CLOSE_GRACE_MS: 2_000,
	SIGTERM_GRACE_MS: 1_000,
	PIPE_DRAIN_MS: 1_000,
	SETTLEMENT_DEADLINE_MS: 15_000,
	DISPLAY_ACTIVITY_TAIL_BYTES: 128 * 1024,
	DISPLAY_ANSWER_RESERVE_BYTES: 128 * 1024,
	MAX_JSON_DEPTH: 64,
	MAX_JSON_ENTRIES: 32_768,
	MAX_JSON_STRING_BYTES: 1024 * 1024,
} as const;


export const AGY_EXECUTABLE = "/Users/tomhosiawa/.local/bin/agy";
export const MIN_PI_VERSION = "1.4.0";
export const MIN_AGY_VERSION = "1.3.5";
export interface NativeUsage {
	input_tokens: number;
	output_tokens: number;
	thinking_tokens: number;
	cache_read_tokens: number;
	total_tokens: number;
}

export interface NativeToolInfo {
	name: string;
	parameters?: Record<string, unknown>;
	output?: string;
	error?: { type: string; message: string };
}

export interface DeniedAction {
	action: string;
	display_name?: string;
}

export type NativeEvent =
	| {
			kind: "init";
			conversationId: string;
			model: string;
			cwd: string;
			tools: string[];
			permissionMode: string;
	  }
	| {
			kind: "user-input";
			conversationId: string;
			index: number;
			state: "DONE";
	  }
	| {
			kind: "response";
			conversationId: string;
			index: number;
			state: "ACTIVE" | "DONE";
			textDelta?: string;
	  }
	| {
			kind: "tool";
			conversationId: string;
			index: number;
			state: "ACTIVE" | "DONE" | "ERROR";
			toolName: string;
			info?: NativeToolInfo;
			subagents?: unknown;
	  }
	| {
			kind: "checkpoint" | "system-message";
			conversationId: string;
			index: number;
			state: "ACTIVE" | "DONE";
	  }
	| {
			kind: "result";
			conversationId: string;
			status: "SUCCESS" | "ERROR";
			response?: string;
			error?: string;
			durationSeconds: number;
			numTurns: number;
			usage: NativeUsage;
			deniedActions?: DeniedAction[];
	  };

export interface CleanupOutcome {
	classification: "not-started" | "clean" | "verified-interrupted" | "stop-unverified";
	retirement: "complete" | "unknown" | "expired";
}

export interface LiveOwner {
	child: ChildProcess | null;
	conversationId: string;
	launchModel: string;
	launchEffort?: string;
	canonicalCwd: string;
	sessionId: string;
	runtime?: OwnedChildRuntime;
	lastAcceptedTurnCount: number;
	isIdle: boolean;
	closeBarrier: Promise<CleanupOutcome> | null;
	settledOutcome?: CleanupOutcome;
}


type Version = readonly [number,number,number];
export function parseVersion(text: unknown): Version | null {
	if (typeof text !== "string") return null;
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function versionAtLeast(version: Version, floor: Version): boolean {
	for (let i = 0; i < 3; i++) {
		if (version[i]! !== floor[i]!) return version[i]! > floor[i]!;
	}
	return true;
}

// Read once at load. A parse that throws counts as sandboxed, so the guard fails closed.
export type AgyVersionVerdict = "ok" | "below" | "unreadable";

// Runs `<executable> --version` with no stdin. The probe starts no conversation, so a refusal here is pre-acquisition.
export function checkAgyVersion(executable: string, timeoutMs: number = BOUNDS.VERSION_PROBE_MS): Promise<AgyVersionVerdict> {
	return new Promise(resolve => {
		let settled = false, output = "";
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (verdict: AgyVersionVerdict) => {
			if (settled) return;
			settled = true; clearTimeout(timer);
			resolve(verdict);
		};
		let child: ChildProcess;
		try { child = spawn(executable, ["--version"], { shell: false, detached: false, stdio: ["ignore", "pipe", "ignore"] }); }
		catch { finish("unreadable"); return; }
		// A hung probe is killed through its own handle, never by PID.
		timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} child.stdout?.destroy(); finish("unreadable"); }, timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => { if (output.length < 4096) output += chunk.toString("utf8"); });
		child.once("error", () => finish("unreadable"));
		child.once("close", code => {
			const version = code === 0 ? parseVersion(output) : null;
			finish(version === null ? "unreadable" : versionAtLeast(version, parseVersion(MIN_AGY_VERSION)!) ? "ok" : "below");
		});
	});
}


// ─────────────────────────────────────────────────────────────────────────────
// NDJSON Parsing and Display Sanitizer
// ─────────────────────────────────────────────────────────────────────────────

function createDisplaySanitizer() {
	let state: "ground" | "escape" | "csi" | "osc" | "string" = "ground";
	let sawEscape = false, marked = false;
	let escapeBytes = 0, highSurrogate = "";
	const marker = "[control sequence removed]";
	function start(next: typeof state, bytes: number): void {
		state = next; sawEscape = false; marked = false; escapeBytes = bytes;
	}
	function ground(): void { state = "ground"; sawEscape = false; marked = false; escapeBytes = 0; }
	return {
		feed(raw: string): string {
			let output = "";
			let text = highSurrogate + raw;
			highSurrogate = "";
			let offset = 0;
			for (const character of text) {
				offset += character.length;
				const code = character.codePointAt(0)!;
				if (state !== "ground") {
					const bytes = Buffer.byteLength(character, "utf8");
					if (bytes > 4096 - escapeBytes) {
						if (!marked) { output += marker; marked = true; }
						escapeBytes = 4096;
					} else escapeBytes += bytes;
					if (state === "osc" || state === "string") {
						if (code === 0x9c || (state === "osc" && code === 7) || (sawEscape && character === "\\")) { ground(); continue; }
						sawEscape = code === 0x1b;
						continue;
					}
					if (code === 0x1b) { state = "escape"; continue; }
					if (state === "csi") {
						if (code >= 0x40 && code <= 0x7e) ground();
						continue;
					}
					if (character === "[") { state = "csi"; continue; }
					if (character === "]") { state = "osc"; continue; }
					if (["P", "X", "^", "_"].includes(character)) { state = "string"; continue; }
					if (code >= 0x20 && code <= 0x2f) continue;
					ground();
					if (code >= 0x30 && code <= 0x7e) continue;
				}
				if (code === 0x1b) { start("escape", 1); continue; }
				if (code === 0x9b) { start("csi", 2); continue; }
				if (code === 0x9d) { start("osc", 2); continue; }
				if ([0x90, 0x98, 0x9e, 0x9f].includes(code)) { start("string", 2); continue; }
				if ((code < 0x20 && code !== 9 && code !== 10) || (code >= 0x7f && code <= 0x9f) ||
					code === 0x061c || code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) continue;
				if (code >= 0xd800 && code <= 0xdbff && offset === text.length) { highSurrogate = character; continue; }
				output += code >= 0xd800 && code <= 0xdfff ? "\ufffd" : character;
			}
			return output;
		},
		finish(): string {
			const output = (highSurrogate ? "\ufffd" : "") + (state !== "ground" && !marked ? marker : "");
			highSurrogate = ""; ground(); return output;
		},
	};
}

export function sanitizeDisplayText(raw: string): string {
	const sanitizer = createDisplaySanitizer();
	return sanitizer.feed(raw) + sanitizer.finish();
}

function takeUtf8Tail(bytes: Buffer, limit: number): Buffer {
	let start = Math.max(0, bytes.length - limit);
	while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
	return bytes.subarray(start);
}

function appendDisplayTail(current: string, addition: string, limit: number): { text: string; clipped: boolean } {
	const next = Buffer.from(addition, "utf8");
	if (next.length > limit) return { text: takeUtf8Tail(next, limit).toString("utf8"), clipped: true };
	const previous = Buffer.from(current, "utf8");
	const retained = takeUtf8Tail(previous, limit - next.length);
	return { text: Buffer.concat([retained, next], retained.length + next.length).toString("utf8"), clipped: retained.length !== previous.length };
}

function clipDisplayAnswer(text: string): { text: string; clipped: boolean } {
	const bytes = Buffer.from(sanitizeDisplayText(text), "utf8");
	const limit = BOUNDS.DISPLAY_ANSWER_RESERVE_BYTES;
	if (bytes.length <= limit) return { text: bytes.toString("utf8"), clipped: false };
	const marker = Buffer.from("\n[display truncated]", "utf8");
	let end = limit - marker.length;
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
	return { text: bytes.subarray(0, end).toString("utf8") + marker.toString("utf8"), clipped: true };
}

function isNativeObject(value: unknown): value is Record<string, any> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateNativeJson(value: unknown): boolean {
	const pending = [{ value, depth: 0 }];
	let entries = 0;
	while (pending.length > 0) {
		const item = pending.pop()!;
		if (++entries > BOUNDS.MAX_JSON_ENTRIES) return false;
		if (typeof item.value === "string") {
			if (Buffer.byteLength(item.value, "utf8") > BOUNDS.MAX_JSON_STRING_BYTES) return false;
		} else if (typeof item.value === "number") {
			if (!Number.isFinite(item.value)) return false;
		} else if (item.value !== null && typeof item.value === "object") {
			if (item.depth >= BOUNDS.MAX_JSON_DEPTH) return false;
			if (Array.isArray(item.value)) {
				if (entries + pending.length + item.value.length > BOUNDS.MAX_JSON_ENTRIES) return false;
				for (const child of item.value) pending.push({ value: child, depth: item.depth + 1 });
			} else {
				const keys = Object.keys(item.value);
				if (entries + pending.length + 2 * keys.length > BOUNDS.MAX_JSON_ENTRIES) return false;
				entries += keys.length;
				for (const key of keys) {
					if (Buffer.byteLength(key, "utf8") > BOUNDS.MAX_JSON_STRING_BYTES) return false;
					pending.push({ value: (item.value as Record<string, unknown>)[key], depth: item.depth + 1 });
				}
			}
		}
	}
	return true;
}

function nativeNonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
function nativeCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function nativeDuration(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function nativeUsage(value: unknown): value is NativeUsage {
	return isNativeObject(value) && ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens"].every(key => nativeCount(value[key]));
}

export function parseNdjsonFrame(line: string): NativeEvent | null {
	if (typeof line !== "string" || line.length === 0 || Buffer.byteLength(line, "utf8") > BOUNDS.MAX_FRAME_BYTES) return null;
	let parsed: unknown;
	try { parsed = JSON.parse(line); } catch { return null; }
	if (!isNativeObject(parsed) || !validateNativeJson(parsed)) return null;
	if (parsed.event === "init") {
		const data = parsed.init;
		if (!nativeNonempty(parsed.conversation_id) || !isNativeObject(data) || !nativeNonempty(data.model) || !nativeNonempty(data.cwd) ||
			!path.isAbsolute(data.cwd) || path.resolve(data.cwd) !== data.cwd || !Array.isArray(data.tools) || !data.tools.every(nativeNonempty) ||
			new Set(data.tools).size !== data.tools.length || !nativeNonempty(data.permission_mode)) return null;
		return { kind: "init", conversationId: parsed.conversation_id, model: data.model, cwd: data.cwd, tools: data.tools, permissionMode: data.permission_mode };
	}
	if (parsed.event === "step_update") {
		const data = parsed.step_update;
		if (!isNativeObject(data) || !nativeNonempty(data.conversation_id) || !nativeCount(data.step_index) ||
			(data.duration_seconds !== undefined && !nativeDuration(data.duration_seconds)) || (data.usage !== undefined && !nativeUsage(data.usage))) return null;
		const base = { conversationId: data.conversation_id, index: data.step_index };
		if (data.step_type === "user_input" && data.state === "DONE") return { ...base, kind: "user-input", state: "DONE" };
		if (data.step_type === "agent_response" && (data.state === "ACTIVE" || data.state === "DONE")) {
			if (data.text_delta !== undefined && typeof data.text_delta !== "string") return null;
			return { ...base, kind: "response", state: data.state, ...(data.text_delta !== undefined ? { textDelta: data.text_delta } : {}) };
		}
		if (data.step_type === "tool" && (data.state === "ACTIVE" || data.state === "DONE" || data.state === "ERROR")) {
			if (!nativeNonempty(data.tool_name)) return null;
			let info: NativeToolInfo | undefined;
			if (data.tool_info !== undefined) {
				const raw = data.tool_info;
				if (!isNativeObject(raw) || raw.name !== data.tool_name || (raw.parameters !== undefined && !isNativeObject(raw.parameters)) ||
					(raw.output !== undefined && typeof raw.output !== "string") || (raw.error !== undefined &&
						(!isNativeObject(raw.error) || !nativeNonempty(raw.error.type) || typeof raw.error.message !== "string"))) return null;
				info = { name: raw.name, ...(raw.parameters !== undefined ? { parameters: raw.parameters } : {}),
					...(raw.output !== undefined ? { output: raw.output } : {}), ...(raw.error !== undefined ? { error: { type: raw.error.type, message: raw.error.message } } : {}) };
			}
			return { ...base, kind: "tool", state: data.state, toolName: data.tool_name,
				...(info !== undefined ? { info } : {}), ...(data.subagent_info !== undefined ? { subagents: data.subagent_info } : {}) };
		}
		if ((data.step_type === "checkpoint" || data.step_type === "system_message") && (data.state === "ACTIVE" || data.state === "DONE")) {
			return { ...base, kind: data.step_type === "checkpoint" ? "checkpoint" : "system-message", state: data.state };
		}
		return null;
	}
	if (parsed.event === "result") {
		const data = parsed.result;
		if (!isNativeObject(data) || !nativeNonempty(data.conversation_id) || !["SUCCESS", "ERROR"].includes(data.status) ||
			!nativeCount(data.num_turns) || !nativeDuration(data.duration_seconds) || !nativeUsage(data.usage) ||
			(data.response !== undefined && typeof data.response !== "string") || (data.error !== undefined && typeof data.error !== "string")) return null;
		if (data.status === "SUCCESS" && (typeof data.response !== "string" || (data.error !== undefined && data.error !== ""))) return null;
		if (data.status === "ERROR" && !nativeNonempty(data.error)) return null;
		if (data.denied_actions !== undefined && (!Array.isArray(data.denied_actions) || !data.denied_actions.every((item: unknown) =>
			isNativeObject(item) && nativeNonempty(item.action) && (item.display_name === undefined || nativeNonempty(item.display_name))))) return null;
		return { kind: "result", conversationId: data.conversation_id, status: data.status, numTurns: data.num_turns,
			durationSeconds: data.duration_seconds, usage: data.usage, ...(data.response !== undefined ? { response: data.response } : {}),
			...(data.error !== undefined ? { error: data.error } : {}), ...(data.denied_actions !== undefined ? { deniedActions: data.denied_actions } : {}) };
	}
	// No supported wire shape has been admitted for error_message; it cannot supply a completion.
	return null;
}


// ─────────────────────────────────────────────────────────────────────────────
// Candidate Evidence Tracing
// ─────────────────────────────────────────────────────────────────────────────

type NativeResultEvent = Extract<NativeEvent, { kind: "result" }>;
type NativeInitEvent = Extract<NativeEvent, { kind: "init" }>;

export interface NativeResume { conversationId: string; permissionMode: string; acceptedCount: number; frontier: number }

export function createOwnedNativeProtocol(expected: { model: string; cwd: string; resume?: NativeResume }, callbacks: {
	onInit(event: NativeInitEvent): void;
	onEvent(event: NativeEvent): void;
	onBoundary(event: NativeResultEvent, accepted: boolean): void;
	onFailure(reason: string): void;
}) {
	let init: NativeInitEvent | null = null;
	let initDelivered = false;
	let failure: string | null = null;
	let closing = false, frozen = false;
	const resume = expected.resume;
	if (resume && (!resume.conversationId || !resume.permissionMode || !Number.isSafeInteger(resume.acceptedCount) || resume.acceptedCount < 1 || resume.acceptedCount >= Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(resume.frontier) || resume.frontier < 0)) throw new Error("Invalid native resume baseline");
	let acceptedCount = resume?.acceptedCount ?? 0, acceptedFrontier = resume?.frontier ?? -1, frontier = acceptedFrontier;
	let firstResumedInput = !!resume;
	let setupBytes = 0, idleBytes = 0, requestBytes = 0;
	let bufferedBytes = 0;
	const frame = Buffer.allocUnsafe(BOUNDS.MAX_FRAME_BYTES);
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const steps = new Map<number, { kind: string; state: string; toolName?: string }>();
	let request: { expectedCount: number; previousFrontier: number; writeAttempted: boolean; inputIndex: number | null; terminal: NativeResultEvent | null } | null = null;

	function fail(reason: string): void {
		if (failure !== null || frozen) return;
		failure = reason;
		try { callbacks.onFailure(reason); } catch {}
	}
	function freezeEvent<T extends NativeEvent>(event: T): T {
		const work: object[] = [event];
		while (work.length) {
			const object = work.pop()!;
			for (const child of Object.values(object)) if (child !== null && typeof child === "object") work.push(child);
			Object.freeze(object);
		}
		return event;
	}
	function deliver(event: NativeEvent): void {
		try { callbacks.onEvent(event); } catch { fail("Pi projection callback failed"); }
	}
	function acceptFrame(line: string): void {
		if (failure !== null) return;
		const parsed = parseNdjsonFrame(line);
		if (!parsed) { fail("Malformed or unsupported AGY frame"); return; }
		const event = freezeEvent(parsed);
		if (request?.terminal) { fail("Native frame followed a terminal in the same available batch"); return; }
		if (event.kind === "init") {
			if (init || event.model !== expected.model || event.cwd !== expected.cwd || (resume && (event.conversationId !== resume.conversationId || event.permissionMode !== resume.permissionMode))) { fail("Native init identity/settings mismatch"); return; }
			init = event; return;
		}
		if (!init || event.conversationId !== init.conversationId) { fail("Native frame has no matching initialized conversation"); return; }
		if (firstResumedInput && !request?.writeAttempted) { fail("Unexpected historical work before resumed input"); return; }
		if (event.kind === "result") {
			if (!request || !request.writeAttempted || event.numTurns !== request.expectedCount) { fail("Unrequested, stale or skipped native terminal"); return; }
			if (event.status === "SUCCESS" && request.inputIndex === null) { fail("Native success has no new DONE user input"); return; }
			request.terminal = event; return;
		}
		const previous = steps.get(event.index);
		const toolName = event.kind === "tool" ? event.toolName : undefined;
		if (event.index <= acceptedFrontier || (!previous && event.index <= frontier) ||
			(previous && (previous.kind !== event.kind || previous.toolName !== toolName || previous.state !== "ACTIVE"))) {
			fail("Native step identity/state frontier mismatch"); return;
		}
		if (event.kind === "user-input") {
			if (!request || !request.writeAttempted || request.inputIndex !== null || event.index <= request.previousFrontier) {
				fail("Unrequested or duplicate DONE user input"); return;
			}
			request.inputIndex = event.index;
		} else if (event.kind === "response" || event.kind === "tool") {
			if (!request || !request.writeAttempted || request.inputIndex === null) { fail("Native work has no current input boundary"); return; }
		}
		steps.set(event.index, { kind: event.kind, state: event.state, ...(toolName !== undefined ? { toolName } : {}) });
		frontier = Math.max(frontier, event.index);
		deliver(event);
	}
	function settleAvailableBatch(): void {
		if (failure !== null || bufferedBytes !== 0 || frozen) return;
		if (init && !initDelivered) {
			initDelivered = true;
			try { callbacks.onInit(init); } catch { fail("Native init callback failed"); }
		}
		if (failure !== null || !request?.terminal) return;
		const result = request.terminal;
		const accepted = request.inputIndex !== null;
		if (accepted) {
			acceptedCount = request.expectedCount;
			acceptedFrontier = frontier;
		}
		request = null; idleBytes = 0; steps.clear();
		if (!accepted) fail("Native error did not establish an accepted input boundary");
		try { callbacks.onBoundary(result, accepted); } catch { fail("Native boundary callback failed"); }
	}
	return {
		feed(chunk: Buffer): void {
			if (frozen) return;
			if (!Buffer.isBuffer(chunk)) { fail("Native stdout supplied non-byte data"); return; }
			let offset = 0;
			while (offset < chunk.length && !frozen) {
				const newline = chunk.indexOf(10, offset);
				const end = newline === -1 ? chunk.length : newline + 1;
				const length = end - offset;
				const budget = !initDelivered ? BOUNDS.MAX_STDOUT_REQUEST_BYTES : request ? BOUNDS.MAX_STDOUT_REQUEST_BYTES : BOUNDS.MAX_IDLE_STDOUT_BYTES;
				const used = !initDelivered ? setupBytes : request ? requestBytes : idleBytes;
				if (length > budget - used || length > BOUNDS.MAX_FRAME_BYTES - bufferedBytes) { fail("Native stdout/frame byte limit exceeded"); return; }
				if (!initDelivered) setupBytes += length; else if (request) requestBytes += length; else idleBytes += length;
				chunk.copy(frame, bufferedBytes, offset, end); bufferedBytes += length; offset = end;
				if (newline !== -1) {
					try { acceptFrame(decoder.decode(frame.subarray(0, bufferedBytes - 1))); }
					catch { fail("Invalid native UTF-8 frame"); }
					bufferedBytes = 0;
				}
			}
			settleAvailableBatch();
		},
		beginRequest(): number {
			if (!init || !initDelivered || failure !== null || closing || frozen || request || bufferedBytes !== 0 || acceptedCount >= Number.MAX_SAFE_INTEGER) throw new Error("Native context is not eligible for a new input");
			request = { expectedCount: acceptedCount + 1, previousFrontier: frontier, writeAttempted: false, inputIndex: null, terminal: null };
			requestBytes = 0;
			return request.expectedCount;
		},
		markWriteAttempt(): void {
			if (!request || request.writeAttempted || failure !== null || closing || frozen) throw new Error("Native write cannot be attempted");
			request.writeAttempted = true;
			firstResumedInput = false;
		},
		beginClose(): void { closing = true; },
		freeze(): void {
			if (frozen) return;
			if (bufferedBytes !== 0) fail("Native stream ended with a partial frame");
			frozen = true;
		},
		invalidate(reason: string): void { fail(reason); },
		snapshot() {
			return Object.freeze({ initialized: init !== null && initDelivered, failure, closing, frozen, bufferedBytes,
				acceptedCount, acceptedFrontier, frontier, activeRequest: request !== null,
				writeAttempted: request?.writeAttempted ?? false, expectedCount: request?.expectedCount ?? null,
				conversationId: init?.conversationId ?? null, permissionMode: init?.permissionMode ?? null });
		},
	};
}

interface OwnedTurnResult {
	success: boolean; answer?: string; error?: string; denials?: string[]; activity?: string;
	cancelled?: boolean; limitExceeded?: boolean; outcome?: CleanupOutcome; notSent?: boolean; fresh?: boolean;
	durationSeconds?: number; usage?: NativeUsage;
	}
interface OwnedTurn {
	readonly expectedCount: number;
	writeAttempted: boolean;
	writerSettled: boolean;
	writerSucceeded: boolean;
	uncertaintyRecorded: boolean;
	terminal: NativeResultEvent | null;
	accepted: boolean;
	settled: boolean;
	updatesAllowed: boolean;
	readonly sanitizer: ReturnType<typeof createDisplaySanitizer>;
	activity: string;
	activityClipped: boolean;
	onEvent(event: NativeEvent): void;
	onBoundary(event: NativeResultEvent, accepted: boolean): void;
	fail(reason: string): void;
	revoke(cancelled: boolean): void;
}
interface OwnedChildRuntime {
	readonly ready: Promise<{ success: boolean; error?: string }>;
	readonly protocol: ReturnType<typeof createOwnedNativeProtocol>;
	acquisition: "pending" | "spawned" | "not-started" | "uncertain" | "threw";
	spawnObserved: boolean;
	exit: { code: number | null; signal: string | null; at: number } | null;
	processClosed: boolean;
	readonly streams: { stdin: boolean; stdout: boolean; stderr: boolean };
	stdinFinished: boolean;
	writerPending: number;
	turn: OwnedTurn | null;
	closeStarted: number | null;
	closeDeadline: number | null;
	expired: boolean;
	revoked: boolean;
	interruptedTerminal: boolean;
	interruptAttempted: boolean;
	interruptSent: boolean;
	activeAttemptedAtClose: boolean;
	lateCleanupStarted: boolean;
	stderrTail: Buffer;
	stderrClipped: boolean;
	notify(): void;
	waitUntil(predicate: () => boolean, deadline: number): Promise<boolean>;
	revoke(): void;
	fail(reason: string): void;
	freezePipes(): void;
	recordRetirement(outcome: CleanupOutcome): void;
}

// Returns the owned record synchronously, including a pending acquisition. The
// caller stores it before awaiting ready; no async resolver can hide a handle.
export function acquireOwnedChild(settings: ResolvedSettings, cwd: string, tracer: ControllerTracer, executable: string, launchArgs: readonly string[] = [], resume?: NativeResume): LiveOwner {
	let resolveReady!: (value: { success: boolean; error?: string }) => void;
	let readySettled = false, setupTimer: ReturnType<typeof setTimeout> | undefined;
	const ready = new Promise<{ success: boolean; error?: string }>(resolve => { resolveReady = resolve; });
	const waiters = new Set<() => void>();
	let owner!: LiveOwner;
	const settleReady = (success: boolean, error?: string) => {
		if (readySettled) return;
		readySettled = true; clearTimeout(setupTimer);
		resolveReady({ success, ...(error ? { error } : {}) });
	};
	const runtime: OwnedChildRuntime = {
		ready, protocol: undefined as any, recordRetirement(outcome) { trace("retirement", { classification: outcome.classification, retirement: outcome.retirement }); }, acquisition: "pending", spawnObserved: false,
		exit: null, processClosed: false, streams: { stdin: false, stdout: false, stderr: false }, stdinFinished: false,
		writerPending: 0, turn: null, closeStarted: null, closeDeadline: null, expired: false, revoked: false,
		interruptedTerminal: false, interruptAttempted: false, interruptSent: false, activeAttemptedAtClose: false, lateCleanupStarted: false, stderrTail: Buffer.alloc(0), stderrClipped: false,
		notify() {
			for (const waiter of [...waiters]) waiter();
			if (runtime.expired && !runtime.lateCleanupStarted) void lateOwnedCleanup(owner);
		},
		waitUntil(predicate, deadline) {
			if (predicate()) return Promise.resolve(true);
			if (performance.now() >= deadline) return Promise.resolve(false);
			return new Promise(resolve => {
				let timer: ReturnType<typeof setTimeout>;
				const finish = (value: boolean) => { clearTimeout(timer); waiters.delete(check); resolve(value); };
				const check = () => { if (predicate()) finish(true); };
				waiters.add(check); timer = setTimeout(() => finish(predicate()), Math.max(0, deadline - performance.now()));
				check();
			});
		},
		revoke() {
			if (!runtime.revoked) {
				runtime.revoked = true; owner.isIdle = false;
				runtime.protocol.beginClose(); settleReady(false, "Owned acquisition was closed");
			}
			runtime.turn?.revoke(false); runtime.notify();
		},
		fail(reason) {
			settleReady(false, reason);
			runtime.turn?.fail(reason);
			void closeChildProcess(owner);
		},
		freezePipes() {
			runtime.protocol.freeze();
			for (const stream of [owner.child?.stdin, owner.child?.stdout, owner.child?.stderr]) {
				if (stream && !stream.destroyed) { try { stream.destroy(); } catch {} }
			}
		},
	};
	const trace = (event: string, payload: Record<string, unknown>) => {
		try { tracer.record(event, payload); }
		catch { runtime.fail("Candidate evidence recording failed"); }
	};
	const protocol = createOwnedNativeProtocol({ model: settings.nativeModel, cwd, resume }, {
		onInit(event) {
			if (runtime.revoked || runtime.expired || runtime.acquisition !== "spawned") { runtime.fail("Native init has no live acquisition"); return; }
			owner.conversationId = event.conversationId; owner.isIdle = true;
			trace("init_validated", { conversationId: event.conversationId });
			settleReady(true);
		},
		onEvent(event) { runtime.turn?.onEvent(event); },
		onBoundary(event, accepted) {
			if (runtime.closeStarted !== null && accepted && event.status === "ERROR" && event.error === "interrupted") runtime.interruptedTerminal = true;
			if (accepted) owner.lastAcceptedTurnCount = event.numTurns;
			trace("native_result", { conversationId: event.conversationId, numTurns: event.numTurns, status: event.status, accepted });
			runtime.turn?.onBoundary(event, accepted); runtime.notify();
		},
		onFailure(reason) { runtime.fail(reason); },
	});
	Object.defineProperty(runtime, "protocol", { value: protocol, writable: false, configurable: false });
	owner = { child: null, conversationId: "", launchModel: settings.nativeModel, launchEffort: settings.nativeEffort,
		canonicalCwd: cwd, sessionId: "", lastAcceptedTurnCount: resume?.acceptedCount ?? 0,
		isIdle: false, closeBarrier: null, runtime };
	const setupStarted = performance.now();
	setupTimer = setTimeout(() => runtime.fail("Setup timeout waiting for init"), BOUNDS.SETUP_TIMEOUT_MS);
	try {
		tracer.record("spawn_attempt", { cwd, nativeModel: settings.nativeModel, nativeEffort: settings.nativeEffort });
		const child = spawn(executable, [...launchArgs, ...(resume ? ["--conversation", resume.conversationId] : []), "--model", settings.nativeModel, ...(settings.nativeEffort ? ["--effort", settings.nativeEffort] : []),
			"--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands", "--print="],
			{ shell: false, detached: false, cwd, stdio: ["pipe", "pipe", "pipe"] });
		owner.child = child;
		child.on("spawn", () => {
			runtime.spawnObserved = true; runtime.acquisition = "spawned";
			trace("spawn_observed", { pid: child.pid }); runtime.notify();
			if (runtime.expired) void lateOwnedCleanup(owner);
		});
		child.on("error", () => {
			if (runtime.acquisition === "pending") runtime.acquisition = !runtime.spawnObserved && child.pid === undefined ? "not-started" : "uncertain";
			runtime.fail("Owned child emitted a process error"); runtime.notify();
			if (runtime.expired) void lateOwnedCleanup(owner);
		});
		child.on("exit", (code, signal) => {
			if (!runtime.exit) runtime.exit = { code, signal, at: performance.now() };
			trace("child_exit", { code, signal }); runtime.notify();
			if (runtime.closeStarted === null) runtime.fail("AGY process exited unexpectedly");
		});
		child.on("close", () => { runtime.processClosed = true; runtime.notify(); });
		for (const key of ["stdin", "stdout", "stderr"] as const) {
			const stream = child[key];
			if (!stream) { runtime.streams[key] = true; runtime.fail("Owned child pipe unavailable"); continue; }
			stream.on("close", () => { runtime.streams[key] = true; runtime.notify(); });
			stream.on("error", () => { runtime.fail(`Owned ${key} pipe error`); runtime.notify(); });
		}
		child.stdin?.on("finish", () => { runtime.stdinFinished = true; runtime.notify(); });
		child.stdout?.on("data", (chunk: Buffer) => { protocol.feed(chunk); runtime.notify(); });
		child.stdout?.on("end", () => { protocol.freeze(); if (runtime.closeStarted === null) runtime.fail("Native stdout ended unexpectedly"); runtime.notify(); });
		// stderr keeps filling its ring until freezePipes() destroys the pipe: stdout ending first must not cut off the
		// tail a failed start shows. stderr never completes a turn.
		child.stderr?.on("data", (chunk: Buffer) => {
			if (!Buffer.isBuffer(chunk)) { runtime.fail("Native stderr supplied non-byte data"); return; }
			const limit = BOUNDS.STDERR_RING_BYTES;
			if (chunk.length > limit) { runtime.stderrTail = Buffer.from(chunk.subarray(chunk.length - limit)); runtime.stderrClipped = true; }
			else {
				const retained = runtime.stderrTail.subarray(Math.max(0, runtime.stderrTail.length - (limit - chunk.length)));
				runtime.stderrClipped ||= retained.length !== runtime.stderrTail.length;
				runtime.stderrTail = Buffer.concat([retained, chunk], retained.length + chunk.length);
			}
		});
	} catch {
		// A synchronous spawn() throw leaves no child and no handle: never "not-started", but retirement is complete.
		runtime.acquisition = "threw";
		runtime.fail("Native acquisition threw before it could be observed"); runtime.notify();
	}
	if (performance.now() - setupStarted >= BOUNDS.SETUP_TIMEOUT_MS) runtime.fail("Native acquisition exceeded setup deadline");
	return owner;
}

async function retireOwnedResources(owner: LiveOwner, deadline: number): Promise<{ complete: boolean; escalated: boolean; eof: boolean }> {
	const r = owner.runtime!;
	let escalated = false, eof = false;
	await r.waitUntil(() => r.acquisition !== "pending", deadline);
	if (r.acquisition === "threw") return { complete: true, escalated, eof };
	const child = owner.child;
	if (!child || r.acquisition === "pending" || r.acquisition === "uncertain") return { complete: false, escalated, eof };
	const attempted = r.activeAttemptedAtClose;
	const signal = (name: "SIGINT" | "SIGTERM" | "SIGKILL") => {
		if (name === "SIGINT") { if (r.interruptAttempted) return; r.interruptAttempted = true; }
		if (!r.exit && r.spawnObserved) { try { const sent = child.kill(name); if (name === "SIGINT" && sent) r.interruptSent = true; } catch {} }
	};
	if (r.acquisition === "spawned" && !r.exit) {
		if (attempted) signal("SIGINT");
		else { try { child.stdin?.end(); eof = true; } catch {} }
		const grace = attempted ? BOUNDS.INTERRUPT_GRACE_MS : BOUNDS.IDLE_CLOSE_GRACE_MS;
		await r.waitUntil(() => r.exit !== null, Math.min(deadline, performance.now() + grace));
		if (!r.exit && performance.now() < deadline) {
			escalated = true; signal("SIGTERM");
			await r.waitUntil(() => r.exit !== null, Math.min(deadline, performance.now() + BOUNDS.SIGTERM_GRACE_MS));
			if (!r.exit && performance.now() < deadline) signal("SIGKILL");
		}
	}
	const observed = await r.waitUntil(() => r.exit !== null || r.acquisition === "not-started", deadline);
	if (!observed) return { complete: false, escalated, eof };
	const drainEnd = Math.min(deadline, (r.exit?.at ?? performance.now()) + BOUNDS.PIPE_DRAIN_MS);
	await r.waitUntil(() => Boolean(child.stdout?.readableEnded && child.stderr?.readableEnded), drainEnd);
	r.freezePipes();
	const complete = await r.waitUntil(() => r.acquisition !== "pending" && r.acquisition !== "uncertain" &&
		(r.exit !== null || r.acquisition === "not-started") && r.processClosed &&
		r.streams.stdin && r.streams.stdout && r.streams.stderr && r.writerPending === 0 &&
		(!r.turn || (r.turn.settled && !r.turn.updatesAllowed)), deadline);
	return { complete: complete && performance.now() < deadline, escalated, eof };
}

async function lateOwnedCleanup(owner: LiveOwner): Promise<void> {
	const r = owner.runtime!;
	if (r.lateCleanupStarted || (r.acquisition !== "spawned" && r.acquisition !== "not-started")) return;
	r.lateCleanupStarted = true;
	await retireOwnedResources(owner, performance.now() + BOUNDS.SETTLEMENT_DEADLINE_MS);
	// This cleanup can never revise the original barrier or permit replacement.
}

export function closeChildProcess(owner: LiveOwner): Promise<CleanupOutcome> {
	if (owner.closeBarrier) return owner.closeBarrier;
	const r = owner.runtime;
	if (!r) {
		const outcome: CleanupOutcome = { classification: "stop-unverified", retirement: "unknown" };
		owner.settledOutcome = outcome; owner.isIdle = false;
		return owner.closeBarrier = Promise.resolve(outcome);
	}
	r.activeAttemptedAtClose = Boolean(r.turn?.writeAttempted && !r.turn.settled);
	r.closeStarted = performance.now(); r.closeDeadline = r.closeStarted + BOUNDS.SETTLEMENT_DEADLINE_MS;
	let resolve!: (outcome: CleanupOutcome) => void;
	owner.closeBarrier = new Promise(resolver => { resolve = resolver; }); // Publish before revoke callbacks.
	r.revoke();
	void (async () => {
		const retired = await retireOwnedResources(owner, r.closeDeadline!);
		let classification: CleanupOutcome["classification"] = "stop-unverified";
		if (retired.complete && r.acquisition === "not-started" && !r.spawnObserved && owner.child?.pid === undefined) classification = "not-started";
		else if (retired.complete && !retired.escalated && r.protocol.snapshot().failure === null && r.protocol.snapshot().frozen && r.exit?.signal === null) {
			if (r.activeAttemptedAtClose && r.interruptSent && r.interruptedTerminal && r.exit.code === 1) classification = "verified-interrupted";
			else if (!r.activeAttemptedAtClose && retired.eof && r.exit?.code === 0) classification = "clean";
		}
		const outcome: CleanupOutcome = { classification, retirement: retired.complete ? "complete" : performance.now() >= r.closeDeadline! ? "expired" : "unknown" };
		r.expired = outcome.retirement !== "complete"; owner.settledOutcome = Object.freeze(outcome);
		r.recordRetirement(owner.settledOutcome);
		resolve(owner.settledOutcome);
		if (r.expired) void lateOwnedCleanup(owner); // Cleanup duty only; original deadline/verdict never change.
	})().catch(() => {
		r.expired = true;
		owner.settledOutcome = Object.freeze({ classification: "stop-unverified", retirement: "unknown" });
		resolve(owner.settledOutcome);
		void lateOwnedCleanup(owner);
	});
	return owner.closeBarrier;
}

export function executeTurn(
	owner: LiveOwner, prompt: string, expectedTurnCount: number, signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<unknown> | undefined, preview: string, tracer: ControllerTracer,
	canPublish: () => boolean, canPublishStopping: () => boolean, fresh = false,
	onToolObservation?: (event: Extract<NativeEvent, { kind: "tool" }>) => void,
	onResponse?: (text: string) => void,
): Promise<OwnedTurnResult> {
	const r = owner.runtime, child = owner.child;
	if (!r || !child || r.revoked || owner.closeBarrier || !child.stdin || r.turn && !r.turn.settled)
		return Promise.resolve({ success: false, error: "Native owner is unavailable" });
	let resolve!: (result: OwnedTurnResult) => void;
	let revokedResult: OwnedTurnResult | null = null;
	let writeDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
	const result = new Promise<OwnedTurnResult>(resolver => { resolve = resolver; });
	const publish = (state: string, body?: string) => {
		if (!turn.updatesAllowed || turn.settled || !onUpdate) return;
		if (!(state === "stopping" ? canPublishStopping() : canPublish())) { if (state !== "stopping") turn.fail("Pi dispatch authority changed"); return; }
		try { onUpdate({ content: [{ type: "text", text: formatRow(state, preview, fresh ? FIXED_NOTICES.freshDisclosure : undefined) }], details: { state, task: prompt, activity: body } }); }
		catch { if (state !== "stopping") turn.fail("Pi progress delivery failed"); }
	};
	const publishResponse = (text: string) => {
		if (!text || !onResponse || !turn.updatesAllowed || turn.settled || r.revoked) return;
		if (!canPublish()) { turn.fail("Pi dispatch authority changed"); return; }
		try { onResponse(text); } catch { turn.fail("Pi answer delivery failed"); }
	};
	const finish = (value: OwnedTurnResult) => {
		if (turn.settled) return;
		publishResponse(turn.sanitizer.finish());
		if (turn.settled) return;
		if (turn.writeAttempted && !turn.writerSettled && !turn.uncertaintyRecorded) {
			turn.uncertaintyRecorded = true;
			try { tracer.record("stdin_uncertain", { expectedTurnCount, outcome: "uncertain" }); } catch {}
		}
		turn.updatesAllowed = false; turn.settled = true;
		signal?.removeEventListener("abort", abort); clearTimeout(writeDeadlineTimer);
		value.notSent = !turn.writeAttempted; value.fresh = fresh;
		value.activity = (turn.activityClipped ? "[activity truncated]\n" : "") + turn.activity;
		if (owner.closeBarrier) void owner.closeBarrier.then(outcome => resolve({ ...value, outcome, denials: turn.terminal?.deniedActions?.map(deniedActionName) ?? value.denials }));
		else resolve(value);
		r.notify();
	};
	const failAndRetire = (reason: string, cancelled: boolean) => {
		if (turn.settled) return;
		turn.updatesAllowed = false;
		revokedResult = { success: false, error: reason, ...(cancelled ? { cancelled: true } : {}), ...(reason === "Native stdout/frame byte limit exceeded" ? { limitExceeded: true } : {}) };
		const barrier = closeChildProcess(owner);
		// Close revokes the request synchronously, so waiting on retirement here
		// cannot deadlock the resource predicate that also requires settlement.
		finish(revokedResult);
		void barrier;
	};
	const commit = () => {
		if (turn.settled || !turn.terminal || !turn.writerSettled || !turn.writerSucceeded || r.revoked) return;
		if (!turn.accepted || r.protocol.snapshot().failure || !canPublish()) { failAndRetire("Native terminal lost its dispatch authority", false); return; }
		const terminal = turn.terminal;
		const denials = terminal.deniedActions?.map(deniedActionName);
		const run = { denials, durationSeconds: terminal.durationSeconds, usage: terminal.usage };
		if (terminal.status === "SUCCESS") {
			const answer = sanitizeDisplayText(terminal.response!);
			finish({ success: true, answer, ...run });
		} else finish({ success: false, error: clipDisplayAnswer(terminal.error!).text || FIXED_NOTICES.taskErrorFallback, ...run });
	};
	const abort = () => {
		if (turn.settled) return;
		publish("stopping"); failAndRetire("Native turn was cancelled", true);
	};
	const turn: OwnedTurn = {
		expectedCount: expectedTurnCount, writeAttempted: false, writerSettled: true, writerSucceeded: false, uncertaintyRecorded: false,
		terminal: null, accepted: false, settled: false, updatesAllowed: true,
		sanitizer: createDisplaySanitizer(), activity: "", activityClipped: false,
		onEvent(event) {
			if (turn.settled || !turn.updatesAllowed || r.revoked) return;
			let text = "";
			if (event.kind === "response" && event.textDelta !== undefined) {
				publishResponse(turn.sanitizer.feed(event.textDelta));
				return;
			}
			if (event.kind === "tool") {
				// Only the owned protocol can deliver this callback; its failure retires this turn.
				onToolObservation?.(event);
				if (turn.settled || r.revoked) return;
				// Tool status is independent of the response's incremental escape state.
				// A DONE step with neither output nor error is the 1.4.9 denial shape: say what is true, without inferring a denial.
				const detail = event.info?.error ? sanitizeDisplayText(event.info.error.message).replace(/\.+$/, "")
					: event.state === "DONE" && event.info?.output === undefined ? "done, no output" : event.state.toLowerCase();
				text = `\nTool ${sanitizeDisplayText(event.toolName)}: ${detail}.\n`;
				if (event.info?.output !== undefined) text += sanitizeDisplayText(event.info.output);
			}
			if (event.kind === "user-input") tracer.record("native_input_boundary", { conversationId: event.conversationId, index: event.index });
			if (text) {
				appendOwnedActivity(turn, text);
				publish("running", (turn.activityClipped ? "[activity truncated]\n" : "") + turn.activity);
			}
		},
		onBoundary(event, accepted) {
			turn.terminal = event; turn.accepted = accepted;
			if (!turn.writerSettled && !writeDeadlineTimer) writeDeadlineTimer = setTimeout(() => failAndRetire("Native write callback remained uncertain", false), BOUNDS.SETTLEMENT_DEADLINE_MS);
			commit();
		},
		fail(reason) { failAndRetire(reason, false); },
		revoke(cancelled) {
			if (!turn.settled) finish(revokedResult ?? { success: false, error: "Native turn authority was revoked", ...(cancelled ? { cancelled: true } : {}) });
		},
	};
	r.turn = turn; owner.isIdle = false;
	if (signal?.aborted || !canPublish()) { failAndRetire("Native prompt was not sent: dispatch authority changed", Boolean(signal?.aborted)); return result; }
	signal?.addEventListener("abort", abort, { once: true });
	try {
		const count = r.protocol.beginRequest();
		if (count !== expectedTurnCount) throw new Error("Native accepted count mismatch");
		const bytes = Buffer.from(JSON.stringify({ event: "user", message: { content: prompt } }) + "\n", "utf8");
		if (!canPublish() || signal?.aborted) throw new Error("Native prompt was not sent: dispatch authority changed");
		tracer.record("stdin_attempt", { expectedTurnCount, byteLength: bytes.length, hash: createHash("sha256").update(bytes).digest("hex") });
		let callbackCalled = false;
		const callback = (error?: Error | null) => {
			if (callbackCalled) { r.fail("Native write callback repeated"); return; }
			callbackCalled = true; r.writerPending--; turn.writerSettled = true; turn.writerSucceeded = !error;
			try { tracer.record("stdin_callback", { success: !error }); }
			catch { failAndRetire("Candidate evidence recording failed", false); }
			r.notify();
			if (error) { failAndRetire("Native stdin write failed; delivery is uncertain", false); return; }
			commit();
		};
		// false is ordinary backpressure; only this callback establishes write completion.
		try {
			r.protocol.markWriteAttempt(); turn.writeAttempted = true; turn.writerSettled = false; r.writerPending++;
			child.stdin.write(bytes, callback);
		}
		catch { failAndRetire("Native stdin write threw; delivery is uncertain", false); }
		publish("running");
	} catch { failAndRetire("Native prompt dispatch failed", false); }
	return result;
}

// Each denied action shows its display_name, falling back to the action when AGY sends none.
function deniedActionName(item: DeniedAction): string {
	return sanitizeDisplayText(item.display_name ?? item.action);
}

function projectedTextCost(bytes: Buffer): number {
	if (bytes.length === 0) return 0;
	let cost = bytes.length + 5; // Covers plain "│ " and the TUI's one-inset " │ " UTF-8 prefixes.
	for (const byte of bytes) if (byte === 10) cost += 5;
	return cost;
}

function takeProjectedText(bytes: Buffer, limit: number, tail: boolean): Buffer {
	if (projectedTextCost(bytes) <= limit) return bytes;
	let remaining = Math.max(0, limit - 5);
	if (tail) {
		let start = bytes.length;
		while (start > 0) {
			const cost = bytes[start - 1] === 10 ? 6 : 1;
			if (cost > remaining) break;
			remaining -= cost; start--;
		}
		while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
		return bytes.subarray(start);
	}
	let end = 0;
	while (end < bytes.length) {
		const cost = bytes[end] === 10 ? 6 : 1;
		if (cost > remaining) break;
		remaining -= cost; end++;
	}
	while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end);
}

function clipProjectedText(text: string, limit: number): string {
	const bytes = Buffer.from(sanitizeDisplayText(text), "utf8");
	if (projectedTextCost(bytes) <= limit) return bytes.toString("utf8");
	const marker = Buffer.from("\n[display truncated]", "utf8");
	const prefix = takeProjectedText(bytes, Math.max(0, limit - projectedTextCost(marker) - 4), false);
	return prefix.toString("utf8") + marker.toString("utf8");
}

function appendOwnedActivity(turn: OwnedTurn, addition: string): void {
	const marker = Buffer.from("[activity truncated]\n", "utf8");
	const budget = BOUNDS.DISPLAY_ACTIVITY_TAIL_BYTES - projectedTextCost(marker) - 8;
	const tail = appendDisplayTail(turn.activity, addition, BOUNDS.DISPLAY_ACTIVITY_TAIL_BYTES);
	const bytes = Buffer.from(tail.text, "utf8");
	const kept = takeProjectedText(bytes, budget, true);
	turn.activityClipped ||= tail.clipped || kept.length !== bytes.length;
	turn.activity = kept.toString("utf8");
}

