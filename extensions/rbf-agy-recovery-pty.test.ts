import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { replayScreen } from "./test-support/rbf-pty-screen.js";
const ROOT = resolve(import.meta.dirname, ".."), HOST = "/Users/tomhosiawa/Library/pnpm/bin/pi";
const submit = (paste: string) => [{ paste }, { key: "enter" }];
describe("clean recovery in actual daily Pi TUI with fake native", () => {
	it("persists, /reloads and process-reopens with exact native identity and no replay", () => {
		const base = process.env.PI214_TEST_ROOT; if (!base) throw new Error("Resolved test root required");
		mkdirSync(base, { recursive: true }); const root = mkdtempSync(join(base, "pty-"));
		const agent = join(root, "agent"), sessions = join(root, "sessions"), cwd = join(root, "workspace");
		for (const dir of [agent, sessions, cwd]) mkdirSync(dir);
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low", theme: "dark" }));
		const run = (name: string, steps: any[], session?: string) => {
			const out = join(root, name + ".raw");
			const plan = { cwd, argv: [HOST, "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-builtin-tools", "-e", join(ROOT, "extensions/test-support/agy-recovery-extension.ts"), "--session-dir", sessions, ...(session ? ["--session", session] : []), "--tui-mode", "fullscreen"], env: { PI_CODING_AGENT_DIR: agent, PI214_OFFLINE_ROOT: root }, cols: 100, rows: 38, timeout: 24, out, steps };
			writeFileSync(join(root, name + ".plan.json"), JSON.stringify(plan, null, 2));
			const result = spawnSync("python3", [join(ROOT, "extensions/test-support/rbf-row-gate-drive.py")], { input: JSON.stringify(plan), encoding: "utf8", timeout: 30000 });
			writeFileSync(join(root, name + ".result.json"), JSON.stringify(result, null, 2));
			expect(result.status, root + " " + result.stderr).toBe(0);
			const marks = JSON.parse(result.stdout), screen = replayScreen(readFileSync(out).subarray(0, marks.done), 100, 38).lines.join("\n");
			writeFileSync(join(root, name + ".screen.txt"), screen); return screen;
		};
		const first = run("reload", [{ wait: "OFFLINE_READY" }, ...submit("/model agy-harness/gemini-3.8-flash"), { sleep: 1 }, ...submit("Remember MAPLE-PTY214."), { wait: "OFFLINE_SAVED_1" }, ...submit("/reload"), { sleep: 1.5 }, ...submit("Recall my label."), { wait: "OFFLINE_SAVED_2" }, { snapshot: "done" }, ...submit("/quit"), { waitExit: 4 }]);
		expect(first).toContain("OFFLINE_ANSWER_2 MAPLE-PTY214");
		expect(first).not.toContain("AGY recovery checkpoint could not be confirmed.");

		const file = join(sessions, readdirSync(sessions).find(x => x.endsWith(".jsonl"))!);
		const reopened = run("reopen", [{ wait: "OFFLINE_READY" }, ...submit("Recall after restart."), { wait: "OFFLINE_SAVED_3" }, { snapshot: "done" }, ...submit("/quit"), { waitExit: 4 }], file);
		expect(reopened).toContain("OFFLINE_ANSWER_3 MAPLE-PTY214");
		for (const name of ["reload.raw", "reopen.raw"]) {
			const raw = readFileSync(join(root, name), "utf8");
			expect(raw).toContain("AGY context: unknown");
			expect(raw).not.toMatch(/AGY — (checking saved conversation|starting|running|stopping)/);
		}
		const native = readFileSync(join(root, "native.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
		expect(native.filter(x => x.event === "input").map(x => x.request.message.content)).toEqual(["Remember MAPLE-PTY214.", "Recall my label.", "Recall after restart."]);
		const saved = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
		const checkpoints = saved.filter(x => x.customType === "rbf-agy-completion/v1");
		expect(checkpoints.map(x => [x.data.acceptedCount, x.data.frontier])).toEqual([[1, 1], [2, 3], [3, 5]]);
		expect(new Set(checkpoints.map(x => x.data.conversationId)).size).toBe(1);
		const loads = readFileSync(join(root, "host.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(e => e.event === "loaded");
		const expectedHashes = Object.fromEntries(["rbf-agy.ts", "lib/agy-native.ts", "lib/agy-recovery.ts"].map(file => [file, createHash("sha256").update(readFileSync(join(ROOT, "extensions", file))).digest("hex")]));
		expect(loads).toHaveLength(3); for (const load of loads) expect(load.hashes).toEqual(expectedHashes);
		console.log("Actual Pi offline receipt: " + root);
	}, 65000);
	it("keeps the saved answer visible and warns when checkpoint saving fails in actual Pi", () => {
		const base = process.env.PI214_TEST_ROOT; if (!base) throw new Error("Resolved root required");
		const root = mkdtempSync(join(base, "pty-fault-")), agent = join(root, "agent"), sessions = join(root, "sessions"), cwd = join(root, "workspace");
		for (const dir of [agent, sessions, cwd]) mkdirSync(dir);
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low", theme: "dark" }));
		const out = join(root, "terminal.raw");
		const plan = { cwd, argv: [HOST, "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-builtin-tools", "-e", join(ROOT, "extensions/test-support/agy-recovery-extension.ts"), "--session-dir", sessions, "--tui-mode", "fullscreen"], env: { PI_CODING_AGENT_DIR: agent, PI214_OFFLINE_ROOT: root, PI214_OFFLINE_FAIL_COMPLETION: "1" }, cols: 100, rows: 38, timeout: 15, out, steps: [{ wait: "OFFLINE_READY" }, ...submit("/model agy-harness/gemini-3.8-flash"), { sleep: .6 }, ...submit("Remember MAPLE-FAULT214."), { wait: "OFFLINE_SAVED_0" }, { sleep: .2 }, { snapshot: "warning" }, ...submit("/quit"), { waitExit: 4 }] };
		writeFileSync(join(root, "plan.json"), JSON.stringify(plan, null, 2));
		const result = spawnSync("python3", [join(ROOT, "extensions/test-support/rbf-row-gate-drive.py")], { input: JSON.stringify(plan), encoding: "utf8", timeout: 20000 });
		writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2)); expect(result.status, root + " " + result.stderr).toBe(0);
		const marks = JSON.parse(result.stdout), screen = replayScreen(readFileSync(out).subarray(0, marks.warning), 100, 38).lines.join("\n");
		writeFileSync(join(root, "warning.screen.txt"), screen);
		expect(screen).toContain("OFFLINE_ANSWER_1 MAPLE-FAULT214");
		expect(screen).toContain("AGY recovery checkpoint could not be confirmed.");
		expect(screen.replace(/\s+/g, " ")).toContain("recovery may be unavailable after restart.");
		const file = join(sessions, readdirSync(sessions).find(x => x.endsWith(".jsonl"))!), saved = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
		expect(saved.filter(e => e.message?.role === "assistant" && e.message.stopReason === "stop")).toHaveLength(1);
		expect(saved.filter(e => e.customType === "rbf-agy-completion/v1")).toHaveLength(0);
		console.log("Actual Pi checkpoint fault receipt: " + root);
	}, 25000);

});
