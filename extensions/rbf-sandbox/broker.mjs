import fs from "node:fs";
import fsp from "node:fs/promises";
import { spawn } from "node:child_process";

const control = fs.createWriteStream(null, { fd: 3, autoClose: false });
const send = (value) => control.write(`${JSON.stringify(value)}\n`);
const nonce = process.env.RBF_SANDBOX_NONCE;

if (!nonce) process.exit(70);
send({ version: 1, phase: "ready", nonce });

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
	input += chunk;
	if (input.length > 25 * 1024 * 1024) process.exit(71);
}

const request = JSON.parse(input);
if (request.version !== 1 || request.nonce !== nonce || typeof request.operation !== "string") process.exit(72);

async function run(command, args, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: JSON.parse(process.env.RBF_SANDBOX_ENV ?? "{}"),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		child.stdout.on("data", (chunk) => { stdout = Buffer.concat([stdout, chunk]); });
		child.stderr.on("data", (chunk) => { stderr = Buffer.concat([stderr, chunk]); });
		child.on("error", reject);
		child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
	});
}

try {
	let value;
	switch (request.operation) {
		case "bash": {
			const result = await run("/bin/bash", ["-c", request.command], request.cwd);
			process.stdout.write(result.stdout);
			process.stderr.write(result.stderr);
			value = { exitCode: result.exitCode };
			break;
		}
		case "readFile":
			value = { base64: (await fsp.readFile(request.path)).toString("base64") };
			break;
		case "writeFile":
			await fsp.writeFile(request.path, request.content);
			value = null;
			break;
		case "mkdir":
			await fsp.mkdir(request.path, { recursive: true });
			value = null;
			break;
		case "access":
			await fsp.access(request.path, request.mode);
			value = null;
			break;
		case "exists":
			value = await fsp.access(request.path).then(() => true, () => false);
			break;
		case "stat":
			value = { isDirectory: (await fsp.stat(request.path)).isDirectory() };
			break;
		case "readdir":
			value = await fsp.readdir(request.path);
			break;
		case "glob": {
			const result = await run(request.fdPath, ["--glob", request.pattern, "--hidden", "--exclude", ".git", "--max-results", String(request.limit), "."], request.cwd);
			if (result.exitCode !== 0) throw new Error(result.stderr.toString() || "fd failed");
			value = result.stdout.toString().split("\n").filter(Boolean);
			break;
		}
		case "grep": {
			const args = ["--line-number", "--color=never", "--hidden"];
			if (request.ignoreCase) args.push("--ignore-case");
			if (request.literal) args.push("--fixed-strings");
			if (request.glob) args.push("--glob", request.glob);
			args.push("--", request.pattern, request.path);
			const result = await run(request.rgPath, args, request.cwd);
			if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(result.stderr.toString() || "rg failed");
			value = result.stdout.toString();
			break;
		}
		default:
			throw new Error("Unknown broker operation");
	}
	send({ version: 1, phase: "completion", nonce, value });
} catch (error) {
	send({ version: 1, phase: "completion", nonce, error: error instanceof Error ? error.message : "Broker operation failed" });
}
