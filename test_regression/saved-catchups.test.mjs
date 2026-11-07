import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createCatchupStore, createSavedRecord, normalizeTitle, selectSavedReports } from '../saved-catchups.js';
import { generateMarkdown } from '../report.js';

const time = '2026-11-08T10:00:00.000Z';
function sample(id = 'one', title = 'Planning') {
  return createSavedRecord({ id, title, transcript: 'Alice: I will write the notes.', targetUser: 'Alice',
    messages: [{ id: 'msg_01', sender: 'Alice', text: 'I will write the notes.', apiKey: 'must-not-save' }],
    apiKey: 'must-not-save', result: { processing_mode: 'heuristic', apiKey: 'must-not-save', summary_points: ['I will write the notes.'],
      action_items: [{ text: 'Write the notes', quote: 'I will write the notes.', owner: 'Alice', source_id: 'msg_01', status: 'confirmed', completed: true,
        confirmation: { source_id: 'msg_02', quote: 'Agreed.', apiKey: 'must-not-save' } }], decisions: [], open_questions: [], needs_you: [] }
  }, time);
}

test('snapshot excludes configuration and credentials at every supported level', () => {
  assert.equal(JSON.stringify(sample()).includes('must-not-save'), false);
});
test('titles trim whitespace, preserve user wording, and reject empty/oversize titles', () => {
  assert.equal(normalizeTitle('  <Planning> 日本語  '), '<Planning> 日本語');
  for (const title of ['', '   ', 'x'.repeat(121), null]) assert.throws(() => normalizeTitle(title), /title/);
});
test('saving requires an analyzed report', () => {
  assert.throws(() => createSavedRecord({ id: 'x', title: 'x', messages: [] }), /Analyze/);
});
test('save, reopen through another store instance, and export preserve completion/evidence', async () => {
  const db = new IDBFactory(); const first = createCatchupStore(db);
  await first.save(sample());
  const second = createCatchupStore(db); const read = await second.get('one');
  assert.equal(read.transcript, sample().transcript);
  assert.deepEqual(read.messages, sample().messages);
  assert.equal(read.result.action_items[0].completed, true);
  assert.equal(read.result.action_items[0].confirmation.quote, 'Agreed.');
  assert.match(generateMarkdown(read.result), /\[x\]/);
  assert.equal((await second.list())[0].transcript, undefined);
});
test('saved snapshot is independent of later changes to the open report', async () => {
  const store = createCatchupStore(new IDBFactory()); const record = sample();
  await store.save(record); record.result.action_items[0].completed = false;
  assert.equal((await store.get('one')).result.action_items[0].completed, true);
});
test('updating an existing report preserves creation date and does not duplicate history', async () => {
  const store = createCatchupStore(new IDBFactory()); await store.save(sample());
  const next = sample(); next.createdAt = next.updatedAt = '2026-11-09T10:00:00.000Z'; next.result.action_items[0].completed = false;
  await store.save(next);
  assert.equal((await store.get('one')).createdAt, time);
  assert.equal((await store.get('one')).result.action_items[0].completed, false);
  assert.equal((await store.list()).length, 1);
});
test('renaming changes title without overwriting saved report/task data', async () => {
  const store = createCatchupStore(new IDBFactory()); await store.save(sample());
  await store.rename('one', '  Release planning  ');
  const result = await store.get('one');
  assert.equal(result.title, 'Release planning'); assert.equal(result.result.action_items[0].completed, true);
  assert.equal((await store.list())[0].title, result.title);
  assert.throws(() => store.rename('one', ' '), /title/);
});
test('trash hides a report from recent/saved views and restore recovers original content', async () => {
  const store = createCatchupStore(new IDBFactory()); await store.save(sample()); await store.trash('one');
  assert.equal(selectSavedReports(await store.list()).length, 0);
  assert.equal(selectSavedReports(await store.list(), { trash: true }).length, 1);
  await store.restore('one');
  assert.equal(selectSavedReports(await store.list()).length, 1);
  assert.equal((await store.get('one')).transcript, sample().transcript);
});
test('permanent deletion removes the record and its metadata; other reports remain', async () => {
  const store = createCatchupStore(new IDBFactory()); await store.save(sample()); await store.save(sample('two'));
  await store.trash('one'); await store.remove('one');
  assert.equal(await store.get('one'), null); assert.deepEqual((await store.list()).map(r => r.id), ['two']);
});
test('opening history updates recency without changing saved edits', async () => {
  const store = createCatchupStore(new IDBFactory()); await store.save(sample()); await store.touch('one');
  const result = await store.get('one'); assert.notEqual(result.recentAt, time); assert.equal(result.updatedAt, time);
});
test('search ignores case/outer whitespace, excludes trash, limits recents, never mutates input', () => {
  const list = [sample('a', 'Release'), sample('b', 'Other'), sample('c', 'Release notes')];
  list[1].recentAt = '2026-11-09T10:00:00.000Z'; list[2].deletedAt = time;
  const before = structuredClone(list);
  assert.deepEqual(selectSavedReports(list, { query: ' RELEASE ' }).map(r => r.id), ['a']);
  assert.deepEqual(selectSavedReports(list, { limit: 1 }).map(r => r.id), ['b']);
  assert.deepEqual(list, before);
});
test('unavailable or denied storage rejects instead of claiming a successful save', async () => {
  await assert.rejects(createCatchupStore(null).save(sample()), /unavailable/);
  const denied = { open() { const request = {}; queueMicrotask(() => request.onerror()); return request; } };
  await assert.rejects(createCatchupStore(denied).save(sample()), /permissions/);
});
test('failed atomic save cannot leave orphan metadata or overwrite an existing report', async () => {
  const db = new IDBFactory(); const store = createCatchupStore(db); await store.save(sample());
  const corrupt = sample('two'); corrupt.result.uncloneable = () => {};
  await assert.rejects(store.save(corrupt), /Storage|storage|clone|cloned/i);
  assert.equal(await store.get('two'), null); assert.equal((await store.list()).length, 1);
  assert.equal((await store.get('one')).title, 'Planning');
});
test('a stale tab cannot overwrite a more recent saved version', async () => {
  const db = new IDBFactory(); const first = createCatchupStore(db), second = createCatchupStore(db);
  const original = await first.save(sample());
  await second.rename('one', 'Updated in another tab');
  await assert.rejects(first.save(sample(), { expectedRevision: original.revision }), /changed/);
  assert.equal((await first.get('one')).title, 'Updated in another tab');
});
test('saving stale progress cannot resurrect a trashed or permanently deleted report', async () => {
  const store = createCatchupStore(new IDBFactory()); const original = await store.save(sample());
  await store.trash('one');
  await assert.rejects(store.save(sample(), { expectedRevision: original.revision }), /deleted/);
  await store.remove('one');
  await assert.rejects(store.save(sample(), { expectedRevision: original.revision }), /deleted/);
  assert.equal((await store.list()).length, 0);
});
test('a stale delete dialog cannot permanently remove a report restored in another tab', async () => {
  const db = new IDBFactory(); const first = createCatchupStore(db), second = createCatchupStore(db);
  await first.save(sample()); await first.trash('one'); await second.restore('one');
  await assert.rejects(first.remove('one'), /no longer in Trash/);
  assert.equal((await first.get('one')).title, 'Planning');
});
