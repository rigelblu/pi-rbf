import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Explicit fake executable injection: no executable discovery or native fallback. */
export function createAgyStreamFixture(root: string, scenario = "normal", holdMs = 600) {
 const executable = join(root, "fake-agy.cjs"), log = join(root, "native.jsonl");
 const worker = readFileSync(new URL("./agy-stream-worker.cjs", import.meta.url), "utf8");
 writeFileSync(executable, `#!${process.execPath}\nconst FIXTURE_LOG=${JSON.stringify(log)}, FIXTURE_SCENARIO=${JSON.stringify(scenario)}, FIXTURE_HOLD_MS=${holdMs};\n` + worker);
 chmodSync(executable, 0o700);
 return { executable, log };
}
