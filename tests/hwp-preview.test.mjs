import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function previewHarness({ initialize, renderPage } = {}) {
  const instances = [];
  const hosts = new Set();
  const scrollRoot = { addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ top: 0 }), clientHeight: 600 };
  const status = {};
  let viewer;
  let nextUrl = 0;
  const urls = new Map();
  const source = await readFile(new URL("../js/hwp-preview.js", import.meta.url), "utf8");
  const context = vm.createContext({
    document: {
      createElement: () => ({ setAttribute() {}, remove() { hosts.delete(this); } }),
      body: { append(host) { hosts.add(host); } },
      querySelector: (selector) => selector === "#document-detail" ? scrollRoot : status
    },
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(target) { this.callback([{ isIntersecting: true, target }]); }
      disconnect() {}
    },
    Blob,
    URL: {
      createObjectURL(blob) { const url = `blob:fixture-${++nextUrl}`; urls.set(url, blob); return url; },
      revokeObjectURL(url) { urls.delete(url); }
    },
    mockCreateEditor: async () => {
      const instance = {
        id: instances.length, loads: 0, destroyed: false, pages: 0,
        async loadFile() {
          this.loads += 1;
          if (this.loads > 1) throw new Error("Studio has stale visible pages on reload");
          return { pageCount: 1 };
        },
        destroy() { this.destroyed = true; },
        async getPageSvg() {
          this.pages += 1;
          if (renderPage) await renderPage(this);
          assert.equal(this.destroyed, false, "rendering must finish before disposal");
          assert.equal(this.loads, 1, "pages must come from the loaded instance");
          return `<svg><text>fixture-${this.id}</text></svg>`;
        }
      };
      instances.push(instance);
      if (initialize) await initialize(instance);
      return instance;
    }
  });
  vm.runInContext(source
    .replace(/^const (EDITOR_URL|STUDIO_URL) = .*;$/gmu, 'const $1 = "fixture";')
    .replace("import(EDITOR_URL)", "Promise.resolve({ createEditor: mockCreateEditor })")
    .replaceAll("export function", "function"), context);
  return {
    instances, hosts, urls,
    get viewer() { return viewer; },
    start(getBytes = async () => new Uint8Array([1])) {
      const image = {};
      const page = { dataset: { pageNumber: "1" }, scrollIntoView() {}, getBoundingClientRect: () => ({ bottom: 800 }), querySelector: () => image };
      viewer = { image, isConnected: true, innerHTML: "", querySelectorAll: () => [page] };
      context.renderHwpPreview(viewer, { name: "fixture.hwp" }, getBytes);
      return { viewer, done: vm.runInContext("loadQueue", context) };
    },
    async render(getBytes) {
      const job = this.start(getBytes);
      await job.done;
      await vm.runInContext("pageQueue", context);
      return job.viewer;
    },
    drainPages: () => vm.runInContext("pageQueue", context),
    clear: () => context.clearHwpPreview()
  };
}

test("HWP reselect creates a fresh Studio after disposing the previous document", async () => {
  const harness = await previewHarness();
  await harness.render();
  assert.match(harness.viewer.innerHTML, /source-page/u);
  harness.clear();
  await harness.render();
  assert.match(harness.viewer.innerHTML, /source-page/u, "reselect must still render the original");
  assert.equal(harness.instances.length, 2);
  assert.equal(harness.instances[0].destroyed, true);
  assert.equal(harness.instances[1].loads, 1);
  assert.equal(harness.hosts.size, 1, "reselect must not accumulate hidden hosts");
  assert.match(await harness.urls.get(harness.viewer.image.src).text(), /fixture-1/u);
});

test("failed byte retrieval cannot leave initialization pending across a successful retry", async () => {
  const init = deferred();
  const harness = await previewHarness({ initialize: () => init.promise });
  await harness.render(async () => { throw new Error("fetch failed"); });
  assert.equal(harness.instances.length, 0, "failed fetch must not start an orphan editor");
  assert.equal(harness.hosts.size, 0);
  const retry = harness.start();
  init.resolve();
  await retry.done;
  await harness.drainPages();
  assert.equal(harness.instances.length, 1);
  assert.equal(harness.hosts.size, 1);
  assert.match(await harness.urls.get(retry.viewer.image.src).text(), /fixture-0/u);
});

test("rapid selection change disposes a pending obsolete initialization before retry", async () => {
  const started = deferred();
  const init = deferred();
  const harness = await previewHarness({ initialize: async (instance) => {
    if (instance.id === 0) { started.resolve(); await init.promise; }
  } });
  const old = harness.start();
  await started.promise;
  const latest = harness.start();
  init.resolve();
  await Promise.all([old.done, latest.done]);
  await harness.drainPages();
  assert.equal(harness.instances[0].destroyed, true);
  assert.equal(harness.instances[0].loads, 0);
  assert.equal(harness.hosts.size, 1);
  assert.equal(old.viewer.image.src, undefined);
  assert.match(await harness.urls.get(latest.viewer.image.src).text(), /fixture-1/u);
});

test("switching during SVG rendering drains the old page and never publishes it", async () => {
  const started = deferred();
  const page = deferred();
  const harness = await previewHarness({ renderPage: async (instance) => {
    if (instance.id === 0) { started.resolve(); await page.promise; }
  } });
  const old = harness.start();
  await started.promise;
  const latest = harness.start();
  assert.equal(harness.instances[0].destroyed, false);
  page.resolve();
  await Promise.all([old.done, latest.done]);
  await harness.drainPages();
  assert.equal(harness.instances[0].destroyed, true);
  assert.equal(old.viewer.image.src, undefined);
  assert.match(await harness.urls.get(latest.viewer.image.src).text(), /fixture-1/u);
});

test("clearing while initialization is pending disposes the abandoned frame", async () => {
  const started = deferred();
  const init = deferred();
  const harness = await previewHarness({ initialize: async () => { started.resolve(); await init.promise; } });
  const old = harness.start();
  await started.promise;
  harness.clear();
  init.resolve();
  await old.done;
  assert.equal(harness.instances[0].destroyed, true);
  assert.equal(harness.hosts.size, 0);
  assert.equal(old.viewer.image.src, undefined);
});
