import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { replayScreen } from "./test-support/rbf-pty-screen.ts";
const ROOT = resolve(import.meta.dirname,".."), DRIVER=join(import.meta.dirname,"test-support/rbf-row-gate-drive.py");
const HOSTS=process.env.RBF_CONTEXT_PI?[process.env.RBF_CONTEXT_PI]:[join(ROOT,"node_modules/.bin/pi"),"/Users/tomhosiawa/Library/pnpm/bin/pi"];
const WIDTHS=process.env.RBF_CONTEXT_WIDTH?[Number(process.env.RBF_CONTEXT_WIDTH)]:[80,120];
const submit=(s:string)=>[{paste:s},{key:"enter"}];
const click=(name:string,label:string)=>[{locate:{name,text:label,columnText:label.replace(/^· /,"")}},{bytes:`\x1b[<0;{${name}X};{${name}}M`},{bytes:`\x1b[<0;{${name}X};{${name}}m`}];

describe("Codex context in actual Pi",()=>{
 for(const host of HOSTS)for(const cols of WIDTHS)it(host+" context, compaction, reload and badges at "+cols,()=>{
  const dir=join(process.env.RBF_CONTEXT_TMPDIR??"/Volumes/tom-ssd/tmp/pi-10.13",`${Date.now()}-${cols}`),agent=join(dir,"agent"),sessions=join(dir,"sessions");for(const p of [dir,agent,sessions])mkdirSync(p,{recursive:true});
  writeFileSync(join(agent,"settings.json"),JSON.stringify({defaultProvider:"codex-harness",defaultModel:"codex",defaultThinkingLevel:"medium",theme:cols===80?"dark":"light"}));
  const sample={last:{totalTokens:50000,inputTokens:49000,cachedInputTokens:48000,outputTokens:1000,reasoningOutputTokens:900},total:{totalTokens:9000000},modelContextWindow:200000};
  const scenario={retainHistory:true,turn:[{kind:"notification",method:"thread/tokenUsage/updated",params:{tokenUsage:sample}},{kind:"subAgent",activity:"started",agentThreadId:"child",agentPath:"/reviewer"},{kind:"childTurn",threadId:"child",events:[{kind:"notification",method:"thread/tokenUsage/updated",params:{tokenUsage:{...sample,last:{totalTokens:199000}}}},{kind:"complete"}]},{kind:"answer",id:"done",text:"CONTEXT_DONE"},{kind:"complete"}]};
  const raw=join(dir,"terminal.raw"),steps=[{wait:"context \\? \\(Codex\\)"},{sleep:.2},{snapshot:"unknown"},...submit("!sleep 30"),{sleep:.6},{key:"ctrl-b"},{sleep:.5},...submit("context"),{wait:"CONTEXT_DONE"},{sleep:.4},{snapshot:"known"},...click("shell","1 shell"),{wait:"Shell details"},{sleep:.2},{snapshot:"shells"},{key:"escape"},{sleep:.2},...click("agents","· agents"),{wait:"Codex agents"},{sleep:.2},{snapshot:"agents"},{key:"escape"},{sleep:.2},{paste:"draft remains"},{snapshot:"draft"},{key:"ctrl-u"},...submit("/cancel"),{sleep:.4},...submit("/compact"),{wait:"Codex context compacted"},{sleep:.3},{snapshot:"compacted"},...submit("next"),{wait:"CONTEXT_DONE",count:2},{sleep:.4},{snapshot:"fresh"},...submit("/reload"),{sleep:1.5},{snapshot:"reloaded"}];
  const plan={cwd:dir,argv:[host,"--no-extensions","--no-skills","--no-themes","--no-context-files","--no-prompt-templates","-e",join(import.meta.dirname,"test-support/rbf-codex-agents-extension.ts"),"-e",join(import.meta.dirname,"rbf-background-tasks.ts"),"--session-dir",sessions,"--tui-mode","fullscreen"],env:{PI_CODING_AGENT_DIR:agent,RBF_AGENTS_SOURCE:process.env.RBF_CONTEXT_SOURCE??join(import.meta.dirname,"rbf-codex.ts"),RBF_FAKE_SCENARIO:JSON.stringify(scenario),RBF_FAKE_LOG:join(dir,"protocol.jsonl"),RBF_FAKE_HISTORY:join(dir,"history.json")},cols,rows:38,timeout:35,out:raw,steps};
  writeFileSync(join(dir,"plan.json"),JSON.stringify(plan,null,2));const run=spawnSync("python3",[DRIVER],{input:JSON.stringify(plan),encoding:"utf8",timeout:42000});writeFileSync(join(dir,"result.json"),JSON.stringify(run,null,2));expect(run.status,dir+" "+run.stderr).toBe(0);
  const marks=JSON.parse(run.stdout),bytes=readFileSync(raw);const screen=(name:string)=>{const s=replayScreen(bytes.subarray(0,marks[name]),cols,38);writeFileSync(join(dir,name+".txt"),s.lines.join("\n"));return s.lines.join("\n");};
  for(const name of ["unknown","compacted","reloaded"]){const text=screen(name);expect(text,dir+" "+name).toContain("context ? (Codex)");expect(text).not.toMatch(/1000M|\(auto\)/);}
  for(const name of ["known","fresh","draft"]){const text=screen(name);expect(text,dir+" "+name).toContain("25.0%/200k · 150k left (Codex)");expect(text).not.toMatch(/1000M|99.5%|\(auto\)/);}
  expect(screen("shells")).toContain("Shell details");expect(screen("agents")).toContain("Codex agents");expect(screen("draft")).toContain("draft remains");
  const requests=readFileSync(join(dir,"protocol.jsonl"),"utf8").trim().split("\n").map(l=>JSON.parse(l));expect(requests.filter(x=>x.method==="turn/start")).toHaveLength(2);expect(requests.filter(x=>x.method==="thread/compact/start")).toHaveLength(1);console.log("context native receipt: "+dir);
 },45000);
});
