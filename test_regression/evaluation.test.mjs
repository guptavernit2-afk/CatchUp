import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeConversation, parseConversation } from '../engine.js';
import { generateMarkdown } from '../report.js';

const scenarios = JSON.parse(readFileSync(new URL('./conversations.json', import.meta.url), 'utf8'));
for (const scenario of scenarios) {
  test(`conversation evaluation: ${scenario.id}`, async () => {
    const messages = parseConversation(scenario.chat);
    const result = await analyzeConversation(messages, null, scenario.target, { mode: 'heuristic' });
    assert.deepEqual(result.action_items.map(item => ({ source: item.source_id, owner: item.owner, status: item.status })), scenario.expected.tasks);
    assert.deepEqual(result.decisions.map(item => item.source_id), scenario.expected.decisions);
    assert.deepEqual(result.open_questions.map(item => item.source_id), scenario.expected.questions);
    if (scenario.expected.attention) assert.deepEqual(result.needs_you.map(item => item.source_id), scenario.expected.attention);
    for (const category of ['needs_you', 'action_items', 'decisions', 'open_questions']) {
      for (const finding of result[category]) {
        assert.ok(messages.find(message => message.id === finding.source_id)?.text.includes(finding.quote), 'Every finding must retain its original source wording');
      }
    }
  });
}

test('export retains completed task state, source references, and processing mode', async () => {
  const result = await analyzeConversation(parseConversation(scenarios[0].chat), null, null, { mode: 'heuristic' });
  result.action_items[0].completed = true;
  const markdown = generateMarkdown(result);
  assert.ok(markdown.includes('- [x] **Confirmed task: "I will finish the login page today."** (@Alice)'));
  assert.ok(markdown.includes('- [ ] **Confirmed task: "I will review the login pull request tomorrow."** (@Bob)'));
  assert.ok(markdown.includes('(msg_01)'));
  assert.ok(markdown.includes('On-device rule analysis'));
  assert.ok(generateMarkdown({ ...result, processing_mode: 'cloud' }).includes('Cloud API analysis'));
});
