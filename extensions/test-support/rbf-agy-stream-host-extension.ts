import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRbfAgy } from "../rbf-agy.js";
import { createAgyStreamFixture } from "./agy-stream-fixture.js";

export default function (pi: ExtensionAPI) {
 let enabled = false, nativeTerminal = false;
 const root = process.env.RBF_AGY_STREAM_ROOT;
 const log = (data: Record<string, unknown>) => {
  if (!root) return;
  appendFileSync(join(root,"host.jsonl"),JSON.stringify({at:Date.now(),...data})+"\n");
 };
 // Register refusal before setup: a failed fake cannot expose another provider.
 pi.on("input",(_event,ctx)=>enabled && ctx.model?.provider==="agy-harness" ? {action:"continue"} : {action:"handled"});
 try {
  if(!root || !isAbsolute(root) || !existsSync(join(root,"offline-profile"))) throw new Error("Missing exclusive offline test profile");
  const scenario=process.env.RBF_AGY_STREAM_SCENARIO ?? "normal";
  const fake=createAgyStreamFixture(root,scenario,Number(process.env.RBF_AGY_STREAM_HOLD_MS ?? 1800));
  createRbfAgy({executable:fake.executable,argv:[],seal:{},trace(event,data){if(event==="native_result")nativeTerminal=true;log({kind:"trace",event,...data});}})(pi);
  pi.registerProvider("pi21-fake-neighbor",{api:"offline-neighbor",baseUrl:"stdio://fake",apiKey:"offline",models:[{id:"neighbor",name:"Offline neighbor",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000}],streamSimple(){throw new Error("Offline neighbor prompts are blocked");}});
  enabled=true;
 } catch(error) {
  log({kind:"setup_error",message:String(error)});
  pi.on("session_start",(_event,ctx)=>ctx.ui.notify("Offline AGY candidate setup failed. All prompts are blocked.","error"));
 }
 pi.registerCommand("offline-agy-depart",{description:"Offline streaming lifecycle check",handler:async(args,ctx)=>{
  const operation=args.trim();log({kind:"departure_begin",operation});
  if(operation==="new"){await ctx.newSession();return;}
  if(operation==="reload"){await ctx.reload();return;}
  if(operation==="model"){const model=ctx.modelRegistry.find("pi21-fake-neighbor","neighbor");if(!model || !await pi.setModel(model))throw new Error("Offline neighbor selection failed");log({kind:"departure_done",operation});return;}
  if(operation==="tree"){
   const user=ctx.sessionManager.getBranch().find((e:any)=>e.type==="message"&&e.message.role==="user");
   if(!user?.parentId)throw new Error("Offline tree target is missing");
   await ctx.navigateTree(user.parentId,{summarize:false});log({kind:"departure_done",operation});
  }
 }});
 let injected=false;
 pi.on("message_end",event=>{
  const mutation=process.env.RBF_AGY_STREAM_MUTATION;
  if(injected || event.message.role!=="assistant" || !mutation)return;
  injected=true;log({kind:"persistence_fault",mutation});
  if(mutation==="content")return {message:{...event.message,content:[{type:"text" as const,text:"Altered final"}]}};
  if(mutation==="prefix")pi.appendEntry("rbf-agy-prefix-fault",{injected:true});
  if(mutation==="foreign")pi.appendEntry("rbf-monitor",{note:"watch ended"});
 });
 const text=(message:any)=>message.content?.filter((b:any)=>b.type==="text").map((b:any)=>b.text).join("\n") ?? "";
 pi.on("message_update",event=>{
  if(event.message.role!=="assistant")return;
  const value=text(event.message);
  log({kind:"update",text:value});
  if(value&&!nativeTerminal)log({kind:"preview",text:value});
 });
 pi.on("message_end",event=>{if(event.message.role==="assistant")log({kind:"final",text:text(event.message),stopReason:event.message.stopReason});});
 pi.on("agent_end",()=>log({kind:"agent_end"}));
 pi.on("session_start",(_event,ctx)=>{
  // Discovery completes after session_start; keep input guarded until the fake model is selected.
  void (async()=>{
   const deadline=Date.now()+8000;
   while(enabled && Date.now()<deadline){
    const model=ctx.modelRegistry.find("agy-harness","gemini-3.8-flash");
    if(model && (ctx.model?.provider===model.provider && ctx.model?.id===model.id || await pi.setModel(model))){
     log({kind:"ready",enabled,hostVersion:VERSION,sourceHashes:Object.fromEntries(["../rbf-agy.ts","../lib/agy-native.ts"].map(file=>[file,createHash("sha256").update(readFileSync(new URL(file,import.meta.url))).digest("hex")])),model:model.provider+"/"+model.id,loaded:ctx.sessionManager.getBranch().filter((e:any)=>e.type==="message"&&e.message.role==="assistant").map((e:any)=>{const value=text(e.message);return{bytes:Buffer.byteLength(value),sha256:createHash("sha256").update(value).digest("hex"),stopReason:e.message.stopReason};})});
     return;
    }
    await new Promise(resolve=>setTimeout(resolve,25));
   }
   enabled=false;log({kind:"setup_error",message:"Fake model discovery/selection did not complete"});
  })().catch(error=>{enabled=false;log({kind:"setup_error",message:String(error)});});
 });
}
