import { describe, expect, it } from "vitest";
import {
	assertOutputInsideRoot,
	assessReceipt,
	parseArgs,
	type DaemonOwnershipReceipt,
} from "./rbf-codex-daemon-ownership-probe.js";

describe("rbf-codex-daemon-ownership-probe", () => {
	it("accepts only bounded absolute paths", () => {
		expect(
			parseArgs([
				"--root",
				"/private/tmp/pi-10",
				"--codex",
				"/usr/local/bin/codex",
				"--output",
				"/private/tmp/pi-10/receipt.json",
			]),
		).toEqual({
			root: "/private/tmp/pi-10",
			codex: "/usr/local/bin/codex",
			output: "/private/tmp/pi-10/receipt.json",
		});
		expect(() => parseArgs(["--root", "relative"])).toThrow();
		expect(() => parseArgs(["--extra", "/tmp/nope"])).toThrow("Unknown argument");
	});

	it("contains the receipt below its isolated root", () => {
		expect(() => assertOutputInsideRoot("/private/tmp/pi-10", "/private/tmp/pi-10/receipt.json")).not.toThrow();
		expect(() => assertOutputInsideRoot("/private/tmp/pi-10", "/private/tmp/receipt.json")).toThrow("below the probe root");
	});

	it("passes only the complete daemon rejoin contract", () => {
		const receipt: Omit<DaemonOwnershipReceipt, "pass"> = {
			schema: "rbf-codex-daemon-ownership-probe/v1",
			codexVersion: "0.154.0",
			daemonBackend: "pid",
			daemonPidSha256: "pid",
			socketPathSha256: "socket",
			threadIdSha256: "thread",
			turnIdSha256: "turn",
			commandStartedBeforeDisconnect: true,
			firstProxyExited: true,
			rejoinedSameThread: true,
			rejoinedRunningTurn: true,
			terminalTurnStatus: "completed",
			sameTurnOccurrences: 1,
			completionCanaryMatches: 1,
			daemonStopReported: true,
			daemonPidAbsent: true,
			socketAbsent: true,
			finalDaemonProcesses: 0,
		};
		expect(assessReceipt(receipt)).toBe(true);
		expect(assessReceipt({ ...receipt, daemonBackend: "unknown" })).toBe(false);
		expect(assessReceipt({ ...receipt, sameTurnOccurrences: 2 })).toBe(false);
		expect(assessReceipt({ ...receipt, terminalTurnStatus: "interrupted" })).toBe(false);
	});
});
