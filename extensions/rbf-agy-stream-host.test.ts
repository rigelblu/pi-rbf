import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { replayScreen } from "./test-support/rbf-pty-screen.js";
import { createAgyStreamProfile } from "./test-support/agy-stream-profile.js";

const driver=resolve(import.meta.dirname,"test-support/rbf-row-gate-drive.py"),wrapper=resolve(import.meta.dirname,"test-support/rbf-agy-stream-host-extension.ts");
const host=process.env.RBF_AGY_PI ?? join(process.env.HOME!,"Library/pnpm/bin/pi");
if(!existsSync(host))throw new Error("Daily Pi host missing; no fallback permitted");
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
const jsonl=(file:string)=>readFileSync(file,"utf8").trim().split("\n").filter(Boolean).map(x=>JSON.parse(x));
const run=(profile:ReturnType<typeof createAgyStreamProfile>,scenario:string,steps:any[],name="turn",session?:string)=>{
 const plan={cwd:profile.root,argv:[host,"--no-extensions","--no-skills","--no-prompt-templates","-e",wrapper,"--session-dir",profile.sessions,"--tui-mode","fullscreen",...(session?["--session",session]:[])],env:{PI_CODING_AGENT_DIR:profile.agent,RBF_AGY_STREAM_ROOT:profile.root,RBF_AGY_STREAM_SCENARIO:scenario,RBF_AGY_STREAM_HOLD_MS:"1800"},cols:100,rows:38,timeout:20,out:join(profile.root,name+".raw"),steps};
 writeFileSync(join(profile.root,name+"-plan.json"),JSON.stringify(plan,null,2));
 const result=spawnSync("python3",[driver],{input:JSON.stringify(plan),encoding:"utf8",timeout:25000});
 writeFileSync(join(profile.root,name+"-result.json"),JSON.stringify({code:result.status,stderr:result.stderr,marks:result.stdout},null,2));
 expect(result.status,profile.root+" "+result.stderr).toBe(0);
 return {marks:JSON.parse(result.stdout),raw:readFileSync(plan.out)};
};
const receipt=(path:string,kind:string,count=1)=>({waitJsonl:{path,field:"kind",value:kind,count}});
describe("AGY streaming in actual daily Pi TUI",()=>{
 for(const [scenario,expected] of [["normal","alpha beta"],["short","new"],["empty",""],["same","old long preview"],["long","L".repeat(256*1024)],["error",null],["cancel",null],["oversize-frame",null]] as const){
  it(scenario+" uses one saved authoritative result and reopens exactly",()=>{
   const profile=createAgyStreamProfile(),log=join(profile.root,"host.jsonl");
   const steps:any[]=[receipt(log,"ready"),{paste:"Summarize the change."},{key:"enter"},receipt(log,"preview"),{snapshot:"preview"}];
   if(scenario==="cancel")steps.push({key:"escape"});
   steps.push(receipt(log,"agent_end"),{snapshot:"final"});
   const capture=run(profile,scenario,steps),events=jsonl(log),native=jsonl(join(profile.root,"native.jsonl"));
   expect(events.find(e=>e.kind==="ready").enabled).toBe(true);
   const previewEvent=events.findIndex(e=>e.kind==="preview"),terminalEvent=events.findIndex(e=>e.kind==="trace"&&e.event==="native_result");
   expect(previewEvent).toBeGreaterThan(-1);if(terminalEvent!==-1)expect(previewEvent).toBeLessThan(terminalEvent);
   expect(native.filter(e=>e.input)).toHaveLength(1);
   const finals=events.filter(e=>e.kind==="final");expect(finals).toHaveLength(1);
   const session=join(profile.sessions,readdirSync(profile.sessions).find(f=>f.endsWith(".jsonl"))!);
   const assistants=jsonl(session).filter(e=>e.type==="message"&&e.message.role==="assistant");expect(assistants).toHaveLength(1);
   const saved=assistants[0].message.content.map((b:any)=>b.text??"").join("\n");
   expect(saved).toBe(finals[0].text);expect(saved).not.toContain("TOOL-ONLY");
   if(expected!==null){expect(saved).toBe(expected);expect(assistants[0].message.stopReason).toBe("stop");expect(events.filter(e=>e.kind==="trace"&&e.event==="provider_anchor")).toHaveLength(1);}
   else {expect(saved).toContain("Incomplete AGY answer");expect(assistants[0].message.stopReason).toBe(scenario==="cancel"?"aborted":"error");expect(events.some(e=>e.kind==="trace"&&e.event==="provider_anchor")).toBe(false);}
   if(scenario==="oversize-frame")expect(saved).toContain("AGY response exceeded the supported output limit. The answer is incomplete.");
   if(scenario==="long")expect(Buffer.byteLength(events.find(e=>e.kind==="preview").text)).toBe(128*1024);
   for(const mark of ["preview","final"]){const screen=replayScreen(capture.raw.subarray(0,capture.marks[mark]),100,38).lines.join("\n");writeFileSync(join(profile.root,mark+".txt"),screen);if(mark==="preview"&&scenario!=="long")expect(screen).toContain(scenario==="short"||scenario==="empty"||scenario==="same"?"old long preview":"alpha");}
   const finalScreen=readFileSync(join(profile.root,"final.txt"),"utf8");if(scenario==="empty"||scenario==="short")expect(finalScreen).not.toContain("old long preview");
   const before=hash(readFileSync(session,"utf8"));run(profile,scenario,[receipt(log,"ready",2),{snapshot:"reopened"}],"reopen",session);
   const reopened=jsonl(log).filter(e=>e.kind==="ready").at(-1);expect(reopened.loaded).toEqual([{bytes:Buffer.byteLength(saved),sha256:hash(saved),stopReason:assistants[0].message.stopReason}]);
   expect(hash(readFileSync(session,"utf8"))).toBe(before);expect(jsonl(join(profile.root,"native.jsonl")).filter(e=>e.input)).toHaveLength(1);
   console.log("AGY host receipt: "+profile.root);
  },55000);
 }
 for(const operation of ["new","reload","tree","model"]){
  it("revokes old publication through actual Pi "+operation,()=>{
   const profile=createAgyStreamProfile(),log=join(profile.root,"host.jsonl");
   const steps:any[]=[receipt(log,"ready"),{paste:"Summarize the change."},{key:"enter"},receipt(log,"preview"),{paste:"/offline-agy-depart "+operation},{key:"enter"}];
   if(operation==="reload"||operation==="tree")steps.push({wait:"Wait for the current response to finish"},{key:"escape"},receipt(log,"agent_end"),{paste:"/offline-agy-depart "+operation},{key:"enter"});
   steps.push(receipt(log,operation==="tree"||operation==="model"?"departure_done":"ready",operation==="tree"||operation==="model"?1:2),{sleep:.4},{snapshot:"destination"});
   const capture=run(profile,"late",steps),events=jsonl(log),native=jsonl(join(profile.root,"native.jsonl"));
   expect(native.filter(e=>e.input)).toHaveLength(1);expect(native.filter(e=>e.lateResponse==="STALE")).toHaveLength(1);expect(native.filter(e=>e.terminal==="SUCCESS")).toHaveLength(1);
   expect(events.some(e=>e.kind==="departure_begin")).toBe(true);expect(events.filter(e=>e.kind==="update"||e.kind==="final").every(e=>!e.text.includes("STALE"))).toBe(true);
   const finals=events.filter(e=>e.kind==="final");expect(finals.every(e=>!e.text.includes("STALE"))).toBe(true);
   expect(events.some(e=>e.kind==="trace"&&e.event==="provider_anchor")).toBe(false);
   const screen=replayScreen(capture.raw.subarray(0,capture.marks.destination),100,38).lines.join("\n");writeFileSync(join(profile.root,"destination.txt"),screen);
   expect(screen).not.toContain("STALE");if(operation!=="reload")expect(screen).not.toContain("alpha");
   console.log("AGY departure receipt: "+profile.root);
  },30000);
 }

});
