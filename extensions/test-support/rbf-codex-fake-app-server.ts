// Scripted `codex app-server` stand-in for rbf-codex tests: JSON-RPC lines over stdio.
// The scenario comes from RBF_FAKE_SCENARIO (JSON); every inbound message is appended
// to RBF_FAKE_LOG so a test can assert exactly what Pi sent.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

export type FakeApproval = { when: "before" | "after"; command?: string | null; reason?: string; kind?: string; approvalId?: string };
export type FakeTurnEvent =
	| { kind: "command"; id: string; command: string; cwd?: string; exitCode?: number; output?: string[]; approvals?: FakeApproval[]; aggregatedOutput?: string; incomplete?: boolean }
	| { kind: "patch"; id: string; changes: { path: string; kind: { type: string; move_path?: string | null }; diff: string }[]; approvals?: FakeApproval[]; status?: string }
	| { kind: "question"; id: string; questions: unknown[] }
	| { kind: "reasoning"; delta: string }
	| { kind: "commentary"; id: string; text: string }
	| { kind: "answer"; id: string; text: string; phase?: "final_answer" | null; streamed?: boolean }
	| { kind: "serverRequest"; method: string; params?: Record<string, unknown> }
	| { kind: "authError" }
	| { kind: "die" }
	| { kind: "hang" }
	| { kind: "complete"; status?: "completed" | "interrupted" | "failed"; errorMessage?: string };

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
let interrupted = false;
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
async function approve(turnId: string, itemId: string, method: string, a: FakeApproval): Promise<boolean> {
	const params: Record<string, unknown> = { threadId: THREAD_ID, turnId, itemId, startedAtMs: Date.now() };
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
		interrupted = true;
		return false;
	}
	return true;
}

async function runTurn(turnId: string, events: FakeTurnEvent[]): Promise<void> {
	notify("turn/started", { threadId: THREAD_ID, turn: { id: turnId, status: "inProgress", items: [] } });
	for (const ev of events) {
		if (interrupted) break;
		await tick();
		switch (ev.kind) {
			case "command": {
				const before = (ev.approvals ?? []).filter((a) => a.when === "before");
				const after = (ev.approvals ?? []).filter((a) => a.when === "after");
				for (const a of before) if (!(await approve(turnId, ev.id, "item/commandExecution/requestApproval", a))) break;
				if (interrupted) break;
				notify("item/started", { threadId: THREAD_ID, turnId, item: { id: ev.id, type: "commandExecution", command: ev.command, cwd: ev.cwd ?? process.cwd(), status: "inProgress" } });
				for (const a of after) if (!(await approve(turnId, ev.id, "item/commandExecution/requestApproval", a))) break;
				if (interrupted) break;
				for (const piece of ev.output ?? []) {
					await tick();
					notify("item/commandExecution/outputDelta", { threadId: THREAD_ID, turnId, itemId: ev.id, delta: piece });
				}
				if (ev.incomplete) break; // the item never completes; the test kills the child or interrupts
				await tick();
				notify("item/completed", { threadId: THREAD_ID, turnId, item: { id: ev.id, type: "commandExecution", command: ev.command, cwd: ev.cwd ?? process.cwd(), status: ev.exitCode ? "failed" : "completed", exitCode: ev.exitCode ?? 0, aggregatedOutput: ev.aggregatedOutput ?? (ev.output ?? []).join(""), durationMs: 12 } });
				break;
			}
			case "patch": {
				const before = (ev.approvals ?? []).filter((a) => a.when === "before");
				const after = (ev.approvals ?? []).filter((a) => a.when === "after");
				for (const a of before) if (!(await approve(turnId, ev.id, "item/fileChange/requestApproval", a))) break;
				if (interrupted) break;
				notify("item/started", { threadId: THREAD_ID, turnId, item: { id: ev.id, type: "fileChange", changes: ev.changes, status: "inProgress" } });
				for (const a of after) if (!(await approve(turnId, ev.id, "item/fileChange/requestApproval", a))) break;
				if (interrupted) break;
				await tick();
				notify("item/completed", { threadId: THREAD_ID, turnId, item: { id: ev.id, type: "fileChange", changes: ev.changes, status: ev.status ?? "completed" } });
				break;
			}
			case "question":
				await ask("item/tool/requestUserInput", { threadId: THREAD_ID, turnId, itemId: ev.id, isBlocking: true, questions: ev.questions });
				break;
			case "reasoning":
				notify("item/reasoning/summaryTextDelta", { threadId: THREAD_ID, turnId, itemId: "r-1", summaryIndex: 0, delta: ev.delta });
				break;
			case "commentary":
				notify("item/started", { threadId: THREAD_ID, turnId, item: { id: ev.id, type: "agentMessage", text: "", phase: "commentary" } });
				for (const piece of ev.text.split(" ")) notify("item/agentMessage/delta", { threadId: THREAD_ID, turnId, itemId: ev.id, delta: `${piece} ` });
				notify("item/completed", { threadId: THREAD_ID, turnId, item: { id: ev.id, type: "agentMessage", text: ev.text, phase: "commentary" } });
				break;
			case "answer":
				notify("item/started", { threadId: THREAD_ID, turnId, item: { id: ev.id, type: "agentMessage", text: "", phase: ev.phase === undefined ? "final_answer" : ev.phase } });
				if (ev.streamed !== false) for (const piece of ev.text.match(/.{1,4}/g) ?? []) notify("item/agentMessage/delta", { threadId: THREAD_ID, turnId, itemId: ev.id, delta: piece });
				notify("item/completed", { threadId: THREAD_ID, turnId, item: { id: ev.id, type: "agentMessage", text: ev.text, phase: ev.phase === undefined ? "final_answer" : ev.phase } });
				break;
			case "authError":
				notify("error", { threadId: THREAD_ID, turnId, error: { message: "Reconnecting... 2/5", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } }, additionalDetails: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header" }, willRetry: true });
				break;
			case "serverRequest":
				await ask(ev.method, { threadId: THREAD_ID, turnId, itemId: "req-1", ...(ev.params ?? {}) }); // real Codex blocks the turn until the reply
				break;
			case "die":
				process.exit(3);
			case "hang":
				return; // never completes; the test interrupts or times out
			case "complete":
				notify("turn/completed", { threadId: THREAD_ID, turn: { id: turnId, status: ev.status ?? "completed", items: [], error: ev.errorMessage ? { message: ev.errorMessage } : null } });
				return;
		}
	}
	if (interrupted) notify("turn/completed", { threadId: THREAD_ID, turn: { id: turnId, status: "interrupted", items: [] } });
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
			interrupted = false;
			send({ id: m.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
			const events = (turnCounter > 1 && scenario.laterTurns) || scenario.turn || [{ kind: "answer", id: "msg-1", text: "FAKE_OK", phase: "final_answer" }, { kind: "complete" }];
			void runTurn(turnId, events as FakeTurnEvent[]);
			break;
		}
		case "turn/steer":
			if (scenario.steerError) send({ id: m.id, error: { code: -32000, message: scenario.steerError } });
			else send({ id: m.id, result: { turnId: m.params?.expectedTurnId } });
			break;
		case "turn/interrupt":
			if (m.id !== undefined) send({ id: m.id, result: {} }); // a request in the real schema; Codex answers it
			if (scenario.ignoreInterrupt) break; // the "no completion within 3 s" path
			interrupted = true;
			notify("turn/completed", { threadId: THREAD_ID, turn: { id: m.params?.turnId, status: "interrupted", items: [] } });
			break;
		default:
			if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `fake does not implement ${m.method}` } });
	}
});

process.stdin.on("end", () => process.exit(0));
