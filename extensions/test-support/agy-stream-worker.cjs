// Offline AGY wire peer. Loaded only by the test factory; never calls a model.
const fs = require('node:fs'), readline = require('node:readline');
const record = data => fs.appendFileSync(FIXTURE_LOG, JSON.stringify({ at: Date.now(), ...data }) + '\n');
const emit = value => {
 const bytes = Buffer.from(JSON.stringify(value) + '\n');
 if (FIXTURE_SCENARIO === 'split') {
  const at = bytes.indexOf(Buffer.from('😀'));
  if (at >= 0) { process.stdout.write(bytes.subarray(0, at + 1)); process.stdout.write(bytes.subarray(at + 1)); return; }
 }
 process.stdout.write(bytes);
};
const args = process.argv.slice(2);
record({ args });
if (args[0] === 'models') { console.log(['low','medium','high'].map(x => `gemini-3.8-flash-${x}\tFlash (${x})`).join('\n')); process.exit(0); }
if (args[0] === '--version') { console.log('1.4.12'); process.exit(0); }
const cid = 'offline-stream-' + process.pid;
let count = 0, index = 0, active = false, timer;
let scenario = FIXTURE_SCENARIO;
const step = data => emit({ event: 'step_update', step_update: { conversation_id: cid, ...data } });
const result = (status, response, error) => {
 record({ terminal: status });
 emit({ event: 'result', result: { conversation_id: cid, status, response, error, num_turns: count, duration_seconds: 0,
  usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 },
  ...(scenario === 'denial' ? { denied_actions: [{ action: 'write_file', display_name: 'EditFile' }] } : {}) } });
};
emit({ event: 'init', conversation_id: cid, init: { model: args[args.indexOf('--model') + 1], cwd: process.cwd(), tools: [], permission_mode: 'default' } });
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
 const input = JSON.parse(line); record({ input }); active = true; count++;
 scenario = FIXTURE_SCENARIO === 'interactive' ? ({ short:'short', empty:'empty', long:'long', error:'error', cancel:'cancel' }[input.message.content] ?? 'normal') : FIXTURE_SCENARIO;
 step({ step_type: 'user_input', state: 'DONE', step_index: index++ });
 const answerIndex = index++;
 const response = (text_delta, state = 'ACTIVE') => step({ step_type: 'agent_response', state, step_index: answerIndex, ...(text_delta === undefined ? {} : { text_delta }) });
 if (!scenario.startsWith('no-preview')) {
  if (scenario === 'split') {
   for (const part of ['safe\u001b', '[31mred', '\u001b]52;c;secret', '\u0007 ', '\ud83d', '\ude00', ' café\u202e!']) response(part);
  } else response(scenario === 'unicode-cap' ? 'x'.repeat(128 * 1024 - 1) + '😀tail' : scenario === 'long' || scenario === 'capped-error' ? 'x'.repeat(180 * 1024) : ['short','empty','same','denial'].includes(scenario) ? 'old long preview' : 'alpha');
  step({ step_type: 'tool', state: 'DONE', step_index: index++, tool_name: 'run_command', tool_info: { name: 'run_command', output: 'TOOL-ONLY\u001b[2J' } });
 }
 record({ preview: true });
 timer = setTimeout(() => {
  if (scenario === 'cancel' || scenario === 'no-preview-cancel') return;
  if (scenario === 'malformed' || scenario === 'no-preview-malformed') { process.stdout.write('invalid-json\n'); return; }
  if (scenario === 'eof' || scenario === 'no-preview-eof') { process.stdout.end(); return; }
  if (scenario === 'oversize-frame') { process.stdout.write(Buffer.alloc(1024 * 1024 + 1, 65)); return; }
  if (scenario === 'oversize-request') { for (let n=0;n<12;n++) response('z'.repeat(200 * 1024)); return; }
  if (scenario === 'late') { record({lateResponse:'STALE'}); response('STALE'); active = false; result('SUCCESS','STALE'); process.stdout.write('', () => process.exit(0)); return; }
  const errors = ['error','no-preview-error','capped-error'];
  if (errors.includes(scenario)) { active = false; result('ERROR',undefined,'Native permission refused'); return; }
  if (scenario === 'normal') response(' beta','DONE');
  else response(undefined,'DONE');
  const answer = scenario === 'short' ? 'new' : scenario === 'empty' || scenario === 'denial' ? '' : scenario === 'same' ? 'old long preview' : scenario === 'long' ? 'L'.repeat(256 * 1024) : scenario === 'split' ? 'safe\u001b[31mred\u001b]52;c;secret\u0007 😀 café\u202e!' : 'alpha beta';
  active = false; result('SUCCESS',answer);
 }, FIXTURE_HOLD_MS);
});
rl.on('close', () => { clearTimeout(timer); record({ eof: true }); process.exit(0); });
process.on('SIGINT', () => {
 record({ signal: 'SIGINT' });
 if (scenario === 'late') return;
 clearTimeout(timer);
 if (active) { active = false; result('ERROR',undefined,'interrupted'); }
 process.stdout.write('', () => process.exit(1));
});
process.stdout.on('error', () => process.exit(2));
