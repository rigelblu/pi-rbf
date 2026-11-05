import { AGY_ACTIVITY, parseAgyActivity } from "./agy-history.js";
// Local consistency evidence for clean completed turns. This is not native head
// verification or a cross-process lease: one Pi process must be the sole writer.
import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, fsyncSync, realpathSync } from "node:fs";

export const AGY_DISPATCH = "rbf-agy-dispatch/v1";
export const AGY_COMPLETION = "rbf-agy-completion/v1";
export const AGY_REFUSAL = "rbf-agy-refusal/v1";
export const RECOVERY_COPY = {
	missing: "This AGY conversation has no verified recovery checkpoint. Your message was not sent. Use /new to start a new conversation.",
	mismatch: "AGY history no longer matches this Pi branch. Your message was not sent. Use /new to start a new conversation.",
	unknown: "Earlier AGY work has an unknown outcome. Your message was not sent. Check any changes and running commands before starting new work with /new.",
	unavailable: "AGY recovery could not be verified. Your message was not sent. Check native AGY availability, then send again.",
	cancelled: "AGY recovery was cancelled. Your message was not sent.",
	checkpoint: "AGY recovery checkpoint could not be confirmed. The answer is visible, but recovery may be unavailable after restart.",
} as const;
export class RecoveryError extends Error {
	constructor(readonly kind: "missing" | "mismatch" | "unknown" | "unavailable") { super(RECOVERY_COPY[kind]); }
}
export interface RecoveryTuple {
	sessionId: string; sessionFile: string; cwd: string; conversationId: string;
	nativeModel: string; nativeEffort: string | null; policyHash: string | null; permissionMode: string;
}
export interface CompletionData extends RecoveryTuple {
	dispatchId: string; assistantId: string; assistantFingerprint: string; prefixHash: string;
	acceptedCount: number; frontier: number;
}
export interface CompletionAnchor { entry: any; data: CompletionData }
interface SessionView {
	getSessionId(): string; getSessionFile(): string | undefined;
	getLeafId(): string | null; getBranch(): readonly any[];
}
export interface SavedSession {
	all: any[]; branch: any[]; sessionId: string; sessionFile: string; cwd: string;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function fingerprint(message: any): string {
	return hash([message?.role, message?.provider, message?.api, message?.model, message?.timestamp, message?.stopReason, message?.content, message?.usage, message?.errorMessage]);
}
export function entryFingerprint(entry: any): string { return hash(entry); }
export function branchFingerprint(entries: readonly any[]): string { return hash(entries.map(entryFingerprint)); }
/** Another extension's plain custom entry. Pi never sends these to the model, so AGY's history checks skip them. */
export function isForeignEntry(entry: any): boolean { return entry?.type === "custom" && !/^rbf-agy-/.test(typeof entry.customType === "string" ? entry.customType : ""); }
/** The branch as AGY's history checks see it: without other extensions' plain custom entries. */
export function historyFingerprint(entries: readonly any[]): string { return branchFingerprint(entries.filter(e => !isForeignEntry(e))); }
const mismatch = (): never => { throw new RecoveryError("mismatch"); };
const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const digest = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) < Number.MAX_SAFE_INTEGER;
export function sameRecoveryTuple(a: RecoveryTuple, b: RecoveryTuple): boolean {
	return ["sessionId", "sessionFile", "cwd", "conversationId", "nativeModel", "nativeEffort", "policyHash", "permissionMode"].every(k => a[k as keyof RecoveryTuple] === b[k as keyof RecoveryTuple]);
}
function textOnly(e: any): boolean {
	const content = e?.message?.content;
	return typeof content === "string" || (Array.isArray(content) && content.every((c: any) => c?.type === "text" && typeof c.text === "string"));
}
function validTuple(d: any, saved: SavedSession): boolean {
	return d && d.sessionId === saved.sessionId && d.sessionFile === saved.sessionFile && d.cwd === saved.cwd &&
		isString(d.conversationId) && isString(d.nativeModel) && (d.nativeEffort === null || isString(d.nativeEffort)) &&
		(d.policyHash === null || digest(d.policyHash)) && isString(d.permissionMode);
}

// Read raw bytes, not Pi's forgiving loader. Parent-before-child also rules out
// cycles. Sync and readback acknowledge these bytes only, never an earlier write.
export function readSavedSession(sm: SessionView, cwd: string): SavedSession {
	let fd: number | undefined;
	try {
		const file = sm.getSessionFile();
		if (!file) return mismatch();
		fd = openSync(file, constants.O_RDWR | constants.O_NOFOLLOW);
		const stat = fstatSync(fd), named = lstatSync(file);
		if (!stat.isFile() || stat.uid !== process.getuid?.() || named.isSymbolicLink() || named.ino !== stat.ino || named.dev !== stat.dev || stat.size > 64 * 1024 * 1024) return mismatch();
		const sessionFile = realpathSync(file), canonicalCwd = realpathSync(cwd);
		fsyncSync(fd);
		const bytes = Buffer.alloc(stat.size + 1);
		let n = 0;
		while (n < bytes.length) { const got = readSync(fd, bytes, n, bytes.length - n, null); if (!got) break; n += got; }
		const after = fstatSync(fd), stillNamed = lstatSync(file);
		if (n !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || stillNamed.ino !== stat.ino || stillNamed.dev !== stat.dev || n === 0 || bytes[n - 1] !== 10) return mismatch();
		const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, n)).slice(0, -1).split("\n");
		if (lines.length > 262145 || lines.some(line => !line.trim())) return mismatch();
		const [header, ...all] = lines.map(line => JSON.parse(line));
		if (header?.type !== "session" || header.version !== 3 || header.id !== sm.getSessionId() || !isString(header.cwd) || realpathSync(header.cwd) !== canonicalCwd) return mismatch();
		const byId = new Map<string, any>();
		for (const e of all) {
			if (!e || !isString(e.id) || !isString(e.type) || byId.has(e.id) || (e.parentId !== null && (!isString(e.parentId) || !byId.has(e.parentId)))) return mismatch();
			byId.set(e.id, e);
		}
		const branch: any[] = [];
		let leaf = sm.getLeafId();
		while (leaf !== null) { const e = byId.get(leaf); if (!e) return mismatch(); branch.push(e); leaf = e.parentId; }
		branch.reverse();
		if (branchFingerprint(branch) !== branchFingerprint(sm.getBranch())) return mismatch();
		return { all, branch, sessionFile, sessionId: header.id, cwd: canonicalCwd };
	} catch (error) {
		if (error instanceof RecoveryError) throw error;
		return mismatch();
	} finally { if (fd !== undefined) closeSync(fd); }
}

export function appendEvidence(pi: { appendEntry(type: string, data: any): unknown }, sm: SessionView, cwd: string, type: string, data: any): any {
	const before = readSavedSession(sm, cwd), parent = sm.getLeafId();
	pi.appendEntry(type, data);
	const after = readSavedSession(sm, cwd), entry = after.branch.at(-1);
	if (!entry || entry.type !== "custom" || entry.customType !== type || entry.parentId !== parent || entry.id !== sm.getLeafId() || JSON.stringify(entry.data) !== JSON.stringify(data) || after.branch.length !== before.branch.length + 1 || branchFingerprint(after.branch.slice(0, -1)) !== branchFingerprint(before.branch)) return mismatch();
	return entry;
}

// Validate the complete selected chain, including prior completions and exact
// certificates. A saved dispatch with no completion/certified zero write blocks.
export function selectRecoveryCompletion(saved: SavedSession, newUserId: string): CompletionAnchor {
	const entries = saved.branch;
	// Match branchFingerprint's JSON array encoding with one linear prefix pass.
	const prefixes: string[] = [], prefix = createHash("sha256").update("[");
	let included = 0;
	for (let i = 0; i <= entries.length; i++) {
		prefixes.push(prefix.copy().update("]").digest("hex"));
		if (i < entries.length && !isForeignEntry(entries[i])) prefix.update((included++ ? "," : "") + JSON.stringify(entryFingerprint(entries[i])));
	}
	let completion: CompletionAnchor | undefined, completionIndex = -1;
	let intent: { entry: any; index: number } | undefined;
	const refused = new Set<string>();
	let started = false, observationSequence = 0;
	const passive = new Set(["message", "custom", "model_change", "thinking_level_change", "session_info", "label"]);
	function tail(start: number, end: number, userId: string, assistantId?: string) {
		const messages = entries.slice(start, end).filter(e => e.type === "message" && !refused.has(e.id));
		if (messages.length !== (assistantId ? 2 : 1) || messages[0]?.id !== userId || messages[0]?.message?.role !== "user" || (assistantId && (messages[1]?.id !== assistantId || messages[1]?.message?.role !== "assistant"))) return mismatch();
		for (const e of messages) if (!textOnly(e)) return mismatch();
	}
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		if (started && !passive.has(e.type)) return mismatch();
		if (e.type !== "custom") continue;
		if (isForeignEntry(e)) continue;
		if (e.customType === AGY_ACTIVITY) {
			const activity = parseAgyActivity(e.data), dispatch = intent?.entry.data;
			let p = i - 1;
			while (p >= 0 && isForeignEntry(entries[p])) p--;
			const previousType = entries[p]?.customType;
			if (!activity || !dispatch || (previousType !== AGY_DISPATCH && previousType !== AGY_ACTIVITY) ||
				activity.source.kind !== "root" || activity.piSessionId !== dispatch.sessionId ||
				activity.inputEntryId !== dispatch.userId || activity.rootConversationId !== dispatch.conversationId ||
				activity.turnCount !== dispatch.acceptedCount + 1 || activity.sequence !== ++observationSequence)
				return mismatch();
			continue;
		}
		if (![AGY_DISPATCH, AGY_COMPLETION, AGY_REFUSAL].includes(e.customType)) {
			if (e.customType !== "rbf-agy-conversation/v1") return mismatch();
			continue;
		}
		const d = e.data;
		if (!validTuple(d, saved)) return mismatch();
		if (e.customType === AGY_DISPATCH) {
			started = true;
			if (intent) throw new RecoveryError("unknown");
			if (!count(d.acceptedCount) || !Number.isSafeInteger(d.frontier) || d.frontier < -1 || !digest(d.prefixHash) || d.prefixHash !== prefixes[i]) return mismatch();
			const u = entries.slice(0, i).find(x => x.id === d.userId);
			if (!u || u.message?.role !== "user" || !textOnly(u) || entries.slice(0, i).reverse().find(x => x.type === "message")?.id !== u.id || d.userFingerprint !== entryFingerprint(u)) return mismatch();
			if (completion) {
				if (!sameRecoveryTuple(d, completion.data) || d.previousCompletionId !== completion.entry.id || d.acceptedCount !== completion.data.acceptedCount || d.frontier !== completion.data.frontier) return mismatch();
				tail(completionIndex + 1, i, u.id);
			} else if (d.previousCompletionId !== null || d.acceptedCount !== 0 || d.frontier !== -1) return mismatch();
			intent = { entry: e, index: i };
			observationSequence = 0;
		} else if (e.customType === AGY_COMPLETION) {
			if (!intent || d.dispatchId !== intent.entry.id || !sameRecoveryTuple(d, intent.entry.data) || !count(d.acceptedCount) || d.acceptedCount !== intent.entry.data.acceptedCount + 1 || !Number.isSafeInteger(d.frontier) || d.frontier <= intent.entry.data.frontier) return mismatch();
			const assistants = entries.slice(intent.index + 1, i).filter(x => x.type === "message");
			const a = assistants[0];
			if (assistants.length !== 1 || a?.message?.role !== "assistant" || !textOnly(a) || a.message.stopReason !== "stop" || a.id !== d.assistantId || entryFingerprint(a) !== d.assistantFingerprint || d.prefixHash !== prefixes[i]) return mismatch();
			completion = { entry: e, data: d }; completionIndex = i; intent = undefined; refused.clear();
		} else {
			if (!completion || !sameRecoveryTuple(d, completion.data) || d.completionId !== completion.entry.id || d.prefixHash !== prefixes[i]) return mismatch();
			if (intent ? d.dispatchId !== intent.entry.id : d.dispatchId !== undefined) return mismatch();
			tail(completionIndex + 1, i, d.userId, d.assistantId);
			const u = entries.find(x => x.id === d.userId), a = entries.find(x => x.id === d.assistantId);
			if (entryFingerprint(u) !== d.userFingerprint || entryFingerprint(a) !== d.assistantFingerprint) return mismatch();
			refused.add(u.id); refused.add(a.id); intent = undefined;
		}
	}
	if (intent) throw new RecoveryError("unknown");
	if (!completion) throw new RecoveryError("missing");
	tail(completionIndex + 1, entries.length, newUserId);
	const latestFileIndex = saved.all.findIndex(e => e.id === completion!.entry.id), selected = new Set(entries.map(e => e.id));
	if (saved.all.slice(latestFileIndex + 1).some(e => !selected.has(e.id) && /^rbf-agy-(dispatch|completion)\//.test(e.customType ?? "") && e.data?.conversationId === completion!.data.conversationId)) return mismatch();
	return completion;
}
