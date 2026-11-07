/**
 * adversarial.js — Adversarial & Edge Case Tests
 * Tests the specific failure modes identified in the system analysis.
 * These are designed to BREAK the engine and expose real bugs.
 *
 * v2 — All previously-⚠ false positives are now strict assertions after engine fixes.
 */

const fs = require('fs');
const assert = require('assert');
const path = require('path');

const heuristicsCode = fs.readFileSync(path.join(__dirname, '..', 'heuristics.js'), 'utf8');
const cleanHeuristics = heuristicsCode.replace(/export function/g, 'function').replace(/export /g, '');
const { extractDeterministicFindings, dedupe } = new Function('assert', cleanHeuristics + '\nreturn { extractDeterministicFindings, dedupe };')(assert);

const engineCode = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
const cleanEngine = engineCode
  .replace(/import\s+{[^}]+}\s+from\s+['"][^'"]+['"]\s*;?/g, '')
  .replace(/export async function/g, 'async function')
  .replace(/export function/g, 'function')
  .replace(/export /g, '');
const { parseConversation } = new Function(cleanEngine + '\nreturn { parseConversation };')();

const createMsg = (id, sender, text) => ({ id: `msg_${id}`, sender, text });

let passed = 0; let failed = 0;
const failures = [];

function runTest(category, name, fn) {
  process.stdout.write(`  [${category}] ${name}... `);
  try {
    fn();
    console.log('✅');
    passed++;
  } catch (err) {
    console.log('❌  ← FAILED');
    console.error(`    → ${err.message}`);
    failures.push({ category, name, err: err.message });
    failed++;
  }
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log('  CatchUp Adversarial Stress Tests v2');
console.log('  (All bugs now strict assertions — no ⚠ warnings)');
console.log('═══════════════════════════════════════════════════════════\n');


// ═══════════════════════════════════════════════
// ADVERSARIAL 1: FALSE POSITIVE — Questions
// ═══════════════════════════════════════════════
console.log('── FALSE POSITIVES: Questions ──\n');

runTest('fp-questions', 'Clarification question that is immediately answered stays silent', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'Can we meet at 1 PM?'),
    createMsg('02', 'Bob', '1 PM works for me, I will be there')
  ]);
  assert.strictEqual(r.fallbackQuestions.length, 0, 'Immediately answered question should not be open');
});

runTest('fp-questions', 'An immediate yes answers a direct help request', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'Can you help?'),
    createMsg('02', 'Bob', 'Yes!')
  ]);
  assert.strictEqual(r.fallbackQuestions.length, 0, 'An immediate affirmative answers the help request');
});

runTest('fp-questions', 'Meeting reschedule confirmation removes the question', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'Can we do 1 PM instead?'),
    createMsg('02', 'Charlie', '1 PM works for me')
  ]);
  assert.strictEqual(r.fallbackQuestions.length, 0, 'Rescheduling confirmation should resolve question');
});

runTest('fp-questions', '"?" inside URL should NOT trigger question detection', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'Check this link: https://api.example.com/data?token=abc123&format=json'),
    createMsg('02', 'Bob', 'Got it, will check it')
  ]);
  assert.strictEqual(r.fallbackQuestions.length, 0, 'URL query strings must not trigger question detection');
});

runTest('fp-questions', 'A direct agreement answers a scheduling tag question', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'We ship on Friday, right?'),
    createMsg('02', 'Bob', 'Sounds good to me')
  ]);
  assert.strictEqual(r.fallbackQuestions.length, 0, 'Direct agreement confirms the proposed schedule');
});

runTest('fp-questions', '"works for me" standalone resolves question', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'Can we do the call at 3 PM?'),
    createMsg('02', 'Bob', 'Works for me')
  ]);
  assert.strictEqual(r.fallbackQuestions.length, 0, '"Works for me" standalone should resolve the question');
});

runTest('fp-questions', '"confirmed" standalone resolves question', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'Can you ship the build today?'),
    createMsg('02', 'Bob', 'Confirmed')
  ]);
  assert.strictEqual(r.fallbackQuestions.length, 0, '"Confirmed" alone should resolve the question');
});


// ═══════════════════════════════════════════════
// ADVERSARIAL 2: FALSE POSITIVE — Actions
// ═══════════════════════════════════════════════
console.log('\n── FALSE POSITIVES: Actions ──\n');

runTest('fp-actions', '"I will be there" is attendance, not a task — document behavior', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Bob', 'I will be there at 5 PM')
  ]);
  assert.strictEqual(r.fallbackActions.length, 0, 'Attendance is not a deliverable');
});

runTest('fp-actions', '"I will think about it" must NOT be an action (vague hedge)', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'I will think about it')
  ]);
  assert.strictEqual(r.fallbackActions.length, 0, '"I will think about it" is a vague hedge, not a commitment');
});

runTest('fp-actions', '"I can\'t make it" must NOT be an action (negation)', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Bob', "I can't make it to the meeting tomorrow")
  ]);
  assert.strictEqual(r.fallbackActions.length, 0, '"I can\'t make it" is a negation and must not be captured as action');
});

runTest('fp-actions', '"We will see how it goes" must NOT be an action (speculative)', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'We will see how it goes')
  ]);
  assert.strictEqual(r.fallbackActions.length, 0, '"We will see" is speculative, not a commitment');
});

runTest('fp-actions', '"I won\'t attend" must NOT be an action (negation)', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', "I won't attend the standup today")
  ]);
  assert.strictEqual(r.fallbackActions.length, 0, '"I won\'t" is a negation');
});

runTest('fp-actions', '"I cannot do this" must NOT be an action (negation)', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'I cannot do this by tomorrow')
  ]);
  assert.strictEqual(r.fallbackActions.length, 0, '"I cannot" is a negation');
});

runTest('fp-actions', '"I will finish the PR" IS a valid action', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'I will finish the PR by EOD')
  ]);
  assert.strictEqual(r.fallbackActions.length, 1, '"I will finish" is a clear commitment');
  assert.strictEqual(r.fallbackActions[0].owner, 'Alice');
});

runTest('fp-actions', 'Past tense "I will have done it" — document current behavior', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'I will have done it by then')
  ]);
  assert.ok(typeof r.fallbackActions.length === 'number', 'Should not crash');
});


// ═══════════════════════════════════════════════
// ADVERSARIAL 3: FALSE POSITIVE — Decisions
// ═══════════════════════════════════════════════
console.log('\n── FALSE POSITIVES: Decisions ──\n');

runTest('fp-decisions', '"We need to decide" is NOT a decision — no keyword hit', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'We need to decide on the tech stack by tomorrow')
  ]);
  // "decided" not present, "decide" alone is not in regex — should be 0
  assert.strictEqual(r.fallbackDecisions.length, 0, '"decide" alone should not match the decision regex');
});

runTest('fp-decisions', '"The requirement is TBD" must NOT be a decision', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Bob', 'The requirement is TBD and will be finalized later')
  ]);
  assert.strictEqual(r.fallbackDecisions.length, 0, '"requirement" keyword removed; TBD guard active');
});

runTest('fp-decisions', '"agreed to disagree" must NOT be a decision', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'We agreed to disagree on this one')
  ]);
  assert.strictEqual(r.fallbackDecisions.length, 0, '"agreed to disagree" is not a concrete decision');
});

runTest('fp-decisions', '"We decided to use PostgreSQL" IS a valid decision', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'We decided to use PostgreSQL for the project')
  ]);
  assert.strictEqual(r.fallbackDecisions.length, 1, '"decided" is a clear decision keyword');
});

runTest('fp-decisions', '"The status is TBD" must NOT be a decision', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Bob', 'The launch date is TBD')
  ]);
  assert.strictEqual(r.fallbackDecisions.length, 0, 'TBD guard must suppress false decision');
});


// ═══════════════════════════════════════════════
// ADVERSARIAL 4: parseConversation Edge Cases
// ═══════════════════════════════════════════════
console.log('\n── PARSE: Edge Cases ──\n');

runTest('parse-adv', 'Unsupported Slack headers fail explicitly instead of dropping speakers', () => {
  assert.throws(() => parseConversation('Slackbot  10:30 AM\nThis is a Slackbot message\nAlice: I see that'), /Unsupported Slack\/Discord header/);
});

runTest('parse-adv', 'Tab-indented continuation lines handled', () => {
  const msgs = parseConversation('Alice: This is the main point\n\t- subpoint one\n\t- subpoint two\nBob: Understood');
  assert.strictEqual(msgs.length, 2, 'Tab-indented subpoints should append to Alice');
  assert.ok(msgs[0].text.includes('subpoint'), 'Subpoints should be in Alice text');
});

runTest('parse-adv', 'Messages with emoji are parsed correctly', () => {
  const msgs = parseConversation('Alice: Great work today 🎉\nBob: Thanks! 🙌 will do more tomorrow');
  assert.strictEqual(msgs.length, 2);
  assert.ok(msgs[0].text.includes('🎉'));
});

runTest('parse-adv', 'Very large conversation (200 msgs) counter stays accurate', () => {
  const raw = Array.from({ length: 200 }, (_, i) =>
    `${['Alice', 'Bob'][i % 2]}: Message number ${i + 1}`
  ).join('\n');
  const msgs = parseConversation(raw);
  assert.strictEqual(msgs.length, 200);
  assert.strictEqual(msgs[199].id, 'msg_200', 'ID should be msg_200 for 200th message');
});

runTest('parse-adv', 'Message with hyphenated name parsed correctly', () => {
  const msgs = parseConversation('Mary-Jane: Hello everyone\nBob: Hi there');
  assert.strictEqual(msgs.length, 2, 'Neither speaker may be lost');
  assert.strictEqual(msgs[0].sender, 'Mary-Jane');
  assert.strictEqual(msgs[0].text, 'Hello everyone');
  assert.strictEqual(msgs[1].sender, 'Bob');
});

runTest('parse-adv', 'Message number > 99 gets correct ID format', () => {
  const raw = Array.from({ length: 105 }, (_, i) =>
    `${['Alice', 'Bob'][i % 2]}: Line ${i + 1}`
  ).join('\n');
  const msgs = parseConversation(raw);
  assert.strictEqual(msgs[99].id, 'msg_100');
  assert.strictEqual(msgs[104].id, 'msg_105');
});


// ═══════════════════════════════════════════════
// ADVERSARIAL 5: Self-mention bug
// ═══════════════════════════════════════════════
console.log('\n── SELF-MENTION BUG ──\n');

runTest('self-mention', 'Sender with same name as targetUser does NOT flag own messages', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Bob', 'I will handle the deployment by tonight'),
    createMsg('02', 'Alice', '@Bob can you confirm?'),
    createMsg('03', 'Bob', 'Confirmed, I will do it')
  ], 'Bob');
  
  // Only msg_02 (where Alice addresses Bob) should be in needsYou
  const selfMentions = r.fallbackNeedsYou.filter(f => 
    f.source_id === 'msg_01' || f.source_id === 'msg_03'
  );
  if (selfMentions.length > 0) {
    throw new Error(`BUG: Bob's own messages flagged as needing Bob's attention: ${selfMentions.map(f => f.source_id).join(', ')}`);
  }
  assert.ok(r.fallbackNeedsYou.some(f => f.source_id === 'msg_02'), 'msg_02 (Alice addressing Bob) should be in needsYou');
});

runTest('self-mention', 'Case-insensitive self-mention guard (sender "BOB" vs targetUser "bob")', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'BOB', 'I will check the logs'),
    createMsg('02', 'Alice', '@bob can you review?')
  ], 'bob');
  const selfMentions = r.fallbackNeedsYou.filter(f => f.source_id === 'msg_01');
  assert.strictEqual(selfMentions.length, 0, 'Case-insensitive self-guard: BOB own message must not be flagged');
  assert.ok(r.fallbackNeedsYou.some(f => f.source_id === 'msg_02'), 'Alice addressing @bob should be flagged');
});


// ═══════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════════════');
console.log(`  Results: ${passed} passed / ${failed} failed / ${passed + failed} total`);
console.log('═══════════════════════════════════════════════════════════\n');

if (failures.length > 0) {
  console.log('FAILURES:\n');
  failures.forEach(f => {
    console.log(`  ❌ [${f.category}] ${f.name}`);
    console.log(`     → ${f.err}\n`);
  });
  process.exit(1);
} else {
  console.log('All adversarial tests passed. Engine is hardened. ✅\n');
}
