// #pi-21: AGY owns execution/context/policy; Pi selects and displays the provider.
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
export const AGY_PROVIDER = "agy-harness";
export const AGY_API = "rbf-agy";
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const CURRENT_FAMILIES = new Set(["gemini-4-argon", "gemini-3.8-flash", "claude-opus-5-5", "claude-sonnet-5-5"]);
const EVIDENCED_EFFORTS = new Set(["low", "medium", "high"]);
const COMPATIBILITY_LIMIT = 1000000000; // suppress host compaction; never a displayed native capacity
const UNPRICED = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
export const AGY_COPY = {
	bootstrap: "AGY has no work model selected. Your message was not sent. Open /model and select an available AGY model.",
	unsupported: "AGY does not support the requested model or effort. Your message was not sent. Select an available AGY model and supported effort.",
	ended: "AGY context has ended. Your message was not sent. Use /new, select an AGY model, and send a new task.",
	settings: "AGY settings differ from this conversation. Your message was not sent. Use /new to change settings and start a new conversation.",
	branch: "AGY context for this branch cannot be verified. Your message was not sent. Use /new and send a new task.",
	policy: "AGY session settings changed. Your message was not sent. Use /new to load the settings for a new conversation.",
	busy: "AGY is busy. Your message was not sent. Wait for the current request to finish.",
	cold: "AGY starts with new context. Earlier Pi messages are not transferred.",
	startup: "AGY could not start. Your message was not sent. Check native AGY, then use /new and send a new task.",
	protocol: "AGY returned an invalid response. The task outcome is unknown. Use /new after this conversation stops.",
	stopped: "AGY stopped. Commands it started may still be running.",
	stopUnknown: "AGY stop could not be verified. Commands it started may still be running.",
} as const;
export interface AgyCatalogueModel {
	id: string;
	name: string;
	variants: Record<string, string>;
	fixed?: string;
}
export function parseAgyCatalogue(text: string): AgyCatalogueModel[] {
	if (Buffer.byteLength(text) > 256 * 1024 || !text.trim())
		throw new Error("AGY model catalogue is empty or too large");
	const rows = text.trimEnd().split(/\r?\n/);
	if (rows.length > 512)
		throw new Error("AGY model catalogue is too large");
	const seen = new Set<string>();
	const models = new Map<string, AgyCatalogueModel>();
	for (const line of rows) {
		const cols = line.split("\t");
		const [id, name] = cols;
		if (cols.length !== 2 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(id) || !name?.trim() || /[\x00-\x1f\x7f-\x9f]/.test(name) || seen.has(id))
			throw new Error("Invalid or ambiguous AGY model catalogue");
		seen.add(id);
		const match = id.match(/^(.*)-(low|medium|high|xhigh|max)$/);
		const grouped = !!match && CURRENT_FAMILIES.has(match[1]) && EVIDENCED_EFFORTS.has(match[2]);
		const key = grouped ? match![1] : id;
		if (grouped) {
			let family = models.get(key);
			if (!family) {
				family = { id: key, name: name.replace(/\s*\((low|medium|high)\)\s*$/i, ""), variants: {} };
				models.set(key, family);
			}
			if (family.fixed)
				throw new Error("Ambiguous AGY model family");
			family.variants[match![2]] = id;
		}
		else {
			if (models.has(key))
				throw new Error("Ambiguous AGY model family");
			models.set(key, { id, name, variants: {}, fixed: id });
		}
	}
	return [...models.values()];
}
export function toAgyProviderModel(m: AgyCatalogueModel): ProviderModelConfig {
	const thinkingLevelMap: Record<string, string | null> = Object.fromEntries(LEVELS.map(level => [level, m.variants[level] ?? null]));
	return { id: m.id, name: `${m.name} (AGY agent)`, reasoning: !m.fixed, thinkingLevelMap, input: ["text"], contextWindow: COMPATIBILITY_LIMIT, maxTokens: COMPATIBILITY_LIMIT, cost: { ...UNPRICED } };
}
const REMOVED_MODEL_ID = "agy-select-model"; // Refuse retired selections; never advertise this ID.
export function resolveAgySelection(model: ProviderModelConfig, level: string | undefined): {
	nativeModel: string;
	nativeEffort?: string;
} {
	if (model.id === REMOVED_MODEL_ID)
		throw new Error(AGY_COPY.bootstrap);
	if (!model.reasoning) {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(model.id))
			throw new Error(AGY_COPY.unsupported);
		return { nativeModel: model.id };
	}
	const variant = level ? (model.thinkingLevelMap as Record<string, string | null> | undefined)?.[level] : undefined;
	if (typeof variant !== "string" || !EVIDENCED_EFFORTS.has(level!) || !CURRENT_FAMILIES.has(model.id) || variant !== `${model.id}-${level}`)
		throw new Error(AGY_COPY.unsupported);
	return { nativeModel: variant, nativeEffort: level };
}
// The public provider owns no native work until the first admitted user request.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { VERSION, parseArgs, FooterComponent, ThinkingSelectorComponent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type RefreshModelsContext, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, stripTerminalSequences } from "@earendil-works/pi-tui";
import { AGY_EXECUTABLE, MIN_PI_VERSION, BOUNDS, parseVersion, versionAtLeast, checkAgyVersion, acquireOwnedChild, executeTurn, closeChildProcess, sanitizeDisplayText, type LiveOwner, type ControllerTracer } from "./lib/agy-native.js";
import { AGY_ACTIVITY, AGY_HISTORY_FAILURE, newAgyActivityBudget, recordAgyActivity, renderAgyActivity } from "./lib/agy-history.js";
export const AGY_PROVENANCE = "rbf-agy-conversation/v1";
export interface AgyRetirementSeal {
	owner?: symbol;
	/** Presentation only; never an admission or resource-release condition. */
	stopNotice?: "stopped" | "unverified";
}
const SEAL_KEY = Symbol.for("rbf.agy.unretired-owner");
function processSeal(): AgyRetirementSeal { return (globalThis as any)[SEAL_KEY] ??= {}; }
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...UNPRICED, total: 0 } }; // untracked; hidden by AGY UI, never native free/zero-usage claim
export interface AgyPolicy {
	path: string;
	hash: string;
	json: string;
	sandbox: boolean;
}
export function readAgyPolicy(file: unknown): AgyPolicy | undefined {
	if (file === undefined)
		return undefined;
	if (typeof file !== "string" || !path.isAbsolute(file))
		throw new Error("AGY session settings need an absolute user-owned JSON file. Your message was not sent.");
	let fd: number | undefined;
	try {
		fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 || stat.size > 65536)
			throw new Error();
		const bytes = Buffer.alloc(65537);
		let n = 0;
		while (n < bytes.length) {
			const got = readSync(fd, bytes, n, bytes.length - n, null);
			if (!got)
				break;
			n += got;
		}
		if (n > 65536)
			throw new Error();
		const raw = bytes.subarray(0, n), json = new TextDecoder("utf-8", { fatal: true }).decode(raw), value = JSON.parse(json);
		if (!value || Array.isArray(value) || typeof value !== "object")
			throw new Error();
		if (value.enableTerminalSandbox !== undefined && typeof value.enableTerminalSandbox !== "boolean")
			throw new Error();
		return Object.freeze({ path: file, hash: createHash("sha256").update(raw).digest("hex"), json, sandbox: value.enableTerminalSandbox === true });
	}
	catch {
		throw new Error("AGY session settings are invalid or unreadable. Your message was not sent. Check the user-owned JSON file and use /new.");
	}
	finally {
		if (fd !== undefined)
			closeSync(fd);
	}
}
export function agyPolicyArgs(p?: AgyPolicy): string[] { return p ? [...(p.sandbox ? ["--sandbox"] : []), "--settings", p.json] : []; }
export function sameAgyPolicy(p: AgyPolicy | undefined, file: unknown): boolean {
	try {
		const next = readAgyPolicy(file);
		return next?.path === p?.path && next?.hash === p?.hash;
	}
	catch {
		return false;
	}
}
export function readAgyCatalogue(executable: string, signal?: AbortSignal): Promise<AgyCatalogueModel[]> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("AGY model refresh cancelled"));
			return;
		}
		let child: ReturnType<typeof spawn>;
		let output = Buffer.alloc(0), settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (error?: Error, value?: AgyCatalogueModel[]) => {
			if (settled)
				return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			error ? reject(error) : resolve(value!);
		};
		const stop = (message: string) => {
			try {
				child?.kill("SIGKILL");
			}
			catch { }
			child?.stdout?.destroy();
			child?.stderr?.destroy();
			finish(new Error(message));
		};
		const abort = () => stop("AGY model refresh cancelled");
		try {
			child = spawn(executable, ["models"], { shell: false, stdio: ["ignore", "pipe", "ignore"] });
		}
		catch {
			finish(new Error("AGY model catalogue unavailable"));
			return;
		}
		timer = setTimeout(() => stop("AGY model refresh timed out"), 10000);
		signal?.addEventListener("abort", abort, { once: true });
		child.on("error", () => finish(new Error("AGY model catalogue unavailable")));
		child.stdout?.on("data", (bytes: Buffer) => {
			if (output.length + bytes.length > 256 * 1024) {
				stop("AGY model catalogue too large");
				return;
			}
			output = Buffer.concat([output, bytes]);
		});
		child.on("close", code => {
			if (settled)
				return;
			try {
				if (code !== 0)
					throw new Error();
				finish(undefined, parseAgyCatalogue(new TextDecoder("utf-8", { fatal: true }).decode(output)));
			}
			catch {
				finish(new Error("AGY model catalogue unavailable or invalid"));
			}
		});
	});
}
// Existing Pi-RBF footer registry: this hook composes with Codex, age and badges.
const FOOTER_KEY = Symbol.for("@earendil-works/pi-rbf:footer-registry");
function footerRegistry(): {
	proto: any;
	registry: any;
} {
	const proto = FooterComponent.prototype as any;
	let registry = proto[FOOTER_KEY];
	if (!registry) {
		const r: any = { hooks: new Map(), originalRender: proto.render, originalHandleMouse: proto.handleMouse };
		r.installedRender = function(this: any, width: number) {
			let lines = r.originalRender.call(this, width);
			for (const h of r.hooks.values()) {
				try {
					lines = h.render.call(this, lines, width);
				}
				catch { }
			}
			return lines;
		};
		r.installedHandleMouse = function(this: any, event: any) {
			if (r.isHandlingMouse)
				return;
			r.isHandlingMouse = true;
			try {
				const base = r.originalHandleMouse?.call(this, event);
				if (base?.handled)
					return base;
				for (const h of r.hooks.values()) {
					try {
						const result = h.handleMouse?.call(this, event);
						if (result?.handled)
							return result;
					}
					catch { }
				}
				return base;
			}
			finally {
				r.isHandlingMouse = false;
			}
		};
		registry = proto[FOOTER_KEY] = r;
		proto.render = r.installedRender;
		proto.handleMouse = r.installedHandleMouse;
	}
	return { proto, registry };
}
const CONTEXT_METRIC = /(?:\d+(?:\.\d+)?%|\?)\/[\d.]+[kM]?(?: \(auto\))?/;
export function projectAgyFooter(lines: string[], width: number): string[] {
	if (!lines[1])
		return lines;
	const out = lines.map(line => truncateToWidth(line, Math.max(0, width), ""));
	const pad = lines[1].match(/^(.*?)( {2,})(.*)$/);
	let left = pad ? pad[1] : lines[1];
	const right = pad?.[3] ?? "";
	left = left.replace(/(?:↑|↓|R|W)\d+(?:\.\d+)?[kM]?/g, "").replace(/CH\d+(?:\.\d+)?%/g, "").replace(/\$\d+(?:\.\d+)?(?: \(sub\))?/g, "");
	left = CONTEXT_METRIC.test(left) ? left.replace(CONTEXT_METRIC, "AGY context: unknown") : "AGY context: unknown";
	left = left.replace(/ {2,}/g, " ").trim();
	left = truncateToWidth(left, Math.max(0, width), "");
	const room = width - visibleWidth(left) - 2;
	const model = room > 0 ? truncateToWidth(right, room, "") : "";
	out[1] = left + (model ? " ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(model))) + model : "");
	return out;
}
export function projectAgyThinking(lines: string[], width: number): string[] {
	return lines.flatMap(line => {
		const plain = stripTerminalSequences(line).trim();
		if (/^[─-]+$/.test(plain))
			return [truncateToWidth(line, Math.max(0, width), "")];
		const text = line.replace(/\(~[\d.]+k tokens\)/g, "(AGY tier)").replace("cycles thinking levels in-session", "selects effort for the next AGY conversation");
		return visibleWidth(text) > width ? wrapTextWithAnsi(text, Math.max(1, width)) : [text];
	});
}
export function installAgyUi(selected: () => boolean): {
	dispose(): void;
} {
	let active = true;
	const { proto, registry } = footerRegistry();
	const hook = {
		id: "agy-context", render(this: any, lines: string[], width: number) {
			if (!active || !selected())
				return lines;
			const base = CONTEXT_METRIC.test(lines[1] ?? "") ? lines : registry.originalRender.call(this, Math.max(width, 512));
			return projectAgyFooter(base, width);
		}, handleMouse() { return undefined; }
	};
	const rest = [...registry.hooks].filter(([id]: [
		string,
		unknown
	]) => id !== hook.id);
	registry.hooks.clear();
	registry.hooks.set(hook.id, hook);
	for (const [id, h] of rest)
		registry.hooks.set(id, h);
	const thinking = ThinkingSelectorComponent.prototype as any, original = thinking.render;
	const render = function(this: any, width: number) { const on = active && selected(); const lines = original.call(this, on ? Math.max(80, width) : width); return on ? projectAgyThinking(lines, width) : lines; };
	thinking.render = render;
	return {
		dispose() {
			active = false;
			if (thinking.render === render)
				thinking.render = original;
			if (registry.hooks.get(hook.id) === hook)
				registry.hooks.delete(hook.id);
			if (!registry.hooks.size && proto.render === registry.installedRender && proto.handleMouse === registry.installedHandleMouse) {
				proto.render = registry.originalRender;
				if (registry.originalHandleMouse)
					proto.handleMouse = registry.originalHandleMouse;
				else
					delete proto.handleMouse;
				delete proto[FOOTER_KEY];
			}
		}
	};
}
export interface AgyProviderOptions {
	/** Test-factory dependencies only; no runtime executable override or native bypass flag. */
	executable?: string;
	piVersion?: string;
	argv?: readonly string[];
	trace?: ControllerTracer["record"];
	seal?: AgyRetirementSeal;
}
type Phase = "unused" | "starting" | "ready" | "running" | "awaiting-anchor" | "ended";
function userText(message: any): string {
	if (message?.role !== "user")
		throw new Error("AGY needs one new user message. Your message was not sent.");
	if (typeof message.content === "string")
		return message.content;
	if (!Array.isArray(message.content) || message.content.some((c: any) => c?.type !== "text" || typeof c.text !== "string"))
		throw new Error("AGY accepts text-only tasks. Your message was not sent. Remove images and send a new request.");
	return message.content.map((c: any) => c.text).join("\n");
}
function fingerprint(message: any): string {
	return createHash("sha256").update(JSON.stringify([message?.role, message?.provider, message?.api, message?.model, message?.timestamp, message?.stopReason, message?.content, message?.usage, message?.errorMessage])).digest("hex");
}
function entryFingerprint(entry: any): string { return createHash("sha256").update(JSON.stringify([entry?.id, entry?.parentId, entry?.type, entry?.type === "message" ? fingerprint(entry.message) : entry])).digest("hex"); }
function branchFingerprint(entries: any[]): string { return createHash("sha256").update(JSON.stringify(entries.map(entryFingerprint))).digest("hex"); }
export function createRbfAgy(options: AgyProviderOptions = {}) {
	return (pi: ExtensionAPI) => {
		pi.registerEntryRenderer(AGY_ACTIVITY, (entry, { expanded }, theme) => renderAgyActivity(entry.data, expanded, theme));
		const executable = options.executable ?? AGY_EXECUTABLE, seal = options.seal ?? processSeal();
		const leases = new WeakMap<LiveOwner, symbol>();
		const disclosed = new WeakSet<LiveOwner>();
		const tracer: ControllerTracer = { record(event, payload) { options.trace?.(event, payload); } };
		let sandbox = true;
		try {
			sandbox = parseArgs([...(options.argv ?? process.argv.slice(2))]).unknownFlags.has("sandbox");
		}
		catch { }
		const v = parseVersion(options.piVersion ?? VERSION), floor = parseVersion(MIN_PI_VERSION)!;
		const hostOk = !sandbox && v !== null && versionAtLeast(v, floor);
		let ctx: ExtensionContext | undefined, currentModel: Model<any> | undefined, phase: Phase = "unused", owner: LiveOwner | undefined, generation = 0, sessionId = "", anchor: {
			id: string;
			fingerprint: string;
			branchFingerprint: string;
		} | undefined;
		let pending: {
			fingerprint: string;
			userId: string;
			branchFingerprint: string;
		} | undefined, policy: AgyPolicy | undefined, policyError: string | undefined, policyFile: unknown;
		let lastMessageTimestamp = 0;
		let activeRequest: symbol | undefined;
		let catalog: ProviderModelConfig[] = [], ui: ReturnType<typeof installAgyUi> | undefined;
		const attempted = new Set<string>();
		// Local refusal pairs are trusted only after this factory observes their exact
		// persistence. They never authorize replay, cleanup or reconstruction on reload.
		const refusalEntries = new Map<string, string>();
		let pendingRefusal: {
			fingerprint: string;
			userId: string;
			userFingerprint: string;
			epoch: number;
			sid: string;
		} | undefined;
		const selected = () => currentModel?.provider === AGY_PROVIDER;
		const notice = (text: string, kind: "info" | "warning" | "error" = "warning") => {
			if (ctx?.mode === "tui")
				ctx.ui.notify(text, kind);
		};
		function hostAdmission() {
			if (!hostOk)
				throw new Error(sandbox ? "AGY is unavailable in a sandboxed Pi session. Your message was not sent. Restart Pi without --sandbox to use AGY." : "Pi 1.4.0 or newer is required for AGY. Your message was not sent.");
			if (ctx?.mode !== "tui")
				throw new Error("AGY is available only in the Pi TUI. Your message was not sent.");
			if (policyError)
				throw new Error(policyError);
			if (seal.owner && seal.owner !== (owner ? leases.get(owner) : undefined))
				throw new Error(AGY_COPY.stopUnknown);
		}
		function checkPolicy() {
			if (!sameAgyPolicy(policy, policyFile))
				throw new Error(AGY_COPY.policy);
		}
		function presentStop() {
			if (ctx?.mode !== "tui")
				return;
			try {
				// Clear accounting notices left by an earlier loaded version.
				ctx.ui.setWidget("rbf-agy-accounting", undefined);
				ctx.ui.setWidget("rbf-agy-stop", seal.stopNotice === "unverified" ? ["Earlier AGY work", AGY_COPY.stopUnknown] : seal.stopNotice === "stopped" ? [AGY_COPY.stopped] : undefined);
			}
			catch { /* Display failure cannot rewrite an accepted native task result. */ }
		}
		const present = () => {
			presentStop();
			if (ctx?.mode !== "tui")
				return;
			if (selected()) {
				ui ??= installAgyUi(selected);
			}
			else {
				ui?.dispose();
				ui = undefined;
			}
		};
		async function retire(captured = owner): Promise<boolean> {
			if (captured === owner) {
				generation++;
				phase = "ended";
				pending = undefined;
			}
			if (!captured)
				return !seal.owner;
			const outcome = await closeChildProcess(captured);
			tracer.record("provider_retired", { retirement: outcome.retirement, classification: outcome.classification });
			if (outcome.retirement === "complete" && seal.owner === leases.get(captured))
				seal.owner = undefined;
			if (!disclosed.has(captured)) {
				disclosed.add(captured);
				const verified = outcome.classification === "clean" || outcome.classification === "verified-interrupted";
				if (!verified)
					seal.stopNotice = "unverified";
				else if (seal.stopNotice !== "unverified")
					seal.stopNotice = "stopped";
				presentStop();
			}
			return outcome.retirement === "complete";
		}
		const clearActivity = () => {
			try {
				if (ctx?.mode === "tui") {
					ctx.ui.setStatus("rbf-agy", undefined);
					ctx.ui.setWidget("rbf-agy-activity", undefined);
				}
			}
			catch { }
		};
		function branch() { return ctx!.sessionManager.getBranch() as any[]; }
		function priorUse() { return (ctx!.sessionManager.getEntries() as any[]).some(e => e?.type === "custom" && e.customType === AGY_PROVENANCE || e?.type === "message" && e.message?.role === "assistant" && !["aborted", "error", "length"].includes(e.message.stopReason) && Array.isArray(e.message.content) && e.message.content.some((c: any) => c?.type === "toolCall" && c.name === "agy_controlled")); }
		async function refreshModels(c: RefreshModelsContext): Promise<ProviderModelConfig[]> {
			const stored = (c.stored?.models ?? []).filter(m => m.id !== REMOVED_MODEL_ID).map(m => ({ id: m.id, name: m.name, reasoning: m.reasoning, thinkingLevelMap: m.thinkingLevelMap, input: m.input, cost: m.cost, contextWindow: m.contextWindow, maxTokens: m.maxTokens }));
			if (!c.allowNetwork) {
				catalog = stored;
				return stored;
			}
			hostAdmission();
			checkPolicy();
			const models = (await readAgyCatalogue(executable, c.signal)).map(toAgyProviderModel);
			catalog = models;
			await c.publish({ persist: { models: models.map(m => ({ ...m, api: AGY_API, provider: AGY_PROVIDER, baseUrl: "stdio://agy" } as Model<any>)), checkedAt: Date.now() } });
			return models;
		}
		function streamSimple(model: Model<any>, context: Context, streamOptions?: SimpleStreamOptions) {
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = { role: "assistant", api: AGY_API, provider: AGY_PROVIDER, model: model.id, content: [], usage: structuredClone(ZERO_USAGE), stopReason: "stop", timestamp: Math.max(Date.now(), lastMessageTimestamp + 1) };
			lastMessageTimestamp = message.timestamp;
			const reservation = Symbol("agy-request");
			const epoch = generation, callSession = ctx?.sessionManager.getSessionId();
			let sent = false, claimed = false, createdOwner = false, nativeAttempted = false, finished = false;
			let requestUser: {
				id: string;
				fingerprint: string;
			} | undefined;
			let workingOwner: LiveOwner | undefined;
			let cancelSetup: (() => void) | undefined;
			const currentScope = () => epoch === generation && ctx?.sessionManager.getSessionId() === callSession;
   const live = () => currentScope() && selected() && !streamOptions?.signal?.aborted;
			const finish = (text: string, error = false, aborted = false) => {
				if (finished)
					return;
				finished = true;
				const clean = sanitizeDisplayText(text);
				message.stopReason = aborted ? "aborted" : error ? "error" : "stop";
				if (error)
					message.errorMessage = clean;
				const snap = () => ({ ...message, content: message.content.map(c => ({ ...c })) });
				message.content = [];
				stream.push({ type: "start", partial: snap() });
				message.content = [{ type: "text", text: "" }];
				stream.push({ type: "text_start", contentIndex: 0, partial: snap() });
				message.content = [{ type: "text", text: clean }];
				if (error && !nativeAttempted && owner?.isIdle && phase === "ready" && requestUser && callSession === sessionId && refusalEntries.size < 64)
					pendingRefusal = { fingerprint: fingerprint(message), userId: requestUser.id, userFingerprint: requestUser.fingerprint, epoch: generation, sid: sessionId };
				stream.push({ type: "text_delta", contentIndex: 0, delta: clean, partial: snap() });
				stream.push({ type: "text_end", contentIndex: 0, content: clean, partial: snap() });
				if (error || aborted)
					stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
				else
					stream.push({ type: "done", reason: "stop", message });
				stream.end();
			};
			void (async () => {
				try {
					hostAdmission();
					checkPolicy();
					if (!selected() || model.provider !== AGY_PROVIDER)
						throw new Error(AGY_COPY.unsupported);
					if (activeRequest || phase === "starting" || phase === "running" || phase === "awaiting-anchor")
						throw new Error(AGY_COPY.busy);
					if (phase === "ended" || owner?.closeBarrier)
						throw new Error(AGY_COPY.ended);
					const sm = ctx!.sessionManager;
					if (!sm.getSessionFile())
						throw new Error("AGY needs Pi session history. Your message was not sent. Start a new Pi session with saving enabled.");
					const entries = branch(), latestUser = [...entries].reverse().find(e => e.type === "message" && e.message?.role === "user");
					if (!latestUser || typeof latestUser.id !== "string" || attempted.has(latestUser.id))
						throw new Error("AGY will not resend this user message. Your message was not sent. Submit a new task after /new.");
					requestUser = { id: latestUser.id, fingerprint: entryFingerprint(latestUser) };
					const settings = resolveAgySelection(model, streamOptions?.reasoning);
					const prompt = userText(context.messages.at(-1));
					if (userText(latestUser.message) !== prompt)
						throw new Error(AGY_COPY.branch);
					if (!prompt.trim() || Buffer.byteLength(prompt) > BOUNDS.MAX_PROMPT_BYTES)
						throw new Error("AGY needs nonempty text of at most 256 KiB. Your message was not sent.");
					const cwd = realpathSync(ctx!.cwd), sid = sm.getSessionId();
					let expectedBranch = branchFingerprint(entries);
					const checkBranch = () => {
						if (!live() || sm.getSessionId() !== sid || realpathSync(ctx!.cwd) !== cwd || branchFingerprint(branch()) !== expectedBranch)
							throw new Error(AGY_COPY.branch);
					};
					if (owner) {
						if (settings.nativeModel !== owner.launchModel || settings.nativeEffort !== owner.launchEffort)
							throw new Error(AGY_COPY.settings);
						const a = entries.findIndex(e => e.id === anchor?.id), after = entries.slice(a + 1);
						if (!anchor || a < 0 || entryFingerprint(entries[a]) !== anchor.fingerprint || branchFingerprint(entries.slice(0, a + 1)) !== anchor.branchFingerprint || sid !== sessionId || cwd !== owner.canonicalCwd || after.at(-1)?.id !== latestUser.id || after.slice(0, -1).some(e => refusalEntries.get(e.id) !== entryFingerprint(e)))
							throw new Error(AGY_COPY.branch);
					}
					else {
						if (priorUse())
							throw new Error(AGY_COPY.ended);
						let lastAssistant = -1;
						entries.forEach((e, i) => {
							if (e.type === "message" && e.message?.role === "assistant")
								lastAssistant = i;
						});
						if (entries.slice(lastAssistant + 1).filter(e => e.type === "message" && e.message?.role === "user").length !== 1)
							throw new Error("AGY needs one new user message. Your message was not sent. Submit one task at a time.");
						if (lastAssistant >= 0)
							notice(AGY_COPY.cold, "info");
					}
					if (!live())
						throw new Error("AGY request cancelled before input. Your message was not sent.");
					claimed = true;
					activeRequest = reservation;
					workingOwner = owner;
					phase = "starting";
					ctx!.ui.setStatus("rbf-agy", "AGY — starting");
					// Revalidate native availability for every dispatch, including a live owner.
					catalog = (await readAgyCatalogue(executable, streamOptions?.signal)).map(toAgyProviderModel);
					checkBranch();
					const listed = catalog.find(m => m.id === model.id);
					if (!listed || JSON.stringify(resolveAgySelection(listed, streamOptions?.reasoning)) !== JSON.stringify(settings))
						throw new Error(AGY_COPY.unsupported);
					if (!owner) {
						if (!live())
							throw new Error("AGY request cancelled before input. Your message was not sent.");
						if (await checkAgyVersion(executable) !== "ok")
							throw new Error(AGY_COPY.startup);
						if (!live())
							throw new Error("AGY request cancelled before input. Your message was not sent.");
						checkPolicy();
						if (seal.owner)
							throw new Error(AGY_COPY.stopUnknown);
						const lease = Symbol("agy-owned-retirement");
						seal.owner = lease;
						owner = acquireOwnedChild(settings, cwd, tracer, executable, agyPolicyArgs(policy));
						workingOwner = owner;
						createdOwner = true;
						leases.set(owner, lease);
						sessionId = sid;
						owner.sessionId = sid;
						// Setup already owns a child; cancellation retires that exact acquisition
						// instead of waiting for its native init timeout before acting.
						const acquired = owner;
						cancelSetup = () => { void retire(acquired).catch(() => { }); };
						streamOptions?.signal?.addEventListener("abort", cancelSetup, { once: true });
						if (streamOptions?.signal?.aborted)
							cancelSetup();
						if (seal.stopNotice === "stopped")
							seal.stopNotice = undefined;
						presentStop();
						const ready = await owner.runtime!.ready;
						if (cancelSetup)
							streamOptions?.signal?.removeEventListener("abort", cancelSetup);
						if (!ready.success || !live())
							throw new Error(AGY_COPY.startup);
						checkBranch();
						const parent = sm.getLeafId(), data = { conversationId: owner.conversationId, cwd, sessionId: sid };
						pi.appendEntry(AGY_PROVENANCE, data);
						const bound = branch().at(-1);
						if (!bound || bound.type !== "custom" || bound.customType !== AGY_PROVENANCE || bound.parentId !== parent || JSON.stringify(bound.data) !== JSON.stringify(data) || bound.id !== sm.getLeafId() || branchFingerprint(branch().slice(0, -1)) !== expectedBranch)
							throw new Error("AGY could not verify session provenance. Your message was not sent. Use /new.");
						expectedBranch = branchFingerprint(branch());
						tracer.record("provider_bound", { entryId: bound.id, sessionId: sid, conversationId: owner.conversationId });
					}
					checkPolicy();
					checkBranch();
					attempted.add(latestUser.id);
					phase = "running";
					nativeAttempted = true;
					const admittedOwner = owner, expectedTurnCount = owner.lastAcceptedTurnCount + 1;
					const activityBudget = newAgyActivityBudget();
					let historyFailed = false;
					const result = await executeTurn(owner, prompt, expectedTurnCount, streamOptions?.signal, update => {
      const details = update.details as any;
      if (details?.state === "stopping" ? !currentScope() : !live()) return;
						ctx!.ui.setStatus("rbf-agy", details?.state === "stopping" ? "AGY — stopping" : "AGY — running");
						if (typeof details?.activity === "string")
							ctx!.ui.setWidget("rbf-agy-activity", sanitizeDisplayText(details.activity).split("\n").filter(Boolean).slice(-5).map(line => truncateToWidth(line, 100, "…")));
					}, "", tracer, live, currentScope, false, event => {
						try {
							const saved = recordAgyActivity(event, { piSessionId: sid, inputEntryId: latestUser.id, rootConversationId: admittedOwner.conversationId, turnCount: expectedTurnCount, source: { kind: "root", conversationId: admittedOwner.conversationId } }, activityBudget, {
								assertCurrent() {
									if (!live() || owner !== admittedOwner || sm.getSessionId() !== sid || realpathSync(ctx!.cwd) !== cwd) throw new Error(AGY_HISTORY_FAILURE);
								},
								entries: branch, leafId: () => sm.getLeafId(), fingerprint: entries => branchFingerprint([...entries]), expectedFingerprint: expectedBranch,
								append: (type, data) => pi.appendEntry(type, data),
							});
							expectedBranch = saved.fingerprint;
						} catch {
							historyFailed = true;
							throw new Error(AGY_HISTORY_FAILURE);
						}
					});
					sent = !result.notSent;
					if (!result.success) {
						await retire(workingOwner);
						const classification = workingOwner?.settledOutcome?.classification;
						const verified = classification === "clean" || classification === "verified-interrupted";
						const reason = historyFailed ? AGY_HISTORY_FAILURE + "\nThe task may already have run. Do not retry automatically." : result.cancelled ? "AGY request cancelled." : result.usage ? `AGY error: ${result.error ?? "Native request failed."}` : sent ? AGY_COPY.protocol : AGY_COPY.startup;
						finish(reason + "\n" + (verified ? AGY_COPY.stopped : AGY_COPY.stopUnknown), true, !!result.cancelled);
						return;
					}
					let answer = result.answer ?? "AGY returned SUCCESS with no answer text.";
					if (result.denials?.length)
						answer += "\n\nDenied actions (conversation total): " + result.denials.join(", ") + ".\nThese diagnostics do not prove an edit was applied.";
					if (!live()) {
						await retire(workingOwner);
						const classification = workingOwner?.settledOutcome?.classification;
						const verified = classification === "clean" || classification === "verified-interrupted";
						finish(answer + "\n\n" + (verified ? AGY_COPY.stopped : AGY_COPY.stopUnknown));
						return;
					}
					owner.isIdle = true;
					phase = "awaiting-anchor";
					message.content = [{ type: "text", text: sanitizeDisplayText(answer) }];
					pending = { fingerprint: fingerprint(message), userId: latestUser.id, branchFingerprint: expectedBranch };
					finish(answer);
				}
				catch (error) {
					const text = error instanceof Error ? error.message : "AGY request failed.";
					if (claimed && workingOwner) {
						if (createdOwner || nativeAttempted || !workingOwner.isIdle || streamOptions?.signal?.aborted || !selected() || ctx?.sessionManager.getSessionId() !== callSession || phase === "ended" || workingOwner !== owner)
							await retire(workingOwner);
						else
							phase = "ready";
					}
					else if (claimed && epoch === generation && phase === "starting")
						phase = "unused";
					finish(text, true, !!streamOptions?.signal?.aborted);
				}
				finally {
					if (cancelSetup)
						streamOptions?.signal?.removeEventListener("abort", cancelSetup);
					if (claimed && ctx?.sessionManager.getSessionId() === callSession && (!workingOwner || owner === workingOwner))
						clearActivity();
					if (activeRequest === reservation)
						activeRequest = undefined;
				}
			})().catch(() => finish("AGY provider failed. The task outcome may be unknown. No automatic retry is allowed.", true));
			return stream;
		}
		pi.registerFlag("agy-settings", { description: "Explicit user-owned AGY session-settings JSON file", type: "string" });
		pi.registerProvider(AGY_PROVIDER, { api: AGY_API, baseUrl: "stdio://agy", apiKey: "agy-native-cli", models: [], refreshModels, streamSimple });
		pi.on("session_start", async (_event, c) => {
			if (sessionId && sessionId !== c.sessionManager.getSessionId() && owner)
				await retire();
			ctx = c;
			currentModel = c.model;
			if (!seal.owner) {
				phase = "unused";
				owner = undefined;
				anchor = undefined;
				pending = undefined;
				attempted.clear();
				refusalEntries.clear();
				pendingRefusal = undefined;
				sessionId = c.sessionManager.getSessionId();
			}
			policyFile = pi.getFlag("agy-settings");
			try {
				policy = readAgyPolicy(policyFile);
				policyError = undefined;
			}
			catch (e) {
				policyError = (e as Error).message;
			}
			present();
		});
		pi.on("model_select", async (event, c) => {
			ctx = c;
			const previous = currentModel;
			currentModel = event.model;
			if (event.model.provider !== AGY_PROVIDER && (owner || phase === "starting"))
				await retire();
			else if (phase === "starting" && (previous?.provider !== event.model.provider || previous?.id !== event.model.id)) {
				if (owner) {
					generation++;
				}
				else
					await retire();
			}
			present();
		});
		pi.on("agent_end", async (event, c) => {
			ctx = c;
			if (pendingRefusal && phase === "ready" && pendingRefusal.epoch === generation && c.sessionManager.getSessionId() === pendingRefusal.sid) {
				const proof = pendingRefusal;
				pendingRefusal = undefined;
				const all = c.sessionManager.getBranch() as any[], i = all.findIndex(e => e.id === proof.userId), user = all[i];
				const after = all.slice(i + 1).filter(e => e.type === "message");
				if (i >= 0 && entryFingerprint(user) === proof.userFingerprint && after.length === 1 && fingerprint(after[0].message) === proof.fingerprint && event.messages.some(m => fingerprint(m) === proof.fingerprint)) {
					refusalEntries.set(user.id, entryFingerprint(user));
					refusalEntries.set(after[0].id, entryFingerprint(after[0]));
				}
			}
			if (!pending || phase !== "awaiting-anchor" || c.sessionManager.getSessionId() !== sessionId)
				return;
			if (!event.messages.some(m => fingerprint(m) === pending!.fingerprint))
				return;
			ctx = c;
			const all = branch(), user = all.findIndex(e => e.id === pending!.userId), matches = all.slice(user + 1).filter(e => e.type === "message" && e.message?.role === "assistant");
			if (user < 0 || matches.length !== 1 || all.at(-1) !== matches[0] || fingerprint(matches[0].message) !== pending.fingerprint || branchFingerprint(all.slice(0, all.indexOf(matches[0]))) !== pending.branchFingerprint) {
				await retire();
				notice(AGY_COPY.branch);
				return;
			}
			anchor = { id: matches[0].id, fingerprint: entryFingerprint(matches[0]), branchFingerprint: branchFingerprint(all) };
			refusalEntries.clear();
			pendingRefusal = undefined;
			pending = undefined;
			phase = "ready";
			tracer.record("provider_anchor", { entryId: anchor.id });
		});
		pi.on("session_tree", async (event, c) => {
			ctx = c;
			if (event.newLeafId !== event.oldLeafId && (owner || phase === "starting"))
				await retire();
		});
		pi.on("session_before_tree", async (event) => selected() && event.preparation.userWantsSummary ? { summary: { summary: "AGY branch summaries are unavailable; no native input was sent." } } : {});
		pi.on("session_before_compact", async () => selected() ? { cancel: true } : {});
		pi.on("session_before_switch", async () => owner && !(await retire()) ? { cancel: true } : {});
		pi.on("session_before_fork", async () => owner && !(await retire()) ? { cancel: true } : {});
		pi.on("session_shutdown", async (event) => {
			await retire();
			// Signal-triggered quit emits cleanup before stopping TUI. Keep the truthful
			// projection for its final frame; this process exits and cannot select another provider.
			if (event.reason !== "quit") {
				clearActivity();
				ui?.dispose();
				ui = undefined;
			}
		});
	};
}
export default createRbfAgy();
