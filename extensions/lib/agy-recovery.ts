// Local consistency evidence for ACP turns: the saved branch read back from disk, and the chain of AGY records on it. This is not native head
// verification or a cross-process lease: one Pi process must be the sole writer.
import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, fsyncSync, realpathSync } from "node:fs";

// The record types the deleted CLI route wrote. Nothing reads or writes them any more; the names stay so a session that holds one is recognised as CLI-born and refused (ER9). `rbf-agy-conversation/v1` is AGY_PROVENANCE in rbf-agy.ts.
export const AGY_DISPATCH = "rbf-agy-dispatch/v1";
export const AGY_COMPLETION = "rbf-agy-completion/v1";
export const AGY_REFUSAL = "rbf-agy-refusal/v1";
// ACP-route records (#pi-21.3), named by route, not version.
export const AGY_ACP_CONVERSATION = "rbf-agy-acp-conversation/v1";
export const AGY_ACP_DISPATCH = "rbf-agy-acp-dispatch/v1";
export const AGY_ACP_COMPLETION = "rbf-agy-acp-completion/v1";
export const AGY_ACP_REFUSAL = "rbf-agy-acp-refusal/v1";
// A wake turn (AGY woke by itself between turns). Plays the dispatch's part in the chain; the marker line that starts the turn is a custom_message entry.
export const AGY_ACP_WAKE = "rbf-agy-acp-wake/v1";
// Written by the commands-in-history and approvals tasks; the recovery chain already accepts them where the design lets them sit.
export const AGY_ACP_ACTIVITY = "rbf-agy-acp-activity/v1";
export const AGY_ACP_PERMISSION = "rbf-agy-acp-permission/v1";
export const AGY_ACP_QUESTION = "rbf-agy-acp-question/v1";
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
function textOnly(e: any): boolean {
	const content = e?.message?.content;
	return typeof content === "string" || (Array.isArray(content) && content.every((c: any) => c?.type === "text" && typeof c.text === "string"));
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

/** What an ACP chat's saved branch proves: the conversation record, the latest completion (null before the first turn) and the frozen settings identity. */
export interface AcpAnchor {
	conversation: any;
	completion: any | null;
	acpSessionId: string;
	cwd: string;
	/** The settings-file hash every record of this chat carries, or undefined while no record has carried one yet. */
	policyHash: string | null | undefined;
}
/** The custom_message entry Pi saves when it starts a wake turn (`pi.sendMessage`). */
export const AGY_WAKE_MARKER = "rbf-agy-wake";
/** The custom_message entry Pi saves, with no turn of its own, when a wake was dropped before any marker went out (Pi stayed busy for the whole attach time). Passive in the chain like the marker. */
export const AGY_WAKE_GONE = "rbf-agy-wake-gone";
const ACP_PASSIVE = new Set(["message", "custom_message", "model_change", "thinking_level_change", "session_info", "label"]);
/**
 * The chain counts only the user's and AGY's messages. Every other message role is passive wherever it sits: `system` (Pi 1.6.0 saves one before the user's message whenever the system
 * prompt's sections change), `toolResult`, `bashExecution` (a `!` command), `custom` (another extension's `pi.sendMessage`, saved as a `custom_message` entry), `branchSummary`,
 * `compactionSummary`, and roles an extension adds (docs/message-types.md). None is ever sent to AGY, which gets the user's text only.
 */
const isChatMessage = (e: any) => e?.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant");
const ACP_OUTCOME: Record<string, string> = { stop: "stop", cancelled: "aborted", length: "length", refusal: "error" };
function acpContent(e: any): boolean {
	const content = e?.message?.content;
	return typeof content === "string" || (Array.isArray(content) && content.every((c: any) => (c?.type === "text" && typeof c.text === "string") || (c?.type === "thinking" && typeof c.thinking === "string")));
}

/**
 * The ACP recovery chain. Walks the saved branch from its conversation record and returns the anchor to resume, `undefined` when the branch holds no ACP chat
 * (so a new one starts), or throws RecoveryError: `unknown` for a dispatch no completion closed, `mismatch` for anything the design does not let sit there.
 * Pi's own passive entries (model and thinking-level changes, names, labels) and other extensions' custom entries may sit anywhere after the conversation record;
 * every other Pi entry type (compaction, branch summary, usage, context edit) and every AGY record it does not list is a mismatch.
 * `refusing` asks for the anchor a refusal record would name: the message being refused is the last one and may hold anything, an image included, since nothing will be sent.
 * `wake` asks for the anchor a wake turn would sit on: there is no new user message (`newUserId` is ignored), and the branch after the anchor holds none that nothing answered.
 */
export function selectAcpRecoveryAnchor(saved: SavedSession, newUserId: string, refusing = false, wake = false): AcpAnchor | undefined {
	const entries = saved.branch;
	const isAcp = (e: any) => e?.type === "custom" && /^rbf-agy-acp-/.test(typeof e.customType === "string" ? e.customType : "");
	const ci = entries.findIndex(e => e.type === "custom" && e.customType === AGY_ACP_CONVERSATION);
	if (ci < 0) return entries.some(isAcp) ? mismatch() : undefined;
	const conversation = entries[ci], c = conversation.data;
	if (!c || !isString(c.acpSessionId) || c.cwd !== saved.cwd || c.piSessionId !== saved.sessionId) return mismatch();
	const prefixes: string[] = [], prefix = createHash("sha256").update("[");
	let included = 0;
	for (let i = 0; i <= entries.length; i++) {
		prefixes.push(prefix.copy().update("]").digest("hex"));
		if (i < entries.length && !isForeignEntry(entries[i])) prefix.update((included++ ? "," : "") + JSON.stringify(entryFingerprint(entries[i])));
	}
	// The first user message of a chat is saved before its conversation record, so the window of messages an anchor owns starts at that message.
	const before = entries.slice(0, ci).map((e, i) => ({ e, i })).filter(x => isChatMessage(x.e)).at(-1);
	let windowStart = before?.e.message?.role === "user" ? before.i : ci + 1;
	// `intent` is the open turn: a dispatch (its input is the user's message) or a wake (its input is the marker). Both are closed by a completion that names them.
	let completion: any = null, intent: { entry: any; index: number; input: string; wake: boolean } | undefined, policyHash: string | null | undefined, activity = 0, anchorIndex = ci;
	const refused = new Set<string>();
	const tuple = (d: any) => {
		if (!d || typeof d !== "object" || d.sessionId !== saved.sessionId || d.sessionFile !== saved.sessionFile || d.cwd !== saved.cwd || d.acpSessionId !== c.acpSessionId || !(d.policyHash === null || digest(d.policyHash))) return false;
		if (policyHash !== undefined && d.policyHash !== policyHash) return false;
		policyHash = d.policyHash;
		return true;
	};
	// A message that was sent is text; one that was refused (an image, say) may hold anything.
	const tail = (start: number, end: number, userId: string, assistantId?: string, anyContent = false) => {
		const messages = entries.slice(start, end).filter(e => isChatMessage(e) && !refused.has(e.id));
		if (messages.length !== (assistantId ? 2 : 1) || messages[0]?.id !== userId || messages[0]?.message?.role !== "user" || !(anyContent || textOnly(messages[0]))) return mismatch();
		if (assistantId && (messages[1]?.id !== assistantId || messages[1]?.message?.role !== "assistant" || !acpContent(messages[1]))) return mismatch();
	};
	for (let i = ci + 1; i < entries.length; i++) {
		const e = entries[i];
		if (!ACP_PASSIVE.has(e.type) && e.type !== "custom") return mismatch();
		if (e.type !== "custom" || isForeignEntry(e)) continue;
		const d = e.data, kind = e.customType;
		if (![AGY_ACP_DISPATCH, AGY_ACP_COMPLETION, AGY_ACP_REFUSAL, AGY_ACP_ACTIVITY, AGY_ACP_PERMISSION, AGY_ACP_QUESTION, AGY_ACP_WAKE].includes(kind)) return mismatch();
		if (!d || typeof d !== "object" || d.acpSessionId !== c.acpSessionId || (d.cwd !== undefined && d.cwd !== c.cwd) || (d.piSessionId !== undefined && d.piSessionId !== c.piSessionId)) return mismatch();
		if (kind === AGY_ACP_PERMISSION || kind === AGY_ACP_QUESTION) {
			// A request between turns carries no message; one during a turn names the dispatch's user message.
			if (!(d.inputEntryId === null || (intent && d.inputEntryId === intent.input))) return mismatch();
		}
		else if (kind === AGY_ACP_ACTIVITY) {
			if (!intent || d.inputEntryId !== intent.input || !Number.isSafeInteger(d.sequence) || d.sequence <= activity || (activity === 0 && d.sequence !== 1)) return mismatch(); // strictly increasing, from 1
			activity = d.sequence;
		}
		else if (kind === AGY_ACP_DISPATCH) {
			if (intent) throw new RecoveryError("unknown");
			if (!tuple(d) || !isString(d.model) || !(d.effort === null || isString(d.effort)) || !isString(d.userId) || !digest(d.userFingerprint) || !digest(d.prefixHash) || d.prefixHash !== prefixes[i]) return mismatch();
			if (d.previousCompletionId !== (completion?.id ?? null)) return mismatch();
			const u = entries.slice(0, i).find(x => x.id === d.userId);
			if (!u || u.type !== "message" || u.message?.role !== "user" || !textOnly(u) || entries.slice(0, i).reverse().find(isChatMessage)?.id !== u.id || d.userFingerprint !== entryFingerprint(u)) return mismatch();
			tail(windowStart, i, u.id);
			intent = { entry: e, index: i, input: d.userId, wake: false };
			activity = 0;
		}
		else if (kind === AGY_ACP_WAKE) {
			// A wake turn: the marker (a custom_message entry after the last anchor), then this record, which plays the dispatch's part. No message may sit unrefused in front of it.
			if (intent) throw new RecoveryError("unknown");
			const marker = [...entries.slice(0, i)].reverse().find(x => x.type === "custom_message" && x.customType === AGY_WAKE_MARKER), markerIndex = marker ? entries.indexOf(marker) : -1;
			if (!marker || !isString(d.markerEntryId) || d.markerEntryId !== marker.id || markerIndex <= anchorIndex || !digest(d.prefixHash) || d.prefixHash !== prefixes[i] || !isString(d.startedAt)) return mismatch();
			if (d.previousCompletionId !== (completion?.id ?? null)) return mismatch();
			if (entries.slice(windowStart, i).some(x => isChatMessage(x) && !refused.has(x.id))) return mismatch();
			intent = { entry: e, index: i, input: marker.id, wake: true };
			activity = 0;
		}
		else if (kind === AGY_ACP_COMPLETION) {
			const dd = intent?.entry.data;
			// A wake record carries no pair; its completion carries the one AGY held when the wake started.
			if (!intent || !tuple(d) || d.dispatchId !== intent.entry.id || (intent.wake ? !isString(d.model) || !(d.effort === null || isString(d.effort)) : d.model !== dd.model || d.effort !== dd.effort)) return mismatch();
			const messages = entries.slice(intent.index + 1, i).filter(x => isChatMessage(x) && !refused.has(x.id)); // pairs refused inside this turn are covered by their own records
			const a = messages[0];
			if (messages.length !== 1 || a?.message?.role !== "assistant" || !acpContent(a) || a.id !== d.assistantId || entryFingerprint(a) !== d.assistantFingerprint || d.prefixHash !== prefixes[i]) return mismatch();
			if (ACP_OUTCOME[d.outcome] === undefined || ACP_OUTCOME[d.outcome] !== a.message.stopReason) return mismatch();
			completion = e; intent = undefined; windowStart = i + 1; anchorIndex = i; refused.clear();
		}
		else {
			// A refusal: one user message and one error or aborted answer, nothing sent.
			// Outside a turn no dispatch may be open. Inside one, it is a message Tom typed while AGY worked: Pi queued it and sent it to the provider after the turn's answer and before
			// agent_end, so the pair sits right after that answer and the record names the open dispatch. Later pairs of the same turn wait for their own records; the completion needs all covered.
			if (!tuple(d) || d.conversationEntryId !== conversation.id || d.completionId !== (completion?.id ?? null) || d.prefixHash !== prefixes[i]) return mismatch();
			if (intent ? d.dispatchId !== intent.entry.id : d.dispatchId !== undefined) return mismatch();
			if (intent) {
				const inTurn = entries.slice(intent.index + 1, i).filter(x => isChatMessage(x) && !refused.has(x.id));
				if (inTurn.length < 3 || inTurn[0].message?.role !== "assistant" || !acpContent(inTurn[0]) || inTurn[1].id !== d.userId || inTurn[1].message?.role !== "user" || inTurn[2].id !== d.assistantId || inTurn[2].message?.role !== "assistant") return mismatch();
			}
			else tail(windowStart, i, d.userId, d.assistantId, true);
			const u = entries.find(x => x.id === d.userId), a = entries.find(x => x.id === d.assistantId);
			if (!(a.message.stopReason === "error" || a.message.stopReason === "aborted") || entryFingerprint(u) !== d.userFingerprint || entryFingerprint(a) !== d.assistantFingerprint) return mismatch();
			refused.add(u.id); refused.add(a.id);
		}
	}
	if (intent) throw new RecoveryError("unknown");
	// `wake` asks whether a wake turn may start now: no user message is being sent, and none may sit unanswered after the anchor.
	if (wake) { if (entries.slice(windowStart).some(x => isChatMessage(x) && !refused.has(x.id))) return mismatch(); }
	else tail(windowStart, entries.length, newUserId, undefined, refusing);
	// Another branch holding a later dispatch or completion of this ACP session means this branch is not the session's head.
	const anchorId = (completion ?? conversation).id, anchorFileIndex = saved.all.findIndex(e => e.id === anchorId), selected = new Set(entries.map(e => e.id));
	if (saved.all.slice(anchorFileIndex + 1).some(e => !selected.has(e.id) && /^rbf-agy-acp-(dispatch|completion)\//.test(e.customType ?? "") && e.data?.acpSessionId === c.acpSessionId)) return mismatch();
	return { conversation, completion, acpSessionId: c.acpSessionId, cwd: c.cwd, policyHash };
}
