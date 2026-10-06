import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const MONITOR_TOOL_NAME = "monitor";
export const TASK_STOP_TOOL_NAME = "task_stop";
export const MONITORS_COMMAND_NAME = "monitors";
export const SESSION_CUSTOM_TYPE = "rbf-monitor";

export default function rbfMonitor(pi: ExtensionAPI): void {
	// Register tool `monitor`
	if (typeof pi.registerTool === "function") {
		pi.registerTool({
			name: MONITOR_TOOL_NAME,
			label: "Monitor",
			description:
				"Pi's Monitor: run a shell command in the background and receive its stdout line by line. Each line arrives as an event message.",
			parameters: Type.Object({
				command: Type.Optional(Type.String()),
				description: Type.Optional(Type.String()),
				timeout_ms: Type.Optional(Type.Number()),
				ws: Type.Optional(Type.Any()),
			}),
			execute: async (_toolCallId, args) => {
				return { content: [{ type: "text", text: `stub monitor ${args.description ?? ""}` }], details: {} };
			},
		});
	}

	// Register tool `task_stop`
	if (typeof pi.registerTool === "function") {
		pi.registerTool({
			name: TASK_STOP_TOOL_NAME,
			label: "TaskStop",
			description: "Pi's TaskStop: stop a running monitor watch by its task id.",
			parameters: Type.Object({
				task_id: Type.String(),
			}),
			execute: async (_toolCallId, args) => {
				return { content: [{ type: "text", text: `stub task_stop ${args.task_id}` }], details: {} };
			},
		});
	}

	// Register command `/monitors`
	if (typeof pi.registerCommand === "function") {
		pi.registerCommand(MONITORS_COMMAND_NAME, {
			description: "List and stop watches",
			handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
				ctx.ui?.notify?.(`stub monitors ${args}`, "info");
			},
		});
	}

	// Register message renderer
	if (typeof pi.registerMessageRenderer === "function") {
		pi.registerMessageRenderer(SESSION_CUSTOM_TYPE, (_message, _options) => {
			return undefined as any;
		});
	}

	// Register event handlers
	pi.on?.("session_start", () => {});
	pi.on?.("session_shutdown", () => {});
	pi.on?.("message_end", () => {});
	pi.on?.("input", () => {});
	pi.on?.("before_agent_start", () => {});
	pi.on?.("agent_start", () => {});
	pi.on?.("agent_end", () => {});
	pi.on?.("session_before_compact", () => {});
	pi.on?.("session_compact", () => {});
	pi.on?.("session_compact_failed", () => {});

	// Register busy listener
	pi.events?.on?.("rbf-background-tasks:busy/v1", () => {});
}
