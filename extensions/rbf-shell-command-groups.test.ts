import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRbfCodex, BOOTSTRAP_MODEL, RowError, COPY } from "./rbf-codex.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The component cases run on the repository's Pi by default. With PI_HOST_PACKAGE set to another installed
// `@earendil-works/pi-coding-agent` directory, every import of Pi and of its `pi-tui` beside it, in this file and
// in the extensions it loads, is that host's instead.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) =>
	process.env.PI_HOST_PACKAGE ? import(/* @vite-ignore */ `${process.env.PI_HOST_PACKAGE}/dist/index.js`) : importOriginal(),
);
vi.mock("@earendil-works/pi-tui", async (importOriginal) =>
	process.env.PI_HOST_PACKAGE ? import(/* @vite-ignore */ `${process.env.PI_HOST_PACKAGE}/../pi-tui/dist/index.js`) : importOriginal(),
);

import { createBashToolDefinition, createEventBus, initTheme, InteractiveMode, ToolExecutionComponent, VERSION } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, getOsc8LinkAtColumn, hyperlink, stripTerminalSequences, TuiAltScreen } from "@earendil-works/pi-tui";
import rbfShellCommandGroups, {
	CONTAINER_METHODS,
	createShellGroupsView,
	HOST_METHODS,
	isOwnerFact,
	isSandboxLaunch,
	SHELL_DISPLAY_CHANNEL,
	UNAVAILABLE_WARNING,
	VIEW_KEY,
	wrappedKey,
} from "./rbf-shell-command-groups.ts";
import { createShellDisplayOwner, rbfBackgroundTasks, setActiveTaskManager, unpatchBashExecutionComponent, unpatchFooterComponent } from "./rbf-background-tasks.ts";
import type { ShellDisplayFact } from "./rbf-background-tasks.ts";
import { applyToolPartsIndent, restoreToolPartsIndent } from "./rbf-tool-parts-indent.ts";
import { applyToolExecutionBlended, restoreToolExecutionBlended } from "./rbf-tool-execution-blended.ts";
import rbfShellDisplayProbe from "./test-support/rbf-shell-display-probe.ts";
import {
	applyEvidence,
	BODY_COLUMN,
	createShellView,
	formatHeader,
	groupRows,
	HEADER_COLUMN,
	identityLines,
	memberId,
	memberLines,
	NO_EVIDENCE,
	reconcileMembership,
	reduceEvidence,
	reduceMcpEvidence,
	replayEvidence,
	updateMember,
	wrapFields,
} from "./rbf-shell-command-groups.ts";
import type {
	EvidenceState,
	FactMessage,
	Field,
	OwnerEvidence,
	OwnerFact,
	ShellGroup,
	ShellMember,
	ShellView,
	TranscriptRow,
	WrappedLine,
} from "./rbf-shell-command-groups.ts";

let calls = 0;

/** A member in `state`. Execution start is confirmed for a member that ran, is running or is in the background, unless `over` says otherwise. */
function member(state: EvidenceState, over: Partial<ShellMember> = {}): ShellMember {
	const started = ["succeeded", "failed", "cancelled", "running", "background"].includes(state);
	return {
		sessionId: "s1",
		toolCallId: `call-${++calls}`,
		source: "pi-bash",
		cwd: "/work",
		nativeRow: undefined,
		executionEvidence: state === "background" ? { state, identity: "task-123" } : { state },
		executionStarted: started,
		rowError: false,
		callOpen: false,
		hasResult: true,
		...over,
	};
}

/** A member whose only evidence is Pi's own error row. */
const errorMember = (over: Partial<ShellMember> = {}) => member("unknown", { rowError: true, ...over });

/** A member carrying what the evidence reducer folded `facts` into. */
function reduced(facts: OwnerFact[], over: Partial<ShellMember> = {}): ShellMember {
	return member("waiting", { ...fold(...facts), ...over });
}

function fold(...facts: OwnerFact[]): OwnerEvidence {
	return facts.reduce(reduceEvidence, NO_EVIDENCE);
}

/** Wrapped lines as the pane shows them, without color. */
function plain(lines: WrappedLine[]): string[] {
	return lines.map((line) => " ".repeat(line.column) + line.spans.map((span) => span.text).join(""));
}

/** The header on one line, as Content design writes it: from the mark on. */
function header(members: ShellMember[], expanded = false): string | undefined {
	const lines = wrapFields(formatHeader(members, expanded), 1000);
	if (lines.length === 0) return undefined;
	expect(lines).toHaveLength(1);
	expect(lines[0]!.column).toBe(1);
	return lines[0]!.spans.map((span) => span.text).join("");
}

const shell = (m: ShellMember): TranscriptRow => ({ kind: "shell", member: m });
/** A row that is not a grouped shell call: one that draws lines, and one that draws none. */
const drawn = (): TranscriptRow => ({ kind: "content", visible: true });
const silent = (): TranscriptRow => ({ kind: "content", visible: false });
const ids = (groups: ShellGroup[]): string[][] => groups.map((group) => group.memberIds);

const START: OwnerFact = { kind: "start" };
const CANCEL: OwnerFact = { kind: "stop-request", reason: "cancel" };
const TIMEOUT: OwnerFact = { kind: "stop-request", reason: "timeout" };
const KILLED: OwnerFact = { kind: "close", code: null, signal: "SIGTERM" };
const exit = (code: number | null): OwnerFact => ({ kind: "close", code });
const completion = (exitCode?: unknown, status?: unknown): OwnerFact => ({ kind: "completion", exitCode, status });

const GENERATION = "pi-bash:gen-1";
let revisions = 0;

/** A view over `rows` whose live Pi owner is `GENERATION`. */
function viewOf(rows: TranscriptRow[], globalExpanded = false): ShellView {
	const view = createShellView();
	view.owners.set("pi-bash", GENERATION);
	reconcileMembership(view, rows, globalExpanded);
	return view;
}

/** One fact about `m` as its live owner publishes it, at the next revision unless `over` names one. */
function tell(view: ShellView, m: ShellMember, fact: OwnerFact, over: Partial<FactMessage> = {}): boolean {
	return applyEvidence(view, {
		kind: "fact",
		sessionId: m.sessionId,
		source: m.source,
		ownerGeneration: GENERATION,
		toolCallId: m.toolCallId,
		revision: ++revisions,
		fact,
		...over,
	});
}

const headersOf = (view: ShellView) => view.groups.map((group) => header(group.memberIds.map((id) => view.members.get(id)!)));

describe("extensions/rbf-shell-command-groups", () => {
	describe("counts and states", () => {
		describe("Uniform group headers", () => {
			const ok = () => member("succeeded");
			const cases: [string, () => ShellMember[]][] = [
				["▸ waiting for 1 shell command", () => [member("waiting")]],
				["▸ waiting for 3 shell commands", () => [member("waiting"), member("waiting"), member("waiting")]],
				["▸ running 1 shell command", () => [member("running")]],
				["▸ running 3 shell commands", () => [member("running"), member("running"), member("running")]],
				["▸ ran 1 shell command", () => [ok()]],
				["▸ ran 3 shell commands", () => [ok(), ok(), ok()]],
				["▸ ran 3 shell commands · 1 failed", () => [ok(), member("failed"), ok()]],
				["▸ ran 3 shell commands · 3 failed", () => [member("failed"), member("failed"), member("failed")]],
				["▸ ran 1 shell command · 1 failed", () => [member("failed")]],
				["▸ 1 shell command · background", () => [member("background")]],
				["▸ 3 shell commands · 3 background", () => [member("background"), member("background"), member("background")]],
				["▸ ran 1 shell command · cancelled", () => [member("cancelled")]],
				["▸ 1 shell command · cancelled", () => [member("cancelled", { executionStarted: false })]],
				["▸ ran 3 shell commands · 3 cancelled", () => [member("cancelled"), member("cancelled"), member("cancelled")]],
				[
					"▸ 3 shell commands · 3 cancelled",
					() => [member("cancelled"), member("cancelled", { executionStarted: false }), member("cancelled")],
				],
				["▸ 1 shell command · not run", () => [member("notRun")]],
				["▸ 3 shell commands · 3 not run", () => [member("notRun"), member("notRun"), member("notRun")]],
				["▸ 1 shell command · status unknown", () => [member("unknown")]],
				["▸ 3 shell commands · status unknown", () => [member("unknown"), member("unknown"), member("unknown")]],
				["▸ 1 shell command · error · status unknown", () => [errorMember()]],
				["▸ 3 shell commands · 3 errors (status unknown)", () => [errorMember(), errorMember(), errorMember()]],
			];
			it.each(cases)("%s", (copy, build) => {
				expect(header(build())).toBe(copy);
			});

			it("no members draw no header, not ran 0 shell commands", () => {
				expect(formatHeader([], false)).toEqual([]);
				expect(wrapFields(formatHeader([], false), 80)).toEqual([]);
			});

			it("an expanded group swaps the mark and keeps the count and status", () => {
				expect(header([ok(), ok()], true)).toBe("▾ ran 2 shell commands");
				expect(header([member("unknown"), member("unknown")], true)).toBe("▾ 2 shell commands · status unknown");
				expect(header([member("running")], true)).toBe("▾ running 1 shell command");
			});

			it("a group that all ran but never proved one member's start is not ran", () => {
				expect(header([ok(), member("succeeded", { executionStarted: false })])).toBe("▸ 2 shell commands");
				expect(header([member("failed", { executionStarted: false })])).toBe("▸ 1 shell command · 1 failed");
			});

			it("Pi's own error row on a member with a proved state counts under that state, not as an error", () => {
				expect(header([member("failed", { rowError: true }), ok()])).toBe("▸ ran 2 shell commands · 1 failed");
				expect(header([member("cancelled", { rowError: true })])).toBe("▸ ran 1 shell command · cancelled");
				expect(header([member("notRun", { rowError: true })])).toBe("▸ 1 shell command · not run");
				expect(header([member("running", { rowError: true })])).toBe("▸ running 1 shell command");
			});
		});

		describe("Mixed group headers", () => {
			const ok = () => member("succeeded");
			const cases: [string, () => ShellMember[]][] = [
				["▸ 3 shell commands · 1 running", () => [ok(), ok(), member("running")]],
				["▸ 3 shell commands · 1 background · 1 failed", () => [member("failed"), ok(), member("background")]],
				["▸ 3 shell commands · 1 failed · 1 waiting", () => [ok(), member("waiting"), member("failed")]],
				["▸ 3 shell commands · 1 cancelled · 1 unknown", () => [member("unknown"), ok(), member("cancelled")]],
				["▸ 3 shell commands · 1 error (status unknown)", () => [ok(), errorMember(), ok()]],
				["▸ 2 shell commands · 1 background", () => [ok(), member("background")]],
				["▸ 3 shell commands · 1 cancelled · 1 not run", () => [ok(), member("notRun"), member("cancelled")]],
				["▸ 3 shell commands · 1 error (status unknown) · 2 unknown", () => [member("unknown"), errorMember(), member("unknown")]],
				["▸ 3 shell commands · 2 errors (status unknown)", () => [errorMember(), ok(), errorMember()]],
				["▸ 3 shell commands · 2 running · 1 waiting", () => [member("running"), member("waiting"), member("running")]],
				["▸ 2 shell commands · 1 not run", () => [ok(), member("notRun")]],
				["▸ 2 shell commands · 1 unknown", () => [ok(), member("unknown")]],
			];
			it.each(cases)("%s", (copy, build) => {
				expect(header(build())).toBe(copy);
			});

			it("every field shows in the fixed order whatever order the members are in", () => {
				const members = [
					member("unknown"),
					member("waiting"),
					member("notRun"),
					member("cancelled"),
					errorMember(),
					member("failed"),
					member("background"),
					member("running"),
					member("succeeded"),
					member("succeeded"),
					member("background", { executionEvidence: { state: "background", identity: "task-124" } }),
					member("unknown"),
				];
				expect(header(members)).toBe(
					"▸ 12 shell commands · 1 running · 2 background · 1 failed · 1 error (status unknown) · 1 cancelled · 1 not run · 1 waiting · 2 unknown",
				);
			});

			it("one running member of three never reads running 3", () => {
				const copy = header([member("succeeded"), member("running"), member("succeeded")]);
				expect(copy).toBe("▸ 3 shell commands · 1 running");
				expect(copy).not.toContain("running 3");
			});
		});

		describe("Color roles", () => {
			const roles = (fields: Field[]) => fields.map((field) => field.map((span) => [span.text, span.role]));

			it("the mark, the count and ran take tool-title", () => {
				expect(roles(formatHeader([member("succeeded"), member("succeeded")], false))).toEqual([[["▸ ran 2 shell commands", "toolTitle"]]]);
			});

			it("running and waiting for are muted between a tool-title mark and count", () => {
				expect(roles(formatHeader([member("running")], false))).toEqual([
					[
						["▸ ", "toolTitle"],
						["running", "muted"],
						[" 1 shell command", "toolTitle"],
					],
				]);
				expect(roles(formatHeader([member("waiting"), member("waiting")], true))).toEqual([
					[
						["▾ ", "toolTitle"],
						["waiting for", "muted"],
						[" 2 shell commands", "toolTitle"],
					],
				]);
			});

			it("a suffix field takes one role across its digits and brackets", () => {
				const fields = formatHeader(
					[
						member("running"),
						member("background"),
						member("failed"),
						errorMember(),
						member("cancelled"),
						member("notRun"),
						member("waiting"),
						member("unknown"),
						member("unknown"),
					],
					false,
				);
				expect(roles(fields).slice(1)).toEqual([
					[["1 running", "muted"]],
					[["1 background", "muted"]],
					[["1 failed", "error"]],
					[["1 error (status unknown)", "error"]],
					[["1 cancelled", "muted"]],
					[["1 not run", "muted"]],
					[["1 waiting", "muted"]],
					[["2 unknown", "muted"]],
				]);
			});

			it("unknown status is muted and a lone error is an error field then a muted one", () => {
				expect(roles(formatHeader([member("unknown")], false)).slice(1)).toEqual([[["status unknown", "muted"]]]);
				expect(roles(formatHeader([errorMember()], false)).slice(1)).toEqual([[["error", "error"]], [["status unknown", "muted"]]]);
				expect(roles(formatHeader([member("background")], false)).slice(1)).toEqual([[["background", "muted"]]]);
			});

			it("the separator is dim and sits between fields only", () => {
				const [line] = wrapFields(formatHeader([member("succeeded"), member("failed")], false), 80);
				expect(line!.spans.map((span) => [span.text, span.role])).toEqual([
					["▸ ran 2 shell commands", "toolTitle"],
					[" · ", "dim"],
					["1 failed", "error"],
				]);
			});
		});

		describe("Wrapping", () => {
			const allFields = () => [
				member("running"),
				member("background"),
				member("background", { executionEvidence: { state: "background", identity: "task-124" } }),
				member("failed"),
				errorMember(),
				member("cancelled"),
				member("notRun"),
				member("waiting"),
				member("unknown"),
				member("unknown"),
				member("succeeded"),
				member("succeeded"),
			];

			it("a routine group is one line at column 1 at 40, 80 and 120 columns", () => {
				const fields = formatHeader([member("succeeded"), member("succeeded"), member("succeeded")], false);
				for (const width of [40, 80, 120]) {
					expect(plain(wrapFields(fields, width))).toEqual([" ▸ ran 3 shell commands"]);
				}
				expect(HEADER_COLUMN).toBe(1);
			});

			it("a mixed group at 40 columns breaks between fields, continues at column 4 and drops the separator at the break", () => {
				const members = [
					member("running"),
					member("background"),
					member("failed"),
					member("succeeded"),
					member("succeeded"),
					member("succeeded"),
				];
				const lines = wrapFields(formatHeader(members, false), 40);
				expect(plain(lines)).toEqual([" ▸ 6 shell commands · 1 running", "    1 background · 1 failed"]);
				expect(lines[1]!.column).toBe(4);
				expect(BODY_COLUMN).toBe(4);
			});

			it("every field at 120 columns takes two lines", () => {
				expect(plain(wrapFields(formatHeader(allFields(), false), 120))).toEqual([
					" ▸ 12 shell commands · 1 running · 2 background · 1 failed · 1 error (status unknown) · 1 cancelled · 1 not run",
					"    1 waiting · 2 unknown",
				]);
			});

			it("every field at 40 columns takes five lines", () => {
				expect(plain(wrapFields(formatHeader(allFields(), false), 40))).toEqual([
					" ▸ 12 shell commands · 1 running",
					"    2 background · 1 failed",
					"    1 error (status unknown)",
					"    1 cancelled · 1 not run · 1 waiting",
					"    2 unknown",
				]);
			});

			it("a line that fits the pane exactly is not broken", () => {
				const fields = formatHeader([member("succeeded"), member("succeeded"), member("running")], false);
				expect(plain(wrapFields(fields, 31))).toEqual([" ▸ 3 shell commands · 1 running"]);
				expect(plain(wrapFields(fields, 30))).toEqual([" ▸ 3 shell commands", "    1 running"]);
			});

			it("a field wider than the pane breaks at a space and loses nothing", () => {
				const fields = formatHeader([member("succeeded"), errorMember()], false);
				expect(plain(wrapFields(fields, 20))).toEqual([" ▸ 2 shell commands", "    1 error (status", "    unknown)"]);
			});

			it("the cell counter can be swapped, so a wide character takes the room it draws in", () => {
				const wide = (text: string) => [...text].reduce((sum, ch) => sum + (ch === "界" ? 2 : 1), 0);
				const fields: Field[] = [[{ text: "Task ID: 界界界界", role: "dim" }], [{ text: "still running", role: "dim" }]];
				expect(plain(wrapFields(fields, 34, BODY_COLUMN))).toEqual(["    Task ID: 界界界界 · still running"]);
				expect(plain(wrapFields(fields, 34, BODY_COLUMN, wide))).toEqual(["    Task ID: 界界界界", "    still running"]);
				expect(plain(wrapFields([[{ text: "界界界界界", role: "dim" }]], 10, BODY_COLUMN, wide))).toEqual(["    界界界", "    界界"]);
			});

			it("no line is wider than the pane and no character is lost at every width from 12 to 130", () => {
				const fields = formatHeader(allFields(), false);
				const whole = fields.map((field) => field.map((span) => span.text).join("")).join("");
				for (let width = 12; width <= 130; width++) {
					const lines = wrapFields(fields, width);
					for (const line of plain(lines)) {
						expect([...line].length, `width ${width}: ${line}`).toBeLessThanOrEqual(width);
					}
					const drawn = lines
						.flatMap((line) => line.spans)
						.filter((span) => span.text !== " · ")
						.map((span) => span.text)
						.join("");
					expect(drawn.replaceAll(" ", ""), `width ${width}`).toBe(whole.replaceAll(" ", ""));
					for (const line of lines.slice(1)) expect(line.column).toBe(4);
				}
			});
		});

		describe("Counting invocations", () => {
			const ran = () => member("succeeded");
			const headerOf = (rows: TranscriptRow[]) => {
				const view = createShellView();
				reconcileMembership(view, rows, false);
				return view.groups.map((group) => header(group.memberIds.map((id) => view.members.get(id)!)));
			};

			it("no shell rows make no group", () => {
				expect(groupRows([], [], false)).toEqual([]);
				expect(groupRows([drawn(), drawn()], [], false)).toEqual([]);
			});

			// The rules never see a command's text: a member is a call id. What a heredoc or a pipeline counts as is asked of real rows, under "real commands" below.
			it("one call is one, and three calls are three", () => {
				expect(headerOf([shell(ran())])).toEqual(["▸ ran 1 shell command"]);
				expect(headerOf([shell(ran()), shell(ran()), shell(ran())])).toEqual(["▸ ran 3 shell commands"]);
			});

			it("one running of three reads 3 shell commands · 1 running", () => {
				expect(headerOf([shell(ran()), shell(ran()), shell(member("running"))])).toEqual(["▸ 3 shell commands · 1 running"]);
			});

			it("a row seen twice for one id counts once", () => {
				const a = ran();
				const b = ran();
				const again = { ...a };
				expect(headerOf([shell(a), shell(again), shell(b), shell(a)])).toEqual(["▸ ran 2 shell commands"]);
			});

			it("repeated updates and output chunks for one id keep the count", () => {
				const a = member("running");
				const b = member("running");
				const view = viewOf([shell(a), shell(b)]);
				for (let i = 0; i < 5; i++) updateMember(view, memberId(a));
				tell(view, a, exit(0));
				tell(view, a, exit(0));
				expect(view.groups).toHaveLength(1);
				expect(view.groups[0]!.memberIds).toEqual([memberId(a), memberId(b)]);
				expect(headersOf(view)).toEqual(["▸ 2 shell commands · 1 running"]);
			});

			it("three members restored without terminal evidence read status unknown, not a bare count and not ran", () => {
				const restored = () => member("waiting", replayEvidence("pi-bash", { matched: true, isError: false, details: { exit_code: 0 } }));
				expect(headerOf([shell(restored()), shell(restored()), shell(restored())])).toEqual(["▸ 3 shell commands · status unknown"]);
			});
		});

		describe("Evidence from the owner", () => {
			it("a member no owner has said a thing about is waiting: an open row, a partial result and an accepted approval are not facts", () => {
				expect(NO_EVIDENCE).toEqual({ executionEvidence: { state: "waiting" }, executionStarted: false });
				expect(header([reduced([])])).toBe("▸ waiting for 1 shell command");
			});

			it("a fact of a kind this reducer was not written for changes nothing, whatever the member's state", () => {
				const newer = { kind: "paused", until: 3 } as unknown as OwnerFact;
				for (const facts of [[], [START], [START, exit(0)], [START, { kind: "lost" }], [START, exit(0), exit(7)]] as OwnerFact[][]) {
					const state = fold(...facts);
					expect(reduceEvidence(state, newer)).toBe(state);
				}
			});

			it("a fact is taken only when it is one of the known kinds with the fields its kind needs", () => {
				const known: unknown[] = [START, CANCEL, TIMEOUT, KILLED, exit(0), exit(null), completion(), completion(0, "completed"), { kind: "background", identity: "t" }, { kind: "cut", identity: "i" }, { kind: "child-error" }, { kind: "not-run" }, { kind: "lost" }];
				for (const fact of known) expect(isOwnerFact(fact), JSON.stringify(fact)).toBe(true);
				const not: unknown[] = [undefined, null, "start", 7, [], {}, { kind: "paused" }, { kind: "host", event: "output" }, { kind: "background" }, { kind: "background", identity: "" }, { kind: "cut", identity: 3 }, { kind: "stop-request" }, { kind: "stop-request", reason: "shutdown" }, { kind: "close" }, { kind: "close", code: "0" }];
				for (const fact of not) expect(isOwnerFact(fact), JSON.stringify(fact)).toBe(false);
			});

			it("an owner-confirmed start is running", () => {
				expect(fold(START)).toEqual({ executionEvidence: { state: "running" }, executionStarted: true });
				expect(header([reduced([START])])).toBe("▸ running 1 shell command");
			});

			it("a detach that resolved the tool with exit 0 is background, not ran", () => {
				const facts: OwnerFact[] = [START, { kind: "background", identity: "task-123" }];
				expect(fold(...facts)).toEqual({ executionEvidence: { state: "background", identity: "task-123" }, executionStarted: true });
				expect(header([reduced(facts)])).toBe("▸ 1 shell command · background");
			});

			it("a background member becomes ran on its actual exit", () => {
				expect(header([reduced([START, { kind: "background", identity: "task-123" }, exit(0)])])).toBe("▸ ran 1 shell command");
			});

			it("a stop request before the close keeps the prior activity", () => {
				expect(header([reduced([START, CANCEL])])).toBe("▸ running 1 shell command");
				expect(header([reduced([START, TIMEOUT])])).toBe("▸ running 1 shell command");
				expect(header([reduced([START, { kind: "background", identity: "task-123" }, CANCEL])])).toBe("▸ 1 shell command · background");
				expect(header([reduced([CANCEL])])).toBe("▸ waiting for 1 shell command");
			});

			it("a stop request whose close was never observed is unknown, not cancelled", () => {
				expect(header([reduced([START, CANCEL, { kind: "lost" }])])).toBe("▸ 1 shell command · status unknown");
			});

			it("a proved refusal before the spawn is not run", () => {
				expect(fold({ kind: "not-run" })).toEqual({ executionEvidence: { state: "notRun" }, executionStarted: false });
				expect(header([reduced([{ kind: "not-run" }], { rowError: true })])).toBe("▸ 1 shell command · not run");
			});

			it("a generic child error after the spawn with no close is unknown beside Pi's own error", () => {
				expect(fold(START, { kind: "child-error" })).toEqual({ executionEvidence: { state: "unknown" }, executionStarted: true });
				expect(header([reduced([START, { kind: "child-error" }], { rowError: true })])).toBe("▸ 1 shell command · error · status unknown");
			});

			it("a close after a child error still proves the ending", () => {
				expect(header([reduced([START, { kind: "child-error" }, exit(1)], { rowError: true })])).toBe("▸ ran 1 shell command · 1 failed");
			});

			it("a numeric exit proves the run: 0 succeeded, anything else failed", () => {
				expect(fold(START, exit(0))).toEqual({ executionEvidence: { state: "succeeded" }, executionStarted: true });
				expect(fold(START, exit(7))).toEqual({ executionEvidence: { state: "failed" }, executionStarted: true });
				expect(header([reduced([START, exit(0)])])).toBe("▸ ran 1 shell command");
				expect(header([reduced([START, exit(7)])])).toBe("▸ ran 1 shell command · 1 failed");
			});

			it("a close with no code and no cause is unknown", () => {
				expect(header([reduced([START, exit(null)])])).toBe("▸ 1 shell command · status unknown");
				expect(header([reduced([START, KILLED])])).toBe("▸ 1 shell command · status unknown");
				expect(header([reduced([START, CANCEL, exit(null)])])).toBe("▸ 1 shell command · status unknown");
			});

			it("a requested signal termination after a confirmed start is ran and cancelled", () => {
				expect(fold(START, CANCEL, KILLED)).toEqual({ executionEvidence: { state: "cancelled" }, executionStarted: true });
				expect(header([reduced([START, CANCEL, KILLED])])).toBe("▸ ran 1 shell command · cancelled");
			});

			it("a cancellation with no confirmed start is cancelled without ran", () => {
				expect(fold(CANCEL, KILLED)).toEqual({ executionEvidence: { state: "cancelled" }, executionStarted: false });
				expect(header([reduced([CANCEL, KILLED])])).toBe("▸ 1 shell command · cancelled");
			});

			it("a confirmed timeout termination is failed", () => {
				expect(header([reduced([START, TIMEOUT, { kind: "close", code: null, signal: "SIGKILL" }])])).toBe("▸ ran 1 shell command · 1 failed");
			});

			it("Codex's numeric exit establishes succeeded and failed", () => {
				expect(header([reduced([START, completion(0, "completed")], { source: "codex-command" })])).toBe("▸ ran 1 shell command");
				expect(header([reduced([START, completion(7, "failed")], { source: "codex-command" })])).toBe("▸ ran 1 shell command · 1 failed");
				expect(fold(completion(0))).toEqual({ executionEvidence: { state: "succeeded" }, executionStarted: true });
			});

			it("a nonzero exit is failed even beside the completed status the native row defaults to", () => {
				expect(fold(START, completion(7, "completed"))).toEqual({ executionEvidence: { state: "failed" }, executionStarted: true });
				expect(header([reduced([START, completion(7, "completed")])])).toBe("▸ ran 1 shell command · 1 failed");
				expect(header([reduced([completion(7)])])).toBe("▸ ran 1 shell command · 1 failed");
			});

			it.each([
				["a completed status with a null exit", completion(null, "completed")],
				["a completed status with no exit", completion(undefined, "completed")],
				["no status and no exit", completion()],
				["an exit that is not a number", completion("0", "completed")],
				["exit 0 beside a failed status", completion(0, "failed")],
				["exit 0 beside a declined status", completion(0, "declined")],
				["exit 0 beside a status that says it is still in progress", completion(0, "inProgress")],
				["exit 0 beside a status nobody defined", completion(0, "paused")],
				["exit 7 beside a declined status", completion(7, "declined")],
			])("Codex completion with %s is unknown, never success", (_name, fact) => {
				expect(fold(START, fact).executionEvidence).toEqual({ state: "unknown" });
				expect(header([reduced([START, fact])])).toBe("▸ 1 shell command · status unknown");
			});

			it("Codex's explicit failed status with no exit is failed without ran, and a decline before the start is not run", () => {
				expect(header([reduced([completion(undefined, "failed")])])).toBe("▸ 1 shell command · 1 failed");
				expect(header([reduced([completion(undefined, "declined")])])).toBe("▸ 1 shell command · not run");
			});

			it("a completion that arrives before its start resolves the member and the late start cannot revive it", () => {
				const done = fold(exit(0));
				expect(done).toEqual({ executionEvidence: { state: "succeeded" }, executionStarted: true });
				expect(reduceEvidence(done, START)).toBe(done);
				const cancelled = fold(CANCEL, KILLED);
				expect(reduceEvidence(cancelled, START)).toBe(cancelled);
			});

			it("a duplicate terminal fact, a stale start and late output leave a resolved member as it is", () => {
				const done = fold(START, exit(7));
				const late: OwnerFact[] = [
					exit(7),
					START,
					{ kind: "background", identity: "task-9" },
					CANCEL,
					{ kind: "child-error" },
					{ kind: "lost" },
					exit(null),
				];
				for (const fact of late) expect(reduceEvidence(done, fact)).toBe(done);
				for (const first of late) {
					for (const second of late) expect(reduceEvidence(reduceEvidence(done, first), second)).toBe(done);
				}
			});

			it("a duplicate start does not restart a member that went to the background", () => {
				const background = fold(START, { kind: "background", identity: "task-123" });
				expect(reduceEvidence(background, START)).toBe(background);
				expect(fold(START, START)).toEqual(fold(START));
			});

			it("contradictory terminal facts are unknown and stay unknown", () => {
				const conflicted = fold(START, exit(0), exit(7));
				expect(conflicted.executionEvidence).toEqual({ state: "unknown" });
				expect(reduceEvidence(conflicted, exit(0)).executionEvidence).toEqual({ state: "unknown" });
				expect(header([reduced([START, exit(0), exit(7), exit(0)])])).toBe("▸ 1 shell command · status unknown");
				expect(header([reduced([START, exit(7), exit(0)])])).toBe("▸ 1 shell command · status unknown");
				expect(header([reduced([START, completion(0, "completed"), completion(1, "failed")])])).toBe("▸ 1 shell command · status unknown");
				expect(header([reduced([START, exit(0), { kind: "not-run" }])])).toBe("▸ 1 shell command · status unknown");
				expect(header([reduced([START, { kind: "not-run" }])])).toBe("▸ 1 shell command · status unknown");
			});

			it("a cut Codex command is background while its owner vouches for it, and unknown once the owner is lost", () => {
				const cut: OwnerFact[] = [START, { kind: "cut", identity: "item-9" }];
				const live = reduced(cut, { source: "codex-command" });
				expect(header([live])).toBe("▸ 1 shell command · background");
				const lost = reduced([...cut, { kind: "lost" }], { source: "codex-command" });
				expect(header([lost])).toBe("▸ 1 shell command · status unknown");
				expect(identityLines([lost])).toEqual([]);
				expect(header([reduced([...cut, completion(0, "completed")], { source: "codex-command" })])).toBe("▸ ran 1 shell command");
			});

			it("a Codex command cut before its start was admitted is unknown, never still running", () => {
				const facts: OwnerFact[] = [{ kind: "cut", identity: "item-9" }];
				expect(fold(...facts)).toEqual({ executionEvidence: { state: "unknown" }, executionStarted: false });
				const member9 = reduced(facts, { source: "codex-command", rowError: true });
				expect(header([member9])).toBe("▸ 1 shell command · error · status unknown");
				expect(identityLines([member9])).toEqual([]);
				expect(header([reduced([...facts, completion(undefined, "declined")])])).toBe("▸ 1 shell command · not run");
			});

			it("a cut says nothing new about a command that already ended or was refused", () => {
				const done = fold(START, completion(0, "completed"));
				expect(reduceEvidence(done, { kind: "cut", identity: "item-9" })).toBe(done);
				const refused = fold({ kind: "not-run" });
				expect(reduceEvidence(refused, { kind: "cut", identity: "item-9" })).toBe(refused);
			});

			it("losing the owner turns waiting, running and background members unknown", () => {
				for (const facts of [[], [START], [START, { kind: "background", identity: "task-1" }]] as OwnerFact[][]) {
					expect(fold(...facts, { kind: "lost" }).executionEvidence).toEqual({ state: "unknown" });
				}
			});
		});

		describe("Evidence restored from history", () => {
			const unknown = { executionEvidence: { state: "unknown" }, executionStarted: false };

			it("any retained Pi bash result is unknown, daily's exit_code 0 included", () => {
				expect(replayEvidence("pi-bash", { matched: true, isError: false, details: { exit_code: 0 } })).toEqual(unknown);
				expect(replayEvidence("pi-bash", { matched: true, isError: false, details: { exitCode: 0, status: "completed" } })).toEqual(unknown);
				expect(replayEvidence("pi-bash", { matched: true, isError: true })).toEqual(unknown);
				expect(replayEvidence("pi-bash", undefined)).toEqual(unknown);
			});

			it("a matched Codex record with numeric exit 0 and a completed status ran", () => {
				const evidence = replayEvidence("codex-command", { matched: true, isError: false, details: { exitCode: 0, status: "completed" } });
				expect(evidence).toEqual({ executionEvidence: { state: "succeeded" }, executionStarted: true });
				expect(header([member("waiting", evidence)])).toBe("▸ ran 1 shell command");
			});

			it.each([
				["a completed status alone", { matched: true, isError: false, details: { status: "completed" } }],
				["a null exit", { matched: true, isError: false, details: { exitCode: null, status: "completed" } }],
				["an exit that is not a number", { matched: true, isError: false, details: { exitCode: "0", status: "completed" } }],
				["exit 0 beside a failed status", { matched: true, isError: false, details: { exitCode: 0, status: "failed" } }],
				["exit 0 on an error record", { matched: true, isError: true, details: { exitCode: 0, status: "completed" } }],
				["a nonzero exit", { matched: true, isError: false, details: { exitCode: 7, status: "failed" } }],
				["a record that matches another call", { matched: false, isError: false, details: { exitCode: 0, status: "completed" } }],
				["a declined record", { matched: true, isError: true, details: { exitCode: null, status: "declined" } }],
				["no details", { matched: true, isError: false }],
			])("a Codex record with %s is unknown", (_name, record) => {
				expect(replayEvidence("codex-command", record)).toEqual(unknown);
			});

			it("a Codex call with no recorded result is unknown", () => {
				expect(replayEvidence("codex-command", undefined)).toEqual(unknown);
			});
		});

		describe("Facts reaching the view", () => {
			it("facts for the member's own session, source, owner and call fold into its state", () => {
				const a = member("waiting");
				const view = viewOf([shell(a)]);
				expect(tell(view, a, START)).toBe(true);
				expect(headersOf(view)).toEqual(["▸ running 1 shell command"]);
				expect(tell(view, a, exit(0))).toBe(true);
				expect(headersOf(view)).toEqual(["▸ ran 1 shell command"]);
			});

			it("the view keeps what the reducer must remember between facts", () => {
				const a = member("waiting");
				const view = viewOf([shell(a)]);
				tell(view, a, START);
				tell(view, a, CANCEL);
				expect(headersOf(view)).toEqual(["▸ running 1 shell command"]);
				tell(view, a, KILLED);
				expect(headersOf(view)).toEqual(["▸ ran 1 shell command · cancelled"]);
			});

			it("contradictory terminal facts stay unknown through the view", () => {
				const a = member("waiting");
				const view = viewOf([shell(a)]);
				for (const fact of [START, exit(0), exit(7), exit(0)]) tell(view, a, fact);
				expect(headersOf(view)).toEqual(["▸ 1 shell command · status unknown"]);
			});

			it("a regroup keeps what the reducer remembers", () => {
				const a = member("waiting");
				const view = viewOf([shell(a)]);
				tell(view, a, START);
				tell(view, a, CANCEL);
				reconcileMembership(view, [shell({ ...a }), shell(member("succeeded"))], false);
				tell(view, a, KILLED);
				expect(headersOf(view)).toEqual(["▸ ran 2 shell commands · 1 cancelled"]);
			});

			it("a background fact carries its identity onto the member", () => {
				const a = member("running");
				const view = viewOf([shell(a)]);
				tell(view, a, { kind: "background", identity: "task-77" });
				expect(plain(identityLines([...view.members.values()]).flatMap((fields) => wrapFields(fields, 80, BODY_COLUMN)))).toEqual([
					"    Task ID: task-77",
				]);
			});

			it("a fact that changes nothing touches no group", () => {
				const a = member("running");
				const view = viewOf([shell(a)]);
				expect(tell(view, a, START)).toBe(false);
				expect(tell(view, a, START)).toBe(false);
				expect(view.groups[0]!.updates).toBe(0);
			});

			it("a fact from another session, another source or another call changes nothing", () => {
				const a = member("running");
				const view = viewOf([shell(a)]);
				view.owners.set("codex-command", "codex-command:gen-1");
				expect(tell(view, a, exit(0), { sessionId: "s2" })).toBe(false);
				expect(tell(view, a, exit(0), { source: "codex-command", ownerGeneration: "codex-command:gen-1" })).toBe(false);
				expect(tell(view, a, exit(0), { toolCallId: "call-elsewhere" })).toBe(false);
				expect(headersOf(view)).toEqual(["▸ running 1 shell command"]);
				expect(view.groups[0]!.updates).toBe(0);
			});

			it("a fact from an owner generation that is no longer the live one changes nothing", () => {
				const a = member("running");
				const view = viewOf([shell(a)]);
				expect(tell(view, a, exit(0), { ownerGeneration: "pi-bash:gen-0" })).toBe(false);
				view.owners.delete("pi-bash");
				expect(tell(view, a, exit(0))).toBe(false);
				expect(headersOf(view)).toEqual(["▸ running 1 shell command"]);
			});

			it("a duplicate or older revision changes nothing, so a replayed snapshot cannot fold a fact twice", () => {
				const a = member("waiting");
				const view = viewOf([shell(a)]);
				expect(tell(view, a, START, { revision: 1 })).toBe(true);
				expect(tell(view, a, exit(0), { revision: 2 })).toBe(true);
				expect(tell(view, a, START, { revision: 1 })).toBe(false);
				expect(tell(view, a, exit(7), { revision: 2 })).toBe(false);
				expect(headersOf(view)).toEqual(["▸ ran 1 shell command"]);
				expect(view.groups[0]!.updates).toBe(2);
			});

			it("a fact that changes nothing still advances the revision, so nothing replayed at or below it folds", () => {
				const a = member("running");
				const view = viewOf([shell(a)]);
				expect(tell(view, a, START, { revision: 3 })).toBe(false);
				expect(tell(view, a, exit(0), { revision: 3 })).toBe(false);
				expect(headersOf(view)).toEqual(["▸ running 1 shell command"]);
			});

			it("a new owner generation starts its revisions over", () => {
				const a = member("waiting");
				const view = viewOf([shell(a)]);
				tell(view, a, START, { revision: 9 });
				view.owners.set("pi-bash", "pi-bash:gen-2");
				expect(tell(view, a, exit(0), { revision: 1, ownerGeneration: "pi-bash:gen-2" })).toBe(true);
				expect(headersOf(view)).toEqual(["▸ ran 1 shell command"]);
			});
		});

		describe("Identity lines", () => {
			const lines = (members: ShellMember[], width = 80) => plain(identityLines(members).flatMap((fields) => wrapFields(fields, width, BODY_COLUMN)));

			it("each background member has one line at column 4, in member order", () => {
				const members = [
					member("succeeded"),
					member("background"),
					member("running"),
					member("background", { executionEvidence: { state: "background", identity: "task-124" } }),
				];
				expect(lines(members)).toEqual(["    Task ID: task-123", "    Task ID: task-124"]);
			});

			it("a Codex command still running after an interruption names its item", () => {
				const cut = member("background", { source: "codex-command", executionEvidence: { state: "background", identity: "item-42" } });
				expect(lines([cut])).toEqual(["    Codex command ID: item-42 · still running"]);
			});

			it("a group with no background member has none", () => {
				const members = [member("succeeded"), member("running"), member("waiting"), member("unknown"), member("failed"), errorMember()];
				expect(identityLines(members)).toEqual([]);
			});

			it("identity text is dim", () => {
				const roles = identityLines([member("background", { source: "codex-command" })])
					.flat(2)
					.map((span) => span.role);
				expect(roles).toEqual(["dim", "dim"]);
			});

			it("a wrapped identity continues at column 4 and drops the separator at the break", () => {
				const cut = member("background", { source: "codex-command", executionEvidence: { state: "background", identity: "item-42" } });
				expect(lines([cut], 40)).toEqual(["    Codex command ID: item-42", "    still running"]);
			});

			it("a narrow pane breaks at a space, and inside a long id only when its line has none", () => {
				const long = member("background", { executionEvidence: { state: "background", identity: "task-0123456789abcdef" } });
				expect(lines([long], 20)).toEqual(["    Task ID:", "    task-0123456789a", "    bcdef"]);
				expect(lines([member("background")], 20)).toEqual(["    Task ID:", "    task-123"]);
			});
		});

		describe("Member lines", () => {
			const restored = (over: Partial<ShellMember> = {}) => member("unknown", { callOpen: false, hasResult: true, ...over });

			it("an unknown member beside a known one shows Status unknown", () => {
				expect(memberLines([member("succeeded"), restored()])).toEqual([[], ["Status unknown"]]);
			});

			it.each(["succeeded", "failed", "cancelled", "notRun", "running", "waiting", "background"] as const)(
				"a %s member counts as known for its unknown neighbor",
				(state) => {
					expect(memberLines([restored(), member(state, { callOpen: state === "running" || state === "waiting" })])).toEqual([["Status unknown"], []]);
				},
			);

			it("when no member is known the header already says so and no member shows Status unknown", () => {
				expect(memberLines([restored(), restored()])).toEqual([[], []]);
				expect(memberLines([restored()])).toEqual([[]]);
			});

			it("errors and unknowns together are still all unknown", () => {
				expect(memberLines([errorMember(), restored(), errorMember()])).toEqual([[], [], []]);
			});

			it("a member with Pi's own error never shows Status unknown, even beside a known member", () => {
				expect(memberLines([member("succeeded"), errorMember(), restored()])).toEqual([[], [], ["Status unknown"]]);
			});

			it("an ended unknown member with no recorded result shows No recorded result", () => {
				expect(memberLines([restored(), restored({ hasResult: false })])).toEqual([[], ["No recorded result"]]);
			});

			it("Status unknown comes first, then No recorded result", () => {
				expect(memberLines([member("succeeded"), restored({ hasResult: false })])).toEqual([[], ["Status unknown", "No recorded result"]]);
			});

			it("an unknown member whose command is still open has no result line", () => {
				expect(memberLines([restored({ callOpen: true, hasResult: false })])).toEqual([[]]);
				expect(memberLines([member("succeeded"), restored({ callOpen: true, hasResult: false })])).toEqual([[], ["Status unknown"]]);
			});

			it("waiting and running members with no result yet get no line", () => {
				const open = { callOpen: true, hasResult: false };
				expect(memberLines([member("waiting", open), member("running", open), restored()])).toEqual([[], [], ["Status unknown"]]);
			});

			it("known members get neither line, whatever their result", () => {
				const bare = { callOpen: false, hasResult: false };
				expect(memberLines([member("succeeded", bare), member("failed", bare), member("cancelled", bare), member("notRun", bare)])).toEqual([
					[],
					[],
					[],
					[],
				]);
			});
		});
	});

	describe("boundaries and order", () => {
		const run = (over: Partial<ShellMember> = {}) => member("succeeded", over);
		const abc = () => [run(), run(), run()] as [ShellMember, ShellMember, ShellMember];
		const keys = (...members: ShellMember[]) => members.map(memberId);

		describe("One group", () => {
			it("three adjacent calls are one group in call order", () => {
				const [a, b, c] = abc();
				const groups = groupRows([shell(a), shell(b), shell(c)], [], false);
				expect(ids(groups)).toEqual([keys(a, b, c)]);
			});

			it("tool-only model turns between calls do not split it: their placeholders draw nothing", () => {
				const [a, b, c] = abc();
				const rows = [silent(), shell(a), silent(), shell(b), silent(), shell(c)];
				expect(ids(groupRows(rows, [], false))).toEqual([keys(a, b, c)]);
			});

			it("a member id is its session, source and call id, so one item id in two sessions is two members", () => {
				const a = run({ toolCallId: "codex-item-1", source: "codex-command" });
				const sameCall: ShellMember = { ...a, agentPath: "other", cwd: "/elsewhere" };
				expect(memberId(a)).toBe(memberId(sameCall));
				expect(memberId(a)).not.toBe(memberId({ ...a, sessionId: "s2" }));
				expect(memberId(a)).not.toBe(memberId({ ...a, source: "pi-bash" }));
				expect(memberId(a)).not.toBe(memberId({ ...a, toolCallId: "codex-item-2" }));
			});
		});

		describe("What ends a group", () => {
			// The rule knows one thing about a row that is not a member: whether it draws a line. Which of Pi's rows do is asked of Pi's own rows, under "boundaries and order: Pi's own rows".
			it("a row that draws a line between two calls splits them, and one that draws none does not", () => {
				const [a, b, c] = abc();
				expect(ids(groupRows([shell(a), drawn(), shell(b), shell(c)], [], false))).toEqual([keys(a), keys(b, c)]);
				expect(ids(groupRows([shell(a), silent(), shell(b), shell(c)], [], false))).toEqual([keys(a, b, c)]);
				expect(ids(groupRows([shell(a), drawn(), drawn(), shell(b), drawn(), shell(c)], [], false))).toEqual([keys(a), keys(b), keys(c)]);
			});

			it.each([
				["session", { sessionId: "s2" }],
				["source", { source: "codex-command" as const }],
				["agent", { agentPath: "root/worker" }],
				["agent thread", { threadId: "thread-child" }],
				["working directory", { cwd: "/elsewhere" }],
			])("a change of %s between adjacent calls splits them", (_name, over) => {
				const a = run();
				const b = run();
				const c = run(over);
				const d = run(over);
				expect(ids(groupRows([shell(a), shell(b), shell(c), shell(d)], [], false))).toEqual([keys(a, b), keys(c, d)]);
			});

			it("a root Codex row's empty thread id and an absent one are the same agent", () => {
				const a = run({ source: "codex-command", threadId: "" });
				const b = run({ source: "codex-command" });
				expect(ids(groupRows([shell(a), shell(b)], [], false))).toEqual([keys(a, b)]);
			});

			it("a group that ended does not pick up a later call that matches it", () => {
				const a = run();
				const b = run({ cwd: "/elsewhere" });
				const c = run();
				expect(ids(groupRows([shell(a), shell(b), shell(c)], [], false))).toEqual([keys(a), keys(b), keys(c)]);
			});
		});

		describe("Delivered input", () => {
			it("each delivered user row splits, repeated text included", () => {
				const [a, b, c] = abc();
				const rows = [shell(a), drawn(), shell(b), drawn(), shell(c)];
				expect(ids(groupRows(rows, [], false))).toEqual([keys(a), keys(b), keys(c)]);
			});

			it("the reopened transcript groups as the live one did when the same rows are drawn", () => {
				const [a, b, c] = abc();
				const live = groupRows([shell(a)], [], false);
				const grown = groupRows([shell(a), shell(b)], live, false);
				const delivered = groupRows([shell(a), shell(b), drawn(), shell(c)], grown, false);
				const replay = groupRows([shell(a), shell(b), drawn(), shell(c)], [], false);
				expect(ids(delivered)).toEqual([keys(a, b), keys(c)]);
				expect(replay).toEqual(delivered);
			});
		});

		describe("Order", () => {
			it("completing C, then A, then B leaves the members in call order", () => {
				const a = member("running");
				const b = member("running");
				const c = member("running");
				const view = viewOf([shell(a), shell(b), shell(c)]);
				for (const m of [c, a, b]) {
					tell(view, m, exit(0));
					expect(view.groups[0]!.memberIds).toEqual(keys(a, b, c));
				}
				expect([...view.members.keys()]).toEqual(keys(a, b, c));
				expect(header(view.groups[0]!.memberIds.map((id) => view.members.get(id)!))).toBe("▸ ran 3 shell commands");
			});

			it("a regroup keeps the evidence a member already has", () => {
				const a = member("running");
				const view = viewOf([shell(a)]);
				tell(view, a, exit(0));
				const fresh = { ...a, executionEvidence: { state: "waiting" as const }, executionStarted: false };
				reconcileMembership(view, [shell(fresh), shell(member("succeeded"))], false);
				expect(header(view.groups[0]!.memberIds.map((id) => view.members.get(id)!))).toBe("▸ ran 2 shell commands");
			});

			it("a member whose row left the transcript leaves the view", () => {
				const [a, b, c] = abc();
				const view = viewOf([shell(a), shell(b), shell(c)]);
				reconcileMembership(view, [shell(a), shell(c)], false);
				expect([...view.members.keys()]).toEqual(keys(a, c));
				expect(tell(view, b, exit(7))).toBe(false);
				expect(updateMember(view, memberId(b))).toBe(false);
				expect(view.groups[0]!.memberIds).toEqual(keys(a, c));
			});
		});

		describe("Open and closed membership", () => {
			it("the last group stays open until something visible follows it", () => {
				const [a, b, c] = abc();
				const open = groupRows([shell(a), drawn(), shell(b), silent()], [], false);
				expect(open.map((group) => group.open)).toEqual([false, true]);
				const closed = groupRows([shell(a), drawn(), shell(b), drawn()], open, false);
				expect(closed.map((group) => group.open)).toEqual([false, false]);
				const next = groupRows([shell(a), drawn(), shell(b), drawn(), shell(c)], closed, false);
				expect(ids(next)).toEqual([keys(a), keys(b), keys(c)]);
				expect(next.map((group) => group.open)).toEqual([false, false, true]);
			});

			it("a closed group still takes its members' status updates", () => {
				const a = member("running");
				const b = member("running");
				const view = viewOf([shell(a), drawn(), shell(b)]);
				expect(view.groups[0]!.open).toBe(false);
				expect(tell(view, a, exit(7))).toBe(true);
				expect(header(view.groups[0]!.memberIds.map((id) => view.members.get(id)!))).toBe("▸ ran 1 shell command · 1 failed");
				expect(ids(view.groups)).toEqual([keys(a), keys(b)]);
			});

			it("a background member's late completion updates its own group and never joins the latest one", () => {
				const a = member("background");
				const b = member("running");
				const view = viewOf([shell(a), drawn(), shell(b)]);
				tell(view, a, exit(0));
				expect(ids(view.groups)).toEqual([keys(a), keys(b)]);
				expect(view.groups.map((group) => group.updates)).toEqual([1, 0]);
			});
		});

		describe("Disclosure through splits and merges", () => {
			it("a new group follows the global setting", () => {
				const [a, b] = abc();
				expect(groupRows([shell(a), drawn(), shell(b)], [], false).map((group) => group.expanded)).toEqual([false, false]);
				expect(groupRows([shell(a), drawn(), shell(b)], [], true).map((group) => group.expanded)).toEqual([true, true]);
			});

			it("an appended member inherits its group's disclosure, whatever the global setting", () => {
				const [a, b, c] = abc();
				const first = groupRows([shell(a)], [], false);
				first[0]!.expanded = true;
				const grown = groupRows([shell(a), shell(b)], first, false);
				expect(grown.map((group) => group.expanded)).toEqual([true]);
				grown[0]!.expanded = false;
				expect(groupRows([shell(a), shell(b), shell(c)], grown, true).map((group) => group.expanded)).toEqual([false]);
			});

			it("late text that splits an expanded group leaves both halves expanded, and a collapsed one collapsed", () => {
				const [a, b, c] = abc();
				const [d, e] = abc();
				const before = groupRows([shell(a), silent(), shell(b), shell(c), drawn(), shell(d), silent(), shell(e)], [], false);
				expect(ids(before)).toEqual([keys(a, b, c), keys(d, e)]);
				before[0]!.expanded = true;
				const after = groupRows([shell(a), drawn(), shell(b), shell(c), drawn(), shell(d), drawn(), shell(e)], before, true);
				expect(ids(after)).toEqual([keys(a), keys(b, c), keys(d), keys(e)]);
				expect(after.map((group) => group.expanded)).toEqual([true, true, false, false]);
			});

			it("a merge keeps inspected details open when either group was expanded", () => {
				const [a, b, c] = abc();
				const split = groupRows([shell(a), drawn(), shell(b), drawn(), shell(c)], [], false);
				split[1]!.expanded = true;
				const merged = groupRows([shell(a), silent(), shell(b), drawn(), shell(c)], split, false);
				expect(ids(merged)).toEqual([keys(a, b), keys(c)]);
				expect(merged.map((group) => group.expanded)).toEqual([true, false]);
			});

			it("a merge of two collapsed groups stays collapsed under an expanded global setting", () => {
				const [a, b] = abc();
				const split = groupRows([shell(a), drawn(), shell(b)], [], false);
				const merged = groupRows([shell(a), silent(), shell(b)], split, true);
				expect(merged.map((group) => group.expanded)).toEqual([false]);
			});

			it("a hidden-thinking toggle splits and merges without losing disclosure", () => {
				const [a, b] = abc();
				let groups = groupRows([shell(a), silent(), shell(b)], [], false);
				groups[0]!.expanded = true;
				groups = groupRows([shell(a), drawn(), shell(b)], groups, false);
				expect(groups.map((group) => group.expanded)).toEqual([true, true]);
				groups = groupRows([shell(a), silent(), shell(b)], groups, false);
				expect(ids(groups)).toEqual([keys(a, b)]);
				expect(groups.map((group) => group.expanded)).toEqual([true]);
			});
		});

		describe("One member's update touches one group", () => {
			it("100 output updates to one of 1,000 members regroup nothing and touch only its group", () => {
				const rows: TranscriptRow[] = [];
				const members: ShellMember[] = [];
				for (let i = 0; i < 1000; i++) {
					if (i > 0 && i % 100 === 0) rows.push(drawn());
					const m = member("running", { nativeRow: { output: "x".repeat(64) } });
					members.push(m);
					rows.push(shell(m));
				}
				const view = viewOf(rows);
				expect(view.groups).toHaveLength(10);
				expect(view.reconciliations).toBe(1);
				const before = view.groups.slice();
				const target = members[437]!;

				for (let i = 0; i < 100; i++) {
					expect(updateMember(view, memberId(target))).toBe(true);
					expect(tell(view, target, START)).toBe(false);
				}

				expect(view.reconciliations).toBe(1);
				expect(view.groups.map((group) => group.updates)).toEqual([0, 0, 0, 0, 100, 0, 0, 0, 0, 0]);
				view.groups.forEach((group, i) => expect(group).toBe(before[i]));
				expect(view.members.get(memberId(target))!.nativeRow).toBe(target.nativeRow);
				expect(JSON.stringify(view.groups)).not.toContain("xxxx");
			});

			it("an evidence update touches only its member's group", () => {
				const a = member("running");
				const b = member("running");
				const view = viewOf([shell(a), drawn(), shell(b)]);
				tell(view, b, exit(7));
				expect(view.reconciliations).toBe(1);
				expect(view.groups.map((group) => group.updates)).toEqual([0, 1]);
			});

			it("an update for a row that is not in the view is dropped and adds no member", () => {
				const a = member("running");
				const hidden = member("running");
				const view = viewOf([shell(a)]);
				expect(tell(view, hidden, exit(0))).toBe(false);
				expect(updateMember(view, memberId(hidden), { rowError: true })).toBe(false);
				expect([...view.members.keys()]).toEqual(keys(a));
				expect(view.groups[0]!.updates).toBe(0);
			});
		});
	});


	describe("pi-52 generic counts copy and boundaries", () => {
		const mcp = (id: string, name: string, connectorId: string): ShellMember => member("waiting", {
			toolCallId: id, source: "codex-mcp" as any, threadId: "root", agentPath: "",
			mcp: { identity: { server: "custom-server", tool: "invoke", display: { appName: name, connectorId } }, evidence: { state: "returned" } },
		} as any);
		it("counts arbitrary MCP identities beside shell activity and retains native invocation order", () => {
			const a = mcp("m1", "Acme Design", "a");
			const b = member("succeeded", { toolCallId: "s1", source: "codex-command", threadId: "root", agentPath: "" });
			const c = mcp("m2", "Notes Lab", "b");
			const again = mcp("m3", "Acme Design", "a");
			const rows = [a,b,c,again];
			expect(header(rows)).toBe("▸ called Acme Design 2 times; ran 1 shell command; called Notes Lab 1 time");
			expect(ids(groupRows(rows.map(shell), [], false))).toEqual([rows.map(memberId)]);
		});
		it("keeps two identical friendly names and server/tool pairs distinct by recorded connector identity", () => {
			const a = mcp("m1", "Design", "c1");
			const b = mcp("m2", "Design", "c2");
			expect(header([a,b])).toBe("▸ called Design [custom-server/invoke] [connector: c1] 1 time; called Design [custom-server/invoke] [connector: c2] 1 time");
		});
	});

	// ─── The view, against Pi's own classes ─────────────────────────────────────

	describe("pi-52 scoped command facts",()=>{
		it("a departed-client reused call ID, wrong thread and stale revision cannot update another member",()=>{
			const a=member("waiting",{source:"codex-command",toolCallId:"same",clientGeneration:"old",threadId:"root"});
			const b=member("waiting",{source:"codex-command",toolCallId:"same",clientGeneration:"new",threadId:"root"});
			const view=createShellView();reconcileMembership(view,[{kind:"shell",member:a},{kind:"shell",member:b}],false);view.owners.set("codex-command","owner");
			const message={kind:"fact",sessionId:a.sessionId,source:"codex-command",ownerGeneration:"owner",toolCallId:"same",clientGeneration:"old",threadId:"root",revision:2,fact:{kind:"start"}} as FactMessage;
			expect(applyEvidence(view,{...message,threadId:"other"})).toBe(false);expect(applyEvidence(view,message)).toBe(true);
			expect(a.executionEvidence.state).toBe("running");expect(b.executionEvidence.state).toBe("waiting");
			expect(applyEvidence(view,{...message,revision:1,fact:{kind:"completion",exitCode:0,status:"completed"}})).toBe(false);
			expect(applyEvidence(view,{...message,ownerGeneration:"revoked",revision:9})).toBe(false);
		});
	});

	describe("pi-52 MCP evidence", () => {
		it("keeps native lifecycle separate from remote dispatch or process proof", () => {
			let evidence = { state: "pending" } as Parameters<typeof reduceMcpEvidence>[0];
			evidence = reduceMcpEvidence(evidence, "start");
			expect(evidence).toEqual({ state: "active" });
			evidence = reduceMcpEvidence(evidence, "failed");
			expect(evidence).toEqual({ state: "failed" });
			expect(reduceMcpEvidence(evidence, "start")).toBe(evidence);
			expect(reduceMcpEvidence(evidence, "lost")).toBe(evidence);
			expect(reduceMcpEvidence(evidence, "returned")).toEqual({ state: "unknown", conflicted: true });
			expect(reduceMcpEvidence({ state: "pending" }, "lost")).toEqual({ state: "unknown" });
			expect(reduceMcpEvidence({ state: "unknown", conflicted: true }, "returned")).toEqual({ state: "unknown", conflicted: true });
		});
	});

	describe("pi-52 generic counts copy and boundaries", () => {
		const mcp = (name: string | undefined, state = "returned", over: Record<string, unknown> = {}) => member("waiting", {
			source: "codex-mcp", threadId: "root", agentPath: "", mcp: { identity: { server: "custom.server", tool: "a.tool.with.dots", ...(name ? { display: { appName: name } } : {}), ...over }, evidence: { state } },
		} as any);
		it("uses exact recorded fallback without interpreting dots", () => {
			expect(header([mcp(undefined)])).toBe("▸ called custom.server/a.tool.with.dots 1 time");
			expect(header([mcp("Notes Lab"), mcp("Notes Lab")], true)).toBe("▾ called Notes Lab 2 times");
		});
		it.each(["pending", "active", "failed", "unknown"])("attributes %s to its MCP category", (state) => {
			const rows = [mcp("Notes Lab", state), member("succeeded", { source: "codex-command" })];
			const fields = formatHeader(rows, false);
			const text = wrapFields(fields, 120).flatMap((line) => line.spans.map((span) => span.text)).join("");
			expect(text).toBe(state === "failed" ? "▸ called Notes Lab 1 time · 1 failed; ran 1 shell command" : `▸ Notes Lab: 1 call · ${state === "unknown" ? "status unknown" : state}; ran 1 shell command`);
			expect(rows[0]!.executionStarted).toBe(false);
		});
		it("escapes identity controls literally, retaining raw values", () => {
			const raw = "Acme\u001b[31m\n\r\t\u0007\u007f\u009bX";
			const row = mcp(raw);
			expect(header([row])).toBe("▸ called Acme\\u001b[31m\\n\\r\\t\\u0007\\u007f\\u009bX 1 time");
			expect(row.mcp!.identity.display!.appName).toBe(raw);
			for (const width of [40, 80, 120]) {
				const lines = wrapFields(formatHeader([row], false), width - 1);
				expect(lines.every((line) => line.column + line.spans.reduce((sum, span) => sum + [...span.text].length, 0) <= width - 1)).toBe(true);
				expect(lines.flatMap((line) => line.spans).every((span) => !/[\x00-\x1f\x7f-\x9f]/.test(span.text))).toBe(true);
			}
		});
		it("keeps distinct plugin identities separate, even with an equal name and pair", () => {
			const a = mcp("Design", "returned", { display: { appName: "Design", pluginId: "p1" } });
			const b = mcp("Design", "returned", { display: { appName: "Design", pluginId: "p2" } });
			const text = wrapFields(formatHeader([a,b],false),1000).flatMap((line)=>line.spans.map((span)=>span.text)).join("");
			expect(text).toBe("▸ called Design [custom.server/a.tool.with.dots] [plugin: p1] 1 time; called Design [custom.server/a.tool.with.dots] [plugin: p2] 1 time");
		});
		it("keeps printable names that imitate identity suffixes distinct",()=>{
			const names=["Name","Name","Name [s/t] [connector: c1]",'identity: ["codex","s","c1",null] [name: Name [s/t] [connector: c1]]'];
			const rows=names.map((appName,i)=>mcp(appName,"returned",{server:"s",tool:"t",display:{appName,connectorId:["c1","c2","c3","c4"][i]}}));
			const clauses=formatHeader(rows,false).map((field)=>field.map((span)=>span.text).join("").replace(/^[▸▾] /,""));
			expect(clauses).toHaveLength(4);expect(new Set(clauses).size).toBe(4);
		});

		it.each([
			["Design 1 time · 1 failed; called Search", '▸ called "Design 1 time · 1 failed; called Search" 1 time'],
			["Search; Archive", '▸ called "Search; Archive" 1 time'],
			["Search · Archive", '▸ called "Search · Archive" 1 time'],
			['Acme "Notes"', String.raw`▸ called "Acme \"Notes\"" 1 time`],
			[String.raw`Acme\Folder "Notes"`, String.raw`▸ called "Acme\\\\Folder \"Notes\"" 1 time`],
		])("pi-52 printable summary syntax keeps %s inside one literal identity",(appName,expected)=>{
			const row=mcp(appName);
			expect(header([row])).toBe(expected);
			expect(row.mcp!.identity.display!.appName).toBe(appName);
		});
		it("pi-52 printable summary syntax quotes the final fallback and disambiguated label",()=>{
			expect(header([mcp(undefined,"returned",{server:"notes;archive",tool:"search"})])).toBe('▸ called "notes;archive/search" 1 time');
			const first=mcp("Design","returned",{display:{appName:"Design",connectorId:"c;1"}});
			const second=mcp("Design","returned",{display:{appName:"Design",connectorId:"c2"}});
			expect(header([first,second])).toBe('▸ called "Design [custom.server/a.tool.with.dots] [connector: c;1]" 1 time; called Design [custom.server/a.tool.with.dots] [connector: c2] 1 time');
		});

		it("the supplied MCP-shell-MCP example uses its exact fallback and one combined count",()=>{
			const rows=[mcp(undefined,"returned",{server:"codex_apps",tool:"figma.use_figma"}),member("succeeded",{source:"codex-command"}),mcp(undefined,"returned",{server:"codex_apps",tool:"figma.use_figma"})];
			expect(header(rows)).toBe("▸ called codex_apps/figma.use_figma 2 times; ran 1 shell command");
		});
		it.each(["server","tool","connectorId","pluginId"])("escapes controls in %s while preserving exact category identity",(field)=>{
			const raw="x\u001b[31m\n\r\t\u0007\u007f\u009b";
			const first=mcp(undefined,"returned",field==="server"||field==="tool"?{[field]:raw}:{display:{appName:"Design",[field]:raw}});
			const second=mcp(undefined,"returned",field==="server"||field==="tool"?{[field]:"other"}:{display:{appName:"Design",[field]:"other"}});
			const rendered=header([first,second])!;expect(rendered).toContain("x\\u001b[31m\\n\\r\\t\\u0007\\u007f\\u009b");expect(rendered).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
		});

		it("does not merge different opaque scopes or drop reused call IDs", () => {
			const a = mcp("A"); const b = mcp("B", "returned", { server: "other" });
			a.clientGeneration = "departed"; b.clientGeneration = "current"; b.toolCallId = a.toolCallId;
			expect(memberId(a)).not.toBe(memberId(b));
			expect(groupRows([{kind:"shell",member:a},{kind:"shell",member:b}],[],false)).toHaveLength(2);
		});
		it("retains category order with shell first and respects visible boundaries", () => {
			const shell=member("succeeded",{source:"codex-command",threadId:"root",agentPath:""});
			const rows=[shell,mcp("Notes")];
			expect(wrapFields(formatHeader(rows,false),120).flatMap((line)=>line.spans.map((span)=>span.text)).join("")).toBe("▸ ran 1 shell command; called Notes 1 time");
			expect(groupRows([{kind:"shell",member:shell},{kind:"content",visible:true},{kind:"shell",member:rows[1]!}],[],false)).toHaveLength(2);
			expect(groupRows([{kind:"shell",member:shell},{kind:"content",visible:false},{kind:"shell",member:rows[1]!}],[],false)).toHaveLength(1);
		});
	});

	describe("view components", () => {
		const SESSION = "s1";
		const WORDS = Array.from({ length: 35 }, (_, i) => `word${String(i + 1).padStart(2, "0")}`).join(" ");
		const ALPHA = "printf 'alpha\\nbeta\\n'";
		const LONG = `echo before; echo '${WORDS}'; echo after`;
		const RAN: ShellDisplayFact[] = [{ kind: "start" }, { kind: "close", code: 0, signal: null }];
		const FAILED: ShellDisplayFact[] = [{ kind: "start" }, { kind: "close", code: 1, signal: null }];
		const GONE: ShellDisplayFact[] = [{ kind: "start" }, { kind: "child-error" }];
		type Bus = { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void };

		const clean = (line: string) => stripTerminalSequences(line).trimEnd();
		const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
		const stages: { view: { stop(): void } }[] = [];
		const pristine = Object.fromEntries(HOST_METHODS.map((name) => [name, (InteractiveMode.prototype as any)[name]]));

		beforeEach(() => {
			initTheme();
			applyToolPartsIndent();
			applyToolExecutionBlended();
		});

		afterEach(async () => {
			for (const stage of stages.splice(0)) stage.view.stop();
			await tick();
			restoreToolPartsIndent();
			restoreToolExecutionBlended();
			delete (globalThis as any)[VIEW_KEY];
			for (const name of HOST_METHODS) {
				(InteractiveMode.prototype as any)[name] = pristine[name];
				delete (InteractiveMode.prototype as any)[wrappedKey(name)];
			}
		});

		/**
		 * An `InteractiveMode` that never started a terminal: Pi's own prototype over the few fields its transcript methods read.
		 * `handleEvent`, `renderSessionItems`, `setToolsExpanded`, `addMessageToChat` and the queue display are Pi's code, and every row is one Pi built.
		 */
		function makeHost(definitions: Map<string, unknown>) {
			const queue = { steering: [] as string[], followUp: [] as string[] };
			const requestRender = vi.fn();
			const host: any = Object.create(InteractiveMode.prototype);
			Object.assign(host, {
				isInitialized: true,
				// Native 1.3 initializes this class field; Object.create deliberately skips the constructor.
				programStatus: { handleEvent() {} },
				footer: { invalidate() {} },
				ui: { requestRender, terminal: { setProgress() {} } },
				chatContainer: new Container(),
				pendingMessagesContainer: new Container(),
				loadedResourcesContainer: new Container(),
				pendingTools: new Map(),
				toolOutputExpanded: false,
				hideThinkingBlock: false,
				hiddenThinkingLabel: "Thinking...",
				outputPad: 1,
				compactionQueuedMessages: [],
				runtimeHost: {
					session: {
						settingsManager: {
							getShowImages: () => false,
							getImageWidthCells: () => 60,
							getShowCacheMissNotices: () => false,
							getCodeBlockIndent: () => "  ",
							getShowTerminalProgress: () => false,
						},
						sessionManager: { getCwd: () => "/work", getEntries: () => [] },
						getToolDefinition: (name: string) => definitions.get(name),
						getSteeringMessages: () => queue.steering,
						getFollowUpMessages: () => queue.followUp,
						retryAttempt: 0,
						// Pi 1.0.3 asks extension resolvers for a row's renderers first; with none loaded it takes Pi's own, as here.
						extensionRunner: { resolveToolRenderers: (_name: string, base: () => unknown) => base(), getMessageRenderer: () => undefined, getMarkdownTransformers: () => [] },
					},
				},
			});
			return { host, queue, requestRender };
		}

		/** A host, a view over it, and the Pi owner's own channel code speaking for a real bash tool definition. */
		function stage(opts: { announce?: boolean; start?: boolean; events?: Bus; mode?: string } = {}) {
			const events = opts.events ?? createEventBus();
			const bash: any = createBashToolDefinition("/work");
			const definitions = new Map<string, unknown>([["bash", bash]]);
			const { host, queue, requestRender } = makeHost(definitions);
			const chat: any = host.chatContainer;
			const notify = vi.fn();
			const ctx: any = { mode: opts.mode ?? "tui", hasUI: true, ui: { notify }, sessionManager: { getSessionId: () => SESSION } };
			const view = createShellGroupsView({ events } as any);
			if (opts.start !== false) view.start(ctx);
			const owner = createShellDisplayOwner<ShellDisplayFact>(events, "pi-bash", (fact) => fact.kind === "close" || fact.kind === "not-run")!;
			if (opts.announce !== false) owner.start(SESSION, bash);
			const calls = new Map<string, { tell(fact: ShellDisplayFact): void }>();
			let width = 80;

			const tell = (id: string, ...facts: ShellDisplayFact[]) => {
				if (!calls.has(id)) calls.set(id, owner.open(id)!);
				for (const fact of facts) calls.get(id)!.tell(fact);
			};
			const begin = (id: string, command = "pwd") => host.handleEvent({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command } });
			const end = (id: string, output = "", isError = false) =>
				host.handleEvent({ type: "tool_execution_end", toolCallId: id, toolName: "bash", result: { content: [{ type: "text", text: output }] }, isError });
			/** One call as Pi's loop delivers it: the row opens, the owner reports, the row takes its result. */
			const run = async (id: string, command = "pwd", output = "/work\n", facts: ShellDisplayFact[] = RAN, isError = false) => {
				await begin(id, command);
				tell(id, ...facts);
				await end(id, output, isError);
			};
			const prose = (text: string) => {
				if (chat.children.length > 0) chat.addChild(new Spacer(1));
				chat.addChild(new Text(text, 1, 0));
			};
			const draw = (at = width): string[] => {
				width = at;
				return chat.render(at).map(clean);
			};
			const native = (at = width): string[] => Container.prototype.render.call(chat, at).map(clean);
			const mouse = (type: string, y: number, over: Record<string, unknown> = {}) =>
				chat.handleMouse({ type, button: "left", x: 6, y, screenX: 6, screenY: y, width, height: 10_000, shift: false, alt: false, ctrl: false, ...over });
			/** What Pi sends for one click: the press, the release, and the click it makes from them. */
			const click = (y: number, over: Record<string, unknown> = {}) => {
				mouse("press", y, over);
				mouse("release", y, over);
				return mouse("click", y, over);
			};
			const headerRow = (nth = 0) => {
				const rows = draw().flatMap((line, y) => (line.startsWith(" ▸") || line.startsWith(" ▾") ? [y] : []));
				return rows[nth]!;
			};
			const headers = () => draw().filter((line) => line.startsWith(" ▸") || line.startsWith(" ▾"));
			const rows = () => chat.children.filter((child: unknown) => child instanceof ToolExecutionComponent) as any[];
			const made = { host, chat, queue, requestRender, notify, ctx, view, owner, events, bash, definitions, tell, begin, end, run, prose, draw, native, mouse, click, headerRow, headers, rows };
			stages.push(made);
			return made;
		}


		describe("pi-52 live membership identity", () => {
			function codex(s: ReturnType<typeof stage>) {
				const tool = { ...s.bash, name: "codex_command", renderCall: (args: any) => new Text(`$ ${args.command}`,0,0), renderResult: () => new Text("out",0,0) };
				s.definitions.set(tool.name, tool);
				const owner = createShellDisplayOwner<any>(s.events,"codex-command",()=>false)!;
				let ownerGeneration="";
				s.events.on(SHELL_DISPLAY_CHANNEL,(message:any)=>{if(message.kind==="announce"&&message.source==="codex-command")ownerGeneration=message.ownerGeneration;});
				owner.start(SESSION,tool);
				const begin = async (id: string, actualThread: string, clientGeneration: string) => {
					const args = { itemId:id,threadId:"",agentPath:"",command:"pwd",cwd:"/work" };
					s.events.emit(SHELL_DISPLAY_CHANNEL,{ kind:"membership",sessionId:SESSION,source:"codex-command",ownerGeneration,toolCallId:`codex-${id}`,revision:1,itemId:id,clientGeneration,threadId:actualThread,agentPath:"",cwd:"/work",binding:new WeakRef(args) });
					await s.host.handleEvent({type:"tool_execution_start",toolCallId:`codex-${id}`,toolName:tool.name,args});
					return args;
				};
				return {begin,owner,tool,get ownerGeneration(){return ownerGeneration;}};
			}
			it("never merges same-empty-root arguments from different actual root threads, starting with the first frame", async () => {
				const s=stage();const c=codex(s);
				await c.begin("a","actual-root-A","client-1");
				expect(s.headers()).toHaveLength(1);
				await c.begin("b","actual-root-B","client-1");
				expect(s.headers()).toHaveLength(2);
				c.owner.stop();
			});
			it("never merges rows from departed and current clients sharing the same root argument strings", async () => {
				const s=stage();const c=codex(s);
				await c.begin("a","actual-root","departed-client");
				s.draw();
				await c.begin("b","actual-root","current-client");
				expect(s.headers()).toHaveLength(2);
				c.owner.stop();
			});
			it("keeps cloned presentation args and contradictory immutable binding native", async () => {
				const s=stage();const c=codex(s);const args=await c.begin("a","root","client");expect(s.headers()).toHaveLength(1);
				s.rows()[0].updateArgs({...args});expect(s.headers()).toEqual([]);
				s.rows()[0].updateArgs(args);
				s.events.emit(SHELL_DISPLAY_CHANNEL,{kind:"membership",sessionId:SESSION,source:"codex-command",ownerGeneration:c.ownerGeneration,toolCallId:"codex-a",revision:1,itemId:"a",clientGeneration:"client",threadId:"different-root",agentPath:"",cwd:"/work",binding:new WeakRef(args)});
				expect(s.headers()).toEqual([]);c.owner.stop();
			});
			it("an unseen withdrawal tombstones a delayed older snapshot before first admission",async()=>{
				const s=stage();const c=codex(s);const args={itemId:"a",threadId:"",agentPath:"",cwd:"/work",command:"pwd"};
				const identity={sessionId:SESSION,source:"codex-command",ownerGeneration:c.ownerGeneration,toolCallId:"codex-a",itemId:"a",clientGeneration:"client",threadId:"root",agentPath:"",cwd:"/work",binding:new WeakRef(args)};
				s.events.emit(SHELL_DISPLAY_CHANNEL,{...identity,kind:"membership-withdraw",revision:2});s.events.emit(SHELL_DISPLAY_CHANNEL,{...identity,kind:"membership",revision:1});
				await s.host.handleEvent({type:"tool_execution_start",toolCallId:"codex-a",toolName:c.tool.name,args});expect(s.headers()).toEqual([]);c.owner.stop();
			});

			it("a synchronous snapshot can bind before the first projected frame",async()=>{
				const s=stage();const c=codex(s);const args={itemId:"snapshot",threadId:"",agentPath:"",cwd:"/work",command:"pwd"};
				s.events.on(SHELL_DISPLAY_CHANNEL,(message:any)=>{if(message.kind==="snapshot-request"&&message.toolCallIds?.includes("codex-snapshot"))s.events.emit(SHELL_DISPLAY_CHANNEL,{kind:"membership",sessionId:SESSION,source:"codex-command",ownerGeneration:c.ownerGeneration,toolCallId:"codex-snapshot",revision:1,itemId:"snapshot",clientGeneration:"client",threadId:"actual-root",agentPath:"",cwd:"/work",binding:new WeakRef(args)});});
				await s.host.handleEvent({type:"tool_execution_start",toolCallId:"codex-snapshot",toolName:c.tool.name,args});
				expect(s.headers()).toHaveLength(1);expect([...s.view.state.members.values()][0]!.threadId).toBe("actual-root");c.owner.stop();
			});
			it("one captured client/thread combines command and MCP without merging another owner",async()=>{
				const s=stage();const c=codex(s);await c.begin("a","root","client");
				const tool={...c.tool,name:"codex_tool"};s.definitions.set(tool.name,tool);
				const mcpOwner=createShellDisplayOwner<any>(s.events,"codex-mcp",()=>false)!;let generation="";
				s.events.on(SHELL_DISPLAY_CHANNEL,(message:any)=>{if(message.kind==="announce"&&message.source==="codex-mcp")generation=message.ownerGeneration;});mcpOwner.start(SESSION,tool);
				const args={itemId:"m",threadId:"",agentPath:"",server:"custom",tool:"invoke",arguments:{},display:{appName:"Notes"}};
				s.events.emit(SHELL_DISPLAY_CHANNEL,{kind:"membership",sessionId:SESSION,source:"codex-mcp",ownerGeneration:generation,toolCallId:"codex-m",revision:1,itemId:"m",clientGeneration:"client",threadId:"root",agentPath:"",cwd:"/work",binding:new WeakRef(args)});
				await s.host.handleEvent({type:"tool_execution_start",toolCallId:"codex-m",toolName:tool.name,args});await c.begin("b","root","client");
				expect(s.headers()).toHaveLength(1);expect(s.view.state.groups[0]!.memberIds).toHaveLength(3);
				await c.begin("d","root","other");expect(s.headers()).toHaveLength(2);mcpOwner.stop();c.owner.stop();
			});
			it.each(["invalid-weak-token","expired-token","wrong-session","wrong-owner","wrong-item","wrong-cwd"])("%s remains a native barrier from admission",async(kind)=>{
				const s=stage();const c=codex(s);const args={itemId:"a",threadId:"",agentPath:"",cwd:"/work",command:"pwd"};
				const binding=kind==="invalid-weak-token"?{deref:()=>args}:kind==="expired-token"?new (class extends WeakRef<object>{deref(){return undefined;}})(args):new WeakRef(args);
				s.events.emit(SHELL_DISPLAY_CHANNEL,{kind:"membership",sessionId:kind==="wrong-session"?"other":SESSION,source:"codex-command",ownerGeneration:kind==="wrong-owner"?"other":c.ownerGeneration,toolCallId:"codex-a",revision:1,itemId:kind==="wrong-item"?"other":"a",clientGeneration:"client",threadId:"root",agentPath:"",cwd:kind==="wrong-cwd"?"/other":"/work",binding});
				await s.host.handleEvent({type:"tool_execution_start",toolCallId:"codex-a",toolName:c.tool.name,args});expect(s.headers()).toEqual([]);c.owner.stop();
			});


			it.each([
				["header","membership-withdraw"],["member","membership-withdraw"],
				["header","owner-withdraw"],["member","owner-withdraw"],
				["header","conflict"],["member","conflict"],
				["header","replacement"],["member","replacement"],
			])("pi-52 immediate retirement invalidates a pending %s gesture on %s before redraw",async(target,invalidation)=>{
					const s=stage();const c=codex(s);const args=await c.begin("a","root","client");
					s.click(s.headerRow());const group=s.view.state.groups[0]!;expect(group.expanded).toBe(true);
					const y=target==="header"?s.headerRow():s.draw().findIndex((line)=>line.includes("$ pwd"));expect(y).toBeGreaterThanOrEqual(0);
					s.mouse("press",y);
					const membership={kind:"membership",sessionId:SESSION,source:"codex-command",ownerGeneration:c.ownerGeneration,toolCallId:"codex-a",revision:1,itemId:"a",clientGeneration:"client",threadId:"root",agentPath:"",cwd:"/work",binding:new WeakRef(args)};
					if(invalidation==="membership-withdraw")s.events.emit(SHELL_DISPLAY_CHANNEL,{...membership,kind:"membership-withdraw",revision:2});
					else if(invalidation==="owner-withdraw")c.owner.stop();
					else if(invalidation==="conflict")s.events.emit(SHELL_DISPLAY_CHANNEL,{...membership,threadId:"other-root"});
					else s.events.emit(SHELL_DISPLAY_CHANNEL,{kind:"announce",sessionId:SESSION,source:"codex-command",ownerGeneration:"replacement-owner",toolName:c.tool.name,execute:c.tool.execute,renderCall:c.tool.renderCall,renderResult:c.tool.renderResult});
					// Deliberately no draw/header query between invalidation and the completed click.
					s.mouse("release",y);s.mouse("click",y);
					expect(group.expanded,`${target}: ${invalidation}`).toBe(true);
					expect(s.headers()).toEqual([]);c.owner.stop();s.view.stop();
			});

			it("keeps an unbound live Codex row native from its first frame", async () => {
				const s=stage();const c=codex(s);
				await s.host.handleEvent({type:"tool_execution_start",toolCallId:"codex-unbound",toolName:"codex_command",args:{itemId:"unbound",threadId:"",agentPath:"",command:"pwd",cwd:"/work"}});
				expect(s.headers()).toEqual([]);
				expect(s.draw().join("\n")).toContain("$ pwd");
				c.owner.stop();
			});
		});

		describe("pi-52 actual producer and native row isolation",()=>{
			it.each(["command","toolCall"] as const)("different actual roots on one real producer client isolate %s from the first native frame",async(kind)=>{
				await exercise(kind,false);
			});
			it.each(["command","toolCall"] as const)("departed/current real producer clients cannot reassociate reused %s IDs",async(kind)=>{
				await exercise(kind,true);
			});
			async function exercise(kind:"command"|"toolCall",replaceClient:boolean){
				const saved=process.env.RBF_FAKE_SCENARIO;const work=mkdtempSync(join(tmpdir(),"pi52-native-source-"));
				const s=stage();const handlers=new Map<string,any>();let provider:any;
				const item=(id:string)=>kind==="command"?{kind,id,command:"printf fixture",cwd:work,output:["fixture"]}:{kind,id,server:"arbitrary",tool:"invoke",arguments:{},result:{content:[]}};
				process.env.RBF_FAKE_SCENARIO=JSON.stringify({threadIds:replaceClient?["actual-root"]:["actual-root-A","actual-root-B"],turn:[item(replaceClient?"duplicate":"a"),{kind:"complete"}],laterTurns:[item("b"),{kind:"complete"}]});
				const seen:any[]=[];s.events.on(SHELL_DISPLAY_CHANNEL,(message)=>seen.push(message));
				const pi:any={events:s.events,on:(name:string,handler:any)=>handlers.set(name,handler),appendEntry(){},registerTool:(tool:any)=>s.definitions.set(tool.name,tool),registerProvider:(_name:string,config:any)=>{provider=config;},getThinkingLevel:()=>"medium"};
				const ctx:any={...s.ctx,model:BOOTSTRAP_MODEL,isIdle:()=>true,hasPendingMessages:()=>false,ui:{notify(){},setWorkingMessage(){}},sessionManager:{getSessionId:()=>SESSION,getCwd:()=>work,getBranch:()=>[],getLeafId:()=>"leaf"}};
				createRbfCodex({argv:[],command:{bin:process.execPath,args:[resolve(import.meta.dirname,"test-support/rbf-codex-fake-app-server.ts")]}})(pi);
				try{
					await handlers.get("session_start")({type:"session_start"},ctx);
					const user={role:"user",content:[{type:"text",text:"fixture"}],timestamp:1};
					const stream=async(messages:any[],rowOnlyTerminal=false)=>{
						let final:any;let call:any;
						for await(const event of provider.streamSimple(BOOTSTRAP_MODEL,{messages},{})){
							if(event.type==="start")await s.host.handleEvent({type:"message_start",message:event.partial});
							else if(event.partial){
								await s.host.handleEvent({type:"message_update",message:event.partial,assistantMessageEvent:event});s.draw();
								for(const row of s.rows())if(row.args?.itemId){const member=[...s.view.state.members.values()].find((member)=>member.nativeRow===row);if(member){expect(member.clientGeneration).toBeTruthy();const record=seen.find((m)=>m.kind==="membership"&&m.binding?.deref()===row.args);expect(record).toBeDefined();expect(member.threadId).toBe(record.threadId);expect(member.clientGeneration).toBe(record.clientGeneration);}}
								for(const group of s.view.state.groups){const tuples=group.memberIds.map((id)=>{const member=s.view.state.members.get(id)!;return JSON.stringify([member.clientGeneration,member.threadId,member.agentPath,member.cwd]);});expect(new Set(tuples).size).toBe(1);}
							}
							if(event.type==="done"){final=event.message;call=final.content.find((part:any)=>part.type==="toolCall");await s.host.handleEvent({type:"message_end",message:final});}
							if(event.type==="error") {
								// This seam fixture projects only original tool rows, creating controlled adjacency across source turns.
								// The scripted turn has no prose answer; its terminal no-answer is not a row-admission event.
								if(rowOnlyTerminal&&event.error.errorMessage===COPY["no-answer"])return {};
								throw new Error(event.error.errorMessage);
							}
						}
						return {final,call};
					};
					const round=async()=>{
						const {final,call}=await stream([user]);expect(call).toBeDefined();expect(call.arguments.threadId).toBe("");
						await s.host.handleEvent({type:"tool_execution_start",toolCallId:call.id,toolName:call.name,args:call.arguments});s.draw();
						let result:any;let isError=false;try{result=await(s.definitions.get(call.name) as any).execute(call.id,structuredClone(call.arguments),undefined,undefined,ctx);}catch(error){if(!(error instanceof RowError))throw error;result={content:[{type:"text",text:error.message}],details:{}};isError=true;}
						await s.host.handleEvent({type:"tool_execution_end",toolCallId:call.id,toolName:call.name,result,isError});
						await stream([user,final,{role:"toolResult",toolCallId:call.id,toolName:call.name,...result,isError,timestamp:2}],true);return call;
					};
					await round();expect(s.headers()).toHaveLength(1);
					const first=seen.find((m)=>m.kind==="membership");
					if(replaceClient){await handlers.get("session_before_switch")({type:"session_before_switch"},ctx);expect(s.headers()).toEqual([]);}
					await round();const records=seen.filter((m)=>m.kind==="membership"&&m.revision===1);const last=records.at(-1);
					if(replaceClient){expect(last.clientGeneration).not.toBe(first.clientGeneration);expect(last.toolCallId).toBe(first.toolCallId);s.events.emit(SHELL_DISPLAY_CHANNEL,first);expect(s.headers()).toHaveLength(1);expect([...s.view.state.members.values()][0]!.clientGeneration).toBe(last.clientGeneration);}
					else{expect(last.clientGeneration).toBe(first.clientGeneration);expect(last.threadId).not.toBe(first.threadId);expect(s.headers()).toHaveLength(2);}
					expect(s.rows()).toHaveLength(2);
				}finally{await handlers.get("session_shutdown")?.({type:"session_shutdown"},ctx);if(saved===undefined)delete process.env.RBF_FAKE_SCENARIO;else process.env.RBF_FAKE_SCENARIO=saved;rmSync(work,{recursive:true,force:true});}
			}
		});

		/** Members in the states the collapsed renders show, made the way each state is reached live. */
		async function member(s: ReturnType<typeof stage>, id: string, state: string) {
			const [kind, identity] = state.split(":");
			await s.begin(id);
			switch (kind) {
				case "ran":
					s.tell(id, ...RAN);
					return s.end(id, "ok\n");
				case "failed":
					s.tell(id, ...FAILED);
					return s.end(id, "boom\n\nCommand exited with code 1", true);
				case "running":
					return s.tell(id, { kind: "start" });
				case "waiting":
					return;
				case "background":
					s.tell(id, { kind: "start" }, { kind: "background", identity: identity! });
					return s.end(id, "[Process running in background]\n");
				case "cancelled":
					s.tell(id, { kind: "start" }, { kind: "stop-request", reason: "cancel" }, { kind: "close", code: null, signal: "SIGTERM" });
					return s.end(id, "Operation aborted", true);
				case "not run":
					s.tell(id, { kind: "not-run" });
					return s.end(id, "refused", true);
				case "unknown":
					s.tell(id, ...GONE);
					return s.end(id, "ok\n");
				case "error":
					s.tell(id, ...GONE);
					return s.end(id, "EPIPE", true);
			}
		}

		const toolCall = (id: string, command: string) => ({ type: "toolCall", id, name: "bash", arguments: { command } });
		const assistant = (text: string, ...calls: unknown[]) => ({ role: "assistant", content: [{ type: "text", text }, ...calls], stopReason: calls.length ? "toolUse" : "stop" });
		const toolResult = (id: string, text: string, isError = false) => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], isError });
		/** The drawn lines from the first line of prose on: Pi's own message rows start with a blank row the renders don't show. */
		const fromFirstProse = (lines: string[]) => lines.slice(lines.findIndex((line) => line !== ""));

		it(`runs on Pi ${process.env.PI_HOST_PACKAGE ? "from PI_HOST_PACKAGE" : "from the repository"}`, () => {
			console.log(`view components host: Pi ${VERSION}`);
			expect(typeof VERSION).toBe("string");
			if (!process.env.PI_HOST_PACKAGE) expect(VERSION).toBe("0.85.1");
		});

		describe("pi-52 MCP evidence and native admission", () => {
			function nativeMcp(s: ReturnType<typeof stage>, alias = "Custom Notes") {
				const definition = { ...s.bash, name: "mcp_sanitized_hash", renderCall: undefined, renderResult: undefined };
				s.definitions.set(definition.name, definition);
				(s.view as any).stop();
				const metadata = [{name:definition.name,sourceInfo:{path:"builtin:mcp",source:"builtin"},namespace:{aliases:[alias]}}];
				const view = createShellGroupsView({events:s.events,getAllTools:()=>metadata} as any);
				view.start(s.ctx); (s as any).view=view;
				return {definition,metadata,view};
			}
			it("admits native MCP by exact provenance and follows native start/final error", async () => {
				const s=stage();const n=nativeMcp(s);
				await s.host.handleEvent({type:"tool_execution_start",toolCallId:"m1",toolName:n.definition.name,args:{query:"example"}});
				expect(s.headers()).toEqual([" ▸ Custom Notes: 1 call · active"]);
				await s.host.handleEvent({type:"tool_execution_update",toolCallId:"m1",toolName:n.definition.name,partialResult:{content:[{type:"text",text:"completed"}]}});
				expect(s.headers()).toEqual([" ▸ Custom Notes: 1 call · active"]);
				await s.host.handleEvent({type:"tool_execution_end",toolCallId:"m1",toolName:n.definition.name,result:{content:[],details:{server:"Custom Notes",tool:"search"}},isError:true});
				expect(s.headers()).toEqual([" ▸ called Custom Notes 1 time · 1 failed"]);
				const children=[...s.chat.children];s.click(s.headerRow());
				expect(s.chat.children).toEqual(children);
				expect(s.draw().slice(2)).toEqual(s.native());
			});
			it("a native assistant abort/error without a final tool result remains unknown with its error",async()=>{
				const s=stage();const n=nativeMcp(s);const call={type:"toolCall",id:"m1",name:n.definition.name,arguments:{query:"fixture"}};
				const message={role:"assistant",content:[call],stopReason:"toolUse"};
				await s.host.handleEvent({type:"message_start",message});await s.host.handleEvent({type:"message_update",message,assistantMessageEvent:{type:"toolcall_start",contentIndex:0,partial:message}});
				expect(s.headers()).toEqual([" ▸ Custom Notes: 1 call · pending"]);
				await s.host.handleEvent({type:"message_end",message:{...message,stopReason:"aborted"}});
				expect(s.headers()).toEqual([" ▸ Custom Notes: 1 call · error · status unknown"]);
				const member=[...n.view.state.members.values()][0]!;expect(member.hasResult).toBe(false);expect(member.mcp!.evidence.state).toBe("unknown");
			});

			it("keeps replaced metadata and renderers native from first admission", async () => {
				const s=stage();const n=nativeMcp(s);n.metadata[0]!.sourceInfo.path="extension:pretend";
				await s.host.handleEvent({type:"tool_execution_start",toolCallId:"m1",toolName:n.definition.name,args:{}});
				expect(s.headers()).toEqual([]);
				n.metadata[0]!.sourceInfo.path="builtin:mcp";s.rows()[0].toolDefinition={...n.definition,renderCall:()=>new Text("custom",0,0)};
				expect(s.headers()).toEqual([]);
			});
			it("1,000 MCP members and 100 output updates copy no output and do not regroup", async () => {
				const s=stage();const n=nativeMcp(s);
				for(let i=0;i<1000;i++) {
					if(i>0&&i%100===0)s.prose(`Batch ${i/100}`);
					await s.host.handleEvent({type:"tool_execution_start",toolCallId:`m${i}`,toolName:n.definition.name,args:{}});
				}
				expect(s.headers()).toHaveLength(10);expect(n.view.state.members.size).toBe(1000);
				const reconciliations=n.view.state.reconciliations;const updates=n.view.state.groups.map((group)=>group.updates);
				const render=vi.spyOn(ToolExecutionComponent.prototype,"render");
				for(let i=0;i<100;i++) {
					await s.host.handleEvent({type:"tool_execution_update",toolCallId:"m437",toolName:n.definition.name,partialResult:{content:[{type:"text",text:"MCP-OUTPUT-MARKER".repeat(i+1)}]}});s.draw();
				}
				expect(render).not.toHaveBeenCalled();render.mockRestore();
				expect(n.view.state.reconciliations).toBe(reconciliations);expect(n.view.state.groups.map((group)=>group.updates)).toEqual(updates);
				expect(JSON.stringify([...n.view.state.members.values()].map(({nativeRow,...rest})=>rest))).not.toContain("MCP-OUTPUT-MARKER");
			},60_000);

			it("captures the server alias and refuses relabelling on reconnect", async () => {
				const s=stage();const n=nativeMcp(s);
				await s.host.handleEvent({type:"tool_execution_start",toolCallId:"m1",toolName:n.definition.name,args:{}});
				expect(s.headers()).toHaveLength(1);
				n.metadata[0]!.namespace.aliases=["Other"];
				expect(s.headers()).toEqual([" ▸ Custom Notes: 1 call · active"]);
			});
		});

		describe("layout", () => {
			it("render 11: two commands that ran, expanded at 100 columns", async () => {
				const s = stage();
				s.prose("Running two quick checks.");
				await s.run("c1", ALPHA, "alpha\nbeta\n");
				await s.run("c2", LONG, `before\n${WORDS}\nafter\n`);
				s.prose("Both printed what I expected.");
				expect(s.draw(100).slice(0, 5)).toEqual([" Running two quick checks.", "", " ▸ ran 2 shell commands", "", " Both printed what I expected."]);
				s.click(2);
				expect(s.draw(100)).toEqual([
					" Running two quick checks.",
					"",
					" ▾ ran 2 shell commands",
					"",
					"",
					" $ printf 'alpha\\nbeta\\n'",
					" └  alpha",
					"    beta",
					"",
					"    Took 0.0s",
					"",
					"",
					"",
					" $ echo before; echo 'word01 word02 word03 word04 word05 word06 word07 word08 word09 word10 word11",
					" word12 word13 word14 word15 word16 word17 word18 word19 word20 word21 word22 word23 word24 word25",
					" word26 word27 word28 word29 word30 word31 word32 word33 word34 word35'; echo after",
					" └  before",
					"    word01 word02 word03 word04 word05 word06 word07 word08 word09 word10 word11 word12 word13",
					"    word14 word15 word16 word17 word18 word19 word20 word21 word22 word23 word24 word25 word26",
					"    word27 word28 word29 word30 word31 word32 word33 word34 word35",
					"    after",
					"",
					"    Took 0.0s",
					"",
					"",
					" Both printed what I expected.",
				]);
			});

			it("render 13: two restored members with no proof they ended, expanded at 100 columns", () => {
				const s = stage();
				const ECHOES = "echo one; echo two; echo three; exit 1";
				s.host.renderSessionItems([
					assistant("Running two quick checks.", toolCall("r1", ALPHA), toolCall("r2", ECHOES)),
					toolResult("r1", "alpha\nbeta\n"),
					assistant("I'll run the second check again."),
				]);
				expect(fromFirstProse(s.draw(100))).toEqual([" Running two quick checks.", "", " ▸ 2 shell commands · status unknown", "", " I'll run the second check again."]);
				s.click(s.headerRow());
				expect(fromFirstProse(s.draw(100))).toEqual([
					" Running two quick checks.",
					"",
					" ▾ 2 shell commands · status unknown",
					"",
					"",
					" $ printf 'alpha\\nbeta\\n'",
					" └  alpha",
					"    beta",
					"",
					"",
					"",
					" $ echo one; echo two; echo three; exit 1",
					"",
					"    No recorded result",
					"",
					" I'll run the second check again.",
				]);
			});

			it("render 14: one command ran and one has no proof it ended, expanded at 100 columns", async () => {
				const s = stage();
				s.prose("Running two quick checks.");
				await s.run("c1", ALPHA, "alpha\nbeta\n");
				await s.run("c2", LONG, `before\n${WORDS}\nafter\n`, GONE);
				s.prose("I can't tell whether the second one finished. I'll run it again.");
				s.draw(100);
				s.click(s.headerRow());
				expect(s.draw(100)).toEqual([
					" Running two quick checks.",
					"",
					" ▾ 2 shell commands · 1 unknown",
					"",
					"",
					" $ printf 'alpha\\nbeta\\n'",
					" └  alpha",
					"    beta",
					"",
					"    Took 0.0s",
					"",
					"",
					"",
					" $ echo before; echo 'word01 word02 word03 word04 word05 word06 word07 word08 word09 word10 word11",
					" word12 word13 word14 word15 word16 word17 word18 word19 word20 word21 word22 word23 word24 word25",
					" word26 word27 word28 word29 word30 word31 word32 word33 word34 word35'; echo after",
					" └  before",
					"    word01 word02 word03 word04 word05 word06 word07 word08 word09 word10 word11 word12 word13",
					"    word14 word15 word16 word17 word18 word19 word20 word21 word22 word23 word24 word25 word26",
					"    word27 word28 word29 word30 word31 word32 word33 word34 word35",
					"    after",
					"",
					"    Took 0.0s",
					"",
					"    Status unknown",
					"",
					" I can't tell whether the second one finished. I'll run it again.",
				]);
			});

			const COLLAPSED: [string, number, string, string[], string | undefined, string[]][] = [
				["01", 80, "I'll check the working tree and run the tests.", ["ran", "ran", "ran"], "The tree is clean and all tests pass.", [" ▸ ran 3 shell commands"]],
				["02", 80, "I'll check the working tree and run the tests.", ["ran", "ran", "running"], undefined, [" ▸ 3 shell commands · 1 running"]],
				["03", 80, "I need to install one dependency first.", ["waiting"], undefined, [" ▸ waiting for 1 shell command"]],
				["04", 80, "I'll check the working tree and run the tests.", ["ran", "failed", "ran"], "One test fails. I'll read it next.", [" ▸ ran 3 shell commands · 1 failed"]],
				["05", 80, "I'll start the dev server and check the port.", ["background:task-123", "ran"], "The dev server is running in the background.", [" ▸ 2 shell commands · 1 background", "    Task ID: task-123"]],
				["06", 80, "I'll run the three migration steps.", ["ran", "cancelled", "not run"], undefined, [" ▸ 3 shell commands · 1 cancelled · 1 not run"]],
				["08", 40, "I'll start the server and run checks.", ["ran", "background:task-123", "ran", "failed", "ran", "running"], undefined, [" ▸ 6 shell commands · 1 running", "    1 background · 1 failed", "    Task ID: task-123"]],
				[
					"09",
					120,
					"I'll run the whole batch.",
					["ran", "background:task-123", "failed", "error", "cancelled", "not run", "unknown", "background:task-124", "unknown", "ran", "waiting", "running"],
					undefined,
					[
						" ▸ 12 shell commands · 1 running · 2 background · 1 failed · 1 error (status unknown) · 1 cancelled · 1 not run",
						"    1 waiting · 2 unknown",
						"    Task ID: task-123",
						"    Task ID: task-124",
					],
				],
				[
					"10",
					40,
					"I'll run the whole batch.",
					["ran", "background:task-123", "failed", "error", "cancelled", "not run", "unknown", "background:task-124", "unknown", "ran", "waiting", "running"],
					undefined,
					[
						" ▸ 12 shell commands · 1 running",
						"    2 background · 1 failed",
						"    1 error (status unknown)",
						"    1 cancelled · 1 not run · 1 waiting",
						"    2 unknown",
						"    Task ID: task-123",
						"    Task ID: task-124",
					],
				],
			];
			it.each(COLLAPSED)("render %s: collapsed at %i columns", async (_name, width, before, states, after, group) => {
				const s = stage();
				s.prose(before);
				for (const [i, state] of states.entries()) await member(s, `c${i}`, state);
				if (after) s.prose(after);
				expect(s.draw(width)).toEqual([` ${before}`, "", ...group, ...(after ? ["", ` ${after}`] : [])]);
			});

			it("the group's lines leave the pane's last column free, as Pi's rows do", async () => {
				const s = stage();
				for (const [i, state] of ["ran", "ran", "running"].entries()) await member(s, `c${i}`, state);
				// The header is 31 cells wide: it fits a 32-column pane and wraps in a 31-column one.
				expect(s.draw(32)).toEqual(["", " ▸ 3 shell commands · 1 running"]);
				expect(s.draw(31)).toEqual(["", " ▸ 3 shell commands", "    1 running"]);
			});

			it("render 07: a resumed session reads status unknown on every earlier group, at 80 columns", () => {
				const s = stage();
				s.host.renderSessionItems([
					assistant("I'll check the working tree and run the tests.", toolCall("a1", "git status"), toolCall("a2", "bun test")),
					toolResult("a1", "clean\n"),
					toolResult("a2", "2 fail\n"),
					assistant("Two tests fail. I'll rerun the slow one.", toolCall("b1", "bun test slow"), toolCall("b2", "bun test slow"), toolCall("b3", "bun test")),
					toolResult("b1", "ok\n"),
					toolResult("b2", "Command exited with code 1", true),
					toolResult("b3", "ok\n"),
					assistant("Fixed. Running the full suite once more.", toolCall("c1", "bun test")),
					toolResult("c1", "ok\n"),
					assistant("All green."),
				]);
				expect(fromFirstProse(s.draw(80))).toEqual([
					" I'll check the working tree and run the tests.",
					"",
					" ▸ 2 shell commands · status unknown",
					"",
					" Two tests fail. I'll rerun the slow one.",
					"",
					" ▸ 3 shell commands · 1 error (status unknown) · 2 unknown",
					"",
					" Fixed. Running the full suite once more.",
					"",
					" ▸ 1 shell command · status unknown",
					"",
					" All green.",
				]);
			});

			it("an expanded member is the row's own drawing, line for line, with and without the indent extension", async () => {
				for (const indent of [true, false]) {
					if (!indent) restoreToolPartsIndent();
					const s = stage();
					s.prose("Two checks.");
					await s.run("c1", ALPHA, "alpha\nbeta\n");
					await s.run("c2", "exit 1", "one\n\n\nCommand exited with code 1", FAILED, true);
					s.prose("Done.");
					s.draw(100);
					s.click(s.headerRow());
					const [first, second] = s.rows();
					const own = (row: any) => (row.render(100) as string[]).map(clean);
					expect(s.draw(100)).toEqual([" Two checks.", "", " ▾ ran 2 shell commands · 1 failed", ...own(first), ...own(second), "", " Done."]);
					const branch = s.draw(100).filter((line) => line.startsWith(" └"));
					expect(branch).toHaveLength(indent ? 2 : 0);
					// Without the extension members draw flush, as Pi draws them alone: the output under the command starts at column 1.
					expect(s.draw(100)).toContain(indent ? "    beta" : " beta");
					s.view.stop();
				}
			});

			it("a collapsed group draws none of its members, and nothing in the container moves", async () => {
				const s = stage();
				await s.run("c1");
				await s.run("c2");
				const children = [...s.chat.children];
				const pending = new Map(s.host.pendingTools);
				const drawn = vi.spyOn(ToolExecutionComponent.prototype, "render");
				expect(s.draw()).toEqual(["", " ▸ ran 2 shell commands"]);
				expect(drawn).not.toHaveBeenCalled();
				drawn.mockRestore();
				expect(s.chat.children).toEqual(children);
				s.chat.children.forEach((child: unknown, i: number) => expect(child).toBe(children[i]));
				expect(new Map(s.host.pendingTools)).toEqual(pending);
			});

			it("no shell rows draw no header", () => {
				const s = stage();
				s.prose("Nothing to run.");
				expect(s.draw()).toEqual([" Nothing to run."]);
				expect(s.draw()).toEqual(s.native());
			});
		});

		describe("eligibility", () => {
			it("with no owner announced every row is Pi's own", async () => {
				const s = stage({ announce: false });
				await s.begin("c1");
				await s.end("c1", "/work\n");
				expect(s.draw()).toEqual(s.native());
				expect(s.headers()).toEqual([]);
				expect(s.notify).not.toHaveBeenCalled();
			});

			it("the view first, the owner later: rows drawn natively become a group when the owner announces", async () => {
				const s = stage({ announce: false });
				await s.begin("c1");
				await s.end("c1", "/work\n");
				expect(s.headers()).toEqual([]);
				s.requestRender.mockClear();
				s.owner.start(SESSION, s.bash);
				expect(s.requestRender).toHaveBeenCalled();
				// A late owner can make the row eligible. It cannot prove how a call it never watched ended.
				expect(s.headers()).toEqual([" ▸ 1 shell command · status unknown"]);
			});

			it("the owner first, the view later: the view asks, and the owner answers with its announce and what it kept", async () => {
				const events = createEventBus();
				const bash: any = createBashToolDefinition("/work");
				const owner = createShellDisplayOwner<ShellDisplayFact>(events, "pi-bash", (fact) => fact.kind === "close")!;
				owner.start(SESSION, bash);
				const early = owner.open("c1")!;
				for (const fact of RAN) early.tell(fact);
				const s = stage({ events, announce: false });
				// The stage built its own definition; the row must carry the one the first owner announced.
				s.definitions.set("bash", bash);
				await s.begin("c1");
				await s.end("c1", "/work\n");
				expect(s.headers()).toEqual([" ▸ ran 1 shell command"]);
			});

			it("a withdrawal returns the rows to Pi, and a new announcement groups them again without their old proof", async () => {
				const s = stage();
				await s.run("c1");
				expect(s.headers()).toEqual([" ▸ ran 1 shell command"]);
				s.owner.stop();
				expect(s.headers()).toEqual([]);
				expect(s.draw()).toEqual(s.native());
				s.owner.start(SESSION, s.bash);
				expect(s.headers()).toEqual([" ▸ 1 shell command · status unknown"]);
			});

			it("an owner replaced by a new generation leaves what was still running unknown", async () => {
				const s = stage();
				await s.begin("c1");
				s.tell("c1", { kind: "start" });
				expect(s.headers()).toEqual([" ▸ running 1 shell command"]);
				s.owner.start(SESSION, s.bash);
				expect(s.headers()).toEqual([" ▸ 1 shell command · status unknown"]);
			});

			it("a second row carrying a member's call id is not grouped twice: one header, and the second row is Pi's own", async () => {
				const s = stage();
				await s.run("c1");
				// A row Pi built for the same call id, with its own result.
				const twin: any = new ToolExecutionComponent("bash", "c1", { command: "pwd" }, {}, s.host.getRegisteredToolDefinition("bash"), s.host.ui, "/work");
				twin.updateResult({ content: [{ type: "text", text: "from the twin\n" }], isError: false });
				s.chat.addChild(twin);
				const own = (twin.render(80) as string[]).map(clean);
				expect(own.some((line) => line.includes("from the twin"))).toBe(true);
				expect(s.draw()).toEqual(["", " ▸ ran 1 shell command", ...own]);
				expect(s.view.state.members.size).toBe(1);
				// Open, the member is drawn once, by the first row, and the twin stays where Pi put it.
				s.click(s.headerRow());
				const [first] = s.rows();
				expect(s.draw()).toEqual(["", " ▾ ran 1 shell command", ...(first.render(80) as string[]).map(clean), ...(twin.render(80) as string[]).map(clean)]);
			});

			it("an announcement under a new generation with no withdrawal before it leaves what was still running unknown", async () => {
				const s = stage();
				await s.begin("c1");
				s.tell("c1", { kind: "start" });
				await s.run("c2");
				expect(s.headers()).toEqual([" ▸ 2 shell commands · 1 running"]);
				// The old owner died without a word; the new one simply announces itself.
				s.events.emit(SHELL_DISPLAY_CHANNEL, { kind: "announce", sessionId: SESSION, source: "pi-bash", toolName: "bash", ownerGeneration: "pi-bash:replacement", execute: s.bash.execute, renderCall: s.bash.renderCall, renderResult: s.bash.renderResult });
				// What the old owner proved stays proved; what it was still watching is unknown.
				expect(s.headers()).toEqual([" ▸ 2 shell commands · 1 unknown"]);
				// And nothing more from the old generation is taken.
				s.tell("c1", ...RAN.slice(1));
				expect(s.headers()).toEqual([" ▸ 2 shell commands · 1 unknown"]);
			});

			it("a fact of a kind the view doesn't know, or one that is no fact at all, changes nothing and the view stays", async () => {
				const s = stage();
				await s.begin("c1");
				s.tell("c1", { kind: "start" });
				expect(s.headers()).toEqual([" ▸ running 1 shell command"]);
				const generation = s.view.state.owners.get("pi-bash");
				const send = (revision: unknown, fact: unknown, over: Record<string, unknown> = {}) =>
					s.events.emit(SHELL_DISPLAY_CHANNEL, { kind: "fact", sessionId: SESSION, source: "pi-bash", ownerGeneration: generation, toolCallId: "c1", revision, fact, ...over });
				send(2, { kind: "paused", until: 3 });
				send(3, undefined);
				send(4, "close");
				send(5, { kind: "background" });
				send(6, { kind: "close" });
				send("7", { kind: "close", code: 0, signal: null });
				send(8, { kind: "close", code: 0, signal: null }, { toolCallId: 7 });
				expect(s.headers()).toEqual([" ▸ running 1 shell command"]);
				expect(s.view.fault).toBeUndefined();
				await tick();
				expect(s.notify).not.toHaveBeenCalled();
				// A fact it does know, after all of those, still lands.
				send(9, { kind: "close", code: 0, signal: null });
				expect(s.headers()).toEqual([" ▸ ran 1 shell command"]);
			});

			it("an announcement for another session makes nothing eligible", async () => {
				const s = stage({ announce: false });
				s.owner.start("another-session", s.bash);
				await s.begin("c1");
				expect(s.headers()).toEqual([]);
			});

			it.each([
				["a renderer-only overlay with no execute", (bash: any) => ({ name: "bash", renderCall: bash.renderCall, renderResult: bash.renderResult })],
				["another execute under the same name", (bash: any) => ({ ...bash, execute: async () => ({ content: [] }) })],
				["a wrapped result renderer", (bash: any) => ({ ...bash, renderResult: (...args: any[]) => bash.renderResult(...args) })],
				["a wrapped call renderer", (bash: any) => ({ ...bash, renderCall: (...args: any[]) => bash.renderCall(...args) })],
				["a tool that draws its own shell", (bash: any) => ({ ...bash, renderShell: "self" })],
			])("%s stays Pi's own row, silently", async (_name, replace) => {
				const s = stage();
				s.definitions.set("bash", replace(s.bash));
				await s.begin("c1");
				await s.end("c1", "/work\n");
				expect(s.headers()).toEqual([]);
				expect(s.draw()).toEqual(s.native());
				expect(s.notify).not.toHaveBeenCalled();
			});

			it("a row that is not a member ends the group before it and starts none", async () => {
				const s = stage();
				await s.run("c1");
				s.definitions.set("read", { name: "read", execute: async () => ({ content: [] }), renderCall: () => new Text("read a.ts", 0, 0), renderResult: () => new Text("", 0, 0) });
				await s.host.handleEvent({ type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: { path: "a.ts" } });
				await s.run("c2");
				await s.run("c3");
				expect(s.headers()).toEqual([" ▸ ran 1 shell command", " ▸ ran 2 shell commands"]);
				expect(s.draw().some((line) => line.includes("read a.ts"))).toBe(true);
			});

			it("a sandbox launch attaches nothing: no handler, no wrapper, no view", () => {
				expect(isSandboxLaunch(["--sandbox"])).toBe(true);
				expect(isSandboxLaunch([])).toBe(false);
				const pi: any = { events: createEventBus(), on: vi.fn() };
				rbfShellCommandGroups(pi, { argv: ["--model", "x", "--sandbox"] });
				expect(pi.on).not.toHaveBeenCalled();
				expect((globalThis as any)[VIEW_KEY]).toBeUndefined();
				for (const name of HOST_METHODS) expect((InteractiveMode.prototype as any)[name]).toBe(pristine[name]);
			});

			it("the entry point attaches on load, starts on session_start and leaves on session_shutdown", async () => {
				const handlers = new Map<string, Function>();
				const pi: any = { events: createEventBus(), on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)) };
				rbfShellCommandGroups(pi, { argv: [] });
				expect([...handlers.keys()]).toEqual(["session_start", "session_shutdown"]);
				expect((globalThis as any)[VIEW_KEY]).toBeDefined();
				for (const name of HOST_METHODS) expect((InteractiveMode.prototype as any)[name]).not.toBe(pristine[name]);
				handlers.get("session_start")!({}, { mode: "tui", ui: { notify: vi.fn() }, sessionManager: { getSessionId: () => SESSION } });
				handlers.get("session_shutdown")!();
				expect((globalThis as any)[VIEW_KEY]).toBeUndefined();
				for (const name of HOST_METHODS) expect((InteractiveMode.prototype as any)[name]).toBe(pristine[name]);
			});
		});

		describe("the real Pi owner", () => {
			afterEach(() => {
				unpatchBashExecutionComponent();
				unpatchFooterComponent();
				setActiveTaskManager(null);
			});

			it.each([["owner first"], ["view first"]])("a command run through rbf-background-tasks groups and reports as it runs (%s)", async (order) => {
				const events = createEventBus();
				const handlers = new Map<string, Function[]>();
				let tool: any;
				const pi: any = {
					events,
					on: (event: string, handler: Function) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
					registerCommand: vi.fn(),
					registerTool: (registered: any) => {
						tool = registered;
					},
				};
				const { host, requestRender } = makeHost(new Map());
				const ctx: any = { mode: "tui", hasUI: false, ui: { notify: vi.fn(), setWorkingMessage: vi.fn(), setStatus: vi.fn(), requestRender }, sessionManager: { getSessionId: () => SESSION, getSessionFile: () => "/tmp/s1.json" } };
				const load = { owner: () => rbfBackgroundTasks(pi, { argv: [] }), view: () => rbfShellCommandGroups(pi, { argv: [] }) };
				for (const part of order === "owner first" ? (["owner", "view"] as const) : (["view", "owner"] as const)) load[part]();
				host.runtimeHost.session.getToolDefinition = (name: string) => (name === "bash" ? tool : undefined);
				for (const handler of handlers.get("session_start")!) await handler({}, ctx);
				const headers = () => (host.chatContainer.render(80) as string[]).map(clean).filter((line) => line.startsWith(" ▸"));
				try {
					/** Pi's loop for one call: the start event, the tool's own execute, the end event. */
					const call = async (id: string, command: string) => {
						await host.handleEvent({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command } });
						const settled = await tool.execute(id, { command }, new AbortController().signal, vi.fn(), ctx).then(
							(result: any) => ({ result, isError: false }),
							(error: Error) => ({ result: { content: [{ type: "text", text: error.message }] }, isError: true }),
						);
						await host.handleEvent({ type: "tool_execution_end", toolCallId: id, toolName: "bash", ...settled });
					};
					await call("c1", "echo hi");
					expect(headers()).toEqual([" ▸ ran 1 shell command"]);
					await call("c2", "echo 'Status: completed'; exit 3");
					expect(headers()).toEqual([" ▸ ran 2 shell commands · 1 failed"]);
					await host.handleEvent({ type: "tool_execution_start", toolCallId: "c3", toolName: "bash", args: { command: "sleep 0.3" } });
					expect(headers()).toEqual([" ▸ 3 shell commands · 1 failed · 1 waiting"]);
					const running = tool.execute("c3", { command: "sleep 0.3" }, new AbortController().signal, vi.fn(), ctx);
					await vi.waitFor(() => expect(headers()).toEqual([" ▸ 3 shell commands · 1 running · 1 failed"]));
					await host.handleEvent({ type: "tool_execution_end", toolCallId: "c3", toolName: "bash", result: await running, isError: false });
					expect(headers()).toEqual([" ▸ ran 3 shell commands · 1 failed"]);
				} finally {
					for (const handler of handlers.get("session_shutdown")!) await handler();
				}
				expect((globalThis as any)[VIEW_KEY]).toBeUndefined();
			});
		});

		describe("disclosure", () => {
			it("a new group follows the global setting", async () => {
				const s = stage();
				s.host.toolOutputExpanded = true;
				await s.run("c1");
				expect(s.headers()).toEqual([" ▾ ran 1 shell command"]);
				expect(s.rows()[0].expanded).toBe(true);
			});

			it("a header click opens one group, sets its members' own flags, and leaves the global setting and other groups alone", async () => {
				const s = stage();
				await s.run("c1");
				await s.run("c2");
				s.prose("Between.");
				await s.run("c3");
				s.click(s.headerRow(0));
				expect(s.headers()).toEqual([" ▾ ran 2 shell commands", " ▸ ran 1 shell command"]);
				expect(s.rows().map((row) => row.expanded)).toEqual([true, true, false]);
				expect(s.host.toolOutputExpanded).toBe(false);
				s.click(s.headerRow(0));
				expect(s.headers()).toEqual([" ▸ ran 2 shell commands", " ▸ ran 1 shell command"]);
				expect(s.rows().map((row) => row.expanded)).toEqual([false, false, false]);
			});

			it("a member appended to an open group opens with it; one appended to a closed group stays closed", async () => {
				const s = stage();
				await s.run("c1");
				s.click(s.headerRow());
				await s.run("c2");
				expect(s.headers()).toEqual([" ▾ ran 2 shell commands"]);
				expect(s.rows().map((row) => row.expanded)).toEqual([true, true]);
				s.click(s.headerRow());
				s.host.toolOutputExpanded = true;
				await s.run("c3");
				expect(s.headers()).toEqual([" ▸ ran 3 shell commands"]);
				expect(s.rows().map((row) => row.expanded)).toEqual([false, false, false]);
			});

			it("the global setting opens and closes every group through Pi's own method, called once", async () => {
				const s = stage();
				await s.run("c1");
				s.prose("Between.");
				await s.run("c2");
				const original = vi.spyOn(s.host, "showStatus");
				expect(s.host.setToolsExpanded(true)).toBeUndefined();
				expect(original).toHaveBeenCalledTimes(1);
				expect(s.host.toolOutputExpanded).toBe(true);
				expect(s.headers()).toEqual([" ▾ ran 1 shell command", " ▾ ran 1 shell command"]);
				s.host.setToolsExpanded(false);
				expect(s.headers()).toEqual([" ▸ ran 1 shell command", " ▸ ran 1 shell command"]);
				expect(original).toHaveBeenCalledTimes(2);
			});

			it("a global request closes a group opened by hand even when Pi's flag already matches and Pi returns early", async () => {
				const s = stage();
				await s.run("c1");
				s.click(s.headerRow());
				expect(s.headers()).toEqual([" ▾ ran 1 shell command"]);
				const status = vi.spyOn(s.host, "showStatus");
				s.requestRender.mockClear();
				s.host.setToolsExpanded(false);
				expect(status).not.toHaveBeenCalled(); // Pi's own method returned early
				expect(s.requestRender).toHaveBeenCalled();
				expect(s.headers()).toEqual([" ▸ ran 1 shell command"]);
				expect(s.rows()[0].expanded).toBe(false);
			});

			it("and opens a group closed by hand when the flag is already true", async () => {
				const s = stage();
				await s.run("c1");
				s.host.setToolsExpanded(true);
				s.click(s.headerRow());
				expect(s.headers()).toEqual([" ▸ ran 1 shell command"]);
				s.host.setToolsExpanded(true);
				expect(s.headers()).toEqual([" ▾ ran 1 shell command"]);
				expect(s.rows()[0].expanded).toBe(true);
			});

			it("Pi's own assistant row between two calls: nothing while it holds only tool calls, a barrier once text arrives, and a barrier as thinking, shown or hidden behind its label", async () => {
				const s = stage();
				await s.run("c1");
				// A tool-only turn: Pi adds the assistant row, and it draws no line.
				const message: any = { role: "assistant", content: [toolCall("c2", "pwd")], stopReason: "toolUse" };
				s.host.addMessageToChat(message);
				const row = s.chat.children.at(-1);
				expect(row.constructor.name).toBe("AssistantMessageComponent");
				expect(row.render(80)).toEqual([]);
				await s.run("c2");
				s.click(s.headerRow());
				expect(s.headers()).toEqual([" ▾ ran 2 shell commands"]);
				// Text streams into that row late: the group splits around it, the prose stays where Pi drew it, and both halves stay open.
				message.content = [{ type: "text", text: "A thought, late." }, toolCall("c2", "pwd")];
				row.updateContent(message);
				expect(s.headers()).toEqual([" ▾ ran 1 shell command", " ▾ ran 1 shell command"]);
				const lines = s.draw();
				expect(lines.indexOf(" A thought, late.")).toBeGreaterThan(lines.indexOf(" ▾ ran 1 shell command"));
				expect(lines.indexOf(" A thought, late.")).toBeLessThan(lines.lastIndexOf(" ▾ ran 1 shell command"));
				// Thinking in place of the text: still a barrier while shown.
				message.content = [{ type: "thinking", thinking: "Considering." }, toolCall("c2", "pwd")];
				row.updateContent(message);
				expect(s.draw().some((line) => line.includes("Considering."))).toBe(true);
				expect(s.headers()).toHaveLength(2);
				// Hidden thinking leaves its label on screen, through Pi's own toggle: the label is a barrier too.
				s.host.hideThinkingBlock = true;
				s.host.updateThinkingBlockVisibility();
				expect(s.draw().some((line) => line.includes("Considering."))).toBe(false);
				expect(s.draw().some((line) => line.includes("Thinking..."))).toBe(true);
				expect(s.headers()).toEqual([" ▾ ran 1 shell command", " ▾ ran 1 shell command"]);
				// The row empties again: the halves merge, open.
				message.content = [toolCall("c2", "pwd")];
				row.updateContent(message);
				expect(s.headers()).toEqual([" ▾ ran 2 shell commands"]);
			});

			it("late text that splits an open group leaves both halves open, and taking it away merges them open", async () => {
				const s = stage();
				await s.run("c1");
				const late = new Text("", 1, 0);
				s.chat.addChild(late);
				await s.run("c2");
				s.click(s.headerRow());
				expect(s.headers()).toEqual([" ▾ ran 2 shell commands"]);
				late.setText("A thought, late.");
				expect(s.headers()).toEqual([" ▾ ran 1 shell command", " ▾ ran 1 shell command"]);
				expect(s.draw()).toContain(" A thought, late.");
				s.click(s.headerRow(1));
				late.setText("");
				expect(s.headers()).toEqual([" ▾ ran 2 shell commands"]);
			});
		});

		describe("mouse routing", () => {
			it("press, release and the click Pi makes from them toggle the header once, and ask for no focus or capture", async () => {
				const s = stage();
				await s.run("c1");
				const y = s.headerRow();
				expect(s.mouse("press", y)).toBeUndefined();
				expect(s.mouse("release", y)).toBeUndefined();
				expect(s.headers()).toEqual([" ▸ ran 1 shell command"]);
				const result = s.mouse("click", y);
				expect(result).toMatchObject({ handled: true });
				expect(result.focus).toBeUndefined();
				expect(result.capture).toBeUndefined();
				expect(result.focusTarget).toBeUndefined();
				expect(s.headers()).toEqual([" ▾ ran 1 shell command"]);
			});

			it("a click Pi reports with button none toggles too", async () => {
				const s = stage();
				await s.run("c1");
				const y = s.headerRow();
				s.mouse("press", y);
				s.mouse("release", y, { button: "none" });
				expect(s.mouse("click", y, { button: "none" })).toMatchObject({ handled: true });
				expect(s.headers()).toEqual([" ▾ ran 1 shell command"]);
			});

			it("two separate clicks on the header toggle it twice", async () => {
				const s = stage();
				await s.run("c1");
				const y = s.headerRow();
				s.click(y, { clickCount: 1 });
				expect(s.headers()).toEqual([" ▾ ran 1 shell command"]);
				s.click(y, { clickCount: 2 });
				expect(s.headers()).toEqual([" ▸ ran 1 shell command"]);
			});

			it("a header toggles while its commands are still running", async () => {
				const s = stage();
				await s.begin("c1");
				s.tell("c1", { kind: "start" });
				const y = s.headerRow();
				s.mouse("press", y);
				// Output arrives and the frame redraws between the press and the click.
				await s.host.handleEvent({ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", partialResult: { content: [{ type: "text", text: "tick\n" }] } });
				s.draw();
				s.mouse("release", y);
				s.mouse("click", y);
				expect(s.headers()).toEqual([" ▾ running 1 shell command"]);
			});

			it.each([
				["a click with no press before it", (s: ReturnType<typeof stage>, y: number) => s.mouse("click", y)],
				["a press that became a drag", (s: ReturnType<typeof stage>, y: number) => (s.mouse("press", y), s.mouse("drag", y, { x: 9 }), s.mouse("release", y), s.mouse("click", y))],
				["a right click", (s: ReturnType<typeof stage>, y: number) => s.click(y, { button: "right" })],
				["a middle click", (s: ReturnType<typeof stage>, y: number) => s.click(y, { button: "middle" })],
				["a shift click", (s: ReturnType<typeof stage>, y: number) => s.click(y, { shift: true })],
				["a ctrl click", (s: ReturnType<typeof stage>, y: number) => s.click(y, { ctrl: true })],
				["an alt click", (s: ReturnType<typeof stage>, y: number) => s.click(y, { alt: true })],
				["a wheel turn", (s: ReturnType<typeof stage>, y: number) => s.mouse("wheel", y, { button: "none", wheelDelta: 1 })],
				["a press on the header and a click on the blank row above it", (s: ReturnType<typeof stage>, y: number) => (s.mouse("press", y), s.mouse("click", y - 1))],
			])("%s does not toggle", async (_name, gesture) => {
				const s = stage();
				s.prose("Before.");
				await s.run("c1");
				const result = gesture(s, s.headerRow());
				expect(result).toBeUndefined();
				expect(s.headers()).toEqual([" ▸ ran 1 shell command"]);
			});

			it("a resize during the press cancels it", async () => {
				const s = stage();
				await s.run("c1");
				const y = s.headerRow();
				s.mouse("press", y);
				s.chat.render(60);
				expect(s.mouse("click", y)).toBeUndefined(); // the event still carries the old width
				expect(s.mouse("click", y, { width: 60 })).toBeUndefined();
				expect(s.headers()).toEqual([" ▸ ran 1 shell command"]);
			});

			it("a rebuild during the press cancels it: a row that joins, a group that splits", async () => {
				const s = stage();
				await s.run("c1");
				const late = new Text("", 1, 0);
				s.chat.addChild(late);
				await s.run("c2");
				const y = s.headerRow();
				s.mouse("press", y);
				await s.run("c3");
				s.draw();
				expect(s.mouse("click", y)).toBeUndefined();
				expect(s.headers()).toEqual([" ▸ ran 3 shell commands"]);
				s.mouse("press", y);
				late.setText("Late.");
				s.draw();
				expect(s.mouse("click", y)).toBeUndefined();
				expect(s.headers()).toEqual([" ▸ ran 1 shell command", " ▸ ran 2 shell commands"]);
			});

			it("every line of a wrapped header toggles; an identity line and a member's status line do not", async () => {
				const s = stage();
				for (const [i, state] of ["ran", "background:task-123", "failed", "unknown", "running"].entries()) await member(s, `c${i}`, state);
				expect(s.draw(40)).toEqual(["", " ▸ 5 shell commands · 1 running", "    1 background · 1 failed · 1 unknown", "    Task ID: task-123"]);
				expect(s.click(3)).toBeUndefined();
				expect(s.draw(40)[1]).toBe(" ▸ 5 shell commands · 1 running");
				expect(s.click(2)).toMatchObject({ handled: true });
				expect(s.draw(40)[1]).toBe(" ▾ 5 shell commands · 1 running");
				const status = s.draw(40).indexOf("    Status unknown");
				expect(status).toBeGreaterThan(3);
				expect(s.click(status)).toBeUndefined();
				expect(s.draw(40)[1]).toBe(" ▾ 5 shell commands · 1 running");
				expect(s.click(1)).toMatchObject({ handled: true });
				expect(s.draw(40)[1]).toBe(" ▸ 5 shell commands · 1 running");
			});

			it("a plain click on any cell of an expanded member collapses the whole group immediately, and reopening reveals every member in order", async () => {
				const s = stage();
				await s.run("c1", ALPHA, "alpha\nbeta\n");
				await s.run("c2", LONG, `before\n${WORDS}\nafter\n`);
				s.click(s.headerRow());
				expect(s.headers()).toEqual([" ▾ ran 2 shell commands"]);
				const lines = s.draw(100);
				const c1Command = lines.findIndex((l) => l.startsWith(" $ printf 'alpha"));
				const c1Output = lines.indexOf("    beta");
				const c1Took = lines.findIndex((l, i) => i > c1Command && l.includes("Took "));
				const c1TrailPad = c1Took + 1;
				const c2Command = lines.findIndex((l) => l.startsWith(" $ echo before"));
				const c2Wrap = c2Command + 1;
				const c2Output = lines.findIndex((l, i) => i > c2Command && l.includes("    after"));
				const c2Took = lines.findIndex((l, i) => i > c2Command && l.includes("Took "));
				const c2TrailPad = c2Took + 1;

				expect(c1Command, "c1Command locate").toBeGreaterThanOrEqual(0);
				expect(c1Output, "c1Output locate").toBeGreaterThanOrEqual(0);
				expect(c1Took, "c1Took locate").toBeGreaterThanOrEqual(0);
				expect(c1TrailPad, "c1TrailPad locate").toBeGreaterThanOrEqual(0);
				expect(c2Command, "c2Command locate").toBeGreaterThanOrEqual(0);
				expect(c2Wrap, "c2Wrap locate").toBeGreaterThanOrEqual(0);
				expect(c2Output, "c2Output locate").toBeGreaterThanOrEqual(0);
				expect(c2Took, "c2Took locate").toBeGreaterThanOrEqual(0);
				expect(c2TrailPad, "c2TrailPad locate").toBeGreaterThanOrEqual(0);

				// Wrapped target line actually is a continuation line, not a new command header
				expect(lines[c2Wrap].startsWith(" $ "), "c2Wrap is continuation, not command header").toBe(false);
				expect(lines[c2Wrap].trim().length, "c2Wrap has content").toBeGreaterThan(0);

				const reached1 = vi.spyOn(s.rows()[0], "handleMouse");
				const reached2 = vi.spyOn(s.rows()[1], "handleMouse");

				const targets = [
					{ desc: "first member command", y: c1Command, x: 6 },
					{ desc: "first member indent column", y: c1Output, x: 2 },
					{ desc: "first member output", y: c1Output, x: 8 },
					{ desc: "first member leading padding", y: c1Command - 1, x: 6 },
					{ desc: "first member metadata", y: c1Took, x: 6 },
					{ desc: "first member trailing padding", y: c1TrailPad, x: 6 },
					{ desc: "later member command", y: c2Command, x: 6 },
					{ desc: "later member wrapped command line", y: c2Wrap, x: 6 },
					{ desc: "later member output", y: c2Output, x: 8 },
					{ desc: "later member metadata", y: c2Took, x: 6 },
					{ desc: "later member trailing padding", y: c2TrailPad, x: 6 },
				];

				for (const { desc, y, x } of targets) {
					expect(y, `${desc} y position`).toBeGreaterThanOrEqual(0);

					// Plain press alone changes nothing
					expect(s.mouse("press", y, { x }), `${desc} press changes nothing`).toBeUndefined();
					expect(s.headers(), `${desc} headers after press`).toEqual([" ▾ ran 2 shell commands"]);
					expect(s.draw(100).some((l) => l.startsWith(" $ printf 'alpha")), `${desc} member 1 still drawn after press`).toBe(true);
					expect(s.draw(100).some((l) => l.startsWith(" $ echo before")), `${desc} member 2 still drawn after press`).toBe(true);

					// Release and click (both button: left and button: none supported)
					for (const button of ["left", "none"] as const) {
						s.mouse("release", y, { x, button });
						const result = s.mouse("click", y, { x, button });
						expect(result, `${desc} click handled with button ${button}`).toMatchObject({ handled: true });
						expect(result.focus, `${desc} click focus with button ${button}`).toBeUndefined();
						expect(result.capture, `${desc} click capture with button ${button}`).toBeUndefined();

						// Whole group collapses immediately
						expect(s.headers(), `${desc} group header collapsed with button ${button}`).toEqual([" ▸ ran 2 shell commands"]);
						const collapsedLines = s.draw(100);
						expect(collapsedLines.some((l) => l.startsWith(" $ ")), `${desc} no member commands shown after collapse`).toBe(false);

						// Reopening reveals every member again in order
						s.click(s.headerRow());
						expect(s.headers(), `${desc} group header reopened`).toEqual([" ▾ ran 2 shell commands"]);
						const reopened = s.draw(100);
						expect(reopened.findIndex((l) => l.startsWith(" $ printf 'alpha"))).toBeLessThan(reopened.findIndex((l) => l.startsWith(" $ echo before")));

						// Re-arm for next button iteration
						s.mouse("press", y, { x });
					}
					// cancel pending press from loop
					s.mouse("release", y, { x });
				}

				// The consumed click never reached either member's own toggle handler
				expect(reached1.mock.calls.filter(([event]) => (event as any).type === "click")).toEqual([]);
				expect(reached2.mock.calls.filter(([event]) => (event as any).type === "click")).toEqual([]);
			});

			it("clicking an expanded member in one group collapses only that group, leaving other groups unchanged", async () => {
				const s = stage();
				await s.run("c1");
				s.prose("Between groups.");
				await s.run("c2");
				s.click(s.headerRow(0));
				s.click(s.headerRow(1));
				expect(s.headers()).toEqual([" ▾ ran 1 shell command", " ▾ ran 1 shell command"]);
				const lines = s.draw(80);
				const secondCommand = lines.lastIndexOf(" $ pwd");
				const result = s.click(secondCommand);
				expect(result, "second group member click handled").toMatchObject({ handled: true });
				expect(s.headers(), "only second group collapsed").toEqual([" ▾ ran 1 shell command", " ▸ ran 1 shell command"]);
			});

			it("drag, non-left, modified clicks and wheel scroll bypass whole-group collapse", async () => {
				const s = stage();
				s.prose("Before.");
				await s.run("c1", ALPHA, "alpha\nbeta\n");
				s.click(s.headerRow());
				expect(s.headers()).toEqual([" ▾ ran 1 shell command"]);
				const lines = s.draw(100);
				const y = lines.indexOf("    beta");
				expect(y).toBeGreaterThanOrEqual(0);

				// Drag bypass: press, drag, release, click
				s.mouse("press", y);
				s.mouse("drag", y, { x: 9 });
				s.mouse("release", y);
				expect(s.mouse("click", y)).toBeUndefined();
				expect(s.headers()).toEqual([" ▾ ran 1 shell command"]);

				// Non-left and modified clicks
				expect(s.click(y, { button: "right" })).toBeUndefined();
				expect(s.click(y, { button: "middle" })).toBeUndefined();
				expect(s.click(y, { shift: true })).toBeUndefined();
				expect(s.click(y, { ctrl: true })).toBeUndefined();
				expect(s.click(y, { alt: true })).toBeUndefined();
				expect(s.mouse("wheel", y, { button: "none", wheelDelta: 1 })).toBeUndefined();
				expect(s.headers()).toEqual([" ▾ ran 1 shell command"]);
			});

			// Fixture note: stock bash warnings are plain text on installed hosts; this test-only fixture
			// verifies that when a tool result emits an OSC 8 hyperlink, TuiAltScreen link activation bypasses group collapse.
			it("test fixture: real native OSC 8 hyperlink in member output activates TuiAltScreen link handler and leaves group expanded", async () => {
				const openUrl = vi.fn();
				let terminalInput: (data: string) => void = () => {};
				const terminal: any = {
					columns: 100, rows: 40, kittyProtocolActive: false,
					start: (onInput: (data: string) => void) => { terminalInput = onInput; },
					stop() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
					clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
				};
				const ui = new TuiAltScreen(terminal, false, "/tmp", { openUrl });

				try {
					const s = stage({ announce: false });
					const fullOutputPath = "/tmp/rbf-test-full-output.log";
					const linkText = `Full output: ${fullOutputPath}`;
					const link = hyperlink(linkText, `file://${fullOutputPath}`);
					const origRender = s.bash.renderResult;
					s.bash.renderResult = (result: any, options: any, theme: any, context: any) => {
						const comp = origRender.call(s.bash, result, options, theme, context);
						comp.addChild(new Text(`    Output truncated. ${link}`, 0, 0));
						return comp;
					};
					s.owner.start(SESSION, s.bash);

					await s.run("c1", "cat file", "alpha\n");
					await s.run("c2", "echo beta", "beta\n");
					s.click(s.headerRow());
					expect(s.headers()).toEqual([" ▾ ran 2 shell commands"]);

					ui.setLayoutRoot(s.chat);
					ui.start();
					ui.renderNow(true);

					const screenLines = (ui as any).previousScreen as string[];
					const prevLinkRow = screenLines.findIndex((l: string) => l.includes("Full output"));
					expect(prevLinkRow, "line with Full output in previousScreen").toBeGreaterThanOrEqual(0);
					const lineText = screenLines[prevLinkRow] ?? "";
					let linkVisibleCol = -1;
					for (let c = 0; c < 80; c++) {
						if (getOsc8LinkAtColumn(lineText, c) === `file://${fullOutputPath}`) {
							linkVisibleCol = c;
							break;
						}
					}
					expect(linkVisibleCol, "visible column with OSC8 link").toBeGreaterThanOrEqual(0);
					terminalInput(`\x1b[<0;${linkVisibleCol + 1};${prevLinkRow + 1}M`);
					terminalInput(`\x1b[<0;${linkVisibleCol + 1};${prevLinkRow + 1}m`);
					ui.renderNow(true);

					// Observable opener evidence: TuiAltScreen opened the URL
					expect(openUrl).toHaveBeenCalledWith(`file://${fullOutputPath}`);
					// Group remains expanded: native link activation bypassed collapse
					expect(s.headers()).toEqual([" ▾ ran 2 shell commands"]);
				} finally {
					ui.stop();
				}
			});

			it("inert group-owned identity, status and separator rows do not collapse the group on click", async () => {
				const s = stage();
				for (const [i, state] of ["ran", "background:task-123", "failed", "unknown", "running"].entries()) await member(s, `c${i}`, state);
				s.click(s.headerRow());
				expect(s.headers()[0]).toContain("▾ 5 shell commands");
				const lines = s.draw(80);
				const blankAbove = s.headerRow() - 1;
				const taskId = lines.indexOf("    Task ID: task-123");
				const statusUnknown = lines.indexOf("    Status unknown");
				expect(taskId).toBeGreaterThan(-1);
				expect(statusUnknown).toBeGreaterThan(-1);

				expect(s.click(blankAbove)).toBeUndefined();
				expect(s.headers()[0]).toContain("▾ 5 shell commands");

				expect(s.click(taskId)).toBeUndefined();
				expect(s.headers()[0]).toContain("▾ 5 shell commands");

				expect(s.click(statusUnknown)).toBeUndefined();
				expect(s.headers()[0]).toContain("▾ 5 shell commands");
			});

			it("width change during press rejects member click and keeps group expanded", async () => {
				const s = stage();
				await s.run("c1");
				await s.run("c2");
				s.click(s.headerRow());
				expect(s.headers()).toEqual([" ▾ ran 2 shell commands"]);
				const y = s.draw().indexOf(" $ pwd");
				expect(y).toBeGreaterThanOrEqual(0);

				s.mouse("press", y);
				s.chat.render(60);
				expect(s.mouse("click", y, { width: 60 })).toBeUndefined();
				expect(s.headers()).toEqual([" ▾ ran 2 shell commands"]);
			});

			it("output height change during press rejects member click and keeps group expanded", async () => {
				const s = stage();
				await s.begin("c1", "cat");
				await s.run("c2");
				s.click(s.headerRow());
				expect(s.headers()[0]).toContain("▾");
				const y = s.draw().indexOf(" $ cat");
				expect(y).toBeGreaterThanOrEqual(0);

				s.mouse("press", y);
				await s.host.handleEvent({ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", partialResult: { content: [{ type: "text", text: "extra\noutput\nlines\n" }] } });
				s.draw();
				expect(s.mouse("click", y)).toBeUndefined();
				expect(s.headers()[0]).toContain("▾");
			});

			it("same-geometry output refresh during press permits member click and collapses group", async () => {
				const s = stage();
				await s.begin("c1", "cat");
				await s.host.handleEvent({ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", partialResult: { content: [{ type: "text", text: "line 1\n" }] } });
				await s.run("c2");
				s.click(s.headerRow());
				expect(s.headers()[0]).toContain("▾");
				const y = s.draw().indexOf(" $ cat");
				expect(y).toBeGreaterThanOrEqual(0);

				s.mouse("press", y);
				await s.host.handleEvent({ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", partialResult: { content: [{ type: "text", text: "line 2\n" }] } });
				s.draw();
				const result = s.mouse("click", y);
				expect(result, "same-geometry click handled").toMatchObject({ handled: true });
				expect(s.headers()[0], "same-geometry click collapsed group").toContain("▸");
			});

			it("true membership change during press (row joined/split) rejects member click", async () => {
				const s = stage();
				await s.run("c1");
				const late = new Text("", 1, 0);
				s.chat.addChild(late);
				await s.run("c2");
				s.click(s.headerRow());
				expect(s.headers()).toEqual([" ▾ ran 2 shell commands"]);
				const y = s.draw().indexOf(" $ pwd");
				expect(y).toBeGreaterThanOrEqual(0);

				// Press while it's a 2-member single group
				s.mouse("press", y);
				// Text arrives and splits group into two 1-member groups
				late.setText("A thought, late.");
				s.draw();
				expect(s.headers()).toEqual([" ▾ ran 1 shell command", " ▾ ran 1 shell command"]);
				// Click on stale geometry/membership rejected
				expect(s.mouse("click", y)).toBeUndefined();
			});

			it("global close and reopen cycle during press rejects member click even at same final geometry", async () => {
				const s = stage();
				await s.run("c1");
				await s.run("c2");
				s.click(s.headerRow());
				expect(s.headers()).toEqual([" ▾ ran 2 shell commands"]);
				const y = s.draw().indexOf(" $ pwd");
				expect(y).toBeGreaterThanOrEqual(0);

				s.mouse("press", y);
				s.host.setToolsExpanded(false);
				s.host.setToolsExpanded(true);
				s.draw();
				expect(s.mouse("click", y)).toBeUndefined();
				expect(s.headers()).toEqual([" ▾ ran 2 shell commands"]);
			});

			it("session switch and view replacement reject stale member clicks across sessions even at same geometry", async () => {
				const s = stage();
				await s.run("c1");
				s.click(s.headerRow());
				expect(s.headers()).toEqual([" ▾ ran 1 shell command"]);
				const y = s.draw().indexOf(" $ pwd");
				expect(y).toBeGreaterThanOrEqual(0);

				s.mouse("press", y);
				// Session switch: owner starts new session on same host and runs new command at same position
				const sess2 = "session-2";
				s.owner.start(sess2, s.bash);
				s.host.toolOutputExpanded = true;
				s.view.start({ ...s.ctx, sessionManager: { getSessionId: () => sess2 } });
				s.chat.children = [];
				await s.run("c2_1");
				s.draw();
				expect(s.headers()).toEqual([" ▾ ran 1 shell command"]);

				// Stale press from session 1 cannot close session 2's group
				s.mouse("release", y);
				expect(s.mouse("click", y)).toBeUndefined();
				expect(s.headers()).toEqual([" ▾ ran 1 shell command"]);
			});

			it("fault projection drops member clicks without throwing and keeps fallback display", async () => {
				const s = stage();
				await s.run("c1");
				await s.run("c2");
				s.click(s.headerRow());
				expect(s.headers()).toEqual([" ▾ ran 2 shell commands"]);
				const y = s.draw().indexOf(" $ pwd");
				expect(y).toBeGreaterThanOrEqual(0);

				s.mouse("press", y);
				// Inject an actual projection failure into member mouse handling
				Object.defineProperty(s.view.state.groups[0]!, "memberIds", {
					get() {
						throw new Error("injected member mouse projection fault");
					},
				});
				expect(() => s.mouse("click", y)).not.toThrow();
				expect(s.view.fault).toMatchObject({ where: "mouse", error: expect.objectContaining({ message: "injected member mouse projection fault" }) });
				// Fallback display is Pi's native display
				expect(s.draw()).toEqual(s.native());
			});

			it("competing press on inert row or outside tool row cancels prior member press", async () => {
				const s = stage();
				await s.run("c1");
				await s.run("c2");
				s.click(s.headerRow());
				expect(s.headers()).toEqual([" ▾ ran 2 shell commands"]);
				const lines = s.draw(80);
				const memberY = lines.indexOf(" $ pwd");
				const blankAbove = s.headerRow() - 1;
				expect(memberY).toBeGreaterThanOrEqual(0);
				expect(blankAbove).toBeGreaterThanOrEqual(0);

				// Press on member row, then competing press on inert blank row cancels gesture
				s.mouse("press", memberY);
				s.mouse("press", blankAbove);
				s.mouse("release", memberY);
				expect(s.mouse("click", memberY)).toBeUndefined();
				expect(s.headers()).toEqual([" ▾ ran 2 shell commands"]);

				// Press on member row, then competing press on outside tool row cancels gesture
				s.definitions.set("read", { name: "read", execute: async () => ({ content: [] }), renderCall: () => new Text("read a.ts", 0, 0), renderResult: () => new Text("", 0, 0) });
				await s.host.handleEvent({ type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: { path: "a.ts" } });
				s.draw();
				const readY = s.draw().findIndex((l) => l.includes("read a.ts"));
				expect(readY).toBeGreaterThanOrEqual(0);

				s.mouse("press", memberY);
				s.mouse("press", readY);
				s.mouse("release", memberY);
				expect(s.mouse("click", memberY)).toBeUndefined();
				expect(s.headers()).toEqual([" ▾ ran 2 shell commands"]);

				// Drag across inert blank row cancels prior member press
				s.mouse("press", memberY);
				s.mouse("drag", blankAbove);
				s.mouse("release", memberY);
				expect(s.mouse("click", memberY)).toBeUndefined();
				expect(s.headers()).toEqual([" ▾ ran 2 shell commands"]);

				// Drag across outside tool row cancels prior member press
				s.mouse("press", memberY);
				s.mouse("drag", readY);
				s.mouse("release", memberY);
				expect(s.mouse("click", memberY)).toBeUndefined();
				expect(s.headers()).toEqual([" ▾ ran 2 shell commands"]);
			});

			it("temporary resize or height change then restored geometry rejects stale member click", async () => {
				const s = stage();
				await s.begin("c1", "cat");
				await s.host.handleEvent({
					type: "tool_execution_update",
					toolCallId: "c1",
					toolName: "bash",
					partialResult: { content: [{ type: "text", text: "initial\n" }] },
				});
				await s.run("c2");
				s.click(s.headerRow());
				expect(s.headers()).toEqual([" ▾ 2 shell commands · 1 waiting"]);
				const y80 = s.draw(80).indexOf(" $ cat");
				expect(y80).toBeGreaterThanOrEqual(0);

				// 1. Temporary resize from 80 to 120 and back to 80
				s.mouse("press", y80, { width: 80 });
				s.draw(120);
				s.draw(80);
				s.mouse("release", y80, { width: 80 });
				expect(s.mouse("click", y80, { width: 80 })).toBeUndefined();
				expect(s.headers()).toEqual([" ▾ 2 shell commands · 1 waiting"]);

				// 2. Temporary height change: output updates to taller frame then back to exact initial height
				s.mouse("press", y80, { width: 80 });
				await s.host.handleEvent({
					type: "tool_execution_update",
					toolCallId: "c1",
					toolName: "bash",
					partialResult: { content: [{ type: "text", text: "line 1\nline 2\nline 3\n" }] },
				});
				s.draw(80); // taller frame rendered during press
				await s.host.handleEvent({
					type: "tool_execution_update",
					toolCallId: "c1",
					toolName: "bash",
					partialResult: { content: [{ type: "text", text: "initial\n" }] },
				});
				s.draw(80); // original height restored before click
				s.mouse("release", y80, { width: 80 });
				expect(s.mouse("click", y80, { width: 80 })).toBeUndefined();
				expect(s.headers()).toEqual([" ▾ 2 shell commands · 1 waiting"]);

				// 3. Wrong-width non-press event followed by valid-width click proves clearing branch
				s.mouse("press", y80, { width: 80 });
				s.mouse("wheel", y80, { width: 120, button: "none" });
				s.mouse("release", y80, { width: 80 });
				expect(s.mouse("click", y80, { width: 80 })).toBeUndefined();
				expect(s.headers()).toEqual([" ▾ 2 shell commands · 1 waiting"]);
			});

			it("closing active or restored groups (running, background, waiting, failed, unknown) collapses disclosure and reopening preserves exact full output, owner facts and pendingTools", async () => {
				for (const state of ["running", "background:task-42", "waiting", "failed", "unknown"]) {
					const s = stage();
					await member(s, "c1", state);
					await s.run("c2", "echo second", "second output\n");
					s.click(s.headerRow());
					expect(s.headers()[0]).toContain("▾");

					// Capture exact before-close state: full rendered output, tool args, results, pendingTools
					const beforeLines = s.rows().map((r) => r.render(100));
					const beforeFacts = s.rows().map((r) => ({ args: r.args, result: r.result, toolCallId: r.toolCallId }));
					const beforePending = s.host.pendingTools.has("c1");

					// Click member row to collapse whole group
					const memberRow = s.draw().indexOf(" $ pwd");
					const result = s.click(memberRow);
					expect(result, `member click in state ${state}`).toMatchObject({ handled: true });
					expect(s.headers()[0], `header collapsed in state ${state}`).toContain("▸");

					// Header truthful status preserved while collapsed
					if (state === "running") {
						expect(s.headers()[0]).toContain("running");
						expect(s.host.pendingTools.has("c1")).toBe(true);
					} else if (state.startsWith("background")) {
						expect(s.headers()[0]).toContain("background");
					} else if (state === "waiting") {
						expect(s.headers()[0]).toContain("waiting");
					} else if (state === "failed") {
						expect(s.headers()[0]).toContain("failed");
					} else if (state === "unknown") {
						expect(s.headers()[0]).toContain("unknown");
					}

					// Click header to reopen group
					s.click(s.headerRow());
					expect(s.headers()[0], `header reopened in state ${state}`).toContain("▾");

					// Exact full-output, args, results, tool IDs and pendingTools preserved across close/reopen
					const afterLines = s.rows().map((r) => r.render(100));
					const afterFacts = s.rows().map((r) => ({ args: r.args, result: r.result, toolCallId: r.toolCallId }));
					expect(afterLines, `exact rendered output in state ${state}`).toEqual(beforeLines);
					expect(afterFacts, `exact facts in state ${state}`).toEqual(beforeFacts);
					expect(s.host.pendingTools.has("c1"), `pendingTools preserved in state ${state}`).toBe(beforePending);
				}
			});

			it("the same click on a tool row outside any group is Pi's: the row toggles", async () => {
				const s = stage({ announce: false });
				await s.begin("c1", ALPHA);
				await s.end("c1", "alpha\nbeta\n");
				const y = s.draw(100).indexOf(" $ printf 'alpha\\nbeta\\n'");
				expect(s.rows()[0].expanded).toBe(false);
				expect(s.click(y)).toMatchObject({ handled: true });
				expect(s.rows()[0].expanded).toBe(true);
			});

			it("press, release, drag, wheel and a non-left click reach the member's own handler with its own row coordinates", async () => {
				const s = stage();
				s.prose("Before.");
				await s.run("c1", ALPHA, "alpha\nbeta\n");
				s.click(s.headerRow());
				const lines = s.draw(100);
				const y = lines.indexOf("    beta");
				const rowTop = y - (s.rows()[0].render(100) as string[]).map(clean).indexOf("    beta");
				const reached = vi.spyOn(s.rows()[0], "handleMouse");
				s.mouse("press", y);
				s.mouse("drag", y, { x: 9 });
				s.mouse("release", y);
				s.mouse("wheel", y, { button: "none", wheelDelta: -1 });
				s.mouse("click", y, { button: "right" });
				s.mouse("click", y, { button: "middle" });
				expect(reached.mock.calls.map(([event]) => [(event as any).type, (event as any).button, (event as any).y])).toEqual([
					["press", "left", y - rowTop],
					["drag", "left", y - rowTop],
					["release", "left", y - rowTop],
					["wheel", "none", y - rowTop],
					["click", "right", y - rowTop],
					["click", "middle", y - rowTop],
				]);
				expect(reached.mock.calls.every(([event]) => (event as any).height === (s.rows()[0].render(100) as string[]).length)).toBe(true);
			});

			it("a row before a group and a row after it still get their own clicks at their own lines", async () => {
				const s = stage();
				s.definitions.set("read", { name: "read", execute: async () => ({ content: [] }), renderCall: () => new Text("read a.ts", 0, 0), renderResult: () => new Text("contents", 0, 0) });
				const other = async (id: string) => {
					await s.host.handleEvent({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: {} });
					await s.host.handleEvent({ type: "tool_execution_end", toolCallId: id, toolName: "read", result: { content: [{ type: "text", text: "x" }] }, isError: false });
				};
				await other("r1");
				await s.run("c1");
				await s.run("c2");
				await other("r2");
				const [first, , , last] = s.rows();
				const lines = s.draw();
				const at = lines.flatMap((line, y) => (line.includes("read a.ts") ? [y] : []));
				expect(at).toHaveLength(2);
				expect(s.click(at[1]!)).toMatchObject({ handled: true });
				expect([first.expanded, last.expanded]).toEqual([false, true]);
				expect(s.click(at[0]!)).toMatchObject({ handled: true });
				expect([first.expanded, last.expanded]).toEqual([true, true]);
				expect(s.headers()).toEqual([" ▸ ran 2 shell commands"]);
			});
		});

		describe("fail open", () => {
			/** Makes the next regroup throw inside the view's own code: the view reads this flag, Pi's drawing does not. */
			const breakProjection = (s: ReturnType<typeof stage>) =>
				Object.defineProperty(s.host, "toolOutputExpanded", {
					configurable: true,
					get() {
						throw new Error("projection fault");
					},
				});

			it("a fault while drawing: that frame is Pi's own, the view lets go, and one warning follows", async () => {
				const s = stage();
				await s.run("c1");
				expect(s.headers()).toEqual([" ▸ ran 1 shell command"]);
				await s.begin("c2");
				breakProjection(s);
				s.requestRender.mockClear();
				const frame = (s.chat.render(80) as string[]).map(clean);
				expect(frame).toEqual(s.native(80));
				expect(frame.some((line) => line.startsWith(" ▸"))).toBe(false);
				expect(s.view.fault).toMatchObject({ where: "render", error: expect.objectContaining({ message: "projection fault" }) });
				expect(s.requestRender).toHaveBeenCalled();
				expect(s.notify).not.toHaveBeenCalled(); // one tick later, after Pi's own draw
				await tick();
				expect(s.notify.mock.calls).toEqual([[UNAVAILABLE_WARNING, "warning"]]);
				expect(UNAVAILABLE_WARNING).toBe("Tool call groups unavailable; showing native tool rows.");
				// Detached: nothing of the view is left on the container or the prototype, and later frames and events are Pi's alone.
				for (const name of CONTAINER_METHODS) expect(Object.prototype.hasOwnProperty.call(s.chat, name)).toBe(false);
				for (const name of HOST_METHODS) expect((InteractiveMode.prototype as any)[name]).toBe(pristine[name]);
				expect((globalThis as any)[VIEW_KEY]).toBeUndefined();
				Object.defineProperty(s.host, "toolOutputExpanded", { configurable: true, writable: true, value: false });
				await s.begin("c3");
				expect(s.draw()).toEqual(s.native());
				await tick();
				expect(s.notify).toHaveBeenCalledTimes(1);
			});

			it("a fault on a mouse event: the event is dropped as handled, no row changes, and the next frame is Pi's own", async () => {
				const s = stage();
				await s.run("c1");
				await s.run("c2");
				const y = s.headerRow();
				Object.defineProperty(s.view.state.groups[0]!, "memberIds", {
					get() {
						throw new Error("projection fault");
					},
				});
				s.requestRender.mockClear();
				const result = s.mouse("press", y);
				expect(result).toMatchObject({ handled: true });
				expect(result.focus).toBeUndefined();
				expect(result.capture).toBeUndefined();
				expect(s.rows().map((row) => row.expanded)).toEqual([false, false]);
				expect(s.requestRender).toHaveBeenCalled();
				expect(s.view.fault).toMatchObject({ where: "mouse", error: expect.objectContaining({ message: "projection fault" }) });
				// The click that follows the dropped press lands on Pi's own geometry, not on the frame the user saw.
				expect(s.draw()).toEqual(s.native());
				await tick();
				expect(s.notify.mock.calls).toEqual([[UNAVAILABLE_WARNING, "warning"]]);
			});

			it("a row whose own render throws is Pi's error: it reaches the caller unchanged and the view stays", async () => {
				const s = stage();
				await s.run("c1");
				const broken = new Error("native render failed");
				const bad = { render: () => { throw broken; }, invalidate() {} };
				s.chat.addChild(bad);
				let thrown: unknown;
				try {
					s.chat.render(80);
				} catch (error) {
					thrown = error;
				}
				expect(thrown).toBe(broken);
				expect(s.view.fault).toBeUndefined();
				s.chat.removeChild(bad);
				expect(s.headers()).toEqual([" ▸ ran 1 shell command"]);
				// The same for a member's own render, and for a member's own mouse handler.
				s.click(s.headerRow());
				const row = s.rows()[0];
				const render = vi.spyOn(row, "render").mockImplementation(() => { throw broken; });
				expect(() => s.chat.render(80)).toThrow(broken);
				render.mockRestore();
				const y = s.draw().indexOf(" $ pwd");
				vi.spyOn(row, "handleMouse").mockImplementation(() => { throw broken; });
				expect(() => s.mouse("press", y)).toThrow(broken);
				expect(() => s.mouse("drag", y)).toThrow(broken);
				expect(() => s.mouse("release", y)).toThrow(broken);
				expect(() => s.mouse("wheel", y, { button: "none" })).toThrow(broken);
				expect(() => s.mouse("click", y, { button: "right" })).toThrow(broken);
				expect(s.view.fault).toBeUndefined();
				await tick();
				expect(s.notify).not.toHaveBeenCalled();
				// View remains attached
				expect(s.headers()).toEqual([" ▾ ran 1 shell command"]);
			});

			it("Pi's own methods keep their results and errors: a thrown event, a rejected event, a failed expansion that mirrors nothing", async () => {
				const failure = new Error("native failure");
				const s = stage();
				await s.run("c1");
				s.click(s.headerRow());
				const event = vi.spyOn(s.host, "updatePendingMessagesDisplay");
				event.mockImplementationOnce(() => { throw failure; });
				await expect(s.host.handleEvent({ type: "queue_update" })).rejects.toBe(failure);
				event.mockRestore();
				const status = vi.spyOn(s.host, "showStatus").mockImplementation(() => { throw failure; });
				expect(() => s.host.setToolsExpanded(true)).toThrow(failure);
				status.mockRestore();
				expect(s.view.fault).toBeUndefined();
				// Pi set its flag and its rows before it failed; the group was not told to follow a call that failed.
				expect(s.view.state.groups[0]!.expanded).toBe(true);
				s.host.toolOutputExpanded = false;
				const failing = vi.spyOn(s.host, "showStatus").mockImplementation(() => { throw failure; });
				s.click(s.headerRow());
				expect(s.view.state.groups[0]!.expanded).toBe(false);
				expect(() => s.host.setToolsExpanded(true)).toThrow(failure);
				expect(s.view.state.groups[0]!.expanded).toBe(false);
				failing.mockRestore();
				await tick();
				expect(s.notify).not.toHaveBeenCalled();
			});

			it("a host without the members the view reads is left alone, with the one warning", async () => {
				const s = stage({ announce: false });
				const { host } = makeHost(new Map([["bash", s.bash]]));
				host.pendingTools = undefined;
				host.pendingTools = { get: () => undefined };
				host.setToolsExpanded(false);
				expect(s.view.fault).toMatchObject({ where: "capture" });
				for (const name of CONTAINER_METHODS) expect(Object.prototype.hasOwnProperty.call(host.chatContainer, name)).toBe(false);
				await tick();
				expect(s.notify.mock.calls).toEqual([[UNAVAILABLE_WARNING, "warning"]]);
			});

			it("outside the TUI the fault is kept and nothing is said: there is no transcript to say it in", async () => {
				const s = stage({ announce: false, mode: "print" });
				const { host } = makeHost(new Map());
				host.pendingTools = [];
				host.setToolsExpanded(false);
				await tick();
				expect(s.view.fault).toMatchObject({ where: "capture" });
				expect(s.notify).not.toHaveBeenCalled();
			});

			it("a fault before session_start holds its warning until there is a context to say it through", async () => {
				const s = stage({ start: false, announce: false });
				const { host } = makeHost(new Map());
				host.pendingTools = [];
				host.setToolsExpanded(false);
				await tick();
				expect(s.notify).not.toHaveBeenCalled();
				s.view.start(s.ctx);
				await tick();
				expect(s.notify.mock.calls).toEqual([[UNAVAILABLE_WARNING, "warning"]]);
			});
		});

		describe("reload", () => {
			it("a second view installs no second wrapper, and the first leaving takes nothing from the second", async () => {
				const first = stage();
				const wrappers = HOST_METHODS.map((name) => (InteractiveMode.prototype as any)[name]);
				const second = createShellGroupsView({ events: first.events } as any);
				stages.push({ view: second });
				expect(HOST_METHODS.map((name) => (InteractiveMode.prototype as any)[name])).toEqual(wrappers);
				HOST_METHODS.forEach((name, i) => expect((InteractiveMode.prototype as any)[name]).toBe(wrappers[i]));
				first.view.stop();
				HOST_METHODS.forEach((name, i) => expect((InteractiveMode.prototype as any)[name]).toBe(wrappers[i]));
				expect((globalThis as any)[VIEW_KEY]).toBe(second);
				// The second view takes the same host and the same container, with one wrapper on each method.
				second.start(first.ctx);
				first.owner.start(SESSION, first.bash);
				await first.run("c1");
				const render = first.chat.render;
				expect(first.draw()).toEqual(["", " ▸ ran 1 shell command"]);
				expect(first.chat.render).toBe(render);
				second.stop();
				for (const name of HOST_METHODS) expect((InteractiveMode.prototype as any)[name]).toBe(pristine[name]);
				for (const name of CONTAINER_METHODS) expect(Object.prototype.hasOwnProperty.call(first.chat, name)).toBe(false);
				expect((globalThis as any)[VIEW_KEY]).toBeUndefined();
				expect(first.draw()).toEqual(first.native());
			});

			it("a second InteractiveMode takes the view with it: the first one's container is unwrapped and draws as Pi draws", async () => {
				const s = stage();
				await s.run("c1");
				expect(s.headers()).toEqual([" ▸ ran 1 shell command"]);
				const other = makeHost(s.definitions);
				await other.host.handleEvent({ type: "tool_execution_start", toolCallId: "d1", toolName: "bash", args: { command: "pwd" } });
				for (const name of CONTAINER_METHODS) {
					expect(Object.prototype.hasOwnProperty.call(s.chat, name)).toBe(false);
					expect(Object.prototype.hasOwnProperty.call(other.host.chatContainer, name)).toBe(true);
				}
				expect(s.draw()).toEqual(s.native());
				expect((other.host.chatContainer.render(80) as string[]).map(clean)).toEqual(["", " ▸ waiting for 1 shell command"]);
				expect(s.view.fault).toBeUndefined();
			});

			it("stopping twice changes nothing more, and the view keeps no row of the session it left", async () => {
				const s = stage();
				await s.run("c1");
				s.draw();
				expect(s.view.state.members.size).toBe(1);
				s.view.stop();
				s.view.stop();
				expect(s.view.state.members.size).toBe(0);
				expect(s.view.state.groups).toEqual([]);
				expect(s.view.fault).toBeUndefined(); // an ordinary stop is not a fault
				expect(s.draw()).toEqual(s.native());
			});

			it("another extension's wrapper over ours is left whole, keeps working, and is not wrapped again by the next view", async () => {
				const s = stage();
				await s.run("c1");
				s.draw();
				const calls: string[] = [];
				const ours = { event: (InteractiveMode.prototype as any).handleEvent, render: s.chat.render };
				const outerEvent = function (this: any, ...args: any[]) {
					calls.push("event");
					return ours.event.apply(this, args);
				};
				const outerRender = function (this: any, width: number) {
					calls.push("render");
					return ours.render.call(this, width);
				};
				(InteractiveMode.prototype as any).handleEvent = outerEvent;
				s.chat.render = outerRender;
				try {
					s.view.stop();
					expect((InteractiveMode.prototype as any).handleEvent).toBe(outerEvent);
					expect(s.chat.render).toBe(outerRender);
					// Ours is still underneath and reaches nothing: Pi's own method runs, once.
					await s.begin("c2");
					expect(s.draw()).toEqual(s.native());
					expect(calls).toEqual(["event", "render"]);
					expect(s.rows()).toHaveLength(2);

					const next = createShellGroupsView({ events: s.events } as any);
					stages.push({ view: next });
					expect((InteractiveMode.prototype as any).handleEvent).toBe(outerEvent);
					next.start(s.ctx);
					s.owner.start(SESSION, s.bash);
					await s.begin("c3");
					expect(s.chat.render).toBe(outerRender);
					// The call that ended before the new view came is unknown; the two still open are waiting for their owner.
					expect(s.draw()[1]).toBe(" ▸ 3 shell commands · 2 waiting · 1 unknown");
					expect(s.rows()).toHaveLength(3); // each event ran Pi's method once, through one wrapper of ours
					next.stop();
					expect((InteractiveMode.prototype as any).handleEvent).toBe(outerEvent);
					expect(s.draw()).toEqual(s.native());
				} finally {
					(InteractiveMode.prototype as any).handleEvent = pristine.handleEvent;
					delete s.chat.render;
					delete s.chat.handleMouse;
					for (const name of CONTAINER_METHODS) delete s.chat[wrappedKey(name)];
				}
			});
		});

		describe("evidence and row facts", () => {
			it("a fact that arrived before its row was drawn is asked for again when the row joins", async () => {
				const s = stage();
				await s.begin("c1");
				s.tell("c1", ...RAN); // no frame yet: the view holds no member for it
				expect(s.view.state.members.size).toBe(0);
				await s.end("c1", "/work\n");
				expect(s.headers()).toEqual([" ▸ ran 1 shell command"]);
			});

			it("a call that ended with no word from its owner is unknown, never waiting and never ran", async () => {
				const s = stage();
				await s.begin("c1");
				expect(s.headers()).toEqual([" ▸ waiting for 1 shell command"]);
				await s.end("c1", "/work\n");
				expect(s.headers()).toEqual([" ▸ 1 shell command · status unknown"]);
			});

			it("Pi's own error row beside missing proof is an error with status unknown; beside a proved ending it is that ending", async () => {
				const s = stage();
				await s.begin("c1");
				await s.end("c1", "EPIPE", true);
				expect(s.headers()).toEqual([" ▸ 1 shell command · error · status unknown"]);
				await s.run("c2", "exit 1", "Command exited with code 1", FAILED, true);
				expect(s.headers()).toEqual([" ▸ 2 shell commands · 1 failed · 1 error (status unknown)"]);
			});

			it("a call the agent abandoned is no longer open: the turn's end closes it", async () => {
				const s = stage();
				await s.run("c0");
				await s.begin("c1");
				s.click(s.headerRow());
				expect(s.draw()).not.toContain("    No recorded result");
				await s.host.handleEvent({ type: "agent_end" });
				expect(s.headers()).toEqual([" ▾ 2 shell commands · 1 unknown"]);
				const lines = s.draw();
				expect(lines.slice(lines.indexOf("    Status unknown"))).toEqual(["    Status unknown", "    No recorded result"]);
			});

			it("a transcript rebuilt while a call is still open leaves that call open: no result line under it, and its owner's facts still land", async () => {
				const s = stage();
				await s.run("c0");
				await s.begin("c1");
				s.click(s.headerRow());
				expect(s.headers()).toEqual([" ▾ 2 shell commands · 1 waiting"]);
				// Pi rebuilds the transcript from its entries, as after a compaction or a tree move; the second call has no result yet.
				s.chat.clear();
				s.host.renderSessionItems([{ role: "assistant", content: [toolCall("c0", "pwd"), toolCall("c1", "pwd")], stopReason: "toolUse" }, toolResult("c0", "/work\n")]);
				expect(s.host.pendingTools.has("c1")).toBe(true);
				expect(s.headers()).toEqual([" ▸ 2 shell commands · 1 waiting"]);
				s.click(s.headerRow());
				expect(s.draw()).not.toContain("    No recorded result");
				expect(s.draw()).not.toContain("    Status unknown");
				s.tell("c1", { kind: "start" });
				expect(s.headers()).toEqual([" ▾ 2 shell commands · 1 running"]);
				s.tell("c1", { kind: "close", code: 0, signal: null });
				await s.end("c1", "/work\n");
				expect(s.headers()).toEqual([" ▾ ran 2 shell commands"]);
				// A row of history with no result is a different thing: a rebuild cannot make it open.
				const old = stage();
				old.host.renderSessionItems([{ role: "assistant", content: [toolCall("h1", "pwd")], stopReason: "toolUse" }]);
				expect(old.headers()).toEqual([" ▸ 1 shell command · status unknown"]);
				old.chat.clear();
				old.host.renderSessionItems([{ role: "assistant", content: [toolCall("h1", "pwd")], stopReason: "toolUse" }]);
				expect(old.headers()).toEqual([" ▸ 1 shell command · status unknown"]);
				old.click(old.headerRow());
				expect(old.draw()).toContain("    No recorded result");
			});

			it("a streamed call whose message ends in an error is closed by that message, not left waiting for the turn to end", async () => {
				const s = stage();
				const streamed = (stopReason?: string) => ({ role: "assistant", content: [toolCall("c1", "pwd")], ...(stopReason ? { stopReason, errorMessage: "overloaded" } : {}) });
				await s.host.handleEvent({ type: "message_start", message: { role: "assistant", content: [] } });
				await s.host.handleEvent({ type: "message_update", message: streamed() });
				expect(s.headers()).toEqual([" ▸ waiting for 1 shell command"]);
				await s.host.handleEvent({ type: "message_end", message: streamed("error") });
				// Pi gave the row the message's error and dropped it from its pending tools; no owner ever saw the call.
				expect(s.headers()).toEqual([" ▸ 1 shell command · error · status unknown"]);
			});

			it("an output chunk changes no fact and touches no group", async () => {
				const s = stage();
				await s.begin("c1");
				s.tell("c1", { kind: "start" });
				s.draw();
				const before = s.view.state.groups[0]!.updates;
				for (let i = 0; i < 10; i++) await s.host.handleEvent({ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", partialResult: { content: [{ type: "text", text: `line ${i}\n` }] } });
				s.draw();
				expect(s.view.state.groups[0]!.updates).toBe(before);
				expect(s.view.state.reconciliations).toBe(1);
			});

			it("a restored Codex command ran only on a matched record with numeric exit 0 and a completed status", () => {
				const s = stage({ announce: false });
				const codex = { name: "codex_command", execute: async () => ({ content: [] }), renderCall: (args: any) => new Text(`$ ${args.command}`, 0, 0), renderResult: () => new Text("out", 0, 0) };
				s.definitions.set("codex_command", codex);
				const owner = createShellDisplayOwner<{ kind: string }>(s.events, "codex-command", () => false)!;
				owner.start(SESSION, codex);
				const call = (id: string) => ({ type: "toolCall", id: `codex-${id}`, name: "codex_command", arguments: { itemId: id, threadId: "", agentPath: "", command: "pwd", cwd: "/work" } });
				const result = (id: string, details: unknown, isError = false) => ({ role: "toolResult", toolCallId: `codex-${id}`, toolName: "codex_command", content: [{ type: "text", text: "x" }], details, isError });
				s.host.renderSessionItems([
					{ role: "assistant", content: [call("i1")], stopReason: "toolUse" },
					result("i1", { itemId: "i1", exitCode: 0, status: "completed" }),
					{ role: "assistant", content: [{ type: "text", text: "next" }, call("i2"), call("i3"), call("i4"), call("i5")], stopReason: "toolUse" },
					result("i2", { itemId: "i2", exitCode: null, status: "completed" }),
					result("i3", { itemId: "other", exitCode: 0, status: "completed" }),
					result("i4", {}, true),
				]);
				expect(s.headers()).toEqual([" ▸ ran 1 shell command", " ▸ 4 shell commands · 1 error (status unknown) · 3 unknown"]);
			});

			it("a transcript Pi rebuilds takes its disclosure from the global setting again and keeps what the owner proved", async () => {
				const s = stage();
				await s.run("c1");
				s.click(s.headerRow());
				expect(s.headers()).toEqual([" ▾ ran 1 shell command"]);
				s.chat.clear();
				s.host.renderSessionItems([{ role: "assistant", content: [toolCall("c1", "pwd")], stopReason: "toolUse" }, toolResult("c1", "/work\n")]);
				expect(s.headers()).toEqual([" ▸ ran 1 shell command"]);
				expect(s.view.state.members.size).toBe(1);
				expect([...s.view.state.members.values()][0]!.nativeRow).toBe(s.rows()[0]);
			});

			it("no group crosses a working-directory change", async () => {
				const s = stage();
				await s.run("c1");
				s.host.runtimeHost.session.sessionManager.getCwd = () => "/elsewhere";
				await s.run("c2");
				expect(s.headers()).toEqual([" ▸ ran 1 shell command", " ▸ ran 1 shell command"]);
			});
		});

		describe("boundaries and order: Pi's own rows", () => {
			const thinking = { role: "assistant", content: [{ type: "thinking", thinking: "Hm." }], stopReason: "toolUse" };
			const ROWS: [string, (s: ReturnType<typeof stage>) => unknown][] = [
				["assistant text", (s) => s.host.addMessageToChat(assistant("Words."))],
				["thinking, shown", (s) => s.host.addMessageToChat(thinking)],
				["thinking, hidden behind its label", (s) => ((s.host.hideThinkingBlock = true), s.host.addMessageToChat(thinking))],
				["a delivered user message", (s) => s.host.addMessageToChat({ role: "user", content: "again", timestamp: 1 })],
				["a user ! command", (s) => s.host.addMessageToChat({ role: "bashExecution", command: "echo mine", output: "mine\n", exitCode: 0, cancelled: false, truncated: false })],
				[
					"another tool's row",
					(s) => {
						s.definitions.set("read", { name: "read", execute: async () => ({ content: [] }), renderCall: () => new Text("read a.ts", 0, 0), renderResult: () => new Text("", 0, 0) });
						return s.host.handleEvent({ type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: { path: "a.ts" } });
					},
				],
				["a status notice", (s) => s.host.showStatus("Thinking blocks: hidden")],
				["a warning", (s) => s.host.showWarning("Careful.")],
				["an error", (s) => s.host.showError("Failed.")],
				["a compaction summary", (s) => s.host.addMessageToChat({ role: "compactionSummary", summary: "Earlier work.", tokensBefore: 1000, timestamp: 1 })],
				["a branch summary", (s) => s.host.addMessageToChat({ role: "branchSummary", summary: "The other branch.", fromId: "x", timestamp: 1 })],
			];
			it.each(ROWS)("%s between two calls, built by Pi's own code, ends the group before it", async (_name, add) => {
				const s = stage();
				await s.run("c1");
				const before = s.chat.children.length;
				await add(s);
				expect(s.chat.children.length).toBeGreaterThan(before);
				await s.run("c2");
				await s.run("c3");
				expect(s.headers()).toEqual([" ▸ ran 1 shell command", " ▸ ran 2 shell commands"]);
				// And what stands between them is drawn where Pi put it, between the two headers.
				const lines = s.draw();
				const [first, second] = lines.flatMap((line, y) => (line.startsWith(" ▸") ? [y] : []));
				expect(lines.slice(first! + 1, second).some((line) => line.trim() !== "")).toBe(true);
			});

			it("a tool-only assistant row draws nothing and ends nothing", async () => {
				const s = stage();
				await s.run("c1");
				s.host.addMessageToChat({ role: "assistant", content: [toolCall("c2", "pwd")], stopReason: "toolUse" });
				await s.run("c2");
				expect(s.headers()).toEqual([" ▸ ran 2 shell commands"]);
			});
		});

		describe("counts and states: real commands", () => {
			it("a heredoc, a pipeline and a compound command are one invocation each, and the same text twice is two", async () => {
				const s = stage();
				await s.run("c1", "python3 - <<'PY'\nimport os\nprint(os.getcwd())\nPY", "/work\n");
				expect(s.headers()).toEqual([" ▸ ran 1 shell command"]);
				await s.run("c2", "ls | wc -l", "3\n");
				await s.run("c3", "printf a; printf b", "ab");
				expect(s.headers()).toEqual([" ▸ ran 3 shell commands"]);
				await s.run("c4", "printf a; printf b", "ab");
				expect(s.headers()).toEqual([" ▸ ran 4 shell commands"]);
				// Results that arrive in pieces, and again whole, add nothing.
				await s.begin("c5", "pwd");
				for (let i = 0; i < 3; i++) await s.host.handleEvent({ type: "tool_execution_update", toolCallId: "c5", toolName: "bash", partialResult: { content: [{ type: "text", text: "/wo" }] } });
				await s.begin("c5", "pwd");
				expect(s.headers()).toEqual([" ▸ 5 shell commands · 1 waiting"]);
			});
		});

		describe("queued and delivered input", () => {
			it("queue growth, an identical submission and withdrawal do not split a group or regroup anything; a delivered message does", async () => {
				const s = stage();
				await s.run("c1");
				/** Draws a frame and says how many times membership has been regrouped so far. */
				const regroups = () => {
					s.draw();
					return s.view.state.reconciliations;
				};
				const queued = async (...steering: string[]) => {
					s.queue.steering = steering;
					await s.host.handleEvent({ type: "queue_update" });
				};
				let count = regroups();
				await queued("again");
				expect(s.host.pendingMessagesContainer.children.length).toBeGreaterThan(0);
				expect(regroups()).toBe(count);
				await s.run("c2");
				expect(regroups()).toBe(++count);
				await queued("again", "again");
				expect(regroups()).toBe(count);
				await s.run("c3");
				expect(regroups()).toBe(++count);
				await queued();
				expect(s.host.pendingMessagesContainer.children).toEqual([]);
				expect(regroups()).toBe(count);
				expect(s.headers()).toEqual([" ▸ ran 3 shell commands"]);
				s.host.addMessageToChat({ role: "user", content: "again", timestamp: 1 });
				await s.run("c4");
				s.host.addMessageToChat({ role: "user", content: "again", timestamp: 2 });
				await s.run("c5");
				expect(s.headers()).toEqual([" ▸ ran 3 shell commands", " ▸ ran 1 shell command", " ▸ ran 1 shell command"]);
			});
		});

		describe("scale", () => {
			it("1,000 members and 100 output updates to one of them: no regroup, no group touched, no collapsed row drawn, no output kept", async () => {
				const s = stage();
				for (let i = 0; i < 1000; i++) {
					if (i > 0 && i % 100 === 0) s.prose(`Batch ${i / 100}.`);
					await s.begin(`c${i}`);
					s.tell(`c${i}`, { kind: "start" });
				}
				expect(s.headers()).toHaveLength(10);
				expect(s.view.state.members.size).toBe(1000);
				const regroups = s.view.state.reconciliations;
				const touched = s.view.state.groups.map((group) => group.updates);
				const drawn = vi.spyOn(ToolExecutionComponent.prototype, "render");
				for (let i = 0; i < 100; i++) {
					await s.host.handleEvent({ type: "tool_execution_update", toolCallId: "c437", toolName: "bash", partialResult: { content: [{ type: "text", text: "OUTPUT-MARKER ".repeat(i + 1) }] } });
					s.chat.render(80);
				}
				expect(drawn).not.toHaveBeenCalled();
				drawn.mockRestore();
				expect(s.view.state.reconciliations).toBe(regroups);
				expect(s.view.state.groups.map((group) => group.updates)).toEqual(touched);
				const kept = JSON.stringify([...s.view.state.members.values()].map(({ nativeRow, ...rest }) => rest)) + JSON.stringify(s.view.state.groups);
				expect(kept).not.toContain("OUTPUT-MARKER");
			}, 60_000);

			it("a member joining a view of 1,000 costs one invocation's replay, not everything the owner holds", async () => {
				const s = stage();
				for (let i = 0; i < 1000; i++) {
					await s.begin(`c${i}`);
					s.tell(`c${i}`, { kind: "start" });
				}
				s.draw();
				const heard: any[] = [];
				s.events.on(SHELL_DISPLAY_CHANNEL, (message) => heard.push(message));
				await s.begin("late");
				s.tell("late", ...RAN);
				heard.length = 0;
				s.draw();
				expect(heard.map((m) => [m.kind, m.toolCallId ?? m.toolCallIds, m.revision])).toEqual([
					["announce", undefined, undefined],
					["fact", "late", 1],
					["fact", "late", 2],
					["snapshot-request", ["late"], undefined],
				]);
				expect(s.headers()).toEqual([" ▸ 1001 shell commands · 1000 running"]);
				// First attach and session_start still ask for everything.
				heard.length = 0;
				s.view.start(s.ctx);
				expect(heard.filter((m) => m.kind === "snapshot-request")).toEqual([{ kind: "snapshot-request", sessionId: SESSION }]);
				expect(heard.filter((m) => m.kind === "fact")).toHaveLength(1002);
			}, 60_000);
		});

		describe("test support display probe lifecycle and ownership", () => {
			it("inactive receipt capture delegates to saved originals when wrapped by later owner after shutdown", async () => {
				const linkLog = `/tmp/test-probe-link-${Date.now()}.log`;
				const copyLog = `/tmp/test-probe-copy-${Date.now()}.log`;
				process.env.RBF_PROBE_LINK_LOG = linkLog;
				process.env.RBF_PROBE_COPY_LOG = copyLog;

				const proto = InteractiveMode.prototype as any;
				const savedProtoHandleEvent = proto.handleEvent;
				proto.handleEvent = function () {};

				let shutdownHandler: any;
				rbfShellDisplayProbe({
					events: createEventBus(),
					on(name: string, fn: any) {
						if (name === "session_shutdown") shutdownHandler = fn;
					},
					registerCommand() {},
				} as any);

				let opens = 0;
				let copies = 0;
				let receivedUrl = "";
				let receivedText = "";
				const r1: any = {
					openUrl(url: string) {
						opens++;
						receivedUrl = url;
					},
					async copySelection(text: string) {
						copies++;
						receivedText = text;
						return true;
					},
					copyOnSelect: false,
				};

				proto.handleEvent.call({ renderer: r1 });

				const innerOpen = r1.openUrl;
				const innerCopy = r1.copySelection;
				const laterOpen = function (this: any, url: string) {
					return innerOpen.call(this, url);
				};
				const laterCopy = function (this: any, text: string) {
					return innerCopy.call(this, text);
				};
				r1.openUrl = laterOpen;
				r1.copySelection = laterCopy;

				shutdownHandler();

				r1.openUrl("file:///test-url");
				await r1.copySelection("test-copy");

				expect(r1.openUrl).toBe(laterOpen);
				expect(r1.copySelection).toBe(laterCopy);
				expect(opens).toBe(1);
				expect(receivedUrl).toBe("file:///test-url");
				expect(copies).toBe(1);
				expect(receivedText).toBe("test-copy");

				proto.handleEvent = savedProtoHandleEvent;
				delete process.env.RBF_PROBE_LINK_LOG;
				delete process.env.RBF_PROBE_COPY_LOG;
			});

			it("preserves later owner copy configuration and policy across events and shutdown", async () => {
				const linkLog = `/tmp/test-probe-link-${Date.now()}.log`;
				const copyLog = `/tmp/test-probe-copy-${Date.now()}.log`;
				process.env.RBF_PROBE_LINK_LOG = linkLog;
				process.env.RBF_PROBE_COPY_LOG = copyLog;

				const proto = InteractiveMode.prototype as any;
				const savedProtoHandleEvent = proto.handleEvent;
				proto.handleEvent = function () {};

				let shutdownHandler: any;
				rbfShellDisplayProbe({
					events: createEventBus(),
					on(name: string, fn: any) {
						if (name === "session_shutdown") shutdownHandler = fn;
					},
					registerCommand() {},
				} as any);

				const r2: any = {
					openUrl() {},
					async copySelection() {
						return true;
					},
					copyOnSelect: false,
				};

				proto.handleEvent.call({ renderer: r2 });
				expect(r2.copyOnSelect).toBe(true);

				const otherCopy = async () => false;
				r2.copySelection = otherCopy;
				r2.copyOnSelect = true;

				proto.handleEvent.call({ renderer: r2 });
				expect(r2.copySelection).toBe(otherCopy);
				expect(r2.copyOnSelect).toBe(true);

				shutdownHandler();
				expect(r2.copySelection).toBe(otherCopy);
				expect(r2.copyOnSelect).toBe(true);

				proto.handleEvent = savedProtoHandleEvent;
				delete process.env.RBF_PROBE_LINK_LOG;
				delete process.env.RBF_PROBE_COPY_LOG;
			});

			it("restores original own and inherited property shapes when probe owns configuration", async () => {
				const linkLog = `/tmp/test-probe-link-${Date.now()}.log`;
				const copyLog = `/tmp/test-probe-copy-${Date.now()}.log`;
				process.env.RBF_PROBE_LINK_LOG = linkLog;
				process.env.RBF_PROBE_COPY_LOG = copyLog;

				const proto = InteractiveMode.prototype as any;
				const savedProtoHandleEvent = proto.handleEvent;
				proto.handleEvent = function () {};

				let shutdownHandler: any;
				rbfShellDisplayProbe({
					events: createEventBus(),
					on(name: string, fn: any) {
						if (name === "session_shutdown") shutdownHandler = fn;
					},
					registerCommand() {},
				} as any);

				const origOpen = () => {};
				const origCopy = async () => true;
				const r3: any = { openUrl: origOpen, copySelection: origCopy, copyOnSelect: false };
				const parent = { copyOnSelect: false };
				const r4: any = Object.create(parent);
				r4.openUrl = origOpen;
				r4.copySelection = origCopy;

				proto.handleEvent.call({ renderer: r3 });
				proto.handleEvent.call({ renderer: r4 });

				expect(r3.copyOnSelect).toBe(true);
				expect(r4.copyOnSelect).toBe(true);
				expect(Object.prototype.hasOwnProperty.call(r4, "copyOnSelect")).toBe(true);

				shutdownHandler();

				expect(r3.openUrl).toBe(origOpen);
				expect(r3.copySelection).toBe(origCopy);
				expect(r3.copyOnSelect).toBe(false);
				expect(Object.prototype.hasOwnProperty.call(r3, "copyOnSelect")).toBe(true);

				expect(r4.openUrl).toBe(origOpen);
				expect(r4.copySelection).toBe(origCopy);
				expect(r4.copyOnSelect).toBe(false);
				expect(Object.prototype.hasOwnProperty.call(r4, "copyOnSelect")).toBe(false);

				proto.handleEvent = savedProtoHandleEvent;
				delete process.env.RBF_PROBE_LINK_LOG;
				delete process.env.RBF_PROBE_COPY_LOG;
			});

			it("delegates to inherited original callbacks under later wrappers after shutdown preserving context, arguments and return values", async () => {
				const linkLog = `/tmp/test-probe-link-${Date.now()}.log`;
				const copyLog = `/tmp/test-probe-copy-${Date.now()}.log`;
				process.env.RBF_PROBE_LINK_LOG = linkLog;
				process.env.RBF_PROBE_COPY_LOG = copyLog;

				const proto = InteractiveMode.prototype as any;
				const savedProtoHandleEvent = proto.handleEvent;
				proto.handleEvent = function () {};

				let shutdownHandler: any;
				rbfShellDisplayProbe({
					events: createEventBus(),
					on(name: string, fn: any) {
						if (name === "session_shutdown") shutdownHandler = fn;
					},
					registerCommand() {},
				} as any);

				let opens = 0;
				let copies = 0;
				const parent = {
					openUrl(this: any, ...args: any[]) {
						opens++;
						return `${this.tag}:${args.join(",")}`;
					},
					copySelection(this: any, ...args: any[]) {
						copies++;
						return Promise.resolve(this.tag === "native" && args.join(",") === "a,b" ? "inherited-ok" : "mismatch");
					},
					copyOnSelect: false,
				};
				const renderer: any = Object.assign(Object.create(parent), { tag: "native" });

				proto.handleEvent.call({ renderer });

				const innerOpen = renderer.openUrl;
				const innerCopy = renderer.copySelection;
				renderer.openUrl = function (this: any, ...args: any[]) {
					return innerOpen.apply(this, args);
				};
				renderer.copySelection = function (this: any, ...args: any[]) {
					return innerCopy.apply(this, args);
				};

				shutdownHandler();

				const openRes = renderer.openUrl("a", "b");
				const copyRes = await renderer.copySelection("a", "b");

				expect(opens).toBe(1);
				expect(openRes).toBe("native:a,b");
				expect(copies).toBe(1);
				expect(copyRes).toBe("inherited-ok");

				proto.handleEvent = savedProtoHandleEvent;
				delete process.env.RBF_PROBE_LINK_LOG;
				delete process.env.RBF_PROBE_COPY_LOG;
			});
		});
	});
});
