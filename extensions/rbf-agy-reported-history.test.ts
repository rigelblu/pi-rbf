import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ACTIVITY_LIMITS, AGY_ACTIVITY, AGY_REPORTED_ACTIVITY, AGY_HISTORY_FAILURE, AGY_HISTORY_UNAVAILABLE, appendAgyReportedStep, captureAgyActivity, captureAgyReportedStep, newAgyActivityBudget, parseAgyActivity, parseAgyReportedStep, recordAgyActivity, recordAgyReportedStep, renderAgyReportedStep, type AgyHistoryEntry, type AgyHistoryGuard, type AgyObservationScope, type AgyReportedStep } from "./lib/agy-history.js";
beforeAll(() => initTheme("dark", false));
const scope: AgyObservationScope = {piSessionId:"pi-1",inputEntryId:"input-1",rootConversationId:"root-1",turnCount:1,source:{kind:"child",childId:"worker-a",conversationId:"child-1",parentConversationId:"root-1"}};
const report = (extra: Partial<AgyReportedStep> = {}): AgyReportedStep => ({step_index:22,type:"GENERIC",source:"MODEL",status:"DONE",content:"supplied opaque text",...extra});
const theme = {fg: (_role: string, text: string) => text} as any;
function journal() {
	const entries: AgyHistoryEntry[] = [{id:"input-1",parentId:null,type:"message"}];
	const fingerprint = (values: readonly AgyHistoryEntry[]) => JSON.stringify(values);
	const guard: AgyHistoryGuard<any> = {assertCurrent() {},entries:()=>entries,leafId:()=>entries.at(-1)!.id,fingerprint,expectedFingerprint:fingerprint(entries),append(customType,data){entries.push({id:"entry-"+entries.length,parentId:entries.at(-1)!.id,type:"custom",customType,data});}};
	const budget = newAgyActivityBudget();
	return {entries,guard,budget,save(input=report(),association=scope){const result=recordAgyReportedStep(input,association,budget,guard);guard.expectedFingerprint=result.fingerprint;return result;}};
}
describe("opaque reported facts",()=>{
	it("preserves public child reported text and container scope without tool/state invention",()=>{
		const data=captureAgyReportedStep(report({step_index:1,type:"PLANNER_RESPONSE",content:"PI_AG9_CHILD_RESULT_20261103",created_at:"2026-11-03T06:27:55Z"}),scope,newAgyActivityBudget()).data;
		expect(data).toMatchObject({schemaVersion:2,kind:"reported-step",attribution:"container",source:scope.source,report:{step_index:1,type:"PLANNER_RESPONSE",source:"MODEL",status:"DONE"},content:{text:"PI_AG9_CHILD_RESULT_20261103",originalBytes:28,omittedBytes:0}});
		expect(data).not.toHaveProperty("toolName");expect(data).not.toHaveProperty("state");expect(data.report).not.toHaveProperty("conversationId");expect(parseAgyActivity(data)).toBeUndefined();expect(parseAgyReportedStep(JSON.parse(JSON.stringify(data)))).toEqual(data);
	});
	it.each([undefined,[],["content"],["content","content"]])("keeps supplied native flags distinct: %j", flags=>{
		const data=captureAgyReportedStep(report(flags===undefined?{}:{truncated_fields:flags}),scope,newAgyActivityBudget()).data;
		if(flags===undefined)expect(data.report).not.toHaveProperty("truncated_fields");else expect(data.report.truncated_fields).toEqual(flags);
		expect(data.content.omittedBytes).toBe(0);
	});
	it.each([undefined,"","2026-11-03T06:27:55Z"])("retains optional native time literally: %j", time=>{
		const data=captureAgyReportedStep(report(time===undefined?{}:{created_at:time}),scope,newAgyActivityBudget()).data;
		expect(data.report.created_at).toBe(time);const text=renderAgyReportedStep(data,true,theme).render(80).join("\n");expect(text).toContain("Native time: "+(time===undefined?"not reported":time===""?'""':time));
	});
	it.each([65535,65536,65537])("retains bounded literal content at %i bytes", bytes=>{
		const data=captureAgyReportedStep(report({content:"x".repeat(bytes)}),scope,newAgyActivityBudget()).data;expect(Buffer.byteLength(data.content.text)).toBe(Math.min(bytes,65536));expect(data.content.originalBytes).toBe(bytes);expect(data.content.omittedBytes).toBe(Math.max(0,bytes-65536));
	});
	it("uses sanitized UTF-8 bytes and never splits a scalar",()=>{
		const data=captureAgyReportedStep(report({content:"\x1b[2J"+"x".repeat(65535)+"\u{1f4a0}"}),scope,newAgyActivityBudget()).data;expect(data.content.originalBytes).toBe(65539);expect(data.content.text).toBe("x".repeat(65535));expect(data.content.omittedBytes).toBe(4);
	});
	it("separates native loss, local loss, empty content and zero retained bytes",()=>{
		const budget=newAgyActivityBudget();budget.payloadBytes=ACTIVITY_LIMITS.requestPayload;
		const cut=captureAgyReportedStep(report({truncated_fields:["content"]}),scope,budget).data;
		expect(cut.content).toEqual({text:"",originalBytes:20,omittedBytes:20});const view=renderAgyReportedStep(cut,false,theme).render(80).join("\n");expect(view).toContain("Native reported truncation.");expect(view).toContain("Local capture is incomplete.");
		const empty=captureAgyReportedStep(report({content:"",truncated_fields:[]}),scope,newAgyActivityBudget()).data;expect(empty.content).toEqual({text:"",originalBytes:0,omittedBytes:0});expect(renderAgyReportedStep(empty,false,theme).render(80).join("\n")).not.toContain("incomplete");
	});
	it.each([511,512,513])("bounds supplied metadata at %i bytes", bytes=>{const run=()=>captureAgyReportedStep(report({type:"x".repeat(bytes)}),scope,newAgyActivityBudget());if(bytes<=512)expect(run().data.report.type.length).toBe(bytes);else expect(run).toThrow(AGY_HISTORY_FAILURE);});
	it.each([31,32,33])("bounds supplied native flags at %i names", count=>{const run=()=>captureAgyReportedStep(report({truncated_fields:Array(count).fill("content")}),scope,newAgyActivityBudget());if(count<=32)expect(run().data.report.truncated_fields).toHaveLength(count);else expect(run).toThrow(AGY_HISTORY_FAILURE);});
	it.each([{thinking:"private"},{initial_prompt:"private"},{tool_calls:[]},{type:""},{status:null},{content:undefined},{truncated_fields:null},{truncated_fields:[null]},{truncated_fields:new Array(1)},{created_at:"bad\nline"},{source:"\x1b[2JMODEL"},{step_index:-1},{step_index:0.5}])("rejects unsupported raw projection without storing it", change=>{expect(()=>captureAgyReportedStep({...report(),...change} as any,scope,newAgyActivityBudget())).toThrow(AGY_HISTORY_FAILURE);});

	it.each([262143,262144,262145])("enforces cumulative opaque payload at %i bytes",bytes=>{const h=journal();for(let left=bytes;left>0;){const n=Math.min(left,65536);h.save(report({content:"x".repeat(n)}));left-=n;}const data=h.entries.slice(1).map(e=>e.data as any);expect(data.reduce((n,d)=>n+d.content.text.length,0)).toBe(Math.min(bytes,262144));expect(data.reduce((n,d)=>n+d.content.omittedBytes,0)).toBe(Math.max(0,bytes-262144));});
	it.each([196607,196608,196609])("validates an otherwise valid serialized envelope at %i bytes",bytes=>{const data=captureAgyReportedStep(report(),scope,newAgyActivityBudget()).data;data.content={text:"\0".repeat(Math.floor((bytes-1024)/6)),originalBytes:Math.floor((bytes-1024)/6),omittedBytes:0};const padding=bytes-Buffer.byteLength(JSON.stringify(data));data.content.text+="x".repeat(padding);data.content.originalBytes=Buffer.byteLength(data.content.text);expect(Buffer.byteLength(JSON.stringify(data))).toBe(bytes);if(bytes<=ACTIVITY_LIMITS.envelope)expect(parseAgyReportedStep(data)).toBeDefined();else expect(parseAgyReportedStep(data)).toBeUndefined();});
	it("rejects unknown saved keys/versions/shapes without executing",()=>{
		const good=captureAgyReportedStep(report(),scope,newAgyActivityBudget()).data;
		for(const value of [null,{}, {...good,schemaVersion:3},{...good,kind:"tool"},{...good,attribution:"per-row"},{...good,thinking:"private"},{...good,content:{...good.content,omittedBytes:1}},{...good,source:{kind:"root",conversationId:"wrong"}},{...good,report:{...good.report,toolName:"run_command"}}]){expect(parseAgyReportedStep(value)).toBeUndefined();expect(renderAgyReportedStep(value,true,theme).render(80).join("\n")).toBe(AGY_HISTORY_UNAVAILABLE);}
	});
	it("deep-copies input, scope and rendered saved values",()=>{
		const input=report({truncated_fields:["content"]}),association=structuredClone(scope),data=captureAgyReportedStep(input,association,newAgyActivityBudget()).data;
		(input.truncated_fields as string[]).push("extra");association.source.conversationId="changed";expect(data.report.truncated_fields).toEqual(["content"]);expect(data.source.conversationId).toBe("child-1");
		const component=renderAgyReportedStep(data,true,theme);data.content.text="mutated";expect(component.render(80).join("\n")).toContain("supplied opaque text");
	});
});
describe("shared bounded guarded journal",()=>{
	it("returns only verified entry identity/fingerprint and stays outside tool records",()=>{const h=journal(),saved=h.save();expect(saved).toEqual({entryId:"entry-1",fingerprint:JSON.stringify(h.entries)});expect(h.entries[1]!.customType).toBe(AGY_REPORTED_ACTIVITY);expect(h.budget).toMatchObject({observations:1,payloadBytes:20});});
	it("shares count, payload and serialized budgets across v1/v2",()=>{
		const h=journal();const root={...scope,source:{kind:"root" as const,conversationId:"root-1"}};const first=recordAgyActivity({kind:"tool",conversationId:"root-1",index:4,state:"DONE",toolName:"run_command",info:{name:"run_command",output:"x".repeat(65536)}},root,h.budget,h.guard);h.guard.expectedFingerprint=first.fingerprint;
		h.save(report({content:"x".repeat(65536)}));h.save(report({content:"x".repeat(65536)}));h.save(report({content:"x".repeat(65537)}));expect(h.budget.payloadBytes).toBe(262144);expect((h.entries.at(-1)!.data as any).content.omittedBytes).toBe(1);expect(h.entries[1]!.customType).toBe(AGY_ACTIVITY);expect(parseAgyActivity(h.entries[1]!.data)).toBeDefined();
	});
	it.each([255,256,257])("accepts only the shared observation count at %i", count=>{const h=journal();for(let i=0;i<Math.min(count,256);i++)h.save();if(count>256)expect(()=>h.save()).toThrow(AGY_HISTORY_FAILURE);expect(h.budget.observations).toBe(Math.min(count,256));});
	it("checks the serialized request bound before any append",()=>{const h=journal();h.budget.serializedBytes=ACTIVITY_LIMITS.requestSerialized;expect(()=>h.save()).toThrow(AGY_HISTORY_FAILURE);expect(h.entries).toHaveLength(1);});
	it("rejects foreign prefix and cannot be fooled by a mutable expected fingerprint",()=>{
		const h=journal(),append=h.guard.append;h.guard.append=(type,data)=>{h.entries[0]!.id="foreign";h.guard.expectedFingerprint=JSON.stringify(h.entries);append(type,data);};expect(()=>h.save()).toThrow(AGY_HISTORY_FAILURE);expect(h.budget.observations).toBe(0);
	});
	it.each(["throw-after-memory","post-currentness","wrong-parent","extra-entry","changed-data"])("failed %s never advances budget or allows a retry", fault=>{
		const h=journal(),append=h.guard.append;let checks=0;
		if(fault==="post-currentness")h.guard.assertCurrent=()=>{if(++checks>1)throw Error("revoked");};
		h.guard.append=(type,data)=>{append(type,data);if(fault==="throw-after-memory")throw Error("disk failure");if(fault==="wrong-parent")h.entries.at(-1)!.parentId="wrong";if(fault==="extra-entry")append(type,data);if(fault==="changed-data")(h.entries.at(-1)!.data as any).report.status="OTHER";};
		expect(()=>h.save()).toThrow();const count=h.entries.length;h.guard.assertCurrent=()=>{};h.guard.append=append;h.guard.expectedFingerprint=JSON.stringify(h.entries);expect(()=>h.save()).toThrow(AGY_HISTORY_FAILURE);expect(h.entries).toHaveLength(count);expect(h.budget.observations).toBe(0);
	});
	it("refuses late callbacks before append and closes their write context",()=>{const h=journal();h.guard.assertCurrent=()=>{throw Error("ticket revoked");};expect(()=>h.save()).toThrow("ticket revoked");h.guard.assertCurrent=()=>{};expect(()=>h.save()).toThrow(AGY_HISTORY_FAILURE);expect(h.entries).toHaveLength(1);});
	it("rejects reentrant guarded writes even when the append hook catches the rejection",()=>{const h=journal(),append=h.guard.append,data=captureAgyReportedStep(report(),scope,h.budget).data;h.guard.append=(type,value)=>{expect(()=>appendAgyReportedStep(data,h.guard)).toThrow(AGY_HISTORY_FAILURE);append(type,value);};expect(()=>h.save()).toThrow(AGY_HISTORY_FAILURE);expect(h.budget.observations).toBe(0);});
	it("rejects reentrant budget use through a different guard object",()=>{const h=journal(),append=h.guard.append;h.guard.append=(type,value)=>{expect(()=>recordAgyReportedStep(report(),scope,h.budget,{...h.guard,append})).toThrow(AGY_HISTORY_FAILURE);append(type,value);};expect(()=>h.save()).toThrow(AGY_HISTORY_FAILURE);expect(h.budget.observations).toBe(0);});
});
describe("literal historical rendering",()=>{
	it("matches the reviewed default, with no synthetic Command row or DONE success",()=>{
		const data=captureAgyReportedStep(report(),scope,newAgyActivityBudget()).data;
		expect(renderAgyReportedStep(data,false,theme).render(80)).toEqual(["AGY reported step \u00B7 step 22","  Child: worker-a","  Native: type=GENERIC \u00B7 source=MODEL \u00B7 status=DONE","  Native truncation: not reported","  Reported text:","    supplied opaque text","  Tool identity and command outcome: unknown","  Native status does not establish tool or child completion."]);
	});
	it("matches the reviewed expanded combined-loss copy",()=>{
		const budget=newAgyActivityBudget();budget.payloadBytes=ACTIVITY_LIMITS.requestPayload-20;const data=captureAgyReportedStep(report({content:"supplied opaque textDROP123",truncated_fields:["content"],created_at:"2026-11-03T06:27:55Z"}),scope,budget).data;
		const view=renderAgyReportedStep(data,true,theme).render(80);expect(view).toContain("  Native reported truncation.");expect(view).toContain("  Local capture is incomplete.");expect(view).toContain("  content: 20 bytes retained; 7 bytes omitted (capture limit).");expect(view.slice(-5)).toEqual(["  Native time: 2026-11-03T06:27:55Z","  Source attribution: container","  Native conversation: child-1 \u00B7 root root-1 \u00B7 turn 1","  Parent conversation: root-1","  Pi input: input-1 \u00B7 report 1"]);
	});
	it("preview hiding is separate from local loss and sanitizes hostile saved text again",()=>{
		const data=captureAgyReportedStep(report({content:"one\ntwo\nthree\nfour"}),scope,newAgyActivityBudget()).data;const view=renderAgyReportedStep(data,false,theme,"Ctrl+O to expand").render(80).join("\n");expect(view).toContain("three");expect(view).not.toContain("four");expect(view).toContain("Ctrl+O to expand");expect(view).not.toContain("incomplete");
		const raw="\x1b]8;;https://invalid.example\x07raw\x1b]8;;\x07\x1b[2J";data.content={text:raw,originalBytes:Buffer.byteLength(raw),omittedBytes:0};expect(renderAgyReportedStep(data,true,theme).render(80).join("\n")).not.toMatch(/[\x1b\x07]/);
	});
	it.each([0,1,2,12,80,120])("bounds literal metadata/text at %i columns", width=>{const data=captureAgyReportedStep(report({type:"G".repeat(512),content:"\u754C\u{1f4a0}e\u0301\n".repeat(50),truncated_fields:["x".repeat(512)]}),scope,newAgyActivityBudget()).data;for(const expanded of [false,true])for(const row of renderAgyReportedStep(data,expanded,theme,"Ctrl+O to expand").render(width))expect(visibleWidth(row)).toBeLessThanOrEqual(width);});
});
