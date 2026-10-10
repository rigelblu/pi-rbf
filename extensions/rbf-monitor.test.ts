// pi-44.1: the delivery rules of `monitor`, unit half. Scenarios 10, 16, 19 and 20 of the pi-44 brief's
// `15_verification.md`; a test name's `15:N` is the line of the bullet it checks. The fakes are the ones that
// file's "Shared setup for the unit scenarios" describes: a fake `pi` that records `sendMessage` and
// `appendEntry` and lets the test emit Pi's events, fake timers, and a fake child the module really receives.
import { EventEmitter } from "node:events";
import * as childProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import rbfMonitor from "./rbf-monitor.ts";

// ─── The fake child, and the `spawn` that hands it to the module ───────────

class FakeChild extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	stdin = null;
	pid = 424242;
	exitCode: number | null = null;
	signalCode: string | null = null;
	/** Shared setup: unless a case says otherwise the child emits `spawn` on the next tick. */
	autoSpawn = true;
	kills: string[] = [];
	kill(signal: string = "SIGTERM"): boolean {
		this.kills.push(signal);
		return true;
	}
	unref(): void {}
	ref(): void {}
}

/** `vi.mock` is hoisted above the imports, so what it shares with the tests is hoisted with it. */
const spawnBox = vi.hoisted(() => ({ next: null as any, calls: [] as unknown[][] }));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const spawn = (...args: unknown[]) => {
		spawnBox.calls.push(args);
		const child = spawnBox.next;
		if (!child) throw new Error("test harness: spawn was called with no fake child prepared");
		// Node emits `spawn` on the tick after `spawn()` returns; so does the fake.
		if (child.autoSpawn) process.nextTick(() => child.emit("spawn"));
		return child;
	};
	return { ...actual, spawn, default: { ...actual, spawn } };
});

// ─── The fake `ctx` and the fake `pi` ──────────────────────────────────────

const CUSTOM_TYPE = "rbf-monitor";
const STEER = { triggerTurn: true, deliverAs: "steer" };
/** A command no real shell could run: a line that reaches the module can only have come from the fake child. */
const COMMAND = "rbf-monitor-unit-fixture --never-run";

type Sent = { message: any; options: any };

class FakeCtx {
	idle = true;
	branch: any[] = [];
	cwd = "/fake/cwd";
	hasUI = true;
	sessionManager = {
		getBranch: () => this.branch,
		getEntries: () => this.branch,
		getSessionId: () => "fake-session",
		getSessionFile: () => undefined,
	};
	ui = { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() };
	isIdle(): boolean {
		return this.idle;
	}
}

class FakePi {
	tools = new Map<string, any>();
	commands = new Map<string, any>();
	renderers = new Map<string, any>();
	handlers = new Map<string, Function[]>();
	busHandlers = new Map<string, Function[]>();
	sent: Sent[] = [];
	appended: Array<{ customType: string; data: any }> = [];
	userMessages: unknown[] = [];
	/** Shared setup: unless a case says otherwise the fake emits `message_end` for a message as soon as `sendMessage` is called with it. */
	autoMessageEnd = true;

	constructor(readonly ctx: FakeCtx) {}

	events = {
		on: (channel: string, handler: Function) => {
			this.busHandlers.set(channel, [...(this.busHandlers.get(channel) ?? []), handler]);
			return () => {};
		},
		emit: (channel: string, payload: unknown) => {
			for (const h of this.busHandlers.get(channel) ?? []) h(payload);
		},
	};

	on(event: string, handler: Function): void {
		this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
	}

	/** Emit one of Pi's events with the fake `ctx`, as Pi does. Returns what the module's handler returned. */
	async emit(type: string, fields: Record<string, unknown> = {}): Promise<any> {
		let result: any;
		for (const h of this.handlers.get(type) ?? []) {
			const r = await h({ type, ...fields }, this.ctx);
			if (r !== undefined) result = r;
		}
		return result;
	}

	/** `message_end` for a custom message, in the shape Pi emits it: the sent fields plus `role: "custom"`. */
	async messageEnd(message: any): Promise<void> {
		await this.emit("message_end", { message: { role: "custom", ...message, timestamp: Date.now() } });
	}

	sendMessage(message: any, options?: any): void {
		this.sent.push({ message, options });
		// Pi confirms on a later microtask, never inside the `sendMessage` call itself.
		if (this.autoMessageEnd) queueMicrotask(() => void this.messageEnd(message));
	}

	sendUserMessage(content: unknown): void {
		this.userMessages.push(content);
	}

	appendEntry(customType: string, data: any): void {
		this.appended.push({ customType, data });
	}

	registerTool(tool: any): void {
		this.tools.set(tool.name, tool);
	}
	registerCommand(name: string, command: any): void {
		this.commands.set(name, command);
	}
	registerMessageRenderer(type: string, renderer: any): void {
		this.renderers.set(type, renderer);
	}

	/** The data of every `rbf-monitor` entry of one kind, in the order it was appended. */
	entries(kind: string): any[] {
		return this.appended.filter((e) => e.customType === CUSTOM_TYPE && e.data?.kind === kind).map((e) => e.data);
	}
	/** The appended entries as `getBranch()` returns them from a session file. */
	asBranch(): any[] {
		return this.appended.map((e, i) => ({ type: "custom", customType: e.customType, data: e.data, id: `entry-${i}`, parentId: i ? `entry-${i - 1}` : null, timestamp: new Date().toISOString() }));
	}
}

const eventText = (id: unknown, ...lines: string[]) => `Monitor event from "d" (task ${id}):\n${lines.join("\n")}`;
const deadlineText = (id: unknown) => `Monitor "d" (task ${id}) reached its 1-second deadline and stopped after 0 events. Re-arm it if you still need the watch.`;
const stoppedText = (id: unknown) => `Monitor "d" (task ${id}) was stopped by Tomek from /monitors after 0 events. Ask him before you re-arm it.`;

// ─── The harness itself ────────────────────────────────────────────────────

describe("rbf-monitor unit harness", () => {
	afterEach(() => {
		spawnBox.next = null;
		spawnBox.calls.length = 0;
	});

	it("the fake child is what node:child_process spawn returns, the call is recorded, and `spawn` is emitted on the next tick", async () => {
		const child = new FakeChild();
		spawnBox.next = child;
		let spawned = false;
		child.once("spawn", () => (spawned = true));

		const returned = childProcess.spawn("bash", ["-c", COMMAND], { detached: true });

		expect(returned).toBe(child);
		expect(spawnBox.calls).toEqual([["bash", ["-c", COMMAND], { detached: true }]]);
		expect(spawned, "not inside the spawn call").toBe(false);
		await new Promise<void>((done) => process.nextTick(done));
		expect(spawned, "on the next tick").toBe(true);
	});
});

// ─── Scenarios 10, 16, 19, 20 ──────────────────────────────────────────────

describe("rbf-monitor delivery unit scenarios", () => {
	let pi: FakePi;
	let ctx: FakeCtx;
	let child: FakeChild;

	beforeEach(async () => {
		vi.useFakeTimers();
		// The module signals the watch's process group by pid. The pid is a fake, so no signal may leave the test.
		vi.spyOn(process, "kill").mockImplementation(() => true);
		spawnBox.calls.length = 0;
		child = new FakeChild();
		spawnBox.next = child;
		ctx = new FakeCtx();
		pi = new FakePi(ctx);
		rbfMonitor(pi as any);
		await pi.emit("session_start", { reason: "startup" });
	});

	afterEach(() => {
		spawnBox.next = null;
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	/** Arm one watch `d` on the fake child. The task id is random, so it's read from the `armed` entry. */
	async function arm(timeoutMs?: number): Promise<{ id: string | undefined; armedAt: number | undefined }> {
		const params = { command: COMMAND, description: "d", ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }) };
		await pi.tools.get("monitor").execute("call-1", params, undefined, undefined, ctx);
		const armed = pi.entries("armed")[0];
		return { id: armed?.id, armedAt: armed?.at };
	}
	/** The fake child prints one line. */
	const print = (text: string) => child.stdout.emit("data", Buffer.from(`${text}\n`));
	const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
	/** One line, and the 200 ms batch window: "a batch that closes". */
	async function batch(text: string): Promise<void> {
		print(text);
		await advance(200);
	}
	/** Finding 1's check, at the end of a test that got its events: the module armed through the recorder, once. */
	function expectArmedThroughTheRecorder(): void {
		expect(spawnBox.calls.length, "the module called the recorded spawn once").toBe(1);
		expect(JSON.stringify(spawnBox.calls[0]), "and passed it the watch's command").toContain(COMMAND);
	}

	// ─── Scenario 10 ─────────────────────────────────────────────────────────
	describe("Scenario 10: esc keeps the event", () => {
		/** The shared start: no `message_end` from the fake, a run active, and event `a` steered into it. */
		async function steerAThenEsc(): Promise<{ id: string | undefined; seqA: string }> {
			pi.autoMessageEnd = false;
			const { id } = await arm();
			ctx.idle = false;
			await pi.emit("agent_start");
			await batch("a");

			expect(pi.sent.length, "15:189 event a gives call 1").toBe(1);
			expect(pi.sent[0]!.options, "15:189 call 1 is a steer").toEqual(STEER);
			expect(pi.sent[0]!.message.customType).toBe(CUSTOM_TYPE);
			expect(pi.sent[0]!.message.content).toBe(eventText(id, "a"));
			expect(pi.sent[0]!.message.details.seqs, "15:189 with one seq").toHaveLength(1);
			const seqA = pi.sent[0]!.message.details.seqs[0] as string;
			expect(typeof seqA).toBe("string");

			// Esc: the run ends, Pi never showed the steer, and Pi is idle again.
			await pi.emit("agent_end", { messages: [] });
			ctx.idle = true;
			await advance(5000);
			expect(pi.sent.length, "15:189 after agent_end nothing more is called: Esc starts no turn").toBe(1);
			return { id, seqA };
		}

		it("15:189 an event Pi cleared on Esc goes out first with the watch's next line, in one catch_up", async () => {
			const { id, seqA } = await steerAThenEsc();

			await batch("b");

			expect(pi.sent.length, "15:189 event b gives call 2").toBe(2);
			const call2 = pi.sent[1]!;
			expect(call2.message.content, "15:189 a's text, one blank line, then b's").toBe(`${eventText(id, "a")}\n\n${eventText(id, "b")}`);
			expect(call2.options).toEqual(STEER);
			expect(call2.message.details.kind).toBe("catch_up");
			expect(call2.message.details.seqs, "15:189 both seqs").toHaveLength(2);
			expect(call2.message.details.seqs[0], "15:189 a's seq first").toBe(seqA);
			expect(typeof call2.message.details.seqs[1]).toBe("string");
			expect(call2.message.details.seqs[1]).not.toBe(seqA);
			expect(call2.message.details.parts, "15:189 two parts").toHaveLength(2);
			expectArmedThroughTheRecorder();
		});

		it("15:190 message_end for the catch_up clears both: nothing is owed, and event c goes out alone", async () => {
			const { id, seqA } = await steerAThenEsc();
			await batch("b");
			expect(pi.sent.length, "15:190 call 2 carries a and b").toBe(2);

			await pi.messageEnd(pi.sent[1]!.message);

			// Asked here, before c: c is handed over with no message_end either, so after it c itself is owed (14:119).
			expect(await pi.emit("before_agent_start", { prompt: "p", systemPrompt: "" }), "15:190 both are cleared, so before_agent_start returns nothing").toBeUndefined();

			await batch("c");
			expect(pi.sent.length, "15:190 event c gives call 3").toBe(3);
			const call3 = pi.sent[2]!;
			expect(call3.message.content, "15:190 c alone").toBe(eventText(id, "c"));
			expect(call3.message.details.kind).toBe("event");
			expect(call3.message.details.seqs).toHaveLength(1);
			expect(call3.message.details.seqs[0]).not.toBe(seqA);
			expect(call3.message.details.seqs).not.toContain(pi.sent[1]!.message.details.seqs[1]);
			expectArmedThroughTheRecorder();
		});

		it("15:191 before_agent_start in place of event b returns event a, and returns it again while no message_end came", async () => {
			const { id, seqA } = await steerAThenEsc();

			const first = await pi.emit("before_agent_start", { prompt: "p", systemPrompt: "" });
			expect(first?.message, "15:191 before_agent_start returns { message }").toBeDefined();
			expect(first.message.customType).toBe(CUSTOM_TYPE);
			expect(first.message.content, "15:191 its content is event a").toBe(eventText(id, "a"));
			expect(first.message.details.seqs).toEqual([seqA]);

			const second = await pi.emit("before_agent_start", { prompt: "p", systemPrompt: "" });
			expect(second?.message, "15:191 a second before_agent_start returns it again").toBeDefined();
			expect(second.message.content).toBe(eventText(id, "a"));
			expect(second.message.details.seqs).toEqual([seqA]);
			expect(pi.sent.length, "15:191 it's returned, never sent").toBe(1);
			expectArmedThroughTheRecorder();
		});
	});

	// ─── Scenario 16 ─────────────────────────────────────────────────────────
	describe("Scenario 16: compaction hold", () => {
		/** One event, alone, handed over as every hand-off is. */
		function expectOneEventAlone(id: string | undefined, text: string, label: string): void {
			expect(pi.sent.length, `${label}: one call`).toBe(1);
			expect(pi.sent[0]!.message.content, `${label}: that event`).toBe(eventText(id, text));
			expect(pi.sent[0]!.message.details.kind, `${label}: alone`).toBe("event");
			expect(pi.sent[0]!.message.details.seqs, `${label}: alone`).toHaveLength(1);
			expect(pi.sent[0]!.options, `${label}: options`).toEqual(STEER);
		}

		it("15:266 while Pi can't take a message a closed batch is held, and goes out within 25 ms of Pi turning idle", async () => {
			const { id } = await arm();
			ctx.idle = false; // no agent_start: Pi can't take a message

			await batch("line1");
			expect(pi.sent.length, "15:266 a batch that closes makes no call").toBe(0);
			await advance(1000);
			expect(pi.sent.length, "15:266 advancing 1 second gives none").toBe(0);

			ctx.idle = true;
			await advance(25);
			expectOneEventAlone(id, "line1", "15:266 within 25 ms of isIdle() true");
			expectArmedThroughTheRecorder();
		});

		it("15:267 session_before_compact and session_compact around the batch change nothing", async () => {
			const { id } = await arm();
			ctx.idle = false;

			await pi.emit("session_before_compact", { reason: "manual", willRetry: false, branchEntries: [], preparation: {} });
			expect(pi.sent.length, "15:267 no call by the time session_before_compact returns").toBe(0);
			await batch("line1");
			expect(pi.sent.length, "15:267 the batch is held").toBe(0);
			await pi.emit("session_compact", { reason: "manual", willRetry: false, fromExtension: true, compactionEntry: {} });
			expect(pi.sent.length, "15:267 no call by the time session_compact returns").toBe(0);
			await advance(1000);
			expect(pi.sent.length, "15:267 none until isIdle() is true").toBe(0);

			ctx.idle = true;
			await advance(25);
			expectOneEventAlone(id, "line1", "15:267 once isIdle() is true");
			expectArmedThroughTheRecorder();
		});

		it("15:268 agent_start with isIdle() still false releases the held event one tick later, alone", async () => {
			const { id } = await arm();
			ctx.idle = false;
			await batch("line1");
			expect(pi.sent.length, "15:268 held while Pi can't take a message").toBe(0);

			await pi.emit("agent_start");
			expect(pi.sent.length, "14:202 the release never runs inside a Pi event handler").toBe(0);
			await advance(1);
			expectOneEventAlone(id, "line1", "15:268 one tick after agent_start");
			expectArmedThroughTheRecorder();
		});

		it("15:269 after agent_end with isIdle() still false a batch is held until Pi is idle", async () => {
			const { id } = await arm();
			ctx.idle = false;
			await pi.emit("agent_start");
			await pi.emit("agent_end", { messages: [] });

			await batch("line1");
			expect(pi.sent.length, "15:269 a run that's ending isn't a run a steer can join").toBe(0);
			await advance(1000);
			expect(pi.sent.length, "15:269 still none while isIdle() is false").toBe(0);

			ctx.idle = true;
			await advance(25);
			expectOneEventAlone(id, "line1", "15:269 within 25 ms of isIdle() true");
			expectArmedThroughTheRecorder();
		});

		it("15:270 two events held in one stretch go out in one catch_up, oldest first", async () => {
			const { id } = await arm();
			ctx.idle = false;
			await batch("line1");
			await batch("line2");
			expect(pi.sent.length, "15:270 both are held").toBe(0);

			ctx.idle = true;
			await advance(25);
			expect(pi.sent.length, "15:270 one call once Pi is idle").toBe(1);
			const { message, options } = pi.sent[0]!;
			expect(message.details.kind).toBe("catch_up");
			expect(message.details.parts, "15:270 two parts").toHaveLength(2);
			expect(message.details.parts[0].lines, "15:270 the oldest part first").toEqual(["line1"]);
			expect(message.details.parts[1].lines).toEqual(["line2"]);
			expect(message.details.seqs).toHaveLength(2);
			expect(message.content).toBe(`${eventText(id, "line1")}\n\n${eventText(id, "line2")}`);
			expect(options).toEqual(STEER);
			expectArmedThroughTheRecorder();
		});

		it("15:271 session_compact_failed with aborted false: the held event goes out within 25 ms of Pi turning idle", async () => {
			const { id } = await arm();
			ctx.idle = false;
			await batch("line1");
			await pi.emit("session_compact_failed", { reason: "manual", aborted: false, willRetry: false, fromExtension: false, errorMessage: "boom" });
			expect(pi.sent.length, "15:271 no call while isIdle() is false").toBe(0);

			ctx.idle = true;
			await advance(25);
			expectOneEventAlone(id, "line1", "15:271 within 25 ms, the same way");
			expectArmedThroughTheRecorder();
		});

		/** The shared start of 15:272: one event held, then the compaction aborted, then Pi idle. */
		async function heldThenAborted(): Promise<{ id: string | undefined }> {
			const { id } = await arm();
			ctx.idle = false;
			await batch("line1");
			await pi.emit("session_compact_failed", { reason: "manual", aborted: true, willRetry: false, fromExtension: false });
			ctx.idle = true;
			await advance(60_000);
			expect(pi.sent.length, "15:272 no call, however far the timers are advanced").toBe(0);
			return { id };
		}

		it("15:272 session_compact_failed with aborted true: no call, then a later event carries the held one first", async () => {
			const { id } = await heldThenAborted();

			await batch("line2");
			expect(pi.sent.length, "15:272 a later event gives one call").toBe(1);
			const { message } = pi.sent[0]!;
			expect(message.details.kind).toBe("catch_up");
			expect(message.details.parts).toHaveLength(2);
			expect(message.details.parts[0].lines, "15:272 the held event first").toEqual(["line1"]);
			expect(message.details.parts[1].lines).toEqual(["line2"]);
			expect(message.content).toBe(`${eventText(id, "line1")}\n\n${eventText(id, "line2")}`);
			expectArmedThroughTheRecorder();
		});

		it("15:272 session_compact_failed with aborted true, a second run: before_agent_start returns the held event instead", async () => {
			const { id } = await heldThenAborted();

			const returned = await pi.emit("before_agent_start", { prompt: "p", systemPrompt: "" });
			expect(returned?.message, "15:272 before_agent_start returns it").toBeDefined();
			expect(returned.message.customType).toBe(CUSTOM_TYPE);
			expect(returned.message.content).toBe(eventText(id, "line1"));
			expect(pi.sent.length, "15:272 returned, not sent").toBe(0);
			expectArmedThroughTheRecorder();
		});

		it("15:273 a deadline that fires while Pi can't take a message ends the watch at once and holds only its notice", async () => {
			const { id, armedAt } = await arm(1000);
			ctx.idle = false;

			await advance(1000);
			expect(pi.sent.length, "15:273 the notice is held").toBe(0);
			const ended = pi.entries("ended");
			expect(ended, "15:273 the watch ends at once: one ended entry at deadline time").toHaveLength(1);
			expect(ended[0]).toMatchObject({ id, armedAt, reason: "deadline", events: 0 });

			ctx.idle = true;
			await advance(25);
			expect(pi.sent.length, "15:273 only its notice goes out").toBe(1);
			expect(pi.sent[0]!.message.details.kind).toBe("deadline");
			expect(pi.sent[0]!.message.details.seqs).toHaveLength(1);
			expect(pi.sent[0]!.message.content).toBe(deadlineText(id));
			expect(pi.sent[0]!.options).toEqual(STEER);
			await advance(5000);
			expect(pi.sent.length, "15:273 and nothing else").toBe(1);
			expect(pi.entries("ended")).toHaveLength(1);
			expectArmedThroughTheRecorder();
		});
	});

	// ─── Scenario 19 ─────────────────────────────────────────────────────────
	describe("Scenario 19: compaction before a prompt", () => {
		it("15:304 input, then a compaction, then a batch: held through session_compact and before_agent_start, sent alone after agent_start", async () => {
			const { id } = await arm();

			await pi.emit("input", { text: "four", source: "interactive" });
			await pi.emit("session_before_compact", { reason: "threshold", willRetry: false, branchEntries: [], preparation: {} });
			await batch("line1");
			expect(pi.sent.length, "15:304 a batch that closes → no call").toBe(0);

			await pi.emit("session_compact", { reason: "threshold", willRetry: false, fromExtension: true, compactionEntry: {} });
			await advance(1);
			expect(pi.sent.length, "15:304 session_compact and one tick → still no call").toBe(0);

			expect(await pi.emit("before_agent_start", { prompt: "four", systemPrompt: "" }), "15:304 before_agent_start returns nothing").toBeUndefined();
			expect(pi.sent.length).toBe(0);

			ctx.idle = false;
			await pi.emit("agent_start");
			await advance(1);
			expect(pi.sent.length, "15:304 agent_start and one tick → one call").toBe(1);
			expect(pi.sent[0]!.message.content, "15:304 with that event alone").toBe(eventText(id, "line1"));
			expect(pi.sent[0]!.message.details.kind).toBe("event");
			expect(pi.sent[0]!.message.details.seqs).toHaveLength(1);
			expect(pi.sent[0]!.options).toEqual(STEER);
			expectArmedThroughTheRecorder();
		});

		it("15:305 a notice built under the hold is announced once", async () => {
			pi.autoMessageEnd = false;
			const { id, armedAt } = await arm(1000);

			await pi.emit("input", { text: "four", source: "interactive" });
			await advance(1000); // the watch's deadline fires under the hold
			expect(pi.sent.length, "15:305 the deadline fires under the hold → no call").toBe(0);
			expect(pi.entries("ended"), "15:305 and one ended entry").toHaveLength(1);
			expect(pi.entries("ended")[0]).toMatchObject({ id, armedAt, reason: "deadline" });

			ctx.branch = pi.asBranch(); // that watch's armed and ended entries, and no announced entry
			expect(ctx.branch.map((e) => e.data.kind)).toEqual(["armed", "ended"]);
			expect(await pi.emit("before_agent_start", { prompt: "four", systemPrompt: "" }), "15:305 before_agent_start returns nothing: the notice sits in held").toBeUndefined();

			ctx.idle = false;
			await pi.emit("agent_start");
			await advance(1);
			expect(pi.sent.length, "15:305 agent_start and one tick → one call").toBe(1);
			expect(pi.sent[0]!.message.content, "15:305 with the deadline notice").toBe(deadlineText(id));
			expect(pi.sent[0]!.message.details.kind).toBe("deadline");
			expect(pi.entries("announced"), "15:305 not announced before message_end").toHaveLength(0);

			await pi.messageEnd(pi.sent[0]!.message);
			expect(pi.entries("announced"), "15:305 message_end → exactly one announced entry").toHaveLength(1);
			expect(pi.entries("announced")[0]).toMatchObject({ id, armedAt, reason: "deadline" });

			ctx.branch = pi.asBranch();
			expect(await pi.emit("before_agent_start", { prompt: "next", systemPrompt: "" }), "15:305 a second before_agent_start returns nothing").toBeUndefined();
			await pi.emit("agent_end", { messages: [] });
			ctx.idle = true;
			await advance(5000);
			expect(pi.sent.length, "15:305 across the whole case: one notice").toBe(1);
			expect(pi.entries("announced"), "15:305 and one announced entry").toHaveLength(1);
			expect(pi.entries("ended")).toHaveLength(1);
			expectArmedThroughTheRecorder();
		});

		it("15:306 a notice in owed: /monitors stop <id> while idle, then before_agent_start twice returns the one notice with the same seq", async () => {
			pi.autoMessageEnd = false;
			const { id } = await arm();

			await pi.commands.get("monitors").handler(`stop ${id}`, ctx);
			expect(pi.sent.length, "15:306 stopped while Pi is idle: nothing is sent").toBe(0);

			ctx.branch = pi.asBranch();
			const first = await pi.emit("before_agent_start", { prompt: "p", systemPrompt: "" });
			expect(first?.message, "15:306 the first before_agent_start returns the notice").toBeDefined();
			expect(first.message.customType).toBe(CUSTOM_TYPE);
			expect(first.message.content, "15:306 the one stopped-by-Tomek notice").toBe(stoppedText(id));
			expect(first.message.details.kind).toBe("user_stop");
			expect(first.message.details.seqs).toHaveLength(1);

			ctx.branch = pi.asBranch();
			const second = await pi.emit("before_agent_start", { prompt: "p", systemPrompt: "" });
			expect(second?.message, "15:306 the second returns it too").toBeDefined();
			expect(second.message.content).toBe(stoppedText(id));
			expect(second.message.details.seqs, "15:306 with the same seq: neither builds a second").toEqual(first.message.details.seqs);
			expect(pi.entries("ended"), "15:306 one ending").toHaveLength(1);
			expect(pi.entries("ended")[0]).toMatchObject({ id, reason: "user_stop" });
			expect(pi.sent.length).toBe(0);
			expectArmedThroughTheRecorder();
		});
	});

	// ─── Scenario 20 ─────────────────────────────────────────────────────────
	describe("Scenario 20: typed prompt hold", () => {
		it("15:316 input while idle holds a closed batch until one tick after agent_start", async () => {
			const { id } = await arm();

			await pi.emit("input", { text: "four", source: "interactive" });
			await batch("line1");
			expect(pi.sent.length, "15:316 a batch that closes → no call").toBe(0);

			ctx.idle = false;
			await pi.emit("agent_start");
			await advance(1);
			expect(pi.sent.length, "15:316 agent_start and one tick → one call").toBe(1);
			expect(pi.sent[0]!.message.content, "15:316 with that event").toBe(eventText(id, "line1"));
			expect(pi.sent[0]!.options).toEqual(STEER);
			expectArmedThroughTheRecorder();
		});

		it("15:317 input with isIdle() false holds nothing: a closed batch is sent at once", async () => {
			const { id } = await arm();
			ctx.idle = false;
			await pi.emit("agent_start"); // a prompt typed during a turn

			await pi.emit("input", { text: "mid-turn", source: "interactive", streamingBehavior: "steer" });
			await batch("line1");
			expect(pi.sent.length, "15:317 one call at once").toBe(1);
			expect(pi.sent[0]!.message.content).toBe(eventText(id, "line1"));
			expect(pi.sent[0]!.options).toEqual(STEER);
			expectArmedThroughTheRecorder();
		});

		it("15:318 with no agent_start the hold ends at 15,000 ms: no call at 14,999, one call a tick after 15,000", async () => {
			const { id } = await arm();

			await pi.emit("input", { text: "four", source: "interactive" }); // 0 ms
			await batch("line1"); // closes at 200 ms
			await advance(14_799);
			expect(pi.sent.length, "15:318 no call at 14,999 ms").toBe(0);

			await advance(1); // 15,000 ms
			await advance(1); // and one tick
			expect(pi.sent.length, "15:318 at 15,000 ms and one tick, one call").toBe(1);
			expect(pi.sent[0]!.message.content).toBe(eventText(id, "line1"));
			expectArmedThroughTheRecorder();
		});

		it("15:319 a 16-second wait with no compaction ends the hold: a batch that closes at 16,000 ms is sent at once", async () => {
			const { id } = await arm();

			await pi.emit("input", { text: "four", source: "interactive" }); // 0 ms
			await advance(15_800);
			expect(pi.sent.length).toBe(0);
			await batch("line1"); // closes at 16,000 ms
			expect(pi.sent.length, "15:319 one call at once").toBe(1);
			expect(pi.sent[0]!.message.content).toBe(eventText(id, "line1"));
			expectArmedThroughTheRecorder();
		});

		/** 15:320 and 15:321 differ only in the event that ends the compaction at 11,000 ms. */
		async function holdClockPausesWhileCompacting(endCompaction: () => Promise<unknown>, label: string): Promise<void> {
			const { id } = await arm();

			await pi.emit("input", { text: "four", source: "interactive" }); // 0 ms, idle
			await advance(1000);
			ctx.idle = false;
			await pi.emit("session_before_compact", { reason: "threshold", willRetry: false, branchEntries: [], preparation: {} }); // 1,000 ms
			await advance(10_000);
			ctx.idle = true;
			await endCompaction(); // 11,000 ms

			await advance(4800);
			await batch("line1"); // closes at 16,000 ms: the clock has run for 6 of its 15 seconds
			expect(pi.sent.length, `${label} a batch that closes at 16,000 ms gives no call`).toBe(0);

			await advance(8999);
			expect(pi.sent.length, `${label} no call at 24,999 ms`).toBe(0);

			await advance(1); // 25,000 ms
			await advance(1); // and one tick
			expect(pi.sent.length, `${label} at 25,000 ms and one tick, one call`).toBe(1);
			expect(pi.sent[0]!.message.content).toBe(eventText(id, "line1"));
			expectArmedThroughTheRecorder();
		}

		it("15:320 a 16-second wait with a compaction inside it doesn't end the hold: the call comes at 25,000 ms", async () => {
			await holdClockPausesWhileCompacting(
				() => pi.emit("session_compact", { reason: "threshold", willRetry: false, fromExtension: true, compactionEntry: {} }),
				"15:320",
			);
		});

		it("15:321 the same with session_compact_failed and aborted false: the clock starts again, the call comes at 25,000 ms", async () => {
			await holdClockPausesWhileCompacting(
				() => pi.emit("session_compact_failed", { reason: "threshold", aborted: false, willRetry: false, fromExtension: false, errorMessage: "boom" }),
				"15:321",
			);
		});
	});
});

// ─── Scenarios 1 to 5, 12 to 15 (Unit Scenarios) ───────────────────────────

describe("Scenario 1: Lines become events — batching, order, size cap, cleaning", () => {
	let pi: FakePi;
	let ctx: FakeCtx;
	let child: FakeChild;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.spyOn(process, "kill").mockImplementation(() => true);
		spawnBox.calls.length = 0;
		child = new FakeChild();
		spawnBox.next = child;
		ctx = new FakeCtx();
		pi = new FakePi(ctx);
		rbfMonitor(pi as any);
		await pi.emit("session_start", { reason: "startup" });
	});

	afterEach(() => {
		spawnBox.next = null;
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	async function arm(description = "d", timeoutMs?: number): Promise<{ id: string; armedAt: number }> {
		const params = { command: COMMAND, description, ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }) };
		await pi.tools.get("monitor").execute("call-1", params, undefined, undefined, ctx);
		const armed = pi.entries("armed").slice(-1)[0];
		return { id: armed?.id, armedAt: armed?.at };
	}
	const print = (text: string) => child.stdout.emit("data", Buffer.from(`${text}\n`));
	const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
	async function batch(text: string): Promise<void> {
		print(text);
		await advance(200);
	}

	it("15:56 lines a, b at 0 ms and c at 150 ms give one sendMessage call at 200 ms whose content is Monitor event from d (task <id>):\\na\\nb\\nc", async () => {
		const { id } = await arm();
		print("a");
		print("b");
		await advance(150);
		print("c");
		expect(pi.sent.length, "15:56 no call before 200 ms").toBe(0);
		await advance(50);
		expect(pi.sent.length, "15:56 one call at 200 ms").toBe(1);
		expect(pi.sent[0]!.message.content, "15:56 content matches").toBe(eventText(id, "a", "b", "c"));
	});

	it("15:57 a line e at 250 ms gives a second call at 450 ms", async () => {
		const { id } = await arm();
		print("a");
		await advance(200);
		expect(pi.sent.length).toBe(1);
		await advance(50);
		print("e");
		await advance(199);
		expect(pi.sent.length, "15:57 no second call before 450 ms").toBe(1);
		await advance(1);
		expect(pi.sent.length, "15:57 second call at 450 ms").toBe(2);
		expect(pi.sent[1]!.message.content, "15:57 second call content").toBe(eventText(id, "e"));
	});

	it("15:58 a blank line and a stderr line give no call", async () => {
		await arm();
		print("   ");
		child.stderr.emit("data", Buffer.from("stderr line\n"));
		await advance(400);
		expect(pi.sent.length, "15:58 blank line and stderr line give no call").toBe(0);
	});

	it("15:59 57 lines at once give one call with 20 lines and a last line (37 more lines not shown)", async () => {
		const { id } = await arm();
		const lines = Array.from({ length: 57 }, (_, i) => `line-${i + 1}`);
		child.stdout.emit("data", Buffer.from(lines.join("\n") + "\n"));
		await advance(200);
		expect(pi.sent.length, "15:59 one call").toBe(1);
		const expectedLines = lines.slice(0, 20);
		expectedLines.push("(37 more lines not shown)");
		expect(pi.sent[0]!.message.content, "15:59 capped at 20 lines").toBe(eventText(id, ...expectedLines));
	});

	it("15:60 1,000 lines at once give one call with 20 lines and a last line (980 more lines not shown), and the watch is still running", async () => {
		const { id } = await arm();
		const lines = Array.from({ length: 1000 }, (_, i) => `line-${i + 1}`);
		child.stdout.emit("data", Buffer.from(lines.join("\n") + "\n"));
		await advance(200);
		expect(pi.sent.length, "15:60 one call").toBe(1);
		const expectedLines = lines.slice(0, 20);
		expectedLines.push("(980 more lines not shown)");
		expect(pi.sent[0]!.message.content, "15:60 capped at 20 lines").toBe(eventText(id, ...expectedLines));
		await batch("still-running");
		expect(pi.sent.length, "15:60 watch is still running").toBe(2);
		expect(pi.sent[1]!.message.content).toBe(eventText(id, "still-running"));
	});

	it("15:61 one 9,000-character line gives one call that holds the line's first 4,000 characters and no more lines line", async () => {
		const { id } = await arm();
		const longLine = "y".repeat(9000);
		print(longLine);
		await advance(200);
		expect(pi.sent.length, "15:61 one call").toBe(1);
		expect(pi.sent[0]!.message.content, "15:61 capped at 4000 chars").toBe(eventText(id, "y".repeat(4000)));
		expect(pi.sent[0]!.message.content, "15:61 no more lines line").not.toContain("more lines not shown");
	});

	it("15:62 two watches printing at 0 ms give two calls, each with its own description and task id", async () => {
		const child1 = child;
		const child2 = new FakeChild();
		spawnBox.next = child1;
		const w1 = await arm("d1");
		spawnBox.next = child2;
		const w2 = await arm("d2");

		child1.stdout.emit("data", Buffer.from("line1\n"));
		child2.stdout.emit("data", Buffer.from("line2\n"));
		await advance(200);

		expect(pi.sent.length, "15:62 two calls").toBe(2);
		const c1 = pi.sent.find((s) => s.message.content.startsWith(`Monitor event from "d1" (task ${w1.id}):\nline1`));
		const c2 = pi.sent.find((s) => s.message.content.startsWith(`Monitor event from "d2" (task ${w2.id}):\nline2`));
		expect(c1, "15:62 call for d1 starts with header").toBeDefined();
		expect(c2, "15:62 call for d2 starts with header").toBeDefined();
	});

	it("15:63 cleaning: multi-byte and ANSI/bell chunks cleaned in content, raw in log", async () => {
		const { id } = await arm();
		const fs = await import("node:fs");
		const chunk1 = Buffer.concat([Buffer.from("\x1b[31mred\x1b[0m caf"), Buffer.from([0xc3])]);
		const chunk2 = Buffer.concat([Buffer.from([0xa9]), Buffer.from("\x07 ok\r\n")]);
		child.stdout.emit("data", chunk1);
		child.stdout.emit("data", chunk2);
		await advance(200);

		expect(pi.sent.length, "15:63 one call").toBe(1);
		const content = pi.sent[0]!.message.content;
		const lines = content.split("\n");
		expect(lines[1], "15:63 second line is red café ok").toBe("red café ok");
		expect(content, "15:63 no escape").not.toContain("\x1b");
		expect(content, "15:63 no bell").not.toContain("\x07");
		expect(content, "15:63 no carriage return").not.toContain("\r");

		const logDir = "/tmp/pi-monitors/session-fake-session";
		const files = fs.readdirSync(logDir).filter((f) => f.startsWith(`${id}-`));
		expect(files.length, "15:63 log file exists").toBe(1);
		const rawLog = fs.readFileSync(`${logDir}/${files[0]}`);
		expect(rawLog, "15:63 raw bytes in log").toEqual(Buffer.concat([chunk1, chunk2]));
	});

	it("15:64 every call's options are steer, and details.seqs holds unique values", async () => {
		await arm();
		await batch("m1");
		await batch("m2");
		expect(pi.sent.length).toBe(2);
		expect(pi.sent[0]!.options, "15:64 steer options").toEqual(STEER);
		expect(pi.sent[1]!.options, "15:64 steer options").toEqual(STEER);
		const seq1 = pi.sent[0]!.message.details.seqs[0];
		const seq2 = pi.sent[1]!.message.details.seqs[0];
		expect(seq1, "15:64 unique seq 1").toBeDefined();
		expect(seq2, "15:64 unique seq 2").toBeDefined();
		expect(seq1, "15:64 unique seqs differ").not.toBe(seq2);
	});
});

describe("Scenario 2: Flood stop", () => {
	let pi: FakePi;
	let ctx: FakeCtx;
	let child: FakeChild;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.spyOn(process, "kill").mockImplementation(() => true);
		spawnBox.calls.length = 0;
		child = new FakeChild();
		spawnBox.next = child;
		ctx = new FakeCtx();
		pi = new FakePi(ctx);
		rbfMonitor(pi as any);
		await pi.emit("session_start", { reason: "startup" });
	});

	afterEach(() => {
		spawnBox.next = null;
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	async function arm(): Promise<{ id: string }> {
		const params = { command: COMMAND, description: "d" };
		await pi.tools.get("monitor").execute("call-1", params, undefined, undefined, ctx);
		const armed = pi.entries("armed")[0];
		return { id: armed?.id };
	}
	const print = (text: string) => child.stdout.emit("data", Buffer.from(`${text}\n`));
	const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

	it("15:72 10 events 1 second apart are all handed over; 11th stops watch and signals process group", async () => {
		const { id } = await arm();
		for (let i = 0; i < 10; i++) {
			print(`event-${i + 1}`);
			await advance(200);
			await advance(800);
		}
		expect(pi.sent.length, "15:72 10 events handed over").toBe(10);
		print("event-11");
		await advance(200);
		expect(pi.sent.length, "15:72 11th gives flood notice call").toBe(11);
		const notice = pi.sent[10]!.message.content;
		expect(notice, "15:72 flood notice content").toBe(
			`Monitor "d" (task ${id}) was stopped after 10 events: more than 10 arrived within 60 seconds. Tighten the filter so it prints only lines you would act on, then re-arm.`
		);
		expect(process.kill, "15:72 child process group was signalled").toHaveBeenCalledWith(-child.pid, "SIGTERM");
		print("after-flood");
		await advance(200);
		expect(pi.sent.length, "15:72 line after flood gives no call").toBe(11);
	});

	it("15:73 with no message_end emitted, watch still stops at 11th after 10 events", async () => {
		pi.autoMessageEnd = false;
		const { id } = await arm();
		ctx.idle = false;
		await pi.emit("agent_start");
		for (let i = 0; i < 10; i++) {
			print(`event-${i + 1}`);
			await advance(200);
			await advance(800);
		}
		expect(pi.sent.length).toBe(10);
		print("event-11");
		await advance(200);
		expect(pi.sent.length, "15:73 11th call is flood notice").toBe(11);
		expect(pi.sent[10]!.message.content).toBe(
			`Monitor "d" (task ${id}) was stopped after 10 events: more than 10 arrived within 60 seconds. Tighten the filter so it prints only lines you would act on, then re-arm.`
		);
	});

	it("15:74 while Pi can't take a message, stops at 11th, delivers 10 events + notice when idle", async () => {
		ctx.idle = false;
		const { id } = await arm();
		for (let i = 0; i < 10; i++) {
			print(`event-${i + 1}`);
			await advance(200);
			await advance(800);
		}
		print("event-11");
		await advance(200);
		expect(pi.sent.length, "15:74 no call while not idle").toBe(0);
		ctx.idle = true;
		await advance(25);
		expect(pi.sent.length, "15:74 one catch_up call within 25 ms").toBe(1);
		const call = pi.sent[0]!;
		expect(call.message.details.kind, "15:74 catch_up").toBe("catch_up");
		expect(call.message.details.parts.length, "15:74 10 events + notice = 11 parts").toBe(11);
		expect(call.message.details.parts[10].kind, "15:74 last part is flood notice").toBe("flood");
	});

	it("15:75 10 events, 61-second gap, and 10 more hands over all 20", async () => {
		await arm();
		for (let i = 0; i < 10; i++) {
			print(`event-${i + 1}`);
			await advance(200);
			await advance(800);
		}
		expect(pi.sent.length, "15:75 10 events sent").toBe(10);
		await advance(61_000);
		for (let i = 10; i < 20; i++) {
			print(`event-${i + 1}`);
			await advance(200);
			await advance(800);
		}
		expect(pi.sent.length, "15:75 all 20 events sent").toBe(20);
	});
});

describe("Scenario 3: Deadline and its limits", () => {
	let pi: FakePi;
	let ctx: FakeCtx;
	let child: FakeChild;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.spyOn(process, "kill").mockImplementation(() => true);
		spawnBox.calls.length = 0;
		child = new FakeChild();
		spawnBox.next = child;
		ctx = new FakeCtx();
		pi = new FakePi(ctx);
		rbfMonitor(pi as any);
		await pi.emit("session_start", { reason: "startup" });
	});

	afterEach(() => {
		spawnBox.next = null;
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	async function arm(timeoutMs?: number): Promise<{ id: string; resText: string }> {
		const params = { command: COMMAND, description: "d", ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }) };
		const res = await pi.tools.get("monitor").execute("call-1", params, undefined, undefined, ctx);
		const resText = (res as any)?.content?.[0]?.text ?? (typeof res === "string" ? res : "");
		const armed = pi.entries("armed")[0];
		return { id: armed?.id, resText };
	}
	const print = (text: string) => child.stdout.emit("data", Buffer.from(`${text}\n`));
	const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

	it("15:83 no timeout_ms: stops in 5 minutes, fires at 300000 ms with reached 5-minute deadline", async () => {
		const { id, resText } = await arm();
		expect(resText, "15:83 armed text").toContain("It stops in 5 minutes");
		await advance(299_999);
		expect(pi.sent.length, "15:83 no call before deadline").toBe(0);
		await advance(1);
		expect(pi.sent.length, "15:83 one call at deadline").toBe(1);
		expect(pi.sent[0]!.message.content, "15:83 deadline text").toBe(
			`Monitor "d" (task ${id}) reached its 5-minute deadline and stopped after 0 events. Re-arm it if you still need the watch.`
		);
	});

	it("15:84 timeout_ms 1800000 gives 30 minutes and 30-minute", async () => {
		const { id, resText } = await arm(1_800_000);
		expect(resText, "15:84 30 minutes").toContain("It stops in 30 minutes");
		await advance(1_800_000);
		expect(pi.sent[0]!.message.content, "15:84 30-minute deadline").toContain("reached its 30-minute deadline");
	});

	it("15:85 timeout_ms 99999999: capped at 3600000, 60 minutes", async () => {
		const { resText } = await arm(99_999_999);
		expect(resText, "15:85 60 minutes").toContain("It stops in 60 minutes");
		expect(resText, "15:85 capped").toContain(" timeout_ms was capped at 3600000.");
	});

	it("15:86 timeout_ms 5: raised to 1000, 1 second", async () => {
		const { resText } = await arm(5);
		expect(resText, "15:86 1 second").toContain("It stops in 1 second");
		expect(resText, "15:86 raised").toContain(" timeout_ms was raised to 1000.");
	});

	it("15:87 timeout_ms 90000: 90 seconds and 90-second", async () => {
		const { resText } = await arm(90_000);
		expect(resText, "15:87 90 seconds").toContain("It stops in 90 seconds");
		await advance(90_000);
		expect(pi.sent[0]!.message.content, "15:87 90-second").toContain("reached its 90-second deadline");
	});

	it("15:88 after one event handed over with no message_end, deadline says after 1 event", async () => {
		pi.autoMessageEnd = false;
		const { id } = await arm(3000);
		print("ev1");
		await advance(200);
		expect(pi.sent.length).toBe(1);
		await advance(2800);
		expect(pi.sent.length, "15:88 deadline fired").toBe(2);
		expect(pi.sent[1]!.message.content, "15:88 after 1 event").toContain(
			`Monitor "d" (task ${id}) reached its 3-second deadline and stopped after 1 event. Re-arm it if you still need the watch.`
		);
	});

	it("15:89 deadline fires once, nothing sent after it", async () => {
		await arm(3000);
		await advance(3000);
		expect(pi.sent.length, "15:89 deadline fired once").toBe(1);
		await advance(5000);
		print("after-deadline");
		await advance(200);
		expect(pi.sent.length, "15:89 nothing sent after deadline").toBe(1);
	});
});

describe("Scenario 4: Refusals and the 5-watch limit", () => {
	let pi: FakePi;
	let ctx: FakeCtx;
	let child: FakeChild;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.spyOn(process, "kill").mockImplementation(() => true);
		spawnBox.calls.length = 0;
		child = new FakeChild();
		spawnBox.next = child;
		ctx = new FakeCtx();
		pi = new FakePi(ctx);
		rbfMonitor(pi as any);
		await pi.emit("session_start", { reason: "startup" });
	});

	afterEach(() => {
		spawnBox.next = null;
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

	it("15:97 ws parameter refuses with Pass command instead, no spawn call", async () => {
		await expect(
			pi.tools.get("monitor").execute("call-1", { ws: "wss://x", command: COMMAND, description: "d" }, undefined, undefined, ctx)
		).rejects.toThrow("monitor in Pi doesn't support ws. Pass command instead: a shell command that prints one line per event.");
		expect(spawnBox.calls.length, "15:97 no spawn call").toBe(0);
	});

	it("15:98 empty command refuses with monitor needs a command, no spawn call", async () => {
		await expect(
			pi.tools.get("monitor").execute("call-1", { command: "  ", description: "d" }, undefined, undefined, ctx)
		).rejects.toThrow("monitor needs a command: a shell command that prints one line per event.");
		expect(spawnBox.calls.length, "15:98 no spawn call").toBe(0);
	});

	it("15:99 a sixth monitor with five running refuses naming all five, no spawn call", async () => {
		for (let i = 1; i <= 5; i++) {
			spawnBox.next = new FakeChild();
			await pi.tools.get("monitor").execute(`call-${i}`, { command: COMMAND, description: `d${i}` }, undefined, undefined, ctx);
		}
		expect(spawnBox.calls.length).toBe(5);
		await expect(
			pi.tools.get("monitor").execute("call-6", { command: COMMAND, description: "d6" }, undefined, undefined, ctx)
		).rejects.toThrow(/^monitor can't arm a sixth watch\. Five are running: "d1" \(task mon-.*\), "d2" \(task mon-.*\), "d3" \(task mon-.*\), "d4" \(task mon-.*\), "d5" \(task mon-.*\)\. Stop one with task_stop first\.$/);
		expect(spawnBox.calls.length, "15:99 no 6th spawn call").toBe(5);
	});

	it("15:100 fake child emitting error then close with code -2: rejects, watch list empty, no appendEntry/sendMessage", async () => {
		child.autoSpawn = false;
		const promise = pi.tools.get("monitor").execute("call-1", { command: COMMAND, description: "d" }, undefined, undefined, ctx);
		child.emit("error", new Error("spawn /bin/bash ENOENT"));
		child.emit("close", -2, null);
		await expect(promise).rejects.toThrow("monitor couldn't start the command: spawn /bin/bash ENOENT.");
		expect(pi.entries("armed").length, "15:100 watch list empty").toBe(0);
		await advance(1000);
		expect(pi.appended.length, "15:100 no appendEntry call").toBe(0);
		expect(pi.sent.length, "15:100 no sendMessage call").toBe(0);
	});

	it("15:101 real spawn with missing directory: rejects with ENOENT, watch list empty", async () => {
		const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
		const spy = vi.spyOn(childProcess, "spawn").mockImplementation(actual.spawn);
		ctx.cwd = "/path/does/not/exist/pi-44-verify";
		const promise = pi.tools.get("monitor").execute("call-1", { command: COMMAND, description: "d" }, undefined, undefined, ctx);
		await expect(promise).rejects.toThrow(/^monitor couldn't start the command: spawn .* ENOENT\.$/);
		expect(pi.entries("armed").length, "15:101 watch list empty").toBe(0);
		await advance(1000);
		expect(pi.appended.length, "15:101 no appendEntry").toBe(0);
		expect(pi.sent.length, "15:101 no sendMessage").toBe(0);
		spy.mockRestore();
	});

	it("15:102 spawn itself throwing ENOENT: same message, empty list", async () => {
		const spy = vi.spyOn(childProcess, "spawn").mockImplementation(() => {
			throw new Error("spawn /bin/bash ENOENT");
		});
		const promise = pi.tools.get("monitor").execute("call-1", { command: COMMAND, description: "d" }, undefined, undefined, ctx);
		await expect(promise).rejects.toThrow("monitor couldn't start the command: spawn /bin/bash ENOENT.");
		expect(pi.entries("armed").length, "15:102 empty list").toBe(0);
		spy.mockRestore();
	});

	it("15:103 fake child emitting neither event: execute is still pending", async () => {
		child.autoSpawn = false;
		let resolved = false;
		pi.tools.get("monitor").execute("call-1", { command: COMMAND, description: "d" }, undefined, undefined, ctx).then(() => {
			resolved = true;
		});
		await advance(500);
		expect(resolved, "15:103 execute still pending").toBe(false);
	});

	it("15:104 fake child emitting spawn: execute resolves with armed text, appendEntry armed follows", async () => {
		child.autoSpawn = false;
		const promise = pi.tools.get("monitor").execute("call-1", { command: COMMAND, description: "d" }, undefined, undefined, ctx);
		expect(pi.entries("armed").length, "15:104 no armed entry before spawn").toBe(0);
		child.emit("spawn");
		const res = await promise;
		const resText = (res as any)?.content?.[0]?.text ?? (typeof res === "string" ? res : "");
		expect(resText, "15:104 armed text").toContain('Watching "d" as task mon-');
		expect(pi.entries("armed").length, "15:104 one armed entry follows").toBe(1);
	});

	it("15:105 when both ws and an empty command are passed, ws message wins", async () => {
		await expect(
			pi.tools.get("monitor").execute("call-1", { ws: "wss://x", command: "   ", description: "d" }, undefined, undefined, ctx)
		).rejects.toThrow("monitor in Pi doesn't support ws. Pass command instead: a shell command that prints one line per event.");
	});

	it("15:106 no other refusal exists: object at sandbox lifecycle symbol arms normally", async () => {
		(globalThis as any)[Symbol.for("rbf.sandbox.lifecycle.v1")] = { restricted: true };
		const res = await pi.tools.get("monitor").execute("call-1", { command: COMMAND, description: "d" }, undefined, undefined, ctx);
		const resText = (res as any)?.content?.[0]?.text ?? (typeof res === "string" ? res : "");
		expect(resText, "15:106 arms normally").toContain('Watching "d" as task mon-');
		delete (globalThis as any)[Symbol.for("rbf.sandbox.lifecycle.v1")];
	});
});

describe("Scenario 5: Every ending happens once, with its exact text, and stays owed until Pi confirms it", () => {
	let pi: FakePi;
	let ctx: FakeCtx;
	let child: FakeChild;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.spyOn(process, "kill").mockImplementation(() => true);
		spawnBox.calls.length = 0;
		child = new FakeChild();
		spawnBox.next = child;
		ctx = new FakeCtx();
		pi = new FakePi(ctx);
		rbfMonitor(pi as any);
		await pi.emit("session_start", { reason: "startup" });
	});

	afterEach(() => {
		spawnBox.next = null;
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	async function arm(description = "d", timeoutMs?: number): Promise<{ id: string; armedAt: number }> {
		const params = { command: COMMAND, description, ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }) };
		await pi.tools.get("monitor").execute("call-1", params, undefined, undefined, ctx);
		const armed = pi.entries("armed").slice(-1)[0];
		return { id: armed?.id, armedAt: armed?.at };
	}
	const print = (text: string) => child.stdout.emit("data", Buffer.from(`${text}\n`));
	const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

	it("15:114 child closes with code 0 after ready 50 ms earlier: one call with event + exit notice, no stderr/log", async () => {
		const { id } = await arm("d");
		print("ready");
		await advance(50);
		child.stderr.emit("data", Buffer.from("stderr noise\n"));
		child.emit("close", 0, null);
		await advance(200);

		expect(pi.sent.length, "15:114 one call").toBe(1);
		const content = pi.sent[0]!.message.content;
		expect(content, "15:114 content matches").toBe(
			`Monitor event from "d" (task ${id}):\nready\nMonitor "d" (task ${id}) ended: its command exited with code 0 after 1 event.`
		);
		expect(content, "15:114 no stderr").not.toContain("Last stderr lines:");
		expect(content, "15:114 no log path").not.toContain("Log:");
		expect(pi.sent[0]!.options).toEqual(STEER);
		const ended = pi.entries("ended");
		expect(ended.length, "15:114 one ended entry").toBe(1);
		expect(ended[0]!.events, "15:114 ended entry has events: 1").toBe(1);
	});

	it("15:115 child closes with code 127 after stderr line: notice holds code 127, stderr line, and Log path", async () => {
		const { id, armedAt } = await arm("d");
		child.stderr.emit("data", Buffer.from("bash: line 1: nope: command not found\n"));
		child.emit("close", 127, null);
		await advance(200);

		expect(pi.sent.length, "15:115 one call").toBe(1);
		const expected = `Monitor "d" (task ${id}) ended: its command exited with code 127 after 0 events.\nLast stderr lines:\nbash: line 1: nope: command not found\nLog: /tmp/pi-monitors/session-fake-session/${id}-${armedAt}.log`;
		expect(pi.sent[0]!.message.content, "15:115 content matches").toBe(expected);
	});

	it("15:116 child closes with code 1 after 8 stderr lines of 100 chars: holds last 4 whole lines (400 chars reached)", async () => {
		const { id } = await arm("d");
		for (let i = 0; i < 8; i++) {
			child.stderr.emit("data", Buffer.from(`${String(i).repeat(100)}\n`));
		}
		child.emit("close", 1, null);
		await advance(200);

		const content = pi.sent[0]!.message.content;
		for (let i = 4; i < 8; i++) {
			expect(content, `15:116 contains line ${i}`).toContain(String(i).repeat(100));
		}
		for (let i = 0; i < 4; i++) {
			expect(content, `15:116 does not contain line ${i}`).not.toContain(String(i).repeat(100));
		}
	});

	it("15:117 child closes with code 1 after 8 stderr lines of 50 chars: holds last 5 whole lines", async () => {
		const { id } = await arm("d");
		for (let i = 0; i < 8; i++) {
			child.stderr.emit("data", Buffer.from(`${String(i).repeat(50)}\n`));
		}
		child.emit("close", 1, null);
		await advance(200);

		const content = pi.sent[0]!.message.content;
		for (let i = 3; i < 8; i++) {
			expect(content, `15:117 contains line ${i}`).toContain(String(i).repeat(50));
		}
		for (let i = 0; i < 3; i++) {
			expect(content, `15:117 does not contain line ${i}`).not.toContain(String(i).repeat(50));
		}
	});

	it("15:118 child closes with code 1 after one stderr line of 900 chars: holds line whole", async () => {
		const { id } = await arm("d");
		const line900 = "z".repeat(900);
		child.stderr.emit("data", Buffer.from(`${line900}\n`));
		child.emit("close", 1, null);
		await advance(200);

		expect(pi.sent[0]!.message.content, "15:118 900 chars intact").toContain(line900);
	});

	it("15:119 log path ends with /<task id>-<armed at>.log", async () => {
		const { id, armedAt } = await arm("d");
		child.emit("close", 1, null);
		await advance(200);
		expect(pi.sent[0]!.message.content, "15:119 log path format").toContain(`/${id}-${armedAt}.log`);
	});

	it("15:120 child closes with code 1 and nothing on stderr: It printed nothing to stderr", async () => {
		const { id, armedAt } = await arm("d");
		child.emit("close", 1, null);
		await advance(200);
		const expected = `Monitor "d" (task ${id}) ended: its command exited with code 1 after 0 events.\nIt printed nothing to stderr.\nLog: /tmp/pi-monitors/session-fake-session/${id}-${armedAt}.log`;
		expect(pi.sent[0]!.message.content, "15:120 nothing to stderr").toBe(expected);
	});

	it("15:121 child closes with signal SIGSEGV: was killed by SIGSEGV", async () => {
		const { id, armedAt } = await arm("d");
		child.emit("close", null, "SIGSEGV");
		await advance(200);
		const expected = `Monitor "d" (task ${id}) ended: its command was killed by SIGSEGV after 0 events.\nIt printed nothing to stderr.\nLog: /tmp/pi-monitors/session-fake-session/${id}-${armedAt}.log`;
		expect(pi.sent[0]!.message.content, "15:121 killed by signal").toBe(expected);
	});

	it("15:122 task_stop with id resolves with Stopped text, no sendMessage even on subsequent close", async () => {
		const { id } = await arm("d");
		const res = await pi.tools.get("task_stop").execute("stop-1", { task_id: id }, undefined, undefined, ctx);
		const resText = (res as any)?.content?.[0]?.text ?? (typeof res === "string" ? res : "");
		expect(resText, "15:122 confirmation").toBe(`Stopped "d" (task ${id}) after 0 events.`);
		expect(pi.sent.length, "15:122 no sendMessage").toBe(0);
		child.emit("close", 0, null);
		await advance(200);
		expect(pi.sent.length, "15:122 still no sendMessage on close").toBe(0);
	});

	it("15:123 task_stop with same id again resolves with No running watch has task id", async () => {
		const { id } = await arm("d");
		await pi.tools.get("task_stop").execute("stop-1", { task_id: id }, undefined, undefined, ctx);
		const res2 = await pi.tools.get("task_stop").execute("stop-2", { task_id: id }, undefined, undefined, ctx);
		const resText2 = (res2 as any)?.content?.[0]?.text ?? (typeof res2 === "string" ? res2 : "");
		expect(resText2, "15:123 not running").toBe(`No running watch has task id "${id}". No watches are running.`);
	});

	it("15:124 task_stop with mon-0000 while one runs: Running: d (task <id>)", async () => {
		const { id } = await arm("d");
		const res = await pi.tools.get("task_stop").execute("stop-1", { task_id: "mon-0000" }, undefined, undefined, ctx);
		const resText = (res as any)?.content?.[0]?.text ?? (typeof res === "string" ? res : "");
		expect(resText, "15:124 lists running watch").toBe(`No running watch has task id "mon-0000". Running: "d" (task ${id}).`);
	});

	it("15:125 /monitors stop <id> while idle appends ended entry, delivered with before_agent_start", async () => {
		const { id } = await arm("d");
		await pi.commands.get("monitors").handler(`stop ${id}`, ctx);
		expect(pi.sent.length, "15:125 no sendMessage call").toBe(0);
		const ended = pi.entries("ended");
		expect(ended.length, "15:125 one ended entry").toBe(1);
		expect(ended[0]!.reason, "15:125 reason user_stop").toBe("user_stop");
		const bas = await pi.emit("before_agent_start");
		expect(bas?.message?.content, "15:125 delivered in before_agent_start").toBe(stoppedText(id));
	});

	it("15:126 /monitors stop <id> during active run delivers one sendMessage call at once as steer", async () => {
		const { id } = await arm("d");
		ctx.idle = false;
		await pi.emit("agent_start");
		await pi.commands.get("monitors").handler(`stop ${id}`, ctx);
		expect(pi.sent.length, "15:126 one sendMessage call at once").toBe(1);
		expect(pi.sent[0]!.message.content, "15:126 stopped by Tomek content").toBe(stoppedText(id));
		expect(pi.sent[0]!.options, "15:126 options steer").toEqual(STEER);
	});

	it("15:127 deadline timer and child close firing in same tick give exactly one call", async () => {
		const { id } = await arm("d", 1000);
		child.emit("close", 0, null);
		await advance(1000);
		expect(pi.sent.length, "15:127 exactly one call").toBe(1);
	});

	it("15:128 four endings with no message_end give four ended entries; emitting message_end adds announced entries", async () => {
		pi.autoMessageEnd = false;
		// 1. Deadline
		spawnBox.next = new FakeChild();
		const w1 = await arm("w1", 1000);
		await advance(1000);

		// 2. Flood
		spawnBox.next = new FakeChild();
		const w2 = await arm("w2");
		for (let i = 0; i < 11; i++) {
			spawnBox.next.stdout.emit("data", Buffer.from(`line-${i}\n`));
			await advance(200);
		}

		// 3. Exit
		spawnBox.next = new FakeChild();
		const w3 = await arm("w3");
		spawnBox.next.emit("close", 0, null);
		await advance(200);

		// 4. User stop
		spawnBox.next = new FakeChild();
		const w4 = await arm("w4");
		await pi.commands.get("monitors").handler(`stop ${w4.id}`, ctx);

		expect(pi.entries("ended").length, "15:128 four ended entries").toBe(4);
		expect(pi.entries("announced").length, "15:128 zero announced entries").toBe(0);

		// Now emit message_end for each notice sent/queued
		for (const sent of pi.sent) {
			if (sent.message.details?.kind !== "event") {
				await pi.messageEnd(sent.message);
			}
		}
		// Also deliver the queued user_stop notice via before_agent_start and emit message_end
		const bas = await pi.emit("before_agent_start");
		if (bas?.message) {
			await pi.messageEnd(bas.message);
		}
		expect(pi.entries("announced").length, "15:128 four announced entries recorded").toBe(4);
		expect(pi.entries("announced")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "announced", id: w1.id, armedAt: w1.armedAt, reason: "deadline" }),
				expect.objectContaining({ kind: "announced", id: w2.id, armedAt: w2.armedAt, reason: "flood" }),
				expect.objectContaining({ kind: "announced", id: w3.id, armedAt: w3.armedAt, reason: "exit" }),
				expect.objectContaining({ kind: "announced", id: w4.id, armedAt: w4.armedAt, reason: "user_stop" }),
			]),
		);
	});

	it("15:129 fresh module with unannounced ended entry delivers notice on before_agent_start", async () => {
		const freshPi = new FakePi(ctx);
		rbfMonitor(freshPi as any);
		await freshPi.emit("session_start", { reason: "startup" });

		const branch = [
			{ type: "custom", customType: CUSTOM_TYPE, data: { kind: "armed", id: "mon-abc", at: 1000, description: "d", timeoutMs: 1000 } },
			{ type: "custom", customType: CUSTOM_TYPE, data: { kind: "ended", id: "mon-abc", armedAt: 1000, reason: "deadline", events: 0, notice: { timeoutMs: 1000, events: 0 } } },
		];
		ctx.branch = branch;

		const bas1 = await freshPi.emit("before_agent_start");
		expect(bas1?.message?.content, "15:129 returns deadline text").toBe(deadlineText("mon-abc"));

		// With announced entry on branch, returns nothing
		ctx.branch.push({ type: "custom", customType: CUSTOM_TYPE, data: { kind: "announced", id: "mon-abc", armedAt: 1000, reason: "deadline" } });
		const bas2 = await freshPi.emit("before_agent_start");
		expect(bas2, "15:129 returns nothing when announced").toBeUndefined();

		// With second unannounced ended entry, returns that one
		ctx.branch.push(
			{ type: "custom", customType: CUSTOM_TYPE, data: { kind: "armed", id: "mon-abc", at: 2000, description: "d", timeoutMs: 1000 } },
			{ type: "custom", customType: CUSTOM_TYPE, data: { kind: "ended", id: "mon-abc", armedAt: 2000, reason: "deadline", events: 0, notice: { timeoutMs: 1000, events: 0 } } },
		);
		const bas3 = await freshPi.emit("before_agent_start");
		expect(bas3?.message?.content, "15:129 returns second unannounced notice").toBe(deadlineText("mon-abc"));
	});

	it("15:130 fresh module with empty branch returns nothing on before_agent_start", async () => {
		const freshPi = new FakePi(ctx);
		rbfMonitor(freshPi as any);
		ctx.branch = [];
		const bas = await freshPi.emit("before_agent_start");
		expect(bas, "15:130 returns nothing").toBeUndefined();
	});
});

describe("Scenario 12: Cleanup and fault tolerance (Unit)", () => {
	let pi: FakePi;
	let ctx: FakeCtx;
	let testSessionId: string;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.spyOn(process, "kill").mockImplementation(() => true);
		spawnBox.calls.length = 0;
		testSessionId = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		ctx = new FakeCtx();
		ctx.sessionManager = {
			getBranch: () => ctx.branch,
			getEntries: () => ctx.branch,
			getSessionId: () => testSessionId,
			getSessionFile: () => undefined,
		};
		pi = new FakePi(ctx);
		rbfMonitor(pi as any);
		await pi.emit("session_start", { reason: "startup" });
	});

	afterEach(async () => {
		const fsModule = (await import("node:fs")).default;
		const pathModule = await import("node:path");
		try {
			fsModule.rmSync(pathModule.join("/tmp/pi-monitors", `session-${testSessionId}`), { recursive: true, force: true });
		} catch {}
		spawnBox.next = null;
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("15:218 session_shutdown signals three watches with SIGKILL, clears timers, no sendMessage or appendEntry", async () => {
		const c1 = new FakeChild();
		const c2 = new FakeChild();
		const c3 = new FakeChild();
		spawnBox.next = c1;
		await pi.tools.get("monitor").execute("call-1", { command: COMMAND, description: "w1" }, undefined, undefined, ctx);
		spawnBox.next = c2;
		await pi.tools.get("monitor").execute("call-2", { command: COMMAND, description: "w2" }, undefined, undefined, ctx);
		spawnBox.next = c3;
		await pi.tools.get("monitor").execute("call-3", { command: COMMAND, description: "w3" }, undefined, undefined, ctx);

		const sentBefore = pi.sent.length;
		const appendedBefore = pi.appended.length;

		await pi.emit("session_shutdown");

		expect(process.kill, "15:218 c1 process group got SIGKILL").toHaveBeenCalledWith(-c1.pid, "SIGKILL");
		expect(process.kill, "15:218 c2 process group got SIGKILL").toHaveBeenCalledWith(-c2.pid, "SIGKILL");
		expect(process.kill, "15:218 c3 process group got SIGKILL").toHaveBeenCalledWith(-c3.pid, "SIGKILL");
		expect(pi.sent.length, "15:218 no sendMessage").toBe(sentBefore);
		expect(pi.appended.length, "15:218 no appendEntry").toBe(appendedBefore);
		expect(vi.getTimerCount(), "15:218 clears every timer").toBe(0);
	});

	it("15:219 throws inside stdout, stderr, close, error, timers, and Pi events are caught with no uncaught exception", async () => {
		const child = new FakeChild();
		spawnBox.next = child;
		await pi.tools.get("monitor").execute("call-1", { command: COMMAND, description: "w1", timeout_ms: 1000 }, undefined, undefined, ctx);

		// Emitting unexpected chunks / triggering edge cases does not throw
		expect(() => child.stdout.emit("data", null as any)).not.toThrow();
		expect(() => child.stderr.emit("data", null as any)).not.toThrow();
		expect(() => child.emit("error", new Error("late error"))).not.toThrow();
		await expect(pi.emit("session_compact_failed", null as any)).resolves.not.toThrow();
		await expect(pi.emit("before_agent_start", null as any)).resolves.not.toThrow();

		// Part 1: Deadline timer fires while appendEntry and sendMessage throw.
		// Make throws active first, then arm fresh watch, fire deadline with fake timers, assert watch ended and log got error text.
		const childDeadline = new FakeChild();
		spawnBox.next = childDeadline;
		const armDeadline = await pi.tools.get("monitor").execute("call-deadline", { command: COMMAND, description: "w-deadline", timeout_ms: 1000 }, undefined, undefined, ctx);
		const idDeadline = armDeadline.details.taskId;

		const origAppendEntry = pi.appendEntry;
		const origSendMessage = pi.sendMessage;

		pi.appendEntry = vi.fn().mockImplementation((type, data) => {
			if (data?.kind === "ended") {
				throw new Error("simulated appendEntry ended failure");
			}
			origAppendEntry.call(pi, type, data);
		});
		pi.sendMessage = vi.fn().mockImplementation(() => {
			throw new Error("simulated sendMessage deadline failure");
		});

		vi.advanceTimersByTime(1001);

		// Assert watch ended
		ctx.ui.notify.mockClear();
		await pi.commands.get("monitors").handler("", ctx);
		expect(ctx.ui.notify, "15:219 deadline watch ended, no watches running").toHaveBeenCalledWith("No watches running.", "info");

		// Assert log received error text
		const fsModule = (await import("node:fs")).default;
		const pathModule = await import("node:path");
		const sessionId = ctx.sessionManager?.getSessionId?.() ?? "default";
		const logDir = pathModule.join("/tmp/pi-monitors", `session-${sessionId}`);
		const deadlineLogName = fsModule.readdirSync(logDir).find((f) => f.startsWith(idDeadline));
		expect(deadlineLogName).toBeDefined();
		const deadlineLogContent = fsModule.readFileSync(pathModule.join(logDir, deadlineLogName!), "utf8");
		expect(deadlineLogContent).toContain("simulated sendMessage deadline failure");

		// Part 2: Arm another fresh watch and emit close while appendEntry and sendMessage throw.
		const childClose = new FakeChild();
		spawnBox.next = childClose;
		const armClose = await pi.tools.get("monitor").execute("call-close", { command: COMMAND, description: "w-close", timeout_ms: 5000 }, undefined, undefined, ctx);
		const idClose = armClose.details.taskId;

		pi.appendEntry = vi.fn().mockImplementation((type, data) => {
			if (data?.kind === "ended") {
				throw new Error("simulated appendEntry close failure");
			}
			origAppendEntry.call(pi, type, data);
		});
		pi.sendMessage = vi.fn().mockImplementation(() => {
			throw new Error("simulated sendMessage close failure");
		});

		childClose.emit("close", 0, null);

		// Assert watch ended
		ctx.ui.notify.mockClear();
		await pi.commands.get("monitors").handler("", ctx);
		expect(ctx.ui.notify, "15:219 close watch ended, no watches running").toHaveBeenCalledWith("No watches running.", "info");

		const closeLogName = fsModule.readdirSync(logDir).find((f) => f.startsWith(idClose));
		expect(closeLogName).toBeDefined();
		const closeLogContent = fsModule.readFileSync(pathModule.join(logDir, closeLogName!), "utf8");
		expect(closeLogContent).toContain("simulated sendMessage close failure");

		// Clean up mocks
		pi.appendEntry = origAppendEntry;
		pi.sendMessage = origSendMessage;
	});

	it("Required 2: caught error in release logs to monitor.log via logError without throwing", async () => {
		const fs = (await import("node:fs")).default;
		const appendSpy = vi.spyOn(fs, "appendFileSync");
		try {
			// Trigger promptHold so events are held
			await pi.emit("input");

			// Arm a watch and emit a line into held
			const child = new FakeChild();
			spawnBox.next = child;
			await pi.tools.get("monitor").execute("call-release-test", { command: COMMAND, description: "w-rel", timeout_ms: 10000 }, undefined, undefined, ctx);

			// Emit data while promptHold is true: item is placed in held, scheduleRelease(25) is armed
			child.stdout.emit("data", Buffer.from("held line\n"));

			// Advance batch window so flushBatch hands off the item to held
			vi.advanceTimersByTime(250);

			// Now make ctx.isIdle throw when release() runs and calls canTake()
			ctx.isIdle = vi.fn().mockImplementation(() => {
				throw new Error("simulated isIdle failure in release");
			});

			vi.advanceTimersByTime(25);

			const monitorLogCall = appendSpy.mock.calls.find((call) =>
				typeof call[0] === "string" && call[0].endsWith("monitor.log")
			);
			expect(monitorLogCall, "logError writes to session monitor.log").toBeDefined();
			expect(String(monitorLogCall![1]), "monitor.log contains error message").toContain("simulated isIdle failure in release");
		} finally {
			appendSpy.mockRestore();
			ctx.isIdle = () => true;
			await pi.emit("session_shutdown");
			await pi.emit("session_start", { reason: "startup" });
		}
	});

	it("Required 2: throw while handling stdout line logs error to watch log via logError", async () => {
		const fsModule = (await import("node:fs")).default;
		const pathModule = await import("node:path");
		const sessionId = ctx.sessionManager?.getSessionId?.() ?? "default";
		const logDir = pathModule.join("/tmp/pi-monitors", `session-${sessionId}`);

		// Part 1: throw during onStdout handling
		const child = new FakeChild();
		spawnBox.next = child;
		const armRes = await pi.tools.get("monitor").execute("call-stdout-test", { command: COMMAND, description: "w-stdout", timeout_ms: 10000 }, undefined, undefined, ctx);
		const id = armRes.details.taskId;

		const watches = (globalThis as any)[Symbol.for("rbf.monitor.watches.v1")];
		const watch = watches?.get(id);
		expect(watch).toBeDefined();

		watch.decoder.decode = vi.fn().mockImplementation(() => {
			throw new Error("simulated onStdout handling failure");
		});

		child.stdout.emit("data", Buffer.from("stdout event line\n"));

		const logName = fsModule.readdirSync(logDir).find((f) => f.startsWith(id));
		expect(logName).toBeDefined();
		const logContent = fsModule.readFileSync(pathModule.join(logDir, logName!), "utf8");
		expect(logContent).toContain("simulated onStdout handling failure");

		// Part 2: throw when batch fires and sendMessage is called
		const childBatch = new FakeChild();
		spawnBox.next = childBatch;
		const armResBatch = await pi.tools.get("monitor").execute("call-stdout-batch", { command: COMMAND, description: "w-stdout-batch", timeout_ms: 10000 }, undefined, undefined, ctx);
		const idBatch = armResBatch.details.taskId;

		const origSendMessage = pi.sendMessage;
		pi.sendMessage = vi.fn().mockImplementation(() => {
			throw new Error("simulated sendMessage stdout batch failure");
		});

		try {
			childBatch.stdout.emit("data", Buffer.from("stdout batch line\n"));
			vi.advanceTimersByTime(250);

			const logNameBatch = fsModule.readdirSync(logDir).find((f) => f.startsWith(idBatch));
			expect(logNameBatch).toBeDefined();
			const logContentBatch = fsModule.readFileSync(pathModule.join(logDir, logNameBatch!), "utf8");
			expect(logContentBatch).toContain("simulated sendMessage stdout batch failure");
		} finally {
			pi.sendMessage = origSendMessage;
		}
	});
});

describe("Scenario 13: /monitors and the badge wording (Unit)", () => {
	let pi: FakePi;
	let ctx: FakeCtx;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.spyOn(process, "kill").mockImplementation(() => true);
		spawnBox.calls.length = 0;
		ctx = new FakeCtx();
		pi = new FakePi(ctx);
		rbfMonitor(pi as any);
		await pi.emit("session_start", { reason: "startup" });
	});

	afterEach(() => {
		spawnBox.next = null;
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

	it("15:231 no watches: /monitors notifies No watches running., footer hook returns rows unchanged", async () => {
		await pi.commands.get("monitors").handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith("No watches running.", "info");

		const { FooterComponent } = await import("@earendil-works/pi-coding-agent");
		const regKey = Symbol.for("@earendil-works/pi-rbf:footer-registry");
		const reg = (FooterComponent.prototype as any)[regKey];
		const hook = reg?.hooks.get("monitor");
		const lines = ["header", "stats left    model right"];
		const rendered = hook ? hook.render.call({}, [...lines], 100) : lines;
		expect(rendered, "15:231 footer rows unchanged").toEqual(lines);
	});

	it("15:232 one watch 4m old with 3 events, 30m deadline: notify text format and stats row · 1 watch", async () => {
		const child = new FakeChild();
		spawnBox.next = child;
		await pi.tools.get("monitor").execute("call-1", { command: COMMAND, description: "d", timeout_ms: 1_800_000 }, undefined, undefined, ctx);
		const id = pi.entries("armed")[0].id;

		child.stdout.emit("data", Buffer.from("e1\n"));
		await advance(200);
		child.stdout.emit("data", Buffer.from("e2\n"));
		await advance(200);
		child.stdout.emit("data", Buffer.from("e3\n"));
		await advance(200);

		// Advance time so watch is 4 minutes old
		await advance(240_000 - 600); // 4 minutes total

		ctx.ui.notify.mockClear();
		await pi.commands.get("monitors").handler("", ctx);
		const expectedNotify = `${id} · d · running 4m · 3 events · stops in 26m\n/monitors stop <id> · /monitors stop all`;
		expect(ctx.ui.notify, "15:232 notify content").toHaveBeenCalledWith(expectedNotify, "info");

		const { FooterComponent } = await import("@earendil-works/pi-coding-agent");
		const regKey = Symbol.for("@earendil-works/pi-rbf:footer-registry");
		const reg = (FooterComponent.prototype as any)[regKey];
		const hook = reg?.hooks.get("monitor");
		const lines = ["header", "stats    gpt-4"];
		const rendered = hook.render.call({}, [...lines], 100);
		expect(rendered[1], "15:232 stats row gains · 1 watch").toContain("· 1 watch");
		const watchIdx = rendered[1].indexOf("· 1 watch");
		const modelIdx = rendered[1].lastIndexOf("gpt-4");
		expect(watchIdx, "15:232 watch before right-aligned model").toBeLessThan(modelIdx);
		expect(rendered[1].endsWith("gpt-4"), "15:232 right-aligned model at end").toBe(true);
	});

	it("15:233 one watch 40 seconds old with one event: running 40s · 1 event", async () => {
		const child = new FakeChild();
		spawnBox.next = child;
		await pi.tools.get("monitor").execute("call-1", { command: COMMAND, description: "d", timeout_ms: 300_000 }, undefined, undefined, ctx);
		const id = pi.entries("armed")[0].id;

		child.stdout.emit("data", Buffer.from("e1\n"));
		await advance(200);
		await advance(40_000 - 200);

		ctx.ui.notify.mockClear();
		await pi.commands.get("monitors").handler("", ctx);
		expect(ctx.ui.notify.mock.calls[0]![0], "15:233 40s and 1 event").toContain(`${id} · d · running 40s · 1 event`);
	});

	it("15:234 two watches: stats row gains · 2 watches, /monitors stop all notifies Stopped 2 watches.", async () => {
		const c1 = new FakeChild();
		const c2 = new FakeChild();
		spawnBox.next = c1;
		await pi.tools.get("monitor").execute("call-1", { command: COMMAND, description: "d1" }, undefined, undefined, ctx);
		spawnBox.next = c2;
		await pi.tools.get("monitor").execute("call-2", { command: COMMAND, description: "d2" }, undefined, undefined, ctx);

		const { FooterComponent } = await import("@earendil-works/pi-coding-agent");
		const regKey = Symbol.for("@earendil-works/pi-rbf:footer-registry");
		const reg = (FooterComponent.prototype as any)[regKey];
		const hook = reg?.hooks.get("monitor");
		const rendered = hook.render.call({}, ["header", "stats    gpt-4"], 100);
		expect(rendered[1], "15:234 stats row gains · 2 watches").toContain("· 2 watches");

		ctx.ui.notify.mockClear();
		await pi.commands.get("monitors").handler("stop all", ctx);
		expect(ctx.ui.notify, "15:234 Stopped 2 watches").toHaveBeenCalledWith("Stopped 2 watches.", "info");
	});

	it("15:235 /monitors stop <id>: No watches running. when empty; No running watch with id mon-0000. when watches run", async () => {
		// When no watches running:
		await pi.commands.get("monitors").handler("stop mon-0000", ctx);
		expect(ctx.ui.notify, "15:235 empty watches notification").toHaveBeenCalledWith(
			"No watches running.",
			"info",
		);

		// When one watch is running:
		spawnBox.next = new FakeChild();
		await pi.tools.get("monitor").execute("call-1", { command: COMMAND, description: "d" }, undefined, undefined, ctx);
		ctx.ui.notify.mockClear();
		await pi.commands.get("monitors").handler("stop mon-0000", ctx);
		expect(ctx.ui.notify, "15:235 unknown watch notification").toHaveBeenCalledWith(
			"No running watch with id mon-0000. Run /monitors to list them.",
			"info",
		);
	});

	it("15:236 /monitors nope notifies Usage line", async () => {
		await pi.commands.get("monitors").handler("nope", ctx);
		expect(ctx.ui.notify, "15:236 usage notification").toHaveBeenCalledWith(
			"Usage: /monitors · /monitors stop <id> · /monitors stop all",
			"info",
		);
	});

	it("15:237 with tasks and todos hooks in registry, unpatch leaves both in place and methods wrapped", async () => {
		const { FooterComponent } = await import("@earendil-works/pi-coding-agent");
		const regKey = Symbol.for("@earendil-works/pi-rbf:footer-registry");
		const reg = (FooterComponent.prototype as any)[regKey];
		reg.hooks.set("tasks", { id: "tasks", render: (l: any) => l, handleMouse: () => undefined });
		reg.hooks.set("todos", { id: "todos", render: (l: any) => l, handleMouse: () => undefined });

		await pi.emit("session_shutdown");

		expect(reg.hooks.has("tasks"), "15:237 tasks hook still in registry").toBe(true);
		expect(reg.hooks.has("todos"), "15:237 todos hook still in registry").toBe(true);
		expect(reg.hooks.has("monitor"), "15:237 monitor hook removed").toBe(false);
		expect((FooterComponent.prototype as any)[regKey], "15:237 registry still on prototype").toBeDefined();
		expect(FooterComponent.prototype.render, "15:237 render method still wrapped").toBe(reg.installedRender);
		expect((FooterComponent.prototype as any).handleMouse, "15:237 handleMouse method still wrapped").toBe(reg.installedHandleMouse);
	});
});

describe("Scenario 14: A narrow pane, and a long line (Unit)", () => {
	it("15:244 renderer given 300-char line: at width 100 rows <= 100 with └ and 4-space indents; at width 18 <= 18 and no └", async () => {
		const ctx = new FakeCtx();
		const pi = new FakePi(ctx);
		rbfMonitor(pi as any);

		const line300 = "w".repeat(300);
		const message = {
			customType: CUSTOM_TYPE,
			content: line300,
			details: {
				kind: "event",
				description: "gate watch",
				lines: [line300],
			},
		};

		const renderer = pi.renderers.get(CUSTOM_TYPE);
		expect(renderer, "15:244 message renderer registered").toBeDefined();
		const comp = renderer(message, { outputPad: 1 });

		// Width 100
		const rows100: string[] = comp.render(100);
		expect(rows100.length, "15:244 wrapped into multiple rows").toBeGreaterThan(2);
		for (const r of rows100) {
			expect(r.length, "15:244 row <= 100 cols").toBeLessThanOrEqual(100);
		}
		expect(rows100[1]!.startsWith(" └  "), "15:244 first row under header starts with └").toBe(true);
		for (let i = 2; i < rows100.length; i++) {
			expect(rows100[i]!.startsWith("    "), `15:244 row ${i} starts with 4 spaces`).toBe(true);
		}

		// Width 18
		const rows18: string[] = comp.render(18);
		for (const r of rows18) {
			expect(r.length, "15:244 row <= 18 cols").toBeLessThanOrEqual(18);
			expect(r, "15:244 narrow row contains no └").not.toContain("└");
		}

		// Failed-exit notice with 300-char stderr line
		const exitMessage = {
			customType: CUSTOM_TYPE,
			content: "exit notice",
			details: {
				kind: "exit",
				description: "gate watch",
				exitCode: 1,
				stderrTail: [line300],
				logPath: "/tmp/pi-monitors/session-xyz/mon-1234.log",
			},
		};
		const exitComp = renderer(exitMessage, { outputPad: 1 });
		const exitRows100: string[] = exitComp.render(100);
		for (const r of exitRows100) {
			expect(r.length, "15:244 exit row <= 100 cols").toBeLessThanOrEqual(100);
		}
		expect(exitRows100[1]!.startsWith(" └  "), "15:244 exit first row under header starts with └").toBe(true);

		const exitRows18: string[] = exitComp.render(18);
		for (const r of exitRows18) {
			expect(r.length, "15:244 exit row <= 18 cols").toBeLessThanOrEqual(18);
			expect(r, "15:244 exit narrow row contains no └").not.toContain("└");
		}
	});
});

describe("Scenario 15: Neighbouring features' contracts (Unit)", () => {
	beforeEach(() => {
		vi.spyOn(process, "kill").mockImplementation(() => true);
	});

	afterEach(() => {
		const watches = (globalThis as any)[Symbol.for("rbf.monitor.watches.v1")];
		if (watches instanceof Map) {
			watches.clear();
		}
		spawnBox.next = null;
		vi.restoreAllMocks();
	});

	it("15:252 across unit flows, fake pi records no sendUserMessage call and no pi.events emit", async () => {
		vi.useFakeTimers();
		try {
			const ctx = new FakeCtx();
			const pi = new FakePi(ctx);
			const emitSpy = vi.spyOn(pi.events, "emit");
			rbfMonitor(pi as any);
			await pi.emit("session_start", { reason: "startup" });

			// Run flows: arm, stdout lines, deliver event, and task_stop
			const child = new FakeChild();
			spawnBox.next = child;
			await pi.tools.get("monitor").execute("call-1", { command: COMMAND, description: "d", timeout_ms: 10000 }, undefined, undefined, ctx);
			child.stdout.emit("data", Buffer.from("line1\n"));
			await vi.advanceTimersByTimeAsync(200);

			await pi.tools.get("task_stop").execute("call-2", { task_id: pi.entries("armed")[0].id }, undefined, undefined, ctx);

			expect(pi.userMessages.length, "15:252 no sendUserMessage").toBe(0);
			expect(emitSpy, "15:252 no pi.events emit").not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("15:253 emit on rbf-background-tasks:busy/v1 with empty payload sets watch: true when watch runs, never answered", async () => {
		const ctx = new FakeCtx();
		const pi = new FakePi(ctx);
		rbfMonitor(pi as any);
		await pi.emit("session_start", { reason: "startup" });

		const busyEmpty: any = {};
		pi.events.emit("rbf-background-tasks:busy/v1", busyEmpty);
		expect(busyEmpty.watch, "15:253 no watch field when no watches").toBeUndefined();
		expect(busyEmpty.answered, "15:253 answered is never set").toBeUndefined();

		spawnBox.next = new FakeChild();
		await pi.tools.get("monitor").execute("call-1", { command: COMMAND, description: "d" }, undefined, undefined, ctx);

		const busyWithWatch: any = {};
		pi.events.emit("rbf-background-tasks:busy/v1", busyWithWatch);
		expect(busyWithWatch.watch, "15:253 watch: true while watch runs").toBe(true);
		expect(busyWithWatch.answered, "15:253 answered still not set").toBeUndefined();
	});

	it("15:256 every message sent or returned has customType: rbf-monitor and never role: user", async () => {
		vi.useFakeTimers();
		try {
			const ctx = new FakeCtx();
			const pi = new FakePi(ctx);
			rbfMonitor(pi as any);
			await pi.emit("session_start", { reason: "startup" });

			spawnBox.next = new FakeChild();
			await pi.tools.get("monitor").execute("call-1", { command: COMMAND, description: "d" }, undefined, undefined, ctx);
			spawnBox.next.stdout.emit("data", Buffer.from("test-line\n"));
			await vi.advanceTimersByTimeAsync(200);

			for (const sent of pi.sent) {
				expect(sent.message.customType, "15:256 customType is rbf-monitor").toBe(CUSTOM_TYPE);
				expect(sent.message.role, "15:256 never role user").not.toBe("user");
			}

			// Also verify message returned by before_agent_start
			const branch = [
				{ type: "custom", customType: CUSTOM_TYPE, data: { kind: "armed", id: "mon-abc", at: 1000, description: "d", timeoutMs: 1000 } },
				{ type: "custom", customType: CUSTOM_TYPE, data: { kind: "ended", id: "mon-abc", armedAt: 1000, reason: "deadline", events: 0, notice: { timeoutMs: 1000, events: 0 } } },
			];
			ctx.branch = branch;
			const bas = await pi.emit("before_agent_start");
			expect(bas?.message, "15:256 before_agent_start returned message").toBeDefined();
			expect(bas.message.customType, "15:256 before_agent_start customType is rbf-monitor").toBe(CUSTOM_TYPE);
			expect(bas.message.role, "15:256 before_agent_start never role user").not.toBe("user");
		} finally {
			vi.useRealTimers();
		}
	});

	it("Finding 5: handOff takes held events with it when taking wake (oldest first)", async () => {
		vi.useFakeTimers();
		try {
			const ctx = new FakeCtx();
			ctx.idle = false;
			const pi = new FakePi(ctx);
			rbfMonitor(pi as any);
			await pi.emit("session_start", { reason: "startup" });

			// Arm two watches
			const c1 = new FakeChild();
			spawnBox.next = c1;
			await pi.tools.get("monitor").execute("call-1", { command: COMMAND, description: "w1" }, undefined, undefined, ctx);
			const id1 = pi.entries("armed")[0].id;

			const c2 = new FakeChild();
			spawnBox.next = c2;
			await pi.tools.get("monitor").execute("call-2", { command: COMMAND, description: "w2" }, undefined, undefined, ctx);
			const id2 = pi.entries("armed")[1].id;

			// w1 prints "a" at t=0
			c1.stdout.emit("data", Buffer.from("a\n"));

			// advance 10 ms; w2 prints "b" at t=10
			await vi.advanceTimersByTimeAsync(10);
			c2.stdout.emit("data", Buffer.from("b\n"));

			// advance 190 ms (t=200): w1 batch closes -> handOff holds event a because Pi not idle (release timer set for t=225)
			await vi.advanceTimersByTimeAsync(190);
			expect(pi.sent.length, "nothing sent while not idle").toBe(0);

			// at t=205: Pi becomes idle
			await vi.advanceTimersByTimeAsync(5);
			ctx.idle = true;

			// at t=210: w2 batch closes before 25ms release timer (t=225) fires!
			await vi.advanceTimersByTimeAsync(5);

			// Assert handOff took held event a with b, oldest first!
			expect(pi.sent.length, "one wake call delivered").toBe(1);
			const sentMsg = pi.sent[0]!.message;
			expect(sentMsg.details.kind, "details.kind is catch_up").toBe("catch_up");
			expect(sentMsg.content, "oldest event a comes before b").toContain(`Monitor event from "w1" (task ${id1}):\na`);
			expect(sentMsg.content, "event b is included").toContain(`Monitor event from "w2" (task ${id2}):\nb`);
			const idxA = sentMsg.content.indexOf(`task ${id1}`);
			const idxB = sentMsg.content.indexOf(`task ${id2}`);
			expect(idxA, "event a before event b").toBeLessThan(idxB);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("Brief Reconciliation Items 1 to 6", () => {
	beforeEach(() => {
		vi.spyOn(process, "kill").mockImplementation(() => true);
	});

	afterEach(() => {
		const watches = (globalThis as any)[Symbol.for("rbf.monitor.watches.v1")];
		if (watches instanceof Map) {
			watches.clear();
		}
		delete (globalThis as any)[Symbol.for("@earendil-works/pi-coding-agent:theme")];
		delete (globalThis as any)[Symbol.for("@mariozechner/pi-coding-agent:theme")];
		spawnBox.next = null;
		vi.restoreAllMocks();
	});

	it("Reconciliation 1: registered tool descriptions match technical offer character for character", async () => {
		const ctx = new FakeCtx();
		const pi = new FakePi(ctx);
		rbfMonitor(pi as any);

		const expectedMonitorDesc = `Pi's Monitor: the tool Tomek's skills call "Monitor". Start a watch: run a shell command in the background and receive each line it prints to stdout as a message. Returns a task id once the command has started.

A line that arrives after your turn has ended starts a new turn for you. A line that arrives while you work reaches you after the running tool call.

- Use monitor when you want one notification per occurrence: a new chat message, a matching log line, a file that changes
- For a single notification, use a command that exits, for example \`until <check>; do sleep 5; done; echo ready\`. You are told when it exits
- Print only lines you would act on. Every line can start a model turn
- Filter for failure lines too, not only success lines. Silence is not success
- Flush each pipe stage per line or lines sit in a buffer: \`grep --line-buffered\`, awk \`fflush()\`
- Only stdout lines are events. Stderr goes to a log file. Lines printed within 200 ms arrive as one message
- If the command fails, the notice shows its last stderr lines and the log file's path
- timeout_ms is the deadline: 300000 (5 minutes) by default, 3600000 (1 hour) at most. At the deadline the watch stops and you get one notice. Re-arm it if you still need it
- A watch that sends more than 10 events in 60 seconds is stopped. At most 5 watches run at once
- A watch stops when Pi exits, reloads, or changes session. It is not re-armed for you. You are told with the next prompt
- Stop a watch with task_stop and its task id
- ws is not supported in Pi. Use command`;

		const expectedTaskStopDesc = `Pi's TaskStop: the tool Tomek's skills call "TaskStop". Stop a watch that monitor started. Pass the task id monitor returned. Returns whether a watch was stopped. In this version it stops watches only.`;

		const monitorTool = pi.tools.get("monitor");
		expect(monitorTool, "monitor tool registered").toBeDefined();
		expect(monitorTool.description).toBe(expectedMonitorDesc);

		const taskStopTool = pi.tools.get("task_stop");
		expect(taskStopTool, "task_stop tool registered").toBeDefined();
		expect(taskStopTool.description).toBe(expectedTaskStopDesc);

		expect(monitorTool.parameters.properties.command.description).toBe(
			"Shell command. Each line it prints to stdout is an event. When it exits, the watch ends",
		);
		expect(monitorTool.parameters.properties.description.description).toBe(
			"Short label shown in every event and every row",
		);
		expect(monitorTool.parameters.properties.timeout_ms.description).toBe(
			"Deadline. Default 300000. Above 3600000 it's capped at 3600000. Below 1000 it's raised to 1000",
		);
		expect(taskStopTool.parameters.properties.task_id.description).toBe(
			"The id monitor returned",
		);
	});

	it("Reconciliation 2: whitespace-only description falls back to first 40 characters of command", async () => {
		const ctx = new FakeCtx();
		const pi = new FakePi(ctx);
		rbfMonitor(pi as any);
		await pi.emit("session_start", { reason: "startup" });

		const monitorTool = pi.tools.get("monitor");
		expect(monitorTool.parameters.required).toEqual(["command", "description"]);

		const longCommand = "tail -n +1 -F /tmp/claude/agent-chat/pi-44-build/chat.md | grep test";
		const expectedDesc = longCommand.slice(0, 40);

		// Call row fallback check
		const callRow = monitorTool.renderCall(
			{ command: longCommand, description: "   \t  " },
			{ fg: (_role: string, t: string) => t, bold: (t: string) => t },
		);
		expect(callRow.text).toBe(`monitor ${expectedDesc}`);

		spawnBox.next = new FakeChild();
		const res = await monitorTool.execute("call-1", { command: longCommand, description: "   \t  " }, undefined, undefined, ctx);
		expect(res.details.description).toBe(expectedDesc);
		expect(res.content[0].text).toContain(`Watching "${expectedDesc}" as task`);

		const armedEntry = pi.entries("armed")[0];
		expect(armedEntry.description).toBe(expectedDesc);
	});

	it("Reconciliation 3: renderer and badge apply theme colour roles", async () => {
		const ctx = new FakeCtx();
		const pi = new FakePi(ctx);
		rbfMonitor(pi as any);
		await pi.emit("session_start", { reason: "startup" });

		const theme = {
			fg: vi.fn((role: string, text: string) => `[${role}]${text}[/${role}]`),
			bold: vi.fn((text: string) => `[bold]${text}[/bold]`),
		};

		const renderer = pi.renderers.get("rbf-monitor");
		expect(renderer).toBeDefined();

		// Event message
		const eventMsg = {
			customType: "rbf-monitor",
			content: "event content",
			details: {
				kind: "event",
				description: "gate watch",
				lines: ["line1"],
			},
		};
		const eventComp = renderer(eventMsg, { outputPad: 1 }, theme);
		eventComp.render(100);
		expect(theme.fg).toHaveBeenCalledWith("toolTitle", expect.any(String));
		expect(theme.fg).toHaveBeenCalledWith("muted", expect.stringContaining("event · gate watch"));
		expect(theme.fg).toHaveBeenCalledWith("dim", expect.stringContaining("└"));

		// Notice message with flood
		theme.fg.mockClear();
		const floodMsg = {
			customType: "rbf-monitor",
			content: "flood content",
			details: {
				kind: "flood",
				description: "gate watch",
			},
		};
		const floodComp = renderer(floodMsg, { outputPad: 1 }, theme);
		floodComp.render(100);
		expect(theme.fg).toHaveBeenCalledWith("muted", expect.stringContaining("stopped · gate watch"));
		expect(theme.fg).toHaveBeenCalledWith("error", expect.stringContaining("More than 10 events in 60 seconds"));

		// Notice message with failed exit
		theme.fg.mockClear();
		const exitMsg = {
			customType: "rbf-monitor",
			content: "exit content",
			details: {
				kind: "exit",
				description: "gate watch",
				exitCode: 1,
				stderrTail: ["err1"],
				logPath: "/tmp/log",
			},
		};
		const exitComp = renderer(exitMsg, { outputPad: 1 }, theme);
		exitComp.render(100);
		expect(theme.fg).toHaveBeenCalledWith("error", expect.stringContaining("Command exited with code 1"));
		expect(theme.fg).toHaveBeenCalledWith("muted", "err1");
		expect(theme.fg).toHaveBeenCalledWith("muted", "Log: /tmp/log");

		// Footer badge
		theme.fg.mockClear();
		(globalThis as any)[Symbol.for("@earendil-works/pi-coding-agent:theme")] = theme;
		const child = new FakeChild();
		spawnBox.next = child;
		await pi.tools.get("monitor").execute("call-1", { command: COMMAND, description: "d" }, undefined, undefined, ctx);

		const { FooterComponent } = await import("@earendil-works/pi-coding-agent");
		const regKey = Symbol.for("@earendil-works/pi-rbf:footer-registry");
		const reg = (FooterComponent.prototype as any)[regKey];
		const hook = reg?.hooks.get("monitor");
		hook.render.call({}, ["header", "stats    gpt-4"], 100);
		expect(theme.fg).toHaveBeenCalledWith("dim", expect.stringContaining("·"));
		expect(theme.fg).toHaveBeenCalledWith("accent", "1 watch");
	});

	it("Reconciliation 4: keepStderrTail keeps newest 100-char line and preceding 350-char line", async () => {
		const ctx = new FakeCtx();
		const pi = new FakePi(ctx);
		rbfMonitor(pi as any);
		await pi.emit("session_start", { reason: "startup" });

		const child = new FakeChild();
		spawnBox.next = child;
		const arm = await pi.tools.get("monitor").execute("call-1", { command: COMMAND, description: "d" }, undefined, undefined, ctx);
		const id = arm.details.taskId;

		const watches = (globalThis as any)[Symbol.for("rbf.monitor.watches.v1")];
		const watch = watches.get(id);

		const line350 = "b".repeat(350);
		const line100 = "a".repeat(100);

		child.stderr.emit("data", Buffer.from(`${line350}\n${line100}\n`));
		expect(watch.stderrTail).toEqual([line350, line100]);
	});

	it("Reconciliation 5: throw after child started ends watch, kills process group with SIGTERM, and returns refusal", async () => {
		vi.useFakeTimers();
		try {
			const ctx = new FakeCtx();
			const pi = new FakePi(ctx);
			rbfMonitor(pi as any);
			await pi.emit("session_start", { reason: "startup" });

			const child = new FakeChild();
			spawnBox.next = child;

			const origAppendEntry = pi.appendEntry;
			pi.appendEntry = vi.fn().mockImplementation((type, data) => {
				if (data?.kind === "armed") {
					throw new Error("simulated appendEntry armed failure");
				}
				origAppendEntry.call(pi, type, data);
			});

			await expect(
				pi.tools.get("monitor").execute("call-1", { command: COMMAND, description: "d" }, undefined, undefined, ctx)
			).rejects.toThrow("monitor couldn't start the command: simulated appendEntry armed failure.");

			// Verify no watch left in /monitors
			ctx.ui.notify.mockClear();
			await pi.commands.get("monitors").handler("", ctx);
			expect(ctx.ui.notify).toHaveBeenCalledWith("No watches running.", "info");

			// Verify process group got SIGTERM
			expect(process.kill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
		} finally {
			vi.useRealTimers();
		}
	});

	it("Reconciliation 6: armed row countdown and /monitors follow rounding rules", async () => {
		vi.useFakeTimers();
		try {
			const ctx = new FakeCtx();
			const pi = new FakePi(ctx);
			rbfMonitor(pi as any);
			await pi.emit("session_start", { reason: "startup" });

			spawnBox.next = new FakeChild();
			const armRes = await pi.tools.get("monitor").execute("call-1", { command: COMMAND, description: "d", timeout_ms: 1_800_000 }, undefined, undefined, ctx);

			const monitorTool = pi.tools.get("monitor");
			const theme = { fg: (_role: string, t: string) => t, bold: (t: string) => t } as any;

			// Initially rendered at t=0
			const row0 = monitorTool.renderResult(armRes, {}, theme);
			expect(row0.text).toContain("Watching · stops in 30m · task");

			// 1 s after arming a 30-minute watch -> stops in 30m
			vi.advanceTimersByTime(1_000);
			const row1s = monitorTool.renderResult(armRes, {}, theme);
			expect(row1s.text).toContain("Watching · stops in 30m · task");

			// 10 minutes later (600,000 ms total) -> stops in 20m
			vi.advanceTimersByTime(599_000);
			const row10m = monitorTool.renderResult(armRes, {}, theme);
			expect(row10m.text).toContain("Watching · stops in 20m · task");

			// 10 min + 1 s (601,000 ms total) -> stops in 20m
			vi.advanceTimersByTime(1_000);
			const row10m1s = monitorTool.renderResult(armRes, {}, theme);
			expect(row10m1s.text).toContain("Watching · stops in 20m · task");

			// Check running after 4 min 59 s -> 4m in /monitors
			spawnBox.next = new FakeChild();
			await pi.tools.get("monitor").execute("call-2", { command: COMMAND, description: "d2", timeout_ms: 600_000 }, undefined, undefined, ctx);
			vi.advanceTimersByTime(299_000);
			ctx.ui.notify.mockClear();
			await pi.commands.get("monitors").handler("", ctx);
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("running 4m"), "info");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("Final code review: limits and order under concurrency (Unit)", () => {
	beforeEach(() => {
		vi.spyOn(process, "kill").mockImplementation(() => true);
	});

	afterEach(() => {
		const watches = (globalThis as any)[Symbol.for("rbf.monitor.watches.v1")];
		if (watches instanceof Map) {
			watches.clear();
		}
		spawnBox.next = null;
		vi.restoreAllMocks();
	});

	it("15:99 two monitor calls in one message with four running: one arms, one is refused naming all five", async () => {
		const ctx = new FakeCtx();
		const pi = new FakePi(ctx);
		rbfMonitor(pi as any);
		await pi.emit("session_start", { reason: "startup" });
		const spawnsBefore = spawnBox.calls.length;
		for (let i = 1; i <= 4; i++) {
			spawnBox.next = new FakeChild();
			await pi.tools.get("monitor").execute(`call-${i}`, { command: COMMAND, description: `d${i}` }, undefined, undefined, ctx);
		}
		// Pi runs a message's tool calls in parallel: both start before either child has reported spawn
		spawnBox.next = new FakeChild();
		const fifth = pi.tools.get("monitor").execute("call-5", { command: COMMAND, description: "d5" }, undefined, undefined, ctx);
		spawnBox.next = new FakeChild();
		const sixth = pi.tools.get("monitor").execute("call-6", { command: COMMAND, description: "d6" }, undefined, undefined, ctx);
		const results = await Promise.allSettled([fifth, sixth]);

		expect(results[0]!.status, "the fifth arms").toBe("fulfilled");
		expect(results[1]!.status, "the sixth is refused").toBe("rejected");
		expect(String((results[1] as PromiseRejectedResult).reason?.message)).toMatch(
			/^monitor can't arm a sixth watch\. Five are running: "d1" \(task mon-.*\), "d2" \(task mon-.*\), "d3" \(task mon-.*\), "d4" \(task mon-.*\), "d5" \(task mon-.*\)\. Stop one with task_stop first\.$/,
		);
		expect(pi.entries("armed").length, "five armed entries, not six").toBe(5);
		expect(spawnBox.calls.length - spawnsBefore, "no sixth spawn call").toBe(5);
	});

	it("a refused start frees its slot: after a can't-start, a fifth watch still arms", async () => {
		const ctx = new FakeCtx();
		const pi = new FakePi(ctx);
		rbfMonitor(pi as any);
		await pi.emit("session_start", { reason: "startup" });
		for (let i = 1; i <= 4; i++) {
			spawnBox.next = new FakeChild();
			await pi.tools.get("monitor").execute(`call-${i}`, { command: COMMAND, description: `d${i}` }, undefined, undefined, ctx);
		}
		const bad = new FakeChild();
		bad.autoSpawn = false;
		spawnBox.next = bad;
		const failed = pi.tools.get("monitor").execute("call-bad", { command: COMMAND, description: "bad" }, undefined, undefined, ctx);
		bad.emit("error", new Error("spawn /bin/bash ENOENT"));
		bad.emit("close", -2, null);
		await expect(failed).rejects.toThrow("monitor couldn't start the command: spawn /bin/bash ENOENT.");

		spawnBox.next = new FakeChild();
		await pi.tools.get("monitor").execute("call-5", { command: COMMAND, description: "d5" }, undefined, undefined, ctx);
		expect(pi.entries("armed").length, "the fifth arms after a failed start").toBe(5);
	});

	it("R66 a stop notice owed while an older event is held arrives after that event, oldest first", async () => {
		vi.useFakeTimers();
		try {
			const ctx = new FakeCtx();
			ctx.idle = false;
			const pi = new FakePi(ctx);
			rbfMonitor(pi as any);
			await pi.emit("session_start", { reason: "startup" });

			const c1 = new FakeChild();
			spawnBox.next = c1;
			await pi.tools.get("monitor").execute("call-1", { command: COMMAND, description: "w1" }, undefined, undefined, ctx);
			const id1 = pi.entries("armed")[0].id;

			// Pi is neither idle nor running (a compaction): the event is held
			c1.stdout.emit("data", Buffer.from("a\n"));
			await vi.advanceTimersByTimeAsync(200);
			expect(pi.sent.length, "the event is held").toBe(0);

			// Tomek stops the watch while the event is still held: the notice is owed
			await pi.commands.get("monitors").handler(`stop ${id1}`, ctx);
			expect(pi.sent.length, "the stop notice starts no turn").toBe(0);

			// Pi turns idle; the release check hands both over in one message
			ctx.idle = true;
			await vi.advanceTimersByTimeAsync(25);
			expect(pi.sent.length, "one message").toBe(1);
			const content: string = pi.sent[0]!.message.content;
			const eventAt = content.indexOf(`Monitor event from "w1" (task ${id1}):\na`);
			const stopAt = content.indexOf("was stopped by Tomek");
			expect(eventAt, "the held event is in the message").toBeGreaterThanOrEqual(0);
			expect(stopAt, "the stop notice is in the message").toBeGreaterThanOrEqual(0);
			expect(eventAt, "the older event comes first").toBeLessThan(stopAt);
		} finally {
			vi.useRealTimers();
		}
	});

	/** R66's setup: event `a` held while Pi is neither idle nor running, then Tomek's stop notice owed. */
	async function heldEventThenOwedStop(): Promise<{ pi: FakePi; id1: string }> {
		const ctx = new FakeCtx();
		ctx.idle = false;
		const pi = new FakePi(ctx);
		rbfMonitor(pi as any);
		await pi.emit("session_start", { reason: "startup" });
		spawnBox.next = new FakeChild();
		const c1 = spawnBox.next;
		await pi.tools.get("monitor").execute("call-1", { command: COMMAND, description: "w1" }, undefined, undefined, ctx);
		const id1 = pi.entries("armed")[0].id;
		c1.stdout.emit("data", Buffer.from("a\n"));
		await vi.advanceTimersByTimeAsync(200);
		await pi.commands.get("monitors").handler(`stop ${id1}`, ctx);
		expect(pi.sent.length, "nothing sent yet").toBe(0);
		return { pi, id1 };
	}

	it("R66 a run that starts with a notice owed and an older event held carries both, oldest first", async () => {
		vi.useFakeTimers();
		try {
			const { pi, id1 } = await heldEventThenOwedStop();
			const result = await pi.emit("before_agent_start");
			const content: string = result?.message?.content ?? "";
			const eventAt = content.indexOf(`Monitor event from "w1" (task ${id1}):\na`);
			const stopAt = content.indexOf("was stopped by Tomek");
			expect(eventAt, "the held event is in the run's first message").toBeGreaterThanOrEqual(0);
			expect(stopAt, "the stop notice is in it").toBeGreaterThanOrEqual(0);
			expect(eventAt, "the older event comes first").toBeLessThan(stopAt);
			await pi.emit("agent_start");
			await vi.advanceTimersByTimeAsync(25);
			expect(pi.sent.length, "the event isn't sent a second time").toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("R66 after an aborted compaction the next run's message is oldest first", async () => {
		vi.useFakeTimers();
		try {
			const { pi, id1 } = await heldEventThenOwedStop();
			await pi.emit("session_compact_failed", { aborted: true });
			const result = await pi.emit("before_agent_start");
			const content: string = result?.message?.content ?? "";
			const eventAt = content.indexOf(`Monitor event from "w1" (task ${id1}):\na`);
			const stopAt = content.indexOf("was stopped by Tomek");
			expect(eventAt, "the held event is in the message").toBeGreaterThanOrEqual(0);
			expect(eventAt, "the older event comes first").toBeLessThan(stopAt);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a watch still starting when the session shuts down is killed, not registered", async () => {
		const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
		const ctx = new FakeCtx();
		const pi = new FakePi(ctx);
		rbfMonitor(pi as any);
		await pi.emit("session_start", { reason: "startup" });
		const child = new FakeChild();
		child.autoSpawn = false;
		spawnBox.next = child;
		const call = pi.tools.get("monitor").execute("call-1", { command: COMMAND, description: "late" }, undefined, undefined, ctx);
		await pi.emit("session_shutdown");
		child.emit("spawn");
		await expect(call).rejects.toThrow("monitor didn't start the command: the session ended first.");
		expect(kill, "the late child's process group got SIGKILL").toHaveBeenCalledWith(-child.pid, "SIGKILL");
		expect(pi.entries("armed").length, "no armed entry").toBe(0);
		const watches = (globalThis as any)[Symbol.for("rbf.monitor.watches.v1")];
		expect(watches.size, "no watch registered").toBe(0);
	});
});
