import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPreviewPageFilter } from '../js/preview-page-filter.js';
import { capturePageAnchor } from '../js/preview-viewport.js';
import { handleWorkspaceKey } from '../js/workspace-activity.js';

test('preview filters only visible containers and anchors use original numbering', () => {
  const pages = [1, 2, 3, 4].map(page => ({ dataset: { pageNumber: String(page) },
    getBoundingClientRect: () => ({ top: page === 2 ? -100 : 400, bottom: page === 2 ? 400 : 900, height: 500 }) }));
  const session = { query: 'alpha, beta', item: { matchScope: 'page', termCount: 2, matchedPages: [{ page: 2 }, { page: 4 }] }, pages, visible: new Set(pages) };
  applyPreviewPageFilter(session);
  assert.deepEqual(pages.filter(p => !p.hidden).map(p => Number(p.dataset.pageNumber)), [2, 4]);
  assert.equal(session.visible.size, 2);
  assert.deepEqual(capturePageAnchor({ getBoundingClientRect: () => ({ top: 0 }) }, pages), { page: 2, fraction: .2 });
  session.item.matchScope = 'document'; applyPreviewPageFilter(session);
  assert.ok(pages.every(p => !p.hidden));
  session.item.matchScope = 'page'; session.item.termCount = 1; applyPreviewPageFilter(session);
  assert.ok(pages.every(p => !p.hidden), 'single keyword retains full continuous original');
});

test('arrows enter original, move occurrences, return to selected row, and never consume typing or editor keys', t => {
  const old = globalThis.document, oldWindow = globalThis.window; t.after(() => { globalThis.document = old; globalThis.window = oldWindow; });
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  let moves = 0, focus = '', prevented = 0;
  const row = { focus() { focus = 'row'; } }, preview = { focus() { focus = 'preview'; } };
  const next = { disabled: false, click() { moves++; } };
  globalThis.document = { querySelector: selector => selector.includes('data-document-id') ? row
    : selector === '#document-detail' ? preview : selector.includes('data-match-direction') ? next : null };
  const key = (key, pane, editing = false) => ({ key, preventDefault() { prevented++; }, target: { closest: selector => {
    if (selector.includes('input')) return editing;
    return selector === '#detail-panel' ? pane === 'preview' : selector === '[data-document-id]' ? row : null;
  } } });
  handleWorkspaceKey(key('ArrowRight', 'documents')); assert.equal(focus, 'preview');
  handleWorkspaceKey(key('ArrowDown', 'preview')); assert.equal(moves, 1);
  next.disabled = true; handleWorkspaceKey(key('ArrowDown', 'preview')); assert.equal(moves, 1);
  handleWorkspaceKey(key('ArrowLeft', 'preview')); assert.equal(focus, 'row');
  const before = prevented; handleWorkspaceKey(key('ArrowDown', 'preview', true)); assert.equal(prevented, before);
  handleWorkspaceKey({ ...key('ArrowDown', 'preview'), isComposing: true }); assert.equal(prevented, before);
});
