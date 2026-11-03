// Saved-value storage/render proof only: no native source admission, command or paid prompt.
import {execFileSync,spawnSync} from "node:child_process";
import {mkdirSync,readFileSync,writeFileSync,realpathSync,renameSync,existsSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {createHash,randomUUID} from "node:crypto";
import {AGY_ACTIVITY,AGY_REPORTED_ACTIVITY,captureAgyActivity,captureAgyReportedStep,newAgyActivityBudget,recordAgyReportedStep,type AgyHistoryGuard,type AgyObservationScope,type AgyReportedStep} from "../lib/agy-history.js";
import {parseAgyCatalogue,toAgyProviderModel,AGY_API,AGY_PROVIDER} from "../rbf-agy.js";
import {replayScreen} from "./rbf-pty-screen.js";

if(process.argv[2]!=="check")throw Error("Use check; this helper never submits a prompt");
const workspace=resolve(dirname(fileURLToPath(import.meta.url)),"../.."),support=join(workspace,"extensions/test-support");
const base=execFileSync("bash",[join(process.env.HOME!,".agents/skills/eng-use-external-tmp/scripts/resolve-external-tmp.sh"),"pi-21.8"],{encoding:"utf8"}).trim();
const root=join(base,"opaque-proof-"+Date.now());mkdirSync(root);
const profile=join(root,"profile"),sessions=join(root,"sessions");mkdirSync(profile);mkdirSync(sessions);
const pi=execFileSync("which",["pi"],{encoding:"utf8"}).trim();
const shimTarget=readFileSync(pi,"utf8").split("# cmd-shim-target=")[1]?.trim();if(!shimTarget)throw Error("Unknown Pi shim");
const packageRoot=dirname(dirname(dirname(realpathSync(shimTarget))));
const runtime=await import(pathToFileURL(join(packageRoot,"dist/core/session-manager.js")).href);
const models=parseAgyCatalogue("gemini-3.8-flash-high\tGemini Flash (High)\n").map(toAgyProviderModel).map(model=>({...model,api:AGY_API,provider:AGY_PROVIDER,baseUrl:"stdio://agy"}));
writeFileSync(join(profile,"models-store.json"),JSON.stringify({[AGY_PROVIDER]:{models,checkedAt:Date.now()}}));
writeFileSync(join(profile,"settings.json"),JSON.stringify({defaultProvider:AGY_PROVIDER,defaultModel:"gemini-3.8-flash",defaultThinkingLevel:"high",packages:[],extensions:[],enableTelemetry:false}));
writeFileSync(join(profile,"auth.json"),"{}");
writeFileSync(join(root,"native.jsonl"),"");
// The wrapper points at this absent fake path. Any attempted acquisition fails before native code.
if(existsSync(join(root,"fake-agy.cjs")))throw Error("Native executable must be unavailable");
const events=join(root,"host-events.jsonl"),ready=join(root,"editor-ready.json");writeFileSync(events,"");
const rows=(file:string)=>existsSync(file)?readFileSync(file,"utf8").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line)):[];
const metadata={step_index:22,type:"GENERIC",source:"MODEL",status:"DONE",content:"supplied opaque text"};
const definitions=[
	{name:"mixed-v1-v2",input:metadata,expected:["Command: printf hello","AGY reported step \u00B7 step 22","supplied opaque text","Tool identity and command outcome: unknown"]},
	{name:"missing-flags",input:{...metadata,type:"PLANNER_RESPONSE",content:"PI_AG9_CHILD_RESULT_20261103"},expected:["Native truncation: not reported","PI_AG9_CHILD_RESULT_20261103","Native time: not reported"]},
	{name:"native-loss",input:{...metadata,truncated_fields:["content"]},expected:["Native truncation: content","Native reported truncation."]},
	{name:"local-loss",input:{...metadata,content:"supplied opaque textDROP123",truncated_fields:[]},remaining:20,expected:["Native truncation: none reported","Local capture is incomplete.","20 bytes retained; 7 bytes omitted"]},
	{name:"combined-loss",input:{...metadata,content:"supplied opaque textDROP123",truncated_fields:["content"],created_at:"2026-11-03T06:27:55Z"},remaining:20,expected:["Native reported truncation.","Local capture is incomplete.","Native time: 2026-11-03T06:27:55Z","Source attribution: container"]},
	{name:"invalid-v2",input:metadata,invalid:true,expected:["AGY activity unavailable: saved record is invalid or unsupported."]},
];
const fixtureReceipts:unknown[]=[];
for(const definition of definitions){
	const sessionId=randomUUID(),inputId="fixture-input",scope:AgyObservationScope={piSessionId:sessionId,inputEntryId:inputId,rootConversationId:"root-1",turnCount:1,source:{kind:"child",childId:"worker-a",conversationId:"child-1",parentConversationId:"root-1"}};
	const budget=newAgyActivityBudget();if("remaining"in definition)budget.payloadBytes=256*1024-definition.remaining!;
	const data="invalid"in definition?{schemaVersion:99}:captureAgyReportedStep(definition.input as AgyReportedStep,scope,budget).data;
	const stamp=new Date().toISOString();const entries:any[]=[{type:"session",version:3,id:sessionId,timestamp:stamp,cwd:workspace},{type:"message",id:inputId,parentId:null,timestamp:stamp,message:{role:"user",content:"Inspect saved reported work",timestamp:Date.now()}}];
	if(definition.name==="mixed-v1-v2"){const rootScope={...scope,source:{kind:"root" as const,conversationId:"root-1"}};entries.push({type:"custom",id:"fixture-v1",parentId:inputId,timestamp:stamp,customType:AGY_ACTIVITY,data:captureAgyActivity({kind:"tool",conversationId:"root-1",index:4,state:"DONE",toolName:"run_command",info:{name:"run_command",parameters:{CommandLine:"printf hello"},output:"hello"}},rootScope,newAgyActivityBudget()).data});}
	entries.push({type:"custom",id:"fixture-v2",parentId:entries.at(-1).id,timestamp:stamp,customType:AGY_REPORTED_ACTIVITY,data});
	const file=join(sessions,definition.name+".jsonl");writeFileSync(file,entries.map(e=>JSON.stringify(e)).join("\n")+"\n");
	for(const cols of [80,120])for(const reopen of [false,true]){
		const label=definition.name+"-"+cols+(reopen?"-reopen":""),raw=join(root,label+".raw"),count=rows(events).filter(e=>e.kind==="ready").length;
		const argv=[pi,"--no-extensions","--no-skills","--no-prompt-templates","--model",AGY_PROVIDER+"/gemini-3.8-flash","--thinking","high","--session",file,"--session-dir",sessions,"--tui-mode","fullscreen","-e",join(support,"rbf-agy-history-candidate.ts")];
		const plan={argv,cwd:workspace,env:{PI_CODING_AGENT_DIR:profile},cols,rows:60,timeout:30,out:raw,steps:[{waitJsonl:{path:events,field:"kind",value:"ready",count:count+1}},{reloadReady:{path:ready,loads:1,command:"/history-ready"}},{sleep:.2},{snapshot:"collapsed"},{key:"ctrl-o"},{sleep:.2},{snapshot:"expanded"},{paste:"/quit"},{key:"enter"},{waitExit:5}]};
		writeFileSync(join(root,label+"-plan.json"),JSON.stringify(plan));
		const result=spawnSync("python3",[join(support,"rbf-row-gate-drive.py")],{input:JSON.stringify(plan),encoding:"utf8",timeout:35000});writeFileSync(join(root,label+"-result.json"),JSON.stringify({code:result.status,stdout:result.stdout,stderr:result.stderr}));if(result.status!==0)throw Error(label+": "+result.stderr+result.stdout);
		const marks=JSON.parse(result.stdout),bytes=readFileSync(raw),collapsed=replayScreen(bytes.subarray(0,marks.collapsed),cols,60).lines.join("\n"),expanded=replayScreen(bytes.subarray(0,marks.expanded),cols,60).lines.join("\n");writeFileSync(join(root,label+"-collapsed.txt"),collapsed);writeFileSync(join(root,label+"-expanded.txt"),expanded);
		for(const expected of definition.expected)if(!expanded.includes(expected))throw Error(label+" missing "+expected);
		if(!("invalid"in definition)&&!expanded.includes("Native status does not establish tool or child completion."))throw Error(label+" invented completion");
		fixtureReceipts.push({label,expected:definition.expected,raw,sha256:createHash("sha256").update(bytes).digest("hex"),exit:marks.exit});console.log("PASS actual Pi saved-value "+label);
	}
}

const storageDir=join(root,"storage");mkdirSync(storageDir);
const sm=runtime.SessionManager.create(storageDir,storageDir),inputEntryId=sm.appendMessage({role:"user",content:"Inspect saved work",timestamp:Date.now()});
const scope:AgyObservationScope={piSessionId:sm.getSessionId(),inputEntryId,rootConversationId:"storage-root",turnCount:1,source:{kind:"child",conversationId:"storage-child",childId:"worker-a",parentConversationId:"storage-root"}};
const guard:AgyHistoryGuard<any>={assertCurrent(){},entries:()=>sm.getBranch(),leafId:()=>sm.getLeafId(),fingerprint:values=>JSON.stringify(values),expectedFingerprint:JSON.stringify(sm.getBranch()),append:(type,data)=>sm.appendCustomEntry(type,data)};
const budget=newAgyActivityBudget(),first=recordAgyReportedStep(metadata,scope,budget,guard);guard.expectedFingerprint=first.fingerprint;
const file=sm.getSessionFile();if(!file||!existsSync(file))throw Error("First opaque report not persisted");const preserved=file+".before-disk-failure";renameSync(file,preserved);mkdirSync(file);
let diskError="";try{recordAgyReportedStep({...metadata,step_index:23},scope,budget,guard);}catch(error){diskError=String(error);}if(!diskError.includes("EISDIR"))throw Error("Expected actual disk failure");
const memory=sm.getBranch().filter((entry:any)=>entry.customType===AGY_REPORTED_ACTIVITY);if(memory.length!==2||budget.observations!==1)throw Error("Failed write accepted");let retryRefused=false;try{recordAgyReportedStep(metadata,scope,budget,guard);}catch{retryRefused=true;}if(!retryRefused||sm.getBranch().filter((entry:any)=>entry.customType===AGY_REPORTED_ACTIVITY).length!==2)throw Error("Uncertain write retried");
const reopened=runtime.SessionManager.open(preserved),saved=reopened.getBranch().filter((entry:any)=>entry.customType===AGY_REPORTED_ACTIVITY);if(saved.length!==1||saved[0].id!==first.entryId)throw Error("Verified opaque entry did not reopen");if(JSON.stringify(reopened.buildSessionContext().messages).includes("supplied opaque text"))throw Error("Opaque data entered model context");
const loaded=rows(events).filter(e=>e.kind==="loaded-source"),hashes=Object.fromEntries(["rbf-agy.ts","lib/agy-native.ts","lib/agy-history.ts"].map(f=>[f,createHash("sha256").update(readFileSync(join(workspace,"extensions",f))).digest("hex")]));for(const event of loaded)for(const[file,hash]of Object.entries(hashes))if(event.hashes[file]!==hash)throw Error("Loaded source drift");
if(rows(join(root,"native.jsonl")).length)throw Error("Native process acquired");
const receipt={root,scope:"Manually supplied saved values: actual Pi rendering/storage, not native child admission or .9barrier proof",piVersion:JSON.parse(readFileSync(join(packageRoot,"package.json"),"utf8")).version,hashes,loadedSourceEvents:loaded.length,fixtures:fixtureReceipts,storage:{diskError,memoryReports:memory.length,verifiedSavedReports:saved.length,returnedEntryId:first.entryId,budgetObservations:budget.observations,retryRefused,modelContextExcludesActivity:true,preserved},nativeExecutableUnavailable:true,nativeInputs:0,conversationWorkers:0,paidRequests:0};
writeFileSync(join(root,"receipt.json"),JSON.stringify(receipt,null,2));console.log("Opaque host receipt: "+root);
