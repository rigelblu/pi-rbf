import { describe, expect, it } from "vitest";
import { parseAgyCatalogue, resolveAgySelection, toAgyProviderModel } from "./rbf-agy.js";
const families = ["gemini-4-argon", "gemini-3.8-flash", "claude-opus-5-5", "claude-sonnet-5-5"];
const inventory = [...families.flatMap(id => ["low", "medium", "high"].map(level => `${id}-${level}\t${id} (${level})`)), "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)"].join("\n");
describe("family effort resolution", () => {
	it("makes all 13 published variants reachable through five Pi models", () => {
		const models = parseAgyCatalogue(inventory);
		expect(models).toHaveLength(5);
		for (const id of families)
			for (const level of ["low", "medium", "high"]) {
				expect(resolveAgySelection(toAgyProviderModel(models.find(m => m.id === id)!), level)).toEqual({ nativeModel: `${id}-${level}`, nativeEffort: level });
			}
		const fixed = toAgyProviderModel(models.find(m => m.id === "gpt-oss-120b-medium")!);
		expect(fixed.reasoning).toBe(false);
		expect(resolveAgySelection(fixed, undefined)).toEqual({ nativeModel: "gpt-oss-120b-medium" });
	});
	it("explicitly hides unsupported levels rather than substituting a native default", () => {
		const m = toAgyProviderModel(parseAgyCatalogue(inventory)[0]);
		expect(m.thinkingLevelMap).toEqual({ off: null, minimal: null, low: `${m.id}-low`, medium: `${m.id}-medium`, high: `${m.id}-high`, xhigh: null, max: null });
		for (const level of [undefined, "off", "minimal", "xhigh", "max"])
			expect(() => resolveAgySelection(m, level)).toThrow(/model or effort/);
		expect(() => resolveAgySelection(toAgyProviderModel({ id: "agy-select-model", name: "Retired AGY entry", variants: {}, fixed: "agy-select-model" }), "high")).toThrow(/Open \/model/);
	});
	it("does not infer effort capabilities from a future model suffix", () => {
		const m = toAgyProviderModel(parseAgyCatalogue("future-model-high\tFuture model (High)")[0]);
		expect(m.id).toBe("future-model-high");
		expect(m.reasoning).toBe(false);
		expect(resolveAgySelection(m, "high")).toEqual({ nativeModel: "future-model-high" });
	});
	it("offers only exact listed variants from the evidenced current families", () => {
		const m = toAgyProviderModel(parseAgyCatalogue("gemini-4-argon-low\tArgon Low")[0]);
		expect(resolveAgySelection(m, "low").nativeModel).toBe("gemini-4-argon-low");
		expect(() => resolveAgySelection(m, "high")).toThrow();
		const x = toAgyProviderModel(parseAgyCatalogue("gemini-4-argon-xhigh\tArgon Xhigh")[0]);
		expect(x.id).toBe("gemini-4-argon-xhigh");
		expect(x.reasoning).toBe(false);
	});
	it.each(["", "bad", "x\tName\textra", "x\tOne\nx\tTwo", "x\tName\u001b[2J", "x\t", "../id\tName"])("rejects malformed or ambiguous metadata %j", raw => {
		expect(() => parseAgyCatalogue(raw)).toThrow();
	});
});
import { afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, existsSync, readFileSync, chmodSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { createRbfAgy, AGY_PROVIDER, AGY_API, AGY_COPY, AGY_PROVENANCE, readAgyPolicy, readAgyCatalogue, sameAgyPolicy, agyPolicyArgs, projectAgyFooter, projectAgyThinking, type AgyRetirementSeal } from "./rbf-agy.js";
const roots = process.env.PI214_TEST_ROOT ?? process.env.RBF_AGY_TEST_ROOT ?? process.env.RBF_AGY_TEST_TMP;
if (!roots) throw new Error("Resolve PI214_TEST_ROOT with eng-use-external-tmp before tests");
mkdirSync(roots, { recursive: true });
const retained: Array<{
	close(): Promise<void>;
}> = [];
afterEach(async () => {
	for (const h of retained.splice(0))
		await h.close();
});
export function harness(mode = "normal", opts: {
	root?: string;
	cwd?: string;
	seal?: AgyRetirementSeal;
	policy?: string;
	mode?: string;
	persist?: boolean;
	argv?: string[];
	piVersion?: string;
	trace?: (event: string, payload: any) => void;
} = {}) {
	const root = opts.root ?? mkdtempSync(join(roots!, "case-")), log = join(root, "native.jsonl"), exe = join(root, "fake-agy.cjs");
	const holder=join(root,"pipe-holder.cjs"),release=join(root,"release-holder"),releaseHistory=join(root,"release-history");
 if(mode==='held-pipe')writeFileSync(holder,`const fs=require('node:fs');const log=${JSON.stringify(log)},release=${JSON.stringify(release)};const record=x=>fs.appendFileSync(log,JSON.stringify(x)+'\\n');record({desc_start:true});for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{record({desc_signal:signal});process.exit(4);});let poll=setInterval(()=>{try{if(fs.readFileSync(release,'utf8')==='release'){clearInterval(poll);record({desc_exit:0});process.exit(0);}}catch{}},25);setTimeout(()=>{record({desc_exit:3});process.exit(3);},5000);`);
 const worker = `#!${process.execPath}
const fs=require('node:fs'),readline=require('node:readline');const LOG=${JSON.stringify(log)},MODE=${JSON.stringify(mode)},RELEASE_HISTORY=${JSON.stringify(releaseHistory)};const args=process.argv.slice(2);const record=x=>fs.appendFileSync(LOG,JSON.stringify(x)+'\\n');const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');record({args});if(args[0]==='--version'){console.log(MODE==='old-version'?'1.0.0':'1.4.12');process.exit(0);}if(args[0]==='models'){const done=()=>{console.log(MODE==='catalogue-empty'?'':MODE==='catalogue-bad'?'malformed-catalogue':${JSON.stringify(inventory)});process.exit(0);};if(MODE==='slow-metadata')setTimeout(done,200);else done();return;}if(MODE==='login-error'){console.error('authentication required FAKE_CREDENTIAL_DO_NOT_EXPOSE');process.exit(1);}const stateFile=${JSON.stringify(join(root, 'native-state.json'))};const resume=args.includes('--conversation')?args[args.indexOf('--conversation')+1]:null;let saved=resume&&fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):null;const cid=MODE==='wrong-resume-id'?'wrong-id':resume??'fixture-'+process.pid;let count=saved?.count??0,step=saved?.step??0,nonce=saved?.nonce??'',active=false;const goCwd=()=>{const p=process.env.PWD;try{return p&&require('node:path').isAbsolute(p)&&fs.realpathSync(p)===process.cwd()?p:process.cwd();}catch{return process.cwd();}};const initialize=()=>{record({init:true});emit({event:'init',conversation_id:cid,init:{model:MODE==='wrong-init-model'?'other-model':args[args.indexOf('--model')+1],cwd:MODE==='wrong-init-cwd'?process.cwd()+'/other':goCwd(),tools:[],permission_mode:MODE==='wrong-resume-mode'?'other-mode':'default'}});};if(MODE==='slow-init')setTimeout(initialize,1000);else initialize();const result=(status,response,error)=>emit({event:'result',result:{conversation_id:cid,status,response,error,num_turns:count,duration_seconds:0,usage:{input_tokens:1,output_tokens:1,thinking_tokens:0,cache_read_tokens:0,total_tokens:2},...(MODE==='denial'?{denied_actions:[{action:'write_file',display_name:'EditFile'}]}:{})}});const rl=readline.createInterface({input:process.stdin});rl.on('line',line=>{const x=JSON.parse(line);record({input:x});active=true;count++;emit({event:'step_update',step_update:{conversation_id:cid,step_index:step++,step_type:'user_input',state:'DONE'}});const finish=()=>{const text=x.message.content;const m=text.match(/MAPLE-[A-Z0-9]+/);if(m)nonce=m[0];if(MODE==='bad'){console.log('malformed-native');active=false;return;}const done=()=>{active=false;fs.writeFileSync(stateFile,JSON.stringify({count,step,nonce}));result(MODE==='error'?'ERROR':'SUCCESS',MODE==='denial'?'':'Native answer '+nonce,MODE==='error'?'Native permission refused':undefined);};if(MODE==='slow')setTimeout(done,400);else done();};if(MODE.startsWith('history')){const ix=step+3;step=ix+1;const tool=(state,info)=>emit({event:'step_update',step_update:{conversation_id:MODE==='history-wrong'?'other-root':cid,step_index:ix,step_type:'tool',state,tool_name:'run_command',...(info?{tool_info:{name:'run_command',...info}}:{})}});if(MODE==='history-many'){for(let n=0;n<256;n++)tool('ACTIVE');tool('DONE');finish();return;}if(MODE==='history-missing'){tool('DONE');finish();return;}tool('ACTIVE',{parameters:{CommandLine:'printf hello'}});if(MODE==='history-hold')return;const resumeHistory=()=>{tool(MODE==='history-error'?'ERROR':'DONE',{parameters:{CommandLine:'printf hello'},...(MODE==='history-error'?{error:{type:'CommandError',message:'permission denied'}}:{output:MODE==='history-long'?['line1','line2','line3','line4','line5','line6'].join(String.fromCharCode(10)):'hello'})});finish();};if(MODE==='history-gate'){let poll=setInterval(()=>{try{if(fs.readFileSync(RELEASE_HISTORY,'utf8')==='release'){clearInterval(poll);resumeHistory();}}catch{}},10);return;}resumeHistory();return;}finish();});rl.on('close',()=>{record({eof:true});if(MODE==='held-pipe'){require('node:child_process').spawn(process.execPath,[${JSON.stringify(holder)}],{stdio:['ignore',1,2]}).unref();process.exit(0);}if(!active){if(MODE==='ignore-eof')setInterval(()=>{},500);else process.exit(0);}});process.on('SIGINT',()=>{record({signal:'SIGINT'});if(active){active=false;result('ERROR',undefined,'interrupted');}process.stdout.write('',()=>process.exit(1));});record({workerReady:true});
`;
	writeFileSync(exe, worker);
	chmodSync(exe, 0o700);
	const sessionFile = join(root, 'pi.jsonl');
	if (!existsSync(sessionFile)) writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id: `pi-${root}`, cwd: root, timestamp: new Date().toISOString() }) + '\n');
	const entries: any[] = readFileSync(sessionFile, 'utf8').trim().split('\n').slice(1).map(line => JSON.parse(line));
	let seq = entries.length;
	let registration: any;
	const handlers = new Map<string, Function[]>();
	let model: any = full(toAgyProviderModel(parseAgyCatalogue(inventory).find(m => m.id === 'gemini-3.8-flash')!));
	const sm = { getBranch: () => entries, getEntries: () => entries, getLeafId: () => entries.at(-1)?.id ?? null, getSessionId: () => `pi-${root}`, getSessionFile: () => opts.persist === false ? undefined : join(root, 'pi.jsonl') };
	const ctx: any = { mode: opts.mode ?? 'tui', cwd: opts.cwd ?? root, sessionManager: sm, model, ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } };
	const append = (value: any) => { const entry = { id: `e${++seq}`, parentId: sm.getLeafId(), ...value }; entries.push(entry); appendFileSync(sessionFile, JSON.stringify(entry) + "\n"); return entry; };
	const pi: any = { on: (name: string, fn: Function) => handlers.set(name, [...(handlers.get(name) ?? []), fn]), registerFlag: vi.fn(), registerEntryRenderer: vi.fn(), getFlag: () => opts.policy, appendEntry: (type: string, data: any) => append({ type: 'custom', customType: type, data }), registerProvider: (_id: string, value: any) => registration = value };
	createRbfAgy({ executable: exe, piVersion: opts.piVersion ?? '1.4.0', argv: opts.argv ?? [], seal: opts.seal ?? {}, trace: opts.trace })(pi);
	const emit = async (name: string, event: any = {}) => {
		let out: any;
		for (const fn of handlers.get(name) ?? [])
			out = await fn(event, ctx);
		return out;
	};
	const ready = emit('session_start');
	const h = {
		root, entries, ctx, pi, registration, emit, ready, full,
		logs: () => {
			try {
				return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x));
			}
			catch {
				return [];
			}
		},
		async request(text: string, extra: any = {}) { await ready; const message = { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }; append({ type: 'message', message }); return registration.streamSimple(model, { systemPrompt: 'NEVER FORWARD THIS SYSTEM', messages: [message] }, { reasoning: 'high', ...extra }).result(); },
		async persist(message: any, between?: () => void) { await emit('message_end', { message }); append({ type: 'message', message }); between?.(); await emit('agent_end', { messages: [message] }); },
		async select(m: any) { const previousModel = model; model = m; ctx.model = m; await emit('model_select', { model: m, previousModel }); },
		async close() { await ready; await emit('session_shutdown'); },
	};
	retained.push(h);
	return h;
}
function full(m: any): any { return { ...m, api: AGY_API, provider: AGY_PROVIDER, baseUrl: 'stdio://agy' }; }
const body = (m: any) => m.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
const inputs = (h: ReturnType<typeof harness>) => h.logs().filter(x => x.input);
const conversations = (h: ReturnType<typeof harness>) => h.logs().filter(x => x.args && x.args[0] !== 'models' && x.args[0] !== '--version');
describe('provider task and persisted follow-up', () => {
	it('sends only new text once to one native child and confirms anchor after persistence', async () => {
		const h = harness();
		const first = await h.request('Remember MAPLE-ABC1. First task.');
		expect(first.stopReason).toBe('stop');
		await h.persist(first);
		const second = await h.request('Recall my label.');
		expect(body(second)).toContain('MAPLE-ABC1');
		await h.persist(second);
		expect(inputs(h).map(x => x.input.message.content)).toEqual(['Remember MAPLE-ABC1. First task.', 'Recall my label.']);
		expect(conversations(h)).toHaveLength(1);
		expect(h.entries.filter(e => e.customType === AGY_PROVENANCE)).toHaveLength(1);
		expect(h.entries.find(e => e.customType === AGY_PROVENANCE).data).toEqual({ conversationId: expect.any(String), cwd: h.root, sessionId: expect.any(String) });
		expect(JSON.stringify(inputs(h))).not.toContain('NEVER FORWARD');
		expect(first.content.every((c: any) => c.type === 'text')).toBe(true);
	});
	it('refuses follow-up before persisted assistant confirmation', async () => {
		const h = harness();
		const first = await h.request('First');
		expect(first.stopReason).toBe('stop');
		await h.emit('message_end', { message: first });
		await h.emit('agent_end', { messages: [first] });
		expect(body(await h.request('Second'))).toContain('context has ended');
		expect(inputs(h)).toHaveLength(1);
	});
	it('does not send a changed live model or lose the idle native owner', async () => {
		const h = harness();
		const first = await h.request('First');
		await h.persist(first);
		await h.select(full(toAgyProviderModel(parseAgyCatalogue(inventory).find(m => m.id === 'claude-opus-5-5')!)));
		expect(body(await h.request('Second'))).toContain('settings differ');
		expect(inputs(h)).toHaveLength(1);
		expect(conversations(h)).toHaveLength(1);
	});
	it('refuses a retry of the already attempted user entry', async () => {
		const h = harness();
		const first = await h.request('First');
		await h.persist(first);
		const last = h.entries.find(e => e.message?.role === 'user');
		const result = await h.registration.streamSimple(h.ctx.model, { messages: [last.message] }, { reasoning: 'high' }).result();
		expect(body(result)).toContain('will not resend');
		expect(inputs(h)).toHaveLength(1);
	});
	it('keeps cancelled/no-op tree navigation but ends actual departures', async () => {
		const h = harness();
		const first = await h.request('First');
		await h.persist(first);
		await h.emit('session_tree', { oldLeafId: 'x', newLeafId: 'x' });
		const second = await h.request('Second');
		expect(second.stopReason).toBe('stop');
		await h.persist(second);
		await h.emit('session_tree', { oldLeafId: 'x', newLeafId: 'y' });
		expect(body(await h.request('Third'))).toContain('context has ended');
		expect(inputs(h)).toHaveLength(2);
	});
	it('refuses busy and invalidates the original result when a concurrent call changed the saved branch', async () => {
		const h = harness('slow');
		const pending = h.request('First');
		await vi.waitFor(() => expect(inputs(h)).toHaveLength(1), { timeout: 3000, interval: 10 });
		const busy = await h.request('Second');
		expect(body(busy)).toContain('busy');
		expect((await pending).stopReason).toBe('error');
		expect(inputs(h)).toHaveLength(1);
		expect(h.entries.filter(e => e.customType === 'rbf-agy-completion/v1')).toHaveLength(0);
	});
});
describe('review regressions: branch, anchor and availability', () => {
	it('rejects a changed branch during pending acquisition before binding or input', async () => {
		const h = harness();
		const pending = h.request('Old branch task');
		await vi.waitFor(() => expect(h.logs().some(x => x.args?.[0] === 'models')).toBe(true));
		const old = h.entries.at(-1).id;
		h.entries.splice(0, h.entries.length, { id: 'other-branch', parentId: null, type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Different branch' }], timestamp: 0 } });
		await h.emit('session_tree', { oldLeafId: old, newLeafId: 'other-branch' });
		expect((await pending).stopReason).toBe('error');
		expect(inputs(h)).toHaveLength(0);
		expect(h.entries.filter(e => e.customType === AGY_PROVENANCE)).toHaveLength(0);
	});
	it.each(['content', 'parent'])('refuses an assistant anchor whose %s changed under the same ID', async (kind) => {
		const h = harness();
		const first = await h.request('First');
		await h.persist(first);
		const anchor = h.entries.find(e => e.message?.role === 'assistant');
		if (kind === 'content')
			anchor.message.content[0].text = 'MUTATED';
		else
			anchor.parentId = 'other-parent';
		expect(body(await h.request('Follow-up'))).toContain('history no longer matches');
		expect(inputs(h)).toHaveLength(1);
	});
	it('preserves accepted SUCCESS when cancellation arrives after native terminal commitment', async () => {
		const abort = new AbortController();
		let observed = false;
		const h = harness('normal', {
			trace: (event, payload) => {
				if (event === 'native_result' && payload.accepted && payload.status === 'SUCCESS') {
					observed = true;
					queueMicrotask(() => abort.abort());
				}
			}
		});
		const answer = await h.request('Remember MAPLE-COMMITTED1.', { signal: abort.signal });
		expect(observed).toBe(true);
		expect(answer.stopReason).toBe('stop');
		expect(body(answer)).toContain('Native answer MAPLE-COMMITTED1');
		expect(body(await h.request('Again'))).toContain('context has ended');
		expect(inputs(h)).toHaveLength(1);
	});
	it('rejects a mutated persisted local refusal rather than skipping arbitrary branch messages', async () => {
		const h = harness();
		const first = await h.request('First');
		await h.persist(first);
		const refusal = await h.request('Changed effort', { reasoning: 'medium' });
		await h.persist(refusal);
		[...h.entries].reverse().find(e => e.message?.role === 'assistant').message.content[0].text = 'UNTRUSTED';
		expect(body(await h.request('Original effort'))).toContain('history no longer matches');
		expect(inputs(h)).toHaveLength(1);
	});
	it('ends a newly acquired owner if provenance persistence cannot be verified', async () => {
		const h = harness();
		h.pi.appendEntry = () => { };
		expect(body(await h.request('Task'))).toContain('could not verify session provenance');
		expect(inputs(h)).toHaveLength(0);
		expect(h.logs().some(x => x.eof)).toBe(true);
		expect(body(await h.request('Again'))).toContain('context has ended');
	});
	it('refuses a removed live variant without sending or retiring its idle owner', async () => {
		const h = harness();
		const first = await h.request('First');
		await h.persist(first);
		const exe = join(h.root, 'fake-agy.cjs');
		const removed = inventory.split('\n').filter(x => !x.startsWith('gemini-3.8-flash-high\t')).join('\n');
		const originalWorker = readFileSync(exe, 'utf8');
		expect(originalWorker.split(JSON.stringify(inventory))).toHaveLength(2);
		writeFileSync(exe, originalWorker.replace(JSON.stringify(inventory), JSON.stringify(removed)));
		const refreshed = await h.registration.refreshModels({ allowNetwork: true, publish: async () => { } });
		expect(refreshed.find((m: any) => m.id === 'gemini-3.8-flash').thinkingLevelMap.high).toBeNull();
		const refusal = await h.request('Removed variant');
		expect(body(refusal)).toContain('does not support');
		await h.persist(refusal);
		expect(inputs(h)).toHaveLength(1);
		expect(h.logs().filter(x => x.eof || x.signal)).toHaveLength(0);
		writeFileSync(exe, originalWorker);
		expect((await h.request('Restored variant')).stopReason).toBe('stop');
		expect(inputs(h)).toHaveLength(2);
	});
	it('admits a corrected request after its own persisted zero-dispatch settings refusal', async () => {
		const h = harness();
		const first = await h.request('First');
		await h.persist(first);
		const refusal = await h.request('Changed effort', { reasoning: 'medium' });
		expect(body(refusal)).toContain('settings differ');
		await h.persist(refusal);
		const second = await h.request('Corrected effort');
		expect(second.stopReason).toBe('stop');
		expect(inputs(h)).toHaveLength(2);
		expect(conversations(h)).toHaveLength(1);
	});
});
describe('second review regressions', () => {
	it('keeps a genuinely unused AGY context after an earlier tree departure', async () => {
		const h = harness();
		await h.ready;
		await h.emit('session_tree', { oldLeafId: 'x', newLeafId: 'y' });
		expect((await h.request('First-ever AGY use')).stopReason).toBe('stop');
		expect(inputs(h)).toHaveLength(1);
	});
	it('keeps an idle owner when the identical model is reselected during follow-up metadata', async () => {
		const h = harness('slow-metadata');
		const first = await h.request('First');
		await h.persist(first);
		const pending = h.request('Second');
		await vi.waitFor(() => expect(h.logs().filter(x => x.args?.[0] === 'models')).toHaveLength(2));
		await h.select(h.ctx.model);
		expect((await pending).stopReason).toBe('stop');
		expect(inputs(h)).toHaveLength(2);
	});
	it('recovers original settings after model change cancels only pending live metadata', async () => {
		const h = harness('slow-metadata');
		const first = await h.request('First');
		await h.persist(first);
		const original = h.ctx.model;
		const pending = h.request('Pending metadata');
		await vi.waitFor(() => expect(h.logs().filter(x => x.args?.[0] === 'models')).toHaveLength(2));
		await h.select(full(toAgyProviderModel(parseAgyCatalogue(inventory).find(m => m.id === 'claude-opus-5-5')!)));
		const refusal = await pending;
		expect(refusal.stopReason).toBe('error');
		await h.persist(refusal);
		expect(inputs(h)).toHaveLength(1);
		expect(h.logs().some(x => x.eof)).toBe(false);
		await h.select(original);
		expect((await h.request('Corrected original settings')).stopReason).toBe('stop');
		expect(inputs(h)).toHaveLength(2);
	});
	it('keeps the pending request busy across model changes until metadata settles', async () => {
		const h = harness('slow-metadata');
		const first = await h.request('First');
		await h.persist(first);
		const original = h.ctx.model;
		const pending = h.request('Pending');
		await vi.waitFor(() => expect(h.logs().filter(x => x.args?.[0] === 'models')).toHaveLength(2));
		await h.select(full(toAgyProviderModel(parseAgyCatalogue(inventory).find(m => m.id === 'claude-opus-5-5')!)));
		await h.select(original);
		const latest = h.entries.at(-1).message;
		const duplicate = await h.registration.streamSimple(original, { messages: [latest] }, { reasoning: 'high' }).result();
		expect(body(duplicate)).toContain('busy');
		expect((await pending).stopReason).toBe('error');
		expect(inputs(h)).toHaveLength(1);
		expect(h.logs().some(x => x.signal)).toBe(false);
	});
	it('preserves committed success but labels forced idle close as unverified', async () => {
		const abort = new AbortController();
		const h = harness('ignore-eof', {
			trace: (event, payload) => {
				if (event === 'native_result' && payload.accepted)
					queueMicrotask(() => abort.abort());
			}
		});
		const answer = await h.request('Committed answer', { signal: abort.signal });
		expect(answer.stopReason).toBe('stop');
		expect(body(answer)).toContain('Native answer');
		expect(body(answer)).toContain('stop could not be verified');
	});
	it('rejects provenance append that mutates the admitted branch prefix', async () => {
		const h = harness();
		const append = h.pi.appendEntry;
		h.pi.appendEntry = (...args: any[]) => { h.entries.find(e => e.message?.role === 'user').message.content[0].text = 'MUTATED DURING APPEND'; append(...args); };
		expect((await h.request('Original prompt')).stopReason).toBe('error');
		expect(inputs(h)).toHaveLength(0);
	});
	it('rejects confirmation when the admitted user mutated after input', async () => {
		const h = harness('slow');
		const pending = h.request('First');
		await vi.waitFor(() => expect(inputs(h)).toHaveLength(1));
		h.entries.find(e => e.message?.role === 'user').message.content[0].text = 'MUTATED AFTER INPUT';
		const first = await pending;
		await h.persist(first);
		expect(body(await h.request('Follow-up'))).toContain('context has ended');
		expect(inputs(h)).toHaveLength(1);
	});
});
describe('native result and process truth', () => {
	it('keeps real native ERROR details and separates retirement from task success', async () => {
		const h = harness('error');
		const answer = await h.request('Task');
		expect(answer.stopReason).toBe('error');
		expect(body(answer)).toContain('Native permission refused');
		expect(inputs(h)).toHaveLength(1);
	});
	it('preserves empty SUCCESS and cumulative denial without fabricating an answer', async () => {
		const h = harness('denial');
		const answer = await h.request('Task');
		expect(answer.stopReason).toBe('stop');
		expect(body(answer)).not.toContain('SUCCESS with no answer text');
		expect(body(answer)).toContain('Denied actions (conversation total): EditFile');
		expect(body(answer)).toContain('do not prove an edit');
	});
	it('treats malformed after-input output as unknown and sends no retry', async () => {
		const h = harness('bad');
		const answer = await h.request('Task');
		expect(answer.stopReason).toBe('error');
		expect(body(answer)).toContain('outcome is unknown');
		expect(body(answer)).not.toContain('message was not sent');
		expect(inputs(h)).toHaveLength(1);
	});
	it('blocks a replacement factory while the original retains live resources', async () => {
		const seal: AgyRetirementSeal = {};
		const old = harness('normal', { seal });
		const result = await old.request('First');
		await old.persist(result);
		const next = harness('normal', { seal });
		expect(body(await next.request('Fresh'))).toContain('stop could not be verified');
		expect(conversations(next)).toHaveLength(0);
		expect(seal.owner).toBeDefined();
		await old.close();
		expect(seal.owner).toBeUndefined();
	});
	it('cancels only its owned child and does not continue after cancellation', async () => {
		const h = harness('slow'), abort = new AbortController();
		const pending = h.request('Task', { signal: abort.signal });
		await vi.waitFor(() => expect(inputs(h)).toHaveLength(1), { timeout: 3000, interval: 10 });
		abort.abort();
		const result = await pending;
		expect(result.stopReason).toBe('aborted');
		expect(h.logs().filter(x => x.signal === 'SIGINT')).toHaveLength(1);
		expect(body(await h.request('Again'))).toContain('context has ended');
	});
});
describe('host and metadata admission', () => {
	it.each([{ mode: 'rpc' }, { mode: 'json' }, { mode: 'print' }, { persist: false }, { argv: ['--sandbox'] }, { piVersion: '0.85.1' }])('refuses excluded host %j without native conversation', async (opts) => {
		const h = harness('normal', opts);
		expect((await h.request('Task')).stopReason).toBe('error');
		expect(conversations(h)).toHaveLength(0);
		expect(inputs(h)).toHaveLength(0);
	});
	it('refreshes catalogue with no model selection/task and zero conversation input', async () => {
		const h = harness();
		await h.ready;
		const publish = vi.fn();
		const models = await h.registration.refreshModels({ allowNetwork: true, signal: new AbortController().signal, publish });
		expect(models).toHaveLength(5);
		expect(publish).toHaveBeenCalledOnce();
		expect(conversations(h)).toHaveLength(0);
		expect(inputs(h)).toHaveLength(0);
	});
	it('starts no metadata process during factory creation or startup cache refresh', async () => {
		const h = harness();
		await h.ready;
		expect(h.logs()).toEqual([]);
		const models = await h.registration.refreshModels({ allowNetwork: false, stored: undefined });
		expect(models).toHaveLength(0);
		expect(h.logs()).toEqual([]);
	});
});
describe('native policy and settings file', () => {
	it('forwards only explicit frozen native settings and never mutates the file', () => {
		const root = mkdtempSync(join(roots, 'policy-')), file = join(root, 'policy.json'), raw = '{"enableTerminalSandbox":true,"toolPermission":"proceed-in-sandbox","agentMode":"accept-edits"}';
		writeFileSync(file, raw, { mode: 0o600 });
		const p = readAgyPolicy(file)!;
		expect(agyPolicyArgs()).toEqual([]);
		expect(agyPolicyArgs(p)).toEqual(['--sandbox', '--settings', raw]);
		expect(sameAgyPolicy(p, file)).toBe(true);
		expect(readFileSync(file, 'utf8')).toBe(raw);
		writeFileSync(file, '{}');
		expect(sameAgyPolicy(p, file)).toBe(false);
	});
	it('rejects invalid, non-owned-mode, symlink and nonabsolute policy inputs', () => {
		const root = mkdtempSync(join(roots, 'policy-')), file = join(root, 'bad.json');
		writeFileSync(file, '[]', { mode: 0o600 });
		expect(() => readAgyPolicy(file)).toThrow();
		writeFileSync(file, '{}');
		chmodSync(file, 0o666);
		expect(() => readAgyPolicy(file)).toThrow();
		chmodSync(file, 0o600);
		const link = join(root, 'link');
		symlinkSync(file, link);
		expect(() => readAgyPolicy(link)).toThrow();
		expect(() => readAgyPolicy('relative.json')).toThrow();
	});
});
describe('Pi presentation and usage truth', () => {
	it('preserves age/badge/model while hiding sentinels, token totals and price', () => {
		const result = projectAgyFooter(['path', '◷ 2m | ↑20k ↓1.2k R8k CH40% $0.123 0.0%/1000M (auto)  (agy-harness) gemini-3.8-flash • high', 'sh:2'], 120);
		expect(result[1]).toContain('◷ 2m');
		expect(result[1]).toContain('AGY context: unknown');
		expect(result[1]).toContain('gemini-3.8-flash');
		expect(result[1]).not.toMatch(/1000M|\$|↑20k|CH40/);
		expect(result[2]).toBe('sh:2');
	});
	it('changes only AGY effort token hints, retaining host controls', () => {
		const result = projectAgyThinking(['Thinking Level', 'Shift+Tab cycles thinking levels in-session', 'high Deep reasoning (~16k tokens)', 'Enter to select'], 80).join('\n');
		expect(result).toContain('(AGY tier)');
		expect(result).toContain('selects effort for the next AGY conversation');
		expect(result).not.toContain('16k');
		expect(result).toContain('Enter to select');
	});
});
import { installAgyOfflineGuard, reserveAgyOfflineRoot } from "./test-support/agy-offline-guard.js";
describe("offline harness provider guard", () => {
	it.each(["google", "openai", "codex-harness", undefined])("handles input before a non-fake provider can receive it: %s", async (provider) => {
		const handlers = new Map<string, Function>();
		const record = vi.fn();
		installAgyOfflineGuard({ on: (name: string, fn: Function) => handlers.set(name, fn) } as any, record);
		const result = await handlers.get("input")!({ text: "public fake test prompt" }, { model: { provider, id: "gemini-3.8-flash" }, ui: { notify: vi.fn() } });
		expect(result).toEqual({ action: "handled" });
		expect(record.mock.calls[0][0]).toBe("offline_provider_refused");
	});
	it.each(["agy-harness", "pi21-fake-neighbor"])("permits only explicitly injected fake-provider IDs: %s", async (provider) => {
		const handlers = new Map<string, Function>();
		installAgyOfflineGuard({ on: (name: string, fn: Function) => handlers.set(name, fn) } as any, vi.fn());
		expect(await handlers.get("input")!({ text: "fake" }, { model: { provider, id: "fixture" } })).toEqual({ action: "continue" });
	});
});
describe("offline guard fault containment and exclusive roots", () => {
	it.each(["record", "notify", "both"])("never throws/continues rejected Google input if %s fails", async (fault) => {
		const handlers = new Map<string, Function>();
		const record = () => {
			if (fault !== "notify")
				throw new Error("disk failed");
		};
		installAgyOfflineGuard({ on: (name: string, fn: Function) => handlers.set(name, fn) } as any, record);
		const ctx = {
			model: { provider: "google", id: "gemini-3.8-flash" }, ui: {
				notify() {
					if (fault !== "record")
						throw new Error("UI failed");
				}
			}
		};
		expect(await handlers.get("input")!({}, ctx)).toEqual({ action: "handled" });
	});
	it("refuses even allowed fake input when evidence recording fails", async () => {
		const handlers = new Map<string, Function>();
		installAgyOfflineGuard({ on: (name: string, fn: Function) => handlers.set(name, fn) } as any, () => { throw new Error("disk failed"); });
		expect(await handlers.get("input")!({}, { model: { provider: "agy-harness", id: "fixture" } })).toEqual({ action: "handled" });
	});
	it("refuses invalidated context getters rather than throwing open", async () => {
		const handlers = new Map<string, Function>();
		installAgyOfflineGuard({ on: (name: string, fn: Function) => handlers.set(name, fn) } as any, vi.fn());
		expect(await handlers.get("input")!({}, { get model() { throw new Error("stale"); } })).toEqual({ action: "handled" });
	});
	it("atomically refuses existing profile/evidence roots and symlinks without touching them", () => {
		const root = mkdtempSync(join(roots, "exclusive-")), fresh = join(root, "new"), sentinel = join(root, "auth-sentinel");
		writeFileSync(sentinel, "UNCHANGED");
		reserveAgyOfflineRoot(fresh);
		expect(() => reserveAgyOfflineRoot(fresh)).toThrow();
		expect(() => reserveAgyOfflineRoot(root)).toThrow();
		const link = join(root, "link");
		symlinkSync(fresh, link);
		expect(() => reserveAgyOfflineRoot(link)).toThrow();
		expect(readFileSync(sentinel, "utf8")).toBe("UNCHANGED");
	});
});
import { createOwnedNativeProtocol, parseNdjsonFrame, sanitizeDisplayText, BOUNDS } from './lib/agy-native.js';
function protocolFixture() {
	const failures: string[] = [], boundaries: any[] = [];
	const p = createOwnedNativeProtocol({ model: 'gemini-3.8-flash-high', cwd: '/tmp' }, { onInit() { }, onEvent() { }, onFailure: error => failures.push(error), onBoundary: (value, accepted) => boundaries.push({ value, accepted }) });
	const feed = (x: any) => p.feed(Buffer.from(JSON.stringify(x) + '\n'));
	feed({ event: 'init', conversation_id: 'fake-cid', init: { model: 'gemini-3.8-flash-high', cwd: '/tmp', tools: [], permission_mode: 'default' } });
	const start = () => { p.beginRequest(); p.markWriteAttempt(); };
	const input = (index = 0, id = 'fake-cid') => ({ event: 'step_update', step_update: { conversation_id: id, step_index: index, step_type: 'user_input', state: 'DONE' } });
	const terminal = (count = 1, id = 'fake-cid') => ({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', num_turns: count, duration_seconds: 0, response: 'Maple 🌳', usage: { input_tokens: 2, output_tokens: 3, thinking_tokens: 1, cache_read_tokens: 4, total_tokens: 5 } } });
	return { p, feed, start, input, terminal, failures, boundaries };
}
describe('native protocol attribution and bounds', () => {
	it('accepts split UTF-8/NDJSON and two exact cumulative terminal boundaries once', () => {
		const h = protocolFixture();
		h.start();
		h.feed(h.input());
		const bytes = Buffer.from(JSON.stringify(h.terminal()) + '\n');
		for (const b of bytes)
			h.p.feed(Buffer.from([b]));
		expect(h.boundaries).toHaveLength(1);
		expect(h.boundaries[0].accepted).toBe(true);
		expect(h.boundaries[0].value.response).toBe('Maple 🌳');
		h.start();
		h.feed(h.input(1));
		h.feed(h.terminal(2));
		expect(h.boundaries).toHaveLength(2);
		expect(h.p.snapshot().acceptedCount).toBe(2);
		expect(h.failures).toEqual([]);
	});
	it.each(['wrong-id', 'wrong-count', 'missing-input', 'duplicate-input', 'old-frontier', 'duplicate-terminal', 'unknown-shape'])('rejects %s without an attributable terminal', kind => {
		const h = protocolFixture();
		h.start();
		if (kind === 'wrong-id')
			h.feed(h.input(0, 'other'));
		else if (kind === 'missing-input')
			h.feed(h.terminal());
		else if (kind === 'duplicate-input') {
			h.feed(h.input());
			h.feed(h.input(1));
		}
		else if (kind === 'old-frontier') {
			h.feed(h.input());
			h.feed(h.terminal());
			h.start();
			h.feed(h.input(0));
		}
		else if (kind === 'unknown-shape')
			h.feed({ event: 'error_message', error: 'not an admitted terminal' });
		else if (kind === 'duplicate-terminal') {
			h.feed(h.input());
			h.p.feed(Buffer.from([h.terminal(), h.terminal()].map(x => JSON.stringify(x)).join('\n') + '\n'));
		}
		else {
			h.feed(h.input());
			h.feed(h.terminal(2));
		}
		expect(h.failures).toHaveLength(1);
		expect(() => h.p.beginRequest()).toThrow();
		expect(h.boundaries).toHaveLength(kind === 'old-frontier' ? 1 : 0);
	});
	it.each(['invalid-utf8', 'oversize-frame', 'partial-eof', 'unrequested-result'])('bounds %s before admitting native completion', kind => {
		const h = protocolFixture();
		if (kind === 'invalid-utf8')
			h.p.feed(Buffer.from([0xff, 10]));
		if (kind === 'oversize-frame')
			h.p.feed(Buffer.alloc(BOUNDS.MAX_FRAME_BYTES + 1, 65));
		if (kind === 'partial-eof') {
			h.p.feed(Buffer.from('{'));
			h.p.freeze();
		}
		if (kind === 'unrequested-result')
			h.feed(h.terminal());
		expect(h.failures).toHaveLength(1);
		expect(h.boundaries).toHaveLength(0);
	});
	it('rejects unsafe numeric result metadata and removes terminal/bidi controls from display', () => {
		const h = protocolFixture(), raw = h.terminal();
		raw.result.usage.input_tokens = -1;
		expect(parseNdjsonFrame(JSON.stringify(raw))).toBeNull();
		expect(sanitizeDisplayText('before\x1b[2J\x9b31m\u202eafter')).not.toMatch(/[\x1b\x9b\u202e]/);
	});
});
const accounting = (h: ReturnType<typeof harness>) => h.ctx.ui.setWidget.mock.calls.filter((call: any[]) => call[0] === 'rbf-agy-accounting' && call[1] !== undefined).map((call: any[]) => call[1]);
describe('removed AGY accounting notices', () => {
	it('publishes no notice before, during or after task persistence', async () => {
		const h = harness('slow');
		const pending = h.request('First');
		await vi.waitFor(() => expect(inputs(h)).toHaveLength(1));
		expect(accounting(h)).toEqual([]);
		const answer = await pending;
		await h.persist(answer);
		expect(accounting(h)).toEqual([]);
	});
	it('keeps notices absent on provider departure and tree movement', async () => {
		const h = harness();
		const answer = await h.request('First');
		await h.persist(answer);
		await h.select({ ...h.ctx.model, provider: 'pi21-fake-neighbor' });
		await h.emit('session_tree', { oldLeafId: 'a', newLeafId: 'b' });
		expect(accounting(h)).toEqual([]);
	});
	it('clears the legacy notice on reopen even when history contains AGY', async () => {
		const h = harness();
		await h.ready;
		h.ctx.sessionManager.getEntries = () => [{ type: 'message', id: 'past', message: { role: 'assistant', provider: AGY_PROVIDER, api: AGY_API, content: [] } }];
		expect(h.ctx.sessionManager.getBranch()).toEqual([]);
		await h.emit('session_start');
		expect(accounting(h)).toEqual([]);
	});
	it('keeps notices absent for malformed-result history', async () => {
		const h = harness('bad');
		const error = await h.request('Task');
		await h.persist(error);
		expect(error.stopReason).toBe('error');
		expect(accounting(h)).toEqual([]);
	});
	it('clears for a clean new session without clearing unrelated widget keys', async () => {
		const h = harness();
		const answer = await h.request('First');
		await h.persist(answer);
		expect(accounting(h)).toEqual([]);
		h.entries.splice(0);
		h.ctx.sessionManager.getSessionId = () => h.root + '-new';
		await h.emit('session_start');
		expect(accounting(h)).toEqual([]);
		expect(h.ctx.ui.setWidget).toHaveBeenCalledWith('rbf-agy-accounting', undefined);
		expect(h.ctx.ui.setWidget.mock.calls.every((call: any[]) => ['rbf-agy-accounting', 'rbf-agy-activity', 'rbf-agy-stop', 'rbf-agy-preview'].includes(call[0]))).toBe(true);
	});
});
const stopWidget = (h: ReturnType<typeof harness>) => h.ctx.ui.setWidget.mock.calls.filter((call: any[]) => call[0] === 'rbf-agy-stop').at(-1)?.[1];
describe('idle stop advisory lifetime', () => {
	it('shows verified idle retirement before new work without changing resource proof', async () => {
		const h = harness(), first = await h.request('First');
		await h.persist(first);
		expect(await h.emit('session_before_switch')).toEqual({});
		expect(stopWidget(h)).toEqual([AGY_COPY.stopped]);
		expect(h.logs().filter(x => x.eof)).toHaveLength(1);
	});
	it('retains an earlier unverified stop across a new factory without becoming an admission block', async () => {
		const seal: AgyRetirementSeal = {};
		const old = harness('ignore-eof', { seal });
		const first = await old.request('First');
		await old.persist(first);
		await old.emit('session_before_switch');
		expect(seal.owner).toBeUndefined();
		expect(stopWidget(old)).toEqual(['Earlier AGY work', AGY_COPY.stopUnknown]);
		const next = harness('normal', { seal });
		await next.ready;
		expect(stopWidget(next)).toEqual(['Earlier AGY work', AGY_COPY.stopUnknown]);
		expect((await next.request('Fresh work')).stopReason).toBe('stop');
		expect(inputs(next)).toHaveLength(1);
		expect(stopWidget(next)).toEqual(['Earlier AGY work', AGY_COPY.stopUnknown]);
		await next.close();
		expect((seal as any).stopNotice).toBe('unverified');
	});
	it('clears a positive advisory on acquisition and ignores duplicate older close disclosure', async () => {
		const seal: AgyRetirementSeal = {};
		const old = harness('normal', { seal });
		const first = await old.request('First');
		await old.persist(first);
		await old.emit('session_before_switch');
		expect((seal as any).stopNotice).toBe('stopped');
		const next = harness('slow', { seal });
		const pending = next.request('New running work');
		await vi.waitFor(() => expect(inputs(next)).toHaveLength(1), { timeout: 3000, interval: 10 });
		expect(stopWidget(next)).toBeUndefined();
		await old.emit('session_shutdown');
		expect((seal as any).stopNotice).toBeUndefined();
		expect((await pending).stopReason).toBe('stop');
		expect(inputs(next)).toHaveLength(1);
	});
});
describe('metadata and initial policy refusal controls', () => {
	it('starts from a working folder reached through a symlink', async () => {
		const root = mkdtempSync(join(roots!, 'case-')), link = root + '-link', savedPwd = process.env.PWD;
		symlinkSync(root, link);
		process.env.PWD = link;
		try {
			const h = harness('normal', { root, cwd: link });
			const answer = await h.request('Reach AGY through a symlinked folder.');
			expect(answer.stopReason).toBe('stop');
			expect(JSON.stringify(answer)).not.toContain(AGY_COPY.startup);
			expect(inputs(h)).toHaveLength(1);
		}
		finally {
			if (savedPwd === undefined) delete process.env.PWD; else process.env.PWD = savedPwd;
		}
	});
	it.each(['catalogue-empty', 'catalogue-bad', 'old-version', 'wrong-init-model', 'wrong-init-cwd'])('refuses %s before provenance or task input', async (mode) => {
		const h = harness(mode);
		const answer = await h.request('Must not dispatch');
		expect(answer.stopReason).toBe('error');
		expect(inputs(h)).toHaveLength(0);
		expect(h.entries.filter(e => e.customType === AGY_PROVENANCE)).toHaveLength(0);
		if (mode.startsWith('catalogue') || mode === 'old-version')
			expect(conversations(h)).toHaveLength(0);
	});
	it('cancels metadata before spawn and while its owned read-only worker is pending', async () => {
		const h = harness('slow-metadata');
		await h.ready;
		const before = new AbortController();
		before.abort();
		await expect(readAgyCatalogue(join(h.root, 'fake-agy.cjs'), before.signal)).rejects.toThrow(/cancelled/);
		expect(h.logs()).toEqual([]);
		const during = new AbortController();
		const pending = readAgyCatalogue(join(h.root, 'fake-agy.cjs'), during.signal);
		const observed = expect(pending).rejects.toThrow(/cancelled/);
		await vi.waitFor(() => expect(h.logs().filter(x => x.args?.[0] === 'models')).toHaveLength(1));
		during.abort();
		await observed;
		expect(conversations(h)).toHaveLength(0);
		expect(inputs(h)).toHaveLength(0);
	});
	it('loads exact cached capabilities without starting native metadata or conversations', async () => {
		const h = harness();
		await h.ready;
		const stored = parseAgyCatalogue(inventory).map(m => full(toAgyProviderModel(m)));
		const rows = await h.registration.refreshModels({ allowNetwork: false, stored: { models: stored } });
		expect(rows.map((m: any) => m.id)).toEqual(stored.map(m => m.id));
		expect(h.logs()).toEqual([]);
	});
	it('rejects over-byte and over-row catalogue bounds without inference', () => {
		expect(() => parseAgyCatalogue('x'.repeat(256 * 1024 + 1))).toThrow(/too large/);
		expect(() => parseAgyCatalogue(Array.from({ length: 513 }, (_, i) => `m${i}\tModel ${i}`).join('\n'))).toThrow(/too large/);
	});
	it.each(['missing', 'relative', 'invalid'])('initial %s policy cannot start native metadata or a conversation', async (kind) => {
		const root = mkdtempSync(join(roots, 'initial-policy-'));
		const file = join(root, 'policy.json');
		if (kind === 'invalid')
			writeFileSync(file, '[]', { mode: 0o600 });
		const h = harness('normal', { policy: kind === 'relative' ? 'relative.json' : file });
		expect((await h.request('No dispatch')).stopReason).toBe('error');
		expect(h.logs()).toEqual([]);
	});
});
describe('selected-provider summary and compaction isolation', () => {
	it('blocks summary generation on AGY before any native owner exists', async () => {
		const h = harness();
		await h.ready;
		const result = await h.emit('session_before_tree', { preparation: { userWantsSummary: true } });
		expect(result?.summary?.summary).toContain('AGY branch summaries are unavailable');
		expect(h.logs()).toEqual([]);
	});
	it('restores neighboring provider compaction after AGY departure', async () => {
		const h = harness();
		const first = await h.request('First');
		await h.persist(first);
		await h.select({ ...h.ctx.model, provider: 'pi21-fake-neighbor' });
		expect(await h.emit('session_before_compact')).toEqual({});
		expect(inputs(h)).toHaveLength(1);
	});
	it('restores neighboring provider branch summaries after AGY departure', async () => {
		const h = harness();
		const first = await h.request('First');
		await h.persist(first);
		await h.select({ ...h.ctx.model, provider: 'pi21-fake-neighbor' });
		expect(await h.emit('session_before_tree', { preparation: { userWantsSummary: true } })).toEqual({});
		expect(inputs(h)).toHaveLength(1);
	});
});
describe('startup cancellation owns its acquired child', () => {
	it('closes an acquired child on cancellation without waiting for delayed native init', async () => {
		const seal: AgyRetirementSeal = {}, h = harness('slow-init', { seal }), abort = new AbortController();
		const pending = h.request('Must not send', { signal: abort.signal });
		await vi.waitFor(() => expect(h.logs().some(x => x.workerReady)).toBe(true));
		expect(conversations(h)).toHaveLength(1);
		abort.abort();
		await vi.waitFor(() => expect(h.logs().filter(x => x.eof)).toHaveLength(1), { timeout: 3000, interval: 10 });
  expect(h.logs().filter(x=>x.signal)).toHaveLength(0);
		expect((await pending).stopReason).toBe('aborted');
		expect(h.logs().filter(x => x.init)).toHaveLength(0);
		expect(inputs(h)).toHaveLength(0);
		expect(h.entries.filter(e => e.customType === AGY_PROVENANCE)).toHaveLength(0);
		expect(seal.owner).toBeUndefined();
	});
});

describe('cancellation progress projection',()=>{
 it('reports the stop outcome without a transient footer label',async()=>{
  const h=harness('slow'),abort=new AbortController();const pending=h.request('Task',{signal:abort.signal});await vi.waitFor(()=>expect(inputs(h)).toHaveLength(1));abort.abort();
  const result = await pending;
  expect(result.stopReason).toBe('aborted');
  expect(body(result)).toMatch(/AGY (stopped|stop could not be verified)/);
  expect(h.ctx.ui.setStatus).not.toHaveBeenCalled();
  expect(inputs(h)).toHaveLength(1);
 });
});


describe('bounded startup and inherited-pipe fault controls',()=>{
 it('refuses a login-required startup without forwarding credential-like stderr',async()=>{
  const h=harness('login-error');const answer=await h.request('Must not send');expect(answer.stopReason).toBe('error');expect(body(answer)).toContain('could not start');expect(body(answer)).not.toContain('FAKE_CREDENTIAL');expect(inputs(h)).toHaveLength(0);expect(h.entries.filter(e=>e.customType===AGY_PROVENANCE)).toHaveLength(0);
 });
 it('rejects an unreadable owner policy before any native process',async()=>{
  const root=mkdtempSync(join(roots,'unreadable-policy-')),file=join(root,'policy.json');writeFileSync(file,'{}',{mode:0o000});
  try {const h=harness('normal',{policy:file});expect((await h.request('Must not send')).stopReason).toBe('error');expect(h.logs()).toEqual([]);}finally{chmodSync(file,0o600);}
 });
 it('retires only owned resources when an unsignalled descendant still holds its pipes',async()=>{
  const seal:AgyRetirementSeal={},h=harness('held-pipe',{seal});const first=await h.request('First');await h.persist(first);await h.emit('session_before_switch');
  expect(seal.owner).toBeUndefined();expect(h.logs().some(x=>x.desc_start)).toBe(true);expect(h.logs().some(x=>x.desc_exit!==undefined)).toBe(false);expect(stopWidget(h)).toEqual([AGY_COPY.stopped]);
  writeFileSync(join(h.root,'release-holder'),'release',{flag:'wx',mode:0o600});await vi.waitFor(()=>expect(h.logs().some(x=>x.desc_exit===0)).toBe(true),{timeout:2000,interval:10});expect(h.logs().filter(x=>x.desc_signal)).toHaveLength(0);expect(inputs(h)).toHaveLength(1);
 });
 it.each(['manual','threshold','overflow'])('refuses %s compaction in the selected AGY scope before any input',async reason=>{
  const h=harness();await h.ready;expect(await h.emit('session_before_compact',{reason})).toEqual({cancel:true});expect(h.logs()).toEqual([]);
 });
});


describe('placeholder-free catalogue', () => {
	it('registers an empty catalogue without a startup work-model substitution', async () => {
		const h = harness(); await h.ready;
		expect(h.registration.models).toEqual([]);
		expect(h.logs()).toEqual([]);
	});
	it('discovers only real native models with no task input', async () => {
		const h = harness(); await h.ready;
		const rows = await h.registration.refreshModels({ allowNetwork: true, publish: async () => {} });
		expect(rows.map((m: any) => m.id)).toEqual([...families, 'gpt-oss-120b-medium']);
		expect(conversations(h)).toHaveLength(0);
		expect(inputs(h)).toHaveLength(0);
	});
	it('drops the retired placeholder from a restored cache while preserving real rows', async () => {
		const h = harness(); await h.ready;
		const real = full(toAgyProviderModel(parseAgyCatalogue(inventory)[0]));
		const retired = full(toAgyProviderModel({ id: 'agy-select-model', name: 'AGY — select a model', variants: {}, fixed: 'agy-select-model' }));
		const rows = await h.registration.refreshModels({ allowNetwork: false, stored: { models: [retired, real] } });
		expect(rows.map((m: any) => m.id)).toEqual([real.id]);
		expect(h.logs()).toEqual([]);
	});
});

import { AGY_COMPLETION, AGY_DISPATCH, AGY_REFUSAL, RECOVERY_COPY } from "./lib/agy-recovery.js";
describe("clean completed turn recovery across fresh factories", () => {
	it("reopens exact native identity twice with cumulative count/frontier and only new text", async () => {
		const seal: AgyRetirementSeal = {}, first = harness("normal", { seal });
		await first.persist(await first.request("Remember MAPLE-RECOVER1."));
		const original = first.entries.find(e => e.customType === AGY_PROVENANCE).data.conversationId;
		await first.close();
		const reloaded = harness("normal", { root: first.root, seal });
		const answer = await reloaded.request("Recall my label after reload.");
		expect(answer.stopReason).toBe("stop"); expect(body(answer)).toContain("MAPLE-RECOVER1");
		await reloaded.persist(answer); await reloaded.close();
		const restarted = harness("normal", { root: first.root, seal: {} });
		const third = await restarted.request("Recall after process restart.");
		expect(third.stopReason).toBe("stop"); await restarted.persist(third);
		expect(inputs(restarted).map(x => x.input.message.content)).toEqual(["Remember MAPLE-RECOVER1.", "Recall my label after reload.", "Recall after process restart."]);
		expect(conversations(restarted).slice(1).map(x => x.args[x.args.indexOf("--conversation") + 1])).toEqual([original, original]);
		expect(restarted.entries.filter(e => e.customType === AGY_COMPLETION).map(e => [e.data.acceptedCount, e.data.frontier])).toEqual([[1, 0], [2, 1], [3, 2]]);
	}, 30000);
	it.each(["wrong-resume-id", "wrong-resume-mode"])("refuses %s init before any new native input", async mode => {
		const first = harness(); await first.persist(await first.request("First")); await first.close();
		const next = harness(mode, { root: first.root });
		expect(body(await next.request("Second"))).toBe(RECOVERY_COPY.unavailable);
		expect(inputs(next)).toHaveLength(1);
	});
	it("certifies a restored zero-write settings refusal and admits a corrected request after another reopen", async () => {
		const first = harness(); await first.persist(await first.request("First")); await first.close();
		const second = harness("normal", { root: first.root });
		const refusal = await second.request("Wrong effort", { reasoning: "medium" }); await second.persist(refusal); await second.close();
		expect(second.entries.filter(e => e.customType === AGY_REFUSAL)).toHaveLength(1);
		const third = harness("normal", { root: first.root });
		expect((await third.request("Correct effort")).stopReason).toBe("stop");
		expect(inputs(third).map(x => x.input.message.content)).toEqual(["First", "Correct effort"]);
	});
	it("does not recover a native SUCCESS whose Pi assistant was never saved", async () => {
		const first = harness(); expect((await first.request("First")).stopReason).toBe("stop"); await first.close();
		const next = harness("normal", { root: first.root });
		expect(body(await next.request("Second"))).toBe(RECOVERY_COPY.unknown); expect(inputs(next)).toHaveLength(1);
	});
	it.each([false, true])("closes current admission after completion append throws; surviving complete bytes=%s", async survived => {
		const first = harness(), append = first.pi.appendEntry;
		first.pi.appendEntry = (type: string, data: any) => { if (type !== AGY_COMPLETION || survived) append(type, data); if (type === AGY_COMPLETION) throw new Error("simulated acknowledgement failure"); };
		const answer = await first.request("Remember MAPLE-ACK1."); await first.persist(answer);
		expect(first.ctx.ui.notify).toHaveBeenCalledWith(RECOVERY_COPY.checkpoint, "warning");
		expect(body(await first.registration.streamSimple(first.ctx.model, { messages: [] }, { reasoning: "high" }).result())).toContain("context has ended");
		await first.close(); const next = harness("normal", { root: first.root });
		const resumed = await next.request("Second");
		expect(resumed.stopReason).toBe(survived ? "stop" : "error");
		expect(inputs(next)).toHaveLength(survived ? 2 : 1);
	});
	it("requires the dispatch intent to reach disk before native stdin", async () => {
		const h = harness(), append = h.pi.appendEntry;
		h.pi.appendEntry = (type: string, data: any) => { if (type !== AGY_DISPATCH) return append(type, data); h.entries.push({ id: "memory-only-intent", parentId: h.ctx.sessionManager.getLeafId(), type: "custom", customType: type, data }); };
		expect((await h.request("Must never reach native")).stopReason).toBe("error"); expect(inputs(h)).toHaveLength(0);
	});
});

describe("outstanding admission invalidation", () => {
	it.each(["model", "effort", "policy"])("does not publish a completion after running %s changes", async kind => {
		const path = join(roots!, `policy-${Date.now()}-${kind}.json`); writeFileSync(path, "{}");
		const h = harness("slow", { policy: path }), pending = h.request("First");
		await vi.waitFor(() => expect(inputs(h)).toHaveLength(1));
		if (kind === "model") await h.select(full(toAgyProviderModel(parseAgyCatalogue(inventory).find(m => m.id === "claude-opus-5-5")!)));
		else if (kind === "effort") await h.emit("thinking_level_select", { level: "medium", previousLevel: "high" });
		else writeFileSync(path, '{"enableTerminalSandbox":false}');
		const answer = await pending; expect(answer.stopReason).toBe("error"); await h.persist(answer);
		expect(h.entries.filter(e => e.customType === AGY_COMPLETION)).toHaveLength(0);
		expect(inputs(h)).toHaveLength(1); expect(body(answer)).not.toContain("message was not sent");
	});
});

describe("restored refusal and crash gap boundaries", () => {
	it.each(["catalogue-bad", "old-version", "wrong-resume-id"])("certifies zero-write %s and permits only a later new request", async mode => {
		const first = harness(); await first.persist(await first.request("First")); await first.close();
		const second = harness(mode, { root: first.root }); const error = await second.request("Never-sent.");
		expect(body(error)).toBe(RECOVERY_COPY.unavailable); await second.persist(error); await second.close();
		expect(inputs(second)).toHaveLength(1); expect(second.entries.filter(e => e.customType === AGY_REFUSAL)).toHaveLength(1);
		const next = harness("normal", { root: first.root }); expect((await next.request("Only-new.")).stopReason).toBe("stop");
		expect(inputs(next).map(x => x.input.message.content)).toEqual(["First", "Only-new."]);
	});
	it("certifies cancellation during restored metadata without replay on later reopen", async () => {
		const first = harness(); await first.persist(await first.request("First")); await first.close();
		const next = harness("slow-metadata", { root: first.root }), abort = new AbortController();
		const before = next.logs().filter(x => x.args?.[0] === "models").length;
		const pending = next.request("Never-sent.", { signal: abort.signal });
		await vi.waitFor(() => expect(next.logs().filter(x => x.args?.[0] === "models").length).toBeGreaterThan(before)); abort.abort();
		const error = await pending; expect(body(error)).toBe(RECOVERY_COPY.cancelled); await next.persist(error); await next.close();
		const restored = harness("normal", { root: first.root }); expect((await restored.request("Only-new.")).stopReason).toBe("stop");
		expect(inputs(restored).map(x => x.input.message.content)).toEqual(["First", "Only-new."]);
	});
	it("does not upgrade legacy provenance to a recovery checkpoint", async () => {
		const h = harness(); h.pi.appendEntry(AGY_PROVENANCE, { conversationId: "legacy-id", cwd: h.root, sessionId: h.ctx.sessionManager.getSessionId() });
		expect(body(await h.request("Do not send"))).toBe(RECOVERY_COPY.missing); expect(inputs(h)).toHaveLength(0); expect(conversations(h)).toHaveLength(0);
	});
	it("refuses a saved intent whose append acknowledgement failed before native write", async () => {
		const h = harness(), append = h.pi.appendEntry;
		h.pi.appendEntry = (type: string, data: any) => { append(type, data); if (type === AGY_DISPATCH) throw new Error("lost intent acknowledgement"); };
		expect((await h.request("Possibly dispatched intent")).stopReason).toBe("error"); expect(inputs(h)).toHaveLength(0); await h.close();
		const next = harness("normal", { root: h.root }); expect(body(await next.request("New request"))).toBe(RECOVERY_COPY.unknown); expect(inputs(next)).toHaveLength(0);
	});
	it("refuses malformed post-write outcome after a fresh factory", async () => {
		const first = harness("bad"); await first.persist(await first.request("First")); await first.close();
		const next = harness("normal", { root: first.root }); expect(body(await next.request("Never retry uncertain work"))).toBe(RECOVERY_COPY.unknown); expect(inputs(next)).toHaveLength(1);
	});
});

describe("captured recovery scope", () => {
	it("refuses a same-ID session-file replacement while metadata awaits", async () => {
		const h = harness("slow-metadata"), pending = h.request("Do not send");
		await vi.waitFor(() => expect(h.logs().some(x => x.args?.[0] === "models")).toBe(true));
		const copy = join(h.root, "copy.jsonl"); writeFileSync(copy, readFileSync(h.ctx.sessionManager.getSessionFile())); h.ctx.sessionManager.getSessionFile = () => copy;
		expect((await pending).stopReason).toBe("error"); expect(inputs(h)).toHaveLength(0); expect(conversations(h)).toHaveLength(0);
	});
});


import { AGY_ACTIVITY, AGY_HISTORY_FAILURE, renderAgyActivity } from './lib/agy-history.js';
const reports = (h: ReturnType<typeof harness>) => h.entries.filter(e => e.customType === AGY_ACTIVITY);
describe('durable AGY observations through the real provider', () => {
 it('saves separate root reports before the assistant and permits exactly the unchanged contextual follow-up', async () => {
  const h=harness('history'); const first=await h.request('Inspect one command');
  expect(first.stopReason).toBe('stop'); expect(reports(h).map(e=>e.data.state)).toEqual(['ACTIVE','DONE']);
  expect(reports(h)[0].data).toMatchObject({schemaVersion:1,piSessionId:h.ctx.sessionManager.getSessionId(),inputEntryId:h.entries[0].id,turnCount:1,stepIndex:4,sequence:1,source:{kind:'root'}});
  expect(reports(h)[1].data.command.text).toBe('printf hello'); expect(reports(h)[1].data.output.text).toBe('hello');
  expect(body(first)).not.toContain('printf hello'); expect(body(first)).not.toContain('hello'); expect(first.content.every((c:any)=>c.type==='text')).toBe(true);
  await h.persist(first); expect(h.entries.at(-2)?.message).toBe(first);
  const second=await h.request('Follow up'); expect(second.stopReason).toBe('stop'); await h.persist(second);
  expect(inputs(h)).toHaveLength(2); expect(reports(h).map(e=>e.data.turnCount)).toEqual([1,1,2,2]);
 });
 it('recovers a completed turn with saved activity after a fresh factory', async () => {
  const first = harness('history');
  const answer = await first.request('Remember MAPLE-HISTORY1.');
  expect(answer.stopReason).toBe('stop');
  expect(reports(first)).toHaveLength(2);
  await first.persist(answer);
  await first.close();
  const next = harness('history', { root: first.root });
  const resumed = await next.request('Recall the label.');
  expect(resumed.stopReason).toBe('stop');
  expect(body(resumed)).toContain('MAPLE-HISTORY1');
  await next.persist(resumed);
  expect(reports(next).map(e => e.data.turnCount)).toEqual([1, 1, 2, 2]);
 });
	it('allows a follow-up after another extension appends a custom entry between turns', async () => {
		const h = harness('history');
		const first = await h.request('Remember MAPLE-MONITOR1.');
		expect(first.stopReason).toBe('stop');
		await h.persist(first);
		h.pi.appendEntry('rbf-monitor', { note: 'watch ended' });
		const second = await h.request('Recall the label.');
		expect(second.stopReason).toBe('stop');
		expect(body(second)).toContain('MAPLE-MONITOR1');
		await h.persist(second);
		expect(inputs(h)).toHaveLength(2);
	});
	it.each(['rbf-agy-unknown/v1', 'custom_message'])('still refuses follow-up after non-foreign custom entry between turns: %s', async kind => {
		const h = harness('history');
		await h.persist(await h.request('First'));
		if (kind === 'custom_message') {
			const entry = { id: `e${h.entries.length + 1}`, parentId: h.entries.at(-1)?.id ?? null, type: 'custom_message', message: { role: 'user', content: 'custom' } };
			h.entries.push(entry);
			appendFileSync(join(h.root, 'pi.jsonl'), JSON.stringify(entry) + '\n');
		} else {
			h.pi.appendEntry(kind, { note: 'unknown agy' });
		}
		expect(body(await h.request('Second'))).toBe(RECOVERY_COPY.mismatch);
		expect(inputs(h)).toHaveLength(1);
	});
	it('allows a foreign custom entry after the stream ends and before the answer is saved', async () => {
		const h = harness('history');
		const first = await h.request('First');
		expect(first.stopReason).toBe('stop');
		h.pi.appendEntry('rbf-monitor', { note: 'mid-turn between dispatch and completion' });
		await h.persist(first);
		const second = await h.request('Second');
		expect(second.stopReason).toBe('stop');
		await h.persist(second);
		expect(inputs(h)).toHaveLength(2);
	});
	it('allows foreign custom entry mid-turn while the turn streams', async () => {
		const h = harness('history-gate');
		const pending = h.request('First');
		await vi.waitFor(() => expect(reports(h)).toHaveLength(1), { timeout: 3000, interval: 10 });
		h.pi.appendEntry('rbf-monitor', { note: 'watch ended' });
		writeFileSync(join(h.root, 'release-history'), 'release', { flag: 'wx', mode: 0o600 });
		const first = await pending;
		expect(first.stopReason).toBe('stop');
		expect(body(first)).toContain('Native answer');
		await h.persist(first);
		const dispatchIndex = h.entries.findIndex(e => e.customType === AGY_DISPATCH);
		const monitorIndex = h.entries.findIndex(e => e.customType === 'rbf-monitor');
		const assistantIndex = h.entries.findIndex(e => e.message?.role === 'assistant');
		const completionIndex = h.entries.findIndex(e => e.customType === AGY_COMPLETION);
		expect(monitorIndex).toBeGreaterThan(dispatchIndex);
		expect(monitorIndex).toBeLessThan(assistantIndex);
		expect(completionIndex).toBeGreaterThan(assistantIndex);
		const second = await h.request('Second');
		expect(second.stopReason).toBe('stop');
		expect(body(second)).toContain('Native answer');
		await h.persist(second);
		expect(inputs(h)).toHaveLength(2);
	});
	it('anchors completion when foreign custom entry appears after the answer before agent_end', async () => {
		const h = harness('history');
		const first = await h.request('First');
		expect(first.stopReason).toBe('stop');
		await h.persist(first, () => {
			h.pi.appendEntry('rbf-monitor', { note: 'after answer before agent_end' });
		});
		const second = await h.request('Second');
		expect(second.stopReason).toBe('stop');
		await h.persist(second);
		expect(inputs(h)).toHaveLength(2);
	});
	it('refuses a follow-up after changed prefix even though all assistant messages still match', async () => {
		const h = harness('history');
		await h.persist(await h.request('First'));
		h.entries[0].message.content[0].text = 'changed';
		expect(body(await h.request('Second'))).toBe(RECOVERY_COPY.mismatch);
		expect(inputs(h)).toHaveLength(1);
	});
 it.each(['throw','throw after append','extra entry','prefix mutation'])('retires without retry on activity storage fault: %s', async fault=>{
  const h=harness('history'),append=h.pi.appendEntry;
  h.pi.appendEntry=(type:string,data:any)=>{if(type!==AGY_ACTIVITY)return append(type,data);if(fault==='throw')throw Error('disk');append(type,data);if(fault==='throw after append')throw Error('disk after memory');if(fault==='extra entry')append('foreign',{});if(fault==='prefix mutation')h.entries[0].message.content[0].text='changed';};
  const result=await h.request('First');expect(result.stopReason).toBe('error');expect(body(result)).toContain(AGY_HISTORY_FAILURE);expect(body(result)).toContain("The task may already have run. Do not retry automatically.");expect(inputs(h)).toHaveLength(1);
  expect(body(await h.request('No retry'))).toContain('context has ended');expect(inputs(h)).toHaveLength(1);
 });
 it('writes no observation to a replacement branch',async()=>{
  const h=harness('history'),append=h.pi.appendEntry;
  h.pi.appendEntry=(type:string,data:any)=>{if(type!==AGY_ACTIVITY)return append(type,data);h.entries.splice(0,h.entries.length,{id:'destination',parentId:null,type:'message',message:{role:'user',content:'other branch'}});};
  expect(body(await h.request('Original'))).toContain(AGY_HISTORY_FAILURE);expect(reports(h)).toHaveLength(0);expect(inputs(h)).toHaveLength(1);
 });
 it('never records wrong native conversation events',async()=>{const h=harness('history-wrong');expect((await h.request('Task')).stopReason).toBe('error');expect(reports(h)).toHaveLength(0);expect(inputs(h)).toHaveLength(1);});
 it('stops visibly at the observation-count bound and preserves the accepted reports',async()=>{
  const h=harness('history-many');const result=await h.request('Many reports');expect(body(result)).toContain(AGY_HISTORY_FAILURE);expect(reports(h)).toHaveLength(256);expect(reports(h).every(e=>e.data.state==='ACTIVE')).toBe(true);expect(inputs(h)).toHaveLength(1);
 });
 it.each(['history-error','history-missing'])('keeps native errors and absent details honest: %s',async mode=>{
  const h=harness(mode);await h.request('Task');const data=reports(h).at(-1).data;
  if(mode==='history-error')expect(data.error).toMatchObject({type:{text:'CommandError'},message:{text:'permission denied'}});else{expect(data.command).toBeUndefined();expect(data.output).toBeUndefined();}
 });
 it('keeps an interrupted ACTIVE report historical, with no synthetic completion',async()=>{
  const h=harness('history-hold'),controller=new AbortController(),pending=h.request('Task',{signal:controller.signal});
  await vi.waitFor(()=>expect(reports(h)).toHaveLength(1),{timeout:3000,interval:10});controller.abort();expect((await pending).stopReason).toBe('aborted');expect(reports(h).map(e=>e.data.state)).toEqual(['ACTIVE']);expect(inputs(h)).toHaveLength(1);
 });
 it('registers historical rendering independently of selected model and never creates records without observations',async()=>{
  const h=harness();await h.request('No tools');expect(h.pi.registerEntryRenderer).toHaveBeenCalledWith(AGY_ACTIVITY,expect.any(Function));expect(h.pi.registerEntryRenderer).toHaveBeenCalledWith("rbf-agy-activity/v2",expect.any(Function));expect(reports(h)).toHaveLength(0);
 });
});
