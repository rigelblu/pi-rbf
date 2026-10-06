import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import rbfMonitor from "./rbf-monitor.ts";

// ─── Fake Child & Fake Pi ──────────────────────────────────────────────────

class FakeChildProcess extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	pid = 12345;
	killed = false;
	exitCode: number | null = null;
	signalCode: string | null = null;

	kill(signal: string = "SIGTERM"): boolean {
		this.killed = true;
		this.signalCode = signal;
		return true;
	}
}

const spawnedCommands: Array<{ command: string; argsOrOptions: any; child: FakeChildProcess }> = [];
let nextChild: FakeChildProcess | null = null;

vi.mock("node:child_process", () => {
	return {
		spawn: vi.fn((command: string, argsOrOptions?: any, maybeOptions?: any) => {
			const child = nextChild ?? new FakeChildProcess();
			spawnedCommands.push({ command, argsOrOptions: argsOrOptions ?? maybeOptions, child });
			return child;
		}),
	};
});

class FakeCtx {
	idle = true;
	branchEntries: any[] = [];
	cwd = "/fake/cwd";
	sessionManager = {
		getBranch: () => this.branchEntries,
	};
	ui = {
		notify: vi.fn(),
	};
	isIdle(): boolean {
		return this.idle;
	}
}

class FakePi {
	tools = new Map<string, any>();
	commands = new Map<string, any>();
	messageRenderers = new Map<string, any>();
	handlers = new Map<string, Function[]>();
	eventBusHandlers = new Map<string, Function[]>();
	sentMessages: Array<{ message: any; options?: any }> = [];
	appendedEntries: Array<{ type: string; data: any }> = [];
	autoEmitMessageEnd = true;

	events = {
		on: (channel: string, handler: Function) => {
			const list = this.eventBusHandlers.get(channel) ?? [];
			list.push(handler);
			this.eventBusHandlers.set(channel, list);
		},
		emit: (channel: string, payload: any) => {
			for (const h of this.eventBusHandlers.get(channel) ?? []) {
				h(payload);
			}
		},
	};

	on(event: string, handler: Function): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	async emit(event: string, ...args: any[]): Promise<any> {
		let lastResult: any;
		for (const h of this.handlers.get(event) ?? []) {
			lastResult = await h(...args);
		}
		return lastResult;
	}

	async sendMessage(message: any, options?: any): Promise<void> {
		this.sentMessages.push({ message, options });
		if (this.autoEmitMessageEnd) {
			await this.emit("message_end", { message });
		}
	}

	appendEntry(type: string, data: any): void {
		this.appendedEntries.push({ type, data });
	}

	registerTool(tool: any): void {
		this.tools.set(tool.name, tool);
	}

	registerCommand(name: string, cmd: any): void {
		this.commands.set(name, cmd);
	}

	registerMessageRenderer(type: string, renderer: any): void {
		this.messageRenderers.set(type, renderer);
	}
}

// ─── Scenarios 10, 16, 19, 20 (Unit) ──────────────────────────────────────

describe("rbf-monitor delivery unit scenarios", () => {
	let fakePi: FakePi;
	let fakeCtx: FakeCtx;
	let fakeChild: FakeChildProcess;

	beforeEach(() => {
		vi.useFakeTimers();
		spawnedCommands.length = 0;
		fakePi = new FakePi();
		fakeCtx = new FakeCtx();
		fakeChild = new FakeChildProcess();
		nextChild = fakeChild;
		rbfMonitor(fakePi as any);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// Helper to arm a watch
	async function armWatch(description: string = "d", timeoutMs?: number): Promise<any> {
		const monitorTool = fakePi.tools.get("monitor");
		expect(monitorTool).toBeDefined();
		const p = monitorTool.execute("call-1", { command: "cmd", description, timeout_ms: timeoutMs }, undefined, undefined, fakeCtx);
		queueMicrotask(() => fakeChild.emit("spawn"));
		return p;
	}

	// ─── Scenario 10: Esc keeps the event ────────────────────────────────────
	describe("Scenario 10: esc keeps the event", () => {
		it("an event Pi cleared on Esc goes out first with the watch's next line as catch_up", async () => {
			fakePi.autoEmitMessageEnd = false;
			await armWatch("d");

			await fakePi.emit("agent_start", {}, fakeCtx);
			fakeCtx.idle = false;

			// Event 'a'
			fakeChild.stdout.emit("data", Buffer.from("a\n"));
			await vi.advanceTimersByTimeAsync(200);

			expect(fakePi.sentMessages.length).toBe(1);
			expect(fakePi.sentMessages[0]?.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
			const seq1 = fakePi.sentMessages[0]?.message.details?.seqs?.[0];
			expect(seq1).toBeDefined();

			// Agent end with idle true
			await fakePi.emit("agent_end", {}, fakeCtx);
			fakeCtx.idle = true;
			await vi.advanceTimersByTimeAsync(100);
			expect(fakePi.sentMessages.length).toBe(1); // Esc starts no turn

			// Event 'b'
			fakeChild.stdout.emit("data", Buffer.from("b\n"));
			await vi.advanceTimersByTimeAsync(200);

			expect(fakePi.sentMessages.length).toBe(2);
			const call2 = fakePi.sentMessages[1]!;
			expect(call2.message.content).toMatch(/Monitor event from "d" \(task [^)]+\):\na\n\nMonitor event from "d" \(task [^)]+\):\nb/);
			expect(call2.message.details.kind).toBe("catch_up");
			expect(call2.message.details.seqs).toEqual([seq1, expect.any(String)]);
			expect(call2.message.details.parts?.length).toBe(2);
		});

		it("emitting message_end for call 2 clears both, and event c arrives alone", async () => {
			fakePi.autoEmitMessageEnd = false;
			await armWatch("d");

			await fakePi.emit("agent_start", {}, fakeCtx);
			fakeCtx.idle = false;
			fakeChild.stdout.emit("data", Buffer.from("a\n"));
			await vi.advanceTimersByTimeAsync(200);

			await fakePi.emit("agent_end", {}, fakeCtx);
			fakeCtx.idle = true;
			fakeChild.stdout.emit("data", Buffer.from("b\n"));
			await vi.advanceTimersByTimeAsync(200);

			expect(fakePi.sentMessages.length).toBe(2);
			const call2 = fakePi.sentMessages[1]!;

			// Confirm call 2
			await fakePi.emit("message_end", { message: call2.message });

			// Event 'c'
			fakeChild.stdout.emit("data", Buffer.from("c\n"));
			await vi.advanceTimersByTimeAsync(200);

			expect(fakePi.sentMessages.length).toBe(3);
			const call3 = fakePi.sentMessages[2]!;
			expect(call3.message.content).toMatch(/Monitor event from "d" \(task [^)]+\):\nc$/);
			expect(call3.message.content).not.toContain("\na\n");

			const beforeStart = await fakePi.emit("before_agent_start", {}, fakeCtx);
			expect(beforeStart).toBeUndefined();
		});

		it("before_agent_start in place of event b returns owed event a, repeated before_agent_start returns it again", async () => {
			fakePi.autoEmitMessageEnd = false;
			await armWatch("d");

			await fakePi.emit("agent_start", {}, fakeCtx);
			fakeCtx.idle = false;
			fakeChild.stdout.emit("data", Buffer.from("a\n"));
			await vi.advanceTimersByTimeAsync(200);

			await fakePi.emit("agent_end", {}, fakeCtx);
			fakeCtx.idle = true;

			// before_agent_start instead of event b
			const res1 = await fakePi.emit("before_agent_start", {}, fakeCtx);
			expect(res1?.message?.content).toMatch(/Monitor event from "d" \(task [^)]+\):\na/);

			// Second before_agent_start without message_end
			const res2 = await fakePi.emit("before_agent_start", {}, fakeCtx);
			expect(res2?.message?.content).toMatch(/Monitor event from "d" \(task [^)]+\):\na/);
		});
	});

	// ─── Scenario 16: Compaction hold ────────────────────────────────────────
	describe("Scenario 16: compaction hold", () => {
		it("while Pi cannot take a message, batch is held until idle (within 25ms)", async () => {
			await armWatch("d");
			fakeCtx.idle = false; // Pi can't take a message

			fakeChild.stdout.emit("data", Buffer.from("line1\n"));
			await vi.advanceTimersByTimeAsync(200);
			expect(fakePi.sentMessages.length).toBe(0);

			await vi.advanceTimersByTimeAsync(1000);
			expect(fakePi.sentMessages.length).toBe(0);

			fakeCtx.idle = true;
			await vi.advanceTimersByTimeAsync(25);
			expect(fakePi.sentMessages.length).toBe(1);
			expect(fakePi.sentMessages[0]?.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
		});

		it("session_before_compact and session_compact around held batch change nothing until idle", async () => {
			await armWatch("d");
			fakeCtx.idle = false;

			await fakePi.emit("session_before_compact", {}, fakeCtx);
			fakeChild.stdout.emit("data", Buffer.from("line1\n"));
			await vi.advanceTimersByTimeAsync(200);

			await fakePi.emit("session_compact", {}, fakeCtx);
			expect(fakePi.sentMessages.length).toBe(0);

			fakeCtx.idle = true;
			await vi.advanceTimersByTimeAsync(25);
			expect(fakePi.sentMessages.length).toBe(1);
		});

		it("agent_start while message held delivers it 1 tick later as steer", async () => {
			await armWatch("d");
			fakeCtx.idle = false;

			fakeChild.stdout.emit("data", Buffer.from("line1\n"));
			await vi.advanceTimersByTimeAsync(200);
			expect(fakePi.sentMessages.length).toBe(0);

			await fakePi.emit("agent_start", {}, fakeCtx);
			await vi.advanceTimersByTimeAsync(1);
			expect(fakePi.sentMessages.length).toBe(1);
		});

		it("after agent_end with isIdle false, batch makes no call until idle", async () => {
			await armWatch("d");
			await fakePi.emit("agent_start", {}, fakeCtx);
			await fakePi.emit("agent_end", {}, fakeCtx);
			fakeCtx.idle = false;

			fakeChild.stdout.emit("data", Buffer.from("line1\n"));
			await vi.advanceTimersByTimeAsync(200);
			expect(fakePi.sentMessages.length).toBe(0);

			fakeCtx.idle = true;
			await vi.advanceTimersByTimeAsync(25);
			expect(fakePi.sentMessages.length).toBe(1);
		});

		it("two events held go out in one call once Pi is idle (catch_up)", async () => {
			await armWatch("d");
			fakeCtx.idle = false;

			fakeChild.stdout.emit("data", Buffer.from("line1\n"));
			await vi.advanceTimersByTimeAsync(200);
			fakeChild.stdout.emit("data", Buffer.from("line2\n"));
			await vi.advanceTimersByTimeAsync(200);
			expect(fakePi.sentMessages.length).toBe(0);

			fakeCtx.idle = true;
			await vi.advanceTimersByTimeAsync(25);
			expect(fakePi.sentMessages.length).toBe(1);
			expect(fakePi.sentMessages[0]?.message.details?.kind).toBe("catch_up");
			expect(fakePi.sentMessages[0]?.message.details?.parts?.length).toBe(2);
		});

		it("session_compact_failed with aborted: false releases held event on idle", async () => {
			await armWatch("d");
			fakeCtx.idle = false;

			fakeChild.stdout.emit("data", Buffer.from("line1\n"));
			await vi.advanceTimersByTimeAsync(200);

			await fakePi.emit("session_compact_failed", { aborted: false }, fakeCtx);
			fakeCtx.idle = true;
			await vi.advanceTimersByTimeAsync(25);
			expect(fakePi.sentMessages.length).toBe(1);
		});

		it("session_compact_failed with aborted: true keeps event for next event or before_agent_start", async () => {
			await armWatch("d");
			fakeCtx.idle = false;

			fakeChild.stdout.emit("data", Buffer.from("line1\n"));
			await vi.advanceTimersByTimeAsync(200);

			await fakePi.emit("session_compact_failed", { aborted: true }, fakeCtx);
			fakeCtx.idle = true;
			await vi.advanceTimersByTimeAsync(10000);
			expect(fakePi.sentMessages.length).toBe(0); // No call!

			// Later event carries held event
			fakeChild.stdout.emit("data", Buffer.from("line2\n"));
			await vi.advanceTimersByTimeAsync(200);
			expect(fakePi.sentMessages.length).toBe(1);
			expect(fakePi.sentMessages[0]?.message.details?.kind).toBe("catch_up");
		});

		it("deadline firing while Pi cannot take message ends watch and holds notice", async () => {
			await armWatch("d", 1000);
			fakeCtx.idle = false;

			await vi.advanceTimersByTimeAsync(1000); // Deadline fires
			expect(fakePi.sentMessages.length).toBe(0);

			fakeCtx.idle = true;
			await vi.advanceTimersByTimeAsync(25);
			expect(fakePi.sentMessages.length).toBe(1);
			expect(fakePi.sentMessages[0]?.message.details?.kind).toBe("deadline");
		});
	});

	// ─── Scenario 19: Compaction before a prompt ─────────────────────────────
	describe("Scenario 19: compaction before a prompt", () => {
		it("input then compaction holds batch; agent_start delivers event alone", async () => {
			await armWatch("d");
			fakeCtx.idle = true;

			await fakePi.emit("input", { text: "four" }, fakeCtx);
			await fakePi.emit("session_before_compact", {}, fakeCtx);

			fakeChild.stdout.emit("data", Buffer.from("line1\n"));
			await vi.advanceTimersByTimeAsync(200);
			expect(fakePi.sentMessages.length).toBe(0);

			await fakePi.emit("session_compact", {}, fakeCtx);
			await vi.advanceTimersByTimeAsync(1);
			expect(fakePi.sentMessages.length).toBe(0);

			const beforeStart = await fakePi.emit("before_agent_start", {}, fakeCtx);
			expect(beforeStart).toBeUndefined();

			fakeCtx.idle = false;
			await fakePi.emit("agent_start", {}, fakeCtx);
			await vi.advanceTimersByTimeAsync(1);
			expect(fakePi.sentMessages.length).toBe(1);
			expect(fakePi.sentMessages[0]?.message.content).toMatch(/line1/);
		});

		it("notice built under hold is announced once on agent_start, not by before_agent_start", async () => {
			await armWatch("d", 1000);
			fakeCtx.idle = true;

			await fakePi.emit("input", { text: "four" }, fakeCtx);
			await vi.advanceTimersByTimeAsync(1000); // Deadline fires under hold

			expect(fakePi.sentMessages.length).toBe(0);
			const endedEntries = fakePi.appendedEntries.filter((e) => e.data?.kind === "ended");
			expect(endedEntries.length).toBe(1);

			fakeCtx.branchEntries = [
				{ type: "rbf-monitor", ...fakePi.appendedEntries[0]?.data },
				{ type: "rbf-monitor", ...endedEntries[0]?.data },
			];

			const beforeStart = await fakePi.emit("before_agent_start", {}, fakeCtx);
			expect(beforeStart).toBeUndefined(); // Sits in held

			fakeCtx.idle = false;
			await fakePi.emit("agent_start", {}, fakeCtx);
			await vi.advanceTimersByTimeAsync(1);
			expect(fakePi.sentMessages.length).toBe(1);

			// message_end confirms
			await fakePi.emit("message_end", { message: fakePi.sentMessages[0]?.message });
			const announced = fakePi.appendedEntries.filter((e) => e.data?.kind === "announced");
			expect(announced.length).toBe(1);

			const beforeStart2 = await fakePi.emit("before_agent_start", {}, fakeCtx);
			expect(beforeStart2).toBeUndefined();
		});

		it("notice in owed returned by repeated before_agent_start with same seq", async () => {
			fakePi.autoEmitMessageEnd = false;
			await armWatch("d");
			fakeCtx.idle = true;

			// Stop from monitors while idle
			const monitorsCmd = fakePi.commands.get("monitors");
			expect(monitorsCmd).toBeDefined();
			const armedEntry = fakePi.appendedEntries.find((e) => e.data?.kind === "armed");
			const watchId = armedEntry?.data?.id ?? "mon-0001";
			await monitorsCmd.handler(`stop ${watchId}`, fakeCtx);

			const res1 = await fakePi.emit("before_agent_start", {}, fakeCtx);
			expect(res1?.message).toBeDefined();
			expect(res1?.message?.content).toMatch(/Stopped from \/monitors/);
			const seq = res1.message.details?.seqs?.[0];

			const res2 = await fakePi.emit("before_agent_start", {}, fakeCtx);
			expect(res2?.message).toBeDefined();
			expect(res2.message.details?.seqs?.[0]).toBe(seq);
		});
	});

	// ─── Scenario 20: Typed prompt hold ──────────────────────────────────────
	describe("Scenario 20: typed prompt hold", () => {
		it("input while idle holds batch until agent_start", async () => {
			await armWatch("d");
			fakeCtx.idle = true;

			await fakePi.emit("input", { text: "hello" }, fakeCtx);
			fakeChild.stdout.emit("data", Buffer.from("line1\n"));
			await vi.advanceTimersByTimeAsync(200);
			expect(fakePi.sentMessages.length).toBe(0);

			fakeCtx.idle = false;
			await fakePi.emit("agent_start", {}, fakeCtx);
			await vi.advanceTimersByTimeAsync(1);
			expect(fakePi.sentMessages.length).toBe(1);
		});

		it("input while not idle holds nothing, batch delivered at once", async () => {
			await armWatch("d");
			fakeCtx.idle = false;
			await fakePi.emit("agent_start", {}, fakeCtx);

			await fakePi.emit("input", { text: "mid-turn" }, fakeCtx);
			fakeChild.stdout.emit("data", Buffer.from("line1\n"));
			await vi.advanceTimersByTimeAsync(200);
			expect(fakePi.sentMessages.length).toBe(1);
		});

		it("15-second limit with no agent_start releases hold", async () => {
			await armWatch("d");
			fakeCtx.idle = true;

			await fakePi.emit("input", { text: "stuck" }, fakeCtx);
			fakeChild.stdout.emit("data", Buffer.from("line1\n"));
			await vi.advanceTimersByTimeAsync(200);

			await vi.advanceTimersByTimeAsync(14799); // total 14,999 ms
			expect(fakePi.sentMessages.length).toBe(0);

			await vi.advanceTimersByTimeAsync(2); // total 15,001 ms
			expect(fakePi.sentMessages.length).toBe(1);
		});

		it("16-second wait with no compaction ends hold", async () => {
			await armWatch("d");
			fakeCtx.idle = true;

			await fakePi.emit("input", { text: "stuck" }, fakeCtx);
			await vi.advanceTimersByTimeAsync(16000);

			fakeChild.stdout.emit("data", Buffer.from("line1\n"));
			await vi.advanceTimersByTimeAsync(200);
			expect(fakePi.sentMessages.length).toBe(1);
		});

		it("compaction pauses 15-second clock, releases at 25s", async () => {
			await armWatch("d");
			fakeCtx.idle = true;

			await fakePi.emit("input", { text: "compacting" }, fakeCtx); // t=0
			await vi.advanceTimersByTimeAsync(1000); // t=1,000

			fakeCtx.idle = false;
			await fakePi.emit("session_before_compact", {}, fakeCtx);

			await vi.advanceTimersByTimeAsync(10000); // t=11,000
			fakeCtx.idle = true;
			await fakePi.emit("session_compact", {}, fakeCtx);

			await vi.advanceTimersByTimeAsync(5000); // t=16,000 (clock has run 6s of 15s)
			fakeChild.stdout.emit("data", Buffer.from("line1\n"));
			await vi.advanceTimersByTimeAsync(200);
			expect(fakePi.sentMessages.length).toBe(0);

			await vi.advanceTimersByTimeAsync(8799); // total 24,999 ms
			expect(fakePi.sentMessages.length).toBe(0);

			await vi.advanceTimersByTimeAsync(2); // total 25,001 ms
			expect(fakePi.sentMessages.length).toBe(1);
		});

		it("session_compact_failed with aborted: false resumes clock, releases at 25s", async () => {
			await armWatch("d");
			fakeCtx.idle = true;

			await fakePi.emit("input", { text: "compacting" }, fakeCtx);
			await vi.advanceTimersByTimeAsync(1000);

			fakeCtx.idle = false;
			await fakePi.emit("session_before_compact", {}, fakeCtx);
			await vi.advanceTimersByTimeAsync(10000);

			fakeCtx.idle = true;
			await fakePi.emit("session_compact_failed", { aborted: false }, fakeCtx);

			await vi.advanceTimersByTimeAsync(5000);
			fakeChild.stdout.emit("data", Buffer.from("line1\n"));
			await vi.advanceTimersByTimeAsync(200);
			expect(fakePi.sentMessages.length).toBe(0);

			await vi.advanceTimersByTimeAsync(8800);
			expect(fakePi.sentMessages.length).toBe(1);
		});
	});
});
