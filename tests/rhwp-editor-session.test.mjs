import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function fixture(createEditor) {
  const elements = new Map(); const handlers = new Map(); let downloads = 0;
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { dataset: {}, textContent: '', disabled: false, open: false,
      showModal() { this.open = true; }, close() { this.open = false; }, replaceChildren() { this.cleared = true; },
      addEventListener(type, handler) { handlers.set(`${selector}:${type}`, handler); } });
    return elements.get(selector);
  };
  const context = vm.createContext({ createEditor, DOMException, Blob, document: { querySelector: element,
    createElement: () => ({ click() { downloads++; } }) }, URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} },
    window: { confirm: () => true, setTimeout() {}, addEventListener() {} } });
  const source = await readFile(new URL('../js/rhwp-editor.js', import.meta.url), 'utf8');
  vm.runInContext(source.replace(/^const RHWP_.*$/gmu, '').replace('import(RHWP_EDITOR_URL)', 'Promise.resolve({ createEditor })')
    .replace('studioUrl: RHWP_STUDIO_URL', 'studioUrl: "fixture"').replace(/^export /gmu, ''), context);
  return { context, element, handlers, get downloads() { return downloads; } };
}

test('Closing a session while HWP editor initialization is pending discards the old document', async () => {
  let release; let began; let destroyed = 0; let loaded = 0;
  const ready = new Promise((resolve) => { began = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const app = await fixture(async () => { began(); await held; return { destroy() { destroyed++; }, loadFile() { loaded++; } }; });
  const opening = app.context.openRhwpEditor({ name: 'private.hwp' }, async () => new ArrayBuffer(4));
  await ready; app.context.destroyRhwpEditor(); release(); await opening;
  assert.equal(loaded, 0); assert.equal(destroyed, 1);
  assert.equal(app.element('#hwp-editor-dialog').open, false);
  assert.equal(app.element('#hwp-editor-title').textContent, '');
  assert.equal(app.element('#hwp-editor-host').cleared, true);
});

test('Logout during a pending HWP export prevents the old account download', async () => {
  let release; let began;
  const ready = new Promise((resolve) => { began = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const app = await fixture(async () => ({ destroy() {}, async loadFile() {},
    async exportHwp() { began(); await held; return new ArrayBuffer(4); } }));
  app.context.initRhwpEditor();
  await app.context.openRhwpEditor({ name: 'private.hwp', format: 'hwp' }, async () => new ArrayBuffer(4));
  const exporting = app.handlers.get('#hwp-editor-download:click')();
  await ready; app.context.destroyRhwpEditor(); release(); await exporting;
  assert.equal(app.downloads, 0); assert.equal(app.element('#hwp-editor-dialog').open, false);
});
