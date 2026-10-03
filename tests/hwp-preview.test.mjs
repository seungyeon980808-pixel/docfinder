import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createRenderScheduler } from "../js/preview-scheduler.js";
import { previewSourceKey } from "../js/preview-cache.js";

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function harness({ initialize, renderPage } = {}) {
  const instances = [];
  const urls = new Map();
  const root = { clientWidth: 600, clientHeight: 600, addEventListener() {}, removeEventListener() {}, scrollTo() {} };
  const status = {};
  const context = vm.createContext({
    document: { querySelector: (selector) => selector === "#document-detail" ? root : status },
    IntersectionObserver: class { constructor(callback) { this.callback = callback; } observe(target) { this.callback([{ isIntersecting: true, target }]); } disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    createRenderScheduler, previewSourceKey, performance, console,
    trackPreviewViewport(session) { session.viewportWidth = 600; session.updateViewport = () => {}; session.onScroll = () => {}; },
    stopPreviewViewport() {}, capturePageAnchor() {}, restorePageAnchor() {},
    createPreviewNavigation: () => ({ bind() {}, setPage() {}, setMatch() {}, setMatches() {}, note() {} }),
    clearPreviewNavigation() {}, focusPageMatch: () => false,
    hwpPageHighlights: () => null,
    Blob,
    URL: { createObjectURL(blob) { const url = `blob:${urls.size}`; urls.set(url, blob); return url; }, revokeObjectURL(url) { urls.delete(url); } },
    createHwpRenderer: async () => {
      const instance = { id: instances.length, pageCount: 1, renders: 0, async page() {
        this.renders += 1;
        if (renderPage) await renderPage(this);
        return { svg: `<svg viewBox="0 0 210 297"><text>document-${this.id}</text></svg>`, layout: { runs: [] } };
      } };
      instances.push(instance);
      if (initialize) await initialize(instance);
      return instance;
    }
  });
  const source = await readFile(new URL("../js/hwp-preview.js", import.meta.url), "utf8");
  vm.runInContext(source.replace(/^import .*;$/gmu, "").replaceAll("export async function", "async function").replaceAll("export function", "function"), context);
  return {
    instances, urls, context,
    start(item = { id: "a", name: "fixture.hwp" }, getBytes = async () => new ArrayBuffer(1)) {
      const image = { complete: true, getAttribute: () => image.src, removeAttribute() { delete image.src; } };
      const page = { dataset: { pageNumber: "1" }, style: {}, scrollIntoView() {}, querySelector: (selector) => selector === "img" ? image : null };
      const viewer = { dataset: {}, innerHTML: "", querySelectorAll: () => [page] };
      return { viewer, image, done: context.renderHwpPreview(viewer, item, getBytes) };
    },
    clear: () => context.clearHwpPreview()
  };
}

test("HWP query changes reuse the renderer and rendered page", async () => {
  const h = await harness();
  const first = h.start();
  await first.done; await tick();
  assert.equal(h.instances[0].renders, 1);
  assert.equal(h.context.updateHwpPreview({ id: "a", name: "fixture.hwp" }, "학생자치, 징계"), true);
  await tick();
  assert.equal(h.instances.length, 1);
  assert.equal(h.instances[0].renders, 1);
  assert.equal(h.context.updateHwpPreview({ id: "a", sourceUrl: "new-version" }, "학생자치"), false);
  h.clear();
  assert.equal(h.urls.size, 0, "clearing releases all visible SVG URLs");
});

test("failed byte retrieval can be retried without an orphan renderer", async () => {
  const h = await harness();
  await h.start(undefined, async () => { throw new Error("fetch failed"); }).done;
  assert.equal(h.instances.length, 0);
  const retry = h.start(); await retry.done; await tick();
  assert.match(await h.urls.get(retry.image.src).text(), /document-0/u);
  h.clear();
});

test("selection changed during initialization cannot publish the old document", async () => {
  const started = deferred(); const init = deferred();
  const h = await harness({ initialize: async (instance) => { if (!instance.id) { started.resolve(); await init.promise; } } });
  const old = h.start(); await started.promise;
  const latest = h.start({ id: "b", name: "second.hwp" });
  init.resolve(); await Promise.all([old.done, latest.done]); await tick();
  assert.equal(old.image.src, undefined);
  assert.match(await h.urls.get(latest.image.src).text(), /document-1/u);
  h.clear();
});

test("selection changed during page rendering never publishes stale SVG", async () => {
  const started = deferred(); const page = deferred();
  const h = await harness({ renderPage: async (instance) => { if (!instance.id) { started.resolve(); await page.promise; } } });
  const old = h.start(); await started.promise;
  const latest = h.start({ id: "b" });
  page.resolve(); await Promise.all([old.done, latest.done]); await tick();
  assert.equal(old.image.src, undefined);
  assert.match(await h.urls.get(latest.image.src).text(), /document-1/u);
  h.clear();
});

test("clearing during initialization prevents publication", async () => {
  const started = deferred(); const init = deferred();
  const h = await harness({ initialize: async () => { started.resolve(); await init.promise; } });
  const old = h.start(); await started.promise;
  h.clear(); init.resolve(); await old.done; await tick();
  assert.equal(old.image.src, undefined);
  assert.equal(h.urls.size, 0);
});
