// Observational transport for opt-in probes only. Forwards bytes, owns only its child.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [codex, ...args] = process.argv.slice(2);
if (!codex) throw new Error("Codex executable required");
const server = args.includes("app-server");
const log = process.env.RBF_INTERRUPTION_REQUEST_LOG;
const owned = process.env.RBF_INTERRUPTION_OWNED_LOG;
const child = spawn(codex, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
let timer: ReturnType<typeof setTimeout> | undefined;
child.stdin.on("error", () => {});
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
if (server && log) createInterface({ input: child.stdout }).on("line", (line) => {
	try {
		const m = JSON.parse(line);
		if (m.method === "item/started" && m.params?.item?.type === "commandExecution") appendFileSync(log, `${JSON.stringify({ method: "probe/command-start", params: { threadId: m.params.threadId, turnId: m.params.turnId, itemId: m.params.item.id, command: m.params.item.command } })}\n`);
	} catch { /* observation does not alter the server stream */ }
});
child.once("spawn", () => { if (server && owned) appendFileSync(owned, `${JSON.stringify({ event: "spawn", pid: child.pid })}\n`); });
child.once("error", () => process.exit(1));
child.once("exit", (code) => {
	if (timer) clearTimeout(timer);
	if (server && owned) appendFileSync(owned, `${JSON.stringify({ event: "exit", pid: child.pid })}\n`);
	process.exit(code ?? 1);
});
createInterface({ input: process.stdin }).on("line", (line) => {
	if (server && log) {
		try {
			const m = JSON.parse(line);
			if (m.method) appendFileSync(log, `${JSON.stringify({ method: m.method, params: m.params })}\n`);
		} catch { /* forward unchanged; protocol validation belongs to the real server */ }
	}
	child.stdin.write(`${line}\n`);
}).on("close", () => {
	child.stdin.end();
	// Normally EOF closes Codex immediately. Bound teardown of this captured child.
	timer = setTimeout(() => { child.kill("SIGTERM"); timer = setTimeout(() => child.kill("SIGKILL"), 1000); }, 5000);
});
// The PTY session sends HUP when Pi dies. Keep the observer alive long enough
// for Codex to observe stdin EOF and for its captured exit to be recorded.
process.on("SIGHUP", () => {
	child.stdout.unpipe(process.stdout); child.stdout.resume();
	child.stderr.unpipe(process.stderr); child.stderr.resume();
	child.stdin.end();
});
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
