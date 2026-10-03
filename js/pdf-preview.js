import { findSearchMatches, highlightSegments, decorateMatch, joinTextRuns, rangesInSegments } from "./search-matches.js?v=phrase-map-2";
import { clearPreviewNavigation, createPreviewNavigation, focusPageMatch } from "./preview-navigation.js?v=phrase-map-2";
import { readPdfTextContent } from "./pdf-text-content.js?v=phrase-map-2";
import { restorePageAnchor, trackPreviewViewport, stopPreviewViewport } from "./preview-viewport.js?v=phrase-map-2";

import { previewSourceKey } from "./preview-cache.js?v=phrase-map-2";
import { createRenderScheduler } from "./preview-scheduler.js?v=phrase-map-2";

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
  stopPreviewViewport(activeSession);
  activeSession.scheduler.clear();
  for (const task of activeSession.tasks) task.cancel();
  for (const layer of activeSession.layers.values()) layer.cancel();
  for (const reader of activeSession.textReaders) reader.cancel().catch(() => {});
  activeSession.loadingTask?.destroy().catch(() => {});
  clearPreviewNavigation();
  activeSession = undefined;
}

export function updatePdfPreview(item, query) {
  const session = activeSession;
  if (!session?.goToPage || session.key !== previewSourceKey(item)) return false;
  session.query = query;
  session.navigation = createPreviewNavigation(item, query);
  session.navigation.bind(session.goToPage);
  for (const page of session.rendered.keys()) {
    if (session.contents.has(page)) applyHighlights(session, page);
    else if (session.visible.has(page)) queuePage(session, page, 0);
  }
  session.goToPage(item.page || 1, 0);
  return true;
}

export async function renderLocalPdf(viewer, documentItem, getBytes, query = "") {
  clearPdfPreview();
  const scrollRoot = document.querySelector("#document-detail");
  const status = document.querySelector("#preview-page-status");
  const navigation = createPreviewNavigation(documentItem, query);
  const session = { viewer, scrollRoot, status, navigation, query, key: previewSourceKey(documentItem), startedAt: performance.now(),
    scheduler: createRenderScheduler(2), contents: new Map(), rendered: new Map(), tasks: new Set(), visible: new Set(), layers: new Map(), textReaders: new Set() };
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
    session.module = module;
    const firstPage = await pdf.getPage(1);
    if (activeSession !== session) return;
    const firstViewport = firstPage.getViewport({ scale: 1 });
    firstPage.cleanup();
    viewer.innerHTML = Array.from({ length: pdf.numPages }, (_, index) =>
      `<div class="source-page" data-page-number="${index + 1}" style="aspect-ratio:${firstViewport.width}/${firstViewport.height}"><canvas role="img" aria-label="PDF 원문 ${index + 1}쪽"></canvas></div>`).join("");
    session.pages = [...viewer.querySelectorAll(".source-page")];
    status.hidden = false;
    trackPreviewViewport(session, pdf.numPages);
    session.goToPage = (number, matchIndex = 0) => {
      const node = session.pages[number - 1];
      if (!node || activeSession !== session) return;
      session.pending = session.query ? { page: number, matchIndex } : null;
      node.scrollIntoView({ block: "start" });
      queuePage(session, node, 0);
      session.updateViewport();
    };
    navigation.bind(session.goToPage);
    session.goToPage(Math.max(1, Math.min(documentItem.page || 1, pdf.numPages)));
    session.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          session.visible.add(entry.target);
          queuePage(session, entry.target);
        } else {
          session.visible.delete(entry.target);
          trimPages(session);
        }
      }
      session.onScroll();
    }, { root: scrollRoot, rootMargin: "300px 0px" });
    session.pages.forEach((page) => session.observer.observe(page));
    session.resizeObserver = new ResizeObserver(() => {
      if (scrollRoot.clientWidth !== session.viewportWidth) {
        session.viewportWidth = scrollRoot.clientWidth;
        restorePageAnchor(scrollRoot, session.pages, session.anchor);
        session.updateViewport();
      }
      for (const page of session.visible) queuePage(session, page);
    });
    session.resizeObserver.observe(scrollRoot);
  } catch {
    if (activeSession === session) {
      viewer.innerHTML = '<p class="preview-error">PDF 원문을 표시하지 못했습니다. 파일 작업 메뉴에서 원문을 열어 확인하세요.</p>';
      status.hidden = true;
      clearPreviewNavigation();
    }
  }
}

function releasePage(session, pageNode) {
  if (pageNode.dataset.rendering === "true" || !pageNode.dataset.renderedWidth) return;
  const canvas = pageNode.querySelector("canvas");
  if (canvas) {
    canvas.width = 0;
    canvas.height = 0;
  }
  session.layers.get(pageNode)?.cancel();
  session.layers.delete(pageNode);
  pageNode.querySelector(".textLayer")?.remove();
  session.contents.delete(pageNode);
  session.rendered.delete(pageNode);
  delete pageNode.dataset.renderedWidth;
}

function trimPages(session) {
  let pixels = [...session.rendered.keys()].reduce((sum, node) => {
    const canvas = node.querySelector("canvas");
    return sum + canvas.width * canvas.height * 4;
  }, 0);
  for (const node of session.rendered.keys()) {
    if (session.rendered.size <= 6 && pixels <= 32 * 1024 * 1024) break;
    if (session.visible.has(node) || session.pending?.page === Number(node.dataset.pageNumber)) continue;
    const canvas = node.querySelector("canvas");
    pixels -= canvas.width * canvas.height * 4;
    releasePage(session, node);
  }
}

function focusPending(session, node) {
  const page = Number(node.dataset.pageNumber);
  if (session.pending?.page !== page) return;
  const { matchIndex } = session.pending;
  if (focusPageMatch(session.scrollRoot, node, matchIndex)) session.navigation.setMatch(page, matchIndex);
  else session.navigation.note(page, "이 쪽은 원문 강조를 표시하지 못했습니다.");
  session.pending = null;
}

function queuePage(session, node, priority = 10) {
  return session.scheduler.schedule(node, () => renderPage(session, node, priority), priority).then(() => {
    if (activeSession === session && session.visible.has(node) && node.dataset.renderedWidth
      && node.dataset.renderedWidth !== String(node.clientWidth)) queuePage(session, node);
  }).catch(() => {});
}

async function renderPage(session, pageNode, priority = 10) {
  if (activeSession !== session || pageNode.dataset.rendering === "true") return;
  const width = pageNode.clientWidth;
  if (!width || (priority && !session.visible.has(pageNode))) return;
  if (pageNode.dataset.renderedWidth === String(width)) {
    session.rendered.delete(pageNode);
    session.rendered.set(pageNode, true);
    if (session.query && !session.contents.has(pageNode)) {
      const page = await session.pdf.getPage(Number(pageNode.dataset.pageNumber));
      if (activeSession !== session) return;
      await renderTextLayer(session, pageNode, page, page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width }));
    }
    focusPending(session, pageNode);
    return;
  }
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
    if (activeSession === session) {
      if (session.query) {
        try {
          await renderTextLayer(session, pageNode, page, page.getViewport({ scale: width / base.width }));
        } catch (error) {
          console.warn("DocFinder PDF highlight failed", error);
          session.navigation.note(Number(pageNode.dataset.pageNumber), "이 쪽은 원문 강조를 표시하지 못했습니다.");
        }
      }
      pageNode.dataset.renderedWidth = String(width);
      session.rendered.delete(pageNode);
      session.rendered.set(pageNode, true);
      session.viewer.dataset.firstPageMs ||= (performance.now() - session.startedAt).toFixed(1);
      focusPending(session, pageNode);
      trimPages(session);
    }
    page.cleanup();
  } catch {
    if (activeSession === session) { delete pageNode.dataset.renderedWidth; pageNode.textContent = `PDF ${pageNode.dataset.pageNumber}쪽을 렌더링하지 못했습니다.`; }
  } finally {
    pageNode.dataset.rendering = "false";
  }
}

async function renderTextLayer(session, pageNode, page, viewport) {
  const content = await readPdfTextContent(page, session.textReaders);
  if (activeSession !== session) return;
  session.layers.get(pageNode)?.cancel();
  pageNode.querySelector(".textLayer")?.remove();
  const container = document.createElement("div");
  container.className = "textLayer";
  container.style.setProperty("--total-scale-factor", viewport.scale);
  pageNode.append(container);
  const layer = new session.module.TextLayer({ textContentSource: content, container, viewport });
  session.layers.set(pageNode, layer);
  await layer.render();
  if (activeSession !== session) return;
  const items = content.items.filter((item) => "str" in item);
  const joined = joinTextRuns(items.map((item, index) => ({ text: item.str,
    separator: item.hasEOL ? "\n" : " ", node: layer.textDivs[index] })));
  session.contents.set(pageNode, joined);
  applyHighlights(session, pageNode);
}

function applyHighlights(session, pageNode) {
  const joined = session.contents.get(pageNode);
  if (!joined) return;
  const ranges = findSearchMatches(joined.text, session.query);
  for (const run of rangesInSegments(joined.segments, ranges)) {
    if (!run.node) continue;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const range of highlightSegments(run.ranges)) {
      const { start, end } = range;
      if (end <= cursor) continue;
      fragment.append(document.createTextNode(run.text.slice(cursor, Math.max(cursor, start))));
      const mark = document.createElement("mark");
      mark.className = "source-highlight";
      mark.textContent = run.text.slice(Math.max(cursor, start), end);
      decorateMatch(mark, range);
      fragment.append(mark);
      cursor = end;
    }
    fragment.append(document.createTextNode(run.text.slice(cursor)));
    run.node.replaceChildren(fragment);
  }
  session.navigation.setMatches(Number(pageNode.dataset.pageNumber), ranges);
  pageNode.dataset.highlightCount = String(ranges.length);
}
