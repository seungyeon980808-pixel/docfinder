import { escapeHtml } from './search-matches.js';

export function createSharedLibrary({ onChange, notify }) {
  let session; let libraries = []; let library; let catalog; let pending; let accessError = '';
  let generation = 0; let abort = new AbortController(); let polling = false; let busy = false; let progress = '';
  const uploads = new Map();
  const shareId = /^\/s\/([a-f0-9]{64})$/u.exec(location.pathname)?.[1];
  function snapshot() { return { sharedUser: session?.user, sharedConfigured: session?.configured, sharedLibraries: libraries, sharedLibrary: library,
    sharedPending: pending, sharedAccessError: accessError, documents: catalog?.documents || [], indexStats: catalog?.stats,
    sourceName: library?.name || '공유 문서함', libraryId: library?.id || '', lastSync: catalog?.lastSync,
    driveConnected: Boolean(catalog?.driveConnected), personalBusy: busy, personalProgress: progress,
    connection: accessError || catalog?.stats?.failures ? 'error' : busy ? 'indexing' : catalog?.driveConnected ? 'connected' : 'idle' }; }
  const emit = () => onChange(snapshot());
  function clear() {
    generation++; abort.abort(); abort = new AbortController(); library = undefined; catalog = undefined; pending = undefined; accessError = ''; busy = false; progress = '';
    document.querySelector('#sharing-dialog').close(); document.querySelector('#sharing-members').replaceChildren(); document.querySelector('#sharing-link').value = ''; document.querySelector('#invite-email').value = ''; emit();
  }
  async function request(url, { method = 'GET', body, signal = abort.signal } = {}) {
    const response = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store', signal,
      headers: { ...(method !== 'GET' ? { 'X-CSRF-Token': session?.csrf } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(value.error || '요청을 완료하지 못했습니다.'); error.status = response.status; throw error; }
    return value;
  }
  async function choose(item, updateUrl = false) {
    clear(); const job = generation; library = item; pending = item?.status === 'pending' ? item : undefined; emit();
    if (!item || pending) return;
    try { const next = await request(`/api/libraries/${item.id}`); if (job !== generation) return; catalog = next; library = { ...item, ...next.library }; emit();
      if (updateUrl) history.replaceState(null, '', `/s/${item.share_id}`);
    } catch (error) { if (job !== generation || error.name === 'AbortError') return; catalog = undefined; accessError = error.message; emit(); }
  }
  async function loadLibraries() {
    const data = await request('/api/libraries'); libraries = data.libraries;
    if (shareId) {
      try { await choose(await request(`/api/shares/${shareId}`)); }
      catch (error) { clear(); accessError = error.message; emit(); }
    } else await choose(libraries[0]);
  }
  async function refresh() {
    if (!session?.user || !library || pending || polling || busy) return;
    polling = true; const id = library.id; const job = generation;
    try {
      const latestSession = await request('/api/session');
      if (job !== generation) return;
      if (latestSession.user?.id !== session.user?.id) {
        session = latestSession; libraries = []; clear();
        if (session.user) await loadLibraries();
        return;
      }
      session = latestSession;
      const next = await request(`/api/libraries/${id}`);
      if (job !== generation) return;
      const changed = next.revision !== catalog?.revision || next.driveConnected !== catalog?.driveConnected;
      catalog = next; if (changed) emit();
    } catch (error) {
      if (job !== generation || error.name === 'AbortError') return;
      clear(); accessError = error.status === 401 ? '로그인이 만료되었습니다. 다시 로그인하세요.' : error.message;
      if (error.status === 401) session.user = null;
      document.querySelector('#sharing-dialog')?.close(); document.querySelector('#sharing-members').replaceChildren(); emit();
    } finally { polling = false; }
  }
  async function start() {
    new ResizeObserver(([entry]) => document.documentElement.style.setProperty('--shared-header-height', `${entry.target.getBoundingClientRect().height}px`)).observe(document.querySelector('.topbar'));
    session = await request('/api/session'); emit();
    if (session.user) await loadLibraries();
    const connectionResult = new URLSearchParams(location.search); const result = connectionResult.get('drive');
    if (result) {
      const reasons = { access_denied: 'Google에서 Drive 연결을 허용하지 않았습니다. 접근 권한과 앱의 테스트 사용자 설정을 확인하세요.',
        scope_missing: 'Drive 파일 접근 권한을 선택한 뒤 연결하세요.', refresh_missing: '지속적인 Drive 연결을 허용한 뒤 다시 연결하세요.',
        account_mismatch: '로그인한 계정과 같은 Google 계정의 Drive를 연결하세요.', temporary: 'Google Drive에 일시적으로 연결하지 못했습니다. 잠시 뒤 다시 시도하세요.' };
      notify(result === 'connected' ? 'Drive를 연결했습니다. 색인을 자동으로 생성합니다.' : result === 'sync-pending'
        ? 'Drive 연결은 완료됐습니다. 목록 갱신은 자동으로 다시 시도합니다.' : reasons[connectionResult.get('drive_reason')] || 'Drive 연결을 완료하지 못했습니다. 연결을 다시 시도하세요.');
      history.replaceState(null, '', location.pathname);
    }
    setInterval(() => { if (!document.hidden) refresh(); }, 3000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    document.querySelector('#library-picker').addEventListener('change', (event) => choose(libraries.find((item) => item.id === event.target.value), true));
    document.querySelector('#accept-invite-button').addEventListener('click', async () => {
      try { const item = pending; await request(`/api/libraries/${item.id}/accept`, { method: 'POST', body: {} }); libraries = (await request('/api/libraries')).libraries; await choose(libraries.find((next) => next.id === item.id)); }
      catch (error) { notify(error.message); }
    });
    document.querySelector('#google-login-button').addEventListener('click', login);
    document.querySelector('#shared-logout-button').addEventListener('click', logout);
    document.querySelector('#share-button').addEventListener('click', sharing);
    document.querySelector('#sharing-form').addEventListener('submit', async (event) => {
      event.preventDefault(); const input = document.querySelector('#invite-email'); const button = event.submitter; button.disabled = true;
      try { await request(`/api/libraries/${library.id}/invitations`, { method: 'POST', body: { email: input.value } }); input.value = ''; await members(); notify('초대를 등록했습니다. 문서함 링크를 전달하세요.'); }
      catch (error) { notify(error.message); }
      finally { button.disabled = false; }
    });
    document.querySelector('#sharing-members').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-revoke-email]'); if (!button) return; button.disabled = true;
      try { await request(`/api/libraries/${library.id}/invitations/${encodeURIComponent(button.dataset.revokeEmail)}`, { method: 'DELETE' }); await members(); notify('열람 권한을 회수했습니다.'); }
      catch (error) { notify(error.message); button.disabled = false; }
    });
    document.querySelector('#copy-library-link').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(new URL(`/s/${library.share_id}`, location.origin).href); notify('문서함 링크를 복사했습니다. 초대한 계정만 열 수 있습니다.'); }
      catch { const input = document.querySelector('#sharing-link'); input.focus(); input.select(); notify('선택한 링크를 복사하세요.'); }
    });
    document.querySelectorAll('[data-close-shared-dialog]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
  }
  async function login() {
    const dialog = document.querySelector('#login-dialog'); const message = document.querySelector('#login-message'); const slot = document.querySelector('#google-signin-slot'); slot.replaceChildren(); dialog.showModal();
    if (!session?.configured) { message.textContent = 'Google 로그인을 준비하고 있습니다. 운영자가 Google 연결 설정을 마치면 사용할 수 있습니다.'; return; }
    message.textContent = '초대받은 Google 계정으로 로그인하세요. Gmail과 Google Workspace 계정을 지원합니다.';
    try {
      const started = Date.now();
      while (!globalThis.google?.accounts?.id) { if (Date.now() - started > 8000) throw new Error('Google 로그인 화면을 불러오지 못했습니다. 새로고침하세요.'); await new Promise((resolve) => setTimeout(resolve, 100)); }
      google.accounts.id.initialize({ client_id: session.clientId, callback: async ({ credential }) => {
        try { const next = await request('/api/auth/google', { method: 'POST', body: { credential } }); session = { ...session, ...next }; clear(); dialog.close(); await loadLibraries(); }
        catch (error) { message.textContent = error.message; }
      } });
      google.accounts.id.renderButton(slot, { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', width: 280 });
    } catch (error) { message.textContent = error.message; }
  }
  async function logout() {
    try { const next = await request('/api/logout', { method: 'POST', body: {} }); session = { ...session, ...next }; libraries = []; clear(); globalThis.google?.accounts?.id?.disableAutoSelect(); document.querySelector('#sharing-dialog').close(); document.querySelector('#sharing-members').replaceChildren(); }
    catch (error) { notify(error.message); }
  }
  async function members() {
    const value = await request(`/api/libraries/${library.id}/invitations`);
    const labels = { pending: '참여 대기', accepted: '열람 중', revoked: '권한 회수됨' };
    document.querySelector('#sharing-members').innerHTML = value.invitations.length ? value.invitations.map((item) => `<li><div><strong>${escapeHtml(item.email)}</strong><small>${labels[item.status]}</small></div>${item.status !== 'revoked' ? `<button type="button" class="secondary-button" data-revoke-email="${escapeHtml(item.email)}">${item.status === 'pending' ? '초대 취소' : '권한 회수'}</button>` : ''}</li>`).join('') : '<li class="sharing-empty">아직 초대한 사람이 없습니다.</li>';
  }
  async function sharing() {
    if (library?.role !== 'owner') return;
    try { await members(); document.querySelector('#sharing-title').textContent = library.name; document.querySelector('#sharing-link').value = new URL(`/s/${library.share_id}`, location.origin).href; document.querySelector('#sharing-dialog').showModal(); }
    catch (error) { notify(error.message); }
  }
  return { start, refresh, login, async connect() {
    try { const value = await request(`/api/libraries/${library.id}/drive`, { method: 'POST', body: {} }); location.assign(value.url); } catch (error) { notify(error.message); }
  }, async disconnect() {
    await request(`/api/libraries/${library.id}/drive`, { method: 'DELETE' }); await refresh();
  }, async sync() { if (library?.role === 'owner') await request(`/api/libraries/${library.id}/sync`, { method: 'POST', body: {} }); await refresh(); },
  async search(query, mode) { if (!library || pending) return []; return (await request(`/api/libraries/${library.id}/search?${new URLSearchParams({ q: query, mode })}`)).documents; },
  async getBytes(item) {
    if (item.libraryId !== library?.id) throw new Error('문서함을 다시 선택하세요.');
    const response = await fetch(item.sourceUrl, { credentials: 'same-origin', cache: 'no-store', signal: abort.signal });
    if (!response.ok) { if ([401, 403].includes(response.status)) await refresh(); throw new Error('문서를 열 수 없습니다. 권한과 Drive 연결을 확인하세요.'); }
    return response.arrayBuffer();
  }, async retry(item) { await request(`/api/libraries/${library.id}/documents/${item.id}/retry`, { method: 'POST', body: {} }); await refresh(); },
  async trash(item) { await request(`/api/libraries/${library.id}/documents/${item.id}`, { method: 'DELETE' }); await refresh(); },
  async upload(files) {
    if (busy || library?.role !== 'owner') return;
    const id = library.id; const job = generation; busy = true; emit();
    try {
      for (const [index, file] of [...files].entries()) {
        const maxFileBytes = session.maxFileBytes || 128 * 1024 * 1024;
        if (!/\.(pdf|hwp|hwpx)$/iu.test(file.name) || file.size < 1 || file.size > maxFileBytes) throw new Error(`${maxFileBytes / 1024 / 1024}MB 이하의 PDF·HWP·HWPX 파일을 선택하세요.`);
        const signature = `${session.user.id}:${id}:${file.name}:${file.size}:${file.lastModified}`;
        let uploadId = uploads.get(signature);
        if (!uploadId) { uploadId = crypto.randomUUID(); uploads.set(signature, uploadId); }
        progress = `업로드 ${index + 1}/${files.length} · ${file.name}`; emit();
        const next = await request(`/api/libraries/${id}/uploads`, { method: 'POST', body: { name: file.name, size: file.size, uploadId } });
        if (job !== generation) throw new DOMException('업로드를 중단했습니다.', 'AbortError');
        if (!next.completed) await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest(); xhr.open('PUT', `/api/libraries/${id}/uploads/${uploadId}`); xhr.setRequestHeader('X-CSRF-Token', session.csrf);
          const signal = abort.signal;
          const cancel = () => xhr.abort(); signal.addEventListener('abort', cancel, { once: true });
          const finish = (error) => { signal.removeEventListener('abort', cancel); error ? reject(error) : resolve(); };
          xhr.upload.onprogress = (event) => { if (job === generation && event.lengthComputable) { progress = `${file.name} · 업로드 ${Math.round(event.loaded / event.total * 100)}%`; emit(); } };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) return finish();
            let value; try { value = JSON.parse(xhr.responseText); } catch { /* A proxy can return HTML on failure. */ }
            finish(new Error(value?.error || '업로드에 실패했습니다. 같은 파일을 다시 선택하세요.'));
          };
          xhr.onerror = () => finish(new Error('연결이 끊겼습니다. 같은 파일을 다시 선택해 업로드를 재시도하세요.'));
          xhr.onabort = () => finish(new DOMException('업로드를 중단했습니다.', 'AbortError')); xhr.send(file);
        });
      }
      notify('업로드했습니다. 서버에서 자동으로 색인합니다.');
    } finally { if (job === generation) { busy = false; progress = ''; emit(); await refresh(); } }
  } };
}
