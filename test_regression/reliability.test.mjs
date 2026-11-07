import test from 'node:test';
import assert from 'node:assert/strict';
// Import the actual production modules, including their real dependency graph.
import { analyzeConversation, parseConversation, resolveCloudConfig, DEFAULT_GEMINI_MODEL } from '../engine.js';
import { validateAnalysis } from '../evidence.js';
import { extractDeterministicFindings, dedupe } from '../heuristics.js';

const msg = (sender, text, id = 'msg_01') => ({ id, sender, text });
const messages = [msg('Alice', 'I will ship the report.'), msg('Bob', 'Thanks.', 'msg_02')];
const options = { mode: 'cloud', apiProvider: 'openai', apiKey: 'fake-test-key' };
function mockFetch(t, result, status = 200) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, ...init });
    return { ok: status < 400, status, json: async () => result };
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}
const chatReply = content => ({ choices: [{ message: { content } }] });

for (const [label, input, expected] of [
  ['hyphenated names', 'Mary-Jane: Hello\nBob: Hi', ['Mary-Jane', 'Bob']],
  ['Unicode and apostrophes', "José: Hello\nO’Connor: Hi\nअनन्या: Namaste", ['José', 'O’Connor', 'अनन्या']],
  ['Android WhatsApp', '07/11/2026, 10:30 - Alice: Hello\n07/11/2026, 10:31 - Bob: Hi', ['Alice', 'Bob']],
  ['12-hour Android WhatsApp', '11/7/26, 1:30 PM - Alice: Hello\n11/7/26, 1:31 PM - Bob: Hi', ['Alice', 'Bob']],
  ['iOS WhatsApp', '[07/11/2026, 10:30:00] Alice: Hello\n[07/11/2026, 10:31:00] Bob: Hi', ['Alice', 'Bob']],
  ['phone numbers and direction marks', '\u200e[07/11/2026, 10:30] +91 99999 12345: Hello\nBob: Hi', ['+91 99999 12345', 'Bob']],
  ['sender timestamps', 'Alice (10:30 AM): Hello\nBob (10:31 AM): Hi', ['Alice', 'Bob']]
]) {
  test(`parser preserves every speaker: ${label}`, () => {
    const parsed = parseConversation(input);
    assert.deepEqual(parsed.map(item => item.sender), expected);
    assert.equal(parsed.length, expected.length);
    assert.deepEqual(parsed.map(item => item.id), expected.map((_, i) => `msg_${String(i + 1).padStart(2, '0')}`));
  });
}
test('parser preserves multiline text and colons in URLs', () => {
  const parsed = parseConversation('Alice: Start\n  follow up\nhttps://example.com/a:b\nBob: Finish');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].text, 'Start follow up https://example.com/a:b');
});
test('bracketed continuations and message-body times are not treated as export headers', () => {
  const parsed = parseConversation('Alice: Meet at  10:30 AM\n[Reminder] Bring the report\nBob: Got it');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].text, 'Meet at  10:30 AM [Reminder] Bring the report');
});
test('WhatsApp system notices do not become somebody else’s words', () => {
  const parsed = parseConversation('07/11/2026, 10:30 - Alice: Hello\n07/11/2026, 10:31 - Bob joined using an invite link\n07/11/2026, 10:32 - Bob: Hi');
  assert.deepEqual(parsed.map(item => item.text), ['Hello', 'Hi']);
});
test('unsupported sender headers fail explicitly instead of merging speakers', () => {
  assert.throws(() => parseConversation('Alice: Hello\n👩‍💻: New message'), /Unrecognized message header/);
  assert.throws(() => parseConversation('[07/11/2026, 10:30] 👩‍💻: New message\nBob: Hi'), /Unrecognized message header/);
});

for (const provider of ['openai', 'groq', 'gemini']) {
  test(`${provider} ignores a saved custom endpoint`, () => {
    const config = resolveCloudConfig({ ...options, apiProvider: provider, customEndpoint: 'https://unrelated.example/api' });
    assert.equal(new URL(config.endpoint).hostname, { openai: 'api.openai.com', groq: 'api.groq.com', gemini: 'generativelanguage.googleapis.com' }[provider]);
  });
}
for (const endpoint of ['https://proxy.example/v1/chat/completions', 'http://localhost:11434/v1/chat/completions', 'http://127.0.0.1:11434/v1/chat/completions', 'http://[::1]:11434/v1/chat/completions']) {
  test(`custom mode accepts explicit endpoint ${endpoint}`, () => {
    assert.equal(resolveCloudConfig({ ...options, apiProvider: 'custom', customEndpoint: endpoint }).endpoint, endpoint);
  });
}
for (const endpoint of ['', 'garbage', 'http://public.example/api', 'https://user:pass@proxy.example/api', 'https://proxy.example/api#secret', 'javascript:alert(1)', 'http://localhost.evil.example/api']) {
  test(`custom mode rejects unsafe/missing endpoint ${endpoint}`, () => {
    assert.throws(() => resolveCloudConfig({ ...options, apiProvider: 'custom', customEndpoint: endpoint }));
  });
}
test('unknown providers fail closed', () => {
  assert.throws(() => resolveCloudConfig({ ...options, apiProvider: 'typo' }), /Unknown cloud provider/);
});
test('real cloud request stays on selected provider and forbids redirects', async t => {
  const calls = mockFetch(t, chatReply('{}'));
  await analyzeConversation(messages, null, null, { ...options, customEndpoint: 'https://unrelated.example/api' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].headers.Authorization, 'Bearer fake-test-key');
  assert.equal(calls[0].redirect, 'error');
});
test('Gemini uses current default, header authentication and compatible JSON configuration', async t => {
  const calls = mockFetch(t, { candidates: [{ content: { parts: [{ text: '{}' }] } }] });
  await analyzeConversation(messages, null, null, { ...options, apiProvider: 'gemini' });
  assert.equal(DEFAULT_GEMINI_MODEL, 'gemini-3.5-flash-lite');
  assert.equal(calls[0].url, `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`);
  assert.ok(!calls[0].url.includes(options.apiKey));
  assert.equal(calls[0].headers['x-goog-api-key'], options.apiKey);
  assert.deepEqual(JSON.parse(calls[0].body).generationConfig, { responseMimeType: 'application/json' });
});
test('HTTP errors do not display provider-echoed keys or transcripts', async t => {
  mockFetch(t, { error: { message: 'fake-test-key private transcript' } }, 401);
  await assert.rejects(analyzeConversation(messages, null, null, options), error => /HTTP 401/.test(error.message) && !/fake-test-key|private transcript/.test(error.message));
});
test('cloud timeout aborts the request', async t => {
  const original = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = (_, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
  });
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(analyzeConversation(messages, null, null, { ...options, timeoutMs: 5 }), /timed out/);
  assert.equal(aborted, true);
});

const finding = { text: 'Ship report', quote: 'I will ship the report.', source_id: 'msg_01', owner: 'Alice' };
test('exact evidence replaces model paraphrases and keeps the real source', () => {
  const result = validateAnalysis({ action_items: [finding] }, messages);
  assert.deepEqual(result.action_items, [{ ...finding, text: finding.quote }]);
});
for (const invalid of [
  { ...finding, source_id: 'msg_02' },
  { ...finding, source_id: 'missing' },
  { ...finding, source_id: null },
  { ...finding, quote: 'iwillshipthereport' },
  { ...finding, quote: 'i will ship the report.' },
  { ...finding, quote: '   ' },
  { ...finding, quote: 123 },
  null,
  []
]) {
  test(`reject malformed or mismatched evidence ${JSON.stringify(invalid)}`, () => {
    assert.deepEqual(validateAnalysis({ action_items: [invalid] }, messages).action_items, []);
  });
}
test('Unicode quotes are verified without discarding their characters', () => {
  const source = msg('José', 'Enviaré el informe mañana.');
  assert.equal(validateAnalysis({ action_items: [{ quote: source.text, source_id: source.id, owner: 'José' }] }, [source]).action_items[0].text, source.text);
});
test('invented and merely discussed owners are removed', () => {
  for (const owner of ['Imaginary', 'Al', 'Bob']) {
    const source = msg('Alice', 'I will ship the report. Bob reviewed it.');
    assert.equal(validateAnalysis({ action_items: [{ ...finding, owner }] }, [source]).action_items[0].owner, null);
  }
});
test('explicit assignees in the cited message are preserved', () => {
  for (const text of ['@Bob please ship the report.', 'Bob, can you ship the report?']) {
    assert.equal(validateAnalysis({ action_items: [{ quote: text, source_id: 'msg_01', owner: 'Bob' }] }, [msg('Alice', text)]).action_items[0].owner, 'Bob');
  }
});
test('unsupported summaries are rejected while cited summary quotes survive', () => {
  const result = validateAnalysis({ summary_points: ['Launch approved.', { quote: 'Thanks.', source_id: 'msg_01' }, { quote: 'I will ship the report.', source_id: 'msg_01' }] }, messages);
  assert.deepEqual(result.summary_points, ['I will ship the report.']);
});
test('negated deployment evidence cannot become an affirmative task', async t => {
  mockFetch(t, chatReply(JSON.stringify({ action_items: [{ text: 'Deploy today', quote: 'must not deploy', source_id: 'msg_01', owner: 'Imaginary' }], summary_points: ['Launch approved.'] })));
  const result = await analyzeConversation([msg('Alice', 'We must not deploy today.')], null, null, options);
  assert.deepEqual(result.action_items, []);
  assert.ok(!result.summary_points.some(point => point.includes('Launch approved')));
});
for (const payload of [null, [], 123, { action_items: [null, { quote: 123 }] }, { results: null }]) {
  test(`malformed JSON shape produces safe deterministic results: ${JSON.stringify(payload)}`, async t => {
    mockFetch(t, chatReply(JSON.stringify(payload)));
    const result = await analyzeConversation(messages, null, null, options);
    assert.equal(result.action_items.length, 1);
    assert.equal(result.action_items[0].owner, 'Alice');
    assert.ok(result.summary_points.length);
  });
}
test('Markdown-wrapped JSON remains supported', async t => {
  mockFetch(t, chatReply('```json\n{"summary_points":[{"quote":"Thanks.","source_id":"msg_02"}]}\n```'));
  const result = await analyzeConversation(messages, null, null, options);
  assert.deepEqual(result.summary_points, ['Thanks.']);
});
test('invalid JSON errors never echo model output', async t => {
  mockFetch(t, chatReply('private transcript is not JSON'));
  await assert.rejects(analyzeConversation(messages, null, null, options), error => /valid JSON/.test(error.message) && !error.message.includes('private transcript'));
});
test('invalid fenced JSON errors never echo model output', async t => {
  mockFetch(t, chatReply('```json\nprivate transcript is not JSON\n```'));
  await assert.rejects(analyzeConversation(messages, null, null, options), error => /valid JSON/.test(error.message) && !error.message.includes('private transcript'));
});
test('invalid HTTP response JSON errors never echo response contents', async t => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => { throw new SyntaxError('private transcript'); } });
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(analyzeConversation(messages, null, null, options), error => /invalid JSON/.test(error.message) && !error.message.includes('private transcript'));
});
test('null provider envelope produces an actionable error', async t => {
  mockFetch(t, null);
  await assert.rejects(analyzeConversation(messages, null, null, options), /empty response content/);
});
test('result metadata records cloud versus on-device processing', async t => {
  mockFetch(t, chatReply('{}'));
  assert.equal((await analyzeConversation(messages, null, null, options)).processing_mode, 'cloud');
  assert.equal((await analyzeConversation(messages, null, null, { mode: 'heuristic' })).processing_mode, 'heuristic');
});
test('Instant Rules works through production imports without any network', async t => {
  const calls = mockFetch(t, {});
  const result = await analyzeConversation(messages, null, null, { mode: 'heuristic' });
  assert.equal(result.action_items.length, 1);
  assert.deepEqual(calls, []);
});
test('reserved object names cannot break owner grouping', async () => {
  const result = await analyzeConversation([msg('__proto__', 'I will ship the report.')], null, null, { mode: 'heuristic' });
  assert.equal(result.action_items[0].owner, '__proto__');
});
test('duplicate IDs are rejected before requesting a provider', async t => {
  const calls = mockFetch(t, {});
  await assert.rejects(analyzeConversation([messages[0], messages[0]], null, null, options), /unique string IDs/);
  assert.deepEqual(calls, []);
});
test('@ prefix does not bypass self-mention guard', () => {
  assert.deepEqual(extractDeterministicFindings([msg('Alice', '@Alice I will send the report.')], '@Alice').fallbackNeedsYou, []);
});
test('unrelated acknowledgements do not answer information questions', () => {
  for (const question of ['Where is the production password?', 'Can you tell me where the report is?']) {
    assert.equal(extractDeterministicFindings([msg('Alice', question), msg('Bob', 'Great!', 'msg_02')]).fallbackQuestions.length, 1);
  }
});
test('negated agreements are not classified as decisions', () => {
  for (const text of ['We never agreed to deploy today.', 'We have not decided to ship.', "We didn't agree to ship."]) {
    assert.deepEqual(extractDeterministicFindings([msg('Alice', text)]).fallbackDecisions, []);
    assert.deepEqual(validateAnalysis({ decisions: [{ quote: text, source_id: 'msg_01' }] }, [msg('Alice', text)]).decisions, []);
  }
});
test('a decision not to deploy is still a decision', () => {
  assert.equal(extractDeterministicFindings([msg('Alice', 'We decided not to deploy today.')]).fallbackDecisions.length, 1);
});
test('dedupe preserves conflicting explicit owners, removes actual duplicates and never mutates inputs', () => {
  const alice = { text: 'Task', quote: 'Do work', source_id: 'msg_01', owner: 'Alice' };
  const bob = { ...alice, owner: 'Bob' };
  const unassigned = { ...alice, owner: null };
  const original = structuredClone([alice, bob, unassigned]);
  const result = dedupe([unassigned, alice], [bob, alice, bob]);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(item => item.owner).sort(), ['Alice', 'Bob']);
  assert.deepEqual([alice, bob, unassigned], original);
});
