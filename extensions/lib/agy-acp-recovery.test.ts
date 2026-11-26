// The ACP recovery chain over hand-built branches. No process starts; every record is built the way the provider writes it.
import { describe, expect, it } from "vitest";
import { AGY_ACP_ACTIVITY, AGY_ACP_COMPLETION, AGY_ACP_CONVERSATION, AGY_ACP_DISPATCH, AGY_ACP_PERMISSION, AGY_ACP_QUESTION, AGY_ACP_REFUSAL, AGY_ACP_WAKE, RecoveryError, entryFingerprint, historyFingerprint, selectAcpRecoveryAnchor, type SavedSession } from "./agy-recovery.js";

const SESSION = "pi-session-1", FILE = "/tmp/session.jsonl", CWD = "/tmp/work", ACP = "acp-session-1";

/** Builds one saved branch entry by entry. Each record's hashes and ids are computed from what is already in the branch. */
function chat() {
	const entries: any[] = [], extra: any[] = [];
	let n = 0, policy: string | null = null;
	const push = (body: object) => { const e: any = { id: String(++n).padStart(8, "0"), parentId: entries.at(-1)?.id ?? null, timestamp: "2026-11-09T12:00:00.000Z", ...body }; entries.push(e); return e; };
	const message = (role: string, text: string, extraFields: object = {}) => push({ type: "message", message: { role, content: [{ type: "text", text }], timestamp: n, ...(role === "assistant" ? { api: "rbf-agy", provider: "agy-harness", model: "gemini-3.8-flash", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" } : {}), ...extraFields } });
	const tupleOf = () => ({ sessionId: SESSION, sessionFile: FILE, cwd: CWD, acpSessionId: ACP, policyHash: policy });
	const custom = (customType: string, data: object) => push({ type: "custom", customType, data });
	const api = {
		entries, extra,
		setPolicy(hash: string | null) { policy = hash; },
		user: (text = "question") => message("user", text),
		assistant: (text = "answer", stopReason = "stop") => message("assistant", text, { stopReason }),
		assistantWithThinking: () => push({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "answer" }], provider: "agy-harness", stopReason: "stop", timestamp: n } }),
		conversation: (data: object = {}) => custom(AGY_ACP_CONVERSATION, { acpSessionId: ACP, cwd: CWD, piSessionId: SESSION, ...data }),
		dispatch(user: any, over: object = {}) { return custom(AGY_ACP_DISPATCH, { ...tupleOf(), model: "gemini-3.8-flash", effort: "high", userId: user.id, userFingerprint: entryFingerprint(user), prefixHash: historyFingerprint(entries), previousCompletionId: entries.filter(e => e.customType === AGY_ACP_COMPLETION).at(-1)?.id ?? null, ...over }); },
		/** The AGY wake marker Pi saves when it starts the turn (pi.sendMessage). A custom_message entry: passive in the chain. */
		marker: () => push({ type: "custom_message", customType: "rbf-agy-wake", content: "AGY continued on its own.", display: true }),
		/** The record Pi saves before a wake turn streams anything. It plays the dispatch's part. */
		wake(marker: any, over: object = {}) { return custom(AGY_ACP_WAKE, { piSessionId: SESSION, acpSessionId: ACP, markerEntryId: marker.id, previousCompletionId: entries.filter(e => e.customType === AGY_ACP_COMPLETION).at(-1)?.id ?? null, prefixHash: historyFingerprint(entries), startedAt: "2026-11-23T04:00:00.000Z", ...over }); },
		completion(dispatch: any, assistant: any, over: object = {}) { return custom(AGY_ACP_COMPLETION, { ...tupleOf(), model: dispatch.data.model ?? "gemini-3.8-flash", effort: dispatch.data.effort ?? "high", dispatchId: dispatch.id, assistantId: assistant.id, assistantFingerprint: entryFingerprint(assistant), prefixHash: historyFingerprint([...entries]), usage: {}, outcome: "stop", ...over }); },
		refusal(user: any, assistant: any, over: object = {}) { return custom(AGY_ACP_REFUSAL, { ...tupleOf(), conversationEntryId: entries.find(e => e.customType === AGY_ACP_CONVERSATION).id, completionId: entries.filter(e => e.customType === AGY_ACP_COMPLETION).at(-1)?.id ?? null, userId: user.id, userFingerprint: entryFingerprint(user), assistantId: assistant.id, assistantFingerprint: entryFingerprint(assistant), prefixHash: historyFingerprint([...entries]), ...over }); },
		record: (customType: string, data: object) => custom(customType, { acpSessionId: ACP, ...data }),
		pi: (type: string, body: object = {}) => push({ type, ...body }),
		foreign: (customType = "other-extension/state") => custom(customType, { n }),
		/** One finished turn: user, dispatch, answer, completion. */
		turn(text = "question") { const u = api.user(text), d = api.dispatch(u), a = api.assistant(), c = api.completion(d, a); return { u, d, a, c }; },
		saved(): SavedSession { return { all: [...entries, ...extra], branch: [...entries], sessionId: SESSION, sessionFile: FILE, cwd: CWD }; },
	};
	return api;
}
const failure = (run: () => unknown): string | undefined => { try { run(); } catch (error) { return error instanceof RecoveryError ? error.kind : "other"; } return undefined; };
/** A chat with one finished turn and nothing after it. */
function completedChat() { const c = chat(); c.user("first"); c.conversation(); const d = c.dispatch(c.entries[0]), a = c.assistant(), done = c.completion(d, a); return { c, d, a, done }; }
/** The same chat with a new user message waiting to be sent. */
function afterOneTurn() { const t = completedChat(); const next = t.c.user("second"); return { ...t, next }; }

describe("pi-21.3 ACP recovery chain: what it accepts", () => {
	it("finds no ACP chat when the branch holds no conversation record, including one that only has CLI-era activity records", () => {
		const c = chat(); c.user(); c.assistant(); const u = c.user("new");
		expect(selectAcpRecoveryAnchor(c.saved(), u.id)).toBeUndefined();
		c.pi("custom", { customType: "rbf-agy-activity/v1", data: {} });
		expect(selectAcpRecoveryAnchor(c.saved(), u.id)).toBeUndefined();
	});

	it("takes the conversation record as the anchor of a chat whose only message was refused, and resumes it", () => {
		const c = chat(), first = c.user("/goal x"); c.conversation(); const answer = c.assistant("refused", "error"); c.refusal(first, answer);
		const next = c.user("plain");
		const anchor = selectAcpRecoveryAnchor(c.saved(), next.id)!;
		expect(anchor.completion).toBeNull();
		expect(anchor.acpSessionId).toBe(ACP);
		expect(anchor.conversation.customType).toBe(AGY_ACP_CONVERSATION);
	});

	it("takes the conversation record as the anchor when no turn has run yet, with the first message saved before it", () => {
		const c = chat(); const u = c.user("first"); c.conversation();
		expect(selectAcpRecoveryAnchor(c.saved(), u.id)!.completion).toBeNull();
	});

	it("takes the latest completion as the anchor and returns the frozen settings identity", () => {
		const { c, done, next } = afterOneTurn();
		c.setPolicy(null);
		const anchor = selectAcpRecoveryAnchor(c.saved(), next.id)!;
		expect(anchor.completion.id).toBe(done.id);
		expect(anchor.policyHash).toBeNull();
	});

	it("follows two finished turns and accepts an assistant answer that carries thinking blocks", () => {
		const c = chat(), u1 = c.user("one"); c.conversation(); const d1 = c.dispatch(u1), a1 = c.assistantWithThinking(); c.completion(d1, a1);
		const t2 = c.turn("two"); const next = c.user("three");
		expect(selectAcpRecoveryAnchor(c.saved(), next.id)!.completion.id).toBe(t2.c.id);
	});

	it("accepts Pi's passive entries and other extensions' entries anywhere after the conversation record", () => {
		const c = chat(), u1 = c.user("one"); c.conversation(); c.foreign(); c.pi("model_change", { provider: "agy-harness", modelId: "claude-sonnet-5-5" }); const d1 = c.dispatch(u1);
		c.pi("thinking_level_change", { thinkingLevel: "low" }); c.foreign("rbf-cache-guardian/state"); const a1 = c.assistant(); c.pi("session_info", { name: "x" }); c.completion(d1, a1);
		c.pi("label", { targetId: a1.id, label: "keep" }); c.pi("model_change", { provider: "agy-harness", modelId: "gemini-3.8-flash" }); c.pi("thinking_level_change", { thinkingLevel: "high" }); c.foreign();
		const u2 = c.user("two"); c.pi("model_change", { provider: "agy-harness", modelId: "gemini-4-argon" }); c.foreign(); const d2 = c.dispatch(u2); c.pi("thinking_level_change", { thinkingLevel: "medium" });
		const a2 = c.assistant(); const c2 = c.completion(d2, a2); c.pi("model_change", { provider: "agy-harness", modelId: "claude-opus-5-5" }); c.foreign();
		const next = c.user("three");
		expect(selectAcpRecoveryAnchor(c.saved(), next.id)!.completion.id).toBe(c2.id);
	});

	it("accepts refused pairs between turns, each with its refusal record, whatever else sits around them", () => {
		const { c, done } = completedChat();
		const u = c.user("image"); const a = c.assistant("no images", "error"); c.pi("model_change", { provider: "agy-harness", modelId: "claude-opus-5-5" }); c.refusal(u, a);
		const u2 = c.user("/goal"); const a2 = c.assistant("no", "error"); c.refusal(u2, a2);
		const next = c.user("plain");
		expect(selectAcpRecoveryAnchor(c.saved(), next.id)!.completion.id).toBe(done.id);
	});

	it("accepts a refused pair whose assistant message has stopReason aborted (Esc during pre-send check), and refuses it without its refusal record", () => {
		const { c, done } = completedChat();
		const u = c.user("cancelled before send");
		const a = c.assistant("AGY request cancelled before input. Your message was not sent.", "aborted");
		c.refusal(u, a);
		const next = c.user("after esc");
		expect(selectAcpRecoveryAnchor(c.saved(), next.id)!.completion.id).toBe(done.id);

		const missing = completedChat();
		missing.c.user("cancelled before send");
		missing.c.assistant("AGY request cancelled before input. Your message was not sent.", "aborted");
		const n2 = missing.c.user("after esc");
		expect(failure(() => selectAcpRecoveryAnchor(missing.c.saved(), n2.id))).toBe("mismatch");
	});

	it("accepts a refused pair whose user message holds an image, because nothing was sent; the same message is no message to send", () => {
		const imageMessage = (c: ReturnType<typeof chat>) => c.pi("message", { message: { role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "what is this" }], timestamp: 1 } });
		const { c, done } = completedChat();
		const u = imageMessage(c), a = c.assistant("no images", "error"); c.refusal(u, a);
		const next = c.user("plain");
		expect(selectAcpRecoveryAnchor(c.saved(), next.id)!.completion.id).toBe(done.id);
		// An image as the message being sent is refused; as the message being refused it names the same anchor.
		const sending = completedChat(), image = imageMessage(sending.c);
		expect(failure(() => selectAcpRecoveryAnchor(sending.c.saved(), image.id))).toBe("mismatch");
		expect(selectAcpRecoveryAnchor(sending.c.saved(), image.id, true)!.completion.id).toBe(sending.done.id);
		// Asking for a refusal anchor does not loosen the rest: a stray message before it still fails.
		const stray = completedChat(); stray.c.user("an unanswered earlier message"); const last = imageMessage(stray.c);
		expect(failure(() => selectAcpRecoveryAnchor(stray.c.saved(), last.id, true))).toBe("mismatch");
	});

	it("accepts requests between turns and requests during a turn, and activity in order", () => {
		const c = chat(), u1 = c.user("one"); c.conversation(); c.record(AGY_ACP_PERMISSION, { inputEntryId: null }); c.record(AGY_ACP_QUESTION, { inputEntryId: null });
		const d1 = c.dispatch(u1);
		c.record(AGY_ACP_ACTIVITY, { inputEntryId: u1.id, sequence: 1 }); c.record(AGY_ACP_PERMISSION, { inputEntryId: u1.id }); c.record(AGY_ACP_ACTIVITY, { inputEntryId: u1.id, sequence: 2 });
		c.record(AGY_ACP_QUESTION, { inputEntryId: null });
		const a1 = c.assistant(); const done = c.completion(d1, a1); c.record(AGY_ACP_PERMISSION, { inputEntryId: null });
		const next = c.user("two");
		expect(selectAcpRecoveryAnchor(c.saved(), next.id)!.completion.id).toBe(done.id);
	});

	it.each([["stop", "stop"], ["cancelled", "aborted"], ["length", "length"], ["refusal", "error"]])("accepts a %s completion on a %s answer", (outcome, stopReason) => {
		const c = chat(), u = c.user("one"); c.conversation(); const d = c.dispatch(u), a = c.assistant("partial", stopReason); c.completion(d, a, { outcome });
		const next = c.user("two");
		expect(selectAcpRecoveryAnchor(c.saved(), next.id)).toBeDefined();
	});

	it("accepts a later dispatch or completion on another branch only when it sits before the anchor in the file", () => {
		const { c, next } = afterOneTurn();
		const other = { id: "zzzz0001", parentId: "00000001", type: "custom", customType: AGY_ACP_DISPATCH, data: { acpSessionId: "another-session" } };
		c.extra.push(other);
		expect(selectAcpRecoveryAnchor(c.saved(), next.id)).toBeDefined(); // same file, different ACP session
	});
});

describe("pi-21.3 ACP recovery chain: what it refuses", () => {
	it("calls a dispatch no completion closed unknown, and a second dispatch while one is open unknown", () => {
		const c = chat(), u = c.user("one"); c.conversation(); c.dispatch(u); const next = c.user("two");
		expect(failure(() => selectAcpRecoveryAnchor(c.saved(), next.id))).toBe("unknown");
		const again = chat(), u1 = again.user("one"); again.conversation(); again.dispatch(u1); again.dispatch(u1, { previousCompletionId: null });
		expect(failure(() => selectAcpRecoveryAnchor(again.saved(), "none"))).toBe("unknown");
	});

	it.each([
		["compaction", { type: "compaction", summary: "s", firstKeptEntryId: "x", tokensBefore: 1 }],
		["branch_summary", { type: "branch_summary", fromId: "x", summary: "s" }],
		["usage", { type: "usage", kind: "cache_warm", provider: "p", model: "m", usage: {} }],
		["context_edit", { type: "context_edit", targetId: "x", replacement: null }],
	])("refuses a Pi %s entry after the conversation record", (_name, body) => {
		const { c, next } = afterOneTurn();
		expect(failure(() => selectAcpRecoveryAnchor(c.saved(), next.id))).toBeUndefined();
		const fresh = afterOneTurn(); fresh.c.entries.splice(fresh.c.entries.indexOf(fresh.next), 0, { id: "ins00001", parentId: null, ...body });
		expect(failure(() => selectAcpRecoveryAnchor(fresh.c.saved(), fresh.next.id))).toBe("mismatch");
	});

	it.each([
		["a CLI conversation record", "rbf-agy-conversation/v1"],
		["a CLI dispatch", "rbf-agy-dispatch/v1"],
		["an AGY type the chain does not list", "rbf-agy-acp-surprise/v1"],
		["a CLI activity record", "rbf-agy-activity/v1"],
	])("refuses %s in an ACP chat", (_name, customType) => {
		const { c, next } = afterOneTurn(); c.entries.splice(c.entries.indexOf(next), 0, { id: "ins00001", parentId: null, type: "custom", customType, data: { acpSessionId: ACP } });
		expect(failure(() => selectAcpRecoveryAnchor(c.saved(), next.id))).toBe("mismatch");
	});

	it("refuses a second conversation record and a record of another ACP session, cwd or Pi session", () => {
		for (const mutate of [
			(c: ReturnType<typeof chat>) => c.conversation({ acpSessionId: "second" }),
			(c: ReturnType<typeof chat>) => c.record(AGY_ACP_PERMISSION, { acpSessionId: "other", inputEntryId: null }),
			(c: ReturnType<typeof chat>) => c.record(AGY_ACP_PERMISSION, { cwd: "/elsewhere", inputEntryId: null }),
			(c: ReturnType<typeof chat>) => c.record(AGY_ACP_PERMISSION, { piSessionId: "another-pi", inputEntryId: null }),
		]) {
			const { c, next } = afterOneTurn(); c.entries.splice(c.entries.indexOf(next), 0, { id: "ins00001", parentId: null, ...(() => { const probe = chat(); mutate(probe); return probe.entries[0]; })() });
			expect(failure(() => selectAcpRecoveryAnchor(c.saved(), next.id))).toBe("mismatch");
		}
	});

	it("refuses a conversation record from another folder or Pi session, and an ACP record with no conversation record", () => {
		const a = chat(), ua = a.user(); a.conversation({ cwd: "/elsewhere" });
		expect(failure(() => selectAcpRecoveryAnchor(a.saved(), ua.id))).toBe("mismatch");
		const b = chat(), ub = b.user(); b.conversation({ piSessionId: "other" });
		expect(failure(() => selectAcpRecoveryAnchor(b.saved(), ub.id))).toBe("mismatch");
		const d = chat(), ud = d.user(); d.record(AGY_ACP_PERMISSION, { inputEntryId: null });
		expect(failure(() => selectAcpRecoveryAnchor(d.saved(), ud.id))).toBe("mismatch");
	});

	it("refuses an answer edited after it was saved, and a user message edited after its dispatch", () => {
		const a = afterOneTurn(); a.a.message.content = [{ type: "text", text: "edited" }];
		expect(failure(() => selectAcpRecoveryAnchor(a.c.saved(), a.next.id))).toBe("mismatch");
		const b = afterOneTurn(); b.c.entries[0].message.content = [{ type: "text", text: "edited" }];
		expect(failure(() => selectAcpRecoveryAnchor(b.c.saved(), b.next.id))).toBe("mismatch");
	});

	it("refuses an extra message between the anchor and the new one, including an assistant answer", () => {
		const a = afterOneTurn(); a.c.entries.splice(a.c.entries.indexOf(a.next), 0, { id: "ins00001", parentId: null, type: "message", message: { role: "assistant", content: [{ type: "text", text: "stray" }], stopReason: "stop" } });
		expect(failure(() => selectAcpRecoveryAnchor(a.c.saved(), a.next.id))).toBe("mismatch");
		const b = afterOneTurn(); b.c.entries.splice(b.c.entries.indexOf(b.next), 0, { id: "ins00002", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "two users" }] } });
		expect(failure(() => selectAcpRecoveryAnchor(b.c.saved(), b.next.id))).toBe("mismatch");
	});

	it("refuses a refused pair whose refusal record is missing, or whose refusal names the wrong anchor, fingerprint or hash", () => {
		const missing = completedChat(); missing.c.user("image"); missing.c.assistant("no", "error"); const n1 = missing.c.user("next");
		expect(failure(() => selectAcpRecoveryAnchor(missing.c.saved(), n1.id))).toBe("mismatch");
		for (const over of [{ completionId: null }, { userFingerprint: "0".repeat(64) }, { assistantFingerprint: "1".repeat(64) }, { prefixHash: "2".repeat(64) }, { conversationEntryId: "elsewhere" }]) {
			const w = completedChat(), u = w.c.user("image"), a = w.c.assistant("no", "error"); w.c.refusal(u, a, over); const n = w.c.user("next");
			expect(failure(() => selectAcpRecoveryAnchor(w.c.saved(), n.id)), JSON.stringify(over)).toBe("mismatch");
		}
		const okAnswer = completedChat(), u = okAnswer.c.user("x"), a = okAnswer.c.assistant("not an error", "stop"); okAnswer.c.refusal(u, a); const n = okAnswer.c.user("next");
		expect(failure(() => selectAcpRecoveryAnchor(okAnswer.c.saved(), n.id))).toBe("mismatch");
	});

	it("refuses requests that name the wrong message, and activity outside a turn or out of order", () => {
		const a = afterOneTurn(); a.c.entries.splice(a.c.entries.indexOf(a.next), 0, { id: "ins00001", parentId: null, type: "custom", customType: AGY_ACP_PERMISSION, data: { acpSessionId: ACP, inputEntryId: "someone-else" } });
		expect(failure(() => selectAcpRecoveryAnchor(a.c.saved(), a.next.id))).toBe("mismatch");
		const b = afterOneTurn(); b.c.entries.splice(b.c.entries.indexOf(b.next), 0, { id: "ins00002", parentId: null, type: "custom", customType: AGY_ACP_ACTIVITY, data: { acpSessionId: ACP, inputEntryId: b.c.entries[0].id, sequence: 1 } });
		expect(failure(() => selectAcpRecoveryAnchor(b.c.saved(), b.next.id))).toBe("mismatch");
		const c = chat(), u = c.user("one"); c.conversation(); const d = c.dispatch(u); c.record(AGY_ACP_ACTIVITY, { inputEntryId: u.id, sequence: 2 }); c.record(AGY_ACP_ACTIVITY, { inputEntryId: u.id, sequence: 1 }); const as = c.assistant(); c.completion(d, as); const n = c.user("two");
		expect(failure(() => selectAcpRecoveryAnchor(c.saved(), n.id))).toBe("mismatch");
	});

	// Cold review F7: the brief says an activity sequence is strictly increasing from 1; the chain only required it to increase.
	it("refuses a turn whose first activity record does not have sequence 1, and takes sequences that start at 1 and skip", () => {
		const bad = chat(), u = bad.user("one"); bad.conversation(); const d = bad.dispatch(u); bad.record(AGY_ACP_ACTIVITY, { inputEntryId: u.id, sequence: 5 }); const a = bad.assistant(); bad.completion(d, a); const next = bad.user("two");
		expect(failure(() => selectAcpRecoveryAnchor(bad.saved(), next.id))).toBe("mismatch");
		const zero = chat(), z = zero.user("one"); zero.conversation(); const dz = zero.dispatch(z); zero.record(AGY_ACP_ACTIVITY, { inputEntryId: z.id, sequence: 0 }); const az = zero.assistant(); zero.completion(dz, az); const nz = zero.user("two");
		expect(failure(() => selectAcpRecoveryAnchor(zero.saved(), nz.id))).toBe("mismatch");
		const ok = chat(), o = ok.user("one"); ok.conversation(); const dok = ok.dispatch(o); ok.record(AGY_ACP_ACTIVITY, { inputEntryId: o.id, sequence: 1 }); ok.record(AGY_ACP_ACTIVITY, { inputEntryId: o.id, sequence: 4 }); const aok = ok.assistant(); const done = ok.completion(dok, aok);
		const t2 = ok.user("two"), d2 = ok.dispatch(t2); ok.record(AGY_ACP_ACTIVITY, { inputEntryId: t2.id, sequence: 1 }); const a2 = ok.assistant(); const done2 = ok.completion(d2, a2); const n2 = ok.user("three");
		expect(done.id).not.toBe(done2.id);
		expect(selectAcpRecoveryAnchor(ok.saved(), n2.id)!.completion.id).toBe(done2.id);
	});

	it("refuses a completion that names the wrong dispatch, answer, hash, tuple or outcome", () => {
		for (const over of [{ dispatchId: "zzz" }, { assistantId: "zzz" }, { assistantFingerprint: "0".repeat(64) }, { prefixHash: "1".repeat(64) }, { sessionId: "other" }, { sessionFile: "/other" }, { outcome: "cancelled" }, { outcome: "unknown" }, { model: "other" }]) {
			const c = chat(), u = c.user("one"); c.conversation(); const d = c.dispatch(u), a = c.assistant(); c.completion(d, a, over); const n = c.user("two");
			expect(failure(() => selectAcpRecoveryAnchor(c.saved(), n.id)), JSON.stringify(over)).toBe("mismatch");
		}
	});

	it("refuses a dispatch with a wrong hash, previous completion, user fingerprint or latest message", () => {
		for (const over of [{ prefixHash: "0".repeat(64) }, { previousCompletionId: "zzz" }, { userFingerprint: "1".repeat(64) }, { userId: "zzz" }, { effort: 5 }]) {
			const { c, next } = afterOneTurn(); c.entries.splice(c.entries.indexOf(next), 1);
			const u = c.user("second"); c.dispatch(u, over); const a = c.assistant(); void a;
			const n = c.user("third");
			expect(failure(() => selectAcpRecoveryAnchor(c.saved(), n.id)), JSON.stringify(over)).toBe("mismatch");
		}
	});

	it("refuses when the frozen settings identity changes between records", () => {
		const c = chat(), u = c.user("one"); c.conversation(); const d = c.dispatch(u), a = c.assistant(); c.completion(d, a); c.setPolicy("f".repeat(64));
		const t = c.turn("two"); void t; const n = c.user("three");
		expect(failure(() => selectAcpRecoveryAnchor(c.saved(), n.id))).toBe("mismatch");
	});

	it("refuses when another branch of the file holds a later dispatch or completion of this ACP session", () => {
		const { c, next } = afterOneTurn();
		c.extra.push({ id: "zzzz0001", parentId: c.entries[0].id, type: "custom", customType: AGY_ACP_COMPLETION, data: { acpSessionId: ACP } });
		expect(failure(() => selectAcpRecoveryAnchor(c.saved(), next.id))).toBe("mismatch");
	});

	it("reports the frozen settings hash of the chat, so a changed file can be refused", () => {
		const c = chat(), hash = "a".repeat(64); c.setPolicy(hash);
		const u = c.user("one"); c.conversation(); const d = c.dispatch(u), a = c.assistant(); c.completion(d, a); const n = c.user("two");
		expect(selectAcpRecoveryAnchor(c.saved(), n.id)!.policyHash).toBe(hash);
	});
});

// Pi 1.6.0 saves a role: "system" message entry, before the user's message, whenever the system prompt's sections change (tools, skills, context files,
// extension sections): pi-coding-agent agent-session.js persists the system message, pi-agent-core agent-loop.js declareToolChanges makes it. It is not a
// user or assistant message, so it is passive wherever it sits in the chain.
describe("pi-21.3 ACP recovery chain: Pi 1.6.0 system messages are passive", () => {
	const system = (c: ReturnType<typeof chat>, tag = "changed") => c.pi("message", { message: { role: "system", content: "", sections: { skills: tag }, toolsAdded: [{ name: tag }], timestamp: 1 } });

	it("resumes when a system message sits before the next user message (the system prompt changed since the last turn)", () => {
		const { c, done } = completedChat();
		system(c); const next = c.user("second");
		expect(selectAcpRecoveryAnchor(c.saved(), next.id)!.completion.id).toBe(done.id);
	});

	it("resumes after a system message sat before each of two user messages, and before the first one", () => {
		const c = chat(); system(c, "one"); const u1 = c.user("one"); c.conversation(); const d1 = c.dispatch(u1), a1 = c.assistant(); c.completion(d1, a1);
		system(c, "two"); const u2 = c.user("two"); const d2 = c.dispatch(u2), a2 = c.assistant(), c2 = c.completion(d2, a2);
		system(c, "three"); const next = c.user("three");
		expect(selectAcpRecoveryAnchor(c.saved(), next.id)!.completion.id).toBe(c2.id);
	});

	it("accepts a system message between the user message and its dispatch, between the dispatch and the answer, and between the answer and the completion", () => {
		const c = chat(), u = c.user("first"); c.conversation(); system(c, "a"); const d = c.dispatch(u); system(c, "b"); const a = c.assistant(); system(c, "c"); const done = c.completion(d, a);
		const next = c.user("second");
		expect(selectAcpRecoveryAnchor(c.saved(), next.id)!.completion.id).toBe(done.id);
	});

	it("accepts a system message inside a refused pair and before the message after it", () => {
		const { c } = completedChat();
		system(c, "a"); const refused = c.user("/goal x"); system(c, "b"); const answer = c.assistant("refused", "error"); c.refusal(refused, answer);
		system(c, "c"); const next = c.user("plain");
		expect(selectAcpRecoveryAnchor(c.saved(), next.id)!.completion).not.toBeNull();
	});

	it("still refuses a second user message, a second answer and a message that is not text, with system messages around them", () => {
		const a = afterOneTurn(); system(a.c); a.c.user("another");
		expect(failure(() => selectAcpRecoveryAnchor(a.c.saved(), a.next.id))).toBe("mismatch");
		const b = chat(), u = b.user("first"); b.conversation(); system(b); const d = b.dispatch(u); b.assistant(); system(b); b.assistant("again"); b.completion(d, b.entries.find(e => e.type === "message" && e.message.role === "assistant" && e.id !== b.entries.at(-1).id));
		const next = b.user("next");
		expect(failure(() => selectAcpRecoveryAnchor(b.saved(), next.id))).toBe("mismatch");
	});

	it("does not take a system message for the user message the dispatch names", () => {
		const c = chat(), u = c.user("first"); c.conversation(); const sys = system(c);
		expect(failure(() => c.dispatch(sys, {}) && selectAcpRecoveryAnchor(c.saved(), u.id))).toBe("mismatch");
	});
});

// Cold review F2: a message typed while AGY works is queued by Pi and sent to the provider after the turn's answer but before agent_end. The provider refuses it with nothing sent;
// Pi saves the user's message and the error answer inside the open turn, and the refusal record names the open dispatch.
describe("pi-21.3 ACP recovery chain: a refused pair inside an open turn", () => {
	/** user1, dispatch, answer, then `pairs` refused (user, error answer) pairs, each followed by its refusal record naming the dispatch, then the completion. */
	function openTurn(pairs = 1, over: (i: number) => object = () => ({})) {
		const c = chat(), u1 = c.user("first"); c.conversation(); const d = c.dispatch(u1), a = c.assistant();
		const refused = Array.from({ length: pairs }, (_, i) => ({ user: c.user(`typed while it works ${i + 1}`), error: c.assistant("AGY is busy.", "error") }));
		refused.forEach((r, i) => c.refusal(r.user, r.error, { dispatchId: d.id, ...over(i) }));
		return { c, u1, d, a, refused };
	}

	it("resumes after a turn that had one message refused inside it, and after a turn that had two", () => {
		for (const pairs of [1, 2]) {
			const t = openTurn(pairs), done = t.c.completion(t.d, t.a), next = t.c.user("after");
			expect(selectAcpRecoveryAnchor(t.c.saved(), next.id)!.completion.id).toBe(done.id);
		}
	});

	it("continues to accept a later turn and a normal refusal after such a turn", () => {
		const t = openTurn(1); t.c.completion(t.d, t.a);
		const t2 = t.c.turn("second"), bad = t.c.user("/goal x"), err = t.c.assistant("refused", "error"); t.c.refusal(bad, err);
		const next = t.c.user("third");
		expect(selectAcpRecoveryAnchor(t.c.saved(), next.id)!.completion.id).toBe(t2.c.id);
	});

	it("refuses a refused pair whose message the turn's completion did not leave covered, or whose record names no dispatch or another one", () => {
		const open = openTurn(1); // the refused pair has its record, but the turn never completes: unknown outcome
		expect(failure(() => selectAcpRecoveryAnchor(open.c.saved(), open.c.user("after").id))).toBe("unknown");
		const uncovered = openTurn(1); uncovered.c.user("one more"); uncovered.c.assistant("AGY is busy.", "error"); uncovered.c.completion(uncovered.d, uncovered.a);
		expect(failure(() => selectAcpRecoveryAnchor(uncovered.c.saved(), uncovered.c.user("after").id))).toBe("mismatch");
		const noDispatch = openTurn(1, () => ({ dispatchId: undefined })); noDispatch.c.completion(noDispatch.d, noDispatch.a);
		expect(failure(() => selectAcpRecoveryAnchor(noDispatch.c.saved(), noDispatch.c.user("after").id))).toBe("mismatch");
		const wrong = openTurn(1, () => ({ dispatchId: "zzz" })); wrong.c.completion(wrong.d, wrong.a);
		expect(failure(() => selectAcpRecoveryAnchor(wrong.c.saved(), wrong.c.user("after").id))).toBe("mismatch");
	});

	it("refuses a refusal that names a dispatch when no turn is open, and a refused pair that sits before the turn's answer", () => {
		const { c, d, a } = (() => { const t = openTurn(1); t.c.completion(t.d, t.a); return t; })();
		const closed = c.user("later"), err = c.assistant("AGY is busy.", "error"); c.refusal(closed, err, { dispatchId: d.id });
		expect(failure(() => selectAcpRecoveryAnchor(c.saved(), c.user("after").id))).toBe("mismatch");
		const early = chat(), u1 = early.user("first"); early.conversation(); const d2 = early.dispatch(u1);
		const pu = early.user("typed early"), pe = early.assistant("AGY is busy.", "error"), a2 = early.assistant();
		early.refusal(pu, pe, { dispatchId: d2.id }); early.completion(d2, a2);
		expect(failure(() => selectAcpRecoveryAnchor(early.saved(), early.user("after").id))).toBe("mismatch");
		expect(a.id).toBeTruthy();
	});

	it("refuses a refused pair that is not a user message and an error or aborted answer, or whose fingerprints do not match", () => {
		const t = openTurn(1, () => ({ userFingerprint: "0".repeat(64) })); t.c.completion(t.d, t.a);
		expect(failure(() => selectAcpRecoveryAnchor(t.c.saved(), t.c.user("after").id))).toBe("mismatch");
		const ok = chat(), u1 = ok.user("first"); ok.conversation(); const d = ok.dispatch(u1), a = ok.assistant();
		const pu = ok.user("typed"), stopAnswer = ok.assistant("not an error", "stop"); ok.refusal(pu, stopAnswer, { dispatchId: d.id }); ok.completion(d, a);
		expect(failure(() => selectAcpRecoveryAnchor(ok.saved(), ok.user("after").id))).toBe("mismatch");
	});
});

// Widened F1. The chain counts only user and assistant messages. Pi 1.6.0 docs/message-types.md lists the other roles (system, toolResult, bashExecution, custom, branchSummary,
// compactionSummary) and says an augmented host can add more. A `!` command saves a bashExecution message; pi.sendMessage saves a custom_message entry. None of them is the user's text
// or AGY's answer, and none is ever sent to AGY, so each is passive wherever it sits. Compaction and branch_summary entries are a different matter: they still refuse (see "what it refuses").
describe("pi-21.3 ACP recovery chain: only user and assistant messages count", () => {
	const bash = (c: ReturnType<typeof chat>, command = "ls") => c.pi("message", { message: { role: "bashExecution", command, output: "a.txt\n", exitCode: 0, cancelled: false, truncated: false, timestamp: 1, excludeFromContext: false } });
	const sent = (c: ReturnType<typeof chat>, tag = "note") => c.pi("custom_message", { customType: "other-extension", content: tag, display: true });
	const roleOnly = (c: ReturnType<typeof chat>, role: string) => c.pi("message", { message: { role, content: [{ type: "text", text: "x" }], customType: "other-extension", summary: "s", timestamp: 1 } });
	const passive: [string, (c: ReturnType<typeof chat>) => unknown][] = [
		["a bashExecution message (a `!` command)", c => bash(c)],
		["a custom_message entry (another extension's pi.sendMessage)", c => sent(c)],
		["the wake-gone line (rbf-agy-wake-gone, saved with no turn when a wake was dropped)", c => c.pi("custom_message", { customType: "rbf-agy-wake-gone", content: "AGY's work after its turn couldn't be shown in time, so Pi stopped AGY. The chat continues.", display: true })],
		["a message entry with role custom", c => roleOnly(c, "custom")],
		["a toolResult message", c => roleOnly(c, "toolResult")],
		["a branchSummary message", c => roleOnly(c, "branchSummary")],
		["a compactionSummary message", c => roleOnly(c, "compactionSummary")],
		["a message whose role only an extension knows", c => roleOnly(c, "zz-extension-role")],
	];

	it.each(passive)("resumes when %s sits between the last completion and the new user message", (_name, add) => {
		const { c, done } = completedChat();
		add(c); const next = c.user("second");
		expect(selectAcpRecoveryAnchor(c.saved(), next.id)!.completion.id).toBe(done.id);
	});

	it.each(passive)("accepts %s before the first message, between the user message and its dispatch, between the dispatch and the answer, and between the answer and the completion", (_name, add) => {
		const c = chat(); add(c); const u = c.user("first"); c.conversation(); add(c); const d = c.dispatch(u); add(c); const a = c.assistant(); add(c); const done = c.completion(d, a);
		add(c); const next = c.user("second");
		expect(selectAcpRecoveryAnchor(c.saved(), next.id)!.completion.id).toBe(done.id);
	});

	it.each(passive)("accepts %s inside a refused pair, and before and after it", (_name, add) => {
		const { c, done } = completedChat();
		add(c); const refused = c.user("/goal x"); add(c); const answer = c.assistant("refused", "error"); add(c); c.refusal(refused, answer);
		add(c); const next = c.user("plain");
		expect(selectAcpRecoveryAnchor(c.saved(), next.id)!.completion.id).toBe(done.id);
	});

	it("resumes after a `!` command ran before the chat's first turn and between two turns (the everyday case)", () => {
		const c = chat(); bash(c, "pwd"); const u1 = c.user("one"); c.conversation(); const d1 = c.dispatch(u1), a1 = c.assistant(); c.completion(d1, a1);
		bash(c, "git status"); sent(c); const t2 = c.turn("two"); bash(c, "ls");
		const next = c.user("three");
		expect(selectAcpRecoveryAnchor(c.saved(), next.id)!.completion.id).toBe(t2.c.id);
	});

	it.each(passive)("does not take %s for the user message a dispatch names, or for AGY's answer", (_name, add) => {
		const c = chat(), u = c.user("first"); c.conversation(); const other = add(c) as any;
		expect(failure(() => c.dispatch(other, {}) && selectAcpRecoveryAnchor(c.saved(), u.id))).toBe("mismatch");
		const d = chat(), u2 = d.user("first"); d.conversation(); const dd = d.dispatch(u2); const x = add(d) as any;
		expect(failure(() => d.completion(dd, x) && selectAcpRecoveryAnchor(d.saved(), d.user("next").id))).toBe("mismatch");
	});

	it.each(passive)("still refuses a second user message and a second answer with %s around them", (_name, add) => {
		const a = afterOneTurn(); add(a.c); a.c.user("another"); add(a.c);
		expect(failure(() => selectAcpRecoveryAnchor(a.c.saved(), a.next.id))).toBe("mismatch");
		const b = chat(), u = b.user("first"); b.conversation(); const d = b.dispatch(u); const first = b.assistant(); add(b); b.assistant("again"); b.completion(d, first);
		expect(failure(() => selectAcpRecoveryAnchor(b.saved(), b.user("next").id))).toBe("mismatch");
	});
});

// Decisions 2026-11-22: each AGY wake-up is its own turn. The marker (a custom_message, passive) starts it, `acp-wake` plays the dispatch's part, and the completion names the wake.
describe("pi-21.3 ACP recovery chain: wake turns", () => {
	/** What the chain says when a new user message follows everything so far: undefined for a resume, else its error kind. */
	const verdict = (c: ReturnType<typeof chat>) => { const next = c.user("next"); return failure(() => selectAcpRecoveryAnchor(c.saved(), next.id)); };
	const wakeTurn = (c: ReturnType<typeof chat>, text = "AGY's reply") => { const m = c.marker(), w = c.wake(m), a = c.assistant(text), done = c.completion(w, a); return { m, w, a, done }; };

	it("resumes after a wake turn that followed a completion, and takes the wake's completion as the anchor", () => {
		const { c } = completedChat();
		const { done } = wakeTurn(c); const next = c.user("second");
		expect(selectAcpRecoveryAnchor(c.saved(), next.id)!.completion.id).toBe(done.id);
	});

	it("takes a wake turn as the first turn after the conversation record, which is the anchor it names", () => {
		// The chat's only message was refused after session/new, so it has a conversation record and no completion; AGY then woke.
		const c = chat(), first = c.user("/goal x"); c.conversation(); const answer = c.assistant("refused", "error"); c.refusal(first, answer);
		const { done, w } = wakeTurn(c);
		expect(w.data.previousCompletionId).toBeNull();
		const next = c.user("second");
		expect(selectAcpRecoveryAnchor(c.saved(), next.id)!.completion.id).toBe(done.id);
	});

	it("follows two wake turns in a row, a wake between refused pairs, and then a normal turn whose dispatch names the last wake", () => {
		const { c } = completedChat();
		wakeTurn(c, "one"); const refused = c.user("/goal x"); const answer = c.assistant("no", "error"); c.refusal(refused, answer);
		const second = wakeTurn(c, "two");
		const u = c.user("normal"); const d = c.dispatch(u); const a = c.assistant(); c.completion(d, a);
		expect(d.data.previousCompletionId).toBe(second.done.id);
		const next = c.user("after");
		expect(selectAcpRecoveryAnchor(c.saved(), next.id)!.completion.id).toBe(c.entries.filter(e => e.customType === AGY_ACP_COMPLETION).at(-1).id);
	});

	it("accepts the wake's activity, permission and question records in any order, keyed by the marker's id, and refuses ones keyed by anything else", () => {
		const { c } = completedChat();
		const m = c.marker(), w = c.wake(m);
		c.record(AGY_ACP_ACTIVITY, { inputEntryId: m.id, sequence: 1 }); c.record(AGY_ACP_PERMISSION, { inputEntryId: m.id }); c.record(AGY_ACP_QUESTION, { inputEntryId: m.id }); c.record(AGY_ACP_ACTIVITY, { inputEntryId: m.id, sequence: 2 }); c.record(AGY_ACP_PERMISSION, { inputEntryId: null });
		const a = c.assistant(); const done = c.completion(w, a); const next = c.user("second");
		expect(selectAcpRecoveryAnchor(c.saved(), next.id)!.completion.id).toBe(done.id);
		for (const type of [AGY_ACP_ACTIVITY, AGY_ACP_PERMISSION, AGY_ACP_QUESTION]) {
			const bad = completedChat(); const bm = bad.c.marker(), bw = bad.c.wake(bm);
			bad.c.record(type, { inputEntryId: "some-user-message", sequence: 1 }); const ba = bad.c.assistant(); bad.c.completion(bw, ba);
			expect(verdict(bad.c)).toBe("mismatch");
		}
		const first = completedChat(); const fm = first.c.marker(); first.c.wake(fm); first.c.record(AGY_ACP_ACTIVITY, { inputEntryId: fm.id, sequence: 5 });
		expect(failure(() => selectAcpRecoveryAnchor(first.c.saved(), "x"))).toBe("mismatch");
	});

	it("calls a wake no completion closed unknown, whether it is last, a second one follows it, or a dispatch does", () => {
		const { c } = completedChat(); const m = c.marker(); c.wake(m); c.assistant("partial");
		const next = c.user("second");
		expect(failure(() => selectAcpRecoveryAnchor(c.saved(), next.id))).toBe("unknown");
		const two = completedChat(); const m1 = two.c.marker(); two.c.wake(m1); const m2 = two.c.marker(); two.c.wake(m2);
		expect(failure(() => selectAcpRecoveryAnchor(two.c.saved(), "x"))).toBe("unknown");
		const dis = completedChat(); const m3 = dis.c.marker(); dis.c.wake(m3); const u = dis.c.user("typed"); dis.c.dispatch(u);
		expect(failure(() => selectAcpRecoveryAnchor(dis.c.saved(), "x"))).toBe("unknown");
	});

	it("refuses a wake record that names the wrong marker, the wrong previous completion or the wrong prefix hash, or reuses a marker", () => {
		const bad = (make: (c: ReturnType<typeof chat>, m: any) => object) => {
			const { c } = completedChat(); const m = c.marker(); const w = c.wake(m, make(c, m)); const a = c.assistant(); c.completion(w, a);
			return verdict(c);
		};
		expect(bad(() => ({ markerEntryId: "not-a-marker" }))).toBe("mismatch");
		expect(bad(() => ({ markerEntryId: "00000001" }))).toBe("mismatch"); // the first user message, not a marker
		expect(bad(() => ({ previousCompletionId: null }))).toBe("mismatch");
		expect(bad(() => ({ previousCompletionId: "00000099" }))).toBe("mismatch");
		expect(bad(() => ({ prefixHash: "a".repeat(64) }))).toBe("mismatch");
		expect(bad(() => ({ acpSessionId: "another-session" }))).toBe("mismatch");
		const { c } = completedChat(); const first = wakeTurn(c); c.wake(first.m); // a second wake record on the first wake's marker
		expect(failure(() => selectAcpRecoveryAnchor(c.saved(), "x"))).toBe("mismatch");
	});

	it("refuses a wake whose answer is missing, doubled, not an assistant message, or whose outcome disagrees with its stop reason", () => {
		const one = (mutate: (c: ReturnType<typeof chat>, w: any) => any) => { const { c } = completedChat(); const m = c.marker(), w = c.wake(m); const done = mutate(c, w); void done; return verdict(c); };
		expect(one((c, w) => c.completion(w, c.entries.find(e => e.customType === AGY_ACP_COMPLETION)))).toBe("mismatch"); // no answer after the wake
		expect(one((c, w) => { const a = c.assistant(); c.assistant("again"); return c.completion(w, a); })).toBe("mismatch");
		expect(one((c, w) => { const a = c.assistant("hmm", "error"); return c.completion(w, a); })).toBe("mismatch"); // outcome "stop" on an error answer
		expect(one((c, w) => { const a = c.assistant("hmm", "aborted"); return c.completion(w, a, { outcome: "cancelled" }); })).toBeUndefined();
	});

	it("refuses an unrefused message inside the wake window or before the wake record", () => {
		const { c } = completedChat(); c.user("a message nothing answered"); const m = c.marker(), w = c.wake(m); const a = c.assistant(); c.completion(w, a);
		expect(verdict(c)).toBe("mismatch");
		const inside = completedChat(); const m2 = inside.c.marker(), w2 = inside.c.wake(m2); inside.c.user("typed and not refused"); const a2 = inside.c.assistant(); inside.c.completion(w2, a2);
		expect(verdict(inside.c)).toBe("mismatch");
	});

	it("accepts a message Tom typed during the wake: its refused pair after the wake's answer, covered by a refusal that names the wake", () => {
		const { c } = completedChat(); const m = c.marker(), w = c.wake(m); const a = c.assistant("AGY's reply");
		const typed = c.user("typed during the wake"), busy = c.assistant("AGY is busy.", "error");
		c.refusal(typed, busy, { dispatchId: w.id }); c.completion(w, a);
		const next = c.user("second");
		expect(selectAcpRecoveryAnchor(c.saved(), next.id)).toBeTruthy();
		const wrong = completedChat(); const m2 = wrong.c.marker(), w2 = wrong.c.wake(m2); const a2 = wrong.c.assistant(); const u2 = wrong.c.user("typed"), b2 = wrong.c.assistant("AGY is busy.", "error");
		wrong.c.refusal(u2, b2, { dispatchId: "00000099" }); wrong.c.completion(w2, a2);
		expect(verdict(wrong.c)).toBe("mismatch");
	});

	it("answers the question a wake asks before it starts: no new user message, the anchor it would sit on, and nothing unanswered before it", () => {
		const { c, done } = completedChat(); c.marker();
		expect(selectAcpRecoveryAnchor(c.saved(), "none", false, true)!.completion.id).toBe(done.id);
		const open = completedChat(); open.c.user("typed, nothing answered it");
		expect(failure(() => selectAcpRecoveryAnchor(open.c.saved(), "none", false, true))).toBe("mismatch");
		const unfinished = completedChat(); const m = unfinished.c.marker(); unfinished.c.wake(m);
		expect(failure(() => selectAcpRecoveryAnchor(unfinished.c.saved(), "none", false, true))).toBe("unknown");
		const refused = completedChat(); const u = refused.c.user("/goal x"), a = refused.c.assistant("no", "error"); refused.c.refusal(u, a); refused.c.marker();
		expect(selectAcpRecoveryAnchor(refused.c.saved(), "none", false, true)!.completion.id).toBe(refused.done.id);
	});

	it("keeps a marker with no wake record passive: the turn never streamed, so resume is safe", () => {
		const { c, done } = completedChat(); c.marker(); const next = c.user("second");
		expect(selectAcpRecoveryAnchor(c.saved(), next.id)!.completion.id).toBe(done.id);
	});

	it("refuses a newer wake or completion for this session on another branch, as for a dispatch", () => {
		const { c } = completedChat(); const m = c.marker(), w = c.wake(m); const a = c.assistant(); const done = c.completion(w, a);
		const next = c.user("second");
		c.extra.push({ id: "other001", parentId: done.id, type: "custom", customType: AGY_ACP_COMPLETION, data: { acpSessionId: ACP } });
		expect(failure(() => selectAcpRecoveryAnchor(c.saved(), next.id))).toBe("mismatch");
	});
});
