// Only conversation/report data is persisted here. Provider credentials and
// engine options deliberately have no place in this schema.
const categories = ['needs_you', 'action_items', 'decisions', 'open_questions'];
export function normalizeTitle(value) {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title || title.length > 120) throw new Error('Enter a title between 1 and 120 characters.');
  return title;
}

export function createSavedRecord({ id, title, transcript, targetUser, messages, result }, now = new Date().toISOString()) {
  if (typeof id !== 'string' || !id) throw new Error('This catch-up needs an ID.');
  if (!Array.isArray(messages) || !messages.length || !result || typeof result !== 'object') throw new Error('Analyze a conversation before saving it.');
  const cleanResult = { summary_points: (result.summary_points || []).filter(p => typeof p === 'string') };
  for (const category of categories) {
    cleanResult[category] = (result[category] || []).map(item => {
      const clean = {};
      for (const key of ['text', 'quote', 'source_id', 'owner', 'status', 'priority']) {
        if (typeof item[key] === 'string') clean[key] = item[key];
      }
      if (category === 'action_items') clean.completed = Boolean(item.completed);
      if (item.confirmation && typeof item.confirmation.source_id === 'string' && typeof item.confirmation.quote === 'string') {
        clean.confirmation = { source_id: item.confirmation.source_id, quote: item.confirmation.quote };
      }
      return clean;
    });
  }
  if (['local', 'cloud', 'heuristic'].includes(result.processing_mode)) cleanResult.processing_mode = result.processing_mode;
  if (typeof result.notice === 'string') cleanResult.notice = result.notice;
  return {
    schemaVersion: 1, id, title: normalizeTitle(title), createdAt: now, updatedAt: now, recentAt: now, deletedAt: null,
    transcript: typeof transcript === 'string' ? transcript : '', targetUser: typeof targetUser === 'string' ? targetUser : '',
    messages: messages.map(message => ({ id: String(message.id), sender: String(message.sender), text: String(message.text) })),
    result: cleanResult
  };
}

export function reportMetadata(record) {
  const { id, title, createdAt, updatedAt, recentAt, deletedAt, revision } = record;
  return { id, title, createdAt, updatedAt, recentAt, deletedAt, revision,
    messageCount: record.messages.length, mode: record.result.processing_mode || 'local', taskCount: record.result.action_items.length };
}

export function selectSavedReports(records, { trash = false, query = '', limit = Infinity } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  return records.filter(record => Boolean(record.deletedAt) === trash && record.title.toLocaleLowerCase().includes(needle))
    .sort((a, b) => (b.recentAt || b.updatedAt).localeCompare(a.recentAt || a.updatedAt) || a.id.localeCompare(b.id)).slice(0, limit);
}

/** Two stores keep listing history cheap; report + metadata always change atomically. */
export function createCatchupStore(indexedDB = globalThis.indexedDB) {
  let database;
  function open() {
    if (!indexedDB) return Promise.reject(new Error('Saving is unavailable in this browser. You can still download Markdown.'));
    if (!database) database = new Promise((resolve, reject) => {
      let abandoned = false;
      const request = indexedDB.open('catchup-saved-reports', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('reports', { keyPath: 'id' });
        db.createObjectStore('metadata', { keyPath: 'id' });
      };
      request.onerror = () => { database = null; reject(new Error('Could not open saved catch-ups. Check browser storage permissions.')); };
      request.onblocked = () => { abandoned = true; database = null; reject(new Error('Close other CatchUp tabs and retry to update saved storage.')); };
      request.onsuccess = () => {
        const db = request.result;
        if (abandoned) { db.close(); return; }
        db.onversionchange = () => { db.close(); database = null; };
        resolve(db);
      };
    });
    return database;
  }
  async function transaction(mode, operation) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['reports', 'metadata'], mode);
      let value, failure;
      tx.oncomplete = () => resolve(value);
      tx.onabort = tx.onerror = () => reject(failure || new Error('Could not update saved catch-ups. Storage may be full or unavailable. Your current report is still open.'));
      try { operation(tx.objectStore('reports'), tx.objectStore('metadata'), result => { value = result; }, error => { failure = error; tx.abort(); }); }
      catch (error) { tx.abort(); reject(error); }
    });
  }
  async function modify(id, update) {
    return transaction('readwrite', (reports, metadata, done, fail) => {
      const request = reports.get(id);
      request.onsuccess = () => {
        if (!request.result) { done(null); return; }
        try {
          const next = update(request.result);
          if (next) { reports.put(next); metadata.put(reportMetadata(next)); }
          else { reports.delete(id); metadata.delete(id); }
          done(next);
        } catch (error) { fail(error); }
      };
    });
  }
  return {
    list: () => transaction('readonly', (_reports, metadata, done) => { const request = metadata.getAll(); request.onsuccess = () => done(request.result); }),
    get: id => transaction('readonly', (reports, _metadata, done) => { const request = reports.get(id); request.onsuccess = () => done(request.result || null); }),
    save: (record, { expectedRevision } = {}) => transaction('readwrite', (reports, metadata, done, fail) => {
      const request = reports.get(record.id);
      request.onsuccess = () => {
        const previous = request.result;
        if (expectedRevision !== undefined && (!previous || previous.deletedAt || previous.revision !== expectedRevision)) {
          fail(new Error('This saved catch-up changed or was deleted in another tab. Reopen it from My catch-ups before saving, or cancel and download Markdown to keep your current changes.'));
          return;
        }
        const next = { ...record, createdAt: previous?.createdAt || record.createdAt, revision: (previous?.revision || 0) + 1 };
        reports.put(next); metadata.put(reportMetadata(next)); done(next);
      };
    }),
    rename: (id, title) => { const validTitle = normalizeTitle(title); return modify(id, record => ({ ...record, title: validTitle, revision: (record.revision || 0) + 1, updatedAt: new Date().toISOString() })); },
    touch: id => modify(id, record => ({ ...record, recentAt: new Date().toISOString() })),
    trash: id => modify(id, record => ({ ...record, revision: (record.revision || 0) + 1, deletedAt: new Date().toISOString() })),
    restore: id => modify(id, record => ({ ...record, revision: (record.revision || 0) + 1, deletedAt: null, recentAt: new Date().toISOString() })),
    remove: id => modify(id, record => {
      if (!record.deletedAt) throw new Error('This catch-up is no longer in Trash. Move it to Trash before deleting permanently.');
      return null;
    })
  };
}
