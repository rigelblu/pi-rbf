import { accessSync, chmodSync, constants, mkdtempSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertPackageIntegrity, digestPackage } from "./integrity.js";
import { deriveLaunchAuthority } from "./launch-authority.js";
import {
	acquireLifecycleSentinel,
	beginActivation,
	beginReset,
	finishReset,
	markActive,
	markDirty,
	setAuthorityRoot,
} from "./lifecycle.js";
import { loadEffectivePolicy, type EffectivePolicy } from "./policy.js";
import { runLivePreflight } from "./preflight.js";
import { SandboxController, statusText } from "./state.js";
import { registerSandboxedTools } from "./tools.js";

const STATUS_KEY = "rbf-sandbox";
const TOOL_NAMES = ["bash", "read", "write", "edit", "grep", "find", "ls"] as const;
const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const packageDigest = digestPackage(packageRoot);
const launchAuthority = deriveLaunchAuthority(Object.freeze([...process.argv]));
const sentinel = acquireLifecycleSentinel({
	argvDigest: launchAuthority.argvDigest,
	packageIdentity: `${packageRoot}:${packageDigest}`,
	sandboxRequested: launchAuthority.sandboxRequested,
});
const controller = new SandboxController(launchAuthority.sandboxRequested);
let policy: EffectivePolicy | undefined;
const admittedToolSources = new Map<string, string>();

function resolveExecutable(name: string): string {
	for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!path.isAbsolute(directory)) continue;
		const candidate = path.join(directory, name);
		try {
			accessSync(candidate, constants.X_OK);
			return realpathSync(candidate);
		} catch {
			// Try the next absolute PATH entry.
		}
	}
	throw new Error(`Required sandbox tool is unavailable: ${name}`);
}

function toolSupportRoot(toolPath: string): string | undefined {
	const marker = `${path.sep}Cellar${path.sep}`;
	const index = toolPath.indexOf(marker);
	return index > 0 ? toolPath.slice(0, index) : undefined;
}

function auditToolRoutes(pi: ExtensionAPI): void {
	assertPackageIntegrity(packageRoot, packageDigest);
	const tools = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	for (const name of TOOL_NAMES) {
		const tool = tools.get(name);
		if (!tool) throw new Error(`Sandbox tool route is missing: ${name}`);
		const source = realpathSync(tool.sourceInfo.path);
		if (!source.startsWith(`${packageRoot}${path.sep}`) && source !== path.join(packageRoot, "index.ts")) {
			throw new Error(`Sandbox tool route was replaced: ${name}`);
		}
		const admitted = admittedToolSources.get(name);
		if (admitted && admitted !== source) throw new Error(`Sandbox tool source changed: ${name}`);
		admittedToolSources.set(name, source);
	}
}

function renderStatus(ctx: ExtensionContext): void {
	const snapshot = controller.snapshot;
	const color = snapshot.state === "failed" ? "error" : snapshot.state === "active" ? "success" : "warning";
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, statusText(snapshot)));
}

async function activate(pi: ExtensionAPI, ctx: ExtensionContext, requestedTools: readonly string[]): Promise<void> {
	if (!sentinel) throw new Error("Sandbox lifecycle sentinel is unavailable");
	if (ctx.mode !== "tui") throw new Error("Sandbox v1 supports interactive TUI mode only");
	if (!ctx.model || ctx.modelRegistry.getRegisteredProviderIds().includes(ctx.model.provider)) {
		throw new Error("Sandbox requires a Pi built-in provider");
	}
	const rgPath = resolveExecutable("rg");
	const fdPath = resolveExecutable("fd");
	const authorityRoot = sentinel.authorityRoot ?? mkdtempSync(`/private/tmp/rbf-sandbox-${process.getuid?.() ?? 0}-${process.pid}-`);
	chmodSync(authorityRoot, 0o700);
	setAuthorityRoot(sentinel, authorityRoot);
	const supportRoots = [toolSupportRoot(rgPath), toolSupportRoot(fdPath)].filter((value): value is string => Boolean(value));
	policy = await loadEffectivePolicy({
		workspace: ctx.cwd,
		authorityRoot,
		packageRoot,
		toolPaths: [rgPath, fdPath, ...supportRoots],
		admittedToolSourcesAndDigests: { package: packageDigest },
	});
	beginActivation(sentinel, policy.authorityDigest);
	const dependencies = await SandboxManager.checkDependenciesAsync({ command: rgPath });
	if (dependencies.errors.length > 0) throw new Error(dependencies.errors.join("; "));
	await SandboxManager.initialize(policy.srtConfig, undefined, false);
	await runLivePreflight({ brokerPath: path.join(packageRoot, "broker.mjs"), policy, workspace: policy.authority.workspace });
	registerSandboxedTools(pi, {
		brokerPath: path.join(packageRoot, "broker.mjs"),
		fdPath,
		policy,
		rgPath,
		workspace: policy.authority.workspace,
	});
	auditToolRoutes(pi);
	const active = requestedTools.filter((name): name is (typeof TOOL_NAMES)[number] => TOOL_NAMES.includes(name as (typeof TOOL_NAMES)[number]));
	pi.setActiveTools(active);
	markActive(sentinel);
	controller.activate();
	renderStatus(ctx);
}

export default function rbfSandbox(pi: ExtensionAPI): void {
	pi.registerFlag("sandbox", {
		type: "boolean",
		description: "Confine agent-issued host-affecting tools",
	});
	pi.registerCommand("sandbox", {
		description: "Show agent-tool sandbox status",
		handler: async (_args, ctx) => {
			const snapshot = controller.snapshot;
			const suffix = snapshot.reason ? `\nreason: ${snapshot.reason}` : policy ? `\nworkspace: ${policy.authority.workspace}\npolicy: ${policy.authorityDigest}` : "";
			ctx.ui.notify(`${statusText(snapshot)}${suffix}`, snapshot.state === "failed" ? "error" : "info");
		},
	});
	pi.on("tool_call", async (event, ctx) => {
		if (controller.blocksHostAffectingTools()) {
			return { block: true, reason: "Sandbox tools are blocked until enforcement is active" };
		}
		if (!launchAuthority.sandboxRequested) return undefined;
		if (!TOOL_NAMES.includes(event.toolName as (typeof TOOL_NAMES)[number])) {
			return { block: true, reason: `Tool is unavailable in sandbox mode: ${event.toolName}` };
		}
		try {
			auditToolRoutes(pi);
			return undefined;
		} catch (error) {
			controller.fail(error instanceof Error ? error.message : "Sandbox route integrity failed");
			if (sentinel) markDirty(sentinel);
			pi.setActiveTools([]);
			renderStatus(ctx);
			return { block: true, reason: "Sandbox route integrity failed; restart Pi" };
		}
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!launchAuthority.sandboxRequested || controller.snapshot.state !== "active") return undefined;
		try {
			if (!ctx.model || ctx.modelRegistry.getRegisteredProviderIds().includes(ctx.model.provider)) {
				throw new Error("Sandbox requires a Pi built-in provider");
			}
			auditToolRoutes(pi);
			return undefined;
		} catch (error) {
			controller.fail(error instanceof Error ? error.message : "Sandbox route integrity failed");
			if (sentinel) markDirty(sentinel);
			pi.setActiveTools([]);
			renderStatus(ctx);
			ctx.shutdown();
			return undefined;
		}
	});
	pi.on("session_start", async (_event, ctx) => {
		if (!launchAuthority.sandboxRequested) {
			renderStatus(ctx);
			return;
		}
		const requestedTools = pi.getActiveTools();
		pi.setActiveTools([]);
		renderStatus(ctx);
		try {
			await activate(pi, ctx, requestedTools);
		} catch (error) {
			if (sentinel) markDirty(sentinel);
			controller.fail(error instanceof Error ? error.message : "Sandbox activation failed");
			pi.setActiveTools([]);
			renderStatus(ctx);
		}
	});
	pi.on("session_shutdown", async () => {
		if (!sentinel || sentinel.state !== "active") return;
		try {
			beginReset(sentinel);
			await SandboxManager.reset();
			finishReset(sentinel);
		} catch {
			markDirty(sentinel);
		}
	});
}
