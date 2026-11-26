import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { keyHint, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { sanitizeDisplayText } from "./agy-native.js";
import { AGY_ACP_PERMISSION, AGY_ACP_QUESTION } from "./agy-recovery.js";
import { wireLog, wireLogOn } from "./agy-wire-log.js";

export { AGY_ACP_PERMISSION, AGY_ACP_QUESTION };

export const ACP_APPROVAL_BOUNDS = Object.freeze({
	requestBytes: 64 * 1024,
	live: 8,
	reviewMs: 15 * 60_000,
});

export type PermissionOutcome =
	| { outcome: { outcome: "cancelled" } }
	| { outcome: { outcome: "selected"; optionId: string } };

export type AgyAcpApprovalReply = "allow_once" | "reject_once" | "cancelled";
export type AgyAcpApprovalReason = "user" | "turn-stopped" | "review-cap" | "unsafe";

export interface AgyAcpPermissionRecord {
	piSessionId: string;
	inputEntryId: string | null;
	acpSessionId: string;
	toolCallId: string;
	kind: string;
	title: string;
	command?: string;
	/** AGY asked to run this outside its own sandbox (`BypassSandbox: true`). Present only when it did. */
	bypassSandbox?: true;
	optionsOffered: string[];
	reply: AgyAcpApprovalReply;
	reason: AgyAcpApprovalReason;
}

export interface AgyAcpQuestionRecord {
	piSessionId: string;
	inputEntryId: string | null;
	acpSessionId: string;
	toolCallId: string;
	questions: string[];
	reply?: string;
	reason?: string;
	answers?: Record<string, unknown>;
}

export const ACP_QUESTION_ERROR_MESSAGE = "Pi could not show the question";
export const ACP_QUESTION_LINE = "AGY asked a question Pi can't show yet, so AGY asks it in the chat instead.";

const PERMISSION_UNAVAILABLE = "AGY permission record unavailable: saved record is invalid or unsupported.";
const QUESTION_UNAVAILABLE = "AGY question record unavailable: saved record is invalid or unsupported.";
const RECORD_ENVELOPE_BYTES = 192 * 1024;
const QUESTION_ITEM_MAX_BYTES = 2048;
const RECORD_TITLE_MAX_CHARS = 512;
const PERMISSION_COLLAPSE_CHARS = 200;
const CANCELLED: PermissionOutcome = Object.freeze({ outcome: Object.freeze({ outcome: "cancelled" as const }) });

function clampUtf8(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

type RecordValue = Record<string, unknown>;
const isObject = (value: unknown): value is RecordValue =>
	value !== null && typeof value === "object" && !Array.isArray(value);

// ─────────────────────────────────────────────────────────────────────────────
// Inert text and lossless wrapping

export function inertText(text: string): string {
	return text.replace(
		/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g,
		char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
	);
}

/**
 * Native action data must not pass through word-wrap, which can discard meaningful whitespace.
 * `indent` starts every row a wrap continues, so no AGY text can reach the margin where Pi's own labels sit.
 */
export function losslessWrap(text: string, width: number, indent = ""): string[] {
	const limit = Math.max(1, width);
	const lines: string[] = [];
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	for (const paragraph of text.split("\n")) {
		let line = "";
		let cells = 0;
		for (const { segment } of segmenter.segment(paragraph)) {
			const size = visibleWidth(segment);
			if (line && line !== indent && cells + size > limit) {
				lines.push(line);
				line = indent;
				cells = visibleWidth(indent);
			}
			line += segment;
			cells += size;
		}
		lines.push(line);
	}
	return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Approval dialog and presenter

export type ApprovalChoice = "accept" | "reject" | undefined;

/** Starts every dialog row that continues a value, so only Pi's own lines start at the margin. */
const CONTINUATION = "  ";

export const APPROVAL_HEADER = "AGY needs approval";
export const APPROVAL_HEADER_BYPASS = "AGY needs approval to run outside its sandbox";

export interface ApprovalView {
	toolCallId: string;
	kind: string;
	title: string;
	command?: string;
	bypassSandbox?: true;
	cwd: string;
	details: string;
	pendingCount(): number;
}

export type ApprovalPresenter = (view: ApprovalView, signal: AbortSignal) => Promise<ApprovalChoice>;
export type DialogPaint = (role: "accent" | "text" | "dim" | "warning", text: string) => string;
export type DialogKeybinding =
	| "tui.select.up"
	| "tui.select.down"
	| "tui.select.pageUp"
	| "tui.select.pageDown"
	| "tui.select.confirm"
	| "tui.select.cancel";

export interface DialogHost {
	rows(): number;
	redraw(): void;
	paint: DialogPaint;
	keybindings?: { matches?(data: string, id: DialogKeybinding): boolean };
}

export class ApprovalDialog implements Component {
	private focus = 0;
	private offset = 0;
	private capacity = 1;
	private lines: string[] = [];
	private readonly detailText: string;
	private wrappedWidth = 0;
	private reviewed = new Set<number>();
	private layout = "";
	private usable = false;
	private ended = false;
	private drawn = false;
	private hasFocus = false;

	constructor(
		private readonly view: ApprovalView,
		private readonly host: DialogHost,
		private readonly finish: (choice: ApprovalChoice) => void,
		readonly dispose = () => {},
	) {
		// A newline inside one of AGY's values continues that value, so it gets the same indent as a wrapped row.
		const field = (text: string) => inertText(text).replaceAll("\n", "\n" + CONTINUATION);
		const title = /^(Run|In):/.test(view.title) ? JSON.stringify(view.title) : view.title;
		this.detailText =
			view.command !== undefined
				? "Run: " + field(view.command) + "\nIn: " + field(view.cwd) + (view.details ? "\n" + inertText(view.details) : "")
				: field(title) + (view.details ? "\n" + inertText(view.details) : "") + "\nIn: " + field(view.cwd);
	}

	invalidate(): void {}

	/** Pi's TUI sets this when keyboard focus moves to or from the dialog. The message log reads it here. */
	get focused(): boolean {
		return this.hasFocus;
	}
	set focused(value: boolean) {
		this.hasFocus = value;
		wireLog("dlg", { step: "focus", toolCallId: this.view.toolCallId, focused: value });
	}

	get canAccept(): boolean {
		return this.usable && this.lines.length > 0 && this.reviewed.size === this.lines.length;
	}

	private matchKey(data: string, id: DialogKeybinding, ...keys: Parameters<typeof matchesKey>[1][]): boolean {
		return Boolean(this.host.keybindings?.matches?.(data, id)) || keys.some(key => matchesKey(data, key));
	}

	/** The name of a key the dialog knows, for the message log. A key it does not know is `other`: the log never keeps what was typed. */
	private keyName(data: string): string {
		if (this.matchKey(data, "tui.select.cancel", Key.escape)) return "escape";
		if (this.matchKey(data, "tui.select.up", Key.up)) return "up";
		if (this.matchKey(data, "tui.select.down", Key.down, Key.tab)) return "down";
		if (this.matchKey(data, "tui.select.pageDown", Key.pageDown)) return "pageDown";
		if (this.matchKey(data, "tui.select.pageUp", Key.pageUp)) return "pageUp";
		if (matchesKey(data, Key.home)) return "home";
		if (matchesKey(data, Key.end)) return "end";
		if (this.matchKey(data, "tui.select.confirm", Key.enter)) return "enter";
		return "other";
	}

	handleInput(data: string): void {
		if (wireLogOn()) {
			wireLog("dlg", { step: "key", toolCallId: this.view.toolCallId, key: this.keyName(data), onAllow: this.focus === 1, canAccept: this.canAccept, ended: this.ended });
		}
		if (this.ended) return;
		if (this.matchKey(data, "tui.select.cancel", Key.escape)) {
			this.complete("reject");
			return;
		}
		if (this.matchKey(data, "tui.select.up", Key.up) || this.matchKey(data, "tui.select.down", Key.down, Key.tab)) {
			this.focus = this.focus === 0 ? 1 : 0;
		} else if (this.matchKey(data, "tui.select.pageDown", Key.pageDown)) {
			this.offset = Math.min(Math.max(0, this.lines.length - this.capacity), this.offset + this.capacity);
		} else if (this.matchKey(data, "tui.select.pageUp", Key.pageUp)) {
			this.offset = Math.max(0, this.offset - this.capacity);
		} else if (matchesKey(data, Key.home)) {
			this.offset = 0;
		} else if (matchesKey(data, Key.end)) {
			this.offset = Math.max(0, this.lines.length - this.capacity);
		} else if (this.matchKey(data, "tui.select.confirm", Key.enter)) {
			if (this.focus === 0) this.complete("reject");
			else if (this.canAccept) this.complete("accept");
		}
		this.host.redraw();
	}

	private complete(choice: ApprovalChoice): void {
		if (this.ended) return;
		this.ended = true;
		wireLog("dlg", { step: "finish", toolCallId: this.view.toolCallId, choice: choice ?? "none", focused: this.hasFocus });
		this.finish(choice);
	}

	render(width: number): string[] {
		const rows = this.host.rows();
		this.usable = width >= 40 && rows >= 18;
		if (!this.drawn) {
			this.drawn = true;
			wireLog("dlg", { step: "render", toolCallId: this.view.toolCallId, width, rows, usable: this.usable, bypass: this.view.bypassSandbox === true });
		}
		if (!this.usable) {
			this.focus = 0;
			this.reviewed.clear();
			return wrapTextWithAnsi(
				"AGY approval: enlarge the terminal to review. Enter or Esc rejects.",
				Math.max(1, width),
			).slice(0, Math.max(1, rows));
		}
		const inner = width - 4;
		const wrap = (text: string) =>
			text.split("\n").flatMap(line => (line ? wrapTextWithAnsi(line, inner).map(row => truncateToWidth(row, inner, "")) : [""]));
		const header = wrap(this.view.bypassSandbox ? APPROVAL_HEADER_BYPASS : APPROVAL_HEADER);
		const legend = wrap("↑↓ choose · Enter confirm · Esc reject · PgUp/PgDn details");
		// Reserve chrome from terminal size only so flipping canAccept or pendingCount never resets reviewed progress.
		const pageReserve = inner < 50 ? 2 : 1;
		const chrome = 2 + header.length + 3 + pageReserve + 1 + 2 + 1 + legend.length;
		const capacity = Math.max(1, rows - chrome);
		const layout = width + ":" + capacity;
		if (this.wrappedWidth !== inner) {
			this.lines = losslessWrap(this.detailText, inner, CONTINUATION);
			this.wrappedWidth = inner;
		}
		if (layout !== this.layout) {
			this.layout = layout;
			this.reviewed.clear();
			this.offset = 0;
		}
		this.capacity = capacity;
		this.offset = Math.min(this.offset, Math.max(0, this.lines.length - capacity));
		const end = Math.min(this.lines.length, this.offset + capacity);
		for (let i = this.offset; i < end; i++) this.reviewed.add(i);
		const paint = this.host.paint;
		const frame = (text: string, role: Parameters<DialogPaint>[0] = "text") =>
			"│ " + paint(role, text) + " ".repeat(Math.max(0, inner - visibleWidth(text))) + " │";
		const result = ["┌" + "─".repeat(width - 2) + "┐"];
		for (const line of header) result.push(frame(line, "accent"));
		result.push(frame(""));
		for (const line of this.lines.slice(this.offset, end)) result.push(frame(line));
		result.push(frame(""));
		if (this.lines.length > capacity) {
			const totalPages = Math.ceil(this.lines.length / capacity);
			const currentPage = end >= this.lines.length ? totalPages : Math.floor(this.offset / capacity) + 1;
			const pageLine =
				"Page " +
				currentPage +
				" of " +
				totalPages +
				" (lines " +
				(this.offset + 1) +
				"-" +
				end +
				" of " +
				this.lines.length +
				")";
			for (const line of wrap(pageLine)) result.push(frame(line, "dim"));
		}
		if (!this.canAccept) {
			for (const line of wrap("Review all details before allowing.")) result.push(frame(line, "warning"));
		}
		for (const line of wrap((this.focus === 0 ? "> " : "  ") + "Reject once")) {
			result.push(frame(line, this.focus === 0 ? "accent" : "text"));
		}
		const allowRole = this.focus === 1 ? "accent" : this.canAccept ? "text" : "dim";
		for (const line of wrap((this.focus === 1 ? "> " : "  ") + "Allow once" + (this.canAccept ? "" : "  (unavailable)"))) {
			result.push(frame(line, allowRole));
		}
		const waiting = this.view.pendingCount();
		if (waiting > 0) {
			const waitingLine = waiting === 1 ? "1 more AGY request waiting" : `${waiting} more AGY requests waiting`;
			for (const line of wrap(waitingLine)) result.push(frame(line, "dim"));
		}
		result.push(frame(""));
		for (const line of legend) result.push(frame(line, "dim"));
		result.push("└" + "─".repeat(width - 2) + "┘");
		return result;
	}
}

export function approvalPresenter(
	ctx: ExtensionContext,
	options?: { onHandle?: (handle: any) => void },
): ApprovalPresenter {
	return async (view, signal) => {
		if (signal.aborted) return undefined;
		try {
			if (!ctx.hasUI) return undefined;
			return await ctx.ui.custom<ApprovalChoice>(
				(tui, theme, keybindings, done) => {
					let ended = false;
					const finish = (choice: ApprovalChoice) => {
						if (ended) return;
						ended = true;
						signal.removeEventListener("abort", abort);
						done(choice);
					};
					const abort = () => {
						wireLog("dlg", { step: "abort", toolCallId: view.toolCallId });
						finish(undefined);
					};
					signal.addEventListener("abort", abort, { once: true });
					if (signal.aborted) queueMicrotask(abort);
					return new ApprovalDialog(
						view,
						{
							rows: () => tui.terminal.rows,
							redraw: () => tui.requestRender(),
							paint: (role, text) => theme.fg(role, text),
							keybindings,
						},
						finish,
						() => signal.removeEventListener("abort", abort),
					);
				},
				{
					overlay: true,
					overlayOptions: { width: "100%", maxHeight: "100%" },
					...(options?.onHandle ? { onHandle: options.onHandle } : {}),
				},
			);
		} catch {
			return undefined;
		}
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Immutable wire data snapshot & permission parsing

/** Copy JSON data without invoking getters/toJSON supplied by a caller. */
export function snapshot(value: unknown, depth = 0, budget = { count: 0 }): unknown {
	if (++budget.count > 20_000 || depth > 32) throw new Error("Invalid permission data");
	if (typeof value === "string" && (value.length > ACP_APPROVAL_BOUNDS.requestBytes || Buffer.byteLength(value) > ACP_APPROVAL_BOUNDS.requestBytes)) {
		throw new Error("Invalid permission data");
	}
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (!isObject(value) && !Array.isArray(value)) throw new Error("Invalid permission data");
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) throw new Error("Invalid permission data");
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (Array.isArray(value)) {
		if (value.length > 20_000) throw new Error("Invalid permission data");
		return Array.from({ length: value.length }, (_, i) => {
			const descriptor = descriptors[String(i)];
			if (!descriptor || !("value" in descriptor)) throw new Error("Invalid permission data");
			return snapshot(descriptor.value, depth + 1, budget);
		});
	}
	const result: RecordValue = Object.create(null);
	for (const [key, descriptor] of Object.entries(descriptors)) {
		if (!("value" in descriptor) || !descriptor.enumerable) throw new Error("Invalid permission data");
		result[key] = snapshot(descriptor.value, depth + 1, budget);
	}
	return result;
}

interface ParsedPermissionRequest {
	valid: boolean;
	sessionMatches: boolean;
	hasToolCallId: boolean;
	toolCallId: string;
	kind: string;
	title: string;
	command?: string;
	bypassSandbox?: true;
	cwd: string;
	details: string;
	optionsOffered: string[];
	allowOptionId?: string;
	rejectOptionId?: string;
}

/** `Run` and the header show the first two. AGY's own summary and its wait are left out (Tom, 2026-11-25). */
const COMMAND_PARAMETERS_NOT_LISTED = new Set(["CommandLine", "BypassSandbox", "WaitMsBeforeAsync", "toolSummary"]);

/** A name that is not a plain word, or is one of Pi's own labels, prints quoted so AGY's text can't pose as Pi's. */
function parameterLine(name: string, value: unknown): string {
	const plain = /^[A-Za-z_]\w*$/.test(name) && name !== "Run" && name !== "In";
	return (plain ? name : JSON.stringify(name)) + ": " + JSON.stringify(value);
}

function parsePermissionRequest(params: unknown, expectedAcpSessionId: string, defaultCwd: string): ParsedPermissionRequest {
	let snap: unknown;
	try {
		snap = snapshot(params);
	} catch {
		return {
			valid: false,
			sessionMatches: false,
			hasToolCallId: false,
			toolCallId: "unknown",
			kind: "unknown",
			title: "action",
			cwd: defaultCwd,
			details: "",
			optionsOffered: [],
		};
	}

	const withinSize = Buffer.byteLength(JSON.stringify(snap)) <= ACP_APPROVAL_BOUNDS.requestBytes;
	if (!isObject(snap)) {
		return {
			valid: false,
			sessionMatches: false,
			hasToolCallId: false,
			toolCallId: "unknown",
			kind: "unknown",
			title: "action",
			cwd: defaultCwd,
			details: "",
			optionsOffered: [],
		};
	}

	const sessionMatches = snap.sessionId === expectedAcpSessionId;
	const toolCall = isObject(snap.toolCall) ? snap.toolCall : undefined;

	const validToolCallId =
		toolCall !== undefined &&
		typeof toolCall.toolCallId === "string" &&
		toolCall.toolCallId.trim().length > 0 &&
		toolCall.toolCallId.length <= 256;
	const toolCallId =
		toolCall !== undefined && typeof toolCall.toolCallId === "string" && toolCall.toolCallId.trim().length > 0
			? toolCall.toolCallId.trim().slice(0, 256)
			: "unknown";

	const validKind =
		toolCall !== undefined &&
		typeof toolCall.kind === "string" &&
		toolCall.kind.trim().length > 0 &&
		toolCall.kind.length <= 128;
	const kind =
		toolCall !== undefined && typeof toolCall.kind === "string" && toolCall.kind.trim().length > 0
			? toolCall.kind.trim().slice(0, 128)
			: "unknown";

	const validTitle =
		toolCall !== undefined &&
		typeof toolCall.title === "string" &&
		toolCall.title.trim().length > 0;
	const title =
		toolCall !== undefined && typeof toolCall.title === "string" && toolCall.title.trim().length > 0
			? toolCall.title.trim()
			: "action";

	const rawInputValidShape = toolCall?.rawInput === undefined || isObject(toolCall.rawInput);
	const argsValidShape = toolCall?.args === undefined || isObject(toolCall.args);
	const rawInput = toolCall && isObject(toolCall.rawInput) ? toolCall.rawInput : undefined;
	const args = toolCall && isObject(toolCall.args) ? toolCall.args : undefined;

	let commandValid = rawInputValidShape && argsValidShape;
	let command: string | undefined;
	const isRunCommand = toolCall?.name === "run_command";
	const isExecute = isRunCommand || toolCall?.kind === "execute";
	const hasRawCmd = rawInput !== undefined && rawInput.CommandLine !== undefined;
	const hasArgsCmd = args !== undefined && args.CommandLine !== undefined;

	if (hasRawCmd && hasArgsCmd) {
		if (
			typeof rawInput.CommandLine === "string" &&
			typeof args.CommandLine === "string" &&
			rawInput.CommandLine === args.CommandLine
		) {
			if (isExecute && rawInput.CommandLine.length > 0) command = rawInput.CommandLine;
		} else {
			commandValid = false;
		}
	} else if (hasRawCmd) {
		if (typeof rawInput.CommandLine === "string") {
			if (isExecute && rawInput.CommandLine.length > 0) command = rawInput.CommandLine;
		} else {
			commandValid = false;
		}
	} else if (hasArgsCmd) {
		if (typeof args.CommandLine === "string") {
			if (isExecute && args.CommandLine.length > 0) command = args.CommandLine;
		} else {
			commandValid = false;
		}
	}
	if (isRunCommand && (!command || command.length === 0)) commandValid = false;

	let cwd = defaultCwd;
	const hasRawCwd = rawInput !== undefined && rawInput.Cwd !== undefined;
	const hasArgsCwd = args !== undefined && args.Cwd !== undefined;
	if (hasRawCwd && hasArgsCwd && rawInput.Cwd !== args.Cwd) {
		commandValid = false;
	} else if (hasRawCwd && typeof rawInput.Cwd === "string" && rawInput.Cwd.trim().length > 0) {
		cwd = rawInput.Cwd;
	} else if (hasArgsCwd && typeof args.Cwd === "string" && args.Cwd.trim().length > 0) {
		cwd = args.Cwd;
	}

	// A request to run outside AGY's sandbox carries BypassSandbox: true. Checked whatever the request's kind or name. The two copies must agree, and only a boolean is a value Pi can show faithfully.
	let bypassSandbox = false;
	const rawBypass = rawInput?.BypassSandbox, argsBypass = args?.BypassSandbox;
	if ((rawBypass !== undefined && typeof rawBypass !== "boolean") || (argsBypass !== undefined && typeof argsBypass !== "boolean")) {
		commandValid = false;
	} else if (rawBypass !== undefined && argsBypass !== undefined && rawBypass !== argsBypass) {
		commandValid = false;
	} else {
		bypassSandbox = rawBypass === true || argsBypass === true;
	}

	const optionsOffered: string[] = [];
	let allowOptionId: string | undefined;
	let rejectOptionId: string | undefined;
	let optionsValid = false;

	if (Array.isArray(snap.options)) {
		const seenIds = new Set<string>();
		let hasDuplicateId = false;
		let allItemsValid = snap.options.length >= 2 && snap.options.length <= 8;
		for (const opt of snap.options) {
			if (!isObject(opt)) {
				allItemsValid = false;
				continue;
			}
			const optKind =
				typeof opt.kind === "string" && opt.kind.length > 0 && opt.kind.length <= 128 ? opt.kind : undefined;
			if (optKind !== undefined && optionsOffered.length < 32) optionsOffered.push(optKind);
			const optId =
				typeof opt.optionId === "string" && opt.optionId.length > 0 && opt.optionId.length <= 256
					? opt.optionId
					: undefined;
			if (optId === undefined || optKind === undefined) {
				allItemsValid = false;
				continue;
			}
			if (seenIds.has(optId)) {
				hasDuplicateId = true;
				allItemsValid = false;
				continue;
			}
			seenIds.add(optId);
			if (optKind === "allow_once" && allowOptionId === undefined) allowOptionId = optId;
			if (optKind === "reject_once" && rejectOptionId === undefined) rejectOptionId = optId;
		}
		if (hasDuplicateId) {
			allowOptionId = undefined;
			rejectOptionId = undefined;
		}
		optionsValid = allItemsValid && allowOptionId !== undefined && rejectOptionId !== undefined;
	}

	// AGY sends its input twice. Show rawInput, then whatever args adds or contradicts.
	const unmatchedArgs = Object.entries(args ?? {}).filter(([key, value]) => !isDeepStrictEqual(value, rawInput?.[key]));
	const details =
		command === undefined
			? [rawInput ?? {}, Object.fromEntries(unmatchedArgs)]
					.filter(block => Object.keys(block).length > 0)
					.map(block => JSON.stringify(block, null, 2))
					.join("\n")
			: [...Object.entries(rawInput ?? {}), ...unmatchedArgs]
					.filter(([key, value]) => !COMMAND_PARAMETERS_NOT_LISTED.has(key) && !(key === "Cwd" && value === cwd))
					.map(([key, value]) => parameterLine(key, value))
					.join("\n");

	const valid =
		withinSize &&
		sessionMatches &&
		toolCall !== undefined &&
		validToolCallId &&
		validKind &&
		validTitle &&
		commandValid &&
		optionsValid;

	return {
		valid,
		sessionMatches,
		hasToolCallId: validToolCallId,
		toolCallId,
		kind,
		title,
		...(command !== undefined ? { command } : {}),
		...(bypassSandbox ? { bypassSandbox: true as const } : {}),
		cwd,
		details,
		optionsOffered,
		allowOptionId,
		rejectOptionId,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// One-reply-per-request FIFO approval queue

export interface AcpApprovalResult {
	outcome: PermissionOutcome;
	record: AgyAcpPermissionRecord;
}

export interface AcpApprovalQueueOptions {
	piSessionId: string;
	acpSessionId: string;
	cwd: string;
	present: ApprovalPresenter;
	/** Called when a record is decided, before its reply is on the wire. The provider does not use it: it saves `request()`'s `record` once the reply reached the link. */
	onRecord?: (record: AgyAcpPermissionRecord) => void;
	onPendingStateChange?: (toolCallId: string, waiting: boolean) => void;
	reviewTimeoutMs?: number;
}

export interface AcpApprovalRequestContext {
	turnRunning: boolean;
	inputEntryId: string | null;
	signal?: AbortSignal;
	present?: ApprovalPresenter;
}

interface QueuedPermission {
	inputEntryId: string;
	hasToolCallId: boolean;
	toolCallId: string;
	kind: string;
	title: string;
	command?: string;
	bypassSandbox?: true;
	cwd: string;
	details: string;
	optionsOffered: string[];
	allowOptionId: string;
	rejectOptionId: string;
	present: ApprovalPresenter;
	requestSignal?: AbortSignal;
	modal: AbortController;
	/** Counts the entries of one queue, so a message log line says which request a later line answers. */
	n: number;
	promise: Promise<AcpApprovalResult>;
	resolve(result: AcpApprovalResult): void;
	interrupted: Promise<void>;
	interrupt(): void;
	onAbort(): void;
	done: boolean;
	timer?: ReturnType<typeof setTimeout>;
	deadline?: number;
}

export class AcpApprovalQueue {
	private readonly piSessionId: string;
	private readonly acpSessionId: string;
	private readonly cwd: string;
	private readonly defaultPresent: ApprovalPresenter;
	private readonly onRecord?: (record: AgyAcpPermissionRecord) => void;
	private readonly onPendingStateChange?: (toolCallId: string, waiting: boolean) => void;
	private readonly reviewMs: number;

	private readonly live = new Set<QueuedPermission>();
	private readonly fifo: QueuedPermission[] = [];
	private readonly approvalsByToolCall = new Map<string, { reply: AgyAcpApprovalReply; reason: AgyAcpApprovalReason }>();
	private pumping = false;
	private seq = 0;

	private turnRunning = false;
	private turnInputEntryId: string | null = null;
	private turnSignal?: AbortSignal;
	private turnPresent?: ApprovalPresenter;
	private readonly onTurnAbort = () => this.cancelAll("turn-stopped");

	constructor(options: AcpApprovalQueueOptions) {
		this.piSessionId = options.piSessionId;
		this.acpSessionId = options.acpSessionId;
		this.cwd = options.cwd;
		this.defaultPresent = options.present;
		this.onRecord = options.onRecord;
		this.onPendingStateChange = options.onPendingStateChange;
		this.reviewMs = options.reviewTimeoutMs ?? ACP_APPROVAL_BOUNDS.reviewMs;
		if (!Number.isSafeInteger(this.reviewMs) || this.reviewMs <= 0 || this.reviewMs > ACP_APPROVAL_BOUNDS.reviewMs) {
			throw new Error("Invalid approval bounds");
		}
	}

	get liveCount(): number {
		return this.live.size;
	}

	beginTurn(inputEntryId: string, signal?: AbortSignal, present?: ApprovalPresenter): void {
		if (this.turnSignal) this.turnSignal.removeEventListener("abort", this.onTurnAbort);
		this.approvalsByToolCall.clear();
		this.turnRunning = true;
		this.turnInputEntryId = inputEntryId;
		this.turnSignal = signal;
		this.turnPresent = present;
		if (signal) {
			if (signal.aborted) this.cancelAll("turn-stopped");
			else signal.addEventListener("abort", this.onTurnAbort, { once: true });
		}
	}

	endTurn(): void {
		if (this.turnSignal) this.turnSignal.removeEventListener("abort", this.onTurnAbort);
		this.turnSignal = undefined;
		this.turnPresent = undefined;
		this.turnRunning = false;
		this.turnInputEntryId = null;
		this.cancelAll("turn-stopped");
	}

	clearTurnApprovals(): void {
		this.approvalsByToolCall.clear();
	}

	approvalForToolCall(toolCallId: string): { reply: AgyAcpApprovalReply; reason: AgyAcpApprovalReason } | undefined {
		return this.approvalsByToolCall.get(toolCallId);
	}

	/** The reply for this tool call never reached AGY, so no later record may say it was answered. */
	forgetApproval(toolCallId: string): void {
		wireLog("q", { step: "forget", toolCallId });
		this.approvalsByToolCall.delete(toolCallId);
	}

	cancelAll(reason: "turn-stopped" = "turn-stopped"): void {
		this.fifo.length = 0;
		for (const entry of [...this.live]) {
			this.settle(entry, CANCELLED, "cancelled", reason);
		}
	}

	request(params: unknown, ctx?: AcpApprovalRequestContext): Promise<AcpApprovalResult> {
		const turnRunning = ctx ? ctx.turnRunning : this.turnRunning;
		const inputEntryId = ctx ? ctx.inputEntryId : this.turnInputEntryId;
		const signal = ctx ? ctx.signal : this.turnSignal;
		const present = ctx?.present ?? this.turnPresent ?? this.defaultPresent;

		const parsed = parsePermissionRequest(params, this.acpSessionId, this.cwd);
		wireLog("q", { step: "request", toolCallId: parsed.toolCallId, live: this.live.size, valid: parsed.valid, turnRunning, bypass: parsed.bypassSandbox === true });
		const rejectOutcome = (canUseRejectOption: boolean): { outcome: PermissionOutcome; reply: "reject_once" | "cancelled" } => {
			if (canUseRejectOption && parsed.rejectOptionId) {
				return {
					outcome: { outcome: { outcome: "selected", optionId: parsed.rejectOptionId } },
					reply: "reject_once",
				};
			}
			return { outcome: CANCELLED, reply: "cancelled" };
		};

		const immediate = (
			outcome: PermissionOutcome,
			reply: AgyAcpApprovalReply,
			reason: AgyAcpApprovalReason,
			entryId: string | null,
		): Promise<AcpApprovalResult> => {
			const record = this.makeRecord(parsed, entryId, reply, reason);
			wireLog("q", { step: "reply", toolCallId: record.toolCallId, reply, reason, atOnce: true });
			if (entryId !== null && parsed.sessionMatches && parsed.hasToolCallId) {
				this.approvalsByToolCall.set(record.toolCallId, { reply, reason });
			}
			this.emitRecord(record);
			return Promise.resolve({ outcome, record });
		};

		// Case 1: No turn is running. A request between turns starts a wake turn and reaches the queue inside it (Decisions 2026-11-22), so this is only a request that outlived its turn: never a dialog.
		if (!turnRunning || inputEntryId === null) {
			if (parsed.valid) return immediate(CANCELLED, "cancelled", "turn-stopped", null);
			const rejected = rejectOutcome(parsed.sessionMatches);
			return immediate(rejected.outcome, rejected.reply, "unsafe", null);
		}

		// Case 2a: Invalid, oversized, wrong session, or missing allow_once/reject_once.
		if (!parsed.valid) {
			const rejected = rejectOutcome(parsed.sessionMatches);
			return immediate(rejected.outcome, rejected.reply, "unsafe", inputEntryId);
		}

		// Case 3: Turn already stopped.
		if (signal?.aborted) {
			return immediate(CANCELLED, "cancelled", "turn-stopped", inputEntryId);
		}

		// Case 2b: Queue full (8 live requests).
		if (this.live.size >= ACP_APPROVAL_BOUNDS.live) {
			const rejected = rejectOutcome(true);
			return immediate(rejected.outcome, rejected.reply, "unsafe", inputEntryId);
		}

		// Case 4: Enqueue in FIFO.
		let resolve!: QueuedPermission["resolve"];
		let interrupt!: QueuedPermission["interrupt"];
		const entry: QueuedPermission = {
			inputEntryId,
			hasToolCallId: parsed.hasToolCallId,
			toolCallId: parsed.toolCallId,
			kind: parsed.kind,
			title: parsed.title,
			...(parsed.command !== undefined ? { command: parsed.command } : {}),
			...(parsed.bypassSandbox ? { bypassSandbox: true as const } : {}),
			cwd: parsed.cwd,
			details: parsed.details,
			optionsOffered: parsed.optionsOffered,
			allowOptionId: parsed.allowOptionId!,
			rejectOptionId: parsed.rejectOptionId!,
			present,
			requestSignal: signal,
			modal: new AbortController(),
			n: ++this.seq,
			done: false,
			promise: new Promise<AcpApprovalResult>(done => {
				resolve = done;
			}),
			resolve: result => resolve(result),
			interrupted: new Promise<void>(done => {
				interrupt = done;
			}),
			interrupt: () => interrupt(),
			onAbort: () => this.cancelAll("turn-stopped"),
		};

		this.live.add(entry);
		this.fifo.push(entry);
		this.emitPending(entry.toolCallId, true);
		if (signal) {
			signal.addEventListener("abort", entry.onAbort, { once: true });
			if (signal.aborted) {
				this.cancelAll("turn-stopped");
				return entry.promise;
			}
		}
		void this.pump();
		return entry.promise;
	}

	private makeRecord(
		source: Pick<ParsedPermissionRequest, "toolCallId" | "kind" | "title" | "command" | "bypassSandbox" | "optionsOffered">,
		inputEntryId: string | null,
		reply: AgyAcpApprovalReply,
		reason: AgyAcpApprovalReason,
	): AgyAcpPermissionRecord {
		return {
			piSessionId: this.piSessionId,
			inputEntryId,
			acpSessionId: this.acpSessionId,
			toolCallId: source.toolCallId,
			kind: source.kind,
			title: source.title.slice(0, RECORD_TITLE_MAX_CHARS), // the dialog shows it whole
			...(source.command !== undefined ? { command: source.command } : {}),
			...(source.bypassSandbox ? { bypassSandbox: true as const } : {}),
			optionsOffered: [...source.optionsOffered],
			reply,
			reason,
		};
	}

	private emitRecord(record: AgyAcpPermissionRecord): void {
		try {
			this.onRecord?.(record);
		} catch {}
	}

	private emitPending(toolCallId: string, waiting: boolean): void {
		try {
			this.onPendingStateChange?.(toolCallId, waiting);
		} catch {}
	}

	private settle(
		entry: QueuedPermission,
		outcome: PermissionOutcome,
		reply: AgyAcpApprovalReply,
		reason: AgyAcpApprovalReason,
	): void {
		if (entry.done) return;
		entry.done = true;
		clearTimeout(entry.timer);
		entry.requestSignal?.removeEventListener("abort", entry.onAbort);
		this.live.delete(entry);
		const record = this.makeRecord(entry, entry.inputEntryId, reply, reason);
		wireLog("q", { step: "reply", n: entry.n, toolCallId: entry.toolCallId, reply, reason });
		if (entry.hasToolCallId) {
			this.approvalsByToolCall.set(record.toolCallId, { reply, reason });
		}
		this.emitRecord(record);
		this.emitPending(entry.toolCallId, false);
		entry.resolve({ outcome, record });
		entry.interrupt();
		// Publish before arbitrary abort/disposal listeners can reenter the queue.
		entry.modal.abort();
	}

	private async pump(): Promise<void> {
		if (this.pumping) return;
		this.pumping = true;
		try {
			while (this.fifo.length > 0) {
				const entry = this.fifo.shift()!;
				if (entry.done) continue;
				if (entry.requestSignal?.aborted) {
					this.cancelAll("turn-stopped");
					continue;
				}
				entry.deadline = performance.now() + this.reviewMs;
				entry.timer = setTimeout(() => {
					this.settle(
						entry,
						{ outcome: { outcome: "selected", optionId: entry.rejectOptionId } },
						"reject_once",
						"review-cap",
					);
				}, this.reviewMs);
				entry.timer.unref?.();

				const view: ApprovalView = Object.freeze({
					toolCallId: entry.toolCallId,
					kind: entry.kind,
					title: entry.title,
					...(entry.command !== undefined ? { command: entry.command } : {}),
					...(entry.bypassSandbox ? { bypassSandbox: true as const } : {}),
					cwd: entry.cwd,
					details: entry.details,
					pendingCount: () => Math.max(0, this.live.size - 1),
				});

				let choice: ApprovalChoice;
				wireLog("q", { step: "present", n: entry.n, toolCallId: entry.toolCallId, waiting: Math.max(0, this.live.size - 1) });
				try {
					choice = await Promise.race([
						Promise.resolve().then(() =>
							entry.done || entry.modal.signal.aborted ? undefined : entry.present(view, entry.modal.signal),
						),
						entry.interrupted.then(() => undefined),
					]);
				} catch {
					choice = undefined;
				}
				wireLog("q", { step: "choice", n: entry.n, toolCallId: entry.toolCallId, choice: choice ?? "none", settled: entry.done });
				if (entry.done) continue;
				if (entry.requestSignal?.aborted) {
					this.cancelAll("turn-stopped");
					continue;
				}
				if (performance.now() >= entry.deadline) {
					this.settle(
						entry,
						{ outcome: { outcome: "selected", optionId: entry.rejectOptionId } },
						"reject_once",
						"review-cap",
					);
					continue;
				}
				if (choice === "accept") {
					this.settle(
						entry,
						{ outcome: { outcome: "selected", optionId: entry.allowOptionId } },
						"allow_once",
						"user",
					);
				} else if (choice === "reject") {
					this.settle(
						entry,
						{ outcome: { outcome: "selected", optionId: entry.rejectOptionId } },
						"reject_once",
						"user",
					);
				} else if (entry.requestSignal?.aborted) {
					this.settle(entry, CANCELLED, "cancelled", "turn-stopped");
				} else {
					this.settle(
						entry,
						{ outcome: { outcome: "selected", optionId: entry.rejectOptionId } },
						"reject_once",
						"unsafe",
					);
				}
			}
		} finally {
			this.pumping = false;
			if (this.fifo.length > 0) void this.pump();
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Question extraction

export function extractAgyAcpQuestion(
	params: unknown,
	scope: { piSessionId: string; acpSessionId: string; inputEntryId: string | null },
): AgyAcpQuestionRecord {
	let snap: RecordValue = {};
	try {
		const candidate = snapshot(params);
		if (isObject(candidate)) snap = candidate;
	} catch {
		snap = {};
	}

	const cleanedId = typeof snap.toolCallId === "string" ? sanitizeDisplayText(snap.toolCallId).trim().slice(0, 256) : "";
	const toolCallId = cleanedId || "elicitation";

	const questions: string[] = [];
	const schema = isObject(snap.requestedSchema) ? snap.requestedSchema : undefined;
	const properties = schema && isObject(schema.properties) ? schema.properties : undefined;
	if (properties) {
		for (const [key, prop] of Object.entries(properties)) {
			if (key.endsWith("_other")) continue;
			if (!isObject(prop)) continue;
			const title = typeof prop.title === "string" ? sanitizeDisplayText(prop.title).trim() : "";
			const desc = typeof prop.description === "string" ? sanitizeDisplayText(prop.description).trim() : "";
			const text = clampUtf8(title || desc, QUESTION_ITEM_MAX_BYTES).trim();
			if (text) {
				questions.push(text);
				if (questions.length >= 64) break;
			}
		}
	}

	if (questions.length === 0) {
		const message =
			typeof snap.message === "string" ? clampUtf8(sanitizeDisplayText(snap.message).trim(), QUESTION_ITEM_MAX_BYTES).trim() : "";
		questions.push(message || "question");
	}

	return {
		piSessionId: scope.piSessionId,
		inputEntryId: scope.inputEntryId,
		acpSessionId: scope.acpSessionId,
		toolCallId,
		questions,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved record parsers and Pi transcript renderers

const PERMISSION_KEYS = new Set([
	"piSessionId",
	"inputEntryId",
	"acpSessionId",
	"toolCallId",
	"kind",
	"title",
	"command",
	"bypassSandbox",
	"optionsOffered",
	"reply",
	"reason",
]);
const PERMISSION_REPLIES = new Set<AgyAcpApprovalReply>(["allow_once", "reject_once", "cancelled"]);
const PERMISSION_REASONS = new Set<AgyAcpApprovalReason>(["user", "turn-stopped", "review-cap", "unsafe"]);
const QUESTION_KEYS = new Set([
	"piSessionId",
	"inputEntryId",
	"acpSessionId",
	"toolCallId",
	"questions",
	"reply",
	"reason",
	"answers",
]);

const nonEmptyBounded = (value: unknown, max: number): value is string =>
	typeof value === "string" && value.trim().length > 0 && value.length <= max;

export function parseAgyAcpPermission(value: unknown): AgyAcpPermissionRecord | undefined {
	try {
		const snap = snapshot(value);
		if (!isObject(snap)) return undefined;
		if (!Object.keys(snap).every(key => PERMISSION_KEYS.has(key))) return undefined;
		if (
			!nonEmptyBounded(snap.piSessionId, 512) ||
			!(snap.inputEntryId === null || nonEmptyBounded(snap.inputEntryId, 512)) ||
			!nonEmptyBounded(snap.acpSessionId, 512) ||
			!nonEmptyBounded(snap.toolCallId, 256) ||
			!nonEmptyBounded(snap.kind, 128) ||
			!nonEmptyBounded(snap.title, RECORD_TITLE_MAX_CHARS)
		) {
			return undefined;
		}
		if (
			snap.command !== undefined &&
			(typeof snap.command !== "string" || Buffer.byteLength(snap.command) > ACP_APPROVAL_BOUNDS.requestBytes)
		) {
			return undefined;
		}
		if (snap.bypassSandbox !== undefined && snap.bypassSandbox !== true) return undefined;
		if (
			!Array.isArray(snap.optionsOffered) ||
			snap.optionsOffered.length > 32 ||
			!snap.optionsOffered.every(item => typeof item === "string" && item.length <= 128)
		) {
			return undefined;
		}
		if (
			typeof snap.reply !== "string" ||
			!PERMISSION_REPLIES.has(snap.reply as AgyAcpApprovalReply) ||
			typeof snap.reason !== "string" ||
			!PERMISSION_REASONS.has(snap.reason as AgyAcpApprovalReason)
		) {
			return undefined;
		}
		if (Buffer.byteLength(JSON.stringify(snap)) > RECORD_ENVELOPE_BYTES) return undefined;
		return {
			piSessionId: snap.piSessionId,
			inputEntryId: snap.inputEntryId,
			acpSessionId: snap.acpSessionId,
			toolCallId: snap.toolCallId,
			kind: snap.kind,
			title: snap.title,
			...(snap.command !== undefined ? { command: snap.command } : {}),
			...(snap.bypassSandbox === true ? { bypassSandbox: true as const } : {}),
			optionsOffered: [...(snap.optionsOffered as string[])],
			reply: snap.reply as AgyAcpApprovalReply,
			reason: snap.reason as AgyAcpApprovalReason,
		};
	} catch {
		return undefined;
	}
}

export function formatAgyAcpPermissionLine(data: AgyAcpPermissionRecord): { text: string; role: "dim" | "warning" } {
	const cleanCommand = data.command ? sanitizeDisplayText(data.command) : "";
	const cleanTitle = sanitizeDisplayText(data.title || "");
	const action = cleanCommand ? `run ${cleanCommand}` : cleanTitle || "run an action";

	if (data.reason === "user" && data.reply === "allow_once") {
		return { text: `You allowed AGY to ${action} once${data.bypassSandbox ? ", outside its sandbox" : ""}.`, role: "dim" };
	}
	if (data.reason === "user") {
		return { text: `You rejected AGY's request to ${action}${data.bypassSandbox ? " outside its sandbox" : ""}.`, role: "warning" };
	}
	if (data.reason === "turn-stopped") {
		return { text: `AGY's request to ${action} was rejected because the turn stopped.`, role: "warning" };
	}
	if (data.reason === "review-cap") {
		return { text: `AGY's request to ${action} was rejected after 15 minutes without an answer.`, role: "warning" };
	}
	return { text: "AGY sent a request Pi can't show safely, so Pi rejected it.", role: "warning" }; // "unsafe"
}

function expandHint(hint?: string): string {
	if (hint !== undefined) return hint;
	try {
		return keyHint("app.tools.expand", "to expand");
	} catch {
		return "ctrl+o to expand";
	}
}

export function renderAgyAcpPermission(value: unknown, expanded: boolean, theme: Theme, hint?: string): Component {
	const data = parseAgyAcpPermission(value);
	return {
		invalidate() {},
		render(width) {
			if (width < 1) return [];
			const wrap = (text: string) =>
				wrapTextWithAnsi(sanitizeDisplayText(text).replace(/\t/g, "    "), width).map(row =>
					truncateToWidth(row, width, ""),
				);
			if (!data) return wrap(PERMISSION_UNAVAILABLE).map(row => theme.fg("warning", row));
			if (!expanded && data.reason !== "unsafe") {
				const cleanCommand = data.command ? sanitizeDisplayText(data.command) : "";
				const cleanTitle = sanitizeDisplayText(data.title || "");
				const source = cleanCommand || cleanTitle;
				if (source.includes("\n") || [...source].length > PERMISSION_COLLAPSE_CHARS) {
					const firstLine = source.split("\n")[0] ?? "";
					const preview = [...firstLine].slice(0, PERMISSION_COLLAPSE_CHARS).join("") + "…";
					const previewData = cleanCommand ? { ...data, command: preview } : { ...data, title: preview };
					const { text, role } = formatAgyAcpPermissionLine(previewData);
					const rows = wrap(text).map(row => theme.fg(role, row));
					const hintLine = `    ... (${expandHint(hint)})`;
					rows.push(...wrapTextWithAnsi(hintLine, width).map(row => truncateToWidth(row, width, "")));
					return rows;
				}
			}
			const { text, role } = formatAgyAcpPermissionLine(data);
			return wrap(text).map(row => theme.fg(role, row));
		},
	};
}

export function parseAgyAcpQuestion(value: unknown): AgyAcpQuestionRecord | undefined {
	try {
		const snap = snapshot(value);
		if (!isObject(snap)) return undefined;
		if (!Object.keys(snap).every(key => QUESTION_KEYS.has(key))) return undefined;
		if (
			!nonEmptyBounded(snap.piSessionId, 512) ||
			!(snap.inputEntryId === null || nonEmptyBounded(snap.inputEntryId, 512)) ||
			!nonEmptyBounded(snap.acpSessionId, 512) ||
			!nonEmptyBounded(snap.toolCallId, 256)
		) {
			return undefined;
		}
		if (
			!Array.isArray(snap.questions) ||
			snap.questions.length === 0 ||
			snap.questions.length > 64 ||
			!snap.questions.every(q => typeof q === "string" && q.trim().length > 0)
		) {
			return undefined;
		}
		if (snap.reply !== undefined && (typeof snap.reply !== "string" || snap.reply.length > 128)) return undefined;
		if (snap.reason !== undefined && (typeof snap.reason !== "string" || snap.reason.length > 128)) return undefined;
		if (snap.answers !== undefined && !isObject(snap.answers)) return undefined;
		if (Buffer.byteLength(JSON.stringify(snap)) > RECORD_ENVELOPE_BYTES) return undefined;
		return {
			piSessionId: snap.piSessionId,
			inputEntryId: snap.inputEntryId,
			acpSessionId: snap.acpSessionId,
			toolCallId: snap.toolCallId,
			questions: [...(snap.questions as string[])],
			...(snap.reply !== undefined ? { reply: snap.reply } : {}),
			...(snap.reason !== undefined ? { reason: snap.reason } : {}),
			...(snap.answers !== undefined ? { answers: { ...(snap.answers as Record<string, unknown>) } } : {}),
		};
	} catch {
		return undefined;
	}
}

export function formatAgyAcpQuestionLine(_data: AgyAcpQuestionRecord): string {
	return ACP_QUESTION_LINE;
}

export function renderAgyAcpQuestion(value: unknown, _expanded: boolean, theme: Theme): Component {
	const data = parseAgyAcpQuestion(value);
	return {
		invalidate() {},
		render(width) {
			if (width < 1) return [];
			const wrap = (text: string) =>
				wrapTextWithAnsi(sanitizeDisplayText(text).replace(/\t/g, "    "), width).map(row =>
					truncateToWidth(row, width, ""),
				);
			if (!data) return wrap(QUESTION_UNAVAILABLE).map(row => theme.fg("warning", row));
			return wrap(formatAgyAcpQuestionLine(data)).map(row => theme.fg("dim", row));
		},
	};
}
