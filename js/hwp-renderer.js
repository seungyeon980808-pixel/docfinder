let worker;
let sequence = 0;
const pending = new Map();

export function destroyHwpRenderer() {
  if (worker) { worker.onmessage = null; worker.onerror = null; worker.terminate(); worker = undefined; }
  for (const task of pending.values()) task.reject(new DOMException("문서함을 닫았습니다.", "AbortError"));
  pending.clear();
}

function request(data, transfer = []) {
  if (!worker) {
    worker = new Worker(new URL("./hwp-render-worker.js?v=phrase-map-2", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      const task = pending.get(data.id);
      if (!task) return;
      pending.delete(data.id);
      if (data.error) task.reject(new Error(data.error));
      else task.resolve(data.result);
    };
    worker.onerror = () => {
      for (const task of pending.values()) task.reject(new Error("한글 렌더러를 불러오지 못했습니다."));
      pending.clear();
      worker.terminate();
      worker = undefined;
    };
  }
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try { worker.postMessage({ ...data, id }, transfer); }
    catch (error) { pending.delete(id); reject(error); }
  });
}

export async function createHwpRenderer(bytes, key) {
  const { pageCount } = await request({ type: "open", key, bytes }, [bytes]);
  return { pageCount, page: (page) => request({ type: "page", key, page }) };
}
