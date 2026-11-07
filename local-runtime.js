export const WEBLLM_URL = 'https://esm.run/@mlc-ai/web-llm@0.2.87';
const MODEL_ID = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';
const SUMMARY_SCHEMA = JSON.stringify({
  type: 'object', properties: { summary_ids: { type: 'array', items: { type: 'string' }, maxItems: 4 } },
  required: ['summary_ids'], additionalProperties: false
});

function abortError() {
  return new DOMException('Analysis cancelled.', 'AbortError');
}

export function withDeadline(operation, { signal, timeoutMs, timeoutMessage, stop = () => {} }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('Timeout must be a positive number.'));
  if (signal?.aborted) { stop(); return Promise.reject(abortError()); }
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      error ? reject(error) : resolve(value);
    };
    const cancel = () => { stop(); finish(abortError()); };
    const timer = setTimeout(() => { stop(); finish(new Error(timeoutMessage)); }, timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(() => { if (done) throw abortError(); return operation(); }).then(value => finish(null, value), error => finish(error));
  });
}

/** Dedicated worker owns GPU resources; cancellation destroys that generation. */
export function createLocalRuntime({
  loadLibrary = () => import(WEBLLM_URL),
  createWorker = () => new Worker(new URL('./local-worker.js', import.meta.url), { type: 'module' }),
  cleanupTimeoutMs = 5000
} = {}) {
  let entry = null;
  let busy = false;
  let cleanup = Promise.resolve();
  function reset(expected = entry, force = false) {
    if (!expected || expected.stopped) return;
    expected.stopped = true;
    expected.rejectFailure?.(abortError());
    expected.worker?.removeEventListener?.('error', expected.onError);
    if (entry === expected) entry = null;
    if (!expected.worker) return;
    if (force || !expected.engine?.unload) { expected.worker.terminate(); return; }
    // Let WebLLM release its GPU device before killing the worker. Abruptly
    // terminating during GPU work can make some drivers reject the next adapter.
    const release = (async () => {
      let timer;
      try {
        expected.engine.interruptGenerate?.();
        await Promise.race([expected.engine.unload(), new Promise(resolve => { timer = setTimeout(resolve, cleanupTimeoutMs); })]);
      } catch { /* A failed worker still needs the hard termination below. */ }
      finally { clearTimeout(timer); expected.worker.terminate(); }
    })();
    cleanup = Promise.all([cleanup, release]).then(() => {});
  }
  async function init(onProgress) {
    if (entry?.ready) return entry.engine;
    if (!entry) {
      const current = { worker: null, ready: false, listeners: new Set() };
      entry = current;
      current.promise = (async () => {
        await cleanup;
        if (entry !== current) throw abortError();
        const library = await loadLibrary();
        if (entry !== current) throw abortError();
        current.worker = createWorker();
        current.failure = new Promise((resolve, reject) => {
          current.rejectFailure = reject;
          current.onError = () => { reject(new Error('The local AI worker stopped. Retry or choose Instant Rules.')); reset(current, true); };
          current.worker.addEventListener?.('error', current.onError);
        });
        current.failure.catch(() => {});
        current.engine = new library.WebWorkerMLCEngine(current.worker, {
          initProgressCallback: info => {
            if (entry === current) for (const listener of current.listeners) listener({ ...info, stage: 'loading' });
          }
        });
        await Promise.race([current.engine.reload(MODEL_ID), current.failure]);
        if (entry !== current) throw abortError();
        current.ready = true;
        return current.engine;
      })().catch(error => { reset(current); throw error; });
    }
    const current = entry;
    if (onProgress) current.listeners.add(onProgress);
    try { return await current.promise; }
    finally { current.listeners.delete(onProgress); }
  }
  return {
    init,
    isReady: () => Boolean(entry?.ready),
    async run(messages, onProgress, { signal, loadTimeoutMs = 180000, inferenceTimeoutMs = 60000 } = {}) {
      if (busy) throw new Error('A local analysis is already running. Cancel it before starting another.');
      if (signal?.aborted) throw abortError();
      busy = true;
      try {
        if (!entry?.ready) onProgress?.({ stage: 'loading', text: 'Preparing the local model. First use downloads model files and can take several minutes.', progress: 0 });
        const engine = await withDeadline(() => init(onProgress), {
          signal, timeoutMs: loadTimeoutMs, stop: () => reset(),
          timeoutMessage: 'Local model loading timed out. Retry to reuse downloaded files, or choose Instant Rules.'
        });
        onProgress?.({ stage: 'inference', text: 'Model ready. Selecting source messages for your briefing…' });
        return await withDeadline(() => Promise.race([engine.chat.completions.create({
          messages, temperature: 0.1, max_tokens: 128, response_format: { type: 'json_object', schema: SUMMARY_SCHEMA }
        }), entry.failure]), {
          signal, timeoutMs: inferenceTimeoutMs, stop: () => reset(),
          timeoutMessage: 'Local analysis timed out. Choose Instant Rules or retry the local model.'
        });
      } catch (error) {
        reset();
        if (typeof error === 'string' && /compatible GPU|WebGPU|adapter/i.test(error)) throw new Error('WebGPU is unavailable on this device. Use Instant Rules or retry in a WebGPU-capable browser.');
        throw error instanceof Error ? error : new Error('Local AI could not finish on this device. Retry or choose Instant Rules.');
      } finally { busy = false; }
    }
  };
}

export const localRuntime = createLocalRuntime();
