import assert from "node:assert/strict";
import test from "node:test";
import { findSearchRanges, findSearchMatches, highlightSegments, highlightMarkup, joinTextRuns, rangesInSegments, termStyle } from "../js/search-matches.js";
import { adjacentMatchPages, createPreviewNavigation, matchingPages, focusPageMatch } from "../js/preview-navigation.js";
import { layoutHighlightRects } from "../js/hwp-highlights.js";
import { summarizeIndex } from "../js/index-health.js";

test("검색어 강조는 분해된 한글과 줄바꿈을 원문 글자 범위로 돌려준다", () => {
  const source = "학생\n자치".normalize("NFD");
  assert.deepEqual(findSearchRanges(source, "학생자치"), [{ start: 0, end: source.length }]);
  assert.match(highlightMarkup(source, "학생자치"), /data-term-index="0"/u);
  assert.match(highlightMarkup("학\u200b생 자치", "학생자치"), />학\u200b생 자치<\/mark>/u);
});

test("길이가 달라지는 호환 문자와 악성 HTML을 안전하게 강조한다", () => {
  assert.match(highlightMarkup("<img> ﬃ ＡＢＣ", "ffi, abc"), /^&lt;img&gt; .*data-term-index="0".*>ﬃ<\/mark> .*data-term-index="1".*>ＡＢＣ<\/mark>$/u);
  assert.deepEqual(findSearchRanges("the rapist", "therapist"), []);
  assert.equal(highlightMarkup("aaaa", "aaa").replace(/<[^>]+>/gu, ""), "aaaa");
});

test("PDF 텍스트 조각·줄 경계 너머의 검색어를 각 조각으로 나눈다", () => {
  const joined = joinTextRuns([{ text: "학생", separator: "\n" }, { text: "자치 활동", separator: " " }]);
  const ranges = findSearchRanges(joined.text, "학생자치");
  const runs = rangesInSegments(joined.segments, ranges);
  assert.deepEqual(runs.map((run) => run.ranges), [[{ start: 0, end: 2 }], [{ start: 0, end: 2 }]]);
});

test("일치 페이지 목록은 중복·잘못된 쪽을 제거하고 현재 쪽 전후로 이동한다", () => {
  const pages = matchingPages({ matchedPages: [{ page: 8 }, { page: null }, { page: 3 }, { page: 8 }, { page: -1 }] });
  assert.deepEqual(pages.map((page) => page.page), [3, 8]);
  assert.deepEqual(adjacentMatchPages(pages, 3), { previous: undefined, next: 8 });
  assert.deepEqual(adjacentMatchPages(pages, 5), { previous: 3, next: 8 });
  assert.deepEqual(adjacentMatchPages(pages, 8), { previous: 3, next: undefined });
});

test("다른 쪽의 강조 실패 안내는 현재 쪽의 안내를 덮어쓰지 않는다", (context) => {
  const originalDocument = globalThis.document;
  context.after(() => { globalThis.document = originalDocument; });
  const note = {};
  const elements = { ".preview-match-count": {}, ".preview-current-page": {}, details: {},
    '[data-match-direction="previous"]': {}, '[data-match-direction="next"]': {}, ".preview-match-note": note };
  const host = { querySelector: (selector) => elements[selector], querySelectorAll: () => [] };
  globalThis.document = { querySelector: (selector) => selector === "#preview-controls" ? host : null };
  const navigation = createPreviewNavigation({ page: 1, matchedPages: [{ page: 1, excerpt: "학생자치 첫 쪽" },
    { page: 2, excerpt: "학생자치 다음 쪽" }] }, "학생자치");
  navigation.note(1, "첫 쪽 안내");
  navigation.note(2, "다음 쪽 안내");
  assert.equal(note.hidden, false);
  assert.match(note.innerHTML, /첫 쪽 안내/);
  navigation.setPage(2, 3);
  assert.match(note.innerHTML, /다음 쪽 안내/);
  navigation.setPage(3, 3);
  assert.equal(note.hidden, true);
});

test("한글 강조는 실제 SVG 글자 좌표와 일치할 때만 표시한다", () => {
  const runs = [{ text: "학생 자치", x: 10, y: 20, h: 10, charX: [0, 10, 20, 25, 35, 45] }];
  const glyphs = [{ text: "학", x: 10, y: 28 }, { text: "생", x: 20, y: 28 },
    { text: "자", x: 35, y: 28 }, { text: "치", x: 45, y: 28 }];
  assert.deepEqual(layoutHighlightRects(runs, "학생자치", glyphs), { complete: true,
    rectangles: [{ x: 10, y: 20, width: 45, height: 10, termIndex: 0, matchIndex: 0 }] });
  assert.deepEqual(layoutHighlightRects(runs, "학생자치", glyphs.map((item) => ({ ...item, x: item.x + 30 }))), { complete: false, rectangles: [] });
});

test("색인 현황은 공백·보이지 않는 글자와 추출 실패를 검색 가능으로 세지 않는다", () => {
  const documents = [{ id: "a", indexStatus: "ready" }, { id: "b", indexStatus: "textless" }, { id: "c", indexStatus: "error" }];
  const summary = summarizeIndex(documents, [{ id: "a", page: 1, text: "학생자치" }, { id: "a", page: 2, text: " \n " },
    { id: "b", page: 1, text: "\u200b" }, { id: "orphan", page: 1, text: "ignored" }]);
  assert.equal(summary.searchableDocuments, 1);
  assert.equal(summary.searchablePages, 1);
  assert.equal(summary.failures, 1);
  assert.equal(summary.textlessDocuments, 1);
  assert.equal(summary.emptyPages, 2);
});

test("검색어별 색상과 개별 일치 ID를 텍스트 조각 너머로 유지한다", () => {
  const source = "학생 자치 징계 학생자치".normalize("NFD");
  const matches = findSearchMatches(source, "학생 자치, 징계");
  assert.deepEqual(matches.map((match) => [match.termIndex, match.matchIndex]), [[0, 0], [1, 1], [0, 2]]);
  assert.notEqual(termStyle(0), termStyle(1));
  assert.notEqual(termStyle(0), termStyle(6));
  const joined = joinTextRuns([{ text: "학생" }, { text: "자치" }]);
  const runs = rangesInSegments(joined.segments, findSearchMatches(joined.text, "학생 자치"));
  assert.equal(runs[0].ranges[0].matchIndex, runs[1].ranges[0].matchIndex);
});

test("위치 탐색은 같은 쪽의 다음 일치와 다음 쪽을 잇고 색인 결과를 변경하지 않는다", (context) => {
  const old = globalThis.document; context.after(() => { globalThis.document = old; });
  const elements = { ".preview-current-page": {}, ".preview-match-count": {}, details: {},
    '[data-match-direction="previous"]': {}, '[data-match-direction="next"]': {}, ".preview-match-note": {} };
  const host = { querySelector: (selector) => elements[selector], querySelectorAll: () => [] };
  globalThis.document = { querySelector: (selector) => selector === "#preview-controls" ? host : null };
  const item = { page: 1, matchedPages: [{ page: 1, ranges: [{ termIndex: 0, matchIndex: 0 }, { termIndex: 1, matchIndex: 1 }] },
    { page: 4, ranges: [{ termIndex: 0, matchIndex: 0 }] }] };
  const original = JSON.stringify(item);
  const nav = createPreviewNavigation(item, "학생자치, 징계");
  const moves = []; nav.bind((page, match) => moves.push([page, match]));
  const click = (direction) => host.onclick({ target: { closest: (selector) => selector === "[data-match-direction]" ? { dataset: { matchDirection: direction } } : null } });
  click("next"); click("next"); click("previous");
  assert.deepEqual(moves, [[1, 1], [4, 0], [1, 1]]);
  nav.setMatches(1, [{ termIndex: 0, matchIndex: 0 }]);
  assert.equal(JSON.stringify(item), original, "rendered coordinates must not mutate the search snapshot");
});

test("겹친 검색어는 원문을 중복시키지 않고 두 색상과 일치 위치를 모두 보존한다", () => {
  const source = "학생자치";
  const matches = findSearchMatches(source, "학생자치, 자치");
  const segments = highlightSegments(matches);
  assert.deepEqual(segments.map(({ start, end, termIndices, matchIndices }) => ({ start, end, termIndices, matchIndices })),
    [{ start: 0, end: 2, termIndices: [0], matchIndices: [0] }, { start: 2, end: 4, termIndices: [0, 1], matchIndices: [0, 1] }]);
  const html = highlightMarkup(source, "학생자치, 자치");
  assert.equal(html.replace(/<[^>]+>/gu, ""), source);
  assert.match(html, /linear-gradient/);
  assert.match(html, /data-term-indices="0 1"/);
  const focused = [], styles = [];
  const mark = { dataset: { matchIndices: "0 1", termIndices: "0 1" },
    classList: { add: (value) => focused.push(value) }, style: { setProperty: (...value) => styles.push(value) },
    getBoundingClientRect: () => ({ top: 300 }) };
  const scrolls = [];
  const root = { querySelectorAll: () => [], scrollTop: 100, clientHeight: 500,
    getBoundingClientRect: () => ({ top: 0 }), scrollTo: (value) => scrolls.push(value) };
  assert.equal(focusPageMatch(root, { querySelectorAll: () => [mark] }, 1), true);
  assert.deepEqual(focused, ["is-current-match"]);
  assert.deepEqual(styles, [["--match-stroke", "hsl(202 65% 32%)"]]);
  assert.deepEqual(scrolls, [{ top: 250, behavior: "instant" }]);
});
