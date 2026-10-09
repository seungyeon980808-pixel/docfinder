import { previewSourceKey } from "./preview-cache.js?v=phrase-map-2";

const positions = new Map();
const limit = 50;
let activeQuery;
const normalizeQuery = (query) => String(query || "").normalize("NFC").trim();
const keyFor = (item) => JSON.stringify([item.libraryId || "", previewSourceKey(item)]);

export function clearPreviewPositions() { positions.clear(); activeQuery = undefined; }

export function initialPreviewPosition(item, query) {
  const normalized = normalizeQuery(query);
  if (activeQuery !== normalized) { positions.clear(); activeQuery = normalized; }
  const key = keyFor(item);
  const saved = positions.get(key);
  if (saved) {
    positions.delete(key); positions.set(key, saved);
    return structuredClone(saved);
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
