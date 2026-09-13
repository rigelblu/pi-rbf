import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, RefreshModelsContext, ThinkingLevel } from "@earendil-works/pi-ai";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { API_ID, BOOTSTRAP_MODEL, BOOTSTRAP_MODEL_ID, COPY, CATALOG_MAX_AGE_MS, ENTRY_TYPE, NOTICE, PROVIDER_ID, codexModelId, createRbfCodex, displayCommand, humanRequestKind, mapEffort, toProviderModel } from "./rbf-codex.ts";
import type { FakeScenario } from "./test-support/rbf-codex-fake-app-server.ts";

const FAKE = resolve(import.meta.dirname, "test-support/rbf-codex-fake-app-server.ts");
// Vitest runs on Node, which strips types from .ts on its own (Node 22.6+).
const fakeCommand = { bin: process.execPath, args: [FAKE] };
const MISSING_COMMAND = { bin: "/nonexistent/codex-not-here", args: ["app-server"] };

type Handler = (event: any, ctx: ExtensionContext) => Promise<any>;
type Entry = { type: string; customType?: string; data?: unknown; message?: { role: string; content: unknown } };

function makePi() {
	const handlers = new Map<string, Handler>();
	const entries: { customType: string; data: unknown }[] = [];
	let provider: { name: string; config: ProviderConfig } | undefined;
	const pi = {
		on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
		appendEntry: vi.fn((customType: string, data: unknown) => entries.push({ customType, data })),
		registerProvider: vi.fn((name: string, config: ProviderConfig) => {
			provider = { name, config };
		}),
	} as unknown as ExtensionAPI;
	return {
		pi,
		handlers,
		entries,
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
	const ctx = {
		mode: opts.mode ?? "tui",
		ui: { notify, setWorkingMessage },
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => opts.sessionId ?? "session-A",
			getCwd: () => opts.cwd ?? process.cwd(),
		},
	} as unknown as ExtensionContext;
	return { ctx, branch, notify, setWorkingMessage };
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
	return { events, final, text, thinking };
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
		return { ...fx, ...c, turn, shutdown };
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
			expect(m).toMatchObject({ id: "codex-gpt-x", name: "GPT-X (Codex agent)", reasoning: true, input: ["text"] }); // text-only until pi-10.3; id prefixed so the row never collides with openai-codex
			expect(codexModelId("codex-gpt-x")).toBe("gpt-x");
			expect(codexModelId("gpt-legacy")).toBe("gpt-legacy");
			expect(codexModelId(BOOTSTRAP_MODEL_ID)).toBeUndefined();
			expect(m.thinkingLevelMap).toEqual({ minimal: null, low: null, medium: "medium", high: "high", xhigh: null, max: null });
			expect(toProviderModel(codexModel("gpt-y", ["low", "xhigh", "max"])).thinkingLevelMap).toEqual({ minimal: null, low: "low", medium: null, high: null, xhigh: "xhigh", max: "max" });
		});

		function refreshCtx(opts: { allowNetwork: boolean; force?: boolean; stored?: RefreshModelsContext["stored"] }) {
			const publish = vi.fn(async () => true);
			const ctx = { allowNetwork: opts.allowNetwork, force: opts.force, stored: opts.stored, publish, signal: new AbortController().signal } as unknown as RefreshModelsContext;
			return { ctx, publish };
		}
		const storedEntry = (checkedAt: number) => ({ models: [{ ...model("gpt-stored", { minimal: null, low: "low", medium: null, high: null, xhigh: null, max: null }), name: "GPT-STORED (Codex agent)" }], checkedAt }); // bare id, as a pre-prefix store would hold

		it("returns the stored list without network and never spawns", async () => {
			const b = await boot();
			const r = refreshCtx({ allowNetwork: false, stored: storedEntry(0) });
			const list = await b.provider.config.refreshModels!(r.ctx);
			expect(list.map((m) => m.id)).toEqual([BOOTSTRAP_MODEL_ID, "codex-gpt-stored"]); // normalized on read
			expect(r.publish).not.toHaveBeenCalled();
			expect(sent()).toEqual([]);
		});

		it("skips the fetch when the store is fresh, fetches and publishes when forced or stale, and skips hidden models", async () => {
			const now = 1_000_000_000_000;
			const fx = makePi();
			createRbfCodex({ command: fakeCommand, argv: [], now: () => now })(fx.pi);
			const fresh = refreshCtx({ allowNetwork: true, stored: storedEntry(now - CATALOG_MAX_AGE_MS + 1000) });
			expect((await fx.provider.config.refreshModels!(fresh.ctx)).map((m) => m.id)).toEqual([BOOTSTRAP_MODEL_ID, "codex-gpt-stored"]);
			expect(fresh.publish).not.toHaveBeenCalled();
			expect(sent()).toEqual([]);

			const forced = refreshCtx({ allowNetwork: true, force: true, stored: storedEntry(now) });
			const list = await fx.provider.config.refreshModels!(forced.ctx);
			expect(list.map((m) => m.id)).toEqual([BOOTSTRAP_MODEL_ID, "codex-gpt-fake-1", "codex-gpt-fake-2"]);
			expect(list[2]).toMatchObject({ name: "GPT Fake 2 (Codex agent)", input: ["text"], reasoning: true });
			expect(list[2].thinkingLevelMap).toEqual({ minimal: null, low: null, medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
			expect(forced.publish).toHaveBeenCalledTimes(1);
			const persisted = (forced.publish.mock.calls[0] as unknown as [{ persist: { models: Model<any>[]; checkedAt: number } }])[0].persist;
			expect(persisted.checkedAt).toBe(now);
			expect(persisted.models.map((m) => m.id)).toEqual(["codex-gpt-fake-1", "codex-gpt-fake-2"]);
			expect(persisted.models[0]).toMatchObject({ api: API_ID, provider: PROVIDER_ID });
			expect(methods()).toEqual(["initialize", "initialized", "model/list"]);

			const stale = refreshCtx({ allowNetwork: true, stored: storedEntry(now - CATALOG_MAX_AGE_MS - 1) });
			await fx.provider.config.refreshModels!(stale.ctx);
			expect(stale.publish).toHaveBeenCalledTimes(1);
		});

		it("returns the stored or bootstrap list without throwing when the spawn fails", async () => {
			const b = await boot({ command: MISSING_COMMAND });
			const r1 = refreshCtx({ allowNetwork: true, force: true, stored: storedEntry(0) });
			expect((await b.provider.config.refreshModels!(r1.ctx)).map((m) => m.id)).toEqual([BOOTSTRAP_MODEL_ID, "codex-gpt-stored"]);
			const r2 = refreshCtx({ allowNetwork: true, force: true });
			expect(await b.provider.config.refreshModels!(r2.ctx)).toEqual([BOOTSTRAP_MODEL]);
			expect(r1.publish).not.toHaveBeenCalled();
		});
	});

	describe("model and effort on turn/start", () => {
		it("sends the catalog model id and the mapped effort", async () => {
			const b = await boot();
			await b.turn("hi", model("codex-gpt-fake-2", { minimal: null, low: null, medium: "medium", high: "high", xhigh: "xhigh", max: "max" }), { reasoning: "high" });
			const start = sent().find((m) => m.method === "turn/start")!;
			expect(start.params).toMatchObject({ model: "gpt-fake-2", effort: "high" }); // prefix stripped for Codex
		});

		it("sends effort but no model for the bootstrap id, and neither effort when the level is unsupported or off", async () => {
			const b = await boot();
			await b.turn("one", model(), { reasoning: "medium" });
			await b.turn("two", model(), {});
			await b.turn("three", model("codex-gpt-fake-1", { minimal: null, low: "low", medium: null, high: null, xhigh: null, max: null }), { reasoning: "high" });
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
			const r = await b.turn("hi", model("codex-gpt-gone"), { reasoning: "high" });
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
			expect(b.entries).toEqual([{ customType: ENTRY_TYPE, data: { threadId: "thread-fake-1", cwd: process.cwd(), sessionId: "session-A" } }]);
			b.branch.push({ type: "custom", customType: ENTRY_TYPE, data: b.entries[0].data });
			await b.turn("second");
			expect(methods().filter((m) => m === "thread/start")).toHaveLength(1);
			expect(methods().filter((m) => m === "thread/resume")).toHaveLength(1);
			expect(sent().find((m) => m.method === "thread/resume")!.params).toMatchObject({ threadId: "thread-fake-1", excludeTurns: true });
			expect(b.entries).toHaveLength(1);
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
		it("commands, exit codes, reasoning, and commentary become thinking; final_answer streams as text; working line follows", async () => {
			scenario({
				turn: [
					{ kind: "command", id: "c1", command: "pwd" },
					{ kind: "reasoning", delta: "thinking about it " },
					{ kind: "command", id: "c2", command: "false", exitCode: 1 },
					{ kind: "commentary", id: "m1", text: "Looking at the repo now" },
					{ kind: "answer", id: "m2", text: "PWD=/tmp", phase: "final_answer" },
					{ kind: "complete" },
				],
			});
			const b = await boot();
			const r = await b.turn("Run pwd");
			expect(r.final?.stopReason).toBe("stop");
			expect(r.text).toBe("PWD=/tmp");
			expect(r.thinking).toBe("$ pwd\nthinking about it $ false\n→ exit 1\nLooking at the repo now ");
			const calls = b.setWorkingMessage.mock.calls.map((c) => c[0]);
			expect(calls[0]).toBe("$ pwd");
			expect(calls).toContain("$ false → exit 1");
			expect(calls).toContain("Looking at the repo now");
			expect(calls[calls.length - 1]).toBeUndefined();
			const kinds = r.events.map((e) => e.type);
			expect(kinds[0]).toBe("start");
			expect(kinds).toContain("thinking_start");
			expect(kinds).toContain("text_delta");
			expect(kinds[kinds.length - 1]).toBe("done");
		});

		it("strips Codex's login-shell wrapper from the working line and the thinking record", async () => {
			expect(displayCommand("/bin/zsh -lc pwd")).toBe("pwd");
			expect(displayCommand("/bin/zsh -lc '/bin/sleep 20'")).toBe("/bin/sleep 20");
			expect(displayCommand("ls -la")).toBe("ls -la");
			scenario({ turn: [{ kind: "command", id: "c1", command: "/bin/zsh -lc pwd" }, { kind: "answer", id: "m1", text: "OK" }, { kind: "complete" }] });
			const b = await boot();
			const r = await b.turn("Run pwd");
			expect(r.thinking).toBe("$ pwd\n");
			expect(b.setWorkingMessage.mock.calls[0][0]).toBe("$ pwd");
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

		it("answers a server request with a JSON-RPC error and the turn continues", async () => {
			scenario({ turn: [{ kind: "serverRequest", method: "item/commandExecution/requestApproval" }, { kind: "answer", id: "m1", text: "DONE" }, { kind: "complete" }] });
			const b = await boot();
			const r = await b.turn("hi");
			expect(r.text).toBe("DONE");
			const reply = sent().find((m) => m.id !== undefined && !m.method);
			expect(reply).toMatchObject({ error: { code: -32601 } });
			expect(b.notify).toHaveBeenCalledWith(NOTICE.declined("approval"), "warning");
		});

		it("a legacy approval request and a user-input request are declined with the matching notice; other server requests silently", async () => {
			scenario({ turn: [{ kind: "serverRequest", method: "execCommandApproval" }, { kind: "serverRequest", method: "item/tool/requestUserInput" }, { kind: "serverRequest", method: "attestation/generate" }, { kind: "answer", id: "m1", text: "DONE" }, { kind: "complete" }] });
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

		it("sends exactly one turn/start per streamSimple call across success, failure, and interruption", async () => {
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
			expect(methods()).toContain("turn/interrupt");
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
