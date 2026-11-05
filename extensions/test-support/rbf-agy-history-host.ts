// Reproduce ingestion/reload/reopen in real Pi with only an owned fake worker.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseAgyCatalogue, toAgyProviderModel, AGY_API, AGY_PROVIDER } from "../rbf-agy.js";
import { replayScreen } from "./rbf-pty-screen.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), support = join(workspace, "extensions/test-support");
const base = process.env.RBF_AGY_TEST_ROOT ?? tmpdir();
mkdirSync(base, { recursive: true });
const caseName = process.env.RBF_AGY_HISTORY_CASE ?? "host";
if (!/^host(?:-[a-zA-Z0-9-]+)?$/.test(caseName)) throw new Error("Invalid isolated host case name");
const root = join(base, caseName), profile = join(root, "profile"), sessions = join(root, "sessions");
for (const dir of [root, profile, sessions]) mkdirSync(dir, { recursive: true });
const fake = join(root, "fake-agy.cjs"), events = join(root, "host-events.jsonl"), native = join(root, "native.jsonl");
const catalogue = "gemini-3.8-flash-high\tGemini Flash (High)\n";
writeFileSync(join(root, "catalogue.txt"), catalogue);
const cachedModels = parseAgyCatalogue(catalogue).map(toAgyProviderModel).map(model => ({...model,api:AGY_API,provider:AGY_PROVIDER,baseUrl:"stdio://agy"}));
writeFileSync(join(profile, "models-store.json"), JSON.stringify({[AGY_PROVIDER]:{models:cachedModels,checkedAt:Date.now()}}));
writeFileSync(join(profile, "settings.json"), JSON.stringify({ defaultProvider: "agy-harness", defaultModel: "gemini-3.8-flash", defaultThinkingLevel: "high", packages: [], extensions: [], enableTelemetry: false }));
const fakeSource = `#!${process.execPath}
const fs=require('node:fs'),readline=require('node:readline');
const log=${JSON.stringify(native)},args=process.argv.slice(2),record=x=>fs.appendFileSync(log,JSON.stringify(x)+'\\n'),emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
record({kind:'launch',args});if(args[0]==='models'){process.stdout.write(${JSON.stringify(catalogue)});process.exit(0);}if(args[0]==='--version'){console.log('1.4.12');process.exit(0);}
const cid='history-fake-'+process.pid;let count=0,step=0;
emit({event:'init',conversation_id:cid,init:{model:args[args.indexOf('--model')+1],cwd:process.cwd(),tools:['run_command'],permission_mode:'default'}});
const rl=readline.createInterface({input:process.stdin});rl.on('line',line=>{const input=JSON.parse(line);record({kind:'input',input});count++;emit({event:'step_update',step_update:{conversation_id:cid,step_index:step++,step_type:'user_input',state:'DONE'}});const ix=step+3;step=ix+1;for(const state of ['ACTIVE','DONE'])emit({event:'step_update',step_update:{conversation_id:cid,step_index:ix,step_type:'tool',tool_name:'run_command',state,tool_info:{name:'run_command',parameters:{CommandLine:'printf hello'},...(state==='DONE'?{output:'hello'}:{})}}});emit({event:'result',result:{conversation_id:cid,status:'SUCCESS',response:'HISTORY_TASK_DONE',duration_seconds:0,num_turns:count,usage:{input_tokens:1,output_tokens:1,thinking_tokens:0,cache_read_tokens:0,total_tokens:2}}});});rl.on('close',()=>{record({kind:'eof'});process.exit(0);});process.on('SIGINT',()=>process.exit(1));
`;
writeFileSync(fake, fakeSource); chmodSync(fake, 0o700);
function session(file: string) { if (!existsSync(file)) writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: root }) + "\n"); }
session(join(sessions, "history.jsonl"));
if (process.argv[2] === "prepare") { console.log(JSON.stringify({ root, profile, session: join(sessions, "history.jsonl"), extension: join(support, "rbf-agy-history-candidate.ts") }, null, 2)); process.exit(0); }
const pi = process.env.RBF_AGY_HISTORY_PI ?? execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
const bundle = process.env.RBF_AGY_HISTORY_BUNDLE === "1" ? readdirSync(join(workspace, "extensions")).filter(name => /^rbf-.*\.ts$/.test(name) && !name.endsWith(".test.ts") && name !== "rbf-agy.ts").map(name => join(workspace, "extensions", name)) : [];
const bundleArgs = bundle.flatMap(file => ["-e", file]);
const rows = (file: string) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const submit = (text: string) => [{ paste: text }, { key: "enter" }];
const evidence: unknown[] = [];
const nativeCounts = () => { const log=rows(native);return {inputs:log.filter(e=>e.kind==="input").length,conversations:log.filter(e=>e.kind==="launch"&&e.args.includes("--input-format")).length,metadata:log.filter(e=>e.kind==="launch"&&!e.args.includes("--input-format")).length}; };
for (const cols of [80, 120]) {
	const file = join(sessions, cols === 80 ? "history.jsonl" : "history120.jsonl"); session(file);
	if (rows(file).some(e => e.type === "message" && e.message?.role === "user")) throw new Error("Refuse to overwrite an existing host run; retain it and use a fresh pi-21.8 temporary subdir");
	const initialInputs = rows(native).filter(e => e.kind === "input").length;
	const firstReady = rows(events).filter(e => e.kind === "ready").length;
	function run(label: string, steps: unknown[]) {
		const countsBefore = nativeCounts();
		const raw = join(root, `${cols}-${label}.raw`);
		const plan = { cwd: root, argv: [pi, "--no-extensions", "--no-skills", "--no-prompt-templates", "--model", "agy-harness/gemini-3.8-flash", "--thinking", "high", "--session", file, "--session-dir", sessions, "--tui-mode", "fullscreen", ...bundleArgs, "-e", join(support, "rbf-agy-history-candidate.ts")], env: { PI_CODING_AGENT_DIR: profile, TERM_PROGRAM: "Apple_Terminal", KITTY_WINDOW_ID: "", TMUX: "", STY: "", PI_TELEMETRY_DISABLED: "1" }, cols, rows: 60, timeout: 30, out: raw, steps };
		writeFileSync(join(root, `${cols}-${label}-plan.json`), JSON.stringify(plan, null, 2));
		const result = spawnSync("python3", [join(support, "rbf-row-gate-drive.py")], { input: JSON.stringify(plan), encoding: "utf8", timeout: 35000 });
		writeFileSync(join(root, `${cols}-${label}-result.json`), JSON.stringify({ code: result.status, stderr: result.stderr, stdout: result.stdout }, null, 2));
		if (result.status !== 0) throw new Error(`${label}/${cols}: ${result.stderr}`);
		const marks = JSON.parse(result.stdout), bytes = readFileSync(raw);
		for (const [name, at] of Object.entries(marks)) if (typeof at === "number") {
			const screen = replayScreen(bytes.subarray(0, at), cols, 60).lines.join("\n");
			writeFileSync(join(root, `${cols}-${label}-${name}.txt`), screen);
			if (["collapsed", "expanded", "reopened", "reloaded"].includes(name) && (!screen.includes("AGY command") || !screen.includes("printf hello") || !screen.includes("hello") || !screen.includes("outcome: unknown"))) throw new Error(`Missing historical command on ${cols}/${label}/${name}`);
		}
		const countsAfter = nativeCounts();
		if (label === "reopen" && (countsAfter.inputs !== countsBefore.inputs || countsAfter.conversations !== countsBefore.conversations)) throw new Error("Viewing acquired native conversation authority");
		evidence.push({ cols, label, raw, marks, countsBefore, countsAfter }); console.log(`PASS actual Pi ${cols}/${label}`);
	}
	run("ingest", [ { waitJsonl: { path: events, field: "kind", value: "ready", count: firstReady + 1 } }, { reloadReady: { path: join(root, "editor-ready.json"), loads: 1, command: "/history-ready" } }, ...submit("HISTORY_FAKE_COMMAND"), { wait: "HISTORY_TASK_DONE" }, { sleep: .3 }, { snapshot: "collapsed" }, { key: "ctrl-o" }, { sleep: .3 }, { snapshot: "expanded" }, ...(cols === 80 ? [...submit("HISTORY_FAKE_FOLLOWUP"), { wait: "HISTORY_TASK_DONE", count: 2 }, { sleep: .3 }] : []), ...submit("/reload"), { waitJsonl: { path: events, field: "kind", value: "ready", count: firstReady + 2 } }, { reloadReady: { path: join(root, "editor-ready.json"), loads: 2, command: "/history-ready" } }, { sleep: .3 }, { snapshot: "reloaded" }, ...submit("/quit"), { waitExit: 5 } ]);
	const beforeReopen = rows(native).filter(e => e.kind === "input").length;
	if (beforeReopen - initialInputs !== (cols === 80 ? 2 : 1)) throw new Error("Fake request count mismatch");
	const saved = rows(file), reports = saved.filter(e => e.customType === "rbf-agy-activity/v1");
	if (reports.length !== (cols === 80 ? 4 : 2) || reports.some(e => e.data.source.kind !== "root")) throw new Error("Saved report count/attribution mismatch");
	if (saved.filter(e => e.type === "message" && e.message?.role === "assistant").some(e => JSON.stringify(e.message.content).includes("printf hello"))) throw new Error("Observation entered assistant context");
	run("reopen", [{ waitJsonl: { path: events, field: "kind", value: "ready", count: firstReady + 3 } }, { reloadReady: { path: join(root, "editor-ready.json"), loads: 1, command: "/history-ready" } }, { key: "ctrl-o" }, { sleep: .4 }, { snapshot: "reopened" }, ...submit("/quit"), { waitExit: 5 }]);
	if (rows(native).filter(e => e.kind === "input").length !== beforeReopen) throw new Error("Reopening sent a native prompt");
}
const hashes = Object.fromEntries(["extensions/rbf-agy.ts", "extensions/lib/agy-native.ts", "extensions/lib/agy-history.ts"].map(file => [file, createHash("sha256").update(readFileSync(join(workspace, file))).digest("hex")]));
writeFileSync(join(root, "receipt.json"), JSON.stringify({ pi, hashes, fakeNativeOnly: true, paidNativePrompts: 0, bundle, evidence }, null, 2));
console.log(`Host receipt: ${root}`);
