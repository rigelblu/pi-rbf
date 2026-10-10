import { describe, expect, it } from "vitest";
import { historyCounts } from "./test-support/rbf-codex-interruption-inspect.ts";

const nonce = "SYNTHETIC_NONCE";
const user = (text: string) => ({ type: "userMessage", content: [{ type: "text", text }] });
const reply = (text: string) => ({ type: "agentMessage", text });
const command = (text: string, id = "sleep-1") => ({ type: "commandExecution", id, command: text });
const first = (text = "/bin/zsh -lc '/bin/sleep 8'") => ({ status: "interrupted", items: [user(`Remember ${nonce}`), command(text)] });
const recalled = (text = nonce) => ({ status: "completed", items: [user("Recall it"), reply(text)] });

describe("native interruption inspector evidence", () => {
	it.each(["/bin/sleep 8", "/bin/zsh -lc '/bin/sleep 8'", '/bin/zsh -lc "/bin/sleep 8"'])("counts the native command %s", (text) => {
		expect(historyCounts([first(text), recalled()], 1, nonce)).toEqual({ same_thread: true, bindings: 1, user_turns: 2, interrupted: 1, completed: 1, nonce_inputs: 1, nonce_recall: true, sleep_commands: 1 });
	});

	it("does not count a different duration or claim recall without a completed turn", () => {
		expect(historyCounts([first("/bin/sleep 80")], 1, nonce)).toMatchObject({ sleep_commands: 0, nonce_recall: false });
	});

	it("counts repeated native commands instead of hiding a replay", () => {
		const repeat = { status: "completed", items: [user("Recall it"), command("/bin/sleep 8", "sleep-2"), reply(nonce)] };
		expect(historyCounts([first(), repeat], 1, nonce).sleep_commands).toBe(2);
	});

	it("requires every completed recall to be exact", () => {
		expect(historyCounts([first(), recalled(), recalled("wrong")], 1, nonce).nonce_recall).toBe(false);
		expect(historyCounts([first(), recalled(`The nonce is ${nonce}`)], 1, nonce).nonce_recall).toBe(false);
	});

	it("counts a saved started row missing from native history, without duplicating it later", () => {
		const recorded = [{ id: "sleep-1", command: "/bin/zsh -lc '/bin/sleep 8'" }];
		const cut = { status: "interrupted", items: [user(`Remember ${nonce}`)] };
		expect(historyCounts([cut, recalled()], 1, nonce, recorded).sleep_commands).toBe(1);
		expect(historyCounts([first(), recalled()], 1, nonce, recorded).sleep_commands).toBe(1);
		expect(historyCounts([first(), recalled()], 1, nonce, [...recorded, { id: "sleep-2", command: "/bin/sleep 8" }]).sleep_commands).toBe(2);
		expect(() => historyCounts([{ status: "interrupted", items: [{ type: "commandExecution", command: "/bin/sleep 8" }] }], 1, nonce)).toThrow("Command item id required");
	});

	it("excludes internal compaction turns from user counts", () => {
		expect(historyCounts([first(), { status: "completed", items: [{ type: "contextCompaction" }] }, recalled()], 1, nonce)).toMatchObject({ user_turns: 2, interrupted: 1, completed: 1, nonce_recall: true });
	});
});
