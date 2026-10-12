import { applyPreviewPageFilter } from "./preview-page-filter.js";
import { initialPreviewPosition } from "./preview-position.js?v=navigation-focus-1";
import { hwpPageHighlights } from "./hwp-highlights.js?v=phrase-map-2";
import { decorateMatch } from "./search-matches.js?v=phrase-map-2";
import { clearPreviewNavigation, createPreviewNavigation, focusPageMatch } from "./preview-navigation.js?v=navigation-focus-1";
import { capturePageAnchor, restorePageAnchor, trackPreviewViewport, stopPreviewViewport } from "./preview-viewport.js?v=navigation-focus-1";
import { previewSourceKey } from "./preview-cache.js?v=responsiveness-1";
import { createRenderScheduler } from "./preview-scheduler.js?v=phrase-map-2";
import { createHwpRenderer, destroyHwpRenderer } from "./hwp-renderer.js?v=phrase-map-2";

let activeSession;

export function clearHwpPreview(release = false) {
  if (release) destroyHwpRenderer();
  const session = activeSession;
  if (!session) return;
  session.abort.abort();
  activeSession = undefined;
  session.scheduler.clear();
  session.observer?.disconnect();
  session.resizeObserver?.disconnect();
  stopPreviewViewport(session);
  for (const record of session.rendered.values()) URL.revokeObjectURL(record.url);
  clearPreviewNavigation();
}

export function updateHwpPreview(item, query) {
  const session = activeSession;
  if (!session?.goToPage || session.key !== previewSourceKey(item)) return false;
  const position = initialPreviewPosition(item, query);
  session.item = item;
  session.restoreAnchor = position.anchor;
  session.query = query;
  applyPreviewPageFilter(session);
  session.navigation = createPreviewNavigation(item, query);
  session.navigation.bind((page, index) => { session.restoreAnchor = null; session.goToPage(page, index); });
  for (const [node, record] of session.rendered) applyHighlights(session, node, record);
  session.goToPage(position.anchor?.page || position.page, position.matchIndex);
  if (position.anchor) {
    session.pending = null; session.restoreAnchor = null;
    restorePageAnchor(session.scrollRoot, session.pages, position.anchor); session.updateViewport();
  }
  return true;
}

export async function renderHwpPreview(viewer, item, getBytes, query = "") {
  if (!viewer) return;
  clearHwpPreview();
  const scrollRoot = document.querySelector("#document-detail");
  const status = document.querySelector("#preview-page-status");
  const position = initialPreviewPosition(item, query);
  const session = { viewer, scrollRoot, status, query, item, restoreAnchor: position.anchor, key: previewSourceKey(item),
    navigation: createPreviewNavigation(item, query), scheduler: createRenderScheduler(1),
    abort: new AbortController(), rendered: new Map(), visible: new Set(), startedAt: performance.now() };
  activeSession = session;
  try {
    const bytes = await getBytes(item, { signal: session.abort.signal });
    if (activeSession !== session) return;
    session.renderer = await createHwpRenderer(bytes, session.key);
    if (activeSession !== session) return;
    const pageCount = session.renderer.pageCount;
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new Error("원문 페이지가 없습니다.");
    viewer.innerHTML = Array.from({ length: pageCount }, (_, index) =>
      `<div class="source-page" data-page-number="${index + 1}"><img alt="${index + 1}쪽 한글 원문" /></div>`).join("");
    session.pages = [...viewer.querySelectorAll(".source-page")];
    applyPreviewPageFilter(session);
    status.hidden = false;
    trackPreviewViewport(session, pageCount);
    session.goToPage = (number, matchIndex = 0) => {
      const node = session.pages[number - 1];
      if (!node || node.hidden || activeSession !== session) return;
      session.pending = session.query ? { page: number, matchIndex } : null;
      node.scrollIntoView({ block: "start" });
      const record = session.rendered.get(node);
      if (record) { touchPage(session, node, record); focusPending(session, node); }
      else queuePage(session, node, 0);
      if (!session.query && session.restoreAnchor) {
        restorePageAnchor(scrollRoot, session.pages, session.restoreAnchor);
        session.restoreAnchor = null;
      }
      session.updateViewport();
    };
    session.navigation.bind((page, index) => { session.restoreAnchor = null; session.goToPage(page, index); });
    // Start the selected match first; nearby pages can follow after it.
    session.goToPage(Math.max(1, Math.min(position.anchor?.page || position.page, pageCount)), position.matchIndex);
    if (position.anchor) {
      session.pending = null; session.restoreAnchor = null;
      restorePageAnchor(scrollRoot, session.pages, position.anchor); session.updateViewport();
    }
    session.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) { session.visible.add(entry.target); queuePage(session, entry.target); }
        else session.visible.delete(entry.target);
      }
      trimPages(session);
      session.onScroll();
    }, { root: scrollRoot, rootMargin: "300px 0px" });
    session.pages.forEach((page) => session.observer.observe(page));
    session.resizeObserver = new ResizeObserver(() => {
      if (scrollRoot.clientWidth === session.viewportWidth) return;
      session.viewportWidth = scrollRoot.clientWidth;
      restorePageAnchor(scrollRoot, session.pages, session.anchor);
      session.updateViewport();
    });
    session.resizeObserver.observe(scrollRoot);
  } catch (error) {
    if (activeSession === session) {
      console.warn("DocFinder HWP preview failed", error);
      viewer.innerHTML = '<p class="preview-error" role="status">한글 원문을 표시하지 못했습니다. 연결을 확인한 뒤 <button type="button" class="secondary-button" data-preview-retry>원문 다시 시도</button></p>';
      status.hidden = true;
      clearPreviewNavigation();
    }
  }
}

function touchPage(session, node, record) {
  session.rendered.delete(node);
  session.rendered.set(node, record);
}

function trimPages(session) {
  let bytes = [...session.rendered.values()].reduce((sum, record) => sum + record.svg.length * 2, 0);
  for (const [node, record] of session.rendered) {
    if (session.rendered.size <= 6 && bytes <= 8 * 1024 * 1024) break;
    if (session.visible.has(node) || session.pending?.page === Number(node.dataset.pageNumber)) continue;
    URL.revokeObjectURL(record.url);
    bytes -= record.svg.length * 2;
    node.querySelector("img").removeAttribute("src");
    node.querySelector(".source-overlay")?.remove();
    session.rendered.delete(node);
  }
}

function focusPending(session, node) {
  const page = Number(node.dataset.pageNumber);
  if (session.pending?.page !== page) return;
  const image = node.querySelector("img");
  if (!image.complete) return;
  const { matchIndex } = session.pending;
  session.navigation.setMatch(page, matchIndex);
  if (!focusPageMatch(session.scrollRoot, node, matchIndex)) session.navigation.note(page, "이 쪽은 원문 강조 대신 검색된 본문을 표시합니다.");
  session.pending = null;
  if (session.restoreAnchor) {
    restorePageAnchor(session.scrollRoot, session.pages, session.restoreAnchor);
    session.restoreAnchor = null;
  }
  session.updateViewport();
}

function applyHighlights(session, node, record) {
  node.querySelector(".source-overlay")?.remove();
  if (!session.query) return;
  let highlights;
  try { highlights = hwpPageHighlights(record.svg, record.layout, session.query); } catch { /* Indexed excerpt remains available. */ }
  if (!highlights) return;
  const indexed = session.item.matchedPages?.find(entry => entry.page === Number(node.dataset.pageNumber));
  if (indexed?.ranges?.length && (indexed.ranges.length !== highlights.matches.length
    || indexed.ranges.some((range, index) => range.termIndex !== highlights.matches[index]?.termIndex))) {
    session.navigation.note(Number(node.dataset.pageNumber), "원문 텍스트가 색인과 다릅니다. 색인 갱신 후 원문 강조를 확인할 수 있습니다.");
    return;
  }
  const overlay = document.createElement("div");
  overlay.className = "source-overlay";
  overlay.setAttribute("aria-hidden", "true");
  for (const rectangle of highlights.rectangles) {
    const mark = document.createElement("mark");
    mark.className = "source-highlight";
    Object.assign(mark.style, { left: `${rectangle.x / highlights.width * 100}%`, top: `${rectangle.y / highlights.height * 100}%`,
      width: `${rectangle.width / highlights.width * 100}%`, height: `${rectangle.height / highlights.height * 100}%` });
    decorateMatch(mark, rectangle);
    overlay.append(mark);
  }
  node.append(overlay);
  session.navigation.setMatches(Number(node.dataset.pageNumber), highlights.matches);
}

function queuePage(session, node, priority = 10) {
  const cached = session.rendered.get(node);
  if (cached) { touchPage(session, node, cached); return; }
  session.scheduler.schedule(node, async () => {
    if (activeSession !== session || node.hidden || (priority && !session.visible.has(node))) return;
    try {
      const record = await session.renderer.page(Number(node.dataset.pageNumber));
      if (activeSession !== session || node.hidden || (priority && !session.visible.has(node))) return;
      if (!record.svg.includes("<svg")) throw new Error("원문 페이지가 없습니다.");
      const viewBox = record.svg.match(/viewBox=["']\s*0\s+0\s+([\d.]+)\s+([\d.]+)["']/u);
      if (viewBox) node.style.aspectRatio = `${viewBox[1]}/${viewBox[2]}`;
      record.url = URL.createObjectURL(new Blob([record.svg], { type: "image/svg+xml" }));
      session.rendered.set(node, record);
      const image = node.querySelector("img");
      image.onerror = () => { if (activeSession === session) node.textContent = `${node.dataset.pageNumber}쪽 이미지를 표시하지 못했습니다.`; };
      image.onload = () => {
        if (activeSession !== session) return;
        session.viewer.dataset.firstPageMs ||= (performance.now() - session.startedAt).toFixed(1);
        focusPending(session, node);
      };
      image.src = record.url;
      applyHighlights(session, node, record);
      trimPages(session);
    } catch (error) {
      if (activeSession === session) { console.warn("DocFinder HWP page failed", error); node.innerHTML = `<p class="preview-error" role="status">${node.dataset.pageNumber}쪽을 표시하지 못했습니다. <button type="button" data-preview-retry>원문 다시 시도</button></p>`; }
    }
  }, priority).catch(() => {});
}
