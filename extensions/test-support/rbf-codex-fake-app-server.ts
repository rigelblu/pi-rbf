// Scripted `codex app-server` stand-in for rbf-codex tests: JSON-RPC lines over stdio.
// The scenario comes from RBF_FAKE_SCENARIO (JSON); every inbound message is appended
// to RBF_FAKE_LOG so a test can assert exactly what Pi sent.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

export type FakeApproval = { when: "before" | "after"; command?: string | null; reason?: string; kind?: string; approvalId?: string };
/** Computer use's per-app question, as Codex 0.154.0 sends it (probe 2026-09-14): an empty-form MCP elicitation during the `mcpToolCall`; a refused one fails the call and the turn goes on. */
export type FakeElicitation = { message: string; app?: string; subtitle?: string; persist?: string[]; mode?: string; properties?: Record<string, unknown>; approvalKind?: string | null };
export type FakeTurnEvent =
	| { kind: "command"; id: string; command: string; cwd?: string; exitCode?: number; output?: string[]; approvals?: FakeApproval[]; aggregatedOutput?: string; incomplete?: boolean }
	| { kind: "toolCall"; id: string; server: string; tool: string; arguments?: unknown; appContext?: Record<string, unknown> | null; result?: { content?: unknown[]; structuredContent?: unknown }; status?: "completed" | "failed"; error?: string; elicitations?: FakeElicitation[]; progress?: boolean; incomplete?: boolean; durationMs?: number }
	| { kind: "startupStatus"; name: string; status: string; error?: string | null; failureReason?: string | null }
	/** A `subAgentActivity` item on the current turn, as Codex announces a sub-agent (probe 2026-09-14). */
	| { kind: "subAgent"; activity: "started" | "interacted" | "completed" | "interrupted"; agentThreadId: string; agentPath: string }
	/** A sub-agent's turn on its own thread: `turn/started`, its events with the child's ids, ending on its own `complete`. Inline unless `detached`, which lets two children run at once. */
	| { kind: "childTurn"; threadId: string; turnId?: string; events: FakeTurnEvent[]; detached?: boolean }
	/** Complete a command started with `incomplete` earlier, on the current turn (a root row held open while a child works). */
	| { kind: "finishCommand"; id: string; command: string; exitCode?: number; aggregatedOutput?: string }
	/** A `collabAgentToolCall` on the current turn; draws nothing. A code-mode model announces a child only here: `receivers` on the completion, `states` per child (probe `subapproval-luna.jsonl` and Tomek's sol rollouts, 2026-09-15). */
	| { kind: "collab"; tool?: string; receivers?: string[]; states?: Record<string, string> }
	/** Timing controls for interleaved turns: pause, or wait until Pi has answered this many server requests in this process. */
	| { kind: "sleep"; ms: number }
	| { kind: "awaitReplies"; count: number }
	| { kind: "patch"; id: string; changes: { path: string; kind: { type: string; move_path?: string | null }; diff: string }[]; approvals?: FakeApproval[]; status?: string }
	| { kind: "question"; id: string; questions: unknown[] }
	| { kind: "reasoning"; delta: string }
	| { kind: "commentary"; id: string; text: string }
	| { kind: "answer"; id: string; text: string; phase?: "final_answer" | null; streamed?: boolean }
	| { kind: "serverRequest"; method: string; params?: Record<string, unknown> }
	| { kind: "authError" }
	| { kind: "die" }
	| { kind: "hang" }
	| { kind: "complete"; status?: "completed" | "interrupted" | "failed"; errorMessage?: string; after?: FakeTurnEvent[] };

export type FakeScenario = {
	/** Reject `initialize` with this message. */
	initializeError?: string;
	/** Reject `turn/start` when it carries this model id (the retired-model case). */
	retiredModel?: string;
	/** Events emitted after `turn/start`, in order. Default: one streamed answer, then completed. */
	turn?: FakeTurnEvent[];
	/** Events for the second and later turns, when they differ. */
	laterTurns?: FakeTurnEvent[];
	/** Swallow `turn/interrupt` so no completion ever arrives. */
	ignoreInterrupt?: boolean;
	/** Turns listed on `thread/resume` (with turns). */
	resumeTurns?: { id: string; status: string }[];
	/** Reject `thread/fork` with this message. */
	forkError?: string;
	/** Reject `turn/steer` with this message. */
	steerError?: string;
	/** Emitted after an interrupted turn's `turn/completed`, with that turn's ids: a `finishCommand` here is Codex reporting a command that ran on after the cancel; a `sleep` spaces them. */
	afterInterrupt?: FakeTurnEvent[];
	/** Hold the `turn/start` response and `turn/started` this long, so a late completion can land while Pi still waits for the new turn's id. */
	turnStartDelayMs?: number;
	approvalPolicy?: string;
	sandboxType?: string;
	models?: { id: string; displayName: string; efforts: string[]; hidden?: boolean; input?: string[] }[];
};

const scenario: FakeScenario = process.env.RBF_FAKE_SCENARIO ? (JSON.parse(process.env.RBF_FAKE_SCENARIO) as FakeScenario) : {};
const log = process.env.RBF_FAKE_LOG;
const THREAD_ID = "thread-fake-1";
let turnCounter = 0;
let forkCounter = 0;
let requestCounter = 9000;
let childCounter = 0;
/** One control block per running turn, keyed by turn id, so `turn/interrupt` and a `cancel` stop only that turn (a child's, or the root's). */
type TurnCtl = { threadId: string; turnId: string; interrupted: boolean };
const turns = new Map<string, TurnCtl>();
let repliesSeen = 0;
const replies = new Map<number, (m: Record<string, unknown>) => void>();

function send(m: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
}
function notify(method: string, params: unknown): void {
	send({ method, params });
}
/** Send a server request and wait for Pi's reply (result or error). */
function ask(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
	const id = ++requestCounter;
	return new Promise((resolve) => {
		replies.set(id, resolve);
		send({ id, method, params });
	});
}
function threadResponse(threadId = THREAD_ID, turns?: unknown[]) {
	return {
		thread: { id: threadId, cwd: process.cwd(), ephemeral: false, ...(turns ? { turns } : {}) },
		approvalPolicy: scenario.approvalPolicy ?? "on-request",
		sandbox: { type: scenario.sandboxType ?? "workspaceWrite" },
		model: "gpt-fake",
		modelProvider: "fake",
	};
}
const tick = () => new Promise((r) => setTimeout(r, 5));

/** Returns false when the answer stopped the turn (`cancel`). */
async function approve(ctl: TurnCtl, itemId: string, method: string, a: FakeApproval): Promise<boolean> {
	const params: Record<string, unknown> = { threadId: ctl.threadId, turnId: ctl.turnId, itemId, startedAtMs: Date.now() };
	if (method === "item/commandExecution/requestApproval") {
		params.command = a.command === undefined ? "/bin/zsh -lc 'echo hi'" : a.command;
		params.cwd = process.cwd();
		if (a.kind) params.kind = a.kind;
		if (a.approvalId) params.approvalId = a.approvalId;
	}
	if (a.reason) params.reason = a.reason;
	const reply = await ask(method, params);
	const decision = reply.result && typeof reply.result === "object" ? (reply.result as Record<string, unknown>).decision : undefined;
	if (decision === "cancel") {
		ctl.interrupted = true;
		return false;
	}
	return true;
}

function completeCommand(threadId: string, turnId: string, ev: { id: string; command: string; cwd?: string; exitCode?: number; aggregatedOutput?: string; output?: string[] }): void {
	notify("item/completed", { threadId, turnId, item: { id: ev.id, type: "commandExecution", command: ev.command, cwd: ev.cwd ?? process.cwd(), status: ev.exitCode ? "failed" : "completed", exitCode: ev.exitCode ?? 0, aggregatedOutput: ev.aggregatedOutput ?? (ev.output ?? []).join(""), durationMs: 12 } });
}

async function runTurn(ctl: TurnCtl, events: FakeTurnEvent[]): Promise<void> {
	const { threadId: THREAD, turnId } = ctl;
	turns.set(turnId, ctl);
	notify("turn/started", { threadId: THREAD, turn: { id: turnId, status: "inProgress", items: [] } });
	const command = (ev: { id: string; command: string; cwd?: string; exitCode?: number; aggregatedOutput?: string; output?: string[] }) => completeCommand(THREAD, turnId, ev);
	for (const ev of events) {
		if (ctl.interrupted) break;
		await tick();
		switch (ev.kind) {
			case "command": {
				const before = (ev.approvals ?? []).filter((a) => a.when === "before");
				const after = (ev.approvals ?? []).filter((a) => a.when === "after");
				for (const a of before) if (!(await approve(ctl, ev.id, "item/commandExecution/requestApproval", a))) break;
				if (ctl.interrupted) break;
				notify("item/started", { threadId: THREAD, turnId, item: { id: ev.id, type: "commandExecution", command: ev.command, cwd: ev.cwd ?? process.cwd(), status: "inProgress" } });
				for (const a of after) if (!(await approve(ctl, ev.id, "item/commandExecution/requestApproval", a))) break;
				if (ctl.interrupted) break;
				for (const piece of ev.output ?? []) {
					await tick();
					notify("item/commandExecution/outputDelta", { threadId: THREAD, turnId, itemId: ev.id, delta: piece });
				}
				if (ev.incomplete) break; // the item never completes; the test kills the child or interrupts
				await tick();
				command(ev);
				break;
			}
			case "finishCommand":
				command(ev);
				break;
			case "patch": {
				const before = (ev.approvals ?? []).filter((a) => a.when === "before");
				const after = (ev.approvals ?? []).filter((a) => a.when === "after");
				for (const a of before) if (!(await approve(ctl, ev.id, "item/fileChange/requestApproval", a))) break;
				if (ctl.interrupted) break;
				notify("item/started", { threadId: THREAD, turnId, item: { id: ev.id, type: "fileChange", changes: ev.changes, status: "inProgress" } });
				for (const a of after) if (!(await approve(ctl, ev.id, "item/fileChange/requestApproval", a))) break;
				if (ctl.interrupted) break;
				await tick();
				notify("item/completed", { threadId: THREAD, turnId, item: { id: ev.id, type: "fileChange", changes: ev.changes, status: ev.status ?? "completed" } });
				break;
			}
			case "subAgent": {
				const item = { id: `subagent-${ev.activity}-${++childCounter}`, type: "subAgentActivity", kind: ev.activity, agentThreadId: ev.agentThreadId, agentPath: ev.agentPath };
				notify("item/started", { threadId: THREAD, turnId, item });
				notify("item/completed", { threadId: THREAD, turnId, item });
				break;
			}
			case "childTurn": {
				const child: TurnCtl = { threadId: ev.threadId, turnId: ev.turnId ?? `turn-${ev.threadId}-${++childCounter}`, interrupted: false };
				const run = runTurn(child, ev.events);
				if (!ev.detached) await run;
				break;
			}
			case "sleep":
				await new Promise((r) => setTimeout(r, ev.ms));
				break;
			case "awaitReplies":
				while (repliesSeen < ev.count) await tick();
				break;
			case "collab": {
				const agentsStates = Object.fromEntries(Object.entries(ev.states ?? {}).map(([id, status]) => [id, { status, message: null }]));
				const item = { id: `collab-${++childCounter}`, type: "collabAgentToolCall", tool: ev.tool ?? "wait", status: "completed", senderThreadId: THREAD, receiverThreadIds: ev.receivers ?? [], prompt: null, model: null, reasoningEffort: null, agentsStates };
				notify("item/started", { threadId: THREAD, turnId, item: { ...item, status: "inProgress", receiverThreadIds: ev.tool === "spawnAgent" ? [] : (ev.receivers ?? []), agentsStates: {} } });
				notify("item/completed", { threadId: THREAD, turnId, item });
				break;
			}
			case "toolCall": {
				const base = { id: ev.id, type: "mcpToolCall", server: ev.server, tool: ev.tool, arguments: ev.arguments ?? {}, appContext: ev.appContext ?? null, pluginId: null, readOnlyHint: true };
				notify("item/started", { threadId: THREAD, turnId, item: { ...base, status: "inProgress", result: null, error: null, durationMs: null } });
				let status: string = ev.status ?? "completed";
				let result: unknown = ev.result ? { structuredContent: null, ...ev.result } : { content: [{ type: "text", text: "" }], structuredContent: null };
				for (const e of ev.elicitations ?? []) {
					await tick();
					const meta: Record<string, unknown> = { callId: ev.id, codex_approval_kind: e.approvalKind === undefined ? "mcp_tool_call" : e.approvalKind, connector_name: "Computer Use", persist: e.persist ?? ["session", "always"], subtitle: e.subtitle ?? "", riskLevel: "high" };
					if (meta.codex_approval_kind === null) delete meta.codex_approval_kind;
					const reply = await ask("mcpServer/elicitation/request", { threadId: THREAD, turnId, serverName: ev.server, mode: e.mode ?? "form", _meta: meta, message: e.message, requestedSchema: { type: "object", properties: e.properties ?? {} } });
					const action = reply.result && typeof reply.result === "object" ? (reply.result as Record<string, unknown>).action : undefined;
					if (action !== "accept") {
						// Codex: the call fails with its sentence in the result, `error` stays null, and the turn continues (probe 2026-09-14)
						status = "failed";
						result = { content: [{ type: "text", text: `Computer Use was not approved to use ${e.app ?? "the app"}` }], structuredContent: null };
						break;
					}
				}
				if (ev.progress) notify("item/mcpToolCall/progress", { threadId: THREAD, turnId, itemId: ev.id, message: "working", progress: 1, total: 2 });
				if (ev.incomplete) break; // the item never completes; the test kills the child or interrupts
				await tick();
				notify("item/completed", { threadId: THREAD, turnId, item: { ...base, status: ev.error ? "failed" : status, result: ev.error ? null : result, error: ev.error ? { message: ev.error } : null, durationMs: ev.durationMs ?? 12 } });
				break;
			}
			case "startupStatus":
				notify("mcpServer/startupStatus/updated", { threadId: THREAD, name: ev.name, status: ev.status, error: ev.error ?? null, failureReason: ev.failureReason ?? null });
				break;
			case "question":
				await ask("item/tool/requestUserInput", { threadId: THREAD, turnId, itemId: ev.id, isBlocking: true, questions: ev.questions });
				break;
			case "reasoning":
				notify("item/reasoning/summaryTextDelta", { threadId: THREAD, turnId, itemId: "r-1", summaryIndex: 0, delta: ev.delta });
				break;
			case "commentary":
				notify("item/started", { threadId: THREAD, turnId, item: { id: ev.id, type: "agentMessage", text: "", phase: "commentary" } });
				for (const piece of ev.text.split(" ")) notify("item/agentMessage/delta", { threadId: THREAD, turnId, itemId: ev.id, delta: `${piece} ` });
				notify("item/completed", { threadId: THREAD, turnId, item: { id: ev.id, type: "agentMessage", text: ev.text, phase: "commentary" } });
				break;
			case "answer":
				notify("item/started", { threadId: THREAD, turnId, item: { id: ev.id, type: "agentMessage", text: "", phase: ev.phase === undefined ? "final_answer" : ev.phase } });
				if (ev.streamed !== false) for (const piece of ev.text.match(/.{1,4}/g) ?? []) notify("item/agentMessage/delta", { threadId: THREAD, turnId, itemId: ev.id, delta: piece });
				notify("item/completed", { threadId: THREAD, turnId, item: { id: ev.id, type: "agentMessage", text: ev.text, phase: ev.phase === undefined ? "final_answer" : ev.phase } });
				break;
			case "authError":
				notify("error", { threadId: THREAD, turnId, error: { message: "Reconnecting... 2/5", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } }, additionalDetails: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header" }, willRetry: true });
				break;
			case "serverRequest":
				await ask(ev.method, { threadId: THREAD, turnId, itemId: "req-1", ...(ev.params ?? {}) }); // real Codex blocks the turn until the reply
				break;
			case "die":
				process.exit(3);
			case "hang":
				return; // never completes; the test interrupts or times out
			case "complete": {
				notify("turn/completed", { threadId: THREAD, turn: { id: turnId, status: ev.status ?? "completed", items: [], error: ev.errorMessage ? { message: ev.errorMessage } : null } });
				turns.delete(turnId);
				for (const late of ev.after ?? []) {
					// Events Codex would never send after the turn ended, scripted to prove Pi ignores them.
					await tick();
					if (late.kind === "subAgent") await runTurn({ ...ctl, interrupted: false }, [late]).catch(() => {});
					else if (late.kind === "command") command(late);
				}
				return;
			}
		}
	}
	if (ctl.interrupted) {
		notify("turn/completed", { threadId: THREAD, turn: { id: turnId, status: "interrupted", items: [] } });
		turns.delete(turnId);
		void lateEvents(THREAD, turnId);
	}
}

/** After an interrupted turn ended (by `turn/interrupt` or a `cancel` answer): a `finishCommand` here is Codex reporting a command that ran on. */
async function lateEvents(threadId: string, turnId: string): Promise<void> {
	for (const late of scenario.afterInterrupt ?? []) {
		await new Promise((r) => setTimeout(r, 40));
		if (late.kind === "finishCommand") completeCommand(threadId, turnId, late);
		else if (late.kind === "sleep") await new Promise((r) => setTimeout(r, late.ms));
	}
}

createInterface({ input: process.stdin }).on("line", (line) => {
	if (log) appendFileSync(log, `${line}\n`);
	let m: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
	try {
		m = JSON.parse(line);
	} catch {
		return;
	}
	if (m.id !== undefined && !m.method) {
		// Pi's reply to one of our server requests
		const waiter = replies.get(Number(m.id));
		if (waiter) {
			replies.delete(Number(m.id));
			repliesSeen += 1;
			waiter(m as Record<string, unknown>);
		}
		return;
	}
	switch (m.method) {
		case "initialize":
			if (scenario.initializeError) send({ id: m.id, error: { code: -32000, message: scenario.initializeError } });
			else send({ id: m.id, result: { userAgent: "fake" } });
			break;
		case "initialized":
			break;
		case "model/list": {
			const models = scenario.models ?? [
				{ id: "gpt-fake-1", displayName: "GPT Fake 1", efforts: ["low", "medium", "high"] },
				{ id: "gpt-fake-2", displayName: "GPT Fake 2", efforts: ["medium", "high", "xhigh", "max", "ultra"], input: ["text", "image"] },
				{ id: "gpt-hidden", displayName: "Hidden", efforts: ["low"], hidden: true },
			];
			send({
				id: m.id,
				result: {
					data: models.map((x) => ({ id: x.id, model: x.id, displayName: x.displayName, hidden: x.hidden ?? false, isDefault: false, defaultReasoningEffort: x.efforts[0], supportedReasoningEfforts: x.efforts.map((e) => ({ reasoningEffort: e, description: e })), inputModalities: x.input ?? ["text"] })),
					nextCursor: null,
				},
			});
			break;
		}
		case "thread/start":
			send({ id: m.id, result: threadResponse() });
			break;
		case "thread/resume":
			send({ id: m.id, result: threadResponse(String(m.params?.threadId ?? THREAD_ID), m.params?.excludeTurns ? undefined : (scenario.resumeTurns ?? [])) });
			break;
		case "thread/fork":
			if (scenario.forkError) send({ id: m.id, error: { code: -32000, message: scenario.forkError } });
			else send({ id: m.id, result: threadResponse(`thread-fake-fork-${++forkCounter}`) });
			break;
		case "turn/start": {
			const model = m.params?.model;
			if (scenario.retiredModel && model === scenario.retiredModel) {
				send({ id: m.id, error: { code: -32000, message: `model ${scenario.retiredModel} is not available` } });
				break;
			}
			turnCounter += 1;
			const turnId = `turn-fake-${turnCounter}`;
			const events = (turnCounter > 1 && scenario.laterTurns) || scenario.turn || [{ kind: "answer", id: "msg-1", text: "FAKE_OK", phase: "final_answer" }, { kind: "complete" }];
			const begin = () => {
				send({ id: m.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
				void runTurn({ threadId: String(m.params?.threadId ?? THREAD_ID), turnId, interrupted: false }, events as FakeTurnEvent[]);
			};
			if (scenario.turnStartDelayMs) setTimeout(begin, scenario.turnStartDelayMs);
			else begin();
			break;
		}
		case "turn/steer":
			if (scenario.steerError) send({ id: m.id, error: { code: -32000, message: scenario.steerError } });
			else send({ id: m.id, result: { turnId: m.params?.expectedTurnId } });
			break;
		case "turn/interrupt": {
			if (m.id !== undefined) send({ id: m.id, result: {} }); // a request in the real schema; Codex answers it
			if (scenario.ignoreInterrupt) break; // the "no completion within 3 s" path
			// Only the named turn ends, as on real Codex (probe 2026-09-14: the parent's interrupt never reaches a child's turn); a running command is not killed.
			const ctl = turns.get(String(m.params?.turnId));
			if (ctl) ctl.interrupted = true;
			turns.delete(String(m.params?.turnId));
			const threadId = ctl?.threadId ?? String(m.params?.threadId ?? THREAD_ID);
			notify("turn/completed", { threadId, turn: { id: m.params?.turnId, status: "interrupted", items: [] } });
			void lateEvents(threadId, String(m.params?.turnId));
			break;
		}
		default:
			if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `fake does not implement ${m.method}` } });
	}
});

process.stdin.on("end", () => process.exit(0));
