// The row gate's `rbf-codex`: the real extension, pointed at the fake app-server instead of `codex`.
// Loaded into a real interactive Pi with `-e`, so every Codex row renders through Pi's own loop,
// row shell, and theme. RBF_FAKE_SCENARIO reaches the fake through Pi's environment.
import { resolve } from "node:path";
import { createRbfCodex } from "../rbf-codex.ts";

const FAKE = resolve(import.meta.dirname, "rbf-codex-fake-app-server.ts");

export default createRbfCodex({ command: { bin: process.execPath, args: [FAKE] } });
