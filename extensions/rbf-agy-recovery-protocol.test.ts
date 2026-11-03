import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOwnedNativeProtocol, type NativeResume } from "./lib/agy-native.js";
const raw = (name: string) => readFileSync(join(import.meta.dirname, "fixtures/agy-recovery", name), "utf8").trim().split("\n").map(line => JSON.parse(line));
const seed = raw("seed.ndjson"), resumed = raw("resumed.ndjson"), init = seed[0];
const baseline: NativeResume = { conversationId: init.conversation_id, permissionMode: init.init.permission_mode, acceptedCount: 1, frontier: 1 };
function protocol(resume?: NativeResume) {
	const failures: string[] = [], boundaries: any[] = [];
	const p = createOwnedNativeProtocol({ model: init.init.model, cwd: init.init.cwd, resume }, { onInit() {}, onEvent() {}, onBoundary(event, accepted) { boundaries.push({ event, accepted }); }, onFailure(reason) { failures.push(reason); } });
	const feed = (...frames: any[]) => p.feed(Buffer.from(frames.map(x => JSON.stringify(x)).join("\n") + "\n"));
	return { p, failures, boundaries, feed };
}
describe("captured CLI 1.4.12 clean-turn boundaries", () => {
	it("accepts the exact recorded seed and restored cumulative continuation", () => {
		const first = protocol(); first.feed(seed[0]); first.p.beginRequest(); first.p.markWriteAttempt(); first.feed(...seed.slice(1));
		expect(first.p.snapshot()).toMatchObject({ failure: null, acceptedCount: 1, acceptedFrontier: 1 });
		const next = protocol(baseline); next.feed(resumed[0]); expect(next.p.beginRequest()).toBe(2); next.p.markWriteAttempt(); next.feed(...resumed.slice(1));
		expect(next.p.snapshot()).toMatchObject({ failure: null, acceptedCount: 2, acceptedFrontier: 4 });
		expect(next.boundaries[0].event.response.trim()).toBe("PI214_629bd9f5c8e76942");
	});
	it("the same recording fails when a fresh parser resets cumulative state", () => {
		const next = protocol(); next.feed(resumed[0]); next.p.beginRequest(); next.p.markWriteAttempt(); next.feed(...resumed.slice(1));
		expect(next.failures).toEqual(["Unrequested, stale or skipped native terminal"]); expect(next.boundaries).toHaveLength(0);
	});
	it.each(["id", "mode", "historical-step", "count-reset", "count-skip", "frontier-reset"])("rejects %s", kind => {
		const next = protocol(baseline), start = structuredClone(resumed[0]);
		if (kind === "id") start.conversation_id = "fallback-fresh-id";
		if (kind === "mode") start.init.permission_mode = "default";
		next.feed(start);
		if (!["id", "mode"].includes(kind)) {
			if (kind === "historical-step") next.feed(resumed[2]);
			else {
				next.p.beginRequest(); next.p.markWriteAttempt(); const frames = structuredClone(resumed.slice(1));
				if (kind === "count-reset") frames.at(-1).result.num_turns = 1;
				if (kind === "count-skip") frames.at(-1).result.num_turns = 3;
				if (kind === "frontier-reset") frames[0].step_update.step_index = 0;
				next.feed(...frames);
			}
		}
		expect(next.failures).toHaveLength(1); expect(next.boundaries).toHaveLength(0);
	});
});
