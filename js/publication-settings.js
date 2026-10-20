import { escapeHtml } from './search-matches.js';

export function createPublicationSettings({ request, context, notify, onSaved }) {
  const form = document.querySelector('#publication-form');
  const list = document.querySelector('#publication-documents');
  const status = document.querySelector('#publication-status');
  let opened; let documents = [];
  const current = job => Boolean(job && opened === job && job.id === context().library?.id && job.generation === context().generation);
  const reset = () => { opened = undefined; documents = []; list.replaceChildren(); status.textContent = ''; };
  async function open() {
    reset(); const job = { id: context().library.id, generation: context().generation }; opened = job;
    const value = await request(`/api/libraries/${job.id}/publications`);
    if (!current(job)) return;
    documents = value.documents;
    list.innerHTML = documents.map(doc => `<label class="public-file-choice"><input type="checkbox" value="${escapeHtml(doc.id)}" ${doc.published ? 'checked' : ''} /><span>${escapeHtml(doc.name)}</span></label>`).join('') || '<p>등록된 문서가 없습니다.</p>';
    status.textContent = `${documents.filter(doc => doc.published).length}개 공개 · 나머지는 등록된 이메일만 열람`;
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); const job = opened; if (!current(job)) return;
    const button = event.submitter; button.disabled = true;
    const ids = new Set([...list.querySelectorAll('input:checked')].map(input => input.value));
    try {
      await request(`/api/libraries/${job.id}/publications`, { method: 'POST', body: { documents: documents.filter(doc => ids.has(doc.id)).map(({id,version})=>({id,version})) } });
      if (!current(job)) return;
      await onSaved(); await open(); notify('문서 공개 범위를 저장했습니다.');
    } catch (error) { if (current(job)) status.textContent = error.message; }
    finally { button.disabled = false; }
  });
  return { open, reset };
}
