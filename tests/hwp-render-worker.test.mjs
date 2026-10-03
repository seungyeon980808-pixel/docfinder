import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("HWP worker caches parsing and SVG and frees least recently used documents", async () => {
  let created = 0; let rendered = 0; const freed = [];
  const messages = [];
  const context = vm.createContext({ self: { postMessage: (message) => messages.push(message) }, core: {
    HwpDocument: class {
      constructor() { this.id = ++created; }
      pageCount() { return 2; }
      renderPageSvg(page) { rendered++; return `<svg>${this.id}:${page}</svg>`; }
      getPageTextLayout() { return '{"runs":[]}'; }
      free() { freed.push(this.id); }
    }
  } });
  const source = await readFile(new URL("../js/hwp-render-worker.js", import.meta.url), "utf8");
  vm.runInContext(source.replace(/^import .*;$/gmu, "").replace(/^const ready =.*;$/mu, "const ready = Promise.resolve();"), context);
  let id = 0;
  const call = async (type, key, page) => { await context.self.onmessage({ data: { type, key, page, bytes: new ArrayBuffer(1), id: ++id } }); return messages.at(-1); };
  await call("open", "a"); await call("page", "a", 1); await call("page", "a", 1); await call("open", "a");
  assert.equal(created, 1); assert.equal(rendered, 1);
  await call("open", "b"); await call("page", "a", 2); await call("open", "c");
  assert.deepEqual(freed, [2], "the untouched document is evicted first");
  assert.match((await call("page", "b", 1)).error, /다시 열어/u);
  await call("open", "b"); assert.equal(created, 4);
});
