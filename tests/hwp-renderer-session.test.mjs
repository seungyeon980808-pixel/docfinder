import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('Shared session cleanup terminates HWP worker caches and cancels pending page rendering', async () => {
  const workers = [];
  const context = vm.createContext({ DOMException, Worker: class {
    constructor() { workers.push(this); }
    terminate() { this.terminated = true; }
    postMessage(data) {
      if (data.type === 'open') queueMicrotask(() => this.onmessage?.({ data: { id: data.id, result: { pageCount: 2 } } }));
    }
  } });
  const source = await readFile(new URL('../js/hwp-renderer.js', import.meta.url), 'utf8');
  vm.runInContext(source.replace('new URL("./hwp-render-worker.js?v=phrase-map-2", import.meta.url)', '"worker"').replace(/^export /gmu, ''), context);
  const first = await context.createHwpRenderer(new ArrayBuffer(2), 'account-a');
  const pending = first.page(1);
  const rejected = assert.rejects(pending, (error) => error.name === 'AbortError');
  context.destroyHwpRenderer(); await rejected;
  assert.equal(workers[0].terminated, true); assert.equal(workers[0].onmessage, null);
  await context.createHwpRenderer(new ArrayBuffer(2), 'account-b');
  assert.equal(workers.length, 2); context.destroyHwpRenderer();
});
