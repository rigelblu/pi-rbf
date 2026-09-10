import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
	SandboxRuntimeConfigSchema,
	type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import { digestAuthority, type AuthorityDigestV1 } from "./authority-digest.js";

interface WorkspaceGrant {
	readonly environment?: readonly string[];
	readonly read?: readonly string[];
	readonly write?: readonly string[];
}

interface SandboxConfigV1 {
	readonly version: 1;
	readonly workspaces: Readonly<Record<string, WorkspaceGrant>>;
}

export interface EffectivePolicy {
	readonly authority: AuthorityDigestV1;
	readonly authorityDigest: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly srtConfig: SandboxRuntimeConfig;
}

const RUNTIME_ROOTS = ["/System", "/usr/bin", "/usr/lib", "/usr/libexec", "/usr/share", "/bin", "/sbin"];
const RESERVED_ENVIRONMENT = /^(?:PI_|DYLD_|LD_|GIT_|JJ_|SSH_|GPG_|AWS_|AZURE_|GOOGLE_|GCP_|OPENAI_|ANTHROPIC_|GITHUB_|GITLAB_|NPM_|PNPM_|BUN_|DOCKER_)|(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;

async function canonicalDirectory(candidate: string): Promise<string> {
	if (!path.isAbsolute(candidate)) throw new Error(`Sandbox root must be absolute: ${candidate}`);
	const canonical = await realpath(candidate);
	if (!(await stat(canonical)).isDirectory()) throw new Error(`Sandbox root must be a directory: ${candidate}`);
	return canonical;
}

async function readConfig(configPath: string): Promise<SandboxConfigV1 | undefined> {
	try {
		const metadata = await lstat(configPath);
		if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Sandbox config must be a regular file");
		if (metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) {
			throw new Error("Sandbox config must be owner-only");
		}
		const parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Sandbox config must be an object");
		const value = parsed as Record<string, unknown>;
		if (value.version !== 1 || !value.workspaces || typeof value.workspaces !== "object" || Array.isArray(value.workspaces)) {
			throw new Error("Sandbox config must contain version 1 workspaces");
		}
		if (Object.keys(value).some((key) => key !== "version" && key !== "workspaces")) throw new Error("Unknown sandbox config key");
		return parsed as SandboxConfigV1;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function safeEnvironment(authorityRoot: string): Record<string, string> {
	const value: Record<string, string> = {
		HOME: homedir(),
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		SHELL: "/bin/bash",
		TMPDIR: path.join(authorityRoot, "tmp"),
	};
	for (const name of ["USER", "LOGNAME", "LANG", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR"]) {
		if (process.env[name] !== undefined) value[name] = process.env[name];
	}
	return value;
}

export async function loadEffectivePolicy(options: {
	readonly admittedToolSourcesAndDigests?: Readonly<Record<string, string>>;
	readonly authorityRoot: string;
	readonly configPath?: string;
	readonly packageRoot?: string;
	readonly toolPaths?: readonly string[];
	readonly workspace: string;
}): Promise<EffectivePolicy> {
	const workspace = await canonicalDirectory(options.workspace);
	const authorityRoot = await canonicalDirectory(options.authorityRoot);
	const packageRoot = options.packageRoot ? await canonicalDirectory(options.packageRoot) : undefined;
	const toolPaths = [...new Set((await Promise.all((options.toolPaths ?? []).map(async (toolPath) => [toolPath, await realpath(toolPath, { encoding: "utf8" })]))).flat())].sort();
	await mkdir(path.join(authorityRoot, "tmp"), { recursive: true, mode: 0o700 });
	const config = await readConfig(options.configPath ?? path.join(homedir(), ".pi/agent/sandbox.json"));
	const grant = config?.workspaces[workspace] ?? {};
	if (grant.environment?.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || RESERVED_ENVIRONMENT.test(name))) {
		throw new Error("Sandbox environment grant is reserved or invalid");
	}
	const readRoots = [...new Set([workspace, ...(await Promise.all((grant.read ?? []).map(canonicalDirectory)))])].sort();
	const writeRoots = [...new Set([workspace, ...(await Promise.all((grant.write ?? []).map(canonicalDirectory)))])].sort();
	const environment = safeEnvironment(authorityRoot);
	for (const name of grant.environment ?? []) {
		if (process.env[name] !== undefined) environment[name] = process.env[name];
	}
	const srtConfig = SandboxRuntimeConfigSchema.parse({
		network: {
			allowedDomains: [],
			deniedDomains: [],
			strictAllowlist: true,
			allowUnixSockets: [],
			allowAllUnixSockets: false,
			allowLocalBinding: false,
			allowMachLookup: [],
		},
		filesystem: {
			disabled: false,
			denyRead: ["/"],
			allowRead: [...RUNTIME_ROOTS, process.execPath, ...toolPaths, authorityRoot, ...(packageRoot ? [packageRoot] : []), ...readRoots],
			allowWrite: [authorityRoot, ...writeRoots],
			denyWrite: [options.configPath ?? path.join(homedir(), ".pi/agent/sandbox.json"), ...(packageRoot ? [packageRoot] : [])],
			allowGitConfig: false,
		},
		allowPty: false,
		allowAppleEvents: false,
		enableWeakerNestedSandbox: false,
		enableWeakerNetworkIsolation: false,
	});
	const authority: AuthorityDigestV1 = {
		version: 1,
		workspace,
		readRoots,
		writeRoots,
		environmentNamesAndLaunchValues: environment,
		runtimeRoots: [...RUNTIME_ROOTS, ...toolPaths],
		protectedPaths: [options.configPath ?? path.join(homedir(), ".pi/agent/sandbox.json"), ...(packageRoot ? [packageRoot] : [])],
		admittedToolSourcesAndDigests: options.admittedToolSourcesAndDigests ?? {},
		versions: { node: process.versions.node, pi: "0.85.1", srt: "0.0.75" },
		srtConfig: srtConfig as unknown as Record<string, unknown>,
		authorityRoot,
	};
	return Object.freeze({ authority, authorityDigest: digestAuthority(authority), environment: Object.freeze(environment), srtConfig });
}
