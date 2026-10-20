// Yield to the catalog paint before preparing the server-side search corpus.
export function createIndexPreparation({ request, isCurrent, onChange }) {
  let active;
  let status;
  function reset() { active?.abort.abort(); active = undefined; status = undefined; }
  async function prepare(revision, ready = false, retry = false) {
    if (!revision || !isCurrent(revision)) return;
    if (!retry && active?.revision === revision) return active.promise;
    reset();
    const job = { revision, abort: new AbortController() }; active = job;
    status = ready ? 'ready' : 'loading'; onChange();
    if (ready) return;
    job.promise = (async () => {
      try {
        if (typeof requestAnimationFrame === 'function') await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (active !== job || !isCurrent(revision)) return;
        const result = await request(job.abort.signal);
        if (active !== job || !isCurrent(revision)) return;
        if (!result.ready || result.revision !== revision) throw new Error('검색 자료가 갱신되었습니다.');
        status = 'ready'; onChange();
      } catch (error) {
        if (active !== job || !isCurrent(revision) || error.name === 'AbortError') return;
        status = 'error'; onChange();
      }
    })();
    return job.promise;
  }
  return { prepare, reset, get status() { return status; } };
}
