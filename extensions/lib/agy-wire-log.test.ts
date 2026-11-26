import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { startWireLog, type WireLogRun } from "../test-support/agy-wire-log-env.js";
import { WIRE_LOG_FILE, wireLog, wireLogOn, wireLogPath } from "./agy-wire-log.js";

let run: WireLogRun | undefined;
afterEach(() => { run?.stop(); run = undefined; });

describe("the opt-in message log", () => {
	it("appends one JSON line per event, with a time in ms, to rbf-agy-wire.jsonl in Pi's agent dir, and makes the dir", () => {
		run = startWireLog();
		expect(existsSync(run.dir)).toBe(false);
		const before = Date.now();
		wireLog("in", { kind: "request", method: "session/request_permission", id: "1", toolCallId: "call_1" });
		wireLog("out", { kind: "reply", id: "1", optionId: "allow", delivered: true });
		expect(wireLogPath()).toBe(run.file);
		expect(run.file.endsWith("/" + WIRE_LOG_FILE)).toBe(true);
		const lines = run.lines();
		expect(lines).toEqual([
			{ t: expect.any(Number), ev: "in", kind: "request", method: "session/request_permission", id: "1", toolCallId: "call_1" },
			{ t: expect.any(Number), ev: "out", kind: "reply", id: "1", optionId: "allow", delivered: true },
		]);
		expect(lines[0].t).toBeGreaterThanOrEqual(before);
		expect(lines[1].t).toBeGreaterThanOrEqual(lines[0].t);
	});

	it.each([undefined, "0", "true", "yes", ""])("writes nothing, and makes no folder, when the variable is %j", value => {
		run = startWireLog(false);
		if (value !== undefined) process.env.RBF_AGY_WIRE_LOG = value;
		expect(wireLogOn()).toBe(false);
		wireLog("q", { step: "request", toolCallId: "call_1" });
		wireLog("dlg", { step: "key", key: "enter" });
		expect(run.exists()).toBe(false);
		expect(existsSync(run.dir)).toBe(false);
	});

	it("keeps only scalars, cut to 160 characters, so an object or a long text cannot get in whole", () => {
		run = startWireLog();
		wireLog("q", { step: "request", ok: true, none: null, n: 3, nan: Number.NaN, nested: { text: "SECRET" }, list: ["SECRET"], fn: () => "SECRET", missing: undefined, long: "x".repeat(500) });
		const [line] = run.lines();
		expect(line).toEqual({ t: expect.any(Number), ev: "q", step: "request", ok: true, none: null, n: 3, nan: null, long: "x".repeat(160) + "…" });
		expect(JSON.stringify(line)).not.toContain("SECRET");
	});

	it("never throws when the log cannot be written", () => {
		run = startWireLog();
		process.env.PI_CODING_AGENT_DIR = "/dev/null/not-a-folder";
		expect(() => wireLog("rec", { customType: "x", result: "ok" })).not.toThrow();
	});
});
