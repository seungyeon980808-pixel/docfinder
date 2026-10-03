// Bound work in flight and prioritize the requested match before nearby pages.
export function createRenderScheduler(concurrency = 2) {
  const tasks = new Map();
  let running = 0;
  let closed = false;
  function drain() {
    if (closed) return;
    const waiting = [...tasks.values()].filter((task) => !task.running).sort((a, b) => a.priority - b.priority);
    while (running < concurrency && waiting.length) {
      const task = waiting.shift();
      task.running = true;
      running += 1;
      const finish = (error, result) => {
        running -= 1;
        tasks.delete(task.key);
        if (error) task.reject(error);
        else task.resolve(result);
        drain();
      };
      Promise.resolve().then(task.run).then((result) => finish(null, result), (error) => finish(error));
    }
  }
  return {
    schedule(key, run, priority = 10) {
      if (closed) return Promise.resolve(false);
      const existing = tasks.get(key);
      if (existing) { existing.priority = Math.min(existing.priority, priority); return existing.promise; }
      const task = { key, run, priority, running: false };
      task.promise = new Promise((resolve, reject) => Object.assign(task, { resolve, reject }));
      tasks.set(key, task);
      queueMicrotask(drain);
      return task.promise;
    },
    clear() {
      closed = true;
      for (const [key, task] of tasks) if (!task.running) { task.resolve(false); tasks.delete(key); }
    }
  };
}
