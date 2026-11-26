// A21.3-4: the AGY ACP route in actual Pi 1.6.0, with the fake ACP server behind agy-host-shim.cjs. Reads the real session file Pi wrote.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { readSavedSession, selectAcpRecoveryAnchor } from "./lib/agy-recovery.js";
import { replayScreen } from "./test-support/rbf-pty-screen.js";
import { cliLaunches } from "./test-support/agy-launch-check.js";

const ROOT = resolve(import.meta.dirname, ".."), HOST = "/Users/tomhosiawa/Library/pnpm/bin/pi";
const ACP_SOURCE_FILES = ["rbf-agy.ts", "lib/agy-acp.ts", "lib/agy-acp-session.ts", "lib/agy-recovery.ts", "lib/agy-history.ts", "lib/agy-acp-approval.ts"];
const submit = (paste: string) => [{ paste }, { key: "enter" }];
const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));

/**
 * Runs the PTY driver without blocking the test worker. Vitest's worker answers its own RPC calls only when its event loop turns; ten tests of back-to-back spawnSync calls
 * (80 s in all) starved it past the 60 s limit and failed the file with "[vitest-worker]: Timeout calling onTaskUpdate", though every test passed.
 */
function runDriver(plan: object, timeoutMs: number): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise(resolve => {
		const child = spawn("python3", [join(ROOT, "extensions/test-support/rbf-row-gate-drive.py")], { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", d => { stdout += d; });
		child.stderr.on("data", d => { stderr += d; });
		child.on("close", status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
		child.stdin.end(JSON.stringify(plan));
	});
}

// A21.3-6: across every case of this file, no start of the fake `agy` carries `--print` or is anything but `acp` or `models`. The shim logs every start, whatever it then serves, in its profile's launches.jsonl.
const profileRoots: string[] = [];
afterEach(() => {
	const cli = profileRoots.splice(0).flatMap(root => existsSync(join(root, "launches.jsonl")) ? cliLaunches(lines(join(root, "launches.jsonl"))) : []);
	expect(cli, "a start of the fake agy that only the CLI route made").toEqual([]);
});

/** A private Pi profile (agent dir and HOME), session folder and offline root for one scenario. */
function profile(name: string) {
	const base = process.env.PI214_TEST_ROOT; if (!base) throw new Error("Resolved test root required");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, `${name}-`)), agent = join(root, "agent"), home = join(root, "home"), sessions = join(root, "sessions"), cwd = join(root, "workspace");
	for (const dir of [agent, home, sessions, cwd]) mkdirSync(dir);
	profileRoots.push(root);
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low", theme: "dark" }));
	/** One Pi process. `extension` is the host extension; `session` reopens a saved file; `env` adds to the scenario's env. */
	const run = async (label: string, steps: any[], opts: { extension?: string; session?: string; env?: Record<string, string>; cols?: number; rows?: number; timeout?: number; dropFlags?: string[]; extraFlags?: string[] } = {}) => {
		const cols = opts.cols ?? 100, rows = opts.rows ?? 38, timeout = opts.timeout ?? 40;
		const out = join(root, label + ".raw");
		const plan = {
			cwd, out, steps, cols, rows, timeout,
			argv: [HOST, ...["--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-builtin-tools"].filter(flag => !opts.dropFlags?.includes(flag)), ...(opts.extraFlags ?? []), "-e", join(ROOT, "extensions/test-support", opts.extension ?? "rbf-agy-acp-host-extension.ts"), "--session-dir", sessions, ...(opts.session ? ["--session", opts.session] : []), "--tui-mode", "fullscreen"],
			env: { PI_CODING_AGENT_DIR: agent, HOME: home, PI_TELEMETRY: "0", PI213_OFFLINE_ROOT: root, PI214_OFFLINE_ROOT: root, ...opts.env },
		};
		writeFileSync(join(root, label + ".plan.json"), JSON.stringify(plan, null, 2));
		const result = await runDriver(plan, Math.max(60000, (timeout + 20) * 1000));
		writeFileSync(join(root, label + ".result.json"), JSON.stringify(result, null, 2));
		expect(result.status, root + " " + result.stderr).toBe(0);
		const marks = JSON.parse(result.stdout), raw = readFileSync(out);
		const linesAt = (mark?: string | number) => replayScreen(raw.subarray(0, typeof mark === "number" ? mark : mark ? marks[mark] : marks.done ?? raw.length), cols, rows).lines;
		const screenAt = (mark?: string | number) => linesAt(mark).join("\n");
		return { marks, raw, linesAt, screenAt, cols, rows };
	};
	const sessionFile = () => join(sessions, readdirSync(sessions).find(x => x.endsWith(".jsonl"))!);
	const sessionFiles = () => readdirSync(sessions).filter(x => x.endsWith(".jsonl")).sort().map(x => join(sessions, x));
	const acp = () => existsSync(join(root, "acp.jsonl")) ? lines(join(root, "acp.jsonl")) : [];
	/** Every start of the fake `agy`, in order, as `{ args }`: what the shim saw, whether or not it served it. */
	const launches = () => existsSync(join(root, "launches.jsonl")) ? lines(join(root, "launches.jsonl")) : [];
	const host = () => existsSync(join(root, "host.jsonl")) ? lines(join(root, "host.jsonl")) : [];
	return { root, run, sessionFile, sessionFiles, acp, launches, host, sessions };
}

const methods = (rows: any[]) => rows.filter(r => r.in).map(r => r.in.method as string);
const calls = (rows: any[], method: string) => rows.filter(r => r.in?.method === method).map(r => r.in);
/** What sits in Pi's editor box: the lines between the last two rules above the footer. */
function editorText(screen: string) {
	const rows = screen.split("\n"), rules = rows.flatMap((row, i) => /^─{40,}$/.test(row) ? [i] : []);
	return rows.slice(rules.at(-2)! + 1, rules.at(-1)!).join("\n").trim();
}
const sourceHashes = (files: string[]) => Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(join(ROOT, "extensions", file))).digest("hex")]));

function assertScreenFits(screenLines: string[], cols: number) {
	for (const line of screenLines) expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
}

function assertOnlyFakeLaunches(hostRows: any[]) {
	expect(hostRows.filter(e => e.event === "offline_provider_refused")).toEqual([]);
	const admitted = hostRows.filter(e => e.event === "offline_input_admitted");
	expect(admitted.length).toBeGreaterThan(0);
	for (const item of admitted) expect(item.modelProvider).toBe("agy-harness");
}

describe("pi-21.3 ACP chat in actual Pi with a fake ACP server", () => {
	it("writes its records to the saved file, then resumes the same ACP session after /reload and after a restart, also after a refusal", async () => {
		const p = profile("acp-pty"), hostLog = join(p.root, "host.jsonl");
		const first = await p.run("first", [
			{ wait: "ACP_READY_startup" }, ...submit("/model agy-harness/gemini-3.8-flash"), { sleep: 1 },
			...submit("Remember MAPLE-A1."), { wait: "ACP_SAVED_C1_R0" }, { snapshot: "answered" },
			...submit("/goal finish the report"), { wait: "ACP_SAVED_C1_R1" }, { sleep: 0.5 }, { snapshot: "refused" },
			{ key: "up" }, { sleep: 0.5 }, { snapshot: "after-up" }, { bytes: "\u0005" }, { key: "ctrl-u" }, { sleep: 0.3 }, { snapshot: "cleared" },
			...submit("/reload"), { waitJsonl: { path: hostLog, field: "event", value: "loaded", count: 2 } }, { wait: "Reloaded keybindings" }, { sleep: 1 },
			...submit("Second question."), { wait: "ACP_SAVED_C2_R1" }, { snapshot: "resumed" },
			...submit("/quit"), { waitExit: 5 },
		]);
		writeFileSync(join(p.root, "screens.txt"), ["answered", "refused", "after-up", "cleared", "resumed"].map(n => `==== ${n}\n${first.screenAt(n)}`).join("\n"));

		// The records are on disk, in order, and name one ACP session.
		const file = p.sessionFile(), afterFirst = lines(file), types = (entries: any[]) => entries.filter(e => String(e.customType).startsWith("rbf-agy-")).map(e => e.customType);
		expect(types(afterFirst)).toEqual(["rbf-agy-acp-conversation/v1", "rbf-agy-acp-dispatch/v1", "rbf-agy-acp-completion/v1", "rbf-agy-acp-refusal/v1", "rbf-agy-acp-dispatch/v1", "rbf-agy-acp-completion/v1"]);
		const [conversation, dispatch1, completion1, refusal, dispatch2, completion2] = afterFirst.filter(e => String(e.customType).startsWith("rbf-agy-"));
		const acpSessionId = conversation.data.acpSessionId;
		expect(conversation.data).toEqual({ acpSessionId: expect.stringMatching(/^fake-acp-/), cwd: expect.stringContaining("/workspace"), piSessionId: afterFirst[0].id });
		for (const record of [dispatch1, completion1, refusal, dispatch2, completion2]) expect(record.data.acpSessionId).toBe(acpSessionId);
		expect(dispatch1.data.previousCompletionId).toBeNull();
		expect(refusal.data).toMatchObject({ completionId: completion1.id, conversationEntryId: conversation.id });
		expect(dispatch2.data.previousCompletionId).toBe(completion1.id);
		// Saved before the first prompt: the order in the file is conversation, then dispatch, then the user's answer, then the completion.
		const order = afterFirst.map(e => e.customType ?? (e.type === "message" ? e.message.role : e.type));
		expect(order.slice(order.indexOf("rbf-agy-acp-conversation/v1"), order.indexOf("rbf-agy-acp-completion/v1") + 1)).toEqual(["rbf-agy-acp-conversation/v1", "rbf-agy-acp-dispatch/v1", "assistant", "rbf-agy-acp-completion/v1"]);

		const restarted = await p.run("restart", [{ wait: "ACP_READY_startup" }, ...submit("After restart."), { wait: "ACP_SAVED_C3_R1" }, { snapshot: "done" }, ...submit("/quit"), { waitExit: 5 }], { session: file });
		writeFileSync(join(p.root, "restart.screen.txt"), restarted.screenAt("done"));

		const rows = p.acp();
		expect(rows.filter(r => r.args).map(r => r.args)).toEqual([["acp"], ["acp"], ["acp"]]);
		// Each of the three children is retired with session/close, before Pi closes its stdin.
		expect(methods(rows)).toEqual([
			"initialize", "session/new", "session/set_config_option", "session/set_config_option", "session/prompt", "session/close",
			"initialize", "session/resume", "session/set_config_option", "session/set_config_option", "session/prompt", "session/close",
			"initialize", "session/resume", "session/set_config_option", "session/set_config_option", "session/prompt", "session/close",
		]);
		expect(calls(rows, "session/close").map(m => m.params.sessionId)).toEqual([acpSessionId, acpSessionId, acpSessionId]);
		expect(calls(rows, "session/resume").map(m => m.params.sessionId)).toEqual([acpSessionId, acpSessionId]);
		expect(calls(rows, "session/prompt").map(m => [m.params.sessionId, m.params.prompt[0].text])).toEqual([[acpSessionId, "Remember MAPLE-A1."], [acpSessionId, "Second question."], [acpSessionId, "After restart."]]);
		expect(calls(rows, "session/set_config_option").slice(2, 4).map(m => [m.params.configId, m.params.value])).toEqual([["model", "gemini-3.8-flash"], ["thought_level", "low"]]);
		const final = lines(file);
		expect(types(final)).toHaveLength(8);
		expect(final.filter(e => e.customType === "rbf-agy-acp-dispatch/v1").at(-1).data.previousCompletionId).toBe(completion2.id);
		expect(final.filter(e => e.customType === "rbf-agy-acp-conversation/v1")).toHaveLength(1);

		// The code that ran is the code in this workspace.
		const loads = lines(hostLog).filter(e => e.event === "loaded");
		expect(loads.map(e => e.reason)).toEqual(["startup", "reload", "startup"]);
		for (const load of loads) expect(load.hashes).toEqual(sourceHashes(ACP_SOURCE_FILES));
		for (const name of ["first.raw", "restart.raw"]) expect(readFileSync(join(p.root, name), "utf8")).not.toContain("could not be confirmed");

		// ER7, as measured in Pi 1.5.0: a refused message is not put back in the editor. It stays in the transcript and in the Up-arrow history.
		// The refusal is drawn once, as Pi's error line, not also as a plain line above it.
		const drawn = first.screenAt("refused").replace(/\s+/g, " ");
		expect(drawn.split("Pi doesn't send AGY commands yet.")).toHaveLength(2);
		expect(drawn).toContain("Error: AGY would run /goal as its own command.");
		expect(editorText(first.screenAt("refused"))).toBe("");
		expect(first.screenAt("refused")).toContain("/goal finish the report");
		expect(editorText(first.screenAt("after-up"))).toBe("/goal finish the report");
		console.log("ACP PTY receipt: " + p.root);
	}, 180000);

	// Pi 1.6.0 saves a role: "system" message before the user's whenever the system prompt's sections change (agent-session.js persists it; agent-loop.js declareToolChanges makes it).
	// Adding AGENTS.md between two runs is the everyday case (a skill needs Pi's read tool, which a resumed session keeps off, so it adds nothing here): the chat must resume, and the system text must never reach AGY.
	it("resumes the same ACP session after the system prompt changes between runs: a context file, then an appended system prompt", async () => {
		const p = profile("acp-sysprompt"), work = join(p.root, "workspace");
		const own = ["--no-skills", "--no-context-files", "--no-builtin-tools"]; // the brief: this case runs with Pi's own skills, context files and tools, as in daily use, which the other cases switch off
		const first = await p.run("first", [{ wait: "ACP_READY_startup" }, ...submit("/model agy-harness/gemini-3.8-flash"), { sleep: 1 }, ...submit("Remember MAPLE-S1."), { wait: "ACP_SAVED_C1_R0" }, ...submit("/quit"), { waitExit: 5 }], { dropFlags: own });
		const file = p.sessionFile(), systems = () => lines(file).filter(e => e.type === "message" && e.message?.role === "system");
		expect(systems()).toHaveLength(1);
		writeFileSync(join(work, "AGENTS.md"), "Probe rule: answer briefly.\n");
		const second = await p.run("second", [{ wait: "ACP_READY_startup" }, ...submit("Second question."), { wait: "ACP_SAVED_C2_R0" }, { snapshot: "done" }, ...submit("/quit"), { waitExit: 5 }], { session: file, dropFlags: own });
		expect(systems()).toHaveLength(2);
		const third = await p.run("third", [{ wait: "ACP_READY_startup" }, ...submit("Third question."), { wait: "ACP_SAVED_C3_R0" }, { snapshot: "done" }, ...submit("/quit"), { waitExit: 5 }], { session: file, dropFlags: own, extraFlags: ["--append-system-prompt", "Probe rule two: no bullet lists."] });
		for (const [name, run] of [["second", second], ["third", third]] as const) writeFileSync(join(p.root, `${name}.screen.txt`), run.screenAt("done"));
		expect(systems()).toHaveLength(3);
		// The system message sits before the user's message, and the chain resumed: no refusal record, three completions, one ACP session.
		const saved = lines(file), roles = saved.filter(e => e.type === "message").map(e => e.message.role);
		expect(roles).toEqual(["system", "user", "assistant", "system", "user", "assistant", "system", "user", "assistant"]);
		expect(saved.filter(e => e.customType === "rbf-agy-acp-refusal/v1")).toEqual([]);
		expect(saved.filter(e => e.customType === "rbf-agy-acp-completion/v1")).toHaveLength(3);
		const rows = p.acp(), acpSessionId = saved.find(e => e.customType === "rbf-agy-acp-conversation/v1").data.acpSessionId;
		expect(methods(rows).filter(m => m === "session/new")).toHaveLength(1);
		expect(calls(rows, "session/resume").map(m => m.params.sessionId)).toEqual([acpSessionId, acpSessionId]);
		// Only the user's text goes to AGY: no system text, no AGENTS.md or appended text.
		expect(calls(rows, "session/prompt").map(m => m.params.prompt[0].text)).toEqual(["Remember MAPLE-S1.", "Second question.", "Third question."]);
		expect(JSON.stringify(calls(rows, "session/prompt"))).not.toMatch(/Probe rule/);
		for (const screen of [first.screenAt(), second.screenAt("done"), third.screenAt("done")]) expect(screen).not.toContain("no longer matches");
	}, 180000);

	// A21.3-4 / ER5: the system-prompt case above keeps `--no-skills` and `--no-builtin-tools` on, which hid a defect before. Here Pi runs with its own tools, skills and context files, as in daily use. A tool switched off
	// in the middle of the chat makes Pi declare the change in a system message it saves with the next prompt; a skill edited between runs changes the system prompt on resume. Neither may lose the chat or reach AGY.
	it("resumes the same ACP session after a tool is switched off mid-chat and after a skill is edited between runs, with Pi's own tools, skills and context files on", async () => {
		const p = profile("acp-tools-skill"), skill = join(p.root, "agent", "skills", "probe", "SKILL.md");
		mkdirSync(join(p.root, "agent", "skills", "probe"), { recursive: true });
		writeFileSync(skill, "---\nname: probe\ndescription: Use when asked about the probe rule.\n---\nAnswer briefly.\n");
		const own = { dropFlags: ["--no-skills", "--no-context-files", "--no-builtin-tools"] };
		const first = await p.run("first", [
			{ wait: "ACP_READY_startup" }, ...submit("/model agy-harness/gemini-3.8-flash"), { sleep: 1 },
			...submit("Remember MAPLE-T1."), { wait: "ACP_SAVED_C1_R0" }, { sleep: 0.5 },
			...submit("/toggle-tool bash"), { wait: "ACP_TOOL_bash_OFF" }, { sleep: 0.3 },
			...submit("Second question."), { wait: "ACP_SAVED_C2_R0" }, { snapshot: "toggled" },
			...submit("/quit"), { waitExit: 5 },
		], own);
		const file = p.sessionFile(), saved1 = lines(file), roles1 = saved1.filter(e => e.type === "message").map(e => e.message.role);
		expect(roles1).toEqual(["system", "user", "assistant", "system", "user", "assistant"]); // the toggle's system message sits in front of the second user message
		writeFileSync(skill, "---\nname: probe\ndescription: Use when asked about the probe rule, which has changed.\n---\nAnswer in one line.\n");
		const second = await p.run("second", [{ wait: "ACP_READY_startup" }, ...submit("Third question."), { wait: "ACP_SAVED_C3_R0" }, { snapshot: "done" }, ...submit("/quit"), { waitExit: 5 }], { ...own, session: file });
		writeFileSync(join(p.root, "screens.txt"), `==== toggled\n${first.screenAt("toggled")}\n==== done\n${second.screenAt("done")}`);
		const saved = lines(file), roles = saved.filter(e => e.type === "message").map(e => e.message.role);
		writeFileSync(join(p.root, "roles.txt"), roles.join("\n"));
		// Pi 1.6.0 saved a system message in front of each user message after the first: the first run's holds the tools with bash, the second declares them without it, and the third, after the skill edit, has the new description.
		expect(roles).toEqual(["system", "user", "assistant", "system", "user", "assistant", "system", "user", "assistant"]);
		const systems = saved.filter(e => e.type === "message" && e.message.role === "system").map(e => e.message.sections ?? {});
		expect(systems[0].tools).toContain("- bash:");
		expect(systems[1].tools).not.toContain("- bash:");
		expect(systems[2].skills).toContain("which has changed");
		expect(saved.filter(e => e.customType === "rbf-agy-acp-refusal/v1")).toEqual([]);
		expect(saved.filter(e => e.customType === "rbf-agy-acp-completion/v1")).toHaveLength(3);
		const rows = p.acp(), acpSessionId = saved.find(e => e.customType === "rbf-agy-acp-conversation/v1").data.acpSessionId;
		expect(methods(rows).filter(m => m === "session/new")).toHaveLength(1);
		expect(calls(rows, "session/resume").map(m => m.params.sessionId)).toEqual([acpSessionId]); // one restart; the toggle did not restart anything
		expect(calls(rows, "session/prompt").map(m => [m.params.sessionId, m.params.prompt[0].text])).toEqual([[acpSessionId, "Remember MAPLE-T1."], [acpSessionId, "Second question."], [acpSessionId, "Third question."]]);
		expect(JSON.stringify(calls(rows, "session/prompt"))).not.toMatch(/probe rule|Answer briefly|Answer in one line|bash/i);
		for (const screen of [first.screenAt("toggled"), second.screenAt("done")]) expect(screen).not.toContain("no longer matches");
	}, 240000);

	// Decisions 2026-11-22: each AGY wake-up is its own turn. The fake AGY finishes the turn and then speaks on its own. Pi shows the marker line and streams AGY's reply as a turn of its own, sends AGY nothing
	// for it, and both the marker and the reply are in the history after a restart, where the next message resumes the same conversation.
	it("shows `AGY continued on its own.` and AGY's reply as a turn of its own when AGY wakes, sends AGY nothing for it, and keeps both across a restart", async () => {
		const p = profile("acp-wake");
		const first = await p.run("first", [
			{ wait: "ACP_READY_startup" }, ...submit("/model agy-harness/gemini-3.8-flash"), { sleep: 1 },
			...submit("[wake] Start the background job."), { wait: "ACP_SAVED_C2_R0" }, { sleep: 0.5 }, { snapshot: "woke" },
			...submit("/quit"), { waitExit: 5 },
		], { env: { PI213_WAKE_QUIET_MS: "500" } });
		writeFileSync(join(p.root, "screens.txt"), `==== woke\n${first.screenAt("woke")}`);
		const file = p.sessionFile(), saved = lines(file);
		const shown = first.screenAt("woke");
		expect(shown).toContain("AGY continued on its own.");
		expect(shown).not.toContain("[rbf-agy-wake]"); // the marker is drawn as the one line, without Pi's custom-message label
		expect(shown).toContain("Background job finished.");
		expect(shown.indexOf("Done.")).toBeLessThan(shown.indexOf("AGY continued on its own."));
		expect(shown.indexOf("AGY continued on its own.")).toBeLessThan(shown.indexOf("Background job finished."));
		// The saved order: the turn, then the marker, the wake record, its activity, the reply and the completion that names the wake.
		const order = saved.map(e => e.customType ?? (e.type === "message" ? e.message.role : e.type)).filter(x => x !== "model_change" && x !== "thinking_level_change");
		expect(order.slice(order.indexOf("rbf-agy-acp-completion/v1"))).toEqual(["rbf-agy-acp-completion/v1", "rbf-agy-wake", "rbf-agy-acp-wake/v1", "rbf-agy-acp-activity/v1", "assistant", "rbf-agy-acp-completion/v1"]);
		const marker = saved.find(e => e.type === "custom_message"), wake = saved.find(e => e.customType === "rbf-agy-acp-wake/v1"), completions = saved.filter(e => e.customType === "rbf-agy-acp-completion/v1");
		expect(marker).toMatchObject({ customType: "rbf-agy-wake", content: "AGY continued on its own.", display: true });
		expect(wake.data).toMatchObject({ markerEntryId: marker.id, previousCompletionId: completions[0].id });
		expect(completions[1].data).toMatchObject({ dispatchId: wake.id, outcome: "stop" });
		expect(saved.find(e => e.customType === "rbf-agy-acp-activity/v1" && e.data.toolCallId === "call_wake_1").data.inputEntryId).toBe(marker.id);
		// Pi sent AGY one prompt, and nothing for the wake.
		expect(calls(p.acp(), "session/prompt").map(m => m.params.prompt[0].text)).toEqual(["[wake] Start the background job."]);
		// After the one prompt, Pi sent AGY nothing but the close when it quit: no settings call and no second prompt for the wake.
		const sent = methods(p.acp()), afterPrompt = sent.slice(sent.indexOf("session/prompt") + 1);
		expect(afterPrompt).toEqual(["session/close"]);

		const restarted = await p.run("restart", [{ wait: "Background job finished" }, { sleep: 1 }, ...submit("After restart."), { wait: "ACP_SAVED_C3_R0" }, { snapshot: "done" }, ...submit("/quit"), { waitExit: 5 }], { session: file });
		writeFileSync(join(p.root, "restart.screen.txt"), restarted.screenAt("done"));
		const after = restarted.screenAt("done");
		expect(after).toContain("AGY continued on its own.");
		expect(after).toContain("Background job finished.");
		expect(after).not.toMatch(/no longer matches|unknown outcome|cannot be verified/);
		const rows = p.acp();
		expect(calls(rows, "session/resume")).toHaveLength(1);
		expect(calls(rows, "session/prompt").map(m => m.params.prompt[0].text)).toEqual(["[wake] Start the background job.", "After restart."]);
		expect(lines(file).filter(e => e.customType === "rbf-agy-acp-dispatch/v1").at(-1).data.previousCompletionId).toBe(completions[1].id);
		assertOnlyFakeLaunches(p.host());
	}, 180000);

	// A wake can begin while Pi is still checking a prompt Tom typed. Pi runs input handlers and checks auth in `_preparePrompt` while `isIdle()` is still true, so a wake marker sent then starts its own run and Tom's prompt
	// throws "Agent is already processing" with his text gone from the editor. The provider holds wakes from the `input` event until that prompt's run starts (or 2 s), so the prompt meets the owner that is waking and gets
	// the ordinary busy refusal, which is saved; the wake turn follows. The test extension's slow `input` handler (1.5 s) runs after the provider's, and the fake AGY wakes inside it.
	it("gives a prompt typed while AGY wakes the busy refusal, not Pi's `Agent is already processing`, and then runs the wake turn", async () => {
		const p = profile("acp-wake-typed");
		const first = await p.run("first", [
			{ wait: "ACP_READY_startup" }, ...submit("/model agy-harness/gemini-3.8-flash"), { sleep: 1 },
			...submit("[wake-long] Start the background job."), { wait: "ACP_SAVED_C1_R0" }, { sleep: 0.5 }, // the wake is a long one (about 3 s), so it is still running when the slow handler ends
			...submit("[slow] Typed while AGY wakes."), { wait: "long 39", timeout: 30 }, { sleep: 1.5 }, { snapshot: "woke" },
			...submit("/quit"), { waitExit: 8 },
		], { env: { PI213_WAKE_QUIET_MS: "500", PI213_ACP_MODE: "wake-hold" }, extension: "rbf-agy-acp-slow-hooks-extension.ts", timeout: 90 });
		const shown = first.screenAt("woke");
		writeFileSync(join(p.root, "screens.txt"), `==== woke\n${shown}`);
		const hook = p.host().find(e => e.event === "slow_input_end");
		expect(hook, "the slow input handler ran").toBeDefined();
		expect(hook.wakeBegan, "AGY woke inside the slow input handler").toBe(true);
		expect(shown).not.toContain("already processing");
		expect(shown.replace(/\s+/g, " ")).toContain("AGY is busy. Your message was not sent.");
		expect(shown).toContain("AGY continued on its own.");
		expect(shown).toContain("long 39");
		expect(shown.indexOf("Typed while AGY wakes.")).toBeLessThan(shown.indexOf("AGY continued on its own."));
		// Saved: the first turn, Tom's message with the busy answer and its refusal record, then the wake (marker, record, reply, completion that names it).
		const saved = lines(p.sessionFile());
		const order = saved.map(e => e.customType ?? (e.type === "message" ? e.message.role : e.type)).filter(x => x !== "model_change" && x !== "thinking_level_change" && x !== "system");
		expect(order.slice(order.indexOf("rbf-agy-acp-completion/v1"))).toEqual(["rbf-agy-acp-completion/v1", "user", "assistant", "rbf-agy-acp-refusal/v1", "rbf-agy-wake", "rbf-agy-acp-wake/v1", "assistant", "rbf-agy-acp-completion/v1"]);
		// AGY got the first prompt only: nothing for Tom's refused message, nothing for the wake.
		expect(calls(p.acp(), "session/prompt").map(m => m.params.prompt[0].text)).toEqual(["[wake-long] Start the background job."]);
		assertOnlyFakeLaunches(p.host());
	}, 240000);

	// A wake deferred because Pi was busy for a reason that is not a run (compaction here) waited for `agent_settled`, which fires only when a run ends, so AGY's output was dropped when the owner gave up after 15 s.
	// The provider now re-checks every 250 ms. The test extension's `session_before_compact` handler runs before the provider's, which cancels the compaction, and the fake AGY wakes inside it.
	it("sends a wake that began while Pi was compacting as soon as Pi is idle, instead of dropping AGY's output after 15 s", async () => {
		const p = profile("acp-wake-compact"), big = (n: number, scenario = "") => `${scenario}Part ${n}. ` + "word ".repeat(15000);
		const first = await p.run("first", [
			{ wait: "ACP_READY_startup" }, ...submit("/model agy-harness/gemini-3.8-flash"), { sleep: 1 },
			...submit("Remember MAPLE-Z1."), { wait: "ACP_SAVED_C1_R0" }, { sleep: 0.5 },
			...submit(big(2)), { wait: "ACP_SAVED_C2_R0", timeout: 60 }, { sleep: 0.5 },
			...submit(big(3, "[wake] ")), { wait: "ACP_SAVED_C3_R0", timeout: 60 }, { sleep: 0.5 },
			...submit("/compact"), { wait: "Compaction cancelled", timeout: 30 }, { wait: "Background job finished", timeout: 8 }, { sleep: 1.5 }, { snapshot: "woke" },
			...submit("/quit"), { waitExit: 8 },
		], { env: { PI213_WAKE_QUIET_MS: "500", PI213_ACP_MODE: "wake-hold" }, extension: "rbf-agy-acp-slow-hooks-extension.ts", timeout: 150 });
		const shown = first.screenAt("woke");
		writeFileSync(join(p.root, "screens.txt"), `==== woke\n${shown}`);
		const hook = p.host().find(e => e.event === "slow_compact_end");
		expect(hook, "the slow compaction handler ran").toBeDefined();
		expect(hook.wakeBegan, "AGY woke inside the slow compaction handler").toBe(true);
		expect(shown).toContain("Compaction cancelled");
		expect(shown).toContain("AGY continued on its own.");
		expect(shown).toContain("Background job finished.");
		const saved = lines(p.sessionFile());
		expect(saved.filter(e => e.type === "compaction")).toEqual([]);
		const wake = saved.find(e => e.customType === "rbf-agy-acp-wake/v1"), completions = saved.filter(e => e.customType === "rbf-agy-acp-completion/v1");
		expect(wake).toBeDefined();
		expect(completions).toHaveLength(4);
		expect(completions[3].data).toMatchObject({ dispatchId: wake.id, outcome: "stop" });
		expect(calls(p.acp(), "session/prompt")).toHaveLength(3);
		assertOnlyFakeLaunches(p.host());
	}, 300000);

	// AGY's JSON-RPC error text used to carry its code bare, `AGY ACP request failed (429)`, and Pi's retry check takes a bare 429, 500 or 503 for an HTTP status. Pi retried, the provider refused to resend (it never resends a
	// prompt AGY may have run), and Tom ended on that refusal instead of AGY's error. The code is now written so the check cannot match it.
	it("shows AGY's own error for a JSON-RPC error with code 429 and does not start Pi's automatic retry", async () => {
		const retry = { defaultThinkingLevel: "low", theme: "dark", retry: { enabled: true, maxRetries: 2, baseDelayMs: 100 } };
		const p = profile("acp-rpc-429");
		writeFileSync(join(p.root, "agent", "settings.json"), JSON.stringify(retry));
		const first = await p.run("first", [
			{ wait: "ACP_READY_startup" }, ...submit("/model agy-harness/gemini-3.8-flash"), { sleep: 1 },
			...submit("[rpc-429] go"), { wait: "AGY ACP request failed", timeout: 30 }, { sleep: 2.5 }, { snapshot: "failed" },
			{ key: "ctrl-u" }, ...submit("/quit"), { waitExit: 8 },
		]);
		const shown = first.screenAt("failed");
		writeFileSync(join(p.root, "screens.txt"), `==== failed\n${shown}`);
		expect(calls(p.acp(), "session/prompt").map(m => m.params.prompt[0].text)).toEqual(["[rpc-429] go"]);
		expect(p.host().filter(e => e.event === "provider_call")).toHaveLength(1); // Pi did not call the provider again
		expect(shown).toContain("AGY ACP request failed");
		expect(shown).not.toMatch(/Retry|Retrying|will not resend/);
		assertOnlyFakeLaunches(p.host());
	}, 240000);

	// Tom's bar for pi-21 (2026-11-22): Tom types every prompt, and Pi sends AGY no prompts of its own. In actual Pi 1.6.0 with the fake AGY, whose request log is the receipt, a chat with an AGY model
	// selected sends no `session/prompt` for Pi's own work: /compact, a /tree move with a branch summary, Pi's automatic retry, or a wake turn (the wake case above).
	it("sends AGY no prompt of its own for /compact or a /tree move with a branch summary", async () => {
		const p = profile("acp-bar-compact"), big = (n: number) => `Part ${n}. ` + "word ".repeat(15000);
		const first = await p.run("first", [
			{ wait: "ACP_READY_startup" }, ...submit("/model agy-harness/gemini-3.8-flash"), { sleep: 1 },
			...submit("Remember MAPLE-Z1."), { wait: "ACP_SAVED_C1_R0" }, { sleep: 0.5 },
			// One saved answer: Pi itself finds nothing to compact.
			...submit("/compact"), { wait: "Nothing to compact" }, { snapshot: "small" },
			// A session big enough to compact: Pi reaches the provider's hook, which cancels it.
			...submit(big(2)), { wait: "ACP_SAVED_C2_R0", timeout: 60 }, { sleep: 0.5 }, ...submit(big(3)), { wait: "ACP_SAVED_C3_R0", timeout: 60 }, { sleep: 0.5 },
			...submit("/compact"), { wait: "Compaction cancelled" }, { snapshot: "cancelled" },
			// A /tree move to the first message, with a branch summary: the provider answers it itself.
			...submit("/tree"), { sleep: 1.5 }, ...Array.from({ length: 5 }, () => ({ key: "up" })), { sleep: 0.5 }, { key: "enter" },
			{ wait: "Summarize branch\\?" }, { key: "down" }, { key: "enter" }, { wait: "Navigated to selected point" }, { sleep: 1 }, { snapshot: "tree" },
			{ key: "ctrl-u" }, ...submit("/quit"), { waitExit: 8 },
		], { timeout: 120 });
		writeFileSync(join(p.root, "screens.txt"), ["small", "cancelled", "tree"].map(n => `==== ${n}\n${first.screenAt(n)}`).join("\n"));
		const saved = lines(p.sessionFile()), rows = p.acp();
		// Three prompts, all of them Tom's, and nothing after the last one but the close that moving the tree causes.
		const prompts = calls(rows, "session/prompt").map(m => m.params.prompt[0].text as string); // the fake's log shrinks a long text to `<n chars>`
		expect(prompts).toHaveLength(3);
		expect(prompts[0]).toBe("Remember MAPLE-Z1.");
		for (const long of prompts.slice(1)) expect(long).toMatch(/^<750\d\d chars>$/);
		const sent = methods(rows);
		expect(sent.slice(sent.lastIndexOf("session/prompt") + 1)).toEqual(["session/close"]);
		expect(lines(join(p.root, "host.jsonl")).filter(e => e.event === "provider_call")).toHaveLength(3);
		expect(saved.filter(e => e.type === "compaction")).toEqual([]);
		expect(saved.filter(e => e.type === "branch_summary").map(e => e.summary)).toEqual(["AGY branch summaries are unavailable; no native input was sent."]);
		expect(saved.filter(e => e.type === "message" && e.message.role === "assistant")).toHaveLength(3);
		expect(first.screenAt("small")).toContain("Nothing to compact");
		expect(first.screenAt("cancelled")).toContain("Compaction cancelled");
		assertOnlyFakeLaunches(p.host());
	}, 240000);

	// Pi retries a failed turn by itself when the error text looks transient, writes a context_edit entry that breaks resume, and calls the provider again. Two AGY refusals carry words that are not ours: a command
	// name (`overloaded`, a name Pi's retry check takes for a server error) and a result AGY ended the turn with (`overloaded` again). The provider writes such words apart, with zero-width spaces, so Pi starts no retry,
	// the refusal reads as it did, and AGY gets only the prompts Tom sent. (These two cases used to show Pi's retry for real, with the provider refusing the resend; now there is no retry to refuse.)
	it("starts no Pi retry for an AGY refusal that carries a retry word, before or after the prompt was sent, so AGY gets no prompt twice", async () => {
		const retry = { defaultThinkingLevel: "low", theme: "dark", retry: { enabled: true, maxRetries: 2, baseDelayMs: 100 } };
		const refused = profile("acp-bar-retry-refused");
		writeFileSync(join(refused.root, "agent", "settings.json"), JSON.stringify(retry));
		const a = await refused.run("first", [
			{ wait: "ACP_READY_startup" }, ...submit("/model agy-harness/gemini-3.8-flash"), { sleep: 1 },
			...submit("Remember MAPLE-Z1."), { wait: "ACP_SAVED_C1_R0" }, { sleep: 0.5 },
			...submit("/overloaded please"), { wait: "ACP_SAVED_C1_R1" }, { sleep: 2 }, { snapshot: "refused" }, // longer than Pi's retry delay and three attempts of it
			{ key: "ctrl-u" }, ...submit("/quit"), { waitExit: 8 },
		], { env: { PI213_ACP_MODE: "cmd-overloaded" } });
		writeFileSync(join(refused.root, "screens.txt"), `==== refused\n${a.screenAt("refused")}`);
		expect(calls(refused.acp(), "session/prompt").map(m => m.params.prompt[0].text)).toEqual(["Remember MAPLE-Z1."]);
		// Pi called the provider once for each message Tom typed and not again.
		expect(lines(join(refused.root, "host.jsonl")).filter(e => e.event === "provider_call")).toHaveLength(2);
		const refusedScreen = a.screenAt("refused").replace(/\u200b/g, "").replace(/\s+/g, " ");
		expect(refusedScreen).toContain("AGY would run /overloaded as its own command. Pi doesn't send AGY commands yet. Your message was not sent.");
		expect(refusedScreen).not.toMatch(/Retry|Retrying|will not resend/);
		expect(lines(refused.sessionFile()).filter(e => e.type === "context_edit")).toEqual([]);

		const lost = profile("acp-bar-retry-sent");
		writeFileSync(join(lost.root, "agent", "settings.json"), JSON.stringify(retry));
		const b = await lost.run("first", [
			{ wait: "ACP_READY_startup" }, ...submit("/model agy-harness/gemini-3.8-flash"), { sleep: 1 },
			...submit("[stop-overloaded] go"), { wait: "does not handle yet", timeout: 30 }, { sleep: 2 }, { snapshot: "ended" },
			...submit("/quit"), { waitExit: 8 },
		]);
		writeFileSync(join(lost.root, "screens.txt"), `==== ended\n${b.screenAt("ended")}`);
		expect(calls(lost.acp(), "session/prompt").map(m => m.params.prompt[0].text)).toEqual(["[stop-overloaded] go"]);
		expect(lines(join(lost.root, "host.jsonl")).filter(e => e.event === "provider_call")).toHaveLength(1);
		const lostScreen = b.screenAt("ended").replace(/\u200b/g, "").replace(/\s+/g, " ");
		expect(lostScreen).toContain("AGY ended the turn with a result Pi does not handle yet (overloaded).");
		expect(lostScreen).not.toMatch(/Retry|Retrying|AGY context has ended|will not resend/);
		expect(lines(lost.sessionFile()).filter(e => e.type === "context_edit")).toEqual([]);
		assertOnlyFakeLaunches(lost.host());
		assertOnlyFakeLaunches(refused.host());
	}, 240000);

	// Widened F1. A `!` command saves a bashExecution message; another extension's pi.sendMessage saves a custom_message entry. Neither is the user's text or AGY's answer, so the chat resumes
	// with them on the branch, in the same process and after a restart, and AGY gets only the user's text. Both are asserted in the saved file, so a Pi that stopped saving them would fail here.
	it("resumes the same ACP session with a `!` command and another extension's message on the branch, before and after a restart", async () => {
		const p = profile("acp-bang"), bang = (n: number) => [...submit(`!echo BANG_$((${n}0+${n}))`), { wait: `BANG_${n}${n}` }, { sleep: 0.5 }];
		const first = await p.run("first", [
			{ wait: "ACP_READY_startup" }, ...submit("/model agy-harness/gemini-3.8-flash"), { sleep: 1 },
			...bang(1), ...submit("Remember MAPLE-B1."), { wait: "ACP_SAVED_C1_R0" },
			...bang(2), ...submit("/note from another extension"), { wait: "ACP_NOTE_SENT" }, { sleep: 0.5 },
			...submit("Second question."), { wait: "ACP_SAVED_C2_R0" }, { snapshot: "second" },
			...bang(3), ...submit("/quit"), { waitExit: 5 },
		]);
		const file = p.sessionFile(), kinds = () => lines(file).filter(e => e.type === "message" || e.type === "custom_message").map(e => e.type === "custom_message" ? "custom_message" : e.message.role);
		// Pi saves the first `!` command before the system message, which comes with the first prompt.
		expect(kinds()).toEqual(["bashExecution", "system", "user", "assistant", "bashExecution", "custom_message", "user", "assistant", "bashExecution"]);
		// A resumed branch that holds a `!` command is not repainted until the first key (measured on Pi 1.6.0: the startup notice only shows after input), so the restart waits for the old output instead.
		const restarted = await p.run("restart", [{ wait: "BANG_33" }, { sleep: 1 }, ...bang(4), ...submit("After restart."), { wait: "ACP_SAVED_C3_R0" }, { snapshot: "done" }, ...submit("/quit"), { waitExit: 5 }], { session: file });
		for (const [name, run] of [["second", first], ["restart", restarted]] as const) writeFileSync(join(p.root, `${name}.screen.txt`), run.screenAt(name === "second" ? "second" : "done"));
		expect(kinds()).toEqual(["bashExecution", "system", "user", "assistant", "bashExecution", "custom_message", "user", "assistant", "bashExecution", "bashExecution", "user", "assistant"]);
		const saved = lines(file);
		expect(saved.filter(e => e.customType === "rbf-agy-acp-refusal/v1")).toEqual([]);
		expect(saved.filter(e => e.customType === "rbf-agy-acp-completion/v1")).toHaveLength(3);
		const rows = p.acp(), acpSessionId = saved.find(e => e.customType === "rbf-agy-acp-conversation/v1").data.acpSessionId;
		expect(methods(rows).filter(m => m === "session/new")).toHaveLength(1);
		expect(calls(rows, "session/resume").map(m => m.params.sessionId)).toEqual([acpSessionId]);
		// Only the user's text goes to AGY: no command, command output or note text.
		expect(calls(rows, "session/prompt").map(m => m.params.prompt[0].text)).toEqual(["Remember MAPLE-B1.", "Second question.", "After restart."]);
		expect(JSON.stringify(calls(rows, "session/prompt"))).not.toMatch(/BANG_|another extension|echo/);
		for (const screen of [first.screenAt("second"), restarted.screenAt("done")]) expect(screen).not.toMatch(/no longer matches|unknown outcome|cannot be verified/);
		assertOnlyFakeLaunches(p.host());
	}, 180000);

	// Cold review F2. Enter while AGY works queues the message as a steer; Pi sends it to the provider after the turn's answer is saved and before agent_end.
	// The message is refused with nothing sent, the running turn still completes, the chat goes on and a restart resumes it.
	it("refuses a message typed while AGY works with nothing sent, completes the running turn, continues the chat, and resumes after a restart", async () => {
		const p = profile("acp-pty-steer"), release = join(p.root, "release"), cols = 100;
		const first = await p.run("first", [
			{ wait: "ACP_READY_startup" }, ...submit("/model agy-harness/gemini-3.8-flash"), { sleep: 1 },
			...submit("[hold] First question"), { sleep: 1.5 }, { snapshot: "working" },
			...submit("Typed while AGY works."), { sleep: 0.7 }, { snapshot: "typed" },
			{ writeFixtureFile: { path: release, text: "go" } },
			{ wait: "ACP_SAVED_C1_R1" }, { sleep: 0.5 }, { snapshot: "released" },
			...submit("Third question."), { wait: "ACP_SAVED_C2_R1" }, { sleep: 0.3 }, { snapshot: "continued" },
			...submit("/quit"), { waitExit: 5 },
		], { cols, rows: 38, timeout: 60 });
		const names = ["working", "typed", "released", "continued"];
		writeFileSync(join(p.root, "screens.txt"), names.map(n => `==== ${n}\n${first.screenAt(n)}`).join("\n"));
		const file = p.sessionFile(), saved = lines(file);
		expect(saved.filter(e => String(e.customType).startsWith("rbf-agy-")).map(e => e.customType)).toEqual([
			"rbf-agy-acp-conversation/v1", "rbf-agy-acp-dispatch/v1", "rbf-agy-acp-refusal/v1", "rbf-agy-acp-completion/v1", "rbf-agy-acp-dispatch/v1", "rbf-agy-acp-completion/v1"]);
		const [conversation, dispatch1, refusal, completion1, dispatch2] = saved.filter(e => String(e.customType).startsWith("rbf-agy-"));
		expect(refusal.data).toMatchObject({ dispatchId: dispatch1.id, completionId: null, conversationEntryId: conversation.id });
		expect(completion1.data).toMatchObject({ dispatchId: dispatch1.id, outcome: "stop" });
		expect(dispatch2.data.previousCompletionId).toBe(completion1.id);
		const roles = saved.filter(e => e.type === "message").map(e => e.message.role + (e.message.role === "assistant" ? ":" + e.message.stopReason : ""));
		expect(roles).toEqual(["system", "user", "assistant:stop", "user", "assistant:error", "user", "assistant:stop"]);
		expect(saved.find(e => e.type === "message" && e.message.stopReason === "error").message.errorMessage).toBe("AGY is busy. Your message was not sent. Wait for the current request to finish.");
		const screens = names.map(n => first.screenAt(n)).join("\n");
		expect(screens).toContain("AGY is busy.");
		expect(screens).not.toMatch(/cannot be verified|AGY stopped|context has ended|unknown outcome/);

		const restarted = await p.run("restart", [{ wait: "ACP_READY_startup" }, ...submit("After restart."), { wait: "ACP_SAVED_C3_R1" }, { snapshot: "done" }, ...submit("/quit"), { waitExit: 5 }], { session: file, cols, rows: 38 });
		writeFileSync(join(p.root, "restart.screen.txt"), restarted.screenAt("done"));
		expect(restarted.screenAt("done")).not.toMatch(/unknown outcome|no longer matches|cannot be verified/);
		const rows = p.acp(), acpSessionId = conversation.data.acpSessionId;
		expect(calls(rows, "session/prompt").map(m => m.params.prompt[0].text)).toEqual(["[hold] First question", "Third question.", "After restart."]);
		expect(rows.filter(r => r.args)).toHaveLength(2);
		expect(calls(rows, "session/resume").map(m => m.params.sessionId)).toEqual([acpSessionId]);
		expect(calls(rows, "session/close")).toHaveLength(2);
		assertOnlyFakeLaunches(p.host());
		console.log(`ACP PTY steer receipt: ${p.root}`);
	}, 180000);

	// Decisions 2026-11-22, the model catalogue for AGY 1.5.14: the shim serves the saved real `agy models` list and the fake ACP server offers what real AGY 1.5.14 offered (Neon at high to start; xhigh only on Neon and
	// Hydrogen; no thought_level on an Orchestrator). Every move below used to be refused, because the effort was checked against the model being left: Flash to Neon xhigh, and any move off an Orchestrator.
	it("changes model and thinking level through Flash, Neon xhigh, an Orchestrator and Argon in one ACP conversation, each landing as the pair AGY confirms", async () => {
		const p = profile("acp-pty-114"), fixture = join(ROOT, "extensions/test-support/fixtures/agy-models-1.5.14.txt");
		const first = await p.run("first", [
			{ wait: "ACP_READY_startup" },
			...submit("/model agy-harness/gemini-3.8-flash"), { wait: "Model: gemini-3\\.8-flash" }, ...submit("/thinking low"), { wait: "Thinking level: low" },
			...submit("First on Flash low."), { wait: "ACP_SAVED_C1_R0" },
			...submit("/model agy-harness/gemini-4-neon"), { wait: "Model: gemini-4-neon" }, ...submit("/thinking xhigh"), { wait: "Thinking level: xhigh" },
			...submit("Second on Neon xhigh."), { wait: "ACP_SAVED_C2_R0" }, { sleep: 0.3 }, { snapshot: "neon" },
			...submit("/model agy-harness/gemini-pro-orchestrator-neon"), { wait: "Model: gemini-pro-orchestrator-neon" },
			...submit("Third on an Orchestrator."), { wait: "ACP_SAVED_C3_R0" }, { sleep: 0.3 }, { snapshot: "orchestrator" },
			...submit("/model agy-harness/gemini-4-argon"), { wait: "Model: gemini-4-argon" }, ...submit("/thinking low"), { wait: "Thinking level: low", count: 2 },
			...submit("Fourth on Argon low."), { wait: "ACP_SAVED_C4_R0" }, { sleep: 0.3 }, { snapshot: "argon" },
			// The real list holds Claude and GPT-OSS rows; only Gemini models reach Pi's model list (Decisions 2026-11-22).
			...submit("/model agy-harness/claude-sonnet-5-5"), { wait: "No matching models" }, { snapshot: "no-claude" }, { key: "escape" }, { sleep: 0.5 },
			...submit("/quit"), { waitExit: 5 },
		], { env: { PI213_MODELS_FILE: fixture, PI213_ACP_MODE: "agy-1.5.14" } });
		writeFileSync(join(p.root, "screens.txt"), ["neon", "orchestrator", "argon", "no-claude"].map(n => `==== ${n}\n${first.screenAt(n)}`).join("\n"));
		const saved = lines(p.sessionFile()), rows = p.acp();
		// One session, four prompts, and the settings calls AGY needed: the Orchestrator gets the model only.
		expect(methods(rows).filter(m => m === "session/new")).toHaveLength(1);
		expect(calls(rows, "session/prompt").map(m => m.params.prompt[0].text)).toEqual(["First on Flash low.", "Second on Neon xhigh.", "Third on an Orchestrator.", "Fourth on Argon low."]);
		// The settings calls each turn needed, in order, each sent once: an echo that follows its reply is matched however late the client reads it.
		const perTurn: string[][][] = [[]];
		for (const row of rows) {
			if (row.in?.method === "session/prompt") perTurn.push([]);
			else if (row.in?.method === "session/set_config_option") perTurn.at(-1)!.push([row.in.params.configId, row.in.params.value]);
		}
		expect(perTurn.slice(0, 4)).toEqual([
			[["model", "gemini-3.8-flash"], ["thought_level", "low"]],
			[["model", "gemini-4-neon"], ["thought_level", "xhigh"]],
			[["model", "gemini-pro-orchestrator-neon"]],
			[["model", "gemini-4-argon"], ["thought_level", "low"]],
		]);
		// Each turn records the pair AGY confirmed; an Orchestrator confirms no effort.
		expect(saved.filter(e => e.customType === "rbf-agy-acp-dispatch/v1").map(e => [e.data.model, e.data.effort])).toEqual([["gemini-3.8-flash", "low"], ["gemini-4-neon", "xhigh"], ["gemini-pro-orchestrator-neon", null], ["gemini-4-argon", "low"]]);
		expect(saved.filter(e => e.customType === "rbf-agy-acp-completion/v1").map(e => [e.data.model, e.data.effort])).toEqual([["gemini-3.8-flash", "low"], ["gemini-4-neon", "xhigh"], ["gemini-pro-orchestrator-neon", null], ["gemini-4-argon", "low"]]);
		expect(saved.filter(e => e.customType === "rbf-agy-acp-refusal/v1")).toEqual([]);
		for (const name of ["neon", "orchestrator", "argon"]) expect(first.screenAt(name)).not.toMatch(/does not support|settings differ|cannot be verified/);
		expect(first.screenAt("neon")).toContain("gemini-4-neon");
		expect(first.screenAt("no-claude")).toContain("No matching models");
		assertOnlyFakeLaunches(p.host());
	}, 180000);

	// ER9, A21.3-6. The fixture is a session file actual Pi 1.6.0 saved from a chat the CLI route ran (v0.33.x, fake native): a system message, the user's, the three CLI records and AGY's answer.
	// The CLI route is deleted, so a message typed into it is refused with a plain line: nothing is sent, no AGY process starts, no AGY record is written. `/new` then starts a working ACP chat.
	const CLI_BORN = "This chat used AGY's old CLI route, which Pi no longer runs. Your message was not sent. Use /new to start a new AGY chat.";
	it.each([80, 120])("refuses a message in a chat the CLI route started, whole at %s columns, keeps the text one Up arrow away, and /new starts a working ACP chat", async cols => {
		const p = profile(`acp-pty-cli-born-${cols}`), work = realpathSync(join(p.root, "workspace")), file = join(p.sessions, "cli-born.jsonl");
		const fixture = readFileSync(join(ROOT, "extensions/test-support/fixtures/agy-cli-born-session.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
		fixture[0].cwd = work;
		writeFileSync(file, fixture.map(e => JSON.stringify(e)).join("\n") + "\n");
		const before = fixture.filter(e => String(e.customType).startsWith("rbf-agy-")).map(e => e.customType);
		expect(before).toEqual(["rbf-agy-conversation/v1", "rbf-agy-dispatch/v1", "rbf-agy-completion/v1"]);
		const run = await p.run("refused", [
			{ wait: "ACP_READY_startup" }, ...submit("/model agy-harness/gemini-3.8-flash"), { sleep: 1 }, ...submit("Continue the old work."), { wait: "old CLI route" }, { sleep: 0.7 }, { snapshot: "refused" },
			{ key: "up" }, { sleep: 0.5 }, { snapshot: "after-up" }, { bytes: "\u0005" }, { key: "ctrl-u" }, { sleep: 0.3 },
			...submit("/new"), { sleep: 1.5 }, ...submit("Fresh start."), { wait: "ACP_SAVED_C1_R0" }, { sleep: 0.3 }, { snapshot: "fresh" },
			...submit("/quit"), { waitExit: 5 },
		], { session: file, cols });
		writeFileSync(join(p.root, "screens.txt"), ["refused", "after-up", "fresh"].map(n => `==== ${n}\n${run.screenAt(n)}`).join("\n"));
		const shown = run.screenAt("refused");
		expect(shown.replace(/\s+/g, " ")).toContain(CLI_BORN); // the whole line, at this width
		assertScreenFits(run.linesAt("refused"), cols);
		expect(shown).toContain("Continue the old work."); // the typed text stays visible above the line
		expect(editorText(run.screenAt("after-up"))).toBe("Continue the old work.");
		// Nothing was sent or started for it, and no AGY record was written into the old chat; Pi saved its own error entry.
		const saved = lines(file);
		expect(saved.filter(e => String(e.customType).startsWith("rbf-agy-")).map(e => e.customType)).toEqual(before);
		expect(saved.filter(e => e.type === "message" && e.message.role === "assistant" && e.message.stopReason === "error").map(e => e.message.errorMessage)).toEqual([CLI_BORN]);
		const rows = p.acp();
		// The shim logs every start with its time and the host logs every call Pi makes to the provider with its time. Pi called the provider twice: for the refused message, then for the fresh chat's. Between them the
		// shim saw no start at all (no `--print`, no `--version`, no `models`, no `acp`), and after the second call it saw the one `agy acp` of the fresh chat.
		const [refusedCall, freshCall] = p.host().filter(e => e.event === "provider_call").map(e => e.t as number);
		expect(freshCall).toBeGreaterThan(refusedCall!);
		const launches = p.launches();
		expect(launches.filter(l => l.t > refusedCall! && l.t < freshCall!).map(l => l.args)).toEqual([]);
		expect(launches.filter(l => l.t >= freshCall!).map(l => l.args)).toEqual([["acp"]]);
		expect(rows.filter(r => r.args)).toHaveLength(1);
		expect(calls(rows, "session/prompt").map(m => m.params.prompt[0].text)).toEqual(["Fresh start."]);
		expect(run.screenAt("fresh")).toContain("Hello from ACP.");
		expect(p.sessionFiles()).toHaveLength(2);
		console.log("ACP PTY CLI-born receipt: " + p.root);
	}, 120000);

	it.each([80, 120])("handles after-prompt echoes, mid-turn /model and /thinking, max_tokens without compaction, /new cleanup, and divergence at %s columns", async cols => {
		const p = profile(`acp-pty-life-${cols}`), hostLog = join(p.root, "host.jsonl"), release = join(p.root, "release");
		const run = await p.run("lifecycle", [
			{ wait: "ACP_READY_startup" },
			...submit("/model agy-harness/gemini-3.8-flash"), { wait: "Model: gemini-3\\.8-flash" },
			// 1. After-prompt echo delivers nothing extra and completes normally.
			...submit("First with after-prompt echo."), { wait: "ACP_SAVED_C1_R0" }, { sleep: 0.3 }, { snapshot: "after-echo" },
			// 2. Mid-turn /model and /thinking during [hold] do not retire AGY and apply on the next send.
			...submit("[hold] turn two"), { sleep: 1 },
			...submit("/model agy-harness/gemini-4-neon"), { wait: "Model: gemini-4-neon" },
			...submit("/thinking high"), { wait: "Thinking level: high" },
			{ sleep: 0.2 }, { snapshot: "mid-hold" },
			{ writeFixtureFile: { path: release, text: "go" } },
			{ wait: "ACP_SAVED_C2_R0" }, { sleep: 0.3 }, { snapshot: "after-hold" },
			// 3. [maxtokens] (stopReason: "length") triggers no auto-compaction and keeps the same ACP session.
			...submit("[maxtokens] cut me off"), { wait: "ACP_SAVED_C3_R0" }, { sleep: 0.6 }, { snapshot: "after-maxtokens" },
			...submit("Continue after maxtokens."), { wait: "ACP_SAVED_C4_R0" }, { sleep: 0.3 }, { snapshot: "after-continue" },
			// 4. /new cleanly retires the ACP child.
			...submit("/new"),
			{ waitJsonl: { path: hostLog, field: "event", value: "provider_retired", count: 1 } },
			{ wait: "ACP_READY_new" }, { sleep: 0.5 }, { snapshot: "after-new" },
			// 5. Injected mid-turn config_option_update ([diverge]) displays the divergence copy.
			...submit("[diverge] drift now"),
			{ wait: "AGY reported different settings for this turn" }, { sleep: 0.4 }, { snapshot: "after-diverge" },
			...submit("/quit"), { waitExit: 5 },
		], { cols, rows: 38, timeout: 60, env: { PI213_ACP_MODE: "echo:after-prompt" } });

		const snapNames = ["after-echo", "mid-hold", "after-hold", "after-maxtokens", "after-continue", "after-new", "after-diverge"];
		writeFileSync(join(p.root, "screens.txt"), snapNames.map(n => `==== ${n}\n${run.screenAt(n)}`).join("\n"));
		for (const name of snapNames) assertScreenFits(run.linesAt(name), cols);

		const hostRows = p.host();
		assertOnlyFakeLaunches(hostRows);

		// First session file (the 4 turns before /new).
		const savedEvents = hostRows.filter(e => e.event === "saved");
		const firstFile = savedEvents[0].file as string;
		const firstEntries = lines(firstFile);

		// No auto-compaction or context_edit entries from [maxtokens] or anywhere else.
		expect(firstEntries.filter(e => e.type === "compaction" || e.type === "context_edit")).toEqual([]);
		const completions = firstEntries.filter(e => e.customType === "rbf-agy-acp-completion/v1");
		expect(completions).toHaveLength(4);
		expect(completions[2].data.outcome).toBe("length");
		const maxTokensAssistant = firstEntries.find(e => e.id === completions[2].data.assistantId);
		expect(maxTokensAssistant?.message?.stopReason).toBe("length");
		expect(completions[3].data.outcome).toBe("stop");
		expect(completions[2].data.model).toBe("gemini-4-neon");
		expect(completions[2].data.effort).toBe("high");
		expect(completions[3].data.acpSessionId).toBe(completions[0].data.acpSessionId);

		// readSavedSession + selectAcpRecoveryAnchor accept the saved session file cleanly (no mismatch after [maxtokens]).
		const [firstHeader, ...firstBranch] = firstEntries;
		const savedSession = readSavedSession(
			{
				getSessionId: () => firstHeader.id,
				getSessionFile: () => firstFile,
				getLeafId: () => firstBranch.at(-1).id,
				getBranch: () => firstBranch,
			},
			firstHeader.cwd,
		);
		const probeUser = { id: "probe-next", parentId: savedSession.branch.at(-1).id, type: "message", message: { role: "user", content: [{ type: "text", text: "probe next" }] } };
		const anchor = selectAcpRecoveryAnchor(
			{ ...savedSession, all: [...savedSession.all, probeUser], branch: [...savedSession.branch, probeUser] },
			probeUser.id,
		);
		expect(anchor?.acpSessionId).toBe(completions[0].data.acpSessionId);
		expect(anchor?.completion?.id).toBe(completions[3].id);

		// ACP log: exactly 2 children (1 before /new, 1 for [diverge] after /new).
		const acpRows = p.acp();
		expect(acpRows.filter(r => r.args).map(r => r.args)).toEqual([["acp"], ["acp"]]);
		const prompts = calls(acpRows, "session/prompt");
		expect(prompts.map(m => m.params.prompt[0].text)).toEqual([
			"First with after-prompt echo.",
			"[hold] turn two",
			"[maxtokens] cut me off",
			"Continue after maxtokens.",
			"[diverge] drift now",
		]);
		// Prompts 1-4 all share one ACP session (no second prompt sent automatically for max_tokens, no retirement during [hold]).
		const firstAcpSid = completions[0].data.acpSessionId;
		for (const prompt of prompts.slice(0, 4)) expect(prompt.params.sessionId).toBe(firstAcpSid);
		expect(prompts[4].params.sessionId).not.toBe(firstAcpSid);

		// The mid-turn /model + /thinking during [hold] applied before [maxtokens] (prompt 3).
		const firstChildSets = calls(acpRows, "session/set_config_option").filter(m => m.params.sessionId === firstAcpSid);
		expect(firstChildSets.map(m => [m.params.configId, m.params.value])).toEqual([
			["model", "gemini-3.8-flash"],
			["thought_level", "low"],
			["model", "gemini-4-neon"],
			["thought_level", "high"],
		]);

		// /new retired the first child cleanly with EOF logged.
		expect(acpRows.some(r => r.eof === true)).toBe(true);
		const retirements = hostRows.filter(e => e.event === "provider_retired");
		expect(retirements.length).toBeGreaterThanOrEqual(1);
		expect(retirements[0]).toMatchObject({ retirement: "complete", classification: "clean" });

		// After-prompt echo showed nothing unexpected.
		const echoScreen = run.screenAt("after-echo").replace(/\s+/g, " ");
		expect(echoScreen).toContain("Hello from ACP.");
		expect(echoScreen).not.toContain("different settings");
		expect(echoScreen).not.toContain("could not confirm");

		// [diverge] showed the divergence copy.
		const divergeScreen = run.screenAt("after-diverge").replace(/\s+/g, " ");
		expect(divergeScreen).toContain("AGY reported different settings for this turn. The task may have run. Review its results before sending again.");
		console.log(`ACP PTY lifecycle (${cols} cols) receipt: ${p.root}`);
	}, 180000);

	it.each([80, 120])("drives approval dialogs and command history in actual Pi at %s columns", async cols => {
		const p = profile(`acp-pty-perm-${cols}`);
		const pageDowns = Array.from({ length: 10 }, () => ({ bytes: "\u001b[6~" }));
		const run = await p.run("approvals", [
			{ wait: "ACP_READY_startup" },
			...submit("/model agy-harness/gemini-3.8-flash"), { wait: "Model: gemini-3\\.8-flash" },

			// 1. [perm] Allow once: dialog opens with Reject once focused, down+enter allows and returns focus to editor.
			...submit("[perm] allow me"),
			{ wait: "AGY needs approval" }, { sleep: 0.3 }, { snapshot: "perm-open" },
			{ key: "down" }, { key: "enter" },
			{ wait: "ACP_SAVED_C1_R0" }, { sleep: 0.3 }, { snapshot: "perm-allowed" },

			// 2. [perm] Esc rejects: saves rejected-by-you activity without Error details.
			...submit("[perm] reject me"),
			{ wait: "(?s)ACP_SAVED_C1_R0.*AGY needs approval" }, { sleep: 0.3 }, { snapshot: "perm-reject-open" },
			{ key: "escape" },
			{ wait: "ACP_SAVED_C2_R0" }, { sleep: 0.3 }, { snapshot: "perm-rejected" },

			// 3. [perm-long] 200-line command: Allow once locked until paged to bottom, Esc rejects cleanly.
			...submit("[perm-long] two hundred lines"),
			{ wait: "(?s)ACP_SAVED_C2_R0.*Review all details before allowing\\." }, { sleep: 0.3 }, { snapshot: "perm-long-locked" },
			...pageDowns,
			{ sleep: 0.3 }, { snapshot: "perm-long-unlocked" },
			{ key: "escape" },
			{ wait: "ACP_SAVED_C3_R0" }, { sleep: 0.3 }, { snapshot: "perm-long-rejected" },

			// 4. [perm-two] Two concurrent requests: shows waiting count and answers both in FIFO order.
			...submit("[perm-two] two requests"),
			{ wait: "(?s)ACP_SAVED_C3_R0.*1 more AGY request waiting" }, { sleep: 0.3 }, { snapshot: "perm-two-first" },
			{ key: "down" }, { key: "enter" },
			{ wait: "(?s)1 more AGY request waiting.*Run: echo two" }, { sleep: 0.3 }, { snapshot: "perm-two-second" },
			{ key: "escape" },
			{ wait: "ACP_SAVED_C4_R0" }, { sleep: 0.3 }, { snapshot: "perm-two-done" },

			// 5. [perm-escape] ANSI escape and bidi override rendered visibly as \uXXXX.
			...submit("[perm-escape] escape test"),
			{ wait: "(?s)ACP_SAVED_C4_R0.*\\\\u001b\\[31m" }, { sleep: 0.3 }, { snapshot: "perm-escape-open" },
			{ key: "escape" },
			{ wait: "ACP_SAVED_C5_R0" }, { sleep: 0.3 }, { snapshot: "perm-escape-done" },

			...submit("/quit"), { waitExit: 5 },
		], { cols, rows: 38, timeout: 90 });

		const snapNames = [
			"perm-open", "perm-allowed", "perm-reject-open", "perm-rejected",
			"perm-long-locked", "perm-long-unlocked", "perm-long-rejected",
			"perm-two-first", "perm-two-second", "perm-two-done",
			"perm-escape-open", "perm-escape-done",
		];
		writeFileSync(join(p.root, "screens.txt"), snapNames.map(n => `==== ${n}\n${run.screenAt(n)}`).join("\n"));
		for (const name of snapNames) assertScreenFits(run.linesAt(name), cols);

		const hostRows = p.host();
		assertOnlyFakeLaunches(hostRows);

		// 1. [perm] open & allowed screens
		const permOpen = run.screenAt("perm-open");
		expect(permOpen).toContain("AGY needs approval");
		expect(permOpen).toContain("Run: ls -1");
		expect(permOpen).toContain("> Reject once");
		expect(permOpen).toContain("Allow once");
		expect(permOpen).not.toContain("Native policy still applies.");
		expect(permOpen).not.toContain("Origin not supplied");

		const permAllowed = run.screenAt("perm-allowed").replace(/\s+/g, " ");
		expect(permAllowed).toContain("You allowed AGY to run ls -1 once.");
		expect(permAllowed).toContain("AGY command · step 1 · reported DONE");

		// 2. [perm] rejected screen (and no Error details line)
		const permRejected = run.screenAt("perm-rejected").replace(/\s+/g, " ");
		expect(permRejected).toContain("You rejected AGY's request to run ls -1.");
		expect(permRejected).toContain("AGY command · step 1 · rejected by you");
		expect(permRejected).not.toContain("Error details");

		// 3. [perm-long] locked before PageDown, unlocked on final Page N of N after PageDown, collapsed on reject
		const longLocked = run.screenAt("perm-long-locked");
		expect(longLocked).toContain("Allow once  (unavailable)");
		expect(longLocked).toContain("Review all details before allowing.");
		const longUnlocked = run.screenAt("perm-long-unlocked");
		expect(longUnlocked).toContain("Allow once");
		expect(longUnlocked).not.toContain("(unavailable)");
		expect(longUnlocked).not.toContain("Review all details before allowing.");
		expect(longUnlocked).toMatch(/Page (\d+) of \1 \(lines \d+-(\d+) of \2\)/);
		const longRejected = run.screenAt("perm-long-rejected").replace(/\s+/g, " ");
		expect(longRejected).toContain("You rejected AGY's request to run echo line-1….");
		expect(longRejected).toContain("to expand");
		expect(longRejected).not.toContain("echo line-200");

		// 4. [perm-two] first shows waiting count, second shows echo two without waiting
		const twoFirst = run.screenAt("perm-two-first");
		expect(twoFirst).toContain("Run: echo one");
		expect(twoFirst).toContain("1 more AGY request waiting");
		const twoSecond = run.screenAt("perm-two-second");
		expect(twoSecond).toContain("Run: echo two");
		expect(twoSecond).not.toContain("1 more AGY request waiting");

		// 5. [perm-escape] shows escaped ANSI and bidi sequences
		const escapeOpen = run.screenAt("perm-escape-open");
		expect(escapeOpen).toContain("\\u001b[31m");
		expect(escapeOpen).toContain("\\u202e");

		// Saved session records confirm all 6 permission decisions & 6 activity records.
		const saved = lines(p.sessionFile());
		const permissions = saved.filter(e => e.customType === "rbf-agy-acp-permission/v1");
		const activities = saved.filter(e => e.customType === "rbf-agy-acp-activity/v1");
		expect(permissions.map(e => [e.data.toolCallId, e.data.reply, e.data.reason])).toEqual([
			["call_1540230168067533781", "allow_once", "user"],
			["call_1540230168067533781", "reject_once", "user"],
			["call_perm_long", "reject_once", "user"],
			["call_perm_1", "allow_once", "user"],
			["call_perm_2", "reject_once", "user"],
			["call_perm_escape", "reject_once", "user"],
		]);
		expect(activities.map(e => [e.data.toolCallId, e.data.state, e.data.approval?.reply])).toEqual([
			["call_1540230168067533781", "completed", "allow_once"],
			["call_1540230168067533781", "failed", "reject_once"],
			["call_perm_long", "failed", "reject_once"],
			["call_perm_1", "completed", "allow_once"],
			["call_perm_2", "failed", "reject_once"],
			["call_perm_escape", "failed", "reject_once"],
		]);

		// host.jsonl counts reflect saved permission and activity entries.
		const lastSaved = hostRows.filter(e => e.event === "saved").at(-1);
		expect(lastSaved.counts).toMatchObject({ completion: 5, refusal: 0, permission: 6, activity: 6, question: 0 });
		console.log(`ACP PTY approvals (${cols} cols) receipt: ${p.root}`);
	}, 180000);

	// Row 64: AGY's sandbox blocked a write and AGY asked again for the same command with BypassSandbox: true. The dialog and the saved lines must say that it runs outside the sandbox.
	it("says in the dialog and in the saved lines that AGY asks to run a command outside its sandbox, in actual Pi", async () => {
		const cols = 80, p = profile("acp-pty-bypass");
		const run = await p.run("bypass", [
			{ wait: "ACP_READY_startup" },
			...submit("/model agy-harness/gemini-3.8-flash"), { wait: "Model: gemini-3\\.8-flash" },
			...submit("[perm-bypass] allow me"),
			{ wait: "AGY needs approval" }, { sleep: 0.3 }, { snapshot: "bypass-open" },
			{ key: "down" }, { key: "enter" },
			{ wait: "ACP_SAVED_C1_R0" }, { sleep: 0.3 }, { snapshot: "bypass-allowed" },
			...submit("[perm-bypass] reject me"),
			{ wait: "(?s)ACP_SAVED_C1_R0.*AGY needs approval" }, { sleep: 0.3 }, { snapshot: "bypass-reject-open" },
			{ key: "escape" },
			{ wait: "ACP_SAVED_C2_R0" }, { sleep: 0.3 }, { snapshot: "bypass-rejected" },
			...submit("/quit"), { waitExit: 5 },
		], { cols, rows: 38, timeout: 90 });
		const snapNames = ["bypass-open", "bypass-allowed", "bypass-reject-open", "bypass-rejected"];
		writeFileSync(join(p.root, "screens.txt"), snapNames.map(n => `==== ${n}\n${run.screenAt(n)}`).join("\n"));
		for (const name of snapNames) assertScreenFits(run.linesAt(name), cols);
		assertOnlyFakeLaunches(p.host());

		for (const name of ["bypass-open", "bypass-reject-open"]) {
			const open = run.screenAt(name);
			expect(open, name).toContain("AGY needs approval to run outside its sandbox");
			expect(open, name).toContain("Run: touch out.txt");
			expect(open, name).toContain("> Reject once");
		}
		expect(run.screenAt("bypass-allowed").replace(/\s+/g, " ")).toContain("You allowed AGY to run touch out.txt once, outside its sandbox.");
		expect(run.screenAt("bypass-rejected").replace(/\s+/g, " ")).toContain("You rejected AGY's request to run touch out.txt outside its sandbox.");

		// The request AGY sent carried BypassSandbox in both places, the replies went back, and the saved records say it.
		const asked = p.acp().filter(r => r.out?.method === "session/request_permission").map(r => r.out.params.toolCall);
		expect(asked.map(t => [t.toolCallId, t.rawInput.BypassSandbox, t.args.BypassSandbox])).toEqual([["call_perm_bypass", true, true], ["call_perm_bypass", true, true]]);
		expect(p.acp().filter(r => r.permissionReply).map(r => r.permissionReply.outcome)).toEqual([{ outcome: "selected", optionId: "allow" }, { outcome: "selected", optionId: "deny" }]);
		const permissions = lines(p.sessionFile()).filter(e => e.customType === "rbf-agy-acp-permission/v1");
		expect(permissions.map(e => [e.data.toolCallId, e.data.command, e.data.bypassSandbox, e.data.reply, e.data.reason])).toEqual([
			["call_perm_bypass", "touch out.txt", true, "allow_once", "user"],
			["call_perm_bypass", "touch out.txt", true, "reject_once", "user"],
		]);
		// The message log is opt-in: this run did not ask for it.
		expect(existsSync(join(p.root, "agent", "rbf-agy-wire.jsonl"))).toBe(false);
		console.log(`ACP PTY bypass-sandbox receipt: ${p.root}`);
	}, 180000);

	// Row 65: Tom answered a real dialog with Down then Enter and no reply reached AGY. Best-fit suspect: in Pi's fullscreen mode (Tom's setting) a mouse click outside the overlay takes keyboard focus, and the keys go there.
	// Guard: with the setting on, the dialog opens, a left click lands on Pi's editor line (outside the dialog) and one inside the dialog, a wheel turn lands over the transcript, the editor line and the dialog, then Down and Enter answer it.
	it("keeps keys on an open approval dialog after a click on the editor line and a scroll over the transcript in fullscreen", async () => {
		const cols = 80, p = profile("acp-pty-click");
		writeFileSync(join(p.root, "agent", "settings.json"), JSON.stringify({ defaultThinkingLevel: "low", theme: "dark", tuiMode: "fullscreen" }));
		const click = (x: number, row: string) => [{ bytes: `\x1b[<0;${x};{${row}}M` }, { bytes: `\x1b[<0;${x};{${row}}m` }];
		const wheel = (button: number, x: number, row: string) => ({ bytes: `\x1b[<${button};${x};{${row}}M` });
		const run = await p.run("click", [
			{ wait: "ACP_READY_startup" },
			...submit("/model agy-harness/gemini-3.8-flash"), { wait: "Model: gemini-3\\.8-flash" },

			// 1. A left click on the editor line, which lies outside the dialog.
			...submit("[perm] click away"),
			{ wait: "AGY needs approval" }, { sleep: 0.3 }, { snapshot: "click-open" },
			{ locate: { name: "editor", text: "Working" } }, { locate: { name: "allow", text: "Allow once" } },
			...click(10, "editor+1"), ...click(10, "allow"), { sleep: 0.3 }, { snapshot: "click-after" },
			{ key: "down" }, { key: "enter" },
			{ wait: "ACP_SAVED_C1_R0" }, { sleep: 0.3 }, { snapshot: "click-answered" },

			// 2. A wheel turn up and down over the transcript, then over the editor line.
			...submit("[perm] scroll away"),
			{ wait: "(?s)ACP_SAVED_C1_R0.*AGY needs approval" }, { sleep: 0.3 }, { snapshot: "scroll-open" },
			{ locate: { name: "transcript", text: "scroll away" } }, { locate: { name: "editor2", text: "Working" } }, { locate: { name: "allow2", text: "Allow once" } },
			wheel(64, 10, "transcript"), wheel(65, 10, "transcript"), wheel(64, 10, "editor2+1"), wheel(65, 10, "editor2+1"), wheel(64, 10, "allow2"), wheel(65, 10, "allow2"), { sleep: 0.3 }, { snapshot: "scroll-after" },
			{ key: "down" }, { key: "enter" },
			{ wait: "ACP_SAVED_C2_R0" }, { sleep: 0.3 }, { snapshot: "scroll-answered" },
			...submit("/quit"), { waitExit: 5 },
		], { cols, rows: 38, timeout: 90, env: { RBF_AGY_WIRE_LOG: "1" } });
		const snapNames = ["click-open", "click-after", "click-answered", "scroll-open", "scroll-after", "scroll-answered"];
		writeFileSync(join(p.root, "screens.txt"), snapNames.map(n => `==== ${n}\n${run.screenAt(n)}`).join("\n"));
		assertOnlyFakeLaunches(p.host());
		expect(JSON.parse(readFileSync(join(p.root, "agent", "settings.json"), "utf8")).tuiMode).toBe("fullscreen");

		// The dialog was still open, and still on the same request, after the click and after the scroll.
		for (const name of ["click-after", "scroll-after"]) {
			const screen = run.screenAt(name);
			expect(screen, name).toContain("AGY needs approval");
			expect(screen, name).toContain("> Reject once");
		}
		expect(p.acp().filter(r => r.permissionReply).map(r => r.permissionReply.outcome)).toEqual([{ outcome: "selected", optionId: "allow" }, { outcome: "selected", optionId: "allow" }]);
		const permissions = lines(p.sessionFile()).filter(e => e.customType === "rbf-agy-acp-permission/v1");
		expect(permissions.map(e => [e.data.toolCallId, e.data.reply, e.data.reason])).toEqual([["call_1540230168067533781", "allow_once", "user"], ["call_1540230168067533781", "allow_once", "user"]]);
		const answered = run.screenAt("scroll-answered").replace(/\s+/g, " ");
		expect(answered).toContain("You allowed AGY to run ls -1 once.");

		// What Pi did with the click, from the message log (RBF_AGY_WIRE_LOG=1, in the profile's agent dir). A click on the editor line took focus from the dialog (`focused: false`) and Pi gave it back with the next key,
		// before the dialog handled that key. A click inside the dialog and a wheel turn anywhere changed no focus. Both answers are Down, then Enter.
		const wire = lines(join(p.root, "agent", "rbf-agy-wire.jsonl"));
		const steps = wire.filter(e => e.ev === "dlg" && e.step !== "render").map(e => e.step === "focus" ? `focus:${e.focused}` : e.step === "key" ? `key:${e.key}` : `${e.step}:${e.choice}`);
		expect(steps).toEqual([
			"focus:true", "focus:false", "focus:true", "key:down", "key:enter", "finish:accept", "focus:false",
			"focus:true", "key:down", "key:enter", "finish:accept", "focus:false",
		]);
		expect(wire.filter(e => e.ev === "rec").map(e => [e.customType, e.toolCallId, e.result])).toEqual([["rbf-agy-acp-permission/v1", "call_1540230168067533781", "ok"], ["rbf-agy-acp-permission/v1", "call_1540230168067533781", "ok"]]);
		expect(wire.filter(e => e.ev === "out" && e.kind === "reply").map(e => [e.id, e.optionId, e.delivered])).toEqual([["1", "allow", true], ["1", "allow", true]]);
		// The log holds no text AGY wrote, no command and no output.
		const wireText = readFileSync(join(p.root, "agent", "rbf-agy-wire.jsonl"), "utf8");
		for (const secret of ["ls -1", "a.txt", "after permission", "click away", "scroll away"]) expect(wireText, secret).not.toContain(secret);
		console.log(`ACP PTY click receipt: ${p.root}`);
	}, 180000);

	it("handles mid-turn Esc cancel on a streaming partial answer, anchors the aborted entry before agent_end, and continues the same ACP session", async () => {
		const cols = 80;
		const p = profile("acp-pty-cancel");
		const run = await p.run("cancel", [
			{ wait: "ACP_READY_startup" },
			...submit("/model agy-harness/gemini-3.8-flash"), { wait: "Model: gemini-3\\.8-flash" },
			...submit("[hold-partial] cancel me"),
			{ wait: "Partial before cancel\\." }, { sleep: 0.2 }, { snapshot: "streaming-partial" },
			{ key: "escape" },
			{ wait: "ACP_SAVED_C1_R0" }, { sleep: 0.3 }, { snapshot: "after-cancel" },
			...submit("After cancel continue."),
			{ wait: "ACP_SAVED_C2_R0" }, { sleep: 0.3 }, { snapshot: "after-continue" },
			...submit("/quit"), { waitExit: 5 },
		], { cols, rows: 38, timeout: 60 });

		const snapNames = ["streaming-partial", "after-cancel", "after-continue"];
		writeFileSync(join(p.root, "screens.txt"), snapNames.map(n => `==== ${n}\n${run.screenAt(n)}`).join("\n"));
		for (const name of snapNames) assertScreenFits(run.linesAt(name), cols);

		const hostRows = p.host();
		assertOnlyFakeLaunches(hostRows);

		const file = p.sessionFile();
		const saved = lines(file);
		expect(saved.filter(e => e.type === "compaction" || e.type === "context_edit")).toEqual([]);

		const completions = saved.filter(e => e.customType === "rbf-agy-acp-completion/v1");
		expect(completions).toHaveLength(2);
		expect(completions[0].data.outcome).toBe("cancelled");
		expect(completions[1].data.outcome).toBe("stop");

		const abortedAssistant = saved.find(e => e.id === completions[0].data.assistantId);
		expect(abortedAssistant?.message?.stopReason).toBe("aborted");
		const abortedText = (abortedAssistant?.message?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("");
		expect(abortedText).toBe("Partial before cancel.");

		const acpSessionId = completions[0].data.acpSessionId;
		expect(completions[1].data.acpSessionId).toBe(acpSessionId);

		// readSavedSession + selectAcpRecoveryAnchor accept the saved session cleanly.
		const [header, ...branch] = saved;
		const savedSession = readSavedSession(
			{
				getSessionId: () => header.id,
				getSessionFile: () => file,
				getLeafId: () => branch.at(-1).id,
				getBranch: () => branch,
			},
			header.cwd,
		);
		const probeUser = { id: "probe-next", parentId: savedSession.branch.at(-1).id, type: "message", message: { role: "user", content: [{ type: "text", text: "probe next" }] } };
		const anchor = selectAcpRecoveryAnchor(
			{ ...savedSession, all: [...savedSession.all, probeUser], branch: [...savedSession.branch, probeUser] },
			probeUser.id,
		);
		expect(anchor?.acpSessionId).toBe(acpSessionId);
		expect(anchor?.completion?.id).toBe(completions[1].id);

		// acp.jsonl shows 1 child, 1 session/new, 1 session/cancel, and 2 session/prompt calls on the same acpSessionId.
		const acpRows = p.acp();
		expect(acpRows.filter(r => r.args).map(r => r.args)).toEqual([["acp"]]);
		expect(calls(acpRows, "session/new")).toHaveLength(1);
		expect(calls(acpRows, "session/cancel")).toHaveLength(1);
		const prompts = calls(acpRows, "session/prompt");
		expect(prompts.map(m => [m.params.sessionId, m.params.prompt[0].text])).toEqual([
			[acpSessionId, "[hold-partial] cancel me"],
			[acpSessionId, "After cancel continue."],
		]);

		const afterCancelScreen = run.screenAt("after-cancel").replace(/\s+/g, " ");
		expect(afterCancelScreen).toContain("Partial before cancel.");
		expect(afterCancelScreen).toContain("AGY request cancelled.");
		expect(run.screenAt("after-continue").replace(/\s+/g, " ")).toContain("Hello from ACP.");
		console.log(`ACP PTY mid-turn Esc cancel receipt: ${p.root}`);
	}, 120000);
});
