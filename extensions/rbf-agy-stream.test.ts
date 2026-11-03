import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRbfAgy, AGY_API, AGY_PROVIDER, parseAgyCatalogue, toAgyProviderModel } from "./rbf-agy.js";
import { BOUNDS, createOwnedNativeProtocol, sanitizeDisplayText } from "./lib/agy-native.js";
import { createAgyStreamFixture } from "./test-support/agy-stream-fixture.js";

const base = process.env.RBF_AGY_TEST_ROOT;
if (!base) throw new Error("Resolve eng-use-external-tmp pi-21.7 and set RBF_AGY_TEST_ROOT before running AGY streaming tests");
mkdirSync(base, { recursive: true });
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of disposers.splice(0)) await close(); });
const body = (message: any) => message.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
function harness(scenario = "normal") {
 const root = mkdtempSync(join(base!, "stream-")), fake = createAgyStreamFixture(root, scenario);
 let sequence = 0, session = "session-a", registration: any;
 const entries: any[] = [], events: any[] = [], published: any[] = [], trace: any[] = [], handlers = new Map<string, Function[]>();
 const model = { ...toAgyProviderModel(parseAgyCatalogue("gemini-3.8-flash-high\tFlash (high)")[0]), provider: AGY_PROVIDER, api: AGY_API, baseUrl: "stdio://fake" };
 const sm = { getSessionId: () => session, getSessionFile: () => join(root,"session.jsonl"), getEntries: () => entries, getBranch: () => entries, getLeafId: () => entries.at(-1)?.id ?? null };
 const append = (entry: any) => { const value = { id: String(++sequence), parentId: sm.getLeafId(), ...entry }; entries.push(value); return value; };
 const ctx: any = { mode: "tui", cwd: root, model, sessionManager: sm, ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } };
 const pi: any = { on: (name: string, fn: Function) => handlers.set(name,[...(handlers.get(name) ?? []),fn]), registerEntryRenderer() {}, registerFlag() {}, getFlag() {}, registerProvider: (_name: string, value: any) => registration = value, appendEntry: (customType: string, data: any) => append({ type: "custom", customType, data }) };
 createRbfAgy({ executable: fake.executable, piVersion: "1.4.0", argv: [], seal: {}, trace: (event,data) => trace.push({event,...data}) })(pi);
 const emit = async (name: string, event: any = {}) => { for (const fn of handlers.get(name) ?? []) await fn(event,ctx); };
 const ready = emit("session_start");
 const logs = () => { try { return readFileSync(fake.log,"utf8").trim().split("\n").map(x=>JSON.parse(x)); } catch { return []; } };
 const h = { root, entries, events, published, trace, ctx, emit, logs,
  async start(signal?: AbortSignal) {
   await ready; const user = { role: "user", content: [{ type: "text", text: "task" }], timestamp: Date.now() }; append({ type: "message", message: user });
   const stream = registration.streamSimple(model,{ messages: [user] },{ reasoning: "high", signal });
   const originalPush=stream.push.bind(stream); stream.push=(event:any)=>{published.push(structuredClone(event));originalPush(event);};
   const consuming = (async () => { for await (const e of stream) events.push(structuredClone(e)); })();
   return { result: stream.result() as Promise<any>, consumed: consuming };
  },
  async persist(message: any, kind = "exact") {
   const saved = structuredClone(message); if(kind === "mutated") saved.content[0].text += "changed";
   append({ type: "message", message: saved }); if(kind === "duplicate") append({ type: "message", message: saved });
   await emit("agent_end",{ messages: [message] });
  },
  replaceSession() { session = "session-b"; entries.splice(0); },
  async close() { await ready; await emit("session_shutdown",{reason:"quit"}); }
 };
 disposers.push(h.close); return h;
}
const previewed = async (h: ReturnType<typeof harness>) => vi.waitFor(() => expect(h.events.some(e=>e.type === "text_delta" && e.delta)).toBe(true),{timeout:3000,interval:10});
const finalEvents = (h: ReturnType<typeof harness>) => h.events.filter(e=>e.type === "done" || e.type === "error");

describe("response-only streaming and authoritative final", () => {
 it("publishes before terminal and keeps tool output out of its one answer",async()=>{
  const h=harness(), call=await h.start(); await previewed(h);
  expect(h.logs().some(x=>x.terminal)).toBe(false); expect(h.trace.some(x=>x.event==="provider_anchor")).toBe(false);
  const final=await call.result; await call.consumed;
  expect(body(final)).toBe("alpha beta"); expect(h.events.filter(e=>e.type==="start")).toHaveLength(1);
  expect(h.events.filter(e=>e.type==="text_start")).toHaveLength(1); expect(h.events.filter(e=>e.type==="text_end")).toHaveLength(1);
  expect(finalEvents(h)).toHaveLength(1); expect(JSON.stringify(h.events)).not.toContain("TOOL-ONLY");
  expect(h.ctx.ui.setWidget.mock.calls.some((x:any[])=>x[0]==="rbf-agy-activity"&&JSON.stringify(x[1]).includes("TOOL-ONLY"))).toBe(true);
  await h.persist(final); expect(h.trace.filter(x=>x.event==="provider_anchor")).toHaveLength(1);
 });
 it.each([["short","new"],["empty",""],["same","old long preview"]])("replaces a longer preview exactly: %s",async(scenario,expected)=>{
  const h=harness(scenario), call=await h.start(); await previewed(h); expect(h.events.find(e=>e.type==="text_delta").delta).toBe("old long preview");
  const final=await call.result; await call.consumed; expect(body(final)).toBe(expected); expect(h.events.find(e=>e.type==="text_end").content).toBe(expected); expect(final.content).toEqual([{type:"text",text:expected}]);
  expect(finalEvents(h)).toHaveLength(1);
 });
 it("bounds preview at128KiB while retaining all256KiB of the admitted final",async()=>{
  const h=harness("long"), call=await h.start(); const final=await call.result; await call.consumed;
  expect(body(final)).toHaveLength(256*1024);
  const preview=h.events.filter(e=>e.type==="text_delta").map(e=>e.delta).join(""); expect(Buffer.byteLength(preview)).toBe(128*1024);
  expect(h.ctx.ui.setWidget).toHaveBeenCalledWith("rbf-agy-preview",["AGY answer preview paused.","The complete answer will appear when the task finishes."]);
  expect(createHash("sha256").update(body(final)).digest("hex")).toBe(createHash("sha256").update("L".repeat(256*1024)).digest("hex"));
 });
 it("cuts the preview at a Unicode character boundary",async()=>{
  const h=harness("unicode-cap"),call=await h.start();const final=await call.result;await call.consumed;
  const preview=h.events.filter(e=>e.type==="text_delta").map(e=>e.delta).join("");
  expect(preview).toBe("x".repeat(128*1024-1));expect(preview).not.toContain("\ufffd");
  expect(body(final)).toBe("alpha beta");expect(h.ctx.ui.setWidget).toHaveBeenCalledWith("rbf-agy-preview",undefined);
 });
 it("sanitizes split escapes, surrogate pairs and UTF8 frames without contaminating answer",async()=>{
  const h=harness("split"), call=await h.start(); const final=await call.result; await call.consumed;
  expect(h.events.filter(e=>e.type==="text_delta").map(e=>e.delta).join("")).toBe("safered 😀 café!"); expect(body(final)).toBe("safered 😀 café!");
  expect(body(final)).toBe(sanitizeDisplayText("safe\u001b[31mred\u001b]52;c;secret\u0007 😀 café\u202e!"));
 });
 it("keeps only the native denial appendix with a literal empty final",async()=>{
  const h=harness("denial"),call=await h.start(); const final=await call.result; await call.consumed;
  expect(body(final)).toBe("\n\nDenied actions (conversation total): EditFile.\nThese diagnostics do not prove an edit was applied.");
  expect(body(final)).not.toContain("old long preview");
 });
});

describe("incomplete results, revocation and continuation",()=>{
 it.each(["error","malformed","eof","capped-error","no-preview-error","no-preview-malformed","no-preview-eof"])("retains only an honestly incomplete preview: %s",async scenario=>{
  const h=harness(scenario),call=await h.start();const final=await call.result;await call.consumed;
  expect(final.stopReason).toBe("error"); expect(body(final).includes("Incomplete AGY answer")).toBe(!scenario.startsWith("no-preview"));
  if(scenario==="capped-error")expect(body(final)).toContain("Only part of the streamed text was retained.");
  expect(body(final)).toMatch(/AGY stop(ped| could not be verified)/);expect(finalEvents(h)).toHaveLength(1);expect(h.trace.some(x=>x.event==="provider_anchor")).toBe(false);
 });
 it.each(["cancel","no-preview-cancel"])("aborts with bounded incomplete content: %s",async scenario=>{
  const h=harness(scenario),abort=new AbortController(),call=await h.start(abort.signal);
  await vi.waitFor(()=>expect(h.logs().some(x=>x.preview)).toBe(true)); if(scenario==="cancel")await previewed(h);abort.abort();const final=await call.result;await call.consumed;
  expect(final.stopReason).toBe("aborted");expect(body(final)).toContain("AGY request cancelled.");expect(body(final).includes("Incomplete AGY answer")).toBe(scenario==="cancel");expect(finalEvents(h)).toHaveLength(1);
 });
 it.each(["oversize-frame","oversize-request"])("reports resource oversize as incomplete: %s",async scenario=>{
  const h=harness(scenario),call=await h.start();const final=await call.result;await call.consumed;
  expect(final.stopReason).toBe("error");expect(body(final)).toContain("AGY response exceeded the supported output limit. The answer is incomplete.");expect(h.trace.some(x=>x.event==="provider_anchor")).toBe(false);
 });
 it.each(["session_before_switch","session_tree","session_shutdown","model_select"])("closes publication synchronously on %s",async event=>{
  const h=harness("late"),call=await h.start();await previewed(h);
  if(event==="model_select")h.ctx.model={...h.ctx.model,provider:"other"};
  const retiring=h.emit(event,event==="session_tree"?{oldLeafId:"old",newLeafId:"new"}:event==="model_select"?{model:h.ctx.model}:{reason:"reload"});
  const at=h.published.length;h.replaceSession();await retiring;await call.result;await call.consumed;
  expect(h.published.slice(at)).toEqual([]);expect(JSON.stringify(h.events)).not.toContain("STALE");expect(finalEvents(h)).toHaveLength(1);expect(h.trace.some(x=>x.event==="provider_anchor")).toBe(false);
 });
 it.each(["exact","mutated","duplicate","missing"])("grants continuation only for exact confirmed final persistence: %s",async kind=>{
  const h=harness("empty"),call=await h.start();const final=await call.result;await call.consumed;
  expect(h.trace.some(x=>x.event==="provider_anchor")).toBe(false);
  if(kind!=="missing")await h.persist(final,kind);else await h.emit("agent_end",{messages:[final]});
  expect(h.trace.filter(x=>x.event==="provider_anchor")).toHaveLength(kind==="exact"?1:0);
 });
});

describe("unchanged byte admission limits",()=>{
 const cid="wire",cwd="/";
 function protocol(){let failure:string|undefined;const p=createOwnedNativeProtocol({model:"m",cwd},{onInit(){},onEvent(){},onBoundary(){},onFailure:x=>failure=x});
  const send=(x:any)=>p.feed(Buffer.from(JSON.stringify(x)+"\n"));send({event:"init",conversation_id:cid,init:{model:"m",cwd,tools:[],permission_mode:"default"}});p.beginRequest();p.markWriteAttempt();
  send({event:"step_update",step_update:{conversation_id:cid,step_index:0,step_type:"user_input",state:"DONE"}});return{p,send,failure:()=>failure};}
 const response=(text:string)=>({event:"step_update",step_update:{conversation_id:cid,step_index:1,step_type:"agent_response",state:"ACTIVE",text_delta:text}});
 it("admits an exactly1MiB frame including newline and rejects one additional byte",()=>{
  for(const extra of [0,1]){const h=protocol();const size=Buffer.byteLength(JSON.stringify(response(""))+"\n");h.send(response("x".repeat(BOUNDS.MAX_FRAME_BYTES-size+extra)));expect(Boolean(h.failure())).toBe(Boolean(extra));}
 });
 it("admits exactly2MiB request stdout and rejects one additional byte",()=>{
  for(const extra of [0,1]){const h=protocol();const userBytes=Buffer.byteLength(JSON.stringify({event:"step_update",step_update:{conversation_id:cid,step_index:0,step_type:"user_input",state:"DONE"}})+"\n");
   const frameBytes=700*1024;const overhead=Buffer.byteLength(JSON.stringify(response(""))+"\n");h.send(response("x".repeat(frameBytes-overhead)));h.send(response("x".repeat(frameBytes-overhead)));
   const left=BOUNDS.MAX_STDOUT_REQUEST_BYTES-userBytes-2*frameBytes;h.send(response("x".repeat(left-overhead+extra)));expect(Boolean(h.failure())).toBe(Boolean(extra));}
 });
});
