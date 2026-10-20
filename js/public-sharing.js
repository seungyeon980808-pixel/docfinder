import { escapeHtml } from './search-matches.js';

export const publicLinkUrl = (link, origin = location.origin) => new URL(`/p/${link.id}#k=${link.token}`, origin).href;
const dateLabel = (value) => value ? new Date(value).toLocaleDateString('ko-KR') : '만료 없음';

export function createPublicSharing({ request, context, notify }) {
  const form = document.querySelector('#public-link-form');
  const files = document.querySelector('#public-share-files');
  const scope = document.querySelector('#public-share-scope');
  const includeNew = document.querySelector('#public-share-new');
  const status = document.querySelector('#public-share-status');
  const list = document.querySelector('#public-links-list');
  let links = []; let opened; let openedDocuments = [];
  const selectedIds = () => [...files.querySelectorAll('input:checked')].map((input) => input.value);
  const isCurrent = (job) => Boolean(job && job.libraryId === context().library?.id && job.generation === context().generation);
  function reset() {
    links = []; opened = undefined; openedDocuments = []; form.reset(); files.replaceChildren(); list.replaceChildren(); status.textContent = '';
    document.querySelector('#public-share-folder-files').replaceChildren(); document.querySelector('#public-share-folder-name').textContent = '';
    document.querySelector('#public-link-result').hidden = true; document.querySelector('#public-link-value').value = '';
  }
  function updateScope() {
    const folder = scope.value === 'folder';
    document.querySelector('#public-share-file-picker').hidden = folder;
    document.querySelector('#public-share-folder-preview').hidden = !folder;
    document.querySelector('#public-share-new-row').hidden = !folder;
    if (!folder) includeNew.checked = false;
    const count = folder ? openedDocuments.filter((doc) => doc.sourceFolderId === opened?.folderId).length : selectedIds().length;
    document.querySelector('#public-share-summary').textContent = `${count}개 공개 파일 공유${folder && includeNew.checked ? ' · 추가된 공개 승인 파일도 포함' : ' · 새 파일은 자동으로 공개하지 않음'}`;
    document.querySelector('#public-link-create').disabled = count === 0 && !(folder && includeNew.checked);
  }
  async function load(job) {
    const value = await request(`/api/libraries/${job.libraryId}/public-links`); if (!isCurrent(job)) return;
    links = value.links;
    list.innerHTML = links.length ? links.map((link) => {
      const active = !link.revokedAt && (!link.expiresAt || Date.parse(link.expiresAt) > Date.now());
      const label = link.revokedAt ? '공유 해제됨' : active ? dateLabel(link.expiresAt) : '만료됨';
      return `<li><div><strong>${escapeHtml(link.name)}</strong><small>${link.documentCount}개 파일 · ${link.scope === 'folder' ? link.includeNew ? '폴더 · 공개 승인 파일 자동 포함' : '폴더 · 현재 파일만' : '선택 파일'} · ${label}</small></div>${active ? `<div class="public-link-actions"><button type="button" class="secondary-button" data-public-copy="${link.id}" aria-label="${escapeHtml(link.name)} 링크 복사">복사</button><button type="button" class="secondary-button" data-public-reissue="${link.id}" aria-label="${escapeHtml(link.name)} 링크 재발급">재발급</button><button type="button" class="secondary-button" data-public-revoke="${link.id}" aria-label="${escapeHtml(link.name)} 공유 해제">해제</button></div>` : ''}</li>`;
    }).join('') : '<li class="sharing-empty">만든 링크가 없습니다. 공유할 파일을 선택해 링크를 만드세요.</li>';
  }
  function showLink(link) {
    document.querySelector('#public-link-value').value = publicLinkUrl(link); document.querySelector('#public-link-result').hidden = false;
  }
  async function copy(link) {
    showLink(link);
    try { await navigator.clipboard.writeText(publicLinkUrl(link)); notify('로그인 없이 열 수 있는 링크를 복사했습니다.'); }
    catch { const input = document.querySelector('#public-link-value'); input.focus(); input.select(); notify('선택한 링크를 복사하세요.'); }
  }
  scope.addEventListener('change', updateScope); includeNew.addEventListener('change', updateScope); files.addEventListener('change', updateScope);
  document.querySelector('#public-share-select-all').addEventListener('click', () => { files.querySelectorAll('input').forEach((input) => { input.checked = true; }); updateScope(); });
  document.querySelector('#public-share-select-none').addEventListener('click', () => { files.querySelectorAll('input').forEach((input) => { input.checked = false; }); updateScope(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (!opened || !isCurrent(opened)) return;
    const job = { ...opened }; const settings = [...form.elements]; settings.forEach((element) => { element.disabled = true; }); status.textContent = '공유 링크를 만드는 중입니다.';
    try {
      const automatic = scope.value === 'folder' && includeNew.checked;
      const documentIds = automatic ? [] : scope.value === 'folder' ? openedDocuments.filter((doc) => doc.sourceFolderId === job.folderId).map((doc) => doc.id) : selectedIds();
      const value = await request(`/api/libraries/${job.libraryId}/public-links`, { method: 'POST', body: { name: document.querySelector('#public-share-name').value.trim(), scope: scope.value, folderId: job.folderId, includeNew: automatic, documentIds, expiresInDays: Number(document.querySelector('#public-share-expiry').value) } });
      if (!isCurrent(job)) return;
      showLink(value.link); await load(job); status.textContent = '링크를 만들었습니다. 복사해서 전달하세요.'; notify('로그인 없는 공유 링크를 만들었습니다.');
    } catch (error) { if (isCurrent(job)) status.textContent = error.message; }
    finally { settings.forEach((element) => { element.disabled = false; }); updateScope(); }
  });
  document.querySelector('#copy-public-link').addEventListener('click', async () => {
    const input = document.querySelector('#public-link-value');
    try { await navigator.clipboard.writeText(input.value); notify('로그인 없는 공유 링크를 복사했습니다.'); }
    catch { input.focus(); input.select(); }
  });
  list.addEventListener('click', async (event) => {
    const button = event.target.closest('button'); if (!button || !opened || !isCurrent(opened)) return;
    const job = { ...opened }; const id = button.dataset.publicCopy || button.dataset.publicReissue || button.dataset.publicRevoke;
    const link = links.find((item) => item.id === id); if (!link) return;
    if (button.dataset.publicCopy) return copy(link);
    const question = button.dataset.publicReissue ? '링크를 재발급하면 기존 링크와 열람자의 접근이 차단됩니다. 재발급할까요?' : '이 링크의 이후 열람을 차단할까요? 이미 저장한 파일은 회수되지 않습니다.';
    if (!confirm(question)) return;
    button.disabled = true;
    try {
      if (button.dataset.publicReissue) { const next = await request(`/api/libraries/${job.libraryId}/public-links/${id}/reissue`, { method: 'POST', body: {} }); if (!isCurrent(job)) return; showLink(next); notify('재발급했습니다. 새 링크를 전달하세요.'); }
      else { await request(`/api/libraries/${job.libraryId}/public-links/${id}`, { method: 'DELETE' }); if (!isCurrent(job)) return; document.querySelector('#public-link-result').hidden = true; document.querySelector('#public-link-value').value = ''; notify('공유 링크를 해제했습니다.'); }
      await load(job);
    } catch (error) { if (isCurrent(job)) status.textContent = error.message; button.disabled = false; }
  });
  return { reset, async open() {
    reset(); const current = context(); const job = { libraryId: current.library.id, generation: current.generation, folderId: current.catalog?.folderSource?.folder_id }; opened = job;
    const approved = await request(`/api/libraries/${job.libraryId}/publications`);
    if (!isCurrent(job) || opened !== job) return;
    const published = new Set(approved.documents.filter(doc=>doc.published).map(doc=>doc.id));
    const documents = (current.catalog?.documents || []).filter(doc=>published.has(doc.id)); const selectedId = document.querySelector('.document-select[aria-current="true"]')?.dataset.documentId;
    openedDocuments = documents.slice();
    files.innerHTML = documents.map((doc) => `<label class="public-file-choice"><input type="checkbox" value="${escapeHtml(doc.id)}" ${doc.id === selectedId ? 'checked' : ''} /><span>${escapeHtml(doc.name)}</span></label>`).join('') || '<p>아직 등록된 파일이 없습니다.</p>';
    document.querySelector('#public-share-folder-option').disabled = current.catalog?.folderSource?.status !== 'ready';
    const folderDocuments = documents.filter((doc) => doc.sourceFolderId === opened.folderId);
    document.querySelector('#public-share-folder-name').textContent = current.catalog?.folderSource?.name || '연결한 폴더';
    document.querySelector('#public-share-folder-files').innerHTML = folderDocuments.map((doc) => `<li>${escapeHtml(doc.name)}</li>`).join('') || '<li>아직 파일이 없습니다.</li>';
    document.querySelector('#public-share-name').value = current.library.name;
    updateScope(); await load(opened);
  } };
}
