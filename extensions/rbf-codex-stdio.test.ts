import { once } from "node:events";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AppServerClient, verifyBranchHistory } from "./rbf-codex.ts";

const fixture = resolve(import.meta.dirname, "test-support/rbf-codex-jsonl-fixture.ts");
const text = "line\u2028paragraph\u2029emoji🪐\r\nnext";

describe("Codex stdio JSONL framing", () => {
	it("preserves Unicode separators in history and verifies the completed checkpoint", async () => {
		const client = await AppServerClient.start(process.cwd(), { bin: process.execPath, args: [fixture] });
		try {
			const response = await client.request("thread/turns/list", {}, 2_000);
			expect(response).toMatchObject({ data: [{ id: "checkpoint", items: [{ content: [{ text }] }] }] });
			expect(await verifyBranchHistory(client, "thread", "checkpoint")).toEqual({ ok: true });
		} finally { await client.close(); }
	});

	it("decodes fragmented UTF-8, coalesced CRLF frames, and the final frame at EOF", async () => {
		const client = await AppServerClient.start(process.cwd(), { bin: process.execPath, args: [fixture, "--chunked"] });
		const notifications: unknown[] = [];
		client.subscribe((message) => { if (message.method) notifications.push(message); });
		const exited = once(client.child, "close");
		try {
			expect(await client.request("fixture/fragmented", {}, 2_000)).toEqual({ text });
			await exited;
			expect(notifications).toEqual([
				{ method: "fixture/notice", params: { text } },
				{ method: "fixture/eof", params: { text } },
			]);
		} finally { await client.close(); }
	});
});
