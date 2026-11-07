import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRuntime, localRuntime } from '../local-runtime.js';
import { analyzeConversation, parseConversation } from '../engine.js';
import { extractDeterministicFindings } from '../heuristics.js';
import { validateAnalysis } from '../evidence.js';
import { generateMarkdown } from '../report.js';

const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ reload = async () => {}, unload, cleanupTimeoutMs = 5000, generate = async () => ({ choices: [{ message: { content: '{"summary_ids":["msg_01"]}' } }] }) } = {}) {
  const workers = [], calls = [];
  let reloads = 0;
  class FakeWorker extends EventTarget { terminated = false; terminate() { this.terminated = true; } }
  class FakeEngine {
    constructor(worker, options) { this.worker = worker; this.options = options; if (unload) this.unload = () => unload(worker); }
    async reload() { this.options.initProgressCallback({ text: 'Loading weights', progress: .5 }); return reload(++reloads); }
    chat = { completions: { create: async options => { calls.push(options); return generate(options); } } };
  }
  const runtime = createLocalRuntime({ loadLibrary: async () => ({ WebWorkerMLCEngine: FakeEngine }), createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; }, cleanupTimeoutMs });
  return { runtime, workers, calls, reloads: () => reloads };
}

test('local runtime reuses the loaded worker and reports loading separately from inference', async () => {
  const f = fixture(), first = [], second = [];
  await f.runtime.run([], info => first.push(info.stage));
  await f.runtime.run([], info => second.push(info.stage));
  assert.equal(f.reloads(), 1);
  assert.equal(f.workers.length, 1);
  assert.ok(first.includes('loading'));
  assert.deepEqual(second, ['inference']);
  assert.equal(f.calls[0].max_tokens, 128);
  assert.equal(f.calls[0].response_format.type, 'json_object');
  assert.equal(typeof f.calls[0].response_format.schema, 'string', 'WebLLM requires a serialized schema for this model');
  assert.deepEqual(JSON.parse(f.calls[0].response_format.schema).required, ['summary_ids']);
});
test('cancel during loading terminates the worker and allows a clean retry', async () => {
  const loading = defer();
  const f = fixture({ reload: count => count === 1 ? loading.promise : Promise.resolve() });
  const controller = new AbortController();
  const pending = f.runtime.run([], null, { signal: controller.signal });
  await tick(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.workers[0].terminated, true);
  assert.equal(f.runtime.isReady(), false);
  await f.runtime.run([]);
  loading.resolve(); await tick();
  assert.equal(f.runtime.isReady(), true, 'An old cancelled load cannot clear the replacement engine');
  assert.equal(f.workers.length, 2);
});
test('cancel during inference cannot return a stale result after a new run', async () => {
  const generation = defer(); let count = 0;
  const f = fixture({ generate: () => ++count === 1 ? generation.promise : Promise.resolve({ fresh: true }) });
  const controller = new AbortController();
  const pending = f.runtime.run([], null, { signal: controller.signal });
  await tick(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.workers[0].terminated, true);
  assert.deepEqual(await f.runtime.run([]), { fresh: true });
  generation.resolve({ stale: true }); await tick();
  assert.equal(f.runtime.isReady(), true);
});
test('cancel returns immediately but a replacement waits for orderly GPU unload', async () => {
  const generation = defer(), release = defer(); let count = 0;
  const f = fixture({ generate: () => ++count === 1 ? generation.promise : Promise.resolve({ fresh: true }), unload: () => release.promise });
  const controller = new AbortController(); const first = f.runtime.run([], null, { signal: controller.signal }); await tick(); controller.abort();
  await assert.rejects(first, { name: 'AbortError' }); assert.equal(f.workers[0].terminated, false);
  const next = f.runtime.run([]); await tick(); assert.equal(f.workers.length, 1);
  release.resolve(); assert.deepEqual(await next, { fresh: true }); assert.equal(f.workers[0].terminated, true);
});
test('cancelling while an old worker unloads does not create a late replacement', async () => {
  const generation = defer(), release = defer(); const f = fixture({ generate: () => generation.promise, unload: () => release.promise });
  const firstController = new AbortController(); const first = f.runtime.run([], null, { signal: firstController.signal }); await tick(); firstController.abort(); await assert.rejects(first, { name: 'AbortError' });
  const secondController = new AbortController(); const second = f.runtime.run([], null, { signal: secondController.signal }); await tick(); secondController.abort(); await assert.rejects(second, { name: 'AbortError' });
  release.resolve(); await tick(); assert.equal(f.workers.length, 1);
});
test('an unresponsive unload still terminates the worker after its cleanup deadline', async () => {
  const f = fixture({ generate: () => new Promise(() => {}), unload: () => new Promise(() => {}), cleanupTimeoutMs: 20 });
  const controller = new AbortController(); const first = f.runtime.run([], null, { signal: controller.signal }); await tick(); controller.abort(); await assert.rejects(first, { name: 'AbortError' });
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(f.workers[0].terminated, true);
});
test('cancelling before the library loads never creates a late worker', async () => {
  const library = defer(); let created = 0;
  const runtime = createLocalRuntime({ loadLibrary: () => library.promise, createWorker: () => { created++; } });
  const controller = new AbortController();
  const pending = runtime.run([], null, { signal: controller.signal });
  await tick(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  library.resolve({}); await tick();
  assert.equal(created, 0);
});
test('a pre-aborted request performs no model work', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.runtime.run([], null, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.workers.length, 0);
});
test('local loading timeout terminates GPU resources', async () => {
  const f = fixture({ reload: () => new Promise(() => {}) });
  await assert.rejects(f.runtime.run([], null, { loadTimeoutMs: 20 }), /loading timed out/);
  assert.equal(f.workers[0].terminated, true);
  assert.equal(f.runtime.isReady(), false);
});
test('local inference timeout terminates the worker', async () => {
  const f = fixture({ generate: () => new Promise(() => {}) });
  await assert.rejects(f.runtime.run([], null, { inferenceTimeoutMs: 20 }), /analysis timed out/);
  assert.equal(f.workers[0].terminated, true);
});
test('worker startup failure is actionable and retryable', async () => {
  let count = 0;
  const f = fixture({ reload: async () => { if (++count === 1) throw new Error('GPU allocation failed'); } });
  await assert.rejects(f.runtime.run([]), /GPU allocation failed/);
  assert.equal(f.workers[0].terminated, true);
  await f.runtime.run([]);
  assert.equal(f.runtime.isReady(), true);
});
test('non-Error worker failures have a useful recovery message', async () => {
  const f = fixture({ generate: () => Promise.reject('worker failed') });
  await assert.rejects(f.runtime.run([]), /Retry or choose Instant Rules/);
  assert.equal(f.workers[0].terminated, true);
});
test('worker errors fail immediately instead of waiting for the loading timeout', async () => {
  const f = fixture({ reload: () => new Promise(() => {}) });
  const pending = f.runtime.run([]); await tick();
  const check = assert.rejects(pending, /worker stopped/);
  f.workers[0].dispatchEvent(new Event('error'));
  await check;
  assert.equal(f.workers[0].terminated, true);
});
test('overlapping local analyses are rejected without interrupting the first run', async () => {
  const generation = defer(); const f = fixture({ generate: () => generation.promise });
  const first = f.runtime.run([]); await tick();
  await assert.rejects(f.runtime.run([]), /already running/);
  generation.resolve({ success: true }); assert.deepEqual(await first, { success: true });
});
test('large local inputs fail before loading a model', async () => {
  const messages = Array.from({ length: 201 }, (_, index) => ({ id: `msg_${index}`, sender: 'Alice', text: 'Hello.' }));
  await assert.rejects(analyzeConversation(messages), /exceeds the local model limit/);
});
test('local source selection validates IDs, copies exact text, and shares task status policy', async t => {
  const original = localRuntime.run; t.after(() => { localRuntime.run = original; });
  localRuntime.run = async () => ({ choices: [{ message: { content: '{"summary_ids":["unknown","msg_01","msg_01","msg_02"]}' } }] });
  const messages = parseConversation('Alice: @Bob please review the release checklist.\nBob: I will prepare the demo.');
  const local = await analyzeConversation(messages);
  assert.deepEqual(local.summary_points, messages.map(message => message.text));
  assert.deepEqual(local.action_items, (await analyzeConversation(messages, null, null, { mode: 'heuristic' })).action_items);
});
test('invalid local selections use a labelled rule briefing', async t => {
  const original = localRuntime.run; t.after(() => { localRuntime.run = original; });
  localRuntime.run = async () => ({ choices: [{ message: { content: 'invalid model response' } }] });
  const result = await analyzeConversation(parseConversation('Alice: I will ship the report.\nBob: Thanks.'));
  assert.ok(result.notice.includes('Instant Rules'));
  assert.ok(result.summary_points.length);
  assert.ok(generateMarkdown(result).includes('Processing note:'));
});
test('a local selection of only a bare acknowledgement uses a labelled contextual briefing', async t => {
  const original = localRuntime.run; t.after(() => { localRuntime.run = original; });
  localRuntime.run = async () => ({ choices: [{ message: { content: '{"summary_ids":["msg_02"]}' } }] });
  const result = await analyzeConversation(parseConversation('Alice: Let’s use PostgreSQL.\nBob: Agreed.'));
  assert.ok(result.notice.includes('Instant Rules'));
  assert.ok(result.summary_points.some(point => point.includes('PostgreSQL')));
});
test('cloud cancellation aborts its fetch and is not misreported as a timeout', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let aborted = false;
  globalThis.fetch = (_, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }));
  const controller = new AbortController();
  const pending = analyzeConversation(parseConversation('Alice: I will ship.\nBob: Thanks.'), null, null, { mode: 'cloud', apiProvider: 'openai', apiKey: 'fake-key', signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(aborted, true);
});

const rules = chat => extractDeterministicFindings(parseConversation(chat));
test('an explicit unaccepted request has requested status and the named owner', () => {
  const task = rules('Alice: @Bob please review the release checklist.\nCarol: Good morning.').fallbackActions[0];
  assert.equal(task.owner, 'Bob'); assert.equal(task.status, 'requested'); assert.equal(task.confirmation, undefined);
});
test('acceptance confirms the original request with a second source reference', () => {
  const tasks = rules('Alice: Bob, can you review the release checklist?\nBob: Sure, I will review the release checklist.').fallbackActions;
  assert.equal(tasks.length, 1); assert.equal(tasks[0].status, 'confirmed');
  assert.equal(tasks[0].source_id, 'msg_01'); assert.equal(tasks[0].confirmation.source_id, 'msg_02');
});
test('a different person’s acknowledgement cannot confirm a requested task', () => {
  const task = rules('Alice: @Bob please review the release checklist.\nCharlie: Sure.').fallbackActions[0];
  assert.equal(task.owner, 'Bob'); assert.equal(task.status, 'requested');
});
test('a later substantive acceptance confirms the matching request, without duplicates', () => {
  const tasks = rules('Alice: Bob, can you review the release checklist?\nCarol: Good morning.\nDave: The demo passed.\nBob: I will review the release checklist.').fallbackActions;
  assert.equal(tasks.length, 1); assert.equal(tasks[0].status, 'confirmed'); assert.equal(tasks[0].confirmation.source_id, 'msg_04');
});
test('an unrelated later promise does not confirm an earlier request', () => {
  const tasks = rules('Alice: Bob, can you review artifact number 1?\nCarol: Good morning.\nBob: I will review artifact number 10.').fallbackActions;
  assert.equal(tasks[0].status, 'requested'); assert.equal(tasks[1].status, 'confirmed');
});
test('all modes use the same task ownership, status, text and confirmation evidence', async t => {
  const chat = 'Alice: @Bob please review the release checklist.\nBob: I will prepare the demo.';
  const messages = parseConversation(chat), expected = await analyzeConversation(messages, null, null, { mode: 'heuristic' });
  assert.deepEqual(expected.action_items.map(task => task.status), ['requested', 'confirmed']);
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ action_items: [{ quote: messages[0].text, source_id: 'msg_01', owner: 'Invented', status: 'confirmed' }] }) } }] }) });
  const cloud = await analyzeConversation(messages, null, null, { mode: 'cloud', apiProvider: 'openai', apiKey: 'fake-key' });
  assert.deepEqual(cloud.action_items, expected.action_items);
});
test('a bare agreement retains the full proposal and both messages', () => {
  const decisions = rules('Alice: Let’s keep it simple for now. Vanilla JS unless we hit a wall.\nBob: Agreed.').fallbackDecisions;
  assert.equal(decisions.length, 1); assert.ok(decisions[0].text.includes('Vanilla JS'));
  assert.equal(decisions[0].source_id, 'msg_01'); assert.equal(decisions[0].confirmation.source_id, 'msg_02');
});
test('an immediate promise about another task does not accept the original request', () => {
  const tasks = rules('Alice: @Bob please review the release checklist.\nBob: I will prepare the demo.').fallbackActions;
  assert.deepEqual(tasks.map(task => task.status), ['requested', 'confirmed']);
});
test('short task identifiers such as PR still match a substantive acceptance', () => {
  const tasks = rules('Alice: Bob, can you review the PR?\nBob: I will review the PR.').fallbackActions;
  assert.equal(tasks.length, 1); assert.equal(tasks[0].status, 'confirmed');
});
test('merging acceptance does not discard another promise in the same reply', () => {
  const tasks = rules('Alice: Bob, can you review the release checklist?\nBob: I will review the release checklist. I will prepare the demo.').fallbackActions;
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].confirmation.source_id, 'msg_02');
  assert.equal(tasks[1].quote, 'I will prepare the demo.');
});
test('conditional work is not presented as an unconditional commitment', () => {
  assert.deepEqual(rules('Alice: I will deploy if the tests pass.\nBob: Great.').fallbackActions, []);
});
test('an agreement without a recoverable proposal is not displayed as a decision', () => {
  assert.deepEqual(rules('Alice: Good morning.\nBob: Agreed.').fallbackDecisions, []);
});
test('an ambiguous alternative question is not resolved into an invented choice', () => {
  assert.deepEqual(rules('Alice: Should we use React or Vanilla JS?\nBob: Agreed.').fallbackDecisions, []);
});
test('agreement does not attach itself to a stale proposal across another topic', () => {
  assert.deepEqual(rules('Alice: We should use PostgreSQL.\nCarol: I will book lunch.\nBob: Agreed.').fallbackDecisions, []);
});
test('model decision fragments cannot discard the validated proposal context', () => {
  const messages = parseConversation('Alice: Let’s keep it simple for now. Vanilla JS unless we hit a wall.\nBob: Agreed.');
  const result = validateAnalysis({ decisions: [{ quote: 'Let’s keep it simple for now.', source_id: 'msg_01' }] }, messages);
  assert.ok(result.decisions[0].text.includes('Vanilla JS')); assert.equal(result.decisions[0].confirmation.source_id, 'msg_02');
});
test('exports distinguish requests from commitments and include agreement evidence', async () => {
  const result = await analyzeConversation(parseConversation('Alice: @Bob please review the release checklist.\nCarol: Let’s use PostgreSQL.\nDave: Agreed.'), null, null, { mode: 'heuristic' });
  const markdown = generateMarkdown(result);
  assert.ok(markdown.includes('· Requested')); assert.ok(markdown.includes('PostgreSQL')); assert.ok(markdown.includes('Agreement: "Agreed." (msg_03)'));
});
