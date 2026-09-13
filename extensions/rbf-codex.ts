// rbf-codex — use Codex's full agent harness through Pi (#pi-10, v0.21.0).
//
// Pi spawns `codex app-server` over stdio as a direct child, one per Pi session, and
// sends each turn the user messages since the last answer. Codex owns context, tools,
// sandbox, approval policy, and compaction; Pi passes no policy and declines every
// server request. One Pi conversation maps to one Codex thread, recorded as one
// `rbf-codex-thread/v1` entry in the session log. Codex's real model list sits in Pi's
// picker tagged "(Codex agent)"; the picked model and thinking level go on every
// `turn/start`. A turn running when Pi exits is not recovered.
import { parseArgs, type ExtensionAPI, type ExtensionContext, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEventStream, Context, Model, RefreshModelsContext, SimpleStreamOptions, ThinkingLevel } from "@earendil-works/pi-ai";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";

export const PROVIDER_ID = "rbf-codex";
export const API_ID = "rbf-codex-app-server";
export const BOOTSTRAP_MODEL_ID = "codex";
/** Catalog ids wear this prefix so the picker row never collides with Pi's built-in `openai-codex` rows that list the same Codex ids. */
export const CATALOG_ID_PREFIX = "codex-";
export const ENTRY_TYPE = "rbf-codex-thread/v1";
export const CODEX_FALLBACK_BIN = "/Users/tomhosiawa/.local/bin/codex";
export const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SETUP_TIMEOUT_MS = 15_000;
const INTERRUPT_WAIT_MS = 3_000;
const STDERR_TAIL_LINES = 64;
const workingLineMax = () => Math.max(20, (process.stdout.columns ?? 120) - 8);

export type ThreadEntry = { threadId: string; cwd: string; sessionId: string };
type Rec = Record<string, unknown>;
type JsonRpc = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };

export const COPY = {
	"codex-missing": "Codex CLI not found. Install Codex, check `codex --version`, and send again.",
	"codex-logged-out": "Codex is not logged in. Run `codex login`, then send again.",
	"workspace-mismatch": "This conversation's Codex thread belongs to another directory. Start a new Pi conversation here, or reopen it from that directory.",
	"unsupported-input": "Codex accepts plain text only in this version. Remove the image and send again.",
	"codex-stopped": "Codex stopped unexpectedly. Send your message again to continue this conversation.",
	"turn-failed": "Codex could not complete this request. Send your message again or start a new Pi conversation.",
	"no-answer": "Codex finished without an answer. Send your message again.",
	generic: "Codex is unavailable. See the notice for details.",
} as const;
export type CopyKey = keyof typeof COPY;

export const NOTICE = {
	declined: (what: string) => `Codex asked for ${what}; this version cannot answer, so it was declined.`,
	coldStart: "Codex starts cold; it has not seen this transcript.",
	retiredModel: (model: string) => `Codex no longer offers ${model}; this turn used Codex's default model. Pick another in the model picker.`,
	compact: "Codex manages its own context; /compact is not needed in a Codex conversation.",
	interrupted: "Your last Codex request was interrupted when Pi closed. Send it again, or ask Codex what happened.",
	treeSummary: "Navigated a Codex conversation; Codex keeps its own context.",
	policy: (approval: string, sandbox: string) => `Codex: approval ${approval}, sandbox ${sandbox}.`,
} as const;

/** Codex reports commands wrapped in the login shell (`/bin/zsh -lc '<cmd>'`); show what the user would have typed. */
export function displayCommand(command: string): string {
	const m = /^\/bin\/(?:zsh|bash|sh) -lc (.*)$/s.exec(command);
	if (!m) return command;
	const inner = m[1];
	return /^'(.*)'$/s.test(inner) ? inner.slice(1, -1) : inner;
}

/** Which server requests are questions for the human; every request is declined, these also get a notice. */
export function humanRequestKind(method: string): "approval" | "input" | undefined {
	if (/approval/i.test(method)) return "approval";
	if (/requestUserInput|elicitation/i.test(method)) return "input";
	return undefined;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const ZERO_USAGE = { ...ZERO_COST, totalTokens: 0, cost: { ...ZERO_COST, total: 0 } };
const SENTINEL = 1_000_000_000; // keeps Pi's threshold compaction from ever firing
const PI_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** The user pressed Escape while a setup request was in flight. */
class AbortedError extends Error {}

export class CodexError extends Error {
	constructor(
		readonly key: CopyKey,
		readonly detail?: string,
	) {
		super(COPY[key]);
	}
}

function rec(v: unknown): Rec {
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new CodexError("generic", "Codex returned a non-object");
	return v as Rec;
}

// ── catalog ──────────────────────────────────────────────────────────────────
export const BOOTSTRAP_MODEL: ProviderModelConfig = {
	id: BOOTSTRAP_MODEL_ID,
	name: "Codex agent",
	reasoning: true,
	thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	input: ["text"],
	contextWindow: SENTINEL,
	maxTokens: SENTINEL,
	cost: ZERO_COST,
};

type CodexModel = { id: string; displayName: string; hidden: boolean; supportedReasoningEfforts: { reasoningEffort: string }[] };

/** Pi model id → the id Codex expects on `turn/start`; the bootstrap row sends none. */
export function codexModelId(piModelId: string): string | undefined {
	if (piModelId === BOOTSTRAP_MODEL_ID) return undefined;
	return piModelId.startsWith(CATALOG_ID_PREFIX) ? piModelId.slice(CATALOG_ID_PREFIX.length) : piModelId;
}

/** One Codex `model/list` entry → Pi model config. Pi offers `xhigh` and `max` only when the map names them. */
export function toProviderModel(m: CodexModel): ProviderModelConfig {
	const efforts = new Set(m.supportedReasoningEfforts.map((e) => e.reasoningEffort));
	const thinkingLevelMap: Record<string, string | null> = { minimal: null };
	for (const level of PI_LEVELS) if (level !== "minimal") thinkingLevelMap[level] = efforts.has(level) ? level : null;
	return {
		id: `${CATALOG_ID_PREFIX}${m.id}`,
		name: `${m.displayName} (Codex agent)`,
		reasoning: true,
		thinkingLevelMap,
		input: ["text"], // text-only until pi-10.3 carries images; Pi's editor then blocks a paste up front
		contextWindow: SENTINEL,
		maxTokens: SENTINEL,
		cost: ZERO_COST,
	};
}

/** Pi's persisted store holds full `Model` objects; map them back to registration configs. */
function storedToConfigs(stored: RefreshModelsContext["stored"]): ProviderModelConfig[] {
	return (stored?.models ?? [])
		.filter((m) => m.id !== BOOTSTRAP_MODEL_ID)
		// A store written before the prefix existed holds bare Codex ids; normalize so no session ever sees both forms.
		.map((m) => ({ id: m.id.startsWith(CATALOG_ID_PREFIX) ? m.id : `${CATALOG_ID_PREFIX}${m.id}`, name: m.name, reasoning: m.reasoning, thinkingLevelMap: m.thinkingLevelMap, input: m.input, contextWindow: m.contextWindow, maxTokens: m.maxTokens, cost: m.cost }));
}

function toStoredModel(c: ProviderModelConfig): Model<typeof API_ID> {
	return { id: c.id, name: c.name, api: API_ID, provider: PROVIDER_ID, baseUrl: "stdio://codex", reasoning: c.reasoning, thinkingLevelMap: c.thinkingLevelMap, input: c.input, cost: c.cost, contextWindow: c.contextWindow, maxTokens: c.maxTokens };
}

export function mapEffort(model: Model<any>, level: ThinkingLevel | undefined): string | undefined {
	if (!level) return undefined;
	const mapped = model.thinkingLevelMap?.[level];
	return typeof mapped === "string" ? mapped : undefined;
}

// ── Pi's assistant-message event protocol, one writer per turn ───────────────
// Pi rebuilds the message from `partial` snapshots indexed by content block, so thinking
// and text interleave as separate blocks: switching kind closes the open block and opens a new one.
export class AssistantMessageWriter {
	readonly stream = createAssistantMessageEventStream();
	private readonly partial: AssistantMessage;
	private open: { kind: "thinking" | "text"; index: number } | null = null;
	private ended = false;

	constructor(model: Model<any>) {
		this.partial = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: ZERO_USAGE, stopReason: "stop", timestamp: Date.now() };
	}

	private snap(): AssistantMessage {
		return { ...this.partial, content: this.partial.content.map((b) => ({ ...b })) };
	}

	private closeBlock(): void {
		if (!this.open) return;
		const b = this.partial.content[this.open.index] as { text?: string; thinking?: string };
		if (this.open.kind === "text") this.stream.push({ type: "text_end", contentIndex: this.open.index, content: b.text ?? "", partial: this.snap() });
		else this.stream.push({ type: "thinking_end", contentIndex: this.open.index, content: b.thinking ?? "", partial: this.snap() });
		this.open = null;
	}

	private delta(kind: "thinking" | "text", text: string): void {
		if (!text || this.ended) return;
		if (this.open?.kind !== kind) {
			this.closeBlock();
			const index = this.partial.content.length;
			this.partial.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
			this.open = { kind, index };
			this.stream.push(kind === "text" ? { type: "text_start", contentIndex: index, partial: this.snap() } : { type: "thinking_start", contentIndex: index, partial: this.snap() });
		}
		const b = this.partial.content[this.open.index] as { text?: string; thinking?: string };
		if (kind === "text") b.text = (b.text ?? "") + text;
		else b.thinking = (b.thinking ?? "") + text;
		this.stream.push(kind === "text" ? { type: "text_delta", contentIndex: this.open.index, delta: text, partial: this.snap() } : { type: "thinking_delta", contentIndex: this.open.index, delta: text, partial: this.snap() });
	}

	start(): void {
		this.stream.push({ type: "start", partial: this.snap() });
	}
	thinking(text: string): void {
		this.delta("thinking", text);
	}
	text(text: string): void {
		this.delta("text", text);
	}
	/** The newest non-empty line of the open thinking block; feeds the working line. */
	lastThinkingLine(): string {
		if (this.open?.kind !== "thinking") return "";
		const b = this.partial.content[this.open.index] as { thinking?: string };
		return (b.thinking ?? "").split("\n").filter(Boolean).pop()?.trim() ?? "";
	}
	/** Terminal event; `errorMessage` is always one of the fixed COPY sentences, never Codex text. */
	finish(kind: "done" | "aborted" | "error", errorKey?: CopyKey): void {
		if (this.ended) return;
		this.ended = true;
		this.closeBlock();
		const message: AssistantMessage = { ...this.partial, timestamp: Date.now(), stopReason: kind === "done" ? "stop" : kind };
		if (kind === "done") this.stream.push({ type: "done", reason: "stop", message });
		else {
			message.errorMessage = kind === "aborted" ? "Request was aborted" : COPY[errorKey ?? "generic"];
			this.stream.push({ type: "error", reason: kind, error: message });
		}
		this.stream.end(message);
	}
}

// ── stdio JSON-RPC client; one per Pi session, not detached ──────────────────
export class AppServerClient {
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private readonly listeners = new Set<(m: JsonRpc) => void>();
	readonly stderrTail: string[] = [];
	exited = false;
	readonly onExit = new Set<() => void>();

	private constructor(readonly child: ChildProcessWithoutNullStreams) {
		// A write that lands after Codex died raises EPIPE on stdin; unhandled, that exits Pi. `exit` follows anyway.
		child.stdin.on("error", () => {});
		createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
		child.stderr.on("data", (chunk: Buffer | string) => {
			for (const l of String(chunk).split("\n")) if (l.trim()) this.stderrTail.push(l.trim());
			while (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
		});
		child.once("exit", () => {
			this.exited = true;
			for (const p of [...this.pending.values()]) p.reject(new CodexError("codex-stopped", this.lastStderr()));
			for (const fn of this.onExit) fn();
		});
	}

	static async start(cwd: string, command: CodexCommand): Promise<AppServerClient> {
		const trySpawn = (bin: string) =>
			new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
				const child = spawn(bin, command.args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
				child.once("spawn", () => resolve(child));
				child.once("error", reject);
			});
		let child: ChildProcessWithoutNullStreams;
		try {
			child = await trySpawn(command.bin);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new CodexError("generic", String(e));
			if (!command.fallbackBin) throw new CodexError("codex-missing");
			try {
				child = await trySpawn(command.fallbackBin);
			} catch {
				throw new CodexError("codex-missing");
			}
		}
		return new AppServerClient(child);
	}

	lastStderr(): string | undefined {
		return this.stderrTail[this.stderrTail.length - 1];
	}

	private receive(line: string): void {
		let m: JsonRpc;
		try {
			m = JSON.parse(line) as JsonRpc;
		} catch {
			return;
		}
		if (m.id !== undefined && m.method) {
			// Every server request is declined at once; nothing waits on the human in this version.
			this.write({ id: m.id, error: { code: -32601, message: "pi-rbf-codex does not answer server requests" } });
			for (const fn of this.listeners) fn(m);
			return;
		}
		if (typeof m.id === "number") {
			const p = this.pending.get(m.id);
			if (!p) return; // a reply that already timed out or was aborted
			if (m.error) p.reject(new CodexError("generic", m.error.message));
			else p.resolve(m.result);
			return;
		}
		if (m.method) for (const fn of this.listeners) fn(m);
	}

	private write(m: JsonRpc): void {
		if (this.exited || !this.child.stdin.writable) return;
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
	}

	request(method: string, params: unknown, timeoutMs = SETUP_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
		if (this.exited) return Promise.reject(new CodexError("codex-stopped", this.lastStderr()));
		if (signal?.aborted) return Promise.reject(new AbortedError());
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const done = (fn: () => void) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.pending.delete(id);
				fn();
			};
			const onAbort = () => done(() => reject(new AbortedError()));
			const timer = setTimeout(() => done(() => reject(new CodexError("generic", `Timed out waiting for ${method}`))), timeoutMs);
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(id, { resolve: (v) => done(() => resolve(v)), reject: (e) => done(() => reject(e)) });
			this.write({ id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		this.write({ method, params });
	}

	subscribe(fn: (m: JsonRpc) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	/** stdin EOF, 2 s, SIGTERM, 1 s, SIGKILL. The probe showed Codex exits on EOF in about 250 ms. */
	async close(): Promise<void> {
		if (this.exited) return;
		const exited = new Promise<void>((resolve) => this.onExit.add(resolve));
		const wait = (ms: number) => Promise.race([exited, new Promise<void>((r) => setTimeout(r, ms))]);
		this.child.stdin.end();
		await wait(2_000);
		if (this.exited) return;
		this.child.kill("SIGTERM");
		await wait(1_000);
		if (!this.exited) this.child.kill("SIGKILL");
	}
}

export type CodexCommand = { bin: string; args: string[]; fallbackBin?: string };
export type RbfCodexOptions = {
	/** How to spawn the app-server; tests point this at a fake. */
	command?: CodexCommand;
	/** Frozen argv for the `--sandbox` guard; defaults to `process.argv.slice(2)`. */
	argv?: string[];
	/** Clock for catalog freshness; tests inject one. */
	now?: () => number;
};

const DEFAULT_COMMAND: CodexCommand = { bin: "codex", args: ["app-server"], fallbackBin: CODEX_FALLBACK_BIN };

export function isSandboxLaunch(argv: string[]): boolean {
	return parseArgs(argv).unknownFlags.has("sandbox");
}

// ── the extension ────────────────────────────────────────────────────────────
export function createRbfCodex(options: RbfCodexOptions = {}) {
	const command = options.command ?? DEFAULT_COMMAND;
	const now = options.now ?? Date.now;

	return function rbfCodex(pi: ExtensionAPI): void {
		// `pi --sandbox` (#pi-23) and this provider stay mutually exclusive.
		if (isSandboxLaunch(options.argv ?? process.argv.slice(2))) return;

		// Everything below lives in this closure; Pi rebinds a new instance on switch, fork, and reload.
		const state = { ctx: null as ExtensionContext | null, client: null as AppServerClient | null, shuttingDown: false, noticedPolicy: false };

		const notify = (text: string, type: "info" | "warning" | "error" = "info") => {
			if (state.ctx?.mode === "tui") state.ctx.ui.notify(text, type);
		};

		function newestOwnEntry(ctx: ExtensionContext): ThreadEntry | null {
			const sessionId = ctx.sessionManager.getSessionId();
			const branch = ctx.sessionManager.getBranch();
			for (let i = branch.length - 1; i >= 0; i--) {
				const e = branch[i] as { type: string; customType?: string; data?: ThreadEntry };
				if (e.type === "custom" && e.customType === ENTRY_TYPE) return e.data && e.data.sessionId === sessionId ? e.data : null;
			}
			return null;
		}

		function isBoundBranch(ctx: ExtensionContext): boolean {
			return ctx.sessionManager.getBranch().some((e) => e.type === "custom" && (e as { customType?: string }).customType === ENTRY_TYPE);
		}

		/** Every user-role message after the last assistant message, joined by blank lines. */
		function userTextSinceLastAnswer(context: Context): string {
			const parts: string[] = [];
			for (let i = context.messages.length - 1; i >= 0; i--) {
				const m = context.messages[i];
				if (m.role === "assistant") break;
				if (m.role !== "user") continue;
				if (typeof m.content === "string") parts.unshift(m.content);
				else {
					const texts: string[] = [];
					for (const block of m.content) {
						if (block.type === "image") throw new CodexError("unsupported-input");
						if (block.type === "text") texts.push(block.text);
					}
					parts.unshift(texts.join("\n"));
				}
			}
			return parts.join("\n\n");
		}

		async function ensureClient(cwd: string, signal?: AbortSignal): Promise<AppServerClient> {
			if (state.client && !state.client.exited) return state.client;
			const client = await AppServerClient.start(cwd, command);
			state.client = client;
			try {
				await client.request("initialize", { clientInfo: { name: "pi-rbf-codex", version: "0.21.0" }, capabilities: { experimentalApi: true } }, SETUP_TIMEOUT_MS, signal);
			} catch (e) {
				// Never keep an uninitialized child around; the next prompt must spawn afresh.
				state.client = null;
				void client.close();
				const msg = e instanceof CodexError ? (e.detail ?? "") : String(e);
				if (/auth|login|logged/i.test(msg)) throw new CodexError("codex-logged-out");
				throw e;
			}
			client.notify("initialized", {});
			return client;
		}

		async function ensureThread(client: AppServerClient, ctx: ExtensionContext, cwd: string, signal?: AbortSignal): Promise<{ threadId: string; policy: string; sandbox: string }> {
			const bound = newestOwnEntry(ctx);
			let res: Rec;
			if (bound) {
				if (bound.cwd !== cwd) throw new CodexError("workspace-mismatch", `Codex thread directory: ${bound.cwd}`);
				res = rec(await client.request("thread/resume", { threadId: bound.threadId, excludeTurns: true }, SETUP_TIMEOUT_MS, signal));
			} else {
				res = rec(await client.request("thread/start", { cwd, ephemeral: false }, SETUP_TIMEOUT_MS, signal));
				const threadId = rec(res.thread).id;
				if (typeof threadId !== "string") throw new CodexError("generic", "thread/start returned no thread id");
				pi.appendEntry<ThreadEntry>(ENTRY_TYPE, { threadId, cwd, sessionId: ctx.sessionManager.getSessionId() });
			}
			const threadId = String(rec(res.thread).id);
			const policy = typeof res.approvalPolicy === "string" ? res.approvalPolicy : JSON.stringify(res.approvalPolicy);
			const sandbox = res.sandbox && typeof res.sandbox === "object" ? String((res.sandbox as Rec).type ?? "unknown") : String(res.sandbox ?? "unknown");
			return { threadId, policy, sandbox };
		}

		function streamSimple(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
			const out = new AssistantMessageWriter(model);
			const finish = (kind: "done" | "aborted" | "error", errorKey?: CopyKey) => {
				state.ctx?.ui.setWorkingMessage();
				out.finish(kind, errorKey);
			};
			const fail = (e: unknown) => {
				if (e instanceof AbortedError) return finish("aborted");
				const err = e instanceof CodexError ? e : new CodexError("generic", String(e));
				if (err.detail) notify(`Codex: ${err.detail}`, "warning");
				finish("error", err.key);
			};

			void (async () => {
				const ctx = state.ctx;
				if (!ctx) return fail(new CodexError("generic", "session_start has not run"));
				let text: string;
				try {
					text = userTextSinceLastAnswer(context);
				} catch (e) {
					return fail(e);
				}
				let cwd: string;
				let client: AppServerClient;
				let threadId: string;
				try {
					if (options?.signal?.aborted) return finish("aborted");
					cwd = realpathSync.native(ctx.sessionManager.getCwd());
					client = await ensureClient(cwd, options?.signal);
					const t = await ensureThread(client, ctx, cwd, options?.signal);
					threadId = t.threadId;
					if (!state.noticedPolicy) {
						state.noticedPolicy = true;
						notify(NOTICE.policy(t.policy, t.sandbox));
					}
					if (options?.signal?.aborted) return finish("aborted");
				} catch (e) {
					return fail(e);
				}
				out.start();

				let turnId = "";
				let finalFallback = "";
				let streamedText = false;
				const phases = new Map<string, string | null>();
				let settled = false;
				let interruptTimer: NodeJS.Timeout | undefined;
				const settle = (fn: () => void) => {
					if (settled) return;
					settled = true;
					if (interruptTimer) clearTimeout(interruptTimer);
					unsubscribe();
					client.onExit.delete(onExit);
					options?.signal?.removeEventListener("abort", onAbort);
					fn();
				};
				const onExit = () =>
					settle(() => {
						state.client = null;
						if (state.shuttingDown) finish("aborted");
						else {
							const last = client.lastStderr();
							if (last) notify(`Codex: ${last}`, "warning");
							finish("error", "codex-stopped");
						}
					});
				const onAbort = () => {
					if (turnId) client.notify("turn/interrupt", { threadId, turnId });
					interruptTimer = setTimeout(
						() =>
							settle(() => {
								// The next prompt must respawn, not reuse a child whose stdin is closing.
								if (state.client === client) state.client = null;
								void client.close();
								finish("aborted");
							}),
						INTERRUPT_WAIT_MS,
					);
				};
				const unsubscribe = client.subscribe((m) => {
					try {
						handle(m);
					} catch (e) {
						// One malformed notification must never escape readline's event and take Pi down.
						settle(() => fail(e));
					}
				});
				const handle = (m: JsonRpc) => {
					if (m.id !== undefined && m.method) {
						const asked = humanRequestKind(m.method);
						if (asked) notify(NOTICE.declined(asked), "warning");
						return;
					}
					const p = (m.params ?? {}) as Rec;
					const forThisTurn = p.turnId === turnId || (m.method === "turn/completed" && !!p.turn && typeof p.turn === "object" && (p.turn as Rec).id === turnId);
					if (!forThisTurn) return;
					switch (m.method) {
						case "item/started": {
							const item = rec(p.item);
							if (item.type === "commandExecution") {
								const cmd = displayCommand(String(item.command));
								ctx.ui.setWorkingMessage(`$ ${cmd}`);
								out.thinking(`$ ${cmd}\n`);
							} else if (item.type === "agentMessage") phases.set(String(item.id), (item.phase as string | null) ?? null);
							break;
						}
						case "item/completed": {
							const item = rec(p.item);
							if (item.type === "commandExecution" && typeof item.exitCode === "number" && item.exitCode !== 0) {
								ctx.ui.setWorkingMessage(`$ ${displayCommand(String(item.command))} → exit ${item.exitCode}`);
								out.thinking(`→ exit ${item.exitCode}\n`);
							} else if (item.type === "agentMessage" && phases.get(String(item.id)) !== "commentary") finalFallback = String(item.text ?? "");
							break;
						}
						case "item/reasoning/summaryTextDelta":
							out.thinking(String(p.delta ?? ""));
							break;
						case "item/agentMessage/delta": {
							const d = String(p.delta ?? "");
							if (phases.get(String(p.itemId)) === "commentary") {
								out.thinking(d);
								ctx.ui.setWorkingMessage(out.lastThinkingLine().slice(0, workingLineMax()));
							} else {
								streamedText = true;
								out.text(d);
							}
							break;
						}
						case "turn/completed": {
							const turn = rec(p.turn);
							settle(() => {
								if (turn.status === "completed") {
									if (!streamedText && finalFallback) out.text(finalFallback);
									if (!streamedText && !finalFallback) return finish("error", "no-answer");
									finish("done");
								} else if (turn.status === "interrupted") finish("aborted");
								else {
									const err = turn.error ? String(rec(turn.error).message) : String(turn.status);
									notify(`Codex: ${err}`, "warning");
									finish("error", "turn-failed");
								}
							});
							break;
						}
					}
				};
				client.onExit.add(onExit);
				options?.signal?.addEventListener("abort", onAbort, { once: true });

				const input = [{ type: "text", text, text_elements: [] }];
				const effort = mapEffort(model, options?.reasoning);
				const turnParams: Rec = { threadId, input };
				if (effort) turnParams.effort = effort;
				const codexId = codexModelId(model.id);
				if (codexId) turnParams.model = codexId;
				try {
					let started: Rec;
					try {
						started = rec(await client.request("turn/start", turnParams));
					} catch (e) {
						const detail = e instanceof CodexError ? (e.detail ?? "") : String(e);
						if (!(turnParams.model && detail.includes(String(turnParams.model)))) throw e;
						// Codex retired the persisted model id: one retry on Codex's default, then the user picks another.
						notify(NOTICE.retiredModel(String(turnParams.model)), "warning");
						started = rec(await client.request("turn/start", { threadId, input }));
					}
					turnId = String(rec(started.turn).id);
					if (options?.signal?.aborted) onAbort();
				} catch (e) {
					settle(() => fail(e instanceof CodexError && e.key === "generic" ? new CodexError("turn-failed", e.detail) : e));
				}
			})();
			return out.stream;
		}

		/** Pi calls this without network at startup and with network when the picker opens. */
		async function refreshModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
			const storedConfigs = storedToConfigs(context.stored);
			const fresh = typeof context.stored?.checkedAt === "number" && now() - context.stored.checkedAt < CATALOG_MAX_AGE_MS;
			if (!context.allowNetwork || (!context.force && fresh)) return [BOOTSTRAP_MODEL, ...storedConfigs];
			try {
				const fetched = await fetchCatalog(context.signal);
				await context.publish({ persist: { models: fetched.map(toStoredModel), checkedAt: now() } });
				return [BOOTSTRAP_MODEL, ...fetched];
			} catch {
				return [BOOTSTRAP_MODEL, ...storedConfigs];
			}
		}

		async function fetchCatalog(signal: AbortSignal): Promise<ProviderModelConfig[]> {
			const client = await AppServerClient.start(process.cwd(), command);
			const onAbort = () => void client.close();
			signal.addEventListener("abort", onAbort, { once: true });
			try {
				await client.request("initialize", { clientInfo: { name: "pi-rbf-codex", version: "0.21.0" }, capabilities: { experimentalApi: true } });
				client.notify("initialized", {});
				const res = rec(await client.request("model/list", { includeHidden: false }));
				const data = Array.isArray(res.data) ? (res.data as CodexModel[]) : [];
				return data.filter((m) => !m.hidden).map(toProviderModel);
			} finally {
				signal.removeEventListener("abort", onAbort);
				await client.close();
			}
		}

		pi.on("session_start", async (_event, ctx) => {
			state.ctx = ctx;
			state.client = null;
			state.shuttingDown = false;
			state.noticedPolicy = false;
			if (!newestOwnEntry(ctx)) return; // a forked copy starts cold, so its last prompt was not ours to interrupt
			const last = [...ctx.sessionManager.getBranch()].reverse().find((e) => e.type === "message") as { message?: { role: string } } | undefined;
			if (last?.message?.role === "user") notify(NOTICE.interrupted, "warning");
		});
		const closeChild = async () => {
			state.shuttingDown = true;
			const c = state.client;
			state.client = null;
			if (c) await c.close();
		};
		pi.on("session_shutdown", closeChild);
		pi.on("session_before_switch", async () => {
			await closeChild();
			return {};
		});
		pi.on("session_before_compact", async (event, ctx) => {
			if (!isBoundBranch(ctx)) return {};
			if (event.reason === "manual") notify(NOTICE.compact);
			return { cancel: true };
		});
		pi.on("session_before_tree", async (event, ctx) => {
			if (isBoundBranch(ctx) && event.preparation.userWantsSummary) return { summary: { summary: NOTICE.treeSummary } };
			return {};
		});
		pi.on("model_select", async (event, ctx) => {
			if (event.model.provider !== PROVIDER_ID || event.previousModel?.provider === PROVIDER_ID) return;
			const hasAnswer = ctx.sessionManager.getBranch().some((e) => e.type === "message" && (e as { message?: { role: string } }).message?.role === "assistant");
			if (hasAnswer) notify(NOTICE.coldStart);
		});

		pi.registerProvider(PROVIDER_ID, {
			api: API_ID,
			baseUrl: "stdio://codex",
			apiKey: "codex-cli", // non-secret sentinel; Pi needs one to mark the provider configured
			streamSimple,
			refreshModels,
			models: [BOOTSTRAP_MODEL],
		});
	};
}

export default createRbfCodex();
