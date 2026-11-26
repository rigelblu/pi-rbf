import { describe, expect, it } from "vitest";
import { cliLaunches } from "./test-support/agy-launch-check.js";

describe("cliLaunches: the check behind A21.3-6's `no --print argument anywhere`", () => {
	it("passes the launches the ACP route makes and rows that are not launches", () => {
		expect(cliLaunches([{ args: ["acp"] }, { args: ["acp", "--sandbox"] }, { args: ["models"] }, { out: {} }, { in: {} }])).toEqual([]);
	});
	it("finds a `--print` anywhere, a `--version` and an empty or unknown start, so the check can fail", () => {
		expect(cliLaunches([{ args: ["--print=", "--output-format", "stream-json"] }])).toHaveLength(1);
		expect(cliLaunches([{ args: ["acp", "--print"] }])).toHaveLength(1);
		expect(cliLaunches([{ args: ["--version"] }, { args: [] }, { args: ["serve"] }])).toHaveLength(3);
	});
});
