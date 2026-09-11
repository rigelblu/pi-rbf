import {
	FooterComponent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	isKeyRelease,
	isKeyRepeat,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ─── Types & Constants ────────────────────────────────────────────────────────

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
	id: number;
	text: string;
	status: TodoStatus;
}

export interface TodoToolDetails {
	action: "add" | "update" | "list" | "clear" | "toggle";
	todos: TodoItem[];
	nextId: number;
	item?: TodoItem;
	error?: string;
}

export interface BadgeBounds {
	y: number;
	startX: number;
	endX: number;
}

export const WIDGET_KEY = "todos";
export const STATUS_KEY = "todos";
export const SHORTCUT_KEY = "alt+t";
export const COMMAND_NAME = "todos";
export const TOOL_NAME = "todo";
export const SESSION_CUSTOM_TYPE = "rbf-todos";
export const MAX_VISIBLE_WIDGET_ITEMS = 5;

const FOOTER_TODOS_PATCHED_KEY = Symbol.for("@earendil-works/pi-rbf:footer-todos-patched");
const ORIGINAL_FOOTER_RENDER_KEY = Symbol.for("@earendil-works/pi-rbf:original-todos-footer-render");
const ORIGINAL_FOOTER_HANDLE_MOUSE_KEY = Symbol.for("@earendil-works/pi-rbf:original-todos-footer-handle-mouse");

const FALLBACK_THEME = {
	fg: (_name: string, str: string) => str,
	bold: (str: string) => str,
	inverse: (str: string) => str,
};

export function getActiveTheme(): any {
	return (
		(typeof globalThis !== "undefined"
			? (globalThis as any)[Symbol.for("@earendil-works/pi-coding-agent:theme")] ??
				(globalThis as any)[Symbol.for("@mariozechner/pi-coding-agent:theme")]
			: undefined) ?? FALLBACK_THEME
	);
}

let activeTodoManager: TodoManager | null = null;
let activeGetIsHovered: (() => boolean) | null = null;
let isBadgeHovered = false;
let currentBadgeBounds: BadgeBounds | null = null;
let lastFooterScreenY: number | null = null;
let onBadgeClickHandler: (() => void) | null = null;

export function getIsBadgeHovered(): boolean {
	return isBadgeHovered;
}

export function setIsBadgeHovered(hovered: boolean): void {
	isBadgeHovered = hovered;
}

export function getBadgeBounds(): BadgeBounds | null {
	return currentBadgeBounds;
}

export function getLastFooterScreenY(): number | null {
	return lastFooterScreenY;
}

export function setLastFooterScreenY(screenY: number | null): void {
	lastFooterScreenY = screenY;
}

/**
 * Injects todo progress badge directly into the stats line (lines[1])
 * to the right of stats and (auto).
 */
export function formatStatsLineWithTodos(
	statsLine: string,
	completedCount: number,
	totalCount: number,
	isSelected: boolean,
	width: number,
	theme: any,
): string {
	if (totalCount <= 0 || !statsLine) return statsLine;

	const badgeText = `📋 ${completedCount}/${totalCount}`;
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

/**
 * Calculates the horizontal hit-box bounds for the todos badge in lines[1].
 */
export function calculateBadgeBounds(
	statsLine: string,
	completedCount: number,
	totalCount: number,
	width: number,
): BadgeBounds | null {
	if (totalCount <= 0 || !statsLine) return null;

	const badgeText = `📋 ${completedCount}/${totalCount}`;
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

export function patchFooterComponent(
	todoManager?: TodoManager,
	getIsHovered?: () => boolean,
	onBadgeClick?: () => void,
): boolean {
	if (typeof FooterComponent === "undefined" || !FooterComponent.prototype) {
		return false;
	}
	if (todoManager) {
		activeTodoManager = todoManager;
	}
	if (getIsHovered) {
		activeGetIsHovered = getIsHovered;
	}
	if (onBadgeClick) {
		onBadgeClickHandler = onBadgeClick;
	}
	if ((FooterComponent.prototype as any)[FOOTER_TODOS_PATCHED_KEY]) {
		return true;
	}

	const originalRender = FooterComponent.prototype.render;
	(FooterComponent.prototype as any)[ORIGINAL_FOOTER_RENDER_KEY] = originalRender;
	const originalHandleMouse = (FooterComponent.prototype as any).handleMouse;
	if (originalHandleMouse) {
		(FooterComponent.prototype as any)[ORIGINAL_FOOTER_HANDLE_MOUSE_KEY] = originalHandleMouse;
	}
	(FooterComponent.prototype as any)[FOOTER_TODOS_PATCHED_KEY] = true;

	FooterComponent.prototype.render = function (this: any, width: number): string[] {
		const lines = originalRender.call(this, width);
		if (!lines || lines.length < 2) {
			currentBadgeBounds = null;
			return lines;
		}

		const tm = activeTodoManager;
		if (!tm) {
			currentBadgeBounds = null;
			return lines;
		}

		const { total, completed } = tm.getCounts();
		if (total <= 0) {
			currentBadgeBounds = null;
			return lines;
		}

		const theme = this.session?.theme ?? getActiveTheme();
		const hovered = activeGetIsHovered ? activeGetIsHovered() : isBadgeHovered;

		currentBadgeBounds = calculateBadgeBounds(lines[1], completed, total, width);
		lines[1] = formatStatsLineWithTodos(lines[1], completed, total, hovered, width, theme);

		return lines;
	};

	(FooterComponent.prototype as any).handleMouse = function (
		this: any,
		event: TuiMouseEvent,
	): TuiMouseEventResult | undefined {
		const orig = (FooterComponent.prototype as any)[ORIGINAL_FOOTER_HANDLE_MOUSE_KEY];
		const origResult = orig ? orig.call(this, event) : undefined;
		if (origResult?.handled) {
			return origResult;
		}

		const tm = activeTodoManager;
		if (!tm || tm.getCounts().total === 0) {
			if (isBadgeHovered) {
				isBadgeHovered = false;
				return { handled: true, render: true };
			}
			return origResult;
		}

		const bounds = currentBadgeBounds;
		if (!bounds) {
			return origResult;
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
			return origResult;
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

		return origResult;
	};

	return true;
}

export function unpatchFooterComponent(): void {
	if (typeof FooterComponent === "undefined" || !FooterComponent.prototype) {
		return;
	}
	if ((FooterComponent.prototype as any)[FOOTER_TODOS_PATCHED_KEY]) {
		const originalRender = (FooterComponent.prototype as any)[ORIGINAL_FOOTER_RENDER_KEY];
		if (originalRender) {
			FooterComponent.prototype.render = originalRender;
		}
		const originalHandleMouse = (FooterComponent.prototype as any)[ORIGINAL_FOOTER_HANDLE_MOUSE_KEY];
		if (originalHandleMouse) {
			(FooterComponent.prototype as any).handleMouse = originalHandleMouse;
		} else {
			delete (FooterComponent.prototype as any).handleMouse;
		}
		delete (FooterComponent.prototype as any)[ORIGINAL_FOOTER_RENDER_KEY];
		delete (FooterComponent.prototype as any)[ORIGINAL_FOOTER_HANDLE_MOUSE_KEY];
		delete (FooterComponent.prototype as any)[FOOTER_TODOS_PATCHED_KEY];
	}
	activeTodoManager = null;
	activeGetIsHovered = null;
	isBadgeHovered = false;
	currentBadgeBounds = null;
	lastFooterScreenY = null;
	onBadgeClickHandler = null;
}

// ─── TodoManager ─────────────────────────────────────────────────────────────

/**
 * Pure manager encapsulating todo list state, transitions, formatting, and branch restoration.
 */
export class TodoManager {
	private todos: TodoItem[] = [];
	private nextId = 1;
	private widgetVisible = true;
	private collapsed = false;

	constructor(initialTodos?: TodoItem[], initialNextId?: number) {
		if (initialTodos) {
			this.todos = initialTodos.map((t) => ({ ...t }));
			this.nextId =
				initialNextId ??
				(initialTodos.length > 0
					? Math.max(...initialTodos.map((t) => t.id)) + 1
					: 1);
		}
	}

	getTodos(): TodoItem[] {
		return this.todos.map((t) => ({ ...t }));
	}

	getNextId(): number {
		return this.nextId;
	}

	isWidgetVisible(): boolean {
		return this.widgetVisible;
	}

	setWidgetVisible(visible: boolean): void {
		this.widgetVisible = visible;
	}

	toggleWidgetVisible(): boolean {
		this.widgetVisible = !this.widgetVisible;
		return this.widgetVisible;
	}

	isCollapsed(): boolean {
		return this.collapsed;
	}

	setCollapsed(collapsed: boolean): void {
		this.collapsed = collapsed;
	}

	getCounts(): { total: number; completed: number; inProgress: number; pending: number } {
		const total = this.todos.length;
		let completed = 0;
		let inProgress = 0;
		let pending = 0;
		for (const item of this.todos) {
			if (item.status === "completed") completed++;
			else if (item.status === "in_progress") inProgress++;
			else pending++;
		}
		return { total, completed, inProgress, pending };
	}

	allCompleted(): boolean {
		return this.todos.length > 0 && this.todos.every((t) => t.status === "completed");
	}

	add(text: string): TodoItem {
		const trimmed = (text || "").trim();
		if (!trimmed) {
			throw new Error("Todo text cannot be empty");
		}
		const item: TodoItem = {
			id: this.nextId++,
			text: trimmed,
			status: "pending",
		};
		this.todos.push(item);
		this.collapsed = false;
		return { ...item };
	}

	update(id: number, updates: { text?: string; status?: TodoStatus }): TodoItem | undefined {
		const item = this.todos.find((t) => t.id === id);
		if (!item) return undefined;

		if (updates.text !== undefined) {
			const trimmed = updates.text.trim();
			if (trimmed) item.text = trimmed;
		}

		if (updates.status !== undefined) {
			item.status = updates.status;
			if (item.status !== "completed") {
				this.collapsed = false;
			}
		}

		return { ...item };
	}

	toggle(id: number): TodoItem | undefined {
		const item = this.todos.find((t) => t.id === id);
		if (!item) return undefined;

		// Cycle status: pending -> in_progress -> completed -> pending
		if (item.status === "pending") {
			item.status = "in_progress";
		} else if (item.status === "in_progress") {
			item.status = "completed";
		} else {
			item.status = "pending";
		}

		if (item.status !== "completed") {
			this.collapsed = false;
		}

		return { ...item };
	}

	clear(): void {
		this.todos = [];
		this.nextId = 1;
		this.collapsed = false;
	}

	clearCompleted(): void {
		this.todos = this.todos.filter((t) => t.status !== "completed");
		if (this.todos.length === 0) {
			this.collapsed = false;
		}
	}

	/**
	 * Auto-collapses the widget on user prompt submission if all todos are completed.
	 * Returns true if the widget transitioned from expanded to collapsed.
	 */
	handleUserPromptSubmit(): boolean {
		if (this.todos.length > 0 && this.allCompleted() && !this.collapsed) {
			this.collapsed = true;
			return true;
		}
		return false;
	}

	/**
	 * Reconstruct state from session entries in chronological order.
	 */
	reconstructFromSession(entries: any[]): void {
		let latestTodos: TodoItem[] | null = null;
		let latestNextId = 1;

		if (Array.isArray(entries)) {
			for (const entry of entries) {
				if (!entry) continue;

				// 1. Tool result message details
				if (entry.type === "message" && entry.message) {
					const msg = entry.message;
					if (
						msg.role === "toolResult" &&
						(msg.toolName === TOOL_NAME || msg.toolName === "todos") &&
						msg.details
					) {
						const d = msg.details;
						if (Array.isArray(d.todos)) {
							latestTodos = d.todos.map((t: any) => ({
								id: Number(t.id),
								text: String(t.text || ""),
								status: (t.status === "completed" || t.status === "in_progress" ? t.status : "pending") as TodoStatus,
							}));
							if (typeof d.nextId === "number") {
								latestNextId = d.nextId;
							}
						}
					}
				}

				// 2. Custom entry
				if (entry.type === "custom" && entry.customType === SESSION_CUSTOM_TYPE && entry.data) {
					const data = entry.data;
					if (Array.isArray(data.todos)) {
						latestTodos = data.todos.map((t: any) => ({
							id: Number(t.id),
							text: String(t.text || ""),
							status: (t.status === "completed" || t.status === "in_progress" ? t.status : "pending") as TodoStatus,
						}));
						if (typeof data.nextId === "number") {
							latestNextId = data.nextId;
						}
					}
				}
			}
		}

		if (latestTodos !== null) {
			this.todos = latestTodos;
			this.nextId = Math.max(
				latestNextId,
				this.todos.length > 0 ? Math.max(...this.todos.map((t) => t.id)) + 1 : 1,
			);
			this.collapsed = false;
		} else {
			this.todos = [];
			this.nextId = 1;
			this.collapsed = false;
		}
	}

	/**
	 * Formats monospace boxed lines for ctx.ui.setWidget().
	 * Returns undefined if hidden, collapsed, or empty.
	 */
	formatWidgetLines(theme?: Theme, maxWidth = 80): string[] | undefined {
		if (!this.widgetVisible || this.collapsed || this.todos.length === 0) {
			return undefined;
		}

		const { total, completed } = this.getCounts();
		const boxWidth = Math.min(Math.max(40, maxWidth), 90);
		const contentWidth = boxWidth - 5; // 3 chars left ("│  ") + 2 chars right (" │")

		const lines: string[] = [];

		// Header top border: ┌─ Todos (X/Y completed) ────────┐
		const headerTitle = " Todos ";
		const countText = `(${completed}/${total} completed) `;
		const titleVisibleWidth = visibleWidth(headerTitle) + visibleWidth(countText);
		const topFill = Math.max(0, boxWidth - 3 - titleVisibleWidth);

		const styledBorderLeft = theme ? theme.fg("borderAccent", "┌─") : "┌─";
		const styledHeader = theme ? theme.bold(theme.fg("borderAccent", headerTitle)) : headerTitle;
		const styledCount = theme ? theme.fg("muted", countText) : countText;
		const styledBorderRight = theme
			? theme.fg("borderAccent", `${"─".repeat(topFill)}┐`)
			: `${"─".repeat(topFill)}┐`;
		lines.push(`${styledBorderLeft}${styledHeader}${styledCount}${styledBorderRight}`);

		// Up to MAX_VISIBLE_WIDGET_ITEMS
		const visibleSlice = this.todos.slice(0, MAX_VISIBLE_WIDGET_ITEMS);

		for (const item of visibleSlice) {
			let statusStyled = "";
			if (item.status === "completed") {
				if (theme) {
					const styledIcon = theme.fg("success", "✓");
					const styledText = theme.fg("dim", `#${item.id} ${item.text}`);
					statusStyled = `${styledIcon} ${styledText}`;
				} else {
					statusStyled = `✓ #${item.id} ${item.text}`;
				}
			} else if (item.status === "in_progress") {
				if (theme) {
					const styledIcon = theme.fg("accent", "⠸");
					const styledId = theme.bold(`#${item.id}`);
					const styledText = theme.fg("accent", item.text);
					statusStyled = `${styledIcon} ${styledId} ${styledText}`;
				} else {
					statusStyled = `⠸ #${item.id} ${item.text}`;
				}
			} else {
				// pending
				if (theme) {
					const styledIcon = theme.fg("muted", "○");
					const styledId = theme.fg("muted", `#${item.id}`);
					statusStyled = `${styledIcon} ${styledId} ${item.text}`;
				} else {
					statusStyled = `○ #${item.id} ${item.text}`;
				}
			}

			const truncated = truncateToWidth(statusStyled, contentWidth);
			const padding = Math.max(0, contentWidth - visibleWidth(truncated));
			const leftBorder = theme ? theme.fg("borderAccent", "│  ") : "│  ";
			const rightBorder = theme ? theme.fg("borderAccent", " │") : " │";
			lines.push(`${leftBorder}${truncated}${" ".repeat(padding)}${rightBorder}`);
		}

		// Overflow notice
		if (this.todos.length > MAX_VISIBLE_WIDGET_ITEMS) {
			const overflowCount = this.todos.length - MAX_VISIBLE_WIDGET_ITEMS;
			const overflowText = `… and ${overflowCount} more (type /todos to view all)`;
			const styledOverflow = theme ? theme.fg("muted", overflowText) : overflowText;
			const truncated = truncateToWidth(styledOverflow, contentWidth);
			const padding = Math.max(0, contentWidth - visibleWidth(truncated));
			const leftBorder = theme ? theme.fg("borderAccent", "│  ") : "│  ";
			const rightBorder = theme ? theme.fg("borderAccent", " │") : " │";
			lines.push(`${leftBorder}${truncated}${" ".repeat(padding)}${rightBorder}`);
		}

		// Bottom border: └─────────────────────────┘
		const bottomBorder = `└${"─".repeat(boxWidth - 2)}┘`;
		lines.push(theme ? theme.fg("borderAccent", bottomBorder) : bottomBorder);

		return lines;
	}

	/**
	 * Formats footer status line badge: 📋 X/Y
	 * Returns undefined if no todos exist.
	 */
	formatFooterStatus(theme?: Theme): string | undefined {
		if (this.todos.length === 0) return undefined;
		const { total, completed } = this.getCounts();
		const raw = `📋 ${completed}/${total}`;
		if (theme) {
			return theme.fg("accent", raw);
		}
		return raw;
	}
}

// ─── UI Synchronizer ──────────────────────────────────────────────────────────

/**
 * Synchronizes the TodoManager state with Pi's widget and footer status.
 */
export function updateExtensionUI(
	ctx: ExtensionContext | ExtensionCommandContext | undefined,
	todoManager: TodoManager,
): void {
	if (!ctx || !ctx.ui) return;
	const theme = ctx.ui.theme;
	const cols = (process.stdout && typeof process.stdout.columns === "number" && process.stdout.columns > 0)
		? process.stdout.columns
		: 80;

	// 1. Above-editor widget
	const widgetLines = todoManager.formatWidgetLines(theme, cols - 4);
	try {
		ctx.ui.setWidget?.(WIDGET_KEY, widgetLines, { placement: "aboveEditor" });
	} catch {
		// Ignore if unsupported
	}

	// 2. Clear line 3 footer status (status badge is rendered directly in stats line 1 via patched FooterComponent)
	try {
		ctx.ui.setStatus?.(STATUS_KEY, undefined);
	} catch {
		// Ignore if unsupported
	}

	// 3. Request render so the patched footer stats line updates immediately
	try {
		(ctx.ui as any).requestRender?.();
	} catch {
		// Ignore if unsupported
	}
}

// ─── Interactive Modal Component ──────────────────────────────────────────────

/**
 * Full-screen modal viewer for /todos registered via ctx.ui.custom().
 */
export function createTodoListModalComponent(
	todoManager: TodoManager,
	tui: TUI,
	theme: Theme,
	done: (res: null) => void,
	ctx?: ExtensionCommandContext | ExtensionContext,
): Component & { dispose?(): void } {
	let selectedIndex = 0;
	let scrollOffset = 0;
	const visibleLines = 12;

	function clampIndex(): void {
		const todos = todoManager.getTodos();
		if (todos.length === 0) {
			selectedIndex = 0;
		} else {
			if (selectedIndex < 0) selectedIndex = 0;
			if (selectedIndex >= todos.length) selectedIndex = todos.length - 1;
		}
	}

	function render(width: number): string[] {
		clampIndex();
		const todos = todoManager.getTodos();
		const { total, completed } = todoManager.getCounts();
		const lines: string[] = [];

		lines.push("");
		lines.push(
			theme.bold(theme.fg("borderAccent", " Todos")) +
				(total > 0 ? theme.fg("muted", ` (${completed}/${total} completed)`) : ""),
		);
		lines.push("");

		if (todos.length === 0) {
			lines.push("  (no todos in this session)");
			lines.push("");
			lines.push(theme.fg("muted", "  Esc to close"));
			return lines;
		}

		if (selectedIndex < scrollOffset) {
			scrollOffset = selectedIndex;
		} else if (selectedIndex >= scrollOffset + visibleLines) {
			scrollOffset = selectedIndex - visibleLines + 1;
		}

		const visibleSlice = todos.slice(scrollOffset, scrollOffset + visibleLines);

		for (let i = 0; i < visibleSlice.length; i++) {
			const itemIndex = scrollOffset + i;
			const item = visibleSlice[i];
			const isSelected = itemIndex === selectedIndex;
			const cursor = isSelected ? theme.fg("accent", "❯ ") : "  ";

			let statusIcon = "○";
			let statusColor = "muted";
			if (item.status === "completed") {
				statusIcon = "✓";
				statusColor = "success";
			} else if (item.status === "in_progress") {
				statusIcon = "⠸";
				statusColor = "accent";
			}

			const iconStr = theme.fg(statusColor as any, statusIcon);
			const idStr = isSelected ? theme.bold(`#${item.id}`) : theme.fg("muted", `#${item.id}`);
			let textStr = item.text;
			if (item.status === "completed") {
				textStr = theme.fg("dim", item.text);
			} else if (item.status === "in_progress") {
				textStr = theme.fg("accent", item.text);
			}

			const rowText = `${cursor}${iconStr} ${idStr} ${textStr}`;
			lines.push(truncateToWidth(rowText, Math.max(10, width - 2)));
		}

		if (todos.length > visibleLines) {
			lines.push(
				theme.fg(
					"dim",
					`  showing ${scrollOffset + 1}-${Math.min(scrollOffset + visibleLines, todos.length)} of ${todos.length}`,
				),
			);
		}

		lines.push("");
		lines.push(
			theme.fg("muted", "  ↑/↓ navigate · Space toggle · c clear completed · Esc close"),
		);
		lines.push("");

		return lines;
	}

	function handleInput(data: string): void {
		if (
			data === "q" ||
			data === "Q" ||
			data === "\x1b" ||
			data === "escape" ||
			matchesKey(data, Key.escape)
		) {
			done(null);
			return;
		}

		const todos = todoManager.getTodos();

		// Up / k
		if (
			data === "up" ||
			data === "k" ||
			data === "\x1b[A" ||
			data === "\x1bOA" ||
			matchesKey(data, Key.up)
		) {
			if (selectedIndex > 0) {
				selectedIndex--;
				tui.requestRender();
			}
			return;
		}

		// Down / j
		if (
			data === "down" ||
			data === "j" ||
			data === "\x1b[B" ||
			data === "\x1bOB" ||
			matchesKey(data, Key.down)
		) {
			if (selectedIndex < todos.length - 1) {
				selectedIndex++;
				tui.requestRender();
			}
			return;
		}

		// Space / Enter: toggle status of selected item
		if (
			data === " " ||
			data === "space" ||
			data === "\r" ||
			data === "\n" ||
			data === "enter" ||
			matchesKey(data, Key.space) ||
			matchesKey(data, Key.enter)
		) {
			if (todos.length > 0 && selectedIndex >= 0 && selectedIndex < todos.length) {
				const item = todos[selectedIndex];
				todoManager.toggle(item.id);
				if (ctx) {
					updateExtensionUI(ctx, todoManager);
					(ctx as any).sessionManager?.appendCustomEntry?.(SESSION_CUSTOM_TYPE, {
						todos: todoManager.getTodos(),
						nextId: todoManager.getNextId(),
					});
				}
				tui.requestRender();
			}
			return;
		}

		// c: clear completed items
		if (data === "c" || data === "C") {
			todoManager.clearCompleted();
			clampIndex();
			if (ctx) {
				updateExtensionUI(ctx, todoManager);
				(ctx as any).sessionManager?.appendCustomEntry?.(SESSION_CUSTOM_TYPE, {
					todos: todoManager.getTodos(),
					nextId: todoManager.getNextId(),
				});
			}
			tui.requestRender();
			return;
		}
	}

	return {
		render,
		handleInput,
		invalidate() {},
		dispose() {},
	};
}

// ─── Todo Tool Definition ─────────────────────────────────────────────────────

export const TodoParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("add"),
			Type.Literal("update"),
			Type.Literal("list"),
			Type.Literal("clear"),
			Type.Literal("toggle"),
		],
		{
			description:
				"The action to perform on the todo checklist: 'add' (new item), 'update' (modify status or text), 'list' (view items), 'clear' (remove all), or 'toggle' (cycle status).",
		},
	),
	text: Type.Optional(
		Type.String({
			description: "Description of the todo item (required for 'add', optional for 'update').",
		}),
	),
	id: Type.Optional(
		Type.Number({
			description: "ID of the todo item to update or toggle (required for 'update' and 'toggle').",
		}),
	),
	status: Type.Optional(
		Type.Union(
			[Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")],
			{
				description:
					"New status for the todo item ('pending', 'in_progress', 'completed'). Used with action 'update'.",
			},
		),
	),
});

export function createTodoToolDefinition(
	todoManager: TodoManager,
): ToolDefinition<typeof TodoParams, TodoToolDetails> {
	return {
		name: TOOL_NAME,
		label: "Todo",
		description:
			"Manage the session progress checklist. Use this tool to track multi-step goals, record pending steps, update active steps to in_progress, and mark completed steps.",
		parameters: TodoParams,
		executionMode: "sequential" as const,
		promptGuidelines: [
			"For non-trivial multi-step tasks (3 or more steps), plan your work upfront by adding todo items using the `todo` tool.",
			"Before beginning work on a step, update its status to `in_progress`.",
			"When a step is complete, immediately update its status to `completed`.",
			"Keep todo item descriptions concise, unambiguous, and actionable.",
		],

		async execute(
			_id: string,
			params: {
				action: "add" | "update" | "list" | "clear" | "toggle";
				text?: string;
				id?: number;
				status?: TodoStatus;
			},
			_signal: AbortSignal,
			_onUpdate: any,
			ctx: ExtensionContext,
		) {
			let resultText = "";
			let item: TodoItem | undefined;

			switch (params.action) {
				case "add": {
					if (!params.text || !params.text.trim()) {
						return {
							content: [
								{
									type: "text" as const,
									text: "Error: 'text' parameter is required for action 'add'.",
								},
							],
							details: {
								action: "add" as const,
								todos: todoManager.getTodos(),
								nextId: todoManager.getNextId(),
								error: "Missing text parameter",
							},
							isError: true,
						};
					}
					item = todoManager.add(params.text);
					resultText = `Added todo #${item.id}: "${item.text}"`;
					break;
				}
				case "update": {
					if (typeof params.id !== "number") {
						return {
							content: [
								{
									type: "text" as const,
									text: "Error: 'id' parameter is required for action 'update'.",
								},
							],
							details: {
								action: "update" as const,
								todos: todoManager.getTodos(),
								nextId: todoManager.getNextId(),
								error: "Missing id parameter",
							},
							isError: true,
						};
					}
					if (params.status === undefined && params.text === undefined) {
						return {
							content: [
								{
									type: "text" as const,
									text: "Error: at least one of 'status' or 'text' must be provided for action 'update'.",
								},
							],
							details: {
								action: "update" as const,
								todos: todoManager.getTodos(),
								nextId: todoManager.getNextId(),
								error: "Missing status or text parameter",
							},
							isError: true,
						};
					}
					item = todoManager.update(params.id, { text: params.text, status: params.status });
					if (!item) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Error: todo #${params.id} not found.`,
								},
							],
							details: {
								action: "update" as const,
								todos: todoManager.getTodos(),
								nextId: todoManager.getNextId(),
								error: `Todo #${params.id} not found`,
							},
							isError: true,
						};
					}
					resultText = `Updated todo #${item.id} [${item.status}]: "${item.text}"`;
					break;
				}
				case "toggle": {
					if (typeof params.id !== "number") {
						return {
							content: [
								{
									type: "text" as const,
									text: "Error: 'id' parameter is required for action 'toggle'.",
								},
							],
							details: {
								action: "toggle" as const,
								todos: todoManager.getTodos(),
								nextId: todoManager.getNextId(),
								error: "Missing id parameter",
							},
							isError: true,
						};
					}
					item = todoManager.toggle(params.id);
					if (!item) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Error: todo #${params.id} not found.`,
								},
							],
							details: {
								action: "toggle" as const,
								todos: todoManager.getTodos(),
								nextId: todoManager.getNextId(),
								error: `Todo #${params.id} not found`,
							},
							isError: true,
						};
					}
					resultText = `Toggled todo #${item.id} to [${item.status}]: "${item.text}"`;
					break;
				}
				case "list": {
					const todos = todoManager.getTodos();
					if (todos.length === 0) {
						resultText = "No todos currently exist in this session.";
					} else {
						const { total, completed } = todoManager.getCounts();
						const header = `Todos (${completed}/${total} completed):\n`;
						const body = todos
							.map((t) => {
								const sym = t.status === "completed" ? "✓" : t.status === "in_progress" ? "⠸" : "○";
								return `  ${sym} #${t.id} [${t.status}] ${t.text}`;
							})
							.join("\n");
						resultText = header + body;
					}
					break;
				}
				case "clear": {
					todoManager.clear();
					resultText = "Cleared all todos.";
					break;
				}
			}

			// Synchronize UI and append session entry
			if (ctx) {
				updateExtensionUI(ctx, todoManager);
				(ctx as any).sessionManager?.appendCustomEntry?.(SESSION_CUSTOM_TYPE, {
					todos: todoManager.getTodos(),
					nextId: todoManager.getNextId(),
				});
			}

			return {
				content: [{ type: "text" as const, text: resultText }],
				details: {
					action: params.action,
					todos: todoManager.getTodos(),
					nextId: todoManager.getNextId(),
					item,
				},
			};
		},

		renderCall(args: any, theme: Theme) {
			let text = theme.fg("toolTitle", theme.bold("todo "));
			if (args.action === "add") {
				text += theme.fg("accent", "add ") + theme.fg("muted", JSON.stringify(args.text || ""));
			} else if (args.action === "update") {
				text += theme.fg("accent", `update #${args.id} `);
				if (args.status) text += theme.fg("dim", `[${args.status}] `);
				if (args.text) text += theme.fg("muted", JSON.stringify(args.text));
			} else if (args.action === "toggle") {
				text += theme.fg("accent", `toggle #${args.id}`);
			} else if (args.action === "list") {
				text += theme.fg("muted", "list");
			} else if (args.action === "clear") {
				text += theme.fg("muted", "clear");
			}
			return new Text(text, 0, 0);
		},

		renderResult(result: any, _options: any, theme: Theme) {
			const details = result.details as TodoToolDetails | undefined;
			if (!details) {
				const text = result.content?.[0]?.text || "";
				return new Text(theme.fg("muted", text), 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}

			if (details.action === "add" && details.item) {
				const icon = theme.fg("accent", "+ ");
				const desc =
					theme.fg("text", `Added todo #${details.item.id}: `) +
					theme.fg("muted", details.item.text);
				return new Text(icon + desc, 0, 0);
			}

			if (details.action === "update" && details.item) {
				let icon = "✓ ";
				let color = "success";
				if (details.item.status === "in_progress") {
					icon = "⠸ ";
					color = "accent";
				} else if (details.item.status === "pending") {
					icon = "○ ";
					color = "muted";
				}
				const styledIcon = theme.fg(color as any, icon);
				const desc =
					theme.fg("text", `Todo #${details.item.id} [${details.item.status}]: `) +
					theme.fg("muted", details.item.text);
				return new Text(styledIcon + desc, 0, 0);
			}

			if (details.action === "toggle" && details.item) {
				const icon = theme.fg("accent", "⇄ ");
				const desc =
					theme.fg("text", `Todo #${details.item.id} is now [${details.item.status}]: `) +
					theme.fg("muted", details.item.text);
				return new Text(icon + desc, 0, 0);
			}

			if (details.action === "clear") {
				return new Text(theme.fg("muted", "Cleared all todos"), 0, 0);
			}

			const firstText = result.content?.[0]?.text || "";
			return new Text(theme.fg("muted", firstText), 0, 0);
		},
	};
}

// ─── Extension Entry Point ───────────────────────────────────────────────────

export function rbfTodos(pi: ExtensionAPI): void {
	const todoManager = new TodoManager();
	activeTodoManager = todoManager;
	let currentContext: ExtensionContext | undefined;
	let lastToggleTime = 0;
	let terminalInputSubscribed = false;

	const handleToggleShortcut = (ctx?: ExtensionContext) => {
		const now = Date.now();
		if (now - lastToggleTime < 250) {
			return;
		}
		lastToggleTime = now;
		if (ctx) {
			currentContext = ctx;
		}
		todoManager.toggleWidgetVisible();
		if (currentContext) {
			updateExtensionUI(currentContext, todoManager);
		}
	};

	patchFooterComponent(
		todoManager,
		() => isBadgeHovered,
		() => {
			handleToggleShortcut(currentContext);
		},
	);

	// 1. Register model tool `todo`
	if (typeof pi.registerTool === "function") {
		pi.registerTool(createTodoToolDefinition(todoManager));
	}

	// 2. Register shortcut `Alt+T`
	if (typeof pi.registerShortcut === "function") {
		pi.registerShortcut(SHORTCUT_KEY, {
			description: "Toggle session todos checklist widget",
			handler: (ctx: ExtensionContext) => {
				handleToggleShortcut(ctx);
			},
		});
	}

	// 3. Register command `/todos`
	if (typeof pi.registerCommand === "function") {
		pi.registerCommand(COMMAND_NAME, {
			description: "View and manage session progress checklist",
			handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
				currentContext = ctx as any;
				if (ctx.mode !== "tui" || typeof (ctx.ui as any)?.custom !== "function") {
					const todos = todoManager.getTodos();
					if (todos.length === 0) {
						ctx.ui?.notify?.("No todos in this session.", "info");
						return;
					}
					const { total, completed } = todoManager.getCounts();
					const summary = todos
						.map((t) => {
							const sym = t.status === "completed" ? "✓" : t.status === "in_progress" ? "⠸" : "○";
							return `[${sym}] #${t.id} [${t.status}] ${t.text}`;
						})
						.join("\n");
					ctx.ui?.notify?.(`Todos (${completed}/${total}):\n${summary}`, "info");
					return;
				}

				await (ctx.ui as any).custom(
					(tui: TUI, theme: Theme, _keybindings: any, done: (res: null) => void) =>
						createTodoListModalComponent(todoManager, tui, theme, done, ctx),
				);
			},
		});
	}

	// 4. Listen to session_start (restore state from active branch)
	pi.on?.("session_start", async (_event: any, ctx: ExtensionContext) => {
		currentContext = ctx;
		const entries = ctx.sessionManager?.getEntries?.() || [];
		todoManager.reconstructFromSession(entries);
		updateExtensionUI(ctx, todoManager);

		// Raw terminal input fallback for Alt+T and SGR mouse tracking
		if (!terminalInputSubscribed && ctx.hasUI && typeof ctx.ui?.onTerminalInput === "function") {
			terminalInputSubscribed = true;
			ctx.ui.onTerminalInput((data: string) => {
				// SGR mouse handling: reset hover if moved outside badge bounds
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
							!bounds ||
							badgeY === null ||
							screenY !== badgeY ||
							screenX < bounds.startX ||
							screenX > bounds.endX
						) {
							setIsBadgeHovered(false);
							(ctx.ui as any)?.requestRender?.();
						}
					}
					return undefined;
				}

				if (matchesKey(data, SHORTCUT_KEY) || data === "\x1bt" || data === "†") {
					if (isKeyRelease(data) || isKeyRepeat(data)) {
						return { consume: true };
					}
					handleToggleShortcut(ctx);
					return { consume: true };
				}
				return undefined;
			});
		}
	});

	// 5. Listen to session_tree (restore state after tree navigation / rewind / fork)
	pi.on?.("session_tree", async (_event: any, ctx: ExtensionContext) => {
		currentContext = ctx;
		const entries = ctx.sessionManager?.getEntries?.() || [];
		todoManager.reconstructFromSession(entries);
		updateExtensionUI(ctx, todoManager);
	});

	// 6. Listen to before_agent_start (auto-collapse completed todos on next user prompt)
	pi.on?.("before_agent_start", async (_event: any, ctx: ExtensionContext) => {
		currentContext = ctx;
		const didCollapse = todoManager.handleUserPromptSubmit();
		if (didCollapse) {
			updateExtensionUI(ctx, todoManager);
		}
	});

	// Also listen to input in case before_agent_start is not triggered
	pi.on?.("input", async (_event: any, ctx: ExtensionContext) => {
		currentContext = ctx;
		const didCollapse = todoManager.handleUserPromptSubmit();
		if (didCollapse) {
			updateExtensionUI(ctx, todoManager);
		}
	});

	// 7. Cleanup patches on session shutdown
	pi.on?.("session_shutdown", async () => {
		unpatchFooterComponent();
	});
}

export default rbfTodos;
