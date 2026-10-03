import { clearPdfPreview, localPdfMarkup, renderLocalPdf, updatePdfPreview } from "./pdf-preview.js?v=phrase-map-2";
import { clearHwpPreview, renderHwpPreview, updateHwpPreview } from "./hwp-preview.js?v=phrase-map-2";

import { escapeHtml, highlightMarkup as highlight } from "./search-matches.js?v=phrase-map-2";
import { clearPreviewNavigation } from "./preview-navigation.js?v=phrase-map-2";
import { previewSourceKey } from "./preview-cache.js?v=phrase-map-2";

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function formatDateTime(value) {
  if (!value) return "아직 동기화하지 않음";
  return new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatSize(value) {
  if (!value) return "크기 정보 없음";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / (1024 ** exponent)).toFixed(exponent ? 1 : 0)} ${units[exponent]}`;
}

function folderEntries(documents) {
  const counts = new Map([["전체", documents.length]]);
  for (const document of documents) counts.set(document.folder, (counts.get(document.folder) || 0) + 1);
  return [...counts.entries()].sort(([left], [right]) => left === "전체" ? -1 : right === "전체" ? 1 : left.localeCompare(right, "ko"));
}

function formatOf(documentItem) {
  if (documentItem.format) return documentItem.format;
  const extension = documentItem.name.split(".").pop()?.toLocaleLowerCase("ko-KR");
  return extension === "hwp" || extension === "hwpx" ? extension : "pdf";
}

function resultPath(documentItem) {
  const segments = String(documentItem.path || "").split(" / ");
  if (segments.at(-1) === documentItem.name) segments.pop();
  return segments.join(" / ") || documentItem.folder || "루트 문서";
}

function folderPath(documentItem) {
  const segments = String(documentItem.path || "").split(" / ");
  if (segments.at(-1) === documentItem.name) segments.pop();
  return segments.join(" / ");
}

function renderFolders(state) {
  document.querySelector(".folder-panel").hidden = folderEntries(state.documents).length <= 2;
  document.querySelector("#folder-navigation").innerHTML = folderEntries(state.documents).map(([folder, count]) => `
    <button class="folder-button${state.folder === folder ? " is-active" : ""}" type="button" data-folder="${escapeHtml(folder)}" aria-current="${state.folder === folder ? "page" : "false"}">
      <span>${folder === "전체" ? "전체 문서" : escapeHtml(folder)}</span><small>${count}</small>
    </button>`).join("");
}

function renderDocuments(state) {
  const list = document.querySelector("#document-list");
  if (state.sharedMode && state.sharedPending) { list.replaceChildren(); return; }
  if (!state.results.length) {
    if (state.sharedMode && !state.documents.length && !state.sharedPending) {
      const title = state.sharedAccessError ? "문서함을 열 수 없습니다" : !state.sharedUser ? "Google 계정으로 시작하세요" : state.sharedLibrary?.role === "owner" ? "내 자료로 시작하세요" : "등록된 문서가 없습니다";
      const copy = state.sharedAccessError || (!state.sharedUser ? "내 자료를 올리거나 초대받은 문서함을 열람할 수 있습니다." : state.sharedLibrary?.role === "owner" ? "Drive를 연결하고 PDF·HWP·HWPX를 업로드하세요. 본문 색인은 자동으로 생성됩니다." : "호스트가 파일을 올리면 여기에 표시됩니다.");
      list.innerHTML = `<div class="personal-empty"><span class="personal-empty-kicker">${state.sharedLibrary?.role === "owner" ? "내 문서함" : "공유 문서함"}</span><h2>${title}</h2><p>${escapeHtml(copy)}</p>${!state.sharedUser ? '<small>초대받았다면 초대에 등록된 계정으로 로그인하세요.</small>' : ''}</div>`;
      return;
    }
    if (state.personalMode && !state.documents.length && !state.query.trim()) {
      list.innerHTML = `<div class="personal-empty"><span class="personal-empty-kicker">나의 문서함</span><h2>내 자료로 시작하세요</h2>
        <p>Drive에 업로드하거나 이 컴퓨터의 PDF·한글 파일을 불러오면 본문을 자동으로 색인합니다.</p>
        <div><button type="button" data-personal-action="connect" ${state.personalBusy ? "disabled" : ""}>Google Drive 연결</button>
        <button type="button" data-personal-action="local" ${state.personalBusy ? "disabled" : ""}>이 컴퓨터에서 불러오기</button></div>
        <small>원본은 내 Drive에, 검색 색인은 이 브라우저에 보관됩니다.<br>이 컴퓨터의 파일을 불러오면 원본도 이 브라우저에 보관됩니다.</small></div>`;
      return;
    }
    const pending = state.mode === "content" && state.query.trim() && !state.contentMatches;
    list.innerHTML = pending
      ? `<div class="empty-state"><strong>${state.searching ? "본문을 검색하는 중입니다" : "본문 검색을 실행하세요"}</strong><span>${state.searching ? "색인에서 일치하는 문서를 찾고 있습니다." : "검색 버튼을 누르면 원문 내용과 일치하는 문서만 표시합니다."}</span></div>`
      : '<div class="empty-state"><strong>일치하는 문서가 없습니다</strong><span>검색 범위나 단어를 바꿔 보세요.</span></div>';
    return;
  }
  const showFolder = new Set(state.documents.map((item) => item.folder)).size > 1;
  const matchLabel = (item) => [
    showFolder ? escapeHtml(item.folder) : "",
    item.matchedPages?.length ? `일치 페이지 ${item.matchedPages.length}개` : item.page ? `${item.page}쪽 일치` : state.mode === "content" && state.query && item.excerpt ? "본문 일치" : "",
    item.termCount > 1 ? `${item.matchedTermCount}/${item.termCount}개 포함 · ${item.samePage ? "같은 쪽" : "다른 쪽"}` : "",
    item.indexStatus === "indexing" ? "색인 중" : item.indexStatus === "error" ? "색인 재시도 필요" : item.indexStatus === "textless" ? "본문 텍스트 없음" : ""
  ].filter(Boolean).join(" · ");
  list.innerHTML = state.results.map((item, index) => `
    <div class="document-row${state.selectedId === item.id ? " is-selected" : ""}" data-result-id="${escapeHtml(item.id)}">
      <button class="document-select" type="button" data-document-id="${escapeHtml(item.id)}" aria-current="${state.selectedId === item.id ? "true" : "false"}">
        <span class="result-rank" aria-label="${index + 1}번째 결과">${String(index + 1).padStart(2, "0")}</span>
        <span class="result-content"><span class="result-topline"><span class="document-name" title="${escapeHtml(item.name)}"><strong><i class="format-label">${escapeHtml(formatOf(item).toUpperCase())}</i>${highlight(item.name, state.mode === "name" ? state.query : "")}${item.isNew ? '<i class="new-label">새 문서</i>' : ""}</strong></span>${matchLabel(item) ? `<small class="result-match">${matchLabel(item)}</small>` : ""}</span>
        <span class="result-subline">${resultPath(item) === item.folder ? "" : `<small class="result-path">${escapeHtml(resultPath(item))}</small>`}<time class="result-date">${formatDate(item.modifiedTime)}</time></span>
        ${state.mode === "content" && state.query && item.excerpt ? `<span class="result-excerpt">${highlight(item.excerpt, state.query)}</span>` : ""}</span>
      </button>
      <details class="result-actions"><summary aria-label="${escapeHtml(item.name)} 파일 작업">···</summary><div class="result-menu-panel">
        <button type="button" data-row-action="download">파일 다운로드</button>
        ${item.libraryId && item.indexStatus === "error" && (!state.sharedMode || state.sharedLibrary?.role === "owner") ? '<button type="button" data-row-action="reindex">색인 다시 시도</button>' : ""}
        <button type="button" data-row-action="original">원문 열기</button>
        <button type="button" data-row-action="link">문서 링크 복사</button>
        ${state.sharedMode && state.sharedLibrary?.role === "owner" ? '<button type="button" data-row-action="trash">Drive 휴지통으로 이동</button>' : ''}
        ${!state.sharedMode || state.sharedLibrary?.role === "owner" ? `<button type="button" data-row-action="edit">${["hwp", "hwpx"].includes(formatOf(item)) ? "RHWP로 편집" : "PDF 편집기에서 열기"}</button>` : ''}
        <small>${folderPath(item) ? `${escapeHtml(folderPath(item))}<br>` : ""}수정일 ${formatDate(item.modifiedTime)} · ${formatSize(item.size)}</small>
      </div></details>
    </div>`).join("");
}

function demoPreview(documentItem, query) {
  return `<article class="paper-preview"><span>${escapeHtml(documentItem.publisher)} · ${documentItem.page ?? "-"}쪽</span><h3>${escapeHtml(documentItem.heading)}</h3><p>${highlight(documentItem.excerpt, query)}</p></article>`;
}

function hwpPreview() {
  return '<section class="hwp-preview" aria-label="한글 원문"><p class="preview-loading" role="status">한글 원문을 여는 중입니다</p></section>';
}

function renderDetail(state, getBytes) {
  const documentItem = state.results.find((candidate) => candidate.id === state.selectedId)
    || state.documents.find((candidate) => candidate.id === state.selectedId);
  const detail = document.querySelector("#document-detail");
  if (!documentItem) {
    clearPdfPreview();
    clearHwpPreview(state.sharedMode);
    clearPreviewNavigation();
    document.querySelector("#preview-page-status").hidden = true;
    detail.dataset.key = "";
    detail.dataset.sourceKey = "";
    detail.innerHTML = '<div class="empty-state"><strong>문서를 선택하세요</strong><span>목록에서 문서를 선택하면 원문과 정보를 확인할 수 있습니다.</span></div>';
    return;
  }
  const format = formatOf(documentItem);
  const sourceKey = previewSourceKey(documentItem);
  if (state.mode === "content" && state.query.trim() && !state.settings.demoMode && !state.contentMatches
    && detail.dataset.sourceKey === sourceKey) return;
  const evidenceQuery = state.contentMatches || (state.settings.demoMode && state.mode === "content") ? state.query : "";
  const detailKey = JSON.stringify([documentItem.id, documentItem.modifiedTime, documentItem.sourceUrl, documentItem.page, documentItem.excerpt, documentItem.matchedPages, documentItem.source, state.localMode, state.settings.demoMode, state.mode, evidenceQuery, state.settings.pdfEditorUrl]);
  if (detail.dataset.key === detailKey) return;
  detail.dataset.sourceKey = sourceKey;
  const isHwp = format === "hwp" || format === "hwpx";
  if (isHwp ? updateHwpPreview(documentItem, evidenceQuery) : updatePdfPreview(documentItem, evidenceQuery)) {
    detail.dataset.key = detailKey;
    return;
  }
  clearPdfPreview();
  clearHwpPreview();
  clearPreviewNavigation();
  detail.scrollTop = 0;
  document.querySelector("#preview-page-status").hidden = true;
  detail.dataset.key = detailKey;
  const preview = isHwp ? hwpPreview() : documentItem.source === "demo" ? demoPreview(documentItem, state.query) : localPdfMarkup();
  detail.innerHTML = preview;
  if (!isHwp && documentItem.source !== "demo") renderLocalPdf(detail.querySelector(".pdf-viewer"), documentItem, getBytes, evidenceQuery);
  if (isHwp) renderHwpPreview(detail.querySelector(".hwp-preview"), documentItem, getBytes, evidenceQuery);
}

function renderConnection(state) {
  const status = document.querySelector("#connection-status");
  status.className = `connection-status${["connected", "local"].includes(state.connection) ? " is-connected" : state.connection === "error" ? " is-error" : ""}`;
  const labels = { demo: "데모 데이터", local: state.autoIndex ? "자동 갱신" : "로컬 색인", indexing: "색인 중", connecting: "연결 중", connected: "Drive 연결됨", error: "확인 필요" };
  status.querySelector("span").textContent = state.personalBusy ? "파일 처리 중" : state.publicMode ? state.connection === "error" ? "목록 오류" : "문서함" : labels[state.connection] || "연결 안 됨";
  status.title = state.indexMessage || `문서 ${state.documents.length}개 · ${formatDateTime(state.lastSync)}`;
  status.querySelector("#connect-button").textContent = state.connection === "connected" ? "다시 연결" : "Drive 연결";
  status.querySelector("#connect-button").hidden = state.localMode || state.publicMode || state.sharedMode && state.sharedLibrary?.role !== "owner";
  const upload = document.querySelector("#upload-button");
  upload.hidden = !state.personalMode && !(state.sharedMode && state.sharedLibrary?.role === "owner");
  upload.disabled = !state.driveConnected || state.personalBusy;
  document.querySelector("#disconnect-button").hidden = !state.driveConnected || state.sharedMode && state.sharedLibrary?.role !== "owner";
  if (state.sharedMode) status.querySelector("span").textContent = state.personalBusy ? "업로드 중" : state.sharedUser ? state.sharedLibrary?.role === "reader" ? "열람자" : "내 문서함" : "로그인 필요";
  const picker = document.querySelector("#library-picker");
  picker.hidden = !state.sharedMode || !state.sharedUser;
  const options = (state.sharedLibraries || []).map((item) => `<option value="${escapeHtml(item.id)}">${item.role === "owner" ? "내 문서함" : "초대받은 문서함"} · ${escapeHtml(item.name)}${item.status === "pending" ? " (참여 대기)" : ""}</option>`).join('');
  if (picker.dataset.options !== options) { picker.innerHTML = options; picker.dataset.options = options; }
  if (state.sharedLibrary) picker.value = state.sharedLibrary.id;
  document.querySelector("#share-button").hidden = !state.sharedMode || state.sharedLibrary?.role !== "owner";
  document.querySelector("#google-login-button").hidden = !state.sharedMode;
  document.querySelector("#google-login-button").textContent = state.sharedUser ? "계정 바꾸기" : "Google 로그인";
  document.querySelector("#shared-logout-button").hidden = !state.sharedMode || !state.sharedUser;
  document.querySelector("#shared-logout-button").title = state.sharedUser?.email || '';
  document.querySelector("#pending-invitation").hidden = !state.sharedPending;
  for (const id of ["import-local-button", "restore-local-button", "local-hwp-button", "settings-button"]) document.querySelector(`#${id}`).hidden = Boolean(state.sharedMode);
  const progress = document.querySelector("#personal-progress");
  progress.hidden = !state.personalBusy;
  progress.textContent = state.personalProgress || "문서를 준비하는 중입니다";
  const health = document.querySelector("#index-health");
  const stats = state.indexStats;
  health.hidden = !stats || !Number.isInteger(stats.searchableDocuments);
  if (!health.hidden) {
    document.querySelector("#index-health-summary").textContent = `색인 ${stats.searchableDocuments}/${state.documents.length}`;
    document.querySelector("#index-health-detail").innerHTML = `<strong>본문 검색 가능 ${stats.searchableDocuments}개 · ${stats.searchablePages.toLocaleString("ko-KR")}쪽</strong>
      <p>추출 실패 ${stats.failures}개 · 텍스트 없는 문서 ${stats.textlessDocuments}개 · 텍스트 없는 쪽 ${stats.emptyPages}개</p>
      <ul>${state.documents.map((item) => {
        const count = stats.documentCounts?.[item.id];
        const label = item.indexStatus === "error" ? "추출 실패 · 암호화와 파일 형식 확인"
          : count?.searchablePages ? `검색 가능 ${count.searchablePages}쪽${count.emptyPages ? ` · 텍스트 없는 ${count.emptyPages}쪽` : ""}` : "텍스트 없음 · 원문 열기 가능";
        return `<li><span>${escapeHtml(item.name)}</span><small>${label}</small></li>`;
      }).join("")}</ul><small>텍스트 없는 쪽은 본문 검색에서 제외됩니다.</small>`;
  }
}

function renderNotice(state) {
  const notice = document.querySelector("#sync-notice");
  notice.hidden = !state.notice.visible;
  notice.classList.toggle("is-error", state.notice.type === "error");
  document.querySelector("#sync-title").textContent = state.notice.title;
  document.querySelector("#sync-copy").textContent = state.notice.copy;
}

export function renderApp(state, getBytes) {
  document.title = state.settings.appName;
  document.querySelector(".brand-mark").textContent = state.settings.appName;
  document.querySelector("#organization-name").textContent = state.sharedMode ? "초대 문서함" : state.settings.organization;
  document.querySelector("#total-count").textContent = String(state.documents.length);
  document.querySelector("#source-name").textContent = state.sourceName;
  document.querySelector("#source-path").textContent = state.publicMode ? "게시된 공개 스냅샷" : state.localMode ? "이 컴퓨터의 동기화 폴더" : state.settings.demoMode ? "Google Drive 연결 전" : state.settings.rootFolderId || "폴더 설정 필요";
  document.querySelector("#sync-button").textContent = state.publicMode ? "게시 목록 새로고침" : "목록 새로고침";
  document.querySelector("#last-sync").textContent = formatDateTime(state.lastSync);
  document.querySelector("#search-mode").value = state.mode;
  document.querySelector("#search-input").value = state.query;
  document.querySelector("#search-input").placeholder = state.mode === "content" ? "학교 폭력, 학생 자치 · 쉼표로 AND 검색" : "문서 이름 · 쉼표로 AND 검색";
  document.querySelector("#search-submit").textContent = state.searching ? state.searchProgress || "검색 중" : "검색";
  document.querySelector("#search-submit").disabled = state.searching;
  document.querySelector("#result-summary").textContent = state.mode === "content" && state.query.trim() && !state.contentMatches
    ? state.searching ? "본문 검색 중" : "본문 검색 대기"
    : state.query ? `검색 결과 ${state.results.length}개 · ${state.query}` : `${state.folder === "전체" ? "전체" : state.folder} ${state.results.length}개`;
  document.querySelector("#sort-label").textContent = state.query.trim()
    ? "관련도순"
    : "최신 수정순";
  renderConnection(state);
  renderNotice(state);
  renderFolders(state);
  renderDocuments(state);
  renderDetail(state, getBytes);
}
