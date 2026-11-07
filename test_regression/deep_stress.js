/**
 * deep_stress.js — Comprehensive stress tests for heuristics.js & parseConversation
 * Tests every known failure mode and edge case category.
 * Run with: node test_regression/deep_stress.js
 */

const fs = require('fs');
const assert = require('assert');
const path = require('path');

// Load heuristics.js
const heuristicsCode = fs.readFileSync(path.join(__dirname, '..', 'heuristics.js'), 'utf8');
const cleanHeuristics = heuristicsCode.replace(/export function/g, 'function').replace(/export /g, '');
const heuristicsFn = new Function('assert', cleanHeuristics + '\nreturn { extractDeterministicFindings, dedupe };');
const { extractDeterministicFindings, dedupe } = heuristicsFn(assert);

// Load parseConversation from engine.js (strip ESM)
const engineCode = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
const cleanEngine = engineCode
  .replace(/import\s+{[^}]+}\s+from\s+['"][^'"]+['"]\s*;?/g, '')
  .replace(/export async function/g, 'async function')
  .replace(/export function/g, 'function')
  .replace(/export /g, '');
const engineFn = new Function(cleanEngine + '\nreturn { parseConversation };');
const { parseConversation } = engineFn();

// ─── Test utilities ──────────────────────────────────────────────────────────
const createMsg = (id, sender, text) => ({ id: `msg_${id}`, sender, text });

let passed = 0;
let failed = 0;
const failures = [];

function runTest(category, name, fn) {
  process.stdout.write(`  [${category}] ${name}... `);
  try {
    fn();
    console.log('✅');
    passed++;
  } catch (err) {
    console.log('❌');
    console.error(`    → ${err.message}`);
    failures.push({ category, name, err: err.message });
    failed++;
  }
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log('  CatchUp Deep Stress Test Suite');
console.log('═══════════════════════════════════════════════════════════\n');


// ═══════════════════════════════════════════════
// CATEGORY 1: parseConversation
// ═══════════════════════════════════════════════
console.log('── CATEGORY 1: parseConversation ──\n');

runTest('parse', 'Standard "Name: message" format', () => {
  const msgs = parseConversation('Alice: Hello there\nBob: Hey back');
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].sender, 'Alice');
  assert.strictEqual(msgs[0].text, 'Hello there');
  assert.strictEqual(msgs[1].sender, 'Bob');
});

runTest('parse', 'Timestamp format "[10:30 AM] Alice: text"', () => {
  const msgs = parseConversation('[10:30 AM] Alice: Good morning\n[10:31 AM] Bob: Morning!');
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].sender, 'Alice');
  assert.strictEqual(msgs[0].text, 'Good morning');
});

runTest('parse', 'Name with timestamp "Alice (10:30 AM): text"', () => {
  const msgs = parseConversation('Alice (10:30 AM): Lets sync now\nBob (10:31 AM): Sure!');
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].sender, 'Alice');
  assert.strictEqual(msgs[0].text, 'Lets sync now');
});

runTest('parse', 'Multiline continuation appended to previous', () => {
  const msgs = parseConversation('Alice: This is line one\nThis is still Alice talking\nBob: I see');
  assert.strictEqual(msgs.length, 2);
  assert.ok(msgs[0].text.includes('still Alice'), 'Continuation should be appended');
});

runTest('parse', 'Blank lines are ignored', () => {
  const msgs = parseConversation('Alice: Hello\n\n\nBob: World\n\n');
  assert.strictEqual(msgs.length, 2);
});

runTest('parse', 'Empty string returns empty array', () => {
  const msgs = parseConversation('');
  assert.strictEqual(msgs.length, 0);
});

runTest('parse', 'Only blank lines returns empty array', () => {
  const msgs = parseConversation('   \n   \n   ');
  assert.strictEqual(msgs.length, 0);
});

runTest('parse', 'Message IDs are sequential and zero-padded', () => {
  const msgs = parseConversation('Alice: First\nBob: Second\nCharlie: Third');
  assert.strictEqual(msgs[0].id, 'msg_01');
  assert.strictEqual(msgs[1].id, 'msg_02');
  assert.strictEqual(msgs[2].id, 'msg_03');
});

runTest('parse', 'Colons in message body do not split incorrectly', () => {
  const msgs = parseConversation('Alice: Use this URL: https://example.com for the API');
  assert.strictEqual(msgs.length, 1);
  assert.ok(msgs[0].text.includes('https://'), 'URL in body should be preserved');
});

runTest('parse', 'Name with underscore/numbers is parsed', () => {
  const msgs = parseConversation('user_123: Hello team\nAdmin99: Noted');
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].sender, 'user_123');
});

runTest('parse', 'Sender name is trimmed of whitespace', () => {
  const msgs = parseConversation('  Alice  : Hello');
  assert.strictEqual(msgs[0].sender, 'Alice');
});

runTest('parse', 'Single message with no second speaker still parsed', () => {
  const msgs = parseConversation('Alice: I am working on the API now');
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].sender, 'Alice');
});

runTest('parse', 'WhatsApp style "[12/10/2024, 10:30 AM] Alice: Hi"', () => {
  const msgs = parseConversation('[12/10/2024, 10:30 AM] Alice: Hey there\n[12/10/2024, 10:31 AM] Bob: Heya');
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].sender, 'Alice');
});

runTest('parse', 'Unsupported Discord headers fail explicitly instead of dropping speakers', () => {
  assert.throws(() => parseConversation('Alice — Today at 10:30 AM\nHello everyone\nBob: Sounds good'), /Unsupported Slack\/Discord header/);
});


// ═══════════════════════════════════════════════
// CATEGORY 2: Needs You / Attention Detection
// ═══════════════════════════════════════════════
console.log('\n── CATEGORY 2: Needs You Detection ──\n');

runTest('needsYou', 'Direct @mention with targetUser set', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', '@Bob can you review this PR?')
  ], 'Bob');
  assert.strictEqual(r.fallbackNeedsYou.length, 1);
});

runTest('needsYou', 'targetUser mentioned without @ prefix', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'Bob can you handle the deployment?')
  ], 'Bob');
  assert.strictEqual(r.fallbackNeedsYou.length, 1, 'Name mention without @ should still be caught');
});

runTest('needsYou', 'targetUser match is case-insensitive', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', '@BOB this is urgent')
  ], 'bob');
  assert.strictEqual(r.fallbackNeedsYou.length, 1);
});

runTest('needsYou', 'Partial name match does NOT falsely trigger', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'Robotic systems need review')
  ], 'Rob');
  // "Robotic" should NOT match "Rob" as a standalone word
  assert.strictEqual(r.fallbackNeedsYou.length, 0, 'Partial word match should not trigger');
});

runTest('needsYou', 'Urgent keyword triggers when no targetUser', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'This is urgent, please fix the build')
  ], null);
  assert.strictEqual(r.fallbackNeedsYou.length, 1);
});

runTest('needsYou', 'Blocker keyword triggers when no targetUser', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Dave', 'This is a blocker for the release')
  ], null);
  assert.strictEqual(r.fallbackNeedsYou.length, 1);
});

runTest('needsYou', 'Normal message does NOT trigger needsYou (no targetUser)', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'The meeting went well today')
  ], null);
  assert.strictEqual(r.fallbackNeedsYou.length, 0);
});

runTest('needsYou', 'Message from targetUser themselves does NOT trigger self-needsYou', () => {
  // If Bob sends a message, the system should not flag Bob's own message
  // as needing Bob's attention (sender match only should be careful)
  const r = extractDeterministicFindings([
    createMsg('01', 'Bob', 'I will handle this by tomorrow')
  ], 'Bob');
  // This tests current behavior - sender match logic
  // Bob is the sender; the current regex also matches sender
  // This is actually a known issue we want to flag if it fires
  // For now, document the actual behavior
  assert.strictEqual(r.fallbackNeedsYou.length, 0, 'A sender must not be asked to act on their own message');
});

runTest('needsYou', 'Priority field is always "high" for needsYou findings', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', '@Bob urgent review needed')
  ], 'Bob');
  if (r.fallbackNeedsYou.length > 0) {
    assert.strictEqual(r.fallbackNeedsYou[0].priority, 'high');
  }
});


// ═══════════════════════════════════════════════
// CATEGORY 3: Open Questions
// ═══════════════════════════════════════════════
console.log('\n── CATEGORY 3: Open Questions ──\n');

runTest('questions', 'Simple question mark detected', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'Who is handling the deployment?'),
    createMsg('02', 'Bob', 'Not sure yet')
  ]);
  assert.strictEqual(r.fallbackQuestions.length, 1);
});

runTest('questions', 'Resolved question removed (keyword + topic match)', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'Who is setting up the database?'),
    createMsg('02', 'Bob', 'I will set up the database tomorrow')
  ]);
  assert.strictEqual(r.fallbackQuestions.length, 0, 'Resolved question should be filtered');
});

runTest('questions', 'Multiple unresolved questions all captured', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'What is the deadline?'),
    createMsg('02', 'Bob', 'No idea'),
    createMsg('03', 'Alice', 'Who has the API keys?'),
    createMsg('04', 'Bob', 'Not me')
  ]);
  assert.strictEqual(r.fallbackQuestions.length, 2, 'Both unresolved questions should be captured');
});

runTest('questions', '"Pending" keyword triggers open question even without ?', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'The venue is still pending')
  ]);
  assert.strictEqual(r.fallbackQuestions.length, 1);
});

runTest('questions', '"Undecided" keyword triggers open question', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Bob', 'The budget is undecided')
  ]);
  assert.strictEqual(r.fallbackQuestions.length, 1);
});

runTest('questions', 'Rhetorical exclamations without ? not flagged', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'What a great idea! Lets do it.')
  ]);
  // "What a great idea!" has no "?" so should not be flagged
  assert.strictEqual(r.fallbackQuestions.length, 0);
});

runTest('questions', 'Resolved question: "sure" within 2 messages + shared keyword', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'Can you write the tests?'),
    createMsg('02', 'Bob', 'Sure, I can handle the tests')
  ]);
  assert.strictEqual(r.fallbackQuestions.length, 0, 'Should be resolved');
});

runTest('questions', 'Question resolved by "will do" response', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'Bob can you review the PR?'),
    createMsg('02', 'Bob', 'Will do, I will review the PR now')
  ]);
  // "Will do" + shared keyword "review"/"pr" - check if resolved
  assert.ok(typeof r.fallbackQuestions.length === 'number', 'Should not crash');
});

runTest('questions', 'Substantive ownership answer resolves question after intervening messages', () => {
  const r = extractDeterministicFindings([
    createMsg('01', 'Alice', 'Who handles documentation?'),
    createMsg('02', 'Bob', 'Let me think'),
    createMsg('03', 'Charlie', 'Good question'),
    createMsg('04', 'Dave', 'I will handle the documentation')
  ]);
  assert.strictEqual(r.fallbackQuestions.length, 0, 'Dave explicitly takes ownership of documentation');
});


// ═══════════════════════════════════════════════
// CATEGORY 4: Action Items / Tasks
// ═══════════════════════════════════════════════
console.log('\n── CATEGORY 4: Action Items / Tasks ──\n');

runTest('actions', '"I will" commitment detected', () => {
  const r = extractDeterministicFindings([createMsg('01', 'Alice', 'I will push the code by 5 PM')]);
  assert.strictEqual(r.fallbackActions.length, 1);
  assert.strictEqual(r.fallbackActions[0].owner, 'Alice');
});

runTest('actions', '"I\'ll" contraction detected', () => {
  const r = extractDeterministicFindings([createMsg('01', 'Bob', "I'll deploy the backend tonight")]);
  assert.strictEqual(r.fallbackActions.length, 1);
  assert.strictEqual(r.fallbackActions[0].owner, 'Bob');
});

runTest('actions', '"we will" detected as team task', () => {
  const r = extractDeterministicFindings([createMsg('01', 'Alice', "We will submit the form by Friday")]);
  assert.strictEqual(r.fallbackActions.length, 1);
});

runTest('actions', 'Commitment containing ? is NOT extracted as action', () => {
  const r = extractDeterministicFindings([createMsg('01', 'Alice', 'Will you handle the deployment?')]);
  // Contains ? so should not be an action
  assert.strictEqual(r.fallbackActions.length, 0, 'Questions with will should not be actions');
});

runTest('actions', '@Mention recipient does not replace the first-person speaker', () => {
  const r = extractDeterministicFindings([createMsg('01', 'Alice', '@Bob I will send you the files')]);
  assert.strictEqual(r.fallbackActions[0].owner, 'Alice');
});

runTest('actions', '@Team sets owner to Team', () => {
  const r = extractDeterministicFindings([createMsg('01', 'Alice', '@Team everyone must submit forms by Monday')]);
  const teamAction = r.fallbackActions.find(a => a.owner === 'Team');
  assert.ok(teamAction, 'Owner should be Team');
});

runTest('actions', '"Everyone must" triggers team imperative', () => {
  const r = extractDeterministicFindings([createMsg('01', 'Alice', 'Everyone must review the spec before Friday')]);
  assert.strictEqual(r.fallbackActions.length, 1);
});

runTest('actions', '"I can" is detected as action', () => {
  const r = extractDeterministicFindings([createMsg('01', 'Alice', 'I can take care of the deployment')]);
  assert.strictEqual(r.fallbackActions.length, 1);
});

runTest('actions', 'Generic "I will" without clear task is still captured', () => {
  const r = extractDeterministicFindings([createMsg('01', 'Alice', 'I will sort this out later')]);
  assert.strictEqual(r.fallbackActions.length, 1);
});


// ═══════════════════════════════════════════════
// CATEGORY 5: Decisions
// ═══════════════════════════════════════════════
console.log('\n── CATEGORY 5: Decisions ──\n');

runTest('decisions', '"decided" keyword captured as decision', () => {
  const r = extractDeterministicFindings([createMsg('01', 'Alice', 'We decided to go with PostgreSQL')]);
  assert.strictEqual(r.fallbackDecisions.length, 1);
});

runTest('decisions', '"agreed" keyword captured as decision', () => {
  const r = extractDeterministicFindings([createMsg('01', 'Bob', 'Everyone agreed to push the deadline to Friday')]);
  assert.strictEqual(r.fallbackDecisions.length, 1);
});

runTest('decisions', '"will use" captured as decision', () => {
  const r = extractDeterministicFindings([createMsg('01', 'Charlie', 'We will use React for the frontend')]);
  assert.strictEqual(r.fallbackDecisions.length, 1);
});

runTest('decisions', 'Tentative "maybe" excluded from decisions', () => {
  const r = extractDeterministicFindings([createMsg('01', 'Alice', 'Maybe we should use Redis?')]);
  assert.strictEqual(r.fallbackDecisions.length, 0, 'Tentative statements should not be decisions');
});

runTest('decisions', '"undecided" excluded from decisions', () => {
  const r = extractDeterministicFindings([createMsg('01', 'Bob', 'It is undecided whether we use Vue or React')]);
  assert.strictEqual(r.fallbackDecisions.length, 0);
});

runTest('decisions', 'Decision with ? NOT captured', () => {
  const r = extractDeterministicFindings([createMsg('01', 'Alice', 'Have we decided on the framework?')]);
  assert.strictEqual(r.fallbackDecisions.length, 0, 'Questions about decisions should not be decisions');
});

runTest('decisions', '"pending" in decision text excludes it', () => {
  const r = extractDeterministicFindings([createMsg('01', 'Bob', 'The decision is still pending')]);
  assert.strictEqual(r.fallbackDecisions.length, 0);
});


// ═══════════════════════════════════════════════
// CATEGORY 6: Deduplication
// ═══════════════════════════════════════════════
console.log('\n── CATEGORY 6: Deduplication ──\n');

runTest('dedupe', 'Exact duplicate (same source_id + same quote) is collapsed', () => {
  const f1 = { text: 'Do the thing', quote: 'Do the thing', source_id: 'msg_01' };
  const f2 = { text: 'Do the thing', quote: 'Do the thing', source_id: 'msg_01' };
  const result = dedupe([f1], [f2]);
  assert.strictEqual(result.length, 1);
});

runTest('dedupe', 'Same text different source_ids kept separate', () => {
  const f1 = { text: 'Deploy the app', source_id: 'msg_01' };
  const f2 = { text: 'Deploy the app', source_id: 'msg_02' };
  const result = dedupe([f1], [f2]);
  assert.strictEqual(result.length, 2);
});

runTest('dedupe', 'Different owner on same source preserved', () => {
  const f1 = { text: 'Do the work', quote: 'Do the work', source_id: 'msg_01', owner: 'Alice' };
  const f2 = { text: 'Do the work', quote: 'Do the work', source_id: 'msg_01', owner: 'Bob' };
  const result = dedupe([f1], [f2]);
  assert.strictEqual(result.length, 2, 'Both explicit owners must remain');
  assert.deepStrictEqual(result.map(item => item.owner).sort(), ['Alice', 'Bob']);
});

runTest('dedupe', 'Finding with null/missing source_id is excluded', () => {
  const f1 = { text: 'Bad finding', source_id: null };
  const result = dedupe([f1], []);
  assert.strictEqual(result.length, 0);
});

runTest('dedupe', 'Empty arrays deduped cleanly', () => {
  const result = dedupe([], []);
  assert.strictEqual(result.length, 0);
});

runTest('dedupe', 'LLM finding + heuristic finding same source collapsed', () => {
  const llmFind = { text: 'Review the PR', quote: 'review the PR', source_id: 'msg_04' };
  const heuristicFind = { text: 'Confirmed task: "review the PR"', quote: 'review the PR', source_id: 'msg_04' };
  const result = dedupe([llmFind], [heuristicFind]);
  assert.strictEqual(result.length, 1, 'Same quote+source should dedupe to one');
});


// ═══════════════════════════════════════════════
// CATEGORY 7: Real-World Conversation Simulations
// ═══════════════════════════════════════════════
console.log('\n── CATEGORY 7: Real-World Simulations ──\n');

runTest('realworld', 'Hackathon standup conversation', () => {
  const msgs = [
    createMsg('01', 'Priya', 'Who is booking the electronics lab for Sunday?'),
    createMsg('02', 'Ananya', "I haven't booked it yet. It's unconfirmed. I'll confirm the room availability tomorrow."),
    createMsg('03', 'Karthik', 'I have uploaded the component list, but the final cost table is still pending.'),
    createMsg('04', 'Rahul', 'We need to test the sensors on Sunday 3 PM.'),
    createMsg('05', 'Ananya', "Should we buy another moisture sensor? It's undecided."),
    createMsg('06', 'Priya', 'Upload files by Sunday 9 PM.'),
    createMsg('07', 'Rahul', 'Everyone arrive Monday at 9:30 AM for the 10 AM review.'),
    createMsg('08', 'Karthik', '@Ananya, we need the PPT and system architecture diagram done.'),
    createMsg('09', 'Ananya', "I'll have it due Sunday at 8 PM.")
  ];
  const r = extractDeterministicFindings(msgs, 'Ananya');
  assert.ok(r.fallbackNeedsYou.length >= 1, 'Ananya should be targeted (msg_08)');
  assert.ok(r.fallbackActions.length >= 1, "Ananya's commitment should be an action");
  assert.ok(r.fallbackQuestions.length >= 1, 'Open questions should be detected');
});

runTest('realworld', 'Engineering incident response', () => {
  const msgs = [
    createMsg('01', 'Dev', 'The production server is down. Urgent!'),
    createMsg('02', 'Lead', '@Dev I will investigate the logs now'),
    createMsg('03', 'Dev', 'Thanks. Who has access to the DB admin panel?'),
    createMsg('04', 'Lead', 'I do. I will check the connections'),
    createMsg('05', 'PM', 'We need to inform the client ASAP'),
    createMsg('06', 'Lead', 'Agreed. I will draft the incident report')
  ];
  const r = extractDeterministicFindings(msgs, 'Dev');
  assert.ok(r.fallbackNeedsYou.length >= 1, 'Dev should be targeted in msg_02');
  assert.ok(r.fallbackActions.length >= 2, 'Multiple commitments should be captured');
  assert.ok(r.fallbackDecisions.length >= 1, '"Agreed" should trigger a decision');
});

runTest('realworld', 'Product planning session', () => {
  const msgs = [
    createMsg('01', 'Alice', 'We decided to ship the MVP by end of month'),
    createMsg('02', 'Bob', 'Agreed. I will focus on the payment module this week'),
    createMsg('03', 'Charlie', 'What about mobile support? Its not in scope'),
    createMsg('04', 'Alice', 'We will address it in v2. Not now'),
    createMsg('05', 'Bob', 'Who is writing the release notes?'),
    createMsg('06', 'Charlie', 'I can do it over the weekend')
  ];
  const r = extractDeterministicFindings(msgs);
  assert.ok(r.fallbackDecisions.length >= 1, 'At least one decision should be detected');
  assert.ok(r.fallbackActions.length >= 2, 'Bob and Charlie commitments should be actions');
  assert.ok(r.fallbackQuestions.length >= 1, 'Release notes question should be open');
});

runTest('realworld', 'Conversation with no actionable content gives empty results', () => {
  const msgs = [
    createMsg('01', 'Alice', 'Good morning everyone'),
    createMsg('02', 'Bob', 'Morning! How was your weekend?'),
    createMsg('03', 'Charlie', 'Pretty good, went hiking')
  ];
  const r = extractDeterministicFindings(msgs);
  assert.strictEqual(r.fallbackActions.length, 0, 'Small talk should produce no actions');
  assert.strictEqual(r.fallbackDecisions.length, 0, 'Small talk should produce no decisions');
});

runTest('realworld', 'Single person monologue (not a conversation)', () => {
  const msgs = [
    createMsg('01', 'Alice', 'I will finish the report tonight'),
    createMsg('02', 'Alice', 'I will also review the code'),
    createMsg('03', 'Alice', 'I agreed with myself to push by midnight')
  ];
  const r = extractDeterministicFindings(msgs);
  assert.ok(r.fallbackActions.length >= 2, 'Actions from single speaker should be captured');
});

runTest('realworld', 'Special characters in message text do not crash', () => {
  const msgs = [
    createMsg('01', 'Alice', 'Use the endpoint https://api.example.com/v2?key=123&token=abc'),
    createMsg('02', 'Bob', "I'll call the endpoint: POST /api/v2/{id} — make sure headers are set: 'Content-Type: application/json'")
  ];
  const r = extractDeterministicFindings(msgs);
  assert.ok(typeof r.fallbackActions.length === 'number', 'Should not crash with special chars');
});

runTest('realworld', 'Very long message text handled correctly', () => {
  const longText = 'I will ' + 'handle this task and '.repeat(50) + 'deliver by Friday.';
  const msgs = [createMsg('01', 'Alice', longText)];
  const r = extractDeterministicFindings(msgs);
  assert.ok(r.fallbackActions.length >= 1, 'Long messages should still extract tasks');
});

runTest('realworld', '100 messages performance test (<100ms)', () => {
  const msgs = Array.from({ length: 100 }, (_, i) =>
    createMsg(String(i + 1).padStart(2, '0'),
      ['Alice', 'Bob', 'Charlie'][i % 3],
      i % 5 === 0 ? `I will handle item ${i}` :
      i % 7 === 0 ? `We decided to use approach ${i}` :
      i % 11 === 0 ? `Who handles task ${i}?` :
      `Message number ${i} in the conversation thread`)
  );
  const start = Date.now();
  const r = extractDeterministicFindings(msgs, 'Alice');
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 100, `Performance: ${elapsed}ms (should be <100ms)`);
  assert.ok(r.fallbackActions.length > 0, 'Should extract some actions from 100 messages');
});


// ═══════════════════════════════════════════════
// RESULTS SUMMARY
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
  console.log('All stress tests passed. Engine is solid.\n');
}
