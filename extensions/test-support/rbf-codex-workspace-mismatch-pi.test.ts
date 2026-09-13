import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs, selectSessionByHeaderId } from "./rbf-codex-workspace-mismatch-pi.js";

const roots: string[] = [];
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const launcher = path.join(repositoryRoot, "extensions/test-support/rbf-codex-workspace-mismatch-pi.ts");
const observer = path.join(repositoryRoot, "extensions/test-support/rbf-codex-workspace-observer.ts");

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
	const root = mkdtempSync("/private/tmp/rbf-codex-workspace-launcher-");
	roots.push(root);
	return root;
}

function createSession(sessionDir: string, cwd: string, id: string): SessionManager {
	const manager = SessionManager.create(cwd, sessionDir, { id });
	manager.appendThinkingLevelChange("off");
	manager.appendCustomEntry("rbf-codex-workspace-seed/v1", { seed: true });
	manager.appendMessage({ role: "user", content: "seed", timestamp: 1 });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "seed" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "synthetic",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	});
	const sessionFile = manager.getSessionFile();
	const header = manager.getHeader();
	if (!sessionFile || !header) throw new Error("Synthetic session did not expose its file and header");
	return manager;
}

async function runInteractiveFixture(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; output: string }> {
	return await new Promise((resolve, reject) => {
		const command = [process.execPath, "run", launcher, ...args];
		if (command.some((value) => /[{}\r\n]/.test(value))) throw new Error("Fixture command contains unsupported Tcl characters");
		const expectProgram = [
			"set timeout 30",
			`spawn -noecho ${command.map((value) => `{${value}}`).join(" ")}`,
			"expect eof",
			"set result [wait]",
			"exit [lindex $result 3]",
		].join("; ");
		const child = spawn("/usr/bin/expect", ["-c", expectProgram], {
			cwd: repositoryRoot,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`Workspace launcher timed out: ${output.slice(-2_000)}`));
		}, 30_000);
		child.stdout.on("data", (chunk) => (output += String(chunk)));
		child.stderr.on("data", (chunk) => (output += String(chunk)));
		child.once("error", reject);
		child.once("exit", (status) => {
			clearTimeout(timer);
			resolve({ status, output });
		});
	});
}

describe("rbf-codex real-Pi workspace mismatch launcher", () => {
	it("selects exactly one parsed header and rejects every malformed directory before extension load", () => {
		const root = makeRoot();
		const sessions = path.join(root, "sessions");
		const original = path.join(root, "original");
		const runtime = path.join(root, "runtime");
		const agent = path.join(root, "agent");
		mkdirSync(sessions);
		mkdirSync(original);
		mkdirSync(runtime);
		mkdirSync(agent);
		createSession(sessions, original, "wanted");

		expect(selectSessionByHeaderId(sessions, "wanted").headerCwd).toBe(original);
		expect(() => selectSessionByHeaderId(sessions, "missing")).toThrow("found 0");
		writeFileSync(path.join(sessions, "malformed.jsonl"), "not json\n");
		expect(() => selectSessionByHeaderId(sessions, "wanted")).toThrow();
		expect(() =>
			parseArgs([
				"--session-dir",
				"relative",
				"--session-id",
				"wanted",
				"--runtime-workspace",
				runtime,
				"--artifact",
				observer,
				"--agent-dir",
				agent,
			]),
		).toThrow("must be absolute");
	});

	it("runs one observer through ordinary InteractiveMode with the override and preserves the source session", async () => {
		const root = makeRoot();
		const sessions = path.join(root, "sessions");
		const original = path.join(root, "original");
		const runtime = path.join(root, "runtime");
		const agent = path.join(root, "agent");
		const observerOutput = path.join(root, "observer");
		for (const directory of [sessions, original, runtime, agent]) mkdirSync(directory);
		const manager = createSession(sessions, original, "workspace-proof");
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Synthetic session did not persist");
		const before = readFileSync(sessionFile);
		const leaf = manager.getLeafId();

		const result = await runInteractiveFixture(
			[
				"--session-dir",
				sessions,
				"--session-id",
				"workspace-proof",
				"--runtime-workspace",
				runtime,
				"--artifact",
				observer,
				"--agent-dir",
				agent,
			],
			{
				HOME: process.env.HOME,
				PATH: process.env.PATH,
				TERM: "xterm-256color",
				NO_COLOR: "1",
				CI: "1",
				PI_OFFLINE: "1",
				PI10_WORKSPACE_OBSERVER_OUTPUT: observerOutput,
			},
		);
		expect(result.status, result.output).toBe(0);
		expect(result.output).toContain(
			`workspace_fixture_session_id=workspace-proof session_file=${sessionFile} header_cwd=${original} runtime_cwd=${runtime}`,
		);
		expect(result.output).toContain("workspace_fixture_header_preserved=true workspace_fixture_branch_preserved=true");
		expect(existsSync(`${observerOutput}.loaded`)).toBe(true);
		const observed = JSON.parse(readFileSync(`${observerOutput}.session`, "utf8")) as Record<string, unknown>;
		expect(observed).toMatchObject({
			schema: "rbf-codex-workspace-observer/v1",
			eventReason: "startup",
			sessionId: "workspace-proof",
			leafId: leaf,
			runtimeCwd: runtime,
			contextCwd: runtime,
			mode: "tui",
			modelProvider: "unknown",
			registeredTools: [],
		});
		expect((observed.header as { cwd: string }).cwd).toBe(original);
		expect(readFileSync(sessionFile)).toEqual(before);
	});
});
