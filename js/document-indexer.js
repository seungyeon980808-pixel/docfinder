export function createDocumentIndexer() {
  let worker;
  let sequence = 0;
  const tasks = new Map();
  function stop(error) {
    worker?.terminate(); worker = undefined;
    for (const task of tasks.values()) task.reject(error);
    tasks.clear();
  }
  const cancel = () => stop(new DOMException("색인을 중단했습니다.", "AbortError"));
  return {
    cancel,
    extract(format, bytes, onProgress = () => {}) {
      if (!worker) {
        worker = new Worker(new URL("./document-index-worker.js?v=drive-upload-1", import.meta.url), { type: "module" });
        worker.onmessage = ({ data }) => {
          const task = tasks.get(data.id);
          if (!task) return;
          if (data.progress) return task.onProgress(data.progress);
          tasks.delete(data.id);
          if (data.error) task.reject(new Error(data.error)); else task.resolve(data.result);
        };
        worker.onerror = (event) => stop(new Error(event.message || "색인 작업을 실행하지 못했습니다. 새로고침한 뒤 다시 시도하세요."));
      }
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        tasks.set(id, { resolve, reject, onProgress });
        try { worker.postMessage({ id, format, bytes }, [bytes]); }
        catch (error) { tasks.delete(id); reject(error); }
      });
    }
  };
}
