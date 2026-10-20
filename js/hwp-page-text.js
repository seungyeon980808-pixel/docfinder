import { joinTextRuns } from "./search-matches.js?v=phrase-map-2";

// Paragraph-only extraction omits text boxes in diagrams. Use the same runs
// and separators as the original-page highlighter, including table/drawing text.
export const HWP_TEXT_INDEX_VERSION = 3;

export function readHwpPageText(document, pageIndex) {
  const layout = JSON.parse(document.getPageTextLayout(pageIndex));
  if (!Array.isArray(layout.runs) || layout.runs.some(run => typeof run.text !== "string")) {
    throw new TypeError("문서 본문 형식이 올바르지 않습니다.");
  }
  return joinTextRuns(layout.runs).text;
}
