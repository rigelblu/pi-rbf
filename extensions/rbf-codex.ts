import { literalMcpLabel, mcpDisplayMetadata, type McpDisplay } from "./lib/mcp-display.js";
// rbf-codex — use Codex's full agent harness through Pi (#pi-10, v0.21.12).
//
// Pi spawns `codex app-server` over stdio as a direct child, one per Pi session, and
// sends each prompt to Codex as one turn. Codex owns context, tools, sandbox, approval
// policy, and compaction; Pi passes no policy. Each Codex command, file change, and
// question becomes a real Pi tool round-trip (`codex_command`, `codex_patch`,
// `codex_question`), so one Codex turn spans several `streamSimple` calls and tool
// executions; `ActiveTurn` buffers Codex's events between them. Approvals and questions
// are answered from inside the tool's `execute` through Pi's own dialogs. One Pi branch
// maps to one Codex thread: `rbf-codex-thread/v1` records the binding and
// `rbf-codex-turn/v1` records each turn, so a branch that diverged gets a `thread/fork`
// at its last turn. Every other Codex tool call (an MCP server, an app connector, or the
// code kernel computer use runs through) is a `codex_tool` row, and computer use's per-app
// question (an MCP elicitation) is answered from the same dialog. A sub-agent's items and
// requests reach the same rows and dialogs, tagged with the agent's name, once Codex has
// announced its thread. A turn running when Pi exits is not recovered.
import { FooterComponent, keyHint, parseArgs, renderDiff, truncateToVisualLines, type ExtensionAPI, type ExtensionContext, type ProviderModelConfig, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEventStream, Context, Model, ModelThinkingLevel, RefreshModelsContext, SimpleStreamOptions, ToolCall } from "@earendil-works/pi-ai";
import { Box, Container, Editor, Spacer, Text, truncateToWidth, stripTerminalSequences, wrapTextWithAnsi, matchesKey, Key, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";

export const PROVIDER_ID = "codex-harness"; // the picker prints this id in brackets; it must read apart from Pi's built-in `openai-codex`
export const API_ID = "rbf-codex-app-server";
export const BOOTSTRAP_MODEL_ID = "codex";
/** Catalog ids briefly wore this prefix on 2026-09-13; a store written then is normalized on read. */
const LEGACY_ID_PREFIX = "codex-";
export const ENTRY_TYPE = "rbf-codex-thread/v1";
export const TURN_ENTRY_TYPE = "rbf-codex-turn/v1";
export const TOOL_COMMAND = "codex_command";
export const TOOL_PATCH = "codex_patch";
export const TOOL_QUESTION = "codex_question";
export const TOOL_TOOL = "codex_tool";
export const CODEX_FALLBACK_BIN = "/Users/tomhosiawa/.local/bin/codex";
export const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLIENT_VERSION = "0.21.12";
const SETUP_TIMEOUT_MS = 15_000;
const INTERRUPT_WAIT_MS = 3_000;
const STDERR_TAIL_LINES = 64;
const COMMAND_PREVIEW_LINES = 5;
type PreviewCache = { width?: number; styled?: string; visualLines?: string[]; skippedCount?: number };
/** A row's shared render state, as Pi's bash row keeps it: the start time for `Elapsed`/`Took`, and the per-width preview caches (the result's, and a tool row's code argument's). */
type RowState = { startedAt?: number; endedAt?: number; interval?: ReturnType<typeof setInterval>; preview?: PreviewCache; argPreview?: PreviewCache };
/** The fields of Pi's `ToolRenderContext` the renderers read; Pi's package index does not export that type (only `ToolRenderResultOptions`), so the shape is named here. */
type RenderContext = { state: unknown; executionStarted: boolean; expanded?: boolean; isError?: boolean; invalidate: () => void; lastComponent?: unknown };
const terminalWidth = () => Math.max(20, process.stdout.columns ?? 120);

export type ThreadEntry = { threadId: string; cwd: string; sessionId: string };
export type TurnEntry = { threadId: string; turnId: string; status: string };
type Rec = Record<string, unknown>;
type JsonRpc = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };

export const COPY = {
	"codex-missing": "Codex CLI not found. Install Codex, check `codex --version`, and send again.",
	"codex-version": "Codex CLI 0.157.1 or newer is required. Upgrade Codex and try again.",
	"codex-fast-version": "Codex CLI 0.166.0 or newer is required for this service choice. Upgrade Codex or choose Codex default with /fast-codex.",
	"codex-fast-unreadable": "The saved Codex service choice could not be read. Use /fast-codex and choose Codex default, then try again.",
	"codex-logged-out": "Codex is not logged in. Run `codex login`, then send again.",
	"workspace-mismatch": "This conversation's Codex thread belongs to another directory. Start a new Pi conversation here, or reopen it from that directory.",
	"unsupported-input": "This Codex model accepts plain text only. Remove the image, or pick an image-capable Codex model.",
	"unsupported-thinking-level": "This thinking level is not available for this Codex model. Your message was not sent. Choose a level with /thinking, then send again.",
	"codex-stopped": "Codex stopped unexpectedly. Send your message again to continue this conversation.",
	"turn-failed": "Codex could not complete this request. Send your message again or start a new Pi conversation.",
	"history-unverified": "Codex history for this branch could not be verified. Your message was not sent. Try /fork and resend, or /new to start cold.",
	"fork-failed": "Codex could not fork this branch. Your message was not sent. Use /new to start cold.",
	"no-answer": "Codex finished without an answer. Send your message again.",
	generic: "Codex is unavailable. See the notice for details.",
} as const;
export type CopyKey = keyof typeof COPY;

export const COMPACT_NOTICE = {
	instructions: "Codex compaction cannot take instructions. Run /compact without text.",
	busy: "Codex is busy. Try /compact after Codex finishes.",
	version: "Codex CLI 0.157.1 or newer is required. Upgrade Codex and try again.",
	noThread: "No Codex context to compact yet. Send a message first.",
	foreignBranch: "This branch needs its own Codex thread. Send a message here first, then /compact.",
	unverified: "Cannot verify this branch. Try /fork and send a message, or /new to start cold.",
	changedDraft: "Command changed while Codex checked this branch. Run /compact again.",
	movedOrChanged: "Codex conversation moved or changed while checking. Check before retrying /compact.",
	checkingStatus: "Checking Codex branch…",
	runningStatus: "Compacting Codex context…",
	runningStatusNavigated: "Compacting Codex context on the branch where /compact started…",
	completeStatus: "Codex context compacted.",
	completeNavigated: "Codex compacted the branch where /compact started; this view may be different.",
	unknown: "Codex context may have changed; completion could not be confirmed.",
	unknownNavigated: "Codex context may have changed on the branch where /compact started; completion could not be confirmed.",
	failed: (reason: string) => `Codex context was not compacted: ${reason}`,
	failedNavigated: (reason: string) => `Codex context was not compacted on the branch where /compact started: ${reason}`,
} as const;

export const COMPACT_SAFE_REASONS = {
	refused: "Codex refused this thread.",
	failed: "Codex reported a failed compaction turn.",
	interrupted: "Codex reported an interrupted compaction turn.",
} as const;

export const NOTICE = {
	declined: (what: string) => `Codex asked for ${what}; this version cannot answer, so it was declined.`,
	secret: "Codex asked for a secret; Pi cannot take one privately, so it was declined.",
	restarted: 'Codex restarted; your "Yes for this session" answers were reset.',
	nothingToSend: "Nothing to send: no user message since Codex's last answer.",
	coldStart: "Codex starts cold; it has not seen this transcript.",
	retiredModel: (model: string) => `Codex no longer offers ${model}; this turn used Codex's default model. Pick another in the model picker.`,
	compact: "Codex manages its own context; /compact is not needed in a Codex conversation.",
	interrupted: "Your last Codex request was interrupted when Pi closed. Send it again, or ask Codex what happened.",
	treeSummary: "Navigated a Codex conversation; Codex keeps its own context.",
	policy: (approval: string, sandbox: string) => `Codex: approval ${approval}, sandbox ${sandbox}.`,
	mcpStartFailed: (name: string, why: string) => `Codex MCP server ${name} failed to start${why ? `: ${why}` : ""}`,
	finishedAfterCancel: (exitCode: number | null, command: string) => `Codex's command finished after you cancelled (exit ${exitCode ?? "?"}): ${command}`,
} as const;

/** The approval dialog, in order; the third choice and Escape both answer `cancel`, which refuses and stops the turn. */
export const APPROVAL_CHOICES = ["Yes", "Yes for this session", "No, tell Codex what to do instead"] as const;
const APPROVAL_DECISION: Record<string, "accept" | "acceptForSession" | "cancel"> = { Yes: "accept", "Yes for this session": "acceptForSession", "No, tell Codex what to do instead": "cancel" };
export const OTHER_CHOICE = "Other…";
/** The cut row's text is this extension's, not Pi's: Pi's bash kills its process tree on abort, Codex keeps the command running (probe 2026-09-14), so the word `aborted` would claim a death that did not happen (Q24). */
export const ROW_STATUS = { declined: "Declined", cancelled: "Cancelled", aborted: "Cancelled; command still running in Codex", stopped: "Codex stopped" } as const;
/** The cut row's status: only a command row can have a command still running; a question, patch, or tool call row was simply cancelled (review 2026-09-14). */
export function cutStatus(kind: RowKind): string {
	return kind === "commandExecution" ? ROW_STATUS.aborted : ROW_STATUS.cancelled;
}

/** Codex reports commands wrapped in the login shell (`/bin/zsh -lc '<cmd>'`); show what the user would have typed. */
export function displayCommand(command: string): string {
	const m = /^\/bin\/(?:zsh|bash|sh) -lc (.*)$/s.exec(command);
	if (!m) return command;
	const inner = m[1];
	return /^'(.*)'$/s.test(inner) ? inner.slice(1, -1) : inner;
}

/** Which server requests are questions for the human; only these open a row and a dialog. */
export function humanRequestKind(method: string): "approval" | "input" | undefined {
	if (/approval/i.test(method)) return "approval";
	if (/requestUserInput|elicitation/i.test(method)) return "input";
	return undefined;
}
const HUMAN_REQUESTS: Record<string, RequestKind> = {
	"item/commandExecution/requestApproval": "commandExecution",
	"item/fileChange/requestApproval": "fileChange",
	"item/tool/requestUserInput": "question",
	"mcpServer/elicitation/request": "elicitation",
};
/** Computer use asks per app through an empty-form MCP elicitation tagged as a tool-call approval (probe 2026-09-14); only that shape becomes a dialog. A real form or a URL prompt is declined. */
export function isAppApproval(p: Rec): boolean {
	const meta = p._meta && typeof p._meta === "object" ? (p._meta as Rec) : {};
	const schema = p.requestedSchema && typeof p.requestedSchema === "object" ? (p.requestedSchema as Rec) : {};
	const props = schema.properties && typeof schema.properties === "object" ? (schema.properties as Rec) : {};
	return p.mode === "form" && meta.codex_approval_kind === "mcp_tool_call" && Object.keys(props).length === 0;
}

// ── tool argument shapes; persisted in every session log, so irreversible ─────
/** Which Codex thread ran the item and which agent it is (`agentPath`, e.g. `/root/alpha`); both empty for the root thread. Rows written before v0.21.4 carry neither and read as the root's. */
const AgentFields = { threadId: Type.String(), agentPath: Type.String() };
export const CommandParams = Type.Object({ itemId: Type.String(), ...AgentFields, command: Type.String(), cwd: Type.String() });
export const PatchChange = Type.Object({ path: Type.String(), kind: Type.String(), movePath: Type.Optional(Type.String()), diff: Type.String() });
export const PatchParams = Type.Object({ itemId: Type.String(), ...AgentFields, changes: Type.Array(PatchChange) });
export const QuestionOption = Type.Object({ label: Type.String(), description: Type.String() });
export const Question = Type.Object({ id: Type.String(), header: Type.String(), question: Type.String(), options: Type.Optional(Type.Array(QuestionOption)), isOther: Type.Optional(Type.Boolean()), isSecret: Type.Optional(Type.Boolean()) });
export const QuestionParams = Type.Object({ itemId: Type.String(), ...AgentFields, questions: Type.Array(Question) });
/** `arguments` is Codex's object as sent (the `code` of a `js` call, an app connector's fields); `appContext` is read for display only and not persisted. */
export const ToolCallParams = Type.Object({ itemId: Type.String(), ...AgentFields, server: Type.String(), tool: Type.String(), arguments: Type.Unknown(), display: Type.Optional(Type.Object({ appName: Type.Optional(Type.String()), connectorId: Type.Optional(Type.String()), pluginId: Type.Optional(Type.String()) })) });
export type AgentArgs = { threadId: string; agentPath: string };
export type CommandArgs = AgentArgs & { itemId: string; command: string; cwd: string };
export type PatchChangeArg = { path: string; kind: string; movePath?: string; diff: string };
export type PatchArgs = AgentArgs & { itemId: string; changes: PatchChangeArg[] };
export type QuestionArg = { id: string; header: string; question: string; options?: { label: string; description: string }[]; isOther?: boolean; isSecret?: boolean };
export type QuestionArgs = AgentArgs & { itemId: string; questions: QuestionArg[] };
export type ToolCallArgs = AgentArgs & { itemId: string; server: string; tool: string; arguments: unknown; display?: McpDisplay };
export type RowKind = "commandExecution" | "fileChange" | "question" | "mcpToolCall";
/** A server request a row's `execute` answers: an item's approval or question, or computer use's per-app question (an MCP elicitation with no item of its own). */
export type RequestKind = RowKind | "elicitation";

/** The agent's name from Codex's `agentPath` (`/root/alpha` → `alpha`); empty for the root. */
export function agentName(agentPath: string | undefined): string {
	return (agentPath ?? "").split("/").filter(Boolean).pop() ?? "";
}
/** A sub-agent's row wears its name as a muted tag before the unchanged title, one per line (a patch row has one line per file). */
export function tagLines(theme: Pick<Theme, "fg">, agentPath: string | undefined, styled: string): string {
	const name = agentName(agentPath);
	if (!name) return styled;
	const tag = theme.fg("muted", `${name} `);
	return styled.split("\n").map((l) => `${tag}${l}`).join("\n");
}

/** Codex sends its own title for a computer-use call in `arguments.title`; the row shows it on the title line and the remaining arguments below. */
export function splitTitle(args: unknown): { title?: string; rest: unknown } {
	if (!args || typeof args !== "object" || Array.isArray(args)) return { rest: args ?? {} };
	const { title, ...rest } = args as Rec;
	return typeof title === "string" && title ? { title, rest } : { rest: args };
}
/** The one argument that is the whole call, the `code` of a `js` call: drawn as its own lines, collapsed as a command's output is. */
export function loneString(args: unknown): string | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const values = Object.values(args as Rec);
	return values.length === 1 && typeof values[0] === "string" && values[0] ? values[0] : undefined;
}

/**
 * Pi's edit row, `renderDiff`, and `rbf-edit-glance` read Pi's own numbered diff lines (`+2 new`, `-1 old`, ` 3 context`, ` ...` for a gap),
 * not a unified diff. Codex sends a unified diff (bare hunks) for an `update` and the whole file content for an `add` or `delete`.
 */
export function toPreviewDiff(kind: string, text: string): string {
	if (!text) return "";
	const body = text.replace(/\n$/, "").split("\n");
	const rows: { sign: string; num: number | null; line: string }[] = [];
	if (kind === "add" || kind === "delete") {
		const sign = kind === "add" ? "+" : "-";
		body.forEach((line, i) => rows.push({ sign, num: i + 1, line }));
	} else {
		let oldN = 1;
		let newN = 1;
		let inHunk = !body.some((l) => l.startsWith("@@"));
		for (const line of body) {
			const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
			if (hunk) {
				if (rows.length) rows.push({ sign: " ", num: null, line: "..." });
				oldN = Number(hunk[1]);
				newN = Number(hunk[2]);
				inHunk = true;
				continue;
			}
			if (!inHunk || line.startsWith("\\")) continue; // file headers before the first hunk; `\ No newline at end of file`
			if (line.startsWith("+")) rows.push({ sign: "+", num: newN++, line: line.slice(1) });
			else if (line.startsWith("-")) rows.push({ sign: "-", num: oldN++, line: line.slice(1) });
			else {
				rows.push({ sign: " ", num: oldN, line: line.slice(1) });
				oldN++;
				newN++;
			}
		}
	}
	const width = String(Math.max(1, ...rows.map((r) => r.num ?? 0))).length;
	return rows.map((r) => `${r.sign}${(r.num === null ? "" : String(r.num)).padStart(width, " ")} ${r.line}`).join("\n");
}

/** Codex's `FileUpdateChange.kind` is a tagged object; the tool argument carries it flat. */
export function flattenChanges(changes: unknown): PatchChangeArg[] {
	if (!Array.isArray(changes)) return [];
	return changes.map((c) => {
		const r = (c ?? {}) as Rec;
		const kind = r.kind && typeof r.kind === "object" ? (r.kind as Rec) : {};
		const movePath = typeof kind.move_path === "string" ? kind.move_path : undefined;
		const type = String(kind.type ?? "update");
		return { path: String(r.path ?? ""), kind: type, ...(movePath ? { movePath } : {}), diff: toPreviewDiff(type, String(r.diff ?? "")) };
	});
}

/** Pi's rows show the path the model gave, usually relative; Codex gives absolute ones, so show them relative to the working directory, or under `~`. */
export function displayPath(p: string, cwd: string = process.cwd()): string {
	if (!isAbsolute(p)) return p;
	const rel = relative(cwd, p);
	if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
	const home = homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function diffCounts(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

/** Pi's own row word for Codex's change kind. */
export function patchVerb(kind: string): string {
	return kind === "add" ? "write" : kind === "delete" ? "delete" : "edit";
}

export function patchRowLine(c: PatchChangeArg): string {
	const { added, removed } = diffCounts(c.diff);
	const target = c.movePath ? `${displayPath(c.path)} → ${displayPath(c.movePath)}` : displayPath(c.path);
	return `${patchVerb(c.kind)} ${target} (+${added} −${removed})`;
}

function patchPathsSummary(changes: PatchChangeArg[]): string {
	return changes
		.map((c) => {
			const { added, removed } = diffCounts(c.diff);
			return `${displayPath(c.path)} (+${added} −${removed})`;
		})
		.join(", ");
}

/** A dialog title is truncated to the width with `…`: keep the leading verb and the first command or path; drop the reason first, then trailing paths. */
export function truncateTitle(title: string, width: number): string {
	if (title.length <= width) return title;
	const reasonAt = title.indexOf(" — ");
	if (reasonAt !== -1) {
		const withoutReason = title.slice(0, reasonAt);
		if (withoutReason.length <= width) return withoutReason;
		title = withoutReason;
	}
	while (title.length > width && title.includes(", ")) title = title.slice(0, title.lastIndexOf(", "));
	if (title.length <= width) return title;
	return `${title.slice(0, Math.max(1, width - 1))}…`;
}

export function approvalTitle(kind: RowKind, req: Rec, changes: PatchChangeArg[]): string {
	const reason = typeof req.reason === "string" && req.reason ? ` — ${req.reason}` : "";
	if (kind === "fileChange") return `${changes.length ? `Codex wants to edit: ${patchPathsSummary(changes)}` : "Codex wants to edit files"}${reason}`;
	const command = typeof req.command === "string" && req.command ? displayCommand(req.command) : "(pending)";
	const verb = req.kind === "writeStdin" ? "Codex wants to send input to:" : "Codex wants to run:";
	return `${verb} ${command}${reason}`;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const ZERO_USAGE = { ...ZERO_COST, totalTokens: 0, cost: { ...ZERO_COST, total: 0 } };
const SENTINEL = 1_000_000_000; // keeps Pi's threshold compaction from ever firing
const CODEX_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Pi hides a level only when its entry is null and treats a missing entry as selectable, so every Codex map names all seven levels with off and minimal always null. */
export function withFixedThinkingLevels(map?: Record<string, string | null>): Record<string, string | null> {
	const out: Record<string, string | null> = { off: null, minimal: null };
	for (const level of CODEX_LEVELS) out[level] = map?.[level] ?? null;
	return out;
}

/** The user pressed Escape while a setup request or a row's wait was in flight. */
class AbortedError extends Error {}
/** Pi tints a row as an error only when the tool throws (its bash tool throws on a nonzero exit or an abort); a returned `isError` is ignored. So an error row throws this, carrying the row text. */
export class RowError extends Error {}
/** The turn ended while a tool execution was still waiting on its item. */
class TurnEndedError extends Error {
	constructor(readonly status: string) {
		super(`turn ended: ${status}`);
	}
}

export class CodexError extends Error {
	constructor(
		readonly key: CopyKey,
		readonly detail?: string,
	) {
		super(COPY[key]);
	}
}

function rec(v: unknown): Rec {
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new CodexError("generic", "Codex returned a non-object");
	return v as Rec;
}

/** A logged-out Codex accepts `initialize` and `thread/start`, then reports 401 during the turn; this is the tell wherever it surfaces. */
function isLoggedOut(text: string): boolean {
	return /401|Unauthorized/i.test(text);
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

// ── catalog ──────────────────────────────────────────────────────────────────
export const BOOTSTRAP_MODEL: ProviderModelConfig = {
	id: BOOTSTRAP_MODEL_ID,
	name: "Codex agent",
	reasoning: true,
	thinkingLevelMap: withFixedThinkingLevels({ low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }),
	input: ["text"],
	contextWindow: SENTINEL,
	maxTokens: SENTINEL,
	cost: ZERO_COST,
};

type CodexModel = { id: string; displayName: string; hidden: boolean; supportedReasoningEfforts: { reasoningEffort: string }[]; inputModalities?: string[] };

/** Pi model id → the id Codex expects on `turn/start`; the bootstrap row sends none. */
export function codexModelId(piModelId: string): string | undefined {
	if (piModelId === BOOTSTRAP_MODEL_ID) return undefined;
	return piModelId.startsWith(LEGACY_ID_PREFIX) ? piModelId.slice(LEGACY_ID_PREFIX.length) : piModelId;
}

/** One Codex `model/list` entry → Pi model config. Pi offers `xhigh` and `max` only when the map names them; Pi's editor accepts a paste only when `input` lists `image`. */
export function toProviderModel(m: CodexModel): ProviderModelConfig {
	const efforts = new Set(m.supportedReasoningEfforts.map((e) => e.reasoningEffort));
	const supported: Record<string, string | null> = {};
	for (const level of CODEX_LEVELS) if (efforts.has(level)) supported[level] = level;
	return {
		id: m.id, // Codex's own id; the provider tag in the picker row tells it apart from openai-codex
		name: `${m.displayName} (Codex agent)`,
		reasoning: true,
		thinkingLevelMap: withFixedThinkingLevels(supported),
		input: m.inputModalities?.includes("image") ? ["text", "image"] : ["text"],
		contextWindow: SENTINEL,
		maxTokens: SENTINEL,
		cost: ZERO_COST,
	};
}

/** Pi's persisted store holds full `Model` objects; map them back to registration configs. */
function storedToConfigs(stored: RefreshModelsContext["stored"]): ProviderModelConfig[] {
	return (stored?.models ?? [])
		.filter((m) => m.id !== BOOTSTRAP_MODEL_ID)
		// A store written during the brief `codex-` prefix holds prefixed ids; normalize so no session ever sees both forms.
		.map((m) => ({ id: m.id.startsWith(LEGACY_ID_PREFIX) ? m.id.slice(LEGACY_ID_PREFIX.length) : m.id, name: m.name, reasoning: m.reasoning, thinkingLevelMap: withFixedThinkingLevels(m.thinkingLevelMap), input: m.input, contextWindow: m.contextWindow, maxTokens: m.maxTokens, cost: m.cost }));
}

function toStoredModel(c: ProviderModelConfig): Model<typeof API_ID> {
	return { id: c.id, name: c.name, api: API_ID, provider: PROVIDER_ID, baseUrl: "stdio://codex", reasoning: c.reasoning, thinkingLevelMap: c.thinkingLevelMap, input: c.input, cost: c.cost, contextWindow: c.contextWindow, maxTokens: c.maxTokens };
}

export function mapEffort(model: Model<any>, level: ModelThinkingLevel | undefined): string | undefined {
	if (!level) return undefined;
	const mapped = model.thinkingLevelMap?.[level];
	return typeof mapped === "string" ? mapped : undefined;
}

// ── Pi's assistant-message event protocol, one writer per streamSimple call ──
// Pi rebuilds the message from `partial` snapshots indexed by content block, so thinking,
// text, and tool calls interleave as separate blocks: switching kind closes the open block.
export class AssistantMessageWriter {
	readonly stream = createAssistantMessageEventStream();
	private readonly partial: AssistantMessage;
	private open: { kind: "thinking" | "text"; index: number } | null = null;
	private ended = false;
	started = false;

	constructor(model: Model<any>) {
		this.partial = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: ZERO_USAGE, stopReason: "stop", timestamp: Date.now() };
	}

	private snap(): AssistantMessage {
		return { ...this.partial, content: this.partial.content.map((b) => ({ ...b })) };
	}

	private closeBlock(): void {
		if (!this.open) return;
		const b = this.partial.content[this.open.index] as { text?: string; thinking?: string };
		if (this.open.kind === "text") this.stream.push({ type: "text_end", contentIndex: this.open.index, content: b.text ?? "", partial: this.snap() });
		else this.stream.push({ type: "thinking_end", contentIndex: this.open.index, content: b.thinking ?? "", partial: this.snap() });
		this.open = null;
	}

	private delta(kind: "thinking" | "text", text: string): void {
		if (!text || this.ended) return;
		if (this.open?.kind !== kind) {
			this.closeBlock();
			const index = this.partial.content.length;
			this.partial.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
			this.open = { kind, index };
			this.stream.push(kind === "text" ? { type: "text_start", contentIndex: index, partial: this.snap() } : { type: "thinking_start", contentIndex: index, partial: this.snap() });
		}
		const b = this.partial.content[this.open.index] as { text?: string; thinking?: string };
		if (kind === "text") b.text = (b.text ?? "") + text;
		else b.thinking = (b.thinking ?? "") + text;
		this.stream.push(kind === "text" ? { type: "text_delta", contentIndex: this.open.index, delta: text, partial: this.snap() } : { type: "thinking_delta", contentIndex: this.open.index, delta: text, partial: this.snap() });
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.stream.push({ type: "start", partial: this.snap() });
	}
	thinking(text: string): void {
		this.delta("thinking", text);
	}
	text(text: string): void {
		this.delta("text", text);
	}
	/** One tool call block; the call then ends with `finish("toolUse")` and Pi executes the tool. */
	toolCall(toolCall: ToolCall): void {
		if (this.ended) return;
		this.closeBlock();
		const index = this.partial.content.length;
		this.partial.content.push(toolCall);
		this.stream.push({ type: "toolcall_start", contentIndex: index, partial: this.snap() });
		this.stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: this.snap() });
	}
	/** Terminal event; `errorMessage` is always one of the fixed COPY sentences, never Codex text. */
	finish(kind: "done" | "toolUse" | "aborted" | "error", errorKey?: CopyKey): void {
		if (this.ended) return;
		this.ended = true;
		this.closeBlock();
		const message: AssistantMessage = { ...this.partial, timestamp: Date.now(), stopReason: kind === "done" ? "stop" : kind };
		if (kind === "done" || kind === "toolUse") this.stream.push({ type: "done", reason: kind === "done" ? "stop" : "toolUse", message });
		else {
			message.errorMessage = kind === "aborted" ? "Request was aborted" : COPY[errorKey ?? "generic"];
			this.stream.push({ type: "error", reason: kind, error: message });
		}
		this.stream.end(message);
	}
}

// ── stdio JSON-RPC client; one per Pi session, not detached ──────────────────
export class AppServerClient {
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private readonly listeners = new Set<(m: JsonRpc) => void>();
	readonly stderrTail: string[] = [];
	exited = false;
	readonly onExit = new Set<() => void>();
	/** Handles an inbound server request; returns false to have it answered with a JSON-RPC error at once. */
	onRequest: ((m: JsonRpc & { id: number | string; method: string }) => boolean) | null = null;
	/** Command rows cut while their command still ran (item id → command): Codex keeps the command, so its completion is watched here, past the turn's end, for one notice. */
	readonly cutCommands = new Map<string, string>();
	/** Turn ids that ended on this child: a late item from one must not be taken for the next turn's while that turn waits for its own id (review 2026-09-14). */
	readonly endedTurns = new Set<string>();

	private constructor(readonly child: ChildProcessWithoutNullStreams) {
		// A write that lands after Codex died raises EPIPE on stdin; unhandled, that exits Pi. `exit` follows anyway.
		child.stdin.on("error", () => {});
		// JSONL uses LF boundaries; Unicode line/paragraph separators remain valid JSON string data.
		let fragments: string[] = [];
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			let start = 0;
			let end: number;
			while ((end = chunk.indexOf("\n", start)) !== -1) {
				fragments.push(chunk.slice(start, end));
				const line = fragments.join("");
				fragments = [];
				start = end + 1;
				this.receive(line);
			}
			if (start < chunk.length) fragments.push(chunk.slice(start));
		}).on("end", () => {
			if (fragments.length) this.receive(fragments.join(""));
		});
		child.stderr.on("data", (chunk: Buffer | string) => {
			for (const l of String(chunk).split("\n")) if (l.trim()) this.stderrTail.push(l.trim());
			while (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
		});
		child.once("exit", () => {
			this.exited = true;
			for (const p of [...this.pending.values()]) p.reject(new CodexError("codex-stopped", this.lastStderr()));
			for (const fn of this.onExit) fn();
		});
	}

	static async start(cwd: string, command: CodexCommand): Promise<AppServerClient> {
		const trySpawn = (bin: string) =>
			new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
				const child = spawn(bin, command.args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
				child.once("spawn", () => resolve(child));
				child.once("error", reject);
			});
		let child: ChildProcessWithoutNullStreams;
		try {
			child = await trySpawn(command.bin);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new CodexError("generic", String(e));
			if (!command.fallbackBin) throw new CodexError("codex-missing");
			try {
				child = await trySpawn(command.fallbackBin);
			} catch {
				throw new CodexError("codex-missing");
			}
		}
		return new AppServerClient(child);
	}

	lastStderr(): string | undefined {
		return this.stderrTail[this.stderrTail.length - 1];
	}

	private receive(line: string): void {
		let m: JsonRpc;
		try {
			m = JSON.parse(line) as JsonRpc;
		} catch {
			return;
		}
		if (m.id !== undefined && m.method) {
			let handled = false;
			try {
				handled = this.onRequest?.(m as JsonRpc & { id: number | string; method: string }) === true;
			} catch {
				handled = false;
			}
			if (!handled) this.respondError(m.id, "pi-rbf-codex does not answer this request");
			for (const fn of [...this.listeners]) fn(m);
			return;
		}
		if (typeof m.id === "number") {
			const p = this.pending.get(m.id);
			if (!p) return; // a reply that already timed out or was aborted
			if (m.error) p.reject(new CodexError("generic", m.error.message));
			else p.resolve(m.result);
			return;
		}
		// A snapshot: a turn that subscribes while this message is dispatched (the next turn, started from the previous one's end) must not receive it.
		if (m.method) for (const fn of [...this.listeners]) fn(m);
	}

	private write(m: JsonRpc): void {
		if (this.exited || !this.child.stdin.writable) return;
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
	}

	request(method: string, params: unknown, timeoutMs = SETUP_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
		if (this.exited) return Promise.reject(new CodexError("codex-stopped", this.lastStderr()));
		if (signal?.aborted) return Promise.reject(new AbortedError());
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const done = (fn: () => void) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.pending.delete(id);
				fn();
			};
			const onAbort = () => done(() => reject(new AbortedError()));
			const timer = setTimeout(() => done(() => reject(new CodexError("generic", `Timed out waiting for ${method}`))), timeoutMs);
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(id, { resolve: (v) => done(() => resolve(v)), reject: (e) => done(() => reject(e)) });
			this.write({ id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		this.write({ method, params });
	}

	/** `turn/interrupt` is a request in Codex's schema (a notification is silently ignored, probe 2026-09-14); the reply carries nothing we need. */
	interrupt(threadId: string, turnId: string): void {
		void this.request("turn/interrupt", { threadId, turnId }, SETUP_TIMEOUT_MS).catch(() => {});
	}

	/** Answer one server request; each id is answered exactly once by its owner. */
	respond(id: number | string, result: unknown): void {
		this.write({ id, result });
	}
	respondError(id: number | string, message: string): void {
		this.write({ id, error: { code: -32601, message } });
	}

	subscribe(fn: (m: JsonRpc) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	/** stdin EOF, 2 s, SIGTERM, 1 s, SIGKILL. The probe showed Codex exits on EOF in about 250 ms. */
	async close(): Promise<void> {
		if (this.exited) return;
		const exited = new Promise<void>((resolve) => this.onExit.add(resolve));
		const wait = (ms: number) => Promise.race([exited, new Promise<void>((r) => setTimeout(r, ms))]);
		this.child.stdin.end();
		await wait(2_000);
		if (this.exited) return;
		this.child.kill("SIGTERM");
		await wait(1_000);
		if (!this.exited) this.child.kill("SIGKILL");
	}
}

export type CodexCommand = { bin: string; args: string[]; fallbackBin?: string; versionArgs?: string[] };

export const COMPACT_SUBMIT_INTERCEPTED_KEY = Symbol.for("rbf.codex.compactSubmitIntercepted");
export const COMPACT_DISPATCHER_KEY = Symbol.for("rbf.codex.compactDispatcher");

export const MIN_CODEX_VERSION = "0.157.1";
const NAVIGATION_FEEDBACK_DELAY_MS = 50; // let Pi paint its own navigation status before our branch-qualified notice

export function parseCodexVersion(output: string): [number, number, number] | null {
	const match = /^(?:codex(?:-cli)?\s+)?v?(\d+)\.(\d+)\.(\d+)$/i.exec(output.trim());
	if (!match) return null;
	return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

export function isSupportedCodexVersion(output: string): boolean {
	const v = parseCodexVersion(output);
	if (!v) return false;
	const [major, minor, patch] = v;
	if (major > 0) return true;
	if (major < 0) return false;
	if (minor > 157) return true;
	if (minor < 157) return false;
	return patch >= 1;
}

export function versionArgsFor(command: CodexCommand): string[] {
	if (command.versionArgs) return command.versionArgs;
	if (command.args.length > 0 && /\.[tj]sx?$/.test(command.args[0])) {
		return [command.args[0], "--version"];
	}
	return ["--version"];
}

export async function checkCodexVersion(command: CodexCommand, minimum?: [number, number, number]): Promise<boolean> {
	const argsToUse = versionArgsFor(command);
	const runVersion = (bin: string) =>
		new Promise<string>((resolve, reject) => {
			const cp = spawn(bin, argsToUse, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
			let out = "";
			let err = "";
			const timer = setTimeout(() => {
				cp.kill();
				reject(new Error("Timeout checking codex version"));
			}, 5_000);
			cp.stdout?.on("data", (d) => { out += String(d); });
			cp.stderr?.on("data", (d) => { err += String(d); });
			cp.once("error", (e) => {
				clearTimeout(timer);
				reject(e);
			});
			cp.once("close", (code) => {
				clearTimeout(timer);
				if (code === 0) resolve(out);
				else reject(new Error(`codex --version exited with code ${code}: ${err}`));
			});
		});

	let stdout = "";
	try {
		stdout = await runVersion(command.bin);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT" && command.fallbackBin) {
			try {
				stdout = await runVersion(command.fallbackBin);
			} catch {
				return false;
			}
		} else {
			return false;
		}
	}
	if (!minimum) return isSupportedCodexVersion(stdout);
	const version = parseCodexVersion(stdout);
	if (!version) return false;
	for (let i = 0; i < 3; i++) {
		if (version[i] !== minimum[i]) return version[i] > minimum[i];
	}
	return true;
}

export function isCompactCommand(text: unknown): boolean {
	if (typeof text !== "string") return false;
	const trimmed = text.trim();
	return trimmed === "/compact" || /^\/compact\s/.test(trimmed);
}

export function installCompactSubmitInterceptor(EditorClass: typeof Editor = Editor): void {
	if (!EditorClass || !EditorClass.prototype) return;
	const proto = EditorClass.prototype as any;
	if (proto[COMPACT_SUBMIT_INTERCEPTED_KEY]) return;

	const originalSubmitValue = proto.submitValue;
	if (typeof originalSubmitValue !== "function") return;

	proto.submitValue = function (this: any, ...args: any[]) {
		const dispatcher = (EditorClass as any)[COMPACT_DISPATCHER_KEY];
		const text = typeof this.expandPasteMarkers === "function"
			? this.expandPasteMarkers(this.state.lines.join("\n")).trim()
			: (this.getText?.() ?? "").trim();
		if (dispatcher && isCompactCommand(text) && dispatcher.shouldIntercept()) {
			return dispatcher.dispatch(this, text);
		}
		return originalSubmitValue.apply(this, args);
	};

	proto[COMPACT_SUBMIT_INTERCEPTED_KEY] = true;
}

export type TurnClassification = "user" | "compaction" | "unverified";

export function classifyCompletedTurn(items: unknown[] | undefined): TurnClassification {
	if (!Array.isArray(items) || items.length === 0) return "unverified";
	const hasValidUserMessage = items.some((item) => {
		if (!item || typeof item !== "object") return false;
		const it = item as Record<string, unknown>;
		return typeof it.id === "string" && it.id.length > 0 && it.type === "userMessage" && Array.isArray(it.content);
	});
	if (hasValidUserMessage) return "user";
	const allCompaction = items.every((item) => {
		if (!item || typeof item !== "object") return false;
		const it = item as Record<string, unknown>;
		return it.type === "contextCompaction";
	});
	if (allCompaction) return "compaction";
	return "unverified";
}

export type HistoryVerificationResult =
	| { ok: true }
	| { ok: false; diverged: boolean };

export async function verifyBranchHistory(
	client: AppServerClient,
	threadId: string,
	expectedTurnId: string,
	signal?: AbortSignal
): Promise<HistoryVerificationResult> {
	const startTime = Date.now();
	let cursor: string | undefined = undefined;
	let pageCount = 0;
	const seenCursors = new Set<string>();
	const seenTurns = new Set<string>();
	let unseenUser = false;

	while (pageCount < 100 && Date.now() - startTime < 30_000) {
		if (signal?.aborted) return { ok: false, diverged: false };
		pageCount++;
		const limit = pageCount === 1 ? 5 : 20;
		let res: Rec;
		try {
			res = rec(await client.request(
				"thread/turns/list",
				{ threadId, sortDirection: "desc", itemsView: "full", limit, ...(cursor ? { cursor } : {}) },
				Math.min(SETUP_TIMEOUT_MS, Math.max(1, 30_000 - (Date.now() - startTime))),
				signal
			));
		} catch {
			return { ok: false, diverged: false };
		}

		if (!Array.isArray(res.data) || (res.nextCursor !== null && res.nextCursor !== undefined && typeof res.nextCursor !== "string")) return { ok: false, diverged: false };
		const data = res.data as Rec[];
		if (!data.length && (pageCount === 1 || res.nextCursor)) return { ok: false, diverged: false };

		for (const turn of data) {
			if (!turn || typeof turn.id !== "string" || !turn.id || seenTurns.has(turn.id)) return { ok: false, diverged: false };
			seenTurns.add(turn.id);
			const status = turn.status;
			const classification = classifyCompletedTurn(turn.items as unknown[] | undefined);
			if (turn.id === expectedTurnId) {
				if (status !== "completed" || classification !== "user") return { ok: false, diverged: false };
				return unseenUser ? { ok: false, diverged: true } : { ok: true };
			}
			if (status === "completed") {
				if (classification === "unverified") return { ok: false, diverged: false };
				if (classification === "user") unseenUser = true;
			}
		}

		const nextCursor = typeof res.nextCursor === "string" ? res.nextCursor : null;
		if (!nextCursor) return { ok: false, diverged: false };
		if (seenCursors.has(nextCursor)) {
			return { ok: false, diverged: false };
		}
		seenCursors.add(nextCursor);
		cursor = nextCursor;
	}

	return { ok: false, diverged: false };
}

/** No completed Pi user turn: native history may contain interruptions or compaction, not completed user work. */
export async function verifyEmptyBranchHistory(
	client: AppServerClient,
	threadId: string,
	signal?: AbortSignal
): Promise<boolean> {
	const startTime = Date.now();
	let cursor: string | undefined = undefined;
	let pageCount = 0;
	const seenCursors = new Set<string>();
	const seenTurns = new Set<string>();

	while (pageCount < 100 && Date.now() - startTime < 30_000) {
		if (signal?.aborted) return false;
		pageCount++;
		const limit = pageCount === 1 ? 5 : 20;
		let res: Rec;
		try {
			res = rec(await client.request(
				"thread/turns/list",
				{ threadId, sortDirection: "desc", itemsView: "full", limit, ...(cursor ? { cursor } : {}) },
				Math.min(SETUP_TIMEOUT_MS, Math.max(1, 30_000 - (Date.now() - startTime))),
				signal
			));
		} catch {
			return false;
		}

		if (signal?.aborted || Date.now() - startTime >= 30_000) return false;
		if (!Array.isArray(res.data) || res.nextCursor === "" || (res.nextCursor !== null && res.nextCursor !== undefined && typeof res.nextCursor !== "string")) return false;
		const data = res.data as Rec[];
		if (!data.length && res.nextCursor) return false;
		for (const turn of data) {
			if (!turn || typeof turn.id !== "string" || !turn.id || seenTurns.has(turn.id)) return false;
			seenTurns.add(turn.id);
			if (!Array.isArray(turn.items)) return false;
			if (turn.status !== "interrupted" && (turn.status !== "completed" || classifyCompletedTurn(turn.items) !== "compaction")) return false;
		}

		const nextCursor = typeof res.nextCursor === "string" ? res.nextCursor : null;
		if (!nextCursor) {
			return true;
		}
		if (seenCursors.has(nextCursor)) {
			return false;
		}
		seenCursors.add(nextCursor);
		cursor = nextCursor;
	}
	return false;
}

export type RbfCodexOptions = {
	/** How to spawn the app-server; tests point this at a fake. */
	command?: CodexCommand;
	/** Bounded lifecycle wait; tests shorten this rather than waiting three minutes. */
	compactTimeoutMs?: number;
	/** Frozen argv for the `--sandbox` guard; defaults to `process.argv.slice(2)`. */
	argv?: string[];
	/** Clock for catalog freshness; tests inject one. */
	now?: () => number;
};

const DEFAULT_COMMAND: CodexCommand = { bin: "codex", args: ["app-server"], fallbackBin: CODEX_FALLBACK_BIN };

export function isSandboxLaunch(argv: string[]): boolean {
	return parseArgs(argv).unknownFlags.has("sandbox");
}

// ── shell display observer (pi-42) ──
// Display only. A shell-count view listens on this channel. Nothing sent here starts, stops, approves or settles work,
// and nothing in this section may throw into the code that does. The view is a separate extension that can be removed,
// so this owner imports nothing from it and publishes what it saw without saying what it proves.
// The channel code below is the same as in `rbf-background-tasks.ts`; neither owner imports the other.

export const SHELL_DISPLAY_CHANNEL = "rbf:shell-display:v1";
/** How many invocations an owner keeps for a view that attaches late. */
export const SHELL_DISPLAY_SNAPSHOT_LIMIT = 2000;
/** How many facts it keeps for one invocation: the first, and the newest after it. */
export const SHELL_DISPLAY_FACTS_PER_INVOCATION = 16;

/**
 * What this owner saw of one Codex command item, as it saw it.
 * - `start`: Codex's `item/started` for the command was admitted
 * - `cut`: the row was cut by an interruption while the item had not completed. Codex doesn't kill the command
 * - `completion`: Codex's `item/completed`, with `exitCode` and `status` as they arrived
 * - `not-run`: this owner refused the command's approval before any start was admitted
 * - `lost`: nobody can vouch for the command any more. The client that admitted it is gone, its turn ended some other way than an interruption
 *   while it was open, or a completion named its item on another thread
 */
export type CodexDisplayFact =
	| { kind: "start" }
	| { kind: "cut"; identity: string }
	| { kind: "completion"; exitCode: unknown; status: unknown }
	| { kind: "not-run" }
	| { kind: "lost" };

/** A completed command item as a fact: the two fields as Codex sent them, absent or null included. Never the row's defaulted copy. */
export function shellCompletionFact(item: Rec): CodexDisplayFact {
	return { kind: "completion", exitCode: item.exitCode, status: item.status };
}

/** One command item's display identity: the thread it was admitted on, captured from the owner, and whether its start was admitted. */
type CodexDisplayCall = { bind: ShellDisplayCall<CodexDisplayFact>["bind"]; tell: (fact: CodexDisplayFact) => void; threadId: string; started: boolean; lost?: boolean; lastCompletion?: Rec };

type ShellDisplayBus = { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void };
type ShellDisplayTool = { name: string; execute: unknown; renderCall?: unknown; renderResult?: unknown };

/** One invocation's identity, captured when its execute began. `tell` publishes a fact about it and never throws. */
type DisplayScope = { clientGeneration: string; threadId: string };
type DisplayMembership = { itemId: string; threadId: string; agentPath: string; cwd: string };
export type ShellDisplayCall<Fact> = { sessionId: string; toolCallId: string; tell: (fact: Fact) => void; bind: (args: object, membership: DisplayMembership) => void };

/**
 * One owner's side of the display channel: it announces itself, publishes facts, keeps the last `limit` invocations for a view
 * that asks later, and withdraws. `ends` says which facts close an invocation; when the bound is hit the least recently updated
 * ended invocation goes first, and an open one only when no ended one is left. Undefined on a Pi with no event bus.
 */
export function createShellDisplayOwner<Fact extends { kind: string }>(
	events: ShellDisplayBus | undefined,
	source: string,
	ends: (fact: Fact) => boolean,
	limit = SHELL_DISPLAY_SNAPSHOT_LIMIT,
) {
	if (typeof events?.emit !== "function" || typeof events.on !== "function") return undefined;
	let sessionId = "";
	let ownerGeneration = "";
	let tool: ShellDisplayTool | undefined;
	let stopListening: (() => void) | undefined;
	/** Retained invocations by call id, least recently updated first. */
	type Retained = { toolCallId: string; clientGeneration?: string; ended: boolean; messages: unknown[]; membership?: Record<string, unknown>; lifetime: { closed: boolean } };
	const retained = new Map<string, Retained>();

	// Each message is sent on its own: a subscriber that throws on one must not cut short the withdrawal, the announcement or the facts after it.
	const send = (message: unknown) => {
		try {
			events.emit(SHELL_DISPLAY_CHANNEL, message);
		} catch {}
	};
	const revoke = (invocation: Retained) => {
		invocation.lifetime.closed = true;
		if (!invocation.membership) return;
		const membership = invocation.membership;
		delete invocation.membership;
		send({ ...membership, kind: "membership-withdraw", revision: 2 });
	};
	const announce = () =>
		send({ kind: "announce", sessionId, source, toolName: tool?.name, ownerGeneration, execute: tool?.execute, renderCall: tool?.renderCall, renderResult: tool?.renderResult });
	const answer = (data: unknown) => {
		try {
			const request = data as { kind?: unknown; sessionId?: unknown; toolCallIds?: unknown } | undefined;
			if (!ownerGeneration || request?.kind !== "snapshot-request" || request.sessionId !== sessionId) return;
			announce();
			// A request that names calls gets those calls' facts only; one that names none gets everything kept.
			const wanted = [...retained.values()].filter((call) => !Array.isArray(request.toolCallIds) || request.toolCallIds.includes(call.toolCallId));
			for (const invocation of wanted) {
				if (invocation.membership) send(invocation.membership);
				for (const message of invocation.messages) send(message);
			}
		} catch {}
	};
	const withdraw = () => {
		if (!ownerGeneration) return;
		send({ kind: "withdraw", sessionId, source, ownerGeneration });
		ownerGeneration = "";
		retained.clear();
	};

	return {
		/** A session began: withdraw what was announced before, then announce under a fresh generation. */
		start(session: string | undefined, registered: ShellDisplayTool): void {
			try {
				withdraw();
				if (!session) return;
				sessionId = session;
				tool = registered;
				ownerGeneration = `${source}:${randomUUID()}`;
				stopListening ??= events.on(SHELL_DISPLAY_CHANNEL, answer);
				announce();
			} catch {}
		},
		/** The identity of one invocation, captured now. Undefined while nothing is announced. */
		open(toolCallId: string, scope?: DisplayScope): ShellDisplayCall<Fact> | undefined {
			if (!ownerGeneration) return undefined;
			const identity = { sessionId, source, ownerGeneration, toolCallId, ...scope };
			const key = scope ? JSON.stringify([scope.clientGeneration, scope.threadId, toolCallId]) : toolCallId;
			const lifetime = retained.get(key)?.lifetime ?? { closed: false };
			const keep = () => {
				const invocation: Retained = retained.get(key) ?? { toolCallId, clientGeneration: scope?.clientGeneration, ended: false, messages: [], lifetime };
				retained.delete(key);
				retained.set(key, invocation);
				if (retained.size > limit) {
					const evict = [...retained].find(([, call]) => call.ended)?.[0] ?? retained.keys().next().value;
					if (evict !== undefined) { revoke(retained.get(evict)!); retained.delete(evict); }
				}
				return invocation;
			};
			// Scoped handles share their admission lifetime even when opened before either binds.
			if (scope) keep();
			let revision = 0;
			const tell = (fact: Fact) => {
				try {
					// A call from before a withdrawal or a new session says nothing: no old callback speaks for a new owner.
					if (identity.ownerGeneration !== ownerGeneration) return;
					const message = { kind: "fact", ...identity, revision: ++revision, fact };
					const invocation = keep();
					invocation.messages.push(message);
					if (invocation.messages.length > SHELL_DISPLAY_FACTS_PER_INVOCATION) invocation.messages.splice(1, 1);
					invocation.ended ||= ends(fact);
					send(message);
				} catch {}
			};
			return { sessionId, toolCallId, tell, bind(args, membership) {
				try {
					if (identity.ownerGeneration !== ownerGeneration || !scope || lifetime.closed) return;
					const invocation = keep();
					if (invocation.membership) return;
					invocation.membership = { kind: "membership", ...identity, ...membership, revision: 1, binding: new WeakRef(args) };
					send(invocation.membership);
				} catch {}
			} };
		},
		/** The client left. Process facts remain available; its weak live presentation admission ends. */
		retireClient(clientGeneration: string): void {
			try { for (const invocation of retained.values()) if (invocation.clientGeneration === clientGeneration) revoke(invocation); } catch {}
		},
		/** The owner is going away: withdraw, forget the snapshot and stop answering. */
		stop(): void {
			try {
				withdraw();
				stopListening?.();
				stopListening = undefined;
			} catch {}
		},
	};
}

// ── the Codex side of one turn, across every streamSimple call and tool execution it spans ──
type UserInputItem = { type: "text"; text: string; text_elements: [] } | { type: "image"; url: string };
type TurnItem = { kind: RowKind; threadId: string; agentPath: string; rowOpened: boolean; command?: string; cwd?: string; changes: PatchChangeArg[]; questions: QuestionArg[]; output: string; completed?: Rec; server?: string; tool?: string; arguments?: unknown; appName?: string; displayMetadata?: McpDisplay; answered?: Answer; aborted?: boolean; display?: CodexDisplayCall; /** Display only: Pi called this row's execute, which reports its own ending. */ executed?: boolean };
/** A sub-agent Codex announced on this turn; `turnId` is known once its `turn/started` arrives (a live parent re-drives an interrupted child with a new turn on the same thread). */
type ChildThread = { turnId: string | null; agentPath: string };
type PendingRequest = { id: number | string; method: string; params: Rec; kind: RequestKind; itemId: string };
/** What a dialog answered, applied to the request's own row: a question's answers, or a refused approval; an accepted approval, and the app question, leave the row waiting for its item. */
type Answer = { kind: RequestKind; decision?: string; answers?: Record<string, string>; declined?: boolean };
type WaitOutcome = { kind: "completed"; item: Rec } | { kind: "request"; req: PendingRequest };
type Waiter = { itemId: string; resolve: (o: WaitOutcome) => void; reject: (e: Error) => void; onUpdate?: (output: string) => void };

/** The `mcpToolCall` fields a row shows: server, tool, the arguments as sent, and the app's name when Codex's `appContext` carries one. */
function describeToolCall(it: TurnItem, item: Rec): void {
	it.server ??= String(item.server ?? "");
	it.tool ??= String(item.tool ?? "");
	it.arguments ??= item.arguments ?? {};
	const app = item.appContext && typeof item.appContext === "object" ? (item.appContext as Rec) : {};
	if (typeof app.appName === "string" && app.appName) it.appName = app.appName;
	it.displayMetadata = mcpDisplayMetadata({ appName: app.appName, connectorId: app.connectorId, pluginId: item.pluginId ?? app.pluginId });
}
type ProjectedEvent =
	| { kind: "row"; itemId: string }
	| { kind: "thinking"; text: string }
	| { kind: "answer"; text: string }
	| { kind: "final"; text: string }
	| { kind: "end"; status: string; error?: string };

// ── passive Codex agent overview (pi-10.11) ───────────────────────────────────
export const AGENTS_ENTRY_TYPE = "rbf-codex-agents/v1";
export const AGENTS_MAX_BYTES = 256 * 1024;
const AGENTS_MAX_ROWS = 128;
const AGENT_LABELS = { unknown: "Status not provided", pendingInit: "Starting", running: "Running", interrupted: "Interrupted", completed: "Completed", errored: "Error", shutdown: "Closed", notFound: "Unavailable", turnComplete: "Turn complete" } as const;
type AgentStatus = keyof typeof AGENT_LABELS;
export type CodexAgentFact = { threadId: string; parentThreadId?: string; name?: string; task?: string; status: AgentStatus; observedAt: string };
export type CodexAgentSnapshot = { version: 1; rootThreadId: string; observedAt: string; agents: CodexAgentFact[]; partial: boolean };
const agentRecord = (v: unknown): Rec => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Rec : {};
const agentId = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(v);
const agentText = (v: unknown, max: number): string | undefined => {
	if (typeof v !== "string") return undefined;
	const clean = stripTerminalSequences(v).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
	return Array.from(clean).slice(0, max).join("") || undefined;
};
const agentStatus = (v: unknown): v is AgentStatus => typeof v === "string" && Object.hasOwn(AGENT_LABELS, v);
const agentDate = (v: unknown): v is string => typeof v === "string" && v.length <= 30 && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

/** Display facts only. No client, tool dispatch, request replies, or execution admission lives here. */
export class CodexAgentRoster {
	rootThreadId = "";
	unavailable = false;
	partial = false;
	notSaved = false;
	private rows = new Map<string, CodexAgentFact>();
	private fresh = new Set<string>();
	private announced = new Set<string>();
	private turns = new Map<string, string>();
	private earlyTurns = new Map<string, string>();
	private seenItems = new Set<string>();
	private retiredTurns = new Set<string>();
	private exhausted = false;
	private rootTurnId = "";
	private active = false;
	constructor(private readonly clock: () => number = Date.now) {}
	get agents(): CodexAgentFact[] { return [...this.rows.values()].map(a => ({ ...a })); }
	isFresh(id: string): boolean { return this.fresh.has(id); }
	private timestamp(): string { return new Date(this.clock()).toISOString(); }
	snapshot(): CodexAgentSnapshot { return { version: 1, rootThreadId: this.rootThreadId, observedAt: this.timestamp(), agents: this.agents, partial: this.partial }; }
	restore(root: string, data?: unknown): void {
		this.rootThreadId = agentId(root) ? root : "";
		this.retiredTurns.clear(); this.exhausted = false; this.rootTurnId = "";
		this.rows.clear(); this.fresh.clear(); this.announced.clear(); this.turns.clear(); this.earlyTurns.clear(); this.seenItems.clear(); this.active = false;
		this.unavailable = false; this.partial = false; this.notSaved = false;
		if (data === undefined) return;
		try {
			if (Buffer.byteLength(JSON.stringify(data), "utf8") > AGENTS_MAX_BYTES) throw new Error("size");
			const s = agentRecord(data);
			if (s.version !== 1 || !agentId(s.rootThreadId) || !agentDate(s.observedAt) || typeof s.partial !== "boolean" || !Array.isArray(s.agents) || s.agents.length > AGENTS_MAX_ROWS) throw new Error("shape");
			if (s.rootThreadId !== this.rootThreadId) return; // inherited data belongs to a different binding
			const parsed = new Map<string, CodexAgentFact>();
			for (const value of s.agents) {
				const a = agentRecord(value);
				if (!agentId(a.threadId) || a.threadId === this.rootThreadId || parsed.has(a.threadId) || !agentStatus(a.status) || !agentDate(a.observedAt) || (a.parentThreadId !== undefined && !agentId(a.parentThreadId))) throw new Error("agent");
				if ((a.name !== undefined && (typeof a.name !== "string" || a.name !== agentText(a.name, 128))) || (a.task !== undefined && (typeof a.task !== "string" || a.task !== agentText(a.task, 1024)))) throw new Error("text");
				parsed.set(a.threadId, { threadId: a.threadId, ...(a.parentThreadId ? { parentThreadId: a.parentThreadId } : {}), ...(a.name ? { name: a.name } : {}), ...(a.task ? { task: a.task } : {}), status: a.status, observedAt: a.observedAt });
			}
			this.rows = parsed; this.partial = s.partial;
		} catch { this.unavailable = true; }
	}
	begin(root: string, ended: Iterable<string> = []): boolean {
		const changed = this.rootThreadId !== root;
		const hadRoot = !!this.rootThreadId;
		if (changed) this.restore(root);
		this.finish(); for (const id of ended) this.retire(id); this.active = !this.exhausted; this.rootTurnId = "";
		return (changed && hadRoot) || this.exhausted;
	}
	private retire(id: string): void {
		if (!id || this.retiredTurns.has(id)) return;
		if (this.retiredTurns.size >= 4096) { this.exhausted = true; this.partial = true; this.active = false; return; }
		this.retiredTurns.add(id);
	}
	finish(): void { this.retire(this.rootTurnId); for (const id of this.turns.values()) this.retire(id); for (const id of this.earlyTurns.values()) this.retire(id); this.active = false; this.fresh.clear(); this.announced.clear(); this.turns.clear(); this.earlyTurns.clear(); this.seenItems.clear(); }
	setTurn(id: string): void { if (this.active && agentId(id) && !this.retiredTurns.has(id)) this.rootTurnId = id; }
	private put(id: string, patch: Partial<CodexAgentFact>, status?: AgentStatus): void {
		if (!agentId(id) || id === this.rootThreadId) return;
		const old = this.rows.get(id);
		if (!old && this.rows.size >= AGENTS_MAX_ROWS) { this.partial = true; return; }
		const next: CodexAgentFact = { threadId: id, status: "unknown", observedAt: this.timestamp(), ...old, ...patch, ...(status ? { status } : {}) };
		const changed = !old || next.name !== old.name || next.task !== old.task || next.parentThreadId !== old.parentThreadId || next.status !== old.status || (!!status && !this.fresh.has(id));
		if (!changed) return;
		next.observedAt = this.timestamp();
		this.rows.set(id, next); this.unavailable = false;
		if (status) this.fresh.add(id);
		// Bound both the visible retained set and its exact serialized representation.
		while (Buffer.byteLength(JSON.stringify(this.snapshot()), "utf8") > AGENTS_MAX_BYTES && this.rows.size) {
			const last = [...this.rows.keys()].at(-1)!;
			this.rows.delete(last); this.fresh.delete(last); this.announced.delete(last); this.turns.delete(last); this.partial = true;
		}
	}
	observe(method: string | undefined, p: Rec): boolean {
		if (!this.active || !method || !["thread/started", "turn/started", "turn/completed", "item/started", "item/completed"].includes(method)) return false;
		if ((method === "item/started" || method === "item/completed") && !["subAgentActivity", "collabAgentToolCall"].includes(String(agentRecord(p.item).type))) return false;
		if (method === "turn/started" && this.retiredTurns.has(String(agentRecord(p.turn).id))) return false;
		const before = JSON.stringify([this.agents, [...this.fresh], this.partial]);
		const tid = p.threadId;
		if (method === "thread/started") {
			const t = agentRecord(p.thread);
			if (agentId(t.id) && this.announced.has(t.id)) this.put(t.id, { ...(agentText(t.agentNickname, 128) ? { name: agentText(t.agentNickname, 128) } : {}) });
		} else if (method === "turn/started" && agentId(tid) && tid !== this.rootThreadId) {
			const id = agentRecord(p.turn).id;
			if (agentId(id)) {
				if (this.announced.has(tid)) { const old = this.turns.get(tid); if (old && old !== id) this.retire(old); this.turns.set(tid, id); this.put(tid, {}, "running"); }
				else if (this.earlyTurns.has(tid) || this.earlyTurns.size < AGENTS_MAX_ROWS) { const old = this.earlyTurns.get(tid); if (old && old !== id) this.retire(old); this.earlyTurns.set(tid, id); }
			}
		} else {
			if (tid === this.rootThreadId && method === "turn/started" && !this.rootTurnId) this.setTurn(String(agentRecord(p.turn).id ?? ""));
			const root = tid === this.rootThreadId && !!this.rootTurnId && (p.turnId === this.rootTurnId || agentRecord(p.turn).id === this.rootTurnId);
			const child = agentId(tid) && this.announced.has(tid) && !!this.turns.get(tid) && (p.turnId === this.turns.get(tid) || agentRecord(p.turn).id === this.turns.get(tid));
			if (!root && !child) return false;
			if (method === "turn/completed" && child) {
				const t = agentRecord(p.turn); this.put(tid as string, {}, t.status === "completed" ? "turnComplete" : t.status === "interrupted" ? "interrupted" : t.status === "failed" ? "errored" : undefined); this.retire(String(t.id)); this.turns.delete(tid as string);
			} else if (method === "item/started" || method === "item/completed") {
				const item = agentRecord(p.item);
				if (item.type === "subAgentActivity" || item.type === "collabAgentToolCall") {
					if (!agentId(item.id)) return false;
					const key = JSON.stringify([tid, root ? this.rootTurnId : this.turns.get(String(tid)), method, item.id]);
					if (this.seenItems.has(key)) return false;
					if (this.seenItems.size >= 4096) { this.partial = true; return before !== JSON.stringify([this.agents, [...this.fresh], this.partial]); }
					this.seenItems.add(key);
				}
				const admit = (id: unknown) => {
					if (!agentId(id) || id === this.rootThreadId) return false;
					this.put(id, { parentThreadId: String(tid) });
					if (!this.rows.has(id)) return false;
					this.announced.add(id);
					const early = this.earlyTurns.get(id); if (early) { this.turns.set(id, early); this.earlyTurns.delete(id); }
					return true;
				};
				if (item.type === "subAgentActivity" && method === "item/started" && admit(item.agentThreadId)) {
					const name = agentText(agentName(typeof item.agentPath === "string" ? item.agentPath : undefined), 128);
					this.put(item.agentThreadId as string, name ? { name } : {}, item.kind === "started" ? "running" : item.kind === "completed" ? "completed" : item.kind === "interrupted" ? "interrupted" : undefined);
				} else if (item.type === "collabAgentToolCall") {
					const states = agentRecord(item.agentsStates);
					for (const id of Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []) {
						if (!admit(id)) continue;
						const task = method === "item/completed" && item.status === "completed" && (item.tool === "spawnAgent" || item.tool === "followupTask") ? agentText(item.prompt, 1024) : undefined;
						const st = agentRecord(states[id as string]).status;
						this.put(id as string, task ? { task } : {}, agentStatus(st) && st !== "unknown" && st !== "turnComplete" ? st : undefined);
					}
				}
			}
		}
		return before !== JSON.stringify([this.agents, [...this.fresh], this.partial]);
	}
	private name(a: CodexAgentFact): string {
		if (a.name) return a.name;
		let n = Math.min(8, a.threadId.length);
		while (this.agents.some(b => b.threadId !== a.threadId && b.threadId.slice(0, n) === a.threadId.slice(0, n))) n++;
		return `Agent ${a.threadId.slice(0, n)}`;
	}
	private status(a: CodexAgentFact): string { return `${this.fresh.has(a.threadId) ? "" : "Last recorded: "}${AGENT_LABELS[a.status]}`; }
	full(width: number): string[] {
		const rows = [`Codex agents · ${this.fresh.size ? "Reported activity" : "Last recorded"}`];
		if (this.unavailable) rows.push("Saved agent overview is unavailable.");
		else if (!this.rows.size) rows.push("No agent activity recorded on this branch.");
		this.agents.forEach((a, n) => {
			rows.push(...wrapTextWithAnsi(`${n + 1}. ${this.name(a)} [${a.threadId}] · ${this.status(a)}`, Math.max(1, width)));
			rows.push(...wrapTextWithAnsi(`   Observed ${a.observedAt}`, Math.max(1, width)), ...wrapTextWithAnsi(`   ${a.task ?? "Task not provided"}`, Math.max(1, width)));
		});
		if (this.partial) rows.push("Partial overview · display limit");
		if (this.notSaved) rows.push("Not saved");
		return rows.map(s => truncateToWidth(s, Math.max(1, width)));
	}
}

export type CodexContextSnapshot = { tokens: number; contextWindow: number };

/** A latest reported snapshot, never cumulative accounting or a Pi context estimate. */
export class CodexContextMeter {
	private threadId = "";
	private turnId = "";
	private epoch = 0;
	private viewEpoch = 0;
	get viewGeneration(): number { return this.viewEpoch; }
	snapshot: CodexContextSnapshot | undefined;

	clear(): void { this.threadId = ""; this.turnId = ""; this.snapshot = undefined; this.epoch++; this.viewEpoch++; }
	begin(threadId: string): number { this.threadId = threadId; this.turnId = ""; this.snapshot = undefined; return ++this.epoch; }
	confirmTurn(epoch: number, turnId: string): void { if (epoch === this.epoch && this.threadId) this.turnId = turnId; }
	observe(method: string | undefined, params: unknown): boolean {
		const p = agentRecord(params);
		if (!this.threadId || p.threadId !== this.threadId) return false;
		if (method === "turn/started" && !this.turnId) {
			const id = agentRecord(p.turn).id;
			if (typeof id === "string" && id) this.turnId = id;
		}
		if (method === "thread/compacted" || ((method === "item/started" || method === "item/completed") && agentRecord(p.item).type === "contextCompaction")) {
			this.clear(); // a delayed pre-compaction count must not revive this turn
			return true;
		}
		if (method !== "thread/tokenUsage/updated" || !this.turnId || p.turnId !== this.turnId) return false;
		const u = agentRecord(p.tokenUsage), tokens = agentRecord(u.last).totalTokens, contextWindow = u.modelContextWindow;
		const valid = typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0 && typeof contextWindow === "number" && Number.isSafeInteger(contextWindow) && contextWindow > 0;
		const next = valid ? { tokens: tokens as number, contextWindow: contextWindow as number } : undefined;
		const changed = next?.tokens !== this.snapshot?.tokens || next?.contextWindow !== this.snapshot?.contextWindow;
		this.snapshot = next;
		return changed;
	}
}

function codexContextTokens(count: number): string {
	if (count < 1000) return String(count);
	const scale = count < 1_000_000 ? 1000 : 1_000_000;
	return (count / scale).toFixed(1).replace(/\.0$/, "") + (scale === 1000 ? "k" : "M");
}

export function formatCodexContext(snapshot: CodexContextSnapshot | undefined): string {
	if (!snapshot) return "context ? (Codex)";
	const { tokens, contextWindow } = snapshot;
	return `${(tokens / contextWindow * 100).toFixed(1)}%/${codexContextTokens(contextWindow)} · ${codexContextTokens(Math.max(0, contextWindow - tokens))} left (Codex)`;
}

// Use the same registry protocol as the shell/todo badges; this extension also works alone.
const AGENTS_FOOTER_REGISTRY = Symbol.for("@earendil-works/pi-rbf:footer-registry");
type AgentFooterHook = { id: string; reset?: () => void; render(this: any, lines: string[], width: number): string[]; handleMouse(this: any, event: TuiMouseEvent): TuiMouseEventResult | undefined };
type AgentFooterRegistry = { hooks: Map<string, AgentFooterHook>; originalRender: (width: number) => string[]; originalHandleMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined; installedRender?: (this: any, width: number) => string[]; installedHandleMouse?: (this: any, event: TuiMouseEvent) => TuiMouseEventResult | undefined; isHandlingMouse?: boolean };

/** OSC22 uses CSS shapes on these direct hosts; keep highlight-only fallback elsewhere. */
export function createCodexAgentPointer(env: NodeJS.ProcessEnv = process.env, tty: boolean | undefined = process.stdout.isTTY, write: (data: string) => void = data => { process.stdout.write(data); }) {
	const supported = !!tty && !env.TMUX && !env.STY && (env.TERM_PROGRAM === "ghostty" || env.TERM_PROGRAM === "cmux" || env.TERM === "xterm-ghostty" || env.TERM === "xterm-kitty" || !!env.KITTY_WINDOW_ID);
	let active = false;
	return (inside: boolean) => {
		if (!supported || inside === active) return;
		try { write("\x1b]22;" + (inside ? "pointer" : "text") + "\x1b\\"); active = inside; } catch {}
	};
}

function codexFooterRegistry() {
	const proto = FooterComponent.prototype as typeof FooterComponent.prototype & { [AGENTS_FOOTER_REGISTRY]?: AgentFooterRegistry; handleMouse?: AgentFooterRegistry["originalHandleMouse"] };
	let registry = proto[AGENTS_FOOTER_REGISTRY];
	if (!registry) {
		const created: AgentFooterRegistry = { hooks: new Map(), originalRender: proto.render, originalHandleMouse: proto.handleMouse };
		created.installedRender = function(width) {
			let lines = created.originalRender.call(this, width);
			for (const hook of created.hooks.values()) { try { lines = hook.render.call(this, lines, width); } catch {} }
			return lines;
		};
		created.installedHandleMouse = function(event) {
			if (created.isHandlingMouse) return;
			created.isHandlingMouse = true;
			try {
				const original = created.originalHandleMouse?.call(this, event);
				if (original?.handled) return original;
				for (const hook of created.hooks.values()) { try { const result = hook.handleMouse.call(this, event); if (result?.handled) return result; } catch {} }
				return original;
			} finally { created.isHandlingMouse = false; }
		};
		registry = proto[AGENTS_FOOTER_REGISTRY] = created;
		proto.render = created.installedRender;
		proto.handleMouse = created.installedHandleMouse;
	}
	return { proto, registry };
}

/** Run before badge layout, including when the shell registry was installed first. */
export function installCodexContextFooter(visible: () => boolean, getSnapshot: () => CodexContextSnapshot | undefined, getTheme: () => Pick<Theme, "fg" | "bold"> | undefined, getService?: () => "fast" | "standard" | undefined) {
	const { proto, registry } = codexFooterRegistry();
	const nativeContext = /(?:\d+(?:\.\d+)?%|\?)\/[\d.]+[kM]?(?: \(auto\))?/;
	const hook: AgentFooterHook = {
		id: "codex-context",
		render(lines, width) {
			if (!visible() || this.session?.state?.model?.provider !== PROVIDER_ID || !lines[1]) return lines;
			let base = lines;
			// Tiny native layouts may already clip the placeholder; recover the complete stats first.
			if (!nativeContext.test(base[1])) base = registry.originalRender.call(this, Math.max(width, 512));
			const padding = base[1].match(/^(.*?)(\s{2,})(.*)$/);
			let left = padding ? padding[1] : base[1];
			let right = padding?.[3] ?? "";
			let service: "fast" | "standard" | undefined;
			try { service = getService?.(); } catch {}
			if (service && right) {
				let prefix: string = service;
				try { prefix = getTheme()?.fg("dim", service) ?? service; } catch {}
				right = `${prefix} ${right}`;
			}
			let snapshot: CodexContextSnapshot | undefined;
			try { snapshot = getSnapshot(); } catch {}
			let label = formatCodexContext(snapshot);
			try { const percent = snapshot ? snapshot.tokens / snapshot.contextWindow * 100 : 0; label = getTheme()?.fg(percent > 90 ? "error" : percent > 70 ? "warning" : "dim", label) ?? label; } catch {}
			left = nativeContext.test(left) ? left.replace(nativeContext, () => label) : label;
			left = truncateToWidth(left, Math.max(0, width), "");
			const available = width - visibleWidth(left) - 2;
			const model = available > 0 ? truncateToWidth(right, available, "") : "";
			const result = base.map(line => truncateToWidth(line, Math.max(0, width), ""));
			result[1] = left + (model ? " ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(model))) + model : "");
			return result;
		},
		handleMouse() { return undefined; },
	};
	// Replacement retains first position, regardless of shell/agents/todo load order.
	const rest = [...registry.hooks].filter(([id]) => id !== hook.id);
	registry.hooks.clear(); registry.hooks.set(hook.id, hook);
	for (const [id, h] of rest) registry.hooks.set(id, h);
	return { dispose() {
		if (registry.hooks.get(hook.id) !== hook) return;
		registry.hooks.delete(hook.id);
		if (!registry.hooks.size && proto.render === registry.installedRender && proto.handleMouse === registry.installedHandleMouse) {
			proto.render = registry.originalRender;
			if (registry.originalHandleMouse) proto.handleMouse = registry.originalHandleMouse; else delete proto.handleMouse;
			delete proto[AGENTS_FOOTER_REGISTRY];
		}
	} };
}

export function installCodexAgentsFooter(visible: () => boolean, open: () => void, getTheme: () => Pick<Theme, "fg" | "bold"> | undefined, pointer?: (inside: boolean) => void) {
	const { proto, registry } = codexFooterRegistry();
	let hovered = false, screenY: number | undefined;
	let bounds: { start: number; end: number } | undefined;
	const setHovered = (inside: boolean) => { if (hovered === inside) return; hovered = inside; try { pointer?.(inside); } catch {} };
	const reset = () => { setHovered(false); bounds = undefined; screenY = undefined; };
	const hook: AgentFooterHook = {
		id: "codex-agents",
		reset,
		render(lines, width) {
			bounds = undefined;
			if (!visible() || !lines[1]) { reset(); return lines; }
			const stats = lines[1], padding = stats.match(/^(.*?)(\s{2,})(.*)$/);
			const left = padding ? padding[1] : stats, right = padding?.[3] ?? "";
			const start = visibleWidth(left) + 3, end = start + 6;
			// An incomplete label must not leave a stale or invisible mouse target.
			if (end > width) { reset(); return lines; }
			const theme = getTheme();
			const label = hovered ? (theme?.bold?.("\x1b[7magents\x1b[27m") ?? "\x1b[7magents\x1b[27m") : (theme?.fg?.("accent", "agents") ?? "agents");
			const added = left + " " + (theme?.fg?.("dim", "· ") ?? "· ") + label;
			const remaining = width - visibleWidth(added) - 2;
			const model = remaining > 0 ? truncateToWidth(right, remaining, "") : "";
			bounds = { start, end };
			const result = [...lines];
			result[1] = added + (model ? " ".repeat(Math.max(2, width - visibleWidth(added) - visibleWidth(model))) + model : "");
			return result;
		},
		handleMouse(event) {
			if (!visible() || !bounds) { reset(); return; }
			screenY = event.screenY - event.y + 1;
			const inside = event.y === 1 && event.x >= bounds.start && event.x < bounds.end;
			if (event.type === "move") {
				const changed = hovered !== inside; setHovered(inside);
				return changed ? { handled: true, render: true } : inside ? { handled: true } : undefined;
			}
			if (inside && event.button === "left") {
				if (event.type === "press") return { handled: true };
				if (event.type === "click") { setHovered(false); open(); return { handled: true, render: true }; }
			}
		},
	};
	registry.hooks.get(hook.id)?.reset?.();
	registry.hooks.set(hook.id, hook);
	return {
		reset,
		pointerInput(data: string): boolean {
			const event = /^\x1b\[<\d+;(\d+);(\d+)[Mm]$/.exec(data);
			if (!hovered || !event) return false;
			const outside = !bounds || Number(event[2]) - 1 !== screenY || Number(event[1]) - 1 < bounds.start || Number(event[1]) - 1 >= bounds.end;
			if (outside) setHovered(false);
			return outside;
		},
		dispose() {
			reset();
			if (registry!.hooks.get(hook.id) !== hook) return;
			registry!.hooks.delete(hook.id);
			if (!registry!.hooks.size && proto.render === registry!.installedRender && proto.handleMouse === registry!.installedHandleMouse) {
				proto.render = registry!.originalRender;
				if (registry!.originalHandleMouse) proto.handleMouse = registry!.originalHandleMouse; else delete proto.handleMouse;
				delete proto[AGENTS_FOOTER_REGISTRY];
			}
		},
	};
}

// ── the extension ────────────────────────────────────────────────────────────
export function createRbfCodex(options: RbfCodexOptions = {}) {
	const command = options.command ?? DEFAULT_COMMAND;
	const now = options.now ?? Date.now;

	return function rbfCodex(pi: ExtensionAPI): void {
		// `pi --sandbox` (#pi-23) and this provider stay mutually exclusive.
		if (isSandboxLaunch(options.argv ?? process.argv.slice(2))) return;

		const instanceOwner = Symbol("codexInstance");
		const state = {
			ctx: null as ExtensionContext | null,
			client: null as AppServerClient | null,
			shuttingDown: false,
			noticedPolicy: false,
			activeTurn: null as ActiveTurn | null,
			approvedForSession: false,
			noticedElicitation: false,
			pendingCompact: null as Promise<void> | null,
			checkingCompact: null as { cancelled: boolean; abort: AbortController } | null,
			runningCompact: null as { threadId: string; navigatedDuringRun: boolean; finished: boolean } | null,
			recentCompactTerminal: null as { at: number; outcome: "completed" | "failed" | "unknown"; reason?: string; replayed: boolean } | null,
		};
		type FastMode = "fast" | "standard" | "inherit";
		const fastEntryType = "rbf-codex-fast/v1";
		const fastLabels: Record<FastMode, string> = { fast: "Fast", standard: "Standard", inherit: "Codex default" };
		const fastVersions = new WeakMap<AppServerClient, Promise<boolean>>();
		// Pi may advance its in-memory branch before a session-file write throws.
		// Such a branch cannot authorize a service request until an explicit save succeeds.
		const fastSaveFailures = new Set<string>();
		let fastGeneration = 0;
		let fastPicker: AbortController | undefined;
		function fastMode(ctx: ExtensionContext): FastMode | "unreadable" {
			try {
				if (fastSaveFailures.has(ctx.sessionManager.getSessionId())) return "unreadable";
				const entry = [...ctx.sessionManager.getBranch()].reverse().find(e => e.type === "custom" && typeof e.customType === "string" && e.customType.startsWith("rbf-codex-fast/"));
				if (!entry || entry.type !== "custom") return "inherit";
				const mode = rec(entry.data).mode;
				return entry.customType === fastEntryType && (mode === "fast" || mode === "standard" || mode === "inherit") ? mode : "unreadable";
			} catch { return "unreadable"; }
		}
		function presentFast(ctx: ExtensionContext): void {
			if (ctx.mode !== "tui") return;
			// Clear the former separate row and request a redraw of the branch-derived model prefix.
			ctx.ui.setStatus("rbf-codex-fast", undefined);
		}
		function leaveFast(): void {
			fastGeneration++;
			fastPicker?.abort(); fastPicker = undefined;
		}
		function fastBusy(ctx: ExtensionContext): boolean {
			return state.shuttingDown || !ctx.isIdle() || ctx.hasPendingMessages() || !!(state.activeTurn || state.pendingCompact || state.checkingCompact || state.runningCompact);
		}
		pi.registerCommand("fast-codex", {
			description: "Choose fast or standard Codex service for this conversation",
			handler: async (args, ctx) => {
				if (ctx.mode !== "tui") { ctx.ui.notify("Use /fast-codex in the interactive Pi terminal.", "warning"); return; }
				if (args.trim()) { ctx.ui.notify("Use /fast-codex without arguments.", "warning"); return; }
				if (ctx.model?.provider !== PROVIDER_ID) { ctx.ui.notify("Select a codex-harness model before using /fast-codex.", "warning"); return; }
				if (fastBusy(ctx) || fastPicker) { ctx.ui.notify("Codex is busy. Try /fast-codex after Codex finishes.", "warning"); return; }
				const mode = fastMode(ctx);
				const current = mode === "unreadable" ? "Codex default" : fastLabels[mode];
				const choices = [current, ...Object.values(fastLabels).filter(label => label !== current)];
				const generation = fastGeneration, session = ctx.sessionManager.getSessionId(), leaf = ctx.sessionManager.getLeafId();
				const provider = ctx.model.provider, modelId = ctx.model.id;
				const picker = new AbortController(); fastPicker = picker;
				try {
					const answer = await ctx.ui.select(`Codex fast mode (${mode === "unreadable" ? "Unreadable" : current})`, choices, { signal: picker.signal });
					if (answer === undefined) return;
					if (generation !== fastGeneration || session !== ctx.sessionManager.getSessionId() || leaf !== ctx.sessionManager.getLeafId() || provider !== ctx.model?.provider || modelId !== ctx.model?.id || fastBusy(ctx)) {
						ctx.ui.notify("The conversation or model changed. Run /fast-codex again.", "warning"); return;
					}
					const selected = (Object.keys(fastLabels) as FastMode[]).find(key => fastLabels[key] === answer);
					if (!selected || selected === mode) return;
					try { pi.appendEntry(fastEntryType, { mode: selected }); }
					catch {
						fastSaveFailures.add(session);
						// Supersede any mutation-before-throw entry so a later Pi flush/reload
						// cannot turn that failed save into an authorized higher-cost choice.
						try { pi.appendEntry(fastEntryType, { mode: "unreadable" }); } catch {}
						presentFast(ctx);
						ctx.ui.notify("Could not save the Codex service choice. Use /fast-codex and choose Codex default before sending again.", "error"); return;
					}
					fastSaveFailures.delete(session);
					presentFast(ctx);
					ctx.ui.notify(selected === "fast" ? "Fast mode requested for this conversation. Higher usage may apply." : selected === "standard" ? "Standard speed requested for this conversation." : "This conversation now uses the Codex default service.", "info");
				} finally { if (fastPicker === picker) fastPicker = undefined; }
			},
		});

		const contextMeter = new CodexContextMeter();
		let contextFooter: ReturnType<typeof installCodexContextFooter> | undefined;
		const agents = new CodexAgentRoster(now);
		let agentsFooter: ReturnType<typeof installCodexAgentsFooter> | undefined;
		let footerInputOff: (() => void) | undefined;
		let overviewGeneration = 0;
		let overviewTimer: ReturnType<typeof setTimeout> | undefined;
		let overviewDirty = false;
		let dialogDepth = 0;
		let overviewClose: (() => void) | undefined;
		let overviewSettled: Promise<void> | undefined;
		let overviewRender: (() => void) | undefined;
		const overviewSafe = (fn: () => void) => { try { fn(); } catch {} };
		function presentAgents(): void {
			overviewSafe(() => {
				const ctx = state.ctx;
				if (ctx?.mode !== "tui") return;
				// Removing the old preview also requests the redraw that refreshes the footer.
				ctx.ui.setWidget("rbf-codex-agents", undefined);
				overviewRender?.();
			});
		}
		function flushAgents(): void {
			if (overviewTimer) clearTimeout(overviewTimer);
			overviewTimer = undefined;
			if (!overviewDirty || !agents.rootThreadId || state.ctx?.mode !== "tui") return;
			overviewDirty = false;
			try { pi.appendEntry(AGENTS_ENTRY_TYPE, agents.snapshot()); agents.notSaved = false; }
			catch { agents.notSaved = true; }
			presentAgents();
		}
		function changedAgents(persist = true): void {
			presentAgents();
			if (!persist || state.ctx?.mode !== "tui") return;
			overviewDirty = true;
			if (!overviewTimer) {
				const generation = overviewGeneration;
				overviewTimer = setTimeout(() => { if (generation === overviewGeneration) flushAgents(); }, 250);
			}
		}
		function leaveAgents(): void {
			overviewSafe(() => { agentsFooter?.reset(); agents.finish(); flushAgents(); overviewGeneration++; overviewClose?.(); overviewRender = undefined; presentAgents(); });
		}
		function restoreAgents(ctx: ExtensionContext): void {
			overviewSafe(() => {
				agentsFooter?.reset();
				if (overviewTimer) clearTimeout(overviewTimer);
				overviewTimer = undefined; overviewDirty = false; overviewGeneration++;
				agents.restore("", null); // failed branch lookup must never retain the source roster
				const branch = ctx.sessionManager.getBranch();
				const binding = newestEntries(ctx).thread;
				const entry = [...branch].reverse().find(e => e.type === "custom" && typeof (e as {customType?: unknown}).customType === "string" && ((e as {customType: string}).customType).startsWith("rbf-codex-agents/")) as { customType?: string; data?: unknown } | undefined;
				agents.restore(binding?.threadId ?? "", entry ? (entry.customType !== AGENTS_ENTRY_TYPE || entry.data === undefined ? null : entry.data) : undefined);
			});
			presentAgents();
		}
		async function openAgents(ctx: ExtensionContext): Promise<void> {
			agentsFooter?.reset();
			if (ctx.mode !== "tui" || ctx.model?.provider !== PROVIDER_ID) return;
			if (dialogDepth) { ctx.ui.notify("Finish the Codex dialog before opening the agent overview.", "warning"); return; }
			if (overviewSettled) return;
			let offset = 0;
			const generation = overviewGeneration;
			try {
				overviewSettled = ctx.ui.custom<void>((tui, theme, _keys, done) => {
					let closed = false;
					const close = () => { if (!closed) { closed = true; done(); } };
					overviewClose = close; overviewRender = () => tui.requestRender();
					let page = 10, count = 0;
					return {
						render(width: number) {
							const rows = agents.full(width); page = Math.max(1, Math.floor((process.stdout.rows ?? 24) * 0.8) - 1); count = rows.length;
							offset = Math.max(0, Math.min(offset, count - page));
							return [...rows.slice(offset, offset + page), theme.fg("dim", truncateToWidth("↑↓ scroll · PgUp/PgDn page · Home/End · Esc/Enter close", width))];
						},
						invalidate() {},
						handleInput(data: string) {
							if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) { close(); return; }
							if (matchesKey(data, Key.up)) offset--;
							else if (matchesKey(data, Key.down)) offset++;
							else if (matchesKey(data, Key.pageUp)) offset -= page;
							else if (matchesKey(data, Key.pageDown)) offset += page;
							else if (matchesKey(data, Key.home)) offset = 0;
							else if (matchesKey(data, Key.end)) offset = count;
							tui.requestRender();
						},
						dispose: close,
					};
				}, { overlay: true, overlayOptions: { width: "100%", maxHeight: "80%" } });
				await overviewSettled;
			} catch {} finally {
				if (generation === overviewGeneration) { overviewClose = undefined; overviewRender = undefined; }
				overviewSettled = undefined;
			}
		}
		pi.registerCommand("agents-codex", { description: "See Codex agents and their last reported assignments/statuses", handler: async (_args, ctx) => openAgents(ctx) });

		const notify = (text: string, type: "info" | "warning" | "error" = "info") => {
			if (state.ctx?.mode === "tui") state.ctx.ui.notify(text, type);
		};

		// ── display observer (pi-42): what this owner saw of each command item, for a shell-count view. None of it may throw into a turn. ──
		const display = createShellDisplayOwner<CodexDisplayFact>(pi.events, "codex-command", (fact) => fact.kind === "completion" || fact.kind === "not-run" || fact.kind === "lost");
		/** Command items each client admitted and has not seen complete, by item id. Client-local: a completion that arrives after its turn, or after the session moved on, finds the identity captured when the item was first seen. */
		const openDisplayCalls = new WeakMap<AppServerClient, Map<string, CodexDisplayCall>>();
		const mcpDisplay = createShellDisplayOwner<{ kind: string }>(pi.events, "codex-mcp", () => true);
		const clientGenerations = new WeakMap<AppServerClient, { generation: string; active: boolean }>();
		function displayScope(client: AppServerClient, threadId: string): DisplayScope | undefined {
			// A departed client's buffered row may still be emitted natively; it cannot regain live membership.
			if (client.exited) return undefined;
			let lifetime = clientGenerations.get(client);
			if (!lifetime) clientGenerations.set(client, (lifetime = { generation: randomUUID(), active: true }));
			return lifetime.active ? { clientGeneration: lifetime.generation, threadId } : undefined;
		}
		/** The item's display identity, captured on first use: its session from the announced owner, its thread from the turn that holds it (a root row's own `threadId` is empty). */
		function displayCallFor(client: AppServerClient, itemId: string, it: TurnItem, rootThreadId: string): CodexDisplayCall | undefined {
			if (it.kind !== "commandExecution") return undefined;
			if (!it.display) {
				const scope = displayScope(client, it.threadId || rootThreadId);
				if (!scope) return undefined;
				const call = display?.open(`codex-${itemId}`, scope);
				if (!call) return undefined;
				it.display = { bind: call.bind, tell: call.tell, threadId: it.threadId || rootThreadId, started: false };
				let open = openDisplayCalls.get(client);
				if (!open) openDisplayCalls.set(client, (open = new Map()));
				open.set(itemId, it.display);
			}
			return it.display;
		}
		/** Nobody can vouch for the command any more. Said once per item, however many ways the owner learns it. */
		function displayLost(call: CodexDisplayCall | undefined): void {
			if (!call || call.lost) return;
			call.lost = true;
			call.tell({ kind: "lost" });
		}
		/** Codex's `item/started` for the command was admitted on `threadId`. An approval that opened the row earlier said nothing. */
		function displayStarted(client: AppServerClient, itemId: string, it: TurnItem, rootThreadId: string, threadId: unknown): void {
			try {
				const call = displayCallFor(client, itemId, it, rootThreadId);
				if (!call || call.started || threadId !== call.threadId) return;
				call.started = true;
				call.tell({ kind: "start" });
			} catch {}
		}
		/** A completion for the item arrived on `client`: through its live turn, which passes the item, or after it. One notification reaches both subscribers and is told once. */
		function displayCompleted(client: AppServerClient, itemId: string, held: { it: TurnItem; rootThreadId: string } | undefined, threadId: unknown, item: Rec): void {
			try {
				const call = held ? displayCallFor(client, itemId, held.it, held.rootThreadId) : openDisplayCalls.get(client)?.get(itemId);
				if (!call || call.lastCompletion === item) return;
				call.lastCompletion = item;
				if (threadId !== call.threadId) {
					// The same item id on another thread is not provably this command. The association stays for its own completion.
					displayLost(call);
					return;
				}
				call.tell(shellCompletionFact(item));
				openDisplayCalls.get(client)?.delete(itemId);
			} catch {}
		}
		/** The row ended while its item had not completed. An interruption leaves the command with Codex (`kept`); a turn that ended any other way leaves nobody watching it. */
		function displayRowCut(client: AppServerClient, itemId: string, it: TurnItem, rootThreadId: string, kept: boolean): void {
			try {
				const call = displayCallFor(client, itemId, it, rootThreadId);
				if (kept) call?.tell({ kind: "cut", identity: itemId });
				else displayLost(call);
			} catch {}
		}
		/** This owner refused a command's approval. That proves it never ran only when no start was admitted before the question; after a start, the row ends and nobody watches what Codex does with the command. */
		function displayRefused(client: AppServerClient, rootThreadId: string, itemId: string, it: TurnItem | undefined, kind: RequestKind, answered: Answer): void {
			try {
				if (kind !== "commandExecution" || !it || !(answered.declined || answered.decision === "cancel" || answered.decision === "decline")) return;
				const call = displayCallFor(client, itemId, it, rootThreadId);
				if (call?.started) displayLost(call);
				else call?.tell({ kind: "not-run" });
			} catch {}
		}
		/** The turn ended. A command that started and whose row Pi never executed has no execute left to say how it went: nobody watches it now. */
		function displayTurnEnded(items: Iterable<TurnItem>): void {
			try {
				for (const it of items) {
					if (it.display?.started && !it.completed && !it.executed) displayLost(it.display);
				}
			} catch {}
		}
		/** The client is gone, and with it the only owner that could say how its open commands ended. */
		function displayClientLost(client: AppServerClient): void {
			try {
				const generation = clientGenerations.get(client);
				if (generation) { generation.active = false; display?.retireClient(generation.generation); mcpDisplay?.retireClient(generation.generation); }
				const open = openDisplayCalls.get(client);
				if (!open) return;
				for (const call of open.values()) displayLost(call);
				open.clear();
			} catch {}
		}
		let registeredCommandTool: ShellDisplayTool | undefined;
		let registeredMcpTool: ShellDisplayTool | undefined;

		class ActiveTurn {
			readonly events: ProjectedEvent[] = [];
			cursor = 0;
			readonly items = new Map<string, TurnItem>();
			/** Sub-agent threads admitted by announcement (`subAgentActivity` started or interacted, or a `collabAgentToolCall` naming the thread) and retired by `completed` or `interrupted` (or a collab state that is done); never by their own `turn/completed`. */
			readonly children = new Map<string, ChildThread>();
			/** `turn/started` seen on threads nobody has announced yet: read back when the announcement lands after it (the probe saw the announcement first, by 2 ms). */
			private readonly turnStarts = new Map<string, string>();
			/** The one row `execute` waiting right now; Pi's loop and the tools' sequential mode mean there is never a second. */
			private waiter: Waiter | null = null;
			/** Human requests nobody is waiting to answer yet, in arrival order; any row's `execute` takes the next one (Q25). */
			private readonly requests: PendingRequest[] = [];
			private readonly phases = new Map<string, string | null>();
			ended: { status: string; error?: string } | null = null;
			private consumer: ((ev: ProjectedEvent) => void) | null = null;
			private readonly endController = new AbortController();
			private endWaiters: (() => void)[] = [];
			private interrupting: Promise<void> | null = null;
			private readonly unsubscribe: () => void;
			private readonly onExit: () => void;

			/** Known once `turn/start` answers; until then every message for this thread belongs to this turn (Codex runs one turn per thread). */
			turnId = "";
			/** A steer Codex refused because the turn ended; it becomes the next turn's prompt when this one drains. */
			unsent: UserInputItem[] | undefined;

			readonly overviewGeneration = overviewGeneration;
			constructor(
				readonly client: AppServerClient,
				readonly threadId: string,
			) {
				this.unsubscribe = client.subscribe((m) => {
					try {
						overviewSafe(() => { if (this.overviewGeneration === overviewGeneration && state.ctx?.mode === "tui" && m.id === undefined && agents.observe(m.method, (m.params ?? {}) as Rec)) changedAgents(); });
						this.project(m);
					} catch (e) {
						// One malformed notification must never escape stdout dispatch and take Pi down.
						this.end({ status: "failed", error: String(e) });
					}
				});
				this.onExit = () => {
					try {
						this.end({ status: "childExit" });
					} catch {
						// The child's exit event is a Node emitter; a throw here would exit Pi
					}
				};
				client.onExit.add(this.onExit);
			}
			/** A `turn/start` that never answered: stop listening without ending anything; a request queued meanwhile is still answered once. */
			dispose(): void {
				this.unsubscribe();
				this.client.onExit.delete(this.onExit);
				for (const req of this.requests.splice(0)) this.client.respondError(req.id, "pi-rbf-codex: the turn did not start");
			}

			/** The signal Pi's dialogs take, so a dialog still open when the turn ends is closed. */
			get endSignal(): AbortSignal {
				return this.endController.signal;
			}

			// Cursor ownership: `drain` advances it during replay, then installs the live consumer only once replay has caught up,
			// so at any moment exactly one of the two moves it and `events[cursor..]` is always what the attached call has not seen.
			private push(ev: ProjectedEvent): void {
				this.events.push(ev);
				this.consumer?.(ev);
			}

			/** Replay what this call has not seen, then go live; `consume` returns false to detach (the call ended). A throw detaches and goes to `onError`, never up a Node emitter. */
			drain(consume: (ev: ProjectedEvent) => boolean, onError: (e: unknown) => void): void {
				this.consumer = null;
				const step = (ev: ProjectedEvent): boolean => {
					try {
						return consume(ev);
					} catch (e) {
						this.consumer = null;
						onError(e);
						return false;
					}
				};
				while (this.cursor < this.events.length) {
					const ev = this.events[this.cursor++];
					if (!step(ev)) return;
				}
				this.consumer = (ev) => {
					this.cursor++;
					if (!step(ev)) this.consumer = null;
				};
			}
			detach(): void {
				this.consumer = null;
			}
			get drained(): boolean {
				return this.ended !== null && this.cursor >= this.events.length;
			}

			private end(end: { status: string; error?: string }): void {
				if (this.ended) return;
				this.ended = end;
				overviewSafe(() => { if (this.overviewGeneration === overviewGeneration) { agents.finish(); flushAgents(); presentAgents(); } });
				if (this.turnId) this.client.endedTurns.add(this.turnId);
				for (const child of this.children.values()) if (child.turnId) this.client.endedTurns.add(child.turnId);
				this.unsubscribe();
				this.client.onExit.delete(this.onExit);
				this.waiter?.reject(new TurnEndedError(end.status));
				this.waiter = null;
				// A request queued for a row Pi has not executed yet would otherwise stay open forever; each id is answered exactly once.
				for (const req of this.requests.splice(0)) this.client.respondError(req.id, "pi-rbf-codex: the turn ended before this request could be asked");
				this.endController.abort();
				for (const fn of this.endWaiters.splice(0)) fn();
				displayTurnEnded(this.items.values());
				this.push({ kind: "end", status: end.status, error: end.error });
			}

			private item(itemId: string, kind: RowKind, threadId: unknown): TurnItem {
				let it = this.items.get(itemId);
				if (!it) {
					const child = typeof threadId === "string" && threadId !== this.threadId ? this.children.get(threadId) : undefined;
					it = { kind, threadId: child ? String(threadId) : "", agentPath: child?.agentPath ?? "", rowOpened: false, changes: [], questions: [], output: "" };
					this.items.set(itemId, it);
				}
				return it;
			}
			private openRow(itemId: string): void {
				const it = this.items.get(itemId);
				if (!it || it.rowOpened) return;
				it.rowOpened = true;
				this.push({ kind: "row", itemId });
			}

			/** Admit a child thread by announcement; a re-announcement keeps its turn id and name, a `turn/started` seen earlier supplies the turn id. */
			private admit(threadId: string, agentPath: unknown): void {
				const known = this.children.get(threadId);
				this.children.set(threadId, { turnId: known?.turnId ?? this.turnStarts.get(threadId) ?? null, agentPath: String(agentPath ?? known?.agentPath ?? "") });
			}

			/** A code-mode model (gpt-5.6-luna and -sol on Codex 0.154.0: the probe log `subapproval-luna.jsonl` and Tomek's sol rollouts of 2026-09-15 both spawn through `multi_agent_v1__spawn_agent` inside an `exec` script) announces a child only through `collabAgentToolCall`: `receiverThreadIds` fills on the spawn's completion, `agentsStates` reports each child's state, and no name travels. Runs on `item/started` and `item/completed`; draws nothing. */
			private admitCollab(item: Rec): void {
				const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
				const states = item.agentsStates && typeof item.agentsStates === "object" ? (item.agentsStates as Record<string, Rec | null>) : {};
				for (const receiver of receivers) {
					if (typeof receiver !== "string" || receiver === this.threadId) continue;
					const status = states[receiver]?.status;
					if (status === "completed" || status === "errored" || status === "shutdown" || status === "notFound" || status === "interrupted") {
						this.children.delete(receiver);
						this.turnStarts.delete(receiver); // a re-admission carries a turn id only if a fresh turn/started arrives
					} else this.admit(receiver, undefined);
				}
			}

			/** Admission (Decision 2026-09-14): the root's own turn by its id (its thread until the id is known), and every announced child's thread. Anything else, a Codex-internal agent included, stays dropped. */
			admits(m: JsonRpc, p: Rec): boolean {
				const completedId = m.method === "turn/completed" && !!p.turn && typeof p.turn === "object" ? (p.turn as Rec).id : undefined;
				if (this.turnId ? p.turnId === this.turnId || completedId === this.turnId : p.threadId === this.threadId && m.method !== "turn/completed" && !this.client.endedTurns.has(String(p.turnId))) return true;
				return typeof p.threadId === "string" && p.threadId !== this.threadId && this.children.has(p.threadId);
			}

			private project(m: JsonRpc): void {
				if (m.id !== undefined && m.method) return; // requests reach us through `takeRequest`
				const p = (m.params ?? {}) as Rec;
				const startedId = m.method === "turn/started" && !!p.turn && typeof p.turn === "object" ? String((p.turn as Rec).id ?? "") : undefined;
				if (startedId !== undefined && typeof p.threadId === "string" && p.threadId !== this.threadId && !this.children.has(p.threadId)) this.turnStarts.set(p.threadId, startedId);
				if (!this.admits(m, p)) return;
				const child = typeof p.threadId === "string" && p.threadId !== this.threadId ? this.children.get(p.threadId) : undefined;
				if (child && startedId !== undefined) child.turnId = startedId; // set or replaced: a re-driven child keeps its thread and gets a new turn
				if (!child && !this.turnId && startedId !== undefined) this.turnId = startedId; // Codex's first notification for the turn; it can beat the turn/start response
				switch (m.method) {
					case "error": {
						// A logged-out Codex accepts initialize and thread/start, then reports 401 here while retrying; stop the turn and say so.
						const err = p.error && typeof p.error === "object" ? (p.error as Rec) : {};
						const info = err.codexErrorInfo && typeof err.codexErrorInfo === "object" ? JSON.stringify(err.codexErrorInfo) : "";
						if (isLoggedOut(`${String(err.message ?? "")} ${String(err.additionalDetails ?? "")} ${info}`)) {
							this.client.interrupt(this.threadId, this.turnId);
							this.end({ status: "loggedOut" });
						}
						break;
					}
					case "item/started": {
						const item = rec(p.item);
						const id = String(item.id);
						if (item.type === "commandExecution") {
							const it = this.item(id, "commandExecution", p.threadId);
							it.command = String(item.command ?? "");
							it.cwd = String(item.cwd ?? "");
							displayStarted(this.client, id, it, this.threadId, p.threadId);
							this.openRow(id);
						} else if (item.type === "fileChange") {
							const it = this.item(id, "fileChange", p.threadId);
							it.changes = flattenChanges(item.changes);
							this.openRow(id);
						} else if (item.type === "mcpToolCall") {
							const it = this.item(id, "mcpToolCall", p.threadId);
							describeToolCall(it, item);
							this.openRow(id);
						} else if (item.type === "subAgentActivity") {
							// Admission by announcement; the announcement itself draws nothing.
							const agentThreadId = typeof item.agentThreadId === "string" ? item.agentThreadId : "";
							if (!agentThreadId || agentThreadId === this.threadId) break;
							if (item.kind === "started" || item.kind === "interacted") this.admit(agentThreadId, item.agentPath);
							else if (item.kind === "completed" || item.kind === "interrupted") this.children.delete(agentThreadId);
						} else if (item.type === "collabAgentToolCall") this.admitCollab(item);
						else if (item.type === "agentMessage" && !child) this.phases.set(id, (item.phase as string | null) ?? null);
						break;
					}
					case "item/commandExecution/outputDelta": {
						const it = this.items.get(String(p.itemId));
						if (!it) break;
						it.output += String(p.delta ?? "");
						if (this.waiter?.itemId === String(p.itemId)) this.waiter.onUpdate?.(it.output);
						break;
					}
					case "item/completed": {
						const item = rec(p.item);
						const id = String(item.id);
						if (item.type === "collabAgentToolCall") this.admitCollab(item);
						else if (item.type === "commandExecution" || item.type === "fileChange" || item.type === "mcpToolCall") {
							const it = this.item(id, item.type as RowKind, p.threadId);
							if (item.type === "commandExecution") it.command ??= String(item.command ?? "");
							if (item.type === "fileChange" && !it.changes.length) it.changes = flattenChanges(item.changes);
							if (item.type === "mcpToolCall") describeToolCall(it, item);
							it.completed = item;
							displayCompleted(this.client, id, { it, rootThreadId: this.threadId }, p.threadId, item);
							this.openRow(id); // a completion without a start still leaves a row
							if (this.waiter?.itemId === id) {
								const w = this.waiter;
								this.waiter = null;
								w.resolve({ kind: "completed", item });
							}
						} else if (item.type === "agentMessage" && !child && this.phases.get(id) !== "commentary") this.push({ kind: "final", text: String(item.text ?? "") });
						break;
					}
					case "item/reasoning/summaryTextDelta":
						if (!child) this.push({ kind: "thinking", text: String(p.delta ?? "") }); // a child's reasoning and text are never the parent's
						break;
					case "item/agentMessage/delta":
						if (!child) this.push({ kind: "answer", text: String(p.delta ?? "") }); // commentary streams as text too (Q17)
						break;
					case "turn/completed": {
						const turn = rec(p.turn);
						if (child) {
							// The child's turn ended (any status): a row still open on it settles as aborted; the thread stays admitted for a re-drive.
							child.turnId = null;
							for (const it of this.items.values()) if (it.threadId === p.threadId && !it.completed) it.aborted = true;
							if (this.waiter && this.items.get(this.waiter.itemId)?.threadId === p.threadId) {
								const w = this.waiter;
								this.waiter = null;
								w.reject(new TurnEndedError("interrupted"));
							}
							break;
						}
						const error = turn.error ? String(rec(turn.error).message) : undefined;
						this.end({ status: String(turn.status), error });
						break;
					}
				}
			}

			/** A human-facing request for this turn: opens the item's row if none yet (the app question names its call in `_meta.callId` and opens none), then hands the request to the waiting row's `execute`, else queues it. */
			takeRequest(m: JsonRpc & { id: number | string; method: string }, kind: RequestKind): void {
				const p = (m.params ?? {}) as Rec;
				const meta = p._meta && typeof p._meta === "object" ? (p._meta as Rec) : {};
				const itemId = kind === "elicitation" ? String(meta.callId ?? "") : String(p.itemId);
				if (kind !== "elicitation") {
					const it = this.item(itemId, kind, p.threadId);
					if (kind === "commandExecution" && !it.command) {
						it.command = typeof p.command === "string" ? p.command : "";
						it.cwd ??= typeof p.cwd === "string" ? p.cwd : "";
					}
					if (kind === "question" && Array.isArray(p.questions)) {
						// Codex sends `options: null` on free-text questions; the persisted argument carries no key at all.
						it.questions = (p.questions as Rec[]).map(({ options, ...q }) => (Array.isArray(options) ? { ...q, options } : q) as QuestionArg);
					}
					this.openRow(itemId);
				}
				const req: PendingRequest = { id: m.id, method: m.method, params: p, kind, itemId };
				if (this.waiter) {
					const w = this.waiter;
					this.waiter = null;
					w.resolve({ kind: "request", req });
				} else this.requests.push(req);
			}

			/** The first of: a pending human request (any item's, in arrival order, so no dialog waits behind a running row; Q25), or the item's completion. */
			waitFor(itemId: string, signal: AbortSignal | undefined, onUpdate?: (output: string) => void): Promise<WaitOutcome> {
				const it = this.items.get(itemId);
				if (this.requests.length) return Promise.resolve({ kind: "request", req: this.requests.shift()! });
				if (it?.completed) return Promise.resolve({ kind: "completed", item: it.completed });
				if (it?.aborted) return Promise.reject(new TurnEndedError("interrupted")); // its child's turn ended while the row was open
				if (this.ended) return Promise.reject(new TurnEndedError(this.ended.status));
				if (signal?.aborted) return Promise.reject(new AbortedError());
				return new Promise<WaitOutcome>((resolve, reject) => {
					const onAbort = () => {
						this.waiter = null;
						reject(new AbortedError());
					};
					signal?.addEventListener("abort", onAbort, { once: true });
					const settle = <T>(fn: (v: T) => void) => (v: T) => {
						signal?.removeEventListener("abort", onAbort);
						fn(v);
					};
					this.waiter = { itemId, resolve: settle(resolve), reject: settle(reject), onUpdate };
				});
			}

			/** `turn/interrupt` for the root, then one per announced child with a known turn id (the parent's interrupt never reaches a child's turn, probe 2026-09-14);
			 *  ≤ 3 s for the root turn to end; else drop the child process so the next prompt respawns. No interrupt kills a running command. */
			interrupt(): Promise<void> {
				this.interrupting ??= (async () => {
					if (this.ended) return;
					this.client.interrupt(this.threadId, this.turnId);
					for (const [threadId, child] of this.children) if (child.turnId) this.client.interrupt(threadId, child.turnId);
					const ended = new Promise<void>((resolve) => this.endWaiters.push(resolve));
					await Promise.race([ended, new Promise<void>((r) => setTimeout(r, INTERRUPT_WAIT_MS))]);
					if (this.ended) return;
					// No completion came: the turn is abandoned as interrupted (Codex's rollout records it so once the child dies),
					// and the next prompt must respawn rather than reuse a child whose stdin is closing.
					this.end({ status: "interrupted" });
					if (state.client === this.client) state.client = null;
					void this.client.close();
				})();
				return this.interrupting;
			}
		}

		/** The branch's thread entry and its newest *completed* turn after it. Only a completed turn can be a fork's `lastTurnId`:
		 *  Codex refuses an interrupted or cut turn as in progress (probe 2026-09-14), and such turns carry no answer the branch shows anyway. */
		function newestEntries(ctx: ExtensionContext): { thread: ThreadEntry | null; turn: TurnEntry | null } {
			const branch = ctx.sessionManager.getBranch();
			let turn: TurnEntry | null = null;
			for (let i = branch.length - 1; i >= 0; i--) {
				const e = branch[i] as { type: string; customType?: string; data?: unknown };
				if (e.type !== "custom") continue;
				if (e.customType === ENTRY_TYPE) return { thread: (e.data as ThreadEntry) ?? null, turn };
				if (e.customType === TURN_ENTRY_TYPE && !turn && (e.data as TurnEntry | undefined)?.status === "completed") turn = e.data as TurnEntry;
			}
			return { thread: null, turn: null };
		}

		function newestOwnEntry(ctx: ExtensionContext): ThreadEntry | null {
			const t = newestEntries(ctx).thread;
			return t && t.sessionId === ctx.sessionManager.getSessionId() ? t : null;
		}

		function isBoundBranch(ctx: ExtensionContext): boolean {
			return ctx.sessionManager.getBranch().some((e) => e.type === "custom" && (e as { customType?: string }).customType === ENTRY_TYPE);
		}

		/** Every user-role message after the last assistant message: text first (joined by blank lines), then images in order. */
		function userItems(context: Context, model: Model<any>): UserInputItem[] {
			const texts: string[] = [];
			const images: UserInputItem[] = [];
			for (let i = context.messages.length - 1; i >= 0; i--) {
				const m = context.messages[i];
				if (m.role === "assistant") break;
				if (m.role !== "user") continue;
				if (typeof m.content === "string") texts.unshift(m.content);
				else {
					const parts: string[] = [];
					const mine: UserInputItem[] = [];
					for (const block of m.content) {
						if (block.type === "image") {
							if (!model.input?.includes("image")) throw new CodexError("unsupported-input");
							mine.push({ type: "image", url: `data:${block.mimeType};base64,${block.data}` });
						} else if (block.type === "text") parts.push(block.text);
					}
					texts.unshift(parts.join("\n"));
					images.unshift(...mine);
				}
			}
			const text = texts.join("\n\n");
			const items: UserInputItem[] = text ? [{ type: "text", text, text_elements: [] }] : [];
			return [...items, ...images];
		}

		async function ensureClient(cwd: string, signal?: AbortSignal): Promise<AppServerClient> {
			if (state.client && !state.client.exited) return state.client;
			const client = await AppServerClient.start(cwd, command);
			state.client = client;
			const supported = await checkCodexVersion(command);
			if (!supported) {
				state.client = null;
				await client.close();
				throw new CodexError("codex-version");
			}
			client.onRequest = onServerRequest;
			client.onExit.add(() => { displayClientLost(client); if (state.client === client) { contextMeter.clear(); presentAgents(); } });
			const failedServers = new Set<string>();
			client.subscribe((m) => {
				// Runs inside stdout frame dispatch: nothing thrown here may escape, as the turn's own subscriber guards.
				try {
					watch(m);
				} catch {
					// a malformed notification is dropped; the turn's own handling of it is separate
				}
			});
			function watch(m: JsonRpc): void {
				const p = (m.params ?? {}) as Rec;
				const retiredStart = m.method === "turn/started" && client.endedTurns.has(String(agentRecord(p.turn).id ?? ""));
				if (m.id === undefined && state.client === client && !retiredStart && contextMeter.observe(m.method, m.params)) presentAgents();
				if (m.method === "mcpServer/startupStatus/updated") {
					// One notice per MCP server that failed to start, per child process; `starting` and `ready` say nothing (the probe saw only those).
					const name = String(p.name ?? "");
					if (p.status !== "failed" || failedServers.has(name)) return;
					failedServers.add(name);
					const why = [p.failureReason, p.error].find((v) => typeof v === "string" && v) as string | undefined;
					notify(NOTICE.mcpStartFailed(name, why ?? ""), "warning");
				} else if (m.method === "item/completed") {
					// A command cut by Escape ran on in Codex; say once when it finished, whichever turn (or none) is active by then.
					const item = p.item && typeof p.item === "object" ? (p.item as Rec) : {};
					const id = String(item.id ?? "");
					if (item.type === "commandExecution") displayCompleted(client, id, undefined, p.threadId, item);
					const command = client.cutCommands.get(id);
					if (command === undefined) return;
					client.cutCommands.delete(id);
					notify(NOTICE.finishedAfterCancel(typeof item.exitCode === "number" ? item.exitCode : null, displayCommand(command)));
				}
			}
			if (state.approvedForSession) {
				// Codex's session approval cache lived in the child that is gone; say so once.
				state.approvedForSession = false;
				notify(NOTICE.restarted, "warning");
			}
			try {
				await client.request("initialize", { clientInfo: { name: "pi-rbf-codex", version: CLIENT_VERSION }, capabilities: { experimentalApi: true } }, SETUP_TIMEOUT_MS, signal);
			} catch (e) {
				// Never keep an uninitialized child around; the next prompt must spawn afresh.
				state.client = null;
				void client.close();
				const msg = e instanceof CodexError ? (e.detail ?? "") : String(e);
				if (/auth|login|logged/i.test(msg)) throw new CodexError("codex-logged-out");
				throw e;
			}
			client.notify("initialized", {});
			return client;
		}

		/** Every server request: a human-facing one for the active turn goes to its row's `execute`; everything else is a JSON-RPC error at once. */
		function onServerRequest(m: JsonRpc & { id: number | string; method: string }): boolean {
			const kind = HUMAN_REQUESTS[m.method];
			const p = (m.params ?? {}) as Rec;
			const turn = state.activeTurn;
			const forTurn = !!kind && !!turn && !turn.ended && turn.admits(m, p);
			if (forTurn && (kind === "elicitation" ? isAppApproval(p) : typeof p.itemId === "string")) {
				turn!.takeRequest(m, kind!);
				return true;
			}
			const asked = humanRequestKind(m.method);
			if (asked) notify(NOTICE.declined(asked), "warning");
			return false;
		}

		type Binding = { threadId: string; policy: string; sandbox: string };
		function bindingOf(res: Rec): Binding {
			const threadId = String(rec(res.thread).id);
			const policy = typeof res.approvalPolicy === "string" ? res.approvalPolicy : JSON.stringify(res.approvalPolicy);
			const sandbox = res.sandbox && typeof res.sandbox === "object" ? String((res.sandbox as Rec).type ?? "unknown") : String(res.sandbox ?? "unknown");
			return { threadId, policy, sandbox };
		}

		/** The fork-or-resume rule, from the branch's thread and turn entries plus Codex's own turn list. */
		async function bindThread(client: AppServerClient, ctx: ExtensionContext, cwd: string, signal?: AbortSignal): Promise<Binding> {
			const sessionId = ctx.sessionManager.getSessionId();
			const { thread: T, turn: U } = newestEntries(ctx);
			const start = async () => {
				const res = rec(await client.request("thread/start", { cwd, ephemeral: false }, SETUP_TIMEOUT_MS, signal));
				const threadId = rec(res.thread).id;
				if (typeof threadId !== "string") throw new CodexError("generic", "thread/start returned no thread id");
				pi.appendEntry<ThreadEntry>(ENTRY_TYPE, { threadId, cwd, sessionId });
				return bindingOf(res);
			};
			const fork = async (threadId: string, lastTurnId: string) => {
				let res: Rec;
				try {
					res = rec(await client.request("thread/fork", { threadId, lastTurnId, cwd, ephemeral: false }, SETUP_TIMEOUT_MS, signal));
				} catch (e) {
					throw e instanceof CodexError && e.key === "generic" ? new CodexError("fork-failed", e.detail) : e;
				}
				const forked = rec(res.thread).id;
				if (typeof forked !== "string") throw new CodexError("fork-failed", "thread/fork returned no thread id");
				pi.appendEntry<ThreadEntry>(ENTRY_TYPE, { threadId: forked, cwd, sessionId });
				return bindingOf(res);
			};
			if (!T) return start();
			if (T.cwd !== cwd) throw new CodexError("workspace-mismatch", `Codex thread directory: ${T.cwd}`);
			if (T.sessionId !== sessionId) return U ? fork(T.threadId, U.turnId) : start();
			// Own thread: resume it with excludeTurns: true
			const res = rec(await client.request("thread/resume", { threadId: T.threadId, excludeTurns: true }, SETUP_TIMEOUT_MS, signal));
			if (rec(res.thread).id !== T.threadId) throw new CodexError("history-unverified");
			if (U) {
				const check = await verifyBranchHistory(client, T.threadId, U.turnId, signal);
				if (check.ok) return bindingOf(res);
				if (check.diverged) return fork(T.threadId, U.turnId);
				throw new CodexError("history-unverified");
			} else {
				const emptyOk = await verifyEmptyBranchHistory(client, T.threadId, signal);
				if (!emptyOk) throw new CodexError("history-unverified");
				return bindingOf(res);
			}
		}

		async function startTurn(client: AppServerClient, threadId: string, items: UserInputItem[], model: Model<any>, effort: string, contextView: number, mode: FastMode): Promise<ActiveTurn> {
			const contextEpoch = contextView === contextMeter.viewGeneration ? contextMeter.begin(threadId) : -1;
			presentAgents();
			const turnParams: Rec = { threadId, input: items, effort };
			if (mode !== "inherit") turnParams.serviceTierForTurn = mode === "fast" ? "priority" : "default";
			const codexId = codexModelId(model.id);
			if (codexId) turnParams.model = codexId;
			// Subscribe before sending: stdout dispatches every frame in one chunk synchronously, so a notification can share a chunk with the response.
			overviewSafe(() => { const reset = agents.begin(threadId, client.endedTurns); changedAgents(reset); });
			const turn = new ActiveTurn(client, threadId);
			state.activeTurn = turn;
			let started: Rec;
			try {
				try {
					started = rec(await client.request("turn/start", turnParams));
				} catch (e) {
					const detail = e instanceof CodexError ? (e.detail ?? "") : String(e);
					if (!(turnParams.model && detail.includes(String(turnParams.model)))) throw e;
					// Codex retired the persisted model id: one retry on Codex's default, then the user picks another.
					notify(NOTICE.retiredModel(String(turnParams.model)), "warning");
					const { model: _retired, ...retryParams } = turnParams;
					started = rec(await client.request("turn/start", retryParams));
				}
			} catch (e) {
				turn.dispose();
				overviewSafe(() => { agents.finish(); flushAgents(); presentAgents(); });
				if (state.activeTurn === turn) state.activeTurn = null;
				throw e instanceof CodexError && e.key === "generic" ? new CodexError("turn-failed", e.detail) : e;
			}
			turn.turnId = String(rec(started.turn).id);
			contextMeter.confirmTurn(contextEpoch, turn.turnId);
			overviewSafe(() => agents.setTurn(turn.turnId!));
			return turn;
		}

		/** One user prompt is one Codex turn across N `streamSimple` calls and tool executions. */
		function streamSimple(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
			const out = new AssistantMessageWriter(model);
			const ctx = state.ctx;
			const contextView = contextMeter.viewGeneration;
			const fail = (e: unknown) => {
				if (options?.signal?.aborted || e instanceof AbortedError) return out.finish("aborted");
				const err = e instanceof CodexError ? e : new CodexError("generic", String(e));
				if (err.detail) notify(`Codex: ${err.detail}`, "warning");
				out.finish("error", err.key);
			};

			void (async () => {
				if (!ctx) return fail(new CodexError("generic", "session_start has not run"));
				const signal = options?.signal;

				// Pi re-calls the provider once after an aborted tool; finish the turn it aborted and send nothing.
				if (signal?.aborted) {
					const turn = state.activeTurn;
					if (!turn) return out.finish("aborted");
					await turn.interrupt();
					return drain(turn, { silent: true });
				}

				const turn = state.activeTurn;
				const attach = turn !== null && !turn.drained;
				const last = context.messages[context.messages.length - 1];
				if (attach && last?.role === "toolResult") return drain(turn, {});
				let items: UserInputItem[];
				try {
					items = userItems(context, model);
				} catch (e) {
					return fail(e);
				}
				if (attach) {
					// A steer: Pi delivered a new user message at the tool boundary while Codex still works.
					try {
						await turn.client.request("turn/steer", { threadId: turn.threadId, expectedTurnId: turn.turnId, input: items });
					} catch {
						turn.unsent = items; // the turn ended or refused the steer; it becomes the next turn's prompt, whichever call drains the end
					}
					return drain(turn, {});
				}
				if (!items.length) {
					notify(NOTICE.nothingToSend, "warning");
					return fail(new CodexError("generic"));
				}
				state.recentCompactTerminal = null;
				if (state.pendingCompact) {
					if (signal?.aborted) return out.finish("aborted");
					let onAbort: (() => void) | undefined;
					try {
						await Promise.race([
							state.pendingCompact,
							new Promise<void>((_, reject) => {
								if (!signal) return;
								onAbort = () => reject(new AbortedError());
								signal.addEventListener("abort", onAbort, { once: true });
								if (signal.aborted) onAbort();
							}),
						]);
					} catch (e) {
							if (signal?.aborted || e instanceof AbortedError) return out.finish("aborted");
					} finally {
						if (onAbort) signal?.removeEventListener("abort", onAbort);
					}
					if (signal?.aborted) return out.finish("aborted");
				}
				return beginUserTurn(items);
			})();

			/** Every fresh turn, including a refused steer, verifies the selected branch. */
			async function beginUserTurn(items: UserInputItem[]): Promise<void> {
				if (!ctx) return fail(new CodexError("generic", "session_start has not run"));
				const signal = options?.signal;
				if (signal?.aborted) return out.finish("aborted");
				try {
					const mode = fastMode(ctx);
					if (mode === "unreadable") return fail(new CodexError("codex-fast-unreadable"));
					const level = options?.reasoning ?? pi.getThinkingLevel();
					const effort = mapEffort(model, level);
					if (!effort) return fail(new CodexError("unsupported-thinking-level"));
					const cwd = realpathSync.native(ctx.sessionManager.getCwd());
					const client = await ensureClient(cwd, signal);
					if (mode !== "inherit") {
						let supported = fastVersions.get(client);
						if (!supported) { supported = checkCodexVersion(command, [0, 166, 0]); fastVersions.set(client, supported); }
						if (!await supported) return fail(new CodexError("codex-fast-version"));
					}
					const bound = await bindThread(client, ctx, cwd, signal);
					if (!state.noticedPolicy) {
						state.noticedPolicy = true;
						notify(NOTICE.policy(bound.policy, bound.sandbox));
					}
					if (signal?.aborted) return out.finish("aborted");
					const started = await startTurn(client, bound.threadId, items, model, effort, contextView, mode);
					if (signal?.aborted) {
						await started.interrupt();
						return drain(started, { silent: true });
					}
					return drain(started, {});
				} catch (e) {
					return fail(e);
				}
			}

			/** The turn's `end` event, drained by this call: record it, then finish the stream or start the refused steer's turn. */
			function finishTurn(turn: ActiveTurn, ev: { status: string; error?: string }, mode: { silent?: boolean }, answer: { streamed: boolean; fallback: string }): void {
				if (state.activeTurn === turn) state.activeTurn = null;
				if (ev.status === "childExit") {
					if (state.client === turn.client) state.client = null;
					if (state.shuttingDown || mode.silent) return out.finish("aborted");
					const lastErr = turn.client.lastStderr();
					if (lastErr) notify(`Codex: ${lastErr}`, "warning");
					return out.finish("error", "codex-stopped");
				}
				if (ev.status === "loggedOut") return out.finish("error", "codex-logged-out");
				// No entry for childExit or loggedOut: such a turn may still be in progress in Codex's rollout and must never become a fork's lastTurnId.
				pi.appendEntry<TurnEntry>(TURN_ENTRY_TYPE, { threadId: turn.threadId, turnId: turn.turnId, status: ev.status });
				if (mode.silent) return out.finish("aborted");
				if (turn.unsent?.length) {
					// The steer was refused because the turn ended: it becomes its own turn now, in this same Pi message.
					const unsent = turn.unsent;
					turn.unsent = undefined;
					void beginUserTurn(unsent);
					return;
				}
				if (ev.status === "completed") {
					if (!answer.streamed && answer.fallback) out.text(answer.fallback);
					if (!answer.streamed && !answer.fallback) return out.finish("error", "no-answer");
					return out.finish("done");
				}
				if (ev.status === "interrupted") return out.finish("aborted");
				if (isLoggedOut(ev.error ?? "")) return out.finish("error", "codex-logged-out");
				notify(`Codex: ${ev.error ?? ev.status}`, "warning");
				out.finish("error", "turn-failed");
			}

			/** Replay this turn's buffered events from the cursor, then stream live ones, until a row or the end. */
			function drain(turn: ActiveTurn, mode: { silent?: boolean }): void {
				const answer = { streamed: false, fallback: "" };
				if (!mode.silent) out.start();
				const onAbort = () => void turn.interrupt();
				options?.signal?.addEventListener("abort", onAbort, { once: true });
				if (options?.signal?.aborted) void turn.interrupt(); // Escape landed during the steer or start round trip; the listener above never fires
				const settle = (fn: () => void) => {
					options?.signal?.removeEventListener("abort", onAbort);
					turn.detach();
					fn();
				};
				turn.drain((ev) => {
					switch (ev.kind) {
						case "thinking":
							if (!mode.silent) out.thinking(ev.text);
							return true;
						case "answer":
							if (!mode.silent) {
								answer.streamed = true;
								out.text(ev.text);
							}
							return true;
						case "final":
							answer.fallback = ev.text;
							return true;
						case "row": {
							if (mode.silent) return true;
							const it = turn.items.get(ev.itemId)!;
							out.toolCall(rowToolCall(ev.itemId, it, turn));
							settle(() => out.finish("toolUse")); // the ActiveTurn keeps receiving; the next call attaches
							return false;
						}
						case "end":
							settle(() => finishTurn(turn, ev, mode, answer));
							return false;
					}
				}, fail);
			}

			return out.stream;
		}

		function rowToolCall(itemId: string, it: TurnItem, turn: ActiveTurn): ToolCall {
			const id = `codex-${itemId}`;
			const agent = { threadId: it.threadId, agentPath: it.agentPath };
			if (it.kind === "commandExecution") {
				const args = { itemId, ...agent, command: it.command ?? "", cwd: it.cwd ?? "" } satisfies CommandArgs;
				try { displayCallFor(turn.client, itemId, it, turn.threadId)?.bind(args, { itemId, threadId: it.threadId || turn.threadId, agentPath: it.agentPath, cwd: it.cwd || state.ctx?.sessionManager.getCwd() || "" }); } catch {}
				return { type: "toolCall", id, name: TOOL_COMMAND, arguments: args };
			}
			if (it.kind === "fileChange") return { type: "toolCall", id, name: TOOL_PATCH, arguments: { itemId, ...agent, changes: it.changes } satisfies PatchArgs };
			if (it.kind === "mcpToolCall") {
				const args: ToolCallArgs = { itemId, ...agent, server: it.server ?? "", tool: it.tool ?? "", arguments: it.arguments ?? {}, ...(it.displayMetadata ? { display: { ...it.displayMetadata } } : {}) };
				try {
					const scope = displayScope(turn.client, it.threadId || turn.threadId);
					if (scope) mcpDisplay?.open(id, scope)?.bind(args, { itemId, threadId: it.threadId || turn.threadId, agentPath: it.agentPath, cwd: state.ctx?.sessionManager.getCwd() || "" });
				} catch {}
				return { type: "toolCall", id, name: TOOL_TOOL, arguments: args };
			}
			return { type: "toolCall", id, name: TOOL_QUESTION, arguments: { itemId, ...agent, questions: it.questions } satisfies QuestionArgs };
		}

		// ── tools: each row waits for Codex's completion of its item, answering any human request from here ──
		type ToolResult = { content: { type: "text"; text: string }[]; details: Rec; isError?: boolean };
		const textResult = (text: string, details: Rec, isError = false): ToolResult => ({ content: [{ type: "text", text }], details, isError });
		/** Return a good result; throw an error one so Pi tints it, exactly as bash throws on failure (the thrown text is what the row and Codex-free transcript show). */
		const settle = (r: ToolResult): ToolResult => { if (r.isError) throw new RowError(resultText(r)); return r; };

		function commandResult(itemId: string, item: Rec, output: string): ToolResult {
			const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
			const status = String(item.status ?? "completed");
			// Pi's bash appends `Command exited with code N` after a blank line to the *untrimmed* output (`bash.js` appendStatus), so a
			// trailing newline in the output becomes a second blank line in the row; the same copy and the same shape, so the row and the transcript read as Pi's.
			const text = `${String(item.aggregatedOutput ?? output)}${exitCode ? `\n\nCommand exited with code ${exitCode}` : ""}`.trim();
			return textResult(text || (status === "declined" ? ROW_STATUS.declined : ""), { itemId, exitCode, durationMs: item.durationMs ?? null, status }, (exitCode ?? 0) !== 0 || status === "declined" || status === "failed");
		}
		function patchResult(itemId: string, item: Rec, changes: PatchChangeArg[]): ToolResult {
			const status = String(item.status ?? "completed");
			const applied = changes.length ? changes : flattenChanges(item.changes);
			const text = status === "completed" ? `applied ${applied.length} file(s): ${applied.map((c) => displayPath(c.path)).join(", ")}` : status;
			return textResult(text, { itemId, status }, status !== "completed");
		}

		/** An `mcpToolCall` item: the tool's text parts joined (`structuredContent` as JSON only when they are empty); a failed call is an error row whose text is Codex's
		 *  `error.message`, else the result text (a refused computer-use call is `status: failed` with the sentence in its result and `error: null`, probe 2026-09-14). */
		function toolCallResult(itemId: string, item: Rec): ToolResult {
			const status = String(item.status ?? "completed");
			const error = item.error && typeof item.error === "object" ? String((item.error as Rec).message ?? "") : "";
			const result = item.result && typeof item.result === "object" ? (item.result as Rec) : {};
			const content = Array.isArray(result.content) ? (result.content as Rec[]) : [];
			const text = content.filter((c) => c && typeof c === "object" && c.type === "text").map((c) => String(c.text ?? "")).join("\n").trim();
			const failed = status === "failed" || !!error;
			const structured = !failed && !text && result.structuredContent != null ? JSON.stringify(result.structuredContent) : "";
			return textResult(error || text || structured || (failed ? status : ""), { itemId, status, durationMs: item.durationMs ?? null }, failed);
		}

		/** The dialog's outcome for the request's own row: a question row returns its answers; a refused approval is a declined row; an accepted approval, and the app question, leave the row waiting for its item. */
		function applyAnswer(itemId: string, it: TurnItem, a: Answer): ToolResult | undefined {
			if (a.kind === "question") {
				if (a.declined) throw new RowError(ROW_STATUS.declined);
				const lines = it.questions.map((q) => `${q.header}: ${a.answers?.[q.id] ?? ROW_STATUS.declined}`);
				return textResult(lines.join("\n"), { itemId, answers: a.answers ?? {} });
			}
			if (a.kind !== "elicitation" && (a.declined || a.decision === "cancel")) throw new RowError(ROW_STATUS.declined);
			return undefined;
		}

		/** Opens the dialog(s) for one request and answers it exactly once. */
		async function answerRequest(turn: ActiveTurn, req: PendingRequest, ctx: ExtensionContext): Promise<Answer> {
			dialogDepth++;
			try {
				try { overviewClose?.(); await overviewSettled; } catch {}
				return await answerRequestBody(turn, req, ctx);
			} finally { dialogDepth--; }
		}
		async function answerRequestBody(turn: ActiveTurn, req: PendingRequest, ctx: ExtensionContext): Promise<Answer> {
			const client = turn.client;
			const kind = req.kind;
			if (!ctx.hasUI) {
				client.respondError(req.id, "pi-rbf-codex has no UI to ask the user");
				notify(NOTICE.declined(kind === "question" ? "input" : "approval"), "warning");
				return { kind, declined: true };
			}
			const opts = { signal: turn.endSignal };
			const agent = agentName(turn.items.get(req.itemId)?.agentPath);
			const titled = (title: string) => truncateTitle(agent ? `${agent}: ${title}` : title, terminalWidth()); // a sub-agent's dialog says who is asking, in the row's word
			if (kind === "elicitation") {
				// Computer use's per-app question, answered as an approval: Codex's `message` is the title; `Yes for this session` only when Codex offers to persist it.
				const meta = req.params._meta && typeof req.params._meta === "object" ? (req.params._meta as Rec) : {};
				if (!state.noticedElicitation) {
					state.noticedElicitation = true; // Codex's own risk text (prompt injection through the app), once per session, before the first app question
					if (typeof meta.subtitle === "string" && meta.subtitle) notify(meta.subtitle, "warning");
				}
				const persist = Array.isArray(meta.persist) && meta.persist.includes("session");
				const choices = APPROVAL_CHOICES.filter((c) => persist || c !== "Yes for this session");
				const picked = await ctx.ui.select(titled(String(req.params.message ?? "")), choices, opts);
				const decision = picked === undefined || turn.ended ? "cancel" : APPROVAL_DECISION[picked];
				if (decision === "cancel") client.respond(req.id, { action: "cancel" });
				else {
					if (decision === "acceptForSession") state.approvedForSession = true;
					client.respond(req.id, { action: "accept", content: {}, ...(decision === "acceptForSession" ? { _meta: { persist: "session" } } : {}) });
				}
				return { kind, decision };
			}
			if (kind !== "question") {
				const it = turn.items.get(String(req.params.itemId));
				const title = titled(approvalTitle(kind, req.params, it?.changes ?? []));
				const picked = await ctx.ui.select(title, [...APPROVAL_CHOICES], opts);
				if (turn.ended) {
					client.respond(req.id, { decision: "decline" }); // the dialog was closed by the turn ending
					return { kind, decision: "decline" };
				}
				const decision = picked === undefined ? "cancel" : APPROVAL_DECISION[picked];
				if (decision === "acceptForSession") state.approvedForSession = true;
				client.respond(req.id, { decision });
				return { kind, decision };
			}
			const questions = Array.isArray(req.params.questions) ? (req.params.questions as QuestionArg[]) : [];
			if (questions.some((q) => q.isSecret)) {
				client.respondError(req.id, "pi-rbf-codex cannot take a secret privately");
				notify(NOTICE.secret, "warning");
				return { kind, declined: true };
			}
			const answers: Record<string, string> = {};
			for (const q of questions) {
				const title = agent ? `${agent}: ${q.header}: ${q.question}` : `${q.header}: ${q.question}`;
				let answer: string | undefined;
				if (q.options?.length) {
					const labels = q.options.map((o) => `${o.label} — ${o.description}`);
					const picked = await ctx.ui.select(title, q.isOther ? [...labels, OTHER_CHOICE] : labels, opts);
					if (picked === OTHER_CHOICE) answer = await ctx.ui.input(title, undefined, opts);
					else if (picked !== undefined) answer = q.options[labels.indexOf(picked)]?.label ?? picked;
				} else answer = await ctx.ui.input(title, undefined, opts);
				if (turn.ended) break;
				if (answer !== undefined) answers[q.id] = answer;
			}
			client.respond(req.id, { answers: Object.fromEntries(questions.map((q) => [q.id, { answers: q.id in answers ? [answers[q.id]] : [] }])) });
			return { kind, answers };
		}

		async function executeRow(kind: RowKind, itemId: string, signal: AbortSignal | undefined, onUpdate: ((partial: ToolResult) => void) | undefined, ctx: ExtensionContext): Promise<ToolResult> {
			const turn = state.activeTurn;
			const it = turn?.items.get(itemId);
			// Thrown, not returned: Pi tints only a thrown error and hands the model an error result, so a model that calls this tool by hand learns at once (human check 2026-09-14: a returned `isError` drew as success).
			if (!turn || !it) throw new RowError("No active Codex turn holds this item; this tool cannot be called directly.");
			it.executed = true;
			const onAbort = () => void turn.interrupt();
			signal?.addEventListener("abort", onAbort, { once: true });
			if (kind === "commandExecution" || kind === "mcpToolCall") onUpdate?.(textResult("", { itemId, status: "inProgress" })); // Pi's bash row does the same, so `Elapsed` shows before any output
			try {
				for (;;) {
					if (signal?.aborted) throw new AbortedError();
					if (it.answered) {
						// Another row's `execute` answered this item's request while it waited (Q25); the outcome lands here, on its own row.
						const a = it.answered;
						it.answered = undefined;
						const applied = applyAnswer(itemId, it, a);
						if (applied) return applied;
					}
					const next = await turn.waitFor(itemId, signal, onUpdate && ((output) => onUpdate(textResult(output, { itemId, status: "inProgress" }))));
					if (next.kind === "completed") return settle(kind === "fileChange" ? patchResult(itemId, next.item, it.changes) : kind === "mcpToolCall" ? toolCallResult(itemId, next.item) : commandResult(itemId, next.item, it.output));
					const answered = await answerRequest(turn, next.req, ctx);
					displayRefused(turn.client, turn.threadId, next.req.itemId, turn.items.get(next.req.itemId), next.req.kind, answered);
					if (signal?.aborted) throw new AbortedError(); // Escape closed the dialog: the row is cut, whatever the closed dialog answered
					if (next.req.itemId !== itemId) {
						// Any active row answers any pending request (Q25); the outcome belongs to the request's own row, which opens after this one settles.
						const other = turn.items.get(next.req.itemId);
						if (other) other.answered = answered;
						continue;
					}
					const applied = applyAnswer(itemId, it, answered);
					if (applied) return applied;
				}
			} catch (e) {
				// A command cut while it ran, by Escape or by its turn ending under it (a refused request on another item, a child's turn ending), is not killed:
				// Codex keeps it, so its completion is watched for the one notice, on both paths (review 2026-09-14).
				const cut = kind === "commandExecution" && !it.completed;
				if (cut && (e instanceof AbortedError || e instanceof TurnEndedError)) displayRowCut(turn.client, itemId, it, turn.threadId, e instanceof AbortedError || e.status === "interrupted");
				if (e instanceof AbortedError) {
					// Escape. A plain Error, as Pi's tool contract wants on abort, shaped as Pi's bash shapes its own cut row (`appendStatus`): the output so far, a blank line, then the status.
					if (cut) turn.client.cutCommands.set(itemId, it.command ?? "");
					throw new Error(`${it.output ? `${it.output}\n\n` : ""}${cutStatus(kind)}`);
				}
				if (e instanceof TurnEndedError) {
					if (e.status !== "interrupted") throw new RowError(ROW_STATUS.stopped);
					if (cut) turn.client.cutCommands.set(itemId, it.command ?? "");
					throw new RowError(cutStatus(kind));
				}
				throw e;
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		}

		// ── renderers: the command row and the tool call row are Pi's bash row (`renderers/bash.js`, row gate 2026-09-14), built from the same pieces ──
		/** Pi's bash row keeps the start time in the row's shared state, so the result can show `Elapsed` while running and `Took` after. */
		function startTiming(context: RenderContext): RowState {
			const st = context.state as RowState;
			if (context.executionStarted && st.startedAt === undefined) {
				st.startedAt = Date.now();
				st.endedAt = undefined;
			}
			return st;
		}
		/** A `toolOutput` block as Pi's bash row draws its output: every line gray, a failed row's too (the error tint is the row's background, never the text); collapsed,
		 *  the last five *visual* lines behind Pi's "earlier lines" hint with its expand key, re-truncated when the width changes through the per-width cache.
		 *  `blankBefore` is the empty line bash puts between the title and its output; a code argument under a tool row's title has none. */
		function outputPreview(text: string, expanded: boolean | undefined, cache: PreviewCache, theme: Theme, blankBefore = true): Component {
			const styled = text.split("\n").map((l) => theme.fg("toolOutput", l)).join("\n");
			if (expanded) return new Text(`${blankBefore ? "\n" : ""}${styled}`, 0, 0);
			return {
				render: (width: number) => {
					if (cache.width !== width || cache.styled !== styled) Object.assign(cache, { width, styled, ...truncateToVisualLines(styled, COMMAND_PREVIEW_LINES, width) });
					const lead = blankBefore ? [""] : [];
					if (!cache.skippedCount) return [...lead, ...cache.visualLines!];
					const hint = `${theme.fg("muted", `... (${cache.skippedCount} earlier lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
					return [...lead, truncateToWidth(hint, width, "..."), ...cache.visualLines!];
				},
				invalidate: () => {
					cache.width = undefined;
				},
			};
		}
		/** The result of a command row and of a tool call row, one function so both are the same bytes: the output preview, then `Elapsed` or `Took`; the container is reused across renders. */
		function renderRowResult(result: Parameters<typeof resultText>[0], opts: ToolRenderResultOptions, theme: Theme, context: RenderContext): Component {
			const st = context.state as RowState;
			if (st.startedAt !== undefined && opts.isPartial && !st.interval) st.interval = setInterval(() => context.invalidate(), 1000);
			if (!opts.isPartial || context.isError) {
				st.endedAt ??= Date.now();
				if (st.interval) {
					clearInterval(st.interval);
					st.interval = undefined;
				}
			}
			const component = (context.lastComponent instanceof Container ? context.lastComponent : new Container()) as Container;
			component.clear();
			const text = resultText(result).trim();
			if (text) component.addChild(outputPreview(text, opts.expanded, (st.preview ??= {}), theme));
			if (st.startedAt !== undefined) component.addChild(new Text(`\n${theme.fg("muted", `${opts.isPartial ? "Elapsed" : "Took"} ${(((st.endedAt ?? Date.now()) - st.startedAt) / 1000).toFixed(1)}s`)}`, 0, 0));
			component.invalidate();
			return component;
		}

		const NO_SNIPPET = "; it cannot be called directly.";
		/** Registers the command tool and keeps the object Pi was given, whose functions the owner announces. */
		const registerCommandTool: typeof pi.registerTool = (tool) => {
			pi.registerTool(tool);
			registeredCommandTool = tool;
		};
		registerCommandTool({
			name: TOOL_COMMAND,
			label: "Codex command",
			description: `Records a command the Codex agent is running in this conversation${NO_SNIPPET}`,
			parameters: CommandParams,
			executionMode: "sequential",
			execute: (_id, params, signal, onUpdate, ctx) => executeRow("commandExecution", params.itemId, signal, onUpdate as (p: ToolResult) => void, ctx),
			renderCall(args, theme, context) {
				startTiming(context);
				const live = state.activeTurn?.items.get(args.itemId)?.command;
				const cmd = displayCommand(args.command || live || "");
				return new Text(tagLines(theme, args.agentPath, theme.fg("toolTitle", theme.bold(`$ ${cmd || "(pending)"}`))), 0, 0);
			},
			renderResult: renderRowResult,
		});
		const registerMcpTool: typeof pi.registerTool = (tool) => {
			pi.registerTool(tool);
			registeredMcpTool = tool;
		};
		registerMcpTool({
			name: TOOL_TOOL,
			label: "Codex tool call",
			description: `Records an MCP, app, or computer-use tool call the Codex agent made in this conversation${NO_SNIPPET}`,
			parameters: ToolCallParams,
			executionMode: "sequential",
			execute: (_id, params, signal, onUpdate, ctx) => executeRow("mcpToolCall", params.itemId, signal, onUpdate as (p: ToolResult) => void, ctx),
			renderCall(args, theme, context) {
				// Bold `<server>.<tool>` as bash's `$` title (the app's name for the server when Codex named one, display only), Codex's own call title after it in
				// output gray, then the arguments: a lone string argument (the code of a `js` call) as lines collapsed as output is, anything else as one JSON line.
				const st = startTiming(context);
				const { title: callTitle, rest } = splitTitle(args.arguments);
				const name = literalMcpLabel(state.activeTurn?.items.get(args.itemId)?.appName || mcpDisplayMetadata(args.display)?.appName || args.server);
				const title = tagLines(theme, args.agentPath, `${theme.fg("toolTitle", theme.bold(`${name}.${literalMcpLabel(args.tool)}`))}${callTitle ? ` ${theme.fg("toolOutput", callTitle)}` : ""}`);
				const component = (context.lastComponent instanceof Container ? context.lastComponent : new Container()) as Container;
				component.clear();
				component.addChild(new Text(title, 0, 0));
				const code = loneString(rest);
				const consumed = callTitle !== undefined && rest && typeof rest === "object" && Object.keys(rest as Rec).length === 0; // the title was the whole call: no `{}` line under it
				if (code !== undefined) component.addChild(outputPreview(code.replace(/\n$/, ""), context.expanded, (st.argPreview ??= {}), theme, false));
				else if (!consumed) {
					const json = theme.fg("toolOutput", JSON.stringify(rest) ?? "");
					component.addChild({ render: (width: number) => [truncateToWidth(json, width, "...")], invalidate: () => {} });
				}
				component.invalidate();
				return component;
			},
			renderResult: renderRowResult,
		});
		pi.registerTool({
			name: TOOL_PATCH,
			label: "Codex edit",
			description: `Records a file change the Codex agent is applying in this conversation${NO_SNIPPET}`,
			parameters: PatchParams,
			renderShell: "self", // Pi's own edit row renders in the unpadded self shell, not the padded contentBox; match it so the glance's tinted diff starts at column one
			executionMode: "sequential",
			execute: (_id, params, signal, onUpdate, ctx) => executeRow("fileChange", params.itemId, signal, onUpdate as (p: ToolResult) => void, ctx),
			renderCall(args, theme, context) {
				// Built exactly as Pi's own edit row (`renderers/edit.js`): one Box reused across renders (so rbf-edit-glance's paddingX=0 sticks
				// instead of a fresh paddingX=1 box leaving a one-column gap), carrying `preview.diff` so the glance tints it like an edit.
				const changes = args.changes.length ? args.changes : (state.activeTurn?.items.get(args.itemId)?.changes ?? []);
				const diff = changes.map((c) => c.diff).filter(Boolean).join("\n");
				const box = (context?.lastComponent instanceof Box ? context.lastComponent : new Box(1, 1, (t: string) => t)) as Box & { preview?: { diff: string } };
				box.setBgFn((t: string) => theme.bg(diff ? "toolSuccessBg" : "toolPendingBg", t)); // Pi's edit row: pending until the diff is known, then success
				box.preview = diff ? { diff } : undefined;
				box.clear();
				const header = changes.length ? changes.map((c) => theme.fg("toolTitle", theme.bold(patchRowLine(c)))).join("\n") : theme.fg("toolTitle", theme.bold("edit (pending)"));
				box.addChild(new Text(tagLines(theme, args.agentPath, header), 0, 0));
				if (diff) {
					box.addChild(new Spacer(1));
					box.addChild(new Text(renderDiff(diff), 0, 0));
				}
				return box;
			},
			renderResult(result, _opts, theme, context) {
				return new Text(context.isError ? `\n${theme.fg("error", resultText(result))}` : "", 0, 0);
			},
		});
		pi.registerTool({
			name: TOOL_QUESTION,
			label: "Codex question",
			description: `Records a question the Codex agent asked the user in this conversation${NO_SNIPPET}`,
			parameters: QuestionParams,
			executionMode: "sequential",
			execute: (_id, params, signal, onUpdate, ctx) => executeRow("question", params.itemId, signal, onUpdate as (p: ToolResult) => void, ctx),
			renderCall(args, theme) {
				return new Text(tagLines(theme, args.agentPath, args.questions.map((q) => theme.fg("toolTitle", theme.bold(`? ${q.header}`))).join("\n")), 0, 0);
			},
			renderResult(result, _opts, theme, context) {
				return new Text(`\n${theme.fg("toolOutput", resultText(result))}`, 0, 0); // as the command row: tint is the background
			},
		});

		/** Pi calls this without network at startup and with network when the picker opens. */
		async function refreshModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
			const storedConfigs = storedToConfigs(context.stored);
			const fresh = typeof context.stored?.checkedAt === "number" && now() - context.stored.checkedAt < CATALOG_MAX_AGE_MS;
			if (!context.allowNetwork || (!context.force && fresh)) return [BOOTSTRAP_MODEL, ...storedConfigs];
			try {
				const fetched = await fetchCatalog(context.signal);
				await context.publish({ persist: { models: fetched.map(toStoredModel), checkedAt: now() } });
				return [BOOTSTRAP_MODEL, ...fetched];
			} catch {
				return [BOOTSTRAP_MODEL, ...storedConfigs];
			}
		}

		async function fetchCatalog(signal: AbortSignal): Promise<ProviderModelConfig[]> {
			const client = await AppServerClient.start(process.cwd(), command);
			const onAbort = () => void client.close();
			signal.addEventListener("abort", onAbort, { once: true });
			try {
				await client.request("initialize", { clientInfo: { name: "pi-rbf-codex", version: CLIENT_VERSION }, capabilities: { experimentalApi: true } });
				client.notify("initialized", {});
				const res = rec(await client.request("model/list", { includeHidden: false }));
				const data = Array.isArray(res.data) ? (res.data as CodexModel[]) : [];
				return data.filter((m) => !m.hidden).map(toProviderModel);
			} finally {
				signal.removeEventListener("abort", onAbort);
				await client.close();
			}
		}

		function clearEditor(editor: any): void {
			if (typeof editor.setText === "function") {
				editor.cancelAutocomplete?.();
				editor.state = { lines: [""], cursorLine: 0, cursorCol: 0 };
				editor.pastes?.clear();
				if (typeof editor.pasteCounter === "number") editor.pasteCounter = 0;
				editor.exitHistoryBrowsing?.();
				editor.scrollOffset = 0;
				editor.undoStack?.clear();
				editor.lastAction = null;
				if (editor.onChange) editor.onChange("");
			}
		}

		async function executeCompactLifecycle(
			client: AppServerClient,
			threadId: string,
			runningControl: { threadId: string; navigatedDuringRun: boolean; finished: boolean }
		): Promise<void> {
			contextMeter.clear(); presentAgents();
			type CompactOutcome =
				| { outcome: "completed" }
				| { outcome: "failed"; reason: string }
				| { outcome: "unknown" };

			return new Promise<void>((resolve) => {
				let settled = false;
				let timeoutTimer: NodeJS.Timeout | null = null;
				let compactTurnId: string | null = null;
				let compactItemId: string | null = null;
				let itemCompleted = false;

				const cleanup = () => {
					if (timeoutTimer) clearTimeout(timeoutTimer);
					unsubscribe();
					client.onExit.delete(onExit);
				};

				const settle = (result: CompactOutcome) => {
					if (settled) return;
					settled = true;
					runningControl.finished = true;
					if (!runningControl.navigatedDuringRun) state.recentCompactTerminal = { ...result, at: now(), replayed: false };
					cleanup();
					const report = () => {
						if (state.shuttingDown) { resolve(); return; }
						const navigated = runningControl.navigatedDuringRun;
						if (result.outcome === "completed") notify(navigated ? COMPACT_NOTICE.completeNavigated : COMPACT_NOTICE.completeStatus, navigated ? "warning" : "info");
						else if (result.outcome === "failed") notify(navigated ? COMPACT_NOTICE.failedNavigated(result.reason) : COMPACT_NOTICE.failed(result.reason), "error");
						else notify(navigated ? COMPACT_NOTICE.unknownNavigated : COMPACT_NOTICE.unknown, "warning");
						resolve();
					};
					// session_tree fires before Pi redraws its transcript. Its microtasks finish
					// before a timer, so branch-qualified terminal feedback survives that redraw.
					if (runningControl.navigatedDuringRun) setTimeout(report, NAVIGATION_FEEDBACK_DELAY_MS);
					else report();
				};

				const unsubscribe = client.subscribe((m) => {
					if (settled) return;
					if (m.method === "turn/started") {
						const params = m.params as Rec;
						if (params?.threadId === threadId) {
							const turn = params?.turn as Rec;
							compactTurnId = String(turn?.id ?? "");
						}
					} else if (m.method === "item/started") {
						const params = m.params as Rec;
						if (params?.threadId === threadId) {
							const item = params?.item as Rec;
							if (item?.type === "contextCompaction" && params.turnId === compactTurnId && typeof item.id === "string" && item.id) {
								compactItemId = item.id;
							}
						}
					} else if (m.method === "item/completed") {
						const params = m.params as Rec;
						if (params?.threadId === threadId) {
							const item = params?.item as Rec;
							if (item?.type === "contextCompaction" && params.turnId === compactTurnId && compactItemId !== null && item.id === compactItemId) {
								if (item.status === "completed" || !item.status) {
									itemCompleted = true;
								}
							}
						}
					} else if (m.method === "turn/completed") {
						const params = m.params as Rec;
						if (params?.threadId === threadId) {
							const turn = params?.turn as Rec;
							const turnId = String(turn?.id ?? "");
							if (turnId === compactTurnId) {
								const status = turn?.status;
								if (status === "completed") {
									if (itemCompleted) {
										void settle({ outcome: "completed" });
									} else {
										void settle({ outcome: "unknown" });
									}
								} else if (status === "failed") {
									void settle({ outcome: "failed", reason: COMPACT_SAFE_REASONS.failed });
								} else if (status === "interrupted") {
									void settle({ outcome: "failed", reason: COMPACT_SAFE_REASONS.interrupted });
								} else {
									void settle({ outcome: "unknown" });
								}
							}
						}
					}
				});

				const onExit = () => {
					void settle({ outcome: "unknown" });
				};
				client.onExit.add(onExit);

				timeoutTimer = setTimeout(async () => {
					if (state.client === client) state.client = null;
					await client.close();
					void settle({ outcome: "unknown" });
				}, options.compactTimeoutMs ?? 180_000);

				client.request("thread/compact/start", { threadId }).catch(() => {
					void settle({ outcome: "failed", reason: COMPACT_SAFE_REASONS.refused });
				});
			});
		}

		function handleManualCompact(editor: any, rawText: string): void {
			const trimmed = rawText.trim();
			if (trimmed !== "/compact") {
				notify(COMPACT_NOTICE.instructions, "warning");
				return;
			}
			const ctx = state.ctx;
			if (!ctx) return;
			state.recentCompactTerminal = null;

			const isBusy = (ctx.isIdle && !ctx.isIdle()) || (ctx.hasPendingMessages && ctx.hasPendingMessages()) || state.activeTurn !== null || state.pendingCompact !== null;
			if (isBusy) {
				notify(COMPACT_NOTICE.busy, "warning");
				return;
			}

			const { thread: T, turn: U } = newestEntries(ctx);
			const sessionId = ctx.sessionManager.getSessionId();

			if (!T) {
				notify(COMPACT_NOTICE.noThread, "warning");
				return;
			}
			if (T.sessionId !== sessionId) {
				notify(COMPACT_NOTICE.foreignBranch, "warning");
				return;
			}
			if (!U || U.status !== "completed") {
				notify(COMPACT_NOTICE.noThread, "warning");
				return;
			}

			const capturedLeafId = ctx.sessionManager.getLeafId?.();
			const capturedModel = ctx.model;
			const capturedThread = T;
			const capturedTurn = U;
			const capturedCwd = realpathSync.native(ctx.sessionManager.getCwd());
			const capturedEditorText = typeof editor.getText === "function" ? editor.getText() : rawText;

			notify(COMPACT_NOTICE.checkingStatus, "info");

			let resolveCompact!: () => void;
			state.pendingCompact = new Promise<void>((resolve) => {
				resolveCompact = resolve;
			});
			const checkingControl = { cancelled: false, abort: new AbortController() };
			state.checkingCompact = checkingControl;

			void (async () => {
				try {
					let client: AppServerClient;
					try {
						client = await ensureClient(capturedCwd, checkingControl.abort.signal);
					} catch (e) {
						if (!checkingControl.cancelled && !state.shuttingDown) notify(e instanceof CodexError && e.key === "codex-version" ? COMPACT_NOTICE.version : COMPACT_NOTICE.unverified, "warning");
						return;
					}
					if (checkingControl.cancelled || state.shuttingDown) return;
					let check: HistoryVerificationResult;
					try {
						const resume = rec(await client.request("thread/resume", { threadId: capturedThread.threadId, excludeTurns: true }, SETUP_TIMEOUT_MS, checkingControl.abort.signal));
						if (rec(resume.thread).id !== capturedThread.threadId) throw new Error("Codex returned another thread");
						check = await verifyBranchHistory(client, capturedThread.threadId, capturedTurn.turnId, checkingControl.abort.signal);
					} catch {
						if (!checkingControl.cancelled && !state.shuttingDown) notify(COMPACT_NOTICE.unverified, "warning");
						return;
					}
					if (checkingControl.cancelled || state.shuttingDown) return;
					if (!check.ok) {
						notify(COMPACT_NOTICE.unverified, "warning");
						return;
					}

					const currentLeafId = ctx.sessionManager.getLeafId?.();
					const currentModel = ctx.model;
					const { thread: curT, turn: curU } = newestEntries(ctx);
					const currentCwd = realpathSync.native(ctx.sessionManager.getCwd());
					const currentEditorText = typeof editor.getText === "function" ? editor.getText() : "";

					if (
						currentLeafId !== capturedLeafId ||
						currentModel?.id !== capturedModel?.id ||
						currentModel?.provider !== PROVIDER_ID ||
						curT?.threadId !== capturedThread.threadId ||
						curU?.turnId !== capturedTurn.turnId ||
						currentCwd !== capturedCwd
					) {
						notify(COMPACT_NOTICE.movedOrChanged, "warning");
						return;
					}

					if (currentEditorText !== capturedEditorText) {
						notify(COMPACT_NOTICE.changedDraft, "warning");
						return;
					}

					clearEditor(editor);

					state.checkingCompact = null;
					const runningControl = { threadId: capturedThread.threadId, navigatedDuringRun: false, finished: false };
					state.runningCompact = runningControl;

					notify(COMPACT_NOTICE.runningStatus, "info");

					await executeCompactLifecycle(client, capturedThread.threadId, runningControl);
				} catch {
					if (!checkingControl.cancelled && !state.shuttingDown) {
						const running = state.runningCompact;
						const msg = running ? (running.navigatedDuringRun ? COMPACT_NOTICE.unknownNavigated : COMPACT_NOTICE.unknown) : COMPACT_NOTICE.unverified;
						notify(msg, "warning");
					}
				} finally {
					state.checkingCompact = null;
					state.runningCompact = null;
					state.pendingCompact = null;
					resolveCompact();
				}
			})();
		}

		installCompactSubmitInterceptor();
		(Editor as any)[COMPACT_DISPATCHER_KEY] = {
			owner: instanceOwner,
			shouldIntercept: () => {
				return state.ctx?.model?.provider === PROVIDER_ID;
			},
			dispatch: (editor: any, text: string) => {
				handleManualCompact(editor, text);
			},
		};

		pi.on("session_start", async (_event, ctx) => {
			leaveFast();
			if (registeredCommandTool) {
				let sessionId: string | undefined;
				try {
					sessionId = ctx.sessionManager.getSessionId();
				} catch {}
				display?.start(sessionId, registeredCommandTool);
				if (registeredMcpTool) mcpDisplay?.start(sessionId, registeredMcpTool);
			}
			state.ctx = ctx;
			contextMeter.clear(); contextFooter?.dispose();
			agentsFooter?.dispose(); footerInputOff?.();
			if (ctx.mode === "tui") overviewSafe(() => {
				agentsFooter = installCodexAgentsFooter(() => state.ctx?.mode === "tui" && state.ctx.model?.provider === PROVIDER_ID && !!(agents.agents.length || agents.unavailable || agents.partial || agents.notSaved), () => { const current = state.ctx; if (current && !state.shuttingDown) void openAgents(current).catch(() => {}); }, () => state.ctx?.ui.theme, createCodexAgentPointer());
				contextFooter = installCodexContextFooter(() => state.ctx?.mode === "tui" && state.ctx.model?.provider === PROVIDER_ID, () => contextMeter.snapshot, () => state.ctx?.ui.theme, () => {
					const mode = state.ctx ? fastMode(state.ctx) : "inherit";
					return mode === "fast" || mode === "standard" ? mode : undefined;
				});
				footerInputOff = ctx.ui.onTerminalInput?.(data => { if (agentsFooter?.pointerInput(data)) presentAgents(); return undefined; });
			});
			restoreAgents(ctx);
			state.client = null;
			state.shuttingDown = false;
			state.noticedPolicy = false;
			state.activeTurn = null;
			state.approvedForSession = false;
			state.noticedElicitation = false;
			state.pendingCompact = null;
			state.checkingCompact = null;
			state.runningCompact = null;
			state.recentCompactTerminal = null;
			presentFast(ctx);
			(Editor as any)[COMPACT_DISPATCHER_KEY] = {
				owner: instanceOwner,
				shouldIntercept: () => {
					return state.ctx?.model?.provider === PROVIDER_ID;
				},
				dispatch: (editor: any, text: string) => {
					handleManualCompact(editor, text);
				},
			};
			if (!newestOwnEntry(ctx)) return; // a forked copy starts cold, so its last prompt was not ours to interrupt
			// An unanswered prompt, or a row whose tool never returned (Pi died mid-row): both mean the request was cut.
			const last = [...ctx.sessionManager.getBranch()].reverse().find((e) => e.type === "message") as { message?: { role: string; stopReason?: string } } | undefined;
			if (last?.message?.role === "user" || (last?.message?.role === "assistant" && last.message.stopReason === "toolUse")) notify(NOTICE.interrupted, "warning");
		});
		const closeChild = async () => {
			leaveFast();
			if (state.ctx?.mode === "tui") state.ctx.ui.setStatus("rbf-codex-fast", undefined);
			contextMeter.clear();
			leaveAgents();
			overviewSafe(() => { agentsFooter?.dispose(); footerInputOff?.(); });
			agentsFooter = undefined; footerInputOff = undefined;
			state.shuttingDown = true;
			state.recentCompactTerminal = null;
			if (state.checkingCompact) {
				state.checkingCompact.cancelled = true;
				state.checkingCompact.abort.abort();
			}
			const c = state.client;
			state.client = null;
			if (c) await c.close();
			const curDispatcher = (Editor as any)[COMPACT_DISPATCHER_KEY];
			if (curDispatcher?.owner === instanceOwner) {
				delete (Editor as any)[COMPACT_DISPATCHER_KEY];
			}
		};
		pi.on("session_shutdown", async () => {
			try {
				await closeChild();
			} finally {
				contextFooter?.dispose(); contextFooter = undefined;
				display?.stop();
				mcpDisplay?.stop();
			}
		});
		pi.on("session_before_switch", async () => {
			await closeChild();
			return {};
		});
		pi.on("session_before_compact", async (event, ctx) => {
			if (!isBoundBranch(ctx)) return {};
			if (event.reason === "manual") notify(NOTICE.compact);
			return { cancel: true };
		});
		pi.on("session_tree", async (_event, _ctx) => {
			leaveFast(); presentFast(_ctx);
			contextMeter.clear();
			state.ctx = _ctx; restoreAgents(_ctx);
			const terminal = state.recentCompactTerminal;
			if (terminal && !terminal.replayed && now() - terminal.at < 1500) {
				terminal.replayed = true;
				setTimeout(() => {
					if (state.shuttingDown || state.recentCompactTerminal !== terminal) return;
					if (terminal.outcome === "completed") notify(COMPACT_NOTICE.completeNavigated, "warning");
					else if (terminal.outcome === "failed") notify(COMPACT_NOTICE.failedNavigated(terminal.reason ?? COMPACT_SAFE_REASONS.failed), "error");
					else notify(COMPACT_NOTICE.unknownNavigated, "warning");
				}, NAVIGATION_FEEDBACK_DELAY_MS);
			}
			if (state.checkingCompact && !state.checkingCompact.cancelled) {
				state.checkingCompact.cancelled = true;
				state.checkingCompact.abort.abort();
				setTimeout(() => {
					if (!state.shuttingDown) notify(COMPACT_NOTICE.movedOrChanged, "warning");
				}, NAVIGATION_FEEDBACK_DELAY_MS);
			}
			if (state.runningCompact && !state.runningCompact.finished) {
				const running = state.runningCompact;
				running.navigatedDuringRun = true;
				setTimeout(() => {
					if (!state.shuttingDown && state.runningCompact === running) notify(COMPACT_NOTICE.runningStatusNavigated, "info");
				}, NAVIGATION_FEEDBACK_DELAY_MS);
			}
		});
		pi.on("session_before_tree", async (event, ctx) => {
			leaveFast();
			contextMeter.clear();
			leaveAgents();
			if (isBoundBranch(ctx) && event.preparation.userWantsSummary) return { summary: { summary: NOTICE.treeSummary } };
			return {};
		});
		pi.on("model_select", async (event, ctx) => {
			leaveFast(); presentFast(ctx);
			contextMeter.clear();
			state.ctx = ctx; agentsFooter?.reset();
			overviewSafe(() => { overviewClose?.(); overviewRender = undefined; });
			presentAgents();
			if (event.model.provider !== PROVIDER_ID || event.previousModel?.provider === PROVIDER_ID) return;
			const hasAnswer = ctx.sessionManager.getBranch().some((e) => e.type === "message" && (e as { message?: { role: string } }).message?.role === "assistant");
			if (hasAnswer) notify(NOTICE.coldStart);
		});

		pi.registerProvider(PROVIDER_ID, {
			api: API_ID,
			baseUrl: "stdio://codex",
			apiKey: "codex-cli", // non-secret sentinel; Pi needs one to mark the provider configured
			streamSimple,
			refreshModels,
			models: [BOOTSTRAP_MODEL],
		});
	};
}

export default createRbfCodex();
