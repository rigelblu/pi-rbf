// Observer for the `/cd` verification harness (`rbf-cd-verify.sh`). Loaded into a real interactive
// Pi with `-e`. It records what a turn really sees, so a scenario is judged on the session ID,
// session file, directory, process directory and system prompt Pi used, not on what `/cd` said.
// Every record is one JSON line appended to RBF_CD_OBSERVE_LOG.
//
// It also holds the harness's test hooks, each off unless RBF_CD_TEST_HOOK names it:
//   cancel  a `session_before_switch` handler cancels the switch
//   fail    a `session_before_switch` handler makes the new file unreadable, so Pi's own open throws
//   vanish  a `session_before_switch` handler removes RBF_CD_VANISH_DIR, the destination
// and three commands that stand in for Pi's pickers, which are slow to drive through a terminal:
//   /rbf-cd-state <label>            record the session's state without starting a turn
//   /rbf-cd-set <provider/model> <thinking level>
//   /rbf-cd-select <user:N | text:S> select an entry with `navigateTree`, the call `/tree` makes
import { appendFileSync, chmodSync, rmSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import rbfRowGateProvider from "./rbf-row-gate-provider.ts";

/** The scripted provider again, with a model that takes a thinking level, so a run can pick a non-default model. */
export const THINK_PROVIDER_ID = "rbf-cd-gate";
export const THINK_MODEL_ID = "think";

const SEQUENCE = Symbol.for("rbf.cd.observer.sequence");

export default function rbfCdObserver(pi: ExtensionAPI): void {
	const shared = globalThis as { [SEQUENCE]?: number };
	const hook = process.env.RBF_CD_TEST_HOOK;

	const record = (kind: string, data: object): void => {
		if (!process.env.RBF_CD_OBSERVE_LOG) return;
		shared[SEQUENCE] = (shared[SEQUENCE] ?? 0) + 1;
		appendFileSync(process.env.RBF_CD_OBSERVE_LOG, `${JSON.stringify({ kind, seq: shared[SEQUENCE], label: process.env.RBF_CD_LABEL, ...data })}\n`);
	};

	const stateOf = (ctx: ExtensionContext) => {
		const manager = ctx.sessionManager;
		return {
			sessionId: manager.getSessionId(),
			sessionFile: manager.getSessionFile(),
			ctxCwd: ctx.cwd,
			managerCwd: manager.getCwd(),
			processCwd: process.cwd(),
			leaf: manager.getLeafId(),
			entries: manager.getEntries().length,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			thinkingLevel: pi.getThinkingLevel(),
			sessionName: pi.getSessionName(),
		};
	};
	const safely = (kind: string, run: () => object): void => {
		try {
			record(kind, run());
		} catch (error) {
			record(kind, { error: String(error) });
		}
	};

	rbfRowGateProvider({
		registerProvider: (_name: string, config: any) =>
			pi.registerProvider(THINK_PROVIDER_ID, { ...config, models: [{ ...config.models[0], id: THINK_MODEL_ID, name: THINK_MODEL_ID, reasoning: true }] }),
	} as unknown as ExtensionAPI);

	pi.on("session_start", async (event, ctx) => safely("session_start", () => ({ reason: event.reason, ...stateOf(ctx) })));
	pi.on("before_agent_start", async (event, ctx) => safely("turn", () => ({ prompt: event.prompt, systemPrompt: event.systemPrompt, ...stateOf(ctx) })));
	pi.on("tool_execution_start", async (event) => record("tool_start", { tool: event.toolName }));

	// ─── Test hooks ──────────────────────────────────────────────────────────

	pi.on("session_before_switch", async (event) => {
		record("before_switch", { hook, target: event.targetSessionFile });
		if (hook === "cancel") return { cancel: true };
		if (hook === "fail" && event.targetSessionFile) chmodSync(event.targetSessionFile, 0o000);
		if (hook === "vanish" && process.env.RBF_CD_VANISH_DIR) rmSync(process.env.RBF_CD_VANISH_DIR, { recursive: true, force: true });
		return undefined;
	});

	// ─── Commands ────────────────────────────────────────────────────────────

	pi.registerCommand("rbf-cd-state", {
		description: "Test support: record this session's state",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			safely("state", () => ({ name: args.trim(), ...stateOf(ctx) }));
		},
	});

	pi.registerCommand("rbf-cd-set", {
		description: "Test support: pick a model and thinking level",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const [modelRef, level] = args.trim().split(/\s+/);
			const [provider, id] = modelRef.split("/");
			const model = ctx.modelRegistry.find(provider, id);
			const selected = model ? await pi.setModel(model) : false;
			if (level) pi.setThinkingLevel(level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
			record("set", { selected, model: modelRef, thinkingLevel: pi.getThinkingLevel() });
		},
	});

	pi.registerCommand("rbf-cd-select", {
		description: "Test support: select an entry in the session tree",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const [kind, value] = args.trim().split(/:(.*)/s);
			const messages = ctx.sessionManager.getEntries().filter((entry) => entry.type === "message");
			const target =
				kind === "user"
					? messages.filter((entry) => entry.message.role === "user")[Number(value) - 1]
					: messages.find((entry) => entry.message.role === "assistant" && JSON.stringify(entry.message.content).includes(value));
			if (!target) {
				record("select", { args, error: "no such entry" });
				return;
			}
			try {
				const result = await ctx.navigateTree(target.id, { summarize: false });
				record("select", { args, target: target.id, parent: target.parentId, cancelled: result.cancelled, leaf: ctx.sessionManager.getLeafId() });
			} catch (error) {
				record("select", { args, target: target.id, error: String(error) });
			}
		},
	});
}
