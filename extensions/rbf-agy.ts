// #pi-21: AGY owns execution/context/policy; Pi selects and displays the provider.
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
// Pi 1.6.0 made ProviderModelConfig a union of chat, image and classifier models; AGY lists only chat models, the one with `reasoning`.
type AgyModelConfig = Extract<ProviderModelConfig, { reasoning: boolean }>;
export const AGY_PROVIDER = "agy-harness";
export const AGY_API = "rbf-agy";
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
// AGY 1.5.14 (Decisions 2026-11-22): Neon and Hydrogen are families that also list xhigh. A family offers only the efforts its own `agy models` rows list, so Argon, Flash and the rest keep xhigh null. AGY 1.5.16 (Decisions 2026-11-24) lists Carbon.
const CURRENT_FAMILIES = new Set(["gemini-4-argon", "gemini-4-carbon", "gemini-4-neon", "gemini-4-hydrogen", "gemini-3.8-flash"]);
// Decisions 2026-11-22 (Tom): only Gemini models go through pi-21, because Google's ACP docs offer third-party models only to some IDE clients. Done in code, so no setting brings Claude or GPT-OSS back.
const isGeminiId = (id: unknown): id is string => typeof id === "string" && id.startsWith("gemini-");
const EVIDENCED_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const COMPATIBILITY_LIMIT = 1000000000; // suppress host compaction; never a displayed native capacity
const UNPRICED = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** A message typed into a chat the CLI route started (Decisions 2026-11-22: the route is deleted, and its chats are refused, never continued). */
export const CLI_BORN_COPY = "This chat used AGY's old CLI route, which Pi no longer runs. Your message was not sent. Use /new to start a new AGY chat.";
export const AGY_COPY = {
	bootstrap: "AGY has no work model selected. Your message was not sent. Open /model and select an available AGY model.",
	unsupported: "AGY does not support the requested model or effort. Your message was not sent. Select an available AGY model and supported effort.",
	ended: "AGY context has ended. Your message was not sent. Use /new, select an AGY model, and send a new task.",
	branch: "AGY context for this branch cannot be verified. Your message was not sent. Use /new and send a new task.",
	policy: "AGY session settings changed. Your message was not sent. Use /new to load the settings for a new conversation.",
	busy: "AGY is busy. Your message was not sent. Wait for the current request to finish.",
	cold: "AGY starts with new context. Earlier Pi messages are not transferred.",
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
		if (!isGeminiId(id))
			continue; // every row is still validated above; only Gemini rows reach Pi's model list
		const match = id.match(/^(.*)-(low|medium|high|xhigh|max)$/);
		const grouped = !!match && CURRENT_FAMILIES.has(match[1]) && EVIDENCED_EFFORTS.has(match[2]);
		const key = grouped ? match![1] : id;
		if (grouped) {
			let family = models.get(key);
			if (!family) {
				family = { id: key, name: name.replace(/\s*\((low|medium|high|xhigh)\)\s*$/i, ""), variants: {} };
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
export function toAgyProviderModel(m: AgyCatalogueModel): AgyModelConfig {
	const thinkingLevelMap: Record<string, string | null> = Object.fromEntries(LEVELS.map(level => [level, m.variants[level] ?? null]));
	// maxTokens: 0 marks no host-enforced output limit, disabling isRecoverableLength's context_edit/auto-compaction trigger on stopReason: "length".
	// Held on Pi 1.5.0, and checked against Pi 1.6.0: pi-ai utils/overflow.js `desiredMaxOutput > 0`, called with the model's maxTokens at pi-coding-agent core/agent-session.js:2542.
	return { id: m.id, name: `${m.name} (AGY agent)`, reasoning: !m.fixed, thinkingLevelMap, input: ["text"], contextWindow: COMPATIBILITY_LIMIT, maxTokens: 0, cost: { ...UNPRICED } };
}
const REMOVED_MODEL_ID = "agy-select-model"; // Refuse retired selections; never advertise this ID.
export function resolveAgySelection(model: AgyModelConfig, level: string | undefined): {
	nativeModel: string;
	nativeEffort?: string;
} {
	if (model.id === REMOVED_MODEL_ID)
		throw new Error(AGY_COPY.bootstrap);
	if (!isGeminiId(model.id))
		throw new Error(AGY_COPY.unsupported); // a chat saved on a Claude or GPT-OSS model fails safe
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
import * as piAi from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type RefreshModelsContext, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, stripTerminalSequences } from "@earendil-works/pi-tui";
import { AGY_EXECUTABLE, MIN_PI_VERSION, BOUNDS, parseVersion, versionAtLeast, sanitizeDisplayText, type ControllerTracer } from "./lib/agy-native.js";
import { AGY_DISPATCH, AGY_COMPLETION, AGY_REFUSAL, AGY_ACP_CONVERSATION, AGY_ACP_DISPATCH, AGY_ACP_COMPLETION, AGY_ACP_REFUSAL, AGY_ACP_WAKE, AGY_WAKE_MARKER, AGY_WAKE_GONE, RECOVERY_COPY, RecoveryError, readSavedSession, appendEvidence, selectAcpRecoveryAnchor, fingerprint, entryFingerprint, branchFingerprint, historyFingerprint, isForeignEntry, type SavedSession } from "./lib/agy-recovery.js";
import { AcpOwner, AcpConfigError, AcpStartError, AcpCancelTimeoutError, ACP_COPY, ACP_DEFINITE_STOP_REASONS, WAKE_QUIET_MS, type AcpSelection, type AcpToolUpdate, type AcpWakeResult } from "./lib/agy-acp-session.js";
import { AcpLostError, AcpOversizeRequestError, AcpReply } from "./lib/agy-acp.js";
import { AGY_ACP_ACTIVITY, AGY_HISTORY_FAILURE, newAgyActivityBudget, recordAgyAcpActivity, renderAgyAcpActivity } from "./lib/agy-history.js";
import { wireLog } from "./lib/agy-wire-log.js";
import { AGY_ACP_PERMISSION, AGY_ACP_QUESTION, AcpApprovalQueue, approvalPresenter, extractAgyAcpQuestion, renderAgyAcpPermission, renderAgyAcpQuestion, type ApprovalPresenter } from "./lib/agy-acp-approval.js";
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
const ZERO_WIDTH = "\u200b";
/** Whether Pi's own automatic-retry check would take this error text for a transient failure. It is Pi's check, so it is the running Pi's pattern, not a copy of one. */
function pisRetryTakes(text: string, check: unknown = (piAi as any).isRetryableAssistantError): boolean {
	if (typeof check !== "function") return true; // a Pi that does not export its check: assume the worst and write the words apart
	try { return !!check({ role: "assistant", stopReason: "error", errorMessage: text, content: [] }); } catch { return true; }
}
/**
 * An error text built around words AGY or Tom supplied (a result AGY ended the turn with, a `/name`, a settings key). Pi retries an error whose text matches its retry pattern, writes a context_edit entry that
 * breaks resume, and after a sent prompt shows a false "not sent". So when the text would match, the words are written with a zero-width space after every second character: nothing changes on screen, and no
 * run of three characters is left for a pattern to find. If the words are not the cause, they are replaced by an ellipsis rather than shown in a form Pi would retry.
 */
export function retrySafe(build: (parts: string[]) => string, parts: string[], check: unknown = (piAi as any).isRetryableAssistantError): string {
	const plain = build(parts);
	if (!pisRetryTakes(plain, check)) return plain;
	const apart = build(parts.map(part => [...part].map((c, i) => i % 2 === 1 ? c + ZERO_WIDTH : c).join("")));
	return pisRetryTakes(apart, check) ? build(parts.map(() => "\u2026")) : apart;
}
/** `agy acp` has no --settings, so only enableTerminalSandbox can be honored. Any other key would be ignored without a word, so it is refused. */
export function acpPolicyArgs(p?: AgyPolicy): string[] {
	if (!p) return [];
	const extra = Object.keys(JSON.parse(p.json)).filter(key => key !== "enableTerminalSandbox");
	if (extra.length) throw new Error(retrySafe(keys => ACP_COPY.policyKeys(keys), extra.slice(0, 8).map(key => sanitizeDisplayText(key).slice(0, 64))));
	return p.sandbox ? ["--sandbox"] : [];
}
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
		const text = line.replace(/\(~[\d.]+k tokens\)/g, "(AGY tier)").replace("cycles thinking levels in-session", "selects effort for the next AGY turn");
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
	presentApproval?: ApprovalPresenter;
	approvalReviewTimeoutMs?: number;
	cancelGraceMs?: number;
	/** Test seam: how long AGY must be silent before a wake turn ends. 3 s in use. */
	wakeQuietMs?: number;
	/** Test seam: how long a wake waits for Pi's turn before the owner gives it up. 15 s in use. */
	wakeAttachMs?: number;
}
function userText(message: any): string {
	if (message?.role !== "user")
		throw new Error("AGY needs one new user message. Your message was not sent.");
	if (typeof message.content === "string")
		return message.content;
	if (!Array.isArray(message.content) || message.content.some((c: any) => c?.type !== "text" || typeof c.text !== "string"))
		throw new Error("AGY accepts text-only tasks. Your message was not sent. Remove images and send a new request.");
	return message.content.map((c: any) => c.text).join("\n");
}
export function createRbfAgy(options: AgyProviderOptions = {}) {
	return (pi: ExtensionAPI) => {
		pi.registerEntryRenderer(AGY_ACP_ACTIVITY, (entry, options, theme) => renderAgyAcpActivity(entry.data, options.expanded, theme, typeof (options as any)?.keyHint === "function" ? (options as any).keyHint("app.tools.expand", "to expand") : undefined));
		pi.registerEntryRenderer(AGY_ACP_PERMISSION, (entry, { expanded }, theme) => renderAgyAcpPermission(entry.data, expanded, theme));
		pi.registerEntryRenderer(AGY_ACP_QUESTION, (entry, { expanded }, theme) => renderAgyAcpQuestion(entry.data, expanded, theme));
		// The marker of a wake turn (Decisions 2026-11-22) and the line for a wake dropped before any marker went out (Decisions 2026-11-23). Pi's own look for a custom message puts `[rbf-agy-wake]` in front,
		// so draw just the line. Each is always the same text, whatever the saved message holds.
		if (typeof pi.registerMessageRenderer === "function") {
			const lineOf = (text: string, color: "dim" | "warning") => (_message: any, options: any, theme: any) => ({
				invalidate() { },
				render(width: number) { return width < 1 ? [] : wrapTextWithAnsi(" ".repeat(options?.outputPad ?? 1) + theme.fg(color, text), width).map(row => truncateToWidth(row, width, "")); },
			});
			pi.registerMessageRenderer(AGY_WAKE_MARKER, lineOf(ACP_COPY.woke, "dim"));
			pi.registerMessageRenderer(AGY_WAKE_GONE, lineOf(ACP_COPY.wakeGone, "warning"));
		}
		const executable = options.executable ?? AGY_EXECUTABLE, seal = options.seal ?? processSeal();
		const tracer: ControllerTracer = { record(event, payload) { options.trace?.(event, payload); } };
		let sandbox = true;
		try {
			sandbox = parseArgs([...(options.argv ?? process.argv.slice(2))]).unknownFlags.has("sandbox");
		}
		catch { }
		const v = parseVersion(options.piVersion ?? VERSION), floor = parseVersion(MIN_PI_VERSION)!;
		const hostOk = !sandbox && v !== null && versionAtLeast(v, floor);
		let ctx: ExtensionContext | undefined, currentModel: Model<any> | undefined, generation = 0;
		let policy: AgyPolicy | undefined, policyError: string | undefined, policyFile: unknown;
		// Route state (#pi-21.3).
		interface AcpTurnContext {
			owner: AcpOwner;
			userId: string;
			getExpectedBranch(): string;
			setExpectedBranch(fp: string): void;
			onToolWaiting(toolCallId: string, waiting: boolean): void;
		}
		let acpOwner: AcpOwner | undefined, acpQueue: AcpApprovalQueue | undefined, acpTurn: AcpTurnContext | undefined;
		let acpActive: symbol | undefined, acpPiSession = "", acpAwaiting = false;
		// A wake turn (Decisions 2026-11-22): `acpWakeRun` is set by before_agent_start for the run the marker starts, and read once by the provider call that run makes.
		// `acpWakeDeferred` is an owner whose wake began while Pi was still running; its marker is sent when Pi settles.
		let acpWakeRun = false, acpWakeDeferred: AcpOwner | undefined;
		// The owner a wake marker was sent for and whose run has not started yet: a run that finds its wake gone was the provider's own, not a stranger's marker.
		let acpWakeMarkerOwner: AcpOwner | undefined;
		// Approval replies not yet written to AGY (see the permission handler). A permission record is saved only once its reply has been written.
		let acpPermissionWrites = 0;
		const acpPermissionWaiters: Array<() => void> = [];
		const PERMISSION_WRITE_WAIT_MS = 2000;
		// A wake is not sent while Pi is checking a prompt Tom typed: Pi counts itself idle through the input handlers and the auth check (agent-session.js `_preparePrompt`), so a marker sent then starts a run of its own
		// and the prompt throws "Agent is already processing". `acpInputHold` is set by the `input` event of an idle Pi and ends when that prompt's run starts (before_agent_start) or after INPUT_HOLD_MS.
		// `acpWakePoll` re-checks a deferred wake: Pi emits agent_settled only when a run ends, and Pi can be busy for a reason that is not a run (a compaction, a branch summary, a run that failed to start).
		let acpInputHold: ReturnType<typeof setTimeout> | undefined, acpWakePoll: ReturnType<typeof setInterval> | undefined;
		const INPUT_HOLD_MS = 2000, WAKE_RECHECK_MS = 250;
		let acpAnchor: { conversationId: string; completionId: string | null } | undefined;
		let acpPending: { fingerprint: string; abortedFingerprint?: string; userId: string; branchFingerprint: string; dispatchId: string; tuple: Record<string, unknown>; usage: unknown; epoch: number; modelId: string; outcome: "stop" | "length" | "refusal" | "cancelled"; stopped?: boolean } | undefined;
		let acpRefusal: { fingerprint: string; abortedFingerprint?: string; userId: string; userFingerprint: string; epoch: number; sid: string; anchor: { conversationId: string; completionId: string | null }; tuple: Record<string, unknown> } | undefined;
		// Messages Tom typed while AGY worked, refused with nothing sent after the running turn's answer was saved: one entry per refused pair, in order, until agent_end writes their records.
		let acpTyped: { fingerprint: string; abortedFingerprint?: string; userId: string; userFingerprint: string }[] = [];
		let revokeAcpPublication: ((closeStream?: boolean) => void) | undefined;
		// Bumped by every model or thinking-level selection. A running ACP turn keeps its pair; only a send that is still checking its pair notices.
		let acpSelectionGeneration = 0, acpCheckingBy: symbol | undefined;
		const acpLeases = new WeakMap<AcpOwner, symbol>(), acpDisclosed = new WeakSet<AcpOwner>(), acpRetiring = new WeakSet<AcpOwner>();
		let lastMessageTimestamp = 0;
		let ui: ReturnType<typeof installAgyUi> | undefined;
		const attempted = new Set<string>();
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
			if (seal.owner && seal.owner !== (acpOwner ? acpLeases.get(acpOwner) : undefined))
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
				ctx.ui.setWidget("rbf-agy-stop", seal.stopNotice === "unverified" ? ["Earlier AGY work", AGY_COPY.stopUnknown] : seal.stopNotice === "stopped" ? [ACP_COPY.stopped] : undefined);
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
		const clearActivity = () => {
			try {
				if (ctx?.mode === "tui") {
					ctx.ui.setWidget("rbf-agy-activity", undefined);
					ctx.ui.setWidget("rbf-agy-preview", undefined);
				}
			}
			catch { }
		};
		function branch() { return ctx!.sessionManager.getBranch() as any[]; }
		function cliPriorUse() { return (ctx!.sessionManager.getEntries() as any[]).some(e => e?.type === "custom" && [AGY_PROVENANCE, AGY_DISPATCH, AGY_COMPLETION, AGY_REFUSAL].includes(e.customType) || e?.type === "message" && e.message?.role === "assistant" && !["aborted", "error", "length"].includes(e.message.stopReason) && Array.isArray(e.message.content) && e.message.content.some((c: any) => c?.type === "toolCall" && c.name === "agy_controlled")); }
		async function refreshModels(c: RefreshModelsContext): Promise<ProviderModelConfig[]> {
			const stored = ((c.stored?.models ?? []) as Model<any>[]).filter(m => m.id !== REMOVED_MODEL_ID && isGeminiId(m.id)).map(m => ({ id: m.id, name: m.name, reasoning: m.reasoning, thinkingLevelMap: m.thinkingLevelMap, input: m.input, cost: m.cost, contextWindow: m.contextWindow, maxTokens: 0 }));
			if (!c.allowNetwork) {
				return stored;
			}
			hostAdmission();
			checkPolicy();
			const models = (await readAgyCatalogue(executable, c.signal)).map(toAgyProviderModel);
			await c.publish({ persist: { models: models.map(m => ({ ...m, api: AGY_API, provider: AGY_PROVIDER, baseUrl: "stdio://agy" } as Model<any>)), checkedAt: Date.now() } });
			return models;
		}
		const acpTuple = (o: AcpOwner, extra: Record<string, unknown> = {}) => {
			const sm = ctx!.sessionManager;
			let sessionFile = sm.getSessionFile() ?? "";
			try { sessionFile = realpathSync(sessionFile); } catch { }
			return { sessionId: sm.getSessionId(), sessionFile, cwd: o.cwd, acpSessionId: o.acpSessionId, policyHash: policy?.hash ?? null, ...extra };
		};
		const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
		const ACP_PASSIVE_ENTRY = new Set(["model_change", "thinking_level_change", "session_info", "label"]);
		const isAcpPassive = (e: any) => isForeignEntry(e) || ACP_PASSIVE_ENTRY.has(e?.type);
		const acpBranchFingerprint = (entries: readonly any[]) => branchFingerprint(entries.filter(e => !isAcpPassive(e)));
		const PI_ABORTED_ERROR = /^Aborted after \d+ retry attempts?$/;
		const matchesAcpMessage = (m: any, exact: string, abortedNoError?: string): boolean =>
			fingerprint(m) === exact ||
			(abortedNoError !== undefined &&
				m?.stopReason === "aborted" &&
				(m.errorMessage === "Operation aborted" || (typeof m.errorMessage === "string" && PI_ABORTED_ERROR.test(m.errorMessage))) &&
				fingerprint({ ...m, errorMessage: undefined }) === abortedNoError);
		function appendAcpCustom(targetOwner: AcpOwner, customType: string, data: unknown, inputEntryId: string | null): void {
			const toolCallId = isRecord(data) && typeof data.toolCallId === "string" ? data.toolCallId : undefined;
			const logged = (result: "ok" | "skip:session" | "skip:owner" | "fail") => wireLog("rec", { customType, toolCallId, result });
			try {
				if (!ctx || ctx.sessionManager.getSessionId() !== acpPiSession) return logged("skip:session");
				if (targetOwner !== acpOwner) return logged("skip:owner");
				const turn = acpTurn && acpTurn.owner === targetOwner ? acpTurn : undefined;
				const before = branch();
				const beforeFp = acpBranchFingerprint(before);
				const beforeLen = before.length;
				pi.appendEntry(customType, data);
				const after = branch();
				const landed = after.at(-1);
				if (after.length !== beforeLen + 1 || !landed || landed.type !== "custom" || landed.customType !== customType) {
					throw new Error(AGY_HISTORY_FAILURE);
				}
				const nextFp = acpBranchFingerprint(after);
				if (turn && inputEntryId === turn.userId && turn.getExpectedBranch() === beforeFp) {
					turn.setExpectedBranch(nextFp);
				} else if (acpPending && acpAwaiting && acpPending.branchFingerprint === beforeFp) {
					acpPending.branchFingerprint = nextFp;
				}
				logged("ok");
			} catch {
				logged("fail");
				notice(AGY_HISTORY_FAILURE, "warning");
			}
		}
		async function retireAcp(captured = acpOwner, closePublication = true): Promise<boolean> {
			if (captured === acpOwner && (!captured || !acpRetiring.has(captured))) {
				if (captured) acpRetiring.add(captured);
				acpQueue?.endTurn();
				if (closePublication) revokeAcpPublication?.();
				generation++;
				acpWakeRun = false; acpWakeDeferred = undefined; acpWakeMarkerOwner = undefined; releaseInputHold(); stopWakePoll();
				acpAwaiting = false;
				acpPending = undefined;
				acpTyped = [];
			}
			if (!captured)
				return !seal.owner;
			const outcome = await captured.close();
			tracer.record("provider_retired", { retirement: outcome.retirement, classification: outcome.classification });
			if (outcome.retirement === "complete" && seal.owner === acpLeases.get(captured))
				seal.owner = undefined;
			if (!acpDisclosed.has(captured)) {
				acpDisclosed.add(captured);
				const verified = outcome.classification === "clean" || outcome.classification === "verified-interrupted";
				if (!verified)
					seal.stopNotice = "unverified";
				else if (seal.stopNotice !== "unverified")
					seal.stopNotice = "stopped";
				presentStop();
			}
			return outcome.retirement === "complete";
		}
		interface AcpAcquire {
			cwd: string; sid: string; entries: readonly any[]; saved: SavedSession; newUserId: string; wanted: AcpSelection;
			/** False once the caller's request is over: scope, selection, policy or abort moved. */
			live: () => boolean;
			/** Throws the branch copy when the branch moved since the caller last took its fingerprint. */
			verify: () => void;
			/** Called as soon as a child exists, before anything else can fail, so the caller can retire it. */
			started?: (o: AcpOwner) => void;
			/** Called once a new chat's conversation record is on the branch, so the caller can take the new fingerprint. */
			recorded?: () => void;
			/** Runs on the live owner before Pi's pair is set. */
			beforePair?: (o: AcpOwner) => Promise<void>;
		}
		/**
		 * One way to get an ACP owner that is ready to be prompted: the one in memory, a resumed one (the saved chain says this chat has an ACP conversation), or a new one.
		 * Pi's pair is then set and confirmed. Throws the copy to show; nothing has been sent. The caller holds `acpActive` and has checked the host, the policy and that no turn is running.
		 * An owner that was lost earlier in this Pi session stays retired: only a reload, a restart or `/resume` starts a new Pi session, and so starts a resume.
		 */
		async function acquireAcpOwner(a: AcpAcquire): Promise<{ owner: AcpOwner; acked: { model: string; effort: string | null }; created: boolean }> {
			const created = !acpOwner;
			const o = acpOwner ?? await startAcpOwner(a);
			a.verify();
			await a.beforePair?.(o);
			try { return { owner: o, acked: await o.configure(a.wanted), created }; }
			catch (error) {
				if (error instanceof AcpConfigError) throw new Error(error.kind === "unsupported" ? ACP_COPY.unsupported : ACP_COPY.notConfirmed);
				if (error instanceof AcpLostError) { void retireAcp(o, false); throw new Error(ACP_COPY.lostBeforeSend); }
				throw error;
			}
		}
		async function startAcpOwner(a: AcpAcquire): Promise<AcpOwner> {
			const sm = ctx!.sessionManager;
			const anchor = selectAcpRecoveryAnchor(a.saved, a.newUserId); // RecoveryError: the copy is `.4`'s, nothing is spawned
			const args = acpPolicyArgs(policy);
			if (anchor) {
				// The settings file shaped every turn this chat has had; a different file needs a new conversation.
				if (anchor.policyHash !== undefined && anchor.policyHash !== (policy?.hash ?? null)) throw new Error(AGY_COPY.policy);
				acpAnchor = { conversationId: anchor.conversation.id, completionId: anchor.completion?.id ?? null };
			}
			else {
				let lastAssistant = -1, earlierPiAnswer = false;
				a.entries.forEach((e, i) => {
					if (e.type !== "message" || e.message?.role !== "assistant") return;
					lastAssistant = i;
					// AGY's own refusal of an earlier message (an image, say) carried no context, so it does not count as an earlier answer.
					if (!(e.message.provider === AGY_PROVIDER && (e.message.stopReason === "error" || e.message.stopReason === "aborted"))) earlierPiAnswer = true;
				});
				if (a.entries.slice(lastAssistant + 1).filter(e => e.type === "message" && e.message?.role === "user").length !== 1)
					throw new Error("AGY needs one new user message. Your message was not sent. Submit one task at a time.");
				if (earlierPiAnswer) notice(AGY_COPY.cold, "info");
			}
			if (seal.owner)
				throw new Error(AGY_COPY.stopUnknown);
			const lease = Symbol("agy-acp-owned-retirement");
			seal.owner = lease;
			const holder: { owner?: AcpOwner } = {};
			// A child that dies while no turn is running is retired at once; a running turn handles its own loss.
			const onLost = () => { if (holder.owner && holder.owner === acpOwner && !acpActive) void retireAcp(holder.owner, false); };
			let started: AcpOwner;
			try { holder.owner = started = anchor ? await AcpOwner.resume({ executable, cwd: a.cwd, args, acpSessionId: anchor.acpSessionId, onLost, wakeAttachMs: options.wakeAttachMs }) : await AcpOwner.open({ executable, cwd: a.cwd, args, onLost, wakeAttachMs: options.wakeAttachMs }); }
			catch (error) {
				seal.owner = undefined;
				if (error instanceof AcpStartError) throw new Error(error.kind === "sign-in" ? ACP_COPY.signIn : anchor ? RECOVERY_COPY.unavailable : ACP_COPY.startup);
				throw error;
			}
			if (!a.live()) {
				const outcome = await started.close();
				tracer.record("provider_retired", { retirement: outcome.retirement, classification: outcome.classification });
				if (outcome.retirement === "complete" && seal.owner === lease) seal.owner = undefined;
				throw new Error(AGY_COPY.ended);
			}
			acpLeases.set(started, lease);
			acpOwner = started;
			acpPiSession = a.sid;
			// New work begins: the advisory about an earlier clean stop has done its job.
			if (seal.stopNotice === "stopped") { seal.stopNotice = undefined; presentStop(); }
			const queue = new AcpApprovalQueue({
				piSessionId: a.sid,
				acpSessionId: started.acpSessionId,
				cwd: a.cwd,
				present: (view, sig) => (options.presentApproval ?? (ctx ? approvalPresenter(ctx) : async () => undefined))(view, sig),
				reviewTimeoutMs: options.approvalReviewTimeoutMs,
				onPendingStateChange: (toolCallId, waiting) => {
					if (acpTurn && acpTurn.owner === started) acpTurn.onToolWaiting(toolCallId, waiting);
				},
			});
			acpQueue = queue;
			started.setRequestHandlers({
				// The record of a reply is saved only once the reply was handed to the link; one that never reached AGY leaves no record that says it was answered.
				// `acpPermissionWrites` counts the requests between AGY's asking and the reply's write, so a wake that Esc ends at once can wait for the records of the replies it settled (permissionWritesDone).
				permission: params => { acpPermissionWrites++; return queue.request(params).then(r => new AcpReply(r.outcome, delivered => {
					try {
						if (delivered) appendAcpCustom(started, AGY_ACP_PERMISSION, r.record, r.record.inputEntryId);
						else queue.forgetApproval(r.record.toolCallId);
					}
					finally { permissionWriteEnded(); }
				}), error => { permissionWriteEnded(); throw error; }); },
				question: params => {
					const turn = acpTurn && acpTurn.owner === started ? acpTurn : undefined;
					const record = extractAgyAcpQuestion(params, { piSessionId: acpPiSession, acpSessionId: started.acpSessionId, inputEntryId: turn?.userId ?? null });
					appendAcpCustom(started, AGY_ACP_QUESTION, record, record.inputEntryId);
				},
			});
			started.setWakeListener(() => onAcpWake(started), () => onAcpWakeDropped(started));
			a.started?.(started);
			if (!a.live()) throw new Error(AGY_COPY.ended);
			if (!anchor) {
				try {
					const entry = appendEvidence(pi, sm, a.cwd, AGY_ACP_CONVERSATION, { acpSessionId: started.acpSessionId, cwd: a.cwd, piSessionId: a.sid });
					acpAnchor = { conversationId: entry.id, completionId: null };
				}
				catch { throw new Error("AGY could not verify session provenance. Your message was not sent. Use /new."); }
				a.recorded?.();
			}
			return started;
		}
		/**
		 * AGY spoke between turns (the owner holds its frames and calls this once). Pi starts a turn of its own for it: the marker line, then AGY's reply as an AGY message (Decisions 2026-11-22).
		 * If Pi is still running (the previous turn's completion is being saved), the marker waits for Pi to settle, because a message sent into a running Pi would join that run.
		 */
		function onAcpWake(o: AcpOwner) {
			try {
				if (o !== acpOwner || !ctx || !selected() || ctx.sessionManager.getSessionId() !== acpPiSession) { o.abandonWake(); return; }
				// `acpActive` is a typed prompt still setting AGY's model or effort (the owner is idle until it sends): that is a busy moment like any other, not a reason to drop what AGY said.
				if (acpActive || acpInputHold || acpAwaiting || !ctx.isIdle()) { acpWakeDeferred = o; acpWakePoll ??= setInterval(pumpWake, WAKE_RECHECK_MS); acpWakePoll.unref?.(); return; }
				sendAcpWakeMarker(o);
			}
			catch { o.abandonWake(); }
		}
		/**
		 * The owner's attach timer dropped a wake no turn picked up (Decisions 2026-11-23). A wake whose marker went out is the gone run's to end: it stops AGY and says so. One that was still waiting for Pi to settle
		 * has no run coming, so Pi stops AGY here and saves the line once. `triggerTurn: false` is deliberate: Pi 1.6.0 steers a message sent with no `triggerTurn` into a run in progress, and `false` holds it until that run ends.
		 */
		function onAcpWakeDropped(o: AcpOwner) {
			if (acpWakeMarkerOwner === o || acpWakeDeferred !== o) return;
			acpWakeDeferred = undefined; stopWakePoll();
			if (o !== acpOwner) return;
			try { o.stopAbandonedWake(); } catch { /* a lost owner is retired by its own handler */ }
			try { pi.sendMessage({ customType: AGY_WAKE_GONE, content: ACP_COPY.wakeGone, display: true }, { triggerTurn: false }); } catch { /* the chat continues without the line */ }
		}
		function stopWakePoll() {
			if (acpWakePoll) clearInterval(acpWakePoll);
			acpWakePoll = undefined;
		}
		function permissionWriteEnded() {
			acpPermissionWrites = Math.max(0, acpPermissionWrites - 1);
			if (acpPermissionWrites === 0) for (const done of acpPermissionWaiters.splice(0)) done();
		}
		/** Resolves once every approval reply handed to AGY has been written and its record saved, or after PERMISSION_WRITE_WAIT_MS if one never is. */
		function permissionWritesDone(): Promise<void> {
			if (acpPermissionWrites === 0) return Promise.resolve();
			return new Promise(resolve => {
				const done = () => { clearTimeout(timer); resolve(); };
				const timer = setTimeout(done, PERMISSION_WRITE_WAIT_MS);
				timer.unref?.();
				acpPermissionWaiters.push(done);
			});
		}
		function releaseInputHold() {
			if (acpInputHold) clearTimeout(acpInputHold);
			acpInputHold = undefined;
		}
		/** Looks again at a deferred wake: sends its marker once Pi is idle and no typed prompt is being checked, gives it up when it can no longer be shown. Runs every WAKE_RECHECK_MS while one waits, and when the hold times out. */
		function pumpWake() {
			const o = acpWakeDeferred;
			try {
				if (!o || !o.waking) { acpWakeDeferred = undefined; stopWakePoll(); return; }
				if (o !== acpOwner || !ctx || !selected() || ctx.sessionManager.getSessionId() !== acpPiSession) { acpWakeDeferred = undefined; stopWakePoll(); o.abandonWake(); return; }
				if (acpActive || acpInputHold || acpAwaiting || !ctx.isIdle()) return; // still busy: look again
				acpWakeDeferred = undefined; stopWakePoll();
				sendAcpWakeMarker(o);
			}
			catch { acpWakeDeferred = undefined; stopWakePoll(); o?.abandonWake(); }
		}
		function sendAcpWakeMarker(o: AcpOwner) {
			try { pi.sendMessage({ customType: AGY_WAKE_MARKER, content: ACP_COPY.woke, display: true }, { triggerTurn: true }); acpWakeMarkerOwner = o; }
			catch { o.abandonWake(); }
		}
		/**
		 * What a refusal record needs, taken from the saved chain: the chat this refused message belongs to, or nothing when it has no ACP chat or the chain does not hold.
		 * Read from disk at the moment of refusal (the user message is saved, the error answer is not yet), so a refusal that comes before any owner exists, such as a settings-file change after a reload, is recorded too.
		 */
		function acpRefusalBasis() {
			try {
				const sm = ctx!.sessionManager, user = [...branch()].reverse().find(e => e.type === "message" && e.message?.role === "user");
				if (!user) return undefined;
				const saved = readSavedSession(sm, realpathSync(ctx!.cwd)), anchor = selectAcpRecoveryAnchor(saved, user.id, true);
				if (!anchor) return undefined;
				return {
					user,
					anchor: { conversationId: anchor.conversation.id as string, completionId: (anchor.completion?.id ?? null) as string | null },
					// The chat's own settings hash, so a refusal for a changed file cannot make the chain read two hashes.
					tuple: { sessionId: saved.sessionId, sessionFile: saved.sessionFile, cwd: anchor.cwd, acpSessionId: anchor.acpSessionId, policyHash: anchor.policyHash !== undefined ? anchor.policyHash : policy?.hash ?? null },
				};
			}
			catch { return undefined; }
		}
		function acpStreamSimple(model: Model<any>, context: Context, streamOptions?: SimpleStreamOptions) {
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = { role: "assistant", api: AGY_API, provider: AGY_PROVIDER, model: model.id, content: [], usage: structuredClone(ZERO_USAGE), stopReason: "stop", timestamp: Math.max(Date.now(), lastMessageTimestamp + 1) };
			lastMessageTimestamp = message.timestamp;
			const reservation = Symbol("agy-acp-request");
			const selectionAtStart = acpSelectionGeneration;
			const wakeRun = acpWakeRun; // the run before_agent_start saw start from the wake marker; read once
			acpWakeRun = false;
			const epoch = generation, callSession = ctx?.sessionManager.getSessionId(), callFile = ctx?.sessionManager.getSessionFile(), callCwd = ctx?.cwd;
			let finished = false, started = false, revoked = false, claimed = false, createdOwner = false, nativeAttempted = false, limitExceeded = false, typedDuringTurn = false;
			let requestUser: { id: string; fingerprint: string } | undefined, requestBranch: string | undefined, used: AcpOwner | undefined;
			let answerBytes = 0;
			const currentScope = () => epoch === generation && ctx?.sessionManager.getSessionId() === callSession && ctx?.sessionManager.getSessionFile() === callFile && ctx?.cwd === callCwd;
			const branchIntact = () => {
				try { return currentScope() && selected() && sameAgyPolicy(policy, policyFile) && (!requestBranch || acpBranchFingerprint(branch()) === requestBranch); }
				catch { return false; }
			};
			const canPublish = () => {
				// Not currentModel === model: a selection made during this turn waits for the next send.
				try { return currentScope() && selected() && sameAgyPolicy(policy, policyFile) && !streamOptions?.signal?.aborted; }
				catch { return false; }
			};
			const live = () => canPublish() && (!requestBranch || acpBranchFingerprint(branch()) === requestBranch);
			const snap = () => ({ ...message, content: message.content.map(c => ({ ...c })) });
			const setChecking = (on: boolean) => {
				try {
					if (ctx?.mode !== "tui" || (!on && acpCheckingBy !== reservation)) return;
					acpCheckingBy = on ? reservation : undefined;
					ctx.ui.setWidget("rbf-agy-checking", on ? ["AGY — checking conversation"] : undefined);
				}
				catch { /* A display failure cannot change what was or was not sent. */ }
			};
			const startStream = () => {
				if (started) return;
				started = true;
				message.content = [];
				stream.push({ type: "start", partial: snap() });
			};
			const endBlock = (index: number) => {
				const block = message.content[index] as any;
				stream.push(block.type === "text" ? { type: "text_end", contentIndex: index, content: block.text, partial: snap() } : { type: "thinking_end", contentIndex: index, content: block.thinking, partial: snap() });
			};
			const chunk = (kind: "text" | "thinking", delta: string) => {
				if (finished || revoked || limitExceeded || !live()) return;
				answerBytes += Buffer.byteLength(delta);
				if (answerBytes > BOUNDS.MAX_FRAME_BYTES) { limitExceeded = true; return; }
				startStream();
				const last = message.content.at(-1) as any;
				if (!last || last.type !== kind) {
					if (last) endBlock(message.content.length - 1);
					message.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
					stream.push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex: message.content.length - 1, partial: snap() });
				}
				const block = message.content.at(-1) as any;
				if (kind === "text") block.text += delta; else block.thinking += delta;
				stream.push({ type: kind === "text" ? "text_delta" : "thinking_delta", contentIndex: message.content.length - 1, delta, partial: snap() });
			};
			const streamed = () => message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
			// The streamed answer stays in the message content; this is only the error message under it.
			const incomplete = (reason: string) => streamed() ? "Incomplete AGY answer\n\n" + reason : reason;
			const finish = (text: string, error = false, aborted = false, doneReason: "stop" | "length" = "stop") => {
				if (finished) return;
				finished = true;
				message.stopReason = aborted ? "aborted" : error ? "error" : doneReason;
				if (error) {
					const clean = sanitizeDisplayText(text);
					message.errorMessage = revoked ? AGY_COPY.ended : clean;
					// Pi draws the error message itself ("Error: ..."), so a text block repeating it showed every refusal twice. The content keeps only what AGY streamed.
					if (!started) message.content = [];
					if (typedDuringTurn && callSession === ctx?.sessionManager.getSessionId()) {
						const user = [...branch()].reverse().find(e => e.type === "message" && e.message?.role === "user");
						if (user) acpTyped.push({ fingerprint: fingerprint(message), abortedFingerprint: message.stopReason === "aborted" ? fingerprint({ ...message, errorMessage: undefined }) : undefined, userId: user.id, userFingerprint: entryFingerprint(user) });
					}
					else if (!nativeAttempted && callSession === ctx?.sessionManager.getSessionId()) {
						const basis = acpRefusalBasis();
						if (basis) acpRefusal = { fingerprint: fingerprint(message), abortedFingerprint: message.stopReason === "aborted" ? fingerprint({ ...message, errorMessage: undefined }) : undefined, userId: basis.user.id, userFingerprint: entryFingerprint(basis.user), epoch: generation, sid: callSession!, anchor: basis.anchor, tuple: basis.tuple };
					}
					stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
				}
				else {
					// An empty answer is one literal empty text block; there is no placeholder text.
					if (!started) {
						startStream();
						message.content = [{ type: "text", text: "" }];
						stream.push({ type: "text_start", contentIndex: 0, partial: snap() });
					}
					else if (!message.content.length) message.content = [{ type: "text", text: "" }];
					endBlock(message.content.length - 1);
					stream.push({ type: "done", reason: doneReason, message });
				}
				stream.end();
			};
			const disclosure = async (o: AcpOwner | undefined) => {
				if (!o) return "";
				await retireAcp(o, false);
				const classification = (await o.close()).classification; // the same barrier retireAcp waited on
				return "\n" + (classification === "clean" || classification === "verified-interrupted" ? ACP_COPY.stopped : AGY_COPY.stopUnknown);
			};
			const revokeAnswer = (closeStream = true) => {
				revoked = true;
				if (closeStream) finish("", true);
			};
			const onAbort = () => {
				if (finished || nativeAttempted) return;
				void (async () => {
					if (createdOwner && used) await retireAcp(used, false);
					finish("AGY request cancelled before input. Your message was not sent.", true, true);
				})();
			};
			/**
			 * Maps AGY's frames for one turn: a tool call becomes the activity line and its saved record, a permission wait shows in the widget. `inputId` is the entry that owns the turn: the user's message for a prompt,
			 * the marker for a wake. `branchFp` is the branch the turn expects to find; each saved record moves it.
			 */
			const mapTurn = (m: { o: AcpOwner; sm: ExtensionContext["sessionManager"]; sid: string; cwd: string; inputId: string; branchFp: { get(): string; set(fp: string): void } }) => {
				const { o, sm, sid, cwd } = m;
				const activityBudget = newAgyActivityBudget();
				const liveTools = new Map<string, { name: string; kind: string; title: string; rawInput?: Record<string, unknown>; status: "starting" | "waiting" | "running" }>();
				const waitingToolIds = new Set<string>();
				let lastWidgetKey = "";
				const refreshActivityWidget = () => {
					if (ctx?.mode !== "tui") return;
					let next: string[] | undefined;
					if (liveTools.size > 0) {
						const activeEntries = [...liveTools.values()];
						const active = [...activeEntries].reverse().find(t => t.status === "waiting") ?? activeEntries.at(-1)!;
						const cmd = typeof active.rawInput?.CommandLine === "string" && active.rawInput.CommandLine.trim() ? active.rawInput.CommandLine : undefined;
						const rawLabel = sanitizeDisplayText(cmd ?? active.title ?? active.name).split("\n")[0]!.trim();
						const label = rawLabel || active.name;
						const stateText = active.status === "waiting" ? "waiting for approval" : active.status;
						next = [truncateToWidth(`${label} · ${stateText}`, 100, "…")];
					}
					const key = next ? next.join("\n") : "";
					if (key === lastWidgetKey) return;
					lastWidgetKey = key;
					try { ctx.ui.setWidget("rbf-agy-activity", next); } catch { }
				};
				const handleToolUpdate = (u: AcpToolUpdate) => {
					const existing = liveTools.get(u.toolCallId);
					const rawInput = isRecord(u.rawInput) ? u.rawInput : isRecord(u.args) ? u.args : existing?.rawInput;
					const name = typeof u.name === "string" && u.name.trim() ? u.name.trim() : existing?.name ?? "tool";
					const kind = typeof u.kind === "string" && u.kind.trim() ? u.kind.trim() : existing?.kind ?? "other";
					const CommandLine = typeof rawInput?.CommandLine === "string" && rawInput.CommandLine.trim() ? rawInput.CommandLine : undefined;
					const title = typeof u.title === "string" && u.title.trim() ? u.title.trim() : CommandLine ?? existing?.title ?? name;
					if (u.sessionUpdate === "tool_call") {
						const status = waitingToolIds.has(u.toolCallId) || u.status === "pending" ? "waiting" : "starting";
						liveTools.set(u.toolCallId, { name, kind, title, ...(rawInput !== undefined ? { rawInput } : {}), status });
						refreshActivityWidget();
						return;
					}
					if (u.status === "pending") {
						liveTools.set(u.toolCallId, { name, kind, title, ...(rawInput !== undefined ? { rawInput } : {}), status: "waiting" });
						refreshActivityWidget();
					} else if (u.status === "in_progress") {
						const status = waitingToolIds.has(u.toolCallId) ? "waiting" : "running";
						liveTools.set(u.toolCallId, { name, kind, title, ...(rawInput !== undefined ? { rawInput } : {}), status });
						refreshActivityWidget();
					} else if (u.status === "completed" || u.status === "failed") {
						liveTools.delete(u.toolCallId);
						refreshActivityWidget();
						let output: string | undefined;
						if (isRecord(u.rawOutput) && typeof u.rawOutput.output === "string") {
							output = u.rawOutput.output;
						} else if (Array.isArray(u.content)) {
							const parts: string[] = [];
							for (const c of u.content) {
								if (!isRecord(c)) continue;
								if (c.type === "content" && isRecord(c.content) && c.content.type === "text" && typeof c.content.text === "string") parts.push(c.content.text);
								else if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
							}
							if (parts.length > 0) output = parts.join("");
						}
						const rawExit = isRecord(u.rawOutput) ? (u.rawOutput.exit_code ?? u.rawOutput.exitCode) : undefined;
						const exitCode = typeof rawExit === "number" && Number.isSafeInteger(rawExit) ? rawExit : undefined;
						const approval = acpQueue?.approvalForToolCall(u.toolCallId);
						try {
							const saved = recordAgyAcpActivity({
								piSessionId: sid,
								inputEntryId: m.inputId,
								acpSessionId: o.acpSessionId,
								toolCallId: u.toolCallId,
								name,
								kind,
								title,
								state: u.status,
								...(approval ? { approval } : {}),
								...(name === "run_command" && CommandLine !== undefined ? { command: CommandLine } : {}),
								...(rawInput !== undefined ? { parameters: rawInput } : {}),
								...(output !== undefined ? { output } : {}),
								...(exitCode !== undefined ? { exitCode } : {}),
							}, activityBudget, {
								assertCurrent() {
									if (!currentScope() || !selected() || !sameAgyPolicy(policy, policyFile) || acpOwner !== o || sm.getSessionId() !== sid || realpathSync(ctx!.cwd) !== cwd)
										throw new Error(AGY_HISTORY_FAILURE);
								},
								entries: branch,
								leafId: () => sm.getLeafId(),
								fingerprint: es => acpBranchFingerprint([...es]),
								expectedFingerprint: m.branchFp.get(),
								append: (type, data) => pi.appendEntry(type, data),
							});
							m.branchFp.set(saved.fingerprint);
						} catch {
							notice(AGY_HISTORY_FAILURE, "warning");
						}
					}
				};
				const turnCtx: AcpTurnContext = {
					owner: o,
					userId: m.inputId,
					getExpectedBranch: m.branchFp.get,
					setExpectedBranch: m.branchFp.set,
					onToolWaiting: (toolCallId, waiting) => {
						if (waiting) waitingToolIds.add(toolCallId);
						else waitingToolIds.delete(toolCallId);
						const entry = liveTools.get(toolCallId);
						if (entry) {
							if (waiting) entry.status = "waiting";
							else {
								const stamp = acpQueue?.approvalForToolCall(toolCallId);
								if (!stamp || stamp.reply === "allow_once") entry.status = "running";
							}
							refreshActivityWidget();
						}
					},
				};
				return {
					turnCtx, handleToolUpdate,
					/** Clears the live-tool widget when the turn is over. */
					cleanup() {
						if (liveTools.size > 0 || lastWidgetKey !== "") {
							liveTools.clear();
							waitingToolIds.clear();
							refreshActivityWidget();
						}
					},
				};
			};

			/**
			 * A wake turn (Decisions 2026-11-22). AGY woke between turns, Pi saved the marker and started this run, and the owner holds what AGY said since. Nothing is sent to AGY: no `set_config_option`, no
			 * `session/prompt`. Pi saves `rbf-agy-acp-wake/v1` before anything streams, attaches, and the owner replays the held frames in order and then the live ones. The turn ends after AGY has been
			 * silent for 3 s with no approval dialog open. Esc sends `session/cancel` and ends it as aborted. The completion that names the wake is written at agent_end, as for a prompt.
			 */
			const runWake = async (admission?: string) => {
				const o = acpOwner, markerOwner = acpWakeMarkerOwner;
				acpWakeMarkerOwner = undefined;
				// A marker this provider sent whose wake the owner then gave up on (its 15 s attach timer ran out first): AGY's frames are gone, so the run has nothing to show. It still saves the wake, so the chain holds.
				const gone = !!o && o === markerOwner && !o.waking && o.state === "idle";
				if (!o || (!o.waking && !gone) || acpActive || acpAwaiting) throw new Error(AGY_COPY.ended);
				const sm = ctx!.sessionManager;
				if (!sm.getSessionFile())
					throw new Error("AGY needs Pi session history. Your message was not sent. Start a new Pi session with saving enabled.");
				// A signal already aborted needs no early exit: attachWake sends AGY session/cancel and holds off the next wake, as Esc during the turn does, and the turn is saved as a cancelled wake.
				const entries = branch(), marker = [...entries].reverse().find(e => e.type === "custom_message" && e.customType === AGY_WAKE_MARKER);
				if (!marker || entries.slice(entries.indexOf(marker) + 1).some(e => e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant")))
					throw new Error(AGY_COPY.branch);
				used = o;
				claimed = true;
				acpActive = reservation;
				revokeAcpPublication = revokeAnswer;
				const cwd = realpathSync(ctx!.cwd), sid = sm.getSessionId();
				const anchor = selectAcpRecoveryAnchor(readSavedSession(sm, cwd), marker.id, false, true); // RecoveryError: the chain does not hold, so nothing is saved for this wake
				if (!anchor || anchor.acpSessionId !== o.acpSessionId || (anchor.completion?.id ?? null) !== (acpAnchor?.completionId ?? null)) throw new Error(AGY_COPY.branch);
				// A reason to refuse that is not about the chain (the settings file changed, the host or the model no longer fits): the chain holds, so the wake is still saved and the run ends as a stopped wake below,
				// with AGY told to stop, instead of leaving an answer after the marker that no record covers and an owner still waking.
				let refusal = admission;
				try { checkPolicy(); } catch { refusal ??= ACP_COPY.wakeRefused; }
				const wake = appendEvidence(pi, sm, cwd, AGY_ACP_WAKE, { piSessionId: sid, acpSessionId: o.acpSessionId, markerEntryId: marker.id, previousCompletionId: acpAnchor?.completionId ?? null, prefixHash: historyFingerprint(branch()), startedAt: new Date().toISOString() });
				let expectedBranch = acpBranchFingerprint(branch());
				requestBranch = expectedBranch;
				nativeAttempted = true; // a wake is saved from here: a failure retires the owner, and a restart reads the wake as unknown
				const held = o.heldPair();
				if (held.model) message.model = held.model; // the pair AGY holds, which may not be what Pi has selected since
				const tuple = acpTuple(o, { model: held.model, effort: held.effort });
				const mapping = mapTurn({ o, sm, sid, cwd, inputId: marker.id, branchFp: { get: () => expectedBranch, set: fp => { expectedBranch = requestBranch = fp; } } });
				const turnCtx = mapping.turnCtx;
				acpTurn = turnCtx;
				// A refused run attaches with a signal that is already aborted, so attachWake does what Esc does: session/cancel, the holdoff, and the held requests answered for a stopped turn.
				const runSignal = refusal !== undefined && !gone ? AbortSignal.abort() : streamOptions?.signal;
				acpQueue?.beginTurn(marker.id, runSignal);
				let result: AcpWakeResult;
				try {
					// A wake the owner had given up on has nothing to attach to: it ends as a stopped wake (Decisions 2026-11-23), as Esc before the claim does. AGY gets session/cancel and the holdoff, the chat continues.
					if (gone) { o.stopAbandonedWake(); result = { ended: "cancelled", diverged: false }; }
					else result = await o.attachWake({ text: delta => chunk("text", delta), thought: delta => chunk("thinking", delta), tool: mapping.handleToolUpdate }, { signal: runSignal, quietMs: options.wakeQuietMs ?? WAKE_QUIET_MS, busy: () => (acpQueue?.liveCount ?? 0) > 0 });
				}
				catch (error) {
					if (!(error instanceof AcpLostError)) throw error;
					const tail = await disclosure(o);
					finish(incomplete(limitExceeded ? "AGY response exceeded the supported output limit. The answer is incomplete." + tail : streamOptions?.signal?.aborted ? "AGY request cancelled." + tail : ACP_COPY.lost + tail), true, !!streamOptions?.signal?.aborted);
					return;
				}
				finally {
					acpQueue?.endTurn();
					// Esc ends a wake at once, without waiting for AGY: the replies of the dialogs it closed are written, and their permission records saved under the marker, only after the current tick. The answer
					// must come after them, or the chain reads a permission with no open turn. The turn stays open meanwhile, so each record moves the expected branch.
					await permissionWritesDone();
					if (acpTurn === turnCtx) acpTurn = undefined;
					mapping.cleanup();
				}
				if (finished) return;
				if (result.diverged) {
					o.markIneligible();
					const tail = await disclosure(o);
					finish(ACP_COPY.diverged + tail, true);
					return;
				}
				if (limitExceeded) {
					o.markIneligible();
					const tail = await disclosure(o);
					finish(incomplete("AGY response exceeded the supported output limit. The answer is incomplete." + tail), true);
					return;
				}
				// A refused run has its reason (the settings file changed, say): `branchIntact` would call that a moved branch, so it does not look at a refusal.
				if (refusal === undefined && !branchIntact()) {
					const tail = await disclosure(o);
					finish(streamed() + "\n\n" + tail.trim());
					return;
				}
				const outcome: "stop" | "cancelled" = result.ended === "quiet" ? "stop" : "cancelled";
				acpAwaiting = true;
				if (outcome === "stop") finish("", false, false, "stop");
				else if (gone) finish(ACP_COPY.wakeGone, true, true);
				else if (refusal !== undefined) finish(refusal, true, true);
				else {
					finish(incomplete("AGY request cancelled."), true, true);
					notice("AGY request cancelled.", "warning");
				}
				acpTyped = [];
				acpPending = { fingerprint: fingerprint(message), abortedFingerprint: message.stopReason === "aborted" ? fingerprint({ ...message, errorMessage: undefined }) : undefined, userId: marker.id, branchFingerprint: expectedBranch, dispatchId: wake.id, tuple, usage: structuredClone(message.usage), epoch: generation, modelId: model.id, outcome, stopped: gone || refusal !== undefined };
			};

			void (async () => {
				try {
					// A wake run that fails these is still Pi's own run of the marker: it ends as a stopped wake (runWake), not as a refusal of a message.
					let admission: string | undefined;
					try {
						hostAdmission();
						checkPolicy();
						if (!selected() || model.provider !== AGY_PROVIDER)
							throw new Error(AGY_COPY.unsupported);
					}
					catch (error) {
						if (!wakeRun) throw error;
						admission = ACP_COPY.wakeRefused;
					}
					if (wakeRun) { await runWake(admission); return; }
					if (acpActive || acpAwaiting || acpOwner?.waking) {
						// Pi queued a message Tom typed while AGY worked and offers it after the turn's answer was saved, before agent_end: refuse it, keep the turn, and let agent_end record the pair.
						typedDuringTurn = acpAwaiting && !acpActive && acpPending !== undefined && callSession === acpPiSession;
						throw new Error(AGY_COPY.busy);
					}
					if (acpOwner && acpOwner.state !== "idle")
						throw new Error(AGY_COPY.ended);
					const sm = ctx!.sessionManager;
					if (!sm.getSessionFile())
						throw new Error("AGY needs Pi session history. Your message was not sent. Start a new Pi session with saving enabled.");
					const entries = branch(), latestUser = [...entries].reverse().find(e => e.type === "message" && e.message?.role === "user");
					if (!latestUser || typeof latestUser.id !== "string" || attempted.has(latestUser.id))
						throw new Error("AGY will not resend this user message. Your message was not sent. Submit a new task after /new.");
					requestUser = { id: latestUser.id, fingerprint: entryFingerprint(latestUser) };
					used = acpOwner;
					// On Pi 1.6.0 the saved order is the system message, then the user's (agent-session.js saves a changed system prompt first), but the context can also end with a system
					// message: agent.continue() declares a tool change after the last message (pi-agent-core agent-loop.js declareToolChanges). The text to send is the last user message.
					const prompt = userText([...context.messages].reverse().find(m => m.role === "user"));
					if (userText(latestUser.message) !== prompt)
						throw new Error(AGY_COPY.branch);
					if (!prompt.trim() || Buffer.byteLength(prompt) > BOUNDS.MAX_PROMPT_BYTES)
						throw new Error("AGY needs nonempty text of at most 256 KiB. Your message was not sent.");
					const cwd = realpathSync(ctx!.cwd), sid = sm.getSessionId();
					let expectedBranch = acpBranchFingerprint(entries);
					const checkBranch = () => {
						if (!live() || sm.getSessionId() !== sid || realpathSync(ctx!.cwd) !== cwd || acpBranchFingerprint(branch()) !== expectedBranch)
							throw new Error(AGY_COPY.branch);
					};
					const selection = resolveAgySelection(model, streamOptions?.reasoning);
					const wanted: AcpSelection = { model: model.id, thought: selection.nativeEffort };
					const saved = readSavedSession(sm, cwd);
					if (streamOptions?.signal?.aborted)
						throw new Error("AGY request cancelled before input. Your message was not sent.");
					claimed = true;
					acpActive = reservation;
					revokeAcpPublication = revokeAnswer;
					streamOptions?.signal?.addEventListener("abort", onAbort, { once: true });
					setChecking(true);
					const first = /^\/(\S+)/.exec(prompt)?.[1];
					const { owner: o, acked } = await acquireAcpOwner({
						cwd, sid, entries, saved, newUserId: latestUser.id, wanted, live, verify: checkBranch,
						started: child => { used = child; createdOwner = true; },
						recorded: () => { expectedBranch = acpBranchFingerprint(branch()); },
						beforePair: first === undefined ? undefined : async o => {
							const names = await o.commandList(2000);
							checkBranch();
							if (!names) throw new Error(retrySafe(([name]) => ACP_COPY.listMissing(name!), [sanitizeDisplayText(first).slice(0, 64)]));
							if (names.has(first)) throw new Error(retrySafe(([name]) => ACP_COPY.agyCommand(name!), [sanitizeDisplayText(first).slice(0, 64)]));
						},
					});
					used = o;
					// AGY woke while the pair was being set: the owner is no longer idle and its wake waits for Pi's turn. This message meets a busy AGY, with nothing written; the wake runs after it.
					if (o.waking) throw new Error(AGY_COPY.busy);
					// A newer selection while the pair was being checked cancels this send before anything is written.
					// First, because Pi saves a model_change entry for the selection, which also moves the branch.
					if (acpSelectionGeneration !== selectionAtStart) throw new Error(ACP_COPY.changeCancelled);
					checkBranch();
					checkPolicy();
					try { o.checkPromptSize(prompt); }
					catch (e) {
						if (e instanceof AcpOversizeRequestError) throw new Error("AGY needs nonempty text of at most 256 KiB. Your message was not sent.");
						throw e;
					}
					const tuple = acpTuple(o, { model: acked.model, effort: acked.effort });
					const dispatch = appendEvidence(pi, sm, cwd, AGY_ACP_DISPATCH, { ...tuple, userId: latestUser.id, userFingerprint: entryFingerprint(latestUser), prefixHash: historyFingerprint(branch()), previousCompletionId: acpAnchor?.completionId ?? null });
					expectedBranch = acpBranchFingerprint(branch());
					checkBranch();
					requestBranch = expectedBranch;
					attempted.add(latestUser.id);
					nativeAttempted = true;
					setChecking(false);
					const mapping = mapTurn({ o, sm, sid, cwd, inputId: latestUser.id, branchFp: { get: () => expectedBranch, set: fp => { expectedBranch = requestBranch = fp; } } });
					const turnCtx = mapping.turnCtx;
					acpTurn = turnCtx;
					acpQueue?.beginTurn(latestUser.id, streamOptions?.signal);
					let result;
					try {
						result = await o.prompt(prompt, { text: delta => chunk("text", delta), thought: delta => chunk("thinking", delta), tool: mapping.handleToolUpdate }, { signal: streamOptions?.signal, cancelGraceMs: options.cancelGraceMs ?? 3000 });
					}
					catch (error) {
						if (error instanceof AcpCancelTimeoutError) {
							const tail = await disclosure(o);
							finish(incomplete(ACP_COPY.cancelTimeout + tail), true, false);
							return;
						}
						if (!(error instanceof AcpLostError)) throw error;
						const tail = await disclosure(o);
						finish(incomplete(limitExceeded ? "AGY response exceeded the supported output limit. The answer is incomplete." + tail : streamOptions?.signal?.aborted ? "AGY request cancelled." + tail : ACP_COPY.lost + tail), true, !!streamOptions?.signal?.aborted);
						return;
					}
					finally {
						acpQueue?.endTurn();
						if (acpTurn === turnCtx) acpTurn = undefined;
						mapping.cleanup();
					}
					if (finished) return;
					if (result.diverged) {
						// AGY changed model or effort during the turn: the answer stays visible, but nothing saved will vouch for this turn.
						o.markIneligible();
						const tail = await disclosure(o);
						finish(ACP_COPY.diverged + tail, true);
						return;
					}
					if (limitExceeded) {
						o.markIneligible();
						const tail = await disclosure(o);
						finish(incomplete("AGY response exceeded the supported output limit. The answer is incomplete." + tail), true);
						return;
					}
					const mapped = ACP_DEFINITE_STOP_REASONS[result.stopReason];
					if (!mapped) {
						const tail = await disclosure(o);
						finish(incomplete(retrySafe(([reason]) => ACP_COPY.unsupportedStop(reason!), [sanitizeDisplayText(result.stopReason).slice(0, 40)]) + tail), true);
						return;
					}
					if (!branchIntact()) {
						const tail = await disclosure(o);
						finish(streamed() + "\n\n" + tail.trim());
						return;
					}
					if (result.usage) Object.assign(message.usage, { input: result.usage.input, output: result.usage.output, cacheRead: result.usage.cacheRead, cacheWrite: result.usage.cacheWrite, totalTokens: result.usage.totalTokens });
					const outcome: "stop" | "length" | "refusal" | "cancelled" =
						result.stopReason === "end_turn" ? "stop"
						: result.stopReason === "max_tokens" || result.stopReason === "max_turn_requests" ? "length"
						: result.stopReason === "refusal" ? "refusal"
						: "cancelled";
					acpAwaiting = true;
					if (outcome === "stop" || outcome === "length") finish("", false, false, outcome);
					else if (outcome === "refusal") finish(incomplete("AGY refused this request."), true, false);
					else {
						finish(incomplete("AGY request cancelled."), true, true);
						notice("AGY request cancelled.", "warning");
					}
					acpTyped = [];
					acpPending = { fingerprint: fingerprint(message), abortedFingerprint: message.stopReason === "aborted" ? fingerprint({ ...message, errorMessage: undefined }) : undefined, userId: latestUser.id, branchFingerprint: expectedBranch, dispatchId: dispatch.id, tuple, usage: structuredClone(message.usage), epoch: generation, modelId: model.id, outcome };
				}
				catch (error) {
					// An error that is not one of the copies (an operating-system error from a write, say) reaches Pi's retry check as it is; writing it apart when it would match keeps Pi from resending.
					const baseText = retrySafe(([t]) => t!, [!nativeAttempted && streamOptions?.signal?.aborted
						? "AGY request cancelled before input. Your message was not sent."
						: error instanceof AcpLostError ? (nativeAttempted ? ACP_COPY.lost : ACP_COPY.lostBeforeSend)
						: error instanceof Error ? error.message : "AGY request failed."]);
					// A newer selection cancelled the change and AGY was lost too (acquireAcpOwner turns the loss into the lost-before-send copy): the table's "Cancel after the conversation was lost".
					const lostText = baseText === ACP_COPY.lostBeforeSend && !nativeAttempted && acpSelectionGeneration !== selectionAtStart ? ACP_COPY.changeCancelledLost : baseText;
					// AGY woke while this prompt was in its settings step, and the step then refused it before anything was sent (a setting AGY will not take, a command list that never came, an AGY command's name). AGY's output
					// wins the race: the prompt gets the busy refusal and the owner keeps its wake, which runs after it. A lost owner, a moved branch or a changed settings file still end the conversation as before.
					const wakingBusy = !wakeRun && !nativeAttempted && !!used && used === acpOwner && used.waking && lostText.includes("Your message was not sent")
						&& lostText !== AGY_COPY.branch && lostText !== AGY_COPY.ended && lostText !== AGY_COPY.policy && lostText !== ACP_COPY.lostBeforeSend && lostText !== ACP_COPY.changeCancelledLost;
					const text = wakingBusy ? AGY_COPY.busy : lostText;
					// A refusal before the dispatch keeps a healthy owner: the conversation stays open and nothing was sent. A wake run whose saved chain does not hold is the exception (design 14:165): the owner retires, as it already did when the wake was still waiting.
					if (claimed && used && (nativeAttempted || (streamOptions?.signal?.aborted && createdOwner) || !selected() || ctx?.sessionManager.getSessionId() !== callSession || used !== acpOwner || (used.state !== "idle" && !(used.waking && text === AGY_COPY.busy)) || (createdOwner && !acpAnchor) || text === AGY_COPY.branch || (wakeRun && error instanceof RecoveryError)))
						await retireAcp(used, false);
					// A wake run refused before its record (the branch moved, no session file, an owner that cannot take it) leaves the owner waking and AGY working: stop both as Esc would, or the next burst of AGY's starts
					// another wake every 15 s. An owner the lines above retired is stopped already, and a prompt that is running is never touched.
					if (wakeRun && !nativeAttempted && acpOwner && (acpActive === undefined || acpActive === reservation) && (acpOwner.waking || acpOwner.state === "idle")) { acpOwner.abandonWake(); acpOwner.stopAbandonedWake(); }
					// A wake run is Pi's own (Tom sent nothing): whatever refused it, the line says what happened to AGY's work and never that a message was not sent.
					finish(incomplete(wakeRun && text.includes("Your message was not sent") ? ACP_COPY.wakeRefused : text), true, !!streamOptions?.signal?.aborted);
				}
				finally {
					setChecking(false);
					streamOptions?.signal?.removeEventListener("abort", onAbort);
					if (acpActive === reservation) {
						acpActive = undefined;
						if (revokeAcpPublication === revokeAnswer) revokeAcpPublication = undefined;
					}
				}
			})().catch(() => finish("AGY provider failed. The task outcome may be unknown. No automatic retry is allowed.", true));
			return stream;
		}
		async function acpAgentEnd(event: { messages: readonly any[] }, c: ExtensionContext) {
			if (acpRefusal && acpRefusal.epoch === generation && c.sessionManager.getSessionId() === acpRefusal.sid) {
				const proof = acpRefusal;
				acpRefusal = undefined;
				const all = c.sessionManager.getBranch() as any[], i = all.findIndex(e => e.id === proof.userId), user = all[i];
				const after = all.slice(i + 1).filter(e => e.type === "message");
				if (i >= 0 && entryFingerprint(user) === proof.userFingerprint && after.length === 1 && matchesAcpMessage(after[0].message, proof.fingerprint, proof.abortedFingerprint) && event.messages.some(m => matchesAcpMessage(m, proof.fingerprint, proof.abortedFingerprint))) {
					try {
						appendEvidence(pi, c.sessionManager, c.cwd, AGY_ACP_REFUSAL, { ...proof.tuple, conversationEntryId: proof.anchor.conversationId, completionId: proof.anchor.completionId, userId: user.id, userFingerprint: entryFingerprint(user), assistantId: after[0].id, assistantFingerprint: entryFingerprint(after[0]), prefixHash: historyFingerprint(all) });
					} catch { await retireAcp(); notice(RECOVERY_COPY.checkpoint); }
				}
			}
			if (!acpPending || !acpAwaiting || c.sessionManager.getSessionId() !== acpPiSession)
				return;
			const pending = acpPending;
			// A stopped wake ran nothing under the settings file (that is often why it was stopped), so a changed file does not stop its completion from being written.
			if (pending.epoch !== generation || (!pending.stopped && !sameAgyPolicy(policy, policyFile))) {
				await retireAcp(); notice(RECOVERY_COPY.checkpoint); return;
			}
			if (!event.messages.some(m => matchesAcpMessage(m, pending.fingerprint, pending.abortedFingerprint)))
				return;
			const all = branch(), user = all.findIndex(e => e.id === pending.userId), chat = all.slice(user + 1).filter(e => e.type === "message");
			// The turn's answer comes first. Anything after it must be a message Tom typed while AGY worked and the busy answer Pi saved for it, in the order they were refused.
			const typed = acpTyped; acpTyped = [];
			const turnAnswer = chat[0], answer = turnAnswer?.message?.role === "assistant" ? turnAnswer : undefined;
			const pairsOk = chat.length === 1 + 2 * typed.length && typed.every((t, k) => {
				const u = chat[1 + 2 * k], a = chat[2 + 2 * k];
				return u?.id === t.userId && u.message?.role === "user" && entryFingerprint(u) === t.userFingerprint && a?.message?.role === "assistant" && matchesAcpMessage(a.message, t.fingerprint, t.abortedFingerprint);
			});
			const assistantIndex = answer ? all.indexOf(answer) : -1;
			const covered = new Set(chat.slice(1).map(e => e.id));
			const isBetweenTurnAcp = (e: any) =>
				e?.type === "custom"
				&& (e.customType === AGY_ACP_PERMISSION || e.customType === AGY_ACP_QUESTION)
				&& e.data?.inputEntryId === null
				&& e.data?.acpSessionId === pending.tuple.acpSessionId
				&& (e.data.piSessionId === undefined || e.data.piSessionId === acpPiSession);
			// A custom message saved after the answer is passive, as in the recovery chain (only user and assistant messages count): Pi flushes one sent during a run at that run's turn_end, after the answer and before this event.
			// The branch fingerprint below is taken in front of the answer, so it never sees such a message.
			const trailingOk = assistantIndex >= 0 && all.slice(assistantIndex + 1).every(e => covered.has(e.id) || isAcpPassive(e) || e.type === "custom_message" || isBetweenTurnAcp(e));
			if (user < 0 || !answer || !pairsOk || !trailingOk || !matchesAcpMessage(answer.message, pending.fingerprint, pending.abortedFingerprint) || acpBranchFingerprint(all.slice(0, assistantIndex)) !== pending.branchFingerprint) {
				await retireAcp();
				notice(AGY_COPY.branch);
				return;
			}
			try {
				// Each typed message gets its refusal record first, naming the open dispatch; the completion follows and covers the turn.
				for (let k = 0; k < typed.length; k++) {
					const u = chat[1 + 2 * k], a = chat[2 + 2 * k];
					appendEvidence(pi, c.sessionManager, c.cwd, AGY_ACP_REFUSAL, { ...pending.tuple, conversationEntryId: acpAnchor!.conversationId, completionId: acpAnchor!.completionId, dispatchId: pending.dispatchId, userId: u.id, userFingerprint: entryFingerprint(u), assistantId: a.id, assistantFingerprint: entryFingerprint(a), prefixHash: historyFingerprint(branch()) });
				}
				const data = { ...pending.tuple, dispatchId: pending.dispatchId, assistantId: answer.id, assistantFingerprint: entryFingerprint(answer), prefixHash: historyFingerprint(branch()), usage: pending.usage, outcome: pending.outcome };
				const entry = appendEvidence(pi, c.sessionManager, c.cwd, AGY_ACP_COMPLETION, data);
				acpAnchor = { conversationId: acpAnchor!.conversationId, completionId: entry.id };
			} catch {
				await retireAcp();
				notice(RECOVERY_COPY.checkpoint);
				return;
			}
			acpPending = undefined;
			acpAwaiting = false;
		}
		/** A turn that ends at once with Pi's error line: nothing is sent, nothing is started and nothing is saved but Pi's own error entry. */
		function refusalStream(model: Model<any>, text: string) {
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = { role: "assistant", api: AGY_API, provider: AGY_PROVIDER, model: model.id, content: [], usage: structuredClone(ZERO_USAGE), stopReason: "error", errorMessage: text, timestamp: Math.max(Date.now(), lastMessageTimestamp + 1) };
			lastMessageTimestamp = message.timestamp;
			queueMicrotask(() => { stream.push({ type: "error", reason: "error", error: message }); stream.end(); });
			return stream;
		}
		// A session with a CLI record (or a legacy AGY tool call) on any branch is a CLI-born chat: refused first, before any other check. Every other session is an ACP chat.
		// The CLI route that wrote those records is deleted (Decisions 2026-11-22); this test is all that is left of it.
		function streamSimple(model: Model<any>, context: Context, streamOptions?: SimpleStreamOptions) {
			let cliBorn = false, readable = ctx !== undefined;
			try { cliBorn = readable && cliPriorUse(); } catch { readable = false; /* Unreadable history: refuse rather than start AGY with no context. */ }
			if (!readable) return refusalStream(model, AGY_COPY.branch);
			return cliBorn ? refusalStream(model, CLI_BORN_COPY) : acpStreamSimple(model, context, streamOptions);
		}
		pi.registerFlag("agy-settings", { description: "Explicit user-owned AGY session-settings JSON file", type: "string" });
		pi.registerProvider(AGY_PROVIDER, { api: AGY_API, baseUrl: "stdio://agy", apiKey: "agy-native-cli", models: [], refreshModels, streamSimple });
		pi.on("session_start", async (_event, c) => {
			if (acpPiSession && acpPiSession !== c.sessionManager.getSessionId() && acpOwner)
				await retireAcp();
			ctx = c;
			currentModel = c.model;
			if (!seal.owner) {
				attempted.clear();
				acpOwner = undefined; acpQueue = undefined; acpTurn = undefined; acpAnchor = undefined; acpPending = undefined; acpRefusal = undefined; acpTyped = []; acpAwaiting = false; acpPiSession = ""; acpWakeRun = false; acpWakeDeferred = undefined; acpWakeMarkerOwner = undefined; releaseInputHold(); stopWakePoll();
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
			// A selection waits for the next send; only leaving AGY stops the child.
			if (previous?.provider !== event.model.provider || previous?.id !== event.model.id) acpSelectionGeneration++;
			if (acpOwner && acpOwner.state !== "retired" && event.model.provider !== AGY_PROVIDER) await retireAcp();
			present();
		});
		pi.on("thinking_level_select", async (event) => {
			if (event.level === event.previousLevel) return;
			acpSelectionGeneration++;
		});
		// Pi 1.6.0 events the 0.85.1 types this repo builds against predate: `before_agent_start` carries `messageType` ("custom" for a run started by pi.sendMessage), and `agent_settled` fires once Pi is idle.
		const onPiEvent = pi.on.bind(pi) as unknown as (name: string, handler: (event: any, c: ExtensionContext) => unknown) => void;
		onPiEvent("before_agent_start", async event => {
			acpWakeRun = event?.messageType === "custom" && event.message?.customType === AGY_WAKE_MARKER;
			releaseInputHold(); // a run exists now, so Pi is no longer idle; a deferred wake goes out when it settles
		});
		// An idle Pi is about to check the prompt Tom typed: hold wakes until that prompt's run starts or INPUT_HOLD_MS passes. A prompt that never becomes a run (another extension handles it) is covered by the timeout.
		onPiEvent("input", async (_event, c) => {
			ctx = c;
			try {
				if (!acpOwner || !c.isIdle()) return;
				releaseInputHold();
				acpInputHold = setTimeout(() => { acpInputHold = undefined; pumpWake(); }, INPUT_HOLD_MS);
				acpInputHold.unref?.();
			}
			catch { /* The hold is a courtesy to Tom's prompt; without it the old race is back, nothing else changes. */ }
		});
		onPiEvent("agent_settled", async (_event, c) => {
			ctx = c;
			acpWakeRun = false;
			const o = acpWakeDeferred;
			if (!o || !o.waking) { acpWakeDeferred = undefined; stopWakePoll(); return; }
			if (o !== acpOwner || !selected() || c.sessionManager.getSessionId() !== acpPiSession || acpAwaiting) { acpWakeDeferred = undefined; stopWakePoll(); o.abandonWake(); return; }
			if (acpActive || acpInputHold) return; // Tom's next prompt is being checked: the hold's end or the next poll sends it
			acpWakeDeferred = undefined; stopWakePoll();
			sendAcpWakeMarker(o);
		});
		pi.on("agent_end", async (event, c) => {
			ctx = c;
			await acpAgentEnd(event, c);
		});
		pi.on("session_tree", async (event, c) => {
			ctx = c;
			if (event.newLeafId !== event.oldLeafId && acpOwner && acpOwner.state !== "retired")
				await retireAcp();
		});
		pi.on("session_before_tree", async (event) => selected() && event.preparation.userWantsSummary ? { summary: { summary: "AGY branch summaries are unavailable; no native input was sent." } } : {});
		pi.on("session_before_compact", async () => selected() ? { cancel: true } : {});
		pi.on("session_before_switch", async () => acpOwner && !(await retireAcp()) ? { cancel: true } : {});
		pi.on("session_before_fork", async () => acpOwner && !(await retireAcp()) ? { cancel: true } : {});
		pi.on("session_shutdown", async (event) => {
			await retireAcp();
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
