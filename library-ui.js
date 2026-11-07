import { createCatchupStore, createSavedRecord, selectSavedReports } from './saved-catchups.js';

export function createLibraryUI({ getSnapshot, onOpen, onNew, navigate, isBusy }) {
  const $ = id => document.getElementById(id);
  const store = createCatchupStore();
  let records = [], activeId = null, activeTitle = '', activeRevision, dirty = false, trashView = false;
  let saving = false, editingId = null, deletingId = null, refreshVersion = 0;
  const titleDialog = $('save-catchup-dialog'), deleteDialog = $('delete-catchup-dialog');
  const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const status = text => { $('save-report-status').textContent = text; };
  function button(text, action, label = text) {
    const element = document.createElement('button');
    element.type = 'button'; element.className = 'secondary-btn'; element.textContent = text;
    element.setAttribute('aria-label', label); element.addEventListener('click', action);
    return element;
  }
  function message(text) { const p = document.createElement('p'); p.className = 'library-empty'; p.textContent = text; return p; }
  let resolveLeave = null;
  function finishLeave(leave) {
    $('unsaved-catchup-dialog').close();
    const resolve = resolveLeave; resolveLeave = null;
    resolve?.(leave);
  }
  async function canLeave() {
    if (!dirty) return true;
    if (resolveLeave) return false;
    return new Promise(resolve => {
      resolveLeave = resolve; $('unsaved-catchup-dialog').showModal();
    });
  }
  $('unsaved-keep-btn').addEventListener('click', () => finishLeave(false));
  $('unsaved-discard-btn').addEventListener('click', () => finishLeave(true));
  $('unsaved-catchup-dialog').addEventListener('cancel', event => { event.preventDefault(); finishLeave(false); });
  function setActive(record) {
    activeId = record?.id || null; activeTitle = record?.title || ''; dirty = false;
    activeRevision = record?.revision;
    $('report-heading').textContent = activeTitle || 'Analysis Results';
    $('save-catchup-btn').textContent = activeId ? 'Save changes' : 'Save catch-up';
    status(activeId ? 'Saved on this device.' : 'Not saved. Save this catch-up to reopen it later.');
  }
  function render() {
    const visible = selectSavedReports(records, { trash: trashView, query: $('library-search').value });
    $('library-count').textContent = records.filter(record => !record.deletedAt).length;
    $('library-saved-btn').setAttribute('aria-pressed', String(!trashView));
    $('library-trash-btn').setAttribute('aria-pressed', String(trashView));
    $('library-list').replaceChildren();
    if (!visible.length) $('library-list').append(message($('library-search').value.trim() ? 'No catch-ups match this title.' : trashView ? 'Trash is empty. Deleted catch-ups can be restored here until you delete them permanently.' : 'No saved catch-ups yet. Analyze a conversation, then choose Save catch-up.'));
    visible.forEach(record => {
      const card = document.createElement('article'); card.className = 'saved-catchup-card';
      const body = document.createElement('div'); body.className = 'saved-catchup-body';
      const title = document.createElement('h2'); title.textContent = record.title;
      const meta = document.createElement('p');
      const mode = { local: 'Local AI', cloud: 'Cloud API', heuristic: 'Instant Rules' }[record.mode] || 'Local AI';
      meta.textContent = `${record.messageCount} ${record.messageCount === 1 ? 'message' : 'messages'} · ${record.taskCount} ${record.taskCount === 1 ? 'task' : 'tasks'} · ${mode} · Saved ${dates.format(new Date(record.updatedAt))}`;
      body.append(title, meta); card.append(body);
      const actions = document.createElement('div'); actions.className = 'saved-catchup-actions';
      if (trashView) {
        actions.append(button('Restore', () => mutate(() => store.restore(record.id), 'Catch-up restored.'), `Restore ${record.title}`));
        actions.append(button('Delete permanently', () => {
          deletingId = record.id;
          $('delete-dialog-note').textContent = `“${record.title}” and its saved conversation will be removed from this browser. This cannot be undone.`;
          $('delete-dialog-error').textContent = ''; deleteDialog.showModal();
        }, `Delete ${record.title} permanently`));
      } else {
        actions.append(button('Open', () => openRecord(record.id), `Open ${record.title}`));
        actions.append(button('Rename', () => showTitle(record), `Rename ${record.title}`));
        actions.append(button('Move to Trash', async () => {
          if (record.id === activeId && !(await canLeave())) return;
          await mutate(async () => {
            await store.trash(record.id);
            if (activeId === record.id) { setActive(null); status('Moved to Trash. The open report is now an unsaved copy.'); }
          }, 'Moved to Trash. You can restore it from the Trash view.');
        }, `Move ${record.title} to Trash`));
      }
      card.append(actions); $('library-list').append(card);
    });
    const recent = selectSavedReports(records, { limit: 5 });
    $('recent-catchups').replaceChildren();
    if (!recent.length) $('recent-catchups').append(message('Saved catch-ups will appear here.'));
    recent.forEach(record => {
      const recentButton = button(record.title, () => openRecord(record.id), `Open recent catch-up: ${record.title}`);
      recentButton.className = 'recent-catchup'; recentButton.title = record.title;
      if (record.id === activeId) recentButton.setAttribute('aria-current', 'true');
      $('recent-catchups').append(recentButton);
    });
  }
  async function refresh() {
    const version = ++refreshVersion;
    try {
      const data = await store.list();
      if (version !== refreshVersion) return;
      records = data; $('library-retry-btn').classList.add('hidden'); render();
    } catch (error) {
      if (version !== refreshVersion) return;
      $('library-feedback').textContent = error.message;
      $('library-retry-btn').classList.remove('hidden');
    }
  }
  async function mutate(action, success) {
    if (saving) return;
    saving = true; $('library-list').setAttribute('aria-busy', 'true');
    try { await action(); $('library-feedback').textContent = success; await refresh(); }
    catch (error) { $('library-feedback').textContent = error.message; }
    finally { saving = false; $('library-list').removeAttribute('aria-busy'); }
  }
  async function openRecord(id) {
    if (saving || !(await canLeave())) return;
    if (saving) return;
    saving = true;
    try {
      const record = await store.get(id);
      if (!record || record.deletedAt) { await refresh(); throw new Error('This catch-up is no longer available. Check Trash or reload your saved list.'); }
      // onOpen aborts an active analysis before changing its source messages.
      onOpen(record); setActive(record); navigate('analyze');
      await store.touch(id); await refresh();
    } catch (error) { $('library-feedback').textContent = error.message; status(error.message); }
    finally { saving = false; }
  }
  function showTitle(record = null) {
    if (saving || isBusy()) return;
    editingId = record?.id || null;
    $('save-dialog-title').textContent = record ? 'Rename catch-up' : activeId ? 'Save changes' : 'Save catch-up';
    $('save-dialog-note').textContent = record ? 'Choose a title you can find again.' : 'This saves the conversation, report, and task progress on this device. API keys are not included.';
    $('catchup-title').value = record?.title || activeTitle;
    $('save-dialog-error').textContent = '';
    titleDialog.showModal(); $('catchup-title').focus();
  }
  $('save-catchup-btn').addEventListener('click', () => showTitle());
  $('save-dialog-cancel').addEventListener('click', () => { if (!saving) titleDialog.close(); });
  titleDialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  $('save-catchup-form').addEventListener('submit', async event => {
    event.preventDefault(); if (saving) return;
    saving = true; $('save-dialog-submit').disabled = true;
    try {
      const title = $('catchup-title').value;
      if (editingId) {
        const updated = await store.rename(editingId, title);
        if (!updated) throw new Error('This catch-up was removed in another tab. Reload your list.');
        if (editingId === activeId) { activeTitle = updated.title; if (updated.revision === (activeRevision || 0) + 1) activeRevision = updated.revision; $('report-heading').textContent = activeTitle; }
      } else {
        const snapshot = getSnapshot();
        const record = createSavedRecord({ ...snapshot, id: activeId || crypto.randomUUID(), title });
        const saved = await store.save(record, activeId ? { expectedRevision: activeRevision } : {}); setActive(saved);
      }
      titleDialog.close(); $('library-feedback').textContent = 'Catch-up saved.'; await refresh();
    } catch (error) { $('save-dialog-error').textContent = error.message; }
    finally { saving = false; $('save-dialog-submit').disabled = false; }
  });
  $('delete-dialog-cancel').addEventListener('click', () => { if (!saving) deleteDialog.close(); });
  deleteDialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  $('delete-catchup-form').addEventListener('submit', async event => {
    event.preventDefault(); if (saving || !deletingId) return;
    saving = true; $('delete-dialog-submit').disabled = true;
    try { await store.remove(deletingId); deleteDialog.close(); $('library-feedback').textContent = 'Catch-up permanently deleted.'; await refresh(); }
    catch (error) { $('delete-dialog-error').textContent = error.message; }
    finally { saving = false; $('delete-dialog-submit').disabled = false; }
  });
  $('nav-library').addEventListener('click', event => { event.preventDefault(); navigate('library'); refresh(); });
  $('library-search').addEventListener('input', render);
  $('library-saved-btn').addEventListener('click', () => { trashView = false; render(); });
  $('library-trash-btn').addEventListener('click', () => { trashView = true; render(); });
  $('library-retry-btn').addEventListener('click', refresh);
  $('new-catchup-btn').addEventListener('click', async event => {
    event.preventDefault(); if (!(await canLeave())) return;
    onNew(); setActive(null); navigate('analyze'); render();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  refresh();
  return {
    generated() { setActive(null); render(); },
    changed() { dirty = true; status('Unsaved changes. Choose Save catch-up or Save changes to keep task progress.'); },
    canLeave
  };
}
