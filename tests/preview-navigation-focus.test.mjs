import assert from "node:assert/strict";
import test from "node:test";
import { initialPreviewPosition, rememberPreviewPosition, clearPreviewPositions } from "../js/preview-position.js?v=navigation-focus-1";
import { createPreviewNavigation } from "../js/preview-navigation.js";
import { installWorkspaceActivity, setWorkspaceDocument } from "../js/workspace-activity.js";

const item = { id: "first", page: 8, matchedPages: [
  { page: 8, ranges: [{ termIndex: 0, matchIndex: 0 }] },
  { page: 2, ranges: [{ termIndex: 0, matchIndex: 0 }, { termIndex: 1, matchIndex: 1 }] }
] };

test("first opening uses page order; each document restores its match, keyword and reading anchor", () => {
  clearPreviewPositions();
  assert.equal(initialPreviewPosition(item, "학생 자치, 회장").page, 2);
  rememberPreviewPosition(item, "학생 자치, 회장", { page: 2, matchIndex: 1, termIndex: 1, anchor: { page: 3, fraction: .4 } });
  initialPreviewPosition({ id: "second", page: 9 }, "학생 자치, 회장");
  const restored = initialPreviewPosition(item, "학생 자치, 회장");
  assert.deepEqual(restored, { page: 2, matchIndex: 1, termIndex: 1, anchor: { page: 3, fraction: .4 } });
  restored.anchor.page = 99;
  assert.equal(initialPreviewPosition(item, "학생 자치, 회장").anchor.page, 3);
  assert.equal(initialPreviewPosition({ ...item, modifiedTime: "new" }, "학생 자치, 회장").matchIndex, 0);
  assert.equal(initialPreviewPosition({ ...item, libraryId: "other" }, "학생 자치, 회장").matchIndex, 0);
  assert.equal(initialPreviewPosition(item, "새 검색").matchIndex, 0);
  rememberPreviewPosition(item, "학생 자치, 회장", { page: 99 });
  assert.equal(initialPreviewPosition(item, "학생 자치, 회장").page, 2, "old query cannot publish a late scroll update");
  clearPreviewPositions();
});

test("position memory is bounded and cleared on reset", () => {
  clearPreviewPositions();
  for (let i = 0; i < 51; i++) {
    const document = { id: `doc-${i}` };
    initialPreviewPosition(document, "term");
    rememberPreviewPosition(document, "term", { page: 4, matchIndex: 1, termIndex: -1 });
  }
  assert.equal(initialPreviewPosition({ id: "doc-0" }, "term").page, 1);
  assert.equal(initialPreviewPosition({ id: "doc-50" }, "term").page, 4);
  clearPreviewPositions();
  assert.equal(initialPreviewPosition({ id: "doc-50" }, "term").page, 1);
  clearPreviewPositions();
});

test("keyword navigation stays in the selected file, preserves result data and stops at either end", (context) => {
  clearPreviewPositions();
  const old = globalThis.document; context.after(() => { globalThis.document = old; clearPreviewPositions(); });
  const previous = {}, next = {}, counter = {}, current = {};
  const elements = { '.preview-match-count': counter, '.preview-current-page': current, details: {},
    '[data-match-direction="previous"]': previous, '[data-match-direction="next"]': next, '.preview-match-note': {} };
  const host = { querySelector: (selector) => elements[selector], querySelectorAll: () => [] };
  globalThis.document = { querySelector: (selector) => selector === '#preview-controls' ? host : null };
  const snapshot = JSON.stringify(item);
  const nav = createPreviewNavigation(item, "학생 자치, 회장");
  const moves = []; nav.bind((page, index) => moves.push([page, index]));
  const click = (selector, dataset) => host.onclick({ target: { closest: (value) => value === selector ? { dataset } : null } });
  assert.equal(previous.disabled, true);
  nav.setPage(6, 10);
  assert.match(counter.textContent, /1 \/ 3곳/);
  assert.match(current.textContent, /현재 6쪽/);
  click('[data-match-term]', { matchTerm: '1' });
  assert.deepEqual(moves, [[2, 1]]);
  assert.match(counter.textContent, /1 \/ 1곳/);
  assert.equal(initialPreviewPosition(item, "학생 자치, 회장").termIndex, 1);
  assert.equal(initialPreviewPosition(item, "학생 자치, 회장").matchIndex, 1);
  assert.equal(previous.disabled, true); assert.equal(next.disabled, true);
  click('[data-match-direction]', { matchDirection: 'next' });
  assert.equal(moves.length, 1, 'last occurrence never opens another document');
  click('[data-match-term]', { matchTerm: '-1' });
  click('[data-match-direction]', { matchDirection: 'next' });
  assert.deepEqual(moves.at(-1), [8, 0]);
  assert.equal(next.disabled, true);
  assert.equal(JSON.stringify(item), snapshot, 'keyword filter leaves AND results intact');
});

test("working in the original changes active pane while document identity stays selected", (context) => {
  const old = globalThis.document; context.after(() => { globalThis.document = old; });
  const listeners = {}, workspace = { dataset: {}, addEventListener: (name, callback) => { listeners[name] = callback; } };
  const header = {}, title = {}, status = {};
  globalThis.document = { querySelector: (selector) => ({ '.workspace': workspace, '#preview-document-header': header,
    '#preview-document-name': title, '#preview-activity': status })[selector] };
  installWorkspaceActivity();
  setWorkspaceDocument({ id: 'selected', name: '내 문서.pdf' });
  listeners.wheel({ target: { closest: (selector) => selector === '#detail-panel' } });
  assert.equal(workspace.dataset.activePane, 'preview'); assert.equal(status.textContent, '원문 작업 중');
  setWorkspaceDocument({ id: 'selected', name: '내 문서.pdf' });
  assert.equal(workspace.dataset.activePane, 'preview', 'background render cannot clear the working indicator');
  assert.equal(title.textContent, '내 문서.pdf');
  listeners.focusin({ target: { closest: (selector) => selector === '.document-pane' } });
  assert.equal(workspace.dataset.activePane, 'documents');
  setWorkspaceDocument(null);
  assert.equal(header.hidden, true);
});


test("same-page filtering does not restore a hidden page from a wider search", () => {
  clearPreviewPositions();
  initialPreviewPosition(item, "alpha, beta");
  rememberPreviewPosition(item, "alpha, beta", { page: 8, anchor: { page: 9, fraction: .3 } });
  const filtered = { ...item, matchScope: 'page', termCount: 2, matchedPages: [item.matchedPages[1]] };
  assert.equal(initialPreviewPosition(filtered, "alpha, beta").page, 2);
  rememberPreviewPosition(filtered, "alpha, beta", { page: 2, anchor: { page: 9, fraction: .3 } });
  assert.equal(initialPreviewPosition(filtered, "alpha, beta").anchor, null);
  assert.equal(initialPreviewPosition(item, "alpha, beta").page, 8);
  clearPreviewPositions();
});
