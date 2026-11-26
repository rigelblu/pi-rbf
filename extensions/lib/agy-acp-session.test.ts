// Offline: the only executable ever started is a shim around test-support/agy-acp-fake.cjs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ACP_COPY, ACP_DEFINITE_STOP_REASONS, AcpCancelTimeoutError, AcpConfigError, AcpOwner, AcpStartError, isAcpSignInError, type AcpOwnerRequestHandlers, type AcpToolUpdate } from "./agy-acp-session.js";
import { AcpLostError, AcpOversizeRequestError, AcpReply, AcpRpcError } from "./agy-acp.js";
import { cliLaunches } from "../test-support/agy-launch-check.js";

const base = process.env.PI214_TEST_ROOT;
if (!base) throw new Error("Resolve PI214_TEST_ROOT with eng-use-external-tmp before tests");
mkdirSync(base, { recursive: true });
const FAKE = resolve(import.meta.dirname, "../test-support/agy-acp-fake.cjs");
const owners: AcpOwner[] = [];
const logs: string[] = [];
// A21.3-6: across every case of this file, no start of the fake `agy` carries `--print` or is anything but `acp` or `models`.
afterEach(async () => {
	for (const o of owners.splice(0)) await o.close();
	const cli = logs.splice(0).flatMap(file => cliLaunches(existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : []));
	expect(cli, "a start of the fake agy that only the CLI route made").toEqual([]);
});

/** A throwaway folder, an executable shim that runs the fake with `mode`, and readers for what the fake logged. */
function fake(mode = "") {
	const root = mkdtempSync(join(base!, "acp-")), log = join(root, "fake.jsonl"), release = join(root, "release"), exe = join(root, "agy-fake");
	writeFileSync(exe, `#!${process.execPath}\nrequire(${JSON.stringify(FAKE)})(${JSON.stringify({ log, mode, release })});\n`);
	chmodSync(exe, 0o700);
	logs.push(log);
	const rows = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
	const received = (method: string) => rows().filter(r => r.in?.method === method).map(r => r.in);
	const open = async (args: string[] = [], requests?: AcpOwnerRequestHandlers) => { const o = await AcpOwner.open({ executable: exe, cwd: root, args, requests }); owners.push(o); return o; };
	return { root, exe, log, release, rows, received, open };
}
/** The fake logs when its after-the-turn update has been sent; a short pause lets the client read it. */
const lateEchoSent = async (f: { rows(): any[] }) => { await vi.waitFor(() => expect(f.rows().some(r => r.lateEchoSent)).toBe(true), { timeout: 5000 }); await new Promise(r => setTimeout(r, 30)); };
const collect = () => { const text: string[] = [], thought: string[] = [], tools: AcpToolUpdate[] = []; return { text, thought, tools, handlers: { text: (t: string) => text.push(t), thought: (t: string) => thought.push(t), tool: (u: AcpToolUpdate) => tools.push(u) } }; };

describe("pi-21.3 ACP owner: opening", () => {
	it("starts `<exe> acp` in the folder with PWD set, sends the exact client capabilities, then session/new", async () => {
		const f = fake();
		const owner = await f.open(["--sandbox"]);
		const [launch] = f.rows();
		expect(launch.args).toEqual(["acp", "--sandbox"]);
		expect(launch.cwd).toBe(launch.pwd);
		expect(f.rows().filter(r => r.in).map(r => r.in.method)).toEqual(["initialize", "session/new"]);
		expect(f.received("initialize")[0].params).toEqual({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } }, clientInfo: { name: "pi-rbf-agy", version: "1" } });
		expect(f.received("session/new")[0].params).toEqual({ cwd: f.root, mcpServers: [] });
		expect(owner.acpSessionId).toMatch(/^fake-acp-/);
		expect(owner.state).toBe("idle");
	});

	it.each([
		["a session/new error", "new-fails"],
		["no resume capability", "no-resume"],
		["another protocol version", "old-protocol"],
	])("refuses to open on %s and retires the child it started", async (_name, mode) => {
		const f = fake(mode);
		await expect(f.open()).rejects.toBeInstanceOf(AcpStartError);
		await new Promise(r => setTimeout(r, 100));
		expect(f.rows().some(r => r.eof)).toBe(true);
	});

	it("refuses to open when the executable cannot start", async () => {
		await expect(AcpOwner.open({ executable: "/nonexistent/agy-for-test", cwd: base!, args: [] })).rejects.toBeInstanceOf(AcpStartError);
	});
});

describe("pi-21.3 ACP owner: configuring", () => {
	it("sets model, then thinking level, and trusts the replies", async () => {
		const f = fake(), owner = await f.open();
		expect(await owner.configure({ model: "gemini-3.8-flash", thought: "low" })).toEqual({ model: "gemini-3.8-flash", effort: "low" });
		expect(f.received("session/set_config_option").map(m => [m.params.configId, m.params.value])).toEqual([["model", "gemini-3.8-flash"], ["thought_level", "low"]]);
	});

	it("makes no calls again for the same selection, and sets only what differs for a changed one", async () => {
		const f = fake(), owner = await f.open();
		// Each configure is followed by a turn, as in use: the turn ends the cycle, and echoes that land after it are unsolicited.
		const send = async (selection: { model: string; thought?: string }) => { await owner.configure(selection); await owner.prompt("hello", collect().handlers); };
		const calls = () => f.received("session/set_config_option").map(m => [m.params.configId, m.params.value]);
		await send({ model: "gemini-3.8-flash", thought: "low" });
		expect(calls()).toEqual([["model", "gemini-3.8-flash"], ["thought_level", "low"]]);
		await send({ model: "gemini-3.8-flash", thought: "low" });
		expect(calls()).toHaveLength(2);
		await send({ model: "claude-sonnet-5-5", thought: "low" });
		expect(calls().slice(2)).toEqual([["model", "claude-sonnet-5-5"]]);
		await send({ model: "claude-sonnet-5-5", thought: "high" });
		expect(calls().slice(3)).toEqual([["thought_level", "high"]]);
		await send({ model: "gemini-3.8-flash", thought: "low" });
		expect(calls().slice(4)).toEqual([["model", "gemini-3.8-flash"], ["thought_level", "low"]]);
	});

	it("for a fixed-effort model sends one model call, no thought_level call, and reports the thought level AGY holds", async () => {
		const f = fake(), owner = await f.open();
		expect(await owner.configure({ model: "gpt-oss-120b-medium" })).toEqual({ model: "gpt-oss-120b-medium", effort: "medium" });
		expect(f.received("session/set_config_option").map(m => m.params.configId)).toEqual(["model"]);
	});

	it("refuses a model AGY does not offer without sending any call, and an effort the new model does not offer after its model call, never reaching the prompt", async () => {
		const f = fake(), owner = await f.open();
		await expect(owner.configure({ model: "not-a-model", thought: "low" })).rejects.toMatchObject({ kind: "unsupported" });
		expect(f.received("session/set_config_option")).toEqual([]);
		// The effort is checked against the options the model's reply returned, so the model call goes first; nothing is prompted.
		await expect(owner.configure({ model: "gemini-3.8-flash", thought: "ultra" })).rejects.toMatchObject({ kind: "unsupported" });
		expect(f.received("session/set_config_option").map(m => [m.params.configId, m.params.value])).toEqual([["model", "gemini-3.8-flash"]]);
		expect(f.received("session/prompt")).toEqual([]);
		// With the model already in place the effort is checked against what AGY offers now, and nothing is sent.
		await expect(owner.configure({ model: "gemini-3.8-flash", thought: "ultra" })).rejects.toMatchObject({ kind: "unsupported" });
		expect(f.received("session/set_config_option")).toHaveLength(1);
	});

	// Decisions 2026-11-22, the model catalogue for AGY 1.5.14. The fake's mode `agy-1.5.14` offers what the real zero-prompt check showed: Neon and Hydrogen low to xhigh, Argon and Flash low to high,
	// and no thought_level option at all on an Orchestrator. It starts on Neon at high.
	describe("AGY 1.5.14's models", () => {
		const calls = (f: ReturnType<typeof fake>) => f.received("session/set_config_option").map(m => [m.params.configId, m.params.value]);
		const send = async (owner: AcpOwner, selection: { model: string; thought?: string }) => { const settled = await owner.configure(selection); await owner.prompt("hello", collect().handlers); return settled; };

		it("moves from Flash to Neon xhigh: the effort is checked against the options of the model's reply, and both land as the confirmed pair", async () => {
			const f = fake("agy-1.5.14"), owner = await f.open();
			await send(owner, { model: "gemini-3.8-flash", thought: "low" });
			const before = calls(f).length;
			expect(await send(owner, { model: "gemini-4-neon", thought: "xhigh" })).toEqual({ model: "gemini-4-neon", effort: "xhigh" });
			expect(calls(f).slice(before)).toEqual([["model", "gemini-4-neon"], ["thought_level", "xhigh"]]);
			expect(f.received("session/prompt")).toHaveLength(2);
		});

		it("moves from an Orchestrator to Argon low: the effort option that was gone comes back with the model's reply", async () => {
			const f = fake("agy-1.5.14"), owner = await f.open();
			await send(owner, { model: "gemini-pro-orchestrator-neon" });
			const before = calls(f).length;
			expect(await send(owner, { model: "gemini-4-argon", thought: "low" })).toEqual({ model: "gemini-4-argon", effort: "low" });
			expect(calls(f).slice(before)).toEqual([["model", "gemini-4-argon"], ["thought_level", "low"]]);
		});

		it("sends only `model` for an Orchestrator and reports no effort, because AGY shows no thought_level for it", async () => {
			const f = fake("agy-1.5.14"), owner = await f.open();
			expect(await send(owner, { model: "gemini-pro-orchestrator-neon" })).toEqual({ model: "gemini-pro-orchestrator-neon", effort: null });
			expect(calls(f)).toEqual([["model", "gemini-pro-orchestrator-neon"]]);
			expect(owner.config().some(o => o.id === "thought_level")).toBe(false);
		});

		it("keeps refusing an effort the model does not offer: Flash xhigh sends the model call, then stops before the prompt", async () => {
			const f = fake("agy-1.5.14"), owner = await f.open();
			await expect(owner.configure({ model: "gemini-3.8-flash", thought: "xhigh" })).rejects.toMatchObject({ kind: "unsupported" });
			expect(calls(f)).toEqual([["model", "gemini-3.8-flash"]]);
			expect(f.received("session/prompt")).toEqual([]);
		});

		it("reaches every Neon and Hydrogen level from the start (Neon at high), from Argon, from Flash and from an Orchestrator, and every Argon and Flash level", async () => {
			const f = fake("agy-1.5.14"), owner = await f.open();
			for (const [model, level] of [["gemini-4-neon", "xhigh"], ["gemini-4-hydrogen", "xhigh"], ["gemini-4-hydrogen", "low"], ["gemini-4-argon", "high"], ["gemini-4-neon", "xhigh"], ["gemini-3.8-flash", "medium"], ["gemini-4-hydrogen", "xhigh"], ["gemini-4-argon", "low"], ["gemini-3.8-flash", "high"]] as const)
				expect(await send(owner, { model, thought: level })).toEqual({ model, effort: level });
			expect(await send(owner, { model: "gemini-pro-orchestrator-g1-pro" })).toEqual({ model: "gemini-pro-orchestrator-g1-pro", effort: null });
			expect(await send(owner, { model: "gemini-4-neon", thought: "xhigh" })).toEqual({ model: "gemini-4-neon", effort: "xhigh" });
		});
	});

	it("refuses to send when AGY's replies do not show the requested pair", async () => {
		const f = fake("wrong-ack"), owner = await f.open();
		await expect(owner.configure({ model: "gemini-3.8-flash", thought: "low" })).rejects.toMatchObject({ kind: "not-confirmed" });
		await expect(owner.configure({ model: "gemini-3.8-flash", thought: "low" })).rejects.toMatchObject({ kind: "not-confirmed" });
	});
});

describe("pi-21.3 ACP owner: a turn", () => {
	it("hands text chunks over in order and returns AGY's usage", async () => {
		const f = fake(), owner = await f.open(), seen = collect();
		const result = await owner.prompt("hello", seen.handlers);
		expect(seen.text).toEqual(["Hello", " from", " ACP."]);
		expect(result).toEqual({ stopReason: "end_turn", diverged: false, usage: { input: 4331, output: 60, cacheRead: 48051, cacheWrite: 0, totalTokens: 52442 } });
		expect(f.received("session/prompt")).toHaveLength(1);
		expect(f.received("session/prompt")[0].params).toEqual({ sessionId: owner.acpSessionId, prompt: [{ type: "text", text: "hello" }] });
		expect(owner.state).toBe("idle");
	});

	it("hands thought chunks over separately and tolerates an empty answer", async () => {
		const f = fake(), owner = await f.open(), seen = collect();
		await owner.prompt("[thought] go", seen.handlers);
		expect(seen.thought).toEqual(["Thinking it over."]);
		expect(seen.text).toEqual(["Done."]);
		const empty = collect();
		await owner.prompt("[empty] go", empty.handlers);
		expect(empty.text).toEqual([]);
		expect(f.received("session/prompt")).toHaveLength(2);
	});

	it("reports another stop reason as AGY gave it", async () => {
		const f = fake(), owner = await f.open();
		expect((await owner.prompt("[maxtokens] go", collect().handlers)).stopReason).toBe("max_tokens");
		void f;
	});

	it("refuses a second prompt while one is running", async () => {
		const f = fake(), owner = await f.open();
		const first = owner.prompt("[hold] go", collect().handlers);
		await expect(owner.prompt("again", collect().handlers)).rejects.toBeInstanceOf(AcpLostError);
		writeFileSync(f.release, "go");
		await first;
		expect(f.received("session/prompt")).toHaveLength(1);
	});

	it("answers a permission request with the offered reject option by default, and a question with -32603", async () => {
		const f = fake(), owner = await f.open();
		const permSeen = collect(), qSeen = collect();
		await owner.prompt("[perm] go", permSeen.handlers);
		await owner.prompt("[question] go", qSeen.handlers);
		const reply = (k: string) => f.rows().find(r => r[k])[k];
		expect(reply("permissionReply")).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
		expect(permSeen.text).toEqual([]);
		expect(permSeen.tools.map(t => [t.sessionUpdate, t.status])).toEqual([["tool_call", "in_progress"], ["tool_call_update", "pending"], ["tool_call_update", "failed"]]);
		expect(reply("elicitationReply")).toEqual({ error: { code: -32603, message: "Pi could not show the question" } });
		expect(qSeen.text).toEqual(["after question"]);
	});

	it("gives fs/*, terminal/* and unknown requests a -32601 error on their own ids", async () => {
		const f = fake(), owner = await f.open();
		await owner.prompt("[fs] go", collect().handlers);
		const replies = f.rows().find(r => r.clientPowerReplies).clientPowerReplies;
		expect(replies.map((r: any) => r.error.code)).toEqual([-32601, -32601, -32601]);
	});

	it("passes a 600 KB output carried twice and ends the owner for a frame over 2 MiB", async () => {
		const f = fake(), owner = await f.open();
		expect((await owner.prompt("[big] go", collect().handlers)).stopReason).toBe("end_turn");
		const g = fake(), second = await g.open();
		let lostWith = "";
		await expect(second.prompt("[oversize] go", collect().handlers)).rejects.toSatisfy((e: AcpLostError) => { lostWith = e.reason; return e instanceof AcpLostError; });
		expect(lostWith).toBe("frame too large");
		expect(second.state).toBe("ineligible");
	});

	it("ends the owner when AGY exits mid-turn or answers an unknown id, and reports it once", async () => {
		const lost: string[] = [];
		const f = fake();
		const owner = await AcpOwner.open({ executable: f.exe, cwd: f.root, args: [], onLost: e => lost.push(e.reason) });
		owners.push(owner);
		await expect(owner.prompt("[exit] go", collect().handlers)).rejects.toBeInstanceOf(AcpLostError);
		expect(owner.state).toBe("ineligible");
		expect(lost).toHaveLength(1);
		const g = fake(), other = await g.open();
		await expect(other.prompt("[unknown-id] go", collect().handlers)).rejects.toBeInstanceOf(AcpLostError);
		expect(other.lostError?.reason).toBe("response to an unknown request");
	});
});

describe("pi-21.3 ACP owner: AGY's command list and retirement", () => {
	it("reports the command names when the list arrives after the session opens", async () => {
		const f = fake(), owner = await f.open();
		const names = await owner.commandList(2000);
		expect(names?.has("goal")).toBe(true);
	});

	it("reports no list when it does not arrive in time, without waiting longer than asked", async () => {
		const f = fake("no-commands"), owner = await f.open();
		const started = Date.now();
		expect(await owner.commandList(150)).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(1500);
	});

	it("closes an idle child with stdin and reports a clean, complete stop", async () => {
		const f = fake(), owner = await f.open();
		const outcome = await owner.close();
		expect(outcome).toEqual({ classification: "clean", retirement: "complete" });
		expect(owner.state).toBe("retired");
		expect(f.rows().some(r => r.eof)).toBe(true);
		expect(await owner.close()).toBe(outcome);
	});

	it("escalates to a terminate signal when stdin does not stop the child, and says the stop was not verified", async () => {
		const f = fake("ignore-eof"), owner = await f.open();
		const outcome = await owner.close();
		expect(outcome).toEqual({ classification: "stop-unverified", retirement: "complete" });
		expect(owner.child.exitCode !== null || owner.child.signalCode !== null).toBe(true);
	}, 10000);

	it("does not call a stop during a turn clean", async () => {
		const f = fake(), owner = await f.open();
		const running = owner.prompt("[hold] go", collect().handlers);
		running.catch(() => { });
		await new Promise(r => setTimeout(r, 100));
		expect((await owner.close()).classification).toBe("stop-unverified");
		await expect(running).rejects.toBeInstanceOf(AcpLostError);
		expect(owner.state).toBe("retired");
	}, 10000);

	// AGY 1.5.10: session/close stops the session's subagents and background tasks, also when no prompt is running.
	describe("session/close on retire", () => {
		/** Position of Pi's request, AGY's reply to it, and the end of Pi's input, in the fake's log. */
		const closeOrder = (f: ReturnType<typeof fake>) => {
			const rows = f.rows(), asked = rows.findIndex(r => r.in?.method === "session/close");
			return { asked, replied: asked < 0 ? -1 : rows.findIndex(r => r.out && r.out.id === rows[asked].in.id), eof: rows.findIndex(r => r.eof), params: rows[asked]?.in.params };
		};

		it("asks AGY to close the session, waits for its reply, and only then closes stdin", async () => {
			const f = fake(), owner = await f.open();
			expect(await owner.close()).toEqual({ classification: "clean", retirement: "complete" });
			const o = closeOrder(f);
			expect(o.params).toEqual({ sessionId: owner.acpSessionId });
			expect(f.received("session/close")).toHaveLength(1);
			expect(o.asked).toBeGreaterThanOrEqual(0);
			expect(o.replied).toBeGreaterThan(o.asked);
			expect(o.eof).toBeGreaterThan(o.replied);
			await owner.close();
			expect(f.received("session/close")).toHaveLength(1); // a second retire sends nothing
		});

		it("goes on to close stdin when AGY answers session/close with an error, without waiting", async () => {
			const f = fake("close-error"), owner = await f.open(), started = Date.now();
			expect(await owner.close()).toEqual({ classification: "clean", retirement: "complete" });
			expect(Date.now() - started).toBeLessThan(1500);
			expect(closeOrder(f).eof).toBeGreaterThan(closeOrder(f).asked);
		});

		it("waits 2 seconds at most for a session/close AGY never answers, then closes stdin as before", async () => {
			const f = fake("close-no-reply"), owner = await f.open(), started = Date.now();
			expect(await owner.close()).toEqual({ classification: "clean", retirement: "complete" });
			const took = Date.now() - started, o = closeOrder(f);
			expect(took).toBeGreaterThanOrEqual(1900);
			expect(took).toBeLessThan(6000);
			expect(o.replied).toBe(-1);
			expect(o.eof).toBeGreaterThan(o.asked);
		}, 15000);

		it("stays inside the 15 second limit when AGY ignores session/close, stdin and TERM, and still ends the child", async () => {
			const f = fake("close-no-reply,ignore-eof,ignore-term"), owner = await f.open(), started = Date.now();
			expect(await owner.close()).toEqual({ classification: "stop-unverified", retirement: "complete" });
			expect(Date.now() - started).toBeLessThan(15000);
			expect(owner.child.exitCode !== null || owner.child.signalCode !== null).toBe(true);
			expect(f.received("session/close")).toHaveLength(1);
		}, 25000);

		it("shows nothing for a permission request AGY sends while it answers session/close, and answers it as cancelled", async () => {
			const permission = vi.fn(async () => ({ outcome: { outcome: "selected", optionId: "allow" } }));
			const f = fake("close-asks-permission"), owner = await f.open([], { permission });
			expect(await owner.close()).toEqual({ classification: "clean", retirement: "complete" });
			expect(permission).not.toHaveBeenCalled();
			expect(f.rows().find(r => r.latePermissionReply)?.latePermissionReply).toEqual({ outcome: { outcome: "cancelled" } });
		});

		it("sends nothing when AGY did not advertise the close capability", async () => {
			const f = fake("no-close"), owner = await f.open(), started = Date.now();
			expect(await owner.close()).toEqual({ classification: "clean", retirement: "complete" });
			expect(Date.now() - started).toBeLessThan(1500);
			expect(f.received("session/close")).toEqual([]);
		});

		it("sends nothing to a child that already exited, and does not wait", async () => {
			const f = fake(), owner = await f.open();
			await expect(owner.prompt("[exit] go", collect().handlers)).rejects.toBeInstanceOf(AcpLostError);
			const started = Date.now();
			await owner.close();
			expect(Date.now() - started).toBeLessThan(1500);
			expect(f.received("session/close")).toEqual([]);
		});

		it("fails a running turn as lost at once, while it waits for an unanswered session/close", async () => {
			const f = fake("close-no-reply"), owner = await f.open();
			const running = owner.prompt("[hold] go", collect().handlers);
			running.catch(() => { });
			await new Promise(r => setTimeout(r, 100));
			const closing = owner.close(), started = Date.now();
			await expect(running).rejects.toBeInstanceOf(AcpLostError);
			expect(Date.now() - started).toBeLessThan(500);
			expect((await closing).classification).toBe("stop-unverified");
			expect(f.received("session/close")).toHaveLength(1);
		}, 15000);

		it("keeps a running turn failed as lost when AGY ends it as cancelled in answer to session/close, and passes it no more text", async () => {
			const f = fake("close-ends-turn"), owner = await f.open(), seen = collect();
			const running = owner.prompt("[hold-partial] go", seen.handlers);
			running.catch(() => { });
			await vi.waitFor(() => expect(seen.text).toEqual(["Partial before cancel."]));
			const closing = owner.close();
			await expect(running).rejects.toBeInstanceOf(AcpLostError);
			expect((await closing).classification).toBe("stop-unverified");
			expect(owner.state).toBe("retired");
			expect(seen.text).toEqual(["Partial before cancel."]);
		}, 15000);
	});
});

describe("pi-21.3 ACP owner: config echoes and divergence", () => {
	const calls = (f: ReturnType<typeof fake>) => f.received("session/set_config_option").map(m => [m.params.configId, m.params.value]);
	const FLASH_LOW = { model: "gemini-3.8-flash", thought: "low" };
	const PAIR = [["model", "gemini-3.8-flash"], ["thought_level", "low"]];

	it.each([
		["the recorded order: the model echo lands after the effort call and before its reply", "echo:recorded"],
		["both echoes after both replies", "echo:after-replies"],
		["the effort echo after session/prompt, the model echo before it", "echo:effort-after-prompt"],
		["both echoes after session/prompt", "echo:after-prompt"],
		["the model echo missing", "echo:missing-model"],
	])("sends one prompt, shows no divergence and leaves the owner idle with %s", async (_name, mode) => {
		const f = fake(mode), owner = await f.open();
		await owner.configure(FLASH_LOW);
		const result = await owner.prompt("hello", collect().handlers);
		expect(result).toMatchObject({ stopReason: "end_turn", diverged: false });
		expect(calls(f)).toEqual(PAIR);
		expect(f.received("session/prompt")).toHaveLength(1);
		expect(owner.state).toBe("idle");
		await owner.configure(FLASH_LOW); // still acknowledged: nothing to re-send
		expect(calls(f)).toHaveLength(2);
	});

	// The client handles every line of one read in a row, and configure() noted a reply's expected echo only after its await continued, so an echo that FOLLOWED its reply in the same read was counted as unsolicited.
	// That cost a second pass of both settings, and when it happened again in the second pass, a refusal to confirm a setting AGY had confirmed. A busy machine reads late, so it showed up as a rare failure.
	it.each([
		["the model call", "echo:same-chunk:model"],
		["the effort call", "echo:same-chunk:thought_level"],
		["both calls", "echo:same-chunk:all"],
	])("matches an echo that follows its reply in the same read, for %s: two calls, no divergence, nothing re-sent", async (_name, mode) => {
		const f = fake(mode), owner = await f.open();
		expect(await owner.configure(FLASH_LOW)).toEqual({ model: "gemini-3.8-flash", effort: "low" });
		expect(f.received("session/set_config_option").map(m => [m.params.configId, m.params.value])).toEqual(PAIR);
		const result = await owner.prompt("hello", collect().handlers);
		expect(result).toMatchObject({ stopReason: "end_turn", diverged: false });
		await owner.configure(FLASH_LOW); // still acknowledged: nothing to send
		expect(f.received("session/set_config_option")).toHaveLength(2);
	});

	it("matches every echo over a run of changes when only some calls arrive with their echo in one read", async () => {
		const f = fake("echo:same-chunk:model"), owner = await f.open(), sets = () => f.received("session/set_config_option").map(m => [m.params.configId, m.params.value]);
		await owner.configure(FLASH_LOW); await owner.prompt("one", collect().handlers);
		await owner.configure({ model: "gemini-4-neon", thought: "low" }); await owner.prompt("two", collect().handlers); // model only changes
		await owner.configure({ model: "gemini-4-neon", thought: "high" }); const last = await owner.prompt("three", collect().handlers); // effort only changes
		expect(last.diverged).toBe(false);
		expect(sets()).toEqual([...PAIR, ["model", "gemini-4-neon"], ["thought_level", "high"]]); // the effort stayed `low` through the model change, so only the model and then the effort went out
	});

	it("re-sends both settings once when an echo arrives before its own reply, then sends one prompt: four calls, no divergence", async () => {
		const f = fake("echo:before-reply"), owner = await f.open();
		await owner.configure(FLASH_LOW);
		expect(f.received("session/set_config_option").map(m => [m.params.configId, m.params.value])).toEqual([...PAIR, ...PAIR]);
		const result = await owner.prompt("hello", collect().handlers);
		expect(result.diverged).toBe(false);
		expect(f.received("session/prompt")).toHaveLength(1);
		expect(f.received("session/set_config_option")).toHaveLength(4);
	});

	it("treats an update after the turn as AGY's own change: the next send re-sends both settings and records what the replies say", async () => {
		const f = fake(), owner = await f.open();
		await owner.configure(FLASH_LOW);
		const first = await owner.prompt("[late-echo] go", collect().handlers);
		expect(first.diverged).toBe(false); // it arrived after the result, with no turn to blame
		await lateEchoSent(f);
		expect(await owner.configure({ model: "gemini-3.8-flash", thought: "medium" })).toEqual({ model: "gemini-3.8-flash", effort: "medium" });
		expect(calls(f).slice(2)).toEqual([["model", "gemini-3.8-flash"], ["thought_level", "medium"]]);
	});

	it("lets expected echoes lapse when the turn's result arrives: an update then is AGY's own change even if it repeats a pair Pi expected", async () => {
		const f = fake("echo:none"), owner = await f.open();
		await owner.configure(FLASH_LOW); // no echo ever arrives; the model call's reply pair (flash, medium) stays expected until the result
		await owner.prompt("[late-echo] go", collect().handlers); // then AGY reports (flash, medium) again
		await lateEchoSent(f);
		await owner.configure(FLASH_LOW);
		expect(calls(f).slice(2)).toEqual(PAIR);
	});

	it("re-sends both settings for the unchanged selection too after such an update", async () => {
		const f = fake(), owner = await f.open();
		await owner.configure(FLASH_LOW);
		await owner.prompt("[late-echo] go", collect().handlers);
		await lateEchoSent(f);
		expect(await owner.configure(FLASH_LOW)).toEqual({ model: "gemini-3.8-flash", effort: "low" });
		expect(calls(f).slice(2)).toEqual(PAIR);
	});

	it("refuses when, after such an update, AGY's effort reply does not show the selected level", async () => {
		const f = fake("wrong-effort"), owner = await f.open();
		await owner.configure(FLASH_LOW);
		await owner.prompt("[late-echo] go", collect().handlers);
		await lateEchoSent(f);
		await expect(owner.configure({ model: "gemini-3.8-flash", thought: "medium" })).rejects.toMatchObject({ kind: "not-confirmed" });
	});

	it("marks a change AGY makes during the turn, which no call of Pi's explains, as a divergence even though AGY answered", async () => {
		const f = fake(), owner = await f.open(), seen = collect();
		await owner.configure(FLASH_LOW);
		const result = await owner.prompt("[diverge] go", seen.handlers);
		expect(result).toMatchObject({ stopReason: "end_turn", diverged: true });
		expect(seen.text).toEqual(["Answered anyway."]);
	});

	// Cold review F3: an update that repeats the acknowledged pair raised no divergence but cleared the acknowledgement, so a later move in the same turn was compared with nothing.
	it("marks a move of the model as a divergence after an update that only repeated the acknowledged pair", async () => {
		const f = fake(), owner = await f.open(), seen = collect();
		await owner.configure(FLASH_LOW);
		const result = await owner.prompt("[repeat-diverge] go", seen.handlers);
		expect(result).toMatchObject({ stopReason: "end_turn", diverged: true });
		expect(seen.text).toEqual(["Answered anyway."]);
	});

	it("keeps a divergence when AGY moves the model and then moves it back within the turn", async () => {
		const f = fake(), owner = await f.open();
		await owner.configure(FLASH_LOW);
		expect(await owner.prompt("[move-and-back] go", collect().handlers)).toMatchObject({ diverged: true });
	});

	it("shows no divergence for an update that only repeats the pair, but stops trusting the acknowledgement: the next send re-sends both settings", async () => {
		const f = fake(), owner = await f.open();
		await owner.configure(FLASH_LOW);
		expect(await owner.prompt("[repeat] go", collect().handlers)).toMatchObject({ stopReason: "end_turn", diverged: false });
		expect(await owner.configure(FLASH_LOW)).toEqual({ model: "gemini-3.8-flash", effort: "low" });
		expect(calls(f).slice(2)).toEqual(PAIR);
	});

	it("starts every turn with no divergence from the one before", async () => {
		const f = fake(), owner = await f.open();
		await owner.configure(FLASH_LOW);
		expect(await owner.prompt("[repeat-diverge] go", collect().handlers)).toMatchObject({ diverged: true });
		await owner.configure(FLASH_LOW);
		expect(await owner.prompt("[repeat] go", collect().handlers)).toMatchObject({ diverged: false });
	});

	it("refuses to confirm a pair when AGY rejects the effort call, after the model call went through", async () => {
		const f = fake("effort-fails"), owner = await f.open();
		await expect(owner.configure(FLASH_LOW)).rejects.toMatchObject({ kind: "not-confirmed" });
		expect(f.received("session/prompt")).toEqual([]);
	});
});

describe("pi-21.3 ACP owner: resuming", () => {
	const resume = async (f: ReturnType<typeof fake>, id = "saved-session-7") => { const o = await AcpOwner.resume({ executable: f.exe, cwd: f.root, args: [], acpSessionId: id }); owners.push(o); return o; };

	it("sends initialize, then session/resume with the saved id and folder, and no session/new", async () => {
		const f = fake(), owner = await resume(f);
		expect(f.rows().filter(r => r.in).map(r => r.in.method)).toEqual(["initialize", "session/resume"]);
		expect(f.received("session/resume")[0].params).toEqual({ sessionId: "saved-session-7", cwd: f.root, mcpServers: [] });
		expect(owner.acpSessionId).toBe("saved-session-7");
		expect(owner.state).toBe("idle");
	});

	it("starts from AGY's defaults, so the pair is set again before the prompt, and the command list arrives", async () => {
		const f = fake(), owner = await resume(f);
		expect(owner.config().find(o => o.id === "model")!.currentValue).toBe("gemini-4-argon");
		await owner.configure({ model: "gemini-3.8-flash", thought: "low" });
		expect(f.received("session/set_config_option").map(m => [m.params.configId, m.params.value])).toEqual([["model", "gemini-3.8-flash"], ["thought_level", "low"]]);
		expect((await owner.commandList(2000))?.has("goal")).toBe(true);
		const seen = collect();
		expect((await owner.prompt("hello", seen.handlers)).stopReason).toBe("end_turn");
		expect(f.received("session/prompt")[0].params.sessionId).toBe("saved-session-7");
	});

	it.each([
		["AGY refusing the session", "resume-fails"],
		["AGY answering with another session id", "resume-wrong-id"],
		["a missing resume capability", "no-resume"],
	])("refuses to resume on %s and retires the child it started", async (_name, mode) => {
		const f = fake(mode);
		await expect(AcpOwner.resume({ executable: f.exe, cwd: f.root, args: [], acpSessionId: "saved-session-7" })).rejects.toBeInstanceOf(AcpStartError);
		await new Promise(r => setTimeout(r, 100));
		expect(f.rows().some(r => r.eof)).toBe(true);
	});
});

describe("pi-21.3 ACP owner: safety, hooks, cancel and sign-in", () => {
	it("exposes exact copy lines and definite stop-reason mapping", () => {
		expect(ACP_COPY.signIn).toBe("AGY needs you to sign in. Your message was not sent. Sign in with AGY itself, then send again.");
		expect(ACP_COPY.cancelTimeout).toBe("AGY did not stop within 3 seconds, so Pi stopped it. This conversation cannot continue. Use /new to start a new conversation.");
		expect(ACP_COPY.question).toBe("AGY asked a question Pi can't show yet, so AGY asks it in the chat instead.");
		expect(ACP_DEFINITE_STOP_REASONS).toEqual({ end_turn: "stop", max_tokens: "length", max_turn_requests: "length", refusal: "error", cancelled: "aborted" });
	});

	it("classifies sign-in RPC errors on -32000 and rejects generic or other codes", () => {
		expect(isAcpSignInError(new AcpRpcError(-32000, "Authentication required: please sign in"))).toBe(true);
		expect(isAcpSignInError(new AcpRpcError(-32000, "User is not logged in"))).toBe(true);
		expect(isAcpSignInError(new AcpRpcError(-32000, "Missing credentials"))).toBe(true);
		expect(isAcpSignInError(new AcpRpcError(-32000, "fake error"))).toBe(false);
		expect(isAcpSignInError(new AcpRpcError(-32000))).toBe(false);
		expect(isAcpSignInError(new AcpRpcError(-32603, "please sign in"))).toBe(false);
		expect(isAcpSignInError(new Error("sign in"))).toBe(false);
	});

	it("throws AcpStartError('sign-in') and retires the child when session/new or session/resume reports a sign-in error", async () => {
		const fNew = fake("signin-fails");
		const errNew = await fNew.open().catch(e => e);
		expect(errNew).toBeInstanceOf(AcpStartError);
		expect(errNew.kind).toBe("sign-in");
		await vi.waitFor(() => expect(fNew.rows().some(r => r.eof)).toBe(true));

		const fResume = fake("signin-fails");
		const errResume = await AcpOwner.resume({ executable: fResume.exe, cwd: fResume.root, args: [], acpSessionId: "saved-session-7" }).catch(e => e);
		expect(errResume).toBeInstanceOf(AcpStartError);
		expect(errResume.kind).toBe("sign-in");
		await vi.waitFor(() => expect(fResume.rows().some(r => r.eof)).toBe(true));

		const fGeneric = fake("new-fails");
		const errGeneric = await fGeneric.open().catch(e => e);
		expect(errGeneric).toBeInstanceOf(AcpStartError);
		expect(errGeneric.kind).toBe("startup");
	});

	it("drops replayed tool updates outside an active prompt and forwards in-flight tool updates", async () => {
		const f = fake("replay-tools");
		const owner = await AcpOwner.resume({ executable: f.exe, cwd: f.root, args: [], acpSessionId: "saved-session-7" });
		owners.push(owner);
		await new Promise(r => setTimeout(r, 30));
		const seen = collect();
		await owner.prompt("hello", seen.handlers);
		expect(seen.tools).toEqual([]);

		owner.setRequestHandlers({ permission: () => ({ outcome: { outcome: "selected", optionId: "allow" } }) });
		const permSeen = collect();
		await owner.prompt("[perm] go", permSeen.handlers);
		expect(permSeen.text).toEqual(["after permission"]);
		expect(permSeen.tools.map(t => [t.sessionUpdate, t.toolCallId, t.status])).toEqual([
			["tool_call", "call_1540230168067533781", "in_progress"],
			["tool_call_update", "call_1540230168067533781", "pending"],
			["tool_call_update", "call_1540230168067533781", "in_progress"],
			["tool_call_update", "call_1540230168067533781", "completed"],
		]);
		expect(permSeen.tools.at(-1)?.rawOutput).toEqual({ output: "a.txt\nb.txt", exit_code: 0 });
	});

	it("routes permission and question hooks, supports between-turn permissions, and always replies -32603 to elicitation/create", async () => {
		const seenPerms: Array<{ id: unknown; cmd?: string }> = [];
		const seenQuestions: any[] = [];
		const f = fake();
		const owner = await f.open([], {
			permission: (params, id) => {
				seenPerms.push({ id, cmd: params?.toolCall?.rawInput?.CommandLine });
				return { outcome: { outcome: "selected", optionId: id === "1" ? "allow" : "deny" } };
			},
			question: (params) => {
				seenQuestions.push(params);
				throw new Error("hook threw");
			},
		});

		const twoSeen = collect();
		await owner.prompt("[perm-two] go", twoSeen.handlers);
		expect(seenPerms).toEqual([{ id: "1", cmd: "echo one" }, { id: "2", cmd: "echo two" }]);
		expect(twoSeen.text).toEqual(["after two permissions"]);

		const longSeen = collect();
		await owner.prompt("[perm-long] go", longSeen.handlers);
		expect(seenPerms.at(-1)?.cmd?.split("\n")).toHaveLength(200);
		expect(longSeen.text).toEqual(["after long permission"]);

		const escSeen = collect();
		await owner.prompt("[perm-escape] go", escSeen.handlers);
		expect(seenPerms.at(-1)?.cmd).toContain("\x1b[31mred\x1b[0m");
		expect(seenPerms.at(-1)?.cmd).toContain("\u202eevil");

		const qSeen = collect();
		await owner.prompt("[question] go", qSeen.handlers);
		expect(seenQuestions).toHaveLength(1);
		expect(seenQuestions[0].requestedSchema.properties.q0.title).toBe("Which colors do you like?");
		expect(f.rows().find(r => r.elicitationReply).elicitationReply).toEqual({ error: { code: -32603, message: "Pi could not show the question" } });

		await owner.prompt("[perm-between] go", collect().handlers);
		await vi.waitFor(() => expect(f.rows().some(r => r.betweenPermissionReply)).toBe(true));
		expect(seenPerms.at(-1)?.id).toBe("between-1");
	});

	it("passes an AcpReply from the permission handler to the link, and the handler learns that the fake received what was written", async () => {
		const f = fake(), delivered: boolean[] = [];
		const owner = await f.open([], { permission: async () => new AcpReply({ outcome: { outcome: "selected", optionId: "allow" } }, ok => delivered.push(ok)) });
		expect((await owner.prompt("[perm] go", collect().handlers)).stopReason).toBe("end_turn");
		expect(delivered).toEqual([true]);
		expect(f.rows().find(r => r.permissionReply)?.permissionReply).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
	});

	it("handles refusal, max_turn_requests and usage_update scenarios", async () => {
		const f = fake(), owner = await f.open();
		expect((await owner.prompt("[refusal] go", collect().handlers)).stopReason).toBe("refusal");
		expect((await owner.prompt("[max-requests] go", collect().handlers)).stopReason).toBe("max_turn_requests");
		const seen = collect();
		expect((await owner.prompt("[usage-update] go", seen.handlers)).stopReason).toBe("end_turn");
		expect(seen.text).toEqual(["usage ok"]);
		expect(f.rows().filter(r => r.out?.params?.update?.sessionUpdate === "usage_update").map(r => r.out.params.update)).toEqual([{ sessionUpdate: "usage_update", used: 0, size: 1048576 }]);
	});

	it("checks prompt outbound size before dispatch without writing", async () => {
		const f = fake(), owner = await f.open();
		expect(() => owner.checkPromptSize("a".repeat(200), 100)).toThrow(AcpOversizeRequestError);
		expect(() => owner.checkPromptSize("hello", 500)).not.toThrow();
		expect(f.received("session/prompt")).toEqual([]);
	});

	it("sends session/cancel on abort and returns to idle when AGY cancels within the grace window", async () => {
		const f = fake(), owner = await f.open();
		const controller = new AbortController();
		const pending = owner.prompt("[cancel-wait] go", collect().handlers, { signal: controller.signal, cancelGraceMs: 2000 });
		await vi.waitFor(() => expect(f.received("session/prompt")).toHaveLength(1));
		controller.abort();
		const result = await pending;
		expect(result.stopReason).toBe("cancelled");
		expect(result.diverged).toBe(false);
		expect(f.received("session/cancel")).toHaveLength(1);
		expect(owner.state).toBe("idle");
		// Owner stays alive and handles another turn cleanly.
		const next = collect();
		expect((await owner.prompt("hello", next.handlers)).stopReason).toBe("end_turn");
		expect(next.text).toEqual(["Hello", " from", " ACP."]);
	});

	it("rejects with AcpCancelTimeoutError and marks the owner ineligible when AGY does not stop within the grace window", async () => {
		const f = fake("cancel-timeout"), owner = await f.open();
		const controller = new AbortController();
		const pending = owner.prompt("[hold] go", collect().handlers, { signal: controller.signal, cancelGraceMs: 80 });
		await vi.waitFor(() => expect(f.received("session/prompt")).toHaveLength(1));
		controller.abort();
		const err = await pending.catch(e => e);
		expect(err).toBeInstanceOf(AcpCancelTimeoutError);
		expect(err.message).toBe(ACP_COPY.cancelTimeout);
		expect(f.received("session/cancel")).toHaveLength(1);
		expect(owner.state).toBe("ineligible");
		expect((await owner.close()).classification).toBe("stop-unverified");
	});

	it("ignores cancel() when idle, caps early startup notifications at 64, and guards wrong-session questions and empty toolCallId", async () => {
		const f = fake(), idleOwner = await f.open();
		idleOwner.cancel();
		await new Promise(r => setTimeout(r, 30));
		expect(f.received("session/cancel")).toEqual([]);

		// Inline shim emitting `pad` dummy notifications + 1 available_commands_update before replying to session/new,
		// and during a prompt emitting a wrong-session elicitation/create and a tool_call with empty toolCallId.
		const runInline = async (pad: number) => {
			const root = mkdtempSync(join(base!, "acp-cap-")), exe = join(root, "agy-inline");
			const script = `const send=o=>process.stdout.write(JSON.stringify(o)+"\\n");
let buf="", qReply=null;
const cfg=[{id:"model",currentValue:"m1",options:[{value:"m1"}]},{id:"thought_level",currentValue:"low",options:[{value:"low"}]}];
process.stdin.on("data",d=>{buf+=d;let i;while((i=buf.indexOf("\\n"))>=0){const m=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);
if(m.method==="initialize")send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{resume:{}}}}});
else if(m.method==="session/new"){
for(let k=0;k<${pad};k++)send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"s1",update:{sessionUpdate:"tool_call",toolCallId:"early_"+k}}});
send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"s1",update:{sessionUpdate:"available_commands_update",availableCommands:[{name:"goal"}]}}});
send({jsonrpc:"2.0",id:m.id,result:{sessionId:"s1",configOptions:cfg}});
}else if(m.method==="session/prompt"){
send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"s1",update:{sessionUpdate:"tool_call",toolCallId:""}}});
send({jsonrpc:"2.0",id:"wq",method:"elicitation/create",params:{sessionId:"other-session",toolCallId:"q1",message:"hi"}});
qReply=m.id;
}else if(m.id==="wq"&&qReply!==null){
send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"s1",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:JSON.stringify(m.error)}}}});
send({jsonrpc:"2.0",id:qReply,result:{stopReason:"end_turn"}});
qReply=null;
}}});
process.stdin.on("end",()=>process.exit(0));`;
			writeFileSync(exe, `#!${process.execPath}\n${script}\n`);
			chmodSync(exe, 0o700);
			const wrongQuestions: any[] = [];
			const owner = await AcpOwner.open({ executable: exe, cwd: root, args: [], requests: { question: p => { wrongQuestions.push(p); } } });
			owners.push(owner);
			return { owner, wrongQuestions };
		};

		const capped = await runInline(64);
		expect(await capped.owner.commandList(50)).toBeUndefined();
		const seen = collect();
		await capped.owner.prompt("go", seen.handlers);
		expect(seen.tools).toEqual([]);
		expect(capped.wrongQuestions).toEqual([]);
		expect(JSON.parse(seen.text.join(""))).toEqual({ code: -32603, message: "Pi could not show the question" });

		const within = await runInline(63);
		expect((await within.owner.commandList(50))?.has("goal")).toBe(true);
	});
});

// AGY 1.5.14 sends {"sessionUpdate":"usage_update","used":0,"size":1048576} at session start, after each model call and after a model or effort change.
describe("pi-21.3 ACP owner: usage_update", () => {
	const FLASH_LOW = { model: "gemini-3.8-flash", thought: "low" };
	const PAIR = [["model", "gemini-3.8-flash"], ["thought_level", "low"]];
	const calls = (f: ReturnType<typeof fake>) => f.received("session/set_config_option").map(m => [m.params.configId, m.params.value]);
	const usageFrames = (f: ReturnType<typeof fake>) => f.rows().filter(r => r.out?.params?.update?.sessionUpdate === "usage_update").length;
	const afterTurn = async (f: ReturnType<typeof fake>) => { await vi.waitFor(() => expect(f.rows().some(r => r.usageAfterTurn)).toBe(true), { timeout: 5000 }); await new Promise(r => setTimeout(r, 30)); };

	it.each([
		["the recorded order", "echo:recorded"],
		["both echoes after both replies", "echo:after-replies"],
		["the effort echo after session/prompt", "echo:effort-after-prompt"],
		["both echoes after session/prompt", "echo:after-prompt"],
		["the model echo missing", "echo:missing-model"],
	])("changes nothing when it arrives at session start, right after each set_config_option reply and between chunks, with %s: same answer, no divergence, pair still acknowledged", async (_name, echo) => {
		const f = fake(`usage-updates,${echo}`), owner = await f.open(), seen = collect();
		await owner.configure(FLASH_LOW);
		expect(calls(f)).toEqual(PAIR);
		const result = await owner.prompt("hello", seen.handlers);
		expect(seen.text).toEqual(["Hello", " from", " ACP."]);
		expect(seen.thought).toEqual([]);
		expect(seen.tools).toEqual([]);
		expect(result).toMatchObject({ stopReason: "end_turn", diverged: false });
		expect(usageFrames(f)).toBeGreaterThanOrEqual(6); // start, two replies, three chunks
		expect(owner.state).toBe("idle");
		await owner.configure(FLASH_LOW); // still acknowledged: nothing to re-send
		expect(calls(f)).toHaveLength(2);
		expect(f.received("session/prompt")).toHaveLength(1);
	});

	it("does not take a usage_update between the reply of a set_config_option and its echo for the echo: the echo still matches", async () => {
		const f = fake("usage-updates,echo:after-replies"), owner = await f.open();
		await owner.configure(FLASH_LOW);
		await owner.prompt("hello", collect().handlers);
		await afterTurn(f);
		await owner.configure(FLASH_LOW);
		expect(calls(f)).toHaveLength(2);
	});

	it("is ignored between turns: no handler runs, the owner stays idle and the acknowledged pair holds for the next send", async () => {
		const f = fake("usage-updates"), owner = await f.open(), seen = collect();
		await owner.configure(FLASH_LOW);
		await owner.prompt("first", seen.handlers);
		const before = usageFrames(f);
		await afterTurn(f);
		expect(usageFrames(f)).toBeGreaterThan(before);
		expect(seen.text).toEqual(["Hello", " from", " ACP."]);
		expect(owner.state).toBe("idle");
		expect(await owner.configure(FLASH_LOW)).toEqual({ model: "gemini-3.8-flash", effort: "low" });
		expect(calls(f)).toHaveLength(2);
		const second = collect();
		expect(await owner.prompt("second", second.handlers)).toMatchObject({ stopReason: "end_turn", diverged: false });
		expect(second.text).toEqual(["Hello", " from", " ACP."]);
	});

	it("is ignored on a resumed session too", async () => {
		const f = fake("usage-updates"), owner = await AcpOwner.resume({ executable: f.exe, cwd: f.root, args: [], acpSessionId: "saved-session-7" });
		owners.push(owner);
		await owner.configure(FLASH_LOW);
		expect(calls(f)).toEqual(PAIR);
		expect(await owner.prompt("hello", collect().handlers)).toMatchObject({ stopReason: "end_turn", diverged: false });
		expect(usageFrames(f)).toBeGreaterThanOrEqual(6);
	});
});

// Decisions 2026-11-22: each AGY wake-up is its own turn. The owner buffers what AGY says between turns from its first real frame, tells the provider once, and hands the frames over when the
// provider attaches. It ends the wake after AGY has been silent for 3 s (shortened here), never while something is `busy`, and Esc sends session/cancel.
describe("pi-21.3 ACP owner: wake turns", { timeout: 30000 }, () => {
	const QUIET = 150;
	const wakes = (owner: AcpOwner) => { const n = { count: 0 }; owner.setWakeListener(() => { n.count++; }); return n; };
	const prompted = async (mode: string, scenario: string, requests?: AcpOwnerRequestHandlers) => {
		const f = fake(mode), owner = await f.open([], requests), n = wakes(owner);
		await owner.prompt(`[${scenario}] go`, collect().handlers);
		return { f, owner, n };
	};
	/** When the fake sent each answer chunk and tool result of a wake, from its own log. */
	const frameTimes = (f: ReturnType<typeof fake>) => f.rows().filter(r => typeof r.wakeFrameAt === "number").map(r => r.wakeFrameAt as number);
	const toolNames = (seen: ReturnType<typeof collect>) => seen.tools.map(t => `${t.sessionUpdate}:${t.toolCallId}:${t.status}`);

	it("tells the listener once when AGY speaks after a turn, holds every frame from the first one, and replays them in order when the provider attaches", async () => {
		const { owner, n } = await prompted("", "wake");
		await vi.waitFor(() => expect(n.count).toBe(1), { timeout: 10000 });
		expect(owner.state).toBe("waking");
		await new Promise(r => setTimeout(r, 120)); // the rest of the burst arrives while nobody is attached
		expect(n.count).toBe(1);
		const seen = collect();
		const result = await owner.attachWake(seen.handlers, { quietMs: QUIET });
		expect(toolNames(seen)).toEqual(["tool_call_update:call_wake_1:completed"]);
		expect(seen.text).toEqual(["Background job", " finished."]);
		expect(result).toEqual({ ended: "quiet", diverged: false });
		expect(owner.state).toBe("idle");
		expect(owner.waking).toBe(false);
	});

	it("ends the wake only after AGY was silent for the quiet time, counting every frame, and holds the end while something is busy", async () => {
		const { owner, n } = await prompted("", "wake");
		await vi.waitFor(() => expect(n.count).toBe(1), { timeout: 10000 });
		let busy = true; const started = Date.now();
		setTimeout(() => { busy = false; }, 500);
		const result = await owner.attachWake(collect().handlers, { quietMs: QUIET, busy: () => busy });
		expect(result.ended).toBe("quiet");
		expect(Date.now() - started).toBeGreaterThanOrEqual(480);
		const quick = await prompted("", "wake");
		await vi.waitFor(() => expect(quick.n.count).toBe(1), { timeout: 10000 });
		await quick.owner.attachWake(collect().handlers, { quietMs: QUIET });
		// Measured from the time the fake logged for its last frame, not from a guess about when the burst ended: the wake ends a quiet time after it, and not much later.
		const last = frameTimes(quick.f).at(-1)!;
		expect(Date.now() - last).toBeGreaterThanOrEqual(QUIET);
		expect(Date.now() - last).toBeLessThan(QUIET + 3000);
	});

	// A burst longer than the quiet time, its frames spaced under it: the silence is counted from the LAST frame. A wake whose clock ran from the first frame would end after two frames here, and the rest would start a new wake.
	it("ends a wake a quiet time after AGY's last frame, however long the burst ran, and takes every frame as one wake", async () => {
		const quiet = 1000, f = fake("wake-gap:500"), owner = await f.open(), n = wakes(owner);
		await owner.prompt("[wake-paced] go", collect().handlers);
		await vi.waitFor(() => expect(n.count).toBe(1), { timeout: 10000 });
		const seen = collect();
		await owner.attachWake(seen.handlers, { quietMs: quiet });
		const ended = Date.now(), times = frameTimes(f);
		expect(times).toHaveLength(5);
		expect(seen.text.join("")).toBe("p0 p1 p2 p3 p4 ");
		expect(n.count).toBe(1);
		expect(ended - times.at(-1)!).toBeGreaterThanOrEqual(quiet);
		expect(ended - times.at(-1)!).toBeLessThan(quiet + 3000);
	});

	it("is not tricked into a wake by usage, config or command-list updates alone", async () => {
		const { f, owner, n } = await prompted("", "wake-noise");
		await vi.waitFor(() => expect(f.rows().some(r => r.wakeNoiseSent)).toBe(true), { timeout: 10000 });
		await new Promise(r => setTimeout(r, 100));
		expect(n.count).toBe(0);
		expect(owner.state).toBe("idle");
		expect(await owner.configure({ model: "gemini-4-argon", thought: "medium" })).toEqual({ model: "gemini-4-argon", effort: "medium" }); // the config update is still taken
	});

	it("starts a second wake for a second burst after the first ended", async () => {
		const { owner, n } = await prompted("wake-gap:500", "wake-two");
		await vi.waitFor(() => expect(n.count).toBe(1), { timeout: 10000 });
		const first = collect();
		await owner.attachWake(first.handlers, { quietMs: QUIET });
		expect(first.text.join("")).toBe("Background job finished.");
		await vi.waitFor(() => expect(n.count).toBe(2), { timeout: 10000 });
		const second = collect();
		await owner.attachWake(second.handlers, { quietMs: QUIET });
		expect(second.text).toEqual(["A second thing."]);
	});

	it("does nothing without a listener, and does not wake on the frames that follow session/new or session/resume", async () => {
		const quiet = fake(""), plain = await quiet.open();
		await plain.prompt("[wake] go", collect().handlers);
		await new Promise(r => setTimeout(r, 300));
		expect(plain.state).toBe("idle");
		const replay = fake("replay-tools"), owner = await replay.open(), n = wakes(owner);
		await new Promise(r => setTimeout(r, 200)); // the fake replays a tool call right after session/new
		expect(n.count).toBe(0);
		expect(owner.state).toBe("idle");
	});

	it("holds a permission request that opens a wake, answers it through the permission handler once attached, and gives the dialog the wake's time", async () => {
		const asked: string[] = [];
		let release!: () => void; const answer = new Promise<void>(r => { release = r; });
		const requests: AcpOwnerRequestHandlers = { permission: async params => { asked.push(params.toolCall.toolCallId); await answer; return { outcome: { outcome: "selected", optionId: "allow" } }; } };
		const { f, owner, n } = await prompted("", "wake-perm", requests);
		await vi.waitFor(() => expect(n.count).toBe(1), { timeout: 10000 });
		expect(asked).toEqual([]); // nothing is asked before a turn exists
		let open = true; const seen = collect();
		const wake = owner.attachWake(seen.handlers, { quietMs: QUIET, busy: () => open });
		await vi.waitFor(() => expect(asked).toEqual(["call_wake_perm"]), { timeout: 10000 });
		await new Promise(r => setTimeout(r, QUIET * 2)); // longer than the quiet time, with the dialog open
		expect(owner.state).toBe("waking");
		open = false; release();
		expect((await wake).ended).toBe("quiet");
		expect(f.rows().find(r => r.wakePermissionReply)?.wakePermissionReply).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
		expect(seen.text).toEqual(["Listed the files."]);
	});

	it("answers a question that opens a wake with error -32603 after attaching, and tells the question handler", async () => {
		const questions: string[] = [];
		const { f, owner, n } = await prompted("", "wake-question", { question: params => { questions.push(params.toolCallId); } });
		await vi.waitFor(() => expect(n.count).toBe(1), { timeout: 10000 });
		const seen = collect();
		await owner.attachWake(seen.handlers, { quietMs: QUIET });
		expect(questions).toEqual(["call_wake_q"]);
		expect(f.rows().find(r => r.wakeElicitationReply)?.wakeElicitationReply).toEqual({ error: { code: -32603, message: "Pi could not show the question" } });
		expect(seen.text).toEqual(["Asked in chat."]);
	});

	it("sends session/cancel when the signal aborts, ends the wake as cancelled at once, and ignores what AGY had already sent for a second", async () => {
		const { f, owner, n } = await prompted("cancel-trails", "wake-long");
		await vi.waitFor(() => expect(n.count).toBe(1), { timeout: 10000 });
		const controller = new AbortController(), seen = collect();
		const wake = owner.attachWake(seen.handlers, { quietMs: 5000, signal: controller.signal });
		await vi.waitFor(() => expect(seen.text.length).toBeGreaterThan(2), { timeout: 10000 });
		controller.abort();
		expect(await wake).toEqual({ ended: "cancelled", diverged: false });
		await vi.waitFor(() => expect(f.received("session/cancel")).toHaveLength(1), { timeout: 10000 });
		expect(owner.state).toBe("idle");
		await vi.waitFor(() => expect(f.rows().some(r => r.trailingSent)).toBe(true), { timeout: 10000 });
		await new Promise(r => setTimeout(r, 100));
		expect(n.count).toBe(1); // the trailing frame started no new wake
	});

	it("marks a wake diverged when AGY changes its settings during it, and not for an update that repeats the pair", async () => {
		const f = fake("agy-1.5.14,wake-gap:30"), owner = await f.open(), n = wakes(owner);
		await owner.configure({ model: "gemini-4-neon", thought: "high" });
		await owner.prompt("[wake] go", collect().handlers);
		await vi.waitFor(() => expect(n.count).toBe(1), { timeout: 10000 });
		// A move of the model arrives during the wake, as the fake's own update.
		const attached = owner.attachWake(collect().handlers, { quietMs: QUIET });
		await (owner as any).onConfigUpdate([{ id: "model", currentValue: "gemini-pro-orchestrator-neon", options: [{ value: "gemini-pro-orchestrator-neon" }] }]);
		expect(await attached).toMatchObject({ ended: "quiet", diverged: true });
	});

	// AGY changes its own model or thinking level while it works between turns. No turn owns that update: if the wake is abandoned (nothing attached within 15 s, Esc before the run, the owner retiring)
	// the update still has to reach Pi's snapshot, or Pi keeps a confirmed pair AGY no longer runs and the next send skips its settings calls.
	it("applies the config and command-list updates a wake held when the wake is abandoned, so the next send sets the pair again", async () => {
		const f = fake(), owner = await f.open(), n = wakes(owner), FLASH_LOW = { model: "gemini-3.8-flash", thought: "low" };
		expect([...(await owner.commandList(3000))!]).toContain("goal"); // the fake's own list arrives 80 ms after the session starts; the wake's must come after it
		await owner.configure(FLASH_LOW);
		await owner.prompt("[wake-move] go", collect().handlers);
		await vi.waitFor(() => expect(n.count).toBe(1), { timeout: 10000 });
		// The last frame of AGY's burst (the command list, sent after the move) is in the wake's buffer: the client reads the pipe on its own time, so wait for the owner itself.
		await vi.waitFor(() => expect((owner as any).wake?.buffer.some((b: any) => b.kind === "update" && b.update.sessionUpdate === "available_commands_update")).toBe(true), { timeout: 5000 });
		owner.abandonWake(); // nothing attached
		expect(await owner.configure(FLASH_LOW)).toEqual({ model: "gemini-3.8-flash", effort: "low" });
		expect(f.received("session/set_config_option").map(m => [m.params.configId, m.params.value])).toEqual([["model", "gemini-3.8-flash"], ["thought_level", "low"], ["model", "gemini-3.8-flash"], ["thought_level", "low"]]);
		expect([...(await owner.commandList(10))!]).toEqual(["woke-cmd"]); // the list AGY sent while it woke replaced the old one
	});

	// A wake freezes the pair AGY holds at its start, so a move of the model or effort during it is divergence. With an acknowledged pair that is the acknowledgement; an update nobody asked for between turns
	// (a late echo, an update that only repeats the pair) clears the acknowledgement, and the wake used to freeze nothing and see no divergence at all.
	it.each([
		["moves the model", "wake-move", true],
		["only repeats the pair", "wake-repeat", false],
	])("marks a wake diverged exactly when AGY moves its settings during it, also after an update between turns cleared the acknowledgement: an update that %s", async (_name, scenario, diverged) => {
		const f = fake("clear-ack"), owner = await f.open(), n = wakes(owner);
		await owner.commandList(3000); // the fake's own list comes 80 ms after the session starts; keep it out of the wake
		await owner.configure({ model: "gemini-3.8-flash", thought: "low" });
		await owner.prompt(`[${scenario}] go`, collect().handlers);
		await vi.waitFor(() => expect(n.count).toBe(1), { timeout: 10000 });
		await vi.waitFor(() => expect((owner as any).wake?.buffer.some((b: any) => b.kind === "update" && b.update.availableCommands?.some((c: any) => c.name === "woke-cmd"))).toBe(true), { timeout: 5000 }); // AGY's burst, the update in it too, is held
		expect(await owner.attachWake(collect().handlers, { quietMs: QUIET })).toMatchObject({ ended: "quiet", diverged });
	});

	// A wake that starts while Pi's own settings step is running (AGY speaks after the model call's reply and before the effort call's) must not freeze the pair from before that step: Pi's calls explain the change,
	// and an update that only repeats the new pair is not AGY moving anything. The pair is frozen when the provider attaches, from the acknowledgement or the snapshot, which Pi's calls have set by then.
	describe("a wake that starts during Pi's settings step", () => {
		const FLASH_LOW = { model: "gemini-3.8-flash", thought: "low" };
		const wakeFrame = (owner: AcpOwner) => (owner as any).onNotification("session/update", { sessionId: owner.acpSessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working." } } });
		const update = (owner: AcpOwner, move: boolean) => (owner as any).onNotification("session/update", { sessionId: owner.acpSessionId, update: { sessionUpdate: "config_option_update", configOptions: (owner as any).snapshot.map((o: any) => move && o.id === "model" ? { ...o, currentValue: "claude-opus-5-5" } : o) } });
		const duringSettings = async (move: boolean) => {
			const f = fake("slow-set:300"), owner = await f.open(), n = wakes(owner);
			await owner.prompt("hello", collect().handlers); // the first turn: the owner is armed
			const configuring = owner.configure(FLASH_LOW); // two slow calls
			await vi.waitFor(() => expect(f.received("session/set_config_option").length).toBeGreaterThanOrEqual(1), { timeout: 5000 });
			wakeFrame(owner); // AGY speaks while the pair is being set: the wake starts
			await configuring;
			await vi.waitFor(() => expect(n.count).toBe(1), { timeout: 5000 });
			const attached = owner.attachWake(collect().handlers, { quietMs: 400 });
			await vi.waitFor(() => expect((owner as any).expectedEchoes).toEqual([]), { timeout: 5000 }); // the echoes of Pi's own two calls have been matched: what comes next is AGY's
			update(owner, move); // AGY sends an update during the wake: it repeats the pair Pi just set, or moves the model
			return attached;
		};

		it("does not read an update that only repeats the pair Pi just set as divergence", async () => {
			expect(await duringSettings(false)).toMatchObject({ ended: "quiet", diverged: false });
		});

		it("still reads a real move of the model during the wake as divergence", async () => {
			expect(await duringSettings(true)).toMatchObject({ ended: "quiet", diverged: true });
		});
	});

	it("refuses a prompt while a wake runs, and a second attach", async () => {
		const { owner, n } = await prompted("", "wake");
		await vi.waitFor(() => expect(n.count).toBe(1), { timeout: 10000 });
		await expect(owner.prompt("typed", collect().handlers)).rejects.toBeInstanceOf(AcpLostError);
		const first = owner.attachWake(collect().handlers, { quietMs: QUIET });
		await expect(owner.attachWake(collect().handlers, { quietMs: QUIET })).rejects.toBeInstanceOf(AcpLostError);
		await first;
	});

	it("answers a held request `cancelled` when the wake is abandoned or the owner closes, so AGY never waits on Pi", async () => {
		const requests: AcpOwnerRequestHandlers = { permission: async () => ({ outcome: { outcome: "selected", optionId: "allow" } }) };
		const { f, owner, n } = await prompted("", "wake-perm", requests);
		await vi.waitFor(() => expect(n.count).toBe(1), { timeout: 10000 });
		owner.abandonWake();
		await vi.waitFor(() => expect(f.rows().some(r => r.wakePermissionReply)).toBe(true), { timeout: 10000 });
		expect(f.rows().find(r => r.wakePermissionReply)?.wakePermissionReply).toEqual({ outcome: { outcome: "cancelled" } });
		await vi.waitFor(() => expect(n.count).toBe(2), { timeout: 10000 }); // AGY carries on after the refusal ("Not allowed."), which is a new wake
		const closing = await prompted("", "wake-perm", requests);
		await vi.waitFor(() => expect(closing.n.count).toBe(1), { timeout: 10000 });
		const outcome = await closing.owner.close();
		expect(outcome.classification).not.toBe("clean"); // a stop in the middle of a wake cannot be verified
		expect(closing.f.rows().find(r => r.wakePermissionReply)?.wakePermissionReply).toEqual({ outcome: { outcome: "cancelled" } });
	});

	it("fails an attached wake as lost when the child dies", async () => {
		const { f, owner, n } = await prompted("", "wake-long");
		await vi.waitFor(() => expect(n.count).toBe(1), { timeout: 10000 });
		const wake = owner.attachWake(collect().handlers, { quietMs: 5000 });
		await new Promise(r => setTimeout(r, 120));
		owner.child.kill("SIGKILL");
		await expect(wake).rejects.toBeInstanceOf(AcpLostError);
		expect(owner.state).toBe("ineligible");
		void f;
	});
});
