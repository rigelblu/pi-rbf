import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, RefreshModelsContext, ThinkingLevel, ToolCall } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Box } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { API_ID, APPROVAL_CHOICES, BOOTSTRAP_MODEL, BOOTSTRAP_MODEL_ID, COPY, CATALOG_MAX_AGE_MS, ENTRY_TYPE, NOTICE, OTHER_CHOICE, PROVIDER_ID, ROW_STATUS, TOOL_COMMAND, TOOL_PATCH, TOOL_QUESTION, TOOL_TOOL, TURN_ENTRY_TYPE, codexModelId, createRbfCodex, diffCounts, displayCommand, displayPath, flattenChanges, humanRequestKind, isAppApproval, loneString, mapEffort, patchRowLine, RowError, splitTitle, toPreviewDiff, toProviderModel, truncateTitle } from "./rbf-codex.ts";
import type { FakeScenario } from "./test-support/rbf-codex-fake-app-server.ts";

const FAKE = resolve(import.meta.dirname, "test-support/rbf-codex-fake-app-server.ts");
// Vitest runs on Node, which strips types from .ts on its own (Node 22.6+).
const fakeCommand = { bin: process.execPath, args: [FAKE] };
const MISSING_COMMAND = { bin: "/nonexistent/codex-not-here", args: ["app-server"] };

type Handler = (event: any, ctx: ExtensionContext) => Promise<any>;
type Entry = { type: string; customType?: string; data?: unknown; message?: { role: string; content: unknown } };

type Tool = { name: string; execute: (id: string, params: any, signal: AbortSignal | undefined, onUpdate: ((p: any) => void) | undefined, ctx: ExtensionContext) => Promise<any>; renderCall: (args: any, theme: any, context: any) => any; renderResult: (result: any, opts: any, theme: any, context: any) => any };
const fakeTheme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };

function makePi() {
	const handlers = new Map<string, Handler>();
	const entries: { customType: string; data: unknown }[] = [];
	const tools = new Map<string, Tool>();
	let provider: { name: string; config: ProviderConfig } | undefined;
	const pi = {
		on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
		appendEntry: vi.fn((customType: string, data: unknown) => entries.push({ customType, data })),
		registerTool: vi.fn((tool: Tool) => tools.set(tool.name, tool)),
		registerProvider: vi.fn((name: string, config: ProviderConfig) => {
			provider = { name, config };
		}),
	} as unknown as ExtensionAPI;
	return {
		pi,
		handlers,
		entries,
		tools,
		get provider() {
			if (!provider) throw new Error("no provider registered");
			return provider;
		},
		get registered() {
			return provider !== undefined;
		},
	};
}

function makeCtx(opts: { branch?: Entry[]; sessionId?: string; cwd?: string; mode?: "tui" | "print" } = {}) {
	const branch = opts.branch ?? [];
	const notify = vi.fn();
	const setWorkingMessage = vi.fn();
	/** Scripted dialog answers, in order; `undefined` is Escape. */
	const answers: (string | undefined)[] = [];
	const dialogs: { kind: "select" | "input"; title: string; options?: string[]; signal?: AbortSignal }[] = [];
	const select = vi.fn(async (title: string, options: string[], o?: { signal?: AbortSignal }) => {
		dialogs.push({ kind: "select", title, options, signal: o?.signal });
		if (!answers.length) await new Promise<void>((resolve) => o?.signal?.addEventListener("abort", () => resolve(), { once: true }));
		return answers.shift();
	});
	const input = vi.fn(async (title: string, _placeholder?: string, o?: { signal?: AbortSignal }) => {
		dialogs.push({ kind: "input", title, signal: o?.signal });
		return answers.shift();
	});
	const mode = opts.mode ?? "tui";
	const ctx = {
		mode,
		hasUI: mode === "tui",
		ui: { notify, setWorkingMessage, select, input },
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => opts.sessionId ?? "session-A",
			getCwd: () => opts.cwd ?? process.cwd(),
		},
	} as unknown as ExtensionContext;
	return { ctx, branch, notify, setWorkingMessage, answers, dialogs, select, input };
}

function model(id = BOOTSTRAP_MODEL_ID, thinkingLevelMap: Model<any>["thinkingLevelMap"] = BOOTSTRAP_MODEL.thinkingLevelMap): Model<any> {
	return { id, name: id, api: API_ID, provider: PROVIDER_ID, baseUrl: "stdio://codex", reasoning: true, thinkingLevelMap, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1e9, maxTokens: 1e9 };
}

function userMessage(text: string) {
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
}
function assistantMessage(text: string): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], api: API_ID, provider: PROVIDER_ID, model: BOOTSTRAP_MODEL_ID, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>) {
	const events: AssistantMessageEvent[] = [];
	for await (const e of stream) events.push(e);
	const last = events[events.length - 1];
	const final = last?.type === "done" ? last.message : last?.type === "error" ? last.error : undefined;
	const text = final?.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("") ?? "";
	const thinking = final?.content.filter((b) => b.type === "thinking").map((b) => (b as { thinking: string }).thinking).join("") ?? "";
	const toolCall = final?.content.find((b) => b.type === "toolCall") as ToolCall | undefined;
	return { events, final, text, thinking, toolCall };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function toolResultMessage(call: ToolCall, result: { content: { type: "text"; text: string }[]; details: unknown; isError?: boolean }) {
	return { role: "toolResult" as const, toolCallId: call.id, toolName: call.name, content: result.content, details: result.details, isError: !!result.isError, timestamp: Date.now() };
}

describe("rbf-codex", () => {
	let dir: string;
	let logPath: string;
	const savedEnv = { ...process.env };
	const booted: { shutdown: () => Promise<unknown> | undefined }[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "rbf-codex-test-"));
		logPath = join(dir, "fake.log");
		process.env.RBF_FAKE_LOG = logPath;
		delete process.env.RBF_FAKE_SCENARIO;
	});
	afterEach(async () => {
		// Close every fake child this test spawned; leaked children made the full suite flaky under load.
		await Promise.all(booted.splice(0).map((b) => b.shutdown()));
		process.env = { ...savedEnv };
		rmSync(dir, { recursive: true, force: true });
	});

	function scenario(s: FakeScenario) {
		process.env.RBF_FAKE_SCENARIO = JSON.stringify(s);
	}
	function sent(): { method?: string; id?: number; params?: Record<string, unknown>; error?: unknown }[] {
		try {
			return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
		} catch {
			return [];
		}
	}
	function methods() {
		return sent().filter((m) => m.method).map((m) => m.method);
	}

	/** Boot an extension instance with `session_start` already fired, ready to stream. */
	async function boot(opts: Parameters<typeof makeCtx>[0] & { command?: typeof fakeCommand; argv?: string[] } = {}) {
		const fx = makePi();
		createRbfCodex({ command: opts.command ?? fakeCommand, argv: opts.argv ?? [] })(fx.pi);
		const c = makeCtx(opts);
		await fx.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, c.ctx);
		const turn = (text: string | Context["messages"], m: Model<any> = model(), options: { reasoning?: ThinkingLevel; signal?: AbortSignal } = {}) => {
			const messages = typeof text === "string" ? [userMessage(text)] : text;
			return collect(fx.provider.config.streamSimple!(m, { messages } as Context, options));
		};
		const shutdown = () => fx.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, c.ctx);
		booted.push({ shutdown });
		// Mirror Pi's agent loop: an execute that throws becomes an error tool result (`createErrorToolResult` + isError), which is how Pi tints the row. A returned isError is ignored by Pi, so error rows must throw.
		const exec = async (call: ToolCall, opts: { signal?: AbortSignal; onUpdate?: (p: any) => void; ctx?: ExtensionContext } = {}) => {
			try { return await fx.tools.get(call.name)!.execute(call.id, call.arguments, opts.signal, opts.onUpdate, opts.ctx ?? c.ctx); }
			catch (e) { if (e instanceof RowError) return { content: [{ type: "text" as const, text: e.message }], details: {}, isError: true }; throw e; } // an abort still rejects, as Pi's tool contract requires; only a settled error row becomes a result
		};
		/** One Pi round: the call that ends with a row, the tool's execution, and the call that attaches after it. */
		const round = async (messages: Context["messages"], m: Model<any> = model(), opts: { signal?: AbortSignal; onUpdate?: (p: any) => void; gapMs?: number } = {}) => {
			const first = await collect(fx.provider.config.streamSimple!(m, { messages } as Context, { signal: opts.signal }));
			if (!first.toolCall) return { first, result: undefined, next: undefined, messages };
			// Pi validates every emitted tool call against the tool's TypeBox schema before execute; a shape drift would fail here.
			expect(validateToolArguments(fx.tools.get(first.toolCall.name) as any, first.toolCall)).toEqual(first.toolCall.arguments);
			const result = await exec(first.toolCall, opts);
			if (opts.gapMs) await sleep(opts.gapMs);
			const after = [...messages, first.final!, toolResultMessage(first.toolCall, result)];
			const next = await collect(fx.provider.config.streamSimple!(m, { messages: after } as Context, { signal: opts.signal }));
			return { first, result, next, messages: after };
		};
		return { ...fx, ...c, turn, shutdown, exec, round };
	}

	describe("registration", () => {
		it("registers with api, baseUrl, apiKey, streamSimple, refreshModels, and the bootstrap model", async () => {
			const b = await boot();
			expect(b.provider.name).toBe(PROVIDER_ID);
			expect(b.provider.config).toMatchObject({ api: API_ID, baseUrl: "stdio://codex", apiKey: "codex-cli" });
			expect(typeof b.provider.config.streamSimple).toBe("function");
			expect(typeof b.provider.config.refreshModels).toBe("function");
			expect(b.provider.config.models).toEqual([BOOTSTRAP_MODEL]);
			expect(BOOTSTRAP_MODEL.reasoning).toBe(true);
			expect(BOOTSTRAP_MODEL.thinkingLevelMap).toEqual({ minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
		});

		it("registers nothing when --sandbox is in argv", () => {
			const fx = makePi();
			createRbfCodex({ command: fakeCommand, argv: ["--sandbox", "--model", "x"] })(fx.pi);
			expect(fx.registered).toBe(false);
			expect(fx.pi.on).not.toHaveBeenCalled();
		});
	});

	describe("catalog", () => {
		const codexModel = (id: string, efforts: string[], extra: Record<string, unknown> = {}) => ({ id, model: id, displayName: id.toUpperCase(), hidden: false, supportedReasoningEfforts: efforts.map((e) => ({ reasoningEffort: e })), ...extra });

		it("maps a Codex model to a Pi model with only listed efforts, minimal null, and xhigh and max named", () => {
			const m = toProviderModel(codexModel("gpt-x", ["medium", "high", "ultra"], { inputModalities: ["text", "image"] }));
			expect(m).toMatchObject({ id: "gpt-x", name: "GPT-X (Codex agent)", reasoning: true, input: ["text", "image"] }); // the provider tag keeps the row apart from openai-codex
			expect(toProviderModel(codexModel("gpt-t", ["low"], { inputModalities: ["text"] })).input).toEqual(["text"]);
			expect(codexModelId("gpt-x")).toBe("gpt-x");
			expect(codexModelId("codex-gpt-x")).toBe("gpt-x"); // a store from the brief prefix era
			expect(codexModelId(BOOTSTRAP_MODEL_ID)).toBeUndefined();
			expect(m.thinkingLevelMap).toEqual({ minimal: null, low: null, medium: "medium", high: "high", xhigh: null, max: null });
			expect(toProviderModel(codexModel("gpt-y", ["low", "xhigh", "max"])).thinkingLevelMap).toEqual({ minimal: null, low: "low", medium: null, high: null, xhigh: "xhigh", max: "max" });
		});

		function refreshCtx(opts: { allowNetwork: boolean; force?: boolean; stored?: RefreshModelsContext["stored"] }) {
			const publish = vi.fn(async () => true);
			const ctx = { allowNetwork: opts.allowNetwork, force: opts.force, stored: opts.stored, publish, signal: new AbortController().signal } as unknown as RefreshModelsContext;
			return { ctx, publish };
		}
		const storedEntry = (checkedAt: number) => ({ models: [{ ...model("codex-gpt-stored", { minimal: null, low: "low", medium: null, high: null, xhigh: null, max: null }), name: "GPT-STORED (Codex agent)" }], checkedAt }); // prefixed id, as a store from the prefix era would hold

		it("returns the stored list without network and never spawns", async () => {
			const b = await boot();
			const r = refreshCtx({ allowNetwork: false, stored: storedEntry(0) });
			const list = await b.provider.config.refreshModels!(r.ctx);
			expect(list.map((m) => m.id)).toEqual([BOOTSTRAP_MODEL_ID, "gpt-stored"]); // legacy prefix stripped on read
			expect(r.publish).not.toHaveBeenCalled();
			expect(sent()).toEqual([]);
		});

		it("skips the fetch when the store is fresh, fetches and publishes when forced or stale, and skips hidden models", async () => {
			const now = 1_000_000_000_000;
			const fx = makePi();
			createRbfCodex({ command: fakeCommand, argv: [], now: () => now })(fx.pi);
			const fresh = refreshCtx({ allowNetwork: true, stored: storedEntry(now - CATALOG_MAX_AGE_MS + 1000) });
			expect((await fx.provider.config.refreshModels!(fresh.ctx)).map((m) => m.id)).toEqual([BOOTSTRAP_MODEL_ID, "gpt-stored"]);
			expect(fresh.publish).not.toHaveBeenCalled();
			expect(sent()).toEqual([]);

			const forced = refreshCtx({ allowNetwork: true, force: true, stored: storedEntry(now) });
			const list = await fx.provider.config.refreshModels!(forced.ctx);
			expect(list.map((m) => m.id)).toEqual([BOOTSTRAP_MODEL_ID, "gpt-fake-1", "gpt-fake-2"]);
			expect(list[2]).toMatchObject({ name: "GPT Fake 2 (Codex agent)", input: ["text", "image"], reasoning: true });
			expect(list[1]).toMatchObject({ input: ["text"] });
			expect(list[2].thinkingLevelMap).toEqual({ minimal: null, low: null, medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
			expect(forced.publish).toHaveBeenCalledTimes(1);
			const persisted = (forced.publish.mock.calls[0] as unknown as [{ persist: { models: Model<any>[]; checkedAt: number } }])[0].persist;
			expect(persisted.checkedAt).toBe(now);
			expect(persisted.models.map((m) => m.id)).toEqual(["gpt-fake-1", "gpt-fake-2"]);
			expect(persisted.models[0]).toMatchObject({ api: API_ID, provider: PROVIDER_ID });
			expect(methods()).toEqual(["initialize", "initialized", "model/list"]);

			const stale = refreshCtx({ allowNetwork: true, stored: storedEntry(now - CATALOG_MAX_AGE_MS - 1) });
			await fx.provider.config.refreshModels!(stale.ctx);
			expect(stale.publish).toHaveBeenCalledTimes(1);
		});

		it("returns the stored or bootstrap list without throwing when the spawn fails", async () => {
			const b = await boot({ command: MISSING_COMMAND });
			const r1 = refreshCtx({ allowNetwork: true, force: true, stored: storedEntry(0) });
			expect((await b.provider.config.refreshModels!(r1.ctx)).map((m) => m.id)).toEqual([BOOTSTRAP_MODEL_ID, "gpt-stored"]);
			const r2 = refreshCtx({ allowNetwork: true, force: true });
			expect(await b.provider.config.refreshModels!(r2.ctx)).toEqual([BOOTSTRAP_MODEL]);
			expect(r1.publish).not.toHaveBeenCalled();
		});
	});

	describe("model and effort on turn/start", () => {
		it("sends the catalog model id and the mapped effort", async () => {
			const b = await boot();
			await b.turn("hi", model("gpt-fake-2", { minimal: null, low: null, medium: "medium", high: "high", xhigh: "xhigh", max: "max" }), { reasoning: "high" });
			const start = sent().find((m) => m.method === "turn/start")!;
			expect(start.params).toMatchObject({ model: "gpt-fake-2", effort: "high" });
		});

		it("sends effort but no model for the bootstrap id, and neither effort when the level is unsupported or off", async () => {
			const b = await boot();
			await b.turn("one", model(), { reasoning: "medium" });
			await b.turn("two", model(), {});
			await b.turn("three", model("gpt-fake-1", { minimal: null, low: "low", medium: null, high: null, xhigh: null, max: null }), { reasoning: "high" });
			const starts = sent().filter((m) => m.method === "turn/start").map((m) => m.params!);
			expect(starts[0]).toMatchObject({ effort: "medium" });
			expect(starts[0]).not.toHaveProperty("model");
			expect(starts[1]).not.toHaveProperty("effort");
			expect(starts[1]).not.toHaveProperty("model");
			expect(starts[2]).toMatchObject({ model: "gpt-fake-1" });
			expect(starts[2]).not.toHaveProperty("effort");
			expect(mapEffort(model(), "max")).toBe("max");
			expect(mapEffort(model(), "minimal")).toBeUndefined();
		});

		it("retries once without model and effort when Codex rejects the persisted model id, with the retired-model notice", async () => {
			scenario({ retiredModel: "gpt-gone" });
			const b = await boot();
			const r = await b.turn("hi", model("gpt-gone"), { reasoning: "high" });
			expect(r.text).toBe("FAKE_OK");
			const starts = sent().filter((m) => m.method === "turn/start").map((m) => m.params!);
			expect(starts).toHaveLength(2);
			expect(starts[0]).toMatchObject({ model: "gpt-gone", effort: "high" });
			expect(starts[1]).not.toHaveProperty("model");
			expect(starts[1]).not.toHaveProperty("effort");
			expect(b.notify).toHaveBeenCalledWith(NOTICE.retiredModel("gpt-gone"), "warning");
		});
	});

	describe("thread binding", () => {
		it("first prompt: thread/start, then the entry with the session id, then turn/start; second prompt resumes", async () => {
			const b = await boot({ sessionId: "session-A" });
			const r1 = await b.turn("first");
			expect(r1.text).toBe("FAKE_OK");
			expect(methods()).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
			const threadEntries = () => b.entries.filter((e) => e.customType === ENTRY_TYPE);
			expect(threadEntries()).toEqual([{ customType: ENTRY_TYPE, data: { threadId: "thread-fake-1", cwd: process.cwd(), sessionId: "session-A" } }]);
			b.branch.push({ type: "custom", customType: ENTRY_TYPE, data: b.entries[0].data });
			await b.turn("second");
			expect(methods().filter((m) => m === "thread/start")).toHaveLength(1);
			expect(methods().filter((m) => m === "thread/resume")).toHaveLength(1);
			expect(sent().find((m) => m.method === "thread/resume")!.params).toMatchObject({ threadId: "thread-fake-1", excludeTurns: true });
			expect(threadEntries()).toHaveLength(1);
		});

		it("ignores an entry copied from another session and starts a new thread", async () => {
			const b = await boot({ sessionId: "session-B", branch: [{ type: "custom", customType: ENTRY_TYPE, data: { threadId: "thread-old", cwd: process.cwd(), sessionId: "session-A" } }] });
			await b.turn("hi");
			expect(methods()).toContain("thread/start");
			expect(methods()).not.toContain("thread/resume");
			expect(b.entries[0].data).toMatchObject({ sessionId: "session-B" });
		});

		it("refuses a recorded cwd mismatch with zero turn requests", async () => {
			const b = await boot({ branch: [{ type: "custom", customType: ENTRY_TYPE, data: { threadId: "thread-old", cwd: "/somewhere/else", sessionId: "session-A" } }] });
			const r = await b.turn("hi");
			expect(r.final?.stopReason).toBe("error");
			expect(r.final?.errorMessage).toBe(COPY["workspace-mismatch"]);
			expect(methods()).not.toContain("turn/start");
			expect(b.notify).toHaveBeenCalledWith("Codex: Codex thread directory: /somewhere/else", "warning");
		});

		it("shows the policy notice once per session from the thread response", async () => {
			scenario({ approvalPolicy: "never", sandboxType: "readOnly" });
			const b = await boot();
			await b.turn("one");
			await b.turn("two");
			expect(b.notify.mock.calls.filter((c) => c[0] === NOTICE.policy("never", "readOnly"))).toHaveLength(1);
		});
	});

	describe("streaming and activity", () => {
		it("reasoning becomes thinking; commentary and final_answer stream as text; the working line is never touched (v0.21.1)", async () => {
			scenario({
				turn: [
					{ kind: "reasoning", delta: "thinking about it " },
					{ kind: "commentary", id: "m1", text: "Looking at the repo now" },
					{ kind: "answer", id: "m2", text: "PWD=/tmp", phase: "final_answer" },
					{ kind: "complete" },
				],
			});
			const b = await boot();
			const r = await b.turn("Run pwd");
			expect(r.final?.stopReason).toBe("stop");
			expect(r.text).toBe("Looking at the repo now PWD=/tmp");
			expect(r.thinking).toBe("thinking about it ");
			expect(b.setWorkingMessage).not.toHaveBeenCalled();
			const kinds = r.events.map((e) => e.type);
			expect(kinds[0]).toBe("start");
			expect(kinds).toContain("thinking_start");
			expect(kinds).toContain("text_delta");
			expect(kinds[kinds.length - 1]).toBe("done");
			expect(b.entries).toContainEqual({ customType: TURN_ENTRY_TYPE, data: { threadId: "thread-fake-1", turnId: "turn-fake-1", status: "completed" } });
		});

		it("a turn that ends with commentary and no final answer shows the commentary as the answer", async () => {
			scenario({ turn: [{ kind: "commentary", id: "m1", text: "Nothing else to do" }, { kind: "complete" }] });
			const b = await boot();
			const r = await b.turn("hi");
			expect(r.final?.stopReason).toBe("stop");
			expect(r.text).toBe("Nothing else to do ");
		});

		it("strips Codex's login-shell wrapper for display", () => {
			expect(displayCommand("/bin/zsh -lc pwd")).toBe("pwd");
			expect(displayCommand("/bin/zsh -lc '/bin/sleep 20'")).toBe("/bin/sleep 20");
			expect(displayCommand("ls -la")).toBe("ls -la");
		});

		it("an agent message with null phase streams as the answer and is not repeated at turn end", async () => {
			scenario({ turn: [{ kind: "answer", id: "m1", text: "HELLO", phase: null }, { kind: "complete" }] });
			const b = await boot();
			const r = await b.turn("hi");
			expect(r.text).toBe("HELLO");
			expect(r.final?.content.filter((c) => c.type === "text")).toHaveLength(1);
		});

		it("uses the last agent message when nothing streamed, and no-answer when there is none", async () => {
			scenario({ turn: [{ kind: "answer", id: "m1", text: "ONLY_AT_END", streamed: false }, { kind: "complete" }] });
			const b = await boot();
			expect((await b.turn("hi")).text).toBe("ONLY_AT_END");
			scenario({ turn: [{ kind: "complete" }] });
			const b2 = await boot(); // a fresh child; the fake reads its scenario at spawn
			const r = await b2.turn("again");
			expect(r.final?.stopReason).toBe("error");
			expect(r.final?.errorMessage).toBe(COPY["no-answer"]);
		});

		it("a permissions request is a JSON-RPC error with the declined notice and the turn continues", async () => {
			scenario({ turn: [{ kind: "serverRequest", method: "item/permissions/requestApproval" }, { kind: "answer", id: "m1", text: "DONE" }, { kind: "complete" }] });
			const b = await boot();
			const r = await b.turn("hi");
			expect(r.text).toBe("DONE");
			const reply = sent().find((m) => m.id !== undefined && !m.method);
			expect(reply).toMatchObject({ error: { code: -32601 } });
			expect(b.notify).toHaveBeenCalledWith(NOTICE.declined("approval"), "warning");
		});

		it("a legacy approval, a human request for another turn, and other server requests are errors at arrival; only human kinds get a notice", async () => {
			scenario({ turn: [{ kind: "serverRequest", method: "execCommandApproval" }, { kind: "serverRequest", method: "item/tool/requestUserInput", params: { turnId: "turn-elsewhere" } }, { kind: "serverRequest", method: "attestation/generate" }, { kind: "answer", id: "m1", text: "DONE" }, { kind: "complete" }] });
			const b = await boot();
			expect((await b.turn("hi")).text).toBe("DONE");
			expect(sent().filter((m) => m.id !== undefined && !m.method && (m as { error?: unknown }).error)).toHaveLength(3);
			expect(b.notify).toHaveBeenCalledWith(NOTICE.declined("approval"), "warning");
			expect(b.notify).toHaveBeenCalledWith(NOTICE.declined("input"), "warning");
			expect(b.notify).toHaveBeenCalledTimes(3); // policy notice + two declines
			expect(humanRequestKind("mcpServer/elicitation/request")).toBe("input");
			expect(humanRequestKind("account/chatgptAuthTokens/refresh")).toBeUndefined();
		});

		it("joins steer and custom user messages after the last assistant message into one turn, in order", async () => {
			const b = await boot();
			await b.turn([userMessage("old"), assistantMessage("answered"), userMessage("first"), { role: "user", content: "steer text", timestamp: Date.now() } as any, userMessage("third")]);
			expect(sent().find((m) => m.method === "turn/start")!.params).toMatchObject({ input: [{ type: "text", text: "first\n\nsteer text\n\nthird", text_elements: [] }] });
		});

		it("sends exactly one turn/start per user prompt across success, failure, and interruption", async () => {
			const b = await boot();
			await b.turn("one");
			await b.turn("two");
			const ac = new AbortController();
			const p = b.turn("three", model(), { signal: ac.signal });
			await vi.waitFor(() => expect(methods().filter((m) => m === "turn/start")).toHaveLength(3));
			ac.abort();
			await p;
			await b.turn("four");
			expect(methods().filter((m) => m === "turn/start")).toHaveLength(4);
		});

		it("a failed turn ends with the fixed turn-failed sentence and a notice carrying Codex's message", async () => {
			scenario({ turn: [{ kind: "complete", status: "failed", errorMessage: "quota exhausted" }] });
			const b = await boot();
			const r = await b.turn("hi");
			expect(r.final?.errorMessage).toBe(COPY["turn-failed"]);
			expect(b.notify).toHaveBeenCalledWith("Codex: quota exhausted", "warning");
		});
	});

	describe("tool rows (Scenario 7)", () => {
		const diffA = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,4 @@\n line\n-old\n+new1\n+new2\n+new3\n";

		it("a Codex command becomes one Pi tool call, the tool returns its output, and the next call attaches with one turn/start", async () => {
			scenario({ turn: [{ kind: "reasoning", delta: "look " }, { kind: "command", id: "c1", command: "/bin/zsh -lc 'ls -la'", output: ["a.ts\n", "b.ts\n"] }, { kind: "answer", id: "m1", text: "two files" }, { kind: "complete" }] });
			const b = await boot();
			const updates: string[] = [];
			const r = await b.round([userMessage("list files")], model(), { onUpdate: (p) => updates.push(p.content[0].text) });
			expect(r.first.final?.stopReason).toBe("toolUse");
			expect(r.first.thinking).toBe("look ");
			expect(r.first.events.map((e) => e.type).slice(-3)).toEqual(["toolcall_start", "toolcall_end", "done"]);
			expect(r.first.toolCall).toEqual({ type: "toolCall", id: "codex-c1", name: TOOL_COMMAND, arguments: { itemId: "c1", threadId: "", agentPath: "", command: "/bin/zsh -lc 'ls -la'", cwd: process.cwd() } }); // threadId and agentPath are empty for the root thread (v0.21.4)
			expect(r.result).toMatchObject({ content: [{ type: "text", text: "a.ts\nb.ts" }], details: { itemId: "c1", exitCode: 0, status: "completed" }, isError: false });
			expect(updates).toEqual(["", "a.ts\n", "a.ts\nb.ts\n"]); // the empty first update opens the row with `Elapsed`, as Pi's bash row does
			expect(r.next!.final?.stopReason).toBe("stop");
			expect(r.next!.text).toBe("two files");
			expect(methods().filter((m) => m === "turn/start")).toHaveLength(1);
			expect(b.entries.filter((e) => e.customType === TURN_ENTRY_TYPE)).toEqual([{ customType: TURN_ENTRY_TYPE, data: { threadId: "thread-fake-1", turnId: "turn-fake-1", status: "completed" } }]);
		});

		it("a nonzero exit ends the result with the code and isError", async () => {
			scenario({ turn: [{ kind: "command", id: "c1", command: "false", exitCode: 2, output: ["boom\n"] }, { kind: "answer", id: "m1", text: "failed" }, { kind: "complete" }] });
			const b = await boot();
			const r = await b.round([userMessage("run it")]);
			expect(r.result).toMatchObject({ content: [{ type: "text", text: "boom\n\n\nCommand exited with code 2" }], isError: true }); // a thrown error row carries no structured details and Pi's bash copy after the untrimmed output (its trailing newline kept), exactly as Pi's bash builds it
			expect(r.next!.text).toBe("failed");
		});

		it("a file change becomes a codex_patch call with flattened changes and an applied result", async () => {
			scenario({ turn: [{ kind: "patch", id: "p1", changes: [{ path: "src/a.ts", kind: { type: "update", move_path: null }, diff: diffA }, { path: "src/b.ts", kind: { type: "add" }, diff: "x\ny\n" }] }, { kind: "answer", id: "m1", text: "edited" }, { kind: "complete" }] });
			const b = await boot();
			const r = await b.round([userMessage("edit it")]);
			expect(r.first.toolCall).toEqual({ type: "toolCall", id: "codex-p1", name: TOOL_PATCH, arguments: { itemId: "p1", threadId: "", agentPath: "", changes: [{ path: "src/a.ts", kind: "update", diff: " 1 line\n-2 old\n+2 new1\n+3 new2\n+4 new3" }, { path: "src/b.ts", kind: "add", diff: "+1 x\n+2 y" }] } }); // Codex sends the file content as an add's diff; Pi's rows read numbered +/- lines
			expect(r.result).toMatchObject({ content: [{ type: "text", text: "applied 2 file(s): src/a.ts, src/b.ts" }], details: { itemId: "p1", status: "completed" }, isError: false });
			expect(r.next!.text).toBe("edited");
			expect(flattenChanges([{ path: "x", kind: { type: "update", move_path: "y" }, diff: "" }])).toEqual([{ path: "x", kind: "update", movePath: "y", diff: "" }]);
			// Pi's numbered diff format (`edit-diff.js`): the glance tints and `renderDiff` colors only lines shaped `+N text` / `-N text`.
			expect(toPreviewDiff("delete", "a\nb")).toBe("-1 a\n-2 b");
			expect(toPreviewDiff("add", "")).toBe("");
			expect(toPreviewDiff("add", "ROW\n")).toBe("+1 ROW");
			expect(toPreviewDiff("update", "@@ -1 +1,2 @@\n ONE\n+TINT\n")).toBe(" 1 ONE\n+2 TINT"); // a real Codex update: bare hunk, no file headers
			expect(toPreviewDiff("update", "@@ -8,3 +8,3 @@\n a\n-b\n+B\n c\n@@ -20,2 +20,3 @@\n d\n+e\n f\n\\ No newline at end of file\n")).toBe("  8 a\n- 9 b\n+ 9 B\n 10 c\n    ...\n 20 d\n+21 e\n 21 f"); // two hunks: numbers padded to the widest, ` ...` between, the no-newline marker dropped
		});

		it("shows Codex's absolute paths the way Pi's rows show the model's: relative to the working directory, else under ~ (#pi-10.3 human Scenario 1)", () => {
			expect(displayPath("/w/src/a.ts", "/w")).toBe("src/a.ts");
			expect(displayPath("src/a.ts", "/w")).toBe("src/a.ts");
			expect(displayPath(`${homedir()}/notes.md`, "/w")).toBe("~/notes.md");
			expect(displayPath("/etc/hosts", "/w")).toBe("/etc/hosts");
			expect(patchRowLine({ path: `${process.cwd()}/pi10-row.txt`, kind: "add", diff: "+ROW\n" })).toBe("write pi10-row.txt (+1 −0)");
		});

		it("execute with an itemId no active turn holds returns an error result and sends nothing", async () => {
			const b = await boot();
			const r = await b.exec({ type: "toolCall", id: "codex-nope", name: TOOL_COMMAND, arguments: { itemId: "nope", command: "rm -rf /", cwd: "/" } });
			expect(r.isError).toBe(true);
			expect(sent()).toEqual([]);
		});

		it("the late-completion gap: the turn ends before Pi's next call, which still attaches and drains", async () => {
			scenario({ turn: [{ kind: "command", id: "c1", command: "pwd", output: ["/tmp\n"] }, { kind: "answer", id: "m1", text: "done" }, { kind: "complete" }] });
			const b = await boot();
			const r = await b.round([userMessage("go")], model(), { gapMs: 150 });
			expect(r.next!.final?.stopReason).toBe("stop");
			expect(r.next!.text).toBe("done");
			expect(methods().filter((m) => m === "turn/start")).toHaveLength(1);
			expect(b.entries.filter((e) => e.customType === TURN_ENTRY_TYPE)).toHaveLength(1);
			// The following prompt is a fresh turn.
			await b.turn("again");
			expect(methods().filter((m) => m === "turn/start")).toHaveLength(2);
		});

		it("two commands in one turn are two rows in order", async () => {
			scenario({ turn: [{ kind: "command", id: "c1", command: "one" }, { kind: "command", id: "c2", command: "two" }, { kind: "answer", id: "m1", text: "both" }, { kind: "complete" }] });
			const b = await boot();
			const r1 = await b.round([userMessage("go")]);
			expect(r1.first.toolCall?.arguments.command).toBe("one");
			expect(r1.next!.toolCall?.arguments.command).toBe("two");
			const result2 = await b.exec(r1.next!.toolCall!);
			const r3 = await b.turn([...r1.messages, r1.next!.final!, toolResultMessage(r1.next!.toolCall!, result2)]);
			expect(r3.text).toBe("both");
			expect(methods().filter((m) => m === "turn/start")).toHaveLength(1);
		});

		it("renderCall draws Pi's shell and edit rows; the patch row is a Box with a preview diff for rbf-edit-glance", async () => {
			initTheme(); // renderDiff reads the active theme
			const b = await boot();
			const cmd = b.tools.get(TOOL_COMMAND)!;
			const rc = (executionStarted = false) => ({ state: {} as Record<string, unknown>, executionStarted, invalidate: () => {} });
			expect(cmd.renderCall({ itemId: "c1", command: "/bin/zsh -lc 'ls -la'", cwd: "/" }, fakeTheme, rc()).text).toBe("$ ls -la");
			expect(cmd.renderCall({ itemId: "c1", command: "", cwd: "/" }, fakeTheme, rc()).text).toBe("$ (pending)");
			// The result is a container built as Pi's bash row: rendered at a width, collapsed output is the last five visual lines behind Pi's hint (with its real key styling).
			const shown = (result: { content: { type: "text"; text: string }[]; details: Record<string, unknown> }, opts: { expanded: boolean; isPartial: boolean }, ctx: ReturnType<typeof rc>, width = 80) =>
				cmd.renderResult(result, opts, fakeTheme, { isError: false, ...ctx }).render(width).map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()).join("\n");
			const out = shown({ content: [{ type: "text", text: "1\n2\n3\n4\n5\n6\n7" }], details: {} }, { expanded: false, isPartial: false }, rc());
			expect(out).toMatch(/\.\.\. \(2 earlier lines, .*to expand\)/); // the key text is empty outside a running Pi; the row gate sees `ctrl+o`
			expect(out).toContain("3\n4\n5\n6\n7");
			expect(out).not.toContain("Took"); // no start time recorded: nothing to time
			expect(shown({ content: [{ type: "text", text: `${"w".repeat(100)}\n2\n3\n4\n5\n6` }], details: {} }, { expanded: false, isPartial: false }, rc())).toContain("... (2 earlier lines,"); // visual lines: the wide line wraps to two at width 80, as Pi counts
			expect(shown({ content: [{ type: "text", text: "1\n2\n3\n4\n5\n6\n7" }], details: {} }, { expanded: true, isPartial: false }, rc())).toContain("1\n2\n3");
			// Pi's bash row: the start time is kept in the row state once execution starts; `Elapsed` while partial, `Took` once final, and the ticking interval is cleared at the end.
			const timed = rc(true);
			cmd.renderCall({ itemId: "c1", command: "sleep 1", cwd: "/" }, fakeTheme, timed);
			expect(typeof timed.state.startedAt).toBe("number");
			expect(shown({ content: [], details: {} }, { expanded: false, isPartial: true }, timed)).toMatch(/^\nElapsed \d+\.\ds$/);
			expect(timed.state.interval).toBeDefined();
			expect(shown({ content: [{ type: "text", text: "done" }], details: {} }, { expanded: false, isPartial: false }, timed)).toMatch(/^\ndone\n\nTook \d+\.\ds$/); // a blank line before Took, as Pi's bash row
			expect(timed.state.interval).toBeUndefined();
			const patch = b.tools.get(TOOL_PATCH)!;
			const bgs: string[] = [];
			const bgTheme = { ...fakeTheme, bg: (c: string, t: string) => (bgs.push(c), t) };
			const box = patch.renderCall({ itemId: "p1", changes: [{ path: "src/a.ts", kind: "update", diff: diffA }, { path: "src/b.ts", kind: "delete", diff: "-gone\n" }, { path: "src/c.ts", kind: "update", movePath: "src/d.ts", diff: "" }] }, bgTheme, rc());
			expect(box).toBeInstanceOf(Box);
			expect(box.preview.diff).toBe(`${diffA}\n-gone\n`);
			const header = box.children[0].text as string;
			expect(header).toBe("edit src/a.ts (+3 −1)\ndelete src/b.ts (+0 −1)\nedit src/c.ts → src/d.ts (+0 −0)");
			box.render(80);
			const pending = patch.renderCall({ itemId: "p2", changes: [] }, bgTheme, rc());
			expect(pending.children[0].text).toBe("edit (pending)");
			pending.render(80);
			expect([...new Set(bgs)]).toEqual(["toolSuccessBg", "toolPendingBg"]); // Pi's edit row: success color once the diff is known, pending before (one call per rendered line)
			// Reuse the same box instance across renders, as Pi's edit row does, so rbf-edit-glance's paddingX=0 survives instead of a fresh paddingX=1 box.
			const reused = patch.renderCall({ itemId: "p1", changes: [{ path: "src/a.ts", kind: "update", diff: diffA }] }, fakeTheme, { state: {}, executionStarted: false, invalidate: () => {}, lastComponent: box });
			expect(reused).toBe(box);
			expect(reused.children[0].text).toBe("edit src/a.ts (+3 −1)"); // cleared and rebuilt, not appended
			expect(diffCounts(diffA)).toEqual({ added: 3, removed: 1 });
			expect(patchRowLine({ path: "n.ts", kind: "add", diff: "+a\n+b\n" })).toBe("write n.ts (+2 −0)");
			const q = b.tools.get(TOOL_QUESTION)!;
			expect(q.renderCall({ itemId: "q1", questions: [{ id: "a", header: "Color", question: "Which?" }] }, fakeTheme, rc()).text).toBe("? Color");
		});
	});

	describe("requests (Scenario 8)", () => {
		const diffA = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,4 @@\n line\n-old\n+new1\n+new2\n+new3\n";
		const replies = () => sent().filter((m) => m.id !== undefined && !m.method) as { id: number; result?: any; error?: any }[];

		it("an approval before item/started opens the row from the request; each choice answers by name once, and no second row opens", async () => {
			let starts = 0;
			for (const [answer, decision] of [["Yes", "accept"], ["Yes for this session", "acceptForSession"], [undefined, "cancel"]] as const) {
				scenario({ turn: [{ kind: "command", id: "c1", command: "/bin/zsh -lc 'echo hi'", output: ["hi\n"], approvals: [{ when: "before", command: "/bin/zsh -lc 'echo hi'", reason: "needs network" }] }, { kind: "answer", id: "m1", text: "said hi" }, { kind: "complete" }] });
				const b = await boot();
				b.answers.push(answer);
				const r = await b.round([userMessage("say hi")]);
				expect(r.first.toolCall).toEqual({ type: "toolCall", id: "codex-c1", name: TOOL_COMMAND, arguments: { itemId: "c1", threadId: "", agentPath: "", command: "/bin/zsh -lc 'echo hi'", cwd: process.cwd() } });
				expect(b.dialogs).toEqual([{ kind: "select", title: "Codex wants to run: echo hi — needs network", options: [...APPROVAL_CHOICES], signal: expect.any(AbortSignal) }]);
				expect(replies().at(-1)?.result).toEqual({ decision }); // the log spans the three boots of this test
				if (decision === "cancel") {
					expect(r.result).toMatchObject({ content: [{ type: "text", text: ROW_STATUS.declined }], isError: true });
					expect(r.next!.final?.stopReason).toBe("aborted");
					expect(b.entries.filter((e) => e.customType === TURN_ENTRY_TYPE)).toEqual([{ customType: TURN_ENTRY_TYPE, data: { threadId: "thread-fake-1", turnId: "turn-fake-1", status: "interrupted" } }]);
				} else {
					expect(r.result).toMatchObject({ content: [{ type: "text", text: "hi" }], isError: false });
					expect(r.next!.toolCall).toBeUndefined(); // item/started for c1 opened no second row
					expect(r.next!.text).toBe("said hi");
				}
				expect(methods().filter((m) => m === "turn/start")).toHaveLength(++starts); // one per boot in this test
			}
		});

		it("an approval that arrives while execute already waits opens the dialog from that execute; two callbacks for one item open two dialogs in order", async () => {
			scenario({ turn: [{ kind: "command", id: "c1", command: "curl x", output: ["ok\n"], approvals: [{ when: "after", approvalId: "a1", command: "curl x" }, { when: "after", approvalId: "a2", kind: "writeStdin", command: "curl x" }] }, { kind: "answer", id: "m1", text: "fetched" }, { kind: "complete" }] });
			const b = await boot();
			b.answers.push("Yes", "Yes");
			const r = await b.round([userMessage("fetch")]);
			expect(b.dialogs.map((d) => d.title)).toEqual(["Codex wants to run: curl x", "Codex wants to send input to: curl x"]);
			expect(replies().map((m) => m.result)).toEqual([{ decision: "accept" }, { decision: "accept" }]);
			expect(r.result).toMatchObject({ content: [{ type: "text", text: "ok" }], isError: false });
			expect(r.next!.text).toBe("fetched");
		});

		it("a request with command null opens the row as pending and titles the dialog (pending)", async () => {
			scenario({ turn: [{ kind: "command", id: "c1", command: "later", approvals: [{ when: "before", command: null }] }, { kind: "answer", id: "m1", text: "ok" }, { kind: "complete" }] });
			const b = await boot();
			b.answers.push("Yes");
			const r = await b.round([userMessage("go")]);
			expect(r.first.toolCall?.arguments).toEqual({ itemId: "c1", threadId: "", agentPath: "", command: "", cwd: process.cwd() });
			expect(b.tools.get(TOOL_COMMAND)!.renderCall(r.first.toolCall!.arguments, fakeTheme, { state: {}, executionStarted: false }).text).toBe("$ (pending)");
			expect(b.dialogs[0].title).toBe("Codex wants to run: (pending)");
		});

		it("a file change started first and then approved opens the patch dialog titled with paths and counts", async () => {
			scenario({ turn: [{ kind: "patch", id: "p1", changes: [{ path: "src/a.ts", kind: { type: "update" }, diff: diffA }], approvals: [{ when: "after" }] }, { kind: "answer", id: "m1", text: "edited" }, { kind: "complete" }] });
			const b = await boot();
			b.answers.push("Yes");
			const r = await b.round([userMessage("edit")]);
			expect(r.first.toolCall?.name).toBe(TOOL_PATCH);
			expect(b.dialogs[0].title).toBe("Codex wants to edit: src/a.ts (+3 −1)");
			expect(r.result).toMatchObject({ content: [{ type: "text", text: "applied 1 file(s): src/a.ts" }], isError: false });
		});

		it("a patch approval before its item opens the row pending and titles the dialog without paths", async () => {
			scenario({ turn: [{ kind: "patch", id: "p1", changes: [{ path: "src/a.ts", kind: { type: "update" }, diff: diffA }], approvals: [{ when: "before", reason: "outside the sandbox" }] }, { kind: "answer", id: "m1", text: "edited" }, { kind: "complete" }] });
			const b = await boot();
			b.answers.push("Yes");
			const r = await b.round([userMessage("edit")]);
			expect(r.first.toolCall?.arguments).toEqual({ itemId: "p1", threadId: "", agentPath: "", changes: [] });
			expect(b.dialogs[0].title).toBe("Codex wants to edit files — outside the sandbox");
			expect(r.result).toMatchObject({ content: [{ type: "text", text: "applied 1 file(s): src/a.ts" }] });
		});

		it("a question becomes a codex_question row; options render as label — description and the label goes back; Escape sends no answer", async () => {
			const questions = [{ id: "q1", header: "Color", question: "Which color?", options: [{ label: "RED", description: "warm" }, { label: "BLUE", description: "cool" }], isOther: true }, { id: "q2", header: "Name", question: "Call it?" }];
			scenario({ turn: [{ kind: "question", id: "u1", questions }, { kind: "answer", id: "m1", text: "noted" }, { kind: "complete" }] });
			const b = await boot();
			b.answers.push("BLUE — cool", "widget");
			const r = await b.round([userMessage("ask me")]);
			expect(r.first.toolCall).toEqual({ type: "toolCall", id: "codex-u1", name: TOOL_QUESTION, arguments: { itemId: "u1", threadId: "", agentPath: "", questions } });
			expect(b.dialogs).toEqual([{ kind: "select", title: "Color: Which color?", options: ["RED — warm", "BLUE — cool", OTHER_CHOICE], signal: expect.any(AbortSignal) }, { kind: "input", title: "Name: Call it?", signal: expect.any(AbortSignal) }]);
			expect(replies().at(-1)?.result).toEqual({ answers: { q1: { answers: ["BLUE"] }, q2: { answers: ["widget"] } } });
			expect(r.result).toMatchObject({ content: [{ type: "text", text: "Color: BLUE\nName: widget" }], isError: false });
			expect(r.next!.text).toBe("noted");

			scenario({ turn: [{ kind: "question", id: "u1", questions: [questions[0]] }, { kind: "answer", id: "m1", text: "noted" }, { kind: "complete" }] });
			const b2 = await boot();
			b2.answers.push(OTHER_CHOICE, "PINK");
			const r2 = await b2.round([userMessage("ask me")]);
			expect(b2.dialogs.map((d) => d.kind)).toEqual(["select", "input"]);
			expect(r2.result).toMatchObject({ content: [{ type: "text", text: "Color: PINK" }] });

			const b3 = await boot();
			b3.answers.push(undefined);
			const r3 = await b3.round([userMessage("ask me")]);
			expect(replies().at(-1)?.result).toEqual({ answers: { q1: { answers: [] } } });
			expect(r3.result).toMatchObject({ content: [{ type: "text", text: `Color: ${ROW_STATUS.declined}` }] });

			// Codex sends `options: null` on a free-text question; the persisted argument drops it so Pi's validator and renderCall see a clean shape.
			scenario({ turn: [{ kind: "question", id: "u1", questions: [{ id: "q9", header: "Name", question: "Call it?", options: null, isOther: false, isSecret: false }] }, { kind: "answer", id: "m1", text: "ok" }, { kind: "complete" }] });
			const b4 = await boot();
			b4.answers.push("gizmo");
			const r4 = await b4.round([userMessage("ask me")]);
			expect(r4.first.toolCall?.arguments.questions[0]).not.toHaveProperty("options");
			expect(b4.dialogs.map((d) => d.kind)).toEqual(["input"]);
			expect(r4.result).toMatchObject({ content: [{ type: "text", text: "Name: gizmo" }] });
		});

		it("a secret question declines the whole request with the secret notice; without a UI every request is declined with the notice", async () => {
			const questions = [{ id: "q1", header: "Token", question: "Paste it", isSecret: true }];
			scenario({ turn: [{ kind: "question", id: "u1", questions }, { kind: "answer", id: "m1", text: "ok" }, { kind: "complete" }] });
			const b = await boot();
			const r = await b.round([userMessage("go")]);
			expect(b.dialogs).toEqual([]);
			expect(replies()[0].error).toBeDefined();
			expect(b.notify).toHaveBeenCalledWith(NOTICE.secret, "warning");
			expect(r.result).toMatchObject({ content: [{ type: "text", text: ROW_STATUS.declined }], isError: true });

			scenario({ turn: [{ kind: "command", id: "c1", command: "ls", approvals: [{ when: "before" }] }, { kind: "answer", id: "m1", text: "ok" }, { kind: "complete" }] });
			const p = await boot({ mode: "print" });
			const rp = await p.round([userMessage("go")]);
			expect(p.select).not.toHaveBeenCalled();
			expect(replies()[0].error).toBeDefined();
			expect(rp.result).toMatchObject({ content: [{ type: "text", text: ROW_STATUS.declined }], isError: true });
		});

		it("an error row throws RowError so Pi tints it (a returned isError is ignored by Pi's loop)", async () => {
			scenario({ turn: [{ kind: "command", id: "c1", command: "touch /etc/x", approvals: [{ when: "before" }] }, { kind: "answer", id: "m1", text: "ok" }, { kind: "complete" }] });
			const b = await boot();
			b.answers.push("No, tell Codex what to do instead");
			const first = await b.turn("go");
			await expect(b.tools.get(TOOL_COMMAND)!.execute(first.toolCall!.id, first.toolCall!.arguments, undefined, undefined, b.ctx)).rejects.toBeInstanceOf(RowError);
		});

		it("a dialog still open when the turn ends is closed through its signal and answered decline", async () => {
			scenario({ turn: [{ kind: "command", id: "c1", command: "ls", approvals: [{ when: "after" }] }, { kind: "answer", id: "m1", text: "ok" }, { kind: "complete" }] });
			const b = await boot();
			const first = await b.turn("go");
			const ac = new AbortController();
			const p = b.exec(first.toolCall!, { signal: ac.signal }); // no answer queued: the dialog stays open
			await vi.waitFor(() => expect(b.dialogs).toHaveLength(1));
			ac.abort(); // Escape on the row: interrupt → the fake ends the turn → the dialog closes
			await expect(p).rejects.toThrow(ROW_STATUS.aborted); // v0.21.4 row text (Q24)
			expect(b.dialogs[0].signal?.aborted).toBe(true);
			await vi.waitFor(() => expect(replies().map((m) => m.result)).toEqual([{ decision: "decline" }]));
		});

		it("after Yes for this session, a respawn in the same process notifies the reset once; a fresh session_start notifies nothing", async () => {
			scenario({ turn: [{ kind: "command", id: "c1", command: "ls", approvals: [{ when: "before" }] }, { kind: "answer", id: "m1", text: "ok" }, { kind: "complete" }], laterTurns: [{ kind: "die" }] });
			const b = await boot();
			b.answers.push("Yes for this session");
			await b.round([userMessage("go")]);
			expect((await b.turn("two")).final?.errorMessage).toBe(COPY["codex-stopped"]);
			delete process.env.RBF_FAKE_SCENARIO;
			expect((await b.turn("three")).text).toBe("FAKE_OK");
			expect(b.notify.mock.calls.filter((c) => c[0] === NOTICE.restarted)).toHaveLength(1);
			await b.turn("four");
			expect(b.notify.mock.calls.filter((c) => c[0] === NOTICE.restarted)).toHaveLength(1);
			const fresh = await boot();
			await fresh.turn("one");
			expect(fresh.notify).not.toHaveBeenCalledWith(NOTICE.restarted, "warning");
		});

		it("a request queued for a row Pi never executes is answered with an error when the turn ends", async () => {
			// The approval opens the row; the test ends the turn by aborting the provider call instead of executing the tool.
			scenario({ turn: [{ kind: "command", id: "c1", command: "ls", approvals: [{ when: "before" }] }, { kind: "answer", id: "m1", text: "ok" }, { kind: "complete" }] });
			const b = await boot();
			const first = await b.turn("go");
			expect(first.toolCall?.name).toBe(TOOL_COMMAND);
			const ac = new AbortController();
			ac.abort();
			const recall = await b.turn([userMessage("go"), first.final!], model(), { signal: ac.signal });
			expect(recall.final?.stopReason).toBe("aborted");
			await vi.waitFor(() => expect(replies().filter((m) => m.error)).toHaveLength(1));
			await sleep(150); // let any second reply for the same id land before asserting exactly once
			const errors = replies().filter((m) => m.error);
			expect(errors).toHaveLength(1);
			expect(new Set(replies().map((m) => m.id)).size).toBe(replies().length);
		});

		it("truncates a dialog title to the width: reason first, then trailing paths, then an ellipsis", () => {
			expect(truncateTitle("Codex wants to run: ls — a very long reason", 30)).toBe("Codex wants to run: ls");
			expect(truncateTitle("Codex wants to edit: a.ts (+1 −0), b.ts (+2 −0), c.ts (+3 −0)", 40)).toBe("Codex wants to edit: a.ts (+1 −0)");
			expect(truncateTitle("Codex wants to run: a-command-that-is-very-long-indeed", 30)).toBe("Codex wants to run: a-command…");
			expect(truncateTitle("short", 30)).toBe("short");
		});
	});

	describe("branches (Scenario 9)", () => {
		const T = (sessionId: string, threadId = "thread-fake-1") => ({ type: "custom", customType: ENTRY_TYPE, data: { threadId, cwd: process.cwd(), sessionId } });
		const U = (turnId: string, status = "completed") => ({ type: "custom", customType: TURN_ENTRY_TYPE, data: { threadId: "thread-fake-1", turnId, status } });
		const threadEntries = (b: { entries: { customType: string; data: unknown }[] }) => b.entries.filter((e) => e.customType === ENTRY_TYPE).map((e) => e.data);

		it("(a) own thread, turn entry, nothing newer on Codex: resume with turns, no fork", async () => {
			scenario({ resumeTurns: [{ id: "turn-1", status: "completed" }] });
			const b = await boot({ sessionId: "A", branch: [T("A"), U("turn-1")] });
			await b.turn("hi");
			expect(methods()).toEqual(["initialize", "initialized", "thread/resume", "turn/start"]);
			expect(sent().find((m) => m.method === "thread/resume")!.params).toEqual({ threadId: "thread-fake-1" });
			expect(threadEntries(b)).toEqual([]);
		});

		it("(b) Codex completed a turn this branch never saw: fork at the branch's last turn, one new thread entry, turn/start on the fork", async () => {
			scenario({ resumeTurns: [{ id: "turn-1", status: "completed" }, { id: "turn-2", status: "completed" }] });
			const b = await boot({ sessionId: "A", branch: [T("A"), U("turn-1")] });
			await b.turn("hi");
			expect(methods()).toEqual(["initialize", "initialized", "thread/resume", "thread/fork", "turn/start"]);
			expect(sent().find((m) => m.method === "thread/fork")!.params).toEqual({ threadId: "thread-fake-1", lastTurnId: "turn-1", cwd: process.cwd(), ephemeral: false });
			expect(threadEntries(b)).toEqual([{ threadId: "thread-fake-fork-1", cwd: process.cwd(), sessionId: "A" }]);
			expect(sent().find((m) => m.method === "turn/start")!.params).toMatchObject({ threadId: "thread-fake-fork-1" });
		});

		it("(c, j) another session's thread with a turn entry: fork directly, no resume first", async () => {
			const b = await boot({ sessionId: "B", branch: [T("A"), U("turn-1")] });
			await b.turn("hi");
			expect(methods()).toEqual(["initialize", "initialized", "thread/fork", "turn/start"]);
			expect(threadEntries(b)).toEqual([{ threadId: "thread-fake-fork-1", cwd: process.cwd(), sessionId: "B" }]);
		});

		it("(d, f) another session's thread with no turn entry, or no thread at all: thread/start", async () => {
			const b = await boot({ sessionId: "B", branch: [T("A")] });
			await b.turn("hi");
			expect(methods()).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
			const c = await boot({ branch: [] });
			await c.turn("hi");
			expect(methods().filter((m) => m === "thread/start")).toHaveLength(2);
		});

		it("(e, k) only interrupted, failed, or inProgress turns after the branch's last turn: resume, no fork", async () => {
			scenario({ resumeTurns: [{ id: "turn-1", status: "completed" }, { id: "turn-2", status: "interrupted" }, { id: "turn-3", status: "failed" }, { id: "turn-4", status: "inProgress" }] });
			const b = await boot({ sessionId: "A", branch: [T("A"), U("turn-1")] });
			await b.turn("hi");
			expect(methods()).not.toContain("thread/fork");
			expect(threadEntries(b)).toEqual([]);
		});

		it("an interrupted turn entry after the completed one is never a fork's lastTurnId; with no completed entry a foreign thread starts cold", async () => {
			scenario({ resumeTurns: [{ id: "turn-1", status: "completed" }, { id: "turn-2", status: "interrupted" }, { id: "turn-3", status: "completed" }] });
			const b = await boot({ sessionId: "A", branch: [T("A"), U("turn-1"), U("turn-2", "interrupted")] });
			await b.turn("hi");
			expect(sent().find((m) => m.method === "thread/fork")!.params).toMatchObject({ lastTurnId: "turn-1" });
			const c = await boot({ sessionId: "B", branch: [T("A"), U("turn-2", "interrupted")] });
			await c.turn("hi");
			expect(methods().filter((m) => m === "thread/start")).toHaveLength(1);
		});

		it("(g) completed and interrupted turns each append one turn entry", async () => {
			scenario({ turn: [{ kind: "complete", status: "interrupted" }] });
			const b = await boot();
			const r = await b.turn("hi");
			expect(r.final?.stopReason).toBe("aborted");
			expect(b.entries.filter((e) => e.customType === TURN_ENTRY_TYPE)).toEqual([{ customType: TURN_ENTRY_TYPE, data: { threadId: "thread-fake-1", turnId: "turn-fake-1", status: "interrupted" } }]);
		});

		it("(h) a thread/fork error ends the call with turn-failed and sends no turn/start", async () => {
			scenario({ forkError: "no such turn" });
			const b = await boot({ sessionId: "B", branch: [T("A"), U("turn-1")] });
			const r = await b.turn("hi");
			expect(r.final?.errorMessage).toBe(COPY["turn-failed"]);
			expect(methods()).not.toContain("turn/start");
		});

		it("(i) own thread with no turn entry after it: resume without turns, never fork, even when Codex lists completed turns", async () => {
			scenario({ resumeTurns: [{ id: "turn-1", status: "completed" }, { id: "turn-2", status: "completed" }] });
			const b = await boot({ sessionId: "A", branch: [T("A")] });
			await b.turn("hi");
			expect(methods()).toEqual(["initialize", "initialized", "thread/resume", "turn/start"]);
			expect(sent().find((m) => m.method === "thread/resume")!.params).toEqual({ threadId: "thread-fake-1", excludeTurns: true });
		});
	});

	describe("steer (Scenario 10)", () => {
		it("a user message during an active turn is one turn/steer with the active turn id and no turn/start", async () => {
			scenario({ turn: [{ kind: "command", id: "c1", command: "sleep 1" }, { kind: "answer", id: "m1", text: "woke" }, { kind: "complete" }] });
			const b = await boot();
			const first = await b.turn("go");
			const result = await b.exec(first.toolCall!);
			const r = await b.turn([userMessage("go"), first.final!, toolResultMessage(first.toolCall!, result), userMessage("also check b")]);
			expect(r.final?.stopReason).toBe("stop");
			expect(r.text).toBe("woke");
			expect(sent().filter((m) => m.method === "turn/steer").map((m) => m.params)).toEqual([{ threadId: "thread-fake-1", expectedTurnId: "turn-fake-1", input: [{ type: "text", text: "also check b", text_elements: [] }] }]);
			expect(methods().filter((m) => m === "turn/start")).toHaveLength(1);
		});

		it("a refused steer becomes exactly one turn/start after the turn ends, carrying the steer text and images", async () => {
			scenario({ turn: [{ kind: "command", id: "c1", command: "sleep 1" }, { kind: "answer", id: "m1", text: "woke" }, { kind: "complete" }], laterTurns: [{ kind: "answer", id: "m2", text: "took the steer" }, { kind: "complete" }], steerError: "turn already ended" });
			const b = await boot();
			const m = model("gpt-fake-2");
			m.input = ["text", "image"];
			const first = await b.turn("go", m);
			const result = await b.exec(first.toolCall!);
			const steer = { role: "user" as const, content: [{ type: "text" as const, text: "and this" }, { type: "image" as const, data: "AAAA", mimeType: "image/png" }], timestamp: Date.now() };
			const r = await b.turn([userMessage("go"), first.final!, toolResultMessage(first.toolCall!, result), steer], m);
			expect(r.final?.stopReason).toBe("stop");
			expect(r.text).toBe("woketook the steer"); // the ended turn's answer, then the new turn's, in one Pi message
			expect(methods().filter((m) => m === "turn/steer")).toHaveLength(1);
			const starts = sent().filter((m) => m.method === "turn/start").map((m) => m.params!);
			expect(starts).toHaveLength(2);
			expect(starts[1]).toMatchObject({ threadId: "thread-fake-1", input: [{ type: "text", text: "and this", text_elements: [] }, { type: "image", url: "data:image/png;base64,AAAA" }] });
			expect(b.entries.filter((e) => e.customType === TURN_ENTRY_TYPE)).toHaveLength(2);
		});

		it("a refused steer survives a row that opens before the turn ends, and is sent exactly once", async () => {
			scenario({ turn: [{ kind: "command", id: "c1", command: "one" }, { kind: "command", id: "c2", command: "two" }, { kind: "answer", id: "m1", text: "both" }, { kind: "complete" }], laterTurns: [{ kind: "answer", id: "m2", text: "took the steer" }, { kind: "complete" }], steerError: "refused" });
			const b = await boot();
			const first = await b.turn("go");
			const result1 = await b.exec(first.toolCall!);
			const second = await b.turn([userMessage("go"), first.final!, toolResultMessage(first.toolCall!, result1), userMessage("later")]); // steer refused; this call ends on row c2
			expect(second.toolCall?.arguments.command).toBe("two");
			const result2 = await b.exec(second.toolCall!);
			const third = await b.turn([userMessage("go"), first.final!, toolResultMessage(first.toolCall!, result1), userMessage("later"), second.final!, toolResultMessage(second.toolCall!, result2)]);
			expect(third.text).toBe("bothtook the steer");
			const starts = sent().filter((m) => m.method === "turn/start").map((m) => m.params!);
			expect(starts).toHaveLength(2);
			expect(starts[1]).toMatchObject({ input: [{ type: "text", text: "later", text_elements: [] }] });
		});

		it("Escape that lands during the steer round trip still interrupts the turn", async () => {
			scenario({ turn: [{ kind: "command", id: "c1", command: "one" }, { kind: "hang" }] });
			const b = await boot();
			const first = await b.turn("go");
			const result = await b.exec(first.toolCall!);
			const ac = new AbortController();
			const p = b.turn([userMessage("go"), first.final!, toolResultMessage(first.toolCall!, result), userMessage("steer")], model(), { signal: ac.signal });
			ac.abort(); // before turn/steer has answered
			const r = await p;
			expect(r.final?.stopReason).toBe("aborted");
			await vi.waitFor(() => expect(methods()).toContain("turn/interrupt"));
		});
	});

	describe("images (Scenario 11)", () => {
		it("an image on an image-capable model travels as a data URL after the text; text-only models and the bootstrap row refuse it", async () => {
			const b = await boot();
			const m = model("gpt-fake-2");
			m.input = ["text", "image"];
			await b.turn([{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }], timestamp: Date.now() } as any], m);
			expect(sent().find((x) => x.method === "turn/start")!.params).toMatchObject({ input: [{ type: "text", text: "what is this", text_elements: [] }, { type: "image", url: "data:image/png;base64,iVBORw0KGgo=" }] });
			const t = await b.turn([{ role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: Date.now() } as any], model("gpt-fake-1"));
			expect(t.final?.errorMessage).toBe(COPY["unsupported-input"]);
			expect(methods().filter((x) => x === "turn/start")).toHaveLength(1);
			expect(COPY["unsupported-input"]).toBe("This Codex model accepts plain text only. Remove the image, or pick an image-capable Codex model.");
		});
	});

	describe("abort during a row (Scenario 12)", () => {
		it("aborting the tool's signal sends one turn/interrupt, rejects execute with the cut-row text, and Pi's re-call with the aborted signal finishes the turn silently", async () => {
			scenario({ turn: [{ kind: "command", id: "c1", command: "sleep 9", incomplete: true }, { kind: "hang" }] });
			const b = await boot();
			const first = await b.turn("go");
			const ac = new AbortController();
			const p = b.exec(first.toolCall!, { signal: ac.signal });
			await sleep(50);
			ac.abort();
			await expect(p).rejects.toThrow(ROW_STATUS.aborted); // v0.21.4: the command was never killed, so the row says so (Q24)
			await vi.waitFor(() => expect(methods().filter((m) => m === "turn/interrupt")).toHaveLength(1));
			const before = sent().length;
			const recall = await b.turn([userMessage("go"), first.final!], model(), { signal: ac.signal });
			expect(recall.final?.stopReason).toBe("aborted");
			expect(recall.events.map((e) => e.type)).toEqual(["error"]);
			expect(sent().length).toBe(before);
			expect(b.entries.filter((e) => e.customType === TURN_ENTRY_TYPE)).toEqual([{ customType: TURN_ENTRY_TYPE, data: { threadId: "thread-fake-1", turnId: "turn-fake-1", status: "interrupted" } }]);
			delete process.env.RBF_FAKE_SCENARIO;
			await b.turn("next");
			expect(methods().filter((m) => m === "turn/start")).toHaveLength(2);
		});

		it("with the interrupt ignored, the child is closed after 3 s and the next prompt spawns a new one", async () => {
			scenario({ turn: [{ kind: "command", id: "c1", command: "sleep 9", incomplete: true }, { kind: "hang" }], ignoreInterrupt: true });
			const b = await boot();
			const first = await b.turn("go");
			const ac = new AbortController();
			const p = b.exec(first.toolCall!, { signal: ac.signal });
			await sleep(50);
			ac.abort();
			await expect(p).rejects.toThrow(ROW_STATUS.aborted);
			const recall = await b.turn([userMessage("go"), first.final!], model(), { signal: ac.signal });
			expect(recall.final?.stopReason).toBe("aborted");
			delete process.env.RBF_FAKE_SCENARIO;
			await vi.waitFor(() => expect(sent().filter((m) => m.method === "initialize")).toHaveLength(1));
			expect((await b.turn("again")).text).toBe("FAKE_OK");
			expect(methods().filter((m) => m === "initialize")).toHaveLength(2);
		}, 15_000);

		it("child death during a row ends the row as Codex stopped and the next call as codex-stopped; under the shutdown flag both end aborted", async () => {
			scenario({ turn: [{ kind: "command", id: "c1", command: "sleep 9", incomplete: true }, { kind: "die" }] });
			const b = await boot();
			const first = await b.turn("go");
			const result = await b.exec(first.toolCall!);
			expect(result).toMatchObject({ content: [{ type: "text", text: ROW_STATUS.stopped }], isError: true });
			const next = await b.turn([userMessage("go"), first.final!, toolResultMessage(first.toolCall!, result)]);
			expect(next.final?.errorMessage).toBe(COPY["codex-stopped"]);
			delete process.env.RBF_FAKE_SCENARIO;
			expect((await b.turn("again")).text).toBe("FAKE_OK"); // activeTurn was nulled; a fresh child and turn

			scenario({ turn: [{ kind: "command", id: "c1", command: "sleep 9", incomplete: true }, { kind: "hang" }] });
			const s = await boot();
			const f = await s.turn("go");
			const p = s.exec(f.toolCall!);
			await sleep(50);
			await s.shutdown();
			expect(await p).toMatchObject({ isError: true });
			const after = await s.turn([userMessage("go"), f.final!, toolResultMessage(f.toolCall!, await p)]);
			expect(after.final?.stopReason).toBe("aborted");
		});
	});

	describe("tool call rows (Scenario 17)", () => {
		const replies = () => sent().filter((m) => m.id !== undefined && !m.method) as { id: number; result?: any; error?: any }[];
		const rc = (executionStarted = false, expanded = false) => ({ state: {} as Record<string, unknown>, executionStarted, expanded, invalidate: () => {} });
		const strip = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
		/** A theme whose styling is visible in the text, so bold and color placement can be asserted. */
		const markTheme = { fg: (c: string, t: string) => `<${c}>${t}</${c}>`, bg: (_c: string, t: string) => t, bold: (t: string) => `<b>${t}</b>` };
		const CUA_SUBTITLE = "Allowing ChatGPT to use this app introduces new risks, including those related to prompt injection attacks, such as data theft or loss. Carefully monitor ChatGPT while it uses this app.";

		it("an mcpToolCall becomes one codex_tool row carrying the root's empty thread and agent, the tool returns the joined text, and the next call attaches", async () => {
			scenario({ turn: [{ kind: "toolCall", id: "t1", server: "bear_app", tool: "list_tags", arguments: {}, result: { content: [{ type: "text", text: '{"tags":["a","b"]}' }] } }, { kind: "answer", id: "m1", text: "two tags" }, { kind: "complete" }] });
			const b = await boot();
			const updates: string[] = [];
			const r = await b.round([userMessage("list tags")], model(), { onUpdate: (p) => updates.push(p.content[0].text) });
			expect(r.first.final?.stopReason).toBe("toolUse");
			expect(r.first.toolCall).toEqual({ type: "toolCall", id: "codex-t1", name: TOOL_TOOL, arguments: { itemId: "t1", threadId: "", agentPath: "", server: "bear_app", tool: "list_tags", arguments: {} } });
			expect(r.result).toMatchObject({ content: [{ type: "text", text: '{"tags":["a","b"]}' }], details: { itemId: "t1", status: "completed", durationMs: 12 }, isError: false });
			expect(updates).toEqual([""]); // the empty first update opens the row with `Elapsed`, as Pi's bash row does; no progress updates after it
			expect(r.next!.text).toBe("two tags");
			expect(methods().filter((m) => m === "turn/start")).toHaveLength(1);
		});

		it("a failed call is an error row with Codex's message; a refused computer-use call carries its sentence; empty text shows structuredContent as JSON, or nothing; progress changes nothing", async () => {
			const cases: { ev: Record<string, unknown>; text: string; isError: boolean }[] = [
				{ ev: { error: "server bear_app is not running" }, text: "server bear_app is not running", isError: true },
				{ ev: { status: "failed", result: { content: [{ type: "text", text: "Computer Use was not approved to use Safari" }] } }, text: "Computer Use was not approved to use Safari", isError: true },
				{ ev: { result: { content: [{ type: "text", text: "" }], structuredContent: { value: 42 } } }, text: '{"value":42}', isError: false },
				{ ev: { result: { content: [{ type: "text", text: "" }] }, progress: true }, text: "", isError: false },
				{ ev: { result: { content: [{ type: "text", text: "first" }, { type: "image", data: "x" }, { type: "text", text: "second" }], structuredContent: { ignored: true } } }, text: "first\nsecond", isError: false },
			];
			for (const c of cases) {
				scenario({ turn: [{ kind: "toolCall", id: "t1", server: "node_repl", tool: "js", arguments: { code: "21*2" }, ...c.ev } as any, { kind: "answer", id: "m1", text: "42" }, { kind: "complete" }] });
				const b = await boot();
				const r = await b.round([userMessage("go")]);
				expect(r.result).toMatchObject({ content: [{ type: "text", text: c.text }], isError: c.isError });
				expect(r.next!.text).toBe("42"); // the turn goes on after a failed call; Codex decides what to do next
			}
		});

		it("renderCall: bold server.tool as the bash title, the app's name for the server, Codex's call title in output gray, a lone code argument collapsed as output is, other arguments as one JSON line", async () => {
			initTheme();
			const b = await boot();
			const tool = b.tools.get(TOOL_TOOL)!;
			const cmd = b.tools.get(TOOL_COMMAND)!;
			const lines = (component: any, width = 80) => component.render(width).map(strip);
			const args = (server: string, toolName: string, a: unknown) => ({ itemId: "t1", threadId: "", agentPath: "", server, tool: toolName, arguments: a });
			const marked = (component: any) => component.render(120).map((l: string) => l.trimEnd()); // Text pads its lines to the width
			expect(marked(tool.renderCall(args("bear_app", "list_tags", {}), markTheme, rc()))).toEqual(["<toolTitle><b>bear_app.list_tags</b></toolTitle>", "<toolOutput>{}</toolOutput>"]);
			expect(marked(tool.renderCall(args("cua_repl", "js", { code: "await cua.getState();", title: "Inspect current Mac UI state" }), markTheme, rc()))).toEqual(["<toolTitle><b>cua_repl.js</b></toolTitle> <toolOutput>Inspect current Mac UI state</toolOutput>", "<toolOutput>await cua.getState();</toolOutput>"]);
			expect(lines(tool.renderCall(args("GitHub_connector", "create_issue", { title: "Bug", body: "It fails" }), fakeTheme, rc()))).toEqual(["GitHub_connector.create_issue Bug", "It fails"]); // a title argument is Codex's call title wherever it appears; what is left is judged alone, so one remaining string is lines
			expect(lines(tool.renderCall(args("cua_repl", "js", { title: "Only a title" }), fakeTheme, rc()))).toEqual(["cua_repl.js Only a title"]); // the title was the whole call: no `{}` line under it (review 2026-09-14)
			expect(lines(tool.renderCall(args("GitHub_connector", "create_issue", { title: "Bug", body: "It fails", labels: ["a"] }), fakeTheme, rc()))).toEqual(["GitHub_connector.create_issue Bug", '{"body":"It fails","labels":["a"]}']);
			expect(lines(tool.renderCall(args("bear_app", "search_notes", { term: "x".repeat(120) }), fakeTheme, rc()), 40)[1]).toHaveLength(40); // one JSON line, cut to the width
			const three = "let a = 1;\nlet b = 2;\na + b;";
			expect(lines(tool.renderCall(args("node_repl", "js", { code: three }), fakeTheme, rc()))).toEqual(["node_repl.js", "let a = 1;", "let b = 2;", "a + b;"]); // three lines: no hint, no blank line between title and code
			const eight = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n");
			const call = lines(tool.renderCall(args("node_repl", "js", { code: `${eight}\n` }), fakeTheme, rc()));
			expect(call[0]).toBe("node_repl.js");
			expect(call[1]).toMatch(/^\.\.\. \(3 earlier lines, .*to expand\)$/);
			expect(call.slice(2)).toEqual(["line 4", "line 5", "line 6", "line 7", "line 8"]);
			const expanded = lines(tool.renderCall(args("node_repl", "js", { code: eight }), fakeTheme, rc(false, true)));
			expect(expanded.slice(1)).toEqual(eight.split("\n"));
			// The code argument and a command's output are the same bytes for the same lines: both go through the one preview helper.
			const asOutput = cmd.renderResult({ content: [{ type: "text", text: eight }], details: {} }, { expanded: false, isPartial: false }, fakeTheme, { isError: false, ...rc() }).render(80) as string[];
			expect(asOutput[0]).toBe(""); // bash's blank line between the title and its output; a code argument sits directly under the title
			expect(tool.renderCall(args("node_repl", "js", { code: eight }), fakeTheme, rc()).render(80).slice(1)).toEqual(asOutput.slice(1));
			// renderResult is the command row's function, so a tool result renders byte for byte as the same command output would.
			const result = { content: [{ type: "text", text: "1\n2\n3\n4\n5\n6\n7" }], details: {} };
			for (const expandedView of [false, true]) {
				const opts = { expanded: expandedView, isPartial: false };
				expect(tool.renderResult(result, opts, fakeTheme, { isError: false, ...rc() }).render(80)).toEqual(cmd.renderResult(result, opts, fakeTheme, { isError: false, ...rc() }).render(80));
			}
			// The app's name replaces the server while the turn holds the item (display only; the persisted argument keeps the server).
			scenario({ turn: [{ kind: "toolCall", id: "t1", server: "codex_apps", tool: "create_issue", arguments: { title: "Bug" }, appContext: { connectorId: "gh", appName: "GitHub" }, incomplete: true }, { kind: "hang" }] });
			const live = await boot();
			const first = await live.turn("file it");
			expect(first.toolCall!.arguments).toEqual({ itemId: "t1", threadId: "", agentPath: "", server: "codex_apps", tool: "create_issue", arguments: { title: "Bug" } });
			expect(lines(live.tools.get(TOOL_TOOL)!.renderCall(first.toolCall!.arguments, fakeTheme, rc()))).toEqual(["GitHub.create_issue Bug"]);
			// The timing state is bash's: `Elapsed` while partial, `Took` once final.
			const timed = rc(true);
			tool.renderCall(args("bear_app", "list_tags", {}), fakeTheme, timed);
			expect(typeof timed.state.startedAt).toBe("number");
			expect(lines(tool.renderResult({ content: [], details: {} }, { expanded: false, isPartial: true }, fakeTheme, { isError: false, ...timed })).join("\n")).toMatch(/^\nElapsed \d+\.\ds$/);
			expect(lines(tool.renderResult({ content: [{ type: "text", text: "done" }], details: {} }, { expanded: false, isPartial: false }, fakeTheme, { isError: false, ...timed })).join("\n")).toMatch(/^\ndone\n\nTook \d+\.\ds$/);
			expect(splitTitle("not an object")).toEqual({ rest: "not an object" });
			expect(loneString({ code: "" })).toBeUndefined();
			expect(loneString(["x"])).toBeUndefined();
		});

		it("the computer-use app question during the row: Codex's message titles the select; Yes accepts, Yes for this session persists, Escape cancels and the call fails with Codex's sentence; the risk notice once per session", async () => {
			const elicitation = { message: 'Allow Computer Use to use "Safari"?', app: "Safari", subtitle: CUA_SUBTITLE };
			for (const [answer, reply] of [["Yes", { action: "accept", content: {} }], ["Yes for this session", { action: "accept", content: {}, _meta: { persist: "session" } }], [undefined, { action: "cancel" }]] as const) {
				scenario({ turn: [{ kind: "toolCall", id: "t1", server: "cua_repl", tool: "js", arguments: { code: "await cua.getApp('com.apple.Safari');", title: "Open Safari" }, result: { content: [{ type: "text", text: "ok" }] }, elicitations: [elicitation] }, { kind: "answer", id: "m1", text: "done" }, { kind: "complete" }] });
				const b = await boot();
				b.answers.push(answer);
				const r = await b.round([userMessage("read the tab")]);
				expect(b.dialogs).toEqual([{ kind: "select", title: 'Allow Computer Use to use "Safari"?', options: [...APPROVAL_CHOICES], signal: expect.any(AbortSignal) }]);
				expect(replies().at(-1)?.result).toEqual(reply);
				expect(b.notify).toHaveBeenCalledWith(CUA_SUBTITLE, "warning");
				if (answer === undefined) expect(r.result).toMatchObject({ content: [{ type: "text", text: "Computer Use was not approved to use Safari" }], isError: true });
				else expect(r.result).toMatchObject({ content: [{ type: "text", text: "ok" }], isError: false });
				expect(r.next!.text).toBe("done"); // cancel fails the call; the turn goes on either way
				expect(b.notify.mock.calls.filter((c) => c[0] === CUA_SUBTITLE)).toHaveLength(1);
			}
			// Two app questions in one session: one risk notice; without `session` in persist the middle choice is not offered.
			scenario({ turn: [{ kind: "toolCall", id: "t1", server: "cua_repl", tool: "js", arguments: { code: "1" }, elicitations: [elicitation] }, { kind: "toolCall", id: "t2", server: "cua_repl", tool: "js", arguments: { code: "2" }, elicitations: [{ message: 'Allow Computer Use to use "Notes"?', app: "Notes", subtitle: CUA_SUBTITLE, persist: ["always"] }] }, { kind: "answer", id: "m1", text: "done" }, { kind: "complete" }] });
			const b = await boot();
			b.answers.push("Yes", "Yes");
			const r1 = await b.round([userMessage("go")]);
			expect(r1.next!.toolCall!.arguments).toMatchObject({ itemId: "t2" }); // the attach call ends with the second row
			const second = await b.exec(r1.next!.toolCall!);
			const last = await b.turn([...r1.messages, r1.next!.final!, toolResultMessage(r1.next!.toolCall!, second)]);
			expect(b.dialogs.map((d) => [d.title, d.options])).toEqual([['Allow Computer Use to use "Safari"?', [...APPROVAL_CHOICES]], ['Allow Computer Use to use "Notes"?', ["Yes", "No, tell Codex what to do instead"]]]);
			expect(b.notify.mock.calls.filter((c) => c[0] === CUA_SUBTITLE)).toHaveLength(1);
			expect(last.text).toBe("done");
		});

		it("an elicitation that is a real form, a URL prompt, or not a tool-call approval is declined with the notice; the call fails and the turn goes on", async () => {
			for (const shape of [{ properties: { name: { type: "string" } } }, { mode: "url" }, { approvalKind: null }, { approvalKind: "other" }]) {
				scenario({ turn: [{ kind: "toolCall", id: "t1", server: "cua_repl", tool: "js", arguments: { code: "1" }, elicitations: [{ message: "Fill this in", app: "Safari", ...shape }] }, { kind: "answer", id: "m1", text: "done" }, { kind: "complete" }] });
				const b = await boot();
				const r = await b.round([userMessage("go")]);
				expect(b.dialogs).toEqual([]);
				expect(replies().at(-1)?.error).toBeDefined();
				expect(b.notify).toHaveBeenCalledWith(NOTICE.declined("input"), "warning");
				expect(r.result).toMatchObject({ isError: true });
				expect(r.next!.text).toBe("done");
			}
			expect(isAppApproval({ mode: "form", _meta: { codex_approval_kind: "mcp_tool_call" }, requestedSchema: { type: "object" } })).toBe(true); // no `properties` at all counts as empty
			// Print and RPC modes have no dialog: the app question is declined with the notice and the call fails with Codex's sentence (Flow #13).
			scenario({ turn: [{ kind: "toolCall", id: "t1", server: "cua_repl", tool: "js", arguments: { code: "1" }, elicitations: [{ message: 'Allow Computer Use to use "Safari"?', app: "Safari" }] }, { kind: "answer", id: "m1", text: "done" }, { kind: "complete" }] });
			const p = await boot({ mode: "print" });
			const rp = await p.round([userMessage("go")]);
			expect(p.dialogs).toEqual([]);
			expect(p.notify).not.toHaveBeenCalled(); // notices are suppressed outside the TUI
			expect(rp.result).toMatchObject({ content: [{ type: "text", text: "Computer Use was not approved to use Safari" }], isError: true });
			expect(rp.next!.text).toBe("done");
		});

		it("an MCP server that fails to start is one warning notice per child process, naming the reason", async () => {
			scenario({ turn: [{ kind: "startupStatus", name: "bear_app", status: "starting" }, { kind: "startupStatus", name: "bear_app", status: "failed", failureReason: "spawn bearcli ENOENT" }, { kind: "startupStatus", name: "bear_app", status: "failed", failureReason: "spawn bearcli ENOENT" }, { kind: "startupStatus", name: "node_repl", status: "failed", error: "exit 1" }, { kind: "answer", id: "m1", text: "ok" }, { kind: "complete" }], laterTurns: [{ kind: "startupStatus", name: "bear_app", status: "failed", failureReason: "spawn bearcli ENOENT" }, { kind: "answer", id: "m2", text: "ok" }, { kind: "complete" }] });
			const b = await boot();
			await b.turn("hi");
			await b.turn("again");
			const startFailures = b.notify.mock.calls.filter((c) => String(c[0]).startsWith("Codex MCP server"));
			expect(startFailures).toEqual([[NOTICE.mcpStartFailed("bear_app", "spawn bearcli ENOENT"), "warning"], [NOTICE.mcpStartFailed("node_repl", "exit 1"), "warning"]]);
		});
	});

	describe("sub-agents (Scenario 18)", () => {
		const replies = () => sent().filter((m) => m.id !== undefined && !m.method) as { id: number; result?: any; error?: any }[];
		const rc = () => ({ state: {} as Record<string, unknown>, executionStarted: false, expanded: false, invalidate: () => {} });
		const markTheme = { fg: (c: string, t: string) => `<${c}>${t}</${c}>`, bg: (_c: string, t: string) => t, bold: (t: string) => `<b>${t}</b>` };
		const alpha = { kind: "subAgent", activity: "started", agentThreadId: "T2", agentPath: "/root/alpha" } as const;

		it("an announced child's command is a row carrying its thread and agent, tagged with its name; its dialog is prefixed; its text and reasoning never reach the parent; an unannounced thread opens nothing and is declined", async () => {
			scenario({
				turn: [
					alpha,
					{ kind: "childTurn", threadId: "T2", turnId: "T2-turn-1", events: [{ kind: "reasoning", delta: "child thinks " }, { kind: "command", id: "c2", command: "/bin/zsh -lc 'pytest -x'", output: ["1 passed\n"], approvals: [{ when: "before", command: "/bin/zsh -lc 'pytest -x'", reason: "runs tests" }] }, { kind: "answer", id: "m2", text: "CHILD DONE" }, { kind: "complete" }] },
					{ kind: "childTurn", threadId: "T3", turnId: "T3-turn-1", events: [{ kind: "command", id: "c3", command: "/bin/zsh -lc 'rm -rf x'", output: ["gone\n"], approvals: [{ when: "before", command: "/bin/zsh -lc 'rm -rf x'" }] }, { kind: "complete" }] },
					{ kind: "collab" },
					{ kind: "answer", id: "m1", text: "PARENT DONE" },
					{ kind: "complete" },
				],
			});
			const b = await boot();
			b.answers.push("Yes");
			const r = await b.round([userMessage("delegate")]);
			expect(r.first.toolCall).toEqual({ type: "toolCall", id: "codex-c2", name: TOOL_COMMAND, arguments: { itemId: "c2", threadId: "T2", agentPath: "/root/alpha", command: "/bin/zsh -lc 'pytest -x'", cwd: process.cwd() } });
			expect(r.first.thinking).toBe(""); // the child's reasoning is not the parent's
			expect(b.dialogs).toEqual([{ kind: "select", title: "alpha: Codex wants to run: pytest -x — runs tests", options: [...APPROVAL_CHOICES], signal: expect.any(AbortSignal) }]);
			expect(replies().filter((m) => m.result?.decision === "accept")).toHaveLength(1); // the child's own request id, answered once
			expect(r.result).toMatchObject({ content: [{ type: "text", text: "1 passed" }], isError: false });
			expect(r.next!.toolCall).toBeUndefined(); // T3 was never announced: no row
			expect(r.next!.text).toBe("PARENT DONE");
			expect(r.next!.thinking).toBe("");
			expect(replies().some((m) => m.error)).toBe(true); // T3's approval was declined with a JSON-RPC error
			expect(b.notify).toHaveBeenCalledWith(NOTICE.declined("approval"), "warning");
			// The row wears the agent's name as a muted tag before the unchanged bold title; the patch, question, and tool rows the same, one tag per line.
			initTheme(); // the patch row's renderDiff reads the active theme
			const cmd = b.tools.get(TOOL_COMMAND)!;
			expect(cmd.renderCall(r.first.toolCall!.arguments, markTheme, rc()).render(120)[0].trimEnd()).toBe("<muted>alpha </muted><toolTitle><b>$ pytest -x</b></toolTitle>");
			expect(cmd.renderCall({ ...r.first.toolCall!.arguments, agentPath: "" }, markTheme, rc()).render(120)[0].trimEnd()).toBe("<toolTitle><b>$ pytest -x</b></toolTitle>");
			const beta = { itemId: "x", threadId: "T9", agentPath: "/root/beta" };
			expect(b.tools.get(TOOL_PATCH)!.renderCall({ ...beta, changes: [{ path: "a.ts", kind: "update", diff: "+1 x" }, { path: "b.ts", kind: "add", diff: "+1 y" }] }, markTheme, rc()).children[0].text).toBe("<muted>beta </muted><toolTitle><b>edit a.ts (+1 −0)</b></toolTitle>\n<muted>beta </muted><toolTitle><b>write b.ts (+1 −0)</b></toolTitle>");
			expect(b.tools.get(TOOL_QUESTION)!.renderCall({ ...beta, questions: [{ id: "q", header: "Color", question: "Which?" }] }, markTheme, rc()).text).toBe("<muted>beta </muted><toolTitle><b>? Color</b></toolTitle>");
			expect(b.tools.get(TOOL_TOOL)!.renderCall({ ...beta, server: "bear_app", tool: "list_tags", arguments: {} }, markTheme, rc()).render(120)[0].trimEnd()).toBe("<muted>beta </muted><toolTitle><b>bear_app.list_tags</b></toolTitle>");
		});

		it("a child's turn ending settles its open row as aborted and keeps the thread; interacted re-drives it on a new turn; completed retires it; an announcement after the root's end is ignored", async () => {
			scenario({
				turn: [
					alpha,
					{ kind: "childTurn", threadId: "T2", turnId: "T2-a", events: [{ kind: "command", id: "c3", command: "/bin/zsh -lc 'sleep 5'", incomplete: true }, { kind: "complete", status: "interrupted" }] },
					{ kind: "subAgent", activity: "interacted", agentThreadId: "T2", agentPath: "/root/alpha" },
					{ kind: "childTurn", threadId: "T2", turnId: "T2-b", events: [{ kind: "command", id: "c4", command: "/bin/zsh -lc 'echo again'", output: ["again\n"] }, { kind: "complete" }] },
					{ kind: "subAgent", activity: "completed", agentThreadId: "T2", agentPath: "/root/alpha" },
					{ kind: "childTurn", threadId: "T2", turnId: "T2-c", events: [{ kind: "command", id: "c5", command: "/bin/zsh -lc 'echo late'", output: ["late\n"] }, { kind: "complete" }] },
					{ kind: "answer", id: "m1", text: "PARENT DONE" },
					{ kind: "complete", after: [{ kind: "subAgent", activity: "started", agentThreadId: "T9", agentPath: "/root/ghost" }] },
				],
				laterTurns: [{ kind: "answer", id: "m9", text: "SECOND" }, { kind: "complete" }],
			});
			const b = await boot();
			const r1 = await b.round([userMessage("delegate")]);
			expect(r1.first.toolCall!.arguments).toMatchObject({ itemId: "c3", threadId: "T2", agentPath: "/root/alpha" });
			expect(r1.result).toMatchObject({ content: [{ type: "text", text: ROW_STATUS.aborted }], isError: true }); // T2's turn ended while c3 was open
			expect(r1.next!.toolCall!.arguments).toMatchObject({ itemId: "c4", threadId: "T2", agentPath: "/root/alpha" }); // the thread was never retired: the re-drive's row opens
			const second = await b.exec(r1.next!.toolCall!);
			expect(second).toMatchObject({ content: [{ type: "text", text: "again" }], isError: false });
			const last = await b.turn([...r1.messages, r1.next!.final!, toolResultMessage(r1.next!.toolCall!, second)]);
			expect(last.toolCall).toBeUndefined(); // c5 came after `completed` retired T2
			expect(last.text).toBe("PARENT DONE");
			await sleep(60); // the ghost announcement after turn/completed lands on nothing
			expect((await b.turn("next")).text).toBe("SECOND");
		});

		it("with the root's own row executing, a child's approval opens its dialog from that execute at once; two pending requests answer in arrival order; the children's rows open next, already complete", async () => {
			scenario({
				turn: [
					{ kind: "command", id: "c1", command: "/bin/zsh -lc 'sleep 3'", incomplete: true },
					alpha,
					{ kind: "subAgent", activity: "started", agentThreadId: "T3", agentPath: "/root/beta" },
					{ kind: "childTurn", threadId: "T2", turnId: "T2-turn", detached: true, events: [{ kind: "command", id: "c2", command: "/bin/zsh -lc 'echo A'", output: ["A\n"], approvals: [{ when: "before", command: "/bin/zsh -lc 'echo A'", reason: "alpha asks" }] }, { kind: "complete" }] },
					{ kind: "childTurn", threadId: "T3", turnId: "T3-turn", detached: true, events: [{ kind: "command", id: "c3", command: "/bin/zsh -lc 'echo B'", output: ["B\n"], approvals: [{ when: "before", command: "/bin/zsh -lc 'echo B'", reason: "beta asks" }] }, { kind: "complete" }] },
					{ kind: "awaitReplies", count: 2 },
					{ kind: "finishCommand", id: "c1", command: "/bin/zsh -lc 'sleep 3'", aggregatedOutput: "slept\n" },
					{ kind: "answer", id: "m1", text: "PARENT DONE" },
					{ kind: "complete" },
				],
			});
			const b = await boot();
			b.answers.push("Yes", "Yes");
			const r1 = await b.round([userMessage("delegate")]);
			expect(r1.first.toolCall!.arguments).toMatchObject({ itemId: "c1", threadId: "", agentPath: "" });
			expect(b.dialogs.map((d) => d.title)).toEqual(["alpha: Codex wants to run: echo A — alpha asks", "beta: Codex wants to run: echo B — beta asks"]);
			expect(replies().filter((m) => m.result?.decision === "accept")).toHaveLength(2);
			expect(r1.result).toMatchObject({ content: [{ type: "text", text: "slept" }], isError: false }); // the root's row completed after both answers
			expect(r1.next!.toolCall!.arguments).toMatchObject({ itemId: "c2", threadId: "T2", agentPath: "/root/alpha" });
			const a = await b.exec(r1.next!.toolCall!);
			expect(a).toMatchObject({ content: [{ type: "text", text: "A" }], isError: false }); // already complete when its row opened
			expect(b.dialogs).toHaveLength(2); // no second dialog for an answered request
			const third = await b.turn([...r1.messages, r1.next!.final!, toolResultMessage(r1.next!.toolCall!, a)]);
			expect(third.toolCall!.arguments).toMatchObject({ itemId: "c3", threadId: "T3", agentPath: "/root/beta" });
			expect(await b.exec(third.toolCall!)).toMatchObject({ content: [{ type: "text", text: "B" }] });
			const last = await b.turn([...r1.messages, r1.next!.final!, toolResultMessage(r1.next!.toolCall!, a), third.final!, toolResultMessage(third.toolCall!, await b.exec(third.toolCall!))]);
			expect(last.text).toBe("PARENT DONE");
		});

		it("a child's turn/started before its announcement still gives the child its turn id and its rows (announcement order, Known Unknown 2026-09-14)", async () => {
			scenario({
				turn: [
					{ kind: "childTurn", threadId: "T2", turnId: "T2-early", detached: true, events: [{ kind: "sleep", ms: 60 }, { kind: "command", id: "c2", command: "/bin/zsh -lc 'echo early'", output: ["early\n"] }, { kind: "complete" }] },
					{ kind: "sleep", ms: 20 },
					alpha,
					{ kind: "sleep", ms: 120 },
					{ kind: "answer", id: "m1", text: "PARENT DONE" },
					{ kind: "complete" },
				],
			});
			const b = await boot();
			const r = await b.round([userMessage("delegate")]);
			expect(r.first.toolCall!.arguments).toMatchObject({ itemId: "c2", threadId: "T2", agentPath: "/root/alpha" });
			expect(r.result).toMatchObject({ content: [{ type: "text", text: "early" }] });
			expect(r.next!.text).toBe("PARENT DONE");
		});

		it("a child announced only by collabAgentToolCall receiverThreadIds (a code-mode model, gpt-5.6-luna 2026-09-15) is admitted untagged, its approval opens the dialog, and a completed state in a later wait retires it", async () => {
			scenario({
				turn: [
					{ kind: "collab", tool: "spawnAgent", receivers: ["T3"], states: { T3: "pendingInit" } },
					{ kind: "collab", tool: "wait", receivers: ["T3"], states: { T3: "running" } }, // a live state keeps the thread admitted
					{ kind: "childTurn", threadId: "T3", turnId: "T3-turn", events: [{ kind: "command", id: "c3", command: "/bin/zsh -lc 'printf ALPHA > /tmp/x'", output: ["ALPHA"], approvals: [{ when: "before", command: "/bin/zsh -lc 'printf ALPHA > /tmp/x'" }] }, { kind: "complete" }] },
					{ kind: "collab", tool: "wait", receivers: ["T3"], states: { T3: "completed" } },
					{ kind: "childTurn", threadId: "T3", turnId: "T3-late", events: [{ kind: "command", id: "c4", command: "/bin/zsh -lc 'echo late'", output: ["late\n"], approvals: [{ when: "before", command: "/bin/zsh -lc 'echo late'" }] }, { kind: "complete" }] },
					{ kind: "answer", id: "m1", text: "PARENT DONE" },
					{ kind: "complete" },
				],
			});
			const b = await boot();
			b.answers.push("Yes");
			const r = await b.round([userMessage("delegate")]);
			expect(r.first.toolCall!.arguments).toMatchObject({ itemId: "c3", threadId: "T3", agentPath: "" });
			expect(b.dialogs.map((d) => d.title)).toEqual(["Codex wants to run: printf ALPHA > /tmp/x"]); // no name on the wire, so no prefix
			expect(r.result).toMatchObject({ content: [{ type: "text", text: "ALPHA" }], isError: false });
			expect(r.next!.toolCall).toBeUndefined(); // c4 came after the wait reported T3 completed: retired, declined
			expect(r.next!.text).toBe("PARENT DONE");
			expect(replies().filter((m) => m.result?.decision === "accept")).toHaveLength(1);
			expect(replies().some((m) => m.error)).toBe(true);
			expect(b.notify).toHaveBeenCalledWith(NOTICE.declined("approval"), "warning");
		});

		const interrupts = () => sent().filter((m) => m.method === "turn/interrupt").map((m) => m.params);
		it("Escape reaches a collab-announced child whose turn/started beat the spawn's completion (the wire order on gpt-5.6-luna): root first, then the child, one turn/interrupt each", async () => {
			scenario({
				turn: [
					{ kind: "childTurn", threadId: "T3", turnId: "T3-turn", detached: true, events: [{ kind: "sleep", ms: 30 }, { kind: "command", id: "c3", command: "/bin/zsh -lc '/bin/sleep 30'", incomplete: true }, { kind: "hang" }] },
					{ kind: "sleep", ms: 10 },
					{ kind: "collab", tool: "spawnAgent", receivers: ["T3"], states: { T3: "pendingInit" } },
					{ kind: "hang" },
				],
			});
			const b = await boot();
			const first = await b.turn("delegate");
			expect(first.toolCall!.arguments).toMatchObject({ itemId: "c3", threadId: "T3", agentPath: "" });
			const ac = new AbortController();
			const p = b.exec(first.toolCall!, { signal: ac.signal });
			await sleep(50);
			ac.abort();
			await expect(p).rejects.toThrow(ROW_STATUS.aborted);
			await vi.waitFor(() => expect(interrupts()).toHaveLength(2));
			expect(interrupts()).toEqual([{ threadId: "thread-fake-1", turnId: "turn-fake-1" }, { threadId: "T3", turnId: "T3-turn" }]); // the turn id came from turnStarts, seen before the announcement
		});

		it("No on a child's dialog cancels that command and ends the agent's turn; the parent goes on and no turn/interrupt is sent (Flow #11)", async () => {
			scenario({
				turn: [
					alpha,
					{ kind: "childTurn", threadId: "T2", turnId: "T2-turn", events: [{ kind: "command", id: "c2", command: "/bin/zsh -lc 'rm -rf dist'", output: ["gone\n"], approvals: [{ when: "before", command: "/bin/zsh -lc 'rm -rf dist'", reason: "clean" }] }, { kind: "answer", id: "m2", text: "CHILD DONE" }, { kind: "complete" }] },
					{ kind: "answer", id: "m1", text: "PARENT DECIDES" },
					{ kind: "complete" },
				],
			});
			const b = await boot();
			b.answers.push(undefined); // Escape
			const r = await b.round([userMessage("delegate")]);
			expect(b.dialogs[0].title).toBe("alpha: Codex wants to run: rm -rf dist — clean");
			expect(r.result).toMatchObject({ content: [{ type: "text", text: ROW_STATUS.declined }], isError: true });
			expect(r.next!.text).toBe("PARENT DECIDES");
			expect(r.next!.final?.stopReason).toBe("stop"); // the child's turn ended interrupted; the root's did not
			expect(methods().filter((m) => m === "turn/interrupt")).toHaveLength(0);
		});

		it("a child's patch approval and question open the same prefixed dialogs and tagged rows as the parent's", async () => {
			const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n";
			scenario({
				turn: [
					alpha,
					{ kind: "childTurn", threadId: "T2", turnId: "T2-turn", events: [{ kind: "patch", id: "p2", changes: [{ path: "/abs/x.ts", kind: { type: "update" }, diff }], approvals: [{ when: "after", reason: "outside the sandbox" }] }, { kind: "question", id: "u2", questions: [{ id: "q1", header: "Color", question: "Which?", options: [{ label: "RED", description: "warm" }] }] }, { kind: "complete" }] },
					{ kind: "answer", id: "m1", text: "PARENT DONE" },
					{ kind: "complete" },
				],
			});
			const b = await boot();
			b.answers.push("Yes", "RED — warm");
			const r1 = await b.round([userMessage("delegate")]);
			expect(r1.first.toolCall!.arguments).toMatchObject({ itemId: "p2", threadId: "T2", agentPath: "/root/alpha" });
			expect(b.dialogs[0].title).toBe("alpha: Codex wants to edit: /abs/x.ts (+1 −1) — outside the sandbox");
			expect(r1.result).toMatchObject({ isError: false });
			expect(r1.next!.toolCall!.arguments).toMatchObject({ itemId: "u2", threadId: "T2", agentPath: "/root/alpha" });
			const answered = await b.exec(r1.next!.toolCall!);
			expect(b.dialogs[1].title).toBe("alpha: Color: Which?");
			expect(answered).toMatchObject({ content: [{ type: "text", text: "Color: RED" }] });
			const last = await b.turn([...r1.messages, r1.next!.final!, toolResultMessage(r1.next!.toolCall!, answered)]);
			expect(last.text).toBe("PARENT DONE");
		});
	});

	describe("abort with a sub-agent (Scenario 19)", () => {
		const interrupts = () => sent().filter((m) => m.method === "turn/interrupt").map((m) => m.params);

		it("Escape on a child's row interrupts the root, then every announced child with a turn id, one each, in order; a child without a turn/started gets none; the row text says the command still runs", async () => {
			scenario({
				turn: [
					{ kind: "subAgent", activity: "started", agentThreadId: "T2", agentPath: "/root/alpha" },
					{ kind: "subAgent", activity: "started", agentThreadId: "T4", agentPath: "/root/gamma" },
					{ kind: "childTurn", threadId: "T2", turnId: "T2-turn", detached: true, events: [{ kind: "command", id: "c2", command: "/bin/zsh -lc '/bin/sleep 30'", incomplete: true }, { kind: "hang" }] },
					{ kind: "hang" },
				],
			});
			const b = await boot();
			const first = await b.turn("delegate");
			expect(first.toolCall!.arguments).toMatchObject({ itemId: "c2", threadId: "T2", agentPath: "/root/alpha" });
			const ac = new AbortController();
			const p = b.exec(first.toolCall!, { signal: ac.signal });
			await sleep(50);
			ac.abort();
			await expect(p).rejects.toThrow(ROW_STATUS.aborted);
			await vi.waitFor(() => expect(interrupts()).toHaveLength(2));
			expect(interrupts()).toEqual([{ threadId: "thread-fake-1", turnId: "turn-fake-1" }, { threadId: "T2", turnId: "T2-turn" }]); // the root first, then the child; gamma never started a turn
			const recall = await b.turn([userMessage("delegate"), first.final!], model(), { signal: ac.signal });
			expect(recall.final?.stopReason).toBe("aborted");
			expect(b.entries.filter((e) => e.customType === TURN_ENTRY_TYPE)).toEqual([{ customType: TURN_ENTRY_TYPE, data: { threadId: "thread-fake-1", turnId: "turn-fake-1", status: "interrupted" } }]);
			expect(interrupts()).toHaveLength(2); // still one each after the re-call
		});

		it("a cut command's completion arriving after the turn ended raises exactly one notice and no row; one that never arrives raises none; a command that had ended before Escape raises none", async () => {
			scenario({ turn: [{ kind: "command", id: "c1", command: "/bin/zsh -lc '/bin/sleep 30'", incomplete: true }, { kind: "hang" }], afterInterrupt: [{ kind: "finishCommand", id: "c1", command: "/bin/zsh -lc '/bin/sleep 30'", exitCode: 0, aggregatedOutput: "" }, { kind: "finishCommand", id: "c1", command: "/bin/zsh -lc '/bin/sleep 30'", exitCode: 0 }] });
			const b = await boot();
			const first = await b.turn("wait");
			const ac = new AbortController();
			const p = b.exec(first.toolCall!, { signal: ac.signal });
			await sleep(50);
			ac.abort();
			await expect(p).rejects.toThrow(ROW_STATUS.aborted);
			const recall = await b.turn([userMessage("wait"), first.final!], model(), { signal: ac.signal });
			expect(recall.final?.stopReason).toBe("aborted");
			expect(recall.toolCall).toBeUndefined();
			await vi.waitFor(() => expect(b.notify).toHaveBeenCalledWith(NOTICE.finishedAfterCancel(0, "/bin/sleep 30"), "info"));
			await sleep(120); // the duplicate completion the fake sends next raises nothing
			expect(b.notify.mock.calls.filter((c) => String(c[0]).startsWith("Codex's command finished"))).toHaveLength(1);
			expect(b.tools.get(TOOL_COMMAND)!.renderResult({ content: [{ type: "text", text: ROW_STATUS.aborted }], details: {} }, { expanded: false, isPartial: false }, fakeTheme, { isError: true, state: {}, invalidate: () => {} }).render(80).map((l: string) => l.trimEnd())).toEqual(["", ROW_STATUS.aborted]);

			// Never completes before the child closes: no notice.
			scenario({ turn: [{ kind: "command", id: "c1", command: "/bin/zsh -lc '/bin/sleep 30'", incomplete: true }, { kind: "hang" }] });
			const s = await boot();
			const f = await s.turn("wait");
			const ac2 = new AbortController();
			const p2 = s.exec(f.toolCall!, { signal: ac2.signal });
			await sleep(50);
			ac2.abort();
			await expect(p2).rejects.toThrow(ROW_STATUS.aborted);
			await s.turn([userMessage("wait"), f.final!], model(), { signal: ac2.signal });
			await s.shutdown();
			await sleep(100);
			expect(s.notify.mock.calls.filter((c) => String(c[0]).startsWith("Codex's command finished"))).toHaveLength(0);

			// The command ended before Escape (its row returned); a completion echoed later is nobody's cut command.
			scenario({ turn: [{ kind: "command", id: "c1", command: "/bin/zsh -lc 'echo done'", output: ["done\n"] }, { kind: "hang" }], afterInterrupt: [{ kind: "finishCommand", id: "c1", command: "/bin/zsh -lc 'echo done'", exitCode: 0 }] });
			const e = await boot();
			const f3 = await e.turn("go");
			const done = await e.exec(f3.toolCall!);
			expect(done).toMatchObject({ content: [{ type: "text", text: "done" }] });
			const ac3 = new AbortController();
			const tail = e.turn([userMessage("go"), f3.final!, toolResultMessage(f3.toolCall!, done)], model(), { signal: ac3.signal });
			await sleep(50);
			ac3.abort();
			expect((await tail).final?.stopReason).toBe("aborted");
			await sleep(150);
			expect(e.notify.mock.calls.filter((c) => String(c[0]).startsWith("Codex's command finished"))).toHaveLength(0);
		});
	});

	describe("abort with a sub-agent (Scenario 19), review folds 2026-09-14", () => {
		it("a command row cut by its turn ending under it (a refused request on another item) reads the same and arms the same notice", async () => {
			scenario({
				turn: [{ kind: "command", id: "c1", command: "/bin/zsh -lc '/bin/sleep 30'", incomplete: true }, { kind: "command", id: "c2", command: "/bin/zsh -lc 'rm -rf dist'", approvals: [{ when: "before", command: "/bin/zsh -lc 'rm -rf dist'" }] }, { kind: "hang" }],
				afterInterrupt: [{ kind: "finishCommand", id: "c1", command: "/bin/zsh -lc '/bin/sleep 30'", exitCode: 0 }],
			});
			const b = await boot();
			b.answers.push(undefined); // No on c2's dialog, opened from c1's execute
			const r = await b.round([userMessage("go")]);
			expect(r.first.toolCall!.arguments).toMatchObject({ itemId: "c1" });
			expect(b.dialogs[0].title).toBe("Codex wants to run: rm -rf dist");
			expect(r.result).toMatchObject({ content: [{ type: "text", text: ROW_STATUS.aborted }], isError: true }); // the turn ended interrupted while c1 still ran
			expect(r.next!.toolCall!.arguments).toMatchObject({ itemId: "c2" }); // the refused request's own row is its trace
			const declined = await b.exec(r.next!.toolCall!);
			expect(declined).toMatchObject({ content: [{ type: "text", text: ROW_STATUS.declined }], isError: true });
			const last = await b.turn([...r.messages, r.next!.final!, toolResultMessage(r.next!.toolCall!, declined)]);
			expect(last.final?.stopReason).toBe("aborted");
			await vi.waitFor(() => expect(b.notify).toHaveBeenCalledWith(NOTICE.finishedAfterCancel(0, "/bin/sleep 30"), "info"));
			expect(b.notify.mock.calls.filter((c) => String(c[0]).startsWith("Codex's command finished"))).toHaveLength(1);
		});

		it("Escape on a tool call row or a question row reads Cancelled, without a command that could still run", async () => {
			scenario({ turn: [{ kind: "toolCall", id: "t1", server: "cua_repl", tool: "js", arguments: { code: "await cua.getState();" }, incomplete: true }, { kind: "hang" }] });
			const b = await boot();
			const first = await b.turn("go");
			const ac = new AbortController();
			const p = b.exec(first.toolCall!, { signal: ac.signal });
			await sleep(50);
			ac.abort();
			await expect(p).rejects.toThrow(/^Cancelled$/);
			await b.turn([userMessage("go"), first.final!], model(), { signal: ac.signal });
			expect(b.notify.mock.calls.filter((c) => String(c[0]).startsWith("Codex's command finished"))).toHaveLength(0);

			scenario({ turn: [{ kind: "question", id: "u1", questions: [{ id: "q", header: "Color", question: "Which?", options: [{ label: "RED", description: "warm" }] }] }, { kind: "hang" }] }); // a select waits for Escape; the harness's input returns at once
			const q = await boot();
			const f = await q.turn("ask");
			const ac2 = new AbortController();
			const pq = q.exec(f.toolCall!, { signal: ac2.signal }); // no answer queued: the dialog stays open until Escape on the row
			await vi.waitFor(() => expect(q.dialogs).toHaveLength(1));
			ac2.abort();
			await expect(pq).rejects.toThrow(/^Cancelled$/); // not `Color: Declined`: Escape cut the row, whatever the closed dialog answered
		});

		it("a cut command's completion landing while the next turn still waits for its id opens no phantom row", async () => {
			scenario({
				turn: [{ kind: "command", id: "c1", command: "/bin/zsh -lc '/bin/sleep 30'", incomplete: true }, { kind: "hang" }],
				afterInterrupt: [{ kind: "sleep", ms: 120 }, { kind: "finishCommand", id: "c1", command: "/bin/zsh -lc '/bin/sleep 30'", exitCode: 0 }],
				laterTurns: [{ kind: "answer", id: "m2", text: "SECOND" }, { kind: "complete" }],
				turnStartDelayMs: 300,
			});
			const b = await boot();
			const first = await b.turn("go");
			const ac = new AbortController();
			const p = b.exec(first.toolCall!, { signal: ac.signal });
			await sleep(50);
			ac.abort();
			await expect(p).rejects.toThrow(ROW_STATUS.aborted);
			await b.turn([userMessage("go"), first.final!], model(), { signal: ac.signal });
			const next = await b.turn("next"); // turn/start answered 300 ms later; c1's completion lands in between
			expect(next.toolCall).toBeUndefined();
			expect(next.text).toBe("SECOND");
			expect(b.notify.mock.calls.filter((c) => String(c[0]).startsWith("Codex's command finished"))).toHaveLength(1);
		});
	});

	describe("cancellation and child loss", () => {
		it("Escape sends turn/interrupt and ends aborted when Codex reports interrupted", async () => {
			scenario({ turn: [{ kind: "hang" }] });
			const b = await boot();
			const ac = new AbortController();
			const p = b.turn("hi", model(), { signal: ac.signal });
			await vi.waitFor(() => expect(methods()).toContain("turn/start"));
			ac.abort();
			const r = await p;
			expect(r.final?.stopReason).toBe("aborted");
			const interrupt = sent().find((m) => m.method === "turn/interrupt")!;
			expect(typeof interrupt.id).toBe("number"); // a request, not a notification: real Codex ignores the latter
			expect(interrupt.params).toEqual({ threadId: "thread-fake-1", turnId: "turn-fake-1" });
			expect(methods().filter((m) => m === "turn/start")).toHaveLength(1);
		});

		it("without a completion within 3 s the child is closed and the next prompt respawns", async () => {
			scenario({ turn: [{ kind: "hang" }], ignoreInterrupt: true });
			const b = await boot();
			const ac = new AbortController();
			const p = b.turn("hi", model(), { signal: ac.signal });
			await vi.waitFor(() => expect(methods()).toContain("turn/start"));
			ac.abort();
			const r = await p;
			expect(r.final?.stopReason).toBe("aborted");
			await vi.waitFor(() => expect(sent().filter((m) => m.method === "initialize")).toHaveLength(1));
			delete process.env.RBF_FAKE_SCENARIO;
			await new Promise((r) => setTimeout(r, 100));
			expect((await b.turn("again")).text).toBe("FAKE_OK");
			expect(methods().filter((m) => m === "initialize")).toHaveLength(2);
		}, 15_000);

		it("child death mid-turn ends with codex-stopped, but with the shutdown flag set it ends aborted", async () => {
			scenario({ turn: [{ kind: "die" }] });
			const b = await boot();
			const r = await b.turn("hi");
			expect(r.final?.stopReason).toBe("error");
			expect(r.final?.errorMessage).toBe(COPY["codex-stopped"]);

			scenario({ turn: [{ kind: "hang" }] });
			const p = b.turn("again");
			await vi.waitFor(() => expect(methods().filter((m) => m === "turn/start")).toHaveLength(2));
			await b.shutdown();
			const r2 = await p;
			expect(r2.final?.stopReason).toBe("aborted");
		});
	});

	describe("refusals and copy", () => {
		it("image input ends with unsupported-input and zero requests", async () => {
			const b = await boot();
			const r = await b.turn([{ role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }], timestamp: Date.now() } as any]);
			expect(r.final?.errorMessage).toBe(COPY["unsupported-input"]);
			expect(sent()).toEqual([]);
		});

		it("a 401 during the turn ends with codex-logged-out at once and interrupts the retrying turn", async () => {
			scenario({ turn: [{ kind: "authError" }, { kind: "hang" }] });
			const b = await boot();
			const started = Date.now();
			const r = await b.turn("hi");
			expect(r.final?.errorMessage).toBe(COPY["codex-logged-out"]);
			expect(Date.now() - started).toBeLessThan(3000);
			await vi.waitFor(() => expect(methods()).toContain("turn/interrupt")); // the fake logs the line when it reads it
		});

		it("a missing Codex binary ends with codex-missing; an auth error on initialize ends with codex-logged-out", async () => {
			const b1 = await boot({ command: MISSING_COMMAND });
			expect((await b1.turn("hi")).final?.errorMessage).toBe(COPY["codex-missing"]);
			scenario({ initializeError: "not logged in: run codex login" });
			const b2 = await boot();
			expect((await b2.turn("hi")).final?.errorMessage).toBe(COPY["codex-logged-out"]);
			// The failed child is not kept: after login the next prompt spawns and initializes again.
			delete process.env.RBF_FAKE_SCENARIO;
			await vi.waitFor(() => expect(sent().filter((m) => m.method === "initialize")).toHaveLength(1));
			expect((await b2.turn("again")).text).toBe("FAKE_OK");
			expect(sent().filter((m) => m.method === "initialize")).toHaveLength(2);
		});

		it("Escape during setup ends aborted without waiting for the request", async () => {
			const b = await boot({ command: { bin: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] } });
			const ac = new AbortController();
			const p = b.turn("hi", model(), { signal: ac.signal });
			await new Promise((r) => setTimeout(r, 150));
			ac.abort();
			const started = Date.now();
			const r = await p;
			expect(r.final?.stopReason).toBe("aborted");
			expect(Date.now() - started).toBeLessThan(1000);
		});

		it("every fixed error sentence is neither retryable nor a context overflow for Pi", () => {
			for (const sentence of Object.values(COPY)) {
				const m: AssistantMessage = { ...assistantMessage(""), content: [], stopReason: "error", errorMessage: sentence };
				expect(isRetryableAssistantError(m), sentence).toBe(false);
				expect(isContextOverflow(m), sentence).toBe(false);
			}
		});

		it("notices are suppressed outside the TUI", async () => {
			scenario({ turn: [{ kind: "complete", status: "failed", errorMessage: "boom" }] });
			const b = await boot({ mode: "print" });
			await b.turn("hi");
			expect(b.notify).not.toHaveBeenCalled();
		});
	});

	describe("session hooks", () => {
		it("shows the interrupted-request notice on session_start only for a bound branch ending in an unanswered user message", async () => {
			const entry = { type: "custom", customType: ENTRY_TYPE, data: { threadId: "t", cwd: process.cwd(), sessionId: "session-A" } };
			const bound = await boot({ sessionId: "session-A", branch: [entry, { type: "message", message: { role: "user", content: "x" } }] });
			expect(bound.notify).toHaveBeenCalledWith(NOTICE.interrupted, "warning");
			// A forked copy carries the original's session id, starts cold, and must not claim an interrupted request.
			const forked = await boot({ sessionId: "session-B", branch: [entry, { type: "message", message: { role: "user", content: "x" } }] });
			expect(forked.notify).not.toHaveBeenCalled();
			const answered = await boot({ branch: [entry, { type: "message", message: { role: "user", content: "x" } }, { type: "message", message: { role: "assistant", content: "y" } }] });
			expect(answered.notify).not.toHaveBeenCalled();
			// Pi died mid-row: the branch ends in the assistant message that opened the row, with no tool result after it.
			const midRow = await boot({ sessionId: "session-A", branch: [entry, { type: "message", message: { role: "user", content: "x" } }, { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "codex-c1", name: TOOL_COMMAND, arguments: {} }], stopReason: "toolUse" } as any }] });
			expect(midRow.notify).toHaveBeenCalledWith(NOTICE.interrupted, "warning");
			const unbound = await boot({ branch: [{ type: "message", message: { role: "user", content: "x" } }] });
			expect(unbound.notify).not.toHaveBeenCalled();
		});

		it("manual compact cancels with the notice; threshold compact cancels silently; unbound branches are untouched", async () => {
			const entry = { type: "custom", customType: ENTRY_TYPE, data: {} };
			const b = await boot({ branch: [entry] });
			expect(await b.handlers.get("session_before_compact")!({ reason: "manual" }, b.ctx)).toEqual({ cancel: true });
			expect(b.notify).toHaveBeenCalledWith(NOTICE.compact, "info");
			b.notify.mockClear();
			expect(await b.handlers.get("session_before_compact")!({ reason: "threshold" }, b.ctx)).toEqual({ cancel: true });
			expect(b.notify).not.toHaveBeenCalled();
			const u = await boot();
			expect(await u.handlers.get("session_before_compact")!({ reason: "manual" }, u.ctx)).toEqual({});
		});

		it("tree navigation with a wanted summary returns the fixed summary while bound, nothing otherwise", async () => {
			const b = await boot({ branch: [{ type: "custom", customType: ENTRY_TYPE, data: {} }] });
			expect(await b.handlers.get("session_before_tree")!({ preparation: { userWantsSummary: true } }, b.ctx)).toEqual({ summary: { summary: NOTICE.treeSummary } });
			expect(await b.handlers.get("session_before_tree")!({ preparation: { userWantsSummary: false } }, b.ctx)).toEqual({});
			const u = await boot();
			expect(await u.handlers.get("session_before_tree")!({ preparation: { userWantsSummary: true } }, u.ctx)).toEqual({});
		});

		it("switching into a Codex model on a session with an answer shows the cold-start notice once", async () => {
			const b = await boot({ branch: [{ type: "message", message: { role: "assistant", content: "y" } }] });
			const select = b.handlers.get("model_select")!;
			await select({ model: model("gpt-fake-1"), previousModel: { ...model("claude"), provider: "anthropic" } }, b.ctx);
			expect(b.notify).toHaveBeenCalledWith(NOTICE.coldStart, "info");
			b.notify.mockClear();
			await select({ model: model("gpt-fake-2"), previousModel: model("gpt-fake-1") }, b.ctx);
			expect(b.notify).not.toHaveBeenCalled();
			const empty = await boot();
			await empty.handlers.get("model_select")!({ model: model(), previousModel: undefined }, empty.ctx);
			expect(empty.notify).not.toHaveBeenCalled();
		});
	});
});
