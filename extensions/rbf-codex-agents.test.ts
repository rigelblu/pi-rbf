import { describe, it, expect } from "vitest";
import { CodexAgentRoster, AGENTS_MAX_BYTES } from "./rbf-codex.ts";

const time = () => Date.parse("2026-10-20T14:00:00.000Z");
function setup() { const a = new CodexAgentRoster(time); a.begin("root"); a.setTurn("root-turn"); return a; }
let eventId = 0;
function collab(a: CodexAgentRoster, ids: string[], states: Record<string, string> = {}, tool = "wait", prompt?: string, status = "completed") {
	return a.observe("item/completed", {threadId:"root",turnId:"root-turn",item:{id:`call-${++eventId}`,type:"collabAgentToolCall",tool,status,prompt,receiverThreadIds:ids,agentsStates:Object.fromEntries(Object.entries(states).map(([id,status])=>[id,{status}]))}});
}
function announce(a: CodexAgentRoster, id: string, kind = "started", name = "Reviewer") { return a.observe("item/started", {threadId:"root",turnId:"root-turn",item:{id:`announce-${++eventId}`,type:"subAgentActivity",kind,agentThreadId:id,agentPath:name ? "/root/"+name : ""}}); }

describe("Codex agent overview", () => {
	it("full overview retains every assignment beyond four without changing saved order", () => {
		const a=setup();for(let i=0;i<4;i++)collab(a,["done-"+i],{["done-"+i]:"completed"},"spawnAgent","Finished task");collab(a,["active"],{active:"running"},"spawnAgent","LIVE TASK");const view=a.full(120).join("\n");expect(view).toContain("LIVE TASK");for(let i=0;i<4;i++)expect(view).toContain("done-"+i);expect(a.snapshot().agents[0].threadId).toBe("done-0");
	});
	it("duplicate item replay cannot regress a later completed status or assignment", () => {
		const a=setup();const original={threadId:"root",turnId:"root-turn",item:{id:"original",type:"subAgentActivity",kind:"started",agentThreadId:"a",agentPath:"/root/Reviewer"}};
		a.observe("item/started",original);announce(a,"a","completed");expect(a.observe("item/started",original)).toBe(false);expect(a.agents[0].status).toBe("completed");
		const task={threadId:"root",turnId:"root-turn",item:{id:"spawn",type:"collabAgentToolCall",tool:"spawnAgent",status:"completed",prompt:"Original task",receiverThreadIds:["a"],agentsStates:{a:{status:"running"}}}};
		a.observe("item/completed",task);collab(a,["a"],{a:"completed"},"followupTask","New task");expect(a.observe("item/completed",task)).toBe(false);expect(a.agents[0]).toMatchObject({task:"New task",status:"completed"});
	});
	it("assignment/status semantics: messages, call status and duplicate facts supply no invented state", () => {
		const a=setup(); collab(a,["a"],{},"spawnAgent","Check cancellation");
		expect(a.agents[0]).toMatchObject({task:"Check cancellation",status:"unknown"});
		collab(a,["a"],{},"sendMessage","Ignore prior assignment"); expect(a.agents[0].task).toBe("Check cancellation");
		collab(a,["a"],{},"sendInput","New input"); expect(a.agents[0].task).toBe("Check cancellation");
		collab(a,["a"],{},"followupTask","Failed assignment","failed"); expect(a.agents[0].task).toBe("Check cancellation");
		collab(a,["a"],{a:"running"},"followupTask","Verify reopening"); expect(a.agents[0]).toMatchObject({task:"Verify reopening",status:"running"});
		expect(collab(a,["a"],{a:"running"},"followupTask","Verify reopening")).toBe(false);
	});
	it("early child start replacement is retired across announcements and root turns", () => {
		const a=setup();a.observe("turn/started",{threadId:"child",turn:{id:"early-one"}});a.observe("turn/started",{threadId:"child",turn:{id:"early-two"}});announce(a,"child");expect(a.observe("turn/started",{threadId:"child",turn:{id:"early-one"}})).toBe(false);expect(a.observe("turn/completed",{threadId:"child",turn:{id:"early-one",status:"completed"}})).toBe(false);expect(a.agents[0].status).toBe("running");
		a.finish();a.begin("root");a.setTurn("new-turn");expect(a.observe("turn/started",{threadId:"child",turn:{id:"early-two"}})).toBe(false);
	});
	it("finite turn observation budget remains visible with no agent rows", () => {
		const a=setup();for(let i=0;i<4098;i++){a.finish();a.begin("root");a.setTurn("turn-"+i);}expect(a.partial).toBe(true);expect(a.agents).toHaveLength(0);expect(a.full(120).join("\n")).toContain("Partial overview");
	});
	it("late old root start during new request gap cannot establish a fresh root turn", () => {
		const a=setup();a.finish();a.begin("root");expect(a.observe("turn/started",{threadId:"root",turn:{id:"root-turn"}})).toBe(false);expect(announce(a,"old-only")).toBe(false);a.setTurn("new-turn");expect(a.agents).toHaveLength(0);
	});
	it("freshness is per agent and metadata/interaction cannot freshen a restored status", () => {
		const a=setup(); announce(a,"a"); announce(a,"b"); const saved=a.snapshot(); const b=setup(); b.restore("root",saved); expect(b.isFresh("a")).toBe(false);
		b.begin("root"); b.setTurn("root-turn"); announce(b,"a","interacted"); expect(b.isFresh("a")).toBe(false);
		collab(b,["a"],{a:"running"}); expect(b.isFresh("a")).toBe(true); expect(b.isFresh("b")).toBe(false);
		b.observe("thread/started",{thread:{id:"a",agentNickname:"New name"}}); expect(b.agents[0].name).toBe("New name"); expect(b.isFresh("b")).toBe(false);
		expect(b.full(120).join("\n")).toContain("Last recorded: Running"); b.begin("root");expect(b.isFresh("a")).toBe(false);
	});
	it("old child/root turn completions cannot settle a re-driven child; turn complete is not assignment completed", () => {
		const a=setup(); announce(a,"a"); a.observe("turn/started",{threadId:"a",turn:{id:"one"}}); a.observe("turn/started",{threadId:"a",turn:{id:"two"}});
		expect(a.observe("turn/started",{threadId:"a",turn:{id:"one"}})).toBe(false);
		expect(a.observe("turn/completed",{threadId:"a",turn:{id:"one",status:"completed"}})).toBe(false);expect(a.agents[0].status).toBe("running");
		a.observe("turn/completed",{threadId:"a",turn:{id:"two",status:"completed"}}); expect(a.agents[0].status).toBe("turnComplete");
		a.begin("root");a.setTurn("new-root-turn");expect(announce(a,"b")).toBe(false);expect(a.agents).toHaveLength(1);expect(a.isFresh("a")).toBe(false);
	});
	it("nested announcements require an announced parent and its exact current turn", () => {
		const a=setup(); const p={threadId:"internal",turnId:"x",item:{id:"nested",type:"subAgentActivity",kind:"started",agentThreadId:"grandchild",agentPath:"/root/G"}};
		expect(a.observe("item/started",p)).toBe(false);expect(a.agents).toHaveLength(0);
		announce(a,"parent");a.observe("turn/started",{threadId:"parent",turn:{id:"p-turn"}});a.observe("item/started",{...p,threadId:"parent",turnId:"p-turn"}); expect(a.agents[1]).toMatchObject({threadId:"grandchild",parentThreadId:"parent"});
	});
	it("snapshot branch binding, incompatible/malformed newest input and deep-copy isolation", () => {
		const a=setup();announce(a,"a");const saved=a.snapshot();saved.agents[0]!.name="mutant";expect(a.agents[0].name).toBe("Reviewer");
		const b=setup();b.restore("different",saved);expect(b.agents).toHaveLength(0);b.restore("root",{...saved,version:2});expect(b.unavailable).toBe(true);expect(b.agents).toHaveLength(0);
		b.restore("root",{...saved,agents:[{...saved.agents[0],status:"invented"}]});expect(b.unavailable).toBe(true);
		b.restore("root",saved);expect(b.agents).toHaveLength(1);expect(b.isFresh("a")).toBe(false);b.begin("different");expect(b.agents).toHaveLength(0);
	});
	it("bounds apply symmetrically in UTF-8 bytes; multibyte snapshot round-trips with explicit partial", () => {
		const a=setup();for(let i=0;i<129;i++)collab(a,[`agent-${i}`],{},"spawnAgent","漢".repeat(1024));
		const saved=a.snapshot();expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThanOrEqual(AGENTS_MAX_BYTES);expect(saved.partial).toBe(true);expect(saved.agents.length).toBeLessThan(128);
		const b=setup();b.restore("root",saved);expect(b.unavailable).toBe(false);expect(b.agents).toEqual(saved.agents);expect(b.partial).toBe(true);
		b.restore("root",{...saved,extra:"x".repeat(AGENTS_MAX_BYTES)});expect(b.unavailable).toBe(true);
	});
	it("untrusted text is inert, IDs stay distinct, full tasks wrap at display-cell widths", () => {
		const a=setup();announce(a,"abcdefgh-1","started","\x1b[31mReviewer\x1b[0m\x07");announce(a,"abcdefgh-2","started","");
		collab(a,["abcdefgh-1"],{},"spawnAgent","Task\n\x1b]0;TITLE\x07"+"漢".repeat(80));
		expect(JSON.stringify(a.snapshot())).not.toMatch(/\\u001b|\\u0007/);expect(a.agents[0].name).toBe("Reviewer");expect(a.agents[0].task).not.toContain("TITLE");
		expect(a.full(20).join("\n")).toContain("Observed");expect(a.full(120).join("\n")).toContain("Agent abcdefgh");
		expect(announce(a,"bad\nid")).toBe(false);expect(a.agents).toHaveLength(2);
	});
});
