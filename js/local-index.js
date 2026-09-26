import { matchProximity } from "./search.js?v=verification-2";

const normalize = (value) => String(value ?? "").normalize("NFKC").toLocaleLowerCase("ko-KR");

export function searchLocalIndex(documents, entries, query) {
  const terms = normalize(query).trim().split(/\s+/u).filter(Boolean);
  if (!terms.length) return documents;
  const byId = new Map(documents.map((documentItem) => [documentItem.id, documentItem]));
  const matches = new Map();
  for (const entry of entries) {
    const proximity = matchProximity(entry.text, query);
    if (!proximity) continue;
    const documentItem = byId.get(entry.id);
    if (!documentItem) continue;
    const previous = matches.get(entry.id);
    if (previous && previous.matchDistance <= proximity.distance) continue;
    const start = Math.max(0, proximity.start - 56);
    const end = Math.min(entry.text.length, start + 170);
    matches.set(entry.id, {
      ...documentItem,
      page: entry.page,
      matchDistance: proximity.distance,
      excerpt: `${start ? "…" : ""}${entry.text.slice(start, end)}${end < entry.text.length ? "…" : ""}`,
      heading: entry.page ? `${entry.page}쪽 본문 검색 결과` : "한글 문서 본문 검색 결과"
    });
  }
  return [...matches.values()].sort((left, right) => left.matchDistance - right.matchDistance || String(right.modifiedTime).localeCompare(String(left.modifiedTime)));
}
