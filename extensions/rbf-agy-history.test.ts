import { describe, expect, it, beforeAll } from "vitest";
import { ACTIVITY_LIMITS, AGY_HISTORY_FAILURE, AGY_HISTORY_UNAVAILABLE, appendAgyActivity, captureAgyActivity, newAgyActivityBudget, parseAgyActivity, recordAgyActivity, renderAgyActivity, type AgyHistoryEntry, type AgyHistoryGuard, type AgyObservationScope, type NativeToolObservation } from "./lib/agy-history.js";
import { initTheme } from "@earendil-works/pi-coding-agent";
beforeAll(() => initTheme("dark", false));
import { visibleWidth } from "@earendil-works/pi-tui";
const scope: AgyObservationScope = { piSessionId: "pi-1", inputEntryId: "input-1", rootConversationId: "root-1", turnCount: 1, source: { kind: "root", conversationId: "root-1" } };
const tool = (output?: string, extra: Partial<NativeToolObservation> = {}): NativeToolObservation => ({ kind: "tool", conversationId: "root-1", index: 4, state: "DONE", toolName: "run_command", info: { name: "run_command", ...(output !== undefined ? { output } : {}) }, ...extra });
const theme = { fg: (_role: string, text: string) => text } as any;
function journal() {
	const entries: AgyHistoryEntry[] = [{ id: "input-1", parentId: null, type: "message" }];
	const fingerprint = (values: readonly AgyHistoryEntry[]) => JSON.stringify(values);
	const guard: AgyHistoryGuard = { assertCurrent() {}, entries: () => entries, leafId: () => entries.at(-1)!.id, fingerprint, expectedFingerprint: fingerprint(entries), append(customType, data) { entries.push({ id: `entry-${entries.length}`, parentId: entries.at(-1)!.id, type: "custom", customType, data }); } };
	const budget = newAgyActivityBudget();
	return { entries, guard, budget, save(event = tool("hello"), association = scope) { const result = recordAgyActivity(event, association, budget, guard); guard.expectedFingerprint = result.fingerprint; return result; } };
}
describe("bounded immutable observation values", () => {
	it.each([65535, 65536, 65537])("retains an exact UTF-8 prefix at %i payload bytes", bytes => {
		const { data } = captureAgyActivity(tool("x".repeat(bytes)), scope, newAgyActivityBudget());
		expect(data.output).toEqual({ text: "x".repeat(Math.min(bytes, 65536)), originalBytes: bytes, omittedBytes: Math.max(0, bytes - 65536) });
	});
	it("does not split a Unicode scalar at the capture boundary", () => {
		const { data } = captureAgyActivity(tool("x".repeat(65535) + "💠"), scope, newAgyActivityBudget());
		expect(data.output!.text).toBe("x".repeat(65535)); expect(data.output!.omittedBytes).toBe(4); expect(data.output!.text).not.toContain("�");
	});
	it.each([262143, 262144, 262145])("labels loss at the cumulative payload boundary %i", bytes => {
		const h = journal(); let left = bytes;
		while (left) { const n = Math.min(left, 65536); h.save(tool("x".repeat(n))); left -= n; }
		const values = h.entries.slice(1).map(e => e.data as any);
		expect(values.reduce((n, d) => n + d.output.text.length, 0)).toBe(Math.min(bytes, 262144));
		expect(values.reduce((n, d) => n + d.output.omittedBytes, 0)).toBe(Math.max(0, bytes - 262144));
	});
	it.each([511, 512, 513])("accepts only bounded opaque identities: %i bytes", bytes => {
		const attempt = () => captureAgyActivity(tool(), { ...scope, inputEntryId: "x".repeat(bytes) }, newAgyActivityBudget());
		if (bytes <= 512) expect(attempt().data.inputEntryId.length).toBe(bytes); else expect(attempt).toThrow(AGY_HISTORY_FAILURE);
	});
	it("keeps missing, empty, error and generic data distinct", () => {
		expect(captureAgyActivity(tool(), scope, newAgyActivityBudget()).data.output).toBeUndefined();
		expect(captureAgyActivity(tool(""), scope, newAgyActivityBudget()).data.output).toEqual({ text: "", originalBytes: 0, omittedBytes: 0 });
		const data = captureAgyActivity(tool("file content", { toolName: "read_file", info: { name: "read_file", parameters: { path: "src/main.ts" }, error: { type: "ReadError", message: "denied" } } }), scope, newAgyActivityBudget()).data;
		expect(data.command).toBeUndefined(); expect(data.parameters!.text).toBe('{"path":"src/main.ts"}'); expect(data.error!.message.text).toBe("denied");
	});
	it("does not infer a command from a lookalike tool or parameter key", () => {
		for (const event of [tool(undefined, { toolName: "run_command_v2", info: { name: "run_command_v2", parameters: { CommandLine: "echo hi" } } }), tool(undefined, { info: { name: "run_command", parameters: { commandline: "echo hi" } } })]) expect(captureAgyActivity(event, scope, newAgyActivityBudget()).data.command).toBeUndefined();
	});
	it("keeps child attribution explicit and separate from root source", () => {
		const child: AgyObservationScope = { ...scope, source: { kind: "child", childId: "worker-a", conversationId: "child-1", parentConversationId: "root-1" } };
		expect(() => captureAgyActivity(tool(), child, newAgyActivityBudget())).toThrow();
		const data = captureAgyActivity(tool("child output", { conversationId: "child-1" }), child, newAgyActivityBudget()).data;
		expect(data.source).toEqual(child.source); expect(data.rootConversationId).toBe("root-1");
	});
});
describe("guarded append boundary", () => {
	it.each([255, 256, 257])("accepts exactly the admitted observation count at %i", count => {
		const h = journal(); for (let i = 0; i < Math.min(count, 256); i++) h.save(tool());
		if (count > 256) expect(() => h.save(tool())).toThrow(AGY_HISTORY_FAILURE);
		expect(h.entries.length).toBe(Math.min(count, 256) + 1);
	});
	it("checks cumulative serialized limit before append", () => {
		const h = journal(); h.budget.serializedBytes = ACTIVITY_LIMITS.requestSerialized;
		expect(() => h.save()).toThrow(AGY_HISTORY_FAILURE); expect(h.entries).toHaveLength(1);
	});
	it("rejects an append that mutates its supplied object to defeat read-back", () => {
		const h = journal(), original = h.guard.append;
		h.guard.append = (type, data) => { data.state = "ERROR"; original(type, data); };
		expect(() => h.save()).toThrow(AGY_HISTORY_FAILURE);
	});
	it("rejects before append when the expected prefix or current scope changed", () => {
		const h = journal(); h.entries[0]!.id = "other"; expect(() => h.save()).toThrow(AGY_HISTORY_FAILURE); expect(h.entries).toHaveLength(1);
		const current = journal(); current.guard.assertCurrent = () => { throw Error("departed"); }; expect(() => current.save()).toThrow("departed"); expect(current.entries).toHaveLength(1);
	});
	it("does not accept a failed write merely because its entry is in memory", () => {
		const h = journal(), original = h.guard.append; h.guard.append = (type, data) => { original(type, data); throw Error("disk full"); };
		expect(() => h.save()).toThrow("disk full"); expect(h.budget.observations).toBe(0);
	});
});
describe("historical rendering", () => {
	it("discloses preview omission separately from capture loss and expands captured content", () => {
		const data = captureAgyActivity(tool("one\ntwo\nthree\nfour\nfive\nsix"), scope, newAgyActivityBudget()).data;
		const collapsed = renderAgyActivity(data, false, theme, "Ctrl+O to expand").render(80).join("\n");
		expect(collapsed).toContain("three"); expect(collapsed).not.toContain("four"); expect(collapsed).toContain("Ctrl+O to expand"); expect(collapsed).not.toContain("Recorded output is incomplete.");
		const expanded = renderAgyActivity(data, true, theme).render(80).join("\n"); expect(expanded).toContain("six"); expect(expanded).toContain("Historical report; current command state is unknown.");
	});
	it("renders missing details and generic tools literally without a success claim", () => {
		const data = captureAgyActivity(tool(undefined, { toolName: "read_file", info: { name: "read_file", parameters: { path: "src/main.ts" } } }), scope, newAgyActivityBudget()).data;
		const text = renderAgyActivity(data, false, theme).render(80).join("\n"); expect(text).toContain("AGY tool · step 4 · reported DONE"); expect(text).toContain('Parameters: {"path":"src/main.ts"}'); expect(text).toContain("Output: not reported"); expect(text).toContain("Tool outcome: unknown"); expect(text).not.toContain("AGY command");
	});
	it("sanitizes terminal controls before storage and again on display", () => {
		const data = captureAgyActivity(tool("ok\x1b[2J\x1b]0;forged title\x07\r\x00safe"), scope, newAgyActivityBudget()).data;
		expect(data.output!.text).toBe("oksafe");
		data.output = { text: "x\x1b[2Jy", originalBytes: 6, omittedBytes: 0 };
		const text = renderAgyActivity(data, true, theme).render(80).join("\n"); expect(text).not.toContain("\x1b"); expect(text).toContain("xy");
	});
	it.each([0, 1, 2, 12, 80, 120])("fits narrow and ordinary terminal widths: %i", width => {
		const data = captureAgyActivity(tool("界".repeat(500) + "\t" + "💠".repeat(50)), scope, newAgyActivityBudget()).data;
		for (const expanded of [false, true]) expect(renderAgyActivity(data, expanded, theme, "Ctrl+O to expand").render(width).every(row => visibleWidth(row) <= width)).toBe(true);
	});
	it("preserves capture-loss notice after serialization/reopen", () => {
		const data = captureAgyActivity(tool("x".repeat(65537)), scope, newAgyActivityBudget()).data;
		const reopened = JSON.parse(JSON.stringify(data)); for (const expanded of [false, true]) expect(renderAgyActivity(reopened, expanded, theme).render(80).join("\n")).toContain("Recorded output is incomplete.");
	});
	it.each([null, {}, {schemaVersion:2}, {...captureAgyActivity(tool(),scope,newAgyActivityBudget()).data,sequence:0}, {...captureAgyActivity(tool(),scope,newAgyActivityBudget()).data,extra:"x".repeat(ACTIVITY_LIMITS.envelope+1)}])("rejects unsupported or malformed saved data without execution", data => {
		expect(parseAgyActivity(data)).toBeUndefined(); expect(renderAgyActivity(data, true, theme).render(80).join("\n")).toBe(AGY_HISTORY_UNAVAILABLE);
	});
});

describe("reviewed terminal copy", () => {
 it("matches the reviewed short ERROR state", () => {
  const event = tool(undefined, {state:"ERROR", info:{name:"run_command", parameters:{CommandLine:"bun run build"},error:{type:"CommandError",message:"permission denied"}}});
  const data = captureAgyActivity(event,scope,newAgyActivityBudget()).data;
  expect(renderAgyActivity(data,false,theme).render(80)).toEqual(["AGY command · step 4 · reported ERROR","  Command: bun run build","  Error [CommandError]: permission denied","  Command outcome: unknown"]);
 });
 it("puts expansion before unknown outcome and capture loss before output", () => {
  const data=captureAgyActivity(tool("Building package 1\nBuilding package 2\nBuilding package 3\nBuilding package 4"),scope,newAgyActivityBudget()).data;
  data.command={text:"bun run build",originalBytes:13,omittedBytes:0};
  expect(renderAgyActivity(data,false,theme,"Ctrl+O to expand").render(80)).toEqual(["AGY command · step 4 · reported DONE","  Command: bun run build","  Output:","    Building package 1","    Building package 2","    Building package 3","    ... (Ctrl+O to expand)","  Command outcome: unknown"]);
 });
 it("keeps combined output/error preview to three rows",()=>{
  const data=captureAgyActivity(tool(undefined,{state:"ERROR",info:{name:"run_command",output:"one\ntwo",error:{type:"Error",message:"three\nfour\nfive"}}}),scope,newAgyActivityBudget()).data;
  const text=renderAgyActivity(data,false,theme,"Ctrl+O to expand").render(80).join("\n");expect(text).toContain("three");expect(text).not.toContain("four");expect(renderAgyActivity(data,true,theme).render(80).join("\n")).toContain("five");
 });
});

describe("parameter encoding contract", () => {
 it("names an incomplete parameter value as a JSON prefix",()=>{
  const data=captureAgyActivity(tool(undefined,{toolName:"read_file",info:{name:"read_file",parameters:{path:"x".repeat(65536)}}}),scope,newAgyActivityBudget()).data;
  expect(data.parameters).toMatchObject({encoding:"json-prefix",originalBytes:65547,omittedBytes:11});
  expect(renderAgyActivity(data,true,theme).render(80).join("\n")).toContain("Parameters (JSON prefix):");
 });
 it("validates complete JSON and rejects inconsistent saved encoding",()=>{
  const data=captureAgyActivity(tool(undefined,{toolName:"read_file",info:{name:"read_file",parameters:{path:"main.ts"}}}),scope,newAgyActivityBudget()).data;
  expect(data.parameters!.encoding).toBe("json");expect(parseAgyActivity(data)).toBeDefined();
  const mismatched=structuredClone(data);mismatched.parameters!.encoding="json-prefix";expect(parseAgyActivity(mismatched)).toBeUndefined();
  const malformed=structuredClone(data);malformed.parameters={text:"{",originalBytes:1,omittedBytes:0,encoding:"json"};expect(parseAgyActivity(malformed)).toBeUndefined();
 });
});
