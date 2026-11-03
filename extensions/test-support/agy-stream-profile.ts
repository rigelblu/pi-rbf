import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export function createAgyStreamProfile() {
 const resolved=spawnSync("bash",[`${process.env.HOME}/.agents/skills/eng-use-external-tmp/scripts/resolve-external-tmp.sh`,"pi-21.7"],{encoding:"utf8"});
 if(resolved.status!==0||!resolved.stdout.trim())throw new Error("Cannot resolve pi-21.7 temporary storage: "+resolved.stderr);
 const root=mkdtempSync(join(resolved.stdout.trim(),"host-")),agent=join(root,"agent"),sessions=join(root,"sessions");
 for(const dir of [agent,sessions])mkdirSync(dir);
 writeFileSync(join(root,"offline-profile"),"pi-21.7 fake-only\n");
 writeFileSync(join(agent,"settings.json"),JSON.stringify({defaultProvider:"agy-harness",defaultModel:"gemini-3.8-flash",defaultThinkingLevel:"high",checkForUpdates:false}));
 writeFileSync(join(agent,"models.json"),JSON.stringify({providers:{"agy-harness":{baseUrl:"stdio://agy",api:"rbf-agy",apiKey:"offline",models:[{id:"gemini-3.8-flash",name:"Flash (AGY agent)",reasoning:true,thinkingLevelMap:{off:null,minimal:null,low:"gemini-3.8-flash-low",medium:"gemini-3.8-flash-medium",high:"gemini-3.8-flash-high",xhigh:null,max:null},input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:1000000000,maxTokens:1000000000}]}}}));
 return {root,agent,sessions};
}
