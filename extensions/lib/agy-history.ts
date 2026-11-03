import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { sanitizeDisplayText, type NativeEvent } from "./agy-native.js";

export const AGY_ACTIVITY = "rbf-agy-activity/v1";
export const AGY_REPORTED_ACTIVITY = "rbf-agy-activity/v2";
export const REPORTED_NATIVE_FIELDS_LIMIT = 32;
export const AGY_HISTORY_FAILURE = "AGY activity could not be saved. History may be incomplete.";
export const AGY_HISTORY_UNAVAILABLE = "AGY activity unavailable: saved record is invalid or unsupported.";
export const ACTIVITY_LIMITS = Object.freeze({ payload: 64 * 1024, requestPayload: 256 * 1024, records: 256, identity: 512, envelope: 192 * 1024, requestSerialized: 2 * 1024 * 1024 });
export type NativeToolObservation = Extract<NativeEvent, { kind: "tool" }>;
export type AgyObservationSource = { kind: "root"; conversationId: string } | { kind: "child"; conversationId: string; parentConversationId: string; childId: string };
export interface AgyObservationScope {
	piSessionId: string;
	inputEntryId: string;
	rootConversationId: string;
	turnCount: number;
	source: AgyObservationSource;
}
export interface CapturedText { text: string; originalBytes: number; omittedBytes: number }
export interface AgyActivityObservation extends AgyObservationScope {
	schemaVersion: 1;
	stepIndex: number;
	sequence: number;
	toolName: string;
	state: NativeToolObservation["state"];
	command?: CapturedText;
	parameters?: CapturedText & { encoding: "json" | "json-prefix" };
	output?: CapturedText;
	error?: { type: CapturedText; message: CapturedText };
}
/** Project only reported fields from an independently admitted container; never pass raw thinking rows. */
export interface AgyReportedStep {
	step_index: number;
	type: string;
	source: string;
	status: string;
	content: string;
	created_at?: string;
	truncated_fields?: readonly string[];
}
export interface AgyReportedStepObservation extends AgyObservationScope {
	schemaVersion: 2;
	kind: "reported-step";
	attribution: "container";
	sequence: number;
	report: Omit<AgyReportedStep, "content">;
	content: CapturedText;
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
function texts(data: AgyActivityObservation): CapturedText[] { return [data.command, data.parameters, data.output, data.error?.type, data.error?.message].filter((v): v is CapturedText => v !== undefined); }

function validScope(value: Record<string, unknown>): boolean {
	if (![value.piSessionId, value.inputEntryId, value.rootConversationId].every(identity) || !count(value.turnCount) || value.turnCount < 1 || !object(value.source)) return false;
	const source = value.source;
	if (!identity(source.conversationId)) return false;
	if (source.kind === "root") return keys(source, ["kind", "conversationId"]) && source.conversationId === value.rootConversationId;
	return source.kind === "child" && keys(source, ["kind", "conversationId", "parentConversationId", "childId"]) && identity(source.parentConversationId) && identity(source.childId) && source.conversationId !== value.rootConversationId;
}

export function parseAgyActivity(value: unknown): AgyActivityObservation | undefined {
	try {
		if (!object(value) || !keys(value, ["schemaVersion", "piSessionId", "inputEntryId", "rootConversationId", "turnCount", "source", "stepIndex", "sequence", "toolName", "state", "command", "parameters", "output", "error"]) || value.schemaVersion !== 1 ||
			!validScope(value) || !identity(value.toolName) || !count(value.stepIndex) || !count(value.sequence) || value.sequence < 1 || value.sequence > ACTIVITY_LIMITS.records || !["ACTIVE", "DONE", "ERROR"].includes(value.state as string)) return undefined;
		for (const field of ["command", "parameters", "output"] as const) if (value[field] !== undefined && !captured(value[field], field === "parameters")) return undefined;
		if (value.parameters !== undefined) {
			const parameters = value.parameters as Record<string, unknown>;
			if (parameters.encoding !== (parameters.omittedBytes === 0 ? "json" : "json-prefix")) return undefined;
			if (parameters.encoding === "json" && !object(JSON.parse(parameters.text as string))) return undefined;
		}
		if (value.command !== undefined && value.toolName !== "run_command") return undefined;
		if (value.error !== undefined && (!object(value.error) || !keys(value.error, ["type", "message"]) || !captured(value.error.type) || !captured(value.error.message))) return undefined;
		const data = value as unknown as AgyActivityObservation;
		if (texts(data).reduce((n, t) => n + Buffer.byteLength(t.text), 0) > ACTIVITY_LIMITS.payload || Buffer.byteLength(JSON.stringify(data)) > ACTIVITY_LIMITS.envelope) return undefined;
		return data;
	} catch { return undefined; }
}

const reportKeys = ["step_index", "type", "source", "status", "created_at", "truncated_fields"];
function nativeReport(value: unknown, input = false): value is Omit<AgyReportedStep, "content"> {
	if (!object(value) || !keys(value, input ? [...reportKeys, "content"] : reportKeys) || !count(value.step_index) || ![value.type, value.source, value.status].every(identity)) return false;
	if (input && typeof value.content !== "string") return false;
	if (value.created_at !== undefined && (typeof value.created_at !== "string" || Buffer.byteLength(value.created_at) > ACTIVITY_LIMITS.identity || sanitizeDisplayText(value.created_at) !== value.created_at || /[\t\n]/.test(value.created_at))) return false;
	return value.truncated_fields === undefined || Array.isArray(value.truncated_fields) && value.truncated_fields.length <= REPORTED_NATIVE_FIELDS_LIMIT && Array.from(value.truncated_fields).every(identity);
}

export function parseAgyReportedStep(value: unknown): AgyReportedStepObservation | undefined {
	try {
		if (!object(value) || !keys(value, ["schemaVersion", "kind", "attribution", "piSessionId", "inputEntryId", "rootConversationId", "turnCount", "source", "sequence", "report", "content"]) ||
			value.schemaVersion !== 2 || value.kind !== "reported-step" || value.attribution !== "container" || !validScope(value) || !count(value.sequence) || value.sequence < 1 || value.sequence > ACTIVITY_LIMITS.records ||
			!nativeReport(value.report) || !captured(value.content) || Buffer.byteLength(JSON.stringify(value)) > ACTIVITY_LIMITS.envelope) return undefined;
		return value as unknown as AgyReportedStepObservation;
	} catch { return undefined; }
}

function validBudget(budget: AgyActivityBudget): boolean {
	return count(budget.payloadBytes) && budget.payloadBytes <= ACTIVITY_LIMITS.requestPayload && count(budget.serializedBytes) && budget.serializedBytes <= ACTIVITY_LIMITS.requestSerialized && count(budget.observations) && budget.observations <= ACTIVITY_LIMITS.records;
}

/** This value records container context, never a fabricated per-row native identity or tool state. */
export function captureAgyReportedStep(input: AgyReportedStep, scope: AgyObservationScope, budget: AgyActivityBudget): { data: AgyReportedStepObservation; payloadBytes: number } {
	if (!nativeReport(input, true) || !validBudget(budget) || budget.observations >= ACTIVITY_LIMITS.records) throw new Error(AGY_HISTORY_FAILURE);
	const { content, ...report } = structuredClone(input);
	const bytes = Buffer.from(sanitizeDisplayText(content), "utf8");
	let end = Math.min(bytes.length, ACTIVITY_LIMITS.payload, ACTIVITY_LIMITS.requestPayload - budget.payloadBytes);
	while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
	const data: AgyReportedStepObservation = { ...structuredClone(scope), schemaVersion: 2, kind: "reported-step", attribution: "container", sequence: budget.observations + 1, report,
		content: { text: bytes.subarray(0, end).toString("utf8"), originalBytes: bytes.length, omittedBytes: bytes.length - end } };
	if (!parseAgyReportedStep(data)) throw new Error(AGY_HISTORY_FAILURE);
	return { data, payloadBytes: end };
}

export function captureAgyActivity(event: NativeToolObservation, scope: AgyObservationScope, budget: AgyActivityBudget): { data: AgyActivityObservation; payloadBytes: number } {
	if (budget.observations >= ACTIVITY_LIMITS.records || event.conversationId !== scope.source.conversationId) throw new Error(AGY_HISTORY_FAILURE);
	let remaining = Math.min(ACTIVITY_LIMITS.payload, ACTIVITY_LIMITS.requestPayload - budget.payloadBytes);
	const capture = (raw: string): CapturedText => {
		const bytes = Buffer.from(sanitizeDisplayText(raw), "utf8");
		let end = Math.min(bytes.length, Math.max(0, remaining));
		while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
		remaining -= end;
		return { text: bytes.subarray(0, end).toString("utf8"), originalBytes: bytes.length, omittedBytes: bytes.length - end };
	};
	const data: AgyActivityObservation = { ...structuredClone(scope), schemaVersion: 1, stepIndex: event.index, sequence: budget.observations + 1, toolName: event.toolName, state: event.state };
	if (event.toolName === "run_command" && typeof event.info?.parameters?.CommandLine === "string") data.command = capture(event.info.parameters.CommandLine);
	if (event.info?.error !== undefined) data.error = { type: capture(event.info.error.type), message: capture(event.info.error.message) };
	if (event.info?.output !== undefined) data.output = capture(event.info.output);
	if (event.info?.parameters !== undefined) {
		const parameters = capture(JSON.stringify(event.info.parameters));
		data.parameters = { ...parameters, encoding: parameters.omittedBytes === 0 ? "json" : "json-prefix" };
	}
	if (!parseAgyActivity(data)) throw new Error(AGY_HISTORY_FAILURE);
	return { data, payloadBytes: texts(data).reduce((n, t) => n + Buffer.byteLength(t.text), 0) };
}

export interface AgyHistoryEntry { id: string; parentId: string | null; type: string; customType?: string; data?: unknown }
export interface AgyHistoryGuard<T = AgyActivityObservation> {
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

export function appendAgyActivity(data: AgyActivityObservation, guard: AgyHistoryGuard): { entryId: string; fingerprint: string } {
	if (!parseAgyActivity(data)) throw new Error(AGY_HISTORY_FAILURE);
	return appendGuarded(AGY_ACTIVITY, data, guard);
}

export function appendAgyReportedStep(data: AgyReportedStepObservation, guard: AgyHistoryGuard<AgyReportedStepObservation>): { entryId: string; fingerprint: string } {
	if (!parseAgyReportedStep(data)) throw new Error(AGY_HISTORY_FAILURE);
	return appendGuarded(AGY_REPORTED_ACTIVITY, data, guard);
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

export function recordAgyActivity(event: NativeToolObservation, scope: AgyObservationScope, budget: AgyActivityBudget, guard: AgyHistoryGuard): { entryId: string; fingerprint: string } {
	return recordCaptured(() => captureAgyActivity(event, scope, budget), data => appendAgyActivity(data, guard), budget);
}

export function recordAgyReportedStep(input: AgyReportedStep, scope: AgyObservationScope, budget: AgyActivityBudget, guard: AgyHistoryGuard<AgyReportedStepObservation>): { entryId: string; fingerprint: string } {
	return recordCaptured(() => captureAgyReportedStep(input, scope, budget), data => appendAgyReportedStep(data, guard), budget);
}


// ─────────────────────────────────────────────────────────────────────────────
// Literal Pi transcript rendering, available without a native client

export function renderAgyActivity(value: unknown, expanded: boolean, theme: Theme, hint?: string): Component {
	const validated = parseAgyActivity(value);
	const data = validated ? structuredClone(validated) : undefined;
	return {
		invalidate() {},
		render(width) {
			if (width < 1) return [];
			const wrap = (s: string) => wrapTextWithAnsi(sanitizeDisplayText(s).replace(/\t/g, "    "), width).map(line => truncateToWidth(line, width, ""));
			if (!data) return wrap(AGY_HISTORY_UNAVAILABLE).map(line => theme.fg("warning", line));
			const lines: string[] = [], command = data.toolName === "run_command";
			let hidden = false;
			const add = (s: string, role: "toolTitle" | "toolOutput" | "muted" | "dim" | "error" | "warning" = "toolOutput", max = Infinity) => {
				const rows = wrap(s);
				hidden ||= rows.length > max;
				lines.push(...rows.slice(0, max).map(row => theme.fg(role, row)));
			};
			add(`AGY ${command ? "command" : "tool"} · step ${data.stepIndex} · reported ${data.state}`, data.state === "ERROR" ? "error" : "toolTitle");
			if (data.source.kind === "child") add(`  Child: ${data.source.childId}`, "muted");
			if (command) add(`  Command: ${data.command ? data.command.text : "not reported"}`, "toolOutput", expanded ? Infinity : 1);
			else add(`  Tool: ${data.toolName}`, "toolTitle");
			if (expanded || !command) add(`  Parameters${data.parameters?.encoding === "json-prefix" ? " (JSON prefix)" : ""}: ${data.parameters ? data.parameters.text : "not reported"}`, "toolOutput", expanded ? Infinity : 1);
			if (texts(data).some(t => t.omittedBytes > 0)) add("  Recorded output is incomplete.", "warning");
			let previewRows = expanded ? Infinity : 3;
			const body = (text: string, role: "toolOutput" | "error") => {
				const count = wrap(text).length;
				add(text, role, previewRows);
				previewRows = Math.max(0, previewRows - count);
			};
			if (data.output === undefined) {
				if (!data.error) add("  Output: not reported", "muted");
			} else {
				add("  Output:", "muted");
				body(data.output.text.split("\n").map(line => `    ${line}`).join("\n"), "toolOutput");
			}
			if (data.error) body(`  Error [${data.error.type.text}]: ${data.error.message.text}`, "error");
			else if (data.state === "ERROR") add("  Error details: not reported", "error");
			if (expanded) for (const [name, field] of Object.entries({ command: data.command, parameters: data.parameters, output: data.output, errorType: data.error?.type, error: data.error?.message })) if (field?.omittedBytes) add(`  ${name}: ${Buffer.byteLength(field.text)} bytes retained; ${field.omittedBytes} bytes omitted (capture limit).`, "dim");
			if (!expanded && hidden) lines.push(...wrapTextWithAnsi(`    ... (${hint ?? keyHint("app.tools.expand", "to expand")})`, width).map(line => truncateToWidth(line, width, "")));
			add(`  ${command ? "Command" : "Tool"} outcome: unknown`, "muted");
			if (expanded) {
				add(`  Native conversation: ${data.source.conversationId} · turn ${data.turnCount} · step ${data.stepIndex}`, "dim");
				add(`  Pi input: ${data.inputEntryId} · report ${data.sequence}`, "dim");
				add(`  Historical report; current ${command ? "command" : "tool"} state is unknown.`, "dim");
			}
			return lines;
		},
	};
}


/** Literal common reports: supplied native status is never a tool/child completion signal. */
export function renderAgyReportedStep(value: unknown, expanded: boolean, theme: Theme, hint?: string): Component {
	const validated = parseAgyReportedStep(value), data = validated ? structuredClone(validated) : undefined;
	return {
		invalidate() {},
		render(width) {
			if (width < 1) return [];
			const wrap = (text: string) => wrapTextWithAnsi(sanitizeDisplayText(text).replace(/\t/g, "    "), width).map(line => truncateToWidth(line, width, ""));
			if (!data) return wrap(AGY_HISTORY_UNAVAILABLE).map(line => theme.fg("warning", line));
			const lines: string[] = []; let hidden = false;
			const add = (text: string, role: "toolTitle" | "toolOutput" | "muted" | "dim" | "warning" = "toolOutput", max = Infinity) => {
				const rows = wrap(text); hidden ||= rows.length > max;
				lines.push(...rows.slice(0, max).map(row => theme.fg(role, row)));
			};
			add("AGY reported step \u00B7 step " + data.report.step_index, "toolTitle");
			if (data.source.kind === "child") add("  Child: " + data.source.childId, "muted", expanded ? Infinity : 1);
			add("  Native: type=" + data.report.type + " \u00B7 source=" + data.report.source + " \u00B7 status=" + data.report.status, "toolOutput", expanded ? Infinity : 1);
			const nativeLoss = data.report.truncated_fields;
			add("  Native truncation: " + (nativeLoss === undefined ? "not reported" : nativeLoss.length ? nativeLoss.join(", ") : "none reported"), "muted", expanded ? Infinity : 1);
			if (nativeLoss?.length) add("  Native reported truncation.", "warning");
			if (data.content.omittedBytes) add("  Local capture is incomplete.", "warning");
			add("  Reported text:", "muted");
			add(data.content.text.split("\n").map(line => "    " + line).join("\n"), "toolOutput", expanded ? Infinity : 3);
			if (expanded && data.content.omittedBytes) add("  content: " + Buffer.byteLength(data.content.text) + " bytes retained; " + data.content.omittedBytes + " bytes omitted (capture limit).", "dim");
			if (!expanded && hidden) add("    ... (" + (hint ?? keyHint("app.tools.expand", "to expand")) + ")", "muted");
			add("  Tool identity and command outcome: unknown", "muted");
			add("  Native status does not establish tool or child completion.", "muted");
			if (expanded) {
				add("  Native time: " + (data.report.created_at === undefined ? "not reported" : data.report.created_at === "" ? '""' : data.report.created_at), "dim");
				add("  Source attribution: container", "dim");
				add("  Native conversation: " + data.source.conversationId + " \u00B7 root " + data.rootConversationId + " \u00B7 turn " + data.turnCount, "dim");
				if (data.source.kind === "child") add("  Parent conversation: " + data.source.parentConversationId, "dim");
				add("  Pi input: " + data.inputEntryId + " \u00B7 report " + data.sequence, "dim");
			}
			return lines;
		},
	};
}
