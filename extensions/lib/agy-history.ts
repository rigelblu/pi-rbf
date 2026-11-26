import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { sanitizeDisplayText } from "./agy-native.js";

export const AGY_ACP_ACTIVITY = "rbf-agy-acp-activity/v1";
export const AGY_HISTORY_FAILURE = "AGY activity could not be saved. History may be incomplete.";
export const AGY_HISTORY_UNAVAILABLE = "AGY activity unavailable: saved record is invalid or unsupported.";
export const ACTIVITY_LIMITS = Object.freeze({ payload: 64 * 1024, requestPayload: 256 * 1024, records: 256, identity: 512, envelope: 192 * 1024, requestSerialized: 2 * 1024 * 1024 });
export interface CapturedText { text: string; originalBytes: number; omittedBytes: number }
export type AgyAcpApprovalReply = "allow_once" | "reject_once" | "cancelled";
export type AgyAcpApprovalReason = "user" | "turn-stopped" | "review-cap" | "unsafe";
export interface AgyAcpApprovalStamp {
	reply: AgyAcpApprovalReply;
	reason: AgyAcpApprovalReason;
}
export interface AgyAcpActivityInput {
	piSessionId: string;
	inputEntryId: string;
	acpSessionId: string;
	toolCallId: string;
	name: string;
	kind: string;
	title: string;
	state: "completed" | "failed";
	approval?: AgyAcpApprovalStamp;
	command?: string;
	parameters?: Record<string, unknown>;
	output?: string;
	exitCode?: number;
}
export interface AgyAcpActivityObservation {
	schemaVersion: 1;
	piSessionId: string;
	inputEntryId: string;
	acpSessionId: string;
	sequence: number;
	toolCallId: string;
	name: string;
	kind: string;
	title: string;
	state: "completed" | "failed";
	approval?: AgyAcpApprovalStamp;
	command?: CapturedText;
	parameters?: CapturedText & { encoding: "json" | "json-prefix" };
	output?: CapturedText;
	exitCode?: number;
}
export interface AgyActivityBudget { payloadBytes: number; serializedBytes: number; observations: number }
export function newAgyActivityBudget(): AgyActivityBudget { return { payloadBytes: 0, serializedBytes: 0, observations: 0 }; }


// ─────────────────────────────────────────────────────────────────────────────
// Bounded historical values; no live admission or execution authority

const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const identity = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && Buffer.byteLength(v) <= ACTIVITY_LIMITS.identity && sanitizeDisplayText(v) === v && !/[\t\n]/.test(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(k => allowed.includes(k));
const captured = (v: unknown, parameters = false): v is CapturedText => object(v) && keys(v, parameters ? ["text", "originalBytes", "omittedBytes", "encoding"] : ["text", "originalBytes", "omittedBytes"]) && typeof v.text === "string" && count(v.originalBytes) && count(v.omittedBytes) && Buffer.byteLength(v.text) <= ACTIVITY_LIMITS.payload && Buffer.byteLength(v.text) + v.omittedBytes === v.originalBytes;
function acpTexts(data: AgyAcpActivityObservation): CapturedText[] { return [data.command, data.parameters, data.output].filter((v): v is CapturedText => v !== undefined); }
const acpActivityKeys = ["schemaVersion", "piSessionId", "inputEntryId", "acpSessionId", "sequence", "toolCallId", "name", "kind", "title", "state", "approval", "command", "parameters", "output", "exitCode"] as const;
const acpApprovalReplies: readonly string[] = ["allow_once", "reject_once", "cancelled"];
const acpApprovalReasons: readonly string[] = ["user", "turn-stopped", "review-cap", "unsafe"];





export function parseAgyAcpActivity(value: unknown): AgyAcpActivityObservation | undefined {
	try {
		if (!object(value) || !keys(value, acpActivityKeys) || value.schemaVersion !== 1 ||
			![value.piSessionId, value.inputEntryId, value.acpSessionId, value.toolCallId, value.name, value.kind, value.title].every(identity) ||
			!count(value.sequence) || value.sequence < 1 || value.sequence > ACTIVITY_LIMITS.records ||
			(value.state !== "completed" && value.state !== "failed")) return undefined;
		if (value.approval !== undefined && (!object(value.approval) || !keys(value.approval, ["reply", "reason"]) ||
			!acpApprovalReplies.includes(value.approval.reply as string) || !acpApprovalReasons.includes(value.approval.reason as string))) return undefined;
		for (const field of ["command", "parameters", "output"] as const) if (value[field] !== undefined && !captured(value[field], field === "parameters")) return undefined;
		if (value.command !== undefined && value.name !== "run_command") return undefined;
		if (value.parameters !== undefined) {
			const parameters = value.parameters as Record<string, unknown>;
			if (parameters.encoding !== (parameters.omittedBytes === 0 ? "json" : "json-prefix")) return undefined;
			if (parameters.encoding === "json" && !object(JSON.parse(parameters.text as string))) return undefined;
		}
		if (value.exitCode !== undefined && (typeof value.exitCode !== "number" || !Number.isSafeInteger(value.exitCode))) return undefined;
		const data = value as unknown as AgyAcpActivityObservation;
		if (acpTexts(data).reduce((n, t) => n + Buffer.byteLength(t.text), 0) > ACTIVITY_LIMITS.payload || Buffer.byteLength(JSON.stringify(data)) > ACTIVITY_LIMITS.envelope) return undefined;
		return data;
	} catch { return undefined; }
}

function validBudget(budget: AgyActivityBudget): boolean {
	return count(budget.payloadBytes) && budget.payloadBytes <= ACTIVITY_LIMITS.requestPayload && count(budget.serializedBytes) && budget.serializedBytes <= ACTIVITY_LIMITS.requestSerialized && count(budget.observations) && budget.observations <= ACTIVITY_LIMITS.records;
}


function clampUtf8(text: string, limit: number): string {
	const bytes = Buffer.from(text, "utf8");
	let end = Math.min(bytes.length, Math.max(0, limit));
	while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

function normalizeAcpLabel(raw: string, fallback: string): string {
	return clampUtf8(sanitizeDisplayText(raw).replace(/[\t\n]+/g, " ").trim(), ACTIVITY_LIMITS.identity).trim() || fallback;
}

function createTextCapturer(budget: AgyActivityBudget): (raw: string) => CapturedText {
	let remaining = Math.min(ACTIVITY_LIMITS.payload, ACTIVITY_LIMITS.requestPayload - budget.payloadBytes);
	return (raw: string): CapturedText => {
		const bytes = Buffer.from(sanitizeDisplayText(raw), "utf8");
		let end = Math.min(bytes.length, Math.max(0, remaining));
		while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
		remaining -= end;
		return { text: bytes.subarray(0, end).toString("utf8"), originalBytes: bytes.length, omittedBytes: bytes.length - end };
	};
}


export function captureAgyAcpActivity(input: AgyAcpActivityInput, budget: AgyActivityBudget): { data: AgyAcpActivityObservation; payloadBytes: number } {
	if (!object(input) || typeof input.name !== "string" || typeof input.kind !== "string" || typeof input.title !== "string" || !validBudget(budget) || budget.observations >= ACTIVITY_LIMITS.records) throw new Error(AGY_HISTORY_FAILURE);
	const capture = createTextCapturer(budget);
	const name = normalizeAcpLabel(input.name, "tool");
	const kind = normalizeAcpLabel(input.kind, "other");
	const title = normalizeAcpLabel(input.title, name);
	const data: AgyAcpActivityObservation = {
		schemaVersion: 1,
		piSessionId: input.piSessionId,
		inputEntryId: input.inputEntryId,
		acpSessionId: input.acpSessionId,
		sequence: budget.observations + 1,
		toolCallId: input.toolCallId,
		name,
		kind,
		title,
		state: input.state,
	};
	if (input.approval !== undefined) {
		try { data.approval = structuredClone(input.approval); } catch { throw new Error(AGY_HISTORY_FAILURE); }
	}
	if (name === "run_command" && typeof input.command === "string") data.command = capture(input.command);
	if (typeof input.output === "string") data.output = capture(input.output);
	if (input.parameters !== undefined && object(input.parameters)) {
		let serialized: string;
		try { serialized = JSON.stringify(input.parameters); } catch { throw new Error(AGY_HISTORY_FAILURE); }
		const parameters = capture(serialized);
		data.parameters = { ...parameters, encoding: parameters.omittedBytes === 0 ? "json" : "json-prefix" };
	}
	if (typeof input.exitCode === "number" && Number.isSafeInteger(input.exitCode)) data.exitCode = input.exitCode;
	if (!parseAgyAcpActivity(data)) throw new Error(AGY_HISTORY_FAILURE);
	return { data, payloadBytes: acpTexts(data).reduce((n, t) => n + Buffer.byteLength(t.text), 0) };
}

export interface AgyHistoryEntry { id: string; parentId: string | null; type: string; customType?: string; data?: unknown }
export interface AgyHistoryGuard<T> {
	/** Check captured session/generation/owner/cwd/provider, including after append. */
	assertCurrent(): void;
	entries(): readonly AgyHistoryEntry[];
	leafId(): string | null;
	fingerprint(entries: readonly AgyHistoryEntry[]): string;
	expectedFingerprint: string;
	append(customType: string, data: T): void;
}

interface WriteContext { active: boolean; failed: boolean }
const guardWrites = new WeakMap<object, WriteContext>(), budgetWrites = new WeakMap<object, WriteContext>();
function enterWrite(contexts: WeakMap<object, WriteContext>, key: object): WriteContext {
	let state = contexts.get(key);
	if (!state) { state = { active: false, failed: false }; contexts.set(key, state); }
	if (state.active || state.failed) { state.failed = true; throw new Error(AGY_HISTORY_FAILURE); }
	state.active = true;
	return state;
}

/** Source admission belongs to the caller. Failure closes this guard; a lost acknowledgement is not retry authority. */
function appendGuarded<T>(customType: string, data: T, guard: AgyHistoryGuard<T>): { entryId: string; fingerprint: string } {
	const snapshot = structuredClone(data), serialized = JSON.stringify(snapshot), expected = guard.expectedFingerprint;
	const state = enterWrite(guardWrites, guard);
	try {
		guard.assertCurrent();
		const before = [...guard.entries()], parent = guard.leafId(), priorIds = new Set(before.map(entry => entry.id));
		if (state.failed || guard.fingerprint(before) !== expected || (before.at(-1)?.id ?? null) !== parent) throw new Error(AGY_HISTORY_FAILURE);
		guard.append(customType, structuredClone(snapshot));
		guard.assertCurrent();
		const after = [...guard.entries()], entry = after.at(-1);
		if (state.failed || after.length !== before.length + 1 || guard.fingerprint(after.slice(0, -1)) !== expected || !entry || entry.type !== "custom" || entry.customType !== customType ||
			entry.parentId !== parent || entry.id !== guard.leafId() || priorIds.has(entry.id) || JSON.stringify(entry.data) !== serialized) throw new Error(AGY_HISTORY_FAILURE);
		const fingerprint = guard.fingerprint(after);
		if (state.failed) throw new Error(AGY_HISTORY_FAILURE);
		return { entryId: entry.id, fingerprint };
	} catch (error) { state.failed = true; throw error; }
	finally { state.active = false; }
}



export function appendAgyAcpActivity(data: AgyAcpActivityObservation, guard: AgyHistoryGuard<AgyAcpActivityObservation>): { entryId: string; fingerprint: string } {
	if (!parseAgyAcpActivity(data)) throw new Error(AGY_HISTORY_FAILURE);
	return appendGuarded(AGY_ACP_ACTIVITY, data, guard);
}

/** One shared request budget spans variants/sources. Unconfirmed writes close it, even if counters never advanced. */
function recordCaptured<T>(capture: () => { data: T; payloadBytes: number }, append: (data: T) => { entryId: string; fingerprint: string }, budget: AgyActivityBudget): { entryId: string; fingerprint: string } {
	const state = enterWrite(budgetWrites, budget);
	try {
		if (!validBudget(budget)) throw new Error(AGY_HISTORY_FAILURE);
		const { data, payloadBytes } = capture(), serializedBytes = Buffer.byteLength(JSON.stringify(data));
		if (state.failed || serializedBytes > ACTIVITY_LIMITS.envelope || budget.serializedBytes + serializedBytes > ACTIVITY_LIMITS.requestSerialized) throw new Error(AGY_HISTORY_FAILURE);
		const result = append(data);
		if (state.failed) throw new Error(AGY_HISTORY_FAILURE);
		budget.payloadBytes += payloadBytes;
		budget.serializedBytes += serializedBytes;
		budget.observations++;
		return result;
	} catch (error) { state.failed = true; throw error; }
	finally { state.active = false; }
}



export function recordAgyAcpActivity(input: AgyAcpActivityInput, budget: AgyActivityBudget, guard: AgyHistoryGuard<AgyAcpActivityObservation>): { entryId: string; fingerprint: string } {
	return recordCaptured(() => captureAgyAcpActivity(input, budget), data => appendAgyAcpActivity(data, guard), budget);
}


// ─────────────────────────────────────────────────────────────────────────────
// Literal Pi transcript rendering, available without a native client

interface AgyActivityRenderView {
	toolName: string;
	stepIndex: number;
	stateLabel: string;
	isError: boolean;
	childId?: string;
	command?: CapturedText;
	parameters?: CapturedText & { encoding: "json" | "json-prefix" };
	output?: CapturedText;
	error?: { type: CapturedText; message: CapturedText };
	exitCode?: number;
	omittedFields: Record<string, CapturedText | undefined>;
	footerLines: string[];
}

function drawAgyActivity(view: AgyActivityRenderView | undefined, expanded: boolean, theme: Theme, hint?: string): Component {
	return {
		invalidate() {},
		render(width) {
			if (width < 1) return [];
			const wrap = (s: string) => wrapTextWithAnsi(sanitizeDisplayText(s).replace(/\t/g, "    "), width).map(line => truncateToWidth(line, width, ""));
			if (!view) return wrap(AGY_HISTORY_UNAVAILABLE).map(line => theme.fg("warning", line));
			const lines: string[] = [], command = view.toolName === "run_command";
			let hidden = false;
			const add = (s: string, role: "toolTitle" | "toolOutput" | "muted" | "dim" | "error" | "warning" = "toolOutput", max = Infinity) => {
				const rows = wrap(s);
				hidden ||= rows.length > max;
				lines.push(...rows.slice(0, max).map(row => theme.fg(role, row)));
			};
			add(`AGY ${command ? "command" : "tool"} · step ${view.stepIndex} · ${view.stateLabel}`, view.isError ? "error" : "toolTitle");
			if (view.childId !== undefined) add(`  Child: ${view.childId}`, "muted");
			if (command) add(`  Command: ${view.command ? view.command.text : "not reported"}`, "toolOutput", expanded ? Infinity : 1);
			else add(`  Tool: ${view.toolName}`, "toolTitle");
			if (expanded || !command) add(`  Parameters${view.parameters?.encoding === "json-prefix" ? " (JSON prefix)" : ""}: ${view.parameters ? view.parameters.text : "not reported"}`, "toolOutput", expanded ? Infinity : 1);
			if (Object.values(view.omittedFields).some(t => t !== undefined && t.omittedBytes > 0)) add("  Recorded output is incomplete.", "warning");
			let previewRows = expanded ? Infinity : 3;
			const body = (text: string, role: "toolOutput" | "error") => {
				const count = wrap(text).length;
				add(text, role, previewRows);
				previewRows = Math.max(0, previewRows - count);
			};
			if (view.output === undefined) {
				if (!view.error) add("  Output: not reported", "muted");
			} else {
				add("  Output:", "muted");
				body(view.output.text.split("\n").map(line => `    ${line}`).join("\n"), "toolOutput");
			}
			if (view.error) body(`  Error [${view.error.type.text}]: ${view.error.message.text}`, "error");
			else if (view.isError) add("  Error details: not reported", "error");
			if (view.exitCode !== undefined) add(`  Exit code: ${view.exitCode}`, "toolOutput", expanded ? Infinity : 1);
			if (expanded) for (const [name, field] of Object.entries(view.omittedFields)) if (field?.omittedBytes) add(`  ${name}: ${Buffer.byteLength(field.text)} bytes retained; ${field.omittedBytes} bytes omitted (capture limit).`, "dim");
			if (!expanded && hidden) lines.push(...wrapTextWithAnsi(`    ... (${hint ?? keyHint("app.tools.expand", "to expand")})`, width).map(line => truncateToWidth(line, width, "")));
			add(`  ${command ? "Command" : "Tool"} outcome: unknown`, "muted");
			if (expanded) for (const line of view.footerLines) add(line, "dim");
			return lines;
		},
	};
}


function acpActivityState(data: AgyAcpActivityObservation): { stateLabel: string; isError: boolean } {
	if (data.state === "completed") return { stateLabel: "reported DONE", isError: false };
	if (data.approval && data.approval.reply !== "allow_once") {
		if (data.approval.reply === "reject_once" && data.approval.reason === "user") return { stateLabel: "rejected by you", isError: false };
		return { stateLabel: "rejected by Pi", isError: false };
	}
	return { stateLabel: "reported ERROR", isError: true };
}

export function renderAgyAcpActivity(value: unknown, expanded: boolean, theme: Theme, hint?: string): Component {
	const validated = parseAgyAcpActivity(value);
	const data = validated ? structuredClone(validated) : undefined;
	const command = data?.name === "run_command";
	return drawAgyActivity(data ? {
		toolName: data.name,
		stepIndex: data.sequence,
		...acpActivityState(data),
		command: data.command,
		parameters: data.parameters,
		output: data.output,
		exitCode: data.exitCode,
		omittedFields: { command: data.command, parameters: data.parameters, output: data.output },
		footerLines: [
			`  ACP session: ${data.acpSessionId} · tool call ${data.toolCallId}`,
			`  Pi input: ${data.inputEntryId} · report ${data.sequence}`,
			`  Historical report; current ${command ? "command" : "tool"} state is unknown.`,
		],
	} : undefined, expanded, theme, hint);
}


