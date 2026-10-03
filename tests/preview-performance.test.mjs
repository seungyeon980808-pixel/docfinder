import assert from "node:assert/strict";
import test from "node:test";
import { createByteCache } from "../js/preview-cache.js";
import { createRenderScheduler } from "../js/preview-scheduler.js";
import { pageAtPosition } from "../js/preview-viewport.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("concurrent original requests share the download and give transferable private buffers", async () => {
  let loads = 0;
  const load = createByteCache(async () => { loads++; return Uint8Array.from([1, 2, 3]).buffer; });
  const item = { id: "a", sourceUrl: "a.pdf?v=1" };
  const [first, second] = await Promise.all([load(item), load(item)]);
  assert.equal(loads, 1);
  structuredClone(first, { transfer: [first] });
  assert.deepEqual([...new Uint8Array(second)], [1, 2, 3]);
  assert.deepEqual([...new Uint8Array(await load(item))], [1, 2, 3]);
  await load({ ...item, sourceUrl: "a.pdf?v=2" });
  assert.equal(loads, 2, "updated originals must not reuse the previous bytes");
});

test("failed original fetch is retried and byte cache respects the budget", async () => {
  let count = 0;
  const load = createByteCache(async () => { if (++count === 1) throw new Error("offline"); return new ArrayBuffer(4); }, 4);
  await assert.rejects(load({ id: "a" }), /offline/);
  await load({ id: "a" }); await load({ id: "b" }); await load({ id: "a" });
  assert.equal(count, 4);
});

test("requested page takes priority and rendering in flight is bounded", async () => {
  const scheduler = createRenderScheduler(1);
  const order = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const first = scheduler.schedule("near", async () => { order.push("near"); await blocked; }, 10);
  const target = scheduler.schedule("target", async () => { order.push("target"); }, 0);
  const duplicate = scheduler.schedule("target", () => assert.fail("duplicate task"), 0);
  assert.equal(target, duplicate);
  await tick();
  assert.deepEqual(order, ["target", "near"]);
  const dropped = scheduler.schedule("obsolete", () => assert.fail("cancelled task"));
  scheduler.clear(); release(); await Promise.all([first, target, dropped]);
});

test("reading position in a 2000-page document needs only logarithmic layout reads", () => {
  let reads = 0;
  const pages = Array.from({ length: 2000 }, (_, index) => ({ index, getBoundingClientRect() { reads++; return { bottom: (index + 1) * 100 }; } }));
  assert.equal(pageAtPosition(pages, 180050).index, 1800);
  assert.ok(reads <= 12, `${reads} layout reads`);
});
