import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeConversation, parseConversation } from '../engine.js';
import { localRuntime } from '../local-runtime.js';
import { validateAnalysis } from '../evidence.js';
import { qualityCorpus } from './quality-corpus.mjs';
import { compareScenario, formats } from './quality-checks.mjs';

const nameSets = {
  original: {},
  indian: { Alice: 'Ananya', Bob: 'Karthik', Carol: 'Ishaan' },
  fullNames: { Alice: 'Priya Shah', Bob: 'Mary-Jane', Carol: 'José', 'Mary-Jane': 'Sam Lee', José: "O'Connor" },
  smartUnicode: { Alice: 'O’Connor', Bob: 'D’Arcy', Carol: 'Renée', José: '李明', 'Mary-Jane': 'Jean-Luc' }
};
function renamed(scenario, names) {
  const pattern = new RegExp(Object.keys(names).join('|') || '(?!)', 'g');
  const replace = value => typeof value === 'string' ? value.replace(pattern, name => names[name]) : value;
  return { ...scenario, chat: replace(scenario.chat), target: replace(scenario.target),
    tasks: scenario.tasks.map(([source, owner, status, quote]) => [source, replace(owner), status, replace(quote)]) };
}

for (const [label, chat, completed] of [
  ['another speaker cannot complete my task', 'Alice: I will review the release checklist.\nBob: Done.', false],
  ['a distant bare done is not linked to an old task', 'Alice: I will review the release checklist.\nBob: Good morning.\nAlice: Done.', false],
  ['quoted withdrawal does not cancel a task', 'Alice: I will send the invoice.\nAlice: The template says "I will not send the invoice".', false],
  ['conditional withdrawal does not cancel a firm task', "Alice: I will send the invoice.\nAlice: If the customer cancels, I won't send the invoice.", false],
  ['explicit matching completion marks the task done', 'Alice: I will review the release checklist.\nAlice: I have completed the release checklist.', true],
  ['not completed does not mark a task done', 'Alice: I will review the release checklist.\nAlice: I have not completed the release checklist.', false]
]) {
  test(`quality state safety: ${label}`, async () => {
    const result = await analyzeConversation(parseConversation(chat), null, null, { mode: 'heuristic' });
    assert.equal(result.action_items.length, 1);
    assert.equal(Boolean(result.action_items[0].completed), completed);
    if (completed) assert.ok(result.summary_points.join(' ').includes('completed'));
  });
}
test('briefing lists multiple tasks per owner and labels omitted items explicitly', async () => {
  const chat = Array.from({ length: 10 }, (_, index) => `Alice: I will review document ${index + 1} tomorrow.`).join('\n');
  const result = await analyzeConversation(parseConversation(chat), null, null, { mode: 'heuristic' });
  assert.equal(result.action_items.length, 10);
  const summary = result.summary_points.join(' ');
  assert.ok(summary.includes('10 confirmed'));
  assert.ok(summary.includes('document 1 tomorrow'));
  assert.ok(summary.includes('document 6 tomorrow'));
  assert.ok(summary.includes('+4 more'));
});
test('1000-message internal analysis retains every independent task and its source', async () => {
  const chat = Array.from({ length: 1000 }, (_, index) => `Person${index}: I will review document ${index + 1} tomorrow.`).join('\n');
  const messages = parseConversation(chat);
  const result = await analyzeConversation(messages, null, null, { mode: 'heuristic' });
  assert.equal(result.action_items.length, 1000);
  assert.equal(result.action_items[999].owner, 'Person999');
  provenance(result, messages);
});
test('direct agreement answers a proposed schedule, but not an information question', async () => {
  const schedule = await analyzeConversation(parseConversation('Alice: We ship on Friday, right?\nBob: Sounds good to me'), null, null, { mode: 'heuristic' });
  assert.equal(schedule.open_questions.length, 0);
  const information = await analyzeConversation(parseConversation('Alice: Where is the release checklist?\nBob: Sounds good to me'), null, null, { mode: 'heuristic' });
  assert.equal(information.open_questions.length, 1);
});
test('summary fragments cannot remove negation from a decision', () => {
  const messages = parseConversation('Alice: We decided not to deploy on Friday.\nBob: Noted.');
  const validated = validateAnalysis({ summary_points: [{ quote: 'deploy on Friday.', source_id: 'msg_01' }] }, messages);
  assert.deepEqual(validated.summary_points, [messages[0].text]);
});
test('summary fragments preserve conditions and duplicate selections do not repeat a message', () => {
  const messages = parseConversation('Alice: We will use PostgreSQL unless costs rise.\nBob: Noted.');
  const validated = validateAnalysis({ summary_points: [{ quote: 'We will use PostgreSQL', source_id: 'msg_01' }, { quote: 'unless costs rise.', source_id: 'msg_01' }] }, messages);
  assert.deepEqual(validated.summary_points, [messages[0].text]);
});
function provenance(result, messages) {
  for (const category of ['needs_you', 'action_items', 'decisions', 'open_questions']) {
    for (const finding of result[category]) {
      assert.ok(messages.find(message => message.id === finding.source_id)?.text.includes(finding.quote), 'A finding must preserve an exact source quote');
      if (finding.confirmation) assert.ok(messages.find(message => message.id === finding.confirmation.source_id)?.text.includes(finding.confirmation.quote), 'Acceptance must cite a real source quote');
    }
  }
}
for (const scenario of qualityCorpus) {
  for (const [nameSet, names] of Object.entries(nameSets)) {
    const variant = renamed(scenario, names);
    for (const [format, chat] of formats(variant.chat)) {
      test(`quality: ${scenario.id} / ${nameSet} / ${format}`, async () => {
        const messages = parseConversation(chat);
        const result = await analyzeConversation(messages, null, variant.target, { mode: 'heuristic' });
        const expected = format === 'smart-apostrophes' ? { ...variant, tasks: variant.tasks.map(task => task.map(value => typeof value === 'string' ? value.replaceAll("'", '’') : value)) } : variant;
        assert.deepEqual(compareScenario(expected, result), []);
        provenance(result, messages);
      });
    }
  }
  for (const mode of ['local', 'cloud']) {
    test(`shared classification contract (mock ${mode} response): ${scenario.id}`, async t => {
      const messages = parseConversation(scenario.chat);
      const expected = await analyzeConversation(messages, null, scenario.target, { mode: 'heuristic' });
      // These exercise real parsing, validation and merge code, not live model
      // quality. Responses deliberately include invented owners and source IDs.
      if (mode === 'local') {
        const original = localRuntime.run;
        t.after(() => { localRuntime.run = original; });
        localRuntime.run = async () => ({ choices: [{ message: { content: JSON.stringify({ summary_ids: ['invented', ...messages.slice(0,4).map(message => message.id)] }) } }] });
      } else {
        const original = globalThis.fetch;
        t.after(() => { globalThis.fetch = original; });
        const findings = messages.map(message => ({ quote: message.text, source_id: message.id, owner: 'Invented owner', status: 'confirmed' }));
        globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
          summary_points: [{ quote: 'Invented summary', source_id: 'invented' }],
          action_items: findings, decisions: findings, open_questions: findings, needs_you: findings
        }) } }] }) });
      }
      const actual = await analyzeConversation(messages, null, scenario.target, mode === 'cloud' ? { mode, apiProvider: 'openai', apiKey: 'test-only-key' } : { mode });
      for (const category of ['action_items', 'decisions', 'open_questions', 'needs_you']) assert.deepEqual(actual[category], expected[category], `${category} must use the same conversation policy`);
      provenance(actual, messages);
      assert.ok(!actual.summary_points.some(point => point.includes('Invented summary')));
    });
  }
}
