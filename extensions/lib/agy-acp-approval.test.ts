import { createHook } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { startWireLog, type WireLogRun } from "../test-support/agy-wire-log-env.js";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	ACP_APPROVAL_BOUNDS,
	ACP_QUESTION_ERROR_MESSAGE,
	ACP_QUESTION_LINE,
	AGY_ACP_PERMISSION,
	AGY_ACP_QUESTION,
	AcpApprovalQueue,
	ApprovalDialog,
	approvalPresenter,
	extractAgyAcpQuestion,
	formatAgyAcpPermissionLine,
	formatAgyAcpQuestionLine,
	inertText,
	losslessWrap,
	parseAgyAcpPermission,
	parseAgyAcpQuestion,
	renderAgyAcpPermission,
	renderAgyAcpQuestion,
	type AgyAcpPermissionRecord,
	type ApprovalChoice,
	type ApprovalView,
} from "./agy-acp-approval.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => {
		resolve = done;
	});
	return { promise, resolve };
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const down = "\x1b[B";
const up = "\x1b[A";
const enter = "\r";
const esc = "\x1b";
const pageDown = "\x1b[6~";
const pageUp = "\x1b[5~";
const home = "\x1b[H";
const endKey = "\x1b[F";

function dialogView(overrides: Partial<ApprovalView> = {}): ApprovalView {
	return {
		toolCallId: "call_1",
		kind: "execute",
		title: "ls -1",
		command: "ls -1",
		cwd: "/workspace",
		details: "",
		pendingCount: () => 0,
		...overrides,
	};
}

function makeDialog(
	overrides: Partial<ApprovalView> = {},
	rows = 30,
	keybindings?: { matches?(data: string, id: string): boolean },
) {
	const finish = vi.fn();
	const redraw = vi.fn();
	const ui = new ApprovalDialog(
		dialogView(overrides),
		{
			rows: () => rows,
			redraw,
			paint: (_role, text) => text,
			keybindings,
		},
		finish,
	);
	return { ui, finish, redraw };
}

function permissionParams(toolCallId = "call_1540230168067533781", command = "ls -1") {
	return {
		sessionId: "acp-session-1",
		toolCall: {
			sessionUpdate: "tool_call",
			toolCallId,
			name: "run_command",
			args: {
				CommandLine: command,
				WaitMsBeforeAsync: 5000,
				toolSummary: "List directory contents",
			},
			status: "pending",
			kind: "execute",
			title: command,
			rawInput: {
				CommandLine: command,
				WaitMsBeforeAsync: 5000,
				toolSummary: "List directory contents",
			},
		},
		options: [
			{ optionId: "allow", name: "Allow", kind: "allow_once" },
			{ optionId: "deny", name: "Deny", kind: "reject_once" },
		],
	};
}

function makeQueueFixture(reviewTimeoutMs?: number) {
	const shown: ApprovalView[] = [];
	const signals: AbortSignal[] = [];
	const answers: ReturnType<typeof deferred<ApprovalChoice>>[] = [];
	const records: AgyAcpPermissionRecord[] = [];
	const pendingEvents: Array<{ toolCallId: string; waiting: boolean }> = [];
	const queue = new AcpApprovalQueue({
		piSessionId: "pi-session-1",
		acpSessionId: "acp-session-1",
		cwd: "/workspace",
		reviewTimeoutMs,
		onRecord: record => records.push(record),
		onPendingStateChange: (toolCallId, waiting) => pendingEvents.push({ toolCallId, waiting }),
		present: async (view, signal) => {
			shown.push(view);
			signals.push(signal);
			const answer = deferred<ApprovalChoice>();
			answers.push(answer);
			return answer.promise;
		},
	});
	return { queue, shown, signals, answers, records, pendingEvents };
}

const mockTheme = {
	fg: (role: string, text: string) => `[${role}]${text}`,
} as unknown as Theme;

describe("inertText and losslessWrap", () => {
	it("escapes C0, C1, DEL, ANSI CSI/OSC, bidi overrides, and zero-width characters while keeping newlines", () => {
		const raw = "\x00\x09\n\x1b[31mred\x1b]52;c;SECRET\x07\x7f\u0085\u009b\u061c\u200b\u200e\u2028\u202eabc\u2066\ufeff";
		const out = inertText(raw);
		expect(out).toContain("\n");
		for (const forbidden of ["\x00", "\x09", "\x1b", "\x07", "\x7f", "\u0085", "\u009b", "\u061c", "\u200b", "\u200e", "\u2028", "\u202e", "\u2066", "\ufeff"]) {
			expect(out).not.toContain(forbidden);
		}
		expect(out).toContain("\\u0000");
		expect(out).toContain("\\u0009");
		expect(out).toContain("\\u001b");
		expect(out).toContain("\\u0007");
		expect(out).toContain("\\u007f");
		expect(out).toContain("\\u0085");
		expect(out).toContain("\\u009b");
		expect(out).toContain("\\u061c");
		expect(out).toContain("\\u200b");
		expect(out).toContain("\\u200e");
		expect(out).toContain("\\u2028");
		expect(out).toContain("\\u202e");
		expect(out).toContain("\\u2066");
		expect(out).toContain("\\ufeff");
	});

	it("preserves every whitespace character and grapheme across wrap boundaries", () => {
		const text = "x".repeat(36) + " ".repeat(45) + "tail 漢字 e\u0301";
		const lines = losslessWrap(text, 36);
		expect(lines.join("")).toBe(text);
		expect(lines.every(line => visibleWidth(line) <= 36)).toBe(true);
	});

	it("starts every row a wrap continues with the indent, and loses nothing under it", () => {
		const text = "x".repeat(36) + " ".repeat(45) + "In: /tmp 漢字 é";
		const lines = losslessWrap(text, 36, "  ");
		expect(lines.length).toBeGreaterThan(2);
		expect(lines.slice(1).every(line => line.startsWith("  "))).toBe(true);
		expect(lines[0] + lines.slice(1).map(line => line.slice(2)).join("")).toBe(text);
		expect(lines.every(line => visibleWidth(line) <= 36)).toBe(true);
	});
});

describe("ApprovalDialog", () => {
	it.each([80, 120])("renders expected initial layout and exact copy at %s columns", width => {
		const { ui } = makeDialog();
		const lines = ui.render(width);
		const joined = lines.join("\n");
		expect(lines.length).toBeLessThanOrEqual(30);
		expect(lines.every(line => visibleWidth(line) === width)).toBe(true);
		expect(joined).toContain("AGY needs approval");
		expect(joined).toContain("Run: ls -1");
		expect(joined).toContain("In: /workspace");
		expect(joined).toContain("> Reject once");
		expect(joined).toContain("  Allow once");
		expect(joined).not.toContain("(unavailable)");
		expect(joined).not.toContain("Review all details before allowing.");
		expect(joined).toContain("↑↓ choose · Enter confirm · Esc reject · PgUp/PgDn details");
		expect(joined).not.toContain("Native policy still applies.");
		expect(joined).not.toContain("Origin not supplied");
	});

	it("renders non-command tool calls with title, details, and cwd", () => {
		const { ui } = makeDialog({
			command: undefined,
			kind: "edit",
			title: "Edit src/app.ts",
			details: '{"path":"src/app.ts"}',
		});
		const joined = ui.render(80).join("\n");
		expect(joined).toContain("Edit src/app.ts");
		expect(joined).toContain('{"path":"src/app.ts"}');
		expect(joined).toContain("In: /workspace");
		expect(joined).not.toContain("Run:");
	});

	it("says in its header when AGY asks to run outside its sandbox, and only then", () => {
		const bypass = makeDialog({ bypassSandbox: true });
		const lines = bypass.ui.render(80);
		expect(lines.some(line => line.includes("│ AGY needs approval to run outside its sandbox "))).toBe(true);
		expect(lines.every(line => visibleWidth(line) === 80)).toBe(true);
		expect(lines.join("\n")).toContain("Run: ls -1");
		const plain = makeDialog().ui.render(80).join("\n");
		expect(plain).toContain("│ AGY needs approval ");
		expect(plain).not.toContain("outside its sandbox");
	});

	it("starts on Reject once and selects reject on Enter or Esc", () => {
		const a = makeDialog();
		a.ui.render(80);
		a.ui.handleInput(enter);
		expect(a.finish).toHaveBeenCalledOnce();
		expect(a.finish).toHaveBeenCalledWith("reject");

		const b = makeDialog();
		b.ui.render(80);
		b.ui.handleInput(down);
		b.ui.handleInput(esc);
		expect(b.finish).toHaveBeenCalledOnce();
		expect(b.finish).toHaveBeenCalledWith("reject");
	});

	it("gates Allow once on full review of a 200-line command and unlocks only after paging all lines", () => {
		const longCmd = Array.from({ length: 200 }, (_, i) => `echo line-${i + 1}`).join("\n");
		const { ui, finish } = makeDialog({ command: longCmd }, 30);
		const firstScreen = ui.render(80).join("\n");
		expect(ui.canAccept).toBe(false);
		expect(firstScreen).toContain("Allow once  (unavailable)");
		expect(firstScreen).toContain("Review all details before allowing.");
		expect(firstScreen).toMatch(/Page 1 of \d+ \(lines 1-\d+ of 201\)/);

		// Jumping to End lands on the final page (Page N of N) but skips middle lines, so Allow once stays locked.
		ui.handleInput(endKey);
		const endScreen = ui.render(80).join("\n");
		expect(endScreen).toMatch(/Page (\d+) of \1 \(lines \d+-201 of 201\)/);
		expect(endScreen).toContain("Page 12 of 12 (lines 184-201 of 201)");
		ui.handleInput(down);
		ui.handleInput(enter);
		expect(ui.canAccept).toBe(false);
		expect(finish).not.toHaveBeenCalled();

		// Returning Home and paging through every page unlocks Allow once.
		ui.handleInput(home);
		ui.render(80);
		for (let i = 0; i < 40 && !ui.canAccept; i++) {
			ui.handleInput(pageDown);
			ui.render(80);
		}
		expect(ui.canAccept).toBe(true);
		ui.handleInput(pageDown);
		const finalScreen = ui.render(80).join("\n");
		expect(finalScreen).toMatch(/Page (\d+) of \1 \(lines \d+-201 of 201\)/);
		expect(finalScreen).toContain("Page 12 of 12 (lines 184-201 of 201)");
		expect(finalScreen).not.toContain("(unavailable)");
		expect(finalScreen).not.toContain("Review all details before allowing.");
		ui.handleInput(enter);
		expect(finish).toHaveBeenCalledOnce();
		expect(finish).toHaveBeenCalledWith("accept");
	});

	it("resets reviewed coverage and requires re-paging when terminal width changes mid-review", () => {
		const { ui, finish } = makeDialog({ command: "long-command-".repeat(90) }, 24);
		ui.render(120);
		for (let i = 0; i < 40 && !ui.canAccept; i++) {
			ui.handleInput(pageDown);
			ui.render(120);
		}
		expect(ui.canAccept).toBe(true);

		ui.render(40);
		expect(ui.canAccept).toBe(false);
		ui.handleInput(down);
		ui.handleInput(enter);
		expect(finish).not.toHaveBeenCalled();

		for (let i = 0; i < 120 && !ui.canAccept; i++) {
			ui.handleInput(pageDown);
			ui.render(40);
		}
		expect(ui.canAccept).toBe(true);
		ui.handleInput(enter);
		expect(finish).toHaveBeenCalledWith("accept");
	});

	it("blocks accept and allows reject in a tiny terminal (<40 cols or <18 rows)", () => {
		const narrow = makeDialog({}, 30);
		const narrowLines = narrow.ui.render(39);
		expect(narrowLines.every(line => visibleWidth(line) <= 39)).toBe(true);
		expect(narrowLines.join(" ")).toContain("AGY approval: enlarge the terminal to review. Enter or Esc rejects.");
		expect(narrow.ui.canAccept).toBe(false);
		narrow.ui.handleInput(down);
		narrow.ui.handleInput(enter);
		expect(narrow.finish).not.toHaveBeenCalled();
		narrow.ui.handleInput(esc);
		expect(narrow.finish).toHaveBeenCalledWith("reject");

		const short = makeDialog({}, 17);
		short.ui.render(80);
		expect(short.ui.canAccept).toBe(false);
		short.ui.handleInput(enter);
		expect(short.finish).toHaveBeenCalledWith("reject");

		// Shrinking mid-review resets Allow focus back to Reject.
		const shrunk = makeDialog({}, 30);
		shrunk.ui.render(80);
		shrunk.ui.handleInput(down);
		shrunk.ui.render(30);
		shrunk.ui.handleInput(enter);
		expect(shrunk.finish).toHaveBeenCalledWith("reject");
	});

	it("shows singular and plural waiting counts only when pending requests exist", () => {
		expect(makeDialog({ pendingCount: () => 0 }).ui.render(80).join("\n")).not.toContain("waiting");
		expect(makeDialog({ pendingCount: () => 1 }).ui.render(80).join("\n")).toContain("1 more AGY request waiting");
		expect(makeDialog({ pendingCount: () => 2 }).ui.render(80).join("\n")).toContain("2 more AGY requests waiting");
	});

	it("respects custom keybindings from DialogHost and supports PageUp", () => {
		const { ui, finish } = makeDialog(
			{ command: Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") },
			24,
			{
				matches: (data, id) =>
					(id === "tui.select.down" && data === "j") ||
					(id === "tui.select.up" && data === "k") ||
					(id === "tui.select.pageDown" && data === "f") ||
					(id === "tui.select.pageUp" && data === "b") ||
					(id === "tui.select.confirm" && data === "y") ||
					(id === "tui.select.cancel" && data === "q"),
			},
		);
		ui.render(80);
		ui.handleInput("f");
		expect(ui.render(80).join("\n")).toContain("Page 2 of");
		ui.handleInput("b");
		expect(ui.render(80).join("\n")).toContain("Page 1 of");
		ui.handleInput("j");
		ui.handleInput("k");
		ui.handleInput("q");
		expect(finish).toHaveBeenCalledWith("reject");

		const second = makeDialog({}, 30, {
			matches: (data, id) => (id === "tui.select.down" && data === "j") || (id === "tui.select.confirm" && data === "y"),
		});
		second.ui.render(80);
		second.ui.handleInput("j");
		second.ui.handleInput("y");
		expect(second.finish).toHaveBeenCalledWith("accept");
	});

	it("keeps every row within width and height even at minimum 40x18 with long details and waiting requests", () => {
		const { ui } = makeDialog({ command: "漢字-long-cmd ".repeat(400), pendingCount: () => 7 }, 18);
		const lines = ui.render(40);
		expect(lines.length).toBeLessThanOrEqual(18);
		expect(lines.every(line => visibleWidth(line) === 40)).toBe(true);
		// Also check up arrow works for toggle without throwing
		ui.handleInput(up);
		expect(ui.render(40).length).toBeLessThanOrEqual(18);
	});
});

// The opt-in message log (RBF_AGY_WIRE_LOG=1): what the dialog and the queue write to it, and what they must never write.
describe("the message log from the approval dialog and queue", () => {
	let wire: WireLogRun | undefined;
	afterEach(() => { wire?.stop(); wire = undefined; });

	it("logs the dialog's first render, focus changes, each key by name, and its finish, and never what was typed or the command", () => {
		wire = startWireLog();
		const { ui, finish } = makeDialog({ command: "touch SECRET-COMMAND.txt", bypassSandbox: true });
		(ui as unknown as { focused: boolean }).focused = true;
		ui.render(80);
		ui.render(80);
		ui.handleInput(down);
		ui.handleInput("SECRET-TYPED");
		(ui as unknown as { focused: boolean }).focused = false; // a click outside took the focus
		(ui as unknown as { focused: boolean }).focused = true;
		ui.handleInput(enter);
		ui.handleInput(enter); // after the finish
		expect(finish).toHaveBeenCalledExactlyOnceWith("accept");
		expect(wire.lines().map(({ t, ev, ...rest }) => ({ ev, ...rest }))).toEqual([
			{ ev: "dlg", step: "focus", toolCallId: "call_1", focused: true },
			{ ev: "dlg", step: "render", toolCallId: "call_1", width: 80, rows: 30, usable: true, bypass: true },
			{ ev: "dlg", step: "key", toolCallId: "call_1", key: "down", onAllow: false, canAccept: true, ended: false },
			{ ev: "dlg", step: "key", toolCallId: "call_1", key: "other", onAllow: true, canAccept: true, ended: false },
			{ ev: "dlg", step: "focus", toolCallId: "call_1", focused: false },
			{ ev: "dlg", step: "focus", toolCallId: "call_1", focused: true },
			{ ev: "dlg", step: "key", toolCallId: "call_1", key: "enter", onAllow: true, canAccept: true, ended: false },
			{ ev: "dlg", step: "finish", toolCallId: "call_1", choice: "accept", focused: true },
			{ ev: "dlg", step: "key", toolCallId: "call_1", key: "enter", onAllow: true, canAccept: true, ended: true },
		]);
		const text = readFileSync(wire.file, "utf8");
		expect(text).not.toContain("SECRET");
		expect(text).not.toContain("touch");
	});

	it("logs each request, its dialog, the choice and the reply, with the tool call id and counts, and no command text", async () => {
		wire = startWireLog();
		const f = makeQueueFixture();
		const turn = new AbortController();
		const ctx = { turnRunning: true, inputEntryId: "in-1", signal: turn.signal };
		const first = f.queue.request(permissionParams("call_X", "touch SECRET-COMMAND.txt"), ctx);
		await tick();
		const second = f.queue.request(permissionParams("call_X", "touch SECRET-COMMAND.txt"), ctx);
		f.answers[0].resolve("accept");
		await first;
		await tick();
		f.answers[1].resolve("reject");
		await second;
		f.queue.forgetApproval("call_X");
		const late = await f.queue.request(permissionParams("call_late"), { turnRunning: false, inputEntryId: null });
		expect(late.record.reason).toBe("turn-stopped");
		expect(wire.lines().map(({ t, ev, ...rest }) => ({ ev, ...rest }))).toEqual([
			{ ev: "q", step: "request", toolCallId: "call_X", live: 0, valid: true, turnRunning: true, bypass: false },
			{ ev: "q", step: "present", n: 1, toolCallId: "call_X", waiting: 0 },
			{ ev: "q", step: "request", toolCallId: "call_X", live: 1, valid: true, turnRunning: true, bypass: false },
			{ ev: "q", step: "choice", n: 1, toolCallId: "call_X", choice: "accept", settled: false },
			{ ev: "q", step: "reply", n: 1, toolCallId: "call_X", reply: "allow_once", reason: "user" },
			{ ev: "q", step: "present", n: 2, toolCallId: "call_X", waiting: 0 },
			{ ev: "q", step: "choice", n: 2, toolCallId: "call_X", choice: "reject", settled: false },
			{ ev: "q", step: "reply", n: 2, toolCallId: "call_X", reply: "reject_once", reason: "user" },
			{ ev: "q", step: "forget", toolCallId: "call_X" },
			{ ev: "q", step: "request", toolCallId: "call_late", live: 0, valid: true, turnRunning: false, bypass: false },
			{ ev: "q", step: "reply", toolCallId: "call_late", reply: "cancelled", reason: "turn-stopped", atOnce: true },
		]);
		expect(readFileSync(wire.file, "utf8")).not.toContain("SECRET");
	});

	it("writes no log, and makes no folder, without the variable", async () => {
		wire = startWireLog(false);
		const { ui } = makeDialog();
		(ui as unknown as { focused: boolean }).focused = true;
		ui.render(80);
		ui.handleInput(down);
		ui.handleInput(enter);
		const f = makeQueueFixture();
		const turn = new AbortController();
		const pending = f.queue.request(permissionParams("call_off"), { turnRunning: true, inputEntryId: "in-1", signal: turn.signal });
		await tick();
		f.answers[0].resolve("accept");
		await pending;
		expect(wire.exists()).toBe(false);
		expect(existsSync(wire.dir)).toBe(false);
	});
});

describe("approvalPresenter", () => {
	it("returns undefined safely when UI is absent or a stale ctx throws", async () => {
		const noUi = approvalPresenter({ hasUI: false, ui: { custom: vi.fn() } } as unknown as ExtensionContext);
		await expect(noUi(dialogView(), new AbortController().signal)).resolves.toBeUndefined();

		const staleCtx = {
			get hasUI() {
				throw new Error("session replaced");
			},
		} as unknown as ExtensionContext;
		const stale = approvalPresenter(staleCtx);
		await expect(stale(dialogView(), new AbortController().signal)).resolves.toBeUndefined();

		const throwingCustom = approvalPresenter({
			hasUI: true,
			ui: {
				custom: vi.fn(() => {
					throw new Error("closed");
				}),
			},
		} as unknown as ExtensionContext);
		await expect(throwingCustom(dialogView(), new AbortController().signal)).resolves.toBeUndefined();
	});

	it("forwards onHandle and resolves undefined when signal aborts", async () => {
		const onHandle = vi.fn();
		let finishFromDone: ((choice: ApprovalChoice) => void) | undefined;
		const custom = vi.fn((factory: any, opts: any) => {
			opts.onHandle?.("overlay-handle");
			return new Promise<ApprovalChoice>(resolve => {
				finishFromDone = resolve;
				factory(
					{ terminal: { rows: 30 }, requestRender: vi.fn() },
					{ fg: (_r: string, t: string) => t },
					undefined,
					resolve,
				);
			});
		});
		const present = approvalPresenter({ hasUI: true, ui: { custom } } as unknown as ExtensionContext, { onHandle });
		const controller = new AbortController();
		const result = present(dialogView(), controller.signal);
		expect(onHandle).toHaveBeenCalledWith("overlay-handle");
		controller.abort();
		await expect(result).resolves.toBeUndefined();
		expect(finishFromDone).toBeDefined();
	});
});

describe("AcpApprovalQueue", () => {
	it("returns allow_once on accept and reject_once on reject (and tracks approvalForToolCall)", async () => {
		const f = makeQueueFixture();
		const turn = new AbortController();

		const first = f.queue.request(permissionParams("call_allow", "ls -1"), {
			turnRunning: true,
			inputEntryId: "in-1",
			signal: turn.signal,
		});
		await tick();
		expect(f.shown).toHaveLength(1);
		expect(f.pendingEvents).toEqual([{ toolCallId: "call_allow", waiting: true }]);
		f.answers[0].resolve("accept");

		const res1 = await first;
		expect(res1.outcome).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
		expect(res1.record).toEqual({
			piSessionId: "pi-session-1",
			inputEntryId: "in-1",
			acpSessionId: "acp-session-1",
			toolCallId: "call_allow",
			kind: "execute",
			title: "ls -1",
			command: "ls -1",
			optionsOffered: ["allow_once", "reject_once"],
			reply: "allow_once",
			reason: "user",
		});
		expect(f.queue.approvalForToolCall("call_allow")).toEqual({ reply: "allow_once", reason: "user" });
		expect(f.pendingEvents).toEqual([
			{ toolCallId: "call_allow", waiting: true },
			{ toolCallId: "call_allow", waiting: false },
		]);

		const second = f.queue.request(permissionParams("call_deny", "rm -rf tmp"), {
			turnRunning: true,
			inputEntryId: "in-1",
			signal: turn.signal,
		});
		await tick();
		f.answers[1].resolve("reject");
		const res2 = await second;
		expect(res2.outcome).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
		expect(res2.record.reply).toBe("reject_once");
		expect(res2.record.reason).toBe("user");
		expect(f.queue.approvalForToolCall("call_deny")).toEqual({ reply: "reject_once", reason: "user" });
	});

	it("maps Esc in ApprovalDialog to reject_once with reason user", async () => {
		const records: AgyAcpPermissionRecord[] = [];
		const queue = new AcpApprovalQueue({
			piSessionId: "pi-session-1",
			acpSessionId: "acp-session-1",
			cwd: "/workspace",
			onRecord: r => records.push(r),
			present: view =>
				new Promise(resolve => {
					const ui = new ApprovalDialog(
						view,
						{ rows: () => 30, redraw: () => {}, paint: (_r, t) => t },
						resolve,
					);
					ui.render(80);
					ui.handleInput(esc);
				}),
		});
		const res = await queue.request(permissionParams("call_esc", "pwd"), {
			turnRunning: true,
			inputEntryId: "in-1",
		});
		expect(res.outcome).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
		expect(res.record.reply).toBe("reject_once");
		expect(res.record.reason).toBe("user");
		expect(records).toHaveLength(1);
	});

	it("cancels open and queued requests with turn-stopped on signal abort or cancelAll, and remains usable next turn", async () => {
		const f = makeQueueFixture();
		const turn1 = new AbortController();
		const a = f.queue.request(permissionParams("call_1", "echo 1"), {
			turnRunning: true,
			inputEntryId: "in-1",
			signal: turn1.signal,
		});
		const b = f.queue.request(permissionParams("call_2", "echo 2"), {
			turnRunning: true,
			inputEntryId: "in-1",
			signal: turn1.signal,
		});
		await tick();
		expect(f.shown).toHaveLength(1);
		expect(f.signals[0].aborted).toBe(false);

		turn1.abort();
		const [ra, rb] = await Promise.all([a, b]);
		expect(f.signals[0].aborted).toBe(true);
		expect(ra.outcome).toEqual({ outcome: { outcome: "cancelled" } });
		expect(ra.record.reply).toBe("cancelled");
		expect(ra.record.reason).toBe("turn-stopped");
		expect(rb.outcome).toEqual({ outcome: { outcome: "cancelled" } });
		expect(rb.record.reply).toBe("cancelled");
		expect(rb.record.reason).toBe("turn-stopped");
		expect(f.shown).toHaveLength(1);

		// Queue is still usable on the next turn.
		f.queue.beginTurn("in-2", new AbortController().signal);
		expect(f.queue.approvalForToolCall("call_1")).toBeUndefined();
		const c = f.queue.request(permissionParams("call_3", "echo 3"));
		await tick();
		expect(f.shown).toHaveLength(2);
		f.answers[1].resolve("accept");
		const rc = await c;
		expect(rc.outcome).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
		expect(rc.record.inputEntryId).toBe("in-2");
		f.queue.endTurn();
	});

	it("rejects after 15-minute review cap with reject_once and continues pumping the next queued request", async () => {
		vi.useFakeTimers();
		try {
			const f = makeQueueFixture();
			const turn = new AbortController();
			const first = f.queue.request(permissionParams("call_slow", "sleep 1"), {
				turnRunning: true,
				inputEntryId: "in-1",
				signal: turn.signal,
			});
			const second = f.queue.request(permissionParams("call_next", "echo ok"), {
				turnRunning: true,
				inputEntryId: "in-1",
				signal: turn.signal,
			});

			await vi.advanceTimersByTimeAsync(ACP_APPROVAL_BOUNDS.reviewMs);
			const res1 = await first;
			expect(res1.outcome).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
			expect(res1.record.reply).toBe("reject_once");
			expect(res1.record.reason).toBe("review-cap");
			expect(f.signals[0].aborted).toBe(true);

			// Next queued request opens and can still be allowed!
			await Promise.resolve();
			expect(f.shown).toHaveLength(2);
			expect(f.shown[1].toolCallId).toBe("call_next");
			f.answers[1].resolve("accept");
			const res2 = await second;
			expect(res2.outcome).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
			expect(res2.record.reply).toBe("allow_once");
			expect(res2.record.reason).toBe("user");
		} finally {
			vi.useRealTimers();
		}
	});

	it("enforces monotonic review deadline even if a blocked presenter resolves late", async () => {
		const queue = new AcpApprovalQueue({
			piSessionId: "pi-1",
			acpSessionId: "acp-session-1",
			cwd: "/workspace",
			reviewTimeoutMs: 5,
			present: async () => {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
				return "accept";
			},
		});
		const res = await queue.request(permissionParams("call_late", "ls"), {
			turnRunning: true,
			inputEntryId: "in-1",
		});
		expect(res.outcome).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
		expect(res.record.reply).toBe("reject_once");
		expect(res.record.reason).toBe("review-cap");
	});

	it.each([
		[
			"missing allow_once",
			(p: any) => {
				p.options = [{ optionId: "deny", name: "Deny", kind: "reject_once" }, { optionId: "always", name: "Always", kind: "allow_always" }];
			},
			"reject_once",
		],
		[
			"missing reject_once",
			(p: any) => {
				p.options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "always", name: "Always", kind: "allow_always" }];
			},
			"cancelled",
		],
		[
			"oversized payload (>64 KiB, snapshot succeeds)",
			(p: any) => {
				p.toolCall.rawInput.Padding = "x".repeat(65536);
			},
			"reject_once",
		],
		[
			"oversized string (>64 KiB, snapshot refuses)",
			(p: any) => {
				p.toolCall.rawInput.Padding = "x".repeat(65537);
			},
			"cancelled",
		],
		[
			"toJSON trap",
			(p: any) => {
				p.toolCall.toJSON = () => {
					throw new Error("toJSON must not run");
				};
			},
			"cancelled",
		],
		[
			"wrong sessionId",
			(p: any) => {
				p.sessionId = "other-acp-session";
			},
			"cancelled",
		],
		[
			"mismatched args/rawInput CommandLine",
			(p: any) => {
				p.toolCall.args.CommandLine = "rm -rf /";
			},
			"reject_once",
		],
		[
			"getter trap",
			(p: any) => {
				Object.defineProperty(p.toolCall, "title", {
					enumerable: true,
					get() {
						throw new Error("getter must not run");
					},
				});
			},
			"cancelled",
		],
		[
			"duplicate optionId",
			(p: any) => {
				p.options[1].optionId = "allow";
			},
			"cancelled",
		],
	])("rejects invalid request (%s) with reason unsafe without killing the queue", async (_label, mutate, expectedReply) => {
		const f = makeQueueFixture();
		const bad = permissionParams("call_bad", "ls -1");
		mutate(bad);

		const badRes = await f.queue.request(bad, { turnRunning: true, inputEntryId: "in-1" });
		expect(badRes.record.reason).toBe("unsafe");
		expect(badRes.record.reply).toBe(expectedReply);
		expect(badRes.record.acpSessionId).toBe("acp-session-1");
		if (expectedReply === "reject_once") {
			expect(badRes.outcome).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
		} else {
			expect(badRes.outcome).toEqual({ outcome: { outcome: "cancelled" } });
		}
		expect(f.shown).toHaveLength(0);

		// A valid request afterwards still opens the dialog and succeeds!
		const good = f.queue.request(permissionParams("call_good", "echo ok"), {
			turnRunning: true,
			inputEntryId: "in-1",
		});
		await tick();
		expect(f.shown).toHaveLength(1);
		f.answers[0].resolve("accept");
		const goodRes = await good;
		expect(goodRes.outcome).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
		expect(goodRes.record.reply).toBe("allow_once");
		expect(goodRes.record.reason).toBe("user");
	});

	it("queues up to 8 live requests in FIFO and rejects the 9th immediately with unsafe while keeping the 8 alive", async () => {
		const f = makeQueueFixture();
		const queued = Array.from({ length: 8 }, (_, i) =>
			f.queue.request(permissionParams(`call_${i + 1}`, `echo ${i + 1}`), {
				turnRunning: true,
				inputEntryId: "in-1",
			}),
		);
		expect(f.queue.liveCount).toBe(8);

		const ninth = await f.queue.request(permissionParams("call_9", "echo 9"), {
			turnRunning: true,
			inputEntryId: "in-1",
		});
		expect(ninth.outcome).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
		expect(ninth.record.reply).toBe("reject_once");
		expect(ninth.record.reason).toBe("unsafe");
		expect(f.queue.liveCount).toBe(8);

		for (let i = 0; i < 8; i++) {
			await tick();
			expect(f.shown[i].toolCallId).toBe(`call_${i + 1}`);
			expect(f.shown[i].pendingCount()).toBe(7 - i);
			f.answers[i].resolve(i % 2 === 0 ? "accept" : "reject");
			const res = await queued[i];
			expect(res.record.reply).toBe(i % 2 === 0 ? "allow_once" : "reject_once");
			expect(res.record.reason).toBe("user");
		}
		expect(f.queue.liveCount).toBe(0);
	});

	// Decisions 2026-11-22: a request that arrives between turns starts a wake turn and reaches the queue inside it, so a request with no turn running is not a case any more.
	// The queue still answers it, `cancelled`, as the reply for a turn that is not running; it never opens a dialog.
	it("answers a request with no turn running `cancelled` as turn-stopped, without opening a dialog", async () => {
		const f = makeQueueFixture();
		const res = await f.queue.request(permissionParams("call_idle", "ls -1"), {
			turnRunning: false,
			inputEntryId: null,
		});
		expect(res.outcome).toEqual({ outcome: { outcome: "cancelled" } });
		expect(res.record.reply).toBe("cancelled");
		expect(res.record.reason).toBe("turn-stopped");
		expect(res.record.inputEntryId).toBeNull();
		expect(f.shown).toHaveLength(0);

		const badIdle = permissionParams("call_idle_bad", "ls -1");
		badIdle.sessionId = "wrong-session";
		const badRes = await f.queue.request(badIdle, { turnRunning: false, inputEntryId: null });
		expect(badRes.outcome).toEqual({ outcome: { outcome: "cancelled" } });
		expect(badRes.record.reply).toBe("cancelled");
		expect(badRes.record.reason).toBe("unsafe");
		expect(badRes.record.inputEntryId).toBeNull();
	});

	it("accepts the recorded ACP 1.5.3 permissionParams fixture and enforces exact 64 KiB boundary", async () => {
		const rawFixture = JSON.parse(
			readFileSync(resolve(import.meta.dirname, "../test-support/fixtures/acp-1.5.3.json"), "utf8"),
		);
		const acpParams = structuredClone(rawFixture.permissionParams);
		acpParams.sessionId = "acp-session-1";

		const f = makeQueueFixture();
		const req = f.queue.request(acpParams, { turnRunning: true, inputEntryId: "in-1" });
		await tick();
		expect(f.shown).toHaveLength(1);
		expect(f.shown[0].command).toBe("ls -1");
		expect(f.shown[0].cwd).toBe("/workspace");
		f.answers[0].resolve("accept");
		const res = await req;
		expect(res.outcome).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
		expect(res.record.toolCallId).toBe("call_1540230168067533781");

		// Exact 64 KiB accepted; +1 byte rejected with unsafe.
		const exact: any = permissionParams("call_exact", "ls -1");
		exact.toolCall.rawInput.Padding = "";
		const baseBytes = Buffer.byteLength(JSON.stringify(exact));
		exact.toolCall.rawInput.Padding = "x".repeat(ACP_APPROVAL_BOUNDS.requestBytes - baseBytes);
		const exactReq = f.queue.request(exact, { turnRunning: true, inputEntryId: "in-1" });
		await tick();
		expect(f.shown).toHaveLength(2);
		f.answers[1].resolve("reject");
		const exactRes = await exactReq;
		expect(exactRes.record.reason).toBe("user");
		expect(exactRes.record.reply).toBe("reject_once");

		exact.toolCall.rawInput.Padding += "x";
		const overRes = await f.queue.request(exact, { turnRunning: true, inputEntryId: "in-1" });
		expect(overRes.record.reason).toBe("unsafe");
		expect(overRes.record.reply).toBe("reject_once");
		expect(f.shown).toHaveLength(2);
	});

	it("publishes the selected result before reentrant modal disposal cancels the queue", async () => {
		const ids = new WeakMap<object, number>();
		const resolved = new Set<number>();
		const hook = createHook({
			init(id, type, _trigger, resource) {
				if (type === "PROMISE") ids.set(resource, id);
			},
			promiseResolve(id) {
				resolved.add(id);
			},
		});
		hook.enable();
		try {
			const choose = deferred<ApprovalChoice>();
			let publishedAtAbort = false;
			let result!: Promise<unknown>;
			const queue = new AcpApprovalQueue({
				piSessionId: "pi-1",
				acpSessionId: "acp-session-1",
				cwd: "/workspace",
				present: async (_view, signal) => {
					signal.addEventListener(
						"abort",
						() => {
							publishedAtAbort = resolved.has(ids.get(result)!);
							queue.cancelAll("turn-stopped");
						},
						{ once: true },
					);
					return choose.promise;
				},
			});
			result = queue.request(permissionParams("call_reent", "ls"), {
				turnRunning: true,
				inputEntryId: "in-1",
			});
			await tick();
			choose.resolve("accept");
			const settled = (await result) as any;
			expect(settled.outcome).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
			expect(publishedAtAbort).toBe(true);
		} finally {
			hook.disable();
		}
	});

	it("does not let a foreign session overwrite approvalForToolCall for an existing toolCallId", async () => {
		const f = makeQueueFixture();
		const turn = new AbortController();
		const realReq = f.queue.request(permissionParams("call_shared", "ls -1"), {
			turnRunning: true,
			inputEntryId: "in-1",
			signal: turn.signal,
		});
		await tick();
		f.answers[0].resolve("accept");
		await realReq;
		expect(f.queue.approvalForToolCall("call_shared")).toEqual({ reply: "allow_once", reason: "user" });

		const foreign = permissionParams("call_shared", "rm -rf /");
		foreign.sessionId = "foreign-acp-session";
		const foreignRes = await f.queue.request(foreign, {
			turnRunning: true,
			inputEntryId: "in-1",
			signal: turn.signal,
		});
		expect(foreignRes.outcome).toEqual({ outcome: { outcome: "cancelled" } });
		expect(foreignRes.record.reason).toBe("unsafe");
		expect(f.queue.approvalForToolCall("call_shared")).toEqual({ reply: "allow_once", reason: "user" });
	});

	// Row 64: AGY's sandbox blocked a write and AGY asked again for the same command with BypassSandbox: true. The dialog and the saved line must say so.
	const bypassParams = (toolCallId: string, where: "both" | "rawInput" | "args", value: unknown = true) => {
		const params = permissionParams(toolCallId, "touch out.txt");
		if (where !== "args") (params.toolCall.rawInput as Record<string, unknown>).BypassSandbox = value;
		if (where !== "rawInput") (params.toolCall.args as Record<string, unknown>).BypassSandbox = value;
		return params;
	};

	it.each(["both", "rawInput", "args"] as const)("carries BypassSandbox: true (in %s) to the dialog view and the saved record, and plain requests carry nothing", async where => {
		const f = makeQueueFixture();
		const turn = new AbortController();
		const ctx = { turnRunning: true, inputEntryId: "in-1", signal: turn.signal };
		const bypass = f.queue.request(bypassParams("call_bypass", where), ctx);
		await tick();
		expect(f.shown[0]).toMatchObject({ toolCallId: "call_bypass", command: "touch out.txt", bypassSandbox: true });
		f.answers[0].resolve("accept");
		const result = await bypass;
		expect(result.record).toEqual({
			piSessionId: "pi-session-1",
			inputEntryId: "in-1",
			acpSessionId: "acp-session-1",
			toolCallId: "call_bypass",
			kind: "execute",
			title: "touch out.txt",
			command: "touch out.txt",
			bypassSandbox: true,
			optionsOffered: ["allow_once", "reject_once"],
			reply: "allow_once",
			reason: "user",
		});
		expect(result.outcome).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });

		const plain = f.queue.request(permissionParams("call_plain", "ls -1"), ctx);
		await tick();
		expect(f.shown[1]).not.toHaveProperty("bypassSandbox");
		f.answers[1].resolve("reject");
		expect((await plain).record).not.toHaveProperty("bypassSandbox");

		const explicitFalse = f.queue.request(bypassParams("call_false", "both", false), ctx);
		await tick();
		expect(f.shown[2]).not.toHaveProperty("bypassSandbox");
		f.answers[2].resolve("reject");
		expect((await explicitFalse).record).not.toHaveProperty("bypassSandbox");
	});

	it("rejects as unsafe, without a dialog, a request whose rawInput and arguments disagree about BypassSandbox or whose BypassSandbox is not a boolean", async () => {
		const f = makeQueueFixture();
		const turn = new AbortController();
		const ctx = { turnRunning: true, inputEntryId: "in-1", signal: turn.signal };
		const disagree = bypassParams("call_disagree", "rawInput");
		(disagree.toolCall.args as Record<string, unknown>).BypassSandbox = false;
		const asString = bypassParams("call_string", "both", "true");
		const asNumber = bypassParams("call_number", "args", 1);
		for (const params of [disagree, asString, asNumber]) {
			const result = await f.queue.request(params, ctx);
			expect(result.record.reason, params.toolCall.toolCallId).toBe("unsafe");
			expect(result.outcome, params.toolCall.toolCallId).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
			expect(result.record, params.toolCall.toolCallId).not.toHaveProperty("bypassSandbox");
		}
		expect(f.shown).toEqual([]);
	});

	// Row 67: the check sat behind "is it a command", so a tool AGY types differently could ask to leave its sandbox under the ordinary header.
	it.each([["run_in_shell", "other"], ["run_in_shell", "Execute"], ["write_file", "edit"]])("says outside its sandbox, and rejects an unreadable BypassSandbox, for a request named %s of kind %s", async (name, kind) => {
		const f = makeQueueFixture();
		const turn = new AbortController();
		const ctx = { turnRunning: true, inputEntryId: "in-1", signal: turn.signal };
		const retyped = (toolCallId: string, where: "both" | "rawInput" | "args", value: unknown) => {
			const params = bypassParams(toolCallId, where, value);
			Object.assign(params.toolCall, { name, kind });
			return params;
		};
		const pending = f.queue.request(retyped("call_retyped", "args", true), ctx);
		await tick();
		expect(f.shown[0]).toMatchObject({ toolCallId: "call_retyped", bypassSandbox: true });
		f.answers[0].resolve("reject");
		expect((await pending).record).toMatchObject({ kind, bypassSandbox: true, reply: "reject_once", reason: "user" });
		const disagree = retyped("call_retyped_disagree", "rawInput", true);
		(disagree.toolCall.args as Record<string, unknown>).BypassSandbox = false;
		for (const params of [disagree, retyped("call_retyped_string", "both", "yes"), retyped("call_retyped_null", "args", null)]) {
			expect((await f.queue.request(params, ctx)).record.reason, params.toolCall.toolCallId).toBe("unsafe");
		}
		expect(f.shown).toHaveLength(1);
	});

	// Row 76: for a command the dialog drew only Run and In, so any other parameter AGY sent was hidden, as BypassSandbox had been.
	const showRequest = async (toolCall: { rawInput?: Record<string, unknown>; args?: Record<string, unknown>; name?: string; kind?: string }, rows = 40) => {
		const f = makeQueueFixture();
		const params = permissionParams("call_parameters", "sleep 20 && echo done");
		if (toolCall.name === undefined) {
			Object.assign(params.toolCall.rawInput, toolCall.rawInput);
			Object.assign(params.toolCall.args, toolCall.args);
		} else {
			Object.assign(params.toolCall, toolCall);
		}
		const pending = f.queue.request(params, { turnRunning: true, inputEntryId: "in-1", signal: new AbortController().signal });
		await tick();
		expect(f.shown).toHaveLength(1);
		const { ui } = makeDialog({ command: undefined, ...f.shown[0] }, rows);
		const lines = ui.render(100);
		f.answers[0].resolve("reject");
		return { ui, lines, body: lines.map(line => line.replace(/^│ /, "").replace(/ *│$/, "")), record: (await pending).record };
	};

	it.each([
		["nothing else", {}, {}, []],
		["one parameter in both copies", { IsDaemon: true }, { IsDaemon: true }, ["IsDaemon: true"]],
		["one parameter in rawInput only", { IsDaemon: true }, {}, ["IsDaemon: true"]],
		["one parameter in the arguments only", {}, { IsDaemon: true }, ["IsDaemon: true"]],
		["two copies that disagree", { IsDaemon: false }, { IsDaemon: true }, ["IsDaemon: false", "IsDaemon: true"]],
		["a sandbox flag AGY didn't set", { BypassSandbox: false }, { BypassSandbox: false }, []],
		["the folder only as In", { Cwd: "/workspace" }, { Cwd: "/workspace" }, []],
		["a folder Pi can't use", { Cwd: 5 }, { Cwd: 5 }, ["Cwd: 5"]],
		["every kind of value", { IsDaemon: false, Env: { A: "b c" }, Note: null, Shell: "zsh", Ids: [1, 2] }, { Ids: [1, 2], Env: { A: "b c" }, Note: null, Shell: "zsh", IsDaemon: false }, ["IsDaemon: false", 'Env: {"A":"b c"}', "Note: null", 'Shell: "zsh"', "Ids: [1,2]"]],
	] as Array<[string, Record<string, unknown>, Record<string, unknown>, string[]]>)("shows a command's other parameters under its folder, and not AGY's summary or wait: %s", async (_label, rawInput, args, expected) => {
		const { body, record } = await showRequest({ rawInput, args });
		const from = body.indexOf("Run: sleep 20 && echo done");
		expect(body.slice(from, from + expected.length + 3)).toEqual(["Run: sleep 20 && echo done", "In: /workspace", ...expected, ""]);
		expect(body.join("\n")).not.toMatch(/toolSummary|List directory contents|WaitMsBeforeAsync/);
		expect(Object.keys(record).sort()).toEqual(["acpSessionId", "command", "inputEntryId", "kind", "optionsOffered", "piSessionId", "reason", "reply", "title", "toolCallId"]);
	});

	it("keeps a parameter's name or value from posing as one of Pi's own lines", async () => {
		const forged = { In: "/safe", Run: "ls", "X\nRun: ls -1": 1, Note: "a\nIn: /safe", "Wipe\u001b[2K": "‮abc", constructor: "c", __proto: 1 };
		const { body, lines } = await showRequest({ rawInput: forged, args: forged });
		expect(body.filter(line => line.startsWith("Run: "))).toEqual(["Run: sleep 20 && echo done"]);
		expect(body.filter(line => line.startsWith("In: "))).toEqual(["In: /workspace"]);
		for (const line of ['"In": "/safe"', '"Run": "ls"', '"X\\nRun: ls -1": 1', 'Note: "a\\nIn: /safe"', '"Wipe\\u001b[2K": "\\u202eabc"', 'constructor: "c"', "__proto: 1"]) expect(body).toContain(line);
		expect(lines.join("\n")).not.toMatch(/[\u001b‮]/);
	});

	// Cold read 2026-11-26: a value padded to a row's edge wrapped, and the next row began at the margin with text AGY chose.
	const marginRows = (lines: string[], label: string) =>
		lines.map(line => line.replace(/^│ /, "")).filter(line => line.startsWith(label));
	it.each([
		["a command padded to the row's edge", { command: "ls" + " ".repeat(69) + "In: /tmp/scratch" }],
		["a command with a newline", { command: "ls\nIn: /tmp/scratch" }],
		["a title padded to the row's edge", { command: undefined, kind: "edit", title: "Edit" + " ".repeat(72) + "In: /tmp/scratch", details: "" }],
		["a title with a newline", { command: undefined, kind: "edit", title: "Edit\nIn: /tmp/scratch", details: "" }],
		["a title that reads like the folder line", { command: undefined, kind: "edit", title: "In: /tmp/scratch", details: "" }],
		["a folder with a newline", { cwd: "/workspace\nRun: rm -rf ~" }],
	] as Array<[string, Record<string, unknown>]>)("keeps AGY's text off the margin where Pi's own lines sit: %s", (_label, overrides) => {
		const { ui } = makeDialog(overrides);
		const lines = ui.render(80);
		expect(marginRows(lines, "In: ")).toHaveLength(1);
		expect(marginRows(lines, "In: ")[0]).toMatch(/^In: \/workspace/);
		expect(marginRows(lines, "Run: ").length).toBeLessThanOrEqual(1);
		expect(lines.join("\n")).not.toMatch(/^│ (In: \/tmp|Run: rm)/m);
	});

	it("keeps a padded parameter value from wrapping onto the margin", async () => {
		const { lines } = await showRequest({ rawInput: { Note: " ".repeat(89) + "In: /safe" }, args: {} });
		expect(marginRows(lines, "In: ")).toHaveLength(1);
		expect(marginRows(lines, "In: ")[0]).toMatch(/^In: \/workspace/);
		expect(lines.some(line => line.includes("  In: /safe"))).toBe(true);
	});

	it("pages a command's long parameter, and allows only after every page was shown", async () => {
		const { ui, lines } = await showRequest({ rawInput: { Env: "v".repeat(6000) }, args: { Env: "v".repeat(6000) } }, 24);
		expect(lines.join("\n")).toContain("Review all details before allowing.");
		for (let i = 0; i < 20; i++) {
			ui.handleInput("\x1b[6~");
			ui.render(100);
		}
		expect(ui.canAccept).toBe(true);
	});

	it.each([
		["equal copies", { Path: "/p", Content: "hi" }, { Content: "hi", Path: "/p" }, [{ Path: "/p", Content: "hi" }]],
		["an argument rawInput lacks", { Path: "/p" }, { Path: "/p", Content: "hi" }, [{ Path: "/p" }, { Content: "hi" }]],
		["an argument that differs", { Path: "/p" }, { Path: "/q" }, [{ Path: "/p" }, { Path: "/q" }]],
		["no rawInput", {}, { Path: "/p" }, [{ Path: "/p" }]],
		["no arguments", { Path: "/p" }, {}, [{ Path: "/p" }]],
		["neither", {}, {}, []],
	] as Array<[string, Record<string, unknown>, Record<string, unknown>, unknown[]]>)("shows a file write's whole input: %s", async (_label, rawInput, args, blocks) => {
		const { body } = await showRequest({ name: "write_file", kind: "edit", rawInput, args });
		const from = body.indexOf("sleep 20 && echo done");
		const expected = blocks.flatMap(block => JSON.stringify(block, null, 2).split("\n"));
		expect(body.slice(from, from + expected.length + 3)).toEqual(["sleep 20 && echo done", ...expected, "In: /workspace", ""]);
	});

	// Row 68: AGY's title is the command itself, so a 512-character title limit refused every longer command with no dialog (ER12c: long input is paged, never truncated).
	it.each([512, 513, 20_000])("opens the dialog for a command of %i characters whose title is that command, shows it whole, and saves a record that reads back", async length => {
		const f = makeQueueFixture();
		const turn = new AbortController();
		const command = "x".repeat(length);
		const pending = f.queue.request(permissionParams("call_long_title", command), { turnRunning: true, inputEntryId: "in-1", signal: turn.signal });
		await tick();
		expect(f.shown).toHaveLength(1);
		expect(f.shown[0].command).toBe(command);
		f.answers[0].resolve("accept");
		const { record, outcome } = await pending;
		expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
		expect(record).toMatchObject({ command, title: command.slice(0, 512), reply: "allow_once", reason: "user" });
		expect(parseAgyAcpPermission(JSON.parse(JSON.stringify(record)))).toEqual(record);
	});

	it("shows a long title whole when the request is not a command, and still rejects a request over 64 KiB with no dialog", async () => {
		const f = makeQueueFixture();
		const turn = new AbortController();
		const ctx = { turnRunning: true, inputEntryId: "in-1", signal: turn.signal };
		const title = "File " + "d/".repeat(600) + "END";
		const params = permissionParams("call_long_file");
		Object.assign(params.toolCall, { name: "write_file", kind: "edit", title, args: { Path: "/p" }, rawInput: { Path: "/p" } });
		const pending = f.queue.request(params, ctx);
		await tick();
		expect(f.shown[0].title).toBe(title);
		f.answers[0].resolve("reject");
		const { record } = await pending;
		expect(record.title).toBe(title.slice(0, 512));
		expect(parseAgyAcpPermission(JSON.parse(JSON.stringify(record)))).toEqual(record);
		expect((await f.queue.request(permissionParams("call_huge", "y".repeat(70_000)), ctx)).record.reason).toBe("unsafe");
		expect(f.shown).toHaveLength(1);
	});

	it("settles with reject_once and reason unsafe when presenter returns undefined or throws while turn is still running", async () => {
		let call = 0;
		const queue = new AcpApprovalQueue({
			piSessionId: "pi-1",
			acpSessionId: "acp-session-1",
			cwd: "/workspace",
			present: async () => {
				call++;
				if (call === 1) return undefined;
				if (call === 2) throw new Error("overlay failed");
				return "accept";
			},
		});
		const turn = new AbortController();
		const r1 = await queue.request(permissionParams("call_noui", "ls -1"), {
			turnRunning: true,
			inputEntryId: "in-1",
			signal: turn.signal,
		});
		expect(r1.outcome).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
		expect(r1.record.reply).toBe("reject_once");
		expect(r1.record.reason).toBe("unsafe");

		const r2 = await queue.request(permissionParams("call_throw", "ls -2"), {
			turnRunning: true,
			inputEntryId: "in-1",
			signal: turn.signal,
		});
		expect(r2.outcome).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
		expect(r2.record.reply).toBe("reject_once");
		expect(r2.record.reason).toBe("unsafe");

		const r3 = await queue.request(permissionParams("call_ok", "ls -3"), {
			turnRunning: true,
			inputEntryId: "in-1",
			signal: turn.signal,
		});
		expect(r3.outcome).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
		expect(r3.record.reply).toBe("allow_once");
		expect(r3.record.reason).toBe("user");
	});
});

describe("extractAgyAcpQuestion", () => {
	it("extracts multi-question requestedSchema titles and skips _other fields", () => {
		const params = {
			toolCallId: "call_ask_1",
			message: "Please answer these questions",
			requestedSchema: {
				type: "object",
				properties: {
					q1: { type: "string", title: "Which database should we use?" },
					q1_other: { type: "string", title: "Other database" },
					q2: { type: "string", description: "Which region should it deploy to?" },
					q2_other: { type: "string", description: "Custom region" },
				},
			},
		};
		const record = extractAgyAcpQuestion(params, {
			piSessionId: "pi-session-1",
			acpSessionId: "acp-session-1",
			inputEntryId: "in-1",
		});
		expect(record).toEqual({
			piSessionId: "pi-session-1",
			inputEntryId: "in-1",
			acpSessionId: "acp-session-1",
			toolCallId: "call_ask_1",
			questions: ["Which database should we use?", "Which region should it deploy to?"],
		});
		expect(ACP_QUESTION_ERROR_MESSAGE).toBe("Pi could not show the question");
		expect(AGY_ACP_QUESTION).toBe("rbf-agy-acp-question/v1");
		expect(AGY_ACP_PERMISSION).toBe("rbf-agy-acp-permission/v1");
	});

	it("falls back to sanitized message or 'question' and handles unsafe/throwing params", () => {
		const withMessage = extractAgyAcpQuestion(
			{ message: "\x1b[31mPick a branch?\x1b[0m" },
			{ piSessionId: "pi-1", acpSessionId: "acp-1", inputEntryId: null },
		);
		expect(withMessage.toolCallId).toBe("elicitation");
		expect(withMessage.questions).toEqual(["Pick a branch?"]);

		const trapped: Record<string, unknown> = {};
		Object.defineProperty(trapped, "requestedSchema", {
			enumerable: true,
			get() {
				throw new Error("boom");
			},
		});
		const fallback = extractAgyAcpQuestion(trapped, { piSessionId: "pi-1", acpSessionId: "acp-1", inputEntryId: "in-1" });
		expect(fallback.toolCallId).toBe("elicitation");
		expect(fallback.questions).toEqual(["question"]);
	});

	it("UTF-8 clamps 64 large questions and oversized fallback message to 2048 bytes so parseAgyAcpQuestion succeeds", () => {
		const properties: Record<string, { type: string; title: string }> = {};
		for (let i = 0; i < 64; i++) {
			properties[`q${i}`] = { type: "string", title: `Q${i}: ` + "漢字🚀".repeat(600) };
		}
		const record = extractAgyAcpQuestion(
			{ toolCallId: "call_big_q", requestedSchema: { type: "object", properties } },
			{ piSessionId: "pi-1", acpSessionId: "acp-1", inputEntryId: "in-1" },
		);
		expect(record.questions).toHaveLength(64);
		for (const q of record.questions) {
			expect(Buffer.byteLength(q, "utf8")).toBeLessThanOrEqual(2048);
			expect(q).not.toContain("\ufffd");
		}
		expect(parseAgyAcpQuestion(record)).toEqual(record);

		const msgRecord = extractAgyAcpQuestion(
			{ message: "語".repeat(1500) },
			{ piSessionId: "pi-1", acpSessionId: "acp-1", inputEntryId: null },
		);
		expect(msgRecord.questions).toHaveLength(1);
		expect(Buffer.byteLength(msgRecord.questions[0]!, "utf8")).toBeLessThanOrEqual(2048);
		expect(msgRecord.questions[0]).not.toContain("\ufffd");
		expect(parseAgyAcpQuestion(msgRecord)).toEqual(msgRecord);
	});
});

describe("permission and question parsers and renderers", () => {
	const basePermission: AgyAcpPermissionRecord = {
		piSessionId: "pi-session-1",
		inputEntryId: "in-1",
		acpSessionId: "acp-session-1",
		toolCallId: "call_1",
		kind: "execute",
		title: "ls -1",
		command: "ls -1",
		optionsOffered: ["allow_once", "reject_once"],
		reply: "allow_once",
		reason: "user",
	};

	it.each([
		["user", "allow_once", "You allowed AGY to run ls -1 once.", "dim"],
		["user", "reject_once", "You rejected AGY's request to run ls -1.", "warning"],
		["turn-stopped", "cancelled", "AGY's request to run ls -1 was rejected because the turn stopped.", "warning"],
		["review-cap", "reject_once", "AGY's request to run ls -1 was rejected after 15 minutes without an answer.", "warning"],
		["unsafe", "reject_once", "AGY sent a request Pi can't show safely, so Pi rejected it.", "warning"],
	] as const)("formats and renders permission reason=%s reply=%s", (reason, reply, expectedText, expectedRole) => {
		const record: AgyAcpPermissionRecord = {
			...basePermission,
			inputEntryId: "in-1",
			reason,
			reply,
		};
		expect(parseAgyAcpPermission(record)).toEqual(record);
		expect(formatAgyAcpPermissionLine(record)).toEqual({ text: expectedText, role: expectedRole });

		const rendered = renderAgyAcpPermission(record, false, mockTheme).render(120);
		expect(rendered).toEqual([`[${expectedRole}]${expectedText}`]);
	});

	it.each([
		["user", "allow_once", "You allowed AGY to run touch out.txt once, outside its sandbox.", "dim"],
		["user", "reject_once", "You rejected AGY's request to run touch out.txt outside its sandbox.", "warning"],
	] as const)("says outside its sandbox in the saved line when BypassSandbox was asked (reason=%s reply=%s)", (reason, reply, expectedText, expectedRole) => {
		const record: AgyAcpPermissionRecord = { ...basePermission, title: "touch out.txt", command: "touch out.txt", bypassSandbox: true, reason, reply };
		expect(parseAgyAcpPermission(record)).toEqual(record);
		expect(formatAgyAcpPermissionLine(record)).toEqual({ text: expectedText, role: expectedRole });
		expect(renderAgyAcpPermission(record, false, mockTheme).render(120)).toEqual([`[${expectedRole}]${expectedText}`]);
		// A saved record that says anything but `true` is not one Pi wrote.
		expect(parseAgyAcpPermission({ ...record, bypassSandbox: false })).toBeUndefined();
		expect(parseAgyAcpPermission({ ...record, bypassSandbox: "true" })).toBeUndefined();
		const { bypassSandbox: _gone, ...plain } = record;
		expect(parseAgyAcpPermission(plain)).toEqual(plain);
	});

	it("uses title when command is absent and renders fallback warning on invalid permission records", () => {
		const noCmd: AgyAcpPermissionRecord = {
			...basePermission,
			command: undefined,
			kind: "edit",
			title: "edit README.md",
		};
		expect(formatAgyAcpPermissionLine(noCmd)).toEqual({
			text: "You allowed AGY to edit README.md once.",
			role: "dim",
		});

		expect(parseAgyAcpPermission({ bad: true })).toBeUndefined();
		expect(parseAgyAcpPermission({ ...basePermission, extra: 1 })).toBeUndefined();
		const invalidRendered = renderAgyAcpPermission({ bad: true }, false, mockTheme).render(120);
		expect(invalidRendered).toEqual([
			"[warning]AGY permission record unavailable: saved record is invalid or unsupported.",
		]);
	});

	it("parses, formats, and renders valid and invalid question records", () => {
		const record = {
			piSessionId: "pi-session-1",
			inputEntryId: "in-1",
			acpSessionId: "acp-session-1",
			toolCallId: "call_q1",
			questions: ["Which database?"],
		};
		expect(parseAgyAcpQuestion(record)).toEqual(record);
		expect(formatAgyAcpQuestionLine(record)).toBe(ACP_QUESTION_LINE);
		expect(renderAgyAcpQuestion(record, false, mockTheme).render(120)).toEqual([`[dim]${ACP_QUESTION_LINE}`]);

		expect(parseAgyAcpQuestion({ piSessionId: "pi-1", questions: [] })).toBeUndefined();
		expect(renderAgyAcpQuestion({ bad: true }, false, mockTheme).render(120)).toEqual([
			"[warning]AGY question record unavailable: saved record is invalid or unsupported.",
		]);
	});

	it("collapses multiline and >200-char permission commands with an expand hint, and expands to full text", () => {
		const longCmd = Array.from({ length: 200 }, (_, i) => `echo line-${i + 1}`).join("\n");
		const record: AgyAcpPermissionRecord = {
			...basePermission,
			command: longCmd,
			title: "long command",
			reply: "reject_once",
			reason: "user",
		};

		const collapsed = renderAgyAcpPermission(record, false, mockTheme, "Ctrl+O to expand").render(120);
		expect(collapsed).toEqual([
			"[warning]You rejected AGY's request to run echo line-1….",
			"    ... (Ctrl+O to expand)",
		]);

		const collapsedDefaultHint = renderAgyAcpPermission(record, false, mockTheme).render(80);
		expect(collapsedDefaultHint.length).toBeLessThanOrEqual(3);
		expect(collapsedDefaultHint[0]).toBe("[warning]You rejected AGY's request to run echo line-1….");
		expect(collapsedDefaultHint.some(row => row.includes("    ... ("))).toBe(true);

		const expanded = renderAgyAcpPermission(record, true, mockTheme, "Ctrl+O to expand").render(120);
		expect(expanded.length).toBeGreaterThanOrEqual(200);
		expect(expanded.join("\n")).toContain("echo line-1");
		expect(expanded.join("\n")).toContain("echo line-200");
		expect(expanded.join("\n")).not.toContain("to expand");

		// Single-line command > 200 chars truncates to 200 chars + ellipsis when collapsed.
		const wideRecord: AgyAcpPermissionRecord = {
			...basePermission,
			command: "a".repeat(250),
			reply: "allow_once",
			reason: "user",
		};
		const wideCollapsed = renderAgyAcpPermission(wideRecord, false, mockTheme, "Ctrl+O to expand").render(400);
		expect(wideCollapsed).toEqual([
			`[dim]You allowed AGY to run ${"a".repeat(200)}… once.`,
			"    ... (Ctrl+O to expand)",
		]);
		expect(renderAgyAcpPermission(wideRecord, true, mockTheme, "Ctrl+O to expand").render(400)).toEqual([
			`[dim]You allowed AGY to run ${"a".repeat(250)} once.`,
		]);

		// Unsafe records omit command text, so no expand hint is added.
		const unsafeLong: AgyAcpPermissionRecord = { ...record, reason: "unsafe" };
		expect(renderAgyAcpPermission(unsafeLong, false, mockTheme, "Ctrl+O to expand").render(120)).toEqual([
			"[warning]AGY sent a request Pi can't show safely, so Pi rejected it.",
		]);
	});
});
