// Hide preview containers only. Original bytes, original numbering and editors
// always retain the complete document.
export function applyPreviewPageFilter(session) {
  const filtered = session.query.trim() && session.item.matchScope === 'page' && session.item.termCount > 1;
  const allowed = new Set((session.item.matchedPages || []).map(entry => entry.page));
  for (const node of session.pages) {
    node.hidden = Boolean(filtered && !allowed.has(Number(node.dataset.pageNumber)));
    if (node.hidden) session.visible.delete(node);
  }
}
