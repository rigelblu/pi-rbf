// A private agent dir and the message-log variable, for a test that reads `<agent dir>/rbf-agy-wire.jsonl`. `stop()` puts both environment variables back.
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface WireLogRun {
	/** The agent dir. It does not exist until something is written to it. */
	dir: string;
	file: string;
	exists(): boolean;
	lines(): Record<string, any>[];
	stop(): void;
}

export function startWireLog(on = true): WireLogRun {
	const base = process.env.PI214_TEST_ROOT ?? process.env.RBF_AGY_TEST_ROOT ?? process.env.RBF_AGY_TEST_TMP ?? tmpdir();
	mkdirSync(base, { recursive: true });
	const dir = join(mkdtempSync(join(base, "wire-")), "agent"), saved = { agent: process.env.PI_CODING_AGENT_DIR, log: process.env.RBF_AGY_WIRE_LOG };
	process.env.PI_CODING_AGENT_DIR = dir;
	if (on) process.env.RBF_AGY_WIRE_LOG = "1";
	else delete process.env.RBF_AGY_WIRE_LOG;
	const file = join(dir, "rbf-agy-wire.jsonl");
	return {
		dir, file,
		exists: () => existsSync(file),
		lines: () => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [],
		stop() {
			for (const [name, value] of [["PI_CODING_AGENT_DIR", saved.agent], ["RBF_AGY_WIRE_LOG", saved.log]] as const) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		},
	};
}
