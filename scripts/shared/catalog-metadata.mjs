// Count pages in PostgreSQL; do not transfer all extracted text just to show a list.
const blankCharacters = `[[:space:]${String.fromCodePoint(0x200b, 0x200c, 0x200d, 0xfeff, 0x00ad)}]`;
export const pageCountsSql = `
  (SELECT count(*) FROM jsonb_array_elements(d.pages) p WHERE regexp_replace(coalesce(p->>'text',''), '${blankCharacters}', '', 'g') <> '') AS searchable_pages,
  (SELECT count(*) FROM jsonb_array_elements(d.pages) p WHERE p->>'page' IS NOT NULL AND regexp_replace(coalesce(p->>'text',''), '${blankCharacters}', '', 'g') = '') AS empty_pages`;

export function metadataStats(documents, rows) {
  const documentCounts = Object.fromEntries(rows.map(row => [row.id, { searchablePages: Number(row.searchable_pages), emptyPages: Number(row.empty_pages) }]));
  const searchableDocuments = rows.filter(row => Number(row.searchable_pages) > 0).length;
  const failures = documents.filter(item => item.indexStatus === 'error').length;
  return { documents: documents.length, searchableDocuments, failures, textlessDocuments: documents.length - searchableDocuments - failures,
    searchablePages: rows.reduce((n, row) => n + Number(row.searchable_pages), 0), emptyPages: rows.reduce((n, row) => n + Number(row.empty_pages), 0), documentCounts };
}

export function sharedDocuments(rows, id) {
  return rows.map(row => ({ ...row.metadata, id: row.id, libraryId: id, source: 'shared', folder: row.metadata.sourceFolderId ? '연결 폴더' : '문서함', path: row.metadata.relativePath || row.metadata.name,
    sha256: row.version, version: row.version, indexStatus: row.status, excerpt: '', heading: '원문',
    sourceUrl: `/api/libraries/${encodeURIComponent(id)}/documents/${encodeURIComponent(row.id)}/original?version=${encodeURIComponent(row.version)}` }));
}
