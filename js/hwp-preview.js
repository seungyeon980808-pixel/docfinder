const EDITOR_URL = new URL("../vendor/rhwp-editor/index.js?v=0.8.6-1", import.meta.url).href;
const STUDIO_URL = new URL("../vendor/rhwp-studio/index.html", import.meta.url).href;

let editor;
let editorHost;
let loadQueue = Promise.resolve();
let generation = 0;
let pageQueue = Promise.resolve();
let activeSession;

function disposeEditor() {
  editor?.destroy();
  editor = undefined;
  editorHost?.remove();
  editorHost = undefined;
}

async function prepareEditor() {
  // Studio retains visible-page state during loadFile; each document needs a fresh frame.
  disposeEditor();
  const { createEditor } = await import(EDITOR_URL);
  const host = document.createElement("div");
  host.className = "hwp-render-host";
  host.setAttribute("aria-hidden", "true");
  host.inert = true;
  document.body.append(host);
  try {
    editor = await createEditor(host, { studioUrl: STUDIO_URL, renderer: "canvas2d" });
    editorHost = host;
    return editor;
  } catch (error) {
    host.remove();
    throw error;
  }
}

export function clearHwpPreview() {
  generation += 1;
  if (!activeSession) return;
  activeSession.observer?.disconnect();
  activeSession.scrollRoot.removeEventListener("scroll", activeSession.onScroll);
  for (const url of activeSession.urls) URL.revokeObjectURL(url);
  activeSession = undefined;
}

export function renderHwpPreview(viewer, documentItem, getBytes) {
  if (!viewer) return;
  clearHwpPreview();
  const scrollRoot = document.querySelector("#document-detail");
  const status = document.querySelector("#preview-page-status");
  const session = { viewer, scrollRoot, status, urls: new Set(), rendered: new Set(), visible: new Set() };
  activeSession = session;
  const currentGeneration = generation;
  loadQueue = loadQueue.catch(() => {}).then(async () => {
    if (currentGeneration !== generation) return;
    try {
      await pageQueue.catch(() => {});
      if (currentGeneration !== generation) return;
      const bytes = await getBytes(documentItem);
      if (currentGeneration !== generation) return;
      const instance = await prepareEditor();
      if (currentGeneration !== generation) { disposeEditor(); return; }
      const result = await instance.loadFile(bytes, documentItem.name, { skipUnsavedGuard: true, suppressDialogs: true });
      if (currentGeneration !== generation) { disposeEditor(); return; }
      const pageCount = Number(result?.pageCount || await instance.pageCount());
      if (currentGeneration !== generation) { disposeEditor(); return; }
      if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new Error("원문 페이지가 없습니다.");
      viewer.innerHTML = Array.from({ length: pageCount }, (_, index) =>
        `<div class="source-page" data-page-number="${index + 1}"><img alt="${index + 1}쪽 한글 원문" /></div>`).join("");
      session.pages = [...viewer.querySelectorAll(".source-page")];
      status.hidden = false;
      session.onScroll = () => {
        const threshold = scrollRoot.getBoundingClientRect().top + scrollRoot.clientHeight * 0.35;
        const current = session.pages.find((page) => page.getBoundingClientRect().bottom >= threshold);
        status.textContent = `${current?.dataset.pageNumber || pageCount} / ${pageCount}쪽`;
      };
      scrollRoot.addEventListener("scroll", session.onScroll, { passive: true });
      session.observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            session.visible.add(entry.target);
            queuePage(session, entry.target, currentGeneration);
          } else {
            session.visible.delete(entry.target);
            releasePage(session, entry.target);
          }
        }
        session.onScroll();
      }, { root: scrollRoot, rootMargin: "650px 0px" });
      session.pages.forEach((page) => session.observer.observe(page));
      session.pages[Math.max(0, Math.min((documentItem.page || 1) - 1, pageCount - 1))].scrollIntoView({ block: "start" });
      session.onScroll();
    } catch {
      if (currentGeneration === generation && viewer.isConnected) {
        viewer.innerHTML = '<p class="preview-error">한글 원문을 표시하지 못했습니다. 파일 작업 메뉴에서 원문을 열어 확인하세요.</p>';
        status.hidden = true;
      }
    }
  });
}

function releasePage(session, pageNode) {
  const image = pageNode.querySelector("img");
  const url = image?.getAttribute("src");
  if (!url) return;
  image.removeAttribute("src");
  URL.revokeObjectURL(url);
  session.urls.delete(url);
  session.rendered.delete(pageNode);
}

function queuePage(session, pageNode, currentGeneration) {
  if (session.rendered.has(pageNode)) return;
  session.rendered.add(pageNode);
  pageQueue = pageQueue.catch(() => {}).then(async () => {
    if (currentGeneration !== generation || activeSession !== session) return;
    if (!session.visible.has(pageNode)) { session.rendered.delete(pageNode); return; }
    try {
      const svg = await editor.getPageSvg(Number(pageNode.dataset.pageNumber) - 1);
      if (currentGeneration !== generation || activeSession !== session) return;
      if (!session.visible.has(pageNode)) { session.rendered.delete(pageNode); return; }
      if (typeof svg !== "string" || !svg.includes("<svg")) throw new Error("원문 페이지가 없습니다.");
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      session.urls.add(url);
      const image = pageNode.querySelector("img");
      image.onerror = () => { pageNode.textContent = `${pageNode.dataset.pageNumber}쪽 이미지를 표시하지 못했습니다.`; };
      image.src = url;
    } catch {
      if (activeSession === session) pageNode.textContent = `${pageNode.dataset.pageNumber}쪽을 렌더링하지 못했습니다.`;
    }
  });
}
