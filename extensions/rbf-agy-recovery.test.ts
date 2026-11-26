import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, symlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readSavedSession, appendEvidence, RecoveryError } from "./lib/agy-recovery.js";

// The two things every AGY record depends on, whichever route wrote it: reading a Pi session file back from disk as raw bytes, and appending a record only when the bytes on disk show it. The ACP recovery
// chain that uses them is tested in lib/agy-acp-recovery.test.ts.
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
	return { cwd, file, entries, sm, pi, header, save, append, user, assistant };
}
const kind = (run: () => unknown): string | undefined => { try { run(); } catch (error) { return error instanceof RecoveryError ? error.kind : "other"; } return undefined; };

describe("saved session evidence", () => {
	it("reads back exactly the branch Pi holds, from the bytes on disk", () => {
		const h = fixture(); h.user("one"); h.assistant(); const u = h.user("two");
		const saved = readSavedSession(h.sm, h.cwd);
		expect(saved.branch.map(e => e.id)).toEqual(h.entries.map(e => e.id));
		expect(saved.all.at(-1).id).toBe(u.id);
		expect(saved.sessionId).toBe("session-one");
	});
	it.each(["malformed", "unterminated", "duplicate", "missing-parent", "cycle", "memory-only", "extra-field"])("refuses a %s session file", problem => {
		const h = fixture(); h.user(); h.assistant(); const u = h.user();
		if (problem === "malformed") appendFileSync(h.file, "broken\n");
		if (problem === "unterminated") writeFileSync(h.file, readFileSync(h.file, "utf8").trimEnd());
		if (problem === "duplicate") { h.entries.push({ ...u }); h.save(); }
		if (problem === "missing-parent") { u.parentId = "absent"; h.save(); }
		if (problem === "cycle") { u.parentId = u.id; h.save(); }
		if (problem === "memory-only") u.message.content[0].text = "memory changed";
		if (problem === "extra-field") u.hostOnlyField = "memory differs from disk";
		expect(kind(() => readSavedSession(h.sm, h.cwd))).toBe("mismatch");
	});
	it("refuses a symlink rather than following it", () => {
		const h = fixture(); const link = join(h.cwd, "link.jsonl"); symlinkSync(h.file, link); h.sm.getSessionFile = () => link;
		expect(kind(() => readSavedSession(h.sm, h.cwd))).toBe("mismatch");
	});
	it("refuses a non-regular session descriptor", () => {
		const h = fixture(); h.sm.getSessionFile = () => h.cwd;
		expect(kind(() => readSavedSession(h.sm, h.cwd))).toBe("mismatch");
	});
	it("appends a record and returns it only when the bytes on disk show exactly it", () => {
		const h = fixture(); h.user();
		const entry = appendEvidence(h.pi, h.sm, h.cwd, "test-record", { saved: true });
		expect(entry).toMatchObject({ type: "custom", customType: "test-record", data: { saved: true } });
		expect(readSavedSession(h.sm, h.cwd).branch.at(-1).id).toBe(entry.id);
	});
	it("never trusts an append that advanced only Pi memory", () => {
		const h = fixture(); h.user();
		h.pi.appendEntry = (customType, data) => { h.entries.push({ id: "memory", parentId: h.sm.getLeafId(), type: "custom", customType, data }); return h.entries.at(-1); };
		expect(kind(() => appendEvidence(h.pi, h.sm, h.cwd, "test-record", {}))).toBe("mismatch");
	});
	it("does not acknowledge an append when post-write sync fails, then freshly validates surviving bytes", () => {
		const h = fixture(); h.user(); fault.failAt = fault.sync + 2;
		try { expect(() => appendEvidence(h.pi, h.sm, h.cwd, "test-sync", { saved: true })).toThrow(); }
		finally { fault.failAt = 0; }
		expect(readSavedSession(h.sm, h.cwd).branch.at(-1).customType).toBe("test-sync");
	});
});
