// Offline: every child here is this Node binary running a few lines of script. Nothing reaches AGY.
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { startWireLog } from "../test-support/agy-wire-log-env.js";
import { AcpClient, AcpLostError, AcpOversizeRequestError, AcpReply, AcpRpcError, type AcpClientOptions, type AcpHandlers, type RpcId } from "./agy-acp.js";

const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => { for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch { } } });

/** `script` runs in a child that can call send(obj) or raw(text) and sees every line it receives as `lines`. */
function connect(script: string, handlers: AcpHandlers = {}, options: AcpClientOptions = {}) {
	const prelude = `const send=o=>process.stdout.write(JSON.stringify(o)+"\\n"),raw=t=>process.stdout.write(t);const lines=[];let buf="";process.stdin.on("data",d=>{buf+=d;let i;while((i=buf.indexOf("\\n"))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);lines.push(l);onLine(JSON.parse(l));}});let onLine=()=>{};`;
	const child = spawn(process.execPath, ["-e", prelude + script], { stdio: ["pipe", "pipe", "pipe"] });
	children.push(child);
	const lost: AcpLostError[] = [];
	const client = new AcpClient(child, { ...handlers, lost: error => { lost.push(error); handlers.lost?.(error); } }, options);
	return { child, client, lost };
}
const until = async (check: () => boolean, ms = 4000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out in test"); await new Promise(r => setTimeout(r, 5)); } };

describe("pi-21.3 ACP client: framing", () => {
	it("correlates a result and keeps falsy results", async () => {
		const { client } = connect(`onLine=m=>send({jsonrpc:"2.0",id:m.id,result:m.method==="zero"?0:m.method==="no"?false:null});`);
		expect(await client.request("zero", {})).toBe(0);
		expect(await client.request("no", {})).toBe(false);
		expect(await client.request("nothing", {})).toBeNull();
	});

	it("correlates concurrent out-of-order responses", async () => {
		const { client } = connect(`const held=[];onLine=m=>{held.push(m);if(held.length===2){for(const x of held.reverse())send({jsonrpc:"2.0",id:x.id,result:x.params.n});}};`);
		const [a, b] = await Promise.all([client.request("n", { n: 1 }), client.request("n", { n: 2 })]);
		expect([a, b]).toEqual([1, 2]);
	});

	it("reads frames split across chunks, including a split multi-byte character, and CRLF rows", async () => {
		const { client } = connect(`onLine=m=>{const out=Buffer.from(JSON.stringify({jsonrpc:"2.0",id:m.id,result:"é✓"})+"\\r\\n");const cut=out.indexOf(0xc3)+1;process.stdout.write(out.subarray(0,cut));setTimeout(()=>process.stdout.write(out.subarray(cut)),20);};`);
		expect(await client.request("x", {})).toBe("é✓");
	});

	it("reads several frames delivered in one chunk and does not split on Unicode line separators", async () => {
		const notes: string[] = [];
		const { client } = connect(`onLine=m=>{raw(JSON.stringify({jsonrpc:"2.0",method:"n",params:{t:"a\\u2028b"}})+"\\n"+JSON.stringify({jsonrpc:"2.0",method:"n",params:{t:"c"}})+"\\n"+JSON.stringify({jsonrpc:"2.0",id:m.id,result:1})+"\\n");};`, { notification: (_m, p) => notes.push(p.t) });
		await client.request("x", {});
		expect(notes).toEqual(["a b", "c"]);
	});

	it("passes a frame carrying a 600 KB output twice, under the 2 MiB cap", async () => {
		const { client, lost } = connect(`onLine=m=>{const out="x".repeat(600000);send({jsonrpc:"2.0",id:m.id,result:{rawOutput:{output:out},content:[{type:"content",content:{type:"text",text:out}}]}});};`);
		const result = await client.request("big", {});
		expect(result.rawOutput.output.length).toBe(600000);
		expect(result.content[0].content.text.length).toBe(600000);
		expect(lost).toEqual([]);
	});

	it("ends the connection as lost for a frame just over the 2 MiB cap, and rejects what was waiting", async () => {
		const cap = 2 * 1024 * 1024; // pinned literal: the cap is a decision, not something to derive
		const { client, lost } = connect(`onLine=m=>{const head='{"jsonrpc":"2.0","id":'+m.id+',"result":"';const tail='"}';const pad=${cap}-Buffer.byteLength(head+tail)+1;raw(head+"y".repeat(pad)+tail+"\\n");};`);
		await expect(client.request("big", {})).rejects.toBeInstanceOf(AcpLostError);
		expect(lost).toHaveLength(1);
		expect(lost[0]!.reason).toBe("frame too large");
		await expect(client.request("later", {})).rejects.toBeInstanceOf(AcpLostError);
	});

	it("accepts a frame of exactly the cap", async () => {
		const cap = 2 * 1024 * 1024; // pinned literal: the cap is a decision, not something to derive
		const { client, lost } = connect(`onLine=m=>{const head='{"jsonrpc":"2.0","id":'+m.id+',"result":"';const tail='"}';const pad=${cap}-Buffer.byteLength(head+tail);raw(head+"y".repeat(pad)+tail+"\\n");};`);
		expect((await client.request("big", {})).length).toBeGreaterThan(cap - 100);
		expect(lost).toEqual([]);
	});

	it("ends the connection for an unterminated stream above the cap", async () => {
		const { client, lost } = connect(`onLine=()=>{raw("z".repeat(${2 * 1024 * 1024}+10));};`);
		await expect(client.request("x", {})).rejects.toBeInstanceOf(AcpLostError);
		expect(lost[0]!.reason).toBe("frame too large");
	});

	it.each([
		["invalid JSON", `raw("{nope\\n")`],
		["invalid UTF-8", `process.stdout.write(Buffer.from([0x7b,0xff,0x7d,0x0a]))`],
		["a JSON array", `raw("[]\\n")`],
		["a scalar", `raw("7\\n")`],
		["a frame without jsonrpc", `raw('{"id":1,"result":1}\\n')`],
		["a frame with a method and a result", `raw('{"jsonrpc":"2.0","id":1,"method":"m","result":1}\\n')`],
		["a response with a result and an error", `raw('{"jsonrpc":"2.0","id":1,"result":1,"error":{"code":1}}\\n')`],
		["a frame with neither method nor id", `raw('{"jsonrpc":"2.0","result":1}\\n')`],
		["a fractional id", `raw('{"jsonrpc":"2.0","id":1.5,"method":"m"}\\n')`],
		["a null id", `raw('{"jsonrpc":"2.0","id":null,"method":"m"}\\n')`],
		["scalar params", `raw('{"jsonrpc":"2.0","method":"m","params":5}\\n')`],
	])("ends the connection for %s", async (_name, emit) => {
		const { client, lost } = connect(`onLine=()=>{${emit}};`);
		await expect(client.request("x", {})).rejects.toBeInstanceOf(AcpLostError);
		expect(lost[0]!.reason).toBe("invalid frame");
	});

	it("ends the connection for a response to a request Pi never sent, and for a repeated response", async () => {
		const unknown = connect(`onLine=()=>{send({jsonrpc:"2.0",id:99,result:1});};`);
		await expect(unknown.client.request("x", {})).rejects.toBeInstanceOf(AcpLostError);
		expect(unknown.lost[0]!.reason).toBe("response to an unknown request");
		const repeat = connect(`onLine=m=>{send({jsonrpc:"2.0",id:m.id,result:1});send({jsonrpc:"2.0",id:m.id,result:2});};`);
		await expect(repeat.client.request("x", {})).resolves.toBe(1);
		await until(() => repeat.lost.length === 1);
		expect(repeat.lost[0]!.reason).toBe("response to an unknown request");
	});

	it("types an error response, preserves wireMessage separately, and keeps AGY's message out of Error.message", async () => {
		const { client } = connect(`onLine=m=>send({jsonrpc:"2.0",id:m.id,error:{code:-32000,message:"secret account text"}});`);
		const error = await client.request("x", {}).catch(e => e);
		expect(error).toBeInstanceOf(AcpRpcError);
		expect(error.code).toBe(-32000);
		expect(error.wireMessage).toBe("secret account text");
		expect(String(error.message)).not.toContain("secret");
	});

	it("leaves wireMessage undefined when AGY sends no string error message", async () => {
		const { client } = connect(`onLine=m=>send({jsonrpc:"2.0",id:m.id,error:{code:-32000,message:42}});`);
		const error = await client.request("x", {}).catch(e => e);
		expect(error).toBeInstanceOf(AcpRpcError);
		expect(error.wireMessage).toBeUndefined();
	});
});

describe("pi-21.3 ACP client: AGY's requests", () => {
	const ask = (id: RpcId, method = "fs/read_text_file") => `send({jsonrpc:"2.0",id:${JSON.stringify(id)},method:${JSON.stringify(method)},params:{path:"/etc/passwd"}});`;

	it("replies -32601 on the original id for fs/* and unknown methods when no handler is set", async () => {
		const replies: any[] = [];
		const { client } = connect(`onLine=m=>{if(m.method==="start"){send({jsonrpc:"2.0",id:"a",method:"fs/read_text_file",params:{}});send({jsonrpc:"2.0",id:0,method:"terminal/create",params:{}});send({jsonrpc:"2.0",id:5,method:"made/up"});return;}if(m.id===undefined||m.result!==undefined||m.error!==undefined){send({jsonrpc:"2.0",method:"seen",params:m});}};`, { notification: (method, params) => { if (method === "seen") replies.push(params); } });
		client.notify("start", {});
		await until(() => replies.length === 3);
		expect(replies.map(r => [r.id, r.error?.code]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([[0, -32601], [5, -32601], ["a", -32601]]);
	});

	it("serves a handler result and a typed error (with optional wireMessage), and a thrown Error becomes -32603 without its text", async () => {
		const replies: any[] = [];
		const { client } = connect(`onLine=m=>{if(m.method==="start"){send({jsonrpc:"2.0",id:1,method:"ok",params:{}});send({jsonrpc:"2.0",id:2,method:"typed",params:{}});send({jsonrpc:"2.0",id:3,method:"boom",params:{}});send({jsonrpc:"2.0",id:4,method:"question",params:{}});return;}send({jsonrpc:"2.0",method:"seen",params:m});};`, {
			notification: (method, params) => { if (method === "seen") replies.push(params); },
			request: (method) => {
				if (method === "ok") return { fine: true };
				if (method === "typed") throw new AcpRpcError(-32001);
				if (method === "question") throw new AcpRpcError(-32603, "Pi could not show the question");
				throw new Error("private path /Users/x");
			},
		});
		client.notify("start", {});
		await until(() => replies.length === 4);
		const byId = Object.fromEntries(replies.map(r => [r.id, r]));
		expect(byId[1].result).toEqual({ fine: true });
		expect(byId[2].error).toEqual({ code: -32001, message: "Request refused" });
		expect(byId[3].error).toEqual({ code: -32603, message: "Internal error" });
		expect(byId[4].error).toEqual({ code: -32603, message: "Pi could not show the question" });
		expect(JSON.stringify(replies)).not.toContain("/Users/x");
	});

	// Cold review F4: a record of Pi's reply (a permission answer) must be written only once the reply was handed to the link.
	it("tells the handler its reply was written, after the bytes went to the link", async () => {
		const replies: any[] = [], delivered: boolean[] = [];
		const { client } = connect(`onLine=m=>{if(m.method==="start")send({jsonrpc:"2.0",id:1,method:"ask",params:{}});else if(m.id===1)send({jsonrpc:"2.0",method:"seen",params:m});};`, {
			notification: (method, params) => { if (method === "seen") replies.push(params); },
			request: () => new AcpReply({ outcome: "selected" }, ok => delivered.push(ok)),
		});
		client.notify("start", {});
		await until(() => replies.length === 1 && delivered.length === 1);
		expect(replies[0].result).toEqual({ outcome: "selected" });
		expect(delivered).toEqual([true]);
	});

	it("tells the handler, and the message log, that its reply was not written when the link was lost before the reply, and writes nothing", async () => {
		const wire = startWireLog();
		try {
			const delivered: boolean[] = []; let release!: () => void;
			const held = new Promise<void>(r => { release = r; });
			const { client, lost, child } = connect(`onLine=m=>{if(m.method==="start"){send({jsonrpc:"2.0",id:1,method:"ask",params:{}});setTimeout(()=>process.exit(0),30);}};`, {
				request: async () => { await held; return new AcpReply({ outcome: "selected" }, ok => delivered.push(ok)); },
			});
			client.notify("start", {});
			await until(() => lost.length === 1);
			release();
			await until(() => delivered.length === 1);
			expect(delivered).toEqual([false]);
			expect(child.exitCode).toBe(0);
			expect(wire.lines().filter(e => e.ev === "out" && e.kind === "reply").map(e => [e.id, e.delivered])).toEqual([[1, false]]);
		} finally { wire.stop(); }
	});

	it("tells the handler its reply was not written when Pi closed its input first", async () => {
		const delivered: boolean[] = []; let release!: () => void, asked = false;
		const held = new Promise<void>(r => { release = r; });
		const { client } = connect(`onLine=m=>{if(m.method==="start")send({jsonrpc:"2.0",id:1,method:"ask",params:{}});};process.stdin.on("end",()=>process.exit(0));`, {
			request: async () => { asked = true; await held; return new AcpReply({ outcome: "selected" }, ok => delivered.push(ok)); },
		});
		client.notify("start", {});
		// Close the input only once AGY's request has reached the handler: a fixed sleep missed it when the machine was busy and the child started late.
		await until(() => asked);
		client.closeInput();
		release();
		await until(() => delivered.length === 1);
		expect(delivered).toEqual([false]);
	});

	it("tells the handler its reply was not written when it is too large to send", async () => {
		const delivered: boolean[] = [];
		const { client, lost } = connect(`onLine=m=>{if(m.method==="start")send({jsonrpc:"2.0",id:1,method:"ask",params:{}});};`, {
			request: () => new AcpReply("x".repeat(100), ok => delivered.push(ok)),
		}, { maxOutboundBytes: 64 });
		client.notify("start", {});
		await until(() => delivered.length === 1);
		expect(delivered).toEqual([false]);
		expect(lost[0]?.reason).toBe("reply too large");
	});

	it("answers with null for an undefined handler result and refuses a result that is not JSON", async () => {
		const replies: any[] = [];
		const { client } = connect(`onLine=m=>{if(m.method==="start"){send({jsonrpc:"2.0",id:1,method:"none",params:{}});send({jsonrpc:"2.0",id:2,method:"fn",params:{}});return;}send({jsonrpc:"2.0",method:"seen",params:m});};`, {
			notification: (method, params) => { if (method === "seen") replies.push(params); },
			request: (method) => method === "none" ? undefined : (() => 1),
		});
		client.notify("start", {});
		await until(() => replies.length === 2);
		const byId = Object.fromEntries(replies.map(r => [r.id, r]));
		expect(byId[1].result).toBeNull();
		expect(byId[2].error.code).toBe(-32603);
	});

	it("reads AGY's output while a request is still waiting for an answer", async () => {
		const notes: string[] = [];
		let release!: (value: unknown) => void;
		const { client } = connect(`onLine=m=>{if(m.method==="start"){send({jsonrpc:"2.0",id:1,method:"slow",params:{}});setTimeout(()=>send({jsonrpc:"2.0",method:"during",params:{}}),30);}};`, {
			notification: method => notes.push(method),
			request: () => new Promise(resolve => { release = resolve; }),
		});
		client.notify("start", {});
		await until(() => notes.includes("during"));
		release({});
	});

	it("ends the connection when AGY has more than 32 requests open, or reuses an open id", async () => {
		const flood = connect(`onLine=()=>{for(let i=0;i<40;i++)send({jsonrpc:"2.0",id:i,method:"m",params:{}});};`, { request: () => new Promise(() => { }) });
		await expect(flood.client.request("x", {})).rejects.toBeInstanceOf(AcpLostError);
		expect(flood.lost[0]!.reason).toBe("too many requests from AGY");
		const dup = connect(`onLine=()=>{send({jsonrpc:"2.0",id:"d",method:"m",params:{}});send({jsonrpc:"2.0",id:"d",method:"m",params:{}});};`, { request: () => new Promise(() => { }) });
		await expect(dup.client.request("x", {})).rejects.toBeInstanceOf(AcpLostError);
	});

	it("does not stall on a notification handler that throws", async () => {
		const { client } = connect(`onLine=m=>{send({jsonrpc:"2.0",method:"n",params:{}});send({jsonrpc:"2.0",id:m.id,result:"ok"});};`, { notification: () => { throw new Error("handler bug"); } });
		await expect(client.request("x", {})).resolves.toBe("ok");
	});
});

describe("pi-21.3 ACP client: loss and limits", () => {
	it("rejects waiting requests and reports loss when AGY exits", async () => {
		const { client, lost } = connect(`onLine=()=>process.exit(3);`);
		await expect(client.request("x", {})).rejects.toBeInstanceOf(AcpLostError);
		expect(["AGY exited", "AGY closed its output"]).toContain(lost[0]!.reason);
	});

	it("reports loss when the executable cannot start, without an unhandled child error", async () => {
		const child = spawn("/nonexistent/agy-for-test", ["acp"], { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
		const lost: AcpLostError[] = [];
		const client = new AcpClient(child, { lost: e => lost.push(e) });
		await expect(client.request("x", {})).rejects.toBeInstanceOf(AcpLostError);
		await until(() => lost.length === 1);
	});

	it("loses the connection on a request timeout and never resends", async () => {
		const { client, lost } = connect(`onLine=()=>{};`, {}, { requestTimeoutMs: 40 });
		const started = Date.now();
		await expect(client.request("x", {})).rejects.toBeInstanceOf(AcpLostError);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(lost[0]!.reason).toBe("request timed out");
	});

	it("waits without a timeout when asked, as a prompt does", async () => {
		const { client } = connect(`onLine=m=>setTimeout(()=>send({jsonrpc:"2.0",id:m.id,result:"late"}),120);`, {}, { requestTimeoutMs: 40 });
		await expect(client.request("prompt", {}, { timeoutMs: null })).resolves.toBe("late");
	});

	it("refuses an oversized outbound request before writing and stays usable", async () => {
		const { client, lost } = connect(`onLine=m=>send({jsonrpc:"2.0",id:m.id,result:m.params.n??"pong"});`, {}, { maxOutboundBytes: 1000 });
		await expect(client.request("x", { text: "a".repeat(2000) })).rejects.toBeInstanceOf(AcpOversizeRequestError);
		await expect(client.request("x", { n: "pong" })).resolves.toBe("pong");
		expect(lost).toEqual([]);
	});

	it("enforces per-request maxOutboundBytes and checkOutboundSize without writing", async () => {
		const { client, lost } = connect(`onLine=m=>send({jsonrpc:"2.0",id:m.id,result:m.params.n??"pong"});`);
		expect(() => client.checkOutboundSize("x", { text: "a".repeat(200) }, 100)).toThrow(AcpOversizeRequestError);
		expect(() => client.checkOutboundSize("x", { n: "ok" }, 100)).not.toThrow();
		await expect(client.request("x", { text: "a".repeat(200) }, { maxOutboundBytes: 100 })).rejects.toThrow("too large");
		await expect(client.request("x", { n: "pong" }, { maxOutboundBytes: 100 })).resolves.toBe("pong");
		expect(lost).toEqual([]);
	});

	it("treats a deliberate closeInput as no loss and fails waiting requests", async () => {
		const { client, lost, child } = connect(`process.stdin.on("end",()=>process.exit(0));`);
		const waiting = client.request("x", {}, { timeoutMs: null });
		client.closeInput();
		await expect(waiting).rejects.toBeInstanceOf(AcpLostError);
		await new Promise(resolve => child.once("exit", resolve));
		expect(lost).toEqual([]);
	});
});
