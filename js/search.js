function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("ko-KR").trim();
}

export function matchProximity(value, query) {
  const text = normalize(value);
  const terms = [...new Set(normalize(query).split(/\s+/u).filter(Boolean))];
  if (!terms.length) return { distance: 0, start: 0 };
  const occurrences = [];
  for (let termIndex = 0; termIndex < terms.length; termIndex += 1) {
    let from = 0;
    while (from < text.length) {
      const start = text.indexOf(terms[termIndex], from);
      if (start === -1) break;
      occurrences.push({ start, end: start + terms[termIndex].length, termIndex });
      from = start + 1;
    }
  }
  occurrences.sort((left, right) => left.start - right.start);
  const counts = Array(terms.length).fill(0);
  const maximumEnds = [];
  let covered = 0;
  let left = 0;
  let best = null;
  for (let right = 0; right < occurrences.length; right += 1) {
    while (maximumEnds.length && occurrences[maximumEnds.at(-1)].end <= occurrences[right].end) maximumEnds.pop();
    maximumEnds.push(right);
    if (counts[occurrences[right].termIndex]++ === 0) covered += 1;
    while (covered === terms.length) {
      const end = occurrences[maximumEnds[0]].end;
      const distance = end - occurrences[left].start;
      if (!best || distance < best.distance || (distance === best.distance && occurrences[left].start < best.start)) {
        best = { distance, start: occurrences[left].start };
      }
      if (--counts[occurrences[left].termIndex] === 0) covered -= 1;
      if (maximumEnds[0] === left) maximumEnds.shift();
      left += 1;
    }
  }
  return best;
}

export function documentFormat(name, mimeType = "") {
  const normalizedName = normalize(name);
  if (normalizedName.endsWith(".hwpx") || mimeType === "application/hwp+zip" || mimeType === "application/vnd.hancom.hwpx") return "hwpx";
  if (normalizedName.endsWith(".hwp") || mimeType === "application/x-hwp" || mimeType === "application/haansofthwp" || mimeType === "application/vnd.hancom.hwp") return "hwp";
  if (normalizedName.endsWith(".pdf") || mimeType === "application/pdf") return "pdf";
  return "";
}

export function isSupportedDocument(name, mimeType = "") {
  return Boolean(documentFormat(name, mimeType));
}

export function filterDocuments(documents, criteria) {
  const query = normalize(criteria.query);
  return documents.filter((document) => {
    const matchesFolder = criteria.folder === "전체" || document.folder === criteria.folder;
    const target = criteria.mode === "content"
      ? `${document.excerpt || ""} ${document.indexedText || ""}`
      : `${document.name} ${document.path}`;
    return matchesFolder && (!query || Boolean(matchProximity(target, query)));
  });
}

export function buildDriveContentQuery(query) {
  const terms = normalize(query).split(/\s+/u).filter(Boolean);
  const clauses = terms.map((term) => `fullText contains '${term.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`);
  return ["mimeType = 'application/pdf'", "trashed = false", ...clauses].join(" and ");
}

export function parseFolderId(value) {
  const trimmed = String(value ?? "").trim();
  const match = trimmed.match(/\/folders\/([\w-]+)/u);
  return match?.[1] ?? trimmed;
}
