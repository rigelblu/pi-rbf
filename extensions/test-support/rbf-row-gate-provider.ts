// Scripted provider for the row gate: makes a real interactive Pi run its own `bash` and `edit`
// tools with no model behind them, so their rows can be captured as the reference the Codex rows
// are compared against. RBF_ROW_GATE_SCRIPT is a JSON array of steps; each `streamSimple` call
// is picked by how many tool results the conversation already holds (Pi calls the provider again
// after every tool result), so one prompt walks the whole script and an extra call replays its
// step instead of skipping one. A tool step streams one tool call and ends with `toolUse`; a text
// step streams the text and ends the turn. Past the end of the script the turn ends with a fixed sentinel.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Model, ToolCall } from "@earendil-works/pi-ai";

export const GATE_PROVIDER_ID = "rbf-gate";
export const GATE_MODEL_ID = "gate";
export const GATE_END = "GATE_END";

type Step = { tool: string; args: Record<string, unknown> } | { text: string };

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const ZERO_USAGE = { ...ZERO_COST, totalTokens: 0, cost: { ...ZERO_COST, total: 0 } };

export default function rbfRowGateProvider(pi: ExtensionAPI): void {
	const script: Step[] = JSON.parse(process.env.RBF_ROW_GATE_SCRIPT ?? "[]");

	pi.registerProvider(GATE_PROVIDER_ID, {
		api: "rbf-row-gate",
		baseUrl: "script://rbf-row-gate",
		apiKey: "rbf-row-gate", // non-secret sentinel; Pi needs one to mark the provider configured
		models: [{ id: GATE_MODEL_ID, name: GATE_MODEL_ID, reasoning: false, input: ["text"], cost: ZERO_COST, contextWindow: 1_000_000, maxTokens: 4096 }],
		streamSimple(model: Model<any>, context: Context) {
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: ZERO_USAGE, stopReason: "stop", timestamp: Date.now() };
			const snap = () => ({ ...message, content: message.content.map((b) => ({ ...b })) });
			const done = context.messages.filter((m) => m.role === "toolResult").length;
			const step = script[done] ?? { text: GATE_END };

			queueMicrotask(() => {
				stream.push({ type: "start", partial: snap() });
				if ("tool" in step) {
					const toolCall: ToolCall = { type: "toolCall", id: `gate-${done + 1}`, name: step.tool, arguments: step.args };
					message.content.push(toolCall);
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: snap() });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: snap() });
					message.stopReason = "toolUse";
					stream.push({ type: "done", reason: "toolUse", message: snap() });
				} else {
					message.content.push({ type: "text", text: step.text });
					stream.push({ type: "text_start", contentIndex: 0, partial: snap() });
					stream.push({ type: "text_delta", contentIndex: 0, delta: step.text, partial: snap() });
					stream.push({ type: "text_end", contentIndex: 0, content: step.text, partial: snap() });
					stream.push({ type: "done", reason: "stop", message: snap() });
				}
				stream.end(snap());
			});
			return stream;
		},
	});
}
