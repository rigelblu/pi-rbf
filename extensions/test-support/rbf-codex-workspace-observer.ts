import { constants, closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const output = process.env.PI10_WORKSPACE_OBSERVER_OUTPUT;
if (!output || !path.isAbsolute(output)) throw new Error("PI10_WORKSPACE_OBSERVER_OUTPUT must be absolute");

function writeNew(suffix: string, value: unknown): void {
	const target = `${output}.${suffix}`;
	if (existsSync(target)) throw new Error(`Observer output already exists: ${suffix}`);
	mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
	const temporary = `${target}.tmp-${process.pid}`;
	const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
	try {
		writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	renameSync(temporary, target);
}

writeNew("loaded", { schema: "rbf-codex-workspace-observer-loaded/v1" });

export default function workspaceObserver(pi: ExtensionAPI): void {
	pi.on("session_start", (event, ctx) => {
		writeNew("session", {
			schema: "rbf-codex-workspace-observer/v1",
			eventReason: event.reason,
			sessionId: ctx.sessionManager.getSessionId(),
			header: ctx.sessionManager.getHeader(),
			leafId: ctx.sessionManager.getLeafId(),
			branchEntryIds: ctx.sessionManager.getBranch().map((entry) => entry.id),
			runtimeCwd: ctx.sessionManager.getCwd(),
			contextCwd: ctx.cwd,
			mode: ctx.mode,
			modelProvider: ctx.model?.provider ?? null,
			registeredTools: pi.getAllTools().map((tool) => tool.name),
		});
		setTimeout(() => ctx.shutdown(), 25);
	});
}
