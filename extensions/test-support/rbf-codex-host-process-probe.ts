import { dlopen, FFIType, ptr } from "bun:ffi";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const PROC_PIDTBSDINFO = 3;
const PROC_PIDTBSDINFO_SIZE = 136;
const TASK_AUDIT_TOKEN = 15;
const KERN_SUCCESS = 0;
const EX_TEMPFAIL = 75;

interface ProcessIdentity {
	pid: number;
	startSeconds: bigint;
	startMicroseconds: bigint;
}

interface ProbeOptions {
	root: string;
	codex: string;
	output: string;
}

interface HostProcessReceipt {
	schema: "rbf-codex-host-process-probe/v1";
	codexVersion: string;
	descriptorLock: {
		shortHelperExited: boolean;
		secondOpenerExit: number;
		acquiredAfterClose: boolean;
		acquiredAfterOwnerDeath: boolean;
	};
	appServer: {
		pidEqualsSessionId: boolean;
		processStartSha256: string;
		identityBoundSignalAvailable: boolean;
		taskForPidStatus: number;
	};
	finalOwnedProcesses: number;
	pass: boolean;
}

const system = dlopen("/usr/lib/libSystem.B.dylib", {
	mach_task_self: { args: [], returns: FFIType.u32 },
	task_for_pid: { args: [FFIType.u32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
	task_info: { args: [FFIType.u32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	mach_port_deallocate: { args: [FFIType.u32, FFIType.u32], returns: FFIType.i32 },
	proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	proc_signal_with_audittoken: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
});

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function run(executable: string, args: string[], stdio: Parameters<typeof spawnSync>[2] = {}): ReturnType<typeof spawnSync> {
	return spawnSync(executable, args, { encoding: "utf8", maxBuffer: MAX_CAPTURE_BYTES, ...stdio });
}

function requireSuccessful(result: ReturnType<typeof spawnSync>, label: string): void {
	if (result.error || result.status !== 0) throw new Error(`${label} failed`);
}

function parseArgs(argv: readonly string[]): ProbeOptions {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag?.startsWith("--") || value === undefined || values.has(flag)) throw new Error("Invalid probe arguments");
		values.set(flag, value);
	}
	for (const flag of values.keys()) {
		if (!["--root", "--codex", "--output"].includes(flag)) throw new Error(`Unknown argument: ${flag}`);
	}
	const root = values.get("--root");
	const codex = values.get("--codex");
	const output = values.get("--output");
	if (!root || !codex || !output) throw new Error("Required arguments: --root PATH --codex PATH --output PATH");
	if (![root, codex, output].every(path.isAbsolute)) throw new Error("Probe paths must be absolute");
	return { root, codex, output };
}

function atomicWriteNew(output: string, value: unknown): void {
	if (existsSync(output)) throw new Error("Output already exists");
	const temporary = `${output}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
	const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
	try {
		writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	renameSync(temporary, output);
	const directory = openSync(path.dirname(output), constants.O_RDONLY);
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
}

function sessionId(pid: number): number {
	const result = run("/usr/bin/ruby", ["-e", "STDOUT.write(Process.getsid(Integer(ARGV[0])).to_s)", String(pid)]);
	requireSuccessful(result, "getsid");
	return Number(result.stdout);
}

function processIds(): number[] {
	const result = run("/bin/ps", ["-axo", "pid="]);
	requireSuccessful(result, "process enumeration");
	return String(result.stdout)
		.split(/\s+/)
		.map(Number)
		.filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

function sessionMembers(sid: number): number[] {
	const script = [
		"target = Integer(ARGV.shift)",
		"members = ARGV.each_with_object([]) do |raw, found|",
		"  begin",
		"    pid = Integer(raw)",
		"    found << pid if Process.getsid(pid) == target",
		"  rescue SystemCallError",
		"  end",
		"end",
		"STDOUT.write(members.join(' '))",
	].join("\n");
	const result = run("/usr/bin/ruby", ["-e", script, String(sid), ...processIds().map(String)]);
	requireSuccessful(result, "session membership scan");
	return String(result.stdout).trim().split(/\s+/).filter(Boolean).map(Number);
}

function processIdentity(pid: number): ProcessIdentity {
	const buffer = new Uint8Array(PROC_PIDTBSDINFO_SIZE);
	const bytes = system.symbols.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ptr(buffer), buffer.length);
	if (bytes !== PROC_PIDTBSDINFO_SIZE) throw new Error("proc_pidinfo did not return PROC_PIDTBSDINFO");
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	const identity = {
		pid: view.getUint32(12, true),
		startSeconds: view.getBigUint64(120, true),
		startMicroseconds: view.getBigUint64(128, true),
	};
	if (identity.pid !== pid || identity.startSeconds === 0n) throw new Error("proc_pidinfo returned an invalid process identity");
	return identity;
}

function auditTokenForPid(pid: number): { status: number; token?: Uint32Array } {
	const self = system.symbols.mach_task_self();
	const taskPort = new Uint32Array(1);
	const status = system.symbols.task_for_pid(self, pid, ptr(taskPort));
	if (status !== KERN_SUCCESS) return { status };
	try {
		const token = new Uint32Array(8);
		const count = new Uint32Array([token.length]);
		const infoStatus = system.symbols.task_info(taskPort[0], TASK_AUDIT_TOKEN, ptr(token), ptr(count));
		if (infoStatus !== KERN_SUCCESS || count[0] !== token.length) return { status: infoStatus };
		return { status: KERN_SUCCESS, token };
	} finally {
		system.symbols.mach_port_deallocate(self, taskPort[0]);
	}
}

async function waitForExit(child: ChildProcess, timeoutMs = 2_000): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return true;
	return await new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.off("exit", exited);
			resolve(false);
		}, timeoutMs);
		const exited = () => {
			clearTimeout(timer);
			resolve(true);
		};
		child.once("exit", exited);
	});
}

async function waitForFile(file: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (existsSync(file)) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Timed out waiting for lock-owner readiness");
}

async function probeDescriptorLock(root: string): Promise<HostProcessReceipt["descriptorLock"]> {
	const lockPath = path.join(root, "lifecycle.lock");
	const descriptor = openSync(lockPath, constants.O_CREAT | constants.O_RDWR, 0o600);
	const shortHelper = run("/usr/bin/lockf", ["-s", "-t", "0", "3"], { stdio: ["ignore", "pipe", "pipe", descriptor] });
	const second = run("/usr/bin/lockf", ["-s", "-t", "0", lockPath, "/usr/bin/true"]);
	closeSync(descriptor);
	const afterClose = run("/usr/bin/lockf", ["-s", "-t", "0", lockPath, "/usr/bin/true"]);
	const readyPath = path.join(root, "lock-owner.ready");
	const owner = spawn(process.execPath, [fileURLToPath(import.meta.url), "--lock-owner", lockPath, readyPath], {
		stdio: ["ignore", "ignore", "ignore"],
	});
	let whileOwnerLive: ReturnType<typeof spawnSync> | undefined;
	try {
		await waitForFile(readyPath);
		whileOwnerLive = run("/usr/bin/lockf", ["-s", "-t", "0", lockPath, "/usr/bin/true"]);
	} finally {
		owner.kill("SIGKILL");
		await waitForExit(owner);
	}
	if (!whileOwnerLive) throw new Error("Lock owner never reached readiness");
	const afterOwnerDeath = run("/usr/bin/lockf", ["-s", "-t", "0", lockPath, "/usr/bin/true"]);
	return {
		shortHelperExited: shortHelper.status === 0,
		secondOpenerExit: second.status ?? -1,
		acquiredAfterClose: afterClose.status === 0,
		acquiredAfterOwnerDeath: whileOwnerLive.status === EX_TEMPFAIL && afterOwnerDeath.status === 0,
	};
}

function runLockOwner(lockPath: string, readyPath: string): void {
	const descriptor = openSync(lockPath, constants.O_CREAT | constants.O_RDWR, 0o600);
	const locked = run("/usr/bin/lockf", ["-s", "-t", "0", "3"], { stdio: ["ignore", "ignore", "ignore", descriptor] });
	if (locked.status !== 0) process.exit(2);
	writeFileSync(readyPath, "ready\n", { mode: 0o600 });
	setInterval(() => undefined, 60_000);
}

async function cleanOwnedChild(child: ChildProcess, sid: number): Promise<number> {
	for (const pid of sessionMembers(sid)) {
		try {
			process.kill(pid, "SIGTERM");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
	await waitForExit(child, 500);
	for (const pid of sessionMembers(sid)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
	await waitForExit(child);
	let consecutiveEmpty = 0;
	for (let attempt = 0; attempt < 20; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 150));
		const members = sessionMembers(sid);
		if (members.length === 0) {
			consecutiveEmpty += 1;
			if (consecutiveEmpty === 2) return 0;
		} else {
			consecutiveEmpty = 0;
		}
	}
	return sessionMembers(sid).length;
}

async function probeAppServer(codex: string): Promise<HostProcessReceipt["appServer"] & { finalOwnedProcesses: number }> {
	const child = spawn(codex, ["app-server"], {
		detached: true,
		env: { ...process.env, RBF_CODEX_LAUNCH_TOKEN: randomBytes(24).toString("hex") },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let sid: number | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
		if (!child.pid) throw new Error("Codex app-server did not expose a PID");
		sid = sessionId(child.pid);
		const pidEqualsSessionId = child.pid === sid;
		const identity = processIdentity(child.pid);
		const audit = auditTokenForPid(child.pid);
		let identityBoundSignalAvailable = false;
		if (audit.token) {
			const beforeSignal = processIdentity(child.pid);
			if (
				beforeSignal.startSeconds !== identity.startSeconds ||
				beforeSignal.startMicroseconds !== identity.startMicroseconds
			) {
				throw new Error("Codex process identity changed before signaling");
			}
			identityBoundSignalAvailable = system.symbols.proc_signal_with_audittoken(ptr(audit.token), 15) === 0;
		}
		const finalOwnedProcesses = await cleanOwnedChild(child, sid);
		sid = undefined;
		return {
			pidEqualsSessionId,
			processStartSha256: sha256(`${identity.pid}:${identity.startSeconds}:${identity.startMicroseconds}`),
			identityBoundSignalAvailable,
			taskForPidStatus: audit.status,
			finalOwnedProcesses,
		};
	} finally {
		if (sid !== undefined) await cleanOwnedChild(child, sid);
	}
}

async function main(): Promise<void> {
	if (process.argv[2] === "--lock-owner") {
		runLockOwner(process.argv[3], process.argv[4]);
		return;
	}
	const options = parseArgs(process.argv.slice(2));
	mkdirSync(options.root, { recursive: true, mode: 0o700 });
	const root = realpathSync(options.root);
	const output = path.resolve(options.output);
	const relative = path.relative(root, output);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error("Output must be below the probe root");
	}
	if (lstatSync(options.codex).isDirectory()) throw new Error("Codex path must be an executable file");
	const versionResult = run(options.codex, ["--version"]);
	requireSuccessful(versionResult, "Codex version check");
	const versionMatch = /^codex-cli (\S+)\s*$/.exec(String(versionResult.stdout));
	if (!versionMatch) throw new Error("Unexpected Codex version output");
	const descriptorLock = await probeDescriptorLock(root);
	const appServer = await probeAppServer(options.codex);
	const pass =
		descriptorLock.shortHelperExited &&
		descriptorLock.secondOpenerExit === EX_TEMPFAIL &&
		descriptorLock.acquiredAfterClose &&
		descriptorLock.acquiredAfterOwnerDeath &&
		appServer.pidEqualsSessionId &&
		appServer.identityBoundSignalAvailable &&
		appServer.finalOwnedProcesses === 0;
	const receipt: HostProcessReceipt = {
		schema: "rbf-codex-host-process-probe/v1",
		codexVersion: versionMatch[1],
		descriptorLock,
		appServer: {
			pidEqualsSessionId: appServer.pidEqualsSessionId,
			processStartSha256: appServer.processStartSha256,
			identityBoundSignalAvailable: appServer.identityBoundSignalAvailable,
			taskForPidStatus: appServer.taskForPidStatus,
		},
		finalOwnedProcesses: appServer.finalOwnedProcesses,
		pass,
	};
	atomicWriteNew(output, receipt);
	const descriptorLockPassed =
		descriptorLock.shortHelperExited &&
		descriptorLock.secondOpenerExit === EX_TEMPFAIL &&
		descriptorLock.acquiredAfterClose &&
		descriptorLock.acquiredAfterOwnerDeath;
	process.stdout.write(
		`descriptor_lock=${descriptorLockPassed ? "true" : "false"} identity_bound_signal=${appServer.identityBoundSignalAvailable ? "true" : "false"} final_owned_processes=${appServer.finalOwnedProcesses}\n`,
	);
	if (!pass) process.exitCode = 1;
	rmSync(path.join(root, "lock-owner.ready"), { force: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : "Host process probe failed"}\n`);
		process.exitCode = 1;
	});
}
