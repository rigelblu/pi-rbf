import { InteractiveMode, parseArgs, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, MouseRegion, visibleWidth } from "@earendil-works/pi-tui";

// The first half of this file is the rules: what a fact proves, which rows group, what a header says. It touches no host.
// The second half, from "the view" on, puts those rules on screen through Pi's transcript container.

/** Which execution owner a shell row belongs to: Pi's wrapped agent bash, or a Codex command item. */
export type ShellSource = "pi-bash" | "codex-command";

/**
 * What the execution owner can vouch for. `succeeded` and `failed` need the owner's terminal evidence.
 * `background` means the tool returned and the process runs on; it carries the Pi task id or the Codex item id.
 */
export type ExecutionEvidence =
	| { state: "waiting" | "running" | "succeeded" | "failed" | "cancelled" | "notRun" | "unknown" }
	| { state: "background"; identity: string };

export type EvidenceState = ExecutionEvidence["state"];

/** One standalone agent shell invocation. The view feeds every field; nothing here is read from command output. */
export type ShellMember = {
	sessionId: string;
	toolCallId: string;
	source: ShellSource;
	/** Codex only. A root row stores `""`. */
	threadId?: string;
	agentPath?: string;
	cwd: string;
	/** Pi's own row. The group draws it and never copies its output. */
	nativeRow: unknown;
	executionEvidence: ExecutionEvidence;
	/** The owner confirmed the start: an observed spawn, an admitted start, or a numeric exit. A cancellation request never sets it. */
	executionStarted: boolean;
	/** Pi's row shows an error result. Kept apart from the evidence: an error can be a cancellation, a refusal, or a failure nobody classified. */
	rowError: boolean;
	/** The call has not ended. A row restored from history is never open. */
	callOpen: boolean;
	/** A result is recorded for the call. */
	hasResult: boolean;
	/** The owner generation and revision of the last evidence update taken. */
	ownerGeneration?: string;
	revision?: number;
};

export type ShellGroup = {
	/** Member ids in call order, each once. The count is this list's length. */
	memberIds: string[];
	expanded: boolean;
	/** Nothing visible has followed the last member, so the next matching call joins. A closed group still takes its members' status updates. */
	open: boolean;
	/** How many member updates have touched this group since it was made. */
	updates: number;
};

/** The id a member is known by everywhere: its session, source and call id. A Codex item id alone is not one. */
export function memberId(member: Pick<ShellMember, "sessionId" | "source" | "toolCallId">): string {
	return `${member.sessionId}\u0000${member.source}\u0000${member.toolCallId}`;
}

// ── evidence ──

/** What the view holds for one invocation: the two fields the header reads, and what the reducer must remember to read the next fact. */
export type OwnerEvidence = {
	executionEvidence: ExecutionEvidence;
	executionStarted: boolean;
	/** A stop or a timeout was asked for. Only a close can confirm it. */
	stopRequested?: "cancel" | "timeout";
	/** Terminal facts disagreed. No later fact can prove an outcome. */
	conflicted?: boolean;
};

/**
 * What an owner saw, as it saw it and as it publishes it. The reducer decides what it proves.
 * - `start`: the owner confirmed the spawn, or Codex admitted the item's start
 * - `background`: Pi's detach. The tool returned and the process runs on under this task id
 * - `cut`: a Codex command's row was cut by an interruption. Codex doesn't kill it, so it runs on under this item id, if it had started
 * - `stop-request`: an abort, `/cancel`, a timeout or an owner shutdown asked the process to stop
 * - `close`: Pi's process closed
 * - `child-error`: a generic child error with no close
 * - `not-run`: the owner proved a refusal or a failure before the spawn
 * - `completion`: Codex's item completion, with `item.exitCode` and `item.status` as they arrived, not defaulted
 * - `lost`: the owner was replaced, closed or reloaded, or a completion named another thread
 */
export type OwnerFact =
	| { kind: "start" }
	| { kind: "background"; identity: string }
	| { kind: "cut"; identity: string }
	| { kind: "stop-request"; reason: "cancel" | "timeout" }
	| { kind: "close"; code: number | null; signal?: string | null }
	| { kind: "child-error" }
	| { kind: "not-run" }
	| { kind: "completion"; exitCode?: unknown; status?: unknown }
	| { kind: "lost" };

/** A member no owner has said anything about. */
export const NO_EVIDENCE: OwnerEvidence = { executionEvidence: { state: "waiting" }, executionStarted: false };

const STILL_GOING = new Set<EvidenceState>(["waiting", "running", "background"]);
const PROVED = new Set<EvidenceState>(["succeeded", "failed", "cancelled", "notRun"]);
/** The proved endings of a process that existed. `notRun` is an ending with no execution. */
const ENDED = new Set<EvidenceState>(["succeeded", "failed", "cancelled"]);

/** What one terminal fact says. `unknown` is a fact with too little in it; `conflict` is one that contradicts itself or a confirmed start. */
type Outcome = "succeeded" | "failed" | "cancelled" | "notRun" | "unknown" | "conflict";

/** Close 0 succeeded and any other code failed. With no code, only a signal after a requested stop or timeout says how it ended. */
function closeOutcome(prev: OwnerEvidence, fact: { code: number | null; signal?: string | null }): Outcome {
	if (typeof fact.code === "number") return fact.code === 0 ? "succeeded" : "failed";
	if (!fact.signal) return "unknown";
	if (prev.stopRequested === "timeout") return "failed";
	if (prev.stopRequested === "cancel") return "cancelled";
	return "unknown";
}

/**
 * A numeric exit decides: nonzero failed, even beside `completed`, the status the native row defaults to. Exit 0 beside a status that is there and is not `completed`,
 * and any exit beside `declined`, contradict.
 * With no exit only an explicit `failed` or `declined` decides: `completed` alone proves nothing.
 */
function completionOutcome(prev: OwnerEvidence, fact: { exitCode?: unknown; status?: unknown }): Outcome {
	if (Number.isInteger(fact.exitCode)) {
		if (fact.status === "declined") return "conflict";
		if (fact.exitCode === 0) return fact.status === undefined || fact.status === null || fact.status === "completed" ? "succeeded" : "conflict";
		return "failed";
	}
	if (fact.status === "failed") return "failed";
	if (fact.status === "declined") return prev.executionStarted ? "conflict" : "notRun";
	return "unknown";
}

/** Takes a terminal fact. A proved outcome is kept against a repeat or an empty fact, and becomes unknown for good against a different one. */
function settle(prev: OwnerEvidence, outcome: Outcome, started: boolean): OwnerEvidence {
	if (prev.conflicted) return prev;
	const state = prev.executionEvidence.state;
	const executionStarted = prev.executionStarted || started;
	if (PROVED.has(state) ? outcome !== "unknown" && outcome !== state : outcome === "conflict") {
		return { executionEvidence: { state: "unknown" }, executionStarted, conflicted: true };
	}
	if (PROVED.has(state) || (outcome === "unknown" && state === "unknown" && executionStarted === prev.executionStarted)) {
		return prev;
	}
	return { executionEvidence: { state: outcome as Exclude<Outcome, "conflict"> }, executionStarted };
}

/**
 * Folds one owner fact into an invocation's evidence. The one place that decides what a fact proves, for both owners: they publish facts and interpret none.
 * Returns `prev` itself when the fact changes nothing.
 */
export function reduceEvidence(prev: OwnerEvidence, fact: OwnerFact): OwnerEvidence {
	const state = prev.executionEvidence.state;
	switch (fact.kind) {
		case "start":
			// A start can't revive a member that ended or went unknown, and can't pull one back from the background.
			if (state === "waiting") return { ...prev, executionEvidence: { state: "running" }, executionStarted: true };
			return STILL_GOING.has(state) && !prev.executionStarted ? { ...prev, executionStarted: true } : prev;
		case "background":
			if (!STILL_GOING.has(state)) return prev;
			if (prev.executionEvidence.state === "background" && prev.executionEvidence.identity === fact.identity) return prev;
			return { ...prev, executionEvidence: { state: "background", identity: fact.identity } };
		case "cut":
			// A command cut before its start was admitted can't be said to run on.
			if (!STILL_GOING.has(state)) return prev;
			if (!prev.executionStarted) return { ...prev, executionEvidence: { state: "unknown" } };
			if (prev.executionEvidence.state === "background" && prev.executionEvidence.identity === fact.identity) return prev;
			return { ...prev, executionEvidence: { state: "background", identity: fact.identity } };
		case "stop-request":
			// Not an ending. The state stays; the reason waits for the close.
			return PROVED.has(state) || prev.conflicted || prev.stopRequested ? prev : { ...prev, stopRequested: fact.reason };
		case "child-error":
		case "lost":
			return STILL_GOING.has(state) ? { ...prev, executionEvidence: { state: "unknown" } } : prev;
		case "close":
			return settle(prev, closeOutcome(prev, fact), typeof fact.code === "number");
		case "not-run":
			return settle(prev, prev.executionStarted ? "conflict" : "notRun", false);
		case "completion":
			return settle(prev, completionOutcome(prev, fact), Number.isInteger(fact.exitCode));
		default:
			// A newer owner may tell a kind of fact this view was not written for. It proves nothing here.
			return prev;
	}
}

/** Whether a fact is one of the kinds above, with the fields its kind needs. Anything else an owner sends is ignored, not folded. */
export function isOwnerFact(fact: unknown): fact is OwnerFact {
	if (!fact || typeof fact !== "object") return false;
	const told = fact as Record<string, unknown>;
	switch (told.kind) {
		case "start":
		case "child-error":
		case "not-run":
		case "completion":
		case "lost":
			return true;
		case "background":
		case "cut":
			return typeof told.identity === "string" && told.identity !== "";
		case "stop-request":
			return told.reason === "cancel" || told.reason === "timeout";
		case "close":
			return told.code === null || typeof told.code === "number";
		default:
			return false;
	}
}

/** A call's stored result, as replay finds it. */
export type ReplayRecord = {
	/** The record matches the selected call and result identity and the admitted source. */
	matched: boolean;
	isError: boolean;
	/** The result's own details, as stored. */
	details?: Record<string, unknown>;
};

/**
 * What history alone proves about a restored call with no live owner evidence. Only a matched Codex record with numeric exit 0,
 * a completed status and no error did run. Every Pi bash result is unknown: detach and foreground exit both store exit 0.
 */
export function replayEvidence(source: ShellSource, record: ReplayRecord | undefined): OwnerEvidence {
	const details = record?.details;
	if (source === "codex-command" && record?.matched && !record.isError && details?.exitCode === 0 && details.status === "completed") {
		return { executionEvidence: { state: "succeeded" }, executionStarted: true };
	}
	return { executionEvidence: { state: "unknown" }, executionStarted: false };
}

// ── grouping ──

/** One row of the transcript in drawn order: a grouped shell call, or anything else. `visible` is false for a row that draws no line, as a tool-only assistant placeholder does. */
export type TranscriptRow = { kind: "shell"; member: ShellMember } | { kind: "content"; visible: boolean };

/** Two adjacent calls share a group only within one session, source, agent and working directory. */
function sameRun(a: ShellMember, b: ShellMember): boolean {
	return (
		a.sessionId === b.sessionId &&
		a.source === b.source &&
		(a.threadId ?? "") === (b.threadId ?? "") &&
		(a.agentPath ?? "") === (b.agentPath ?? "") &&
		a.cwd === b.cwd
	);
}

/**
 * Groups the transcript's rows, in the order drawn. Live and reopened transcripts go through this one function, so the same rows give the same groups.
 * A group made only of new members follows `globalExpanded`. Any other group is expanded when a group in `previous` that held one of its members was:
 * an append inherits, a split keeps both halves as they were, and a merge stays open if either side was.
 */
export function groupRows(rows: readonly TranscriptRow[], previous: readonly ShellGroup[], globalExpanded: boolean): ShellGroup[] {
	const groups: ShellGroup[] = [];
	const seen = new Set<string>();
	let group: ShellGroup | undefined;
	let last: ShellMember | undefined;
	for (const row of rows) {
		if (row.kind === "content") {
			// Anything that draws a line ends the group, whatever it is.
			if (group && row.visible) {
				group.open = false;
				group = undefined;
			}
			continue;
		}
		const id = memberId(row.member);
		if (seen.has(id)) continue;
		seen.add(id);
		if (!group || !sameRun(last!, row.member)) {
			if (group) group.open = false;
			group = { memberIds: [], expanded: globalExpanded, open: true, updates: 0 };
			groups.push(group);
		}
		group.memberIds.push(id);
		last = row.member;
	}

	const before = new Map<string, ShellGroup>();
	for (const was of previous) {
		for (const id of was.memberIds) before.set(id, was);
	}
	for (const made of groups) {
		const from = made.memberIds.map((id) => before.get(id)).filter((was) => was !== undefined);
		if (from.length > 0) made.expanded = from.some((was) => was.expanded);
	}
	return groups;
}

/** The view's state: who the members are, how they group, and the counts the scale check reads. */
export type ShellView = {
	members: Map<string, ShellMember>;
	groups: ShellGroup[];
	groupOf: Map<string, ShellGroup>;
	/** What the reducer holds for each member that has taken a fact. */
	evidence: Map<string, OwnerEvidence>;
	/** The live owner generation for each source. A fact from any other generation is stale. */
	owners: Map<ShellSource, string>;
	/** How many times membership was regrouped. An output or status update never adds one. */
	reconciliations: number;
};

export function createShellView(): ShellView {
	return { members: new Map(), groups: [], groupOf: new Map(), evidence: new Map(), owners: new Map(), reconciliations: 0 };
}

/** Regroups from the rows now drawn. A member already known keeps its object, and so its evidence; a member whose row is gone leaves. */
export function reconcileMembership(view: ShellView, rows: readonly TranscriptRow[], globalExpanded: boolean): void {
	const groups = groupRows(rows, view.groups, globalExpanded);
	const members = new Map<string, ShellMember>();
	for (const row of rows) {
		if (row.kind !== "shell") continue;
		const id = memberId(row.member);
		if (!members.has(id)) members.set(id, view.members.get(id) ?? row.member);
	}
	const groupOf = new Map<string, ShellGroup>();
	for (const group of groups) {
		for (const id of group.memberIds) groupOf.set(id, group);
	}
	for (const id of view.evidence.keys()) {
		if (!members.has(id)) view.evidence.delete(id);
	}
	view.members = members;
	view.groups = groups;
	view.groupOf = groupOf;
	view.reconciliations++;
}

/** What Pi's own row says about a member. Evidence is not among it: that comes only through `applyEvidence`. */
type MemberPatch = Partial<Pick<ShellMember, "rowError" | "callOpen" | "hasResult">>;

/**
 * Marks one member's group, and only that group, as touched, after applying what its row now says. Order and membership are not its business,
 * so an output chunk, which passes no patch, costs one lookup. Returns false for a member the view doesn't hold.
 */
export function updateMember(view: ShellView, id: string, patch?: MemberPatch): boolean {
	const member = view.members.get(id);
	const group = view.groupOf.get(id);
	if (!member || !group) return false;
	if (patch) Object.assign(member, patch);
	group.updates++;
	return true;
}

/** One fact as an owner publishes it on the display channel. `revision` counts up per invocation within one owner generation. */
export type FactMessage = {
	kind: "fact";
	sessionId: string;
	source: ShellSource;
	ownerGeneration: string;
	toolCallId: string;
	revision: number;
	fact: OwnerFact;
};

/**
 * Folds an owner's fact into the member it names. Dropped: another session, source or call, an owner generation that is not the live one,
 * and a revision no newer than the last one taken from that generation, so a replayed snapshot folds nothing twice.
 * Returns true, and touches the member's group, only when the fact changed what is known.
 */
export function applyEvidence(view: ShellView, message: FactMessage): boolean {
	const id = memberId(message);
	const member = view.members.get(id);
	if (!member || view.owners.get(message.source) !== message.ownerGeneration) return false;
	if (member.ownerGeneration === message.ownerGeneration && message.revision <= (member.revision ?? -Infinity)) return false;
	member.ownerGeneration = message.ownerGeneration;
	member.revision = message.revision;
	const prev = view.evidence.get(id) ?? { executionEvidence: member.executionEvidence, executionStarted: member.executionStarted };
	const next = reduceEvidence(prev, message.fact);
	if (next === prev) return false;
	view.evidence.set(id, next);
	member.executionEvidence = next.executionEvidence;
	member.executionStarted = next.executionStarted;
	return updateMember(view, id);
}

// ── copy ──

/** Host theme roles. `toolTitle` is the native tool-title text; unknown status is `muted`, never a warning. */
export type ColorRole = "toolTitle" | "muted" | "dim" | "error";
export type Span = { text: string; role: ColorRole };
/** One piece of a header or identity line. A line breaks between fields before it breaks inside one. */
export type Field = Span[];
/** One drawn line: `column` spaces, then the spans. */
export type WrappedLine = { column: number; spans: Span[] };

/** The column of the header's mark, where every native tool header sits. Columns count from 0 at the pane edge. */
export const HEADER_COLUMN = 1;
/** The column of every line the group owns under its header: wrapped header lines, identity lines and member lines. */
export const BODY_COLUMN = 4;

const SEPARATOR = " · ";

/** The header field a member counts under. An unknown member with Pi's own error row is an unclassified error, and is not counted as unknown too. */
type Tally = EvidenceState | "error";

function tallyOf(member: ShellMember): Tally {
	const state = member.executionEvidence.state;
	return state === "unknown" && member.rowError ? "error" : state;
}

/** The mixed-state fields in their fixed order. A succeeded member is implied by the total. */
const FIELDS: [Tally, ColorRole, (n: number) => string][] = [
	["running", "muted", (n) => `${n} running`],
	["background", "muted", (n) => `${n} background`],
	["failed", "error", (n) => `${n} failed`],
	["error", "error", (n) => `${n} ${n === 1 ? "error" : "errors"} (status unknown)`],
	["cancelled", "muted", (n) => `${n} cancelled`],
	["notRun", "muted", (n) => `${n} not run`],
	["waiting", "muted", (n) => `${n} waiting`],
	["unknown", "muted", (n) => `${n} unknown`],
];

/** What a group of one says in place of a count. */
const ALONE: Partial<Record<Tally, string>> = { background: "background", cancelled: "cancelled", notRun: "not run" };

/**
 * The group header as fields: the mark and count first, then one field per status. The one site for header copy.
 * No members give no fields, so nothing is drawn.
 */
export function formatHeader(members: readonly ShellMember[], expanded: boolean): Field[] {
	const n = members.length;
	if (n === 0) return [];
	const counts = new Map<Tally, number>();
	for (const member of members) {
		const tally = tallyOf(member);
		counts.set(tally, (counts.get(tally) ?? 0) + 1);
	}
	const title = (text: string): Span => ({ text, role: "toolTitle" });
	const muted = (text: string): Span => ({ text, role: "muted" });
	const mark = expanded ? "▾" : "▸";
	const total = `${n} shell ${n === 1 ? "command" : "commands"}`;

	// The prefix already says what every member is doing, so these two carry no suffix.
	if (counts.get("waiting") === n) return [[title(`${mark} `), muted("waiting for"), title(` ${total}`)]];
	if (counts.get("running") === n) return [[title(`${mark} `), muted("running"), title(` ${total}`)]];

	const ran = members.every((member) => member.executionStarted && ENDED.has(member.executionEvidence.state));
	const lead: Field = [title(`${mark} ${ran ? "ran " : ""}${total}`)];
	if (counts.get("unknown") === n) return [lead, [muted("status unknown")]];
	if (n === 1) {
		const [tally] = counts.keys();
		if (tally === "error") return [lead, [{ text: "error", role: "error" }], [muted("status unknown")]];
		const alone = ALONE[tally!];
		if (alone) return [lead, [muted(alone)]];
	}
	const fields: Field[] = [lead];
	for (const [tally, role, text] of FIELDS) {
		const count = counts.get(tally);
		if (count) fields.push([{ text: text(count), role }]);
	}
	return fields;
}

/** One line per member in the background, in member order: the Pi task id, or the Codex item still running after an interruption. */
export function identityLines(members: readonly ShellMember[]): Field[][] {
	const lines: Field[][] = [];
	for (const member of members) {
		const evidence = member.executionEvidence;
		if (evidence.state !== "background") continue;
		if (member.source === "codex-command") {
			lines.push([[{ text: `Codex command ID: ${evidence.identity}`, role: "dim" }], [{ text: "still running", role: "dim" }]]);
		} else {
			lines.push([[{ text: `Task ID: ${evidence.identity}`, role: "dim" }]]);
		}
	}
	return lines;
}

/**
 * The lines the group draws under each member of an expanded group, one list per member.
 * - `Status unknown`: the member is unknown with no error row of Pi's, and another member has a known state. With none known the header says it for all
 * - `No recorded result`: the member is unknown, its call is no longer open, and no result is recorded. An open call has no result yet
 */
export function memberLines(members: readonly ShellMember[]): string[][] {
	const known = members.filter((member) => member.executionEvidence.state !== "unknown").length;
	return members.map((member) => {
		const lines: string[] = [];
		if (member.executionEvidence.state !== "unknown") return lines;
		if (!member.rowError && known > 0) lines.push("Status unknown");
		if (!member.callOpen && !member.hasResult) lines.push("No recorded result");
		return lines;
	});
}

/** A text's width when every character takes one cell. The view passes pi-tui's `visibleWidth` in its place. */
const codePoints = (text: string): number => [...text].length;

/** A field cut at its spaces: each word keeps its spans' roles. */
function wordsOf(field: Field): Span[][] {
	const words: Span[][] = [];
	let word: Span[] = [];
	for (const span of field) {
		span.text.split(" ").forEach((text, i) => {
			if (i > 0 && word.length > 0) {
				words.push(word);
				word = [];
			}
			if (text) word.push({ text, role: span.role });
		});
	}
	if (word.length > 0) words.push(word);
	return words;
}

/**
 * Wraps fields to `width` cells. The first line starts at `firstColumn` and every other at column 4. Fields on one line are joined by a dim ` · `,
 * which is dropped at a break. A field too wide for a line of its own breaks at a space, and inside a word only when the word alone is too wide.
 * Nothing is cut off. `cells` measures a text's width.
 */
export function wrapFields(fields: readonly Field[], width: number, firstColumn = HEADER_COLUMN, cells: (text: string) => number = codePoints): WrappedLine[] {
	const lines: WrappedLine[] = [];
	let line: WrappedLine | undefined;
	let used = 0;
	const newLine = (): WrappedLine => {
		line = { column: lines.length === 0 ? firstColumn : BODY_COLUMN, spans: [] };
		lines.push(line);
		used = line.column;
		return line;
	};
	const widthOf = (spans: Span[]) => spans.reduce((sum, span) => sum + cells(span.text), 0);
	for (const field of fields) {
		const fieldCells = widthOf(field);
		if (line && line.spans.length > 0 && used + SEPARATOR.length + fieldCells <= width) {
			line.spans.push({ text: SEPARATOR, role: "dim" }, ...field);
			used += SEPARATOR.length + fieldCells;
			continue;
		}
		let at = newLine();
		if (used + fieldCells <= width) {
			at.spans.push(...field);
			used += fieldCells;
			continue;
		}
		for (const word of wordsOf(field)) {
			const wordCells = widthOf(word);
			if (at.spans.length > 0 && used + 1 + wordCells <= width) {
				at.spans.push({ text: " ", role: word[0]!.role }, ...word);
				used += 1 + wordCells;
				continue;
			}
			if (at.spans.length > 0) at = newLine();
			for (const span of word) {
				// Cut inside the word only where the line is full. A line always takes one character, so a pane narrower than column 4 still ends.
				let piece = "";
				for (const ch of span.text) {
					const chCells = cells(ch);
					if (used + chCells > width && (piece || at.spans.length > 0)) {
						if (piece) at.spans.push({ text: piece, role: span.role });
						piece = "";
						at = newLine();
					}
					piece += ch;
					used += chCells;
				}
				if (piece) at.spans.push({ text: piece, role: span.role });
			}
		}
	}
	return lines;
}

// ── the view ──
// Presentation only. It draws Pi's own rows through a projection and never moves, wraps or re-registers one.
// Anything it can't do safely it doesn't do: the rows draw as Pi draws them, and one warning says so.

/** The private channel the two execution owners publish on. */
export const SHELL_DISPLAY_CHANNEL = "rbf:shell-display:v1";
/** Said once per attachment when the groups can't attach or a projection fault detaches them. Pi prefixes it with `Warning: `. */
export const UNAVAILABLE_WARNING = "Shell command groups unavailable; showing native tool rows.";

/** Where the live view sits. The wrappers below look it up on every call, so a wrapper left under someone else's patch after a reload reaches the new view, or nothing. */
export const VIEW_KEY = Symbol.for("rbf.shellCommandGroups.view");
/** The four `InteractiveMode` methods the view wraps: three to learn which instance is live, one to follow the global expansion setting. */
export const HOST_METHODS = ["handleEvent", "renderSessionItems", "renderSessionEntries", "setToolsExpanded"] as const;
/** The two methods it wraps on that instance's transcript container. */
export const CONTAINER_METHODS = ["render", "handleMouse"] as const;

export const wrappedKey = (name: string) => Symbol.for(`rbf.shellCommandGroups.wrapped.${name}`);
const originalKey = (name: string) => Symbol.for(`rbf.shellCommandGroups.original.${name}`);

type Method = (this: any, ...args: any[]) => any;
const hasOwn = (target: any, key: PropertyKey) => Object.prototype.hasOwnProperty.call(target, key);

/**
 * Puts one wrapper on `target[name]`. The wrapper holds the method it replaced and hands every call to the live view, or straight to that method when there is none.
 * A target that already carries ours, on top or under another extension's wrapper, is left alone: wrapping again would stack.
 */
function installWrapper(target: any, name: string): boolean {
	const key = wrappedKey(name);
	if (hasOwn(target, key) && typeof target[name] === "function") return true;
	if (typeof target[name] !== "function") return false;
	const own: Method | undefined = hasOwn(target, name) ? target[name] : undefined;
	const original: Method =
		own ??
		function (this: any, ...args: any[]) {
			return Object.getPrototypeOf(target)[name].apply(this, args);
		};
	const wrapper: Method = function (this: any, ...args: any[]) {
		const view = (globalThis as any)[VIEW_KEY];
		return view ? view.call(name, this, original, args) : original.apply(this, args);
	};
	target[name] = wrapper;
	target[key] = wrapper;
	target[originalKey(name)] = own;
	return true;
}

/** Puts back the method the wrapper replaced, only when the method in place is still that wrapper. Under another patch it stays, and reaches nothing once the view is gone. */
function removeWrapper(target: any, name: string): void {
	const key = wrappedKey(name);
	if (!target || !hasOwn(target, key) || target[name] !== target[key]) return;
	const own = target[originalKey(name)];
	if (own) target[name] = own;
	else delete target[name];
	delete target[key];
	delete target[originalKey(name)];
}

/** `pi --sandbox` owns its own bash rows (#pi-23): a sandbox launch gets no view. An argv Pi can't parse gets none either. */
export function isSandboxLaunch(argv: readonly string[]): boolean {
	try {
		return parseArgs([...argv]).unknownFlags.has("sandbox");
	} catch {
		return true;
	}
}

const FALLBACK_THEME = { fg: (_role: string, text: string) => text, bold: (text: string) => text };

function activeTheme(): typeof FALLBACK_THEME {
	return (
		(globalThis as any)[Symbol.for("@earendil-works/pi-coding-agent:theme")] ??
		(globalThis as any)[Symbol.for("@mariozechner/pi-coding-agent:theme")] ??
		FALLBACK_THEME
	);
}

/** One wrapped line in the host theme's roles. The count takes the native tool title's look, which is bold. */
function paint(line: WrappedLine): string {
	const theme = activeTheme();
	const spans = line.spans.map((span) => theme.fg(span.role, span.role === "toolTitle" ? theme.bold(span.text) : span.text));
	return " ".repeat(line.column) + spans.join("");
}

/** An owner's announcement: who it is, and the functions of the tool it registered. */
type Announcement = { kind: "announce"; sessionId: string; source: ShellSource; toolName: string; ownerGeneration: string; execute: unknown; renderCall: unknown; renderResult: unknown };

/** A child's error, carried out of the projection so it reaches the caller as it would have without the view. */
class NativeFault {
	constructor(readonly error: unknown) {}
}

/** What the last drawn frame put where: one entry per run of lines, in the shape Pi's own container routes a mouse event through. */
type Segment = { component: { handleMouse?: (event: any) => any }; height: number };
type Layout = { width: number; segments: Segment[] };
/** A left press on a header or member, waiting for its click. Anything that moved the target since cancels it. */
type Armed =
	| {
			kind: "header";
			first: string;
			start: number;
			width: number;
			reconciliations: number;
			disclosureGeneration: number;
			sessionId: string | undefined;
	  }
	| {
			kind: "member";
			first: string;
			memberId: string;
			row: any;
			start: number;
			height: number;
			width: number;
			reconciliations: number;
			disclosureGeneration: number;
			sessionId: string | undefined;
	  };

const NO_ACTION = {};

/**
 * The view for one extension instance: it learns the live `InteractiveMode`, listens to the owners, and draws groups.
 * `call` is what every wrapper reaches. Until an instance is captured, and after a fault, every call goes straight to Pi.
 */
export function createShellGroupsView(pi: Pick<ExtensionAPI, "events">) {
	let view = createShellView();
	let inert = false;
	let stopped = false;
	let host: any;
	let container: any;
	let ctx: ExtensionContext | undefined;
	let sessionId: string | undefined;
	let stopListening: (() => void) | undefined;
	let warningHeld = false;
	/** Why the view let go, if it did: the error, and which of its own steps met it. Kept for whoever has to find out; never printed. */
	let fault: { where: string; error: unknown } | undefined;
	const announcements = new Map<ShellSource, Announcement>();
	/** Rows Pi rebuilt from history, for calls that were not open when it rebuilt them. Those calls are over, whatever `pendingTools` holds. */
	let restored = new WeakSet<object>();
	let rowOf = new Map<string, any>();
	let idOf = new Map<any, string>();
	let idOfCall = new Map<string, string>();
	/** One candidate member per row, so a frame that changes nothing allocates nothing. */
	let candidates = new WeakMap<object, ShellMember>();
	let signature: unknown[] = [];
	let layout: Layout | undefined;
	let armed: Armed | undefined;
	let disclosureGeneration = 0;

	// ── failing open ──

	/** Says the one warning, or holds it until `session_start` brings a context. `fail` calls it once per view. */
	function warn(): void {
		if (!ctx) {
			warningHeld = true;
			return;
		}
		const kept = ctx;
		// One tick later: Pi draws the conversation right after `session_start`, and a warning sent during that draw lands mid-transcript.
		setTimeout(() => {
			try {
				if (kept.mode === "tui") kept.ui.notify(UNAVAILABLE_WARNING, "warning");
			} catch {}
		}, 0);
	}

	/** Takes the wrappers back off, each only if it is still the one in place, and stops listening. Keeps no row. */
	function detach(): void {
		// A newer view may have taken over, as after a reload: the wrappers are its to keep.
		const live = (globalThis as any)[VIEW_KEY];
		if (live === api || live === undefined) {
			for (const name of CONTAINER_METHODS) removeWrapper(container, name);
			for (const name of HOST_METHODS) removeWrapper(InteractiveMode?.prototype, name);
			delete (globalThis as any)[VIEW_KEY];
		}
		try {
			stopListening?.();
		} catch {}
		stopListening = undefined;
		host = undefined;
		container = undefined;
		layout = undefined;
		armed = undefined;
		disclosureGeneration = 0;
		view = createShellView();
		rowOf = new Map();
		idOf = new Map();
		idOfCall = new Map();
		candidates = new WeakMap();
		restored = new WeakSet();
		signature = [];
		announcements.clear();
	}

	/** The groups can't go on: every call goes to Pi from now, the frame redraws natively, and one warning says so. */
	function fail(where: string, error: unknown): void {
		if (inert) return;
		inert = true;
		fault = { where, error };
		layout = undefined;
		armed = undefined;
		const ui = host?.ui;
		warn();
		setTimeout(detach, 0);
		try {
			ui?.requestRender?.();
		} catch {}
	}

	/** Runs view-only work. A throw here is the view's fault, never Pi's, and ends the view rather than the call. */
	function guard(where: string, work: () => void): void {
		if (inert) return;
		try {
			work();
		} catch (error) {
			fail(where, error);
		}
	}

	/** Runs a child's own method. Its throw is Pi's to deal with, as it was before the view. */
	function native<T>(work: () => T): T {
		try {
			return work();
		} catch (error) {
			throw new NativeFault(error);
		}
	}

	function requestRender(): void {
		try {
			host?.ui?.requestRender?.();
		} catch {}
	}

	// ── the host ──

	/** Learns which `InteractiveMode` is live and wraps its transcript container. A shape it doesn't know is left alone, with the warning. */
	function capture(self: any): void {
		if (self === host) return;
		const chat = self?.chatContainer;
		const supported =
			chat instanceof Container &&
			Array.isArray(chat.children) &&
			self.pendingTools instanceof Map &&
			typeof self.toolOutputExpanded === "boolean" &&
			typeof self.ui?.requestRender === "function";
		if (!supported || !CONTAINER_METHODS.every((name) => installWrapper(chat, name))) {
			fail("capture", new Error("InteractiveMode does not have the transcript container, pending tools, expansion flag or redraw request the view reads"));
			return;
		}
		if (container && container !== chat) for (const name of CONTAINER_METHODS) removeWrapper(container, name);
		host = self;
		container = chat;
		signature = [];
		layout = undefined;
	}

	/** The announcement that makes this child a member, if any: its tool definition carries the announced execute and renderer functions, and it is built as Pi builds a default tool row. */
	function announcementFor(child: any): Announcement | undefined {
		if (announcements.size === 0 || !(child instanceof ToolExecutionComponent)) return undefined;
		const row = child as any;
		const definition = row.toolDefinition;
		if (!definition || typeof definition.execute !== "function") return undefined;
		for (const announced of announcements.values()) {
			if (definition.execute !== announced.execute || definition.renderCall !== announced.renderCall || definition.renderResult !== announced.renderResult) continue;
			if (row.toolName !== announced.toolName || typeof row.toolCallId !== "string" || typeof row.setExpanded !== "function") return undefined;
			// The shape check reads the row's box and its mouse regions, never what a region holds: pi-45 swaps that.
			const box = row.contentBox;
			const parts = box instanceof Box ? box.children : undefined;
			if (!Array.isArray(parts) || parts.length < 1 || parts.length > 2 || !parts.every((part) => part instanceof MouseRegion)) return undefined;
			if (!Array.isArray(row.children) || !row.children.includes(box)) return undefined;
			return announced;
		}
		return undefined;
	}

	function candidateFor(row: any, announced: Announcement): ShellMember {
		let member = candidates.get(row);
		if (!member || member.source !== announced.source || member.sessionId !== announced.sessionId) {
			const args = row.args && typeof row.args === "object" ? row.args : {};
			const codex = announced.source === "codex-command";
			member = {
				sessionId: announced.sessionId,
				toolCallId: row.toolCallId,
				source: announced.source,
				threadId: codex && typeof args.threadId === "string" ? args.threadId : undefined,
				agentPath: codex && typeof args.agentPath === "string" ? args.agentPath : undefined,
				cwd: String((codex && typeof args.cwd === "string" && args.cwd) || row.cwd || ""),
				nativeRow: row,
				...NO_EVIDENCE,
				rowError: false,
				callOpen: true,
				hasResult: false,
			};
			candidates.set(row, member);
		}
		return member;
	}

	/** What Pi's own row says about a call: whether it is still open, and whether a final result or error is recorded. */
	function rowFacts(row: any): Pick<ShellMember, "rowError" | "callOpen" | "hasResult"> {
		const final = row.result !== undefined && row.isPartial === false;
		return {
			callOpen: !restored.has(row) && host.pendingTools.get(row.toolCallId) === row,
			hasResult: final,
			rowError: final && row.result.isError === true,
		};
	}

	function setEvidence(id: string, next: OwnerEvidence): void {
		const member = view.members.get(id);
		if (!member) return;
		view.evidence.set(id, next);
		member.executionEvidence = next.executionEvidence;
		member.executionStarted = next.executionStarted;
		updateMember(view, id);
	}

	/** A call that is over while no owner has said a thing about how it went: what its own record proves, which for Pi bash is nothing. */
	function settle(id: string): void {
		const member = view.members.get(id);
		if (!member || member.callOpen || member.executionEvidence.state !== "waiting") return;
		const held = view.evidence.get(id);
		if (held) {
			setEvidence(id, reduceEvidence(held, { kind: "lost" }));
			return;
		}
		const row = rowOf.get(id);
		const final = row?.result !== undefined && row.isPartial === false;
		const details = final && row.result.details && typeof row.result.details === "object" ? row.result.details : undefined;
		const matched = member.source !== "codex-command" || (details !== undefined && String(details.itemId) === String(row.args?.itemId));
		setEvidence(id, replayEvidence(member.source, final ? { matched, isError: row.result.isError === true, details } : undefined));
	}

	/** Re-reads one member's row. Its group is touched only when something the header or a member line shows has changed. */
	function refresh(id: string | undefined): void {
		const member = id === undefined ? undefined : view.members.get(id);
		const row = id === undefined ? undefined : rowOf.get(id);
		if (!member || !row) return;
		const facts = rowFacts(row);
		if (facts.callOpen !== member.callOpen || facts.hasResult !== member.hasResult || facts.rowError !== member.rowError) updateMember(view, id!, facts);
		settle(id!);
	}

	function syncExpansion(group: ShellGroup): void {
		for (const id of group.memberIds) {
			const row = rowOf.get(id);
			if (row && row.expanded !== group.expanded) native(() => row.setExpanded(group.expanded));
		}
	}

	/** Asks the owners what they hold: everything, or only the calls named. */
	function requestSnapshot(toolCallIds?: string[]): void {
		if (!sessionId) return;
		try {
			pi.events?.emit(SHELL_DISPLAY_CHANNEL, { kind: "snapshot-request", sessionId, ...(toolCallIds ? { toolCallIds } : {}) });
		} catch {}
	}

	/** Every member of one source loses its owner: what was still going is unknown from here. */
	function loseSource(source: ShellSource): void {
		for (const [id, member] of view.members) {
			if (member.source !== source) continue;
			const held = view.evidence.get(id) ?? { executionEvidence: member.executionEvidence, executionStarted: member.executionStarted };
			const next = reduceEvidence(held, { kind: "lost" });
			if (next !== held) setEvidence(id, next);
		}
	}

	function onMessage(data: unknown): void {
		const message = data as { kind?: unknown; sessionId?: unknown; source?: unknown; ownerGeneration?: unknown } | undefined;
		if (!message || typeof message !== "object" || message.sessionId !== sessionId) return;
		if (message.source !== "pi-bash" && message.source !== "codex-command") return;
		if (typeof message.ownerGeneration !== "string") return;
		const source = message.source;
		switch (message.kind) {
			case "announce": {
				const known = announcements.get(source);
				const next = message as Announcement;
				// An owner repeats its announcement with every snapshot it answers; the same one again changes nothing.
				if (known && known.ownerGeneration === next.ownerGeneration && known.execute === next.execute && known.renderCall === next.renderCall && known.renderResult === next.renderResult) break;
				if (known && known.ownerGeneration !== next.ownerGeneration) loseSource(source);
				announcements.set(source, next);
				view.owners.set(source, next.ownerGeneration);
				requestRender();
				break;
			}
			case "withdraw":
				if (announcements.get(source)?.ownerGeneration !== message.ownerGeneration) return;
				loseSource(source);
				announcements.delete(source);
				view.owners.delete(source);
				requestRender();
				break;
			case "fact": {
				const told = message as Partial<FactMessage>;
				if (typeof told.toolCallId !== "string" || typeof told.revision !== "number" || !isOwnerFact(told.fact)) return;
				if (applyEvidence(view, told as FactMessage)) requestRender();
				break;
			}
		}
	}

	// ── drawing ──

	type Entry = { child: any; announced?: Announcement; lines?: string[] };

	/** Regroups from what the container holds now, then brings the members up to date with their rows and their owners. */
	function reconcile(entries: Entry[]): void {
		const rows: TranscriptRow[] = entries.map((entry) =>
			entry.announced
				? { kind: "shell", member: candidateFor(entry.child, entry.announced) }
				: { kind: "content", visible: entry.lines!.length > 0 },
		);
		reconcileMembership(view, rows, host.toolOutputExpanded === true);
		const known = rowOf;
		rowOf = new Map();
		idOf = new Map();
		idOfCall = new Map();
		const added: string[] = [];
		for (const entry of entries) {
			if (!entry.announced) continue;
			const candidate = candidateFor(entry.child, entry.announced);
			const id = memberId(candidate);
			const member = view.members.get(id)!;
			if (!known.has(id)) {
				added.push(member.toolCallId);
				// A row that left and came back starts over: its facts are asked for again below.
				if (!view.evidence.has(id)) Object.assign(member, NO_EVIDENCE, { ownerGeneration: undefined, revision: undefined });
			}
			member.nativeRow = entry.child;
			Object.assign(member, rowFacts(entry.child));
			rowOf.set(id, entry.child);
			idOf.set(entry.child, id);
			idOfCall.set(member.toolCallId, id);
		}
		// A fact that arrived before its row was drawn went nowhere; the owners still hold it. Only the rows that joined are asked about.
		if (added.length > 0) requestSnapshot(added);
		for (const id of rowOf.keys()) settle(id);
		for (const group of view.groups) syncExpansion(group);
	}

	let armedTargetSeen = false;

	function drawGroup(group: ShellGroup, start: number, width: number, out: string[], segments: Segment[]): void {
		const members = group.memberIds.map((id) => view.members.get(id)!);
		const wrapped = (fields: readonly Field[], column: number) => wrapFields(fields, width - 1, column, visibleWidth).map(paint);
		// The blank row above the header is the group's; every member's own leading blank row is the member's.
		out.push("");
		segments.push({ component: NO_ACTION, height: 1 });
		const header = wrapped(formatHeader(members, group.expanded), HEADER_COLUMN);
		out.push(...header);
		const headerStart = start + 1;
		if (armed?.kind === "header" && armed.first === group.memberIds[0]) {
			if (armed.width === width && armed.start === headerStart) armedTargetSeen = true;
		}
		segments.push({ component: { handleMouse: (event) => headerMouse(group, headerStart, event) }, height: header.length });
		const identity = identityLines(members).flatMap((fields) => wrapped(fields, BODY_COLUMN));
		if (identity.length > 0) {
			out.push(...identity);
			segments.push({ component: NO_ACTION, height: identity.length });
		}
		if (!group.expanded) return;
		const notes = memberLines(members);
		members.forEach((member, i) => {
			const row = member.nativeRow as any;
			// The row's own render, so every wrapper on its prototype runs, pi-45's indent included.
			const lines: string[] = native(() => row.render(width));
			out.push(...lines);
			const memberStart = out.length - lines.length;
			const memberHeight = lines.length;
			if (armed?.kind === "member" && armed.memberId === memberId(member)) {
				if (armed.width === width && armed.start === memberStart && armed.height === memberHeight) armedTargetSeen = true;
			}
			segments.push({
				component: { handleMouse: (event) => memberMouse(group, member, memberStart, memberHeight, event) },
				height: lines.length,
			});
			const own = notes[i]!.flatMap((note) => wrapped([[{ text: note, role: "muted" }]], BODY_COLUMN));
			if (own.length > 0) {
				out.push(...own);
				segments.push({ component: NO_ACTION, height: own.length });
			}
		});
	}

	/** One frame: each child in the order Pi holds it, a group standing where its first member is. Nothing in the container changes. */
	function project(width: number): string[] {
		armedTargetSeen = false;
		const entries: Entry[] = [];
		const seen: unknown[] = [];
		const ids = new Set<string>();
		for (const child of container.children) {
			let announced = announcementFor(child);
			if (announced) {
				// One call id drawn by two rows: the second stays Pi's own row, so no command is ever hidden.
				const id = memberId(candidateFor(child, announced));
				if (ids.has(id)) announced = undefined;
				else ids.add(id);
			}
			if (announced) {
				entries.push({ child, announced });
				seen.push(child, announced.ownerGeneration);
			} else {
				const lines: string[] = native(() => child.render(width));
				entries.push({ child, lines });
				seen.push(child, lines.length > 0);
			}
		}
		// Membership is read again only when a row came, went, or changed what it is. An output chunk changes none of that.
		if (seen.length !== signature.length || seen.some((token, i) => token !== signature[i])) {
			reconcile(entries);
			signature = seen;
		}
		const out: string[] = [];
		const segments: Segment[] = [];
		for (const entry of entries) {
			if (!entry.announced) {
				out.push(...entry.lines!);
				segments.push({ component: entry.child, height: entry.lines!.length });
				continue;
			}
			const id = idOf.get(entry.child);
			const group = id === undefined ? undefined : view.groupOf.get(id);
			if (group && group.memberIds[0] === id) drawGroup(group, out.length, width, out, segments);
		}
		if (armed && !armedTargetSeen) armed = undefined;
		layout = { width, segments };
		return out;
	}

	function render(self: any, original: Method, width: number): string[] {
		try {
			return project(width);
		} catch (error) {
			if (error instanceof NativeFault) throw error.error;
			fail("render", error);
			return original.call(self, width);
		}
	}

	// ── the mouse ──

	/** The header's lines toggle group disclosure. The click must follow a plain left press on the same header, still where it was. */
	function headerMouse(group: ShellGroup, start: number, event: any): { handled: true } | undefined {
		try {
			const plain = !event.shift && !event.alt && !event.ctrl;
			if (event.type === "press") {
				armed =
					event.button === "left" && plain
						? {
								kind: "header",
								first: group.memberIds[0]!,
								start,
								width: layout!.width,
								reconciliations: view.reconciliations,
								disclosureGeneration,
								sessionId,
						  }
						: undefined;
				return undefined;
			}
			if (event.type !== "click") {
				if (event.type === "drag" || event.type === "wheel") armed = undefined;
				return undefined;
			}
			const press = armed;
			armed = undefined;
			// Pi reports the synthesized click's button as `left` or `none`, by terminal.
			if (!press || press.kind !== "header" || !plain || (event.button !== "left" && event.button !== "none")) return undefined;
			if (
				press.first !== group.memberIds[0] ||
				press.start !== start ||
				press.width !== layout!.width ||
				press.reconciliations !== view.reconciliations ||
				press.disclosureGeneration !== disclosureGeneration ||
				press.sessionId !== sessionId
			)
				return undefined;
			group.expanded = !group.expanded;
			disclosureGeneration++;
			syncExpansion(group);
			requestRender();
			return { handled: true };
		} catch (error) {
			if (error instanceof NativeFault) throw error.error;
			// The click was aimed at a frame that can't be trusted any more: drop it, don't replay it against native rows.
			fail("mouse", error);
			return { handled: true };
		}
	}

	/** In fullscreen, clicking an expanded command or its output immediately collapses the whole group to its count header. */
	function memberMouse(group: ShellGroup, member: ShellMember, start: number, height: number, event: any): any {
		const row = member.nativeRow as any;
		try {
			const plain = !event.shift && !event.alt && !event.ctrl;
			if (event.type === "press") {
				if (event.button === "left" && plain) {
					armed = {
						kind: "member",
						first: group.memberIds[0]!,
						memberId: memberId(member),
						row,
						start,
						height,
						width: layout!.width,
						reconciliations: view.reconciliations,
						disclosureGeneration,
						sessionId,
					};
				} else {
					armed = undefined;
				}
				return native(() => row.handleMouse?.(event));
			}
			if (event.type === "drag" || event.type === "wheel") {
				armed = undefined;
				return native(() => row.handleMouse?.(event));
			}
			if (event.type === "click") {
				const press = armed;
				armed = undefined;
				const isLeftOrNone = event.button === "left" || event.button === "none";
				if (press && press.kind === "member" && isLeftOrNone && plain) {
					const valid =
						press.first === group.memberIds[0] &&
						press.memberId === memberId(member) &&
						press.row === row &&
						press.start === start &&
						press.height === height &&
						press.width === layout!.width &&
						press.reconciliations === view.reconciliations &&
						press.disclosureGeneration === disclosureGeneration &&
						press.sessionId === sessionId &&
						group.expanded;
					if (valid) {
						group.expanded = false;
						disclosureGeneration++;
						syncExpansion(group);
						requestRender();
						return { handled: true };
					}
				}
				// Modified left/none clicks or clicks without a valid member press must not fold the individual native row
				if (isLeftOrNone) return undefined;
				return native(() => row.handleMouse?.(event));
			}
			return native(() => row.handleMouse?.(event));
		} catch (error) {
			if (error instanceof NativeFault) throw error.error;
			fail("mouse", error);
			return { handled: true };
		}
	}

	function mouse(self: any, original: Method, event: any): any {
		const drawn = layout;
		// Nothing of ours is on screen yet: the event belongs to Pi's own geometry.
		if (!drawn) {
			if (event?.type === "press" || event?.type === "drag" || event?.type === "wheel") armed = undefined;
			return original.call(self, event);
		}
		// Drawn at another width: the rows under the pointer are not the rows this layout knows.
		if (drawn.width !== event?.width) {
			armed = undefined;
			return undefined;
		}
		// Any competing press, drag, or wheel on any row (outside row, inert row, or group row) clears any prior armed gesture before routing
		if (event?.type === "press" || event?.type === "drag" || event?.type === "wheel") armed = undefined;
		// Pi's own routing, over the lines the view drew instead of the lines the container would have drawn.
		return original.call({ mouseLayout: { width: drawn.width, children: drawn.segments } }, event);
	}

	// ── what the wrappers reach ──

	function afterEvent(event: any): void {
		if (!host || !event) return;
		if (typeof event.toolCallId === "string") refresh(idOfCall.get(event.toolCallId));
		// A message that ends in an error or an abort closes its calls there, without an event of their own.
		else if (event.type === "message_end" || event.type === "agent_end" || event.type === "agent_start") {
			for (const [id, member] of view.members) if (member.callOpen) refresh(id);
		}
	}

	/** Marks the rows a replay built, and lets a rebuilt transcript take its disclosure from the global setting again. */
	function afterReplay(before: Set<unknown>, open: Set<string>): void {
		if (!container) return;
		const now = new Set<unknown>(container.children);
		for (const child of now) {
			if (before.has(child) || !(child instanceof ToolExecutionComponent)) continue;
			// A row of history is over. A row Pi rebuilt for a call that was open a moment ago is that call, still open.
			if (!open.has((child as any).toolCallId)) restored.add(child);
		}
		let kept = false;
		for (const row of rowOf.values()) kept ||= now.has(row);
		if (!kept) {
			view.groups = [];
			view.groupOf = new Map();
			signature = [];
		}
	}

	function mirrorExpansion(expanded: boolean): void {
		disclosureGeneration++;
		for (const group of view.groups) {
			group.expanded = expanded;
			syncExpansion(group);
		}
		// Pi returns early when its flag already matches, and then nothing redraws.
		requestRender();
	}

	const api = {
		/** Every wrapper lands here with the method it replaced. Pi's method runs exactly once, and its result or error is the caller's. */
		call(name: string, self: any, original: Method, args: any[]): any {
			if (inert || stopped) return original.apply(self, args);
			switch (name) {
				case "render":
					return self === container ? render(self, original, args[0]) : original.apply(self, args);
				case "handleMouse":
					return self === container ? mouse(self, original, args[0]) : original.apply(self, args);
				case "setToolsExpanded": {
					const result = original.apply(self, args);
					guard("setToolsExpanded", () => {
						capture(self);
						if (self === host) mirrorExpansion(args[0] === true);
					});
					return result;
				}
				case "renderSessionItems": {
					guard("capture", () => capture(self));
					const before = new Set<unknown>(self === host ? container.children : []);
					// Calls still open before the rebuild stay open after it: Pi puts their new rows back among its pending tools.
					const open = new Set<string>();
					if (self === host) guard("renderSessionItems", () => {
						for (const [id, row] of host.pendingTools) if (!restored.has(row)) open.add(id);
					});
					const result = original.apply(self, args);
					if (self === host) guard("renderSessionItems", () => afterReplay(before, open));
					return result;
				}
				case "handleEvent": {
					guard("capture", () => capture(self));
					const result = original.apply(self, args);
					const after = () => {
						if (self === host) guard("handleEvent", () => afterEvent(args[0]));
					};
					if (result && typeof result.then === "function") {
						return result.then((value: unknown) => {
							after();
							return value;
						});
					}
					after();
					return result;
				}
				default:
					guard("capture", () => capture(self));
					return original.apply(self, args);
			}
		},
		/** A session began: keep its context, listen, and ask the owners what they already know. */
		start(context: ExtensionContext): void {
			if (stopped) return;
			ctx = context;
			if (warningHeld) {
				warningHeld = false;
				warn();
			}
			guard("session_start", () => {
				let id: string | undefined;
				try {
					id = context.sessionManager.getSessionId();
				} catch {}
				if (id !== sessionId) {
					sessionId = id;
					announcements.clear();
					view = createShellView();
					signature = [];
				}
				if (typeof pi.events?.on === "function") stopListening ??= pi.events.on(SHELL_DISPLAY_CHANNEL, (data) => guard("message", () => onMessage(data)));
				requestSnapshot();
			});
		},
		/** The extension is going away: no wrapper of ours stays on top, and nothing of the session is kept. */
		stop(): void {
			if (stopped) return;
			stopped = true;
			inert = true;
			const ui = host?.ui;
			detach();
			try {
				ui?.requestRender?.();
			} catch {}
		},
		/** For the scale check: the state the counts are read from. */
		get state(): ShellView {
			return view;
		},
		/** Why this view let go and draws nothing, when a fault made it. Undefined while it works, and after an ordinary stop. */
		get fault(): { where: string; error: unknown } | undefined {
			return fault;
		},
	};

	// Attach: the newest view is the live one. A host without the four methods is one this view can't follow.
	(globalThis as any)[VIEW_KEY] = api;
	const prototype = (InteractiveMode as any)?.prototype;
	if (!prototype || !HOST_METHODS.every((name) => installWrapper(prototype, name))) fail("attach", new Error("InteractiveMode does not have the four methods the view wraps"));
	return api;
}

export default function rbfShellCommandGroups(pi: ExtensionAPI, options: { /** Frozen argv for the `--sandbox` guard; defaults to `process.argv.slice(2)`. */ argv?: string[] } = {}): void {
	// Frozen at entry: a sandbox launch attaches nothing and subscribes to nothing, now or on re-entry.
	if (isSandboxLaunch([...(options.argv ?? process.argv.slice(2))])) return;
	const view = createShellGroupsView(pi);
	pi.on("session_start", (_event, ctx) => view.start(ctx));
	pi.on("session_shutdown", () => view.stop());
}
