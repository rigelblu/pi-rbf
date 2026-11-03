import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, symlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGY_DISPATCH, AGY_COMPLETION, AGY_REFUSAL, readSavedSession, appendEvidence, selectRecoveryCompletion, branchFingerprint, entryFingerprint } from "./lib/agy-recovery.js";

const fault = vi.hoisted(() => ({ sync: 0, failAt: 0 }));
vi.mock("node:fs", async original => {
	const actual = await original<typeof import("node:fs")>();
	return { ...actual, fsyncSync(fd: number) { fault.sync++; if (fault.failAt === fault.sync) throw new Error("injected sync acknowledgement failure"); actual.fsyncSync(fd); } };
});
function fixture() {
	const base = process.env.PI214_TEST_ROOT;
	if (!base) throw new Error("PI214_TEST_ROOT must be resolved by eng-use-external-tmp");
	mkdirSync(base, { recursive: true });
	const cwd = mkdtempSync(join(base, "evidence-")), file = join(cwd, "session.jsonl");
	const header = { type: "session", version: 3, id: "session-one", cwd, timestamp: new Date().toISOString() };
	const entries: any[] = [];
	const sm = { getSessionId: () => header.id, getSessionFile: () => file, getLeafId: () => entries.at(-1)?.id ?? null, getBranch: () => entries };
	const save = () => writeFileSync(file, [header, ...entries].map(x => JSON.stringify(x)).join("\n") + "\n");
	const append = (value: any) => { const entry = { id: `e${entries.length + 1}`, parentId: sm.getLeafId(), timestamp: new Date().toISOString(), ...value }; entries.push(entry); appendFileSync(file, JSON.stringify(entry) + "\n"); return entry; };
	const pi = { appendEntry: (customType: string, data: any) => append({ type: "custom", customType, data }) };
	const user = (text = "new text") => append({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } });
	const assistant = () => append({ type: "message", message: { role: "assistant", provider: "agy-harness", content: [{ type: "text", text: "saved answer" }], stopReason: "stop", timestamp: 2 } });
	save();
	const tuple = { sessionId: header.id, sessionFile: file, cwd, conversationId: "native-one", nativeModel: "gemini-3.8-flash-low", nativeEffort: "low", policyHash: null, permissionMode: "request-review" };
	const checkpoint = () => {
		const u = user();
		const d = appendEvidence(pi, sm, cwd, AGY_DISPATCH, { ...tuple, userId: u.id, userFingerprint: entryFingerprint(u), prefixHash: branchFingerprint(entries), previousCompletionId: null, acceptedCount: 0, frontier: -1 });
		const a = assistant();
		const c = appendEvidence(pi, sm, cwd, AGY_COMPLETION, { ...tuple, dispatchId: d.id, assistantId: a.id, assistantFingerprint: entryFingerprint(a), prefixHash: branchFingerprint(entries), acceptedCount: 1, frontier: 1 });
		return { u, d, a, c };
	};
	return { cwd, file, entries, sm, pi, header, save, append, user, assistant, tuple, checkpoint };
}

describe("saved clean-turn recovery evidence", () => {
	it("restores the exact tuple and cumulative native baseline from saved counterparts", () => {
		const h = fixture(); const { c } = h.checkpoint(); const u = h.user("only this text may be sent");
		const result = selectRecoveryCompletion(readSavedSession(h.sm, h.cwd), u.id);
		expect(result.entry.id).toBe(c.id);
		expect(result.data).toMatchObject({ ...h.tuple, acceptedCount: 1, frontier: 1 });
	});
	it.each(["malformed", "unterminated", "duplicate", "missing-parent", "cycle", "memory-only", "edited-answer", "extra-field", "copy"])("refuses %s evidence", kind => {
		const h = fixture(); const { a } = h.checkpoint(); const u = h.user();
		if (kind === "malformed") appendFileSync(h.file, "broken\n");
		if (kind === "unterminated") writeFileSync(h.file, readFileSync(h.file, "utf8").trimEnd());
		if (kind === "duplicate") { h.entries.push({ ...u }); h.save(); }
		if (kind === "missing-parent") { u.parentId = "absent"; h.save(); }
		if (kind === "cycle") { u.parentId = u.id; h.save(); }
		if (kind === "memory-only") u.message.content[0].text = "memory changed";
		if (kind === "edited-answer") { a.message.content[0].text = "edited"; h.save(); }
		if (kind === "extra-field") u.hostOnlyField = "memory differs from disk";
		if (kind === "copy") { const copy = join(h.cwd, "copy.jsonl"); writeFileSync(copy, readFileSync(h.file)); h.sm.getSessionFile = () => copy; }
		expect(() => selectRecoveryCompletion(readSavedSession(h.sm, h.cwd), u.id)).toThrow();
	});
	it("refuses a symlink rather than following it", () => {
		const h = fixture(); const link = join(h.cwd, "link.jsonl"); symlinkSync(h.file, link); h.sm.getSessionFile = () => link;
		expect(() => readSavedSession(h.sm, h.cwd)).toThrow();
	});
	it("never trusts an append that advanced only Pi memory", () => {
		const h = fixture(); h.user();
		h.pi.appendEntry = (customType, data) => { h.entries.push({ id: "memory", parentId: h.sm.getLeafId(), type: "custom", customType, data }); return h.entries.at(-1); };
		expect(() => appendEvidence(h.pi, h.sm, h.cwd, AGY_DISPATCH, {})).toThrow();
	});
	it("classifies a saved unmatched dispatch as unknown work", () => {
		const h = fixture(); const { c } = h.checkpoint(); const u = h.user();
		appendEvidence(h.pi, h.sm, h.cwd, AGY_DISPATCH, { ...h.tuple, userId: u.id, userFingerprint: entryFingerprint(u), prefixHash: branchFingerprint(h.entries), previousCompletionId: c.id, acceptedCount: 1, frontier: 1 });
		const next = h.user();
		expect(() => selectRecoveryCompletion(readSavedSession(h.sm, h.cwd), next.id)).toThrow(/unknown outcome/);
	});
	it("accepts only exact certified zero-write refusal pairs", () => {
		const h = fixture(); const { c } = h.checkpoint(); const u = h.user("unsupported setting"), a = h.assistant();
		appendEvidence(h.pi, h.sm, h.cwd, AGY_REFUSAL, { ...h.tuple, completionId: c.id, userId: u.id, userFingerprint: entryFingerprint(u), assistantId: a.id, assistantFingerprint: entryFingerprint(a), prefixHash: branchFingerprint(h.entries) });
		const next = h.user();
		expect(selectRecoveryCompletion(readSavedSession(h.sm, h.cwd), next.id).entry.id).toBe(c.id);
		a.message.content[0].text = "mutated refusal"; h.save();
		expect(() => selectRecoveryCompletion(readSavedSession(h.sm, h.cwd), next.id)).toThrow();
	});
	it.each([AGY_DISPATCH, "rbf-agy-dispatch/v2", "rbf-agy-completion/v2"])("refuses newer %s work on another saved branch", customType => {
		const h = fixture(); const { c } = h.checkpoint(); const u = h.user();
		const disk = readFileSync(h.file, "utf8");
		appendFileSync(h.file, JSON.stringify({ id: "other", parentId: c.id, type: "custom", customType, data: { ...h.tuple, acceptedCount: 1 } }) + "\n");
		expect(() => selectRecoveryCompletion(readSavedSession(h.sm, h.cwd), u.id)).toThrow();
		expect(readFileSync(h.file, "utf8").startsWith(disk)).toBe(true);
	});
	it("does not acknowledge an append when post-write sync fails, then freshly validates surviving bytes", () => {
		const h = fixture(); h.user(); fault.failAt = fault.sync + 2;
		try { expect(() => appendEvidence(h.pi, h.sm, h.cwd, "test-sync", { saved: true })).toThrow(); }
		finally { fault.failAt = 0; }
		expect(readSavedSession(h.sm, h.cwd).branch.at(-1).customType).toBe("test-sync");
	});
	it.each(["image-user", "tool-assistant", "old-user"])("refuses internally rehashed unsupported %s history", kind => {
		const h = fixture(); const { u, d, a, c } = h.checkpoint();
		if (kind === "image-user") u.message.content = [{ type: "image", data: "a", mimeType: "image/png" }];
		if (kind === "tool-assistant") a.message.content = [{ type: "toolCall", name: "unknown" }];
		if (kind === "old-user") { const extra = { ...u, id: "extra-user", parentId: u.id }; h.entries.splice(1, 0, extra); d.parentId = extra.id; }
		d.data.userFingerprint = entryFingerprint(u); d.data.prefixHash = branchFingerprint(h.entries.slice(0, h.entries.indexOf(d)));
		c.data.assistantFingerprint = entryFingerprint(a); c.data.prefixHash = branchFingerprint(h.entries.slice(0, h.entries.indexOf(c)));
		h.save(); const next = h.user(); expect(() => selectRecoveryCompletion(readSavedSession(h.sm, h.cwd), next.id)).toThrow();
	});
	it.each(["compaction", "branch_summary", "custom_message", "image-record"])("refuses context-changing %s after a completion", kind => {
		const h = fixture(); h.checkpoint();
		h.append(kind === "image-record" ? { type: "custom", customType: "rbf-agy-image/v1", data: {} } : { type: kind });
		const u = h.user(); expect(() => selectRecoveryCompletion(readSavedSession(h.sm, h.cwd), u.id)).toThrow();
	});
	it("permits passive model metadata without claiming a native transition", () => {
		const h = fixture(); h.checkpoint(); h.append({ type: "model_change", provider: "agy-harness", modelId: "gemini-3.8-flash" });
		const u = h.user(); expect(selectRecoveryCompletion(readSavedSession(h.sm, h.cwd), u.id).data.acceptedCount).toBe(1);
	});

	it("refuses a non-regular session descriptor", () => {
		const h = fixture(); h.sm.getSessionFile = () => h.cwd; expect(() => readSavedSession(h.sm, h.cwd)).toThrow();
	});

});
