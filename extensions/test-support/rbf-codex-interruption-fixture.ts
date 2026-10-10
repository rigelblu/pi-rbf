// Synthetic version-3 Pi tree. No user transcript or command payloads are copied.
import { writeFileSync } from "node:fs";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const timestamp = "2026-10-04T00:00:00.000Z";
const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({ role: "assistant", content, stopReason, api: "rbf-codex-app-server", provider: "codex-harness", model: "codex", usage, timestamp: Date.parse(timestamp), ...(stopReason === "aborted" ? { errorMessage: "Request was aborted" } : {}) });
const call = (id: string) => ({ type: "toolCall" as const, id, name: "codex_command", arguments: { itemId: id, command: "echo SYNTHETIC", cwd: "", threadId: "", agentPath: "" } });

export function writeInterruptionFixture(path: string, cwd: string): void {
	const base = (id: string, parentId: string | null) => ({ id, parentId, timestamp });
	const result = (id: string) => ({ role: "toolResult" as const, toolCallId: id, toolName: "codex_command", content: [{ type: "text" as const, text: "SYNTHETIC" }], isError: false, timestamp: Date.parse(timestamp) });
	const entries: FileEntry[] = [
		{ type: "session", version: 3, id: "fixture-session", timestamp, cwd },
		{ ...base("00000001", null), type: "custom", customType: "rbf-codex-thread/v1", data: { threadId: "fixture-thread", sessionId: "fixture-session", cwd } },
		{ ...base("00000002", "00000001"), type: "message", message: assistant([call("old-row")], "toolUse") },
		{ ...base("00000003", "00000002"), type: "message", message: result("old-row") },
		{ ...base("00000004", "00000003"), type: "message", message: { role: "user", content: "STOPPED", timestamp: Date.parse(timestamp) } },
		{ ...base("00000005", "00000004"), type: "message", message: assistant([call("stopped-row")], "toolUse") },
		{ ...base("00000006", "00000005"), type: "message", message: result("stopped-row") },
		{ ...base("00000007", "00000006"), type: "custom", customType: "rbf-codex-turn/v1", data: { threadId: "fixture-thread", turnId: "interrupted-1", status: "interrupted" } },
		{ ...base("00000008", "00000007"), type: "message", message: assistant([], "aborted") },
	];
	writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
