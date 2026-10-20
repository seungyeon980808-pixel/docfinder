import { applyPreviewPageFilter } from "./preview-page-filter.js";
import { initialPreviewPosition } from "./preview-position.js?v=navigation-focus-1";
import { findSearchMatches, highlightSegments, decorateMatch, joinTextRuns, rangesInSegments } from "./search-matches.js?v=phrase-map-2";
import { clearPreviewNavigation, createPreviewNavigation, focusPageMatch } from "./preview-navigation.js?v=navigation-focus-1";
import { readPdfTextContent } from "./pdf-text-content.js?v=phrase-map-2";
import { restorePageAnchor, trackPreviewViewport, stopPreviewViewport } from "./preview-viewport.js?v=navigation-focus-1";

import { previewSourceKey } from "./preview-cache.js?v=responsiveness-1";
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
  activeSession.abort.abort();
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
  const position = initialPreviewPosition(item, query);
  session.item = item;
  session.restoreAnchor = position.anchor;
  session.query = query;
  applyPreviewPageFilter(session);
  session.navigation = createPreviewNavigation(item, query);
  session.navigation.bind((page, index) => { session.restoreAnchor = null; session.goToPage(page, index); });
  for (const page of session.rendered.keys()) {
    if (session.contents.has(page)) applyHighlights(session, page);
    else if (session.visible.has(page)) queuePage(session, page, 0);
  }
  session.goToPage(position.anchor?.page || position.page, position.matchIndex);
  if (position.anchor) {
    session.pending = null; session.restoreAnchor = null;
    restorePageAnchor(session.scrollRoot, session.pages, position.anchor); session.updateViewport();
  }
  return true;
}

export async function renderLocalPdf(viewer, documentItem, getBytes, query = "") {
  clearPdfPreview();
  const scrollRoot = document.querySelector("#document-detail");
  const status = document.querySelector("#preview-page-status");
  const navigation = createPreviewNavigation(documentItem, query);
  const position = initialPreviewPosition(documentItem, query);
  const session = { viewer, scrollRoot, status, navigation, query, item: documentItem, restoreAnchor: position.anchor, key: previewSourceKey(documentItem), startedAt: performance.now(),
    abort: new AbortController(), scheduler: createRenderScheduler(2), contents: new Map(), rendered: new Map(), tasks: new Set(), visible: new Set(), layers: new Map(), textReaders: new Set() };
  activeSession = session;
  try {
    const [module, bytes] = await Promise.all([pdfjs(), getBytes(documentItem, { signal: session.abort.signal })]);
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
    applyPreviewPageFilter(session);
    status.hidden = false;
    trackPreviewViewport(session, pdf.numPages);
    session.goToPage = (number, matchIndex = 0) => {
      const node = session.pages[number - 1];
      if (!node || node.hidden || activeSession !== session) return;
      session.pending = session.query ? { page: number, matchIndex } : null;
      node.scrollIntoView({ block: "start" });
      queuePage(session, node, 0);
      if (!session.query && session.restoreAnchor) {
        restorePageAnchor(scrollRoot, session.pages, session.restoreAnchor);
        session.restoreAnchor = null;
      }
      session.updateViewport();
    };
    navigation.bind((page, index) => { session.restoreAnchor = null; session.goToPage(page, index); });
    session.goToPage(Math.max(1, Math.min(position.anchor?.page || position.page, pdf.numPages)), position.matchIndex);
    if (position.anchor) {
      session.pending = null; session.restoreAnchor = null;
      restorePageAnchor(scrollRoot, session.pages, position.anchor); session.updateViewport();
    }
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
  } catch (error) {
    if (activeSession === session) {
      console.warn('DocFinder PDF preview failed', error);
      viewer.innerHTML = '<p class="preview-error" role="status">PDF 원문을 표시하지 못했습니다. 연결을 확인한 뒤 <button type="button" class="secondary-button" data-preview-retry>원문 다시 시도</button></p>';
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
  session.navigation.setMatch(page, matchIndex);
  if (!focusPageMatch(session.scrollRoot, node, matchIndex)) session.navigation.note(page, "이 쪽은 원문 강조를 표시하지 못했습니다.");
  session.pending = null;
  if (session.restoreAnchor) {
    restorePageAnchor(session.scrollRoot, session.pages, session.restoreAnchor);
    session.restoreAnchor = null;
  }
  session.updateViewport();
}

function queuePage(session, node, priority = 10) {
  return session.scheduler.schedule(node, () => renderPage(session, node, priority), priority).then(() => {
    if (activeSession === session && session.visible.has(node) && node.dataset.renderedWidth
      && node.dataset.renderedWidth !== String(node.clientWidth)) queuePage(session, node);
  }).catch(() => {});
}

async function renderPage(session, pageNode, priority = 10) {
  if (activeSession !== session || pageNode.hidden || pageNode.dataset.rendering === "true") return;
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
    pageNode.style.aspectRatio = `${base.width}/${base.height}`;
    const paint = async (pixelWidth) => {
      const viewport = page.getViewport({ scale: pixelWidth / base.width });
      // Render away from the displayed canvas so upgrading never blanks the page.
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
      canvas.style.aspectRatio = `${base.width}/${base.height}`;
      canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `PDF 원문 ${pageNode.dataset.pageNumber}쪽`);
      const task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
      session.tasks.add(task);
      try { await task.promise; } finally { session.tasks.delete(task); }
      if (activeSession !== session) return false;
      pageNode.querySelector('canvas').replaceWith(canvas);
      return true;
    };
    if (!pageNode.dataset.renderedWidth && width * ratio > 640) {
      if (!await paint(Math.min(width, 640))) return;
      pageNode.dataset.quality = 'preview';
      const preparation = document.createElement('span'); preparation.className = 'page-preparation'; preparation.setAttribute('role', 'status');
      preparation.textContent = '미리보기 · 원본 품질 준비 중'; pageNode.append(preparation);
      session.viewer.dataset.firstPageMs ||= (performance.now() - session.startedAt).toFixed(1);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (activeSession !== session) return;
    }
    if (!await paint(width * ratio)) return;
    if (activeSession === session) {
      pageNode.dataset.quality = 'original'; pageNode.querySelector('.page-preparation')?.remove();
      session.viewer.dataset.originalQualityMs ||= (performance.now() - session.startedAt).toFixed(1);
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
  } catch (error) {
    if (activeSession === session) {
      console.warn('DocFinder PDF page failed', error);
      delete pageNode.dataset.renderedWidth;
      const retry = `<p class="page-preparation" role="status">${pageNode.dataset.pageNumber}쪽 원본 품질을 준비하지 못했습니다. <button type="button" data-preview-retry>다시 시도</button></p>`;
      pageNode.querySelector('.page-preparation')?.remove();
      if (pageNode.querySelector('canvas')?.width > 0) pageNode.insertAdjacentHTML('beforeend', retry);
      else pageNode.innerHTML = retry;
    }
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
