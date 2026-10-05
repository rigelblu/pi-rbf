// pi-43: last-message age selection, driven through the extension's own registered handlers.
// These cases replay Pi's public event order (message_start at delivery, agent_settled after
// persistence). The real delivery path on both Pi versions is rbf-status-line-age-pty.test.ts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FooterComponent } from "@earendil-works/pi-coding-agent";
import rbfStatusLine, { AGE_STATE_GETTER_KEY, unpatchFooterComponent, type AgeCue } from "./rbf-status-line.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 5, 11, 50); // "11:50"
const at = (minutes: number) => T0 + minutes * MIN;

type Entry = { type: string; message?: { role: string; timestamp?: unknown; content?: unknown } };
const user = (timestamp: unknown, text = "hello"): Entry => ({
	type: "message",
	message: { role: "user", timestamp, content: [{ type: "text", text }] },
});

function start(entries: Entry[] = [], options: { hasUI?: boolean; mode?: string } = {}) {
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	const api = {
		on: (event: string, handler: (...args: any[]) => any) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};
	const branch = { entries };
	const calls: string[] = [];
	// Only getBranch is a legal read; any write or other access fails the test.
	const sessionManager = new Proxy(
		{ getBranch: () => branch.entries },
		{
			get(target, key) {
				calls.push(String(key));
				if (key !== "getBranch") throw new Error(`age read sessionManager.${String(key)}`);
				return (target as any)[key];
			},
		},
	);
	const setStatus = vi.fn();
	const ctx = { hasUI: options.hasUI ?? true, mode: options.mode ?? "tui", ui: { setStatus, notify: vi.fn() }, sessionManager };
	rbfStatusLine(api as any);
	const emit = (event: string, payload: unknown = {}) => {
		for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
	};
	const cue = (): AgeCue | undefined => (FooterComponent.prototype as any)[AGE_STATE_GETTER_KEY]?.().cue(Date.now());
	const deliver = (message: { role: string; timestamp?: unknown; content?: unknown }) => emit("message_start", { message });
	const settle = (saved: Entry[]) => {
		branch.entries = saved;
		emit("agent_settled");
	};
	emit("session_start");
	return { handlers, branch, calls, setStatus, ctx, emit, cue, deliver, settle };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
	unpatchFooterComponent();
});
afterEach(() => {
	unpatchFooterComponent();
	vi.useRealTimers();
});

describe("age delivery", () => {
	it("shows a message delivered while idle from its native timestamp, not event arrival", () => {
		const s = start();
		expect(s.cue()).toBeUndefined();
		s.deliver(user(at(0)).message!);
		expect(s.cue()).toEqual({ text: "💬 <1m", kind: "timed" });

		// Image-only and question-form replies are ordinary user messages.
		const image = start();
		image.deliver({ role: "user", timestamp: at(0), content: [{ type: "image", data: "x" }] });
		expect(image.cue()?.text).toBe("💬 <1m");
	});

	it("includes the queue wait: a message stamped 5 minutes before delivery reads 5m at delivery", () => {
		const s = start([user(at(-30))]);
		expect(s.cue()?.text).toBe("💬 30m");
		// Queued at 11:50, still waiting at 11:55: nothing reaches the extension, the cue keeps the earlier age.
		vi.setSystemTime(at(5));
		expect(s.cue()?.text).toBe("💬 35m");
		s.deliver(user(at(0)).message!);
		expect(s.cue()?.text).toBe("💬 5m");
	});

	it("ignores assistant, tool and custom roles, including a custom message with no timestamp", () => {
		const s = start([user(at(-10))]);
		for (const role of ["assistant", "toolResult", "custom", "bashExecution"]) {
			s.deliver({ role, timestamp: at(0) });
			s.deliver({ role });
		}
		expect(s.cue()?.text).toBe("💬 10m");
	});

	it("shows ? when a delivered user timestamp is missing, negative or nonfinite", () => {
		for (const bad of [undefined, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
			const s = start([user(at(-10))]);
			s.deliver({ role: "user", timestamp: bad });
			expect(s.cue(), String(bad)).toEqual({ text: "💬 ?", kind: "unknown" });
			unpatchFooterComponent();
		}
	});

	it("observes no input, queue or command event", () => {
		const s = start();
		const observed = [...s.handlers.keys()].sort();
		expect(observed).toEqual(
			["agent_settled", "message_start", "session_compact", "session_shutdown", "session_start", "session_tree", "turn_end", "turn_start", "user_bash"].sort(),
		);
	});
});

describe("age submission order", () => {
	it("keeps the newest submitted message selected when an older follow-up is delivered later", () => {
		const P = user(at(0), "same text");
		const F = user(at(10), "same text"); // follow-up queued 12:00
		const S = user(at(11), "same text"); // steer queued 12:01
		const s = start([P]);
		vi.setSystemTime(at(12)); // 12:02
		expect(s.cue()?.text).toBe("💬 12m");

		s.deliver(S.message!);
		expect(s.cue()?.text).toBe("💬 1m");
		s.deliver(F.message!); // delivered last, submitted earlier
		expect(s.cue()?.text).toBe("💬 1m");

		s.settle([P, S, F]); // transcript ends with F
		expect(s.cue()?.text).toBe("💬 1m");

		unpatchFooterComponent();
		const resumed = start([P, S, F]);
		expect(resumed.cue()?.text).toBe("💬 1m");
	});

	it("gives equal age for equal timestamps", () => {
		const s = start([user(at(0)), user(at(0))]);
		vi.setSystemTime(at(3));
		s.deliver(user(at(0)).message!);
		expect(s.cue()?.text).toBe("💬 3m");
	});
});

describe("age withdrawal", () => {
	it("leaves the cue unchanged when queued messages are withdrawn or never delivered", () => {
		for (const delivered of [0, 1, 3]) {
			const saved = Array.from({ length: delivered }, (_, i) => user(at(-20 + i)));
			const s = start(saved);
			vi.setSystemTime(at(5));
			const before = s.cue();
			// A steer and a follow-up are queued at 11:53/11:54 and then cleared. Pi emits no
			// message_start for them; the only thing that happens is the turn settling.
			s.settle(saved);
			expect(s.cue(), `${delivered} delivered`).toEqual(before);
			expect(before?.text).toBe(delivered === 0 ? undefined : `💬 ${25 - (delivered - 1)}m`);
			unpatchFooterComponent();
		}
	});
});

describe("age branch and unusable time", () => {
	it("hides on an empty branch and follows the selected raw branch on tree navigation", () => {
		const s = start([]);
		expect(s.cue()).toBeUndefined();

		vi.setSystemTime(at(40));
		s.deliver(user(at(38)).message!);
		expect(s.cue()?.text).toBe("💬 2m");

		// Navigating to an older branch drops the delivered time: it belonged to the branch left.
		s.branch.entries = [user(at(0)), user(at(10))];
		s.emit("session_tree");
		expect(s.cue()?.text).toBe("💬 30m");
	});

	it("keeps a delivered time across compaction and reads user entries the model context omits", () => {
		const s = start([user(at(0))]);
		vi.setSystemTime(at(20));
		s.deliver(user(at(19)).message!);
		// Raw branch after compaction still holds the old user entry beside the summary.
		s.branch.entries = [user(at(0)), { type: "compaction" }];
		s.emit("session_compact");
		expect(s.cue()?.text).toBe("💬 1m");
		s.settle([user(at(0)), { type: "compaction" }, user(at(19))]);
		expect(s.cue()?.text).toBe("💬 1m");
	});

	it("shows ? for an unusable saved timestamp and when the branch cannot be read", () => {
		const s = start([user(at(0)), user("yesterday")]);
		expect(s.cue()?.text).toBe("💬 ?");

		unpatchFooterComponent();
		const broken = start([]);
		(broken.ctx as any).sessionManager = {
			getBranch: () => {
				throw new Error("boom");
			},
		};
		broken.emit("agent_settled");
		expect(broken.cue()?.text).toBe("💬 ?");
	});

	it("does nothing in print or RPC mode and nothing after shutdown", () => {
		for (const options of [{ hasUI: false, mode: "print" }, { hasUI: true, mode: "rpc" }, { hasUI: true, mode: "json" }]) {
			const headless = start([user(at(0))], options);
			headless.deliver(user(at(0)).message!);
			headless.settle([user(at(0))]);
			expect(headless.cue(), options.mode).toBeUndefined();
			expect(headless.setStatus, `${options.mode} must send no status request`).not.toHaveBeenCalled();
			expect(headless.calls, `${options.mode} must not read history`).toEqual([]);
			unpatchFooterComponent();
		}

		unpatchFooterComponent();
		const s = start([user(at(0))]);
		s.emit("session_shutdown");
		expect((FooterComponent.prototype as any)[AGE_STATE_GETTER_KEY]).toBeUndefined();
		s.deliver(user(at(5)).message!);
		s.emit("agent_settled");
		expect(s.cue()).toBeUndefined();
	});
});

describe("age privacy", () => {
	it("reads only the branch and writes nothing", () => {
		const s = start([user(at(0), "SENTINEL-TEXT")]);
		s.deliver({ role: "user", timestamp: at(1), content: [{ type: "text", text: "SENTINEL-TEXT" }] });
		s.settle([user(at(0), "SENTINEL-TEXT"), user(at(1), "SENTINEL-TEXT")]);
		vi.advanceTimersByTime(5 * MIN);
		expect(new Set(s.calls)).toEqual(new Set(["getBranch"]));
		expect(JSON.stringify(s.cue())).not.toContain("SENTINEL");
		for (const call of s.setStatus.mock.calls) expect(call[1]).toBeUndefined();
	});

	it("has no file, log or network write in the age source", () => {
		const source = readFileSync(resolve(import.meta.dirname, "rbf-status-line.ts"), "utf-8");
		const age = source.slice(source.indexOf("// Last-message age (pi-43)"));
		expect(age).not.toMatch(/writeFile|appendFile|createWriteStream|console\.|fetch\(|node:net|node:http|\.append/);
		// Feature state is numbers and flags: no message, content or text field is stored.
		expect(age).not.toMatch(/message\.content|message\.text|messages\.push/);
	});
});
