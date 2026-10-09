export function createGuestLibrary({ id, onChange }) {
  let catalog; let accessError = ''; let polling = false;
  const secret = new URLSearchParams(location.hash.slice(1)).get('k');
  const base = `/api/public-links/${id}`;
  function emit() {
    onChange({ sharedGuest: true, sharedUser: null, sharedLibraries: [], sharedLibrary: catalog?.library,
      sharedAccessError: accessError, sharedPending: null, documents: catalog?.documents || [], indexStats: catalog?.stats,
      sourceName: catalog?.library.name || '공유 자료', libraryId: id, driveConnected: false, sharedFolderSource: null,
      personalBusy: false, personalProgress: '', connection: accessError ? 'error' : catalog ? 'connected' : 'idle' });
  }
  async function request(path = '', options = {}) {
    const response = await fetch(base + path, { credentials: 'same-origin', cache: 'no-store', ...options });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(value.error || '공유 자료를 열 수 없습니다. 잠시 뒤 다시 시도하세요.'); error.status = response.status; throw error; }
    return value;
  }
  async function authorize() {
    if (!/^[a-f0-9]{64}$/u.test(secret || '')) return;
    await request('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: secret }) });
  }
  async function refresh() {
    if (polling) return; polling = true;
    try {
      let next;
      try { next = await request(); }
      catch (error) { if (error.status !== 401 || !secret) throw error; await authorize(); next = await request(); }
      const changed = next.revision !== catalog?.revision || accessError || !catalog;
      catalog = next; accessError = ''; if (changed) emit();
    } catch (error) { catalog = undefined; accessError = error.message; emit(); }
    finally { polling = false; }
  }
  return {
    async start() {
      document.documentElement.dataset.guest = 'true';
      new ResizeObserver(([entry]) => document.documentElement.style.setProperty('--shared-header-height', `${entry.target.getBoundingClientRect().height}px`)).observe(document.querySelector('.topbar'));
      emit(); await refresh();
      setInterval(() => { if (!document.hidden) refresh(); }, 15000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    }, refresh, sync: refresh,
    async search(query, mode) {
      if (!catalog) return [];
      return (await request(`/search?${new URLSearchParams({ q: query, mode })}`)).documents;
    },
    async getBytes(item) {
      if (item.libraryId !== id || !catalog) throw new Error('공유 링크를 다시 열어 주세요.');
      const response = await fetch(item.sourceUrl, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) {
        const value = await response.json().catch(() => ({}));
        if ([401, 403, 404, 410].includes(response.status)) await refresh();
        throw new Error(value.error || '원문을 불러오지 못했습니다. 잠시 뒤 다시 시도하세요.');
      }
      return response.arrayBuffer();
    }
  };
}
