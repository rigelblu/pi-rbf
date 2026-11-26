// Offline stand-in for `agy acp` (ACP 1.5.3). Frame shapes come from fixtures/acp-1.5.3.json, copied from a recorded
// probe. It talks only over stdio, writes only the log it is given, and never reaches the network or real AGY.
// Use: require("<this file>")({ log, mode, release }) inside a shim that is passed to createRbfAgy({ executable }).
// A prompt starting `[name]` picks a scenario below; any other prompt gets three text chunks and a normal result.
"use strict";
const fs = require("node:fs");
const fixture = JSON.parse(fs.readFileSync(require("node:path").join(__dirname, "fixtures", "acp-1.5.3.json"), "utf8"));

module.exports = function run(cfg) {
	const modes = new Set(String(cfg.mode || "").split(",").filter(Boolean));
	const shrink = v => JSON.parse(JSON.stringify(v, (_k, x) => typeof x === "string" && x.length > 300 ? `<${x.length} chars>` : x));
	const record = x => fs.appendFileSync(cfg.log, JSON.stringify(x) + "\n");
	const write = text => process.stdout.write(text);
	const send = frame => { record({ out: shrink(frame) }); write(JSON.stringify(frame) + "\n"); };
	const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
	const error = (id, code) => send({ jsonrpc: "2.0", id, error: { code, message: "fake error" } });
	const notify = (sessionId, update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	// Mode `cmd-overloaded` adds a command whose name Pi's retry check takes for "overloaded", so a refusal that names it carries a word Pi's retry check would take for a server error (the provider writes it apart so Pi starts no retry).
	const commandsUpdate = () => modes.has("cmd-overloaded") ? { ...fixture.availableCommands, availableCommands: [...fixture.availableCommands.availableCommands, { name: "overloaded", description: "A command named like a transient server error." }] } : fixture.availableCommands;
	const waiters = new Map();
	const wakes = { current: null }; // the wake scenario running after a turn, so a session/cancel can stop it
	const wakeGo = require("node:path").join(require("node:path").dirname(cfg.release), "wake-go");
	const ask = (id, method, params) => new Promise(resolve => { waiters.set(id, resolve); send({ jsonrpc: "2.0", id, method, params }); });

	record({ args: process.argv.slice(2), cwd: process.cwd(), pwd: process.env.PWD });
	// Mode `agy-1.5.14`: the models and thinking levels real AGY 1.5.14 offers (zero-prompt config check of 2026-11-22, agy-1.5.14-noprompt/config-check-output.txt). It starts on Neon at high.
	// The levels depend on the model. An Orchestrator offers none and has no thought_level option at all. A level the current model does not offer is clamped to its highest, as AGY does.
	const m114 = modes.has("agy-1.5.14");
	// The recorded 1.5.3 options hold two Gemini models; Pi now offers only Gemini ones, so the default mode also offers the Gemini ids the tests switch to (AGY 1.5.14's names).
	const EXTRA_GEMINI = [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }, { value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" }, { value: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" }];
	const LEVELS114 = { "gemini-4-neon": ["low", "medium", "high", "xhigh"], "gemini-4-hydrogen": ["low", "medium", "high", "xhigh"], "gemini-4-argon": ["low", "medium", "high"], "gemini-3.8-flash": ["low", "medium", "high"], "claude-opus-5-5": ["low", "medium", "high"], "claude-sonnet-5-5": ["low", "medium", "high"], "gemini-pro-orchestrator-neon": [], "gemini-pro-orchestrator-g1-pro": [], "gpt-oss-120b-medium": [] };
	const state = m114 ? { sessionId: null, model: "gemini-4-neon", thought_level: "high", turn: 0 } : { sessionId: null, model: "gemini-4-argon", thought_level: "medium", turn: 0 };
	// Where a config_option_update echo lands relative to its set_config_option reply (see the `echo:` modes in the header comment of the tests).
	// `echo:same-chunk:<model|thought_level|all>` writes the reply and its echo in one stdout write for the named call (or both), as the client meets them when it reads late: the echo follows its reply on the wire, in the same read.
	const [echoMode, echoArg] = ([...modes].find(x => x.startsWith("echo:")) || "echo:recorded").slice(5).split(":");
	const slowSet = Number(([...modes].find(x => x.startsWith("slow-set:")) || "slow-set:0").slice(9));
	const heldEchoes = [];
	let echoTimers = 0;
	const later = (fn, ms) => { echoTimers++; setTimeout(() => { echoTimers--; fn(); }, ms); };
	let pendingModelEcho = null, beforeReplyDone = false;
	let activePrompt = null;
	// AGY 1.5.14 sends `usage_update` (a context meter, not a token count) at session start, after each model call and after a model or effort change; mode `usage-updates` makes the fake do the same.
	const usageOn = modes.has("usage-updates"), usage = sid => { if (usageOn) notify(sid, fixture.usageUpdate); };
	const flushEchoes = () => { while (heldEchoes.length) heldEchoes.shift()(); };
	const configOptions = () => m114 ? fixture.sessionNew.configOptions.flatMap(o => o.id === "model" ? [{ ...o, currentValue: state.model, options: Object.keys(LEVELS114).map(value => ({ value, name: value })) }] : o.id === "thought_level" ? (LEVELS114[state.model].length ? [{ ...o, currentValue: state.thought_level, options: LEVELS114[state.model].map(value => ({ value, name: value })) }] : []) : [o]) : fixture.sessionNew.configOptions.map(o => o.id === "model" ? { ...o, currentValue: state.model, options: modes.has("lacks-flash") ? o.options.filter(x => x.value !== "gemini-3.8-flash") : [...o.options, ...EXTRA_GEMINI.filter(x => !o.options.some(y => y.value === x.value))] } : o.id === "thought_level" ? { ...o, currentValue: state.thought_level } : o);

	async function prompt(id, params) {
		const text = (params.prompt || []).map(b => b.text || "").join("\n");
		const scenario = (/^\[([\w-]+)\]/.exec(text) || [])[1];
		const sid = params.sessionId;
		const turn = { id, sid, cancelled: false, settled: false, onCancel: null };
		activePrompt = turn;
		const chunk = t => notify(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
		const end = (stopReason = "end_turn") => {
			if (turn.settled) return;
			turn.settled = true;
			if (activePrompt === turn) activePrompt = null;
			result(id, { stopReason, usage: fixture.usage });
			if (usageOn) setTimeout(() => { usage(sid); record({ usageAfterTurn: true }); }, 5); // between turns
		};
		// `bypass` is AGY asking to run the command outside its sandbox: BypassSandbox: true in both the arguments and rawInput (Tom's row 64).
		const permCommand = async (toolCallId, title, cmd, afterText, bypass = false) => {
			const extra = bypass ? { BypassSandbox: true } : {};
			const toolCall = { ...fixture.permissionParams.toolCall, toolCallId, title, args: { ...fixture.permissionParams.toolCall.args, CommandLine: cmd, ...extra }, rawInput: { ...fixture.permissionParams.toolCall.rawInput, CommandLine: cmd, ...extra } };
			notify(sid, { sessionUpdate: "tool_call", toolCallId, name: "run_command", status: "in_progress", kind: "execute", title, rawInput: { CommandLine: cmd } });
			notify(sid, { sessionUpdate: "tool_call_update", toolCallId, name: "run_command", status: "pending", kind: "execute", title, rawInput: { CommandLine: cmd } });
			const reply = await ask("1", "session/request_permission", { ...fixture.permissionParams, sessionId: sid, toolCall });
			record({ permissionReply: reply });
			if (turn.settled) return;
			if (reply?.outcome?.outcome === "selected" && reply.outcome.optionId === "allow") {
				notify(sid, { sessionUpdate: "tool_call_update", toolCallId, name: "run_command", status: "in_progress", kind: "execute", title });
				notify(sid, { sessionUpdate: "tool_call_update", toolCallId, name: "run_command", status: "completed", kind: "execute", title, rawInput: { CommandLine: cmd }, rawOutput: { output: "a.txt\nb.txt", exit_code: 0 }, content: [{ type: "content", content: { type: "text", text: "a.txt\nb.txt" } }] });
				chunk(afterText);
				return end();
			}
			notify(sid, { sessionUpdate: "tool_call_update", toolCallId, name: "run_command", status: "failed", kind: "execute", title, rawInput: { CommandLine: cmd } });
			return end();
		};
		try {
			state.turn++;
			flushEchoes(); // echoes held until the prompt arrives (echo:after-prompt, echo:model-after-prompt)
			// A real turn outlasts the echoes of the calls before it, so a turn starts only once the echoes in flight have landed. A test that wants a late echo asks for one (echo:after-prompt, [late-echo]).
			while (echoTimers > 0) await sleep(2);
			if (turn.settled) return;
			notify(sid, { sessionUpdate: "user_message_chunk", content: { type: "text", text } });
			switch (scenario) {
				case "empty": return end();
				case "thought": notify(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking it over." } }); chunk("Done."); return end();
				case "hold":
					while (!turn.settled && !fs.existsSync(cfg.release)) await sleep(10);
					if (turn.settled) return;
					chunk("Released.");
					return end();
				case "hold-partial":
					chunk("Partial before cancel.");
					while (!turn.settled && !fs.existsSync(cfg.release)) await sleep(10);
					if (turn.settled) return;
					chunk("Released.");
					return end();
				case "cancel-wait":
					await new Promise(resolve => { turn.onCancel = resolve; });
					return;
				case "perm":
					return await permCommand(fixture.permissionParams.toolCall.toolCallId, "ls -1", "ls -1", "after permission");
				// A permission request that is never answered: AGY dies when the release file appears, with the request still open (cold review F4).
				case "perm-link-lost": {
					const toolCall = { ...fixture.permissionParams.toolCall, toolCallId: "call_link_lost" };
					notify(sid, { sessionUpdate: "tool_call", toolCallId: "call_link_lost", name: "run_command", status: "in_progress", kind: "execute", title: "ls -1", rawInput: { CommandLine: "ls -1" } });
					void ask("1", "session/request_permission", { ...fixture.permissionParams, sessionId: sid, toolCall });
					while (!fs.existsSync(cfg.release)) await sleep(10);
					process.exit(2);
				}
				case "perm-long": {
					const cmd = Array.from({ length: 200 }, (_, i) => `echo line-${i + 1}`).join("\n");
					return await permCommand("call_perm_long", "long command", cmd, "after long permission");
				}
				case "perm-bypass":
					return await permCommand("call_perm_bypass", "touch out.txt", "touch out.txt", "after bypass permission", true);
				// AGY asks again for the same tool call (a shape row 65 may have had; not confirmed on real AGY): a second request with its own rpc id, sent 150 ms after the first and so while the first dialog is open.
				// The second carries BypassSandbox: true. Each reply is logged with the rpc id it answers.
				case "perm-reask": {
					const toolCallId = "call_perm_reask", cmd = "touch out.txt";
					const mk = bypass => ({ ...fixture.permissionParams.toolCall, toolCallId, title: cmd, args: { ...fixture.permissionParams.toolCall.args, CommandLine: cmd, ...(bypass ? { BypassSandbox: true } : {}) }, rawInput: { ...fixture.permissionParams.toolCall.rawInput, CommandLine: cmd, ...(bypass ? { BypassSandbox: true } : {}) } });
					notify(sid, { sessionUpdate: "tool_call", toolCallId, name: "run_command", status: "in_progress", kind: "execute", title: cmd, rawInput: { CommandLine: cmd } });
					notify(sid, { sessionUpdate: "tool_call_update", toolCallId, name: "run_command", status: "pending", kind: "execute", title: cmd, rawInput: { CommandLine: cmd } });
					const first = ask("1", "session/request_permission", { ...fixture.permissionParams, sessionId: sid, toolCall: mk(false) }).then(reply => { record({ permissionReply: reply, rpcId: "1" }); return reply; });
					await sleep(150);
					const second = ask("2", "session/request_permission", { ...fixture.permissionParams, sessionId: sid, toolCall: mk(true) }).then(reply => { record({ permissionReply: reply, rpcId: "2" }); return reply; });
					const replies = await Promise.all([first, second]);
					if (turn.settled) return;
					if (replies[1]?.outcome?.outcome === "selected" && replies[1].outcome.optionId === "allow") {
						notify(sid, { sessionUpdate: "tool_call_update", toolCallId, name: "run_command", status: "completed", kind: "execute", title: cmd, rawInput: { CommandLine: cmd }, rawOutput: { output: "", exit_code: 0 }, content: [] });
						chunk("after re-ask");
					}
					else notify(sid, { sessionUpdate: "tool_call_update", toolCallId, name: "run_command", status: "failed", kind: "execute", title: cmd, rawInput: { CommandLine: cmd } });
					return end();
				}
				case "perm-escape": {
					const cmd = "echo \x1b[31mred\x1b[0m \u202eevil";
					return await permCommand("call_perm_escape", cmd, cmd, "after escape permission");
				}
				case "perm-two": {
					const mk = (toolCallId, cmd) => ({ ...fixture.permissionParams.toolCall, toolCallId, title: cmd, args: { ...fixture.permissionParams.toolCall.args, CommandLine: cmd }, rawInput: { ...fixture.permissionParams.toolCall.rawInput, CommandLine: cmd } });
					const c1 = mk("call_perm_1", "echo one"), c2 = mk("call_perm_2", "echo two");
					notify(sid, { sessionUpdate: "tool_call", toolCallId: c1.toolCallId, name: "run_command", status: "in_progress", kind: "execute", title: "echo one", rawInput: { CommandLine: "echo one" } });
					notify(sid, { sessionUpdate: "tool_call_update", toolCallId: c1.toolCallId, name: "run_command", status: "pending", kind: "execute", title: "echo one", rawInput: { CommandLine: "echo one" } });
					notify(sid, { sessionUpdate: "tool_call", toolCallId: c2.toolCallId, name: "run_command", status: "in_progress", kind: "execute", title: "echo two", rawInput: { CommandLine: "echo two" } });
					notify(sid, { sessionUpdate: "tool_call_update", toolCallId: c2.toolCallId, name: "run_command", status: "pending", kind: "execute", title: "echo two", rawInput: { CommandLine: "echo two" } });
					const replies = await Promise.all([
						ask("1", "session/request_permission", { ...fixture.permissionParams, sessionId: sid, toolCall: c1 }),
						ask("2", "session/request_permission", { ...fixture.permissionParams, sessionId: sid, toolCall: c2 }),
					]);
					record({ permissionReplies: replies });
					if (turn.settled) return;
					for (const [c, r] of [[c1, replies[0]], [c2, replies[1]]]) {
						const cmd = c.rawInput.CommandLine;
						if (r?.outcome?.outcome === "selected" && r.outcome.optionId === "allow") {
							notify(sid, { sessionUpdate: "tool_call_update", toolCallId: c.toolCallId, name: "run_command", status: "completed", kind: "execute", title: cmd, rawInput: { CommandLine: cmd }, rawOutput: { output: cmd + "\n", exit_code: 0 }, content: [{ type: "content", content: { type: "text", text: cmd + "\n" } }] });
						}
						else {
							notify(sid, { sessionUpdate: "tool_call_update", toolCallId: c.toolCallId, name: "run_command", status: "failed", kind: "execute", title: cmd, rawInput: { CommandLine: cmd } });
						}
					}
					if (replies.some(r => r?.outcome?.outcome === "selected" && r.outcome.optionId === "allow")) chunk("after two permissions");
					return end();
				}
				case "perm-between":
					chunk("Done.");
					end();
					setTimeout(async () => {
						const toolCall = { ...fixture.permissionParams.toolCall, toolCallId: "call_perm_between" };
						const reply = await ask("between-1", "session/request_permission", { ...fixture.permissionParams, sessionId: sid, toolCall });
						record({ betweenPermissionReply: reply });
					}, 15);
					return;
				case "question": {
					const reply = await ask("2", "elicitation/create", {
						sessionId: sid,
						toolCallId: "call_q",
						mode: "form",
						message: "The agent has a question.",
						requestedSchema: {
							type: "object",
							properties: {
								q0: { type: "string", title: "Which colors do you like?", oneOf: [{ const: "0", title: "Red" }, { const: "1", title: "Blue" }] },
								q0_other: { type: "string", title: "Other" },
							},
						},
					});
					record({ elicitationReply: reply });
					if (turn.settled) return;
					chunk("after question");
					return end();
				}
				case "fs": {
					const replies = await Promise.all([ask("f1", "fs/read_text_file", { sessionId: sid, path: "/etc/passwd" }), ask("f2", "terminal/create", { sessionId: sid, command: "id" }), ask("f3", "made/up", {})]);
					record({ clientPowerReplies: replies });
					if (turn.settled) return;
					chunk("after client powers");
					return end();
				}
				case "big": {
					const out = "x".repeat(600000);
					notify(sid, { sessionUpdate: "tool_call_update", toolCallId: "call_big", name: "run_command", status: "completed", kind: "execute", title: "big", rawInput: { CommandLine: "yes" }, rawOutput: { output: out, exit_code: 0 }, content: [{ type: "content", content: { type: "text", text: out } }] });
					chunk("big ok"); return end();
				}
				case "oversize": {
					const head = '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"' + sid + '","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"', tail = '"}}}}';
					write(head + "y".repeat(2 * 1024 * 1024 - Buffer.byteLength(head + tail) + 1) + tail + "\n"); return;
				}
				// Wake scenarios (AGY 1.5.10 and later: after a turn's result AGY keeps working and talks between turns, with no start or end marker). Each answers the turn normally, then speaks on its own.
				// `wake-gap:<ms>` sets the pause before a second burst. Everything the fake sees is logged: the permission and question replies, and a session/cancel it gets with no prompt running.
				case "wake": case "wake-two": case "wake-perm": case "wake-question": case "wake-noise": case "wake-long": case "wake-move": case "wake-repeat": case "wake-paced": {
					chunk("Done."); end();
					const gap = Number(([...modes].find(x => x.startsWith("wake-gap:")) || "wake-gap:700").slice(9));
					// Every answer chunk and tool result of a wake logs the time it was sent (`wakeFrameAt`), so a test can measure a wake's end from AGY's last frame instead of guessing with the wall clock.
					const stamp = () => record({ wakeFrameAt: Date.now() });
					const wakeChunk = t => { notify(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } }); stamp(); };
					const toolDone = (id, cmd, out) => { notify(sid, { sessionUpdate: "tool_call_update", toolCallId: id, name: "run_command", status: "completed", kind: "execute", title: cmd, rawInput: { CommandLine: cmd }, rawOutput: { output: out, exit_code: 0 }, content: [{ type: "content", content: { type: "text", text: out } }] }); stamp(); };
					const wakeRun = { cancelled: false }; wakes.current = wakeRun;
					(async () => {
						// Mode `wake-hold`: AGY stays quiet until the file `wake-go` appears next to the release file, so a test hook can make Pi busy first (a slow input or compaction handler) and AGY wakes inside it.
						while (modes.has("wake-hold") && !fs.existsSync(wakeGo)) await sleep(10);
						await sleep(40);
						record({ wakeBegan: true });
						// `wake-paced`: five frames `wake-gap` apart (700 ms unless the mode says otherwise), so a gap just under the quiet time runs through several quiet periods.
						if (scenario === "wake-paced") { for (let i = 0; i < 5; i++) { wakeChunk(`p${i} `); if (i < 4) await sleep(gap); } return; }
						// `wake-move`: AGY wakes and changes its own model; `wake-repeat`: it wakes and sends an update that only repeats the pair.
						if (scenario === "wake-move" || scenario === "wake-repeat") {
							// Mode `clear-ack`: an update that only repeats the pair comes first, between turns. Nobody asked for it, so the client stops trusting its acknowledgement before the wake starts.
							if (modes.has("clear-ack")) { notify(sid, { sessionUpdate: "config_option_update", configOptions: configOptions() }); await sleep(20); }
							wakeChunk("Working."); await sleep(10);
							notify(sid, { sessionUpdate: "config_option_update", configOptions: configOptions().map(o => scenario === "wake-move" && o.id === "model" ? { ...o, currentValue: "claude-opus-5-5" } : o) });
							notify(sid, { ...fixture.availableCommands, availableCommands: [{ name: "woke-cmd", description: "Added while AGY woke." }] });
							await sleep(10); wakeChunk(" Done."); return;
						}
						if (scenario === "wake-noise") { notify(sid, fixture.usageUpdate); notify(sid, { sessionUpdate: "config_option_update", configOptions: configOptions() }); notify(sid, fixture.availableCommands); record({ wakeNoiseSent: true }); return; }
						if (scenario === "wake-perm") {
							const toolCall = { ...fixture.permissionParams.toolCall, toolCallId: "call_wake_perm", title: "ls -1" };
							notify(sid, { sessionUpdate: "tool_call", toolCallId: "call_wake_perm", name: "run_command", status: "in_progress", kind: "execute", title: "ls -1", rawInput: { CommandLine: "ls -1" } });
							const reply = await ask("wake-perm-1", "session/request_permission", { ...fixture.permissionParams, sessionId: sid, toolCall });
							record({ wakePermissionReply: reply });
							if (reply?.outcome?.outcome === "selected" && reply.outcome.optionId === "allow") { toolDone("call_wake_perm", "ls -1", "a.txt\nb.txt"); wakeChunk("Listed the files."); }
							else wakeChunk("Not allowed.");
							return;
						}
						if (scenario === "wake-question") {
							const reply = await ask("wake-q-1", "elicitation/create", { sessionId: sid, toolCallId: "call_wake_q", mode: "form", message: "The agent has a question.", requestedSchema: { type: "object", properties: { q0: { type: "string", title: "Which colors do you like?", oneOf: [{ const: "0", title: "Red" }, { const: "1", title: "Blue" }] } } } });
							record({ wakeElicitationReply: reply });
							wakeChunk("Asked in chat.");
							return;
						}
						if (scenario === "wake-long") {
							for (let i = 0; i < 40 && !wakeRun.cancelled; i++) { wakeChunk(`long ${i} `); await sleep(60); }
							if (wakeRun.cancelled && modes.has("cancel-trails")) { await sleep(30); wakeChunk("trailing after cancel"); record({ trailingSent: true }); }
							return;
						}
						toolDone("call_wake_1", "sleep 1 && echo done", "done");
						await sleep(10); wakeChunk("Background job"); await sleep(10); wakeChunk(" finished."); await sleep(10); notify(sid, fixture.usageUpdate);
						if (scenario === "wake-two") { await sleep(gap); wakeChunk("A second thing."); }
					})();
					return;
				}
				case "late-echo": chunk("Done."); end(); setTimeout(() => { notify(sid, { sessionUpdate: "config_option_update", configOptions: configOptions().map(o => o.id === "thought_level" ? { ...o, currentValue: "medium" } : o) }); record({ lateEchoSent: true }); }, 20); return;
				case "diverge": notify(sid, { sessionUpdate: "config_option_update", configOptions: configOptions().map(o => o.id === "model" ? { ...o, currentValue: "claude-opus-5-5" } : o) }); chunk("Answered anyway."); return end();
				// Config updates no call of Pi's explains, mid-turn: one that repeats the current pair, then one that moves the model (cold review F3); a move and a move back.
				case "repeat-diverge": notify(sid, { sessionUpdate: "config_option_update", configOptions: configOptions() }); notify(sid, { sessionUpdate: "config_option_update", configOptions: configOptions().map(o => o.id === "model" ? { ...o, currentValue: "claude-opus-5-5" } : o) }); chunk("Answered anyway."); return end();
				case "repeat": notify(sid, { sessionUpdate: "config_option_update", configOptions: configOptions() }); chunk("Repeated."); return end();
				case "move-and-back": notify(sid, { sessionUpdate: "config_option_update", configOptions: configOptions().map(o => o.id === "model" ? { ...o, currentValue: "claude-opus-5-5" } : o) }); notify(sid, { sessionUpdate: "config_option_update", configOptions: configOptions() }); chunk("Moved and back."); return end();
				case "huge": for (let i = 0; i < 5; i++) chunk("h".repeat(300000)); return end();
				case "maxtokens": chunk("cut off"); return end("max_tokens");
				// A result Pi does not handle, whose name Pi's retry check takes for a transient error: a result like that, after the prompt was sent, must not start a Pi retry either (the provider writes the word apart).
				case "stop-overloaded": chunk("partial"); return end("overloaded");
				case "max-requests": chunk("cut off"); return end("max_turn_requests");
				case "refusal": return end("refusal");
				// AGY answers the prompt itself with a JSON-RPC error: the code is a number Pi's retry check takes for an HTTP status (429, 500, 503) when it is written bare in the error text.
				case "rpc-429": case "rpc-500": case "rpc-503": turn.settled = true; return error(id, Number(scenario.slice(4)));
				case "usage-update": notify(sid, fixture.usageUpdate); chunk("usage ok"); return end();
				case "unknown-id": send({ jsonrpc: "2.0", id: 9999, result: {} }); return;
				case "exit": process.exit(2); return;
				default: chunk("Hello"); usage(sid); chunk(" from"); usage(sid); chunk(" ACP."); usage(sid); return end();
			}
		}
		finally {
			if (activePrompt === turn) activePrompt = null;
		}
	}

	async function handle(m) {
		// AGY writes an echo right after its reply, long before Pi sends anything else; wait out echoes in flight before taking the next call.
		if (m.method === "session/set_config_option" || m.method === "session/prompt") while (echoTimers > 0) await sleep(1);
		if (m.method === undefined) { const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m.error ? { error: m.error } : m.result); } return; }
		switch (m.method) {
			case "initialize": {
				const r = JSON.parse(JSON.stringify(fixture.initialize));
				if (modes.has("no-resume")) delete r.agentCapabilities.sessionCapabilities.resume;
				if (modes.has("no-close")) delete r.agentCapabilities.sessionCapabilities.close;
				if (modes.has("old-protocol")) r.protocolVersion = 2;
				return result(m.id, r);
			}
			case "session/new": {
				if (modes.has("signin-fails")) return send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "Authentication required: please sign in to Antigravity" } });
				if (modes.has("new-fails")) return error(m.id, -32000);
				state.sessionId = "fake-acp-" + process.pid;
				result(m.id, { ...fixture.sessionNew, sessionId: state.sessionId, configOptions: configOptions() });
				usage(state.sessionId);
				if (modes.has("replay-tools")) notify(state.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "replayed_1", name: "run_command", status: "completed", kind: "execute", title: "ls -1", rawInput: { CommandLine: "ls -1" }, rawOutput: { output: "old\n", exit_code: 0 } });
				if (!modes.has("no-commands")) setTimeout(() => notify(state.sessionId, commandsUpdate()), 80);
				return;
			}
			case "session/resume": {
				if (modes.has("signin-fails")) return send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "Authentication required: please sign in to Antigravity" } });
				if (modes.has("resume-fails")) return error(m.id, -32000);
				state.sessionId = modes.has("resume-wrong-id") ? "some-other-session" : m.params.sessionId;
				// A fresh process holds the defaults again, whatever the earlier process had set.
				result(m.id, { ...fixture.sessionNew, sessionId: state.sessionId, configOptions: configOptions() });
				usage(state.sessionId);
				if (modes.has("replay-tools")) notify(state.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "replayed_1", name: "run_command", status: "completed", kind: "execute", title: "ls -1", rawInput: { CommandLine: "ls -1" }, rawOutput: { output: "old\n", exit_code: 0 } });
				if (!modes.has("no-commands")) setTimeout(() => notify(state.sessionId, commandsUpdate()), 80);
				return;
			}
			case "session/set_config_option": {
				const { configId, value, sessionId } = m.params, isModel = configId === "model";
				if (modes.has("effort-fails") && configId === "thought_level") return error(m.id, -32000);
				if (m114 && configId === "model") { if (!LEVELS114[value]) return error(m.id, -32602); state.model = value; const offered = LEVELS114[value]; if (offered.length && !offered.includes(state.thought_level)) state.thought_level = offered.at(-1); }
				else if (m114 && configId === "thought_level") { const offered = LEVELS114[state.model]; if (!offered.length) return error(m.id, -32602); state.thought_level = offered.includes(value) ? value : offered.at(-1); }
				else if (!modes.has("wrong-ack") && (configId === "model" || configId === "thought_level")) state[configId] = value;
				if (modes.has("wrong-effort") && configId === "thought_level") state.thought_level = "low";
				const snapshot = configOptions();
				const echo = () => notify(sessionId, { sessionUpdate: "config_option_update", configOptions: snapshot });
				const reply = () => { result(m.id, { configOptions: snapshot }); usage(sessionId); };
				// The recorded order: the model echo, still showing the old thinking level, lands after the effort call and before its reply.
				const recorded = () => {
					if (isModel) { reply(); pendingModelEcho = echo; later(() => { if (pendingModelEcho) { pendingModelEcho(); pendingModelEcho = null; } }, 2); }
					else { if (pendingModelEcho) { pendingModelEcho(); pendingModelEcho = null; } reply(); later(echo, 5); }
				};
				const go = () => {
					// echo:before-reply is a one-time anomaly of the first model call; every later call behaves as recorded.
					const anomaly = echoMode === "before-reply" && isModel && !beforeReplyDone;
					if (anomaly) beforeReplyDone = true;
					switch (echoMode === "before-reply" && !anomaly ? "recorded" : echoMode) {
						case "before-reply": if (isModel) { echo(); reply(); } else { reply(); later(echo, 5); } return;
						case "after-replies": reply(); later(echo, 8); return;
						case "after-prompt": reply(); heldEchoes.push(echo); return;
						case "effort-after-prompt": reply(); if (isModel) { pendingModelEcho = echo; later(() => { if (pendingModelEcho) { pendingModelEcho(); pendingModelEcho = null; } }, 2); } else heldEchoes.push(echo); return;
						case "none": reply(); return;
						case "missing-model": reply(); if (!isModel) later(echo, 5); return;
						case "same-chunk": {
							if (echoArg !== "all" && echoArg !== configId) return recorded(); // the other call keeps the recorded order
							if (pendingModelEcho) { pendingModelEcho(); pendingModelEcho = null; } // an echo owed to an earlier call goes first
							const frames = [{ jsonrpc: "2.0", id: m.id, result: { configOptions: snapshot } }, { jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "config_option_update", configOptions: snapshot } } }];
							for (const f of frames) record({ out: shrink(f) });
							write(frames.map(f => JSON.stringify(f) + "\n").join(""));
							usage(sessionId);
							return;
						}
						default: return recorded();
					}
				};
				if (modes.has("hold-set")) { (async () => { while (!fs.existsSync(cfg.release)) await sleep(5); if (modes.has("die-on-release")) process.exit(2); go(); })(); return; } // replies wait for the release file; die-on-release: AGY dies instead of answering
				if (slowSet > 0) setTimeout(go, slowSet); else go();
				return;
			}
			case "session/prompt": return void prompt(m.id, m.params).catch(() => { });
			// AGY 1.5.10 stops the session's subagents and background tasks on session/close, also when no prompt is running; the fake only logs the request (the {in} row) and answers it as the modes say.
			case "session/close": {
				if (modes.has("close-no-reply")) return;
				if (modes.has("close-error")) return error(m.id, -32000);
				if (modes.has("close-asks-permission")) { // AGY still talks while it answers: the request lands first, the reply 50 ms later
					ask("late-1", "session/request_permission", { ...fixture.permissionParams, sessionId: m.params.sessionId }).then(r => record({ latePermissionReply: r }));
					return void setTimeout(() => result(m.id, {}), 50);
				}
				if (modes.has("close-ends-turn") && activePrompt && !activePrompt.settled) {
					const current = activePrompt;
					current.settled = true;
					activePrompt = null;
					current.onCancel?.();
					result(current.id, { stopReason: "cancelled", usage: fixture.usage });
				}
				return result(m.id, {});
			}
			case "session/cancel": {
				if (!activePrompt || activePrompt.settled) { record({ cancelWithNoPrompt: true }); if (wakes.current) wakes.current.cancelled = true; }
				if (activePrompt && !activePrompt.settled) {
					activePrompt.cancelled = true;
					if (!modes.has("cancel-timeout")) {
						const current = activePrompt;
						current.onCancel?.();
						if (!current.settled) {
							current.settled = true;
							activePrompt = null;
							result(current.id, { stopReason: "cancelled", usage: fixture.usage });
						}
					}
				}
				return;
			}
			default: return error(m.id, -32601);
		}
	}

	let buf = "";
	process.stdin.on("data", d => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(line); record({ in: shrink(m) }); handle(m); }
	});
	process.stdin.on("end", () => { record({ eof: true }); if (modes.has("ignore-eof")) setInterval(() => { }, 1000); else process.exit(0); });
	if (modes.has("ignore-term")) process.on("SIGTERM", () => record({ ignored: "SIGTERM" }));
};
