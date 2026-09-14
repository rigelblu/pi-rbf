// Scripted `codex app-server` stand-in for rbf-codex tests: JSON-RPC lines over stdio.
// The scenario comes from RBF_FAKE_SCENARIO (JSON); every inbound message is appended
// to RBF_FAKE_LOG so a test can assert exactly what Pi sent.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

export type FakeTurnEvent =
	| { kind: "command"; id: string; command: string; exitCode?: number }
	| { kind: "reasoning"; delta: string }
	| { kind: "commentary"; id: string; text: string }
	| { kind: "answer"; id: string; text: string; phase?: "final_answer" | null; streamed?: boolean }
	| { kind: "serverRequest"; method: string }
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
	/** Swallow `turn/interrupt` so no completion ever arrives. */
	ignoreInterrupt?: boolean;
	approvalPolicy?: string;
	sandboxType?: string;
	models?: { id: string; displayName: string; efforts: string[]; hidden?: boolean; input?: string[] }[];
};

const scenario: FakeScenario = process.env.RBF_FAKE_SCENARIO ? (JSON.parse(process.env.RBF_FAKE_SCENARIO) as FakeScenario) : {};
const log = process.env.RBF_FAKE_LOG;
const THREAD_ID = "thread-fake-1";
let turnCounter = 0;
let interrupted = false;

function send(m: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
}
function notify(method: string, params: unknown): void {
	send({ method, params });
}
function threadResponse() {
	return {
		thread: { id: THREAD_ID, cwd: process.cwd(), ephemeral: false },
		approvalPolicy: scenario.approvalPolicy ?? "on-request",
		sandbox: { type: scenario.sandboxType ?? "workspaceWrite" },
		model: "gpt-fake",
		modelProvider: "fake",
	};
}

async function runTurn(turnId: string): Promise<void> {
	const events = scenario.turn ?? [{ kind: "answer", id: "msg-1", text: "FAKE_OK", phase: "final_answer" }, { kind: "complete" }];
	notify("turn/started", { threadId: THREAD_ID, turn: { id: turnId, status: "inProgress", items: [] } });
	for (const ev of events) {
		if (interrupted) break;
		await new Promise((r) => setTimeout(r, 5));
		switch (ev.kind) {
			case "command":
				notify("item/started", { threadId: THREAD_ID, turnId, item: { id: ev.id, type: "commandExecution", command: ev.command, status: "inProgress" } });
				notify("item/completed", { threadId: THREAD_ID, turnId, item: { id: ev.id, type: "commandExecution", command: ev.command, status: ev.exitCode ? "failed" : "completed", exitCode: ev.exitCode ?? 0 } });
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
				send({ id: 9000 + turnCounter, method: ev.method, params: { threadId: THREAD_ID, turnId, itemId: "req-1" } });
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
	let m: { id?: number | string; method?: string; params?: Record<string, unknown>; error?: unknown };
	try {
		m = JSON.parse(line);
	} catch {
		return;
	}
	if (m.id !== undefined && !m.method) return; // Pi's reply to one of our server requests
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
		case "thread/resume":
			send({ id: m.id, result: threadResponse() });
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
			void runTurn(turnId);
			break;
		}
		case "turn/interrupt":
			if (scenario.ignoreInterrupt) break; // the "no completion within 3 s" path
			interrupted = true;
			notify("turn/completed", { threadId: THREAD_ID, turn: { id: m.params?.turnId, status: "interrupted", items: [] } });
			break;
		default:
			if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `fake does not implement ${m.method}` } });
	}
});

process.stdin.on("end", () => process.exit(0));
