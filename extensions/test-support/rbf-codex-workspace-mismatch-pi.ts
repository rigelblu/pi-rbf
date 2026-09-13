import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	InteractiveMode,
	SessionManager,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	parseSessionEntries,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeResult,
} from "@earendil-works/pi-coding-agent";

interface LauncherOptions {
	readonly sessionDir: string;
	readonly sessionId: string;
	readonly runtimeWorkspace: string;
	readonly artifact: string;
	readonly agentDir: string;
	readonly receipt?: string;
}

export interface SelectedSession {
	readonly sessionFile: string;
	readonly headerCwd: string;
	readonly originalBytes: Buffer;
	readonly originalLeafId: string | null;
	readonly originalBranchEntryIds: readonly string[];
}

function absoluteNativeDirectory(input: string, label: string): string {
	if (!path.isAbsolute(input)) throw new Error(`${label} must be absolute`);
	let resolved: string;
	try {
		resolved = realpathSync.native(input);
	} catch {
		throw new Error(`${label} must be an existing directory`);
	}
	if (resolved !== input || input.normalize("NFC") !== input || !statSync(input).isDirectory()) {
		throw new Error(`${label} must use exact NFC native-realpath directory spelling`);
	}
	return resolved;
}

function absoluteNativeFile(input: string, label: string): string {
	if (!path.isAbsolute(input)) throw new Error(`${label} must be absolute`);
	let resolved: string;
	try {
		resolved = realpathSync.native(input);
	} catch {
		throw new Error(`${label} must be an existing file`);
	}
	if (resolved !== input || input.normalize("NFC") !== input || !statSync(input).isFile()) {
		throw new Error(`${label} must use exact NFC native-realpath file spelling`);
	}
	return resolved;
}

export function parseArgs(argv: readonly string[]): LauncherOptions {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag?.startsWith("--") || value === undefined || values.has(flag)) throw new Error("Invalid launcher arguments");
		values.set(flag, value);
	}
	for (const flag of values.keys()) {
		if (!["--session-dir", "--session-id", "--runtime-workspace", "--artifact", "--agent-dir", "--receipt"].includes(flag)) {
			throw new Error(`Unknown argument: ${flag}`);
		}
	}
	const sessionDir = values.get("--session-dir");
	const sessionId = values.get("--session-id");
	const runtimeWorkspace = values.get("--runtime-workspace");
	const artifact = values.get("--artifact");
	const agentDir = values.get("--agent-dir");
	const receipt = values.get("--receipt");
	if (!sessionDir || !sessionId || !runtimeWorkspace || !artifact || !agentDir) {
		throw new Error("Required arguments: --session-dir DIR --session-id ID --runtime-workspace DIR --artifact FILE --agent-dir DIR");
	}
	if (Buffer.byteLength(sessionId) > 4_096 || sessionId.length === 0) throw new Error("Session ID is invalid");
	return {
		sessionDir: absoluteNativeDirectory(sessionDir, "Session directory"),
		sessionId,
		runtimeWorkspace: absoluteNativeDirectory(runtimeWorkspace, "Runtime workspace"),
		artifact: absoluteNativeFile(artifact, "Extension artifact"),
		agentDir: absoluteNativeDirectory(agentDir, "Agent directory"),
		receipt: receipt === undefined ? undefined : absoluteNativeFile(receipt, "Receipt"),
	};
}

export function selectSessionByHeaderId(sessionDir: string, sessionId: string): SelectedSession {
	const matches: SelectedSession[] = [];
	for (const name of readdirSync(sessionDir).sort()) {
		if (!name.endsWith(".jsonl")) continue;
		const candidate = path.join(sessionDir, name);
		let originalBytes: Buffer;
		let entries: ReturnType<typeof parseSessionEntries>;
		try {
			originalBytes = readFileSync(candidate);
			entries = parseSessionEntries(originalBytes.toString("utf8"));
		} catch {
			throw new Error(`Unreadable or malformed session file: ${candidate}`);
		}
		const header = entries[0];
		if (!header || header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") {
			throw new Error(`Missing session header: ${candidate}`);
		}
		if (header.id !== sessionId) continue;
		const opened = SessionManager.open(candidate, sessionDir);
		matches.push({
			sessionFile: candidate,
			headerCwd: header.cwd,
			originalBytes,
			originalLeafId: opened.getLeafId(),
			originalBranchEntryIds: opened.getBranch().map((entry) => entry.id),
		});
	}
	if (matches.length !== 1) throw new Error(`Expected exactly one session header match for ${sessionId}; found ${matches.length}`);
	return matches[0];
}

async function createRuntime(
	options: LauncherOptions,
	sessionManager: SessionManager,
	sessionStartEvent?: Parameters<typeof createAgentSessionFromServices>[0]["sessionStartEvent"],
): Promise<CreateAgentSessionRuntimeResult> {
	const services: AgentSessionServices = await createAgentSessionServices({
		cwd: sessionManager.getCwd(),
		agentDir: options.agentDir,
		modelRuntimeSignal: AbortSignal.timeout(15_000),
		resourceLoaderOptions: {
			additionalExtensionPaths: [options.artifact],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		},
	});
	const loadErrors = services.resourceLoader.getExtensions().errors;
	if (loadErrors.length > 0 || services.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
		throw new Error("Workspace launcher could not load its one extension");
	}
	const created = await createAgentSessionFromServices({
		services,
		sessionManager,
		sessionStartEvent,
		noTools: "all",
	});
	return { ...created, services, diagnostics: services.diagnostics };
}

async function runInteractiveChild(options: LauncherOptions, selected: SelectedSession): Promise<never> {
	const overridden = SessionManager.open(selected.sessionFile, options.sessionDir, options.runtimeWorkspace);
	if (overridden.getHeader()?.cwd !== selected.headerCwd || overridden.getCwd() !== options.runtimeWorkspace) {
		throw new Error("SessionManager.open did not preserve the header and apply the runtime workspace override");
	}
	const runtime = await createAgentSessionRuntime(
		({ sessionManager, sessionStartEvent }) => createRuntime(options, sessionManager, sessionStartEvent),
		{ cwd: options.runtimeWorkspace, agentDir: options.agentDir, sessionManager: overridden },
	);
	const interactive = new InteractiveMode(runtime, { verbose: false, tuiMode: "regular" });
	await interactive.run();
	throw new Error("InteractiveMode returned without terminating its process");
}

export async function runLauncher(options: LauncherOptions): Promise<void> {
	const selected = selectSessionByHeaderId(options.sessionDir, options.sessionId);
	const originalHeader = SessionManager.open(selected.sessionFile, options.sessionDir).getHeader();
	if (!originalHeader || originalHeader.id !== options.sessionId || originalHeader.cwd !== selected.headerCwd) {
		throw new Error("Selected session identity changed before launch");
	}
	if (options.receipt && process.env.PI10_ADMISSION_RECEIPT !== options.receipt) {
		throw new Error("Launcher receipt does not match PI10_ADMISSION_RECEIPT");
	}

	console.log(
		`workspace_fixture_session_id=${options.sessionId} session_file=${selected.sessionFile} header_cwd=${selected.headerCwd} runtime_cwd=${options.runtimeWorkspace}`,
	);
	const child = spawnSync(process.execPath, ["run", fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
		cwd: options.runtimeWorkspace,
		env: {
			...process.env,
			PI10_WORKSPACE_LAUNCHER_CHILD: "1",
			PI10_WORKSPACE_SESSION_FILE: selected.sessionFile,
		},
		stdio: "inherit",
	});
	if (child.error || child.status !== 0) throw new Error("Workspace fixture InteractiveMode child failed");

	const finalBytes = readFileSync(selected.sessionFile);
	const reopened = SessionManager.open(selected.sessionFile, options.sessionDir);
	const headerPreserved = finalBytes.equals(selected.originalBytes) && reopened.getHeader()?.cwd === selected.headerCwd;
	const branchPreserved =
		reopened.getLeafId() === selected.originalLeafId &&
		JSON.stringify(reopened.getBranch().map((entry) => entry.id)) === JSON.stringify(selected.originalBranchEntryIds);
	if (!headerPreserved || !branchPreserved) throw new Error("Workspace fixture modified the original session identity or branch");
	console.log("workspace_fixture_header_preserved=true workspace_fixture_branch_preserved=true");
}

const isMain = process.argv[1] && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
if (isMain) {
	const options = parseArgs(process.argv.slice(2));
	if (process.env.PI10_WORKSPACE_LAUNCHER_CHILD === "1") {
		const selected = selectSessionByHeaderId(options.sessionDir, options.sessionId);
		if (process.env.PI10_WORKSPACE_SESSION_FILE !== selected.sessionFile) {
			throw new Error("Workspace fixture child session identity changed");
		}
		await runInteractiveChild(options, selected);
	} else {
		await runLauncher(options);
	}
}
