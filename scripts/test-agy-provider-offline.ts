// Actual daily Pi TUI proof. Only a factory-injected fake AGY can be used here.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, chmodSync, realpathSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { reserveAgyOfflineRoot } from "../extensions/test-support/agy-offline-guard.ts";
import { replayScreen } from "../extensions/test-support/rbf-pty-screen.ts";
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
	if (!process.argv[i]?.startsWith("--") || !process.argv[i + 1])
		throw new Error("Expected --case/--pi-package/--candidate/--evidence arguments");
	args.set(process.argv[i], process.argv[i + 1]);
}
const name = args.get("--case"), candidate = realpathSync(args.get("--candidate") ?? ""), pkg = realpathSync(args.get("--pi-package") ?? ""), out = resolve(args.get("--evidence") ?? "");
if (!name || !args.has("--evidence") || !candidate.endsWith("/rbf-agy.ts"))
	throw new Error("Explicit provider candidate/case/evidence required");
if (!["direct-follow-up", "settings-change", "protocol-errors", "abort-and-shutdown", "navigation-and-provider-switch", "catalogue", "presentation-and-usage", "policy-and-startup", "actual-pi-contract", "denied-empty", "lifecycle-guards", "unknown-warning", "positive-clearing", "queued-steer", "retry-suppression"].includes(name))
	throw new Error(`Case not implemented: ${name}`);
const statusOrder = args.get("--status-order") ?? "off";
if (!["off", "before", "after"].includes(statusOrder))
	throw new Error("Expected status-order off/before/after");
if (statusOrder !== "off" && name !== "presentation-and-usage")
	throw new Error("Status composition belongs to the presentation case");
const statusFile = statusOrder === "off" ? undefined : realpathSync(args.get("--status-extension") ?? "");
const sourceFiles = [candidate, join(dirname(candidate), "lib/agy-native.ts"), join(dirname(candidate), "lib/agy-history.ts"), join(dirname(candidate), "lib/agy-recovery.ts"), ...(statusFile ? [statusFile] : [])];
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]));
const beforeHashes = sourceHashes();
reserveAgyOfflineRoot(out); // refuse stale profile/auth/receipt reuse before any child process
const nodeProbe = spawnSync(process.env.RBF_PI21_NODE ?? "node", ["-p", "process.execPath"], { encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: out } });
if (nodeProbe.status !== 0)
	throw new Error("A working Node executable is required before offline Pi starts; set RBF_PI21_NODE to its absolute path.");
const node = realpathSync(nodeProbe.stdout.trim());
const toolDirs: string[] = [];
for (const tool of ["fd", "rg"]) {
	const found = spawnSync("/usr/bin/which", [tool], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
	if (found.status !== 0)
		throw new Error(`Existing ${tool} is required; this runner will not start Pi to download it.`);
	const binary = realpathSync(found.stdout.trim());
	if (spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 5000, env: { PATH: dirname(node) + ":/usr/bin:/bin", HOME: out } }).status !== 0)
		throw new Error(`Existing ${tool} cannot run; no installation attempted.`);
	toolDirs.push(dirname(binary));
}
const root = resolve(import.meta.dirname, ".."), work = join(out, "task-workbench"), profile = join(out, "profile"), sessions = join(out, "sessions");
const home = join(out, "empty-home"), tmp = join(out, "tmp");
for (const p of [work, profile, sessions, home, tmp])
	mkdirSync(p, { mode: 0o700 });
const metadata = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
if (metadata.version !== "1.4.0")
	throw new Error("Revalidate actual-host recipe for this new Pi version");
const theme = args.get("--theme") ?? "dark";
if (!["dark", "light"].includes(theme))
	throw new Error("Expected built-in dark or light theme");
writeFileSync(join(profile, "settings.json"), JSON.stringify({ enabledModels: ["agy-harness/*"], defaultProvider: "agy-harness", defaultModel: "gemini-3.8-flash", defaultThinkingLevel: "high", theme,retry:{enabled:true,maxRetries:1,baseDelayMs:10},...(name==="lifecycle-guards"?{compaction:{enabled:true,reserveTokens:1,keepRecentTokens:1}}:{}) }));
const policyFile = join(out, "session-policy.json"), policyRaw = '{"enableTerminalSandbox":true,"toolPermission":"proceed-in-sandbox","agentMode":"accept-edits"}';
if (name === "policy-and-startup")
	writeFileSync(policyFile, policyRaw, { mode: 0o600 });
const log = join(out, "fake-native.jsonl"), trace = join(out, "provider-trace.jsonl"), ready = join(out, "ready.json"), exe = join(out, "fake-agy.cjs"), wrapper = join(out, "fake-provider.ts");
const families = ["gemini-4-argon", "gemini-3.8-flash", "claude-opus-5-5", "claude-sonnet-5-5"];
const inventory = [...families.flatMap(id => ["low", "medium", "high"].map(level => `${id}-${level}\t${id} (${level})`)), "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)"].join("\n");
// Warm-path fixtures use a real fake-catalogue model, not the retired placeholder.
// Separate cold/legacy/empty discovery proof starts without this fixture cache.
const fixtureStore = JSON.stringify({ "agy-harness": { checkedAt: 0, models: [{ id: "gemini-3.8-flash", name: "gemini-3.8-flash (AGY agent)", api: "rbf-agy", provider: "agy-harness", baseUrl: "stdio://agy", reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "gemini-3.8-flash-low", medium: "gemini-3.8-flash-medium", high: "gemini-3.8-flash-high", xhigh: null, max: null }, input: ["text"], contextWindow: 1_000_000_000, maxTokens: 1_000_000_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } });
writeFileSync(join(profile, "models-store.json"), fixtureStore);
const releaseFile = join(out, "release-first-fake-turn");
const lifecycleOrigin=join(out,"original-session.json");
const warningMarker=join(out,"warning-context-started");
const worker = `#!${node}
const fs=require('node:fs'),readline=require('node:readline');const log=${JSON.stringify(log)},args=process.argv.slice(2);const record=x=>fs.appendFileSync(log,JSON.stringify(x)+'\\n'),emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');record({event:'invocation',args});if(args[0]==='models'){console.log(${JSON.stringify(inventory)});process.exit(0);}if(args[0]==='--version'){console.log('1.4.12');process.exit(0);}const mode=${JSON.stringify(name)};const firstWarning=mode==='unknown-warning'&&!fs.existsSync(${JSON.stringify(warningMarker)});if(firstWarning)fs.writeFileSync(${JSON.stringify(warningMarker)},'first',{flag:'wx',mode:0o600});const cid='fake-'+process.pid;let count=0,step=0,label='',active=false,gate,watchdog;const clearGate=()=>{clearInterval(gate);clearTimeout(watchdog);};emit({event:'init',conversation_id:cid,init:{model:args[args.indexOf('--model')+1],cwd:process.cwd(),tools:[],permission_mode:'default'}});const rl=readline.createInterface({input:process.stdin});rl.on('line',line=>{const input=JSON.parse(line);record({event:'input',input});active=true;count++;const m=input.message.content.match(/MAPLE-[A-Z0-9]+/);if(m)label=m[0];emit({event:'step_update',step_update:{conversation_id:cid,step_index:step++,step_type:'user_input',state:'DONE'}});if(mode==='protocol-errors'||firstWarning){process.stdout.write('MALFORMED_NATIVE\\n');active=false;return;}const done=()=>{clearGate();active=false;record({event:'result',count});emit({event:'result',result:{conversation_id:cid,status:mode==='retry-suppression'?'ERROR':'SUCCESS',...(mode==='retry-suppression'?{error:'503 overloaded fake native'}:{}),num_turns:count,duration_seconds:0,response:mode==='denied-empty'?'':'AGY_FAKE_DONE '+label,...(mode==='denied-empty'?{denied_actions:[{action:'write_file',display_name:'EditFile'}]}:{}),usage:{input_tokens:count,output_tokens:count,thinking_tokens:0,cache_read_tokens:0,total_tokens:2*count}}});};if(mode==='abort-and-shutdown'){watchdog=setTimeout(()=>{record({event:'active_timeout'});process.exit(3);},10000);}else if((mode==='presentation-and-usage'||mode==='queued-steer'||mode==='unknown-warning'&&!firstWarning)&&count===1){gate=setInterval(()=>{try{if(fs.readFileSync(${JSON.stringify(releaseFile)},'utf8')==='release'){record({event:'release_observed'});done();}}catch{}},25);watchdog=setTimeout(()=>{clearGate();record({event:'release_timeout'});process.exit(3);},10000);}else done();});rl.on('close',()=>{record({event:'eof'});if(mode==='presentation-and-usage'||mode==='queued-steer'||mode==='unknown-warning'){clearGate();process.exit(0);}if(!active)process.exit(0);});process.on('SIGINT',()=>{record({event:'signal',signal:'SIGINT'});clearGate();active=false;const interrupted=()=>{clearGate();record({event:'interrupt_result'});emit({event:'result',result:{conversation_id:cid,status:'ERROR',error:'interrupted',num_turns:count,duration_seconds:0,usage:{input_tokens:count,output_tokens:0,thinking_tokens:0,cache_read_tokens:0,total_tokens:count}}});process.stdout.write('',()=>process.exit(1));};if(mode==='abort-and-shutdown'){gate=setInterval(()=>{try{if(fs.readFileSync(${JSON.stringify(releaseFile)},'utf8')==='release'){record({event:'interrupt_release_observed'});interrupted();}}catch{}},25);watchdog=setTimeout(()=>{clearGate();process.exit(3);},5000);}else interrupted();});
`;
writeFileSync(exe, worker);
chmodSync(exe, 0o700);
writeFileSync(wrapper, `${statusFile ? "import statusLine from " + JSON.stringify(statusFile) + ";" : ""}import {appendFileSync,readFileSync,writeFileSync,copyFileSync,constants} from 'node:fs';import {VERSION,FooterComponent} from '@earendil-works/pi-coding-agent';import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';import {createRbfAgy} from ${JSON.stringify(candidate)};import {installAgyOfflineGuard} from ${JSON.stringify(join(root, 'extensions/test-support/agy-offline-guard.ts'))};const record=(event,payload={})=>appendFileSync(${JSON.stringify(trace)},JSON.stringify({event,...payload})+'\\n');export default pi=>{let loads=0;try{loads=JSON.parse(readFileSync(${JSON.stringify(ready)},'utf8')).loads;}catch{}installAgyOfflineGuard(pi,record);if(${JSON.stringify(name)}==='actual-pi-contract')pi.registerFlag('sandbox',{type:'boolean',description:'Offline fixture registers the existing Pi sandbox flag'});${statusOrder === 'before' ? 'statusLine(pi);' : ''}pi.on('session_before_compact',event=>record('test_compact_before',{reason:event.reason}));pi.on('session_before_tree',event=>record('test_tree_before',{summary:event.preparation.userWantsSummary}));const register=pi.registerProvider.bind(pi);pi.registerProvider=(id,config)=>register(id,id==='agy-harness'?{...config,streamSimple:(model,context,options)=>{record('test_provider_call',{lastText:context.messages.at(-1)?.content});return config.streamSimple(model,context,options);}}:config);createRbfAgy({executable:${JSON.stringify(exe)},trace:record})(pi);${statusOrder === 'after' ? "let statusInstalled=false;pi.on('session_start',()=>{if(!statusInstalled){statusInstalled=true;statusLine(pi);}});" : ''}pi.registerProvider('pi21-fake-neighbor',{api:'pi21-fake-neighbor',baseUrl:'stdio://offline',apiKey:'offline-fixture',models:[{id:'fixture',name:'Offline neighbor fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:4096,maxTokens:100}],streamSimple:()=>{const stream=createAssistantMessageEventStream();const message={role:'assistant',api:'pi21-fake-neighbor',provider:'pi21-fake-neighbor',model:'fixture',content:[{type:'text',text:'NEIGHBOR_FAKE_DONE'}],timestamp:Date.now(),stopReason:'stop',usage:{input:100,output:20,cacheRead:30,cacheWrite:0,totalTokens:150,cost:{input:.0004,output:.0002,cacheRead:.0004,cacheWrite:0,total:.001}}};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});stream.end();});return stream;}});pi.registerCommand('pi21-offline-policy',{description:'Offline policy-file mutation fixture',handler:async(action)=>{if(${JSON.stringify(name)}!=='policy-and-startup')throw new Error('Policy mutation outside case');writeFileSync(${JSON.stringify(policyFile)},action.trim()==='restore'?${JSON.stringify(policyRaw)}:'{}');record('policy_fixture',{action:action.trim()});}});pi.registerCommand('pi21-offline-ready',{description:'Offline fixture editor readiness',handler:async(args,ctx)=>{if(args.trim()!==String(loads)||ctx.mode!=='tui'||ctx.model?.provider!=='agy-harness')return;writeFileSync(${JSON.stringify(ready)},JSON.stringify({loads,readyLoad:loads}));}});let returnLeaf;pi.registerCommand('pi21-offline-lifecycle',{description:'Offline public lifecycle fixture',handler:async(args,ctx)=>{
 if(${JSON.stringify(name)}!=='lifecycle-guards')throw new Error('Lifecycle fixture outside case');await ctx.waitForIdle();const action=args.trim();
 const from=ctx.sessionManager.getSessionFile();if(!from?.startsWith(${JSON.stringify(sessions)}+'/'))throw new Error('Active session escaped private fixture');
 let original;try{original=JSON.parse(readFileSync(${JSON.stringify(lifecycleOrigin)},'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;original={path:from,sid:ctx.sessionManager.getSessionId()};writeFileSync(${JSON.stringify(lifecycleOrigin)},JSON.stringify(original),{flag:'wx',mode:0o600});}
 if(typeof original.path!=='string'||!original.path.startsWith(${JSON.stringify(sessions)}+'/'))throw new Error('Invalid original private session');
 const replacement=async fresh=>record('lifecycle',{action,from,to:fresh.sessionManager.getSessionFile(),sessionId:fresh.sessionManager.getSessionId(),original:original.path,originalId:original.sid});
 const branch=ctx.sessionManager.getBranch();
 if(action==='current')await ctx.navigateTree(ctx.sessionManager.getLeafId(),{summarize:false});
 else if(action==='summary'){returnLeaf=ctx.sessionManager.getLeafId();const first=branch.find(e=>e.type==='message'&&e.message?.role==='assistant'&&e.message.provider==='agy-harness'&&e.message.stopReason==='stop');if(!first)throw new Error('Missing original assistant');await ctx.navigateTree(first.id,{summarize:true});}
 else if(action==='return')await ctx.navigateTree(returnLeaf,{summarize:false});
 else if(action==='fork'){const first=branch.find(e=>e.type==='message'&&e.message?.role==='assistant'&&e.message.provider==='agy-harness'&&e.message.stopReason==='stop');if(!first)throw new Error('Missing fork prefix');await ctx.fork(first.id,{position:'at',withSession:replacement});return;}
 else if(action==='resume'){if(from===original.path)throw new Error('Resume would reopen the active file');await ctx.switchSession(original.path,{withSession:replacement});return;}
 else if(action==='copy'){const target=${JSON.stringify(join(sessions,'copied-provenance.jsonl'))};copyFileSync(original.path,target,constants.COPYFILE_EXCL);await ctx.switchSession(target,{withSession:replacement});return;}
 else if(action==='compact'){ctx.compact({customInstructions:'Offline cancellation control',onComplete:()=>record('compact_result',{outcome:'completed'}),onError:error=>record('compact_result',{outcome:'error',error:error.message})});return;}
 else throw new Error('Unknown lifecycle action');record('lifecycle',{action,from,to:ctx.sessionManager.getSessionFile(),sessionId:ctx.sessionManager.getSessionId()});
}});pi.registerCommand('pi21-offline-observe',{description:'Offline fixture reads current public selection',handler:async(tag,ctx)=>{const level=pi.getThinkingLevel();record('observation',{tag:tag.trim(),choiceToken:tag.trim()+':'+ctx.model?.provider+'/'+ctx.model?.id,provider:ctx.model?.provider,model:ctx.model?.id,level,native:ctx.model?.reasoning?ctx.model.thinkingLevelMap?.[level]:ctx.model?.id});}});pi.on('agent_end',event=>record('test_turn_end',{messages:event.messages}));pi.on('session_start',(_,ctx)=>{loads++;writeFileSync(${JSON.stringify(ready)},JSON.stringify({loads}));if(${JSON.stringify(statusOrder)}!=='off'&&ctx.mode==='tui'){ctx.ui.setStatus('pi21-shell','sh:2');ctx.ui.setStatus('pi21-todo','todo:1');}if(${JSON.stringify(statusOrder)}!=='off'&&ctx.mode==='tui'){const proto=FooterComponent.prototype,registry=proto[Symbol.for('@earendil-works/pi-rbf:footer-registry')];record('footer_patch_order',{order:${JSON.stringify(statusOrder)},agyOutside:proto.render===registry?.installedRender,statusOutside:proto[Symbol.for('rbf.statusLine.originalFooterRender')]===registry?.installedRender});}record('test_host',{version:VERSION,mode:ctx.mode});});};
`);
const submit = (text: string) => [{ paste: text }, { key: "enter" }];
const wait = (event: string, count: number) => ({ waitJsonl: { path: trace, field: "event", value: event, count }, timeout: 15 });
let choiceSequence=0;
const choose=(id:string)=>{const tag="choice-"+(++choiceSequence);return [...submit("/model"),{sleep:.7},{key:"tab"},{paste:id},{key:"enter"},{sleep:.2},...submit("/pi21-offline-observe "+tag),{waitJsonl:{path:trace,field:"choiceToken",value:tag+":"+id,count:1},timeout:10}];};
const first = "Remember MAPLE-OFFLINE1. First fake task.";
const second = "Recall my label.";
const steps: any[] = [{ wait: "gemini-3.8-flash" }, { reloadReady: { path: ready, loads: 1, command: "/pi21-offline-ready", clearDraft: true } }, ...submit("/model"), { wait: "Model catalogs refreshed" }, { key: "tab" }, { wait: "gemini-3.8-flash" }, { paste: "agy-harness/gemini-3.8-flash" }, { key: "enter" }, ...submit("/pi21-offline-observe initial"), { waitJsonl: { path: trace, field: "choiceToken", value: "initial:agy-harness/gemini-3.8-flash", count: 1 }, timeout: 5 }, { sleep: .3 }, ...submit("/thinking high"), { sleep: .3 }];
const snapshots: string[] = [];
let currentWidth = 80;
const snapshotWidths = new Map<string, number>();
const resize = (cols: number) => { currentWidth = cols; return { resize: { cols, rows: 35 } }; };
const snapshot = (label: string) => { snapshots.push(label); snapshotWidths.set(label, currentWidth); return { snapshot: label }; };
let expectedInputs = 2, expectedConversations = 1;
if (name === "actual-pi-contract") {
	expectedInputs = 0;
	expectedConversations = 0;
	steps.push(...submit(first), wait("test_turn_end", 1), snapshot("no-session"));
}
else if (name === "catalogue") {
	expectedInputs = 0;
	expectedConversations = 0;
	for (const id of [...families, "gpt-oss-120b-medium"]) {
		steps.push(...choose("agy-harness/" + id));
		if (id !== "gpt-oss-120b-medium")
			for (const level of ["low", "medium", "high"])
				steps.push(...submit("/thinking " + level), ...submit("/pi21-offline-observe " + id + "/" + level));
		else
			steps.push(...submit("/pi21-offline-observe fixed"));
	}
	steps.push(wait("observation", 13), snapshot("catalogue"));
}
else {
	steps.push(...submit(first));
	if (name === "presentation-and-usage")
		steps.push({ waitJsonl: { path: log, field: "event", value: "input", count: 1 }, timeout: 10 }, snapshot("inflight80"), resize(120), snapshot("inflight120"), resize(80), { writeFixtureFile: { path: releaseFile, text: "release" } }, { waitJsonl: { path: log, field: "event", value: "release_observed", count: 1 }, timeout: 5 });
 if(name === "queued-steer") {
  expectedInputs=1;
  steps.push({waitJsonl:{path:log,field:"event",value:"input",count:1},timeout:10},...submit("Queued steer must not dispatch."),{waitJsonl:{path:trace,field:"event",value:"offline_input_admitted",count:2},timeout:5},snapshot("queued80"),{writeFixtureFile:{path:releaseFile,text:"release"}},wait("test_turn_end",1),snapshot("queued-settled80"));
 }
 else if(name === "retry-suppression") {
  expectedInputs=1;
  steps.push({waitJsonl:{path:trace,field:"event",value:"test_provider_call",count:2},timeout:15},wait("test_turn_end",2),snapshot("retry-ended80"));
 }
 else if (name === "protocol-errors" || name === "denied-empty") {
		expectedInputs = 1;
		steps.push(wait("test_turn_end", 1), snapshot(name === "denied-empty" ? "denial80" : "protocol-error"), resize(120), snapshot(name === "denied-empty" ? "denial120" : "protocol-error120"));
	}
	else if (name === "abort-and-shutdown") {
		expectedInputs = 1;
		steps.push({ waitJsonl: { path: log, field: "event", value: "input", count: 1 }, timeout: 10 }, {key:"escape"},{waitJsonl:{path:log,field:"signal",value:"SIGINT",count:1},timeout:2},{sleep:.3},snapshot("stopping80"),resize(120),snapshot("stopping120"),{writeFixtureFile:{path:releaseFile,text:"release"}},wait("test_turn_end",1),snapshot("aborted120"));
	}
 else if(name === "unknown-warning") {
  expectedConversations=2;
  steps.push(wait("test_turn_end",1),snapshot("unknown80"),resize(120),snapshot("unknown120"),resize(80),...submit("/new"),{reloadReady:{path:ready,loads:2,command:"/pi21-offline-ready",clearDraft:true}},...choose("agy-harness/gemini-3.8-flash"),...submit("/thinking high"),...submit(second),{waitJsonl:{path:log,field:"event",value:"input",count:2},timeout:10},snapshot("warning-running80"),resize(120),snapshot("warning-running120"),{writeFixtureFile:{path:releaseFile,text:"release"}},wait("provider_anchor",1),snapshot("warning-complete120"));
 }
	else {
		steps.push(wait("provider_anchor", 1), snapshot("first"));
		if (name === "policy-and-startup") {
			expectedInputs = 1;
			steps.push(...submit("/pi21-offline-policy change"), wait("policy_fixture", 1), ...submit("Changed policy must not dispatch."), wait("test_turn_end", 2), snapshot("policy-refusal"), ...submit("/pi21-offline-policy restore"), wait("policy_fixture", 2));
		}
		if(name === "positive-clearing") {
 expectedConversations=2;
 steps.push(...submit("/new"),{reloadReady:{path:ready,loads:2,command:"/pi21-offline-ready",clearDraft:true}},snapshot("positive80"),resize(120),snapshot("positive120"),resize(80),...choose("agy-harness/gemini-3.8-flash"),...submit("/thinking high"));
}
if (name === "settings-change")
			steps.push(...submit("/thinking medium"), ...submit("Wrong effort must not dispatch."), wait("test_turn_end", 2), snapshot("settings-refusal80"), resize(120), snapshot("settings-refusal120"), resize(80), ...submit("/thinking high"));
		if (name === "navigation-and-provider-switch") {
			expectedConversations = 2;
			steps.push(...choose("pi21-fake-neighbor/fixture"), wait("provider_retired", 1), ...choose("agy-harness/gemini-3.8-flash"), ...submit("Returning must not reopen."), wait("test_turn_end", 2), snapshot("context-ended"), ...submit("/new"), { reloadReady: { path: ready, loads: 2, command: "/pi21-offline-ready", clearDraft: true } }, ...choose("agy-harness/gemini-3.8-flash"), ...submit("/thinking high"));
		}
		if (name !== "policy-and-startup")
			steps.push(...submit(second),wait("provider_anchor",2),snapshot("second"));
 if(name === "positive-clearing")steps.push(snapshot("cleared80"),resize(120),snapshot("cleared120"));
	}
}
if(name === "lifecycle-guards") {
 expectedInputs=3;
 const act=(action:string)=>[...submit("/pi21-offline-lifecycle "+action),{waitJsonl:{path:trace,field:"action",value:action,count:1},timeout:15}];
 steps.push({sleep:.3},...submit("/tree"),{wait:"Session Tree",timeout:5},{snapshot:"tree-open"},{key:"escape"},{key:"ctrl-u"},...act("current"),...submit("/pi21-offline-lifecycle compact"),wait("compact_result",1),...submit(second),wait("provider_anchor",3),snapshot("after-noop-compact"),...act("summary"),...submit("Summary departure must not reopen."),wait("test_turn_end",4),snapshot("tree-ended80"),resize(120),snapshot("tree-ended120"),resize(80),...act("return"),...submit("Returning branch must not reopen."),wait("test_turn_end",5),...submit("/pi21-offline-lifecycle fork"),{reloadReady:{path:ready,loads:2,command:"/pi21-offline-ready",clearDraft:true}},...choose("agy-harness/gemini-3.8-flash"),...submit("Fork must not reopen native context."),wait("test_turn_end",6),...submit("/pi21-offline-lifecycle resume"),{reloadReady:{path:ready,loads:3,command:"/pi21-offline-ready",clearDraft:true}},...choose("agy-harness/gemini-3.8-flash"),...submit("Saved session must not reopen native context."),wait("test_turn_end",7),...submit("/pi21-offline-lifecycle copy"),{reloadReady:{path:ready,loads:4,command:"/pi21-offline-ready",clearDraft:true}},...choose("agy-harness/gemini-3.8-flash"),...submit("Copied provenance must not reopen native context."),wait("test_turn_end",8),snapshot("copied-ended"));
}
if (name === "presentation-and-usage") {
	steps.push(...submit("/session"), { sleep: .4 }, snapshot("session80"), resize(120), snapshot("session120"), resize(80), ...choose("pi21-fake-neighbor/fixture"), ...submit("Known neighbor accounting fixture."), wait("test_turn_end", 3), ...submit("/session"), { sleep: .3 }, snapshot("mixed80"), resize(120), snapshot("mixed120"), resize(80), ...choose("agy-harness/gemini-3.8-flash"), ...submit("/reload"), { reloadReady: { path: ready, loads: 2, command: "/pi21-offline-ready", clearDraft: true } }, snapshot("reloaded80"), ...submit("/new"), { reloadReady: { path: ready, loads: 3, command: "/pi21-offline-ready", clearDraft: true } }, snapshot("clean-new80"), resize(120), snapshot("clean-new120"));
}
steps.push(...submit("/quit"), { waitExit: 6 });
const raw = join(out, "terminal.raw"), plan = { argv: [node, join(pkg, "dist/cli.js"), "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "-e", wrapper, "--session-dir", sessions, "--provider", "agy-harness", "--model", "gemini-3.8-flash", "--tui-mode", "fullscreen", ...(name === "policy-and-startup" ? ["--agy-settings", policyFile] : []), ...(name === "actual-pi-contract" ? ["--no-session"] : [])], cwd: work, inheritEnv: false, env: { HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), TMPDIR: tmp, LANG: "en_US.UTF-8", SHELL: "/bin/zsh", PI_CODING_AGENT_DIR: profile, PATH: [dirname(node), ...toolDirs, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":") }, cols: 80, rows: 35, timeout: 100, out: raw, steps };
writeFileSync(join(out, "plan.json"), JSON.stringify(plan, null, 2));
console.log(`[${name}] starting actual Pi ${metadata.version} TUI with factory-injected fake; zero real requests`);
const result = spawnSync("python3", [join(root, "extensions/test-support/rbf-row-gate-drive.py")], { input: JSON.stringify(plan), encoding: "utf8", timeout: 110000 });
writeFileSync(join(out, "driver-result.json"), JSON.stringify(result, null, 2));
if (result.status !== 0) {
	console.error(result.stderr);
	throw new Error(`Actual-Pi offline case failed; retained ${out}`);
}
const marks = JSON.parse(result.stdout), bytes = readFileSync(raw);
for (const label of snapshots) {
	const sizes = plan.steps.filter(step => step.resize).map((step, i) => ({ at: marks["resize:" + (i + 1)], cols: step.resize.cols, rows: step.resize.rows })).filter(size => size.at < marks[label]);
	const replay = replayScreen(bytes.subarray(0, marks[label]), 80, 35, sizes);
	if (replay.cells.some(row => row.length !== snapshotWidths.get(label)))
		throw new Error("Snapshot width mismatch: " + label);
	const screen = replay.lines.join("\n");
	writeFileSync(join(out, label + ".txt"), screen);
	if ((!label.startsWith("mixed") && !screen.includes("AGY context: unknown")) || screen.includes("1000M"))
		throw new Error("Metrics projection failed in actual Pi");
}
if (name === "presentation-and-usage") {
	const copy = ["AGY token accounting: not tracked in Pi", "AGY cost: unknown. Pi token and cost totals exclude AGY."];
	for (const label of snapshots) {
		const screen = readFileSync(join(out, label + ".txt"), "utf8");
		if (copy.some(line => screen.includes(line)))
			throw new Error("Removed accounting notice is visible: " + label);
		if (label.startsWith("mixed") && (!screen.includes("Input: 130") || !screen.includes("Output: 20") || !screen.includes("Total: 150") || !screen.includes("$0.001")))
			throw new Error("Known neighbor statistics changed: " + label);
	}
}
const calls = readFileSync(log, "utf8").trim().split("\n").map(x => JSON.parse(x)), inputs = calls.filter(x => x.event === "input"), conversations = calls.filter(x => x.event === "invocation" && x.args[0] !== "models" && x.args[0] !== "--version");
if (inputs.length !== expectedInputs || conversations.length !== expectedConversations || (expectedInputs === 2 && inputs[1].input.message.content !== second) || (expectedConversations > 0 && !["abort-and-shutdown", "protocol-errors"].includes(name) && !calls.some(x => x.event === "eof")) || marks.exit?.code !== 0)
	throw new Error("Native fake input/owner/EOF contract failed");
const events = readFileSync(trace, "utf8").trim().split("\n").map(x => JSON.parse(x));
const turns = events.filter(x => x.event === "test_turn_end");
if (statusOrder !== "off") {
	const order = events.find(x => x.event === "footer_patch_order");
	if (!order || (statusOrder === "before" ? !order.agyOutside : !order.statusOutside))
		throw new Error("Requested footer patch ownership order not observed");
	for (const label of ["first", "second", "session80", "session120", "mixed80", "mixed120"]) {
		const screen = readFileSync(join(out, label + ".txt"), "utf8");
		if (!screen.includes("💬") || !screen.includes("sh:2") || !screen.includes("todo:1") || !screen.includes("📁"))
			throw new Error("Existing status-line/age/status content lost: " + label);
	}
}
if (name === "presentation-and-usage") {
	const release = calls.findIndex(x => x.event === "release_observed"), result = calls.findIndex(x => x.event === "result");
	if (release < 0 || result <= release || calls.some(x => x.event === "release_timeout") || readFileSync(releaseFile, "utf8") !== "release")
		throw new Error("In-flight snapshots lacked a controlled first-terminal release");
}
const lastAssistant = (turn: any) => turn?.messages?.filter((m: any) => m.role === "assistant").at(-1);
const assistantText = (message: any) => message?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") ?? "";
if (expectedInputs > 0 && inputs[0].input.message.content !== first)
	throw new Error("First prompt changed in native dispatch");
if (!["protocol-errors", "abort-and-shutdown", "catalogue", "actual-pi-contract", "denied-empty", "unknown-warning", "queued-steer", "retry-suppression"].includes(name)) {
	const successful = turns.map(lastAssistant).filter(m => m?.stopReason === "stop");
	if (successful.length !== (name === "policy-and-startup" ? 1 : ["presentation-and-usage","lifecycle-guards"].includes(name) ? 3 : 2) || successful.some((m: any, i: number) => assistantText(m) !== (name === "presentation-and-usage" && i === 2 ? "NEIGHBOR_FAKE_DONE" : ["navigation-and-provider-switch","positive-clearing"].includes(name) && i === 1 ? "AGY_FAKE_DONE " : "AGY_FAKE_DONE MAPLE-OFFLINE1")))
		throw new Error("Accepted ordinary task results did not persist exact attributable answers");
}
if (name === "denied-empty") {
	for (const label of ["denial80", "denial120"]) {
		const text = readFileSync(join(out, label + ".txt"), "utf8").replace(/\s+/g, " ");
		if (["Denied actions (conversation total): EditFile", "do not prove an edit was applied"].some(copy => !text.includes(copy)) || text.includes("SUCCESS with no answer text"))
			throw new Error("Required denial copy not visible: " + label);
	}
	const answer = lastAssistant(turns[0]);
	if (answer?.stopReason !== "stop" || assistantText(answer).includes("SUCCESS with no answer text") || !assistantText(answer).includes("Denied actions (conversation total): EditFile") || !assistantText(answer).includes("do not prove an edit was applied"))
		throw new Error("Empty-success/denial disclosure false");
}
if(name==="settings-change")for(const label of ["settings-refusal80","settings-refusal120"]){if(!readFileSync(join(out,label+".txt"),"utf8").replace(/\s+/g," ").includes("settings differ"))throw new Error("Settings refusal not visible: "+label);}
if (name === "settings-change" && (lastAssistant(turns[1])?.stopReason !== "error" || !assistantText(lastAssistant(turns[1])).includes("settings differ")))
	throw new Error("Wrong-effort refusal missing");
if (name === "navigation-and-provider-switch" && (lastAssistant(turns[1])?.stopReason !== "error" || !assistantText(lastAssistant(turns[1])).includes("context has ended")))
	throw new Error("Provider departure did not end context");
if (name === "protocol-errors" && (lastAssistant(turns[0])?.stopReason !== "error" || !assistantText(lastAssistant(turns[0])).includes("outcome is unknown") || assistantText(lastAssistant(turns[0])).includes("message was not sent")))
	throw new Error("Malformed after-input classification false");
if (name === "abort-and-shutdown" && (calls.filter(x => x.signal === "SIGINT").length !== 1 || lastAssistant(turns[0])?.stopReason !== "aborted"))
	throw new Error("Owned-child Escape cancellation missing");
if(name === "abort-and-shutdown") {
 for(const label of ["stopping80","stopping120"]){if(readFileSync(join(out,label+".txt"),"utf8").includes("AGY — stopping"))throw new Error("Removed stopping label still visible: "+label);}
 const released=calls.findIndex(x=>x.event==="interrupt_release_observed"),terminal=calls.findIndex(x=>x.event==="interrupt_result");
 if(released<0||terminal<=released||!events.some(e=>e.event==="provider_retired"&&e.classification==="verified-interrupted"))throw new Error("Interruption completion was not released/verified after stopping captures");
}
if (name === "catalogue") {
	const observations = events.filter(x => x.event === "observation"&&!x.tag.startsWith("choice-")&&x.tag!=="initial");
	if (observations.length !== 13 || new Set(observations.map(x => x.native)).size !== 13 || observations.some(x => x.provider !== "agy-harness" || x.native !== (x.tag === "fixed" ? "gpt-oss-120b-medium" : x.tag.replace("/", "-")) || x.model !== (x.tag === "fixed" ? "gpt-oss-120b-medium" : x.tag.split("/")[0]) || x.tag !== "fixed" && x.level !== x.tag.split("/")[1]))
		throw new Error("Not all 13 variants reached through native controls");
}
if (name === "policy-and-startup") {
	const policyEvents = events.filter(x => x.event === "policy_fixture");
	if (policyEvents.length !== 2 || policyEvents[0].action !== "change" || policyEvents[1].action !== "restore")
		throw new Error("Policy fixture mutation receipts missing");
	if (lastAssistant(turns[1])?.stopReason !== "error" || !assistantText(lastAssistant(turns[1])).includes("session settings changed") || readFileSync(policyFile, "utf8") !== policyRaw)
		throw new Error("Frozen policy change/refusal/restoration failed");
	const argv = conversations[0].args;
	if (argv[argv.indexOf("--settings") + 1] !== policyRaw || argv.filter((x: string) => x === "--settings").length !== 1 || argv.filter((x: string) => x === "--sandbox").length !== 1 || argv.includes("--dangerously-skip-permissions") || argv.some((x: string) => /permissions\.allow|permission-mode/.test(x)))
		throw new Error("Explicit policy/sandbox mapping not forwarded exactly");
}
else if (conversations.some(c => c.args.includes("--settings") || c.args.includes("--sandbox") || c.args.includes("--dangerously-skip-permissions")))
	throw new Error("Default launch changed native policy");
if(name === "lifecycle-guards") {
 const actions=events.filter(x=>x.event==="lifecycle").map(x=>x.action);
 if(["current","summary","return","fork","resume","copy"].some(action=>!actions.includes(action))||!events.some(x=>x.event==="test_compact_before"&&x.reason==="manual")||!events.some(x=>x.event==="compact_result"&&x.outcome==="error"&&/cancelled/i.test(x.error))||!events.some(x=>x.event==="test_tree_before"&&x.summary))throw new Error("Public lifecycle/summary/compact controls not exercised");
	if (turns.length !== 8 || turns.slice(3).some((turn, i) => {
		const a = lastAssistant(turn), t = assistantText(a);
		const expected = i < 2 ? "context has ended" : "history no longer matches this Pi branch";
		return a?.stopReason !== "error" || !t.includes("Your message was not sent.") || !t.includes(expected);
	})) throw new Error("Tree/fork/saved/copy context refusal false");
 if(JSON.stringify(inputs.map(x=>x.input.message.content))!==JSON.stringify([first,second,second]))throw new Error("Eligible exact follow-up sequence changed");
 const changes=events.filter(x=>x.event==="lifecycle"&&["fork","resume","copy"].includes(x.action));
 if(changes.length!==3||changes.some(x=>x.from===x.to)||changes.find(x=>x.action==="resume")?.to!==changes[0].original||changes.find(x=>x.action==="copy")?.to!==join(sessions,"copied-provenance.jsonl"))throw new Error("Replacement target/identity receipts false");
 const tree=replayScreen(bytes.subarray(0,marks["tree-open"]),80,35).lines.join("\n");writeFileSync(join(out,"tree-open.txt"),tree);if(!tree.includes("Session Tree"))throw new Error("Tree cancel did not show its native selector");
}
if(name === "unknown-warning") {
 if(turns.length!==2||lastAssistant(turns[0])?.stopReason!=="error"||!assistantText(lastAssistant(turns[0])).includes("outcome is unknown")||lastAssistant(turns[1])?.stopReason!=="stop"||assistantText(lastAssistant(turns[1]))!=="AGY_FAKE_DONE ")throw new Error("Unknown prior context silently reused or relabelled");
 const released=calls.findIndex(x=>x.event==="release_observed"),result=calls.findIndex(x=>x.event==="result");if(released<0||result<=released)throw new Error("Earlier-work running capture did not precede terminal release");
 for(const label of ["warning-running80","warning-running120"]){const text=readFileSync(join(out,label+".txt"),"utf8").replace(/\s+/g," ");if(!text.includes("Earlier AGY work")||!text.includes("AGY stop could not be verified. Commands it started may still be running.")||text.includes("AGY — running")||text.includes("AGY stopped."))throw new Error("Earlier unknown warning missing or current running child labelled stopped");}
}
if(name === "positive-clearing") {
 for(const label of ["positive80","positive120"]){if(!readFileSync(join(out,label+".txt"),"utf8").includes("AGY stopped. Commands it started may still be running."))throw new Error("Prior positive disclosure not visible before fresh work");}
 for(const label of ["cleared80","cleared120"]){const text=readFileSync(join(out,label+".txt"),"utf8");if(text.includes("AGY stopped.")||text.includes("Earlier AGY work")||text.includes("AGY token accounting")||!text.includes("AGY context: unknown"))throw new Error("Positive stop disclosure leaked onto a fresh live child, a removed accounting notice returned, or the AGY footer is missing");}
}
if (["queued-steer","retry-suppression"].includes(name)) {
 if(events.filter(e=>e.event==="test_provider_call").length!==2||inputs.length!==1||conversations.length!==1)throw new Error("Host callback caused extra native input");
 if(name==="queued-steer"&&(!calls.some(x=>x.event==="release_observed")||events.filter(e=>e.event==="offline_input_admitted").length!==2))throw new Error("Queued input not exercised");
}
const sessionFiles = readdirSync(sessions).filter(file => file.endsWith(".jsonl"));
const persisted = sessionFiles.flatMap(file => readFileSync(join(sessions, file), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
const provenance = persisted.filter(e => e.type === "custom" && e.customType === "rbf-agy-conversation/v1");
if ((name === "lifecycle-guards"?new Set(provenance.map(e=>e.data.conversationId)).size:provenance.length) !== expectedConversations || provenance.some(e => JSON.stringify(Object.keys(e.data).sort()) !== JSON.stringify(["conversationId", "cwd", "sessionId"]) || e.data.cwd !== work))
	throw new Error("Persisted provenance contract failed");
const assistants = persisted.filter(e => e.type === "message" && e.message?.role === "assistant");
if ((name === "lifecycle-guards"?new Set(assistants.map(e=>JSON.stringify(e.message))).size:assistants.length) !== (name === "actual-pi-contract" ? 0 : turns.reduce((sum,turn)=>sum+turn.messages.filter((m:any)=>m.role==="assistant").length,0)))
	throw new Error("Not all assistant outcomes persisted");
if(name!=="actual-pi-contract") {
 const canonical=(m:any)=>JSON.stringify([m.role,m.provider,m.api,m.model,m.timestamp,m.stopReason,m.content,m.usage,m.errorMessage]);
 const storedSet=[...new Set(assistants.map(e=>canonical(e.message)))].sort();
 const eventSet=[...new Set(turns.flatMap(turn=>turn.messages.filter((m:any)=>m.role==="assistant").map(canonical)))].sort();
 if(JSON.stringify(storedSet)!==JSON.stringify(eventSet))throw new Error("Persisted assistant set differs from completed actual-host messages");
}
writeFileSync(join(out, "persisted-summary.json"), JSON.stringify({ sessionFiles, provenance, assistants: assistants.map(e => ({ id: e.id, parentId: e.parentId, message: e.message })) }, null, 2));
if (name === "actual-pi-contract") {
	const refusal = lastAssistant(turns[0]);
	if (refusal?.stopReason !== "error" || !assistantText(refusal).includes("needs Pi session history") || sessionFiles.length !== 0)
		throw new Error("Actual TUI persistence guard was not exercised");
	const hostResults: any[] = [];
	const hostProfile = (mode: string) => {
		const dir = join(out, "host-" + mode), home = join(dir, "home"), profile = join(dir, "profile"), saved = join(dir, "sessions"), tmp = join(dir, "tmp");
		reserveAgyOfflineRoot(dir);
		for (const file of [home, profile, saved, tmp])
			mkdirSync(file, { mode: 0o700 });
		writeFileSync(join(profile, "models-store.json"), fixtureStore);
		return { dir, saved, env: { ...plan.env, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), TMPDIR: tmp, PI_CODING_AGENT_DIR: profile } };
	};
	const validRefusal = (m: any) => m?.role === "assistant" && m.provider === "agy-harness" && m.api === "rbf-agy" && m.stopReason === "error" && m.errorMessage?.includes("available only in the Pi TUI");
	const checkSaved = (host: any, validate = validRefusal) => {
		const files = readdirSync(host.saved).filter(file => file.endsWith(".jsonl"));
		const entries = files.flatMap(file => readFileSync(join(host.saved, file), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
		const users = entries.filter(e => e.type === "message" && e.message?.role === "user"), answers = entries.filter(e => e.type === "message" && e.message?.role === "assistant");
		if (files.length !== 1 || users.length !== 1 || answers.length !== 1 || !validate(answers[0].message) || entries.some(e => e.customType === "rbf-agy-conversation/v1"))
			throw new Error("Excluded host persisted a different result or provenance");
	};
	for (const mode of ["text", "json"]) {
		const host = hostProfile(mode);
		const argv = [node, join(pkg, "dist/cli.js"), "--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "-e", wrapper, "--session-dir", host.saved, "--provider", "agy-harness", "--model", "gemini-3.8-flash", "--mode", mode, "-p", "Fake host admission only."];
		const child = spawnSync(argv[0], argv.slice(1), { cwd: work, env: host.env, encoding: "utf8", timeout: 20000, killSignal: "SIGKILL" });
		writeFileSync(join(out, "host-" + mode + ".json"), JSON.stringify(child, null, 2));
		if (mode === "text") {
			if (child.status !== 1 || child.stdout.trim() !== "" || !child.stderr.includes("available only in the Pi TUI"))
				throw new Error("Print host did not refuse before native work");
		}
		else {
			const events = child.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
			if (child.status !== 0 || events.filter(e => e.type === "message_end" && validRefusal(e.message)).length !== 1 || !events.some(e => e.type === "agent_settled"))
				throw new Error("JSON host refusal/completion contract failed");
		}
		checkSaved(host);
		hostResults.push({ mode, exit: child.status });
	}
	const rpcHost = hostProfile("rpc");
	const rpc = await new Promise<any>((resolve, reject) => {
		const child = spawn(node, [join(pkg, "dist/cli.js"), "--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "-e", wrapper, "--session-dir", rpcHost.saved, "--provider", "agy-harness", "--model", "gemini-3.8-flash", "--mode", "rpc"], { cwd: work, env: rpcHost.env, stdio: ["pipe", "pipe", "pipe"] });
		let pending = "", stdout = "", stderr = "", settled = false, readback = false, stateVerified = false, closed = false, failure: Error | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined;
		const events: any[] = [];
		const capture = (code: number | null, signal: string | null, closeObserved: boolean) => writeFileSync(join(out, "host-rpc.json"), JSON.stringify({ code, signal, closeObserved, failure: failure?.message, stdout, stderr, events }, null, 2));
		const fail = (error: Error) => {
			if (failure || closed)
				return;
			failure = error;
			try {
				child.stdin.destroy();
			}
			catch { }
			try {
				child.kill("SIGTERM");
			}
			catch { }
			killTimer = setTimeout(() => {
				if (!closed) {
					try {
						child.kill("SIGKILL");
					}
					catch { }
				}
			}, 500);
			closeTimer = setTimeout(() => {
				if (closed)
					return;
				capture(null, null, false);
				child.stdout.destroy();
				child.stderr.destroy();
				child.unref();
				reject(failure);
			}, 1500);
		};
		const timer = setTimeout(() => fail(new Error("RPC fixture timed out; only retained Pi handle signalled")), 20000);
		child.stdin.on("error", fail);
		child.stderr.on("data", bytes => stderr += bytes.toString());
		child.stdout.on("data", bytes => {
			if (failure)
				return;
			stdout += bytes.toString();
			pending += bytes.toString();
			let newline: number;
			while ((newline = pending.indexOf("\n")) >= 0) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				if (!line.trim())
					continue;
				let e: any;
				try {
					e = JSON.parse(line);
				}
				catch {
					fail(new Error("RPC emitted non-JSON stdout"));
					return;
				}
				events.push(e);
				if (e.type === "response" && e.id === "state") {
					if (!e.success || e.data?.model?.provider !== "agy-harness" || e.data?.model?.id !== "gemini-3.8-flash" || !e.data.sessionFile) {
						fail(new Error("RPC state did not establish intended provider/session"));
						return;
					}
					stateVerified = true;
					child.stdin.write(JSON.stringify({ id: "prompt", type: "prompt", message: "Fake host admission only." }) + "\n");
				}
				if (e.type === "agent_settled" && !settled) {
					settled = true;
					child.stdin.write(JSON.stringify({ id: "readback", type: "get_messages" }) + "\n");
				}
				if (e.type === "response" && e.id === "readback") {
					readback = true;
					child.stdin.end();
				}
			}
		});
		child.on("error", fail);
		child.on("close", (code, signal) => {
			closed = true;
			clearTimeout(timer);
			clearTimeout(killTimer);
			clearTimeout(closeTimer);
			capture(code, signal, true);
			if (failure) {
				reject(failure);
				return;
			}
			const response = events.find(e => e.type === "response" && e.id === "readback");
			const message = response?.data?.messages?.filter((m: any) => m.role === "assistant").at(-1);
			if (code !== 0 || !stateVerified || !settled || !readback || events.filter(e => e.type === "message_end" && validRefusal(e.message)).length !== 1 || !events.some(e => e.type === "response" && e.id === "prompt" && e.success) || !validRefusal(message)) {
				reject(new Error("RPC provider refusal/readback contract failed"));
				return;
			}
			resolve({ mode: "rpc", exit: code });
		});
		child.stdin.write(JSON.stringify({ id: "state", type: "get_state" }) + "\n");
	});
	checkSaved(rpcHost);
	hostResults.push(rpc);
	const sandboxHost = hostProfile("sandbox"), sandboxReady = JSON.parse(readFileSync(ready, "utf8")).loads + 1;
	const priorTurns = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(e => e.event === "test_turn_end").length;
	const sandboxPlan = { ...plan, timeout:30, cwd: work, env: sandboxHost.env, out: join(sandboxHost.dir, "terminal.raw"), argv: [node, join(pkg, "dist/cli.js"), "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "-e", wrapper, "--session-dir", sandboxHost.saved, "--provider", "agy-harness", "--model", "gemini-3.8-flash", "--sandbox", "--tui-mode", "fullscreen"], steps: [{ wait: "gemini-3.8-flash" }, { reloadReady: { path: ready, loads: sandboxReady, command: "/pi21-offline-ready", clearDraft: true } }, ...submit("Fake sandbox admission only."), wait("test_turn_end", priorTurns + 1), { snapshot: "sandbox" }, ...submit("/quit"), { waitExit: 6 }] };
	writeFileSync(join(sandboxHost.dir, "plan.json"), JSON.stringify(sandboxPlan, null, 2));
	const sandbox = spawnSync("python3", [join(root, "extensions/test-support/rbf-row-gate-drive.py")], { input: JSON.stringify(sandboxPlan), encoding: "utf8", timeout: 40000, killSignal: "SIGKILL" });
	writeFileSync(join(sandboxHost.dir, "driver-result.json"), JSON.stringify(sandbox, null, 2));
	if (sandbox.status !== 0)
		throw new Error("Actual TUI sandbox fixture failed: " + sandbox.stderr);
	const sandboxMarks = JSON.parse(sandbox.stdout);
	if (sandboxMarks.exit?.code !== 0)
		throw new Error("Sandbox host did not exit gracefully");
	checkSaved(sandboxHost, (m: any) => m?.provider === "agy-harness" && m.api === "rbf-agy" && m.stopReason === "error" && m.errorMessage?.includes("sandboxed Pi session"));
	hostResults.push({ mode: "tui-sandbox", exit: sandboxMarks.exit.code });
	if (readFileSync(log, "utf8").trim().split("\n").length !== calls.length)
		throw new Error("Excluded host started native metadata/conversation work");
	writeFileSync(join(out, "host-contract.json"), JSON.stringify({ verdict: "PASS", tuiNoSession: true, hostResults, nativeConversationInputs: 0 }, null, 2));
}
const afterHashes = sourceHashes();
if (JSON.stringify(beforeHashes) !== JSON.stringify(afterHashes))
	throw new Error("Candidate source changed during proof");
const sourceHash = createHash("sha256").update(readFileSync(candidate)).digest("hex");
writeFileSync(join(out, "result.json"), JSON.stringify({ verdict: "PASS", case: name, theme, statusOrder, pi: metadata.version, sourceHash, sourceHashes: afterHashes, environmentInherited: false, providerGuard: true, realModelRequests: 0, nativeFakeInputs: inputs.length, nativeConversations: conversations.length, gracefulPiExit: marks.exit.code }, null, 2));
console.log(`[${name}] PASS: ${inputs.length} inputs, ${conversations.length} children, graceful Pi exit; ${out}`);
