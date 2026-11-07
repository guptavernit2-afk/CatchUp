import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeConversation, parseConversation } from '../engine.js';
import { localRuntime } from '../local-runtime.js';
import { validateAnalysis } from '../evidence.js';
import { livePlan, redact, evaluateLive } from './live-audit-utils.mjs';
import { longScenarios } from './live-long-scenarios.mjs';
import { compareScenario } from './quality-checks.mjs';

test('live audits default to preflight and reject unbounded request counts', () => {
  assert.equal(livePlan([]).run, false); assert.equal(livePlan([]).scenarios.length, 5);
  assert.throws(() => livePlan(['--limit','9999']), /limit/);
});
test('live report redaction removes credential values without logging them', () => {
  assert.equal(redact({ error: 'fake-secret-key' }, 'fake-secret-key').includes('fake-secret-key'), false);
});
test('malformed local model selections remain visible as audit errors', () => {
  const scenario = livePlan([]).scenarios[0], messages = parseConversation(scenario.chat);
  const result = { action_items: [], decisions: [], open_questions: [], needs_you: [], summary_points: [] };
  const evaluation = evaluateLive(scenario, messages, result, '{"summary_ids":"invalid"}', 'local');
  assert.equal(evaluation.modelFormatIssues.length, 1);
});
test('raw model errors are reported separately from a corrected final result', async () => {
  const scenario = livePlan([]).scenarios[0], messages = parseConversation(scenario.chat);
  const result = await analyzeConversation(messages, null, null, { mode: 'heuristic' });
  const evaluation = evaluateLive(scenario, messages, result, JSON.stringify({ action_items: [{ quote: messages[0].text, source_id: 'msg_01', owner: 'Wrong person' }] }), 'gemini');
  assert.ok(evaluation.modelOnlyIssues.some(issue => issue.category === 'task-owner'));
  assert.deepEqual(evaluation.finalPipelineIssues, []);
});

test('greetings are excluded from briefings but meaningful messages beginning with thanks survive', () => {
  const messages = parseConversation('Alice: Good morning.\nBob: Thanks.\nCarol: Thanks. I will send the invoice.');
  const result = validateAnalysis({ summary_points: messages.map(message => ({ quote: message.text, source_id: message.id })) }, messages);
  assert.deepEqual(result.summary_points, [messages[2].text]);
});
test('a cloud greeting-only summary becomes a labelled factual rule briefing', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"summary_points":[{"quote":"Good morning.","source_id":"msg_02"}]}' } }] }) });
  const scenario = livePlan([]).scenarios[0];
  const result = await analyzeConversation(parseConversation(scenario.chat), null, null, { mode: 'cloud', apiProvider: 'openai', apiKey: 'test-only-key' });
  assert.ok(result.notice.includes('Instant Rules'));
  assert.ok(!result.summary_points.some(point => point === 'Good morning.'));
  assert.deepEqual(compareScenario(scenario, result), []);
});

for (const scenario of longScenarios) {
  test(`local candidate pool preserves sparse source IDs: ${scenario.id}`, async t => {
    const original = localRuntime.run; t.after(() => { localRuntime.run = original; });
    let supplied = '';
    const ids = [...scenario.tasks.map(task => task[0]), ...scenario.decisions, ...scenario.questions].map(index => `msg_${String(index).padStart(2,'0')}`);
    localRuntime.run = async prompts => {
      supplied = prompts[1].content;
      return { choices: [{ message: { content: JSON.stringify({ summary_ids: ids }) } }] };
    };
    const result = await analyzeConversation(parseConversation(scenario.chat), null, null, { mode: 'local' });
    assert.deepEqual(compareScenario(scenario, result), []);
    assert.equal(result.notice, undefined);
    assert.equal([...supplied.matchAll(/^\[msg_/gm)].length, 4);
    assert.ok(!supplied.includes('coffee machine'));
  });
}
for (const [label, ids] of [['unseen candidate ID', ['msg_02']], ['incomplete factual selection', ['msg_14']]]) {
  test(`local briefing coverage rejects ${label}`, async t => {
    const original = localRuntime.run; t.after(() => { localRuntime.run = original; });
    localRuntime.run = async () => ({ choices: [{ message: { content: JSON.stringify({ summary_ids: ids }) } }] });
    const scenario = longScenarios[0];
    const result = await analyzeConversation(parseConversation(scenario.chat), null, null, { mode: 'local' });
    assert.ok(result.notice.includes('Instant Rules'));
    assert.deepEqual(compareScenario(scenario, result), []);
  });
}
test('a larger selection must cover a decision category instead of only tasks', async t => {
  const original = localRuntime.run; t.after(() => { localRuntime.run = original; });
  localRuntime.run = async () => ({ choices: [{ message: { content: '{"summary_ids":["msg_01","msg_02","msg_03","msg_04"]}' } }] });
  const chat = Array.from({length:5}, (_, i) => `Person${i}: I will review document ${i} tomorrow.`).join('\n') + '\nLead: We decided to use PostgreSQL.';
  const result = await analyzeConversation(parseConversation(chat), null, null, { mode: 'local' });
  assert.ok(result.notice.includes('Instant Rules'));
  assert.ok(result.summary_points.some(point => point.includes('PostgreSQL')));
});
