import { describe, expect, it, beforeAll } from "vitest";
import { ACTIVITY_LIMITS, AGY_ACP_ACTIVITY, AGY_HISTORY_FAILURE, AGY_HISTORY_UNAVAILABLE, appendAgyAcpActivity, captureAgyAcpActivity, newAgyActivityBudget, parseAgyAcpActivity, recordAgyAcpActivity, renderAgyAcpActivity, type AgyAcpActivityInput, type AgyAcpActivityObservation, type AgyAcpApprovalReason, type AgyAcpApprovalReply, type AgyHistoryEntry, type AgyHistoryGuard } from "./lib/agy-history.js";
import { initTheme } from "@earendil-works/pi-coding-agent";
beforeAll(() => initTheme("dark", false));
import { visibleWidth } from "@earendil-works/pi-tui";
const theme = { fg: (_role: string, text: string) => text } as any;
describe("pi-21.3 ACP mapping", () => {
	const taggedTheme = { fg: (role: string, text: string) => `[${role}]${text}` } as any;
	const acpInput = (overrides: Partial<AgyAcpActivityInput> = {}): AgyAcpActivityInput => ({
		piSessionId: "pi-1",
		inputEntryId: "input-1",
		acpSessionId: "acp-1",
		toolCallId: "tc-1",
		name: "run_command",
		kind: "execute",
		title: "ls -1",
		state: "completed",
		...overrides,
	});
	function acpJournal() {
		const entries: AgyHistoryEntry[] = [{ id: "input-1", parentId: null, type: "message" }];
		const fingerprint = (values: readonly AgyHistoryEntry[]) => JSON.stringify(values);
		const guard: AgyHistoryGuard<AgyAcpActivityObservation> = {
			assertCurrent() {},
			entries: () => entries,
			leafId: () => entries.at(-1)!.id,
			fingerprint,
			expectedFingerprint: fingerprint(entries),
			append(customType, data) { entries.push({ id: `entry-${entries.length}`, parentId: entries.at(-1)!.id, type: "custom", customType, data }); },
		};
		const budget = newAgyActivityBudget();
		return {
			entries,
			guard,
			budget,
			save(input: AgyAcpActivityInput = acpInput({ command: "ls -1", output: "a.txt\nb.txt", exitCode: 0 })) {
				const result = recordAgyAcpActivity(input, budget, guard);
				guard.expectedFingerprint = result.fingerprint;
				return result;
			},
		};
	}

	it("exports AGY_ACP_ACTIVITY and records guarded ACP activity entries", () => {
		expect(AGY_ACP_ACTIVITY).toBe("rbf-agy-acp-activity/v1");
		const h = acpJournal();
		const res = h.save(acpInput({ command: "ls -1", parameters: { CommandLine: "ls -1" }, output: "a.txt\nb.txt", exitCode: 0 }));
		expect(res.entryId).toBe("entry-1");
		expect(h.entries[1]?.customType).toBe(AGY_ACP_ACTIVITY);
		expect(h.budget.observations).toBe(1);
		const saved = h.entries[1]?.data as AgyAcpActivityObservation;
		expect(parseAgyAcpActivity(saved)).toEqual(saved);
		expect(saved.sequence).toBe(1);
		expect(saved.exitCode).toBe(0);
	});

	it("consumes payload budget in command -> output -> parameters order and encodes JSON/JSON-prefix", () => {
		const cmd = "c".repeat(30 * 1024);
		const out = "o".repeat(30 * 1024);
		const params = { CommandLine: "p".repeat(10 * 1024) };
		const { data, payloadBytes } = captureAgyAcpActivity(acpInput({ command: cmd, output: out, parameters: params }), newAgyActivityBudget());
		expect(data.command).toEqual({ text: cmd, originalBytes: 30 * 1024, omittedBytes: 0 });
		expect(data.output).toEqual({ text: out, originalBytes: 30 * 1024, omittedBytes: 0 });
		expect(data.parameters!.encoding).toBe("json-prefix");
		expect(Buffer.byteLength(data.parameters!.text)).toBe(4 * 1024);
		expect(data.parameters!.omittedBytes).toBeGreaterThan(0);
		expect(payloadBytes).toBe(ACTIVITY_LIMITS.payload);
		expect(parseAgyAcpActivity(data)).toEqual(data);

		const small = captureAgyAcpActivity(acpInput({ parameters: { CommandLine: "ls -1" } }), newAgyActivityBudget()).data;
		expect(small.parameters).toEqual({ text: '{"CommandLine":"ls -1"}', originalBytes: 23, omittedBytes: 0, encoding: "json" });
	});

	it.each([65535, 65536, 65537])("enforces the 64 KiB per-record payload cap at %i bytes", bytes => {
		const { data, payloadBytes } = captureAgyAcpActivity(acpInput({ output: "x".repeat(bytes) }), newAgyActivityBudget());
		expect(data.output).toEqual({ text: "x".repeat(Math.min(bytes, 65536)), originalBytes: bytes, omittedBytes: Math.max(0, bytes - 65536) });
		expect(payloadBytes).toBe(Math.min(bytes, 65536));
	});

	it("preserves UTF-8 scalar boundaries in captured fields and clamped titles", () => {
		const { data } = captureAgyAcpActivity(acpInput({
			title: "t".repeat(511) + "💠",
			output: "x".repeat(65535) + "💠",
		}), newAgyActivityBudget());
		expect(data.title).toBe("t".repeat(511));
		expect(data.title).not.toContain("\ufffd");
		expect(data.output!.text).toBe("x".repeat(65535));
		expect(data.output!.omittedBytes).toBe(4);
		expect(data.output!.text).not.toContain("\ufffd");
	});

	it("normalizes and clamps name, kind, and title with safe fallbacks so control chars or >512-byte metadata never drop activity", () => {
		const { data } = captureAgyAcpActivity(acpInput({
			name: "  read\n\t_file\x1b[31m  ",
			kind: "  read\t\nkind\x1b[0m  ",
			title: "  ls\n\t-1\x1b[31m\n\t--all  ",
		}), newAgyActivityBudget());
		expect(data.name).toBe("read _file");
		expect(data.kind).toBe("read kind");
		expect(data.title).toBe("ls -1 --all");
		expect(parseAgyAcpActivity(data)).toEqual(data);

		const fallbackTitle = captureAgyAcpActivity(acpInput({ title: "\t\n  \x1b[2J" }), newAgyActivityBudget()).data;
		expect(fallbackTitle.title).toBe("run_command");
		expect(parseAgyAcpActivity(fallbackTitle)).toEqual(fallbackTitle);

		const fallbackAll = captureAgyAcpActivity(acpInput({
			name: "\x1b[2J\t\n ",
			kind: "\x1b[31m\n",
			title: "\x1b[0m  ",
		}), newAgyActivityBudget()).data;
		expect(fallbackAll.name).toBe("tool");
		expect(fallbackAll.kind).toBe("other");
		expect(fallbackAll.title).toBe("tool");
		expect(parseAgyAcpActivity(fallbackAll)).toEqual(fallbackAll);

		const clamped = captureAgyAcpActivity(acpInput({
			name: "n".repeat(511) + "💠",
			kind: "k".repeat(511) + "💠",
			title: "t".repeat(511) + "💠",
		}), newAgyActivityBudget()).data;
		expect(clamped.name).toBe("n".repeat(511));
		expect(clamped.kind).toBe("k".repeat(511));
		expect(clamped.title).toBe("t".repeat(511));
		expect(parseAgyAcpActivity(clamped)).toEqual(clamped);
	});

	it.each([262143, 262144, 262145])("enforces the 256 KiB cumulative request payload cap at %i bytes", bytes => {
		const h = acpJournal();
		let left = bytes;
		while (left) {
			const n = Math.min(left, 65536);
			h.save(acpInput({ output: "x".repeat(n) }));
			left -= n;
		}
		const values = h.entries.slice(1).map(e => e.data as AgyAcpActivityObservation);
		expect(values.reduce((n, d) => n + d.output!.text.length, 0)).toBe(Math.min(bytes, 262144));
		expect(values.reduce((n, d) => n + d.output!.omittedBytes, 0)).toBe(Math.max(0, bytes - 262144));
	});

	it.each([255, 256, 257])("enforces the 256 records cap at %i observations", total => {
		const h = acpJournal();
		for (let i = 0; i < Math.min(total, 256); i++) h.save(acpInput({ toolCallId: `tc-${i + 1}` }));
		if (total > 256) expect(() => h.save(acpInput({ toolCallId: "tc-257" }))).toThrow(AGY_HISTORY_FAILURE);
		expect(h.entries.length).toBe(Math.min(total, 256) + 1);
	});

	it("enforces the 192 KiB envelope cap and cumulative serialized cap", () => {
		const valid = captureAgyAcpActivity(acpInput(), newAgyActivityBudget()).data;
		// Each NUL byte JSON-escapes to 6 bytes (\u0000), exceeding the 192 KiB envelope while staying under the 64 KiB text cap.
		const bloated = { ...valid, output: { text: "\x00".repeat(33_000), originalBytes: 33_000, omittedBytes: 0 } };
		expect(Buffer.byteLength(bloated.output.text)).toBeLessThanOrEqual(ACTIVITY_LIMITS.payload);
		expect(Buffer.byteLength(JSON.stringify(bloated))).toBeGreaterThan(ACTIVITY_LIMITS.envelope);
		expect(parseAgyAcpActivity(bloated)).toBeUndefined();

		const h = acpJournal();
		h.budget.serializedBytes = ACTIVITY_LIMITS.requestSerialized;
		expect(() => h.save()).toThrow(AGY_HISTORY_FAILURE);
		expect(h.entries).toHaveLength(1);
	});

	it("rejects tampered read-back, changed prefix, and unconfirmed appends on recordAgyAcpActivity", () => {
		const tampered = acpJournal();
		const origAppend = tampered.guard.append;
		tampered.guard.append = (type, data) => { data.state = "failed"; origAppend(type, data); };
		expect(() => tampered.save()).toThrow(AGY_HISTORY_FAILURE);
		expect(tampered.budget.observations).toBe(0);

		const drifted = acpJournal();
		drifted.entries[0]!.id = "other";
		expect(() => drifted.save()).toThrow(AGY_HISTORY_FAILURE);
		expect(drifted.entries).toHaveLength(1);

		const failed = acpJournal();
		const origFailed = failed.guard.append;
		failed.guard.append = (type, data) => { origFailed(type, data); throw new Error("disk full"); };
		expect(() => failed.save()).toThrow("disk full");
		expect(failed.budget.observations).toBe(0);
	});

	it("rejects invalid ACP records in parseAgyAcpActivity, appendAgyAcpActivity, and renderAgyAcpActivity", () => {
		const base = captureAgyAcpActivity(acpInput({ command: "ls -1", parameters: { CommandLine: "ls -1" }, output: "ok", exitCode: 0 }), newAgyActivityBudget()).data;
		const invalidCases: unknown[] = [
			null,
			{},
			{ ...base, schemaVersion: 2 },
			{ ...base, extra: true },
			{ ...base, sequence: 0 },
			{ ...base, sequence: 257 },
			{ ...base, state: "DONE" },
			{ ...base, state: "ERROR" },
			{ ...base, title: "line1\nline2" },
			{ ...base, title: "a\tb" },
			{ ...base, title: "x".repeat(513) },
			{ ...base, title: "ok\x1b[31m" },
			{ ...base, name: "read_file" }, // command present while name !== "run_command"
			{ ...base, approval: { reply: "allow_always", reason: "user" } },
			{ ...base, approval: { reply: "reject_once", reason: "timeout" } },
			{ ...base, approval: { reply: "reject_once", reason: "user", extra: 1 } },
			{ ...base, parameters: { text: '{"a":1}', originalBytes: 7, omittedBytes: 0, encoding: "json-prefix" } },
			{ ...base, parameters: { text: '{"a":1', originalBytes: 7, omittedBytes: 1, encoding: "json" } },
			{ ...base, parameters: { text: "{", originalBytes: 1, omittedBytes: 0, encoding: "json" } },
			{ ...base, parameters: { text: "[1,2]", originalBytes: 5, omittedBytes: 0, encoding: "json" } },
			{ ...base, exitCode: 1.5 },
			{ ...base, exitCode: Number.NaN },
			{ ...base, exitCode: "0" },
			{ ...base, command: { text: "c".repeat(40_000), originalBytes: 40_000, omittedBytes: 0 }, output: { text: "o".repeat(30_000), originalBytes: 30_000, omittedBytes: 0 } },
		];
		const h = acpJournal();
		for (const bad of invalidCases) {
			expect(parseAgyAcpActivity(bad)).toBeUndefined();
			expect(() => appendAgyAcpActivity(bad as AgyAcpActivityObservation, h.guard)).toThrow(AGY_HISTORY_FAILURE);
			expect(renderAgyAcpActivity(bad, true, taggedTheme).render(80)).toEqual([`[warning]${AGY_HISTORY_UNAVAILABLE}`]);
		}
		// Non-run_command ignores command during capture; negative safe-integer exitCode is valid.
		const toolData = captureAgyAcpActivity(acpInput({ name: "read_file", kind: "read", title: "Read file", command: "ignored", exitCode: -15 }), newAgyActivityBudget()).data;
		expect(toolData.command).toBeUndefined();
		expect(toolData.exitCode).toBe(-15);
	});

	it.each([80, 120])("renders completed ls -1 command collapsed and expanded at %i cols", width => {
		const data = captureAgyAcpActivity(acpInput({
			command: "ls -1",
			parameters: { CommandLine: "ls -1" },
			output: "a.txt\nb.txt",
			exitCode: 0,
		}), newAgyActivityBudget()).data;

		const collapsed = renderAgyAcpActivity(data, false, theme, "Ctrl+O to expand").render(width);
		expect(collapsed.slice(0, 2)).toEqual([
			"AGY command · step 1 · reported DONE",
			"  Command: ls -1",
		]);
		expect(collapsed).toEqual([
			"AGY command · step 1 · reported DONE",
			"  Command: ls -1",
			"  Output:",
			"    a.txt",
			"    b.txt",
			"  Exit code: 0",
			"  Command outcome: unknown",
		]);
		expect(collapsed.join("\n")).not.toContain(AGY_HISTORY_UNAVAILABLE);

		const expanded = renderAgyAcpActivity(data, true, theme).render(width);
		expect(expanded).toEqual([
			"AGY command · step 1 · reported DONE",
			"  Command: ls -1",
			'  Parameters: {"CommandLine":"ls -1"}',
			"  Output:",
			"    a.txt",
			"    b.txt",
			"  Exit code: 0",
			"  Command outcome: unknown",
			"  ACP session: acp-1 · tool call tc-1",
			"  Pi input: input-1 · report 1",
			"  Historical report; current command state is unknown.",
		]);
		expect(expanded.join("\n")).not.toContain(AGY_HISTORY_UNAVAILABLE);

		const tagged = renderAgyAcpActivity(data, true, taggedTheme).render(width);
		expect(tagged[0]).toBe("[toolTitle]AGY command · step 1 · reported DONE");
		expect(tagged).toContain("[toolOutput]  Exit code: 0");
		expect(tagged).toContain("[dim]  ACP session: acp-1 · tool call tc-1");
		expect(tagged).toContain("[dim]  Pi input: input-1 · report 1");
	});

	it.each([80, 120])("renders rejected by you without Error details at %i cols", width => {
		const budget = newAgyActivityBudget();
		budget.observations = 1;
		const data = captureAgyAcpActivity(acpInput({
			command: "ls -1",
			state: "failed",
			approval: { reply: "reject_once", reason: "user" },
		}), budget).data;
		for (const expanded of [false, true]) {
			const lines = renderAgyAcpActivity(data, expanded, theme).render(width);
			expect(lines[0]).toBe("AGY command · step 2 · rejected by you");
			const text = lines.join("\n");
			expect(text).not.toContain("Error details");
			expect(text).not.toContain("reported ERROR");
			expect(renderAgyAcpActivity(data, expanded, taggedTheme).render(width)[0]).toBe("[toolTitle]AGY command · step 2 · rejected by you");
		}
	});

	it.each<[AgyAcpApprovalReply, AgyAcpApprovalReason]>([
		["cancelled", "turn-stopped"],
		["reject_once", "review-cap"],
		["reject_once", "unsafe"],
		["cancelled", "unsafe"],
	])("renders rejected by Pi for (%s, %s) without Error details", (reply, reason) => {
		const budget = newAgyActivityBudget();
		budget.observations = 2;
		const data = captureAgyAcpActivity(acpInput({
			command: "rm -rf /tmp/demo",
			state: "failed",
			approval: { reply, reason },
		}), budget).data;
		for (const width of [80, 120]) {
			for (const expanded of [false, true]) {
				const lines = renderAgyAcpActivity(data, expanded, theme).render(width);
				expect(lines[0]).toBe("AGY command · step 3 · rejected by Pi");
				const text = lines.join("\n");
				expect(text).not.toContain("Error details");
				expect(text).not.toContain("reported ERROR");
				expect(renderAgyAcpActivity(data, expanded, taggedTheme).render(width)[0]).toBe("[toolTitle]AGY command · step 3 · rejected by Pi");
			}
		}
	});

	it.each([undefined, { reply: "allow_once" as const, reason: "user" as const }])("renders reported ERROR with Error details when failed without rejection (%o)", approval => {
		const budget = newAgyActivityBudget();
		budget.observations = 3;
		const data = captureAgyAcpActivity(acpInput({
			command: "false",
			state: "failed",
			...(approval ? { approval } : {}),
			exitCode: 1,
		}), budget).data;
		for (const width of [80, 120]) {
			for (const expanded of [false, true]) {
				const tagged = renderAgyAcpActivity(data, expanded, taggedTheme).render(width);
				expect(tagged[0]).toBe("[error]AGY command · step 4 · reported ERROR");
				expect(tagged).toContain("[error]  Error details: not reported");
				expect(tagged).toContain("[toolOutput]  Exit code: 1");
			}
		}
	});

	it.each(["read_file", "invoke_subagent"])("renders non-command tool %s with Tool and Parameters in both collapsed and expanded views", toolName => {
		const data = captureAgyAcpActivity(acpInput({
			name: toolName,
			kind: "read",
			title: `Run ${toolName}`,
			parameters: { path: "src/main.ts" },
		}), newAgyActivityBudget()).data;
		for (const width of [80, 120]) {
			const collapsed = renderAgyAcpActivity(data, false, theme).render(width);
			expect(collapsed).toEqual([
				"AGY tool · step 1 · reported DONE",
				`  Tool: ${toolName}`,
				'  Parameters: {"path":"src/main.ts"}',
				"  Output: not reported",
				"  Tool outcome: unknown",
			]);
			const expanded = renderAgyAcpActivity(data, true, theme).render(width);
			expect(expanded).toEqual([
				"AGY tool · step 1 · reported DONE",
				`  Tool: ${toolName}`,
				'  Parameters: {"path":"src/main.ts"}',
				"  Output: not reported",
				"  Tool outcome: unknown",
				"  ACP session: acp-1 · tool call tc-1",
				"  Pi input: input-1 · report 1",
				"  Historical report; current tool state is unknown.",
			]);
		}
	});

	it("handles preview expansion, capture-loss notices, ANSI sanitization, and narrow widths for ACP rendering", () => {
		const longOut = captureAgyAcpActivity(acpInput({ command: "seq 6", output: "1\n2\n3\n4\n5\n6" }), newAgyActivityBudget()).data;
		const collapsed = renderAgyAcpActivity(longOut, false, theme, "Ctrl+O to expand").render(80).join("\n");
		expect(collapsed).toContain("    3");
		expect(collapsed).not.toContain("    4");
		expect(collapsed).toContain("Ctrl+O to expand");
		expect(collapsed).not.toContain("Recorded output is incomplete.");
		expect(renderAgyAcpActivity(longOut, true, theme).render(80).join("\n")).toContain("    6");

		const clipped = captureAgyAcpActivity(acpInput({ command: "cat big", output: "x".repeat(65537) }), newAgyActivityBudget()).data;
		expect(renderAgyAcpActivity(clipped, false, theme).render(80).join("\n")).toContain("Recorded output is incomplete.");
		expect(renderAgyAcpActivity(clipped, true, theme).render(80).join("\n")).toContain("  output: 65529 bytes retained; 8 bytes omitted (capture limit).");

		const tampered = captureAgyAcpActivity(acpInput({ command: "echo ok", output: "safe" }), newAgyActivityBudget()).data;
		tampered.output = { text: "a\x1b[2Jb", originalBytes: 6, omittedBytes: 0 };
		const rendered = renderAgyAcpActivity(tampered, true, theme).render(80).join("\n");
		expect(rendered).not.toContain("\x1b");
		expect(rendered).toContain("    ab");

		const wide = captureAgyAcpActivity(acpInput({ command: "echo wide", output: "界".repeat(200) + "\t" + "💠".repeat(20), exitCode: 0 }), newAgyActivityBudget()).data;
		for (const width of [0, 1, 2, 12, 80, 120]) {
			for (const expanded of [false, true]) {
				expect(renderAgyAcpActivity(wide, expanded, theme, "Ctrl+O to expand").render(width).every(row => visibleWidth(row) <= width)).toBe(true);
			}
		}
	});

});
