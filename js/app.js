import { BUILD_PROFILE, DEFAULT_CONFIG, resolvePublicSnapshotUrls } from "../config.js";
import { DEMO_DOCUMENTS } from "../data/demo-documents.js";
import { createDetailPanelController } from "./detail-panel.js?v=verification-2";
import { authorizeDrive, downloadDriveFile, DriveError, scanDriveFolder, searchDriveContent } from "./drive-api.js";
import { searchHwpContent } from "./hwp-index.js?v=verification-2";
import { searchLocalIndex } from "./local-index.js?v=verification-2";
import { openPdfEditor } from "./pdf-editor.js";
import { renderApp } from "./render.js?v=width-fit-1";
import { initRhwpEditor, openRhwpEditor } from "./rhwp-editor.js";
import { documentFormat, filterDocuments, matchProximity } from "./search.js?v=verification-2";
import { compareSnapshot, createStore, loadPublicSnapshot, loadSettings, loadSnapshot, saveSettings, saveSnapshot, selectSnapshotDocumentId } from "./store.js";
import { createToast } from "./toast.js";

const forceDemo = new URLSearchParams(location.search).has("demo");
const publicMode = BUILD_PROFILE.profile === "public";
document.documentElement.dataset.profile = publicMode ? "public" : "private";
const settings = loadSettings(DEFAULT_CONFIG, { ...BUILD_PROFILE, forceDemo: forceDemo && !publicMode });
const initialDocuments = settings.demoMode && !publicMode ? [...DEMO_DOCUMENTS] : [];
const newestDocumentId = (documents) => [...documents].sort((left, right) => String(right.modifiedTime).localeCompare(String(left.modifiedTime)))[0]?.id || "";
const initialSelectedId = newestDocumentId(initialDocuments);
const store = createStore({
  settings,
  documents: initialDocuments,
  contentMatches: null,
  localMode: false,
  publicMode,
  results: initialDocuments,
  folder: "전체",
  query: "",
  mode: "name",
  selectedId: initialSelectedId,
  accessToken: "",
  connection: publicMode ? "connecting" : settings.demoMode ? "demo" : "idle",
  sourceName: publicMode ? "게시 문서" : settings.demoMode ? "데모 자료" : "Google Drive",
  lastSync: settings.demoMode ? new Date().toISOString() : "",
  searching: false,
  searchProgress: "",
  notice: publicMode
    ? { visible: true, type: "success", title: "게시 문서를 불러오는 중입니다", copy: "게시된 문서 목록과 검색 색인을 확인하고 있습니다." }
    : settings.demoMode
    ? { visible: true, type: "success", title: `데모 문서 ${initialDocuments.length}개를 불러왔습니다`, copy: "폴더와 파일명을 기준으로 분류합니다." }
    : { visible: true, type: "success", title: "Google Drive를 연결하세요", copy: "설정에 OAuth 클라이언트 ID와 공유할 루트 폴더를 입력하면 문서를 자동으로 불러옵니다." }
});

const detailPanel = createDetailPanelController();
const showToast = createToast();

function visibleDocuments(state) {
  const externalContent = state.mode === "content" && (state.localMode || state.publicMode || !state.settings.demoMode);
  if (externalContent && state.query.trim() && !state.contentMatches) return [];
  const source = externalContent && state.contentMatches ? state.contentMatches : state.documents;
  const query = externalContent ? "" : state.query;
  const filtered = filterDocuments(source, { query, folder: state.folder, mode: state.mode });
  const newestFirst = (left, right) => String(right.modifiedTime).localeCompare(String(left.modifiedTime));
  if (!state.query.trim()) return [...filtered].sort(newestFirst);
  if (state.mode === "name") return [...filtered].sort((left, right) => {
    const leftName = matchProximity(left.name, state.query);
    const rightName = matchProximity(right.name, state.query);
    if (Boolean(leftName) !== Boolean(rightName)) return leftName ? -1 : 1;
    const leftMatch = leftName || matchProximity(`${left.name} ${left.path}`, state.query);
    const rightMatch = rightName || matchProximity(`${right.name} ${right.path}`, state.query);
    return (leftMatch?.distance ?? Infinity) - (rightMatch?.distance ?? Infinity) || newestFirst(left, right);
  });
  if (state.localMode || state.publicMode || state.settings.demoMode) return [...filtered].sort((left, right) =>
    (left.matchDistance ?? matchProximity(left.excerpt, state.query)?.distance ?? Infinity)
    - (right.matchDistance ?? matchProximity(right.excerpt, state.query)?.distance ?? Infinity)
    || newestFirst(left, right));
  return [...filtered].sort(newestFirst);
}

let localIndexPromise;
let publicBootPromise;
const deepLinkedId = location.hash.startsWith("#doc=") ? location.hash.slice(5) : "";
const publicSnapshotUrls = resolvePublicSnapshotUrls();

async function loadPublishedCatalog() {
  const snapshot = await loadPublicSnapshot(publicSnapshotUrls, new URL("../", import.meta.url).href);
  const selectedId = selectSnapshotDocumentId(snapshot.documents, deepLinkedId);
  if (deepLinkedId && selectedId !== deepLinkedId) history.replaceState(null, "", `${location.pathname}${location.search}`);
  localIndexPromise = Promise.resolve({ version: 1, entries: snapshot.indexEntries });
  updateView({
    publicMode: true,
    documents: snapshot.documents,
    contentMatches: null,
    selectedId,
    sourceName: "게시 문서",
    lastSync: snapshot.generatedAt,
    connection: "local",
    notice: { visible: false, type: "success", title: `게시 문서 ${snapshot.documents.length}개를 불러왔습니다`, copy: "게시된 목록과 검색 색인을 사용합니다." }
  });
}

async function loadLocalCatalog() {
  const response = await fetch("private/catalog.json", { cache: "no-store" });
  if (!response.ok) return false;
  const catalog = await response.json();
  if (catalog.version !== 1 || !Array.isArray(catalog.documents)) throw new Error("로컬 문서 목록 형식이 올바르지 않습니다.");
  const documents = catalog.documents;
  localIndexPromise = undefined;
  updateView({
    localMode: true,
    documents,
    contentMatches: null,
    selectedId: documents.some((item) => item.id === deepLinkedId) ? deepLinkedId : newestDocumentId(documents),
    sourceName: catalog.sourceName || "로컬 문서",
    lastSync: catalog.generatedAt,
    connection: "local",
    notice: { visible: false, type: "success", title: `실제 문서 ${documents.length}개를 불러왔습니다`, copy: "Google Drive 동기화 폴더의 로컬 색인을 사용합니다. 문서가 바뀌면 색인을 다시 생성하세요." }
  });
  return true;
}

function updateView(patch) {
  store.update((state) => {
    const next = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
    next.results = visibleDocuments(next);
    if (!next.results.some((item) => item.id === next.selectedId)) next.selectedId = next.results[0]?.id || "";
    return next;
  });
}

function openSettings() {
  const state = store.get();
  document.querySelector("#setting-app-name").value = state.settings.appName;
  document.querySelector("#setting-organization").value = state.settings.organization;
  document.querySelector("#setting-client-id").value = state.settings.googleClientId;
  document.querySelector("#setting-folder-id").value = state.settings.rootFolderId;
  document.querySelector("#setting-pdf-editor-url").value = state.settings.pdfEditorUrl || "";
  document.querySelector("#setting-demo-mode").checked = state.settings.demoMode;
  document.querySelector("#settings-dialog").showModal();
}

async function syncDrive() {
  const state = store.get();
  if (state.publicMode) {
    try { await loadPublishedCatalog(); }
    catch { showToast("게시 문서 목록을 불러오지 못했습니다."); }
    return;
  }
  if (state.localMode) {
    try { await loadLocalCatalog(); }
    catch { showToast("로컬 색인을 불러오지 못했습니다."); }
    return;
  }
  if (state.settings.demoMode) {
    const documents = [...DEMO_DOCUMENTS];
    updateView({ documents, selectedId: newestDocumentId(documents), lastSync: new Date().toISOString(), notice: { visible: true, type: "success", title: "데모 문서를 다시 불러왔습니다", copy: "실제 문서는 설정에서 Google Drive를 연결하면 자동으로 반영됩니다." } });
    return;
  }
  if (!state.accessToken) return connectDrive();
  updateView({ connection: "connecting", searching: true });
  try {
    const { rootName, documents } = await scanDriveFolder(state.accessToken, state.settings.rootFolderId);
    const previous = loadSnapshot();
    const changes = compareSnapshot(documents, previous);
    const added = new Set(changes.added);
    const current = documents.map((documentItem) => ({ ...documentItem, isNew: added.has(documentItem.id) }));
    saveSnapshot(documents);
    const changeCount = changes.added.length + changes.updated.length + changes.removed.length;
    updateView({
      documents: current,
      contentMatches: null,
      sourceName: rootName,
      lastSync: new Date().toISOString(),
      connection: "connected",
      searching: false,
      notice: changeCount
        ? { visible: true, type: "success", title: `변경된 문서 ${changeCount}개를 자동 반영했습니다`, copy: `신규 ${changes.added.length}개 · 수정 ${changes.updated.length}개 · 삭제 ${changes.removed.length}개` }
        : { visible: true, type: "success", title: "모든 문서가 최신 상태입니다", copy: "Drive 폴더와 문서 목록을 확인했습니다." }
    });
  } catch (error) {
    const message = error instanceof DriveError ? error.message : "Drive 문서를 불러오지 못했습니다.";
    updateView({ connection: "error", searching: false, notice: { visible: true, type: "error", title: "동기화하지 못했습니다", copy: message } });
  }
}

async function connectDrive() {
  const state = store.get();
  if (!state.settings.googleClientId || !state.settings.rootFolderId) {
    openSettings();
    showToast("먼저 Google Drive 연결 정보를 입력하세요.");
    return;
  }
  updateView({ connection: "connecting" });
  try {
    const accessToken = await authorizeDrive(state.settings.googleClientId);
    updateView({ accessToken, connection: "connected" });
    await syncDrive();
  } catch (error) {
    const message = error instanceof DriveError ? error.message : "Google 계정 연결에 실패했습니다.";
    updateView({ connection: "error", notice: { visible: true, type: "error", title: "Drive에 연결하지 못했습니다", copy: message } });
  }
}

async function runSearch() {
  const state = store.get();
  if ((state.localMode || state.publicMode) && state.mode === "content" && state.query.trim()) {
    updateView({ searching: true, searchProgress: "색인 검색 중" });
    try {
      if (state.publicMode) await publicBootPromise;
      else {
        localIndexPromise ||= fetch("private/search-index.json", { cache: "no-store" }).then((response) => {
          if (!response.ok) throw new Error("로컬 색인을 찾을 수 없습니다.");
          return response.json();
        });
      }
      const index = await localIndexPromise;
      if (index.version !== 1 || !Array.isArray(index.entries)) throw new Error("로컬 색인 형식이 올바르지 않습니다.");
      const documents = state.publicMode ? store.get().documents : state.documents;
      updateView({ contentMatches: searchLocalIndex(documents, index.entries, state.query), searching: false, searchProgress: "" });
    } catch {
      localIndexPromise = undefined;
      updateView({ searching: false, searchProgress: "", notice: { visible: true, type: "error", title: state.publicMode ? "게시된 본문 검색에 실패했습니다" : "로컬 본문 검색에 실패했습니다", copy: state.publicMode ? "페이지를 새로고침한 뒤 다시 시도하세요." : "색인을 다시 생성한 뒤 새로고침하세요." } });
    }
    return;
  }
  if (state.mode !== "content" || state.settings.demoMode || !state.query.trim()) {
    updateView({ contentMatches: null });
    return;
  }
  if (!state.accessToken) {
    showToast("문서 내용 검색을 사용하려면 Drive를 연결하세요.");
    await connectDrive();
    return;
  }
  updateView({ searching: true, searchProgress: "" });
  try {
    const pdfSearch = searchDriveContent(state.accessToken, state.query, state.documents);
    const hwpSearch = searchHwpContent(
      state.documents,
      state.query,
      getDocumentBytes,
      ({ current, total }) => updateView({ searchProgress: `한글 문서 색인 ${current}/${total}` })
    );
    const [pdfMatches, hwpResult] = await Promise.all([pdfSearch, hwpSearch]);
    const matches = [...pdfMatches, ...hwpResult.matches];
    updateView({
      contentMatches: matches,
      searching: false,
      searchProgress: "",
      ...(hwpResult.failures.length ? {
        notice: {
          visible: true,
          type: "error",
          title: `한글 문서 ${hwpResult.failures.length}개를 색인하지 못했습니다`,
          copy: "암호 문서이거나 RHWP가 아직 지원하지 않는 형식일 수 있습니다. 파일명 검색과 Drive 원문은 계속 사용할 수 있습니다."
        }
      } : {})
    });
  } catch (error) {
    const message = error instanceof DriveError ? error.message : "본문 검색에 실패했습니다.";
    updateView({ searching: false, searchProgress: "", notice: { visible: true, type: "error", title: "본문을 검색하지 못했습니다", copy: message } });
  }
}

async function getDocumentBytes(documentItem) {
  if (documentItem.source === "drive") {
    const accessToken = store.get().accessToken;
    if (!accessToken) throw new DriveError("한글 원문을 열려면 Google Drive를 다시 연결하세요.");
    return downloadDriveFile(accessToken, documentItem.id);
  }
  if (documentItem.sourceUrl) {
    const response = await fetch(documentItem.sourceUrl);
    if (!response.ok) throw new Error("예제 한글 문서를 불러오지 못했습니다.");
    return response.arrayBuffer();
  }
  if (documentItem.localFile instanceof File) return documentItem.localFile.arrayBuffer();
  throw new Error("한글 원문 위치를 확인할 수 없습니다.");
}

function selectedDocument() { const state = store.get(); return state.results.find((documentItem) => documentItem.id === state.selectedId) || state.documents.find((documentItem) => documentItem.id === state.selectedId); }

async function downloadDocument(documentItem) {
  if (documentItem.source === "demo") { showToast("데모 문서는 다운로드할 원본 파일이 없습니다."); return; }
  try {
    const bytes = await getDocumentBytes(documentItem);
    const blob = new Blob([bytes], { type: documentItem.format === "pdf" ? "application/pdf" : "application/octet-stream" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = documentItem.name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch { showToast("파일을 다운로드하지 못했습니다. 원문 위치를 확인하세요."); }
}

function openDocumentOriginal(documentItem) {
  const url = documentItem.sourceUrl || documentItem.downloadUrl || documentItem.webViewLink || documentItem.previewUrl;
  if (!url) { showToast("데모 문서에는 원본 링크가 없습니다."); return; }
  window.open(url, "_blank", "noopener");
}

async function runRowAction(action, documentItem) {
  if (action === "download") return downloadDocument(documentItem);
  if (action === "original") return openDocumentOriginal(documentItem);
  if (action === "link") {
    const url = new URL(location.href);
    url.hash = `doc=${documentItem.id}`;
    await navigator.clipboard.writeText(url.href);
    showToast("문서 링크를 복사했습니다.");
    return;
  }
  if (action === "edit") {
    if (["hwp", "hwpx"].includes(documentFormat(documentItem.name, documentItem.mimeType))) return openRhwpEditor(documentItem, getDocumentBytes);
    const state = store.get();
    if (!state.settings.pdfEditorUrl) { openSettings(); showToast("설정에서 PDF 편집기 주소를 연결하세요."); return; }
    try { openPdfEditor(state.settings.pdfEditorUrl, documentItem); }
    catch { showToast("PDF 편집기 주소를 확인하세요."); }
  }
}

document.addEventListener("click", async (event) => {
  if (event.target.closest("#tool-menu button")) document.querySelector("#tool-menu").open = false;
  const folder = event.target.closest("[data-folder]");
  const row = event.target.closest("[data-document-id]");
  const rowAction = event.target.closest("[data-row-action]");
  if (folder) updateView({ folder: folder.dataset.folder });
  if (row) {
    updateView({ selectedId: row.dataset.documentId });
    detailPanel.open(row.dataset.documentId);
  }
  if (rowAction) {
    const documentId = rowAction.closest("[data-result-id]")?.dataset.resultId;
    const documentItem = store.get().results.find((item) => item.id === documentId);
    rowAction.closest("details").open = false;
    if (documentItem) await runRowAction(rowAction.dataset.rowAction, documentItem);
  }
  if (event.target.closest("#settings-button")) openSettings();
  if (event.target.closest("#connect-button")) await connectDrive();
  if (event.target.closest("#sync-button") || event.target.closest("#refresh-button")) await syncDrive();
  if (event.target.closest("#dismiss-notice")) updateView((state) => ({ notice: { ...state.notice, visible: false } }));
  if (event.target.closest("#clear-search")) updateView({ query: "", folder: "전체", contentMatches: null });
  if (event.target.closest("#detail-back")) detailPanel.close();
  if (event.target.closest("#local-hwp-button")) document.querySelector("#local-hwp-input").click();
});

document.querySelector("#search-form").addEventListener("submit", async (event) => { event.preventDefault(); await runSearch(); });
document.querySelector("#document-list").addEventListener("toggle", (event) => {
  const actions = event.target;
  if (!actions.matches(".result-actions") || !actions.open) return;
  document.querySelectorAll(".result-actions[open]").forEach((other) => {
    if (other !== actions) other.open = false;
  });
  const trigger = actions.querySelector("summary").getBoundingClientRect();
  const menu = actions.querySelector(".result-menu-panel");
  const { width, height } = menu.getBoundingClientRect();
  const gap = 8;
  const below = trigger.bottom + gap;
  const above = trigger.top - height - gap;
  menu.style.left = `${Math.max(gap, Math.min(trigger.right - width, innerWidth - width - gap))}px`;
  menu.style.top = `${Math.max(gap, Math.min(below + height <= innerHeight - gap ? below : above, innerHeight - height - gap))}px`;
}, true);
document.querySelector(".document-table").addEventListener("scroll", () => {
  document.querySelectorAll(".result-actions[open]").forEach((actions) => { actions.open = false; });
});
window.addEventListener("resize", () => {
  document.querySelectorAll(".result-actions[open]").forEach((actions) => { actions.open = false; });
});
document.querySelector("#search-input").addEventListener("input", (event) => { updateView({ query: event.target.value, contentMatches: null }); });
document.querySelector("#search-mode").addEventListener("change", (event) => { updateView({ mode: event.target.value, contentMatches: null }); });
document.querySelector("#local-hwp-input").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  const format = documentFormat(file.name, file.type);
  if (format !== "hwp" && format !== "hwpx") {
    showToast("HWP 또는 HWPX 파일을 선택하세요.");
    return;
  }
  await openRhwpEditor({ id: `local-${Date.now()}`, name: file.name, format, source: "local", localFile: file }, getDocumentBytes);
});
document.querySelector("#settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const nextSettings = {
    appName: document.querySelector("#setting-app-name").value.trim(),
    organization: document.querySelector("#setting-organization").value.trim(),
    googleClientId: document.querySelector("#setting-client-id").value.trim(),
    rootFolderId: document.querySelector("#setting-folder-id").value.trim(),
    pdfEditorUrl: document.querySelector("#setting-pdf-editor-url").value.trim(),
    demoMode: document.querySelector("#setting-demo-mode").checked
  };
  saveSettings(nextSettings);
  const documents = nextSettings.demoMode ? [...DEMO_DOCUMENTS] : [];
  updateView({ settings: nextSettings, localMode: false, documents, contentMatches: null, accessToken: "", connection: nextSettings.demoMode ? "demo" : "idle", sourceName: nextSettings.demoMode ? "데모 자료" : "Google Drive", selectedId: newestDocumentId(documents) });
  document.querySelector("#settings-dialog").close();
  showToast("설정을 저장했습니다.");
  if (!forceDemo && nextSettings.demoMode && !nextSettings.googleClientId && ["localhost", "127.0.0.1"].includes(location.hostname)) {
    loadLocalCatalog().catch(() => showToast("로컬 문서 목록을 불러오지 못했습니다."));
  }
});
document.querySelectorAll(".dialog-close, .dialog-cancel").forEach((button) => button.addEventListener("click", () => document.querySelector("#settings-dialog").close()));
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !event.target.matches("input, textarea, select")) { event.preventDefault(); document.querySelector("#search-input").focus(); }
  if (event.key === "Escape") detailPanel.close();
});

store.subscribe((state) => renderApp(state, getDocumentBytes));
initRhwpEditor();
if (deepLinkedId && initialDocuments.some((documentItem) => documentItem.id === deepLinkedId)) updateView({ selectedId: deepLinkedId });
else updateView({});
if (publicMode) {
  publicBootPromise = loadPublishedCatalog();
  publicBootPromise.catch(() => updateView({
    connection: "error",
    notice: { visible: true, type: "error", title: "게시 문서를 불러오지 못했습니다", copy: "게시된 목록과 검색 색인을 확인한 뒤 새로고침하세요." }
  }));
} else if (!forceDemo && settings.demoMode && !settings.googleClientId && ["localhost", "127.0.0.1"].includes(location.hostname)) {
  loadLocalCatalog().catch(() => showToast("로컬 문서 목록을 불러오지 못했습니다."));
}
