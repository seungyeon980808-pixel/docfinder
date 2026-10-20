export function normalizeSearchText(value) {
  return String(value ?? "").normalize("NFKC").replace(/[\u200b-\u200d\ufeff\u00ad]/gu, "").toLocaleLowerCase("ko-KR");
}

const normalize = (value) => normalizeSearchText(value).trim();

// Spaces belong to a phrase; only commas introduce another AND operand.
export function parseSearchTerms(query) {
  const seen = new Set();
  return normalize(query).split(",").map((term) => term.trim().replace(/\s+/gu, " ")).filter((term) => {
    const key = searchNeedle(term);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function searchNeedle(term) {
  return /\p{Script=Hangul}/u.test(term) ? term.replace(/\s+/gu, "") : term;
}

export function prepareSearchText(value) {
  const text = normalizeSearchText(value);
  let compact = "";
  const offsets = new Uint32Array(text.length);
  let length = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (/\s/u.test(text[index])) continue;
    compact += text[index];
    offsets[length++] = index;
  }
  return { text, compact, offsets: offsets.subarray(0, length) };
}

export function findPreparedOccurrences(prepared, query) {
  const terms = parseSearchTerms(query);
  const occurrences = [];
  for (let termIndex = 0; termIndex < terms.length; termIndex += 1) {
    const spacedKorean = /\p{Script=Hangul}/u.test(terms[termIndex]);
    const text = spacedKorean ? prepared.compact : prepared.text;
    const needle = searchNeedle(terms[termIndex]);
    let from = 0;
    while (from < text.length) {
      const start = text.indexOf(needle, from);
      if (start === -1) break;
      const end = start + needle.length;
      occurrences.push({ start: spacedKorean ? prepared.offsets[start] : start,
        end: spacedKorean ? prepared.offsets[end - 1] + 1 : end, termIndex });
      from = start + 1;
    }
  }
  occurrences.sort((left, right) => left.start - right.start);
  return { terms, occurrences };
}

export function matchPreparedProximity(prepared, query) {
  const { terms, occurrences } = findPreparedOccurrences(prepared, query);
  if (!terms.length) return { distance: 0, start: 0 };
  if (new Set(occurrences.map((item) => item.termIndex)).size !== terms.length) return null;
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

export function matchProximity(value, query) {
  return matchPreparedProximity(prepareSearchText(value), query);
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
  const terms = parseSearchTerms(query);
  const clauses = terms.map((term) => {
    const escaped = term.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll('"', '\\"');
    return `fullText contains '${term.includes(" ") ? `"${escaped}"` : escaped}'`;
  });
  return ["mimeType = 'application/pdf'", "trashed = false", ...clauses].join(" and ");
}

export function parseFolderId(value) {
  const trimmed = String(value ?? "").trim();
  const match = trimmed.match(/\/folders\/([\w-]+)/u);
  return match?.[1] ?? trimmed;
}
