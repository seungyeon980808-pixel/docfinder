import { rememberPreviewPosition } from "./preview-position.js?v=navigation-focus-1";

export function pageAtPosition(pages, top) {
  let low = 0;
  let high = pages.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (pages[middle].getBoundingClientRect().bottom <= top) low = middle + 1;
    else high = middle;
  }
  return pages[low];
}

export function capturePageAnchor(scrollRoot, pages) {
  pages = pages.filter(page => !page.hidden);
  const top = scrollRoot.getBoundingClientRect().top;
  const page = pageAtPosition(pages, top);
  if (!page) return null;
  const rectangle = page.getBoundingClientRect();
  if (!rectangle.height) return null;
  return { page: Number(page.dataset.pageNumber), fraction: (top - rectangle.top) / rectangle.height };
}

export function trackPreviewViewport(session, total) {
  const { scrollRoot, pages } = session;
  session.viewportWidth = scrollRoot.clientWidth;
  session.updateViewport = () => {
    if (scrollRoot.clientWidth === session.viewportWidth) session.anchor = capturePageAnchor(scrollRoot, pages);
    const threshold = scrollRoot.getBoundingClientRect().top + scrollRoot.clientHeight * .35;
    const page = Number(pageAtPosition(pages.filter(page => !page.hidden), threshold)?.dataset.pageNumber || total);
    session.status.textContent = `${page} / ${total}쪽`;
    session.navigation.setPage(page, total);
    rememberPreviewPosition(session.item, session.query, {
      ...(session.navigation.selection?.() || { page, matchIndex: 0, termIndex: -1 }), anchor: session.anchor
    });
  };
  session.onScroll = () => {
    if (session.scrollFrame) return;
    session.scrollFrame = requestAnimationFrame(() => { session.scrollFrame = 0; session.updateViewport(); });
  };
  scrollRoot.addEventListener("scroll", session.onScroll, { passive: true });
}

export function stopPreviewViewport(session) {
  if (session.pages?.length) session.updateViewport();
  session.scrollRoot.removeEventListener("scroll", session.onScroll);
  if (session.scrollFrame) cancelAnimationFrame(session.scrollFrame);
}

export function restorePageAnchor(scrollRoot, pages, anchor) {
  const page = anchor && pages[Math.min(pages.length, Math.max(1, anchor.page)) - 1];
  if (!page || page.hidden) return false;
  const rectangle = page.getBoundingClientRect();
  const top = scrollRoot.scrollTop + rectangle.top - scrollRoot.getBoundingClientRect().top + rectangle.height * anchor.fraction;
  scrollRoot.scrollTo({ top: Math.max(0, top), behavior: "instant" });
  return true;
}
