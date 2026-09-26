const PDF_MODULE_URL = new URL("../vendor/pdfjs/pdf.mjs", import.meta.url).href;
const PDF_WORKER_URL = new URL("../vendor/pdfjs/pdf.worker.mjs", import.meta.url).href;
const PDF_ASSET_URL = new URL("../vendor/pdfjs/", import.meta.url).href;

let pdfjsPromise;
let activeSession;

async function pdfjs() {
  pdfjsPromise ||= import(PDF_MODULE_URL).then((module) => {
    module.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
    return module;
  });
  return pdfjsPromise;
}

export function localPdfMarkup() {
  return '<section class="pdf-viewer" aria-label="PDF 원문"><p class="preview-loading" role="status">PDF 원문을 여는 중입니다</p></section>';
}

export function clearPdfPreview() {
  if (!activeSession) return;
  activeSession.observer?.disconnect();
  activeSession.resizeObserver?.disconnect();
  activeSession.scrollRoot.removeEventListener("scroll", activeSession.onScroll);
  for (const task of activeSession.tasks) task.cancel();
  activeSession.loadingTask?.destroy();
  activeSession = undefined;
}

export async function renderLocalPdf(viewer, documentItem, getBytes) {
  clearPdfPreview();
  const scrollRoot = document.querySelector("#document-detail");
  const status = document.querySelector("#preview-page-status");
  const session = { viewer, scrollRoot, status, tasks: new Set(), visible: new Set() };
  activeSession = session;
  try {
    const [module, bytes] = await Promise.all([pdfjs(), getBytes(documentItem)]);
    if (activeSession !== session) return;
    session.loadingTask = module.getDocument({
      data: new Uint8Array(bytes), cMapUrl: `${PDF_ASSET_URL}cmaps/`, cMapPacked: true,
      standardFontDataUrl: `${PDF_ASSET_URL}standard_fonts/`,
      wasmUrl: `${PDF_ASSET_URL}wasm/`, isEvalSupported: false
    });
    const pdf = await session.loadingTask.promise;
    if (activeSession !== session) return;
    session.pdf = pdf;
    const firstPage = await pdf.getPage(1);
    if (activeSession !== session) return;
    const firstViewport = firstPage.getViewport({ scale: 1 });
    firstPage.cleanup();
    viewer.innerHTML = Array.from({ length: pdf.numPages }, (_, index) =>
      `<div class="source-page" data-page-number="${index + 1}" style="aspect-ratio:${firstViewport.width}/${firstViewport.height}"><canvas role="img" aria-label="PDF 원문 ${index + 1}쪽"></canvas></div>`).join("");
    session.pages = [...viewer.querySelectorAll(".source-page")];
    status.hidden = false;
    session.onScroll = () => {
      const threshold = scrollRoot.getBoundingClientRect().top + scrollRoot.clientHeight * 0.35;
      const current = session.pages.find((page) => page.getBoundingClientRect().bottom >= threshold);
      status.textContent = `${current?.dataset.pageNumber || pdf.numPages} / ${pdf.numPages}쪽`;
    };
    scrollRoot.addEventListener("scroll", session.onScroll, { passive: true });
    session.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          session.visible.add(entry.target);
          renderPage(session, entry.target);
        } else session.visible.delete(entry.target);
      }
      session.onScroll();
    }, { root: scrollRoot, rootMargin: "650px 0px" });
    session.pages.forEach((page) => session.observer.observe(page));
    session.resizeObserver = new ResizeObserver(() => {
      for (const page of session.visible) renderPage(session, page);
    });
    session.resizeObserver.observe(scrollRoot);
    session.pages[Math.max(0, Math.min((documentItem.page || 1) - 1, pdf.numPages - 1))].scrollIntoView({ block: "start" });
    session.onScroll();
  } catch {
    if (activeSession === session) {
      viewer.innerHTML = '<p class="preview-error">PDF 원문을 표시하지 못했습니다. 파일 작업 메뉴에서 원문을 열어 확인하세요.</p>';
      status.hidden = true;
    }
  }
}

async function renderPage(session, pageNode) {
  if (activeSession !== session || pageNode.dataset.rendering === "true") return;
  const width = pageNode.clientWidth;
  if (!width || pageNode.dataset.renderedWidth === String(width)) return;
  pageNode.dataset.rendering = "true";
  try {
    const page = await session.pdf.getPage(Number(pageNode.dataset.pageNumber));
    if (activeSession !== session) return;
    const base = page.getViewport({ scale: 1 });
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: (width / base.width) * ratio });
    const canvas = pageNode.querySelector("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    pageNode.style.aspectRatio = `${base.width}/${base.height}`;
    const task = page.render({ canvasContext: canvas.getContext("2d"), viewport });
    session.tasks.add(task);
    try { await task.promise; }
    finally { session.tasks.delete(task); }
    if (activeSession === session) pageNode.dataset.renderedWidth = String(width);
    page.cleanup();
  } catch {
    if (activeSession === session) pageNode.textContent = `PDF ${pageNode.dataset.pageNumber}쪽을 렌더링하지 못했습니다.`;
  } finally {
    pageNode.dataset.rendering = "false";
    if (activeSession === session && session.visible.has(pageNode) && pageNode.clientWidth !== width) renderPage(session, pageNode);
  }
}
