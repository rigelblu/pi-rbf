import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { sanitizeDisplayText, type NativeEvent } from "./agy-native.js";

export const AGY_ACTIVITY = "rbf-agy-activity/v1";
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

export function parseAgyActivity(value: unknown): AgyActivityObservation | undefined {
	try {
		if (!object(value) || !keys(value, ["schemaVersion", "piSessionId", "inputEntryId", "rootConversationId", "turnCount", "source", "stepIndex", "sequence", "toolName", "state", "command", "parameters", "output", "error"]) || value.schemaVersion !== 1 ||
			![value.piSessionId, value.inputEntryId, value.rootConversationId, value.toolName].every(identity) || !count(value.turnCount) || value.turnCount < 1 || !count(value.stepIndex) || !count(value.sequence) || value.sequence < 1 || value.sequence > ACTIVITY_LIMITS.records || !["ACTIVE", "DONE", "ERROR"].includes(value.state as string) || !object(value.source)) return undefined;
		const source = value.source;
		if (!identity(source.conversationId)) return undefined;
		if (source.kind === "root") {
			if (!keys(source, ["kind", "conversationId"]) || source.conversationId !== value.rootConversationId) return undefined;
		} else if (source.kind === "child") {
			if (!keys(source, ["kind", "conversationId", "parentConversationId", "childId"]) || !identity(source.parentConversationId) || !identity(source.childId) || source.conversationId === value.rootConversationId) return undefined;
		} else return undefined;
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
export interface AgyHistoryGuard {
	/** Check captured session/generation/owner/cwd/provider, including after append. */
	assertCurrent(): void;
	entries(): readonly AgyHistoryEntry[];
	leafId(): string | null;
	fingerprint(entries: readonly AgyHistoryEntry[]): string;
	expectedFingerprint: string;
	append(customType: string, data: AgyActivityObservation): void;
}

/** Caller admits the source. This writer only guards its exact historical append. */
export function appendAgyActivity(data: AgyActivityObservation, guard: AgyHistoryGuard): { entryId: string; fingerprint: string } {
	if (!parseAgyActivity(data)) throw new Error(AGY_HISTORY_FAILURE);
	guard.assertCurrent();
	const before = [...guard.entries()], parent = guard.leafId(), serialized = JSON.stringify(data);
	if (guard.fingerprint(before) !== guard.expectedFingerprint || (before.at(-1)?.id ?? null) !== parent) throw new Error(AGY_HISTORY_FAILURE);
	// Keep an independent expected value: an append hook must not be able to alter both sides of read-back.
	guard.append(AGY_ACTIVITY, structuredClone(data));
	guard.assertCurrent();
	const after = [...guard.entries()], entry = after.at(-1);
	if (after.length !== before.length + 1 || guard.fingerprint(after.slice(0, -1)) !== guard.expectedFingerprint || !entry ||
		entry.type !== "custom" || entry.customType !== AGY_ACTIVITY || entry.parentId !== parent || entry.id !== guard.leafId() || before.some(e => e.id === entry.id) || JSON.stringify(entry.data) !== serialized) throw new Error(AGY_HISTORY_FAILURE);
	return { entryId: entry.id, fingerprint: guard.fingerprint(after) };
}

/** Per-request budgets advance only after a verified append; failure never authorizes a retry. */
export function recordAgyActivity(event: NativeToolObservation, scope: AgyObservationScope, budget: AgyActivityBudget, guard: AgyHistoryGuard): { entryId: string; fingerprint: string } {
	const { data, payloadBytes } = captureAgyActivity(event, scope, budget);
	const serializedBytes = Buffer.byteLength(JSON.stringify(data));
	if (serializedBytes > ACTIVITY_LIMITS.envelope || budget.serializedBytes + serializedBytes > ACTIVITY_LIMITS.requestSerialized) throw new Error(AGY_HISTORY_FAILURE);
	const result = appendAgyActivity(data, guard);
	budget.payloadBytes += payloadBytes;
	budget.serializedBytes += serializedBytes;
	budget.observations++;
	return result;
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
