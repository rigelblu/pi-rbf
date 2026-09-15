// rbf-codex — use Codex's full agent harness through Pi (#pi-10, v0.21.4).
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
import { keyHint, parseArgs, renderDiff, truncateToVisualLines, type ExtensionAPI, type ExtensionContext, type ProviderModelConfig, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEventStream, Context, Model, RefreshModelsContext, SimpleStreamOptions, ThinkingLevel, ToolCall } from "@earendil-works/pi-ai";
import { Box, Container, Spacer, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import { createInterface } from "node:readline";

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
const CLIENT_VERSION = "0.21.4";
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
	"codex-logged-out": "Codex is not logged in. Run `codex login`, then send again.",
	"workspace-mismatch": "This conversation's Codex thread belongs to another directory. Start a new Pi conversation here, or reopen it from that directory.",
	"unsupported-input": "This Codex model accepts plain text only. Remove the image, or pick an image-capable Codex model.",
	"codex-stopped": "Codex stopped unexpectedly. Send your message again to continue this conversation.",
	"turn-failed": "Codex could not complete this request. Send your message again or start a new Pi conversation.",
	"no-answer": "Codex finished without an answer. Send your message again.",
	generic: "Codex is unavailable. See the notice for details.",
} as const;
export type CopyKey = keyof typeof COPY;

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
export const ToolCallParams = Type.Object({ itemId: Type.String(), ...AgentFields, server: Type.String(), tool: Type.String(), arguments: Type.Unknown() });
export type AgentArgs = { threadId: string; agentPath: string };
export type CommandArgs = AgentArgs & { itemId: string; command: string; cwd: string };
export type PatchChangeArg = { path: string; kind: string; movePath?: string; diff: string };
export type PatchArgs = AgentArgs & { itemId: string; changes: PatchChangeArg[] };
export type QuestionArg = { id: string; header: string; question: string; options?: { label: string; description: string }[]; isOther?: boolean; isSecret?: boolean };
export type QuestionArgs = AgentArgs & { itemId: string; questions: QuestionArg[] };
export type ToolCallArgs = AgentArgs & { itemId: string; server: string; tool: string; arguments: unknown };
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
const PI_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

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
	thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
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
	const thinkingLevelMap: Record<string, string | null> = { minimal: null };
	for (const level of PI_LEVELS) if (level !== "minimal") thinkingLevelMap[level] = efforts.has(level) ? level : null;
	return {
		id: m.id, // Codex's own id; the provider tag in the picker row tells it apart from openai-codex
		name: `${m.displayName} (Codex agent)`,
		reasoning: true,
		thinkingLevelMap,
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
		.map((m) => ({ id: m.id.startsWith(LEGACY_ID_PREFIX) ? m.id.slice(LEGACY_ID_PREFIX.length) : m.id, name: m.name, reasoning: m.reasoning, thinkingLevelMap: m.thinkingLevelMap, input: m.input, contextWindow: m.contextWindow, maxTokens: m.maxTokens, cost: m.cost }));
}

function toStoredModel(c: ProviderModelConfig): Model<typeof API_ID> {
	return { id: c.id, name: c.name, api: API_ID, provider: PROVIDER_ID, baseUrl: "stdio://codex", reasoning: c.reasoning, thinkingLevelMap: c.thinkingLevelMap, input: c.input, cost: c.cost, contextWindow: c.contextWindow, maxTokens: c.maxTokens };
}

export function mapEffort(model: Model<any>, level: ThinkingLevel | undefined): string | undefined {
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
		createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
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

export type CodexCommand = { bin: string; args: string[]; fallbackBin?: string };
export type RbfCodexOptions = {
	/** How to spawn the app-server; tests point this at a fake. */
	command?: CodexCommand;
	/** Frozen argv for the `--sandbox` guard; defaults to `process.argv.slice(2)`. */
	argv?: string[];
	/** Clock for catalog freshness; tests inject one. */
	now?: () => number;
};

const DEFAULT_COMMAND: CodexCommand = { bin: "codex", args: ["app-server"], fallbackBin: CODEX_FALLBACK_BIN };

export function isSandboxLaunch(argv: string[]): boolean {
	return parseArgs(argv).unknownFlags.has("sandbox");
}

// ── the Codex side of one turn, across every streamSimple call and tool execution it spans ──
type UserInputItem = { type: "text"; text: string; text_elements: [] } | { type: "image"; url: string };
type TurnItem = { kind: RowKind; threadId: string; agentPath: string; rowOpened: boolean; command?: string; cwd?: string; changes: PatchChangeArg[]; questions: QuestionArg[]; output: string; completed?: Rec; server?: string; tool?: string; arguments?: unknown; appName?: string; answered?: Answer; aborted?: boolean };
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
}
type ProjectedEvent =
	| { kind: "row"; itemId: string }
	| { kind: "thinking"; text: string }
	| { kind: "answer"; text: string }
	| { kind: "final"; text: string }
	| { kind: "end"; status: string; error?: string };

// ── the extension ────────────────────────────────────────────────────────────
export function createRbfCodex(options: RbfCodexOptions = {}) {
	const command = options.command ?? DEFAULT_COMMAND;
	const now = options.now ?? Date.now;

	return function rbfCodex(pi: ExtensionAPI): void {
		// `pi --sandbox` (#pi-23) and this provider stay mutually exclusive.
		if (isSandboxLaunch(options.argv ?? process.argv.slice(2))) return;

		// Everything below lives in this closure; Pi rebinds a new instance on switch, fork, and reload.
		const state = { ctx: null as ExtensionContext | null, client: null as AppServerClient | null, shuttingDown: false, noticedPolicy: false, activeTurn: null as ActiveTurn | null, approvedForSession: false, noticedElicitation: false };

		const notify = (text: string, type: "info" | "warning" | "error" = "info") => {
			if (state.ctx?.mode === "tui") state.ctx.ui.notify(text, type);
		};

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

			constructor(
				readonly client: AppServerClient,
				readonly threadId: string,
			) {
				this.unsubscribe = client.subscribe((m) => {
					try {
						this.project(m);
					} catch (e) {
						// One malformed notification must never escape readline's event and take Pi down.
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
			client.onRequest = onServerRequest;
			const failedServers = new Set<string>();
			client.subscribe((m) => {
				// Runs inside readline's `line` event: nothing thrown here may escape, as the turn's own subscriber guards.
				try {
					watch(m);
				} catch {
					// a malformed notification is dropped; the turn's own handling of it is separate
				}
			});
			function watch(m: JsonRpc): void {
				const p = (m.params ?? {}) as Rec;
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
					throw e instanceof CodexError && e.key === "generic" ? new CodexError("turn-failed", e.detail) : e;
				}
				const forked = rec(res.thread).id;
				if (typeof forked !== "string") throw new CodexError("turn-failed", "thread/fork returned no thread id");
				pi.appendEntry<ThreadEntry>(ENTRY_TYPE, { threadId: forked, cwd, sessionId });
				return bindingOf(res);
			};
			if (!T) return start();
			if (T.cwd !== cwd) throw new CodexError("workspace-mismatch", `Codex thread directory: ${T.cwd}`);
			if (T.sessionId !== sessionId) return U ? fork(T.threadId, U.turnId) : start();
			// Own thread: resume it; with a turn entry, fork only when Codex completed a turn this branch never saw.
			const res = rec(await client.request("thread/resume", U ? { threadId: T.threadId } : { threadId: T.threadId, excludeTurns: true }, SETUP_TIMEOUT_MS, signal));
			if (!U) return bindingOf(res);
			const turns = (rec(res.thread).turns as Rec[] | undefined) ?? [];
			const at = turns.findIndex((t) => t.id === U.turnId);
			const unseenCompleted = at >= 0 && turns.slice(at + 1).some((t) => t.status === "completed");
			return unseenCompleted ? fork(T.threadId, U.turnId) : bindingOf(res);
		}

		async function startTurn(client: AppServerClient, threadId: string, items: UserInputItem[], model: Model<any>, reasoning: ThinkingLevel | undefined): Promise<ActiveTurn> {
			const effort = mapEffort(model, reasoning);
			const turnParams: Rec = { threadId, input: items };
			if (effort) turnParams.effort = effort;
			const codexId = codexModelId(model.id);
			if (codexId) turnParams.model = codexId;
			// Subscribe before sending: readline hands over every line of one stdout chunk at once, so a notification can share a chunk with the response.
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
					started = rec(await client.request("turn/start", { threadId, input: items }));
				}
			} catch (e) {
				turn.dispose();
				if (state.activeTurn === turn) state.activeTurn = null;
				throw e instanceof CodexError && e.key === "generic" ? new CodexError("turn-failed", e.detail) : e;
			}
			turn.turnId = String(rec(started.turn).id);
			return turn;
		}

		/** One user prompt is one Codex turn across N `streamSimple` calls and tool executions. */
		function streamSimple(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
			const out = new AssistantMessageWriter(model);
			const fail = (e: unknown) => {
				if (e instanceof AbortedError) return out.finish("aborted");
				const err = e instanceof CodexError ? e : new CodexError("generic", String(e));
				if (err.detail) notify(`Codex: ${err.detail}`, "warning");
				out.finish("error", err.key);
			};

			void (async () => {
				const ctx = state.ctx;
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
				try {
					const cwd = realpathSync.native(ctx.sessionManager.getCwd());
					const client = await ensureClient(cwd, signal);
					const bound = await bindThread(client, ctx, cwd, signal);
					if (!state.noticedPolicy) {
						state.noticedPolicy = true;
						notify(NOTICE.policy(bound.policy, bound.sandbox));
					}
					if (signal?.aborted) return out.finish("aborted");
					const started = await startTurn(client, bound.threadId, items, model, options?.reasoning);
					if (signal?.aborted) {
						await started.interrupt();
						return drain(started, { silent: true });
					}
					return drain(started, {});
				} catch (e) {
					return fail(e);
				}
			})();

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
					void startTurn(turn.client, turn.threadId, unsent, model, options?.reasoning)
						.then((next) => drain(next, {}))
						.catch(fail);
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
							out.toolCall(rowToolCall(ev.itemId, it));
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

		function rowToolCall(itemId: string, it: TurnItem): ToolCall {
			const id = `codex-${itemId}`;
			const agent = { threadId: it.threadId, agentPath: it.agentPath };
			if (it.kind === "commandExecution") return { type: "toolCall", id, name: TOOL_COMMAND, arguments: { itemId, ...agent, command: it.command ?? "", cwd: it.cwd ?? "" } satisfies CommandArgs };
			if (it.kind === "fileChange") return { type: "toolCall", id, name: TOOL_PATCH, arguments: { itemId, ...agent, changes: it.changes } satisfies PatchArgs };
			if (it.kind === "mcpToolCall") return { type: "toolCall", id, name: TOOL_TOOL, arguments: { itemId, ...agent, server: it.server ?? "", tool: it.tool ?? "", arguments: it.arguments ?? {} } satisfies ToolCallArgs };
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
		pi.registerTool({
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
		pi.registerTool({
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
				const name = state.activeTurn?.items.get(args.itemId)?.appName || args.server;
				const title = tagLines(theme, args.agentPath, `${theme.fg("toolTitle", theme.bold(`${name}.${args.tool}`))}${callTitle ? ` ${theme.fg("toolOutput", callTitle)}` : ""}`);
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

		pi.on("session_start", async (_event, ctx) => {
			state.ctx = ctx;
			state.client = null;
			state.shuttingDown = false;
			state.noticedPolicy = false;
			state.activeTurn = null;
			state.approvedForSession = false;
			state.noticedElicitation = false;
			if (!newestOwnEntry(ctx)) return; // a forked copy starts cold, so its last prompt was not ours to interrupt
			// An unanswered prompt, or a row whose tool never returned (Pi died mid-row): both mean the request was cut.
			const last = [...ctx.sessionManager.getBranch()].reverse().find((e) => e.type === "message") as { message?: { role: string; stopReason?: string } } | undefined;
			if (last?.message?.role === "user" || (last?.message?.role === "assistant" && last.message.stopReason === "toolUse")) notify(NOTICE.interrupted, "warning");
		});
		const closeChild = async () => {
			state.shuttingDown = true;
			const c = state.client;
			state.client = null;
			if (c) await c.close();
		};
		pi.on("session_shutdown", closeChild);
		pi.on("session_before_switch", async () => {
			await closeChild();
			return {};
		});
		pi.on("session_before_compact", async (event, ctx) => {
			if (!isBoundBranch(ctx)) return {};
			if (event.reason === "manual") notify(NOTICE.compact);
			return { cancel: true };
		});
		pi.on("session_before_tree", async (event, ctx) => {
			if (isBoundBranch(ctx) && event.preparation.userWantsSummary) return { summary: { summary: NOTICE.treeSummary } };
			return {};
		});
		pi.on("model_select", async (event, ctx) => {
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
