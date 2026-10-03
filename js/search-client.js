import { searchLocalIndex } from "./local-index.js?v=phrase-map-2";

export function createSearchClient() {
  let worker;
  let sequence = 0;
  let currentEntries;
  let preparation;
  const pending = new Map();
  const reset = () => {
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
  return {
    reset,
    async search(documents, entries, query) {
      if (typeof Worker === "undefined") return searchLocalIndex(documents, entries, query);
      if (currentEntries !== entries) {
        reset();
        currentEntries = entries;
        worker = new Worker(new URL("./search-worker.js?v=phrase-map-2", import.meta.url), { type: "module" });
        worker.onmessage = ({ data }) => {
          const request = pending.get(data.id);
          if (!request) return;
          pending.delete(data.id);
          if (data.error) request.reject(new Error(data.error));
          else request.resolve(data.result);
        };
        worker.onerror = reset;
        preparation = send({ type: "prepare", entries });
      }
      await preparation;
      return send({ type: "search", documents, query });
    }
  };
}
