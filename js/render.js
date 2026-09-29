import { clearPdfPreview, localPdfMarkup, renderLocalPdf } from "./pdf-preview.js";
import { clearHwpPreview, renderHwpPreview } from "./hwp-preview.js?v=verification-2";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);

function highlight(value, query) {
  const safe = escapeHtml(String(value ?? "").normalize("NFC"));
  const terms = query.normalize("NFC").trim().split(/\s+/u).filter(Boolean);
  if (!terms.length) return safe;
  const expression = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return safe.replace(new RegExp(`(${expression})`, "giu"), "<mark>$1</mark>");
}

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
  if (!state.results.length) {
    const pending = state.mode === "content" && state.query.trim() && !state.contentMatches;
    list.innerHTML = pending
      ? `<div class="empty-state"><strong>${state.searching ? "본문을 검색하는 중입니다" : "본문 검색을 실행하세요"}</strong><span>${state.searching ? "색인에서 일치하는 문서를 찾고 있습니다." : "검색 버튼을 누르면 원문 내용과 일치하는 문서만 표시합니다."}</span></div>`
      : '<div class="empty-state"><strong>일치하는 문서가 없습니다</strong><span>검색 범위나 단어를 바꿔 보세요.</span></div>';
    return;
  }
  const showFolder = new Set(state.documents.map((item) => item.folder)).size > 1;
  const matchLabel = (item) => [
    showFolder ? escapeHtml(item.folder) : "",
    item.page ? `${item.page}쪽 일치` : state.mode === "content" && state.query && item.excerpt ? "본문 일치" : ""
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
        <button type="button" data-row-action="original">원문 열기</button>
        <button type="button" data-row-action="link">문서 링크 복사</button>
        <button type="button" data-row-action="edit">${["hwp", "hwpx"].includes(formatOf(item)) ? "RHWP로 편집" : "PDF 편집기에서 열기"}</button>
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
    clearHwpPreview();
    document.querySelector("#preview-page-status").hidden = true;
    detail.dataset.key = "";
    detail.innerHTML = '<div class="empty-state"><strong>문서를 선택하세요</strong><span>목록에서 문서를 선택하면 원문과 정보를 확인할 수 있습니다.</span></div>';
    return;
  }
  const format = formatOf(documentItem);
  const evidenceQuery = state.contentMatches || (state.settings.demoMode && state.mode === "content") ? state.query : "";
  const detailKey = JSON.stringify([documentItem.id, documentItem.modifiedTime, documentItem.page, documentItem.excerpt, documentItem.source, state.localMode, state.settings.demoMode, state.mode, evidenceQuery, state.settings.pdfEditorUrl]);
  if (detail.dataset.key === detailKey) return;
  clearPdfPreview();
  clearHwpPreview();
  detail.scrollTop = 0;
  document.querySelector("#preview-page-status").hidden = true;
  detail.dataset.key = detailKey;
  const isHwp = format === "hwp" || format === "hwpx";
  const preview = isHwp ? hwpPreview() : documentItem.source === "demo" ? demoPreview(documentItem, state.query) : localPdfMarkup();
  detail.innerHTML = preview;
  if (!isHwp && documentItem.source !== "demo") renderLocalPdf(detail.querySelector(".pdf-viewer"), documentItem, getBytes);
  if (isHwp) renderHwpPreview(detail.querySelector(".hwp-preview"), documentItem, getBytes);
}

function renderConnection(state) {
  const status = document.querySelector("#connection-status");
  status.className = `connection-status${["connected", "local"].includes(state.connection) ? " is-connected" : state.connection === "error" ? " is-error" : ""}`;
  const labels = { demo: "데모 데이터", local: "로컬 색인", connecting: "Drive 연결 중", connected: "Drive 연결됨", error: "연결 확인 필요" };
  status.querySelector("span").textContent = state.publicMode ? state.connection === "error" ? "게시 목록 오류" : "게시 목록" : labels[state.connection] || "Drive 연결 안 됨";
  status.querySelector("#connect-button").textContent = state.connection === "connected" ? "다시 연결" : "Drive 연결";
  status.querySelector("#connect-button").hidden = state.localMode || state.publicMode;
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
  document.querySelector("#organization-name").textContent = state.settings.organization;
  document.querySelector("#total-count").textContent = String(state.documents.length);
  document.querySelector("#source-name").textContent = state.sourceName;
  document.querySelector("#source-path").textContent = state.publicMode ? "게시된 공개 스냅샷" : state.localMode ? "이 컴퓨터의 동기화 폴더" : state.settings.demoMode ? "Google Drive 연결 전" : state.settings.rootFolderId || "폴더 설정 필요";
  document.querySelector("#sync-button").textContent = state.publicMode ? "게시 목록 새로고침" : state.localMode ? "목록 새로고침" : "Drive 동기화";
  document.querySelector("#last-sync").textContent = formatDateTime(state.lastSync);
  document.querySelector("#search-mode").value = state.mode;
  document.querySelector("#search-input").value = state.query;
  document.querySelector("#search-input").placeholder = state.mode === "content" ? "PDF·한글 문서 본문에서 찾을 단어" : "문서 이름을 입력하세요";
  document.querySelector("#search-submit").textContent = state.searching ? state.searchProgress || "검색 중" : "검색";
  document.querySelector("#search-submit").disabled = state.searching;
  document.querySelector("#result-summary").textContent = state.mode === "content" && state.query.trim() && !state.contentMatches
    ? state.searching ? "본문 검색 중" : "본문 검색 대기"
    : state.query ? `검색 결과 ${state.results.length}개 · ${state.query}` : `${state.folder === "전체" ? "전체" : state.folder} ${state.results.length}개`;
  document.querySelector("#sort-label").textContent = state.query.trim()
    ? state.mode === "content" && !state.localMode && !state.publicMode && !state.settings.demoMode ? "Drive 검색 · 최신 수정순" : "단어 근접도순"
    : "최신 수정순";
  renderConnection(state);
  renderNotice(state);
  renderFolders(state);
  renderDocuments(state);
  renderDetail(state, getBytes);
}
