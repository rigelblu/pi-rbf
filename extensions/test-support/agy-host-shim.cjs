#!/usr/bin/env node
// The `agy` executable for the actual-Pi scenarios of the ACP route (#pi-21.3, A21.3-4). Offline: it reaches only the two fakes.
//   agy acp      -> the ACP fake (agy-acp-fake.cjs), logging to <root>/acp.jsonl; PI213_ACP_MODE picks its modes
//   agy models   -> the catalogue the scenarios select from (families with their three levels)
//   anything else -> exit 2: the CLI route is deleted, so nothing may call `agy --print` or `agy --version`
"use strict";
const path = require("node:path");
const root = process.env.PI213_OFFLINE_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error("PI213_OFFLINE_ROOT required");
const args = process.argv.slice(2);
// Every start is logged here, before anything decides what to serve, so a start the shim then refuses (`--print`, `--version`) is still seen: <root>/launches.jsonl, one `{ args }` row each.
require("node:fs").appendFileSync(path.join(root, "launches.jsonl"), JSON.stringify({ args, t: Date.now() }) + "\n");
if (args[0] === "acp") require("./agy-acp-fake.cjs")({ log: path.join(root, "acp.jsonl"), mode: process.env.PI213_ACP_MODE || "", release: path.join(root, "release") });
else if (args[0] === "models" && process.env.PI213_MODELS_FILE) process.stdout.write(require("node:fs").readFileSync(process.env.PI213_MODELS_FILE)); // a saved `agy models` list, e.g. fixtures/agy-models-1.5.14.txt
else if (args[0] === "models") {
	// The Gemini families Pi offers, then the Claude and GPT-OSS rows it must drop (Decisions 2026-11-22: Gemini only).
	const rows = ids => ids.flatMap(id => ["low", "medium", "high"].map(level => `${id}-${level}\t${id} (${level})`));
	console.log([...rows(["gemini-4-argon", "gemini-3.8-flash", "gemini-4-neon", "gemini-4-hydrogen"]), "gemini-pro-orchestrator-neon\tOrchestrator (Neon)", ...rows(["claude-opus-5-5", "claude-sonnet-5-5"]), "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)"].join("\n"));
}
else {
	// Nothing else is served: the CLI route (`agy --print`, `--version`) is deleted, so any other call is a bug the test should see.
	console.error("agy-host-shim: only `acp` and `models` are served; got " + JSON.stringify(args));
	process.exit(2);
}
