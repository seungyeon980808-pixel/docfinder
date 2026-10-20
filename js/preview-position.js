import { previewSourceKey } from "./preview-cache.js?v=responsiveness-1";

const positions = new Map();
const limit = 50;
let activeQuery;
const normalizeQuery = (query) => String(query || "").normalize("NFC").trim();
const keyFor = (item) => JSON.stringify([item.libraryId || "", previewSourceKey(item), item.matchScope || "document"]);

export function clearPreviewPositions() { positions.clear(); activeQuery = undefined; }

// Only an automatic replacement of the same document may carry its reading position.
// Ordinary file/query changes keep the existing reset behavior.
export function carryPreviewPosition(previous, next, query) {
  if (!previous || previous.id !== next.id || (previous.libraryId || '') !== (next.libraryId || '')
    || activeQuery !== normalizeQuery(query) || keyFor(previous) === keyFor(next)) return;
  const saved = positions.get(keyFor(previous));
  if (saved) rememberPreviewPosition(next, query, saved);
}

export function initialPreviewPosition(item, query) {
  const normalized = normalizeQuery(query);
  if (activeQuery !== normalized) { positions.clear(); activeQuery = normalized; }
  const key = keyFor(item);
  const saved = positions.get(key);
  const pageFilter = item.matchScope === 'page' && item.termCount > 1 && normalized;
  const allowed = new Set((item.matchedPages || []).map(entry => entry.page));
  if (saved && (!pageFilter || allowed.has(saved.page))) {
    positions.delete(key); positions.set(key, saved);
    const restored = structuredClone(saved);
    if (pageFilter && restored.anchor && !allowed.has(restored.anchor.page)) restored.anchor = null;
    return restored;
  }
  const first = normalized ? [...(item.matchedPages || [])].filter((entry) => entry.page > 0)
    .sort((a, b) => a.page - b.page)[0] : null;
  return { page: first?.page || (normalized ? item.page : 1) || 1, matchIndex: first?.ranges?.[0]?.matchIndex || 0, termIndex: -1, anchor: null };
}

export function rememberPreviewPosition(item, query, position) {
  if (!item || activeQuery !== normalizeQuery(query) || !Number.isSafeInteger(position.page) || position.page < 1) return;
  const key = keyFor(item);
  const previous = positions.get(key) || {};
  const value = { ...previous, ...position };
  positions.delete(key); positions.set(key, structuredClone(value));
  while (positions.size > limit) positions.delete(positions.keys().next().value);
}
