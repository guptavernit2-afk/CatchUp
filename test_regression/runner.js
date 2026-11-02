const fs = require('fs');
const assert = require('assert');

// The runner loads the actual heuristics.js production file.
// We use a Function constructor to evaluate it in a controlled environment
// because Node.js does not yet support ESM imports seamlessly for local files
// without a package.json or specific extensions, and heuristics.js is an ESM module.
const heuristicsCode = fs.readFileSync('heuristics.js', 'utf8');

// Strip ESM exports for evaluation
const cleanCode = heuristicsCode
  .replace(/export function/g, 'function')
  .replace(/export /g, '');

const fn = new Function('assert', cleanCode + '\nreturn { extractDeterministicFindings, dedupe };');
const { extractDeterministicFindings, dedupe } = fn(assert);

// Test Utilities
const createMsg = (id, sender, text) => ({ id: `msg_${id}`, sender, text });

const runTest = (name, messages, expected) => {
  process.stdout.write(`Running: ${name}... `);
  const result = extractDeterministicFindings(messages);
  try {
    expected(result, dedupe);
    process.stdout.write('✅\n');
  } catch (err) {
    process.stdout.write('❌\n');
    console.error(`  Error in "${name}": ${err.message}`);
    console.log('  Actual result:', JSON.stringify(result, null, 2));
    process.exit(1);
  }
};

console.log('CatchUp Extraction Regression Suite\n');

// 1. Explicit assignee vs message sender
runTest('Explicit assignee recognition', 
  [createMsg('01', 'Alice', '@Bob I will finish the report')],
  (res) => {
    assert.strictEqual(res.fallbackActions.length, 1);
    assert.strictEqual(res.fallbackActions[0].owner, 'Bob', 'Task should be assigned to @Bob');
  }
);

// 2. Mentions that are not assignments
runTest('Non-assignment mention filtering',
  [createMsg('02', 'Charlie', 'Please look at @Bob\'s draft')],
  (res) => {
    assert.strictEqual(res.fallbackActions.length, 0, 'Should not be an action');
  }
);

// 3. Missing owners
runTest('Unassigned task detection',
  [createMsg('03', 'Dave', 'I can help fix the server')],
  (res) => {
    assert.strictEqual(res.fallbackActions.length, 1);
    assert.strictEqual(res.fallbackActions[0].owner, 'Dave', 'Owner should be the sender');
  }
);

// 4. Confirmed vs tentative decisions
runTest('Decision classification',
  [
    createMsg('04', 'Grace', 'We decided to use PostgreSQL'),
    createMsg('05', 'Heidi', 'Maybe we should use Redis?')
  ],
  (res) => {
    assert.strictEqual(res.fallbackDecisions.length, 1);
    assert.strictEqual(res.fallbackDecisions[0].source_id, 'msg_04');
  }
);

// 5. Question resolution
runTest('Resolved question filtering',
  [
    createMsg('06', 'Ivan', 'Who is setting up the database?'),
    createMsg('07', 'Judy', 'I will set up the database tomorrow')
  ],
  (res) => {
    assert.strictEqual(res.fallbackQuestions.length, 0, 'Question should be resolved by follow-up keyword match');
  }
);

// 6. Unrelated open question
runTest('Open question tracking',
  [
    createMsg('08', 'Karl', 'What about the API documentation?'),
    createMsg('09', 'Alice', 'I will finish the report')
  ],
  (res) => {
    assert.strictEqual(res.fallbackQuestions.length, 1);
    assert.strictEqual(res.fallbackQuestions[0].source_id, 'msg_08');
  }
);

// 7. Duplicate findings (same source)
runTest('Deduplication (same source)',
  [],
  (res, dedupe) => {
    const dupe1 = { text: "Same", source_id: "msg_1" };
    const dupe2 = { text: "Same", source_id: "msg_1" };
    const deduped = dedupe([dupe1], [dupe2]);
    assert.strictEqual(deduped.length, 1);
  }
);

// 8. Identical text from different sources stays separate (contract from 0c06972)
runTest('Distinct sources are not merged on identical text',
  [],
  (res, dedupe) => {
    const dupe1 = { text: "Task A", source_id: "msg_1" };
    const dupe2 = { text: "Task A", source_id: "msg_2" };
    const deduped = dedupe([dupe1], [dupe2]);
    assert.strictEqual(deduped.length, 2, 'Identical text from different source IDs must remain separate findings');
    assert.strictEqual(deduped[0].source_id, 'msg_1');
    assert.strictEqual(deduped[1].source_id, 'msg_2');
  }
);

// 9. Multiline messages
runTest('Multiline message support',
  [createMsg('10', 'Alice', 'First line\nSecond line')],
  (res) => {
    // Current parser collapses lines into one, let's verify it doesn't crash
    assert.ok(res, 'Should handle multiline input');
  }
);

// 10. Empty input
runTest('Empty input resilience',
  [createMsg('11', 'Bob', '')],
  (res) => {
    assert.strictEqual(Object.values(res).every(arr => arr.length === 0), true);
  }
);

// 11. Dynamic targetUser matching (explicit @targetUser)
runTest('Dynamic targetUser matching',
  [
    createMsg('12', 'Alice', 'Hey team, everything looks fine here'),
    createMsg('13', 'Bob', '@Sumit can you review the PR?'),
    createMsg('14', 'Charlie', 'Sounds good, see you both later')
  ],
  (res) => {
    const r = extractDeterministicFindings(
      [
        createMsg('12', 'Alice', 'Hey team, everything looks fine here'),
        createMsg('13', 'Bob', '@Sumit can you review the PR?'),
        createMsg('14', 'Charlie', 'Sounds good, see you both later')
      ],
      'Sumit'
    );
    assert.strictEqual(r.fallbackNeedsYou.length, 1, 'Should flag exactly one targeted mention');
    assert.strictEqual(r.fallbackNeedsYou[0].source_id, 'msg_13');
    assert.strictEqual(r.fallbackNeedsYou[0].priority, 'high');
  }
);

// 12. targetUser null falls back to any mention / urgent indicator
runTest('targetUser null fallback detection',
  [
    createMsg('15', 'Alice', 'Everything is fine, no action needed'),
    createMsg('16', 'Bob', '@Charlie this is a blocker, please escalate'),
    createMsg('17', 'Dave', 'urgent: the build is down')
  ],
  (res) => {
    const r = extractDeterministicFindings(
      [
        createMsg('15', 'Alice', 'Everything is fine, no action needed'),
        createMsg('16', 'Bob', '@Charlie this is a blocker, please escalate'),
        createMsg('17', 'Dave', 'urgent: the build is down')
      ],
      null
    );
    const ids = r.fallbackNeedsYou.map(f => f.source_id);
    assert.deepStrictEqual(ids, ['msg_16', 'msg_17'], 'Should flag any mention and urgent indicators');
  }
);

// 13. Signature compatibility — calling with no second arg still works
runTest('Signature compatibility (no targetUser)',
  [createMsg('18', 'Eve', '@Bob I will finish the report')],
  (res) => {
    const r = extractDeterministicFindings([createMsg('18', 'Eve', '@Bob I will finish the report')]);
    assert.strictEqual(r.fallbackNeedsYou.length, 1);
    assert.strictEqual(r.fallbackNeedsYou[0].source_id, 'msg_18');
  }
);


// ── NEW REGRESSION TESTS — Bug fixes from adversarial run (Phase 2) ──────────

// 14. Negation — "I can't" must not become an action
runTest('Negation: "I can\'t make it" is not an action',
  [createMsg('20', 'Bob', "I can't make it to the meeting tomorrow")],
  (res) => {
    assert.strictEqual(res.fallbackActions.length, 0, '"I can\'t" is a negation, not a commitment');
  }
);

// 15. Self-mention guard — Bob's own messages not flagged when targetUser = Bob
runTest('Self-mention guard: own messages not flagged',
  [],
  (res) => {
    const r = extractDeterministicFindings([
      createMsg('21', 'Bob', 'I will handle the deployment'),
      createMsg('22', 'Alice', '@Bob can you confirm?'),
      createMsg('23', 'Bob', 'Confirmed')
    ], 'Bob');
    const selfFlags = r.fallbackNeedsYou.filter(f => f.source_id === 'msg_21' || f.source_id === 'msg_23');
    assert.strictEqual(selfFlags.length, 0, "Bob's own messages must not be flagged when targetUser=Bob");
    assert.ok(r.fallbackNeedsYou.some(f => f.source_id === 'msg_22'), 'Alice mentioning Bob must be flagged');
  }
);

// 16. Short-token question resolution — "1 PM works for me"
runTest('Short-token resolution: "1 PM works for me" resolves time question',
  [
    createMsg('24', 'Alice', 'Can we meet at 1 PM?'),
    createMsg('25', 'Bob', '1 PM works for me, I will be there')
  ],
  (res) => {
    assert.strictEqual(res.fallbackQuestions.length, 0, '"1 PM" echo + positive ack must resolve question');
  }
);

// 17. "agreed to disagree" is not a decision
runTest('"Agreed to disagree" is not a decision',
  [createMsg('26', 'Alice', 'We agreed to disagree on this')],
  (res) => {
    assert.strictEqual(res.fallbackDecisions.length, 0, '"agreed to disagree" must not be captured as decision');
  }
);

// 18. "The requirement is TBD" is not a decision
runTest('"Requirement is TBD" is not a decision',
  [createMsg('27', 'Bob', 'The requirement is TBD and will be decided later')],
  (res) => {
    assert.strictEqual(res.fallbackDecisions.length, 0, '"requirement" removed from decision keywords; TBD guard active');
  }
);

// 19. "I will think about it" is not an action
runTest('"I will think about it" is not an action (vague hedge)',
  [createMsg('28', 'Alice', 'I will think about it')],
  (res) => {
    assert.strictEqual(res.fallbackActions.length, 0, '"will think" is a vague hedge, not a commitment');
  }
);

// 20. "We will see" is not an action
runTest('"We will see" is not an action (speculative)',
  [createMsg('29', 'Alice', 'We will see how it goes')],
  (res) => {
    assert.strictEqual(res.fallbackActions.length, 0, '"will see" is speculative, not a commitment');
  }
);

// 21. URL query string "?" does not create a spurious open question
runTest('URL with "?" does not create spurious open question',
  [
    createMsg('30', 'Alice', 'Check this: https://example.com/api?token=xyz&v=2'),
    createMsg('31', 'Bob', 'Got it')
  ],
  (res) => {
    assert.strictEqual(res.fallbackQuestions.length, 0, 'URL query strings must not be treated as questions');
  }
);

console.log('\nAll tests completed successfully.');

