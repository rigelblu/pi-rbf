import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
const ROOT = resolve(import.meta.dirname, "..");
const SCRATCH = process.env.RBF_AGENTS_PTY_TMPDIR ?? "/Volumes/tom-ssd/tmp/pi-10.11/pty";
const PI = process.env.RBF_AGENTS_PTY_PI_BIN ?? join(ROOT,"node_modules/.bin/pi");
const STACK = process.env.RBF_AGENTS_PTY_STACK === "1" ? ["rbf-tool-execution-blended.ts","rbf-tool-parts-indent.ts","rbf-shell-command-groups.ts"].flatMap(n=>["-e","/Users/tomhosiawa/.pi/agent/extensions/"+n]) : [];
const EXTENSION = join(import.meta.dirname,"test-support/rbf-codex-agents-extension.ts");
const PYTHON_DRIVER = `
import fcntl, glob, json, os, pty, re, select, signal, struct, sys, termios, time

KEYS = {
    "enter": b"\\r",
    "tab": b"\\t",
    "shift-tab": b"\\x1b[Z",
    "shift+tab": b"\\x1b[Z",
    "escape": b"\\x1b",
    "up": b"\\x1b[A",
    "down": b"\\x1b[B",
    "ctrl-c": b"\\x03",
    "ctrl-d": b"\\x04",
    "ctrl-o": b"\\x0f",
    "ctrl-u": b"\\x15",
    "ctrl-p": b"\\x10",
    "ctrl-l": b"\\x0c",
}

ANSI = re.compile(rb"\\x1b\\[[0-9;?]*[ -/]*[@-~]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|\\x1b[()][A-Za-z0-9]|\\x1b[=>]|\\r")

def strip(raw: bytes) -> bytes:
    return ANSI.sub(b"", raw)

def main():
    plan = json.load(sys.stdin)
    cols = int(plan.get("cols", 80))
    rows = int(plan.get("rows", 38))
    deadline = time.monotonic() + float(plan.get("timeout", 60))
    env = {**os.environ, **plan.get("env", {}), "TERM": "xterm-256color", "COLUMNS": str(cols), "LINES": str(rows)}

    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.chdir(plan["cwd"])
            os.execvpe(plan["argv"][0], plan["argv"], env)
        except BaseException as e:
            print(f"exec failed: {e}", file=sys.stderr)
        finally:
            os._exit(127)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    raw = bytearray()
    failure = None

    def pump(until: float):
        while True:
            left = until - time.monotonic()
            if left <= 0:
                return
            ready, _, _ = select.select([fd], [], [], min(left, 0.05))
            if not ready:
                continue
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            raw.extend(chunk)

    try:
        for step in plan["steps"]:
            if "wait" in step:
                pattern = re.compile(step["wait"].encode())
                count = int(step.get("count", 1))
                wait_deadline = min(deadline, time.monotonic() + float(step.get("timeout", plan.get("timeout", 60))))
                while len(list(pattern.finditer(strip(bytes(raw))))) < count:
                    if time.monotonic() > wait_deadline:
                        failure = f"timed out waiting for {step['wait']!r} (count={count})"
                        break
                    pump(time.monotonic() + 0.1)
                if failure:
                    break
            elif "reloadReady" in step:
                receipt = step["reloadReady"]
                target = int(receipt["loads"])
                last_ping = 0.0
                wait_deadline = min(deadline, time.monotonic() + float(step.get("timeout", plan.get("timeout", 60))))
                while True:
                    try:
                        with open(receipt["path"], encoding="utf-8") as f:
                            state = json.load(f)
                    except (OSError, ValueError):
                        state = {}
                    if state.get("readyLoad") == target and state.get("loads") == target:
                        pump(time.monotonic() + 0.3)
                        break
                    if time.monotonic() > wait_deadline:
                        failure = f"timed out waiting for reload readiness (loads={target})"
                        break
                    if state.get("loads") == target and time.monotonic() - last_ping >= 0.75:
                        command = f"{receipt.get('command', '/rbf-effort-reload-ready')} {target}".encode()
                        os.write(fd, b"\\x1b[200~" + command + b"\\x1b[201~\\r")
                        last_ping = time.monotonic()
                    pump(time.monotonic() + 0.1)
                if failure:
                    break
            elif "createFile" in step:
                cf = step["createFile"]
                with open(cf["path"], "w", encoding="utf-8") as f:
                    f.write(cf.get("content", ""))
                pump(time.monotonic() + 0.1)
            elif "snapshotLog" in step:
                dest = step["snapshotLog"]
                log_file = plan.get("env", {}).get("RBF_FAKE_LOG")
                content = ""
                if log_file and os.path.exists(log_file):
                    with open(log_file, "r", encoding="utf-8") as f:
                        content = f.read()
                with open(dest, "w", encoding="utf-8") as f:
                    f.write(content)
                pump(time.monotonic() + 0.1)
            elif "paste" in step:
                os.write(fd, b"\\x1b[200~" + step["paste"].encode() + b"\\x1b[201~")
                pump(time.monotonic() + 0.2)
            elif "write" in step:
                delay = float(step.get("delay", 0.05))
                for ch in step["write"]:
                    os.write(fd, ch.encode())
                    if delay > 0:
                        pump(time.monotonic() + delay)
                pump(time.monotonic() + 0.2)
            elif "key" in step:
                k = step["key"]
                os.write(fd, KEYS[k])
                pump(time.monotonic() + 0.2)
            elif "raw" in step:
                os.write(fd, step["raw"].encode())
                pump(time.monotonic() + 0.2)
            elif "resize" in step:
                shape = step["resize"]
                fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", shape["rows"], shape["cols"], 0, 0))
                os.kill(pid, signal.SIGWINCH)
                pump(time.monotonic() + 0.4)
            elif "sleep" in step:
                pump(time.monotonic() + float(step["sleep"]))
            elif "waitSessionTurns" in step:
                target = step["waitSessionTurns"]
                wait_deadline = min(deadline, time.monotonic() + float(step.get("timeout", plan.get("timeout", 60))))
                while True:
                    files = glob.glob(os.path.join(target["dir"], "*.jsonl"))
                    try:
                        with open(files[0], "r", encoding="utf-8") as f:
                            count = sum(1 for line in f if '"customType":"rbf-codex-turn/v1"' in line)
                    except (IndexError, OSError):
                        count = 0
                    if count >= int(target["count"]):
                        pump(time.monotonic() + 0.3)
                        break
                    if time.monotonic() > wait_deadline:
                        failure = f"timed out waiting for {target['count']} Codex turns, saw {count}"
                        break
                    pump(time.monotonic() + 0.1)
                if failure:
                    break
    finally:
        pump(time.monotonic() + 0.3)
        try:
            os.kill(pid, signal.SIGTERM)
            pump(time.monotonic() + 0.2)
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        os.close(fd)
        with open(plan["out"], "wb") as f:
            f.write(raw)

    if failure:
        print(failure, file=sys.stderr)
        return 2
    return 0

if __name__ == "__main__":
    sys.exit(main())
`;const submit = (text: string) => [{paste:text},{key:"enter"}];
const ANSI = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]|\r/g;

async function drive(plan: any): Promise<{code:number|null;stderr:string}> {
	return await new Promise(res => { const p=spawn("python3",["-c",PYTHON_DRIVER]); const timer=setTimeout(()=>p.kill("SIGTERM"),35000);let stderr="";p.stderr.on("data",d=>stderr+=d);p.stdout.resume();p.on("close",code=>{clearTimeout(timer);res({code,stderr});});p.stdin.end(JSON.stringify(plan)); });
}

describe("real Pi Codex agent overview", () => {
	it("native CLI fork inherits recorded agents then replaces roster at the new Codex root", async () => {
		const dir=join(SCRATCH,Date.now()+"-fork"),agent=join(dir,"agent"),sessions=join(dir,"sessions");mkdirSync(agent,{recursive:true});mkdirSync(sessions,{recursive:true});writeFileSync(join(agent,"settings.json"),JSON.stringify({defaultProvider:"codex-harness",defaultModel:"codex",defaultThinkingLevel:"medium",theme:process.env.RBF_AGENTS_PTY_THEME??"dark"}));
		const stamp="2026-10-20T14:00:00.000Z",session=join(sessions,"fixture.jsonl");const entries=[{type:"session",version:3,id:"fixture",timestamp:stamp,cwd:dir},{type:"custom",id:"00000001",parentId:null,timestamp:stamp,customType:"rbf-codex-thread/v1",data:{threadId:"thread-fake-1",cwd:dir,sessionId:"fixture"}},{type:"custom",id:"00000002",parentId:"00000001",timestamp:stamp,customType:"rbf-codex-turn/v1",data:{threadId:"thread-fake-1",turnId:"seed-turn",status:"completed"}},{type:"custom",id:"00000003",parentId:"00000002",timestamp:stamp,customType:"rbf-codex-agents/v1",data:{version:1,rootThreadId:"thread-fake-1",observedAt:stamp,partial:false,agents:[{threadId:"old-agent",name:"OldReader",status:"running",observedAt:stamp}]}}];writeFileSync(session,entries.map(e=>JSON.stringify(e)).join("\n")+"\n");
		const scenario={retainHistory:true,turn:[{kind:"subAgent",activity:"started",agentThreadId:"new-agent",agentPath:"/root/NewReader"},{kind:"answer",id:"m",text:"FORK_DONE"},{kind:"complete"}]};const plan={cwd:dir,argv:[PI,"--no-extensions","--no-skills","--no-prompt-templates","-e",EXTENSION,...STACK,"--fork",session,"--session-dir",sessions],env:{PI_CODING_AGENT_DIR:agent,RBF_FAKE_SCENARIO:JSON.stringify(scenario),RBF_FAKE_LOG:join(dir,"native.jsonl"),RBF_FAKE_HISTORY:join(dir,"history.json")},cols:80,rows:38,timeout:20,out:join(dir,"terminal.raw"),steps:[{wait:"OldReader"},{wait:"Last recorded"},...submit("NEW_ONLY"),{wait:"FORK_DONE"},{sleep:.5}]};const result=await drive(plan);expect(result,dir).toMatchObject({code:0});const calls=readFileSync(join(dir,"native.jsonl"),"utf8").trim().split("\n").map(l=>JSON.parse(l));expect(calls.filter(c=>c.method==="thread/fork")).toHaveLength(1);
		const records=readdirSync(sessions).filter(f=>f!=="fixture.jsonl").flatMap(f=>readFileSync(join(sessions,f),"utf8").trim().split("\n").map(l=>JSON.parse(l)));const saved=records.filter(e=>e.customType==="rbf-codex-agents/v1").at(-1);expect(saved.data.rootThreadId).toBe("thread-fake-fork-1");expect(saved.data.agents.map((a:any)=>a.threadId)).toEqual(["new-agent"]);console.log("agents fork receipt: "+dir);
	},40_000);

	it("native empty/unavailable/overflow states, long tasks, End and resize", async () => {
		for(const state of ["empty","unavailable","overflow"]) {
			const dir=join(SCRATCH,Date.now()+"-"+state),agent=join(dir,"agent"),sessions=join(dir,"sessions");mkdirSync(agent,{recursive:true});mkdirSync(sessions,{recursive:true});
			writeFileSync(join(agent,"settings.json"),JSON.stringify({defaultProvider:"codex-harness",defaultModel:"codex",defaultThinkingLevel:"medium",theme:process.env.RBF_AGENTS_PTY_THEME??"dark"}));
			const stamp="2026-10-20T14:00:00.000Z",session=join(sessions,"fixture.jsonl");let entries:any[]=[{type:"session",version:3,id:"fixture",timestamp:stamp,cwd:dir},{type:"custom",id:"00000001",parentId:null,timestamp:stamp,customType:"rbf-codex-thread/v1",data:{threadId:"thread-fake-1",cwd:dir,sessionId:"fixture"}}];
			if(state!=="empty")entries.push({type:"custom",id:"00000002",parentId:"00000001",timestamp:stamp,customType:"rbf-codex-agents/v1",data:state==="unavailable"?{version:2}:{version:1,rootThreadId:"thread-fake-1",observedAt:stamp,partial:false,agents:Array.from({length:30},(_,i)=>({threadId:"agent-"+i,name:"Reader-"+i,status:"running",task:i===29?"LAST_TASK_END":"Read the long supplied assignment across reopening and navigation, keeping every reported status tied to the correct agent rather than inferring completion from a tool call.",observedAt:stamp}))}});
			writeFileSync(session,entries.map(e=>JSON.stringify(e)).join("\n")+"\n");
			const expected=state==="empty"?"No agent activity recorded":state==="unavailable"?"Saved agent overview is unavailable":"LAST_TASK_END";
			const plan={cwd:dir,argv:[PI,"--no-extensions","--no-skills","--no-prompt-templates","-e",EXTENSION,...STACK,"--session",session],env:{PI_CODING_AGENT_DIR:agent},cols:80,rows:50,timeout:15,out:join(dir,"terminal.raw"),steps:[{wait:"codex"},...submit("/agents-codex"),{sleep:.3},...(state==="overflow"?[{raw:"\x1b[F"}]:[]),{wait:expected},...(state==="overflow"?[{resize:{cols:120,rows:20}},{raw:"\x1b[F"},{sleep:.3}]:[]),{key:"escape"}]};
			const result=await drive(plan);expect(result,dir).toMatchObject({code:0});const raw=readFileSync(plan.out,"utf8").replace(ANSI,"");writeFileSync(join(dir,"terminal.txt"),raw);expect(raw).toContain(expected);if(state==="overflow"){expect(raw).toContain("+26 more");expect(raw).toContain("Last recorded:");expect(raw).toContain("Observed");}console.log("agents state receipt: "+dir);
		}
	},60_000);

	it("native approvals and questions preempt the overview without changing answers", async () => {
		const dir=join(SCRATCH,Date.now()+"-dialogs"); const agent=join(dir,"agent"),sessions=join(dir,"sessions");mkdirSync(agent,{recursive:true});mkdirSync(sessions,{recursive:true});
		writeFileSync(join(agent,"settings.json"),JSON.stringify({defaultProvider:"codex-harness",defaultModel:"codex",defaultThinkingLevel:"medium",theme:process.env.RBF_AGENTS_PTY_THEME??"dark"}));
		const scenario={retainHistory:true,turn:[{kind:"subAgent",activity:"started",agentThreadId:"a",agentPath:"/root/Reviewer"},{kind:"sleep",ms:1500},{kind:"command",id:"cmd",command:"echo test",output:["test"],approvals:[{when:"before",command:"echo test"}]},{kind:"question",id:"q",questions:[{id:"color",header:"Color",question:"Pick color",options:[{label:"Red",description:"red"},{label:"Blue",description:"blue"}]}]},{kind:"answer",id:"answer",text:"DIALOG_DONE"},{kind:"complete"}]};
		const plan={cwd:dir,argv:[PI,"--no-extensions","--no-skills","--no-prompt-templates","-e",EXTENSION,...STACK,"--session-dir",sessions],env:{PI_CODING_AGENT_DIR:agent,RBF_FAKE_SCENARIO:JSON.stringify(scenario),RBF_FAKE_LOG:join(dir,"native.jsonl"),RBF_FAKE_HISTORY:join(dir,"history.json")},cols:80,rows:38,timeout:25,out:join(dir,"terminal.raw"),steps:[{wait:"codex"},...submit("delegate"),{wait:"Reviewer"},{raw:"\x1ba"},{wait:"Observed"},{wait:"Codex wants to run"},{key:"enter"},{wait:"Pick color"},{raw:"\x1ba"},{sleep:.2},{key:"enter"},{wait:"DIALOG_DONE"}]};
		const result=await drive(plan);expect(result,dir).toMatchObject({code:0});const raw=readFileSync(plan.out,"utf8").replace(ANSI,"");writeFileSync(join(dir,"terminal.txt"),raw);expect(raw).toContain("Pick color");
		const calls=readFileSync(join(dir,"native.jsonl"),"utf8").trim().split("\n").map(l=>JSON.parse(l));expect(calls.filter(c=>c.result?.decision==="accept")).toHaveLength(1);expect(calls.find(c=>c.result?.answers)?.result.answers).toEqual({color:{answers:["Red"]}});console.log("agents dialog receipt: "+dir);
	},40_000);

	for (const cols of [80,120]) it(`preview, overlay, saved restore and editor cursor at ${cols} columns`, async () => {
		const dir=join(SCRATCH,`${Date.now()}-${cols}`);const agent=join(dir,"agent"),sessions=join(dir,"sessions");mkdirSync(agent,{recursive:true});mkdirSync(sessions,{recursive:true});
		writeFileSync(join(agent,"settings.json"),JSON.stringify({defaultProvider:"codex-harness",defaultModel:"codex",defaultThinkingLevel:"medium",theme:process.env.RBF_AGENTS_PTY_THEME??"dark",enableTerminalTitle:false}));
		const scenario={retainHistory:true,turn:[{kind:"collab",tool:"spawnAgent",prompt:"Check cancellation and reopening",receivers:["agent-a"],states:{"agent-a":"running"}},{kind:"subAgent",activity:"interacted",agentThreadId:"agent-a",agentPath:"/root/Reviewer"},{kind:"collab",tool:"spawnAgent",prompt:"Implement the small fix",receivers:["agent-b"],states:{"agent-b":"pendingInit"}},{kind:"sleep",ms:2500},{kind:"answer",id:"answer",text:"OVERVIEW_DONE"},{kind:"complete"}]};
		const plan={cwd:dir,argv:[PI,"--no-extensions","--no-skills","--no-prompt-templates","-e",EXTENSION,...STACK,"--session-dir",sessions],env:{PI_CODING_AGENT_DIR:agent,RBF_FAKE_SCENARIO:JSON.stringify(scenario),RBF_FAKE_LOG:join(dir,"native.jsonl"),RBF_FAKE_HISTORY:join(dir,"history.json")},cols,rows:38,timeout:25,out:join(dir,"terminal.raw"),steps:[{wait:"codex"},{sleep:.4},...submit("delegate"),{wait:"Reviewer",timeout:8},{raw:"\x1ba"},{wait:"Observed"},{raw:"\x1b"},{wait:"OVERVIEW_DONE"},{sleep:.4},{paste:"draft text"},{raw:"\x1b[D\x1b[D\x1b[D"},{raw:"\x1ba"},{sleep:.3},{raw:"\x1b"},{paste:"X"},{key:"enter"},{waitSessionTurns:{dir:sessions,count:2}},...submit("/reload"),{sleep:1},...submit("/agents-codex"),{sleep:.4},{key:"escape"}]};
		writeFileSync(join(dir,"plan.json"),JSON.stringify(plan,null,2));
		const result=await new Promise<{code:number|null;stderr:string}>(res=>{const p=spawn("python3",["-c",PYTHON_DRIVER]);const timer=setTimeout(()=>p.kill("SIGTERM"),35000);let stderr="";p.stderr.on("data",d=>stderr+=d);p.stdout.resume();p.on("close",code=>{clearTimeout(timer);res({code,stderr});});p.stdin.end(JSON.stringify(plan));});
		expect(result,dir).toMatchObject({code:0});const raw=readFileSync(plan.out,"utf8").replace(ANSI,"");writeFileSync(join(dir,"terminal.txt"),raw);
		expect(raw).toContain("Reviewer");expect(raw).toContain("Check cancellation and reopening");expect(raw).toContain("Last recorded:");expect(raw).toContain("Observed");
		const calls=readFileSync(join(dir,"native.jsonl"),"utf8").trim().split("\n").map(l=>JSON.parse(l));const starts=calls.filter(c=>c.method==="turn/start");expect(starts).toHaveLength(2);expect(starts[1].params.input[0].text).toBe("draft tXext");
		const entries=readdirSync(sessions).flatMap(f=>readFileSync(join(sessions,f),"utf8").trim().split("\n").map(l=>JSON.parse(l)));const saved=entries.filter(e=>e.customType==="rbf-codex-agents/v1");expect(saved.length).toBeGreaterThan(0);expect(saved.at(-1).data.agents).toHaveLength(2);
		writeFileSync(join(dir,"receipt.json"),JSON.stringify({pi:PI,version:execFileSync(PI,["--version"],{encoding:"utf8"}).trim(),sourceSHA256:createHash("sha256").update(readFileSync(process.env.RBF_AGENTS_SOURCE??join(ROOT,"extensions/rbf-codex.ts"))).digest("hex"),cols,snapshots:saved.length,providerTurns:0,fakeTurns:starts.length,cursorPreserved:true},null,2));console.log(`agents PTY receipt: ${dir}`);
	},40_000);
});
