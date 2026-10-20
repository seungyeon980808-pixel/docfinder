import { findPreparedOccurrences, normalizeSearchText, prepareSearchText } from "./search.js?v=phrase-map-2";

export const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const graphemes = new Intl.Segmenter("ko", { granularity: "grapheme" });

// Normalized offsets must map back to original graphemes: NFD Hangul and NFKC
// ligatures can change the number of UTF-16 code units in the searched text.
export function findSearchMatches(value, query) {
  const source = String(value ?? "");
  let normalized = "";
  const starts = [];
  const ends = [];
  for (const { segment, index } of graphemes.segment(source)) {
    const text = normalizeSearchText(segment);
    normalized += text;
    for (let offset = 0; offset < text.length; offset += 1) {
      starts.push(index);
      ends.push(index + segment.length);
    }
  }
  const { occurrences } = findPreparedOccurrences(prepareSearchText(normalized), query);
  return occurrences.map(({ start, end, termIndex }, matchIndex) => ({ start: starts[start], end: ends[end - 1], termIndex, matchIndex }));
}

export function findSearchRanges(value, query) {
  return mergeRanges(findSearchMatches(value, query).map(({ start, end }) => ({ start, end })));
}

function termHue(termIndex) {
  const hues = [42, 202, 278, 145, 350, 18];
  return hues[termIndex] ?? (termIndex * 137.508) % 360;
}

export const termStroke = (index) => `hsl(${termHue(index)} 65% 32%)`;

export function termStyle(termIndex, indices = [termIndex]) {
  const colors = [...new Set(indices)].map((index) => `hsl(${termHue(index)} 85% 75% / .55)`);
  const background = colors.length > 1 ? `linear-gradient(180deg, ${colors.map((color, index) =>
    `${color} ${index / colors.length * 100}% ${(index + 1) / colors.length * 100}%`).join(", ")})` : colors[0];
  return `--match-bg:${background};--match-stroke:${termStroke(termIndex)}`;
}

export function decorateMatch(node, match) {
  node.dataset.termIndex = String(match.termIndex);
  node.dataset.matchIndex = String(match.matchIndex);
  node.dataset.termIndices = (match.termIndices || [match.termIndex]).join(" ");
  node.dataset.matchIndices = (match.matchIndices || [match.matchIndex]).join(" ");
  node.setAttribute("style", `${node.getAttribute("style") || ""};${termStyle(match.termIndex, match.termIndices)}`);
}

// Split overlapping occurrences into disjoint text runs while retaining every
// occurrence ID. This preserves the original text and makes both hits navigable.
export function highlightSegments(ranges) {
  const events = ranges.flatMap((range, id) => range.end > range.start
    ? [{ offset: range.start, id, range, start: true }, { offset: range.end, id, start: false }] : [])
    .sort((a, b) => a.offset - b.offset);
  const active = new Map();
  const result = [];
  for (let index = 0; index < events.length;) {
    const start = events[index].offset;
    while (index < events.length && events[index].offset === start) {
      const event = events[index++];
      if (event.start) active.set(event.id, event.range);
      else active.delete(event.id);
    }
    if (!active.size || index === events.length) continue;
    const matches = [...active.values()].sort((a, b) => a.matchIndex - b.matchIndex);
    result.push({ start, end: events[index].offset, termIndex: matches[0].termIndex, matchIndex: matches[0].matchIndex,
      termIndices: matches.map((match) => match.termIndex), matchIndices: matches.map((match) => match.matchIndex) });
  }
  return result;
}

export function mergeRanges(ranges) {
  const merged = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (!Number.isInteger(range.start) || range.end <= range.start) continue;
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export function highlightMarkup(value, query) {
  const source = String(value ?? "");
  let cursor = 0;
  let html = "";
  for (const { start, end, termIndex, termIndices } of highlightSegments(findSearchMatches(source, query))) {
    html += `${escapeHtml(source.slice(cursor, start))}<mark data-term-index="${termIndex}" data-term-indices="${termIndices.join(" ")}" style="${termStyle(termIndex, termIndices)}">${escapeHtml(source.slice(start, end))}</mark>`;
    cursor = end;
  }
  return html + escapeHtml(source.slice(cursor));
}

export function joinTextRuns(runs) {
  let text = "";
  const segments = runs.map((run) => {
    const start = text.length;
    text += run.text;
    const end = text.length;
    text += run.separator ?? "\n";
    return { ...run, start, end };
  });
  return { text, segments };
}

export function rangesInSegments(segments, ranges) {
  return segments.map((segment) => ({ ...segment, ranges: ranges
    .filter((range) => range.start < segment.end && range.end > segment.start)
    .map((range) => ({ ...range, start: Math.max(range.start, segment.start) - segment.start,
      end: Math.min(range.end, segment.end) - segment.start })) }));
}
