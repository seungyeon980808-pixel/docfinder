export function previewSourceKey(item) {
  return JSON.stringify([item.libraryId || '', item.id, item.source, item.sourceUrl, item.modifiedTime, item.sha256 || item.version || '', item.localFile?.name, item.localFile?.lastModified]);
}

// Cache originals, not transferred PDF worker buffers. Consumers own a copy.
export function createByteCache(loader, budget = 48 * 1024 * 1024, { validate, concurrency = 2 } = {}) {
  const entries = new Map();
  const waiting = [];
  let size = 0; let running = 0; let generation = 0;
  const cancelled = () => new DOMException('원문 준비를 중단했습니다.', 'AbortError');
  function remove(key, entry) {
    if (entries.get(key) !== entry) return;
    entries.delete(key); size -= entry.size;
  }
  function drain() {
    while (running < concurrency && waiting.length) {
      const entry = waiting.pop(); // The latest selected original has priority.
      if (entry.abort.signal.aborted) { entry.reject(cancelled()); continue; }
      running++;
      Promise.resolve().then(() => loader(entry.item, { signal: entry.abort.signal })).then(bytes => {
        entry.ready = true;
        if (entries.get(entry.key) === entry && !entry.abort.signal.aborted) {
          entry.size = bytes.byteLength; size += entry.size;
          for (const [oldKey, oldEntry] of entries) {
            if (size <= budget && entries.size <= 8) break;
            if (oldEntry.ready) remove(oldKey, oldEntry);
          }
        }
        entry.resolve(bytes);
      }, error => { remove(entry.key, entry); entry.reject(error); }).finally(() => { running--; drain(); });
    }
  }
  const load = async (item, { signal } = {}) => {
    if (signal?.aborted) throw cancelled();
    const job = generation;
    const key = previewSourceKey(item);
    let entry = entries.get(key);
    const ready = entry?.ready;
    if (!entry) {
      entry = { key, item, size: 0, ready: false, users: 0, abort: new AbortController() };
      entry.promise = new Promise((resolve, reject) => Object.assign(entry, { resolve, reject }));
      entries.set(key, entry);
      waiting.push(entry); queueMicrotask(drain);
    } else { entries.delete(key); entries.set(key, entry); }
    entry.users++;
    let rejectAbort;
    const abortPromise = new Promise((resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(cancelled());
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // Private originals remain in memory only. Recheck permission on EVERY reuse.
      if (ready && validate) {
        try { await Promise.race([validate(item, { signal }), abortPromise]); }
        catch (error) { remove(key, entry); throw error; }
      }
      const bytes = await Promise.race([entry.promise, abortPromise]);
      if (job !== generation || signal?.aborted || entry.abort.signal.aborted) throw cancelled();
      return bytes.slice(0);
    } finally {
      signal?.removeEventListener('abort', onAbort); entry.users--;
      if (!entry.users && !entry.ready) { entry.abort.abort(); remove(key, entry); }
    }
  };
  load.clear = () => {
    generation++;
    for (const entry of entries.values()) entry.abort.abort();
    entries.clear(); size = 0;
    for (const entry of waiting.splice(0)) entry.reject(cancelled());
  };
  return load;
}
