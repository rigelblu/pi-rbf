#!/usr/bin/env node
// Offline delivery boundary: never delegates to a real AGY executable.
const fs = require('node:fs'), readline = require('node:readline'), crypto = require('node:crypto'), path = require('node:path');
const root = process.env.PI214_OFFLINE_ROOT;
if (!root || !path.isAbsolute(root)) throw Error('PI214_OFFLINE_ROOT required');
const args = process.argv.slice(2), record = value => fs.appendFileSync(path.join(root, 'native.jsonl'), JSON.stringify(value) + '\n');
record({ event: 'launch', args });
if (args[0] === '--version') { console.log('1.4.12'); process.exit(0); }
if (args[0] === 'models') { console.log('gemini-3.8-flash-low\tGemini 3.8 Flash (Low)'); process.exit(0); }
const file = path.join(root, 'native-state.json'), requested = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : undefined;
let state = requested && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
if (state?.cid !== requested) state = null;
state ??= { cid: crypto.randomUUID(), count: 0, step: 0, nonce: '' };
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
emit({ event: 'init', conversation_id: state.cid, init: { model: args[args.indexOf('--model') + 1], cwd: process.cwd(), tools: [], permission_mode: 'request-review' } });
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
	const request = JSON.parse(line); record({ event: 'input', request, cid: state.cid });
	const text = request.message.content, marker = text.match(/MAPLE-[A-Z0-9]+/);
	if (marker) state.nonce = marker[0];
	emit({ event: 'step_update', step_update: { conversation_id: state.cid, step_index: state.step++, step_type: 'user_input', state: 'DONE' } });
	state.count++;
	const response = 'OFFLINE_ANSWER_' + state.count + ' ' + state.nonce;
	emit({ event: 'step_update', step_update: { conversation_id: state.cid, step_index: state.step++, step_type: 'agent_response', state: 'DONE', text_delta: response } });
	fs.writeFileSync(file, JSON.stringify(state));
	emit({ event: 'result', result: { conversation_id: state.cid, status: 'SUCCESS', response, num_turns: state.count, duration_seconds: state.count, usage: { input_tokens: state.count * 10, output_tokens: state.count, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: state.count * 11 } } });
});
input.on('close', () => { record({ event: 'eof' }); process.exit(0); });
process.on('SIGINT', () => process.exit(0));
