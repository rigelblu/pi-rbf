import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
	FooterComponent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const STATUS_LINE_PATCHED_KEY = Symbol.for("rbf.statusLine.footerPatched");
export const ORIGINAL_STATUS_LINE_RENDER_KEY = Symbol.for("rbf.statusLine.originalFooterRender");

export type CommandRunner = (cmd: string, cwd: string) => string | null;

export interface StatusLineComponents {
	dirName: string;
	repoName?: string;
	treeLabel?: string;
	agentTree?: string;
	branch?: string;
	commit?: string;
	sessionName?: string;
}

export interface CachedStatusLine {
	cwd: string;
	sessionName?: string;
	line: string;
	timestamp: number;
}

const FALLBACK_THEME = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};

export function getActiveTheme(): any {
	return (
		(typeof globalThis !== "undefined"
			? (globalThis as any)[Symbol.for("@earendil-works/pi-coding-agent:theme")] ??
				(globalThis as any)[Symbol.for("@mariozechner/pi-coding-agent:theme")]
			: undefined) ?? FALLBACK_THEME
	);
}

export function defaultExec(cmd: string, cwd: string): string | null {
	try {
		const out = execSync(cmd, {
			cwd,
			encoding: "utf-8",
			timeout: 1000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out.trim();
	} catch {
		return null;
	}
}

export function formatStatusLine(components: StatusLineComponents): string {
	let status = `📁 ${components.dirName}`;

	if (components.repoName) {
		status += ` | 📦 ${components.repoName}`;
	}

	if (components.treeLabel) {
		status += ` | ${components.treeLabel}`;
	}

	if (components.agentTree) {
		status += ` | ${components.agentTree}`;
	}

	if (components.branch) {
		status += ` | 🏷️  ${components.branch}`;
	}

	if (components.commit) {
		status += ` @${components.commit}`;
	}

	if (components.sessionName) {
		status += ` • ${components.sessionName}`;
	}

	return status;
}

export function resolveJjWorkspace(
	wsListOutput: string | null,
	atChangeOutput: string | null,
	logAtForStale?: string | null,
	wsRootOutput?: string | null,
): { wsName: string; stale: boolean } | null {
	if (!wsListOutput) {
		return null;
	}

	const lines = wsListOutput
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length === 0) {
		return null;
	}

	let wsName = "";
	let stale = false;

	if (atChangeOutput && atChangeOutput.trim()) {
		const fullChange = atChangeOutput.trim();
		for (const line of lines) {
			const colonIdx = line.indexOf(":");
			if (colonIdx === -1) continue;
			const name = line.slice(0, colonIdx).trim();
			const rest = line.slice(colonIdx + 1).trim();
			const tokens = rest.split(/\s+/);
			for (const token of tokens) {
				if (token && fullChange.startsWith(token)) {
					wsName = name;
					break;
				}
			}
			if (wsName) break;
		}
	} else if (logAtForStale && /stale/i.test(logAtForStale)) {
		stale = true;
	}

	if (!wsName && lines.length > 1 && wsRootOutput) {
		wsName = basename(wsRootOutput.trim());
	}

	if (!wsName) {
		wsName = "default";
	}

	return { wsName, stale };
}

export function resolveAgentTree(
	agentStateFilePath: string,
	currentRoot: string | null,
	nowSec = Math.floor(Date.now() / 1000),
): string | null {
	try {
		if (!existsSync(agentStateFilePath)) {
			return null;
		}
		const content = readFileSync(agentStateFilePath, "utf-8").trim();
		if (!content) {
			return null;
		}
		const firstLine = content.split("\n")[0];
		const parts = firstLine.split("\t");
		if (parts.length < 3) {
			return null;
		}
		const [agentWs, rawRoot, atStr] = parts;
		const agentRoot = rawRoot.trim();
		const agentAt = parseInt(atStr.trim(), 10);
		if (isNaN(agentAt)) {
			return null;
		}

		// Ignore if older than 30 minutes (1800 seconds)
		if (nowSec - agentAt >= 1800) {
			return null;
		}

		// Ignore rb-drive stores (they get written constantly during normal work)
		if (
			agentRoot.includes("/rb-drive/") ||
			agentRoot.includes("/.rb-drive/") ||
			agentRoot.endsWith("/rb-drive") ||
			agentRoot.endsWith("/.rb-drive")
		) {
			return null;
		}

		// Compare workspace roots, not names
		if (currentRoot) {
			const normAgent = resolve(agentRoot);
			const normCurrent = resolve(currentRoot);
			if (normAgent === normCurrent) {
				return null;
			}
		}

		return `🌴 ${agentWs.trim()}`;
	} catch {
		return null;
	}
}

export function resolveStatusLineComponents(
	cwd: string,
	options?: {
		exec?: CommandRunner;
		agentStatePath?: string;
		sessionName?: string;
		nowSec?: number;
	},
): StatusLineComponents {
	const exec = options?.exec ?? defaultExec;
	const dirName = basename(cwd);
	let repoName: string | undefined;
	let treeLabel: string | undefined;
	let branch: string | undefined;
	let commit: string | undefined;
	let sessionRoot: string | null = null;

	const jjRoot = exec("jj root", cwd);
	if (jjRoot) {
		repoName = basename(jjRoot);
		sessionRoot = exec("jj workspace root", cwd) || jjRoot;

		const wsList = exec("jj workspace list --no-pager", cwd);
		const atChange = exec("jj log -r @ -T 'change_id' --no-pager --no-graph", cwd);
		const staleCheck = !atChange ? exec("jj log -r @ --no-pager --no-graph", cwd) : null;
		const wsInfo = resolveJjWorkspace(wsList, atChange, staleCheck, sessionRoot);

		if (wsInfo) {
			if (wsInfo.wsName === "default" && !wsInfo.stale) {
				treeLabel = " main";
			} else {
				treeLabel = ` wt:${wsInfo.wsName}${wsInfo.stale ? " ⚠stale" : ""}`;
			}
		}

		const rawBranch = exec(
			"jj log -r 'latest(ancestors(@) & bookmarks())' -T 'bookmarks' --no-pager --no-graph",
			cwd,
		);
		if (rawBranch) {
			const firstLine = rawBranch.split("\n")[0].trim();
			if (firstLine && firstLine !== "()") {
				branch = firstLine;
			}
		}

		const rawCommit = exec("jj log -r @- -T 'change_id.shortest()' --no-pager --no-graph", cwd);
		if (rawCommit) {
			const firstLine = rawCommit.split("\n")[0].trim();
			if (firstLine) {
				commit = firstLine;
			}
		}
	} else {
		// Fallback to git
		const gitRoot = exec("git rev-parse --show-toplevel", cwd);
		if (gitRoot) {
			repoName = basename(gitRoot);
			sessionRoot = gitRoot;

			const gitDir = exec("git rev-parse --absolute-git-dir", cwd);
			const commonDirRaw = exec("git rev-parse --git-common-dir", cwd);
			if (gitDir && commonDirRaw) {
				const commonDir = isAbsolute(commonDirRaw)
					? commonDirRaw
					: resolve(dirname(gitDir), commonDirRaw);
				if (resolve(gitDir) !== resolve(commonDir)) {
					treeLabel = ` wt:${repoName}`;
				} else {
					treeLabel = " main";
				}
			} else {
				treeLabel = " main";
			}

			const rawBranch = exec("git branch --show-current", cwd);
			if (rawBranch) {
				branch = rawBranch.split("\n")[0].trim();
			}

			const rawCommit = exec("git rev-parse --short HEAD", cwd);
			if (rawCommit) {
				commit = rawCommit.split("\n")[0].trim();
			}
		}
	}

	const agentStatePath =
		options?.agentStatePath ?? join(homedir(), ".claude", "agent_tree.state");
	const agentTree = resolveAgentTree(agentStatePath, sessionRoot, options?.nowSec) ?? undefined;

	return {
		dirName,
		repoName,
		treeLabel,
		agentTree,
		branch,
		commit,
		sessionName: options?.sessionName,
	};
}

export function formatFooterLineWithRightSide(
	leftLine: string,
	rightContent: string,
	width: number,
	theme?: { fg: (color: any, text: string) => string },
): string {
	if (!rightContent) {
		return truncateToWidth(leftLine, width, theme?.fg ? theme.fg("dim", "...") : "...");
	}

	const leftWidth = visibleWidth(leftLine);
	const rightWidth = visibleWidth(rightContent);
	const minPadding = 2;

	if (leftWidth + minPadding + rightWidth <= width) {
		const pad = " ".repeat(Math.max(minPadding, width - leftWidth - rightWidth));
		return leftLine + pad + rightContent;
	}

	const availableForLeft = width - rightWidth - minPadding;
	if (availableForLeft >= 8) {
		const ellipsis = theme?.fg ? theme.fg("dim", "...") : "...";
		const truncatedLeft = truncateToWidth(leftLine, availableForLeft, ellipsis);
		const pad = " ".repeat(Math.max(minPadding, width - visibleWidth(truncatedLeft) - rightWidth));
		return truncatedLeft + pad + rightContent;
	}

	if (width >= rightWidth) {
		return rightContent;
	}
	return truncateToWidth(rightContent, width, "");
}

export const STATUS_LINE_CACHE_KEY = Symbol.for("rbf.statusLine.cache");

export function getCachedStatusLine(): CachedStatusLine | null {
	return (globalThis as any)[STATUS_LINE_CACHE_KEY] ?? null;
}

export function setCachedStatusLine(cache: CachedStatusLine | null): void {
	if (cache === null) {
		delete (globalThis as any)[STATUS_LINE_CACHE_KEY];
	} else {
		(globalThis as any)[STATUS_LINE_CACHE_KEY] = cache;
	}
}

export function invalidateStatusLineCache(): void {
	delete (globalThis as any)[STATUS_LINE_CACHE_KEY];
}

// Last-message age (pi-43): `💬 <age>` at the left of Pi's token row.
export const AGE_STATE_GETTER_KEY = Symbol.for("rbf.statusLine.getAgeState");
export const AGE_WRAPPER_KEY = Symbol.for("rbf.statusLine.ageWrapper");
export const AGE_RESTART_WARNED_KEY = Symbol.for("rbf.statusLine.ageRestartWarned");
export const AGE_WRAPPER_VERSION = 1;
export const AGE_RESTART_WARNING = "Last msg needs a Pi restart to appear.";
const AGE_ICON = "💬";
const AGE_SEPARATOR = " | ";
const AGE_MIN_PADDING = 2;
const AGE_REDRAW_STATUS_KEY = "rbf-status-line-age-redraw";
const MINUTE_MS = 60_000;

/** Newest user timestamp from one source; `unknown` when any candidate cannot be ordered. */
export interface AgeMaximum {
	submittedAt?: number;
	unknown: boolean;
}

export type AgeSelection = { kind: "hidden" } | { kind: "unknown" } | { kind: "timed"; submittedAt: number };

export interface AgeCue {
	text: string;
	/** `timed` advances by the minute; `future` is `?` until the clock reaches the timestamp. */
	kind: "timed" | "unknown" | "future";
}

/** What the footer wrapper reads on every render; one per live extension instance. */
export interface AgeState {
	cue(now: number): AgeCue | undefined;
	report(cue: AgeCue | undefined, drawn: boolean, now: number): void;
}

export function formatLastMessageAge(submittedAt: number, now: number): string {
	const elapsed = now - submittedAt;
	if (!Number.isFinite(elapsed) || elapsed < 0) return "?";
	if (elapsed < MINUTE_MS) return "<1m";
	if (elapsed < 60 * MINUTE_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
	if (elapsed < 24 * 60 * MINUTE_MS) return `${Math.floor(elapsed / (60 * MINUTE_MS))}h`;
	return `${Math.floor(elapsed / (24 * 60 * MINUTE_MS))}d`;
}

export function raiseAgeMaximum(max: AgeMaximum, timestamp: unknown): AgeMaximum {
	if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp < 0) {
		return { ...max, unknown: true };
	}
	return { submittedAt: Math.max(max.submittedAt ?? timestamp, timestamp), unknown: max.unknown };
}

export function scanBranchAgeMaximum(entries: readonly any[]): AgeMaximum {
	let max: AgeMaximum = { unknown: false };
	for (const entry of entries) {
		if (entry?.type !== "message" || entry.message?.role !== "user") continue;
		max = raiseAgeMaximum(max, entry.message.timestamp);
	}
	return max;
}

export function selectAge(branch: AgeMaximum, delivered: AgeMaximum): AgeSelection {
	if (branch.unknown || delivered.unknown) return { kind: "unknown" };
	const at = Math.max(branch.submittedAt ?? -1, delivered.submittedAt ?? -1);
	return at < 0 ? { kind: "hidden" } : { kind: "timed", submittedAt: at };
}

export function ageCueFor(selection: AgeSelection, now: number): AgeCue | undefined {
	if (selection.kind === "hidden") return undefined;
	if (selection.kind === "unknown") return { text: `${AGE_ICON} ?`, kind: "unknown" };
	const age = formatLastMessageAge(selection.submittedAt, now);
	return { text: `${AGE_ICON} ${age}`, kind: age === "?" ? "future" : "timed" };
}

/**
 * Put the cue at the start of Pi's token row without changing the row's width: its cells
 * come out of the padding between the token numbers and the model name. Returns the row
 * untouched when that padding could not keep AGE_MIN_PADDING cells.
 */
export function prependAgeCue(row: string, cue: string): string {
	let pad: RegExpMatchArray | undefined;
	for (const run of row.matchAll(/ {2,}/g)) {
		if (!pad || run[0].length > pad[0].length) pad = run;
	}
	const need = visibleWidth(cue) + AGE_SEPARATOR.length;
	if (!pad || pad.index === undefined || pad[0].length - need < AGE_MIN_PADDING) return row;
	const style = row.match(/^(?:\x1b\[[0-9;]*m)*/)?.[0] ?? "";
	return (
		style +
		cue +
		AGE_SEPARATOR +
		row.slice(style.length, pad.index) +
		" ".repeat(pad[0].length - need) +
		row.slice(pad.index + pad[0].length)
	);
}

export function patchFooterComponent(): boolean {
	if (typeof FooterComponent === "undefined" || !FooterComponent.prototype) {
		return false;
	}
	(FooterComponent.prototype as any)[Symbol.for("rbf.statusLine.invalidateCache")] = invalidateStatusLineCache;

	if ((FooterComponent.prototype as any)[STATUS_LINE_PATCHED_KEY]) {
		return true;
	}

	const originalRender = FooterComponent.prototype.render;
	(FooterComponent.prototype as any)[ORIGINAL_STATUS_LINE_RENDER_KEY] = originalRender;
	(FooterComponent.prototype as any)[STATUS_LINE_PATCHED_KEY] = true;
	(FooterComponent.prototype as any)[AGE_WRAPPER_KEY] = AGE_WRAPPER_VERSION;

	FooterComponent.prototype.render = function (this: any, width: number): string[] {
		const lines = originalRender.call(this, width);
		if (!lines || lines.length === 0) {
			return lines;
		}

		const cwd = this.session?.sessionManager?.getCwd?.() ?? process.cwd();
		const sessionName = this.session?.sessionManager?.getSessionName?.();
		const now = Date.now();

		let statusText: string;
		const cached = getCachedStatusLine();
		if (
			cached &&
			cached.cwd === cwd &&
			cached.sessionName === sessionName &&
			now - cached.timestamp < 2000
		) {
			statusText = cached.line;
		} else {
			const components = resolveStatusLineComponents(cwd, { sessionName });
			statusText = formatStatusLine(components);
			setCachedStatusLine({
				cwd,
				sessionName,
				line: statusText,
				timestamp: now,
			});
		}

		const theme = this.session?.theme ?? getActiveTheme();
		const dimStatusLine = theme.fg("dim", statusText);

		// Check if right-aligned guardian content exists
		const getGuardian =
			(this as any)[Symbol.for("rbf.cacheGuardian.getActiveContent")] ??
			(FooterComponent.prototype as any)?.[Symbol.for("rbf.cacheGuardian.getActiveContent")];
		const guardianContent = typeof getGuardian === "function" ? getGuardian.call(this) : "";

		lines[0] = formatFooterLineWithRightSide(dimStatusLine, guardianContent, width, theme);

		const getAgeState = (FooterComponent.prototype as any)[AGE_STATE_GETTER_KEY];
		const ageState: AgeState | undefined = typeof getAgeState === "function" ? getAgeState() : undefined;
		if (ageState) {
			const cue = ageState.cue(now);
			let drawn = false;
			if (cue && lines.length > 1) {
				const row = prependAgeCue(lines[1], cue.text);
				drawn = row !== lines[1];
				lines[1] = row;
			}
			ageState.report(cue, drawn, now);
		}

		return lines;
	};

	return true;
}

export function unpatchFooterComponent(): void {
	if (typeof FooterComponent === "undefined" || !FooterComponent.prototype) {
		return;
	}
	invalidateStatusLineCache();
	if ((FooterComponent.prototype as any)[STATUS_LINE_PATCHED_KEY]) {
		const originalRender = (FooterComponent.prototype as any)[ORIGINAL_STATUS_LINE_RENDER_KEY];
		if (originalRender) {
			FooterComponent.prototype.render = originalRender;
		}
		delete (FooterComponent.prototype as any)[ORIGINAL_STATUS_LINE_RENDER_KEY];
		delete (FooterComponent.prototype as any)[STATUS_LINE_PATCHED_KEY];
		delete (FooterComponent.prototype as any)[Symbol.for("rbf.statusLine.invalidateCache")];
	}
	delete (FooterComponent.prototype as any)[AGE_WRAPPER_KEY];
	delete (FooterComponent.prototype as any)[AGE_RESTART_WARNED_KEY];
	delete (FooterComponent.prototype as any)[AGE_STATE_GETTER_KEY];
}

/**
 * Last-message age for one extension instance. Timing reads public delivery events and
 * saved history only. The timer is armed from the footer's own report, so a cue that is
 * hidden, unknown or never rendered holds no timer.
 */
function installLastMessageAge(pi: ExtensionAPI, legacyWrapper: boolean): void {
	const proto = FooterComponent.prototype as any;
	// RPC has a UI object but no footer; a redraw request there would reach the RPC client.
	const isTui = (ctx: ExtensionContext) => ctx.hasUI && ctx.mode === "tui";

	if (legacyWrapper) {
		// A wrapper from before this feature never reads the age slot; only a restart replaces it.
		pi.on("session_start", (_event, ctx) => {
			if (!isTui(ctx) || proto[AGE_RESTART_WARNED_KEY]) return;
			proto[AGE_RESTART_WARNED_KEY] = true;
			ctx.ui.notify(AGE_RESTART_WARNING, "warning");
		});
		return;
	}

	let branch: AgeMaximum = { unknown: false };
	let delivered: AgeMaximum = { unknown: false };
	let ui: ExtensionContext["ui"] | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let armedFor: number | undefined;
	let lastText: string | undefined;
	let live = true;

	const selection = (): AgeSelection => (ui ? selectAge(branch, delivered) : { kind: "hidden" });

	const stopTimer = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		armedFor = undefined;
	};

	const requestRedrawIfChanged = (): boolean => {
		const text = ageCueFor(selection(), Date.now())?.text;
		if (text === lastText) return false;
		lastText = text;
		try {
			ui?.setStatus(AGE_REDRAW_STATUS_KEY, undefined);
		} catch {
			lastText = undefined; // not drawn; the next tick or event asks again
		}
		return true;
	};

	const arm = (submittedAt: number, now: number) => {
		stopTimer();
		const elapsed = now - submittedAt;
		const delay = elapsed < 0 ? Math.min(MINUTE_MS, -elapsed) : MINUTE_MS - (elapsed % MINUTE_MS);
		armedFor = submittedAt;
		timer = setTimeout(() => {
			timer = undefined;
			armedFor = undefined;
			if (!live) return;
			// A changed label is redrawn, and that render re-arms. An unchanged one re-arms here.
			const current = selection();
			if (!requestRedrawIfChanged() && current.kind === "timed") arm(current.submittedAt, Date.now());
		}, delay);
		(timer as any).unref?.();
	};

	// The selected message can change without changing the label; keep a running timer on its minute.
	const selectionChanged = () => {
		const current = selection();
		if (!requestRedrawIfChanged() && timer && current.kind === "timed" && armedFor !== current.submittedAt) {
			arm(current.submittedAt, Date.now());
		}
	};

	const state: AgeState = {
		cue: (now) => (live ? ageCueFor(selection(), now) : undefined),
		report: (cue, drawn, now) => {
			if (!live) return;
			const current = selection();
			const wantsTimer = current.kind === "timed" && cue && (cue.kind === "future" || (cue.kind === "timed" && drawn));
			if (!wantsTimer) {
				stopTimer();
				return;
			}
			if (timer && armedFor === current.submittedAt) return;
			arm(current.submittedAt, now);
		},
	};
	proto[AGE_STATE_GETTER_KEY] = () => state;

	const rebuild = (ctx: ExtensionContext, keepDelivered: boolean) => {
		if (!live || !isTui(ctx)) return;
		ui = ctx.ui;
		try {
			branch = scanBranchAgeMaximum(ctx.sessionManager.getBranch());
		} catch {
			branch = { unknown: true };
		}
		if (!keepDelivered) delivered = { unknown: false };
		selectionChanged();
	};

	pi.on("session_start", (_event, ctx) => rebuild(ctx, false));
	pi.on("session_tree", (_event, ctx) => rebuild(ctx, false));
	pi.on("agent_settled", (_event, ctx) => rebuild(ctx, false));
	pi.on("session_compact", (_event, ctx) => rebuild(ctx, true));
	pi.on("message_start", (event, ctx) => {
		if (!live || !isTui(ctx) || event.message.role !== "user") return;
		ui = ctx.ui;
		delivered = raiseAgeMaximum(delivered, (event.message as any).timestamp);
		selectionChanged();
	});
	pi.on("session_shutdown", () => {
		live = false;
		stopTimer();
		ui = undefined;
		// A newer instance may already own the slot; never clear its state.
		if (proto[AGE_STATE_GETTER_KEY]?.() === state) delete proto[AGE_STATE_GETTER_KEY];
	});
}

export default function rbfStatusLine(pi: ExtensionAPI): void {
	const proto = typeof FooterComponent === "undefined" ? undefined : (FooterComponent.prototype as any);
	const legacyWrapper = Boolean(proto?.[STATUS_LINE_PATCHED_KEY]) && (proto[AGE_WRAPPER_KEY] ?? 0) < AGE_WRAPPER_VERSION;
	patchFooterComponent();
	invalidateStatusLineCache();

	const invalidate = () => {
		invalidateStatusLineCache();
	};

	pi.on("session_start", invalidate);
	pi.on("turn_start", invalidate);
	pi.on("turn_end", invalidate);
	pi.on("agent_settled", invalidate);
	pi.on("user_bash", invalidate);

	if (proto) installLastMessageAge(pi, legacyWrapper);
}
