import { describe, expect, it } from "vitest";
import { parseAgyCatalogue, resolveAgySelection, toAgyProviderModel } from "./rbf-agy.js";
const families = ["gemini-4-argon", "gemini-3.8-flash", "gemini-4-neon", "gemini-4-hydrogen"];
// What Pi's model list holds once only Gemini rows are kept (Decisions 2026-11-22): four families and one single Orchestrator.
const inventory = [...families.flatMap(id => ["low", "medium", "high"].map(level => `${id}-${level}\t${id} (${level})`)), "gemini-pro-orchestrator-neon\tOrchestrator (Neon)"].join("\n");
// What the fake `agy models` prints: the same, plus the rows Pi must drop.
const served = [inventory, ...["claude-opus-5-5", "claude-sonnet-5-5"].flatMap(id => ["low", "medium", "high"].map(level => `${id}-${level}\t${id} (${level})`)), "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)"].join("\n");
describe("family effort resolution", () => {
	it("makes all 13 published variants reachable through five Pi models", () => {
		const models = parseAgyCatalogue(inventory);
		expect(models).toHaveLength(5);
		for (const id of families)
			for (const level of ["low", "medium", "high"]) {
				expect(resolveAgySelection(toAgyProviderModel(models.find(m => m.id === id)!), level)).toEqual({ nativeModel: `${id}-${level}`, nativeEffort: level });
			}
		const fixed = toAgyProviderModel(models.find(m => m.id === "gemini-pro-orchestrator-neon")!);
		expect(fixed.reasoning).toBe(false);
		expect(resolveAgySelection(fixed, undefined)).toEqual({ nativeModel: "gemini-pro-orchestrator-neon" });
	});
	it("explicitly hides unsupported levels rather than substituting a native default", () => {
		const m = toAgyProviderModel(parseAgyCatalogue(inventory)[0]);
		expect(m.thinkingLevelMap).toEqual({ off: null, minimal: null, low: `${m.id}-low`, medium: `${m.id}-medium`, high: `${m.id}-high`, xhigh: null, max: null });
		for (const level of [undefined, "off", "minimal", "xhigh", "max"])
			expect(() => resolveAgySelection(m, level)).toThrow(/model or effort/);
		expect(() => resolveAgySelection(toAgyProviderModel({ id: "agy-select-model", name: "Retired AGY entry", variants: {}, fixed: "agy-select-model" }), "high")).toThrow(/Open \/model/);
	});
	it("does not infer effort capabilities from a future model suffix", () => {
		const m = toAgyProviderModel(parseAgyCatalogue("gemini-future-model-high\tFuture model (High)")[0]);
		expect(m.id).toBe("gemini-future-model-high");
		expect(m.reasoning).toBe(false);
		expect(resolveAgySelection(m, "high")).toEqual({ nativeModel: "gemini-future-model-high" });
	});
	it("offers only exact listed variants from the evidenced current families", () => {
		const m = toAgyProviderModel(parseAgyCatalogue("gemini-4-argon-low\tArgon Low")[0]);
		expect(resolveAgySelection(m, "low").nativeModel).toBe("gemini-4-argon-low");
		expect(() => resolveAgySelection(m, "high")).toThrow();
		// A row of a family AGY has not been seen to offer stays a single model, whatever its suffix says.
		const x = toAgyProviderModel(parseAgyCatalogue("gemini-future-model-xhigh\tFuture xhigh")[0]);
		expect(x.id).toBe("gemini-future-model-xhigh");
		expect(x.reasoning).toBe(false);
	});
	// Decisions 2026-11-22, the model catalogue for AGY 1.5.14. The list is the saved output of the real `agy models` (23 rows).
	describe("AGY 1.5.14's model list", () => {
		const real = readFileSync(join(import.meta.dirname, "test-support/fixtures/agy-models-1.5.14.txt"), "utf8");
		const efforts = (id: string) => { const m = toAgyProviderModel(parseAgyCatalogue(real).find(x => x.id === id)!); return Object.entries(m.thinkingLevelMap as Record<string, string | null>).filter(([, v]) => v !== null).map(([k]) => k); };
		it("keeps only the Gemini rows: Neon and Hydrogen with low to xhigh, Argon and Flash with low to high, and each Orchestrator as one model with no effort", () => {
			const models = parseAgyCatalogue(real);
			expect(efforts("gemini-4-neon")).toEqual(["low", "medium", "high", "xhigh"]);
			expect(efforts("gemini-4-hydrogen")).toEqual(["low", "medium", "high", "xhigh"]);
			for (const id of ["gemini-4-argon", "gemini-3.8-flash"]) expect(efforts(id)).toEqual(["low", "medium", "high"]);
			for (const id of ["gemini-pro-orchestrator-neon", "gemini-pro-orchestrator-g1-pro"]) {
				const m = toAgyProviderModel(models.find(x => x.id === id)!);
				expect(m.reasoning).toBe(false);
				expect(efforts(id)).toEqual([]);
				expect(resolveAgySelection(m, undefined)).toEqual({ nativeModel: id });
			}
			// Decisions 2026-11-22 (Tom): only Gemini models go through pi-21. The Claude and GPT-OSS rows never reach Pi's model list.
			expect(models.map(m => m.id).sort()).toEqual(["gemini-3.8-flash", "gemini-4-argon", "gemini-4-hydrogen", "gemini-4-neon", "gemini-pro-orchestrator-g1-pro", "gemini-pro-orchestrator-neon"]);
			expect(real.split("\n").filter(l => /^(claude-|gpt-oss)/.test(l))).toHaveLength(7);
		});
		it("refuses a model that is not Gemini with the unsupported copy, whatever its rows or its effort, so a chat saved on one fails safe", () => {
			for (const id of ["claude-sonnet-5-5", "claude-opus-5-5"]) {
				const family = toAgyProviderModel({ id, name: id, variants: { low: `${id}-low`, medium: `${id}-medium`, high: `${id}-high` } });
				for (const level of ["low", "medium", "high", undefined]) expect(() => resolveAgySelection(family, level)).toThrow(/does not support the requested model or effort/);
			}
			expect(() => resolveAgySelection(toAgyProviderModel({ id: "gpt-oss-120b-medium", name: "GPT-OSS 120B", variants: {}, fixed: "gpt-oss-120b-medium" }), undefined)).toThrow(/does not support the requested model or effort/);
			// The same models as Pi's catalogue held them before: a restored cache row is refused too.
			expect(parseAgyCatalogue("claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)")).toEqual([]);
		});
		it("names a family without its effort, whichever row comes first, and leaves xhigh null where AGY lists no such row", () => {
			expect(parseAgyCatalogue("gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)\ngemini-4-neon-high\tGemini 4 Neon (High)")[0]).toMatchObject({ id: "gemini-4-neon", name: "Gemini 4 Neon" });
			expect(toAgyProviderModel(parseAgyCatalogue(real).find(x => x.id === "gemini-4-argon")!).thinkingLevelMap).toMatchObject({ xhigh: null, max: null });
		});
		it("resolves Neon xhigh to the exact listed row and refuses xhigh where the family lists none", () => {
			const neon = toAgyProviderModel(parseAgyCatalogue(real).find(x => x.id === "gemini-4-neon")!), argon = toAgyProviderModel(parseAgyCatalogue(real).find(x => x.id === "gemini-4-argon")!);
			expect(resolveAgySelection(neon, "xhigh")).toEqual({ nativeModel: "gemini-4-neon-xhigh", nativeEffort: "xhigh" });
			expect(() => resolveAgySelection(argon, "xhigh")).toThrow(/model or effort/);
		});
	});
	// AGY 1.5.16 (Decisions 2026-11-24): the saved output of the real `agy models` (27 rows).
	it("groups AGY 1.5.16's Carbon rows into one model with low to high, so its effort can change inside a chat", () => {
		const models = parseAgyCatalogue(readFileSync(join(import.meta.dirname, "test-support/fixtures/agy-models-1.5.16.txt"), "utf8"));
		expect(models.map(m => m.id).sort()).toEqual(["gemini-3.8-flash", "gemini-4-argon", "gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-neon", "gemini-pro-orchestrator", "gemini-pro-orchestrator-argon", "gemini-pro-orchestrator-neon"]);
		const carbon = toAgyProviderModel(models.find(m => m.id === "gemini-4-carbon")!);
		expect(carbon).toMatchObject({ name: "Gemini 4 Carbon (AGY agent)", reasoning: true });
		for (const level of ["low", "medium", "high"]) expect(resolveAgySelection(carbon, level)).toEqual({ nativeModel: `gemini-4-carbon-${level}`, nativeEffort: level });
		expect(() => resolveAgySelection(carbon, "xhigh")).toThrow(/model or effort/);
		for (const id of ["gemini-pro-orchestrator", "gemini-pro-orchestrator-argon", "gemini-pro-orchestrator-neon"]) expect(resolveAgySelection(toAgyProviderModel(models.find(m => m.id === id)!), undefined)).toEqual({ nativeModel: id });
	});
	it.each(["", "bad", "x\tName\textra", "x\tOne\nx\tTwo", "x\tName\u001b[2J", "x\t", "../id\tName"])("rejects malformed or ambiguous metadata %j", raw => {
		expect(() => parseAgyCatalogue(raw)).toThrow();
	});
});
import { afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, existsSync, readFileSync, chmodSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { createRbfAgy, AGY_PROVIDER, AGY_API, AGY_COPY, AGY_PROVENANCE, readAgyPolicy, readAgyCatalogue, sameAgyPolicy, acpPolicyArgs, projectAgyFooter, projectAgyThinking, type AgyRetirementSeal } from "./rbf-agy.js";
import { parseVersion, sanitizeDisplayText, versionAtLeast } from "./lib/agy-native.js";
const roots = process.env.PI214_TEST_ROOT ?? process.env.RBF_AGY_TEST_ROOT ?? process.env.RBF_AGY_TEST_TMP;
if (!roots) throw new Error("Resolve PI214_TEST_ROOT with eng-use-external-tmp before tests");
mkdirSync(roots, { recursive: true });
const retained: Array<{
	close(): Promise<void>;
	logs(): any[];
}> = [];
// A21.3-6: across every case of this file, no start of the fake `agy` carries `--print` (the deleted CLI route) or is anything but `acp` or `models`.
afterEach(async () => {
	const cli: string[][] = [];
	for (const h of retained.splice(0)) {
		cli.push(...cliLaunches(h.logs()));
		await h.close();
	}
	expect(cli, "a start of the fake agy that only the CLI route made").toEqual([]);
});
/** `mode` is `slow-metadata` for a fake `agy models` that answers after 5 s; every other value is the plain fake. */
export function harness(mode = "normal", opts: {
	root?: string;
	cwd?: string;
	seal?: AgyRetirementSeal;
	policy?: string;
	mode?: string;
	persist?: boolean;
	/** The fake `agy acp` server's modes (test-support/agy-acp-fake.cjs). */
	acp?: string;
	argv?: string[];
	piVersion?: string;
	trace?: (event: string, payload: any) => void;
	presentApproval?: ApprovalPresenter;
	approvalReviewTimeoutMs?: number;
	cancelGraceMs?: number;
	/** How long AGY must be silent before a wake turn ends. */
	wakeQuietMs?: number;
	/** How long a wake waits for Pi's turn before the owner gives it up (15 s in use). */
	wakeAttachMs?: number;
} = {}) {
	const root = opts.root ?? mkdtempSync(join(roots!, "case-")), log = join(root, "native.jsonl"), exe = join(root, "fake-agy.cjs");
	// The one fake `agy`: `models` prints the list a real `agy models` would (Gemini rows and the Claude and GPT-OSS rows Pi must drop; `slow-metadata` holds it for 5 s), anything else is the fake ACP server.
	writeFileSync(exe, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "models") {
	require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args }) + "\\n");
	const out = ${JSON.stringify(served)};
	if (${JSON.stringify(mode)} === "slow-metadata") setTimeout(() => process.stdout.write(out), 5000); else process.stdout.write(out);
}
else require(${JSON.stringify(join(import.meta.dirname, "test-support/agy-acp-fake.cjs"))})(${JSON.stringify({ log, mode: opts.acp ?? "", release: join(root, "release") })});
`);
	chmodSync(exe, 0o700);
	const sessionFile = join(root, 'pi.jsonl');
	if (!existsSync(sessionFile)) writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id: `pi-${root}`, cwd: root, timestamp: new Date().toISOString() }) + '\n');
	const entries: any[] = readFileSync(sessionFile, 'utf8').trim().split('\n').slice(1).map(line => JSON.parse(line));
	let seq = entries.length;
	let registration: any;
	const handlers = new Map<string, Function[]>();
	let model: any = full(toAgyProviderModel(parseAgyCatalogue(inventory).find(m => m.id === 'gemini-3.8-flash')!));
	const sm = { getBranch: () => entries, getEntries: () => entries, getLeafId: () => entries.at(-1)?.id ?? null, getSessionId: () => `pi-${root}`, getSessionFile: () => opts.persist === false ? undefined : join(root, 'pi.jsonl') };
	const sent: { message: any; options: any }[] = [];
	const state = { busy: false };
	const ctx: any = { mode: opts.mode ?? 'tui', hasUI: true, isIdle: () => !state.busy, cwd: opts.cwd ?? root, sessionManager: sm, model, ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } };
	const append = (value: any) => { const entry = { id: `e${++seq}`, parentId: sm.getLeafId(), ...value }; entries.push(entry); appendFileSync(sessionFile, JSON.stringify(entry) + "\n"); return entry; };
	const pi: any = { on: (name: string, fn: Function) => handlers.set(name, [...(handlers.get(name) ?? []), fn]), registerFlag: vi.fn(), registerEntryRenderer: vi.fn(), registerMessageRenderer: vi.fn(), getFlag: () => opts.policy, appendEntry: (type: string, data: any) => append({ type: 'custom', customType: type, data }), registerProvider: (_id: string, value: any) => registration = value, sendMessage: (message: any, options: any) => { sent.push({ message, options }); } };
	createRbfAgy({ executable: exe, piVersion: opts.piVersion ?? '1.4.0', argv: opts.argv ?? [], seal: opts.seal ?? {}, trace: opts.trace, presentApproval: opts.presentApproval, approvalReviewTimeoutMs: opts.approvalReviewTimeoutMs, cancelGraceMs: opts.cancelGraceMs, wakeQuietMs: opts.wakeQuietMs, wakeAttachMs: opts.wakeAttachMs })(pi);
	const emit = async (name: string, event: any = {}) => {
		let out: any;
		for (const fn of handlers.get(name) ?? [])
			out = await fn(event, ctx);
		return out;
	};
	const ready = emit('session_start');
	const h = {
		root, entries, ctx, pi, registration, emit, ready, full, append, sent, state,
		logs: () => {
			try {
				return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x));
			}
			catch {
				return [];
			}
		},
		async request(text: string, extra: any = {}) { await ready; const message = { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }; append({ type: 'message', message }); return registration.streamSimple(model, { systemPrompt: 'NEVER FORWARD THIS SYSTEM', messages: [message] }, { reasoning: 'high', ...extra }).result(); },
		/** Like request(), but returns the event stream. `shape` sets the user message content and any messages Pi puts after it in the context. */
		async stream(text: string, extra: any = {}, shape: { content?: any[]; after?: any[] } = {}) { await ready; const message = { role: 'user', content: shape.content ?? [{ type: 'text', text }], timestamp: Date.now() }; append({ type: 'message', message }); return registration.streamSimple(model, { systemPrompt: 'NEVER FORWARD THIS SYSTEM', messages: [message, ...(shape.after ?? [])] }, { reasoning: 'high', ...extra }); },
		async persist(message: any, between?: () => void) { await emit('message_end', { message }); append({ type: 'message', message }); between?.(); await emit('agent_end', { messages: [message] }); },
		async select(m: any) { const previousModel = model; model = m; ctx.model = m; await emit('model_select', { model: m, previousModel }); },
		async close() { await ready; await emit('session_shutdown'); },
	};
	retained.push(h);
	return h;
}
function full(m: any): any { return { ...m, api: AGY_API, provider: AGY_PROVIDER, baseUrl: 'stdio://agy' }; }
const body = (m: any) => m.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');

// What the CLI route's tests used to prove about the provider as a whole, now on the ACP route (the CLI route is deleted, Decisions 2026-11-22): the host it admits, the catalogue, the settings file,
// the compaction and branch-summary guard, the stop notice. Helpers declared further down (`run`, `launches`, `received`) are only used inside the cases.
const metadataLaunches = (h: ReturnType<typeof harness>) => h.logs().filter(x => x.args?.[0] === 'models');
async function finishedTurn(h: ReturnType<typeof harness>, text: string) { const out = await run(h, text); await h.persist(out.message); return out; }
describe('host and metadata admission', () => {
	it.each([{ mode: 'rpc' }, { mode: 'json' }, { mode: 'print' }, { persist: false }, { argv: ['--sandbox'] }, { piVersion: '0.85.1' }])('refuses excluded host %j without starting AGY', async (opts) => {
		const h = harness('normal', { acp: '', ...opts });
		expect((await run(h, 'Task')).message.stopReason).toBe('error');
		expect(launches(h)).toEqual([]);
		expect(received(h, 'session/prompt')).toEqual([]);
	});
	it('refreshes the catalogue with no model selection and no chat started', async () => {
		const h = harness();
		await h.ready;
		const publish = vi.fn();
		const models = await h.registration.refreshModels({ allowNetwork: true, signal: new AbortController().signal, publish });
		expect(models).toHaveLength(5);
		expect(publish).toHaveBeenCalledOnce();
		expect(launches(h).map(l => l.args)).toEqual([['models']]);
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
describe('settings file', () => {
	it('freezes what it read and notices a change, without ever writing the file', () => {
		const root = mkdtempSync(join(roots, 'policy-')), file = join(root, 'policy.json'), raw = '{"enableTerminalSandbox":true}';
		writeFileSync(file, raw, { mode: 0o600 });
		const p = readAgyPolicy(file)!;
		expect(acpPolicyArgs(p)).toEqual(['--sandbox']);
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
	it.each(['missing', 'relative', 'invalid'])('an initial %s settings file starts no AGY process', async (kind) => {
		const root = mkdtempSync(join(roots, 'initial-policy-')), file = join(root, 'policy.json');
		if (kind === 'invalid') writeFileSync(file, '[]', { mode: 0o600 });
		const h = harness('normal', { policy: kind === 'relative' ? 'relative.json' : file });
		expect((await run(h, 'No dispatch')).message.stopReason).toBe('error');
		expect(h.logs()).toEqual([]);
	});
});
describe('model catalogue discovery', () => {
	it('cancels the metadata read before it spawns and while its worker is pending', async () => {
		const h = harness('slow-metadata');
		await h.ready;
		const before = new AbortController();
		before.abort();
		await expect(readAgyCatalogue(join(h.root, 'fake-agy.cjs'), before.signal)).rejects.toThrow(/cancelled/);
		expect(h.logs()).toEqual([]);
		const during = new AbortController();
		const pending = readAgyCatalogue(join(h.root, 'fake-agy.cjs'), during.signal);
		const observed = expect(pending).rejects.toThrow(/cancelled/);
		await vi.waitFor(() => expect(metadataLaunches(h)).toHaveLength(1));
		during.abort();
		await observed;
		expect(launches(h).filter(l => l.args[0] !== 'models')).toEqual([]);
	});
	it('loads exact cached capabilities without starting anything', async () => {
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
	it('registers an empty catalogue without a startup work-model substitution', async () => {
		const h = harness(); await h.ready;
		expect(h.registration.models).toEqual([]);
		expect(h.logs()).toEqual([]);
	});
	it('discovers only real native models with no task input', async () => {
		const h = harness(); await h.ready;
		const rows = await h.registration.refreshModels({ allowNetwork: true, publish: async () => {} });
		expect(rows.map((m: any) => m.id)).toEqual([...families, 'gemini-pro-orchestrator-neon']);
		expect(launches(h).map(l => l.args)).toEqual([['models']]);
	});
	it('keeps Claude and GPT-OSS rows out of the model list, from the native list and from a restored cache (Decisions 2026-11-22: Gemini only)', async () => {
		const h = harness(); await h.ready;
		const online = await h.registration.refreshModels({ allowNetwork: true, publish: async () => {} });
		expect(online.map((m: any) => m.id).filter((id: string) => !id.startsWith('gemini-'))).toEqual([]);
		const real = full(toAgyProviderModel(parseAgyCatalogue(inventory)[0]));
		const claude = full(toAgyProviderModel({ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', variants: { low: 'claude-sonnet-5-5-low', high: 'claude-sonnet-5-5-high' } }));
		const gpt = full(toAgyProviderModel({ id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B', variants: {}, fixed: 'gpt-oss-120b-medium' }));
		const cached = await h.registration.refreshModels({ allowNetwork: false, stored: { models: [claude, gpt, real] } });
		expect(cached.map((m: any) => m.id)).toEqual([real.id]);
		expect(h.logs()).toEqual([{ args: ['models'] }]); // the one native `agy models` of the online refresh; the cache load starts nothing
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
describe('selected-provider summary and compaction isolation', () => {
	it('blocks summary generation on AGY before any chat exists', async () => {
		const h = harness();
		await h.ready;
		const result = await h.emit('session_before_tree', { preparation: { userWantsSummary: true } });
		expect(result?.summary?.summary).toContain('AGY branch summaries are unavailable');
		expect(h.logs()).toEqual([]);
	});
	it('restores neighboring provider compaction after AGY departure', async () => {
		const h = harness();
		await finishedTurn(h, 'First');
		await h.select({ ...h.ctx.model, provider: 'pi21-fake-neighbor' });
		expect(await h.emit('session_before_compact')).toEqual({});
		expect(received(h, 'session/prompt')).toHaveLength(1);
	});
	it('restores neighboring provider branch summaries after AGY departure', async () => {
		const h = harness();
		await finishedTurn(h, 'First');
		await h.select({ ...h.ctx.model, provider: 'pi21-fake-neighbor' });
		expect(await h.emit('session_before_tree', { preparation: { userWantsSummary: true } })).toEqual({});
		expect(received(h, 'session/prompt')).toHaveLength(1);
	});
});
const accounting = (h: ReturnType<typeof harness>) => h.ctx.ui.setWidget.mock.calls.filter((call: any[]) => call[0] === 'rbf-agy-accounting' && call[1] !== undefined).map((call: any[]) => call[1]);
describe('removed AGY accounting notices', () => {
	it('clears the legacy notice on reopen even when history contains AGY', async () => {
		const h = harness();
		await h.ready;
		h.ctx.sessionManager.getEntries = () => [{ type: 'message', id: 'past', message: { role: 'assistant', provider: AGY_PROVIDER, api: AGY_API, content: [] } }];
		expect(h.ctx.sessionManager.getBranch()).toEqual([]);
		await h.emit('session_start');
		expect(accounting(h)).toEqual([]);
	});
	it('clears for a clean new session without clearing unrelated widget keys', async () => {
		const h = harness();
		await finishedTurn(h, 'First');
		expect(accounting(h)).toEqual([]);
		h.entries.splice(0);
		h.ctx.sessionManager.getSessionId = () => h.root + '-new';
		await h.emit('session_start');
		expect(accounting(h)).toEqual([]);
		expect(h.ctx.ui.setWidget).toHaveBeenCalledWith('rbf-agy-accounting', undefined);
		expect(h.ctx.ui.setWidget.mock.calls.every((call: any[]) => ['rbf-agy-accounting', 'rbf-agy-activity', 'rbf-agy-checking', 'rbf-agy-stop', 'rbf-agy-preview'].includes(call[0]))).toBe(true);
	});
});
const stopWidget = (h: ReturnType<typeof harness>) => h.ctx.ui.setWidget.mock.calls.filter((call: any[]) => call[0] === 'rbf-agy-stop').at(-1)?.[1];
describe('idle stop advisory lifetime', { timeout: 30000 }, () => {
	it('shows verified idle retirement before new work without changing resource proof', async () => {
		const h = harness();
		await finishedTurn(h, 'First');
		expect(await h.emit('session_before_switch')).toEqual({});
		expect(stopWidget(h)).toEqual([ACP_COPY.stopped]);
		expect(h.logs().filter(x => x.eof)).toHaveLength(1);
	});
	it('retains an earlier unverified stop across a new factory without becoming an admission block', async () => {
		const seal: AgyRetirementSeal = {};
		const old = harness('normal', { seal, acp: 'ignore-eof' });
		await finishedTurn(old, 'First');
		await old.emit('session_before_switch');
		expect(seal.owner).toBeUndefined();
		expect(stopWidget(old)).toEqual(['Earlier AGY work', AGY_COPY.stopUnknown]);
		const next = harness('normal', { seal });
		await next.ready;
		expect(stopWidget(next)).toEqual(['Earlier AGY work', AGY_COPY.stopUnknown]);
		expect((await run(next, 'Fresh work')).message.stopReason).toBe('stop');
		expect(received(next, 'session/prompt')).toHaveLength(1);
		expect(stopWidget(next)).toEqual(['Earlier AGY work', AGY_COPY.stopUnknown]);
		await next.close();
		expect((seal as any).stopNotice).toBe('unverified');
	});
	it('clears a positive advisory on acquisition and ignores a duplicate older close disclosure', async () => {
		const seal: AgyRetirementSeal = {};
		const old = harness('normal', { seal });
		await finishedTurn(old, 'First');
		await old.emit('session_before_switch');
		expect((seal as any).stopNotice).toBe('stopped');
		const next = harness('normal', { seal });
		const pending = run(next, 'New work');
		await vi.waitFor(() => expect(received(next, 'session/prompt')).toHaveLength(1), { timeout: 3000, interval: 10 });
		expect(stopWidget(next)).toBeUndefined();
		await old.emit('session_shutdown');
		expect((seal as any).stopNotice).toBeUndefined();
		expect((await pending).message.stopReason).toBe('stop');
	});
});
describe('display text', () => {
	it('removes terminal and bidi controls from what it draws', () => {
		expect(sanitizeDisplayText('before\x1b[2J\x9b31m‮after')).not.toMatch(/[\x1b\x9b‮]/);
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
		// .3 changes effort between turns of one AGY chat; "conversation" would send Tom to /new, which drops AGY's context.
		expect(result).toContain('selects effort for the next AGY turn');
		expect(result).not.toContain('conversation');
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
import { AGY_COMPLETION, AGY_DISPATCH, AGY_REFUSAL, AGY_ACP_WAKE, RECOVERY_COPY } from "./lib/agy-recovery.js";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { ACP_COPY } from "./lib/agy-acp-session.js";
import { AGY_ACP_CONVERSATION, AGY_ACP_DISPATCH, AGY_ACP_COMPLETION, AGY_ACP_REFUSAL, AGY_ACP_PERMISSION, AGY_ACP_QUESTION, entryFingerprint, fingerprint, readSavedSession, selectAcpRecoveryAnchor } from "./lib/agy-recovery.js";
import { AGY_ACP_ACTIVITY, AGY_HISTORY_FAILURE } from "./lib/agy-history.js";
import { ACP_QUESTION_LINE, ApprovalDialog, formatAgyAcpPermissionLine, type ApprovalPresenter, type ApprovalView } from "./lib/agy-acp-approval.js";
import { CLI_BORN_COPY, retrySafe } from "./rbf-agy.js";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { AcpRpcError } from "./lib/agy-acp.js";
import { startWireLog, type WireLogRun } from "./test-support/agy-wire-log-env.js";
import { cliLaunches } from "./test-support/agy-launch-check.js";

// Every ACP test runs createRbfAgy({ executable }) against test-support/agy-acp-fake.cjs. Nothing here starts real AGY.
type Harness = ReturnType<typeof harness>;
const launches = (h: Harness) => h.logs().filter(x => x.args);
const received = (h: Harness, method: string) => h.logs().filter(x => x.in?.method === method).map(x => x.in);
const recordsOf = (h: Harness, type: string) => h.entries.filter(e => e.type === "custom" && e.customType === type);
const acpRecords = (h: Harness) => h.entries.filter(e => e.type === "custom" && String(e.customType).startsWith("rbf-agy-")).map(e => e.customType);
/** What Pi draws for a message: its text blocks, then the error message for an error or abort (Pi adds "Error: " in front of an error's). */
const shown = (m: any) => [body(m), m.stopReason === "error" || m.stopReason === "aborted" ? m.errorMessage : ""].filter(Boolean).join("\n");
/** Writes each entry the fake sees, so a test can read the order in which records and frames happened. */
function traceEntries(h: Harness) {
	const append = h.pi.appendEntry;
	h.pi.appendEntry = (type: string, data: any) => { appendFileSync(join(h.root, "native.jsonl"), JSON.stringify({ entry: type }) + "\n"); return append(type, data); };
}
const timeline = (h: Harness) => h.logs().flatMap(x => x.in ? [x.in.method] : x.entry ? ["entry:" + x.entry] : []);
const streamedText = (m: any) => m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
/** pi-ai's retry.js from the installed Pi, found the way the host checks find Pi: through the `pi` shim. */
function installedPiRetry(): string | undefined {
	try {
		const shim = execFileSync("which", ["pi"], { encoding: "utf8" }).trim(), target = readFileSync(shim, "utf8").split("# cmd-shim-target=")[1]?.trim();
		if (!target) return undefined;
		const root = realpathSync(dirname(dirname(dirname(realpathSync(target))))), ai = join(dirname(root), "pi-ai", "dist/utils/retry.js");
		return existsSync(ai) ? ai : undefined;
	}
	catch { return undefined; }
}
async function run(h: Harness, text: string, extra: any = {}, shape: { content?: any[]; after?: any[] } = {}) {
	const stream = await h.stream(text, extra, shape), events: any[] = [];
	for await (const event of stream) events.push(event);
	return { events, message: await stream.result() };
}
/** Builds a Pi session file that already holds `entries` after one user message, then opens it with the ACP fake. */
function seeded(entries: any[], options: { offBranch?: boolean; acp?: string } = {}) {
	const root = mkdtempSync(join(roots!, "route-")), sessionId = `pi-${root}`;
	const at = (n: number) => new Date(Date.UTC(2026, 10, 9, 12, 0, n)).toISOString();
	const earlierAnswer = { type: "message", message: { role: "assistant", content: [{ type: "text", text: "earlier answer" }], api: "x", provider: "other", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.parse(at(3)) } };
	const chain = [{ type: "model_change", provider: AGY_PROVIDER, modelId: "gemini-3.8-flash" }, { type: "message", message: { role: "user", content: [{ type: "text", text: "Earlier question" }], timestamp: Date.parse(at(2)) } }, earlierAnswer, ...entries];
	const lines = chain.map((body, i) => ({ id: String(i + 10).padStart(8, "0"), parentId: i === 0 ? null : String(i + 9).padStart(8, "0"), timestamp: at(i + 1), ...body }));
	writeFileSync(join(root, "pi.jsonl"), [{ type: "session", version: 3, id: sessionId, cwd: root, timestamp: at(0) }, ...lines].map(l => JSON.stringify(l)).join("\n") + "\n");
	const h = harness("normal", { root, acp: options.acp ?? "" });
	if (options.offBranch) {
		// As after /tree back to the model change: the records stay in the file but leave the current branch.
		const off = new Set(lines.slice(1).map(l => l.id)), sm = h.ctx.sessionManager, byId = () => new Map(h.entries.map((e: any) => [e.id, e]));
		sm.getLeafId = () => h.entries.filter((e: any) => !off.has(e.id)).at(-1)?.id ?? null;
		sm.getBranch = () => { const map = byId(), out: any[] = []; for (let id = sm.getLeafId(); id; id = map.get(id).parentId) out.unshift(map.get(id)); return out; };
	}
	return h;
}
const custom = (customType: string, data: any = {}) => ({ type: "custom", customType, data });
const ACP_CHAT = [custom(AGY_ACP_CONVERSATION, { acpSessionId: "acp-old", cwd: "/x", piSessionId: "p" }), custom(AGY_ACP_DISPATCH, { acpSessionId: "acp-old" }), custom(AGY_ACP_COMPLETION, { acpSessionId: "acp-old" })];

/** The line Pi shows for a message typed into a chat the CLI route started (Decisions 2026-11-22, ER9). */
const CLI_BORN = "This chat used AGY's old CLI route, which Pi no longer runs. Your message was not sent. Use /new to start a new AGY chat.";
const cliBornFixtures: [string, any[], boolean?][] = [
	["rbf-agy-conversation/v1, -dispatch/v1 and -completion/v1 on the current branch", [custom(AGY_PROVENANCE, { conversationId: "c" }), custom(AGY_DISPATCH), custom(AGY_COMPLETION)]],
	["only rbf-agy-completion/v1, on another branch", [custom(AGY_COMPLETION)], true],
	["only rbf-agy-refusal/v1", [custom(AGY_REFUSAL)]],
	["a legacy agy_controlled tool call", [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t", name: "agy_controlled", arguments: {} }], stopReason: "toolUse", timestamp: 1 } }]],
];
// Decisions 2026-11-22: the CLI route (`agy --print`) is deleted, so a message in a chat it started is refused with a plain line, with nothing sent, no AGY process started and no AGY record written.
describe("pi-21.3 CLI-born refusal", () => {
	it("uses the brief's line, character for character", () => { expect(CLI_BORN_COPY).toBe(CLI_BORN); });
	const agyRecords = (h: Harness) => h.entries.filter(e => String(e.customType ?? "").startsWith("rbf-agy-")).map(e => e.customType);
	it.each(cliBornFixtures)("refuses the next message in a session with %s, starts no AGY process and writes no AGY record", async (_name, entries, offBranch) => {
		const h = seeded(entries, { offBranch }), recordsBefore = agyRecords(h), { message } = await run(h, "Continue");
		expect(message.stopReason).toBe("error");
		expect(shown(message)).toBe(CLI_BORN);
		expect(h.logs()).toEqual([]); // the fake logs every start: no `acp`, no `--print`, no `models`, no `--version`
		await h.persist(message);
		expect(agyRecords(h)).toEqual(recordsBefore);
		expect(h.logs()).toEqual([]);
	});

	it.each(cliBornFixtures)("refuses it the same way after a reload: %s", async (_name, entries, offBranch) => {
		const first = seeded(entries, { offBranch });
		await first.close();
		const reopened = harness("normal", { root: first.root, acp: "" });
		await reopened.ready;
		if (offBranch) {
			const off = new Set(reopened.entries.slice(1).map((e: any) => e.id)), sm = reopened.ctx.sessionManager, byId = () => new Map(reopened.entries.map((e: any) => [e.id, e]));
			sm.getLeafId = () => reopened.entries.filter((e: any) => !off.has(e.id)).at(-1)?.id ?? null;
			sm.getBranch = () => { const map = byId(), out: any[] = []; for (let id = sm.getLeafId(); id; id = map.get(id).parentId) out.unshift(map.get(id)); return out; };
		}
		const { message } = await run(reopened, "Continue after the reload");
		expect(shown(message)).toBe(CLI_BORN);
		expect(reopened.logs()).toEqual([]);
	});

	it("refuses before any other check: an AGY command in the text, and an image", async () => {
		const h = seeded([custom(AGY_PROVENANCE, { conversationId: "c" })]);
		expect(shown((await run(h, "/goal finish")).message)).toBe(CLI_BORN);
		expect(shown((await run(h, "ignored", {}, { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "what is this" }] })).message)).toBe(CLI_BORN);
		expect(h.logs()).toEqual([]);
	});

	it("does not refuse a session with only ACP records or with no AGY record, and starts `acp` for it", async () => {
		const plain = seeded([]), { message } = await run(plain, "Continue");
		expect(message.stopReason).toBe("stop");
		expect(launches(plain).map(l => l.args)).toEqual([["acp"]]);
		const acpOnly = seeded(ACP_CHAT, { offBranch: true }), started = await run(acpOnly, "Continue");
		expect(started.message.stopReason).toBe("stop");
		expect(launches(acpOnly)).toHaveLength(1);
	});
});

describe("pi-21.3 ACP route rule", () => {
	it("sends an ACP chat that is no longer live to the ACP route, whose recovery chain refuses these hand-written records", async () => {
		const h = seeded(ACP_CHAT), { message } = await run(h, "Continue");
		expect(shown(message)).toBe(RECOVERY_COPY.mismatch);
		expect(launches(h)).toEqual([]);
	});

	it("starts a new ACP chat when its ACP records sit only on another branch", async () => {
		const h = seeded(ACP_CHAT, { offBranch: true }), { message } = await run(h, "Continue");
		expect(message.stopReason).toBe("stop");
		expect(launches(h)).toHaveLength(1);
		expect(recordsOf(h, AGY_ACP_CONVERSATION)).toHaveLength(2);
	});

	it.each([
		["no AGY record", []],
		["only other extensions' entries", [custom("rbf-cache-guardian/state", { warmedAt: 1 }), custom("some-other-extension")]],
		["only activity records", [custom("rbf-agy-activity/v1"), custom("rbf-agy-activity/v2")]],
	])("starts an ACP chat for a session with %s", async (_name, entries) => {
		const h = seeded(entries as any[]), { message } = await run(h, "Continue");
		expect(message.stopReason).toBe("stop");
		expect(launches(h).map(l => l.args)).toEqual([["acp"]]);
	});
});

describe("pi-21.3 ACP new chat and streaming", () => {
	it("starts nothing until the first send, then one `acp` child in the session folder", async () => {
		const h = harness("normal", { acp: "" });
		await h.ready;
		expect(h.logs()).toEqual([]);
		await run(h, "Hello");
		expect(launches(h).map(l => l.args)).toEqual([["acp"]]);
		expect(launches(h)[0].cwd).toBe(realpathSync(h.root));
		expect(received(h, "initialize")).toHaveLength(1);
		expect(received(h, "session/new")).toHaveLength(1);
		expect(h.logs().some(x => x.args && x.args[0] === "models")).toBe(false);
	});

	it("writes the conversation record, then the dispatch, before the one prompt, and the completion after the saved answer", async () => {
		const h = harness("normal", { acp: "" });
		traceEntries(h);
		const { message } = await run(h, "Hello");
		expect(timeline(h)).toEqual(["initialize", "session/new", "entry:" + AGY_ACP_CONVERSATION, "session/set_config_option", "session/set_config_option", "entry:" + AGY_ACP_DISPATCH, "session/prompt"]);
		expect(recordsOf(h, AGY_ACP_COMPLETION)).toEqual([]);
		await h.persist(message);
		const [conversation] = recordsOf(h, AGY_ACP_CONVERSATION), [dispatch] = recordsOf(h, AGY_ACP_DISPATCH), [completion] = recordsOf(h, AGY_ACP_COMPLETION);
		expect(Object.keys(conversation.data).sort()).toEqual(["acpSessionId", "cwd", "piSessionId"]);
		expect(conversation.data).toEqual({ acpSessionId: expect.stringMatching(/^fake-acp-/), cwd: realpathSync(h.root), piSessionId: h.ctx.sessionManager.getSessionId() });
		expect(dispatch.data).toMatchObject({ acpSessionId: conversation.data.acpSessionId, model: "gemini-3.8-flash", effort: "high", policyHash: null, previousCompletionId: null });
		expect(dispatch.data.userId).toBe(h.entries.find(e => e.type === "message" && e.message.role === "user").id);
		expect(completion.data).toMatchObject({ acpSessionId: conversation.data.acpSessionId, dispatchId: dispatch.id, outcome: "stop", model: "gemini-3.8-flash", effort: "high" });
		expect(acpRecords(h)).toEqual([AGY_ACP_CONVERSATION, AGY_ACP_DISPATCH, AGY_ACP_COMPLETION]);
	});

	it("streams three chunks as three deltas and saves one answer equal to their concatenation", async () => {
		const h = harness("normal", { acp: "" }), { events, message } = await run(h, "Hello");
		expect(events.filter(e => e.type === "text_delta").map(e => e.delta)).toEqual(["Hello", " from", " ACP."]);
		expect(events.map(e => e.type)).toEqual(["start", "text_start", "text_delta", "text_delta", "text_delta", "text_end", "done"]);
		expect(message.content).toEqual([{ type: "text", text: "Hello from ACP." }]);
		expect(message.stopReason).toBe("stop");
		expect(message.provider).toBe(AGY_PROVIDER);
		expect(message.model).toBe("gemini-3.8-flash");
	});

	it("gives the same events, answer and saved records when AGY 1.5.14 sends usage_update frames at start, after each settings call, between chunks and between turns", async () => {
		const quiet = harness("normal", { acp: "" }), noisy = harness("normal", { acp: "usage-updates" });
		const a = await run(quiet, "Hello"), b = await run(noisy, "Hello");
		expect(b.events.map(e => e.type)).toEqual(a.events.map(e => e.type));
		expect(b.events.filter(e => e.type === "text_delta").map(e => e.delta)).toEqual(["Hello", " from", " ACP."]);
		expect(b.message).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "Hello from ACP." }], usage: a.message.usage });
		await noisy.persist(b.message);
		await quiet.persist(a.message);
		expect(acpRecords(noisy)).toEqual(acpRecords(quiet));
		expect(noisy.logs().filter(x => x.out?.params?.update?.sessionUpdate === "usage_update").length).toBeGreaterThanOrEqual(6);
		await vi.waitFor(() => expect(noisy.logs().some(x => x.usageAfterTurn)).toBe(true));
		await new Promise(r => setTimeout(r, 30));
		const [dispatch] = recordsOf(noisy, AGY_ACP_DISPATCH), [completion] = recordsOf(noisy, AGY_ACP_COMPLETION);
		expect(completion.data).toMatchObject({ dispatchId: dispatch.id, outcome: "stop", model: "gemini-3.8-flash", effort: "high" });
		expect(received(noisy, "session/set_config_option").map(m => [m.params.configId, m.params.value])).toEqual(received(quiet, "session/set_config_option").map(m => [m.params.configId, m.params.value]));
	});

	it("continues the same session after a usage_update between turns, with no new settings call and the same chain", async () => {
		const h = harness("normal", { acp: "usage-updates" });
		await h.persist((await run(h, "First")).message);
		await vi.waitFor(() => expect(h.logs().some(x => x.usageAfterTurn)).toBe(true));
		await new Promise(r => setTimeout(r, 30));
		const second = await run(h, "Second");
		expect(second.message.stopReason).toBe("stop");
		expect(body(second.message)).toBe("Hello from ACP.");
		await h.persist(second.message);
		expect(launches(h)).toHaveLength(1);
		expect(received(h, "session/set_config_option")).toHaveLength(2);
		expect(received(h, "session/prompt").map(m => m.params.prompt[0].text)).toEqual(["First", "Second"]);
		const [first, again] = recordsOf(h, AGY_ACP_DISPATCH), completions = recordsOf(h, AGY_ACP_COMPLETION);
		expect(first.data.previousCompletionId).toBeNull();
		expect(again.data.previousCompletionId).toBe(completions[0].id);
		expect(completions).toHaveLength(2);
	});

	it("maps AGY's usage and keeps cost at zero", async () => {
		const h = harness("normal", { acp: "" }), { message } = await run(h, "Hello");
		expect(message.usage).toMatchObject({ input: 4331, output: 60, cacheRead: 48051, cacheWrite: 0, totalTokens: 52442, cost: { total: 0 } });
	});

	it("streams thought chunks as thinking and keeps the text block separate", async () => {
		const h = harness("normal", { acp: "" }), { events, message } = await run(h, "[thought] go");
		expect(events.filter(e => e.type === "thinking_delta").map(e => e.delta)).toEqual(["Thinking it over."]);
		expect(message.content).toEqual([{ type: "thinking", thinking: "Thinking it over." }, { type: "text", text: "Done." }]);
	});

	it("saves an empty answer as one literal empty text block, with no placeholder text", async () => {
		const h = harness("normal", { acp: "" }), { message } = await run(h, "[empty] go");
		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "" }]);
	});

	it("keeps the four facts apart: Pi's selection, the acknowledged pair, the answer, and no attribution field", async () => {
		const h = harness("normal", { acp: "" });
		const { message } = await run(h, "Hello", { reasoning: "low" });
		await h.persist(message);
		const [dispatch] = recordsOf(h, AGY_ACP_DISPATCH), [completion] = recordsOf(h, AGY_ACP_COMPLETION), saved = h.entries.find(e => e.type === "message" && e.message.role === "assistant");
		expect(saved.message.model).toBe("gemini-3.8-flash");
		expect([dispatch.data.model, dispatch.data.effort]).toEqual(["gemini-3.8-flash", "low"]);
		expect([completion.data.model, completion.data.effort]).toEqual(["gemini-3.8-flash", "low"]);
		expect(completion.data.assistantId).toBe(saved.id);
		expect(completion.data.assistantFingerprint).toBe(entryFingerprint(saved));
		for (const data of [dispatch.data, completion.data]) expect(Object.keys(data).filter(k => /execut|attribut/i.test(k))).toEqual([]);
	});

	it("continues the same ACP session for the next message without a new child or any settings call", async () => {
		const h = harness("normal", { acp: "" });
		await h.persist((await run(h, "First")).message);
		await h.persist((await run(h, "Second")).message);
		expect(launches(h)).toHaveLength(1);
		expect(received(h, "session/new")).toHaveLength(1);
		expect(received(h, "session/prompt").map(m => m.params.prompt[0].text)).toEqual(["First", "Second"]);
		expect(received(h, "session/set_config_option")).toHaveLength(2);
		const [first, second] = recordsOf(h, AGY_ACP_DISPATCH), completions = recordsOf(h, AGY_ACP_COMPLETION);
		expect(first.data.previousCompletionId).toBeNull();
		expect(second.data.previousCompletionId).toBe(completions[0].id);
		expect(completions).toHaveLength(2);
	});

	it("never resends a user message: a second call for the same message is refused and sends nothing", async () => {
		const h = harness("normal", { acp: "" });
		await h.persist((await run(h, "Only once")).message);
		const user = h.entries.filter(e => e.type === "message" && e.message.role === "user").at(-1);
		const again = await h.registration.streamSimple(h.ctx.model, { messages: [user.message] }, { reasoning: "high" }).result();
		expect(again.stopReason).toBe("error");
		expect(shown(again)).toContain("will not resend");
		expect(received(h, "session/prompt")).toHaveLength(1);
	});

	it("says earlier Pi messages are not transferred when the chat starts after an answer, and not otherwise", async () => {
		const h = seeded([]);
		await run(h, "Now ask AGY");
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(AGY_COPY.cold, "info");
		const clean = harness("normal", { acp: "" });
		await run(clean, "Hello");
		expect(clean.ctx.ui.notify).not.toHaveBeenCalledWith(AGY_COPY.cold, expect.anything());
	});

	// Cold review F7: ER2 says the notice is for earlier non-AGY answers. AGY's own refusal of a first message is not one.
	it("shows no cold notice when the only earlier answer is AGY's own refusal, and still shows it when another provider answered before", async () => {
		const image = { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "what is this" }] };
		const own = harness("normal", { acp: "" });
		const refused = await run(own, "ignored", {}, image);
		expect(refused.message.stopReason).toBe("error");
		await own.persist(refused.message);
		const { message } = await run(own, "Now a plain message");
		expect(message.stopReason).toBe("stop");
		expect(own.ctx.ui.notify).not.toHaveBeenCalledWith(AGY_COPY.cold, expect.anything());
		const other = seeded([]);
		const refusedAfterOther = await run(other, "ignored", {}, image);
		expect(refusedAfterOther.message.stopReason).toBe("error");
		await other.persist(refusedAfterOther.message);
		await run(other, "Now a plain message");
		expect(other.ctx.ui.notify).toHaveBeenCalledWith(AGY_COPY.cold, "info");
	});

	it("tolerates a system message after the user message in the context, as Pi 1.5.0 can send", async () => {
		const h = harness("normal", { acp: "" });
		const { message } = await run(h, "Hello", {}, { after: [{ role: "system", content: "Tools changed." }] });
		expect(message.stopReason).toBe("stop");
		expect(received(h, "session/prompt")[0].params.prompt[0].text).toBe("Hello");
	});
});

describe("pi-21.3 ACP refusals before anything is sent", () => {
	const image = { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "what is this" }] };
	const IMAGE_COPY = "AGY accepts text-only tasks. Your message was not sent. Remove images and send a new request.";

	it("refuses an image in the first message before any child starts, and writes no ACP record", async () => {
		const h = harness("normal", { acp: "" }), { message } = await run(h, "ignored", {}, image);
		expect(shown(message)).toBe(IMAGE_COPY);
		expect(launches(h)).toEqual([]);
		await h.persist(message);
		expect(acpRecords(h)).toEqual([]);
	});

	it("refuses an image in a live chat without a prompt, then saves a refusal record naming the user message and the error answer", async () => {
		const h = harness("normal", { acp: "" });
		await h.persist((await run(h, "First")).message);
		const refusal = await run(h, "ignored", {}, image);
		expect(shown(refusal.message)).toBe(IMAGE_COPY);
		expect(received(h, "session/prompt")).toHaveLength(1);
		await h.persist(refusal.message);
		const [record] = recordsOf(h, AGY_ACP_REFUSAL), users = h.entries.filter(e => e.type === "message" && e.message.role === "user"), errors = h.entries.filter(e => e.type === "message" && e.message.stopReason === "error");
		expect(record.data).toMatchObject({ userId: users.at(-1).id, userFingerprint: entryFingerprint(users.at(-1)), assistantId: errors[0].id, assistantFingerprint: entryFingerprint(errors[0]), completionId: recordsOf(h, AGY_ACP_COMPLETION)[0].id, conversationEntryId: recordsOf(h, AGY_ACP_CONVERSATION)[0].id });
		const next = await run(h, "Still working");
		expect(next.message.stopReason).toBe("stop");
	});

	it("draws a refusal once: the copy is the error message, and no text block or text event repeats it (Pi adds its own \"Error: \" line)", async () => {
		const h = harness("normal", { acp: "" }), { events, message } = await run(h, "/goal finish the report");
		expect(message.errorMessage).toBe(ACP_COPY.agyCommand("goal"));
		expect(message.content).toEqual([]);
		expect(events.map(e => e.type)).toEqual(["error"]);
	});

	it("refuses a message starting with an AGY command once AGY's list has arrived, keeps the session open and sends nothing", async () => {
		const h = harness("normal", { acp: "" }), refused = await run(h, "/goal finish the report");
		expect(shown(refused.message)).toBe(ACP_COPY.agyCommand("goal"));
		expect(received(h, "session/prompt")).toEqual([]);
		await h.persist(refused.message);
		expect(recordsOf(h, AGY_ACP_REFUSAL)).toHaveLength(1);
		const next = await run(h, "A plain message");
		expect(next.message.stopReason).toBe("stop");
		expect(launches(h)).toHaveLength(1);
	});

	it("refuses slash text it cannot check after waiting 2 s for a list that never arrives, but sends plain text at once", async () => {
		const h = harness("normal", { acp: "no-commands" });
		const plain = Date.now();
		const ok = await run(h, "hello");
		expect(ok.message.stopReason).toBe("stop");
		expect(Date.now() - plain).toBeLessThan(1500);
		await h.persist(ok.message);
		const started = Date.now(), slashed = await run(h, "/goal now");
		expect(shown(slashed.message)).toBe(ACP_COPY.listMissing("goal"));
		expect(Date.now() - started).toBeGreaterThanOrEqual(1800);
		expect(received(h, "session/prompt")).toHaveLength(1);
	}, 15000);

	it("does not treat a path-like first word as an AGY command", async () => {
		const h = harness("normal", { acp: "" }), { message } = await run(h, "/etc/hosts has two lines?");
		expect(message.stopReason).toBe("stop");
	});

	it("refuses a model AGY does not offer, with nothing sent, and records the refusal", async () => {
		const h = harness("normal", { acp: "lacks-flash" }), { message } = await run(h, "Hello");
		expect(shown(message)).toBe(ACP_COPY.unsupported);
		expect(received(h, "session/set_config_option")).toEqual([]);
		expect(received(h, "session/prompt")).toEqual([]);
		await h.persist(message);
		expect(recordsOf(h, AGY_ACP_REFUSAL)).toHaveLength(1);
		expect(recordsOf(h, AGY_ACP_DISPATCH)).toEqual([]);
	});
});

describe("pi-21.3 ACP settings change", () => {
	const row = (id: string) => full(toAgyProviderModel(parseAgyCatalogue(inventory).find(m => m.id === id)!));
	const sets = (h: Harness) => received(h, "session/set_config_option").map(m => [m.params.configId, m.params.value]);
	const ids = (h: Harness) => recordsOf(h, AGY_ACP_DISPATCH).map(r => [r.data.model, r.data.effort]);
	/** Pi's own steps when Tom picks a model and a thinking level, then sends: select, level event, request, persist. */
	async function send(h: Harness, text: string, pick: { model?: string; level?: string; previous?: string } = {}) {
		if (pick.model) await h.select(row(pick.model));
		if (pick.level) await h.emit("thinking_level_select", { level: pick.level, previousLevel: pick.previous ?? "high" });
		const out = await run(h, text, pick.level ? { reasoning: pick.level } : {});
		await h.persist(out.message);
		return out;
	}

	it("keeps one ACP session across an unchanged, model-only, effort-only, combined and switch-back change, setting only what differs", async () => {
		const h = harness("normal", { acp: "" });
		await send(h, "first");                                                       // flash / high
		expect(sets(h)).toEqual([["model", "gemini-3.8-flash"], ["thought_level", "high"]]);
		await send(h, "unchanged");
		expect(sets(h)).toHaveLength(2);
		await send(h, "model only", { model: "gemini-4-hydrogen", level: "high" });    // sonnet / high
		expect(sets(h).slice(2)).toEqual([["model", "gemini-4-hydrogen"]]);
		await send(h, "effort only", { level: "low", previous: "high" });              // sonnet / low
		expect(sets(h).slice(3)).toEqual([["thought_level", "low"]]);
		await send(h, "combined", { model: "gemini-3.8-flash", level: "medium", previous: "low" }); // flash / medium
		expect(sets(h).slice(4)).toEqual([["model", "gemini-3.8-flash"], ["thought_level", "medium"]]);
		await send(h, "switch back", { model: "gemini-4-hydrogen", level: "low", previous: "medium" }); // sonnet / low again
		expect(sets(h).slice(6)).toEqual([["model", "gemini-4-hydrogen"], ["thought_level", "low"]]);
		expect(ids(h)).toEqual([["gemini-3.8-flash", "high"], ["gemini-3.8-flash", "high"], ["gemini-4-hydrogen", "high"], ["gemini-4-hydrogen", "low"], ["gemini-3.8-flash", "medium"], ["gemini-4-hydrogen", "low"]]);
		expect(received(h, "session/prompt")).toHaveLength(6);
		expect(launches(h)).toHaveLength(1);
		expect(received(h, "session/new")).toHaveLength(1);
		expect(new Set(recordsOf(h, AGY_ACP_COMPLETION).map(r => r.data.acpSessionId)).size).toBe(1);
	});

	it("for a fixed-effort model sends a model call only and records the thinking level AGY reports as the effort", async () => {
		const h = harness("normal", { acp: "" });
		await send(h, "first");
		await send(h, "fixed", { model: "gemini-pro-orchestrator-neon" });
		expect(sets(h).slice(2)).toEqual([["model", "gemini-pro-orchestrator-neon"]]);
		// Only the model is checked. The thinking level is whatever AGY holds ("high", left by the first turn), and that is what is recorded.
		expect(ids(h).at(-1)).toEqual(["gemini-pro-orchestrator-neon", "high"]);
	});

	it.each([
		["a reply that does not show the requested pair", "wrong-ack"],
		["a partial acknowledgement: the effort call fails after the model call went through", "effort-fails"],
	])("sends no prompt after %s, keeps the conversation and sends on once a supported setting is picked", async (_name, mode) => {
		const h = harness("normal", { acp: mode });
		const refused = await run(h, "first");
		expect(shown(refused.message)).toBe(ACP_COPY.notConfirmed);
		expect(received(h, "session/prompt")).toEqual([]);
		await h.persist(refused.message);
		expect(recordsOf(h, AGY_ACP_DISPATCH)).toEqual([]);
		expect(recordsOf(h, AGY_ACP_REFUSAL)).toHaveLength(1);
		if (mode === "effort-fails") {
			const next = await send(h, "fixed effort needs no effort call", { model: "gemini-pro-orchestrator-neon" });
			expect(next.message.stopReason).toBe("stop");
			expect(launches(h)).toHaveLength(1);
		}
	});

	// Cold review F7: the copy table's row "Cancel after the conversation was lost".
	it("says the conversation cannot continue when a newer selection cancels the change and AGY is lost before it answers", async () => {
		const h = harness("normal", { acp: "hold-set,die-on-release" });
		const pending = run(h, "first");
		await vi.waitFor(() => expect(received(h, "session/set_config_option").length).toBeGreaterThan(0));
		await h.emit("thinking_level_select", { level: "low", previousLevel: "high" });
		writeFileSync(join(h.root, "release"), "go"); // AGY dies instead of answering the held call
		const cancelled = await pending;
		expect(shown(cancelled.message)).toBe(ACP_COPY.changeCancelledLost);
		expect(ACP_COPY.changeCancelledLost).toBe("AGY change cancelled. Your message was not sent. This conversation cannot continue. Use /new after AGY cleanup completes.");
		expect(received(h, "session/prompt")).toEqual([]);
		await h.persist(cancelled.message);
		const next = await run(h, "second");
		expect(shown(next.message)).toContain("AGY context has ended");
	});

	it("refuses and sends no prompt when a newer selection arrives while the pair is being checked, then uses the newer one", async () => {
		const h = harness("normal", { acp: "hold-set" });
		const pending = run(h, "first");
		await vi.waitFor(() => expect(received(h, "session/set_config_option").length).toBeGreaterThan(0));
		await h.emit("thinking_level_select", { level: "low", previousLevel: "high" });
		writeFileSync(join(h.root, "release"), "go"); // AGY's replies were held until the selection changed
		const cancelled = await pending;
		expect(shown(cancelled.message)).toBe(ACP_COPY.changeCancelled);
		expect(received(h, "session/prompt")).toEqual([]);
		await h.persist(cancelled.message);
		// Let the echoes of the abandoned check land first, as the seconds Tom takes to send again would.
		await vi.waitFor(() => expect(h.logs().filter(x => x.out?.params?.update?.sessionUpdate === "config_option_update").length).toBeGreaterThanOrEqual(2)); // two, or four when the client's second pass ran too
		await new Promise(r => setTimeout(r, 30));
		const next = await run(h, "second", { reasoning: "low" });
		await h.persist(next.message);
		expect(next.message.stopReason).toBe("stop");
		expect(ids(h)).toEqual([["gemini-3.8-flash", "low"]]);
		expect(launches(h)).toHaveLength(1);
	});

	it("lets a running turn keep its pair when the selection changes: no retire, one prompt, and the new pair is set on the next send", async () => {
		const h = harness("normal", { acp: "" });
		const turn = run(h, "[hold] go");
		await vi.waitFor(() => expect(received(h, "session/prompt")).toHaveLength(1));
		await h.select(row("gemini-4-hydrogen"));
		h.append({ type: "model_change", provider: AGY_PROVIDER, modelId: "gemini-4-hydrogen" });
		await h.emit("thinking_level_select", { level: "low", previousLevel: "high" });
		h.append({ type: "thinking_level_change", thinkingLevel: "low" });
		expect(h.logs().some(x => x.eof)).toBe(false);
		writeFileSync(join(h.root, "release"), "go");
		const { message } = await turn;
		expect(message.stopReason).toBe("stop");
		expect(message.model).toBe("gemini-3.8-flash");
		await h.persist(message);
		expect(recordsOf(h, AGY_ACP_COMPLETION)).toHaveLength(1);
		expect(ids(h)).toEqual([["gemini-3.8-flash", "high"]]);
		expect(h.ctx.model.id).toBe("gemini-4-hydrogen");
		const next = await run(h, "next", { reasoning: "low" });
		expect(next.message.model).toBe("gemini-4-hydrogen");
		expect(sets(h).slice(2)).toEqual([["model", "gemini-4-hydrogen"], ["thought_level", "low"]]);
		expect(h.logs().some(x => x.eof)).toBe(false);
	});

	it.each(["echo:recorded", "echo:after-replies", "echo:effort-after-prompt", "echo:after-prompt", "echo:missing-model", "echo:same-chunk:model", "echo:same-chunk:thought_level", "echo:same-chunk:all"])("sends one prompt and shows no divergence with %s", async mode => {
		const h = harness("normal", { acp: mode });
		const { message } = await send(h, "first");
		expect({ stopReason: message.stopReason, errorMessage: message.errorMessage }).toEqual({ stopReason: "stop", errorMessage: undefined }); // a failure prints the error's own text
		expect(received(h, "session/prompt")).toHaveLength(1);
		const again = await send(h, "second");
		expect({ stopReason: again.message.stopReason, errorMessage: again.message.errorMessage }).toEqual({ stopReason: "stop", errorMessage: undefined });
		expect(sets(h)).toHaveLength(2);
		expect(received(h, "session/prompt")).toHaveLength(2);
	});

	it("re-sends both settings once when an echo arrives before its own reply: four calls, then one prompt", async () => {
		const h = harness("normal", { acp: "echo:before-reply" });
		const { message } = await send(h, "first");
		expect(message.stopReason).toBe("stop");
		expect(sets(h)).toHaveLength(4);
		expect(received(h, "session/prompt")).toHaveLength(1);
	});

	it("after an update between turns re-sends both settings, and records the effort the reply reported", async () => {
		const h = harness("normal", { acp: "" });
		await h.emit("thinking_level_select", { level: "low", previousLevel: "high" });
		await send(h, "[late-echo] first", { level: "low" });
		await vi.waitFor(() => expect(h.logs().some(x => x.lateEchoSent)).toBe(true), { timeout: 5000 }); await new Promise(r => setTimeout(r, 30));
		await send(h, "second", { level: "medium", previous: "low" });
		expect(sets(h).slice(2)).toEqual([["model", "gemini-3.8-flash"], ["thought_level", "medium"]]);
		expect(ids(h)).toEqual([["gemini-3.8-flash", "low"], ["gemini-3.8-flash", "medium"]]);
	});

	it("refuses that send when the effort reply does not show the selected level, and records no dispatch for it", async () => {
		const h = harness("normal", { acp: "wrong-effort" });
		await send(h, "[late-echo] first", { level: "low" });
		await vi.waitFor(() => expect(h.logs().some(x => x.lateEchoSent)).toBe(true), { timeout: 5000 }); await new Promise(r => setTimeout(r, 30));
		const refused = await run(h, "second", { reasoning: "medium" });
		expect(shown(refused.message)).toBe(ACP_COPY.notConfirmed);
		expect(received(h, "session/prompt")).toHaveLength(1);
		await h.persist(refused.message);
		expect(ids(h)).toEqual([["gemini-3.8-flash", "low"]]);
	});

	it("ends eligibility with the divergence copy when AGY changes the model during the turn, keeps the answer, saves no completion and refuses the next send", async () => {
		const h = harness("normal", { acp: "" });
		const { message } = await run(h, "[diverge] go");
		expect(message.stopReason).toBe("error");
		expect(shown(message)).toContain("Answered anyway.");
		expect(shown(message)).toContain("AGY reported different settings for this turn. The task may have run. Review its results before sending again.");
		await h.persist(message);
		expect(recordsOf(h, AGY_ACP_COMPLETION)).toEqual([]);
		const next = await run(h, "again");
		expect(shown(next.message)).toBe(AGY_COPY.ended);
		expect(received(h, "session/prompt")).toHaveLength(1);
	});

	it("shows `AGY — checking conversation` while the pair is set and checked, clears it, and adds no pending or applied line", async () => {
		const h = harness("normal", { acp: "slow-set:60" });
		const widget = h.ctx.ui.setWidget as ReturnType<typeof vi.fn>;
		await send(h, "first");
		const calls = widget.mock.calls.filter((c: any[]) => c[0] === "rbf-agy-checking");
		expect(calls.map((c: any[]) => c[1])).toEqual([["AGY — checking conversation"], undefined]);
		expect(calls[0]![1]![0]!.length).toBeLessThanOrEqual(80);
		const texts = [...h.ctx.ui.notify.mock.calls.map((c: any[]) => String(c[0])), ...widget.mock.calls.flatMap((c: any[]) => Array.isArray(c[1]) ? c[1] : [])];
		expect(texts.filter(t => /appl|pending|setting/i.test(t))).toEqual([]);
	});

	it("clears the checking line when the send is refused", async () => {
		const h = harness("normal", { acp: "wrong-ack" });
		const widget = h.ctx.ui.setWidget as ReturnType<typeof vi.fn>;
		await run(h, "first");
		expect(widget.mock.calls.filter((c: any[]) => c[0] === "rbf-agy-checking").map((c: any[]) => c[1])).toEqual([["AGY — checking conversation"], undefined]);
	});
});

describe("pi-21.3 ACP session settings file", () => {
	const settingsFile = (json: string) => { const dir = mkdtempSync(join(roots!, "policy-")), file = join(dir, "settings.json"); writeFileSync(file, json, { mode: 0o600 }); return file; };

	it("starts `acp --sandbox` for enableTerminalSandbox: true", async () => {
		const h = harness("normal", { acp: "", policy: settingsFile('{"enableTerminalSandbox":true}') });
		await run(h, "Hello");
		expect(launches(h).map(l => l.args)).toEqual([["acp", "--sandbox"]]);
	});

	it("starts plain `acp` for enableTerminalSandbox: false", async () => {
		const h = harness("normal", { acp: "", policy: settingsFile('{"enableTerminalSandbox":false}') });
		await run(h, "Hello");
		expect(launches(h).map(l => l.args)).toEqual([["acp"]]);
		expect(recordsOf(h, AGY_ACP_DISPATCH)[0].data.policyHash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("refuses any other key, naming it, before AGY starts", async () => {
		const h = harness("normal", { acp: "", policy: settingsFile('{"enableTerminalSandbox":true,"toolPermission":"proceed","agentMode":"accept-edits"}') });
		const { message } = await run(h, "Hello");
		expect(shown(message)).toBe(ACP_COPY.policyKeys(["toolPermission", "agentMode"]));
		expect(launches(h)).toEqual([]);
	});

	it("builds its arguments from the policy and escapes odd key names", () => {
		const odd = '{"a\\u001b[2Jb":1}';
		expect(() => acpPolicyArgs({ path: "/x", hash: "h", json: odd, sandbox: false })).toThrow(/a.*b/);
		expect(() => acpPolicyArgs({ path: "/x", hash: "h", json: odd, sandbox: false })).not.toThrow(/\u001b/);
		expect(acpPolicyArgs(undefined)).toEqual([]);
	});
});

describe("pi-21.3 ACP loss, limits and cleanup", () => {
	it("passes a tool output of 600 KB carried twice", async () => {
		const h = harness("normal", { acp: "" }), { message } = await run(h, "[big] go");
		expect(message.stopReason).toBe("stop");
		expect(streamedText(message)).toBe("big ok");
	});

	it("ends the owner as lost for a frame over 2 MiB, with the uncertain-outcome copy and a stop disclosure, and refuses the next message", async () => {
		const h = harness("normal", { acp: "" }), { message } = await run(h, "[oversize] go");
		expect(message.stopReason).toBe("error");
		expect(shown(message)).toContain(ACP_COPY.lost);
		expect(shown(message)).toContain(AGY_COPY.stopUnknown);
		await h.persist(message);
		expect(recordsOf(h, AGY_ACP_COMPLETION)).toEqual([]);
		const next = await run(h, "Try again");
		expect(shown(next.message)).toBe(AGY_COPY.ended);
		expect(received(h, "session/prompt")).toHaveLength(1);
	});

	it("keeps the visible partial answer when AGY exits mid-turn, and never resends", async () => {
		const h = harness("normal", { acp: "" }), { message } = await run(h, "[exit] go");
		expect(message.stopReason).toBe("error");
		expect(shown(message)).toContain(ACP_COPY.lost);
		expect(received(h, "session/prompt")).toHaveLength(1);
	});

	it.each([
		["[maxtokens] go", "length", "length", "cut off"],
		["[max-requests] go", "length", "length", "cut off"],
		["[refusal] go", "error", "refusal", ""],
	])("maps definite stop result %s to completion (%s/%s) and keeps the ACP session open", async (promptText, stopReason, outcome, text) => {
		const h = harness("normal", { acp: "" }), { message } = await run(h, promptText);
		expect(message.stopReason).toBe(stopReason);
		expect(streamedText(message)).toBe(text);
		if (outcome === "refusal") expect(shown(message)).toBe("AGY refused this request.");
		else expect(message.errorMessage).toBeUndefined();
		await h.persist(message);
		const [completion] = recordsOf(h, AGY_ACP_COMPLETION);
		expect(completion.data.outcome).toBe(outcome);
		const next = await run(h, "Follow up");
		expect(next.message.stopReason).toBe("stop");
		expect(launches(h)).toHaveLength(1);
		expect(received(h, "session/new")).toHaveLength(1);
		expect(received(h, "session/prompt")).toHaveLength(2);
	});

	it("advertises maxTokens: 0 on fresh and cached AGY models so Pi 1.5.0 does not emit context_edit on stopReason: length", async () => {
		const fresh = toAgyProviderModel(parseAgyCatalogue(inventory)[0]);
		expect(fresh.maxTokens).toBe(0);
		expect(fresh.contextWindow).toBe(1000000000);
		const h = harness("normal", { acp: "" });
		await h.ready;
		const cached = await h.registration.refreshModels({ allowNetwork: false, stored: { models: [{ ...fresh, maxTokens: 1000000000 }] } });
		expect(cached).toHaveLength(1);
		expect(cached[0].maxTokens).toBe(0);
	});

	it("retires the child with unsupportedStop when AGY returns an unrecognized stopReason", async () => {
		const root = mkdtempSync(join(roots!, "acp-unknown-stop-"));
		const h = harness("normal", { root, acp: "" });
		const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "test-support/fixtures/acp-1.5.3.json"), "utf8"));
		writeFileSync(join(root, "fake-agy.cjs"), `#!${process.execPath}
const fixture = ${JSON.stringify(fixture)};
const send = f => process.stdout.write(JSON.stringify(f) + "\\n");
let buf = "";
process.stdin.on("data", d => {
	buf += d;
	let i;
	while ((i = buf.indexOf("\\n")) >= 0) {
		const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
		if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: fixture.initialize });
		else if (m.method === "session/new") send({ jsonrpc: "2.0", id: m.id, result: { ...fixture.sessionNew, sessionId: "acp-custom-1" } });
		else if (m.method === "session/set_config_option") {
			const opts = fixture.sessionNew.configOptions.map(o => o.id === m.params.configId ? { ...o, currentValue: m.params.value } : o);
			fixture.sessionNew.configOptions = opts;
			send({ jsonrpc: "2.0", id: m.id, result: { configOptions: opts } });
		}
		else if (m.method === "session/prompt") send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "mystery_stop", usage: fixture.usage } });
	}
});
process.stdin.on("end", () => process.exit(0));
`, { mode: 0o700 });
		const { message } = await run(h, "Hello");
		expect(message.stopReason).toBe("error");
		expect(shown(message)).toContain(ACP_COPY.unsupportedStop("mystery_stop"));
		await h.persist(message);
		expect(recordsOf(h, AGY_ACP_COMPLETION)).toEqual([]);
	});

	it("keeps what AGY streamed as the message content and leaves it out of the error message", async () => {
		const h = harness("normal", { acp: "" }), { message } = await run(h, "[diverge] go");
		expect(message.content).toEqual([{ type: "text", text: "Answered anyway." }]);
		expect(message.errorMessage).toContain(ACP_COPY.diverged);
		expect(message.errorMessage).not.toContain("Answered anyway.");
	});

	it("asks AGY for nothing more when the answer exceeds the output limit", async () => {
		const h = harness("normal", { acp: "" }), { message } = await run(h, "[huge] go");
		expect(shown(message)).toContain("AGY response exceeded the supported output limit");
	});

	it("closes the child with stdin at shutdown and when another provider is selected", async () => {
		const a = harness("normal", { acp: "" });
		await run(a, "Hello");
		await a.close();
		expect(a.logs().some(x => x.eof)).toBe(true);
		const b = harness("normal", { acp: "" });
		await run(b, "Hello");
		await b.select({ ...b.ctx.model, provider: "other", id: "other-model" });
		await vi.waitFor(() => expect(b.logs().some(x => x.eof)).toBe(true));
	});

	it("asks AGY to close the session before it closes stdin, at shutdown and when another provider is selected, so AGY stops its subagents and background tasks", async () => {
		const closedBeforeEof = (h: Harness) => {
			const rows = h.logs(), sessionId = rows.find(x => x.out?.result?.sessionId)?.out.result.sessionId;
			const asked = rows.findIndex(x => x.in?.method === "session/close"), replied = rows.findIndex(x => asked >= 0 && x.out?.id === rows[asked].in.id), eof = rows.findIndex(x => x.eof);
			return { sessionId, params: rows[asked]?.in.params, ordered: asked >= 0 && replied > asked && eof > replied, count: rows.filter(x => x.in?.method === "session/close").length };
		};
		const a = harness("normal", { acp: "" });
		await run(a, "Hello");
		await a.close();
		expect(closedBeforeEof(a)).toEqual({ sessionId: expect.stringMatching(/^fake-acp-/), params: { sessionId: expect.stringMatching(/^fake-acp-/) }, ordered: true, count: 1 });
		expect(closedBeforeEof(a).params.sessionId).toBe(closedBeforeEof(a).sessionId);
		const b = harness("normal", { acp: "" });
		await run(b, "Hello");
		await b.select({ ...b.ctx.model, provider: "other", id: "other-model" });
		await vi.waitFor(() => expect(b.logs().some(x => x.eof)).toBe(true));
		expect(closedBeforeEof(b)).toMatchObject({ ordered: true, count: 1 });
	});

	it("still retires a chat whose AGY never answers session/close, within the stop limits", async () => {
		const h = harness("normal", { acp: "close-no-reply" });
		await run(h, "Hello");
		const started = Date.now();
		await h.close();
		expect(Date.now() - started).toBeLessThan(8000);
		expect(received(h, "session/close")).toHaveLength(1);
		expect(h.logs().some(x => x.eof)).toBe(true);
	}, 20000);

	it("sends session/cancel on mid-turn abort, saves a cancelled completion, keeps the child alive, and continues the same session", async () => {
		const h = harness("normal", { acp: "" }), controller = new AbortController();
		const pending = run(h, "[hold] go", { signal: controller.signal });
		await vi.waitFor(() => expect(h.logs().some(x => x.out?.params?.update?.sessionUpdate === "user_message_chunk")).toBe(true));
		controller.abort();
		const { message } = await pending;
		expect(message.stopReason).toBe("aborted");
		expect(shown(message)).toContain("AGY request cancelled.");
		expect(received(h, "session/cancel")).toHaveLength(1);
		await h.persist(message);
		expect(recordsOf(h, AGY_ACP_COMPLETION)).toHaveLength(1);
		expect(recordsOf(h, AGY_ACP_COMPLETION)[0].data.outcome).toBe("cancelled");
		expect(h.logs().some(x => x.eof)).toBe(false);
		const next = await run(h, "After cancel");
		expect(next.message.stopReason).toBe("stop");
		expect(launches(h)).toHaveLength(1);
		expect(received(h, "session/prompt")).toHaveLength(2);
	});

	it("anchors aborted completion and pre-send refusal when Pi 1.5.0 overwrites errorMessage to Operation aborted, while rejecting arbitrary tampering", async () => {
		// 1. Mid-turn cancel with InteractiveMode overwriting errorMessage to "Operation aborted"
		const mid = harness("normal", { acp: "" }), midAbort = new AbortController();
		const midPending = run(mid, "[hold] go", { signal: midAbort.signal });
		await vi.waitFor(() => expect(mid.logs().some(x => x.out?.params?.update?.sessionUpdate === "user_message_chunk")).toBe(true));
		midAbort.abort();
		const { message: midMsg } = await midPending;
		expect(midMsg.stopReason).toBe("aborted");
		expect(mid.ctx.ui.notify).toHaveBeenCalledWith("AGY request cancelled.", "warning");
		midMsg.errorMessage = "Operation aborted";
		await mid.persist(midMsg);
		expect(recordsOf(mid, AGY_ACP_COMPLETION)).toHaveLength(1);
		expect(recordsOf(mid, AGY_ACP_COMPLETION)[0].data.outcome).toBe("cancelled");
		const midNextUser = mid.append({ type: "message", message: { role: "user", content: [{ type: "text", text: "Check recovery" }], timestamp: Date.now() } });
		expect(selectAcpRecoveryAnchor(readSavedSession(mid.ctx.sessionManager, realpathSync(mid.root)), midNextUser.id)?.completion?.id).toBe(recordsOf(mid, AGY_ACP_COMPLETION)[0].id);

		// 2. Pre-send Esc with InteractiveMode overwriting errorMessage to "Operation aborted"
		const pre = harness("normal", { acp: "hold-set" }), preAbort = new AbortController();
		const prePending = run(pre, "first", { signal: preAbort.signal });
		await vi.waitFor(() => expect(received(pre, "session/set_config_option").length).toBeGreaterThan(0));
		preAbort.abort();
		const { message: preMsg } = await prePending;
		expect(preMsg.stopReason).toBe("aborted");
		preMsg.errorMessage = "Operation aborted";
		await pre.persist(preMsg);
		expect(recordsOf(pre, AGY_ACP_REFUSAL)).toHaveLength(1);
		const preNextUser = pre.append({ type: "message", message: { role: "user", content: [{ type: "text", text: "Check pre recovery" }], timestamp: Date.now() } });
		expect(selectAcpRecoveryAnchor(readSavedSession(pre.ctx.sessionManager, realpathSync(pre.root)), preNextUser.id)?.conversation?.id).toBe(recordsOf(pre, AGY_ACP_CONVERSATION)[0].id);

		// 3. Arbitrary tampered errorMessage on an aborted message is still rejected
		const tampered = harness("normal", { acp: "" }), tamperedAbort = new AbortController();
		const tamperedPending = run(tampered, "[hold] go", { signal: tamperedAbort.signal });
		await vi.waitFor(() => expect(tampered.logs().some(x => x.out?.params?.update?.sessionUpdate === "user_message_chunk")).toBe(true));
		tamperedAbort.abort();
		const { message: tamperedMsg } = await tamperedPending;
		tamperedMsg.errorMessage = "Tampered error";
		await tampered.persist(tamperedMsg);
		expect(recordsOf(tampered, AGY_ACP_COMPLETION)).toEqual([]);
	});

	it("retires the child with cancel-timeout copy when AGY ignores session/cancel, writes no completion, and refuses further sends", async () => {
		const h = harness("normal", { acp: "cancel-timeout", cancelGraceMs: 100 }), controller = new AbortController();
		const pending = run(h, "[hold] go", { signal: controller.signal });
		await vi.waitFor(() => expect(h.logs().some(x => x.out?.params?.update?.sessionUpdate === "user_message_chunk")).toBe(true));
		controller.abort();
		const { message } = await pending;
		expect(message.stopReason).toBe("error");
		expect(shown(message)).toContain(ACP_COPY.cancelTimeout);
		expect(shown(message)).toContain(AGY_COPY.stopUnknown);
		await h.persist(message);
		expect(recordsOf(h, AGY_ACP_COMPLETION)).toEqual([]);
		await vi.waitFor(() => expect(h.logs().some(x => x.eof)).toBe(true));
		const next = await run(h, "Try again");
		expect(shown(next.message)).toBe(AGY_COPY.ended);
		await h.close();
		const reopened = harness("normal", { root: h.root, acp: "" });
		await reopened.ready;
		expect(shown((await run(reopened, "After reload")).message)).toBe(RECOVERY_COPY.unknown);
	});
});

describe("pi-21.3 ACP resume", { timeout: 20000 }, () => {
	const flashOrSonnet = (id: string) => full(toAgyProviderModel(parseAgyCatalogue(inventory).find(m => m.id === id)!));
	const methodsOf = (rows: any[]) => rows.filter(r => r.in).map(r => r.in.method as string);
	const callsOf = (rows: any[], method: string) => rows.filter(r => r.in?.method === method).map(r => r.in);
	const pairOf = (rows: any[]) => callsOf(rows, "session/set_config_option").map(m => [m.params.configId, m.params.value]);
	/** What Pi does on /reload or a restart: the old provider shuts down, a new one opens the same saved session. `since()` is only what the new one did. */
	async function reload(first: Harness, opts: { acp?: string; policy?: string } = {}) {
		await first.close();
		const mark = first.logs().length, next = harness("normal", { root: first.root, acp: opts.acp ?? "", policy: opts.policy });
		await next.ready;
		return { next, since: () => next.logs().slice(mark) };
	}
	/** Rewrites the saved file as an editor would, then re-links the entries after any that were removed. */
	function edit(h: Harness, change: (entries: any[]) => any[]) {
		const file = join(h.root, "pi.jsonl"), [header, ...lines] = readFileSync(file, "utf8").trim().split("\n"), kept = change(lines.map(l => JSON.parse(l)));
		let parent: string | null = null;
		const relinked = kept.map(e => { const out = { ...e, parentId: parent }; parent = e.id; return out; });
		writeFileSync(file, [header, ...relinked.map(e => JSON.stringify(e))].join("\n") + "\n");
	}
	const finished = async (h: Harness, text: string, extra: any = {}) => { const out = await run(h, text, extra); await h.persist(out.message); return out; };
	const settingsFile = (json: string) => { const dir = mkdtempSync(join(roots!, "resume-policy-")), file = join(dir, "settings.json"); writeFileSync(file, json, { mode: 0o600 }); return file; };
	const image = { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "what is this" }] };

	it("starts nothing when a saved ACP chat is opened, then on the first send resumes the saved session once, sets both options and sends one prompt", async () => {
		const first = harness("normal", { acp: "" });
		await finished(first, "First question");
		const [conversation] = recordsOf(first, AGY_ACP_CONVERSATION), [completion] = recordsOf(first, AGY_ACP_COMPLETION);
		const { next, since } = await reload(first);
		expect(since()).toEqual([]);
		const turn = await finished(next, "Second question");
		expect(turn.message.stopReason).toBe("stop");
		const rows = since();
		expect(rows.filter(r => r.args).map(r => r.args)).toEqual([["acp"]]);
		expect(methodsOf(rows)).toEqual(["initialize", "session/resume", "session/set_config_option", "session/set_config_option", "session/prompt"]);
		expect(callsOf(rows, "session/resume")[0].params).toEqual({ sessionId: conversation.data.acpSessionId, cwd: realpathSync(first.root), mcpServers: [] });
		expect(callsOf(rows, "session/prompt")[0].params.sessionId).toBe(conversation.data.acpSessionId);
		expect(pairOf(rows)).toEqual([["model", "gemini-3.8-flash"], ["thought_level", "high"]]);
		// No second conversation record, no cold-start notice, no "resumed" line: the answer and the footer are all Tom sees.
		expect(recordsOf(next, AGY_ACP_CONVERSATION)).toHaveLength(1);
		expect(recordsOf(next, AGY_ACP_DISPATCH).at(-1)!.data).toMatchObject({ acpSessionId: conversation.data.acpSessionId, previousCompletionId: completion.id });
		expect(next.ctx.ui.notify).not.toHaveBeenCalled();
		// The third turn rides the live owner.
		await finished(next, "Third question");
		expect(callsOf(next.logs(), "session/resume")).toHaveLength(1);
		expect(launches(next).length).toBe(2);
	});

	// Cold review F2. Pi queues a message typed while AGY works and sends it to the provider after the turn's answer is saved, before agent_end.
	// It used to end the chat: no completion for the running turn, a retired owner, and 'unknown outcome' after a restart.
	it("refuses a message typed while AGY works with nothing sent, still writes the running turn's completion, continues the chat, and resumes after a restart", async () => {
		const h = harness("normal", { acp: "" });
		const first = await run(h, "First question");
		await h.emit("message_end", { message: first.message });
		const firstEntry = h.append({ type: "message", message: first.message });
		const typed = await run(h, "Typed while AGY works"); // the typed message is saved (by run) and then offered to the provider
		expect(shown(typed.message)).toBe(AGY_COPY.busy);
		await h.emit("message_end", { message: typed.message });
		const typedEntry = h.append({ type: "message", message: typed.message });
		await h.emit("agent_end", { messages: [first.message, typed.message] });
		// Nothing was sent for the typed message; the owner and the running turn are kept.
		expect(received(h, "session/prompt").map(m => m.params.prompt[0].text)).toEqual(["First question"]);
		expect(h.logs().some(x => x.eof)).toBe(false);
		const [dispatch] = recordsOf(h, AGY_ACP_DISPATCH), [completion] = recordsOf(h, AGY_ACP_COMPLETION), [refusal] = recordsOf(h, AGY_ACP_REFUSAL);
		expect(completion.data).toMatchObject({ dispatchId: dispatch.id, assistantId: firstEntry.id, outcome: "stop" });
		const typedUser = h.entries.find(e => e.type === "message" && e.message.role === "user" && body(e.message) === "Typed while AGY works");
		expect(refusal.data).toMatchObject({ dispatchId: dispatch.id, completionId: null, userId: typedUser.id, assistantId: typedEntry.id });
		expect(acpRecords(h)).toEqual([AGY_ACP_CONVERSATION, AGY_ACP_DISPATCH, AGY_ACP_REFUSAL, AGY_ACP_COMPLETION]);
		expect(h.ctx.ui.notify).not.toHaveBeenCalledWith(AGY_COPY.branch, expect.anything());
		// The next message continues the same chat.
		const third = await finished(h, "Third question");
		expect(third.message.stopReason).toBe("stop");
		expect(received(h, "session/prompt").map(m => m.params.prompt[0].text)).toEqual(["First question", "Third question"]);
		expect(launches(h)).toHaveLength(1);
		expect(recordsOf(h, AGY_ACP_DISPATCH).at(-1)!.data.previousCompletionId).toBe(completion.id);
		// A restart resumes the saved session.
		const { next, since } = await reload(h);
		const fourth = await finished(next, "After restart");
		expect(fourth.message.stopReason).toBe("stop");
		expect(callsOf(since(), "session/resume")).toHaveLength(1);
		expect(callsOf(since(), "session/resume")[0].params.sessionId).toBe(recordsOf(h, AGY_ACP_CONVERSATION)[0].data.acpSessionId);
		expect(recordsOf(next, AGY_ACP_COMPLETION)).toHaveLength(3);
	});

	it("keeps the chat when two messages were typed while AGY works", async () => {
		const h = harness("normal", { acp: "" });
		const first = await run(h, "First question");
		await h.emit("message_end", { message: first.message });
		h.append({ type: "message", message: first.message });
		const typed = await run(h, "Typed one");
		await h.emit("message_end", { message: typed.message });
		h.append({ type: "message", message: typed.message });
		const again = await run(h, "Typed two");
		await h.emit("message_end", { message: again.message });
		h.append({ type: "message", message: again.message });
		await h.emit("agent_end", { messages: [first.message, typed.message, again.message] });
		expect(acpRecords(h)).toEqual([AGY_ACP_CONVERSATION, AGY_ACP_DISPATCH, AGY_ACP_REFUSAL, AGY_ACP_REFUSAL, AGY_ACP_COMPLETION]);
		expect(h.logs().some(x => x.eof)).toBe(false);
		const next = await finished(h, "Third question");
		expect(next.message.stopReason).toBe("stop");
		const { next: restarted, since } = await reload(h);
		expect((await finished(restarted, "After restart")).message.stopReason).toBe("stop");
		expect(callsOf(since(), "session/resume")).toHaveLength(1);
	});

	it("keeps asking only for the checking line while it resumes", async () => {
		const first = harness("normal", { acp: "" });
		await finished(first, "First question");
		const { next } = await reload(first);
		await finished(next, "Second question");
		const widgetCalls = next.ctx.ui.setWidget.mock.calls.filter((c: any[]) => c[0] === "rbf-agy-checking").map((c: any[]) => c[1]);
		expect(widgetCalls).toEqual([["AGY — checking conversation"], undefined]);
	});

	it("carries a model and thinking change made after the last answer across a reload: one resume, both options, one prompt, other extensions' entries left alone", async () => {
		const first = harness("normal", { acp: "" });
		await finished(first, "First question");
		// /model and /thinking: Pi's events and the entries it saves, with another extension's entries between.
		first.append({ type: "custom", customType: "rbf-cache-guardian/state", data: { warmedAt: 1 } });
		await first.select(flashOrSonnet("gemini-4-hydrogen"));
		first.append({ type: "model_change", provider: AGY_PROVIDER, modelId: "gemini-4-hydrogen" });
		await first.emit("thinking_level_select", { level: "low", previousLevel: "high" });
		first.append({ type: "thinking_level_change", thinkingLevel: "low" });
		first.append({ type: "custom", customType: "some-other-extension", data: {} });
		const changed = await finished(first, "Second question", { reasoning: "low" });
		expect(changed.message.model).toBe("gemini-4-hydrogen");
		const { next, since } = await reload(first);
		await next.select(flashOrSonnet("gemini-4-hydrogen"));
		const turn = await finished(next, "Third question", { reasoning: "low" });
		expect(turn.message.stopReason).toBe("stop");
		const rows = since();
		expect(callsOf(rows, "session/resume")).toHaveLength(1);
		expect(callsOf(rows, "session/new")).toHaveLength(0);
		expect(pairOf(rows)).toEqual([["model", "gemini-4-hydrogen"], ["thought_level", "low"]]);
		expect(callsOf(rows, "session/prompt")).toHaveLength(1);
		expect(recordsOf(next, AGY_ACP_DISPATCH).at(-1)!.data).toMatchObject({ model: "gemini-4-hydrogen", effort: "low" });
	});

	it.each([["usage", { type: "usage" }], ["context_edit", { type: "context_edit" }], ["compaction", { type: "compaction", summary: "s", firstKeptEntryId: "x", tokensBefore: 1 }]])("refuses a chat that holds a Pi %s entry after its conversation, with no child started", async (_name, entry) => {
		const first = harness("normal", { acp: "" });
		await finished(first, "First question");
		first.append(entry);
		const { next, since } = await reload(first);
		const { message } = await run(next, "Second question");
		expect(shown(message)).toBe(RECOVERY_COPY.mismatch);
		expect(since()).toEqual([]);
	});

	describe("a saved chain that does not hold", () => {
		it("refuses a chat whose last answer lost its completion record: the earlier work has an unknown outcome", async () => {
			const first = harness("normal", { acp: "" });
			await finished(first, "First question");
			await first.close();
			edit(first, es => es.filter(e => e.customType !== AGY_ACP_COMPLETION));
			const { next, since } = await reload(first);
			const { message } = await run(next, "Second question");
			expect(shown(message)).toBe(RECOVERY_COPY.unknown);
			expect(since()).toEqual([]);
		});

		it("refuses a chat that lost the completion of an earlier turn and went on", async () => {
			const first = harness("normal", { acp: "" });
			await finished(first, "First question");
			await finished(first, "Second question");
			await first.close();
			edit(first, es => es.filter(e => e.id !== recordsOf(first, AGY_ACP_COMPLETION)[0].id));
			const { next, since } = await reload(first);
			const { message } = await run(next, "Third question");
			expect(shown(message)).toBe(RECOVERY_COPY.mismatch);
			expect(since()).toEqual([]);
		});

		it("refuses a chat whose saved answer was edited, and one whose answer text no longer matches the completion", async () => {
			const first = harness("normal", { acp: "" });
			await finished(first, "First question");
			await first.close();
			edit(first, es => es.map(e => e.type === "message" && e.message.role === "assistant" ? { ...e, message: { ...e.message, content: [{ type: "text", text: "edited" }] } } : e));
			const { next, since } = await reload(first);
			const { message } = await run(next, "Second question");
			expect(shown(message)).toBe(RECOVERY_COPY.mismatch);
			expect(since()).toEqual([]);
		});

		it("refuses a chat that has a prompt dispatched and no answer, as when Pi was killed mid-turn", async () => {
			const first = harness("normal", { acp: "" });
			await finished(first, "First question");
			const turn = run(first, "[hold] second");
			await vi.waitFor(() => expect(received(first, "session/prompt")).toHaveLength(2));
			await first.close();
			writeFileSync(join(first.root, "release"), "go");
			await turn.catch(() => undefined);
			const { next, since } = await reload(first);
			const { message } = await run(next, "Third question");
			expect(shown(message)).toBe(RECOVERY_COPY.unknown);
			expect(since()).toEqual([]);
		});

		it("refuses an ACP chat whose conversation record names another folder or Pi session", async () => {
			const first = harness("normal", { acp: "" });
			await finished(first, "First question");
			await first.close();
			edit(first, es => es.map(e => e.customType === AGY_ACP_CONVERSATION ? { ...e, data: { ...e.data, cwd: "/elsewhere" } } : e));
			const { next, since } = await reload(first);
			expect(shown((await run(next, "Second question")).message)).toBe(RECOVERY_COPY.mismatch);
			expect(since()).toEqual([]);
		});
	});

	describe("after refusals that sent nothing", () => {
		it("resumes once and sends one prompt after: an image, a /goal, a between-turn request, and a settings change that was refused and restored", async () => {
			const settings = '{"enableTerminalSandbox":false}', file = settingsFile(settings);
			const first = harness("normal", { acp: "", policy: file });
			await finished(first, "First question");
			const acpSessionId = recordsOf(first, AGY_ACP_CONVERSATION)[0].data.acpSessionId;

			const imageRefusal = await run(first, "ignored", {}, image);
			expect(shown(imageRefusal.message)).toBe("AGY accepts text-only tasks. Your message was not sent. Remove images and send a new request.");
			await first.persist(imageRefusal.message);

			const goalRefusal = await run(first, "/goal finish the report");
			expect(shown(goalRefusal.message)).toBe(ACP_COPY.agyCommand("goal"));
			await first.persist(goalRefusal.message);

			// A second answered turn. Records for a command AGY asked to run during a turn come with the tasks that write them; the chain's acceptance of them is covered in agy-acp-recovery.test.ts.
			await finished(first, "A second question");

			// A request that arrived with no message running.
			first.append({ type: "custom", customType: AGY_ACP_PERMISSION, data: { acpSessionId, inputEntryId: null } });

			// The settings file changes: the send is refused. Then the file is put back.
			writeFileSync(file, '{"enableTerminalSandbox":true}', { mode: 0o600 });
			const policyRefusal = await run(first, "After the settings change");
			expect(shown(policyRefusal.message)).toBe(AGY_COPY.policy);
			await first.persist(policyRefusal.message);
			writeFileSync(file, settings, { mode: 0o600 });
			await finished(first, "After the file was restored");

			expect(recordsOf(first, AGY_ACP_REFUSAL)).toHaveLength(3);
			for (const record of recordsOf(first, AGY_ACP_REFUSAL)) expect(record.data.policyHash).toBe(recordsOf(first, AGY_ACP_DISPATCH)[0].data.policyHash);

			const { next, since } = await reload(first, { policy: file });
			const turn = await finished(next, "After the reload");
			expect(turn.message.stopReason).toBe("stop");
			const rows = since();
			expect(callsOf(rows, "session/resume")).toHaveLength(1);
			expect(callsOf(rows, "session/resume")[0].params.sessionId).toBe(acpSessionId);
			expect(callsOf(rows, "session/prompt")).toHaveLength(1);
			expect(callsOf(rows, "session/new")).toHaveLength(0);
		});

		it("refuses a refused pair whose refusal record was removed", async () => {
			const first = harness("normal", { acp: "" });
			await finished(first, "First question");
			const refused = await run(first, "/goal x");
			await first.persist(refused.message);
			await first.close();
			edit(first, es => es.filter(e => e.customType !== AGY_ACP_REFUSAL));
			const { next, since } = await reload(first);
			expect(shown((await run(next, "After the reload")).message)).toBe(RECOVERY_COPY.mismatch);
			expect(since()).toEqual([]);
		});

		it("resumes the empty session of a chat whose only message was refused after session/new", async () => {
			const first = harness("normal", { acp: "lacks-flash" });
			const refused = await run(first, "Hello");
			expect(shown(refused.message)).toBe(ACP_COPY.unsupported);
			await first.persist(refused.message);
			expect(recordsOf(first, AGY_ACP_REFUSAL)[0].data.completionId).toBeNull();
			const { next, since } = await reload(first);
			const turn = await finished(next, "Hello again");
			expect(turn.message.stopReason).toBe("stop");
			const rows = since();
			expect(callsOf(rows, "session/resume")).toHaveLength(1);
			expect(callsOf(rows, "session/prompt")).toHaveLength(1);
			expect(recordsOf(next, AGY_ACP_DISPATCH)[0].data.previousCompletionId).toBeNull();
		});

		it("records a refusal that comes before any owner exists: an image sent first after a reload leaves a chat that still resumes", async () => {
			const first = harness("normal", { acp: "" });
			await finished(first, "First question");
			const { next } = await reload(first);
			const refused = await run(next, "ignored", {}, image);
			expect(shown(refused.message)).toContain("text-only");
			await next.persist(refused.message);
			expect(recordsOf(next, AGY_ACP_REFUSAL)).toHaveLength(1);
			expect(launches(next).length).toBe(1); // only the first process's child
			const again = await reload(next);
			const turn = await finished(again.next, "After the second reload");
			expect(turn.message.stopReason).toBe("stop");
			expect(callsOf(again.since(), "session/resume")).toHaveLength(1);
		});
	});

	describe("when AGY cannot resume", () => {
		it.each([["refuses the session", "resume-fails"], ["answers with another session", "resume-wrong-id"], ["cannot resume at all", "no-resume"]])("shows the unavailable copy, sends nothing and keeps the chat resumable when AGY %s", async (_name, mode) => {
			const first = harness("normal", { acp: "" });
			await finished(first, "First question");
			const { next, since } = await reload(first, { acp: mode });
			const refused = await run(next, "Second question");
			expect(shown(refused.message)).toBe(RECOVERY_COPY.unavailable);
			expect(callsOf(since(), "session/prompt")).toEqual([]);
			await next.persist(refused.message);
			expect(recordsOf(next, AGY_ACP_REFUSAL)).toHaveLength(1);
			await vi.waitFor(() => expect(since().some(r => r.eof)).toBe(true));
			const again = await reload(next);
			const turn = await finished(again.next, "Third question");
			expect(turn.message.stopReason).toBe("stop");
			expect(callsOf(again.since(), "session/resume")).toHaveLength(1);
		});

		it("starts no child for a settings file that differs from the one the chat ran with", async () => {
			const file = settingsFile('{"enableTerminalSandbox":false}');
			const first = harness("normal", { acp: "", policy: file });
			await finished(first, "First question");
			const other = settingsFile('{"enableTerminalSandbox":true}');
			const { next, since } = await reload(first, { policy: other });
			const refused = await run(next, "Second question");
			expect(shown(refused.message)).toBe(AGY_COPY.policy);
			expect(since()).toEqual([]);
			await next.persist(refused.message);
			expect(recordsOf(next, AGY_ACP_REFUSAL).at(-1)!.data.policyHash).toBe(recordsOf(first, AGY_ACP_DISPATCH)[0].data.policyHash);
			const back = await reload(next, { policy: file });
			expect((await finished(back.next, "Third question")).message.stopReason).toBe("stop");
			expect(callsOf(back.since(), "session/resume")).toHaveLength(1);
		});

		it("does not resume inside the same Pi session after the child was lost", async () => {
			const first = harness("normal", { acp: "" });
			await finished(first, "First question");
			const lost = await run(first, "[exit] go");
			expect(lost.message.stopReason).toBe("error");
			await first.persist(lost.message);
			const after = await run(first, "Next");
			expect(shown(after.message)).toBe(AGY_COPY.ended);
			expect(callsOf(first.logs(), "session/resume")).toEqual([]);
		});
	});

	it("cancels a send when a real /model entry is saved while the pair is being checked: the cancel copy, the owner kept, no branch error", async () => {
		const h = harness("normal", { acp: "hold-set" });
		const pending = run(h, "first");
		await vi.waitFor(() => expect(received(h, "session/set_config_option").length).toBeGreaterThan(0));
		await h.select(flashOrSonnet("gemini-4-hydrogen"));
		h.append({ type: "model_change", provider: AGY_PROVIDER, modelId: "gemini-4-hydrogen" });
		writeFileSync(join(h.root, "release"), "go");
		const cancelled = await pending;
		expect(shown(cancelled.message)).toBe(ACP_COPY.changeCancelled);
		expect(received(h, "session/prompt")).toEqual([]);
		await h.persist(cancelled.message);
		expect(h.logs().some(x => x.eof)).toBe(false);
		expect(recordsOf(h, AGY_ACP_REFUSAL)).toHaveLength(1);
	});

	it("records a refusal for pre-send Esc during hold-set and resumes cleanly after reload", async () => {
		const first = harness("normal", { acp: "hold-set" }), controller = new AbortController();
		const pending = run(first, "first", { signal: controller.signal });
		await vi.waitFor(() => expect(received(first, "session/set_config_option").length).toBeGreaterThan(0));
		controller.abort();
		const cancelled = await pending;
		expect(cancelled.message.stopReason).toBe("aborted");
		expect(shown(cancelled.message)).toBe("AGY request cancelled before input. Your message was not sent.");
		expect(received(first, "session/prompt")).toEqual([]);
		await first.persist(cancelled.message);
		expect(recordsOf(first, AGY_ACP_REFUSAL)).toHaveLength(1);
		const { next, since } = await reload(first);
		const turn = await finished(next, "After Esc reload");
		expect(turn.message.stopReason).toBe("stop");
		expect(callsOf(since(), "session/resume")).toHaveLength(1);
		expect(callsOf(since(), "session/prompt")).toHaveLength(1);
	});

	it("shows ACP_COPY.signIn on session/new and session/resume, retires the child, and saves a refusal on resume", async () => {
		const fresh = harness("normal", { acp: "signin-fails" });
		const freshOut = await run(fresh, "Hello");
		expect(freshOut.message.stopReason).toBe("error");
		expect(shown(freshOut.message)).toBe(ACP_COPY.signIn);
		expect(received(fresh, "session/prompt")).toEqual([]);
		await vi.waitFor(() => expect(fresh.logs().some(x => x.eof)).toBe(true));

		const first = harness("normal", { acp: "" });
		await finished(first, "First question");
		const { next, since } = await reload(first, { acp: "signin-fails" });
		const refused = await run(next, "Second question");
		expect(shown(refused.message)).toBe(ACP_COPY.signIn);
		expect(callsOf(since(), "session/prompt")).toEqual([]);
		await next.persist(refused.message);
		expect(recordsOf(next, AGY_ACP_REFUSAL)).toHaveLength(1);
		await vi.waitFor(() => expect(since().some(r => r.eof)).toBe(true));
		const again = await reload(next);
		const turn = await finished(again.next, "Third question");
		expect(turn.message.stopReason).toBe("stop");
		expect(callsOf(again.since(), "session/resume")).toHaveLength(1);
	});

	it("drops replayed tool updates during session/new and session/resume without writing activity records", async () => {
		const first = harness("normal", { acp: "replay-tools" });
		await finished(first, "Hello");
		expect(recordsOf(first, AGY_ACP_ACTIVITY)).toEqual([]);
		const { next } = await reload(first, { acp: "replay-tools" });
		await finished(next, "Again");
		expect(recordsOf(next, AGY_ACP_ACTIVITY)).toEqual([]);
	});
});

describe("pi-21.3 ACP approvals, questions, client powers, and activity", () => {
	const plainTheme = { fg: (_role: string, text: string) => text } as any;
	const registeredRenderer = (h: Harness, customType: string) => {
		const call = (h.pi.registerEntryRenderer as ReturnType<typeof vi.fn>).mock.calls.find((c: any[]) => c[0] === customType);
		expect(call).toBeDefined();
		return call![1] as (entry: any, opts: { expanded: boolean }, theme: any) => { render(width: number): string[] };
	};

	it("registers ACP entry renderers and records Allow once with widget transitions and activity history", async () => {
		const h = harness("normal", { acp: "", presentApproval: async () => "accept" });
		const { message } = await run(h, "[perm] go");
		expect(message.stopReason).toBe("stop");
		expect(streamedText(message)).toBe("after permission");
		await h.persist(message);

		const widgetCalls = (h.ctx.ui.setWidget as ReturnType<typeof vi.fn>).mock.calls.filter((c: any[]) => c[0] === "rbf-agy-activity").map((c: any[]) => c[1]);
		expect(widgetCalls).toEqual([["ls -1 · starting"], ["ls -1 · waiting for approval"], ["ls -1 · running"], undefined]);

		const [perm] = recordsOf(h, AGY_ACP_PERMISSION);
		const [act] = recordsOf(h, AGY_ACP_ACTIVITY);
		expect(perm.data).toMatchObject({ toolCallId: "call_1540230168067533781", command: "ls -1", reply: "allow_once", reason: "user" });
		expect(act.data).toMatchObject({
			toolCallId: "call_1540230168067533781",
			name: "run_command",
			state: "completed",
			approval: { reply: "allow_once", reason: "user" },
			command: { text: "ls -1" },
			parameters: { text: '{"CommandLine":"ls -1"}', encoding: "json" },
			output: { text: "a.txt\nb.txt" },
			exitCode: 0,
		});
		expect(h.logs().find(x => x.permissionReply)?.permissionReply).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
		expect(registeredRenderer(h, AGY_ACP_PERMISSION)(perm, { expanded: false }, plainTheme).render(80).join("\n")).toBe("You allowed AGY to run ls -1 once.");
		const collapsedAct = registeredRenderer(h, AGY_ACP_ACTIVITY)(act, { expanded: false }, plainTheme).render(80);
		expect(collapsedAct.slice(0, 2)).toEqual(["AGY command · step 1 · reported DONE", "  Command: ls -1"]);
		const expandedAct = registeredRenderer(h, AGY_ACP_ACTIVITY)(act, { expanded: true }, plainTheme).render(80).join("\n");
		expect(expandedAct).toContain("a.txt");
		expect(expandedAct).toContain("  Exit code: 0");
		expect(recordsOf(h, AGY_ACP_COMPLETION)).toHaveLength(1);
	});

	it("records Reject once and Esc via ApprovalDialog as rejected by you without Error details", async () => {
		for (const mode of ["reject", "escape"] as const) {
			const presentApproval: ApprovalPresenter = mode === "reject"
				? async () => "reject"
				: async view => new Promise(resolve => {
					const dialog = new ApprovalDialog(view, { rows: () => 24, redraw() {}, paint: (_r, t) => t }, resolve);
					dialog.render(80);
					dialog.handleInput("\x1b");
				});
			const h = harness("normal", { acp: "", presentApproval });
			const { message } = await run(h, "[perm] go");
			expect(message.stopReason).toBe("stop");
			expect(message.content).toEqual([{ type: "text", text: "" }]);
			await h.persist(message);
			const [perm] = recordsOf(h, AGY_ACP_PERMISSION);
			const [act] = recordsOf(h, AGY_ACP_ACTIVITY);
			expect(perm.data).toMatchObject({ reply: "reject_once", reason: "user" });
			expect(act.data).toMatchObject({ state: "failed", approval: { reply: "reject_once", reason: "user" } });
			expect(h.logs().find(x => x.permissionReply)?.permissionReply).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
			expect(registeredRenderer(h, AGY_ACP_PERMISSION)(perm, { expanded: false }, plainTheme).render(80).join("\n")).toBe("You rejected AGY's request to run ls -1.");
			const renderedAct = registeredRenderer(h, AGY_ACP_ACTIVITY)(act, { expanded: true }, plainTheme).render(80).join("\n");
			expect(renderedAct).toContain("AGY command · step 1 · rejected by you");
			expect(renderedAct).not.toContain("Error details");
		}
	});

	it("cancels an open permission dialog with turn-stopped when the turn aborts and keeps the session open", async () => {
		let dialogOpened!: () => void;
		const opened = new Promise<void>(r => { dialogOpened = r; });
		const presentApproval: ApprovalPresenter = (_view, signal) => new Promise(resolve => {
			dialogOpened();
			signal.addEventListener("abort", () => resolve(undefined), { once: true });
		});
		const h = harness("normal", { acp: "", presentApproval }), controller = new AbortController();
		const pending = run(h, "[perm] go", { signal: controller.signal });
		await opened;
		controller.abort();
		const { message } = await pending;
		expect(message.stopReason).toBe("aborted");
		await h.persist(message);
		const [perm] = recordsOf(h, AGY_ACP_PERMISSION);
		expect(perm.data).toMatchObject({ reply: "cancelled", reason: "turn-stopped" });
		expect(h.logs().find(x => x.permissionReply)?.permissionReply).toEqual({ outcome: { outcome: "cancelled" } });
		expect(recordsOf(h, AGY_ACP_COMPLETION)[0].data.outcome).toBe("cancelled");
		expect(h.logs().some(x => x.eof)).toBe(false);
	});

	// Cold review F4: a permission record says what Pi's reply was, so it is saved only for a reply that reached AGY. Here AGY dies with the dialog open: the reply that cancels it cannot be sent.
	it("saves no permission record for a request whose reply could not reach AGY, because the link was lost with the dialog open", async () => {
		let dialogOpened!: () => void;
		const opened = new Promise<void>(r => { dialogOpened = r; });
		const presentApproval: ApprovalPresenter = (_view, signal) => new Promise(resolve => {
			dialogOpened();
			signal.addEventListener("abort", () => resolve("accept"), { once: true }); // the turn is lost, and the dialog closes
		});
		const h = harness("normal", { acp: "", presentApproval });
		const pending = run(h, "[perm-link-lost] go");
		await opened;
		writeFileSync(join(h.root, "release"), "release");
		const { message } = await pending;
		expect(message.stopReason).toBe("error");
		await h.persist(message);
		await new Promise(r => setTimeout(r, 100));
		expect(recordsOf(h, AGY_ACP_PERMISSION)).toEqual([]);
		expect(h.logs().some(x => x.permissionReply)).toBe(false);
	});

	it("rejects an unanswered permission request after the review cap and labels the activity rejected by Pi", async () => {
		const presentApproval: ApprovalPresenter = (_view, signal) => new Promise(resolve => {
			signal.addEventListener("abort", () => resolve(undefined), { once: true });
		});
		const h = harness("normal", { acp: "", presentApproval, approvalReviewTimeoutMs: 50 });
		const { message } = await run(h, "[perm] go");
		expect(message.stopReason).toBe("stop");
		await h.persist(message);
		const [perm] = recordsOf(h, AGY_ACP_PERMISSION);
		const [act] = recordsOf(h, AGY_ACP_ACTIVITY);
		expect(perm.data).toMatchObject({ reply: "reject_once", reason: "review-cap" });
		expect(act.data).toMatchObject({ state: "failed", approval: { reply: "reject_once", reason: "review-cap" } });
		expect(registeredRenderer(h, AGY_ACP_PERMISSION)(perm, { expanded: false }, plainTheme).render(80).join("\n")).toBe("AGY's request to run ls -1 was rejected after 15 minutes without an answer.");
		const renderedAct = registeredRenderer(h, AGY_ACP_ACTIVITY)(act, { expanded: true }, plainTheme).render(80).join("\n");
		expect(renderedAct).toContain("AGY command · step 1 · rejected by Pi");
		expect(renderedAct).not.toContain("Error details");
	});

	it("queues concurrent permission requests in FIFO order, reports pendingCount, and records each decision", async () => {
		const seen: Array<{ command?: string; pending: number }> = [];
		const choices = ["accept", "reject"] as const;
		const presentApproval: ApprovalPresenter = async view => {
			await new Promise(r => setTimeout(r, 10));
			seen.push({ command: view.command, pending: view.pendingCount() });
			return choices[seen.length - 1];
		};
		const h = harness("normal", { acp: "", presentApproval });
		const { message } = await run(h, "[perm-two] go");
		expect(message.stopReason).toBe("stop");
		expect(streamedText(message)).toBe("after two permissions");
		await h.persist(message);
		expect(seen).toEqual([{ command: "echo one", pending: 1 }, { command: "echo two", pending: 0 }]);
		const perms = recordsOf(h, AGY_ACP_PERMISSION);
		const acts = recordsOf(h, AGY_ACP_ACTIVITY);
		expect(perms.map(p => [p.data.command, p.data.reply, p.data.reason])).toEqual([
			["echo one", "allow_once", "user"],
			["echo two", "reject_once", "user"],
		]);
		expect(acts.map(a => [a.data.command.text, a.data.state, a.data.approval])).toEqual([
			["echo one", "completed", { reply: "allow_once", reason: "user" }],
			["echo two", "failed", { reply: "reject_once", reason: "user" }],
		]);
	});


	// Row 65 (cause 3, ruled out by the code and pinned here): AGY asks twice for one tool call, the second request arriving while the first dialog is open. Each request gets its own dialog, its own record and its own reply.
	it("gives an AGY re-ask of one tool call its own dialog, its own permission record and its own reply", async () => {
		const views: ApprovalView[] = [], answers: Array<(choice: "accept" | "reject") => void> = [];
		const presentApproval: ApprovalPresenter = view => new Promise(resolve => { views.push(view); answers.push(resolve); });
		const h = harness("normal", { acp: "", presentApproval });
		const pending = run(h, "[perm-reask] go");
		await vi.waitFor(() => expect(views).toHaveLength(1), { timeout: 5000, interval: 10 });
		// The second request reached the queue behind the open first dialog, and opened no dialog of its own yet.
		await vi.waitFor(() => expect(views[0].pendingCount()).toBe(1), { timeout: 5000, interval: 10 });
		expect(views).toHaveLength(1);
		expect(h.logs().filter(x => x.permissionReply)).toEqual([]);
		answers[0]("accept");
		await vi.waitFor(() => expect(views).toHaveLength(2), { timeout: 5000, interval: 10 });
		answers[1]("reject");
		const { message } = await pending;
		expect(message.stopReason).toBe("stop");
		await h.persist(message);
		expect(views.map(v => [v.toolCallId, v.command, v.bypassSandbox])).toEqual([["call_perm_reask", "touch out.txt", undefined], ["call_perm_reask", "touch out.txt", true]]);
		expect(recordsOf(h, AGY_ACP_PERMISSION).map(p => [p.data.toolCallId, p.data.bypassSandbox, p.data.reply, p.data.reason])).toEqual([
			["call_perm_reask", undefined, "allow_once", "user"],
			["call_perm_reask", true, "reject_once", "user"],
		]);
		const replies = h.logs().filter(x => x.permissionReply);
		expect(replies.map(x => [x.rpcId, x.permissionReply.outcome])).toEqual([["1", { outcome: "selected", optionId: "allow" }], ["2", { outcome: "selected", optionId: "deny" }]]);
		// Both asks were answered by what Pi sent, so no later request for this call was taken as the first one's answer.
		expect(h.logs().filter(x => x.in?.id === "1" || x.in?.id === "2").map(x => x.in.id)).toEqual(["1", "2"]);
	});

	// Row 65: the opt-in message log (RBF_AGY_WIRE_LOG=1) says, per message, where a permission answer went. It holds ids and states, never the text AGY wrote, a command or its output.
	describe("the message log", () => {
		let wire: WireLogRun | undefined;
		afterEach(() => { wire?.stop(); wire = undefined; });

		it("logs what AGY asked, what Pi answered and delivered, the queue's steps and the saved records, and no answer text", async () => {
			wire = startWireLog();
			const presented: Array<(choice: "accept" | "reject") => void> = [];
			const presentApproval: ApprovalPresenter = () => new Promise(resolve => { presented.push(resolve); });
			const h = harness("normal", { acp: "", presentApproval });
			// A re-ask of one tool call, then an allowed command whose output and AGY's text are not to be logged.
			const reask = run(h, "[perm-reask] go");
			await vi.waitFor(() => expect(presented).toHaveLength(1), { timeout: 5000, interval: 10 });
			await vi.waitFor(() => expect(wire!.lines().filter(x => x.ev === "q" && x.step === "request")).toHaveLength(2), { timeout: 5000, interval: 10 });
			presented[0]("accept");
			await vi.waitFor(() => expect(presented).toHaveLength(2), { timeout: 5000, interval: 10 });
			presented[1]("accept");
			await h.persist((await reask).message);
			const answered = run(h, "[perm] go");
			await vi.waitFor(() => expect(presented).toHaveLength(3), { timeout: 5000, interval: 10 });
			presented[2]("accept");
			const { message } = await answered;
			expect(streamedText(message)).toBe("after permission");
			await h.persist(message);

			const lines = wire.lines();
			expect(lines.every(x => typeof x.t === "number" && ["in", "out", "q", "dlg", "rec"].includes(x.ev))).toBe(true);
			const slim = (ev: string, pick: (x: any) => boolean = () => true) => lines.filter(x => x.ev === ev && pick(x)).map(({ t, ev: _ev, ...rest }) => rest);
			// in: AGY's two permission requests, each with its own rpc id and the one tool call id, and the tool call's updates by state.
			expect(slim("in", x => x.method === "session/request_permission").slice(0, 2)).toEqual([
				{ kind: "request", method: "session/request_permission", id: "1", toolCallId: "call_perm_reask" },
				{ kind: "request", method: "session/request_permission", id: "2", toolCallId: "call_perm_reask" },
			]);
			expect(slim("in", x => x.method === "session/update" && x.sessionUpdate === "tool_call_update").map(x => [x.toolCallId, x.status])).toContainEqual(["call_perm_reask", "pending"]);
			// out: each answer, with the option it chose and whether it was written.
			expect(slim("out", x => x.kind === "reply").slice(0, 2)).toEqual([
				{ kind: "reply", id: "1", outcome: "selected", optionId: "allow", delivered: true },
				{ kind: "reply", id: "2", outcome: "selected", optionId: "allow", delivered: true },
			]);
			expect(slim("out", x => x.kind === "request" && x.method === "session/prompt").length).toBeGreaterThan(0);
			// q: the queue's steps for both asks of the one tool call, in order.
			expect(slim("q", x => x.toolCallId === "call_perm_reask").map(x => [x.step, x.n, x.choice, x.reply])).toEqual([
				["request", undefined, undefined, undefined], ["present", 1, undefined, undefined], ["request", undefined, undefined, undefined],
				["choice", 1, "accept", undefined], ["reply", 1, undefined, "allow_once"], ["present", 2, undefined, undefined], ["choice", 2, "accept", undefined], ["reply", 2, undefined, "allow_once"],
			]);
			expect(slim("q", x => x.step === "request" && x.toolCallId === "call_perm_reask").map(x => [x.live, x.bypass])).toEqual([[0, false], [1, true]]);
			// rec: each saved permission record, once its reply was written.
			expect(slim("rec")).toEqual([
				{ customType: AGY_ACP_PERMISSION, toolCallId: "call_perm_reask", result: "ok" },
				{ customType: AGY_ACP_PERMISSION, toolCallId: "call_perm_reask", result: "ok" },
				{ customType: AGY_ACP_PERMISSION, toolCallId: "call_1540230168067533781", result: "ok" },
			]);
			// Never AGY's text, the command, its output or the typed prompt.
			const text = readFileSync(wire.file, "utf8");
			for (const secret of ["after permission", "after re-ask", "a.txt", "ls -1", "touch out.txt", "[perm", "NEVER FORWARD"]) expect(text, secret).not.toContain(secret);
		});

		it("logs a permission record that could not be saved as failed", async () => {
			wire = startWireLog();
			const h = harness("normal", { acp: "", presentApproval: async () => "accept" });
			const origAppend = h.pi.appendEntry;
			h.pi.appendEntry = (type: string, data: any) => {
				if (type === AGY_ACP_PERMISSION) throw new Error("disk full");
				return origAppend(type, data);
			};
			await run(h, "[perm] go");
			expect(wire.lines().filter(x => x.ev === "rec").map(({ t, ev, ...rest }) => rest)).toEqual([{ customType: AGY_ACP_PERMISSION, toolCallId: "call_1540230168067533781", result: "fail" }]);
		});

		it("writes no log and makes no folder without RBF_AGY_WIRE_LOG=1", async () => {
			wire = startWireLog(false);
			const h = harness("normal", { acp: "", presentApproval: async () => "accept" });
			const { message } = await run(h, "[perm] go");
			expect(message.stopReason).toBe("stop");
			await h.persist(message);
			expect(recordsOf(h, AGY_ACP_PERMISSION)).toHaveLength(1);
			expect(wire.exists()).toBe(false);
			expect(existsSync(wire.dir)).toBe(false);
		});
	});

	it("warns without altering the permission reply if appending the permission record fails", async () => {
		const h = harness("normal", { acp: "", presentApproval: async () => "accept" });
		const origAppend = h.pi.appendEntry;
		h.pi.appendEntry = (type: string, data: any) => {
			if (type === AGY_ACP_PERMISSION) throw new Error("disk full");
			return origAppend(type, data);
		};
		const { message } = await run(h, "[perm] go");
		expect(message.stopReason).toBe("stop");
		expect(h.logs().find(x => x.permissionReply)?.permissionReply).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(AGY_HISTORY_FAILURE, "warning");
	});

	it("rejects an invalid/unsafe permission request without opening a dialog or killing the turn, then handles a valid request", async () => {
		const root = mkdtempSync(join(roots!, "acp-unsafe-perm-"));
		const present = vi.fn(async () => "accept" as const);
		const h = harness("normal", { root, acp: "", presentApproval: present });
		const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "test-support/fixtures/acp-1.5.3.json"), "utf8"));
		const log = join(root, "native.jsonl");
		writeFileSync(join(root, "fake-agy.cjs"), `#!${process.execPath}
const fs = require("node:fs");
const fixture = ${JSON.stringify(fixture)};
const log = ${JSON.stringify(log)};
const record = x => fs.appendFileSync(log, JSON.stringify(x) + "\\n");
const send = f => process.stdout.write(JSON.stringify(f) + "\\n");
const waiters = new Map();
const ask = (id, method, params) => new Promise(r => { waiters.set(id, r); send({ jsonrpc: "2.0", id, method, params }); });
let buf = "";
process.stdin.on("data", d => {
	buf += d;
	let i;
	while ((i = buf.indexOf("\\n")) >= 0) {
		const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
		if (m.method === undefined) { const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m.result ?? { error: m.error }); } continue; }
		if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: fixture.initialize });
		else if (m.method === "session/new") send({ jsonrpc: "2.0", id: m.id, result: { ...fixture.sessionNew, sessionId: "acp-unsafe-1" } });
		else if (m.method === "session/set_config_option") {
			const opts = fixture.sessionNew.configOptions.map(o => o.id === m.params.configId ? { ...o, currentValue: m.params.value } : o);
			fixture.sessionNew.configOptions = opts;
			send({ jsonrpc: "2.0", id: m.id, result: { configOptions: opts } });
		}
		else if (m.method === "session/prompt") {
			void (async () => {
				const sid = m.params.sessionId;
				const badReply = await ask("bad-1", "session/request_permission", {
					sessionId: sid,
					toolCall: { ...fixture.permissionParams.toolCall, toolCallId: "call_bad" },
					options: [{ optionId: "deny", kind: "reject_once", name: "Deny" }],
				});
				const goodReply = await ask("good-1", "session/request_permission", { ...fixture.permissionParams, sessionId: sid });
				record({ badReply, goodReply });
				send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok after unsafe" } } } });
				send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn", usage: fixture.usage } });
			})();
		}
	}
});
process.stdin.on("end", () => process.exit(0));
`, { mode: 0o700 });
		const { message } = await run(h, "go");
		expect(message.stopReason).toBe("stop");
		expect(streamedText(message)).toBe("ok after unsafe");
		await h.persist(message);
		expect(present).toHaveBeenCalledTimes(1);
		const replies = h.logs().find(x => x.badReply);
		expect(replies.badReply).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
		expect(replies.goodReply).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
		const perms = recordsOf(h, AGY_ACP_PERMISSION);
		expect(perms.map(p => [p.data.toolCallId, p.data.reply, p.data.reason])).toEqual([
			["call_bad", "reject_once", "unsafe"],
			["call_1540230168067533781", "allow_once", "user"],
		]);
		expect(registeredRenderer(h, AGY_ACP_PERMISSION)(perms[0], { expanded: false }, plainTheme).render(80).join("\n")).toBe("AGY sent a request Pi can't show safely, so Pi rejected it.");
	});

	it("answers elicitation/create with -32603, records AGY_ACP_QUESTION, and renders ACP_QUESTION_LINE", async () => {
		const h = harness("normal", { acp: "" });
		const { message } = await run(h, "[question] go");
		expect(message.stopReason).toBe("stop");
		expect(streamedText(message)).toBe("after question");
		await h.persist(message);
		expect(h.logs().find(x => x.elicitationReply)?.elicitationReply).toEqual({ error: { code: -32603, message: "Pi could not show the question" } });
		const [q] = recordsOf(h, AGY_ACP_QUESTION);
		expect(q.data).toMatchObject({ toolCallId: "call_q", questions: ["Which colors do you like?"] });
		expect(q.data.inputEntryId).toBe(h.entries.find(e => e.type === "message" && e.message.role === "user").id);
		expect(registeredRenderer(h, AGY_ACP_QUESTION)(q, { expanded: false }, plainTheme).render(80).join("\n")).toBe(ACP_QUESTION_LINE);
	});

	it("refuses fs/read_text_file, terminal/create, and unknown inbound methods with -32601", async () => {
		const h = harness("normal", { acp: "" });
		const { message } = await run(h, "[fs] go");
		expect(message.stopReason).toBe("stop");
		expect(streamedText(message)).toBe("after client powers");
		const replies = h.logs().find(x => x.clientPowerReplies)?.clientPowerReplies;
		expect(replies).toHaveLength(3);
		for (const reply of replies) expect(reply?.error?.code).toBe(-32601);
	});
});

describe("pi-21.3 ACP error copies", () => {
	// Pi retries an error whose text matches its retry patterns and then appends a context_edit entry that breaks resume.
	const copies = (): string[] => [
		...Object.values(AGY_COPY), ...Object.values(RECOVERY_COPY),
		ACP_COPY.wakeGone, ACP_COPY.wakeRefused, ACP_COPY.unsupported, ACP_COPY.notConfirmed, ACP_COPY.changeCancelled, ACP_COPY.changeCancelledLost, ACP_COPY.diverged, ACP_COPY.listMissing("goal"), ACP_COPY.agyCommand("goal"), ACP_COPY.startup, ACP_COPY.signIn, ACP_COPY.cancelTimeout, ACP_COPY.question, ACP_COPY.lost, ACP_COPY.lostBeforeSend,
		ACP_COPY.unsupportedStop("max_tokens"), ACP_COPY.unsupportedStop("max_turn_requests"), ACP_COPY.policyKeys(["toolPermission"]),
		"AGY refused this request.",
		"AGY response exceeded the supported output limit. The answer is incomplete.", "AGY request cancelled.", "AGY request cancelled before input. Your message was not sent.",
		"AGY could not verify session provenance. Your message was not sent. Use /new.", "AGY accepts text-only tasks. Your message was not sent. Remove images and send a new request.",
		"AGY needs nonempty text of at most 256 KiB. Your message was not sent.", "AGY provider failed. The task outcome may be unknown. No automatic retry is allowed.",
		"AGY will not resend this user message. Your message was not sent. Submit a new task after /new.",
		ACP_QUESTION_LINE,
		formatAgyAcpPermissionLine({ piSessionId: "p", inputEntryId: "u", acpSessionId: "a", toolCallId: "t", kind: "execute", title: "ls -1", command: "ls -1", optionsOffered: ["allow_once", "reject_once"], reply: "allow_once", reason: "user" }).text,
		formatAgyAcpPermissionLine({ piSessionId: "p", inputEntryId: "u", acpSessionId: "a", toolCallId: "t", kind: "execute", title: "ls -1", command: "ls -1", optionsOffered: ["allow_once", "reject_once"], reply: "reject_once", reason: "user" }).text,
		formatAgyAcpPermissionLine({ piSessionId: "p", inputEntryId: "u", acpSessionId: "a", toolCallId: "t", kind: "execute", title: "ls -1", command: "ls -1", optionsOffered: ["allow_once", "reject_once"], reply: "cancelled", reason: "turn-stopped" }).text,
		formatAgyAcpPermissionLine({ piSessionId: "p", inputEntryId: "u", acpSessionId: "a", toolCallId: "t", kind: "execute", title: "ls -1", command: "ls -1", optionsOffered: ["allow_once", "reject_once"], reply: "reject_once", reason: "review-cap" }).text,
		formatAgyAcpPermissionLine({ piSessionId: "p", inputEntryId: "u", acpSessionId: "a", toolCallId: "t", kind: "execute", title: "ls -1", command: "ls -1", optionsOffered: ["allow_once", "reject_once"], reply: "reject_once", reason: "unsafe" }).text,
		// AGY's JSON-RPC errors reach the user as `error.message`. A bare 429, 500 or 503 in it is an HTTP status to Pi's retry check; so is every other status it lists.
		...[429, 500, 502, 503, 504, 520, 524, -32500, -32503, 1429, 5000, -32000, -32601, -32603].map(code => new AcpRpcError(code).message),
	];
	const asMessage = (text: string) => ({ role: "assistant", stopReason: "error", errorMessage: text, content: [{ type: "text", text }] }) as any;

	it("matches none of Pi's retryable-error patterns in the Pi package this workspace builds against", () => {
		for (const text of copies()) expect(isRetryableAssistantError(asMessage(text)), text).toBe(false);
	});

	// The daily Pi's retry.js, found through the `pi` shim on PATH. It fails, not skips, when Pi cannot be found: a silent pass would say nothing about the installed Pi's longer pattern list.
	it("matches none of them in the installed Pi, whose pattern list is longer than the workspace's", async () => {
		const found = installedPiRetry();
		expect(found, "the installed Pi's retry.js, through the `pi` shim on PATH").toBeDefined();
		const version = JSON.parse(readFileSync(join(dirname(dirname(dirname(found!))), "package.json"), "utf8")).version as string;
		expect(versionAtLeast(parseVersion(version)!, [1, 5, 0]), `installed Pi ${version}: the list the check is for starts at 1.5.0`).toBe(true);
		const { isRetryableAssistantError: installed } = await import(pathToFileURL(found!).href);
		for (const text of copies()) expect(installed(asMessage(text)), text).toBe(false);
	});

	it("uses the brief's wording for the lines it names, character for character", () => {
		expect(ACP_COPY.unsupported).toBe("AGY cannot change to this setting in the same conversation. Your message was not sent. Select the previous setting to continue, or use /new.");
		expect(ACP_COPY.notConfirmed).toBe("AGY could not confirm this setting. Your message was not sent. Select a supported setting and send again, or use /new.");
		expect(ACP_COPY.lostBeforeSend).toBe("AGY could not verify the conversation with this setting. Your message was not sent. Use /new to start a new conversation.");
		expect(ACP_COPY.changeCancelled).toBe("AGY change cancelled. Your message was not sent.");
		expect(ACP_COPY.diverged).toBe("AGY reported different settings for this turn. The task may have run. Review its results before sending again.");
		expect(ACP_COPY.lost).toBe("AGY could not confirm this turn. The task outcome is unknown. No automatic retry was sent.");
		expect(ACP_COPY.agyCommand("goal")).toBe("AGY would run /goal as its own command. Pi doesn't send AGY commands yet. Your message was not sent.");
		expect(ACP_COPY.listMissing("goal")).toBe("AGY's command list didn't arrive, so Pi can't check /goal. Your message was not sent. Send it again.");
		expect(ACP_COPY.policyKeys(["a", "b"])).toBe("AGY over ACP can't apply these settings: a, b. Your message was not sent. Remove them from the file, or start Pi without --agy-settings.");
	});

	it("writes AGY's usual JSON-RPC code plainly and spreads the digits only of a code that holds one of Pi's retry statuses", () => {
		expect(new AcpRpcError(-32603).message).toBe("AGY ACP request failed (code -32603)");
		expect(new AcpRpcError(-32000).message).toBe("AGY ACP request failed (code -32000)");
		expect(new AcpRpcError(-32601).message).toBe("AGY ACP request failed (code -32601)");
		expect(new AcpRpcError(429).message).toBe("AGY ACP request failed (code 4 2 9)");
		expect(new AcpRpcError(-32500).message).toBe("AGY ACP request failed (code -3 2 5 0 0)"); // Pi 0.85 finds 500 inside -32500
		// What Pi 0.85 (anywhere in the text) and Pi 1.6 (not touching a letter or digit) each do with the plain number: the spread is needed exactly when 0.85 would match.
		const old = /429|500|502|503|504|520|524/, current = /(?<![a-z0-9])(?:429|500|502|503|504|520|524)(?![a-z0-9])/i;
		for (const code of [-32603, -32000, -32601, -32602, -32700]) { expect(old.test(String(code)), String(code)).toBe(false); expect(current.test(String(code)), String(code)).toBe(false); }
		for (const code of [429, 500, 503, -32500, 1429]) expect(old.test(String(code)), String(code)).toBe(true);
		for (const code of [429, 500, 503]) expect(current.test(String(code)), String(code)).toBe(true);
	});

	// The texts built around words AGY or Tom supplied: a result AGY ended the turn with, a `/name` Tom typed, a key in the settings file. Pi retries an error whose text matches, appends a context_edit entry
	// that breaks resume, and after a sent prompt ends on a false "not sent". No text the ACP route builds may match, whatever the words are.
	const retryPredicates = async () => {
		const found = installedPiRetry();
		expect(found, "the installed Pi's retry.js is found through the pi shim").toBeDefined();
		const { isRetryableAssistantError: installed } = await import(pathToFileURL(found!).href);
		return [["this workspace's Pi", isRetryableAssistantError], ["the installed Pi", installed]] as const;
	};
	const unretryable = async (message: any) => { for (const [name, predicate] of await retryPredicates()) expect(predicate(message), `${name}: ${message.errorMessage}`).toBe(false); };

	it("does not let a result AGY ended the turn with make Pi retry, after the prompt was sent", async () => {
		const h = harness("normal", { acp: "" });
		const { message } = await run(h, "[stop-overloaded] go");
		expect(message.stopReason).toBe("error");
		expect(shown(message).replace(/\u200b/g, "")).toContain("overloaded"); // the word stays readable
		await unretryable(message);
	});

	it("does not let a `/name` Tom typed make Pi retry, when AGY's command list has not arrived", async () => {
		const h = harness("normal", { acp: "no-commands" });
		const { message } = await run(h, "/x/502.log why is this slow?");
		expect(message.stopReason).toBe("error");
		expect(shown(message).replace(/\u200b/g, "")).toBe(ACP_COPY.listMissing("x/502.log"));
		await unretryable(message);
	}, 15000);

	it("does not let a command name that AGY knows make Pi retry", async () => {
		const h = harness("normal", { acp: "cmd-overloaded" });
		await h.persist((await run(h, "hello")).message);
		const { message } = await run(h, "/overloaded please");
		expect(message.stopReason).toBe("error");
		expect(shown(message).replace(/\u200b/g, "")).toBe(ACP_COPY.agyCommand("overloaded"));
		await unretryable(message);
	}, 15000);

	it("does not let a key in the settings file make Pi retry", async () => {
		const dir = mkdtempSync(join(roots!, "policy-")), file = join(dir, "settings.json");
		writeFileSync(file, '{"requestTimeout":30,"enableTerminalSandbox":false}', { mode: 0o600 });
		const h = harness("normal", { acp: "", policy: file });
		const { message } = await run(h, "Hello");
		expect(message.stopReason).toBe("error");
		expect(shown(message).replace(/\u200b/g, "")).toBe(ACP_COPY.policyKeys(["requestTimeout"]));
		await unretryable(message);
	});

	it("writes any hostile words apart so neither Pi's retry check nor a copy of its patterns finds them, and keeps them readable", async () => {
		const builders: Array<[string, (f: string) => string]> = [["a result", f => ACP_COPY.unsupportedStop(f)], ["a missing list", f => ACP_COPY.listMissing(f)], ["an AGY command", f => ACP_COPY.agyCommand(f)], ["a settings key", f => ACP_COPY.policyKeys([f])]];
		const words = ["timeout", "server_error", "overloaded", "rate limit", "terminated", "x/502.log", "requestTimeout", "ECONNRESET", "429", "fetch failed", "service unavailable", "goal"];
		// Each Pi's own check decides for its own text: the workspace's older Pi knows fewer words than the installed one.
		for (const [piName, predicate] of await retryPredicates())
			for (const [kind, build] of builders)
				for (const word of words) {
					const text = retrySafe(([w]) => build(w!), [word], predicate);
					expect(predicate({ role: "assistant", stopReason: "error", errorMessage: text, content: [] }), `${piName}, ${kind}: ${word}`).toBe(false);
					expect(text.replace(/\u200b/g, ""), `${kind}: ${word}`).toBe(build(word)); // only invisible characters were added
				}
		expect(retrySafe(([w]) => ACP_COPY.agyCommand(w!), ["goal"])).toBe(ACP_COPY.agyCommand("goal")); // a harmless word is left alone, so Tom can copy it
	});

	it("does catch a copy that would be retried, so the check can fail", () => {
		expect(isRetryableAssistantError(asMessage("AGY connection lost. Please try again"))).toBe(true);
	});
});

// Decisions 2026-11-22: each AGY wake-up becomes its own turn in Pi's chat. The provider asks Pi for the turn with pi.sendMessage(marker, {triggerTurn: true}); Pi saves the marker, emits
// before_agent_start with messageType "custom", and calls the provider, which sends AGY nothing and streams what AGY said. The tests do what Pi does, and nothing else.
describe("pi-21.3 ACP wake turns", { timeout: 40000 }, () => {
	const QUIET = 200;
	const MARKER = { customType: "rbf-agy-wake", content: "AGY continued on its own.", display: true };
	const wakeHarness = (acp: string, opts: Parameters<typeof harness>[1] = {}) => harness("normal", { acp, wakeQuietMs: QUIET, ...opts });
	/** A first turn that ends, with its answer saved and its completion written, after which the fake AGY keeps working. */
	async function afterTurn(h: Harness, scenario: string) {
		const first = await run(h, `[${scenario}] go`);
		await h.persist(first.message);
		return first;
	}
	/** What Pi does when the provider asks for the wake turn: save the marker, announce the run, call the provider. `sentBefore` is how many marker requests had been made. */
	async function wakeTurn(h: Harness, sentBefore = 0, signal?: AbortSignal, between?: () => Promise<void>) {
		await vi.waitFor(() => expect(h.sent.length).toBeGreaterThan(sentBefore), { timeout: 15000 });
		const call = h.sent.at(-1)!;
		const marker = h.append({ type: "custom_message", customType: call.message.customType, content: call.message.content, display: call.message.display });
		await h.emit("before_agent_start", { messageType: "custom", message: { role: "custom", ...call.message, timestamp: Date.now() } });
		await between?.(); // what happens in Pi between the marker run starting and its call to the provider
		const stream = await h.registration.streamSimple(h.ctx.model, { systemPrompt: "", messages: [] }, { signal });
		const events: any[] = [], entriesAtFirstChunk: string[] = [];
		for await (const event of stream) {
			if (event.type === "text_delta" && !entriesAtFirstChunk.length) entriesAtFirstChunk.push(...h.entries.map(e => e.customType ?? e.type));
			events.push(event);
		}
		return { call, marker, events, message: await stream.result(), entriesAtFirstChunk };
	}
	const finished = async (h: Harness, text: string) => { const out = await run(h, text); await h.persist(out.message); return out; };
	const plainTheme = { fg: (_role: string, text: string) => text } as any;
	const registeredRenderer = (h: Harness, customType: string) => {
		const call = (h.pi.registerEntryRenderer as ReturnType<typeof vi.fn>).mock.calls.find((c: any[]) => c[0] === customType);
		expect(call).toBeDefined();
		return call![1] as (entry: any, opts: { expanded: boolean }, theme: any) => { render(width: number): string[] };
	};
	const prompts = (h: Harness) => received(h, "session/prompt").map(m => m.params.prompt[0].text);
	const settingsCalls = (h: Harness) => received(h, "session/set_config_option").length;
	const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
	const wakeBegan = (h: Harness) => vi.waitFor(() => expect(h.logs().some(x => x.wakeBegan)).toBe(true), { timeout: 10000 });
	const wakeNow = async (h: Harness) => { writeFileSync(join(h.root, "wake-go"), ""); await wakeBegan(h); };

	it("asks Pi for one marker turn when AGY speaks after a turn, sends AGY nothing, saves the wake before anything streams, and writes a completion that names it", async () => {
		const h = wakeHarness("");
		const first = await afterTurn(h, "wake");
		const settingsBefore = settingsCalls(h);
		const { call, marker, message, events, entriesAtFirstChunk } = await wakeTurn(h);
		expect(h.sent).toHaveLength(1);
		expect(call.message).toEqual(MARKER);
		expect(call.options).toEqual({ triggerTurn: true });
		expect(prompts(h)).toEqual(["[wake] go"]);
		expect(settingsCalls(h)).toBe(settingsBefore);
		expect(message.stopReason).toBe("stop");
		expect(streamedText(message)).toBe("Background job finished.");
		expect(events.at(-1).type).toBe("done");
		// The wake record is saved before the first chunk; the tool call it drew is saved under the marker.
		expect(entriesAtFirstChunk).toContain(AGY_ACP_WAKE);
		const [wake] = recordsOf(h, AGY_ACP_WAKE), [firstCompletion] = recordsOf(h, AGY_ACP_COMPLETION);
		expect(wake.data).toMatchObject({ markerEntryId: marker.id, previousCompletionId: firstCompletion.id, acpSessionId: firstCompletion.data.acpSessionId, piSessionId: expect.any(String), prefixHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
		expect(h.entries.indexOf(marker)).toBeLessThan(h.entries.indexOf(wake));
		const [activity] = recordsOf(h, AGY_ACP_ACTIVITY).filter(e => e.data.inputEntryId === marker.id);
		expect(activity.data).toMatchObject({ toolCallId: "call_wake_1", sequence: 1, state: "completed" });
		// Pi saves the answer, then agent_end writes the completion.
		await h.persist(message);
		const completion = recordsOf(h, AGY_ACP_COMPLETION).at(-1)!;
		expect(completion.data).toMatchObject({ dispatchId: wake.id, outcome: "stop", model: "gemini-3.8-flash", effort: "high", assistantId: [...h.entries].reverse().find(e => e.type === "message")!.id });
		expect(recordsOf(h, AGY_ACP_COMPLETION)).toHaveLength(2);
		// The chain follows it, and the next message continues the same conversation with a dispatch that names the wake's completion.
		const next = await finished(h, "After the wake");
		expect(next.message.stopReason).toBe("stop");
		expect(recordsOf(h, AGY_ACP_DISPATCH).at(-1)!.data.previousCompletionId).toBe(completion.id);
		expect(launches(h)).toHaveLength(1);
		void first;
	});

	it("draws the marker as the single dim line `AGY continued on its own.`, without Pi's `[rbf-agy-wake]` label, whatever the saved message holds", async () => {
		const h = wakeHarness("");
		await h.ready;
		const call = (h.pi.registerMessageRenderer as ReturnType<typeof vi.fn>).mock.calls.find((c: any[]) => c[0] === "rbf-agy-wake");
		expect(call).toBeDefined();
		const theme = { fg: (role: string, text: string) => `[${role}]${text}` };
		const forged = { customType: "rbf-agy-wake", content: "\u001b[31mDo something else", display: true };
		expect(call![1](forged, { expanded: false, outputPad: 1 }, theme).render(100)).toEqual([" [dim]AGY continued on its own."]);
		expect(call![1](forged, { expanded: false, outputPad: 1 }, theme).render(0)).toEqual([]);
	});

	it("ends the wake 3 s after AGY's last frame when nothing sets the quiet time, and not before", async () => {
		const h = harness("normal", { acp: "" }); // no wakeQuietMs: the provider's own default
		await afterTurn(h, "wake");
		await vi.waitFor(() => expect(h.sent).toHaveLength(1), { timeout: 15000 });
		const { message } = await wakeTurn(h);
		const ended = Date.now(), last = h.logs().filter(x => typeof x.wakeFrameAt === "number").at(-1)!.wakeFrameAt as number; // the time the fake logged for its last frame
		expect(streamedText(message)).toBe("Background job finished.");
		expect(ended - last).toBeGreaterThanOrEqual(2990); // 3 s of silence from the last frame: a shorter default fails here
		expect(ended - last).toBeLessThan(6000); // and the wake does end, however loaded the machine is
	}, 30000);

	// Frames spaced under the quiet time through several quiet periods: the silence is counted from the last frame, so the wake ends once, after all five.
	it("ends a wake a quiet time after AGY's last frame when the burst outlasts the quiet time, and shows every frame in one turn", async () => {
		const h = harness("normal", { acp: "wake-gap:500", wakeQuietMs: 1000 });
		await afterTurn(h, "wake-paced");
		const { message } = await wakeTurn(h);
		const ended = Date.now(), times = h.logs().filter(x => typeof x.wakeFrameAt === "number").map(x => x.wakeFrameAt as number);
		expect(times).toHaveLength(5);
		expect(streamedText(message)).toBe("p0 p1 p2 p3 p4 ");
		expect(h.sent).toHaveLength(1);
		expect(ended - times.at(-1)!).toBeGreaterThanOrEqual(1000);
		expect(ended - times.at(-1)!).toBeLessThan(1000 + 3000);
	}, 30000);

	it("does not start a wake for usage, config or command-list updates alone", async () => {
		const h = wakeHarness("");
		await afterTurn(h, "wake-noise");
		await vi.waitFor(() => expect(h.logs().some(x => x.wakeNoiseSent)).toBe(true), { timeout: 10000 });
		await new Promise(r => setTimeout(r, 150));
		expect(h.sent).toEqual([]);
		expect(recordsOf(h, AGY_ACP_WAKE)).toEqual([]);
	});

	it("starts a second wake for a second burst, with its own marker, record and completion", async () => {
		const h = wakeHarness("wake-gap:600");
		await afterTurn(h, "wake-two");
		const one = await wakeTurn(h);
		await h.persist(one.message);
		const two = await wakeTurn(h, 1);
		expect(streamedText(one.message)).toBe("Background job finished.");
		expect(streamedText(two.message)).toBe("A second thing.");
		await h.persist(two.message);
		expect(recordsOf(h, AGY_ACP_WAKE).map(e => e.data.markerEntryId)).toEqual([one.marker.id, two.marker.id]);
		const completions = recordsOf(h, AGY_ACP_COMPLETION);
		expect(completions).toHaveLength(3);
		expect(recordsOf(h, AGY_ACP_WAKE)[1].data.previousCompletionId).toBe(completions[1].id);
	});

	it("opens the approval dialog inside the wake, saves the permission under the marker, holds the wake open while it is up, and lets the command run", async () => {
		let answer!: (v: "accept" | "reject") => void;
		const present = vi.fn(() => new Promise<"accept" | "reject">(resolve => { answer = resolve; }));
		const h = wakeHarness("", { presentApproval: present as any });
		await afterTurn(h, "wake-perm");
		const turn = wakeTurn(h);
		await vi.waitFor(() => expect(present).toHaveBeenCalledTimes(1), { timeout: 15000 });
		await new Promise(r => setTimeout(r, QUIET * 2)); // longer than the quiet time, with the dialog open
		answer("accept");
		const { marker, message } = await turn;
		expect(streamedText(message)).toBe("Listed the files.");
		expect(h.logs().find(x => x.wakePermissionReply)?.wakePermissionReply).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
		const [permission] = recordsOf(h, AGY_ACP_PERMISSION);
		expect(permission.data).toMatchObject({ inputEntryId: marker.id, reply: "allow_once", reason: "user", toolCallId: "call_wake_perm" });
		const activity = recordsOf(h, AGY_ACP_ACTIVITY).find(e => e.data.toolCallId === "call_wake_perm")!;
		expect(activity.data).toMatchObject({ inputEntryId: marker.id, approval: { reply: "allow_once", reason: "user" } });
	});

	it("holds a permission request that is AGY's first frame until the wake attaches, then asks", async () => {
		const present = vi.fn(async () => "reject" as const);
		const h = wakeHarness("", { presentApproval: present as any });
		await afterTurn(h, "perm-between");
		await vi.waitFor(() => expect(h.sent).toHaveLength(1), { timeout: 15000 });
		expect(present).not.toHaveBeenCalled(); // nothing is asked, and AGY is not answered, before the turn exists
		expect(h.logs().some(x => x.betweenPermissionReply)).toBe(false);
		const { marker } = await wakeTurn(h);
		expect(present).toHaveBeenCalledTimes(1);
		expect(h.logs().find(x => x.betweenPermissionReply)?.betweenPermissionReply).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
		expect(recordsOf(h, AGY_ACP_PERMISSION)[0].data).toMatchObject({ inputEntryId: marker.id, reply: "reject_once", reason: "user" });
	});

	it("answers a woken question with error -32603 and saves its line under the marker", async () => {
		const h = wakeHarness("");
		await afterTurn(h, "wake-question");
		const { marker, message } = await wakeTurn(h);
		expect(h.logs().find(x => x.wakeElicitationReply)?.wakeElicitationReply).toEqual({ error: { code: -32603, message: "Pi could not show the question" } });
		expect(recordsOf(h, AGY_ACP_QUESTION)[0].data).toMatchObject({ inputEntryId: marker.id });
		expect(streamedText(message)).toBe("Asked in chat.");
	});

	it("stops on Esc: session/cancel goes to AGY, the turn is saved as aborted, and the chat carries on", async () => {
		const h = wakeHarness("cancel-trails", { wakeQuietMs: 1500 }); // longer than the usual 200 ms: a busy machine can stall the test for that long between two of the fake's chunks, and the wake would end by itself before Esc
		await afterTurn(h, "wake-long");
		await vi.waitFor(() => expect(h.sent).toHaveLength(1), { timeout: 15000 });
		const controller = new AbortController();
		const turn = wakeTurn(h, 0, controller.signal);
		await vi.waitFor(() => expect(h.logs().filter(x => x.out?.params?.update?.sessionUpdate === "agent_message_chunk").length).toBeGreaterThan(3), { timeout: 15000 });
		controller.abort();
		const { message, marker } = await turn;
		expect(message.stopReason).toBe("aborted");
		await vi.waitFor(() => expect(received(h, "session/cancel")).toHaveLength(1), { timeout: 10000 });
		await h.persist(message);
		const completion = recordsOf(h, AGY_ACP_COMPLETION).at(-1)!;
		expect(completion.data).toMatchObject({ dispatchId: recordsOf(h, AGY_ACP_WAKE)[0].id, outcome: "cancelled" });
		await vi.waitFor(() => expect(h.logs().some(x => x.trailingSent)).toBe(true), { timeout: 10000 });
		await new Promise(r => setTimeout(r, 150));
		expect(h.sent).toHaveLength(1); // what AGY had already sent started no new wake
		expect((await finished(h, "Still here")).message.stopReason).toBe("stop");
		void marker;
	});

	// Esc on a woken approval dialog: the queue settles the request as `cancelled` and the wake ends in the same tick, but the permission record is saved only when the reply has been written to AGY. Saved after the
	// wake's answer it fails the chain: before agent_end it retires the chat, after the completion a restart reads a permission with no open turn as a mismatch. A prompt is spared because it waits for AGY's own result.
	it("saves the permission of a woken dialog that Esc closed before the wake's answer, so the chat carries on and a restart resumes", async () => {
		const present = vi.fn(() => new Promise<"accept" | "reject">(() => { /* never answered: Esc closes it */ }));
		const h = wakeHarness("", { presentApproval: present as any });
		await afterTurn(h, "wake-perm");
		const controller = new AbortController();
		const turn = wakeTurn(h, 0, controller.signal);
		await vi.waitFor(() => expect(present).toHaveBeenCalledTimes(1), { timeout: 15000 });
		controller.abort();
		const { message, marker } = await turn;
		expect(message.stopReason).toBe("aborted");
		// What Pi does the moment the stream ends: save the answer, then agent_end. The checks are soft so one run shows every way the chain breaks.
		const permissionsAtEnd = recordsOf(h, AGY_ACP_PERMISSION).length;
		await h.emit("message_end", { message });
		const answerEntry = h.append({ type: "message", message });
		await h.emit("agent_end", { messages: [message] });
		await new Promise(r => setTimeout(r, 200)); // a late write has landed by now
		expect.soft(permissionsAtEnd, "the permission record is saved before the wake's answer").toBe(1);
		const [permission] = recordsOf(h, AGY_ACP_PERMISSION);
		expect(permission.data).toMatchObject({ inputEntryId: marker.id, reply: "cancelled", reason: "turn-stopped" });
		expect.soft(h.entries.indexOf(permission), "the permission sits before the answer").toBeLessThan(h.entries.indexOf(answerEntry));
		expect.soft(recordsOf(h, AGY_ACP_COMPLETION).at(-1)!.data).toMatchObject({ outcome: "cancelled", assistantId: answerEntry.id });
		expect.soft(h.ctx.ui.notify, "the chat was not retired").not.toHaveBeenCalledWith(AGY_COPY.branch, expect.anything());
		expect.soft((await finished(h, "Still here")).message.stopReason).toBe("stop");
		const reopened = harness("normal", { root: h.root, acp: "", wakeQuietMs: QUIET });
		await h.close(); await reopened.ready;
		expect((await finished(reopened, "After restart")).message.stopReason).toBe("stop");
	});

	// A wake run Pi starts but the provider refuses before it saves the wake record used to leave an assistant message nothing covers: the chain broke for the next wake and for a restart, and AGY was not told to stop.
	/** What Pi does when the wake run ends: save the answer, then agent_end. */
	const endTurn = async (h: Harness, message: any) => { await h.emit("message_end", { message }); const entry = h.append({ type: "message", message }); await h.emit("agent_end", { messages: [message] }); return entry; };

	it("treats Esc pressed before Pi calls the provider for the wake as Esc during it: AGY is told to stop, and the wake is saved so a later wake and a restart work", async () => {
		const h = wakeHarness("");
		await afterTurn(h, "wake");
		const controller = new AbortController();
		controller.abort();
		const { message, marker } = await wakeTurn(h, 0, controller.signal);
		expect.soft(message.stopReason).toBe("aborted");
		const answer = await endTurn(h, message);
		await vi.waitFor(() => expect(received(h, "session/cancel"), "AGY got session/cancel").toHaveLength(1), { timeout: 10000 }); // the fake logs a notification on its own time
		const [wake] = recordsOf(h, AGY_ACP_WAKE);
		expect.soft(wake?.data, "the wake record").toMatchObject({ markerEntryId: marker.id });
		expect.soft(recordsOf(h, AGY_ACP_COMPLETION).at(-1)!.data).toMatchObject({ dispatchId: wake?.id, outcome: "cancelled", assistantId: answer.id });
		await new Promise(r => setTimeout(r, 200));
		expect.soft(h.ctx.ui.notify, "the chat was not retired").not.toHaveBeenCalledWith(AGY_COPY.branch, expect.anything());
		const reopened = harness("normal", { root: h.root, acp: "", wakeQuietMs: QUIET });
		await h.close(); await reopened.ready;
		expect((await finished(reopened, "After restart")).message.stopReason).toBe("stop");
		expect(prompts(reopened)).toEqual(["[wake] go", "After restart"]);
	});

	// Decisions 2026-11-23 (1): a wake that is no longer waiting when its run starts (the owner's 15 s attach timer ran out after the marker went out) is a stopped wake, as with Esc before the claim: AGY gets
	// session/cancel and the 1 s holdoff, the records keep the chain valid, and the chat continues, in the session and after a restart.
	it("ends a wake run whose wake the owner had already given up on as a stopped wake: AGY is told to stop, the wake is saved, and the chat continues in the session and after a restart", async () => {
		const h = wakeHarness("", { wakeAttachMs: 250 });
		await afterTurn(h, "wake");
		const { message, marker } = await wakeTurn(h, 0, undefined, () => new Promise(r => setTimeout(r, 700))); // the owner's attach timer runs out before the provider is called: AGY's frames are gone
		expect.soft(message.stopReason).toBe("aborted");
		// Tom sent nothing in a wake run, so the line says what happened to AGY's work.
		expect.soft(shown(message)).toBe("AGY's work after its turn couldn't be shown in time, so Pi stopped AGY. The chat continues.");
		const answer = await endTurn(h, message);
		await vi.waitFor(() => expect(received(h, "session/cancel"), "AGY got session/cancel").toHaveLength(1), { timeout: 3000 });
		const [wake] = recordsOf(h, AGY_ACP_WAKE);
		expect.soft(wake?.data, "the wake record").toMatchObject({ markerEntryId: marker.id });
		expect.soft(recordsOf(h, AGY_ACP_COMPLETION).at(-1)!.data).toMatchObject({ dispatchId: wake?.id, outcome: "cancelled", assistantId: answer.id });
		expect.soft(received(h, "session/close"), "the owner was kept").toEqual([]);
		expect.soft((await finished(h, "Still here")).message.stopReason).toBe("stop");
		expect.soft(received(h, "session/cancel"), "one cancel, never two").toHaveLength(1);
		expect.soft(h.sent, "the marker only: no second line from the owner's own give-up").toHaveLength(1);
		const reopened = harness("normal", { root: h.root, acp: "", wakeQuietMs: QUIET });
		await h.close(); await reopened.ready;
		expect((await finished(reopened, "After restart")).message.stopReason).toBe("stop");
		expect(prompts(reopened)).toEqual(["[wake] go", "Still here", "After restart"]);
	});

	// Decisions 2026-11-23 (2): Pi stays busy for the owner's whole attach time (15 s in use), so the owner drops the wake before any marker went out. The deferred wake used to vanish: AGY kept working (its next burst
	// started another wake) and Tom saw nothing. Now Pi stops AGY as for a gone run and saves the line once, as a message with no turn: `triggerTurn: false` is what makes a busy Pi hold it until the run ends (Pi 1.6.0 steers
	// a message sent with no `triggerTurn` into the running turn).
	const GONE = "rbf-agy-wake-gone";
	const goneLines = (h: Harness) => h.sent.filter(x => x.message.customType === GONE);
	const markers = (h: Harness) => h.sent.filter(x => x.message.customType === "rbf-agy-wake");

	it("stops AGY and says so once, in a line with no turn of its own, when Pi stays busy until the owner drops the wake before any marker went out, and the chat continues in the session and after a restart", async () => {
		const h = wakeHarness("", { wakeAttachMs: 250 });
		h.state.busy = true; // Pi stays busy for the whole attach time
		await afterTurn(h, "wake");
		await wakeBegan(h);
		await pause(1200); // the owner's timer ran out at 250 ms
		expect.soft(received(h, "session/cancel"), "AGY got session/cancel").toHaveLength(1);
		expect.soft(goneLines(h), "the line was asked for once").toHaveLength(1);
		expect.soft(goneLines(h)[0]?.message).toEqual({ customType: GONE, content: ACP_COPY.wakeGone, display: true });
		expect.soft(goneLines(h)[0]?.options, "display only: no turn, and not steered into the busy run").toEqual({ triggerTurn: false });
		expect.soft(markers(h), "no marker went out").toEqual([]);
		expect.soft(recordsOf(h, AGY_ACP_WAKE), "no wake record").toEqual([]);
		// Pi's side: the busy run ends, and the line it held lands after it. Nothing starts a turn, nothing repeats.
		h.state.busy = false;
		h.append({ type: "custom_message", customType: GONE, content: ACP_COPY.wakeGone, display: true });
		await h.emit("agent_settled", { aborted: false });
		await pause(400);
		expect.soft(received(h, "session/cancel"), "still one cancel").toHaveLength(1);
		expect.soft(h.sent, "no second message").toHaveLength(1);
		expect.soft((await finished(h, "Still here")).message.stopReason).toBe("stop");
		expect.soft(launches(h), "the next send used the same owner").toHaveLength(1);
		expect.soft(received(h, "session/close"), "the owner was kept").toEqual([]);
		const reopened = harness("normal", { root: h.root, acp: "", wakeQuietMs: QUIET });
		await h.close(); await reopened.ready;
		expect((await finished(reopened, "After restart")).message.stopReason).toBe("stop");
		expect(prompts(reopened)).toEqual(["[wake] go", "Still here", "After restart"]);
		expect(new Set(received(reopened, "session/prompt").map(m => m.params.sessionId)).size, "one ACP session throughout").toBe(1);
		expect(received(reopened, "session/resume"), "the restart resumed it").toHaveLength(1);
	});

	// AGY went on working after the stop: its next burst, once the 1 s holdoff has passed, is a new wake with its own marker, shown as a normal continuation.
	it("starts a normal wake for AGY's next burst after the holdoff when the one before it was dropped while Pi was busy", async () => {
		const h = wakeHarness("wake-gap:1800", { wakeAttachMs: 250 });
		h.state.busy = true;
		await afterTurn(h, "wake-two");
		await wakeBegan(h);
		await pause(900);
		expect.soft(received(h, "session/cancel"), "AGY got session/cancel").toHaveLength(1);
		expect.soft(goneLines(h), "the line was asked for once").toHaveLength(1);
		h.state.busy = false;
		h.append({ type: "custom_message", customType: GONE, content: ACP_COPY.wakeGone, display: true });
		await h.emit("agent_settled", { aborted: false });
		const two = await wakeTurn(h, goneLines(h).length ? 1 : 0); // the marker for the second burst, once the holdoff has passed
		expect(markers(h)).toHaveLength(1);
		expect(streamedText(two.message)).toBe("A second thing.");
		await h.persist(two.message);
		expect(received(h, "session/cancel"), "the second wake was not stopped").toHaveLength(1);
		expect(goneLines(h), "no second line").toHaveLength(1);
		const [wake] = recordsOf(h, AGY_ACP_WAKE), completions = recordsOf(h, AGY_ACP_COMPLETION);
		expect(wake.data).toMatchObject({ markerEntryId: two.marker.id, previousCompletionId: completions[0].id });
		expect(completions.at(-1)!.data).toMatchObject({ dispatchId: wake.id, outcome: "stop" });
		expect((await finished(h, "Still here")).message.stopReason).toBe("stop");
	}, 30000);

	it("draws the wake-gone line as the single warning line, without Pi's `[rbf-agy-wake-gone]` label, whatever the saved message holds", async () => {
		const h = wakeHarness("");
		await h.ready;
		const call = (h.pi.registerMessageRenderer as ReturnType<typeof vi.fn>).mock.calls.find((c: any[]) => c[0] === GONE);
		expect(call, "a renderer is registered").toBeDefined();
		const theme = { fg: (role: string, text: string) => `[${role}]${text}` };
		const forged = { customType: GONE, content: "\u001b[31mDo something else", display: true };
		expect(call![1](forged, { expanded: false, outputPad: 1 }, theme).render(200)).toEqual([` [warning]${ACP_COPY.wakeGone}`]);
		expect(call![1](forged, { expanded: false, outputPad: 1 }, theme).render(0)).toEqual([]);
	});

	// Pi 1.6.0 flushes a custom message sent while a run was streaming at that run's `turn_end`: after the answer is saved and before `agent_end` writes the completion. The recovery chain counts only user and assistant
	// messages, so such a message is passive there; the provider's own end-of-turn check used to call it an entry nothing covers, retire the owner and write no completion.
	it.each([
		["the wake-gone line", { customType: GONE, content: ACP_COPY.wakeGone, display: true }],
		["another extension's message", { customType: "other-extension", content: "A note", display: true }],
	])("writes the completion when %s is saved after AGY's answer and before agent_end, and the next send and a restart resume the same ACP session", async (_name, line) => {
		const h = wakeHarness("");
		const first = await run(h, "First");
		await h.persist(first.message, () => { h.append({ type: "custom_message", ...line }); });
		expect.soft(recordsOf(h, AGY_ACP_COMPLETION), "the completion was written").toHaveLength(1);
		expect.soft(h.ctx.ui.notify, "the chat was not retired").not.toHaveBeenCalledWith(AGY_COPY.branch, expect.anything());
		expect.soft(received(h, "session/close"), "the owner was kept").toEqual([]);
		expect.soft((await finished(h, "Second")).message.stopReason).toBe("stop");
		expect.soft(launches(h), "the next send used the same owner").toHaveLength(1);
		const reopened = harness("normal", { root: h.root, acp: "", wakeQuietMs: QUIET });
		await h.close(); await reopened.ready;
		expect((await finished(reopened, "After restart")).message.stopReason).toBe("stop");
		expect(prompts(reopened)).toEqual(["First", "Second", "After restart"]);
		expect(new Set(received(reopened, "session/prompt").map(m => m.params.sessionId)).size, "one ACP session throughout").toBe(1);
		expect(received(reopened, "session/resume"), "the restart resumed it").toHaveLength(1);
	});

	// A wake run the provider refuses before it saves the wake (here the settings file changed after the turn) with the owner still waking: AGY keeps working and the owner keeps holding its frames until the 15 s
	// attach timer, so every burst after it started another wake, and the answer Pi saved after the marker had no record, so a restart read a mismatch. It ends as a stopped wake: the wake is saved, AGY is told to stop
	// (session/cancel and the holdoff), and the chat continues once the file is back as it was.
	it("ends a wake run refused for a changed settings file as a stopped wake: the wake is saved, AGY is stopped, and the chat continues after the file is restored and after a restart", async () => {
		const dir = mkdtempSync(join(roots!, "policy-")), file = join(dir, "settings.json");
		writeFileSync(file, '{"enableTerminalSandbox":false}', { mode: 0o600 });
		const h = wakeHarness("cancel-trails", { policy: file });
		await afterTurn(h, "wake-long");
		writeFileSync(file, '{"enableTerminalSandbox":true}', { mode: 0o600 });
		const { message, marker } = await wakeTurn(h);
		expect.soft(message.stopReason).toBe("aborted");
		expect.soft(shown(message)).toBe(ACP_COPY.wakeRefused);
		const answer = await endTurn(h, message);
		await vi.waitFor(() => expect(received(h, "session/cancel"), "AGY got session/cancel").toHaveLength(1), { timeout: 3000 });
		const [wake] = recordsOf(h, AGY_ACP_WAKE);
		expect.soft(wake?.data, "the wake record").toMatchObject({ markerEntryId: marker.id });
		expect.soft(recordsOf(h, AGY_ACP_COMPLETION).at(-1)!.data).toMatchObject({ dispatchId: wake?.id, outcome: "cancelled", assistantId: answer.id });
		await pause(1400); // longer than the holdoff: what AGY had already sent after the cancel starts no new wake
		expect.soft(h.sent, "no second wake").toHaveLength(1);
		writeFileSync(file, '{"enableTerminalSandbox":false}', { mode: 0o600 });
		expect.soft((await finished(h, "Still here")).message.stopReason).toBe("stop");
		const reopened = harness("normal", { root: h.root, acp: "", policy: file, wakeQuietMs: QUIET });
		await h.close(); await reopened.ready;
		expect((await finished(reopened, "After restart")).message.stopReason).toBe("stop");
	}, 30000);

	// A wake run the provider cannot even place (no marker on the branch) is refused before anything can be saved. Whatever refuses it, the line says what happened to AGY's work, never that a message was not sent,
	// and AGY is stopped so it does not start another wake every 15 s.
	it("says what happened to AGY's work, not that a message was not sent, when it refuses a wake run for any other reason, and stops AGY", async () => {
		const h = wakeHarness("cancel-trails");
		await afterTurn(h, "wake-long");
		await vi.waitFor(() => expect(h.sent).toHaveLength(1), { timeout: 10000 });
		await h.emit("before_agent_start", { messageType: "custom", message: { role: "custom", ...MARKER, timestamp: Date.now() } }); // Pi starts the run, but the marker is not on the branch
		const stream = await h.registration.streamSimple(h.ctx.model, { systemPrompt: "", messages: [] }, {});
		for await (const _ of stream) { /* drain */ }
		const message = await stream.result();
		expect(message.stopReason).toBe("error");
		expect(shown(message)).toBe(ACP_COPY.wakeRefused);
		expect(shown(message)).not.toMatch(/not sent/);
		await vi.waitFor(() => expect(received(h, "session/cancel"), "AGY got session/cancel").toHaveLength(1), { timeout: 3000 });
		await pause(1400);
		expect(h.sent, "no second wake").toHaveLength(1);
	}, 30000);

	// A wake that starts while Tom's typed prompt is still setting AGY's model or effort: the prompt holds the provider (acpActive) with the owner idle, so the owner starts the wake, and the provider used to give it
	// up on the spot, dropping what AGY said and answering a woken permission request `cancelled` with no record. It waits like any busy moment; the prompt meets the waking owner and is refused as busy.
	it("keeps a wake that starts while a typed prompt is setting AGY's model or effort, refuses the prompt as busy, and then runs the wake turn", async () => {
		const h = wakeHarness("wake-hold,slow-set:500");
		await afterTurn(h, "wake");
		const typed = run(h, "Typed while AGY wakes", { reasoning: "low" }); // a new effort: two settings calls, slow
		await vi.waitFor(() => expect(received(h, "session/set_config_option").length).toBeGreaterThan(2), { timeout: 15000 }); // the typed prompt's first call is out
		await wakeNow(h); // AGY wakes inside it
		const refused = await typed;
		expect(shown(refused.message)).toBe(AGY_COPY.busy);
		expect(prompts(h)).toEqual(["[wake] go"]); // nothing of Tom's went to AGY
		await h.persist(refused.message); // the refusal is saved, and agent_end records it
		await h.emit("agent_settled", { aborted: false });
		const { message, marker } = await wakeTurn(h);
		expect(streamedText(message)).toBe("Background job finished."); // AGY's work was not lost
		await endTurn(h, message);
		expect(recordsOf(h, AGY_ACP_REFUSAL)).toHaveLength(1);
		const [wake] = recordsOf(h, AGY_ACP_WAKE);
		expect(wake.data).toMatchObject({ markerEntryId: marker.id });
		const reopened = harness("normal", { root: h.root, acp: "", wakeQuietMs: QUIET });
		await h.close(); await reopened.ready;
		expect((await finished(reopened, "After restart")).message.stopReason).toBe("stop");
	});

	// A wake freezes the pair AGY holds when it starts. After an update between turns cleared the acknowledgement it froze nothing, so AGY moving its own model during the wake was not seen: the wake ended as
	// a normal stop, and its completion vouched for a pair AGY no longer ran.
	it("ends a wake in which AGY moved its own model as diverged, with no completion, also when an update between turns cleared the acknowledgement", async () => {
		const h = wakeHarness("clear-ack");
		await afterTurn(h, "wake-move");
		const { message } = await wakeTurn(h);
		expect(message.stopReason).toBe("error");
		expect(shown(message)).toContain(ACP_COPY.diverged);
		await endTurn(h, message);
		expect(recordsOf(h, AGY_ACP_WAKE)).toHaveLength(1);
		expect(recordsOf(h, AGY_ACP_COMPLETION)).toHaveLength(1); // the first turn's only: nothing vouches for the wake
	});

	it("keeps a wake in which AGY only repeated its settings as a normal turn, after an update between turns cleared the acknowledgement", async () => {
		const h = wakeHarness("clear-ack");
		await afterTurn(h, "wake-repeat");
		const { message } = await wakeTurn(h);
		expect(message.stopReason).toBe("stop");
		expect(streamedText(message)).toBe("Working. Done.");
		await endTurn(h, message);
		expect(recordsOf(h, AGY_ACP_COMPLETION)).toHaveLength(2);
	});

	// A wake that starts while Tom's prompt is in its settings step is kept (the previous change), but the step itself can still fail: an effort AGY will not take, a command list that never arrives, a name that is an
	// AGY command. Each refuses the prompt before anything is sent, and the provider used to retire the owner for it because it was no longer idle, which lost the wake. Tom's prompt gets the busy refusal instead.
	it("refuses a prompt whose settings step fails after AGY woke as busy, keeps the owner, and still runs the wake turn", async () => {
		const h = wakeHarness("no-commands,wake-hold");
		await afterTurn(h, "wake");
		const typed = run(h, "/goal now"); // the command list never arrives: the step waits 2 s for it, and AGY wakes meanwhile
		await vi.waitFor(() => expect(h.logs().some(x => x.args)).toBe(true), { timeout: 5000 });
		await pause(200);
		await wakeNow(h);
		const refused = await typed;
		expect(shown(refused.message)).toBe(AGY_COPY.busy); // not "AGY's command list didn't arrive"
		expect(received(h, "session/close"), "the owner was kept").toEqual([]);
		await h.persist(refused.message);
		await h.emit("agent_settled", { aborted: false });
		const { message } = await wakeTurn(h);
		expect(streamedText(message)).toBe("Background job finished."); // AGY's work was not lost
		await endTurn(h, message);
		expect(prompts(h)).toEqual(["[wake] go"]);
		expect((await finished(h, "Still here")).message.stopReason).toBe("stop");
	}, 20000);

	// Esc pressed before Pi calls the provider for the wake, with a permission request as AGY's first frame: the owner answered it `cancelled` itself, with no dialog, no record and no line, so Tom never learned AGY
	// had asked. The request now goes through the same handler as during a stopped turn: a `turn-stopped` record under the marker, before the wake's answer.
	it("records a permission request AGY held when Esc came before the wake run, as rejected because the turn stopped", async () => {
		const present = vi.fn(async () => "accept" as const);
		const h = wakeHarness("", { presentApproval: present as any });
		await afterTurn(h, "perm-between");
		await vi.waitFor(() => expect(h.sent).toHaveLength(1), { timeout: 10000 });
		const controller = new AbortController();
		controller.abort();
		const { message, marker } = await wakeTurn(h, 0, controller.signal);
		expect(message.stopReason).toBe("aborted");
		expect(present, "no dialog opens in a stopped turn").not.toHaveBeenCalled();
		const [permission] = recordsOf(h, AGY_ACP_PERMISSION);
		expect(permission?.data, "the permission record, saved before the wake's answer").toMatchObject({ inputEntryId: marker.id, reply: "cancelled", reason: "turn-stopped", toolCallId: "call_perm_between" });
		await vi.waitFor(() => expect(h.logs().find(x => x.betweenPermissionReply)?.betweenPermissionReply).toEqual({ outcome: { outcome: "cancelled" } }), { timeout: 5000 });
		const answer = await endTurn(h, message);
		expect(h.entries.indexOf(permission)).toBeLessThan(h.entries.indexOf(answer));
		expect(recordsOf(h, AGY_ACP_COMPLETION).at(-1)!.data).toMatchObject({ outcome: "cancelled", assistantId: answer.id });
	}, 30000);

	// A stopped wake (Esc before the run, or a refused run) takes the permission requests AGY held out of the buffer and answers them. The settings and command-list updates it held belong to nobody and still have
	// to reach Pi's snapshot: a wake that dropped them left Pi trusting a pair AGY had moved away from, and the next send skipped its settings calls.
	/** A first turn, and the fake's own command list (it sends one 80 ms after the session starts), so the list AGY sends while it wakes is the later one. */
	const warmUp = async (h: Harness) => {
		await finished(h, "Warm up");
		await vi.waitFor(() => expect(h.logs().some(x => x.out?.params?.update?.availableCommands?.some((c: any) => c.name === "goal"))).toBe(true), { timeout: 10000 });
	};
	const woke = async (h: Harness) => { // AGY has finished its burst: a chunk, a move of its own model, a new command list, a chunk
		await vi.waitFor(() => expect(h.logs().some(x => x.out?.params?.update?.availableCommands?.some((c: any) => c.name === "woke-cmd"))).toBe(true), { timeout: 10000 });
		await vi.waitFor(() => expect(h.sent).toHaveLength(1), { timeout: 10000 });
		await pause(200); // and the owner has read it: the fake's pipe is read on the owner's own time
	};
	const nextSend = async (h: Harness) => {
		const before = received(h, "session/set_config_option").length;
		expect((await finished(h, "Next question")).message.stopReason).toBe("stop");
		expect(received(h, "session/set_config_option").length - before, "the pair AGY moved is set again before the prompt").toBe(2);
		const refused = await run(h, "/woke-cmd now");
		expect(shown(refused.message), "the command list AGY sent while it woke").toBe(ACP_COPY.agyCommand("woke-cmd"));
	};

	it("keeps the settings and command-list updates a wake held when Esc came before the wake run", async () => {
		const h = wakeHarness("");
		await warmUp(h);
		await afterTurn(h, "wake-move");
		await woke(h);
		const controller = new AbortController();
		controller.abort();
		const { message } = await wakeTurn(h, 0, controller.signal);
		expect(message.stopReason).toBe("aborted");
		await endTurn(h, message);
		await nextSend(h);
	}, 30000);

	it("keeps the settings and command-list updates a wake held when the run is refused for a changed settings file", async () => {
		const dir = mkdtempSync(join(roots!, "policy-")), file = join(dir, "settings.json");
		writeFileSync(file, '{"enableTerminalSandbox":false}', { mode: 0o600 });
		const h = wakeHarness("", { policy: file });
		await warmUp(h);
		await afterTurn(h, "wake-move");
		await woke(h);
		writeFileSync(file, '{"enableTerminalSandbox":true}', { mode: 0o600 });
		const { message } = await wakeTurn(h);
		expect(shown(message)).toBe(ACP_COPY.wakeRefused);
		await endTurn(h, message);
		writeFileSync(file, '{"enableTerminalSandbox":false}', { mode: 0o600 });
		await nextSend(h);
	}, 30000);

	// Design 14:165: a wake run refused because the recovery chain does not hold retires the owner, whatever state the wake was in. A wake the owner had given up on left the owner idle, and the retire rule only
	// looked for an owner that was not idle, so it was kept, running on a chain that no longer holds.
	it("retires the owner when a wake run the owner had given up on is refused because the saved chain does not hold", async () => {
		const h = wakeHarness("", { wakeAttachMs: 250 });
		await afterTurn(h, "wake");
		h.append({ type: "message", message: { role: "user", content: [{ type: "text", text: "A message nothing answered" }], timestamp: Date.now() } }); // the chain finds an unanswered message in front of the wake
		const { message } = await wakeTurn(h, 0, undefined, () => new Promise(r => setTimeout(r, 700)));
		expect(message.stopReason).toBe("error");
		expect(shown(message)).toBe(ACP_COPY.wakeRefused);
		await vi.waitFor(() => expect(received(h, "session/close"), "the owner was retired").toHaveLength(1), { timeout: 5000 });
	}, 30000);

	it("refuses a message typed during the wake with nothing sent, finishes the wake, and records both so a restart resumes", async () => {
		const h = wakeHarness("");
		await afterTurn(h, "wake");
		const { message } = await wakeTurn(h);
		await h.emit("message_end", { message });
		const answerEntry = h.append({ type: "message", message });
		const typed = await run(h, "Typed during the wake"); // Pi offers the queued message after the wake's answer is saved
		expect(shown(typed.message)).toBe(AGY_COPY.busy);
		await h.emit("message_end", { message: typed.message });
		h.append({ type: "message", message: typed.message });
		await h.emit("agent_end", { messages: [message, typed.message] });
		expect(prompts(h)).toEqual(["[wake] go"]);
		const [wake] = recordsOf(h, AGY_ACP_WAKE), refusal = recordsOf(h, AGY_ACP_REFUSAL)[0], completion = recordsOf(h, AGY_ACP_COMPLETION).at(-1)!;
		expect(refusal.data).toMatchObject({ dispatchId: wake.id });
		expect(completion.data).toMatchObject({ dispatchId: wake.id, assistantId: answerEntry.id });
		const reopened = harness("normal", { root: h.root, acp: "", wakeQuietMs: QUIET });
		await h.close(); await reopened.ready;
		expect((await finished(reopened, "After restart")).message.stopReason).toBe("stop");
	});

	it("reads a wake Pi did not finish saving as unknown on restart, never as continued", async () => {
		const h = wakeHarness("");
		await afterTurn(h, "wake");
		const { message } = await wakeTurn(h);
		await h.emit("message_end", { message });
		h.append({ type: "message", message }); // the answer is saved; the completion never is (Pi quit before agent_end)
		expect(recordsOf(h, AGY_ACP_WAKE)).toHaveLength(1);
		await h.close();
		const reopened = harness("normal", { root: h.root, acp: "", wakeQuietMs: QUIET });
		await reopened.ready;
		expect(shown((await run(reopened, "After restart")).message)).toBe(RECOVERY_COPY.unknown);
		expect(prompts(reopened)).toEqual(["[wake] go"]); // the log is shared: the first turn's prompt only, nothing new
	});

	it("waits for Pi to settle before asking for the marker when AGY speaks while Pi is still finishing its turn", async () => {
		const h = wakeHarness("");
		h.state.busy = true; // Pi is still inside the previous run
		await afterTurn(h, "wake");
		await wakeBegan(h); // under load the fake can take a while to speak; the marker must wait for the settle, not for the clock
		await pause(300);
		expect(h.sent).toEqual([]);
		h.state.busy = false;
		await h.emit("agent_settled", { aborted: false });
		expect(h.sent).toHaveLength(1);
		const { message } = await wakeTurn(h);
		expect(streamedText(message)).toBe("Background job finished.");
	});

	// Pi runs input handlers and checks auth for a typed prompt while isIdle() is still true, so a marker sent in that window starts a run of its own and the prompt throws. Mode `wake-hold` keeps the fake AGY quiet until the test says go.
	it("holds a wake from the `input` event of an idle Pi until that prompt's run starts, then sends the marker when Pi settles", async () => {
		const h = wakeHarness("wake-hold");
		await afterTurn(h, "wake");
		await h.emit("input", { text: "typed while AGY wakes", source: "interactive" }); // Pi is idle: the prompt's run has not started
		await wakeNow(h);
		await pause(300);
		expect(h.sent).toEqual([]); // held: a marker now would start a run under the prompt
		h.state.busy = true;
		await h.emit("before_agent_start", { messageType: "user", prompt: "typed while AGY wakes" }); // the prompt's run started: the hold is over
		await pause(500);
		expect(h.sent).toEqual([]); // but Pi is running the prompt, so the marker still waits
		h.state.busy = false;
		await h.emit("agent_settled", { aborted: false });
		expect(h.sent).toHaveLength(1);
	});

	it("lets go of the hold after 2 s when the prompt never becomes a run", async () => {
		const h = wakeHarness("wake-hold");
		await afterTurn(h, "wake");
		const start = Date.now();
		await h.emit("input", { text: "handled by another extension", source: "interactive" });
		await wakeNow(h);
		await pause(500);
		expect(h.sent).toEqual([]);
		await vi.waitFor(() => expect(h.sent).toHaveLength(1), { timeout: 15000 });
		expect(Date.now() - start).toBeGreaterThanOrEqual(1900);
	});

	it("does not hold a wake for an `input` event that arrives while Pi is running", async () => {
		const h = wakeHarness("wake-hold");
		await afterTurn(h, "wake");
		h.state.busy = true;
		await h.emit("input", { text: "queued for the running turn", source: "interactive", streamingBehavior: "steer" });
		h.state.busy = false;
		await wakeNow(h);
		await vi.waitFor(() => expect(h.sent).toHaveLength(1), { timeout: 1000 });
	});

	// agent_settled fires only when a run ends. A wake deferred for another reason (compaction, a /tree summary, a failed run start) would wait for the owner's 15 s give-up and lose what AGY said.
	it("sends a deferred wake once Pi is idle again even though no run ended, without waiting for agent_settled", async () => {
		const h = wakeHarness("");
		h.state.busy = true; // Pi is compacting: busy, with no run that will end
		await afterTurn(h, "wake");
		await wakeBegan(h);
		await pause(400);
		expect(h.sent).toEqual([]);
		h.state.busy = false; // the compaction was cancelled; Pi emits no agent_settled
		await vi.waitFor(() => expect(h.sent).toHaveLength(1), { timeout: 1000 });
		const { message } = await wakeTurn(h);
		expect(streamedText(message)).toBe("Background job finished.");
	});

	it("refuses a run for the marker when AGY is not waking, and sends AGY nothing", async () => {
		const h = wakeHarness("");
		await afterTurn(h, "empty");
		const marker = h.append({ type: "custom_message", customType: "rbf-agy-wake", content: "AGY continued on its own.", display: true });
		await h.emit("before_agent_start", { messageType: "custom", message: { role: "custom", ...MARKER } });
		const stream = await h.registration.streamSimple(h.ctx.model, { systemPrompt: "", messages: [] }, {});
		for await (const _ of stream) { /* drain */ }
		const message = await stream.result();
		expect(message.stopReason).toBe("error");
		expect(prompts(h)).toEqual(["[empty] go"]);
		expect(recordsOf(h, AGY_ACP_WAKE)).toEqual([]);
		void marker;
	});

	// Decisions 2026-11-22: AGY 1.5.10 and later stop a session's subagents and background tasks on cancel and close, so a verified clean stop on ACP says so.
	it("says AGY stopped along with its subagents and background tasks after a verified clean ACP stop, in the widget and in the line under an error", async () => {
		const h = wakeHarness("");
		await finished(h, "First question");
		await h.close();
		expect(stopWidget(h)).toEqual(["AGY stopped, along with its subagents and background tasks."]);
		const drift = wakeHarness("");
		const out = await run(drift, "[diverge] go"); // AGY changes its own settings mid-turn: the answer stays, the chat stops
		expect(shown(out.message)).toBe(`Answered anyway.\n${ACP_COPY.diverged}\nAGY stopped, along with its subagents and background tasks.`);
	});

	it("a message from the user after a user turn is not a wake: before_agent_start for a user prompt leaves the flag off", async () => {
		const h = wakeHarness("");
		await h.ready;
		await h.emit("before_agent_start", { messageType: "user", prompt: "hello" });
		const out = await finished(h, "plain question");
		expect(out.message.stopReason).toBe("stop");
		expect(prompts(h)).toEqual(["plain question"]);
	});
});
