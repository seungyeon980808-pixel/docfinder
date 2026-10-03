import { findPreparedOccurrences, matchPreparedProximity, normalizeSearchText, parseSearchTerms, prepareSearchText, searchNeedle } from "./search.js?v=phrase-map-2";

const cachedIndexes = new WeakMap();
const grams = (text) => {
  const result = new Set();
  for (let index = 0; index < text.length - 1; index += 1) result.add(text.slice(index, index + 2));
  return result;
};

export function createPageSearchIndex(entries) {
  const pages = entries.map((entry) => ({ ...entry, prepared: prepareSearchText(entry.text) }));
  const postings = new Map();
  for (let page = 0; page < pages.length; page += 1) {
    for (const gram of grams(pages[page].prepared.compact)) {
      if (!postings.has(gram)) postings.set(gram, []);
      postings.get(gram).push(page);
    }
  }
  for (const [gram, pages] of postings) postings.set(gram, Uint32Array.from(pages));
  return { pages, postings };
}

function includesPage(pages, page) {
  let low = 0;
  let high = pages.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (pages[middle] === page) return true;
    if (pages[middle] < page) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

export function searchPageIndex(documents, index, query) {
  const normalizedQuery = normalizeSearchText(query).trim();
  const terms = parseSearchTerms(query);
  if (!terms.length) return documents;
  const candidates = new Set();
  for (const term of terms) {
    const sets = [...grams(searchNeedle(term).replace(/\s+/gu, ""))].map((gram) => index.postings.get(gram));
    if (sets.some((set) => !set)) return [];
    sets.sort((left, right) => left.length - right.length);
    const pages = sets.length ? [...sets[0]].filter((page) => sets.every((set) => includesPage(set, page)))
      : index.pages.map((_, page) => page);
    for (const page of pages) candidates.add(page);
  }
  const byId = new Map(documents.map((item) => [item.id, item]));
  const matches = new Map();
  const matchedPages = new Map();
  const coverage = new Map();
  const phrase = terms.join(" ");
  const compactPhrase = terms.map(searchNeedle).join("");
  const compare = (left, right) => left.matchQuality - right.matchQuality || left.matchDistance - right.matchDistance
    || String(right.modifiedTime || "").localeCompare(String(left.modifiedTime || "")) || (left.page || 0) - (right.page || 0);
  for (const candidate of candidates) {
    const entry = index.pages[candidate];
    const item = byId.get(entry.id);
    if (!item) continue;
    const { occurrences } = findPreparedOccurrences(entry.prepared, normalizedQuery);
    if (!occurrences.length) continue;
    const termIndices = [...new Set(occurrences.map((match) => match.termIndex))];
    if (!coverage.has(entry.id)) coverage.set(entry.id, new Set());
    for (const termIndex of termIndices) coverage.get(entry.id).add(termIndex);
    const samePage = termIndices.length === terms.length;
    const match = samePage ? matchPreparedProximity(entry.prepared, normalizedQuery)
      : { start: occurrences[0].start, distance: occurrences[0].end - occurrences[0].start };
    const quality = !samePage ? 3 : entry.prepared.text.includes(phrase) ? 0
      : /\p{Script=Hangul}/u.test(compactPhrase) && entry.prepared.compact.includes(compactPhrase) ? 1 : 2;
    const display = String(entry.text).normalize("NFKC").replace(/[\u200b-\u200d\ufeff\u00ad]/gu, "");
    const start = Math.max(0, match.start - 56);
    const end = Math.min(display.length, Math.max(start + 170, match.start + Math.min(match.distance, 240)));
    const result = { ...item, page: entry.page, matchQuality: quality, matchDistance: match.distance,
      matchedTermCount: terms.length, termCount: terms.length, samePage,
      excerpt: `${start ? "…" : ""}${display.slice(start, end)}${end < display.length ? "…" : ""}`,
      heading: entry.page ? `${entry.page}쪽 본문 검색 결과` : "한글 문서 본문 검색 결과" };
    if (!matchedPages.has(entry.id)) matchedPages.set(entry.id, []);
    matchedPages.get(entry.id).push({ page: entry.page, excerpt: result.excerpt, termIndices,
      ranges: occurrences.map(({ start, end, termIndex }, matchIndex) => ({ start, end, termIndex, matchIndex })) });
    if (!matches.has(entry.id) || compare(result, matches.get(entry.id)) < 0) matches.set(entry.id, result);
  }
  return [...matches.values()].filter((item) => coverage.get(item.id).size === terms.length).sort(compare).map((item) => ({ ...item,
    matchedPages: matchedPages.get(item.id).sort((left, right) => (left.page || 0) - (right.page || 0)) }));
}

export function searchLocalIndex(documents, entries, query) {
  if (!cachedIndexes.has(entries)) cachedIndexes.set(entries, createPageSearchIndex(entries));
  return searchPageIndex(documents, cachedIndexes.get(entries), query);
}
