import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { replayScreen } from "./test-support/rbf-pty-screen.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DRIVER = join(import.meta.dirname, "test-support/rbf-row-gate-drive.py");
const EXT = join(import.meta.dirname, "test-support/rbf-codex-agents-extension.ts");
const HOSTS = process.env.RBF_FOOTER_PI ? [process.env.RBF_FOOTER_PI] : [join(ROOT, "node_modules/.bin/pi"), "/Users/tomhosiawa/Library/pnpm/bin/pi"];
const submit = (text: string) => [{ paste: text }, { key: "enter" }];

describe("Codex agents stay behind the footer in actual Pi", () => {
	for (const host of HOSTS) for (const cols of [80, 120]) it(`${host} announcements, updates and reload at ${cols}`, () => {
		const dir = join(process.env.RBF_AGENTS_PTY_TMPDIR ?? "/Volumes/tom-ssd/tmp/pi-10.12/native", `${Date.now()}-visibility-${cols}`);
		const agent = join(dir, "agent"), sessions = join(dir, "sessions");
		mkdirSync(agent, { recursive: true }); mkdirSync(sessions, { recursive: true });
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "codex-harness", defaultModel: "codex", defaultThinkingLevel: "medium" }));
		const session = join(sessions, "fixture.jsonl");
		writeFileSync(session, JSON.stringify({ type: "session", version: 3, id: "visibility-fixture", timestamp: "2026-10-20T14:00:00.000Z", cwd: dir }) + "\n");
		const scenario = { retainHistory: true, turn: [
			{ kind: "subAgent", activity: "started", agentThreadId: "agent-a", agentPath: "/root/Reviewer" },
			{ kind: "sleep", ms: 1100 },
			{ kind: "collab", tool: "spawnAgent", prompt: "Implement the small fix", receivers: ["agent-b"], states: { "agent-b": "running" } },
			{ kind: "subAgent", activity: "started", agentThreadId: "agent-b", agentPath: "/root/Builder" },
			{ kind: "subAgent", activity: "completed", agentThreadId: "agent-a", agentPath: "/root/Reviewer" },
			{ kind: "sleep", ms: 2500 },
			{ kind: "subAgent", activity: "completed", agentThreadId: "agent-b", agentPath: "/root/Builder" },
			{ kind: "sleep", ms: 900 },
			{ kind: "answer", id: "done", text: "VISIBILITY_DONE" }, { kind: "complete" },
		] };
		const persisted = (count: number) => ({ waitJsonl: { path: session, field: "customType", value: "rbf-codex-agents/v1", count } });
		const steps = [
			{ wait: "codex" }, { sleep: .4 }, { snapshot: "empty" }, ...submit("delegate"),
			persisted(1), { snapshot: "single" }, persisted(2), { snapshot: "multiple" },
			{ locate: { name: "badge", text: "· agents", columnText: "agents" } },
			{ bytes: "\x1b[<0;{badgeX};{badge}M" }, { bytes: "\x1b[<0;{badgeX};{badge}m" },
			{ wait: "Observed" }, { sleep: .2 }, { snapshot: "opened" }, { key: "escape" }, { sleep: .2 }, { snapshot: "closed" }, { sessionSnapshot: { dir: sessions, name: "closed_state" } }, persisted(3), { snapshot: "updated_closed" },
			{ wait: "VISIBILITY_DONE" }, { sleep: .4 }, { snapshot: "ended" },
			...submit("/reload"), { sleep: 1 }, { snapshot: "restored" }, ...submit("/agents-codex"),
			{ wait: "Last recorded" }, { sleep: .2 }, { snapshot: "command" }, { key: "escape" }, { sleep: .2 }, { snapshot: "dismissed" },
		];
		const raw = join(dir, "terminal.raw");
		const plan = { cwd: dir, argv: [host, "--no-extensions", "--no-skills", "--no-prompt-templates", "-e", EXT, "--session", session, "--session-dir", sessions, "--tui-mode", "fullscreen"], env: { PI_CODING_AGENT_DIR: agent, RBF_FAKE_SCENARIO: JSON.stringify(scenario), RBF_FAKE_LOG: join(dir, "native.jsonl"), RBF_FAKE_HISTORY: join(dir, "history.json") }, cols, rows: 38, timeout: 20, out: raw, steps };
		writeFileSync(join(dir, "plan.json"), JSON.stringify(plan, null, 2));
		const result = spawnSync("python3", [DRIVER], { input: JSON.stringify(plan), encoding: "utf8", timeout: 25000 });
		writeFileSync(join(dir, "result.json"), JSON.stringify({ code: result.status, stderr: result.stderr, marks: result.stdout }, null, 2));
		expect(result.status, dir + " " + result.stderr).toBe(0);
		const bytes = readFileSync(raw), marks = JSON.parse(result.stdout);
		const screen = (mark: string) => {
			const text = replayScreen(bytes.subarray(0, marks[mark]), cols, 38).lines.join("\n");
			writeFileSync(join(dir, mark + ".txt"), text); return text;
		};
		expect(screen("empty")).not.toContain("· agents");
		for (const mark of ["single", "multiple", "closed", "updated_closed", "ended", "restored", "dismissed"]) {
			const text = screen(mark);
			expect(text, mark).toContain("· agents");
			expect(text, mark).not.toContain("Codex agents ·");
			expect(text, mark).not.toContain("Reviewer");
			expect(text, mark).not.toContain("Builder");
		}
		for (const mark of ["opened", "command"]) {
			const text = screen(mark);
			expect(text).toContain("Reviewer [agent-a]");
			expect(text).toContain("Builder [agent-b]");
			expect(text).toContain("Implement the small fix");
			expect(text).toContain("Completed");
		}
		expect(screen("command")).toContain("Last recorded:");
		const closedRecords = readFileSync(session).subarray(0, marks.closed_state.bytes).toString("utf8").trim().split("\n").map(line => JSON.parse(line));
		const closedRoster = closedRecords.filter(entry => entry.customType === "rbf-codex-agents/v1").at(-1).data.agents;
		expect(closedRoster.find((entry: any) => entry.threadId === "agent-b").status).toBe("running");

		const calls = readFileSync(join(dir, "native.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
		expect(calls.filter(call => call.method === "turn/start")).toHaveLength(1);
		writeFileSync(join(dir, "receipt.json"), JSON.stringify({ host, cols, sourceSHA256: createHash("sha256").update(readFileSync(process.env.RBF_AGENTS_SOURCE ?? join(ROOT, "extensions/rbf-codex.ts"))).digest("hex"), providerCalls: 0, fakeTurns: 1 }, null, 2));
		console.log("agent visibility receipt: " + dir);
	}, 30000);
});
