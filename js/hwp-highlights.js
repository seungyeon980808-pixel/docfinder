import { findSearchMatches, joinTextRuns, rangesInSegments } from "./search-matches.js?v=phrase-map-2";

let corePromise;
async function loadCore() {
  corePromise ||= import("../vendor/rhwp-core/rhwp.js").then(async (core) => {
    await core.default({ module_or_path: new URL("../vendor/rhwp-core/rhwp_bg.wasm", import.meta.url).href });
    return core;
  }).catch((error) => { corePromise = undefined; throw error; });
  return corePromise;
}

// Only publish rectangles when the layout matches the actual SVG glyph positions.
// Studio can use different fonts; an unverified rectangle would mislead readers.
export function layoutHighlightRects(runs, query, glyphs) {
  const joined = joinTextRuns(runs);
  const ranges = findSearchMatches(joined.text, query);
  const byCharacter = new Map();
  for (const glyph of glyphs) {
    const character = glyph.text.normalize("NFKC");
    if (!byCharacter.has(character)) byCharacter.set(character, []);
    byCharacter.get(character).push(glyph);
  }
  const rectangles = [];
  for (const run of rangesInSegments(joined.segments, ranges)) {
    for (const range of run.ranges) {
      const utf16 = run.charX?.length === run.text.length + 1;
      const start = utf16 ? range.start : [...run.text.slice(0, range.start)].length;
      const end = utf16 ? range.end : [...run.text.slice(0, range.end)].length;
      const x = run.x + run.charX?.[start];
      const width = run.charX?.[end] - run.charX?.[start];
      if (![x, width, run.y, run.h].every(Number.isFinite) || width <= 0 || run.h <= 0) return { rectangles: [], complete: false };
      let offset = start;
      for (const character of [...run.text.slice(range.start, range.end)]) {
        if (!/\s/u.test(character)) {
          const expectedX = run.x + run.charX[offset];
          if (!(byCharacter.get(character.normalize("NFKC")) || []).some((glyph) =>
            Math.abs(glyph.x - expectedX) <= 1.5 && glyph.y >= run.y - 2 && glyph.y <= run.y + run.h + 2)) {
            return { rectangles: [], complete: false };
          }
        }
        offset += utf16 ? character.length : 1;
      }
      rectangles.push({ x, y: run.y, width, height: run.h, termIndex: range.termIndex, matchIndex: range.matchIndex });
    }
  }
  return { rectangles, complete: ranges.length > 0 };
}

export function hwpPageHighlights(svg, layout, query) {
  const xml = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = xml.documentElement;
  const viewBox = root.getAttribute("viewBox")?.trim().split(/[\s,]+/u).map(Number);
  if (xml.querySelector("parsererror") || !viewBox || viewBox.length !== 4 || viewBox[0] || viewBox[1]
    || !viewBox.every(Number.isFinite) || viewBox[2] <= 0 || viewBox[3] <= 0) return null;
  const glyphs = [...xml.querySelectorAll("text")].filter((node) => !node.closest("[transform]"))
    .map((node) => ({ text: node.textContent, x: Number.parseFloat(node.getAttribute("x")), y: Number.parseFloat(node.getAttribute("y")) }));
  const result = layoutHighlightRects(layout.runs || [], query, glyphs);
  const matches = findSearchMatches(joinTextRuns(layout.runs || []).text, query);
  return result.complete ? { ...result, matches, width: viewBox[2], height: viewBox[3] } : null;
}

export async function createHwpHighlightSource(bytes) {
  const core = await loadCore();
  const document = new core.HwpDocument(new Uint8Array(bytes));
  return {
    dispose() { document.free(); },
    page(svg, pageNumber, query) {
      const layout = JSON.parse(document.getPageTextLayout(pageNumber - 1));
      return hwpPageHighlights(svg, layout, query);
    }
  };
}
