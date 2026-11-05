import { spawn, spawnSync } from "node:child_process";
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
const run=async(profile:ReturnType<typeof createAgyStreamProfile>,scenario:string,steps:any[],name="turn",session?:string,mutation?:string)=>{
 const plan={cwd:profile.root,argv:[host,"--no-extensions","--no-skills","--no-prompt-templates","-e",wrapper,"--session-dir",profile.sessions,"--tui-mode","fullscreen",...(session?["--session",session]:[])],env:{PI_CODING_AGENT_DIR:profile.agent,RBF_AGY_STREAM_ROOT:profile.root,RBF_AGY_STREAM_SCENARIO:scenario,RBF_AGY_STREAM_HOLD_MS:"1800",RBF_AGY_STREAM_MUTATION:mutation ?? ""},cols:100,rows:38,timeout:20,out:join(profile.root,name+".raw"),steps};
 writeFileSync(join(profile.root,name+"-plan.json"),JSON.stringify(plan,null,2));
 const result=await new Promise<{status:number|null;stderr:string;stdout:string}>((resolve,reject)=>{
  const child=spawn("python3",[driver],{stdio:["pipe","pipe","pipe"]});let stdout="",stderr="";
  const timer=setTimeout(()=>{stderr+="PTY driver exceeded25seconds";child.kill("SIGTERM");},25000);
  child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");child.stdout.on("data",chunk=>stdout+=chunk);child.stderr.on("data",chunk=>stderr+=chunk);
  child.once("error",error=>{clearTimeout(timer);reject(error);});child.once("close",status=>{clearTimeout(timer);resolve({status,stderr,stdout});});
  child.stdin.on("error",error=>{stderr+=String(error);});child.stdin.end(JSON.stringify(plan));
 });
 writeFileSync(join(profile.root,name+"-result.json"),JSON.stringify({code:result.status,stderr:result.stderr,marks:result.stdout},null,2));
 expect(result.status,profile.root+" "+result.stderr).toBe(0);
 return {marks:JSON.parse(result.stdout),raw:readFileSync(plan.out)};
};
const receipt=(path:string,kind:string,count=1)=>({waitJsonl:{path,field:"kind",value:kind,count}});
describe("AGY discovery on cold Pi startup",()=>{
 for(const populated of [false,true]){
  it(populated?"selects Flash/high from the discovery store without inference":"rejects Flash with an empty discovery store",()=>{
   const profile=createAgyStreamProfile(),store=join(profile.agent,"models-store.json");
   if(!populated)writeFileSync(store,"{}\n");
   const result=spawnSync(host,["--no-extensions","--no-skills","--no-prompt-templates","-e",resolve(import.meta.dirname,"rbf-agy.ts"),"--session-dir",profile.sessions,"--provider","agy-harness","--model","gemini-3.8-flash","--thinking","high","--mode","rpc"],{
    cwd:profile.root,env:{...process.env,PI_OFFLINE:"1",PI_CODING_AGENT_DIR:profile.agent},encoding:"utf8",input:'{"id":"cold-start","type":"get_state"}\n',timeout:10000,
   });
   writeFileSync(join(profile.root,"cold-start-result.json"),JSON.stringify(result,null,2));
   expect(result.error).toBeUndefined();
   if(!populated){
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown provider "agy-harness"');
    return;
   }
   expect(result.status,result.stderr).toBe(0);
   const response=result.stdout.trim().split("\n").map(line=>JSON.parse(line)).find(event=>event.id==="cold-start");
   expect(response).toMatchObject({type:"response",command:"get_state",success:true,data:{model:{provider:"agy-harness",id:"gemini-3.8-flash"},thinkingLevel:"high",isStreaming:false,messageCount:0,pendingMessageCount:0}});
  },15000);
 }
});

describe("AGY streaming in actual daily Pi TUI",()=>{
 for(const [scenario,expected] of [["normal","alpha beta"],["short","new"],["empty",""],["same","old long preview"],["long","L".repeat(256*1024)],["error",null],["cancel",null],["oversize-frame",null]] as const){
  it(scenario+" uses one saved authoritative result and reopens exactly",async()=>{
   const profile=createAgyStreamProfile(),log=join(profile.root,"host.jsonl");
   const steps:any[]=[receipt(log,"ready"),{paste:"Summarize the change."},{key:"enter"},receipt(log,"preview"),{snapshot:"preview"}];
   if(scenario==="cancel")steps.push({key:"escape"});
   steps.push(receipt(log,"agent_end"),{snapshot:"final"});
   const capture=await run(profile,scenario,steps),events=jsonl(log),native=jsonl(join(profile.root,"native.jsonl"));
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
   const before=hash(readFileSync(session,"utf8"));await run(profile,scenario,[receipt(log,"ready",2),{snapshot:"reopened"}],"reopen",session);
   const reopened=jsonl(log).filter(e=>e.kind==="ready").at(-1);expect(reopened.loaded).toEqual([{bytes:Buffer.byteLength(saved),sha256:hash(saved),stopReason:assistants[0].message.stopReason}]);
   expect(hash(readFileSync(session,"utf8"))).toBe(before);expect(jsonl(join(profile.root,"native.jsonl")).filter(e=>e.input)).toHaveLength(1);
   console.log("AGY host receipt: "+profile.root);
  },55000);
 }
 for(const operation of ["new","reload","tree","model"]){
  it("revokes old publication through actual Pi "+operation,async()=>{
   const profile=createAgyStreamProfile(),log=join(profile.root,"host.jsonl");
   const steps:any[]=[receipt(log,"ready"),{paste:"Summarize the change."},{key:"enter"},receipt(log,"preview"),{paste:"/offline-agy-depart "+operation},{key:"enter"}];
   if(operation==="reload"||operation==="tree")steps.push({wait:"Wait for the current response to finish"},{key:"escape"},receipt(log,"agent_end"),{paste:"/offline-agy-depart "+operation},{key:"enter"});
   steps.push(receipt(log,operation==="tree"||operation==="model"?"departure_done":"ready",operation==="tree"||operation==="model"?1:2),{sleep:.4},{snapshot:"destination"});
   const capture=await run(profile,"late",steps),events=jsonl(log),native=jsonl(join(profile.root,"native.jsonl"));
   expect(native.filter(e=>e.input)).toHaveLength(1);expect(native.filter(e=>e.lateResponse==="STALE")).toHaveLength(1);expect(native.filter(e=>e.terminal==="SUCCESS")).toHaveLength(1);
   expect(events.some(e=>e.kind==="departure_begin")).toBe(true);expect(events.filter(e=>e.kind==="update"||e.kind==="final").every(e=>!e.text.includes("STALE"))).toBe(true);
   const finals=events.filter(e=>e.kind==="final");expect(finals.every(e=>!e.text.includes("STALE"))).toBe(true);
   expect(events.some(e=>e.kind==="trace"&&e.event==="provider_anchor")).toBe(false);
   const screen=replayScreen(capture.raw.subarray(0,capture.marks.destination),100,38).lines.join("\n");writeFileSync(join(profile.root,"destination.txt"),screen);
   expect(screen).not.toContain("STALE");if(operation!=="reload")expect(screen).not.toContain("alpha");
   console.log("AGY departure receipt: "+profile.root);
  },30000);
 }

 for(const mutation of ["content","prefix"]){
  it("refuses continuation after a public persistence "+mutation+" change",async()=>{
   const profile=createAgyStreamProfile(),log=join(profile.root,"host.jsonl");
   const steps=[receipt(log,"ready"),{paste:"Summarize the change."},{key:"enter"},receipt(log,"agent_end"),{paste:"Follow-up must remain local."},{key:"enter"},receipt(log,"agent_end",2)];
   await run(profile,"normal",steps,"persistence",undefined,mutation);
   const events=jsonl(log),native=jsonl(join(profile.root,"native.jsonl"));
   expect(events.filter(e=>e.kind==="persistence_fault")).toHaveLength(1);expect(native.filter(e=>e.input)).toHaveLength(1);
   expect(events.some(e=>e.kind==="trace"&&e.event==="provider_anchor")).toBe(false);
   const finals=events.filter(e=>e.kind==="final");expect(finals).toHaveLength(2);expect(finals[1].stopReason).toBe("error");
   expect(finals[0].text).toBe(mutation==="content"?"Altered final":"alpha beta");
   console.log("AGY persistence fault receipt: "+profile.root);
  },30000);
 }


 it("continues after another extension's entry lands after the answer",async()=>{
  const profile=createAgyStreamProfile(),log=join(profile.root,"host.jsonl");
  const steps=[receipt(log,"ready"),{paste:"Summarize the change."},{key:"enter"},receipt(log,"agent_end"),{paste:"Follow-up must reach AGY."},{key:"enter"},receipt(log,"agent_end",2)];
  await run(profile,"normal",steps,"persistence",undefined,"foreign");
  const events=jsonl(log),native=jsonl(join(profile.root,"native.jsonl"));
  expect(events.filter(e=>e.kind==="persistence_fault")).toHaveLength(1);expect(native.filter(e=>e.input)).toHaveLength(2);
  expect(events.filter(e=>e.kind==="trace"&&e.event==="provider_anchor").length).toBeGreaterThanOrEqual(1);
  const finals=events.filter(e=>e.kind==="final");expect(finals).toHaveLength(2);expect(finals[0].stopReason).toBe("stop");expect(finals[1].stopReason).toBe("stop");
  console.log("AGY foreign entry receipt: "+profile.root);
 },30000);
});
