import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { getShellConfig, FooterComponent } from "@earendil-works/pi-coding-agent";
import {
	Text,
	visibleWidth,
	truncateToWidth,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { appendFileSync, chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export const MONITOR_TOOL_NAME = "monitor";
export const TASK_STOP_TOOL_NAME = "task_stop";
export const MONITORS_COMMAND_NAME = "monitors";
export const SESSION_CUSTOM_TYPE = "rbf-monitor";

const DEFAULT_DEADLINE_MS = 300_000;
const MIN_DEADLINE_MS = 1_000;
const MAX_DEADLINE_MS = 3_600_000;
const BATCH_WINDOW_MS = 200;
const MAX_RUNNING_WATCHES = 5;
const MAX_EVENT_LINES = 20;
const MAX_EVENT_CHARS = 4_000;
const MAX_PARTIAL_CHARS = 4_000;
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const PROMPT_HOLD_MS = 15_000;
const LOG_BASE_DIR = "/tmp/pi-monitors";

const FOOTER_PI_RBF_REGISTRY_KEY = Symbol.for("@earendil-works/pi-rbf:footer-registry");
const WATCHES_GLOBAL_KEY = Symbol.for("rbf.monitor.watches.v1");

type EndReason = "task_stop" | "user_stop" | "deadline" | "flood" | "exit" | "shutdown";

interface Watch {
	id: string;
	description: string;
	command: string;
	cwd: string;
	timeoutMs: number;
	armedAt: number;
	deadlineAt: number;
	child: ChildProcess;
	pid: number;
	state: "running" | "ended";
	handed: number;
	sentTimes: number[];
	batch: string[];
	partial: string;
	decoder: TextDecoder;
	errDecoder: TextDecoder;
	stderrTail: string[];
	errPartial: string;
	batchTimer?: NodeJS.Timeout;
	deadlineTimer: NodeJS.Timeout;
	logPath: string;
	logBytes: number;
}

const FALLBACK_THEME = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
};

export function getActiveTheme(): any {
	return (
		(typeof globalThis !== "undefined"
			? (globalThis as any)[Symbol.for("@earendil-works/pi-coding-agent:theme")] ??
				(globalThis as any)[Symbol.for("@mariozechner/pi-coding-agent:theme")]
			: undefined) ?? FALLBACK_THEME
	);
}

interface Outgoing {
	seq: string;
	kind: "event" | "deadline" | "flood" | "exit" | "user_stop" | "restart";
	content: string;
	details: Record<string, any>;
	covers: { id: string; armedAt: number; reason: EndReason }[];
}

function stripAnsi(value: string): string {
	if (typeof value !== "string") return value;
	if (!value.includes("\u001B") && !value.includes("\u009B")) return value;
	const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
	const osc = `(?:\\u001B\\][\\s\\S]*?${ST})`;
	const csi = "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";
	const pattern = `${osc}|${csi}`;
	return value.replace(new RegExp(pattern, "g"), "");
}

function cleanLine(raw: string): string {
	const stripped = stripAnsi(raw);
	let out = "";
	for (const char of stripped) {
		const code = char.codePointAt(0);
		if (code === undefined) continue;
		if (code === 0x09) {
			out += char;
			continue;
		}
		if (code <= 0x1f) continue;
		if (code >= 0xfff9 && code <= 0xfffb) continue;
		out += char;
	}
	return out;
}

function killProcessTree(pid: number): void {
	if (!pid || pid <= 1) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}

function terminateProcessTree(pid: number, gracefulTimeoutMs = 500): Promise<void> {
	return new Promise((resolve) => {
		if (!pid || pid <= 1) {
			resolve();
			return;
		}
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			try {
				process.kill(pid, "SIGTERM");
			} catch {}
		}
		const timer = setTimeout(() => {
			try {
				killProcessTree(pid);
			} catch {}
			resolve();
		}, gracefulTimeoutMs);
		if (typeof timer.unref === "function") timer.unref();
	});
}

function formatDeadlineDuration(timeoutMs: number): string {
	if (timeoutMs % 60000 === 0) {
		const mins = timeoutMs / 60000;
		return `${mins}-minute`;
	}
	const secs = Math.round(timeoutMs / 1000);
	return `${secs}-second`;
}

function fallbackDescription(command: unknown, description: unknown): string {
	if (typeof description === "string" && description.trim().length > 0) {
		return description.trim();
	}
	if (typeof command === "string") {
		const trimmed = command.trim();
		const firstLine = trimmed.split("\n")[0] ?? "";
		return firstLine.slice(0, 40);
	}
	return "";
}

function formatTimeRemaining(ms: number): string {
	if (ms <= 0) return "0s";
	const s = Math.ceil(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.ceil(s / 60);
	return `${m}m`;
}

function formatTimeElapsed(ms: number): string {
	const s = Math.floor(Math.max(0, ms) / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m`;
}

function formatEventsWord(events: number): string {
	return `${events} event${events === 1 ? "" : "s"}`;
}

function capEvent(batch: string[]): { lines: string[]; omitted: number } {
	const lines: string[] = [];
	let chars = 0;
	let i = 0;
	for (; i < batch.length; i++) {
		if (lines.length >= MAX_EVENT_LINES || chars >= MAX_EVENT_CHARS) break;
		let line = batch[i]!;
		if (chars + line.length > MAX_EVENT_CHARS) {
			line = line.slice(0, Math.max(0, MAX_EVENT_CHARS - chars));
			lines.push(line);
			chars += line.length;
			i++;
			break;
		}
		lines.push(line);
		chars += line.length;
	}
	const omitted = Math.max(0, batch.length - i);
	return { lines, omitted };
}

function formatEventText(description: string, id: string, lines: string[], omitted: number): string {
	let text = `Monitor event from "${description}" (task ${id}):\n${lines.join("\n")}`;
	if (omitted > 0) {
		text += `\n(${omitted} more lines not shown)`;
	}
	return text;
}

export interface RenderLine {
	text: string;
	role?: "error" | "muted" | "default";
}

export interface RenderBlock {
	header?: string;
	headerRest?: string;
	headerTool?: string;
	linesUnder: Array<string | RenderLine>;
}

export class MonitorMessageComponent {
	constructor(
		private blocks: Array<{ header?: string; headerRest?: string; headerTool?: string; linesUnder: Array<string | RenderLine> }>,
		private pad: number = 1,
		private theme?: any,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const out: string[] = [];
		const headerPrefix = " ".repeat(this.pad);
		const theme = this.theme;

		for (let b = 0; b < this.blocks.length; b++) {
			if (b > 0) {
				out.push("");
			}
			const block = this.blocks[b]!;
			let toolName = block.headerTool ?? "monitor";
			let headerRest = block.headerRest ?? "";
			if (!block.headerRest && typeof block.header === "string") {
				if (block.header.startsWith("monitor ")) {
					toolName = "monitor";
					headerRest = block.header.slice(8);
				} else if (block.header === "monitor") {
					toolName = "monitor";
					headerRest = "";
				} else {
					toolName = "";
					headerRest = block.header;
				}
			}

			const rawHeader = toolName ? (headerRest ? `${toolName} ${headerRest}` : toolName) : headerRest;

			let styledHeader = rawHeader;
			if (theme?.fg && toolName) {
				const styledTool = theme.bold ? theme.bold(toolName) : toolName;
				const toolPart = theme.fg("toolTitle", styledTool);
				styledHeader = headerRest ? `${toolPart} ${theme.fg("muted", headerRest)}` : toolPart;
			} else if (theme?.fg && headerRest) {
				styledHeader = theme.fg("muted", headerRest);
			}

			if (width < 20) {
				out.push(...this.wrap(rawHeader, width));
				for (const item of block.linesUnder) {
					const lineText = typeof item === "string" ? item : item.text;
					out.push(...this.wrap(lineText, width));
				}
			} else {
				out.push(truncateToWidth(headerPrefix + styledHeader, width, ""));
				let isFirst = true;
				const contentWidth = width - 4;
				const branchChar = theme?.fg ? theme.fg("dim", "└") : "└";
				for (const item of block.linesUnder) {
					const lineText = typeof item === "string" ? item : item.text;
					const lineRole = typeof item === "string" ? undefined : item.role;
					const chunks = this.wrap(lineText, contentWidth);
					for (const chunk of chunks) {
						const styledChunk = lineRole && theme?.fg ? theme.fg(lineRole, chunk) : chunk;
						if (isFirst) {
							out.push(` ${branchChar}  ${styledChunk}`);
							isFirst = false;
						} else {
							out.push(`    ${styledChunk}`);
						}
					}
				}
			}
		}
		return out.map((r) => truncateToWidth(r, width, ""));
	}

	private wrap(text: string, maxWidth: number): string[] {
		if (text.length === 0) return [""];
		const chunks: string[] = [];
		let remaining = text;
		while (remaining.length > 0) {
			if (visibleWidth(remaining) <= maxWidth) {
				chunks.push(remaining);
				break;
			}
			let take = maxWidth;
			while (take > 0 && visibleWidth(remaining.slice(0, take)) > maxWidth) {
				take--;
			}
			if (take === 0) take = 1;
			chunks.push(remaining.slice(0, take));
			remaining = remaining.slice(take);
		}
		return chunks;
	}
}

export interface FooterExtensionHook {
	id: string;
	render: (this: any, lines: string[], width: number) => string[];
	handleMouse: (this: any, event: TuiMouseEvent) => TuiMouseEventResult | undefined;
}

export interface FooterRegistry {
	hooks: Map<string, FooterExtensionHook>;
	originalRender: (width: number) => string[];
	originalHandleMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
	isHandlingMouse?: boolean;
	installedRender?: (this: any, width: number) => string[];
	installedHandleMouse?: (this: any, event: TuiMouseEvent) => TuiMouseEventResult | undefined;
}

function getOrCreateFooterRegistry(): FooterRegistry | null {
	if (typeof FooterComponent === "undefined" || !FooterComponent.prototype) {
		return null;
	}
	let registry: FooterRegistry = (FooterComponent.prototype as any)[FOOTER_PI_RBF_REGISTRY_KEY];
	if (!registry) {
		const originalRender = FooterComponent.prototype.render;
		const originalHandleMouse = (FooterComponent.prototype as any).handleMouse;

		const installedRender = function (this: any, width: number): string[] {
			let lines = registry.originalRender.call(this, width);
			for (const hook of registry.hooks.values()) {
				try {
					lines = hook.render.call(this, lines, width);
				} catch {}
			}
			return lines;
		};

		const installedHandleMouse = function (
			this: any,
			event: TuiMouseEvent,
		): TuiMouseEventResult | undefined {
			if (registry.isHandlingMouse) {
				return undefined;
			}
			registry.isHandlingMouse = true;
			try {
				const origResult = registry.originalHandleMouse
					? registry.originalHandleMouse.call(this, event)
					: undefined;
				if (origResult?.handled) {
					return origResult;
				}
				for (const hook of registry.hooks.values()) {
					try {
						const result = hook.handleMouse.call(this, event);
						if (result?.handled) {
							return result;
						}
					} catch {}
				}
				return origResult;
			} finally {
				registry.isHandlingMouse = false;
			}
		};

		registry = {
			hooks: new Map(),
			originalRender,
			originalHandleMouse,
			isHandlingMouse: false,
			installedRender,
			installedHandleMouse,
		};
		(FooterComponent.prototype as any)[FOOTER_PI_RBF_REGISTRY_KEY] = registry;
		FooterComponent.prototype.render = installedRender;
		(FooterComponent.prototype as any).handleMouse = installedHandleMouse;
	}
	return registry;
}

function unpatchFooterComponent(): void {
	if (typeof FooterComponent === "undefined" || !FooterComponent.prototype) {
		return;
	}
	const registry: FooterRegistry | undefined = (FooterComponent.prototype as any)[FOOTER_PI_RBF_REGISTRY_KEY];
	if (registry) {
		registry.hooks.delete("monitor");
		if (registry.hooks.size === 0) {
			const currentRender = FooterComponent.prototype.render;
			const currentHandleMouse = (FooterComponent.prototype as any).handleMouse;
			const canRestore =
				typeof registry.installedRender === "function" &&
				typeof registry.installedHandleMouse === "function" &&
				currentRender === registry.installedRender &&
				currentHandleMouse === registry.installedHandleMouse;

			if (canRestore) {
				FooterComponent.prototype.render = registry.originalRender;
				if (registry.originalHandleMouse) {
					(FooterComponent.prototype as any).handleMouse = registry.originalHandleMouse;
				} else {
					delete (FooterComponent.prototype as any).handleMouse;
				}
				delete (FooterComponent.prototype as any)[FOOTER_PI_RBF_REGISTRY_KEY];
			}
		}
	}
}

export default function rbfMonitor(pi: ExtensionAPI): void {
	const watches = new Map<string, Watch>();
	let held: Outgoing[] = [];
	const owed = new Map<string, Outgoing>();

	let runActive = false;
	let promptHold = false;
	let holdLeft = PROMPT_HOLD_MS;
	let holdSince = 0;
	let holdClockRunning = false;
	let holdTimer: NodeJS.Timeout | undefined;
	let releaseTimer: NodeJS.Timeout | null = null;
	let lastCtx: any = undefined;

	// Watches whose command has been spawned but hasn't reported `spawn` yet, id to description.
	// Pi runs a message's tool calls in parallel, so the five-watch limit counts these too.
	const starting = new Map<string, string>();
	// Counts session shutdowns, so a command that reports `spawn` after one is killed, not registered.
	let shutdowns = 0;

	let seqCounter = 0;
	const runtimeStartMs = Date.now();
	function seqOrder(seq: string): number {
		return Number(seq.slice(seq.lastIndexOf(":") + 1)) || 0;
	}
	/** Oldest first. A seq read back from the session record may come from an earlier runtime, so that part is compared first. */
	function bySeq(a: Outgoing, b: Outgoing): number {
		return (Number(a.seq.slice(0, a.seq.lastIndexOf(":"))) || 0) - (Number(b.seq.slice(0, b.seq.lastIndexOf(":"))) || 0) || seqOrder(a.seq) - seqOrder(b.seq);
	}
	function nextSeq(): string {
		return `${runtimeStartMs}:${++seqCounter}`;
	}

	function requestFooterRender(ctx?: any) {
		const targetUi = ctx?.ui ?? lastCtx?.ui;
		if (targetUi && typeof targetUi.requestRender === "function") {
			targetUi.requestRender();
		}
	}

	function killLeftovers() {
		const oldWatches = (globalThis as any)[WATCHES_GLOBAL_KEY];
		if (oldWatches instanceof Map && oldWatches !== watches) {
			for (const w of oldWatches.values()) {
				if (w && typeof w.pid === "number") {
					killProcessTree(w.pid);
				}
			}
		}
		(globalThis as any)[WATCHES_GLOBAL_KEY] = watches;
	}

	function installFooterHook() {
		const registry = getOrCreateFooterRegistry();
		if (!registry) return;
		registry.hooks.set("monitor", {
			id: "monitor",
			render(lines: string[], width: number) {
				if (watches.size === 0 || lines.length < 2) return lines;
				const count = watches.size;
				const badgeText = count === 1 ? "1 watch" : `${count} watches`;
				const statsLine = lines[1] ?? "";
				const theme = (this as any)?.session?.theme ?? (lastCtx?.ui as any)?.getTheme?.() ?? getActiveTheme();
				const bullet = theme?.fg ? theme.fg("dim", "· ") : "· ";
				const styledBadgeText = theme?.fg ? theme.fg("accent", badgeText) : badgeText;
				const styledBadge = ` ${bullet}${styledBadgeText}`;

				const padMatch = statsLine.match(/^(.*?)(\s{2,})(.*)$/);
				if (!padMatch) {
					lines[1] = `${statsLine}${styledBadge}`;
					return lines;
				}
				const left = padMatch[1]!;
				const right = padMatch[3]!;
				const newLeft = `${left}${styledBadge}`;
				const newLeftWidth = visibleWidth(newLeft);
				const rightWidth = visibleWidth(right);
				const minPadding = 2;

				if (newLeftWidth + minPadding + rightWidth <= width) {
					const pad = " ".repeat(width - newLeftWidth - rightWidth);
					lines[1] = newLeft + pad + right;
				} else {
					const availableForRight = width - newLeftWidth - minPadding;
					if (availableForRight > 0) {
						const truncatedRight = truncateToWidth(right, availableForRight, "");
						const pad = " ".repeat(width - newLeftWidth - visibleWidth(truncatedRight));
						lines[1] = newLeft + pad + truncatedRight;
					} else {
						lines[1] = truncateToWidth(newLeft, width, "");
					}
				}
				return lines;
			},
			handleMouse: () => undefined,
		});
	}

	function canTake(): "steer" | "wake" | "nothing" {
		if (runActive) return "steer";
		if (lastCtx?.isIdle?.() && !promptHold) return "wake";
		return "nothing";
	}

	function logError(err: unknown, watch?: Watch): void {
		try {
			const text = `${String(err instanceof Error ? (err.message || err) : err)}\n`;
			if (watch) {
				appendLog(watch, text);
			} else {
				const sessionId = lastCtx?.sessionManager?.getSessionId?.() ?? "default";
				const logDir = join(LOG_BASE_DIR, `session-${sessionId}`);
				fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
				fs.appendFileSync(join(logDir, "monitor.log"), text, { mode: 0o600 });
			}
		} catch {}
	}

	function oneMessage(all: Outgoing[]): any {
		if (all.length === 1) {
			const item = all[0]!;
			return {
				customType: SESSION_CUSTOM_TYPE,
				content: item.content,
				display: true,
				details: {
					...item.details,
					seqs: [item.seq],
				},
			};
		}
		return {
			customType: SESSION_CUSTOM_TYPE,
			content: all.map((i) => i.content).join("\n\n"),
			display: true,
			details: {
				kind: "catch_up",
				seqs: all.map((i) => i.seq),
				parts: all.map((i) => ({ ...i.details, seqs: [i.seq] })),
			},
		};
	}

	function send(message: any): void {
		pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
	}

	function give(items: Outgoing[], take: "steer" | "wake"): void {
		if (take === "wake") {
			// Oldest first: a notice owed after an event was held must not overtake it.
			const all = [...owed.values(), ...items].sort(bySeq);
			for (const item of items) {
				owed.set(item.seq, item);
			}
			send(oneMessage(all));
		} else {
			for (const item of items) {
				owed.set(item.seq, item);
				send(oneMessage([item]));
			}
		}
	}

	function scheduleRelease(ms: number): void {
		if (releaseTimer) {
			clearTimeout(releaseTimer);
			releaseTimer = null;
		}
		releaseTimer = setTimeout(() => {
			releaseTimer = null;
			release();
		}, ms);
		if (typeof (releaseTimer as any)?.unref === "function") (releaseTimer as any).unref();
	}

	function release(): void {
		try {
			if (held.length === 0) return;
			const take = canTake();
			if (take === "nothing") {
				scheduleRelease(25);
				return;
			}
			const items = held;
			held = [];
			give(items, take);
		} catch (err) {
			logError(err);
		}
	}

	function handOff(item: Outgoing): void {
		const take = canTake();
		if (take === "nothing") {
			held.push(item);
			scheduleRelease(25);
			return;
		}
		if (held.length > 0) {
			const items = [...held, item];
			held = [];
			give(items, take);
		} else {
			give([item], take);
		}
	}

	function startHoldClock(): void {
		if (!promptHold || holdClockRunning) return;
		holdClockRunning = true;
		holdSince = Date.now();
		if (holdTimer) clearTimeout(holdTimer);
		holdTimer = setTimeout(endPromptHold, holdLeft);
		if (typeof (holdTimer as any)?.unref === "function") (holdTimer as any).unref();
	}

	function stopHoldClock(): void {
		if (!holdClockRunning) return;
		holdClockRunning = false;
		if (holdTimer) clearTimeout(holdTimer);
		holdTimer = undefined;
		holdLeft = Math.max(0, holdLeft - (Date.now() - holdSince));
	}

	function endPromptHold(): void {
		try {
			if (!promptHold) return;
			promptHold = false;
			holdClockRunning = false;
			if (holdTimer) clearTimeout(holdTimer);
			holdTimer = undefined;
			scheduleRelease(0);
		} catch (err) {
			logError(err);
		}
	}

	function noticeContent(
		reason: EndReason,
		desc: string,
		id: string,
		events: number,
		timeoutMs?: number,
		exitInfo?: {
			exitCode?: number | null;
			signal?: string | null;
			stderrTail?: string[];
			logPath?: string;
			eventPrefix?: string;
		},
	): string {
		if (reason === "deadline") {
			return `Monitor "${desc}" (task ${id}) reached its ${formatDeadlineDuration(timeoutMs ?? 300000)} deadline and stopped after ${formatEventsWord(events)}. Re-arm it if you still need the watch.`;
		}
		if (reason === "user_stop") {
			return `Monitor "${desc}" (task ${id}) was stopped by Tomek from /monitors after ${formatEventsWord(events)}. Ask him before you re-arm it.`;
		}
		if (reason === "flood") {
			return `Monitor "${desc}" (task ${id}) was stopped after ${formatEventsWord(events)}: more than 10 arrived within 60 seconds. Tighten the filter so it prints only lines you would act on, then re-arm.`;
		}
		if (reason === "exit") {
			const prefix = exitInfo?.eventPrefix ?? "";
			let line = "";
			if (exitInfo?.exitCode === 0) {
				line = `${prefix}Monitor "${desc}" (task ${id}) ended: its command exited with code 0 after ${formatEventsWord(events)}.`;
			} else if (exitInfo?.signal) {
				line = `${prefix}Monitor "${desc}" (task ${id}) ended: its command was killed by ${exitInfo.signal} after ${formatEventsWord(events)}.`;
			} else {
				line = `${prefix}Monitor "${desc}" (task ${id}) ended: its command exited with code ${exitInfo?.exitCode ?? 1} after ${formatEventsWord(events)}.`;
			}
			if (exitInfo?.exitCode !== 0 || exitInfo?.signal) {
				if (exitInfo?.stderrTail && exitInfo.stderrTail.length > 0) {
					line += `\nLast stderr lines:\n${exitInfo.stderrTail.join("\n")}\nLog: ${exitInfo.logPath}`;
				} else {
					line += `\nIt printed nothing to stderr.\nLog: ${exitInfo?.logPath}`;
				}
			}
			return line;
		}
		return "";
	}

	function buildNotice(
		watch: Watch,
		reason: EndReason,
		extra?: {
			lastLines?: { lines: string[]; omitted: number };
			exitCode?: number | null;
			signal?: string | null;
		},
	): Outgoing {
		const events = watch.handed;
		const id = watch.id;
		const desc = watch.description;
		let eventPrefix = "";
		if (extra?.lastLines && extra.lastLines.lines.length > 0) {
			eventPrefix = formatEventText(desc, id, extra.lastLines.lines, extra.lastLines.omitted) + "\n";
		}
		const content = noticeContent(reason, desc, id, events, watch.timeoutMs, {
			exitCode: extra?.exitCode,
			signal: extra?.signal,
			stderrTail: watch.stderrTail,
			logPath: watch.logPath,
			eventPrefix,
		});

		const details: Record<string, any> = {
			kind: reason,
			taskId: id,
			armedAt: watch.armedAt,
			description: desc,
			events,
		};
		if (extra?.lastLines?.lines) {
			details.lines = extra.lastLines.lines;
			details.omitted = extra.lastLines.omitted;
		}
		if (reason === "deadline") {
			details.timeoutMs = watch.timeoutMs;
		}
		if (reason === "exit") {
			if (extra?.exitCode !== undefined) details.exitCode = extra.exitCode;
			if (extra?.signal !== undefined) details.signal = extra.signal;
			if (extra?.exitCode !== 0 || extra?.signal) {
				details.stderrTail = watch.stderrTail;
				details.logPath = watch.logPath;
			}
		}

		return {
			seq: nextSeq(),
			kind: reason as any,
			content,
			details,
			covers: [{ id, armedAt: watch.armedAt, reason }],
		};
	}

	function endWatch(
		watch: Watch,
		reason: EndReason,
		extra?: { exitCode?: number | null; signal?: string | null },
	): void {
		if (watch.state !== "running") return;
		watch.state = "ended";
		if (watch.batchTimer) {
			clearTimeout(watch.batchTimer);
			watch.batchTimer = undefined;
		}
		clearTimeout(watch.deadlineTimer);

		if (reason === "shutdown") {
			killProcessTree(watch.pid);
		} else {
			terminateProcessTree(watch.pid);
		}
		watches.delete(watch.id);

		if (reason === "shutdown") {
			return;
		}

		let lastLines: { lines: string[]; omitted: number } | undefined;
		if (reason === "exit") {
			lastLines = capEvent(watch.batch);
			if (lastLines.lines.length > 0) {
				watch.handed += 1;
			}
		}

		let notice: Outgoing | undefined;
		if (reason !== "task_stop") {
			notice = buildNotice(watch, reason, {
				lastLines,
				exitCode: extra?.exitCode,
				signal: extra?.signal,
			});
		}

		try {
			pi.appendEntry(SESSION_CUSTOM_TYPE, {
				kind: "ended",
				id: watch.id,
				armedAt: watch.armedAt,
				reason,
				events: watch.handed,
				...(extra?.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
				...(extra?.signal !== undefined ? { signal: extra.signal } : {}),
				at: Date.now(),
				...(notice ? { notice: notice.details } : {}),
			});
		} catch (e) {
			logError(e, watch);
		}

		requestFooterRender();

		if (reason === "task_stop") {
			// tool result is the answer
		} else if (reason === "user_stop") {
			if (notice) {
				if (runActive) {
					handOff(notice);
				} else {
					owed.set(notice.seq, notice);
				}
			}
		} else {
			if (notice) {
				handOff(notice);
			}
		}
	}

	function takeLines(watch: Watch, text: string): string[] {
		const combined = watch.partial + text;
		const split = combined.split("\n");
		let partial = split.pop() ?? "";
		if (partial.length > MAX_PARTIAL_CHARS) {
			partial = partial.slice(0, MAX_PARTIAL_CHARS);
		}
		watch.partial = partial;

		const lines: string[] = [];
		for (const raw of split) {
			const cleaned = cleanLine(raw);
			if (cleaned.trim().length > 0) {
				lines.push(cleaned);
			}
		}
		return lines;
	}

	function takeStderrLines(watch: Watch, text: string): string[] {
		const combined = watch.errPartial + text;
		const split = combined.split("\n");
		let partial = split.pop() ?? "";
		if (partial.length > MAX_PARTIAL_CHARS) {
			partial = partial.slice(0, MAX_PARTIAL_CHARS);
		}
		watch.errPartial = partial;

		const lines: string[] = [];
		for (const raw of split) {
			const cleaned = cleanLine(raw);
			if (cleaned.trim().length > 0) {
				lines.push(cleaned);
			}
		}
		return lines;
	}

	function keepStderrTail(watch: Watch, text: string): void {
		const lines = takeStderrLines(watch, text);
		for (const cleaned of lines) {
			watch.stderrTail.push(cleaned);
		}
		const newest = watch.stderrTail.slice(-5);
		const kept: string[] = [];
		let totalChars = 0;
		for (let i = newest.length - 1; i >= 0; i--) {
			if (totalChars >= 400) {
				break;
			}
			const line = newest[i]!;
			kept.unshift(line);
			totalChars += line.length;
		}
		watch.stderrTail = kept;
	}

	function appendLog(watch: Watch, chunk: Buffer | Uint8Array | string): void {
		try {
			if (watch.logBytes >= MAX_LOG_BYTES) return;
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			const isFirst = watch.logBytes === 0 && !existsSync(watch.logPath);
			if (watch.logBytes + buf.length > MAX_LOG_BYTES) {
				const allowed = MAX_LOG_BYTES - watch.logBytes;
				if (allowed > 0) {
					fs.appendFileSync(watch.logPath, buf.subarray(0, allowed), { mode: 0o600 });
				}
				fs.appendFileSync(watch.logPath, Buffer.from("\n[Log truncated at 10 MB]\n"), { mode: 0o600 });
				watch.logBytes = MAX_LOG_BYTES + 1;
				if (isFirst) {
					try { chmodSync(watch.logPath, 0o600); } catch {}
				}
				return;
			}
			fs.appendFileSync(watch.logPath, buf, { mode: 0o600 });
			if (isFirst) {
				try { chmodSync(watch.logPath, 0o600); } catch {}
			}
			watch.logBytes += buf.length;
		} catch {}
	}

	function flushBatch(watch: Watch): void {
		try {
			if (watch.state !== "running") return;
			watch.batchTimer = undefined;
			const { lines, omitted } = capEvent(watch.batch);
			watch.batch = [];
			if (lines.length === 0) return;

			const now = Date.now();
			watch.sentTimes = watch.sentTimes.filter((t) => now - t <= 60000);
			if (watch.sentTimes.length >= 10) {
				endWatch(watch, "flood");
				return;
			}
			watch.sentTimes.push(now);
			watch.handed += 1;

			const item: Outgoing = {
				seq: nextSeq(),
				kind: "event",
				content: formatEventText(watch.description, watch.id, lines, omitted),
				details: {
					kind: "event",
					taskId: watch.id,
					armedAt: watch.armedAt,
					description: watch.description,
					lines,
					omitted,
					events: watch.handed,
				},
				covers: [],
			};
			handOff(item);
		} catch (e) {
			logError(e, watch);
		}
	}

	function addOwedFromRecord(branch: any[]): void {
		const isCovered = (id: string, armedAt: number) => {
			for (const item of owed.values()) {
				if (item.covers.some((c) => c.id === id && c.armedAt === armedAt)) return true;
			}
			for (const item of held) {
				if (item.covers.some((c) => c.id === id && c.armedAt === armedAt)) return true;
			}
			return false;
		};

		const entries = (Array.isArray(branch) ? branch : []).filter(
			(e: any) => e && e.customType === SESSION_CUSTOM_TYPE,
		);
		const announcedSet = new Set<string>();
		for (const e of entries) {
			if (e.data?.kind === "announced" && e.data?.id && e.data?.armedAt) {
				announcedSet.add(`${e.data.id}:${e.data.armedAt}`);
			}
		}
		for (const [seq, item] of owed.entries()) {
			if (item.covers.length > 0 && item.covers.every((c) => announcedSet.has(`${c.id}:${c.armedAt}`))) {
				owed.delete(seq);
			}
		}

		for (const e of entries) {
			if (e.data?.kind === "ended" && e.data?.reason !== "task_stop") {
				const { id, armedAt, reason, notice, events, exitCode, signal } = e.data;
				if (!id || !armedAt) continue;
				if (announcedSet.has(`${id}:${armedAt}`)) continue;
				if (isCovered(id, armedAt)) continue;

				const dEvents = notice?.events ?? events ?? 0;
				const armedEntry = branch.find(
					(entry: any) =>
						entry.customType === SESSION_CUSTOM_TYPE &&
						entry.data?.kind === "armed" &&
						entry.data?.id === id &&
						(entry.data?.at === armedAt || !armedAt),
				);
				const desc = notice?.description ?? armedEntry?.data?.description ?? "watch";
				const timeoutMs = notice?.timeoutMs ?? armedEntry?.data?.timeoutMs ?? 300_000;
				const content = noticeContent(reason, desc, id, dEvents, timeoutMs, {
					exitCode,
					signal,
					stderrTail: notice?.stderrTail,
					logPath: notice?.logPath,
				});

				const item: Outgoing = {
					seq: nextSeq(),
					kind: reason as any,
					content,
					details: notice ?? {
						kind: reason,
						taskId: id,
						armedAt,
						description: desc,
						events: dEvents,
					},
					covers: [{ id, armedAt, reason }],
				};
				owed.set(item.seq, item);
			}
		}

		const endedSet = new Set<string>();
		for (const e of entries) {
			if (e.data?.kind === "ended" && e.data?.id && e.data?.armedAt) {
				endedSet.add(`${e.data.id}:${e.data.armedAt}`);
			}
		}

		const orphans: Array<{ id: string; armedAt: number; description: string }> = [];
		for (const e of entries) {
			if (e.data?.kind === "armed") {
				const { id, at, description } = e.data;
				const armedAt = at;
				if (!id || !armedAt) continue;
				if (endedSet.has(`${id}:${armedAt}`) || announcedSet.has(`${id}:${armedAt}`)) continue;
				if (watches.has(id)) continue;
				if (isCovered(id, armedAt)) continue;
				orphans.push({ id, armedAt, description: description ?? "unknown" });
			}
		}

		if (orphans.length > 0) {
			const orphansList = orphans.map((o) => `"${o.description}" (task ${o.id})`).join(", ");
			const restartText = `These watches stopped when Pi restarted its runtime and were not re-armed: ${orphansList}. Re-arm any you still need.`;
			const restartItem: Outgoing = {
				seq: nextSeq(),
				kind: "restart",
				content: restartText,
				details: {
					kind: "restart",
					watches: orphans.map((o) => ({ taskId: o.id, description: o.description })),
				},
				covers: orphans.map((o) => ({ id: o.id, armedAt: o.armedAt, reason: "shutdown" as const })),
			};
			owed.set(restartItem.seq, restartItem);
		}
	}

	// ─── Register Tools ──────────────────────────────────────────────────────

	if (typeof pi.registerTool === "function") {
		pi.registerTool({
			name: MONITOR_TOOL_NAME,
			label: "Monitor",
			description:
				`Pi's Monitor: the tool Tomek's skills call "Monitor". Start a watch: run a shell command in the background and receive each line it prints to stdout as a message. Returns a task id once the command has started.

A line that arrives after your turn has ended starts a new turn for you. A line that arrives while you work reaches you after the running tool call.

- Use monitor when you want one notification per occurrence: a new chat message, a matching log line, a file that changes
- For a single notification, use a command that exits, for example \`until <check>; do sleep 5; done; echo ready\`. You are told when it exits
- Print only lines you would act on. Every line can start a model turn
- Filter for failure lines too, not only success lines. Silence is not success
- Flush each pipe stage per line or lines sit in a buffer: \`grep --line-buffered\`, awk \`fflush()\`
- Only stdout lines are events. Stderr goes to a log file. Lines printed within 200 ms arrive as one message
- If the command fails, the notice shows its last stderr lines and the log file's path
- timeout_ms is the deadline: 300000 (5 minutes) by default, 3600000 (1 hour) at most. At the deadline the watch stops and you get one notice. Re-arm it if you still need it
- A watch that sends more than 10 events in 60 seconds is stopped. At most 5 watches run at once
- A watch stops when Pi exits, reloads, or changes session. It is not re-armed for you. You are told with the next prompt
- Stop a watch with task_stop and its task id
- ws is not supported in Pi. Use command`,
			parameters: Type.Object({
				command: Type.String({
					description: "Shell command. Each line it prints to stdout is an event. When it exits, the watch ends",
				}),
				description: Type.String({
					description: "Short label shown in every event and every row",
				}),
				timeout_ms: Type.Optional(
					Type.Number({
						description: "Deadline. Default 300000. Above 3600000 it's capped at 3600000. Below 1000 it's raised to 1000",
					}),
				),
				ws: Type.Optional(Type.Any()),
			}),
			renderCall: (args: any, theme: Theme) => {
				const desc = fallbackDescription(args?.command, args?.description);
				return new Text(theme.fg("toolTitle", theme.bold("monitor ")) + theme.fg("muted", desc), 0, 0);
			},
			renderResult: (result: any, options: any, theme: Theme) => {
				if (result?.details?.taskId) {
					const deadlineAt =
						typeof result.details.deadlineAt === "number"
							? result.details.deadlineAt
							: (typeof result.details.armedAt === "number" && typeof result.details.timeoutMs === "number"
								? result.details.armedAt + result.details.timeoutMs
								: undefined);
					const timeRemainingMs =
						deadlineAt !== undefined
							? Math.max(0, deadlineAt - Date.now())
							: (result.details.timeoutMs ?? DEFAULT_DEADLINE_MS);
					const timeStr = formatTimeRemaining(timeRemainingMs);
					let branchText = `Watching · stops in ${timeStr} · task ${result.details.taskId}`;
					if (options?.expanded && result.details.command) {
						branchText += `\n${result.details.command}`;
					}
					return new Text(theme.fg("muted", branchText), 0, 0);
				}
				const text = result.content?.[0]?.text || "";
				return new Text(theme.fg("muted", text), 0, 0);
			},
			execute: async (_toolCallId, args, _signal, _onUpdate, ctx) => {
				if (ctx) lastCtx = ctx;

				if ("ws" in args && args.ws !== undefined) {
					throw new Error(
						"monitor in Pi doesn't support ws. Pass command instead: a shell command that prints one line per event.",
					);
				}
				if (!args.command || !args.command.trim()) {
					throw new Error(
						"monitor needs a command: a shell command that prints one line per event.",
					);
				}
				let timeoutMs = DEFAULT_DEADLINE_MS;
				let capped = false;
				let raised = false;
				if (typeof args.timeout_ms === "number" && !isNaN(args.timeout_ms)) {
					if (args.timeout_ms < MIN_DEADLINE_MS) {
						timeoutMs = MIN_DEADLINE_MS;
						raised = true;
					} else if (args.timeout_ms > MAX_DEADLINE_MS) {
						timeoutMs = MAX_DEADLINE_MS;
						capped = true;
					} else {
						timeoutMs = args.timeout_ms;
					}
				}

				const command = args.command.trim();
				const description = fallbackDescription(args.command, args.description);

				let id = "";
				for (;;) {
					const hex = Math.floor(Math.random() * 0x10000)
						.toString(16)
						.padStart(4, "0");
					const candidate = `mon-${hex}`;
					if (!watches.has(candidate) && !starting.has(candidate)) {
						id = candidate;
						break;
					}
				}

				if (watches.size + starting.size >= MAX_RUNNING_WATCHES) {
					const runningList = [
						...[...watches.values()].map((w) => `"${w.description}" (task ${w.id})`),
						...[...starting.entries()].map(([startingId, d]) => `"${d}" (task ${startingId})`),
					].join(", ");
					throw new Error(
						`monitor can't arm a sixth watch. Five are running: ${runningList}. Stop one with task_stop first.`,
					);
				}
				starting.set(id, description);
				const shutdownsAtStart = shutdowns;
				try {

				const armedAt = Date.now();
				const deadlineAt = armedAt + timeoutMs;
				const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "default";
				const logDir = join(LOG_BASE_DIR, `session-${sessionId}`);
				try {
					mkdirSync(logDir, { recursive: true, mode: 0o700 });
					chmodSync(logDir, 0o700);
				} catch {}
				const logPath = join(logDir, `${id}-${armedAt}.log`);

				const shellConfig =
					typeof getShellConfig === "function"
						? getShellConfig()
						: { shell: process.env.SHELL || "bash", args: ["-c"] };

				let child: ChildProcess;
				try {
					child = spawn(shellConfig.shell, [...shellConfig.args, command], {
						cwd: ctx?.cwd || process.cwd(),
						detached: true,
						env: process.env,
						stdio: ["ignore", "pipe", "pipe"],
					});
				} catch (err: any) {
					throw new Error(`monitor couldn't start the command: ${err.message}.`);
				}

				const watch: Watch = {
					id,
					description,
					command,
					cwd: ctx?.cwd || process.cwd(),
					timeoutMs,
					armedAt,
					deadlineAt,
					child,
					pid: child.pid ?? 0,
					state: "running",
					handed: 0,
					sentTimes: [],
					batch: [],
					partial: "",
					decoder: new TextDecoder("utf-8", { fatal: false }),
					errDecoder: new TextDecoder("utf-8", { fatal: false }),
					stderrTail: [],
					errPartial: "",
					deadlineTimer: undefined as any,
					logPath,
					logBytes: 0,
				};

				let started = false;
				child.stdout?.on("data", (chunk) => {
					onStdout(watch, chunk);
				});
				child.stderr?.on("data", (chunk) => {
					onStderr(watch, chunk);
				});
				child.on("close", (code, signal) => {
					if (started) {
						onClose(watch, code, signal);
					}
				});

				await new Promise<void>((resolve, reject) => {
					let settled = false;
					const onSpawn = () => {
						try {
							if (settled) return;
							settled = true;
							child.off("error", onError);
							child.on("error", (err: any) => {
								try {
									if (watch.state === "running") {
										appendLog(watch, `Error: ${err?.message ?? err}`);
										endWatch(watch, "exit", {
											exitCode: typeof err?.code === "number" ? err.code : null,
											signal: typeof err?.signal === "string" ? err.signal : null,
										});
									}
								} catch (e) {
									logError(e, watch);
								}
							});
							started = true;
							resolve();
						} catch (e) {
							logError(e, watch);
							reject(e);
						}
					};
					const onError = (err: Error) => {
						try {
							if (settled) return;
							settled = true;
							child.off("spawn", onSpawn);
							reject(err);
						} catch (e) {
							logError(e);
							reject(err);
						}
					};
					child.once("spawn", onSpawn);
					child.once("error", onError);
				}).catch((err) => {
					try {
						if (existsSync(logPath)) rmSync(logPath);
					} catch (e) {
						logError(e);
					}
					throw new Error(`monitor couldn't start the command: ${err.message}.`);
				});

				if (shutdowns !== shutdownsAtStart) {
					started = false;
					killProcessTree(child.pid ?? 0);
					try {
						if (existsSync(logPath)) rmSync(logPath);
					} catch (e) {
						logError(e);
					}
					throw new Error("monitor didn't start the command: the session ended first.");
				}

				try {
					watch.deadlineTimer = setTimeout(() => {
						try {
							endWatch(watch, "deadline");
						} catch (e) {
							logError(e, watch);
						}
					}, timeoutMs);
					if (typeof watch.deadlineTimer.unref === "function") watch.deadlineTimer.unref();

					watches.set(id, watch);
					pi.appendEntry(SESSION_CUSTOM_TYPE, {
						kind: "armed",
						id,
						at: armedAt,
						description,
						command,
						timeoutMs,
					});

					requestFooterRender(ctx);
				} catch (err: any) {
					logError(err, watch);
					if (watch.deadlineTimer) {
						clearTimeout(watch.deadlineTimer);
						watch.deadlineTimer = undefined as any;
					}
					watches.delete(id);
					watch.state = "ended";
					if (watch.pid) {
						terminateProcessTree(watch.pid);
					}
					try {
						if (existsSync(logPath)) rmSync(logPath);
					} catch (e) {
						logError(e);
					}
					throw new Error(`monitor couldn't start the command: ${err?.message ?? err}.`);
				}

				const stopsInStr =
					timeoutMs % 60000 === 0
						? `${timeoutMs / 60000} minute${timeoutMs / 60000 === 1 ? "" : "s"}`
						: `${Math.round(timeoutMs / 1000)} second${Math.round(timeoutMs / 1000) === 1 ? "" : "s"}`;

				let resultText = `Watching "${description}" as task ${id}. Each line the command prints arrives as a message. It stops in ${stopsInStr}, or when you call task_stop with task_id "${id}".`;
				if (capped) {
					resultText += " timeout_ms was capped at 3600000.";
				} else if (raised) {
					resultText += " timeout_ms was raised to 1000.";
				}

				return {
					content: [{ type: "text", text: resultText }],
					details: {
						taskId: id,
						description,
						command,
						timeoutMs,
						armedAt,
						deadlineAt,
					},
				};
				} finally {
					starting.delete(id);
				}
			},
		});
	}

	if (typeof pi.registerTool === "function") {
		pi.registerTool({
			name: TASK_STOP_TOOL_NAME,
			label: "TaskStop",
			description:
				`Pi's TaskStop: the tool Tomek's skills call "TaskStop". Stop a watch that monitor started. Pass the task id monitor returned. Returns whether a watch was stopped. In this version it stops watches only.`,
			parameters: Type.Object({
				task_id: Type.String({
					description: "The id monitor returned",
				}),
			}),
			renderCall: (args: any, theme: Theme) => {
				return new Text(theme.fg("toolTitle", theme.bold("task_stop ")) + theme.fg("muted", args.task_id || ""), 0, 0);
			},
			renderResult: (result: any, _options: any, theme: Theme) => {
				const text = result.details?.branchText ?? result.content?.[0]?.text ?? "";
				return new Text(theme.fg("muted", text), 0, 0);
			},
			execute: async (_toolCallId, args, _signal, _onUpdate, ctx) => {
				if (ctx) lastCtx = ctx;
				const taskId = args.task_id;
				const watch = watches.get(taskId);
				if (!watch) {
					if (watches.size === 0) {
						return {
							content: [
								{
									type: "text",
									text: `No running watch has task id "${taskId}". No watches are running.`,
								},
							],
							details: {},
						};
					}
					const runningList = [...watches.values()]
						.map((w) => `"${w.description}" (task ${w.id})`)
						.join(", ");
					return {
						content: [
							{
								type: "text",
								text: `No running watch has task id "${taskId}". Running: ${runningList}.`,
							},
						],
						details: {},
					};
				}
				const events = watch.handed;
				const desc = watch.description;
				const id = watch.id;
				endWatch(watch, "task_stop");
				return {
					content: [
						{
							type: "text",
							text: `Stopped "${desc}" (task ${id}) after ${formatEventsWord(events)}.`,
						},
					],
					details: {
						branchText: `Stopped "${desc}" after ${formatEventsWord(events)}`,
					},
				};
			},
		});
	}

	// ─── Register Command `/monitors` ────────────────────────────────────────

	if (typeof pi.registerCommand === "function") {
		pi.registerCommand(MONITORS_COMMAND_NAME, {
			description: "List and stop watches",
			handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
				lastCtx = ctx;
				const trimmed = args.trim();
				if (trimmed === "") {
					if (watches.size === 0) {
						ctx.ui?.notify?.("No watches running.", "info");
						return;
					}
					const now = Date.now();
					const lines = [...watches.values()].map((w) => {
						const runningTime = formatTimeElapsed(now - w.armedAt);
						const stopsInTime = formatTimeRemaining(Math.max(0, w.deadlineAt - now));
						return `${w.id} · ${w.description} · running ${runningTime} · ${formatEventsWord(w.handed)} · stops in ${stopsInTime}`;
					});
					lines.push("/monitors stop <id> · /monitors stop all");
					ctx.ui?.notify?.(lines.join("\n"), "info");
					return;
				}
				if (trimmed === "stop all") {
					if (watches.size === 0) {
						ctx.ui?.notify?.("No watches running.", "info");
						return;
					}
					const count = watches.size;
					for (const w of [...watches.values()]) {
						endWatch(w, "user_stop");
					}
					ctx.ui?.notify?.(`Stopped ${count} watch${count === 1 ? "" : "es"}.`, "info");
					return;
				}
				if (trimmed.startsWith("stop ")) {
					if (watches.size === 0) {
						ctx.ui?.notify?.("No watches running.", "info");
						return;
					}
					const targetId = trimmed.slice(5).trim();
					const w = watches.get(targetId);
					if (w) {
						endWatch(w, "user_stop");
						ctx.ui?.notify?.(`Stopped ${targetId} · ${w.description}`, "info");
					} else {
						ctx.ui?.notify?.(`No running watch with id ${targetId}. Run /monitors to list them.`, "info");
					}
					return;
				}
				ctx.ui?.notify?.("Usage: /monitors · /monitors stop <id> · /monitors stop all", "info");
			},
		});
	}

	// ─── Register Message Renderer ───────────────────────────────────────────

	if (typeof pi.registerMessageRenderer === "function") {
		pi.registerMessageRenderer(SESSION_CUSTOM_TYPE, (message, options, theme) => {
			const details = message.details as Record<string, any> | undefined;
			const content = typeof message.content === "string" ? message.content : "";
			const pad = options?.outputPad ?? 1;

			if (!details || typeof details !== "object") {
				return new MonitorMessageComponent([{ header: "monitor", linesUnder: [content] }], pad, theme);
			}

			const parts: any[] =
				details.kind === "catch_up" && Array.isArray(details.parts)
					? details.parts
					: [details];

			const blocks: RenderBlock[] = [];
			for (const part of parts) {
				let header = "";
				const linesUnder: Array<string | RenderLine> = [];

				const desc = part.description ?? "watch";
				if (part.kind === "event") {
					header = `monitor event · ${desc}`;
					if (Array.isArray(part.lines)) {
						linesUnder.push(...part.lines);
					}
					if (part.omitted) {
						linesUnder.push(`(${part.omitted} more lines not shown)`);
					}
				} else if (part.kind === "deadline" || part.kind === "user_stop" || part.kind === "flood") {
					header = `monitor stopped · ${desc}`;
					if (part.kind === "deadline") {
						const dStr = part.timeoutMs ? formatDeadlineDuration(part.timeoutMs) : "";
						linesUnder.push(
							dStr
								? `Reached its ${dStr} deadline after ${formatEventsWord(part.events ?? 0)}`
								: `Reached its deadline after ${formatEventsWord(part.events ?? 0)}`,
						);
					} else if (part.kind === "user_stop") {
						linesUnder.push(`Stopped from /monitors after ${formatEventsWord(part.events ?? 0)}`);
					} else if (part.kind === "flood") {
						linesUnder.push({
							text: "More than 10 events in 60 seconds. The filter is too loose",
							role: "error",
						});
					}
				} else if (part.kind === "exit") {
					header = `monitor ended · ${desc}`;
					if (Array.isArray(part.lines)) {
						linesUnder.push(...part.lines);
					}
					if (part.exitCode === 0) {
						linesUnder.push(`Command exited with code 0 after ${formatEventsWord(part.events ?? 0)}`);
					} else if (part.signal) {
						linesUnder.push({
							text: `Command was killed by ${part.signal} after ${formatEventsWord(part.events ?? 0)}`,
							role: "error",
						});
						if (Array.isArray(part.stderrTail) && part.stderrTail.length > 0) {
							for (const line of part.stderrTail) {
								linesUnder.push({ text: line, role: "muted" });
							}
						}
						if (part.logPath) linesUnder.push({ text: `Log: ${part.logPath}`, role: "muted" });
					} else {
						linesUnder.push({
							text: `Command exited with code ${part.exitCode ?? 1} after ${formatEventsWord(part.events ?? 0)}`,
							role: "error",
						});
						if (Array.isArray(part.stderrTail) && part.stderrTail.length > 0) {
							for (const line of part.stderrTail) {
								linesUnder.push({ text: line, role: "muted" });
							}
						}
						if (part.logPath) linesUnder.push({ text: `Log: ${part.logPath}`, role: "muted" });
					}
				} else if (part.kind === "restart") {
					const count = Array.isArray(part.watches) ? part.watches.length : 1;
					const headerDesc = count === 1 ? (part.watches?.[0]?.description ?? "watch") : `${count} watches`;
					header = `monitor stopped · ${headerDesc}`;
					linesUnder.push("Pi restarted its runtime. Not re-armed:");
					if (Array.isArray(part.watches)) {
						for (const w of part.watches) {
							linesUnder.push(`${w.description} (task ${w.taskId})`);
						}
					}
				} else {
					header = `monitor · ${desc}`;
					linesUnder.push(content);
				}

				blocks.push({ header, linesUnder });
			}

			return new MonitorMessageComponent(blocks, pad, theme);
		});
	}

	// ─── Event Handlers ──────────────────────────────────────────────────────

	function onStdout(watch: Watch, chunk: Buffer | Uint8Array | string) {
		try {
			appendLog(watch, chunk);
			const text = watch.decoder.decode(typeof chunk === "string" ? Buffer.from(chunk) : chunk, {
				stream: true,
			});
			const lines = takeLines(watch, text);
			for (const line of lines) {
				watch.batch.push(line);
				if (!watch.batchTimer) {
					watch.batchTimer = setTimeout(() => {
						flushBatch(watch);
					}, BATCH_WINDOW_MS);
					if (typeof (watch.batchTimer as any)?.unref === "function") {
						(watch.batchTimer as any).unref();
					}
				}
			}
		} catch (e) {
			logError(e, watch);
		}
	}

	function onStderr(watch: Watch, chunk: Buffer | Uint8Array | string) {
		try {
			appendLog(watch, chunk);
			const text = watch.errDecoder.decode(typeof chunk === "string" ? Buffer.from(chunk) : chunk, {
				stream: true,
			});
			keepStderrTail(watch, text);
		} catch (e) {
			logError(e, watch);
		}
	}

	function onClose(watch: Watch, code: number | null, signal: string | null) {
		try {
			if (watch.state !== "running") return;
			if (watch.partial.trim().length > 0) {
				const cleaned = cleanLine(watch.partial);
				if (cleaned.trim().length > 0) {
					watch.batch.push(cleaned);
				}
				watch.partial = "";
			}
			if (watch.errPartial.length > 0) {
				keepStderrTail(watch, "\n");
				watch.errPartial = "";
			}
			endWatch(watch, "exit", { exitCode: code, signal });
		} catch (e) {
			logError(e, watch);
		}
	}

	pi.on?.("message_end", async (event: any) => {
		try {
			const msg = event?.message;
			if (!msg || msg.role !== "custom" || msg.customType !== SESSION_CUSTOM_TYPE) return;
			const seqs = msg.details?.seqs;
			if (!Array.isArray(seqs)) return;
			for (const seq of seqs) {
				const item = owed.get(seq);
				if (!item) continue;
				owed.delete(seq);
				for (const cover of item.covers) {
					pi.appendEntry(SESSION_CUSTOM_TYPE, {
						kind: "announced",
						id: cover.id,
						armedAt: cover.armedAt,
						reason: cover.reason,
						at: Date.now(),
					});
				}
			}
		} catch (err) {
			logError(err);
		}
	});

	pi.on?.("input", async (_event: any, ctx: any) => {
		try {
			if (ctx) lastCtx = ctx;
			if (!ctx?.isIdle?.()) return;
			promptHold = true;
			holdLeft = PROMPT_HOLD_MS;
			startHoldClock();
		} catch (err) {
			logError(err);
		}
	});

	pi.on?.("session_before_compact", async (_event: any, ctx: any) => {
		try {
			if (ctx) lastCtx = ctx;
			stopHoldClock();
		} catch (err) {
			logError(err);
		}
	});

	pi.on?.("session_compact", async (_event: any, ctx: any) => {
		try {
			if (ctx) lastCtx = ctx;
			startHoldClock();
		} catch (err) {
			logError(err);
		}
	});

	pi.on?.("session_compact_failed", async (event: any, ctx: any) => {
		try {
			if (ctx) lastCtx = ctx;
			startHoldClock();
			if (event?.aborted) {
				if (releaseTimer) {
					clearTimeout(releaseTimer);
					releaseTimer = null;
				}
				for (const item of held) {
					owed.set(item.seq, item);
				}
				held = [];
			}
		} catch (err) {
			logError(err);
		}
	});

	pi.on?.("agent_start", async (_event: any, ctx: any) => {
		try {
			if (ctx) lastCtx = ctx;
			runActive = true;
			endPromptHold();
			scheduleRelease(0);
		} catch (err) {
			logError(err);
		}
	});

	pi.on?.("agent_end", async (_event: any, ctx: any) => {
		try {
			if (ctx) lastCtx = ctx;
			runActive = false;
		} catch (err) {
			logError(err);
		}
	});

	pi.on?.("before_agent_start", async (_event: any, ctx: any) => {
		try {
			if (ctx) lastCtx = ctx;
			addOwedFromRecord(ctx?.sessionManager?.getBranch?.() ?? []);
			if (owed.size === 0) return undefined;
			// What's held would follow as a steer once the run starts, after a notice that may be newer. It goes in this message.
			for (const item of held) {
				owed.set(item.seq, item);
			}
			held = [];
			return { message: oneMessage([...owed.values()].sort(bySeq)) };
		} catch (err) {
			logError(err);
			return undefined;
		}
	});

	pi.on?.("session_start", async (_event: any, ctx: any) => {
		try {
			if (ctx) lastCtx = ctx;
			killLeftovers();
			installFooterHook();
		} catch (err) {
			logError(err);
		}
	});

	pi.on?.("session_shutdown", async (_event: any, ctx: any) => {
		try {
			if (ctx) lastCtx = ctx;
			shutdowns++;
			for (const w of [...watches.values()]) {
				endWatch(w, "shutdown");
			}
			if (holdTimer) {
				clearTimeout(holdTimer);
				holdTimer = undefined;
			}
			if (releaseTimer) {
				clearTimeout(releaseTimer);
				releaseTimer = null;
			}
			promptHold = false;
			holdClockRunning = false;
			held = [];
			owed.clear();
			unpatchFooterComponent();
			if (typeof unsubBusy === "function") {
				unsubBusy();
			}
		} catch (err) {
			logError(err);
		}
	});

	const unsubBusy = pi.events?.on?.("rbf-background-tasks:busy/v1", (busy: any) => {
		try {
			if (watches.size > 0 && busy && typeof busy === "object") {
				busy.watch = true;
			}
		} catch (err) {
			logError(err);
		}
	});

	killLeftovers();
	installFooterHook();
}
