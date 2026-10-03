import assert from "node:assert/strict";
import test from "node:test";
import { capturePageAnchor, restorePageAnchor } from "../js/preview-viewport.js";

test("resizing a preview retains the same page and reading position", () => {
  const root = { scrollTop: 900, getBoundingClientRect: () => ({ top: 100 }),
    scrollTo({ top }) { this.scrollTop = top; } };
  const rectangles = [{ top: -800, bottom: 0, height: 800 }, { top: 0, bottom: 800, height: 800 }];
  const pages = rectangles.map((_, index) => ({ dataset: { pageNumber: String(index + 1) },
    getBoundingClientRect: () => rectangles[index] }));
  const anchor = capturePageAnchor(root, pages);
  assert.deepEqual(anchor, { page: 2, fraction: 0.125 });
  rectangles[1] = { top: 850, bottom: 2450, height: 1600 };
  assert.equal(restorePageAnchor(root, pages, anchor), true);
  assert.equal(root.scrollTop, 1850);
  assert.equal(restorePageAnchor(root, pages, null), false);
});
