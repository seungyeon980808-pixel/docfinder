import { BUILD_PROFILE, DEFAULT_CONFIG, resolvePublicSnapshotUrls } from "../config.js?v=compact-live-1";
import { DEMO_DOCUMENTS } from "../data/demo-documents.js";
import { createDetailPanelController } from "./detail-panel.js?v=verification-2";
import { downloadDriveFile, DriveError } from "./drive-api.js";
import { createSearchClient } from "./search-client.js?v=phrase-map-2";
import { summarizeIndex } from "./index-health.js?v=phrase-map-2";
import { openPdfEditor } from "./pdf-editor.js";
import { renderApp } from "./render.js?v=phrase-map-2";
import { destroyRhwpEditor, initRhwpEditor, openRhwpEditor } from "./rhwp-editor.js";
import { documentFormat, filterDocuments, matchProximity } from "./search.js?v=phrase-map-2";
import { createStore, loadPublicSnapshot, loadSettings, saveSettings, selectSnapshotDocumentId } from "./store.js";
import { createToast } from "./toast.js";
import { createByteCache } from "./preview-cache.js?v=phrase-map-2";
import { createSharedLibrary } from "./shared-library.js?v=sharing-1";

const forceDemo = new URLSearchParams(location.search).has("demo");
const publicMode = BUILD_PROFILE.profile === "public";
const sharedMode = BUILD_PROFILE.profile === "shared";
const localProfile = BUILD_PROFILE.profile === "local" && !new URLSearchParams(location.search).has("personal");
const personalMode = !publicMode && !localProfile && !sharedMode;
document.documentElement.dataset.profile = sharedMode ? "shared" : localProfile ? "local" : publicMode ? "public" : "private";
const settings = localProfile || sharedMode ? { ...DEFAULT_CONFIG, demoMode: false } : { ...loadSettings(DEFAULT_CONFIG, BUILD_PROFILE), demoMode: forceDemo && !publicMode };
const initialDocuments = settings.demoMode && !publicMode ? [...DEMO_DOCUMENTS] : [];
const newestDocumentId = (documents) => [...documents].sort((left, right) => String(right.modifiedTime).localeCompare(String(left.modifiedTime)))[0]?.id || "";
const initialSelectedId = newestDocumentId(initialDocuments);
const store = createStore({
  settings,
  documents: initialDocuments,
  contentMatches: null,
  localMode: localProfile,
  autoIndex: localProfile,
  publicMode,
  sharedMode,
  personalMode,
  personalBusy: false,
  driveConnected: false,
  results: initialDocuments,
  folder: "전체",
  query: "",
  mode: "name",
  selectedId: initialSelectedId,
  accessToken: "",
  connection: publicMode ? "connecting" : settings.demoMode ? "demo" : "idle",
  sourceName: publicMode ? "게시 문서" : settings.demoMode ? "데모 자료" : "내 자료",
  lastSync: settings.demoMode ? new Date().toISOString() : "",
  searching: false,
  searchProgress: "",
  notice: publicMode
    ? { visible: true, type: "success", title: "게시 문서를 불러오는 중입니다", copy: "게시된 문서 목록과 검색 색인을 확인하고 있습니다." }
    : settings.demoMode
    ? { visible: true, type: "success", title: `데모 문서 ${initialDocuments.length}개를 불러왔습니다`, copy: "폴더와 파일명을 기준으로 분류합니다." }
    : { visible: false, type: "success", title: "내 자료를 연결하세요", copy: "Drive에 업로드하거나 이 컴퓨터의 파일을 불러오면 자동으로 색인합니다." }
});

const detailPanel = createDetailPanelController();
const showToast = createToast();
const searchClient = createSearchClient();
let searchSequence = 0;
let searchTimer;
let localRevision = "";
let sharedSignature = "";
const sharedController = sharedMode ? createSharedLibrary({ notify: showToast, onChange(snapshot) {
  const previous = store.get();
  if (previous.sharedUser?.id !== snapshot.sharedUser?.id || previous.libraryId !== snapshot.libraryId) destroyRhwpEditor();
  const signature = JSON.stringify([snapshot.sharedUser?.id, snapshot.libraryId, snapshot.documents.map((item) => [item.id, item.version, item.indexStatus])]);
  const changed = signature !== sharedSignature;
  if (changed) { sharedSignature = signature; searchSequence++; }
  updateView({ ...snapshot, ...(changed ? { contentMatches: null, selectedId: selectSnapshotDocumentId(snapshot.documents, store.get().libraryId === snapshot.libraryId ? store.get().selectedId || deepLinkedId : deepLinkedId), searching: false } : {}),
    notice: { visible: Boolean(snapshot.sharedAccessError), type: "error", title: "문서함 접근을 확인하세요", copy: snapshot.sharedAccessError || "" } });
  if (changed && snapshot.documents.length && store.get().query.trim()) { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 0); }
} }) : null;

function visibleDocuments(state) {
  const externalContent = (state.mode === "content" || state.sharedMode) && (state.localMode || state.publicMode || state.personalMode || state.sharedMode || !state.settings.demoMode);
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
  if (state.localMode || state.publicMode || state.personalMode || state.settings.demoMode) return [...filtered].sort((left, right) =>
    (left.matchQuality ?? 2) - (right.matchQuality ?? 2)
    || (left.matchDistance ?? matchProximity(left.excerpt, state.query)?.distance ?? Infinity)
    - (right.matchDistance ?? matchProximity(right.excerpt, state.query)?.distance ?? Infinity)
    || newestFirst(left, right));
  return [...filtered].sort(newestFirst);
}

let localIndexPromise;
let publicBootPromise;
let personalController;
let personalControllerPromise;
let personalIndex = { version: 1, entries: [] };
let personalSignature = "";
async function getPersonalLibrary() {
  personalControllerPromise ||= import("./personal-library.js?v=drive-upload-1").then(({ createPersonalLibrary }) => {
    personalController = createPersonalLibrary({ onChange(snapshot) {
      const signature = JSON.stringify([snapshot.libraryId, snapshot.documents.map((item) => [item.id, item.modifiedTime, item.indexStatus]), snapshot.entries.length]);
      const changed = signature !== personalSignature;
      if (changed) {
        personalSignature = signature;
        personalIndex = { version: 1, entries: snapshot.entries };
        searchClient.reset(); searchSequence++;
      }
      const indexStats = changed ? summarizeIndex(snapshot.documents, snapshot.entries) : store.get().indexStats;
      updateView({ documents: snapshot.documents, sourceName: snapshot.sourceName, libraryId: snapshot.libraryId,
        personalBusy: snapshot.busy, personalProgress: snapshot.progress, driveConnected: snapshot.connected,
        connection: snapshot.error || indexStats?.failures ? "error" : snapshot.connected ? "connected" : snapshot.documents.length ? "local" : "idle",
        indexStats,
        ...(changed ? { contentMatches: null } : {}),
        notice: { visible: Boolean(snapshot.error || !snapshot.durable && snapshot.documents.length), type: snapshot.error ? "error" : "success",
          title: snapshot.error ? "연결 또는 업로드를 확인하세요" : "현재 탭에서 사용 중입니다",
          copy: snapshot.error || "브라우저 저장 공간을 사용할 수 없습니다. 탭을 닫으면 파일을 다시 불러와야 합니다." }
      });
      const state = store.get();
      if (changed && state.mode === "content" && state.query.trim()) { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 0); }
    } });
    return personalController;
  }).catch((error) => { personalControllerPromise = undefined; throw error; });
  return personalControllerPromise;
}
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
    indexStats: summarizeIndex(snapshot.documents, snapshot.indexEntries),
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
  searchClient.reset();
  localRevision = catalog.generatedAt;
  const current = store.get();
  const byId = new Map(documents.map((item) => [item.id, item]));
  const retainedMatches = current.contentMatches?.flatMap((match) => {
    const item = byId.get(match.id);
    return item ? [{ ...match, ...item, page: match.page, heading: match.heading,
      excerpt: match.excerpt, matchedPages: match.matchedPages }] : [];
  }) ?? null;
  updateView({
    localMode: true,
    documents,
    indexStats: undefined,
    contentMatches: retainedMatches,
    selectedId: selectSnapshotDocumentId(documents, current.selectedId || deepLinkedId),
    sourceName: catalog.sourceName || "로컬 문서",
    lastSync: catalog.generatedAt,
    connection: "local",
    notice: { visible: false, type: "success", title: `실제 문서 ${documents.length}개를 불러왔습니다`, copy: localProfile ? "문서 폴더의 추가·수정·삭제가 자동으로 반영됩니다." : "로컬 폴더의 색인을 사용합니다." }
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
  document.querySelector("#setting-pdf-editor-url").value = state.settings.pdfEditorUrl || "";
  document.querySelector("#setting-demo-mode").checked = state.settings.demoMode;
  document.querySelector("#settings-dialog").showModal();
}

async function syncDrive() {
  const state = store.get();
  try {
    if (state.sharedMode) await sharedController.sync();
    else if (state.publicMode) await loadPublishedCatalog();
    else if (state.localMode) { await loadLocalCatalog(); await runSearch(); }
    else await (await getPersonalLibrary()).sync();
  } catch (error) { showToast(error.message || "문서 목록을 불러오지 못했습니다."); }
}

async function connectDrive() {
  const state = store.get();
  if (state.sharedMode) { await sharedController.connect(); return; }
  if (!state.settings.googleClientId) {
    openSettings();
    showToast("운영용 Google 클라이언트 ID를 설정하세요.");
    return;
  }
  try {
    const controller = personalController || await getPersonalLibrary();
    await controller.connect(state.settings.googleClientId);
  }
  catch (error) { showToast(error.message || "Google Drive를 연결하지 못했습니다."); }
}

async function runSearch() {
  clearTimeout(searchTimer);
  const request = ++searchSequence;
  const state = store.get();
  const isCurrent = () => request === searchSequence && store.get().query === state.query && store.get().mode === state.mode;
  if (state.sharedMode) {
    if (!state.query.trim()) { updateView({ contentMatches: null }); return; }
    updateView({ searching: true, searchProgress: "검색 중" });
    try { const matches = await sharedController.search(state.query, state.mode); if (isCurrent()) updateView({ contentMatches: matches, searching: false, searchProgress: "" }); }
    catch (error) { if (isCurrent()) { updateView({ searching: false, contentMatches: [], searchProgress: "" }); showToast(error.message); await sharedController.refresh(); } }
    return;
  }
  if ((state.localMode || state.publicMode || state.personalMode) && state.mode === "content" && state.query.trim()) {
    updateView({ searching: true, searchProgress: "색인 검색 중" });
    try {
      if (state.publicMode) await publicBootPromise;
      else if (state.personalMode) { await getPersonalLibrary(); localIndexPromise = Promise.resolve(personalIndex); }
      else {
        localIndexPromise ||= fetch(`private/search-index.json${localProfile ? `?revision=${encodeURIComponent(localRevision)}` : ""}`, { cache: "no-store" }).then((response) => {
          if (!response.ok) throw new Error("로컬 색인을 찾을 수 없습니다.");
          return response.json();
        });
      }
      const index = await localIndexPromise;
      if (!isCurrent()) return;
      if (index.version !== 1 || !Array.isArray(index.entries)) throw new Error("로컬 색인 형식이 올바르지 않습니다.");
      const documents = state.publicMode ? store.get().documents : state.documents;
      const matches = await searchClient.search(documents, index.entries, state.query);
      if (isCurrent()) updateView({ contentMatches: matches, searching: false, searchProgress: "", indexStats: summarizeIndex(documents, index.entries) });
    } catch {
      if (!isCurrent()) return;
      localIndexPromise = undefined;
      updateView({ searching: false, searchProgress: "", notice: { visible: true, type: "error", title: state.publicMode ? "게시된 본문 검색에 실패했습니다" : "로컬 본문 검색에 실패했습니다", copy: state.publicMode ? "페이지를 새로고침한 뒤 다시 시도하세요." : "색인을 다시 생성한 뒤 새로고침하세요." } });
    }
    return;
  }
  if (state.mode !== "content" || state.settings.demoMode || !state.query.trim()) {
    updateView({ contentMatches: null });
    return;
  }
  updateView({ contentMatches: null });
}

const cachedDocumentBytes = createByteCache(loadDocumentBytes);

async function getDocumentBytes(documentItem) {
  if (store.get().sharedMode) return sharedController.getBytes(documentItem);
  if (documentItem.libraryId) return (await getPersonalLibrary()).getBytes(documentItem);
  // Drive authorization is checked on every read, including cached originals.
  if (documentItem.source === "drive") return loadDocumentBytes(documentItem);
  return cachedDocumentBytes(documentItem);
}

async function loadDocumentBytes(documentItem) {
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
  if (documentItem.source === "shared") return downloadDocument(documentItem);
  if (documentItem.source === "browser") return downloadDocument(documentItem);
  const url = documentItem.sourceUrl || documentItem.downloadUrl || documentItem.webViewLink || documentItem.previewUrl;
  if (!url) { showToast("데모 문서에는 원본 링크가 없습니다."); return; }
  window.open(url, "_blank", "noopener");
}

async function runRowAction(action, documentItem) {
  if (store.get().sharedMode && ["reindex", "edit", "trash"].includes(action) && store.get().sharedLibrary?.role !== "owner") return;
  if (action === "trash") {
    if (!confirm(`${documentItem.name}을 Drive 휴지통으로 이동할까요? 문서함에서도 제거됩니다.`)) return;
    try { await sharedController.trash(documentItem); showToast("Drive 휴지통으로 이동했습니다."); } catch (error) { showToast(error.message); }
    return;
  }
  if (action === "reindex") {
    try { if (store.get().sharedMode) await sharedController.retry(documentItem); else await (await getPersonalLibrary()).retry(documentItem); }
    catch (error) { showToast(error.message || "색인을 다시 시도하지 못했습니다."); }
    return;
  }
  if (action === "download") return downloadDocument(documentItem);
  if (action === "original") return openDocumentOriginal(documentItem);
  if (action === "link") {
    const url = store.get().sharedMode ? new URL(`/s/${store.get().sharedLibrary.share_id}`, location.origin) : new URL(location.href);
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
  if (event.target.closest('[data-personal-action="connect"]')) await connectDrive();
  if (event.target.closest("#upload-button")) document.querySelector("#drive-upload-input").click();
  if (event.target.closest('[data-personal-action="local"]') || event.target.closest("#import-local-button")) document.querySelector("#local-library-input").click();
  if (event.target.closest("#disconnect-button")) {
    try { if (store.get().sharedMode) await sharedController.disconnect(); else (await getPersonalLibrary()).disconnect(); }
    catch (error) { showToast(error.message); }
  }
  if (event.target.closest("#restore-local-button")) {
    try { await (await getPersonalLibrary()).restoreLocal(); }
    catch (error) { showToast(error.message || "저장한 문서를 불러오지 못했습니다."); }
  }
  if (event.target.closest("#sync-button") || event.target.closest("#refresh-button")) await syncDrive();
  if (event.target.closest("#dismiss-notice")) updateView((state) => ({ notice: { ...state.notice, visible: false } }));
  if (event.target.closest("#clear-search")) {
    searchSequence += 1;
    clearTimeout(searchTimer);
    updateView({ query: "", folder: "전체", contentMatches: null, searching: false, searchProgress: "" });
  }
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
function queueSearch(patch) {
  searchSequence += 1;
  clearTimeout(searchTimer);
  updateView({ ...patch, contentMatches: null, searching: false, searchProgress: "" });
  const state = store.get();
  if ((state.sharedMode || (state.localMode || state.publicMode || state.personalMode) && state.mode === "content") && state.query.trim()) searchTimer = setTimeout(runSearch, 180);
}
let composingQuery = false;
document.querySelector("#search-input").addEventListener("compositionstart", () => {
  composingQuery = true;
  searchSequence += 1;
  clearTimeout(searchTimer);
});
document.querySelector("#search-input").addEventListener("compositionend", (event) => {
  composingQuery = false;
  queueSearch({ query: event.target.value });
});
document.querySelector("#search-input").addEventListener("input", (event) => {
  if (!composingQuery && !event.isComposing) queueSearch({ query: event.target.value });
});
document.querySelector("#search-mode").addEventListener("change", (event) => { queueSearch({ mode: event.target.value }); });
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
for (const [selector, action] of [["#drive-upload-input", "upload"], ["#local-library-input", "importLocal"]]) {
  document.querySelector(selector).addEventListener("change", async (event) => {
    const files = [...event.target.files || []];
    event.target.value = "";
    if (!files.length) return;
    try { if (store.get().sharedMode && action === "upload") await sharedController.upload(files); else await (await getPersonalLibrary())[action](files); }
    catch (error) { showToast(error.message || "파일을 처리하지 못했습니다."); }
  });
}
document.querySelector("#settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const nextSettings = {
    appName: document.querySelector("#setting-app-name").value.trim(),
    organization: document.querySelector("#setting-organization").value.trim(),
    googleClientId: document.querySelector("#setting-client-id").value.trim(),
    rootFolderId: "",
    pdfEditorUrl: document.querySelector("#setting-pdf-editor-url").value.trim(),
    demoMode: false
  };
  personalController?.disconnect();
  saveSettings(nextSettings);
  const documents = nextSettings.demoMode ? [...DEMO_DOCUMENTS] : [];
  updateView({ settings: nextSettings, localMode: false, documents, contentMatches: null, accessToken: "", connection: nextSettings.demoMode ? "demo" : "idle", sourceName: nextSettings.demoMode ? "데모 자료" : "Google Drive", selectedId: newestDocumentId(documents) });
  document.querySelector("#settings-dialog").close();
  showToast("설정을 저장했습니다.");
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
if (sharedMode) {
  sharedController.start().catch((error) => showToast(error.message || "공유 문서함을 준비하지 못했습니다."));
} else if (publicMode) {
  publicBootPromise = loadPublishedCatalog();
  publicBootPromise.catch(() => updateView({
    connection: "error",
    notice: { visible: true, type: "error", title: "게시 문서를 불러오지 못했습니다", copy: "게시된 목록과 검색 색인을 확인한 뒤 새로고침하세요." }
  }));
} else if (localProfile) {
  loadLocalCatalog().catch(() => showToast("로컬 문서 목록을 불러오지 못했습니다."));
} else if (personalMode) {
  // Preload before the first click so opening Google's popup stays synchronous.
  getPersonalLibrary().catch(() => showToast("문서함을 준비하지 못했습니다. 새로고침하세요."));
}

if (localProfile) {
  let polling = false;
  async function refreshLocalIndex() {
    if (polling || document.hidden) return;
    polling = true;
    try {
      const response = await fetch("api/index-status", { cache: "no-store" });
      if (!response.ok) throw new Error("Local server unavailable");
      const status = await response.json();
      const connection = status.phase === "indexing" ? "indexing" : status.phase === "error" ? "error" : "local";
      if (status.revision && status.revision !== localRevision) {
        searchSequence += 1;
        await loadLocalCatalog();
        await runSearch();
      }
      if (store.get().connection !== connection || store.get().indexMessage !== status.message
        || JSON.stringify(store.get().indexStats) !== JSON.stringify(status.stats)) updateView({ connection, indexMessage: status.message, indexStats: status.stats });
    } catch {
      if (store.get().connection !== "error") updateView({ connection: "error", indexMessage: "로컬 서버 연결을 확인하세요." });
    } finally { polling = false; }
  }
  setInterval(refreshLocalIndex, 2000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshLocalIndex(); });
}
