import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FooterComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createRbfCodex, BOOTSTRAP_MODEL, PROVIDER_ID, CodexContextMeter, formatCodexContext, installCodexContextFooter, installCodexAgentsFooter } from "./rbf-codex.ts";
import { patchFooterComponent, unpatchFooterComponent } from "./rbf-background-tasks.ts";

const usage = (tokens: unknown = 50000, window: unknown = 200000, threadId = "root", turnId = "turn-1") => ({ threadId, turnId, tokenUsage: { last: { totalTokens: tokens, inputTokens: 49000, cachedInputTokens: 48000, outputTokens: 1000, reasoningOutputTokens: 900 }, total: { totalTokens: 9000000 }, modelContextWindow: window } });
const start = (m: CodexContextMeter, id = "turn-1") => { const epoch = m.begin("root"); m.observe("turn/started", { threadId: "root", turn: { id } }); m.confirmTurn(epoch, id); };

describe("Codex context telemetry", () => {
 it("uses last.totalTokens once rather than session totals or overlapping subsets", () => {
  const m = new CodexContextMeter(); start(m); expect(m.observe("thread/tokenUsage/updated", usage())).toBe(true);
  expect(formatCodexContext(m.snapshot)).toBe("25.0%/200k · 150k left (Codex)");
  expect(m.observe("thread/tokenUsage/updated", usage())).toBe(false);
 });
 for (const [tokens, window] of [[undefined,200000],[null,200000],[-1,200000],[1.5,200000],[NaN,200000],[Infinity,200000],[Number.MAX_SAFE_INTEGER+1,200000],[50000,null],[50000,0],[50000,-1],[50000,1.5],[50000,Infinity]]) it("makes malformed counts unknown: " + String(tokens) + "/" + String(window), () => {
  const m = new CodexContextMeter(); start(m);m.observe("thread/tokenUsage/updated",usage());
  const p = usage(tokens,window); if(tokens===undefined) delete (p.tokenUsage.last as any).totalTokens;
  m.observe("thread/tokenUsage/updated",p);expect(formatCodexContext(m.snapshot)).toBe("context ? (Codex)");
 });
 it("accepts a reported zero and clamps remaining alone when over capacity", () => {
  const m = new CodexContextMeter();start(m);m.observe("thread/tokenUsage/updated",usage(0));expect(formatCodexContext(m.snapshot)).toBe("0.0%/200k · 200k left (Codex)");
  m.observe("thread/tokenUsage/updated",usage(250000));expect(formatCodexContext(m.snapshot)).toBe("125.0%/200k · 0 left (Codex)");
 });
 it("rejects children, wrong turns, unarmed events and late prior-turn snapshots", () => {
  const m = new CodexContextMeter();m.observe("thread/tokenUsage/updated",usage());expect(m.snapshot).toBeUndefined();start(m);m.observe("thread/tokenUsage/updated",usage());
  m.observe("thread/tokenUsage/updated",usage(190000,200000,"child"));m.observe("thread/tokenUsage/updated",usage(190000,200000,"root","wrong"));expect(m.snapshot?.tokens).toBe(50000);
  start(m,"turn-2");m.observe("thread/tokenUsage/updated",usage());expect(m.snapshot).toBeUndefined();m.observe("thread/tokenUsage/updated",usage(10000,200000,"root","turn-2"));expect(m.snapshot?.tokens).toBe(10000);
 });
 it("disarms on compaction so late same-turn data cannot restore stale context", () => {
  const m = new CodexContextMeter();start(m);m.observe("thread/tokenUsage/updated",usage());m.observe("item/started",{threadId:"root",turnId:"turn-1",item:{type:"contextCompaction"}});m.observe("thread/tokenUsage/updated",usage());expect(m.snapshot).toBeUndefined();
  start(m,"turn-2");m.observe("thread/tokenUsage/updated",usage(10000,200000,"root","turn-2"));expect(m.snapshot?.tokens).toBe(10000);
 });
 it("clear revokes a response arriving after navigation/client loss and accepts final telemetry after turn completion", () => {
  const m=new CodexContextMeter();const epoch=m.begin("root");m.clear();m.confirmTurn(epoch,"turn-1");m.observe("turn/started",{threadId:"root",turn:{id:"turn-1"}});m.observe("thread/tokenUsage/updated",usage());expect(m.snapshot).toBeUndefined();
  start(m);m.observe("turn/completed",{threadId:"root",turn:{id:"turn-1"}});m.observe("thread/tokenUsage/updated",usage());expect(m.snapshot?.tokens).toBe(50000);
 });
 it("ignores malformed envelopes without throwing",()=>{const m=new CodexContextMeter();start(m);for(const p of [null,[],"x",{}, {threadId:"root",turnId:"turn-1",tokenUsage:null}])expect(()=>m.observe("thread/tokenUsage/updated",p)).not.toThrow();});
});

const KEY=Symbol.for("@earendil-works/pi-rbf:footer-registry"),proto=FooterComponent.prototype as any;
let originalRender:any,originalMouse:any,cleanups:Array<()=>void>=[];
const theme={fg:(_c:string,t:string)=>t,bold:(t:string)=>t};
const footer=()=>({session:{state:{model:{provider:"codex-harness"}}}});
const render=(f:any,w=80)=>proto.render.call(f,w);
beforeEach(()=>{initTheme();originalRender=proto.render;originalMouse=proto.handleMouse;delete proto[KEY];proto.render=()=>["/workspace","$0.000 0.0%/1000M (auto)                         codex • medium"];delete proto.handleMouse;});
afterEach(()=>{for(const c of cleanups.reverse())c();cleanups=[];unpatchFooterComponent();proto.render=originalRender;if(originalMouse)proto.handleMouse=originalMouse;else delete proto.handleMouse;delete proto[KEY];});
const install=(get=()=>({tokens:50000,contextWindow:200000}) as any)=>{const h=installCodexContextFooter(()=>true,get,()=>theme);cleanups.push(()=>h.dispose());return h;};
describe("Codex native context footer",()=>{
 for(const order of ["context-first","shell-first"])it("reflows before badges and preserves their hitboxes: "+order,()=>{
  const shellOpen=vi.fn(),agentOpen=vi.fn(),f=footer();
  const shells=()=>patchFooterComponent({getRunningTasks:()=>[{}]} as any,()=>false,()=>false,shellOpen);
  if(order==="shell-first")shells();install();if(order==="context-first")shells();const a=installCodexAgentsFooter(()=>true,agentOpen,()=>theme);cleanups.push(()=>a.dispose());
  const line=stripTerminalSequences(render(f)[1]);expect(line).toContain("25.0%/200k · 150k left (Codex)");expect(line).not.toMatch(/1000M|\(auto\)/);expect(visibleWidth(line)).toBeLessThanOrEqual(80);
  for(const [label,open] of [["1 shell",shellOpen],["agents",agentOpen]] as const){proto.handleMouse.call(f,{type:"click",x:line.indexOf(label)+2,y:1,button:"left",screenX:0,screenY:40});expect(open).toHaveBeenCalledOnce();}
 });
 it("updates on telemetry without Pi session changes, and never mutates real state",()=>{const f=footer();const before=JSON.stringify(f.session);let s:any;install(()=>s);expect(stripTerminalSequences(render(f)[1])).toContain("context ? (Codex)");s={tokens:50000,contextWindow:200000};expect(stripTerminalSequences(render(f)[1])).toContain("150k left");expect(JSON.stringify(f.session)).toBe(before);});
 it("leaves non-Codex footers unchanged and stale dispose cannot remove replacement",()=>{const f=footer();const base=proto.render.call(f,80);const a=install(),b=install(()=>undefined);a.dispose();expect(stripTerminalSequences(render(f)[1])).toContain("context ? (Codex)");f.session.state.model.provider="other";expect(render(f)).toEqual(base);b.dispose();expect(render(f)).toEqual(base);});
 it("clips safely at narrow widths and highlights actual high usage",()=>{const roles:string[]=[];const h=installCodexContextFooter(()=>true,()=>({tokens:190000,contextWindow:200000}),()=>({fg:(r:string,t:string)=>{roles.push(r);return t;},bold:(t:string)=>t}));cleanups.push(()=>h.dispose());for(const w of [12,40,80,120]){const line=stripTerminalSequences(render(footer(),w)[1]);expect(visibleWidth(line)).toBeLessThanOrEqual(w);expect(line).not.toContain("1000M");}expect(roles).toContain("error");});
});


describe("context footer session lifetime",()=>{
 it("keeps the actual prototype truthful after a later extension vetoes a switch, and cleans up on shutdown",async()=>{
  const handlers=new Map<string,Function>(),f=footer(),base=render(f);
  const ctx:any={mode:"tui",model:{...BOOTSTRAP_MODEL,provider:PROVIDER_ID},ui:{setWidget(){},notify(){},setWorkingMessage(){}},sessionManager:{getBranch:()=>[],getSessionId:()=>"A",getCwd:()=>process.cwd(),getLeafId:()=>"leaf"}};
  createRbfCodex({argv:[]})({on:(e:string,h:Function)=>handlers.set(e,h),appendEntry(){},registerTool(){},registerCommand(){},getThinkingLevel:()=>"medium",registerProvider(){}} as any);
  try{
   await handlers.get("session_start")?.({},ctx);expect(stripTerminalSequences(render(f)[1])).toContain("context ? (Codex)");
   await handlers.get("session_before_switch")?.({reason:"resume"},ctx);
   // A later handler returns cancel:true, so Pi emits no replacement session_start.
   expect(stripTerminalSequences(render(f)[1])).toContain("context ? (Codex)");expect(render(f)[1]).not.toMatch(/1000M|\(auto\)/);
  }finally{await handlers.get("session_shutdown")?.({},ctx);}
  expect(render(f)).toEqual(base);
 });
});
