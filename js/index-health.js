const summaries = new WeakMap();
export function summarizeIndex(documents, entries) {
  if (!summaries.has(documents)) summaries.set(documents, new WeakMap());
  const cached = summaries.get(documents);
  if (cached.has(entries)) return cached.get(entries);
  const documentCounts = Object.fromEntries(documents.map((item) => [item.id, { searchablePages: 0, emptyPages: 0 }]));
  for (const entry of entries) {
    if (!Object.hasOwn(documentCounts, entry.id)) continue;
    const counts = documentCounts[entry.id];
    const hasText = String(entry.text || "").replace(/[\u200b-\u200d\ufeff\u00ad]/gu, "").trim().length > 0;
    if (hasText) counts.searchablePages += 1;
    else if (entry.page !== null) counts.emptyPages += 1;
  }
  const searchableDocuments = documents.filter((item) => documentCounts[item.id].searchablePages > 0).length;
  const failures = documents.filter((item) => item.indexStatus === "error").length;
  const result = { documents: documents.length, searchableDocuments, failures,
    searchablePages: Object.values(documentCounts).reduce((sum, item) => sum + item.searchablePages, 0),
    emptyPages: Object.values(documentCounts).reduce((sum, item) => sum + item.emptyPages, 0),
    textlessDocuments: documents.length - searchableDocuments - failures, documentCounts };
  cached.set(entries, result);
  return result;
}
