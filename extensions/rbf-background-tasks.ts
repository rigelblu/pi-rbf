import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	BashExecutionComponent,
	createBashToolDefinition,
	FooterComponent,
	getShellConfig,
	keyText,
	ToolExecutionComponent,
	type BashOperations,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Key,
	Loader,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

// ─── Constants & Limits ───────────────────────────────────────────────────────

export const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10MB limit per task log
export const MAX_CONCURRENT_BACKGROUND_TASKS = 10;
export const DEFAULT_LOG_BASE_DIR = "/tmp/pi-tasks";
export const BACKGROUND_TASKS_STATUS_KEY = "rbf-background-tasks";
export const TASK_ID_LENGTH = 8;

/** `rbf-cd.ts` asks this before it switches sessions: the switch stops every tracked task and aborts a running command. */
export const BUSY_QUERY_CHANNEL = "rbf-background-tasks:busy/v1";

export const BASH_EXECUTION_PATCHED_KEY = Symbol.for("rbf.backgroundTasks.bashExecutionPatched");
export const LOADER_PATCHED_KEY = Symbol.for("rbf.backgroundTasks.loaderPatched");
export const TOOL_EXECUTION_PATCHED_KEY = Symbol.for("rbf.backgroundTasks.toolExecutionPatched");
const ORIG_LOADER_UPDATE_DISPLAY = Symbol.for("rbf.backgroundTasks.origLoaderUpdateDisplay");
const ORIG_LOADER_SET_MESSAGE = Symbol.for("rbf.backgroundTasks.origLoaderSetMessage");
const ORIG_BASH_UPDATE_DISPLAY = Symbol.for("rbf.backgroundTasks.origBashUpdateDisplay");
const ORIG_TOOL_EXECUTION_UPDATE_DISPLAY = Symbol.for("rbf.backgroundTasks.origToolExecutionUpdateDisplay");
export const INSTALLED_TOOL_EXECUTION_UPDATE_DISPLAY = Symbol.for("rbf.backgroundTasks.installedToolExecutionUpdateDisplay");

// ─── Types ───────────────────────────────────────────────────────────────────

export type TaskStatus = "running" | "completed" | "failed" | "stopped";

export interface BackgroundTask {
	id: string;
	command: string;
	cwd: string;
	pid: number;
	pgid: number;
	status: TaskStatus;
	exitCode: number | null;
	startTime: number;
	endTime?: number;
	logPath: string;
	logBytes: number;
	isTruncated: boolean;
	isBackgrounded: boolean;
	child?: ChildProcess;
	logStream?: fs.WriteStream;
}

export interface ActiveForegroundExecution {
	task: BackgroundTask;
	detach: () => void;
	abort: () => void;
}

/** Filled in by the listener before `emit` returns. Flags are only ever raised, so a second listener can't hide running work. */
export interface BusyQuery {
	answered?: boolean;
	backgroundTask?: boolean;
	command?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Generate an 8-character hex string for task identification.
 */
export function generateTaskId(): string {
	if (typeof crypto.randomBytes === "function") {
		return crypto.randomBytes(4).toString("hex");
	}
	return Math.random().toString(16).slice(2, 10).padEnd(TASK_ID_LENGTH, "0");
}

/**
 * Format milliseconds into human-readable runtime (e.g. 12s, 1m 23s, 2h 15m 10s).
 */
export function formatRuntime(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) {
		return `${minutes}m ${seconds}s`;
	}
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return `${hours}h ${remainingMinutes}m ${seconds}s`;
}

/**
 * Ensure log directory exists with mode 0700 permissions.
 */
export function ensureLogDir(sessionId: string, baseDir = DEFAULT_LOG_BASE_DIR): string {
	const safeSessionId = (sessionId || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
	const sessionDir = path.join(baseDir, `session-${safeSessionId}`);
	if (!fs.existsSync(sessionDir)) {
		fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
	}
	return sessionDir;
}

/**
 * Format footer badge text for active background tasks.
 */
export function formatFooterBadge(count: number): string | undefined {
	if (count <= 0) return undefined;
	return count === 1 ? "1 shell" : `${count} shells`;
}

/**
 * Kill process and all children (cross-platform).
 */
export function killProcessTree(pid: number): void {
	// pid 1 is launchd/init, and kill(-1) signals every process the user owns.
	if (!pid || pid <= 1) return;
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/pid", pid.toString(), "/T", "/F"], {
				detached: true,
				windowsHide: true,
			}).once("error", () => {});
		} catch {}
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
	}
}

/**
 * Cross-platform process tree killer with SIGTERM grace period before SIGKILL.
 */
export function terminateProcessTree(pid: number, gracefulTimeoutMs = 500): Promise<void> {
	return new Promise((resolve) => {
		// pid 1 is launchd/init, and kill(-1) signals every process the user owns.
		if (!pid || pid <= 1) {
			resolve();
			return;
		}

		if (process.platform === "win32") {
			try {
				killProcessTree(pid);
			} catch {}
			resolve();
			return;
		}

		// On Unix, attempt SIGTERM to process group first
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

		if (typeof timer.unref === "function") {
			timer.unref();
		}

		resolve();
	});
}

// ─── TaskManager ─────────────────────────────────────────────────────────────

export class TaskManager {
	private tasks = new Map<string, BackgroundTask>();
	private activeForeground: ActiveForegroundExecution | null = null;

	setActiveForeground(execution: ActiveForegroundExecution | null): void {
		this.activeForeground = execution;
	}

	getActiveForeground(): ActiveForegroundExecution | null {
		return this.activeForeground;
	}

	clearActiveForeground(): void {
		this.activeForeground = null;
	}

	detachActiveForeground(): boolean {
		if (!this.activeForeground) return false;
		const execution = this.activeForeground;
		execution.detach();
		return true;
	}

	addBackgroundTask(task: BackgroundTask): void {
		this.tasks.set(task.id, task);
	}

	getTask(id: string): BackgroundTask | undefined {
		return this.tasks.get(id);
	}

	findTask(query: string): BackgroundTask | undefined {
		if (!query) return undefined;
		const exact = this.tasks.get(query);
		if (exact) return exact;

		// Prefix match (minimum 2 chars)
		const clean = query.toLowerCase().trim();
		for (const [id, task] of this.tasks) {
			if (id.toLowerCase().startsWith(clean)) {
				return task;
			}
		}
		return undefined;
	}

	getAllTasks(): BackgroundTask[] {
		return Array.from(this.tasks.values()).sort((a, b) => b.startTime - a.startTime);
	}

	getRunningTasks(): BackgroundTask[] {
		return this.getAllTasks().filter((t) => t.status === "running");
	}

	stopTask(id: string): boolean {
		const task = this.findTask(id);
		if (!task) return false;

		if (task.status === "running") {
			task.status = "stopped";
			task.endTime = Date.now();
			if (task.pid) {
				terminateProcessTree(task.pid);
			}
			if (task.logStream) {
				try {
					task.logStream.write("\n[Process stopped by user]\n");
					task.logStream.end();
				} catch {}
			}
			return true;
		}
		return false;
	}

	stopAllTasks(): void {
		for (const task of this.getRunningTasks()) {
			this.stopTask(task.id);
		}
		if (this.activeForeground) {
			this.activeForeground.abort();
		}
	}

	clear(): void {
		this.tasks.clear();
		this.activeForeground = null;
	}
}

export function formatBackgroundHintMessage(
	msg: string,
	hasActiveForeground?: boolean,
): string {
	if (typeof msg !== "string") {
		return msg;
	}

	// Remove /ctrl+c or ctrl+c/ from cancel hint (e.g. "escape/ctrl+c to cancel" -> "escape to cancel")
	let updated = msg.replace(/\/ctrl\+c/gi, "").replace(/ctrl\+c\//gi, "");

	if (updated.includes("Running...")) {
		if (!updated.includes("ctrl+b")) {
			if (updated.includes("(")) {
				updated = updated.replace(
					/Running\.\.\.\s*\(/,
					"Running... (ctrl+b to run in background · ",
				);
			} else {
				updated = updated.replace(
					"Running...",
					"Running... (ctrl+b to run in background)",
				);
			}
		}
		return updated;
	}

	if (updated.startsWith("Working") || updated.includes("Working")) {
		const shouldShow =
			hasActiveForeground ??
			(getActiveTaskManager()?.getActiveForeground() !== null &&
				getActiveTaskManager()?.getActiveForeground() !== undefined);

		if (shouldShow) {
			if (!updated.includes("ctrl+b")) {
				if (updated.includes("(")) {
					updated = updated.replace(
						/\s*\(.*?\)/,
						" (ctrl+b to run in background · Esc to cancel)",
					);
				} else {
					updated = `${updated} (ctrl+b to run in background · Esc to cancel)`;
				}
			}
		} else {
			updated = updated
				.replace(/\s*\(ctrl\+b to run in background[^)]*\)/gi, "")
				.trim();
		}
		return updated;
	}

	return updated;
}

/**
 * Recursively search a component tree and append the background hint to any Text node
 * displaying elapsed execution time (e.g. "Elapsed 8.0s").
 */
export function applyElapsedHint(node: any, theme?: any): boolean {
	if (!node) return false;

	if (typeof node.setText === "function" && typeof node.text === "string") {
		const currentText = node.text;
		if (currentText.includes("Elapsed") && !currentText.includes("ctrl+b")) {
			const cleaned = currentText.replace(/\/ctrl\+c/gi, "").replace(/ctrl\+c\//gi, "");
			const fg = theme?.fg ? theme.fg.bind(theme) : (_c: string, t: string) => t;
			node.setText(cleaned + fg("muted", " · (ctrl+b to run in background · Esc to cancel)"));
			return true;
		}
	}

	let found = false;
	if (node.child && applyElapsedHint(node.child, theme)) {
		found = true;
	}

	if (Array.isArray(node.children)) {
		for (const child of node.children) {
			if (applyElapsedHint(child, theme)) {
				found = true;
			}
		}
	}

	return found;
}

/**
 * Patch BashExecutionComponent and Loader to display (ctrl+b to run in background)
 * while a foreground shell command is executing.
 */
export function patchBashExecutionComponent(): void {
	// 1. Patch Loader prototype so any running command loader (bundled CLI or unbundled SDK)
	// gets the background hint immediately from its initial construction frame.
	const loaderProto = (Loader as any)?.prototype;
	if (loaderProto && !loaderProto[LOADER_PATCHED_KEY]) {
		const origUpdateDisplay = loaderProto.updateDisplay;
		const origSetMessage = loaderProto.setMessage;

		loaderProto[ORIG_LOADER_UPDATE_DISPLAY] = origUpdateDisplay;
		loaderProto[ORIG_LOADER_SET_MESSAGE] = origSetMessage;

		loaderProto.updateDisplay = function () {
			if (typeof this.message === "string") {
				this.message = formatBackgroundHintMessage(this.message);
			}
			if (typeof origUpdateDisplay === "function") {
				return origUpdateDisplay.call(this);
			}
		};

		loaderProto.setMessage = function (message: string) {
			const formatted = formatBackgroundHintMessage(message);
			if (typeof origSetMessage === "function") {
				return origSetMessage.call(this, formatted);
			}
			this.message = formatted;
			if (typeof this.updateDisplay === "function") {
				this.updateDisplay();
			}
		};

		loaderProto[LOADER_PATCHED_KEY] = true;
	}

	// 2. Also patch BashExecutionComponent.prototype.updateDisplay (for unbundled/SDK mode)
	const bashProto = (BashExecutionComponent as any)?.prototype;
	if (bashProto && !bashProto[BASH_EXECUTION_PATCHED_KEY]) {
		const origBashUpdateDisplay = bashProto.updateDisplay;
		bashProto[ORIG_BASH_UPDATE_DISPLAY] = origBashUpdateDisplay;

		bashProto.updateDisplay = function () {
			if (Array.isArray(this.outputLines) && typeof origBashUpdateDisplay === "function") {
				try {
					origBashUpdateDisplay.call(this);
				} catch {}
			}
			if (this.status === "running" && this.loader && typeof this.loader.setMessage === "function") {
				const currentMessage = this.loader.message || "";
				if (!currentMessage.includes("ctrl+b") || currentMessage.toLowerCase().includes("ctrl+c")) {
					this.loader.setMessage(
						formatBackgroundHintMessage(
							`Running... (${keyText("tui.select.cancel")} to cancel)`,
						),
					);
				}
			}
		};

		bashProto[BASH_EXECUTION_PATCHED_KEY] = true;
	}

	// 3. Patch ToolExecutionComponent.prototype.updateDisplay for agent bash tools
	const toolProto = (ToolExecutionComponent as any)?.prototype;
	if (toolProto && !toolProto[TOOL_EXECUTION_PATCHED_KEY]) {
		const origToolUpdateDisplay = toolProto.updateDisplay;
		toolProto[ORIG_TOOL_EXECUTION_UPDATE_DISPLAY] = origToolUpdateDisplay;

		const installedUpdateDisplay = function (this: any) {
			if (typeof origToolUpdateDisplay === "function") {
				try {
					origToolUpdateDisplay.call(this);
				} catch {}
			}
			if (this.isPartial && (this.toolName === "bash" || !this.toolName)) {
				const renderContainer =
					typeof this.getRenderShell === "function" && this.getRenderShell() === "self"
						? this.selfRenderContainer
						: this.contentBox;
				if (renderContainer) {
					applyElapsedHint(renderContainer, (this as any).theme);
				}
			}
		};

		toolProto.updateDisplay = installedUpdateDisplay;
		toolProto[INSTALLED_TOOL_EXECUTION_UPDATE_DISPLAY] = installedUpdateDisplay;
		toolProto[TOOL_EXECUTION_PATCHED_KEY] = true;
	}
}

export function unpatchBashExecutionComponent(): void {
	const loaderProto = (Loader as any)?.prototype;
	if (loaderProto && loaderProto[LOADER_PATCHED_KEY]) {
		if (loaderProto[ORIG_LOADER_UPDATE_DISPLAY]) {
			loaderProto.updateDisplay = loaderProto[ORIG_LOADER_UPDATE_DISPLAY];
			delete loaderProto[ORIG_LOADER_UPDATE_DISPLAY];
		}
		if (loaderProto[ORIG_LOADER_SET_MESSAGE]) {
			loaderProto.setMessage = loaderProto[ORIG_LOADER_SET_MESSAGE];
			delete loaderProto[ORIG_LOADER_SET_MESSAGE];
		}
		delete loaderProto[LOADER_PATCHED_KEY];
	}

	const bashProto = (BashExecutionComponent as any)?.prototype;
	if (bashProto && bashProto[BASH_EXECUTION_PATCHED_KEY]) {
		if (bashProto[ORIG_BASH_UPDATE_DISPLAY]) {
			bashProto.updateDisplay = bashProto[ORIG_BASH_UPDATE_DISPLAY];
			delete bashProto[ORIG_BASH_UPDATE_DISPLAY];
		}
		delete bashProto[BASH_EXECUTION_PATCHED_KEY];
	}

	const toolProto = (ToolExecutionComponent as any)?.prototype;
	if (toolProto && toolProto[TOOL_EXECUTION_PATCHED_KEY]) {
		const installed = toolProto[INSTALLED_TOOL_EXECUTION_UPDATE_DISPLAY];
		const canRestore =
			typeof installed === "function"
				? toolProto.updateDisplay === installed
				: true;
		if (canRestore) {
			if (toolProto[ORIG_TOOL_EXECUTION_UPDATE_DISPLAY]) {
				toolProto.updateDisplay = toolProto[ORIG_TOOL_EXECUTION_UPDATE_DISPLAY];
				delete toolProto[ORIG_TOOL_EXECUTION_UPDATE_DISPLAY];
			}
			delete toolProto[TOOL_EXECUTION_PATCHED_KEY];
			delete toolProto[INSTALLED_TOOL_EXECUTION_UPDATE_DISPLAY];
		}
	}
}

// ─── Footer Updates & Patching ────────────────────────────────────────────────

export const FOOTER_TASKS_PATCHED_KEY = Symbol.for("rbf.backgroundTasks.footerPatched");
export const ORIGINAL_FOOTER_RENDER_KEY = Symbol.for("rbf.backgroundTasks.originalFooterRender");
export const ORIGINAL_FOOTER_HANDLE_MOUSE_KEY = Symbol.for("rbf.backgroundTasks.origFooterHandleMouse");

export interface BadgeBounds {
	y: number;
	startX: number;
	endX: number;
}

let isFooterSelected = false;
let isBadgeHovered = false;
let currentBadgeBounds: BadgeBounds | null = null;
let lastFooterScreenY: number | null = null;
let onBadgeClickHandler: (() => void) | null = null;
let activeTaskManager: TaskManager | null = null;

export function getIsFooterSelected(): boolean {
	return isFooterSelected;
}

export function setIsFooterSelected(selected: boolean): void {
	isFooterSelected = selected;
}

export function getIsBadgeHovered(): boolean {
	return isBadgeHovered;
}

export function setIsBadgeHovered(hovered: boolean): void {
	isBadgeHovered = hovered;
}

export function getBadgeBounds(): BadgeBounds | null {
	return currentBadgeBounds;
}

export function setBadgeBounds(bounds: BadgeBounds | null): void {
	currentBadgeBounds = bounds;
}

export function getLastFooterScreenY(): number | null {
	return lastFooterScreenY;
}

export function setLastFooterScreenY(screenY: number | null): void {
	lastFooterScreenY = screenY;
}

export function setOnBadgeClick(handler: (() => void) | null): void {
	onBadgeClickHandler = handler;
}

export function getActiveTaskManager(): TaskManager | null {
	return activeTaskManager;
}

export function setActiveTaskManager(manager: TaskManager | null): void {
	activeTaskManager = manager;
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

/**
 * Calculates the horizontal hit-box bounds for the background tasks badge in lines[1].
 */
export function calculateBadgeBounds(
	statsLine: string,
	taskCount: number,
	width: number,
): BadgeBounds | null {
	if (taskCount <= 0 || !statsLine) return null;

	const badgeText = taskCount === 1 ? "1 shell" : `${taskCount} shells`;
	const padMatch = statsLine.match(/^(.*?)(\s{2,})(.*)$/);
	const left = padMatch ? padMatch[1] : statsLine;
	const leftWidth = visibleWidth(left);
	const startX = leftWidth + 1;
	// Bullet "· " has width 2, badgeText, plus optional padding (2)
	const badgeWidth = 2 + visibleWidth(badgeText) + 2;
	const endX = Math.min(width, startX + badgeWidth);
	if (startX >= width) return null;

	return { y: 1, startX, endX };
}

/**
 * Injects background task count badge directly into the stats line (lines[1])
 * to the right of `$0.000 (sub) 0.1%/272k (auto)`.
 */
export function formatStatsLineWithTasks(
	statsLine: string,
	taskCount: number,
	isSelected: boolean,
	width: number,
	theme: any,
): string {
	if (taskCount <= 0 || !statsLine) return statsLine;

	const badgeText = taskCount === 1 ? "1 shell" : `${taskCount} shells`;
	const bullet = theme?.fg ? theme.fg("dim", "· ") : "· ";
	let styledBadge: string;
	if (isSelected) {
		if (theme?.inverse) {
			styledBadge =
				bullet +
				(theme.bold
					? theme.bold(theme.inverse(` ${badgeText} `))
					: theme.inverse(` ${badgeText} `));
		} else {
			styledBadge = bullet + `[${badgeText}]`;
		}
	} else {
		styledBadge = bullet + (theme?.fg ? theme.fg("accent", badgeText) : badgeText);
	}

	// Find the padding between the left stats and right-aligned model
	const padMatch = statsLine.match(/^(.*?)(\s{2,})(.*)$/);
	if (!padMatch) {
		const combined = `${statsLine} ${styledBadge}`;
		return truncateToWidth(combined, width, "");
	}

	const left = padMatch[1];
	const right = padMatch[3];
	const newLeft = `${left} ${styledBadge}`;
	const newLeftWidth = visibleWidth(newLeft);
	const rightWidth = visibleWidth(right);
	const minPadding = 2;

	if (newLeftWidth + minPadding + rightWidth <= width) {
		const pad = " ".repeat(width - newLeftWidth - rightWidth);
		return newLeft + pad + right;
	}

	const availableForRight = width - newLeftWidth - minPadding;
	if (availableForRight > 0) {
		const truncatedRight = truncateToWidth(right, availableForRight, "");
		const pad = " ".repeat(Math.max(0, width - newLeftWidth - visibleWidth(truncatedRight)));
		return newLeft + pad + truncatedRight;
	}

	return truncateToWidth(newLeft, width, "");
}

const FOOTER_PI_RBF_REGISTRY_KEY = Symbol.for("@earendil-works/pi-rbf:footer-registry");

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

export function getOrCreateFooterRegistry(): FooterRegistry | null {
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
				} catch {
					// Guard against hook render error
				}
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
					} catch {
						// Guard against hook mouse error
					}
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

export function patchFooterComponent(
	taskManager?: TaskManager,
	getIsSelected?: () => boolean,
	getIsHovered?: () => boolean,
	onBadgeClick?: () => void,
): boolean {
	const registry = getOrCreateFooterRegistry();
	if (!registry) {
		return false;
	}
	if (onBadgeClick) {
		onBadgeClickHandler = onBadgeClick;
	}

	registry.hooks.set("tasks", {
		id: "tasks",
		render(this: any, lines: string[], width: number): string[] {
			if (!lines || lines.length < 2) {
				currentBadgeBounds = null;
				return lines;
			}

			const tm = taskManager ?? activeTaskManager;
			if (!tm) {
				currentBadgeBounds = null;
				return lines;
			}

			const runningCount = tm.getRunningTasks().length;
			if (runningCount <= 0) {
				currentBadgeBounds = null;
				return lines;
			}

			const theme = this.session?.theme ?? getActiveTheme();
			const selected = getIsSelected ? getIsSelected() : isFooterSelected;
			const hovered = getIsHovered ? getIsHovered() : isBadgeHovered;
			const highlighted = selected || hovered;

			currentBadgeBounds = calculateBadgeBounds(lines[1], runningCount, width);
			lines[1] = formatStatsLineWithTasks(lines[1], runningCount, highlighted, width, theme);

			return lines;
		},
		handleMouse(this: any, event: TuiMouseEvent): TuiMouseEventResult | undefined {
			const tm = taskManager ?? activeTaskManager;
			if (!tm || tm.getRunningTasks().length === 0) {
				if (isBadgeHovered) {
					isBadgeHovered = false;
					return { handled: true, render: true };
				}
				return undefined;
			}

			const bounds = currentBadgeBounds;
			if (!bounds) {
				return undefined;
			}

			if (typeof event.screenY === "number" && typeof event.y === "number") {
				lastFooterScreenY = event.screenY - event.y;
			}

			const inBounds =
				event.y === bounds.y &&
				event.x >= bounds.startX &&
				event.x <= bounds.endX;

			if (event.type === "move") {
				if (inBounds !== isBadgeHovered) {
					isBadgeHovered = inBounds;
					return { handled: true, render: true };
				}
				if (inBounds) {
					return { handled: true };
				}
				return undefined;
			}

			if (event.type === "press" && inBounds && event.button === "left") {
				return { handled: true };
			}

			if (event.type === "click" && inBounds && event.button === "left") {
				if (onBadgeClickHandler) {
					onBadgeClickHandler();
				}
				return { handled: true, render: true };
			}

			return undefined;
		},
	});

	(FooterComponent.prototype as any)[FOOTER_TASKS_PATCHED_KEY] = true;
	return true;
}

export function unpatchFooterComponent(): void {
	if (typeof FooterComponent === "undefined" || !FooterComponent.prototype) {
		return;
	}
	const registry: FooterRegistry | undefined = (FooterComponent.prototype as any)[FOOTER_PI_RBF_REGISTRY_KEY];
	if (registry) {
		registry.hooks.delete("tasks");
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
	delete (FooterComponent.prototype as any)[FOOTER_TASKS_PATCHED_KEY];
	delete (FooterComponent.prototype as any)[ORIGINAL_FOOTER_RENDER_KEY];
	delete (FooterComponent.prototype as any)[ORIGINAL_FOOTER_HANDLE_MOUSE_KEY];
	isBadgeHovered = false;
	currentBadgeBounds = null;
	lastFooterScreenY = null;
	onBadgeClickHandler = null;
}

export function updateFooterBadge(
	ctx: ExtensionContext | ExtensionCommandContext,
	taskManager: TaskManager,
): void {
	if (!ctx?.ui) return;
	const runningCount = taskManager.getRunningTasks().length;
	if (runningCount === 0) {
		isFooterSelected = false;
		isBadgeHovered = false;
		currentBadgeBounds = null;
	}
	// Clear any separate status badge in extension statuses so it never takes up a 3rd line
	if (typeof ctx.ui.setStatus === "function") {
		ctx.ui.setStatus(BACKGROUND_TASKS_STATUS_KEY, undefined);
	}
	// Request TUI render so the updated lines[1] badge takes effect immediately
	if (typeof (ctx.ui as any).requestRender === "function") {
		(ctx.ui as any).requestRender();
	}
}

// ─── Operations Factory ──────────────────────────────────────────────────────

export function createBackgroundableOperations(
	ctx: ExtensionContext,
	taskManager: TaskManager,
	sessionId: string,
	baseDir = DEFAULT_LOG_BASE_DIR,
): BashOperations {
	return {
		exec: async (command, cwd, options) => {
			const shellConfig = getShellConfig();
			const taskId = generateTaskId();
			const sessionDir = ensureLogDir(sessionId, baseDir);
			const logPath = path.join(sessionDir, `${taskId}.log`);
			const logStream = fs.createWriteStream(logPath, { flags: "a", mode: 0o600 });

			const task: BackgroundTask = {
				id: taskId,
				command,
				cwd,
				pid: 0,
				pgid: 0,
				status: "running",
				exitCode: null,
				startTime: Date.now(),
				logPath,
				logBytes: 0,
				isTruncated: false,
				isBackgrounded: false,
				logStream,
			};

			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const child = spawn(
				shellConfig.shell,
				commandFromStdin ? shellConfig.args : [...shellConfig.args, command],
				{
					cwd,
					detached: process.platform !== "win32",
					env: options.env ?? process.env,
					stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
					windowsHide: true,
				},
			);

			task.child = child;
			task.pid = child.pid || 0;
			task.pgid = child.pid || 0;

			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}

			return new Promise<{ exitCode: number | null }>((resolve, reject) => {
				let isResolved = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				let timedOut = false;

				if (options.timeout && options.timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (task.pid) {
							terminateProcessTree(task.pid);
						}
					}, options.timeout * 1000);
				}

				const appendLog = (chunk: Buffer | string) => {
					if (task.isTruncated) return;
					const len = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
					if (task.logBytes + len > MAX_LOG_BYTES) {
						task.isTruncated = true;
						const rem = Math.max(0, MAX_LOG_BYTES - task.logBytes);
						if (rem > 0 && logStream.writable) {
							const part =
								typeof chunk === "string"
									? Buffer.from(chunk).subarray(0, rem)
									: chunk.subarray(0, rem);
							logStream.write(part);
							task.logBytes += rem;
						}
						if (logStream.writable) {
							logStream.write("\n[Output truncated at 10MB limit]\n");
							task.logBytes += 33;
						}
						return;
					}
					if (logStream.writable) {
						logStream.write(chunk);
						task.logBytes += len;
					}
				};

				const detach = () => {
					if (isResolved || task.isBackgrounded) return;
					if (timeoutHandle) {
						clearTimeout(timeoutHandle);
						timeoutHandle = undefined;
					}
					task.isBackgrounded = true;
					taskManager.clearActiveForeground();
					taskManager.addBackgroundTask(task);

					// Update footer
					updateFooterBadge(ctx, taskManager);
					(ctx?.ui as any)?.requestRender?.();

					// Emit detachment notice to chat row and agent context
					const notice = `\nCommand was manually backgrounded by user with ID: ${task.id}. Output is being written to:\n  ${task.logPath}\n\n[Process running in background]\nTask ID: ${task.id}\nCommand: ${task.command}\nStatus: actively running in background\nNotice: This command was moved to the background by the user and is still executing. Inform the user that it is running in the background and do not state that it has completed.\n`;
					options.onData(Buffer.from(notice));

					// Resolve foreground execution cleanly so chat row completes
					isResolved = true;
					resolve({ exitCode: 0 });
				};

				const abort = () => {
					if (isResolved) return;
					if (timeoutHandle) {
						clearTimeout(timeoutHandle);
						timeoutHandle = undefined;
					}
					task.status = "stopped";
					task.endTime = Date.now();
					taskManager.clearActiveForeground();
					(ctx?.ui as any)?.requestRender?.();
					if (task.pid) {
						terminateProcessTree(task.pid);
					}
					try {
						logStream.end();
					} catch {}
					isResolved = true;
					resolve({ exitCode: null });
				};

				taskManager.setActiveForeground({ task, detach, abort });
				(ctx?.ui as any)?.requestRender?.();

				child.stdout?.on("data", (chunk: Buffer) => {
					appendLog(chunk);
					if (!task.isBackgrounded) {
						options.onData(chunk);
					}
				});

				child.stderr?.on("data", (chunk: Buffer) => {
					appendLog(chunk);
					if (!task.isBackgrounded) {
						options.onData(chunk);
					}
				});

				child.on("close", (code) => {
					if (timeoutHandle) {
						clearTimeout(timeoutHandle);
						timeoutHandle = undefined;
					}
					task.exitCode = code;
					task.endTime = Date.now();
					if (task.status === "running") {
						task.status = code === 0 ? "completed" : "failed";
					}

					const finishAndResolve = (exitCode: number | null) => {
						if (!isResolved) {
							isResolved = true;
							if (timedOut) {
								reject(new Error(`timeout:${options.timeout}`));
							} else {
								resolve({ exitCode });
							}
						}
					};

					if (task.isBackgrounded) {
						try {
							logStream.end();
						} catch {}
						updateFooterBadge(ctx, taskManager);
					} else {
						taskManager.clearActiveForeground();
						(ctx?.ui as any)?.requestRender?.();
						try {
							logStream.end(() => {
								finishAndResolve(code);
							});
						} catch {
							finishAndResolve(code);
						}
					}
				});

				child.on("error", (err) => {
					if (timeoutHandle) {
						clearTimeout(timeoutHandle);
						timeoutHandle = undefined;
					}
					appendLog(`\nSpawn error: ${err.message}\n`);
					task.status = "failed";
					task.endTime = Date.now();

					const finishAndResolve = (exitCode: number | null) => {
						if (!isResolved) {
							isResolved = true;
							resolve({ exitCode });
						}
					};

					if (task.isBackgrounded) {
						try {
							logStream.end();
						} catch {}
						updateFooterBadge(ctx, taskManager);
					} else {
						taskManager.clearActiveForeground();
						(ctx?.ui as any)?.requestRender?.();
						try {
							logStream.end(() => {
								finishAndResolve(1);
							});
						} catch {
							finishAndResolve(1);
						}
					}
				});

				if (options.signal) {
					options.signal.addEventListener(
						"abort",
						() => {
							if (timeoutHandle) {
								clearTimeout(timeoutHandle);
								timeoutHandle = undefined;
							}
							if (!task.isBackgrounded) {
								abort();
							}
						},
						{ once: true },
					);
				}
			});
		},
	};
}

// ─── Modal Components ────────────────────────────────────────────────────────

export interface TasksModalComponent extends Component {
	dispose?(): void;
}

/**
 * Interactive Shell details / tasks viewer modal component for ctx.ui.custom().
 */
export function createTasksModalComponent(
	taskManager: TaskManager,
	initialTaskId: string | null,
	tui: TUI,
	theme: Theme,
	done: (res: null) => void,
): TasksModalComponent {
	const allTasks = taskManager.getAllTasks();
	let view: "list" | "details" =
		initialTaskId || allTasks.length <= 1 ? "details" : "list";

	let selectedTaskIndex = 0;
	if (initialTaskId) {
		const idx = allTasks.findIndex((t) => t.id === initialTaskId);
		if (idx !== -1) selectedTaskIndex = idx;
	}

	let detailsScrollOffset = 0;
	const boxVisibleLines = 10;

	const timer = setInterval(() => {
		tui.requestRender();
	}, 500);

	function getActiveTask(): BackgroundTask | undefined {
		const tasks = taskManager.getAllTasks();
		return tasks[selectedTaskIndex];
	}

	function renderListView(width: number): string[] {
		const tasks = taskManager.getAllTasks();
		const lines: string[] = [];

		lines.push("");
		lines.push(theme.bold(" Shell tasks"));
		lines.push("");

		if (tasks.length === 0) {
			lines.push("  (no shell tasks in this session)");
			lines.push("");
			lines.push("  Esc/Enter to close");
			return lines;
		}

		for (let i = 0; i < tasks.length; i++) {
			const t = tasks[i];
			const isSelected = i === selectedTaskIndex;
			const cursor = isSelected ? theme.fg("accent", "❯ ") : "  ";

			const idStr = theme.bold(t.id);
			let statusStr: string = t.status;
			if (t.status === "running") statusStr = theme.fg("accent", "running  ");
			else if (t.status === "completed") statusStr = theme.fg("success", "completed");
			else if (t.status === "failed") statusStr = theme.fg("error", "failed   ");
			else if (t.status === "stopped") statusStr = theme.fg("warning", "stopped  ");

			const runtimeStr = formatRuntime(
				(t.endTime ?? Date.now()) - t.startTime,
			).padEnd(6);
			const cmdStr = t.command.replace(/\r?\n/g, " ");

			const rowText = `${cursor}${idStr}  ${statusStr}  ${runtimeStr}  ${cmdStr}`;
			lines.push(truncateToWidth(rowText, Math.max(10, width - 2)));
		}

		lines.push("");
		lines.push(
			theme.fg(
				"muted",
				"  ↑/↓ to navigate · Enter to view · x to stop · Esc to close",
			),
		);
		lines.push("");

		return lines;
	}

	function renderDetailsView(width: number): string[] {
		const task = getActiveTask();
		const lines: string[] = [];

		lines.push("");
		lines.push(theme.bold(" Shell details"));
		lines.push("");

		if (!task) {
			lines.push("  (task not found)");
			lines.push("");
			lines.push("  Esc to close");
			return lines;
		}

		// Status
		let statusFormatted: string = task.status;
		if (task.status === "running") {
			statusFormatted = theme.fg("accent", "running");
		} else if (task.status === "completed") {
			statusFormatted = theme.fg("success", "completed");
		} else if (task.status === "failed") {
			statusFormatted = theme.fg(
				"error",
				`failed (exit ${task.exitCode ?? 1})`,
			);
		} else if (task.status === "stopped") {
			statusFormatted = theme.fg("warning", "stopped");
		}
		lines.push(`  Status:  ${statusFormatted}`);

		// Runtime
		const runtimeMs = (task.endTime ?? Date.now()) - task.startTime;
		lines.push(`  Runtime: ${formatRuntime(runtimeMs)}`);

		// Command
		lines.push(`  Command: ${task.command.replace(/\r?\n/g, " ")}`);

		// Log path
		lines.push(`  Log:     ${task.logPath}`);
		lines.push("");
		lines.push("  Output:");

		// Read log content
		let logLines: string[] = [];
		try {
			if (fs.existsSync(task.logPath)) {
				const content = fs.readFileSync(task.logPath, "utf8");
				logLines = content.split("\n");
				if (logLines.length > 0 && logLines[logLines.length - 1] === "") {
					logLines.pop();
				}
			}
		} catch {
			logLines = ["(unable to read log file)"];
		}

		if (logLines.length === 0) {
			logLines = ["(no output recorded yet)"];
		}

		const boxWidth = Math.min(Math.max(30, width - 4), 90);
		const innerWidth = boxWidth - 4;

		// Box Top Border
		const topBorder = `  ╭${"─".repeat(boxWidth - 2)}╮`;
		lines.push(theme.fg("muted", topBorder));

		// Clamp scroll offset
		const maxScroll = Math.max(0, logLines.length - boxVisibleLines);
		if (detailsScrollOffset > maxScroll) {
			detailsScrollOffset = maxScroll;
		}

		const visibleSlice = logLines.slice(
			detailsScrollOffset,
			detailsScrollOffset + boxVisibleLines,
		);

		// Pad slice to boxVisibleLines
		while (visibleSlice.length < boxVisibleLines) {
			visibleSlice.push("");
		}

		for (const rawLine of visibleSlice) {
			const cleanLine = rawLine.replace(/\r/g, "");
			const truncated = truncateToWidth(cleanLine, innerWidth);
			const padLen = Math.max(0, innerWidth - visibleWidth(truncated));
			const innerContent = truncated + " ".repeat(padLen);
			lines.push(
				`  ${theme.fg("muted", "│")} ${innerContent} ${theme.fg("muted", "│")}`,
			);
		}

		// Box Bottom Border
		const bottomBorder = `  ╰${"─".repeat(boxWidth - 2)}╯`;
		lines.push(theme.fg("muted", bottomBorder));

		// Summary text
		lines.push(
			theme.fg(
				"muted",
				`  Showing ${Math.min(boxVisibleLines, logLines.length)} lines (${logLines.length} total) (↑/↓ to scroll, g/G top/bottom)`,
			),
		);
		lines.push("");

		const hasMultipleTasks = taskManager.getAllTasks().length > 1;
		const backHint = hasMultipleTasks ? "← to go back · " : "";
		lines.push(
			theme.fg(
				"muted",
				`  ${backHint}Esc/Enter/Space to close · x to stop`,
			),
		);
		lines.push("");

		return lines;
	}

	function handleInput(data: string): void {
		// Close commands
		if (
			data === "q" ||
			data === "\x1b" ||
			matchesKey(data, Key.escape)
		) {
			done(null);
			return;
		}

		if (view === "list") {
			const tasks = taskManager.getAllTasks();
			if (
				matchesKey(data, Key.enter) ||
				data === "\r" ||
				data === "\n" ||
				data === " " ||
				matchesKey(data, Key.space)
			) {
				if (tasks.length > 0) {
					view = "details";
					detailsScrollOffset = 0;
					tui.requestRender();
				} else {
					done(null);
				}
				return;
			}

			if (matchesKey(data, Key.up) || data === "k" || data === "\x1b[A") {
				if (selectedTaskIndex > 0) {
					selectedTaskIndex--;
					tui.requestRender();
				}
				return;
			}

			if (matchesKey(data, Key.down) || data === "j" || data === "\x1b[B") {
				if (selectedTaskIndex < tasks.length - 1) {
					selectedTaskIndex++;
					tui.requestRender();
				}
				return;
			}

			if (data === "x" || data === "X") {
				const current = tasks[selectedTaskIndex];
				if (current && current.status === "running") {
					taskManager.stopTask(current.id);
					tui.requestRender();
				}
				return;
			}
		} else {
			// details view
			const task = getActiveTask();
			const hasMultipleTasks = taskManager.getAllTasks().length > 1;

			if (
				matchesKey(data, Key.enter) ||
				data === "\r" ||
				data === "\n" ||
				data === " " ||
				matchesKey(data, Key.space)
			) {
				done(null);
				return;
			}

			if (
				hasMultipleTasks &&
				(data === "\x1b[D" ||
					data === "h" ||
					data === "\x7f" ||
					data === "\b" ||
					matchesKey(data, Key.left) ||
					matchesKey(data, Key.backspace))
			) {
				view = "list";
				tui.requestRender();
				return;
			}

			if (data === "x" || data === "X") {
				if (task && task.status === "running") {
					taskManager.stopTask(task.id);
					tui.requestRender();
				}
				return;
			}

			if (matchesKey(data, Key.up) || data === "k" || data === "\x1b[A") {
				if (detailsScrollOffset > 0) {
					detailsScrollOffset--;
					tui.requestRender();
				}
				return;
			}

			if (matchesKey(data, Key.down) || data === "j" || data === "\x1b[B") {
				detailsScrollOffset++;
				tui.requestRender();
				return;
			}

			if (data === "g" || matchesKey(data, Key.home) || data === "\x1b[H") {
				detailsScrollOffset = 0;
				tui.requestRender();
				return;
			}

			if (data === "G" || matchesKey(data, Key.end) || data === "\x1b[F") {
				detailsScrollOffset = 999999;
				tui.requestRender();
				return;
			}

			if (matchesKey(data, Key.pageUp) || data === "\x1b[5~") {
				detailsScrollOffset = Math.max(0, detailsScrollOffset - boxVisibleLines);
				tui.requestRender();
				return;
			}

			if (matchesKey(data, Key.pageDown) || data === "\x1b[6~") {
				detailsScrollOffset += boxVisibleLines;
				tui.requestRender();
				return;
			}
		}
	}

	return {
		render(width: number): string[] {
			return view === "list" ? renderListView(width) : renderDetailsView(width);
		},
		handleInput,
		invalidate() {},
		dispose() {
			clearInterval(timer);
		},
	};
}

// ─── Extension Entry Point ───────────────────────────────────────────────────

export function rbfBackgroundTasks(pi: ExtensionAPI): void {
	const taskManager = new TaskManager();
	setActiveTaskManager(taskManager);
	setIsFooterSelected(false);

	// Patch BashExecutionComponent display loader message
	patchBashExecutionComponent();

	// Patch FooterComponent to render task count to right of stats line
	patchFooterComponent(taskManager, () => getIsFooterSelected());

	// ─── Busy query ───────────────────────────────────────────────────────────

	// Another extension can't import this task manager: a bare import may reach a different module instance.
	const stopAnsweringBusyQuery =
		typeof pi.events?.on === "function"
			? pi.events.on(BUSY_QUERY_CHANNEL, (data) => {
					const query = data as BusyQuery;
					query.answered = true;
					if (taskManager.getRunningTasks().length > 0) query.backgroundTask = true;
					// A `!` command or the agent's bash tool, still in the foreground.
					if (taskManager.getActiveForeground()) query.command = true;
				})
			: undefined;

	// ─── Agent bash tool registration ─────────────────────────────────────────

	let currentSessionCtx: ExtensionContext | null = null;

	const bashOperations: BashOperations = {
		exec: async (command, cwd, options) => {
			const effectiveCtx = currentSessionCtx;
			const sessionId = effectiveCtx?.sessionManager?.getSessionId?.() || "default";
			const bgOps = createBackgroundableOperations(
				effectiveCtx || ({ ui: { setStatus: () => {}, requestRender: () => {} } } as any),
				taskManager,
				sessionId,
			);
			return bgOps.exec(command, cwd, options);
		},
	};

	const baseBashTool = createBashToolDefinition(process.cwd(), {
		operations: bashOperations,
	});

	if (typeof pi.registerTool === "function") {
		pi.registerTool({
			...baseBashTool,
			promptGuidelines: [
				...(baseBashTool.promptGuidelines || []),
				"When a command is backgrounded by the user, it is actively running in the background. Inform the user that the command is running in the background with its Task ID, and do not state that it has finished.",
			],
			async execute(id, params, signal, onUpdate, ctx) {
				if (ctx) {
					currentSessionCtx = ctx;
				}
				try {
					ctx?.ui?.setWorkingMessage?.("Working (ctrl+b to run in background · Esc to cancel)");
					return await baseBashTool.execute(id, params, signal, onUpdate, ctx);
				} finally {
					ctx?.ui?.setWorkingMessage?.(undefined);
				}
			},
			renderResult(result, options, theme, context) {
				const safeContext = context ? ((context as any).state ? context : { ...context, state: {} }) : ({ state: {} } as any);
				const comp = baseBashTool.renderResult!(result as any, options, theme, safeContext);
				if (options.isPartial && comp) {
					applyElapsedHint(comp, theme);
				}
				return comp;
			},
		});
	}

	// ─── user_bash hook ───────────────────────────────────────────────────────

	pi.on("user_bash", async (_event, ctx) => {
		currentSessionCtx = ctx;
		const sessionId = ctx.sessionManager?.getSessionId?.() || "default";
		const operations = createBackgroundableOperations(ctx, taskManager, sessionId);
		return { operations };
	});

	pi.on("agent_start", async (_event, ctx) => {
		currentSessionCtx = ctx;
	});

	// ─── Terminal Input Hook (Ctrl+B & Down Arrow Selection) ──────────────────

	pi.on("session_start", async (_event, ctx) => {
		currentSessionCtx = ctx;
		setOnBadgeClick(() => {
			void showTasksUI(ctx);
		});

		if (ctx.hasUI && typeof ctx.ui.onTerminalInput === "function") {
			ctx.ui.onTerminalInput((data: string) => {
				const runningCount = taskManager.getRunningTasks().length;

				// Check for SGR mouse moves/clicks to detect moving outside the badge
				const sgrMatch = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
				if (sgrMatch) {
					if (getIsBadgeHovered()) {
						const screenX = Number.parseInt(sgrMatch[2], 10) - 1;
						const screenY = Number.parseInt(sgrMatch[3], 10) - 1;
						const bounds = getBadgeBounds();
						const footerY =
							getLastFooterScreenY() ??
							(process.stdout.rows ? process.stdout.rows - 2 : null);
						const badgeY = footerY !== null ? footerY + 1 : null;
						if (
							bounds &&
							badgeY !== null &&
							(screenY !== badgeY || screenX < bounds.startX || screenX > bounds.endX)
						) {
							setIsBadgeHovered(false);
							updateFooterBadge(ctx, taskManager);
						}
					}
					return undefined;
				}

				// 1. Ctrl+B foreground detachment
				const isCtrlB =
					matchesKey(data, "ctrl+b") ||
					matchesKey(data, Key.ctrl("b")) ||
					data === "\x02";

				if (isCtrlB) {
					const active = taskManager.getActiveForeground();
					if (!active) {
						// Pass through to editor (moves cursor left)
						return undefined;
					}

					// Check maximum concurrent tasks
					if (runningCount >= MAX_CONCURRENT_BACKGROUND_TASKS) {
						ctx.ui.notify(
							`Maximum concurrent background tasks (${MAX_CONCURRENT_BACKGROUND_TASKS}) reached. Stop a task with /cancel <id> before backgrounding another.`,
							"warning",
						);
						return { consume: true };
					}

					// Detach foreground task
					taskManager.detachActiveForeground();
					return { consume: true };
				}

				// 2. Background task footer navigation (Claude Code style)
				if (runningCount === 0) {
					if (getIsFooterSelected() || getIsBadgeHovered()) {
						setIsFooterSelected(false);
						setIsBadgeHovered(false);
						updateFooterBadge(ctx, taskManager);
					}
					return undefined;
				}

				// When not selected: Down arrow on empty editor selects the badge
				if (!getIsFooterSelected()) {
					const isDown =
						matchesKey(data, "down") ||
						data === "\x1b[B" ||
						data === "\x1bOB";
					const editorText = ctx.ui.getEditorText ? ctx.ui.getEditorText() : "";
					if (isDown && editorText.trim() === "") {
						setIsFooterSelected(true);
						updateFooterBadge(ctx, taskManager);
						return { consume: true };
					}
					return undefined;
				}

				// When selected:
				// Enter opens /tasks
				const isEnter =
					matchesKey(data, "enter") ||
					matchesKey(data, "return") ||
					data === "\r" ||
					data === "\n";
				if (isEnter) {
					setIsFooterSelected(false);
					updateFooterBadge(ctx, taskManager);
					void showTasksUI(ctx);
					return { consume: true };
				}

				// Up or Escape deselects
				const isUp =
					matchesKey(data, "up") ||
					data === "\x1b[A" ||
					data === "\x1bOA";
				const isEscape =
					matchesKey(data, "escape") ||
					matchesKey(data, "esc") ||
					data === "\x1b";
				if (isUp || isEscape) {
					setIsFooterSelected(false);
					updateFooterBadge(ctx, taskManager);
					return { consume: true };
				}

				// Down arrow while selected consumes to avoid unwanted navigation
				const isDown =
					matchesKey(data, "down") ||
					data === "\x1b[B" ||
					data === "\x1bOB";
				if (isDown) {
					return { consume: true };
				}

				// Any other character typed: deselect and let input pass through to editor
				setIsFooterSelected(false);
				updateFooterBadge(ctx, taskManager);
				return undefined;
			});
		}
	});

	// ─── User Commands ────────────────────────────────────────────────────────

	let isShowingTasksUI = false;

	async function showTasksUI(
		ctx: ExtensionCommandContext | ExtensionContext,
		targetTaskId?: string,
	): Promise<void> {
		if (isShowingTasksUI) return;
		isShowingTasksUI = true;
		try {
			if (ctx.mode !== "tui" || typeof (ctx.ui as any)?.custom !== "function") {
				const tasks = taskManager.getAllTasks();
				if (tasks.length === 0) {
					ctx.ui.notify("No shell tasks in this session.", "info");
					return;
				}
				const summary = tasks
					.map(
						(t) =>
							`[${t.id}] ${t.status} (${formatRuntime((t.endTime ?? Date.now()) - t.startTime)}): ${t.command}`,
					)
					.join("\n");
				ctx.ui.notify(`Shell tasks:\n${summary}`, "info");
				return;
			}

			const allTasks = taskManager.getAllTasks();
			if (allTasks.length === 0) {
				ctx.ui.notify("No shell tasks in this session.", "info");
				return;
			}

			await (ctx.ui as any).custom(
				(
					tui: TUI,
					theme: Theme,
					_kb: any,
					done: (res: null) => void,
				) => {
					return createTasksModalComponent(
						taskManager,
						targetTaskId || null,
						tui,
						theme,
						done,
					);
				},
			);

			updateFooterBadge(ctx, taskManager);
		} finally {
			isShowingTasksUI = false;
		}
	}

	pi.registerCommand("tasks", {
		description: "View and manage running and completed background shell tasks",
		handler: async (args, ctx) => {
			const targetId = args?.trim() || undefined;
			await showTasksUI(ctx, targetId);
		},
	});

	pi.registerCommand("bashes", {
		description: "Alias for /tasks",
		handler: async (args, ctx) => {
			const targetId = args?.trim() || undefined;
			await showTasksUI(ctx, targetId);
		},
	});

	async function handleCancelCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const trimmed = args?.trim();
		if (!trimmed) {
			const running = taskManager.getRunningTasks();
			if (running.length === 1) {
				const task = running[0];
				taskManager.stopTask(task.id);
				updateFooterBadge(ctx, taskManager);
				ctx.ui.notify(`Task ${task.id} stopped.`, "info");
				return;
			}
			ctx.ui.notify("Usage: /cancel <task-id>", "warning");
			return;
		}

		const task = taskManager.findTask(trimmed);
		if (!task) {
			ctx.ui.notify(`No task matching "${trimmed}".`, "error");
			return;
		}

		if (task.status !== "running") {
			ctx.ui.notify(`Task ${task.id} is already ${task.status}.`, "warning");
			return;
		}

		taskManager.stopTask(task.id);
		updateFooterBadge(ctx, taskManager);
		ctx.ui.notify(`Task ${task.id} stopped.`, "info");
	}

	pi.registerCommand("cancel", {
		description: "Cancel a running background shell task by ID",
		handler: async (args, ctx) => {
			await handleCancelCommand(args, ctx);
		},
	});

	pi.registerCommand("kill", {
		description: "Alias for /cancel",
		handler: async (args, ctx) => {
			await handleCancelCommand(args, ctx);
		},
	});

	// ─── Session Shutdown Cleanup ─────────────────────────────────────────────

	pi.on("session_shutdown", async () => {
		stopAnsweringBusyQuery?.();
		unpatchBashExecutionComponent();
		unpatchFooterComponent();
		taskManager.stopAllTasks();
		setActiveTaskManager(null);
		setIsFooterSelected(false);
		setIsBadgeHovered(false);
		setOnBadgeClick(null);
	});
}

export default rbfBackgroundTasks;
