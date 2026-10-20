import { searchLocalIndex } from "./local-index.js?v=phrase-map-2";

export function createSearchClient() {
  let worker;
  let sequence = 0;
  let currentEntries;
  let preparation;
  let generation = 0;
  let searchGeneration = 0;
  const pending = new Map();
  const reset = () => {
    generation++; searchGeneration++;
    worker?.terminate();
    worker = undefined;
    currentEntries = undefined;
    preparation = undefined;
    for (const request of pending.values()) request.reject(new Error("검색 색인이 변경됐습니다."));
    pending.clear();
  };
  const send = (message) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...message, id });
  });
  const prepare = entries => {
    if (typeof Worker === 'undefined') return Promise.resolve();
    if (currentEntries !== entries) {
      reset(); currentEntries = entries;
      worker = new Worker(new URL('./search-worker.js?v=phrase-map-2', import.meta.url), { type: 'module' });
      const instance = worker;
      worker.onmessage = ({ data }) => {
        if (worker !== instance) return;
        const request = pending.get(data.id); if (!request) return;
        pending.delete(data.id);
        if (data.error) request.reject(new Error(data.error)); else request.resolve(data.result);
      };
      worker.onerror = () => { if (worker === instance) reset(); };
      preparation = send({ type: 'prepare', entries });
    }
    return preparation;
  };
  return {
    reset, prepare,
    async search(documents, entries, query, matchScope = "document") {
      if (typeof Worker === "undefined") return searchLocalIndex(documents, entries, query, matchScope);
      const ready = prepare(entries); const indexJob = generation; const searchJob = ++searchGeneration;
      await ready;
      if (indexJob !== generation || searchJob !== searchGeneration) throw new DOMException('지난 검색을 중단했습니다.', 'AbortError');
      const result = await send({ type: 'search', documents, query, matchScope });
      if (indexJob !== generation || searchJob !== searchGeneration) throw new DOMException('지난 검색을 중단했습니다.', 'AbortError');
      return result;
    }
  };
}
