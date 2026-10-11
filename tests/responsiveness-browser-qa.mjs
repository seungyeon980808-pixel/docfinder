import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { sharedFixture } from './shared-fixture.mjs';
import { syntheticPdf } from './create-public-qa-fixture.mjs';
import * as rhwp from '../vendor/rhwp-core/rhwp.js';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.DOCFINDER_PLAYWRIGHT || 'playwright');
const output = path.resolve(process.argv[2] || 'evidence/responsiveness-2026-10-10'); await fs.mkdir(output, { recursive: true });
const app = await sharedFixture(); const host = await app.browser('host');
const library = (await host.request('/api/libraries')).data.libraries[0]; const base = `/api/libraries/${library.id}`;
const pdf = syntheticPdf(Array.from({ length: 24 }, (_, i) => `alpha beta handbook page ${i + 1}`));
await rhwp.default({ module_or_path: await fs.readFile(new URL('../vendor/rhwp-core/rhwp_bg.wasm', import.meta.url)) });
const hwp = rhwp.HwpDocument.createEmpty(); hwp.insertText(0, 0, 0, '학교 학생 자치 alpha beta'); const hwpBytes = Buffer.from(hwp.exportHwp()); hwp.free();
for (const [id, name, bytes, pages] of [['file-a', 'alpha-guide.pdf', pdf, 24], ['file-b', 'beta-guide.pdf', pdf, 24], ['file-hwp', '학교자료.hwp', hwpBytes, 1]]) {
  const metadata = { id, name, size: bytes.length, modifiedTime: '2026-10-10T00:00:00Z', md5Checksum: createHash('md5').update(bytes).digest('hex') };
  app.files.set(id, { libraryId: library.id, metadata, bytes }); await app.service.upsertFile(library.id, metadata);
  await app.db.query("UPDATE df_documents SET status='ready',pages=$3 WHERE library_id=$1 AND id=$2", [library.id, id, JSON.stringify(Array.from({ length: pages }, (_, n) => ({ page: n + 1, text: `alpha beta handbook page ${n + 1}` })))]);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)); const original = app.drive.bytes.bind(app.drive);
app.drive.bytes = async (...args) => { await delay(args[1] === 'file-a' ? 400 : 60); return original(...args); };
const results = []; const errors = [];
const waitPdf = page => page.waitForFunction(() => Number(document.querySelector('.pdf-viewer')?.dataset.originalQualityMs) > 0);
const select = async (page, id) => { await page.locator(`[data-document-id="${id}"]`).click(); await page.waitForSelector(`[data-document-id="${id}"][aria-current="true"]`); };
const anchor = page => page.evaluate(async () => {
  const { capturePageAnchor } = await import('/js/preview-viewport.js?v=navigation-focus-1');
  return capturePageAnchor(document.querySelector('#document-detail'), [...document.querySelectorAll('.source-page')]);
});
try {
  for (const [name, engine, viewport] of [['chromium-desktop', chromium, { width: 1280, height: 800 }], ['webkit-desktop', webkit, { width: 1280, height: 800 }], ['webkit-mobile', webkit, { width: 390, height: 844 }]]) {
    if (process.env.DOCFINDER_QA_BROWSER && !name.startsWith(process.env.DOCFINDER_QA_BROWSER)) continue;
    const browser = await engine.launch({ headless: true }); const context = await browser.newContext({ viewport, deviceScaleFactor: 2, acceptDownloads: true });
    const [cookieName, value] = host.cookie.split('='); await context.addCookies([{ name: cookieName, value, url: app.origin, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage(); page.on('pageerror', error => { errors.push(`${name}: ${error.message}`); process.stdout.write(`error: ${error.message}\n`); });
    page.on('console', message => { if (message.type() === 'warning' || message.type() === 'error') process.stdout.write(`${message.type()}: ${message.text().slice(0, 500)}\n`); });
    process.stdout.write(`${name}: 검수 시작\n`);
    app.service.cache.clear();
    let failPreparation = viewport.width >= 600;
    await page.route('**/prepare', async route => {
      if (failPreparation) { failPreparation = false; await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporary fixture failure"}' }); }
      else await route.continue();
    });
    try {
      await page.goto(app.origin); await page.waitForSelector('[data-document-id="file-a"]');
      if (viewport.width < 600) {
        await select(page, 'file-b'); await waitPdf(page);
        await page.waitForFunction(() => document.querySelector('#detail-panel').classList.contains('is-open') && Math.abs(document.querySelector('#detail-panel').getBoundingClientRect().left) < 1);
        assert.ok(await page.locator('.source-page canvas').first().isVisible());
        await page.screenshot({ path: path.join(output, `${name}.png`) });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        results.push({ surface: name, checks: ['선택·모바일 원문 표시', '가로 넘침 없음'] }); continue;
      }
      await page.waitForSelector('[data-index-retry]'); await page.locator('[data-index-retry]').click();
      await page.waitForFunction(() => document.querySelector('#index-preparation').hidden);
      // Real input/clicks while a slow previous original is still loading.
      await select(page, 'file-a'); await select(page, 'file-b'); await waitPdf(page); await delay(450);
      assert.ok(await page.evaluate(() => document.querySelector('#document-detail').dataset.sourceKey.includes('file-b')));
      const quality = await page.evaluate(() => { const node = document.querySelector('.source-page[data-quality="original"]'); return { width: node.clientWidth, pixels: node.querySelector('canvas').width }; });
      assert.ok(Math.abs(quality.pixels - quality.width * 2) < 2, 'original canvas retains the prior DPR resolution');
      await page.locator('#document-detail').evaluate(element => { element.scrollTop = 1900; }); await delay(80);
      await page.locator('#search-input').focus(); await page.locator('#search-input').evaluate(element => { element.setSelectionRange(0, 0); window.qaInput = element; window.qaRow = document.querySelector('[data-document-id="file-b"]'); });
      const position = await page.locator('#document-detail').evaluate(element => element.scrollTop);
      await page.locator('#tool-menu summary').click(); await page.locator('#sync-button').click(); await delay(150);
      const retained = await page.evaluate(() => ({ sameInput: window.qaInput === document.querySelector('#search-input'), sameRow: window.qaRow === document.querySelector('[data-document-id="file-b"]'), scroll: document.querySelector('#document-detail').scrollTop, selected: document.querySelector('[aria-current="true"][data-document-id]')?.dataset.documentId }));
      assert.equal(retained.sameInput, true); assert.equal(retained.sameRow, true); assert.equal(retained.selected, 'file-b'); assert.ok(Math.abs(position - retained.scroll) < 3);
      app.files.get('file-b').metadata.modifiedTime = '2026-10-11T00:00:00Z'; await app.service.upsertFile(library.id, app.files.get('file-b').metadata);
      await app.db.query("UPDATE df_documents SET status='ready',pages=$3 WHERE library_id=$1 AND id=$2", [library.id, 'file-b', JSON.stringify(Array.from({ length: 24 }, (_, n) => ({ page: n + 1, text: `alpha beta handbook page ${n + 1}` })))]);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForFunction(() => document.querySelector('#document-detail').dataset.sourceKey.includes('2026-10-11')); await waitPdf(page);
      assert.ok(Math.abs(position - await page.locator('#document-detail').evaluate(element => element.scrollTop)) < 3, 'new original version retains reading position');
      // Composing text survives background metadata refresh.
      await page.locator('#search-input').dispatchEvent('compositionstart'); await page.locator('#search-input').evaluate(element => { element.value = '학교'; element.setSelectionRange(1, 1); });
      await page.locator('#tool-menu summary').click(); await page.locator('#sync-button').click(); await delay(150); assert.equal(await page.locator('#search-input').inputValue(), '학교');
      await page.locator('#search-input').dispatchEvent('compositionend'); await page.locator('#clear-search').click();
      await page.locator('#search-mode').selectOption('content'); await page.locator('#search-input').fill('alpha, beta'); await page.locator('#search-form').evaluate(form => form.requestSubmit());
      await page.waitForSelector('[data-document-id="file-b"]'); await select(page, 'file-b'); await waitPdf(page);
      await page.waitForSelector('.textLayer mark');
      assert.equal(await page.locator('[data-match-term="0"]').count(), 1); assert.equal(await page.locator('[data-match-term="1"]').count(), 1);
      await page.locator('[data-match-direction="next"]').click(); assert.equal(await page.locator('[aria-current="true"][data-document-id]').getAttribute('data-document-id'), 'file-b');
      await page.locator('#document-detail').evaluate(element => { element.scrollTop = 1900; }); await delay(80);
      const contentPosition = await anchor(page);
      const selectedMatch = await page.locator('.preview-match-count').textContent();
      app.files.get('file-b').metadata.modifiedTime = '2026-10-11T01:00:00Z'; await app.service.upsertFile(library.id, app.files.get('file-b').metadata);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForFunction(() => document.querySelector('#document-detail').dataset.sourceKey.includes('2026-10-11T01')); await waitPdf(page); await delay(80);
      const replacedPosition = await anchor(page); assert.equal(replacedPosition.page, contentPosition.page);
      assert.ok(Math.abs(contentPosition.fraction - replacedPosition.fraction) < .02, `reading anchor ${JSON.stringify(contentPosition)} -> ${JSON.stringify(replacedPosition)}`);
      await app.db.query("UPDATE df_documents SET status='ready',pages=$3 WHERE library_id=$1 AND id=$2", [library.id, 'file-b', JSON.stringify(Array.from({ length: 24 }, (_, n) => ({ page: n + 1, text: `alpha beta handbook page ${n + 1}` })))]);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await page.waitForSelector('[data-document-id="file-b"][aria-current="true"]');
      await page.waitForSelector('.preview-match-count'); assert.equal(await page.locator('.preview-match-count').textContent(), selectedMatch);
      if (!await fs.stat(path.join(output, `${name}.png`)).catch(() => false)) await page.screenshot({ path: path.join(output, `${name}.png`) });
      await page.locator('#clear-search').click(); await page.locator('#search-mode').selectOption('name');
      const row = page.locator('.document-row').filter({ has: page.locator('[data-document-id="file-b"]') }); await row.locator('summary').click();
      const downloading = page.waitForEvent('download'); await row.locator('[data-row-action="download"]').click(); const download = await downloading;
      assert.deepEqual(await fs.readFile(await download.path()), pdf, 'download is the exact original, never a preview');
      let failOriginal = true;
      await page.route('**/documents/file-hwp/original?**', async route => {
        if (failOriginal) { failOriginal = false; await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporary fixture failure"}' }); }
        else await route.continue();
      });
      await select(page, 'file-hwp'); await page.waitForSelector('[data-preview-retry]'); await page.locator('[data-preview-retry]').click();
      await page.waitForFunction(() => Number(document.querySelector('.hwp-preview')?.dataset.firstPageMs) > 0);
      const hwpRow = page.locator('.document-row').filter({ has: page.locator('[data-document-id="file-hwp"]') }); await hwpRow.locator('summary').click(); await hwpRow.locator('[data-row-action="edit"]').click();
      // The existing editor waits for external Korean web fonts; readiness must
      // remain a real enabled save control even when the font network is slow.
      await page.waitForFunction(() => !document.querySelector('#hwp-editor-download').disabled && document.querySelector('#hwp-editor-status').textContent.includes('사본'), null, { timeout: 90000 });
      const frame = page.frames().find(frame => frame.url().includes('/rhwp-studio/')); assert.ok(frame);
      const inputs = await frame.locator('input,textarea,[contenteditable],canvas').evaluateAll(elements => elements.map(e => ({ tag: e.tagName, id: e.id, type: e.type, role: e.getAttribute('role') })));
      await fs.writeFile(path.join(output, `${name}-editor-elements.json`), JSON.stringify(inputs, null, 2));
      await frame.locator('canvas').last().click({ position: { x: 100, y: 100 } });
      const typing = frame.locator('textarea'); await typing.press('Control+Home'); await typing.pressSequentially('QA_RESP_MARKER');
      await delay(100);
      await frame.locator('#sb-zoom-range').focus(); await frame.locator('#sb-zoom-range').press('ArrowRight');
      const zoom = await frame.locator('#sb-zoom-range').inputValue();
      app.files.get('file-b').metadata.modifiedTime = '2026-10-12T00:00:00Z'; await app.service.upsertFile(library.id, app.files.get('file-b').metadata);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await delay(200);
      assert.equal(await frame.locator('#sb-zoom-range').inputValue(), zoom, 'background catalog refresh retains editor zoom');
      const saveText = async () => {
        const saved = page.waitForEvent('download'); await page.locator('#hwp-editor-download').click(); const copy = await saved;
        const exported = new rhwp.HwpDocument(new Uint8Array(await fs.readFile(await copy.path())));
        try { return exported.getTextFileText(); } finally { exported.free(); }
      };
      const edited = await saveText(); process.stdout.write(`${name}: 편집 내용 ${JSON.stringify(edited)}\n`); assert.match(edited, /QA_RESP_MARKER/); assert.match(edited, /학교 학생 자치/);
      await typing.focus(); await typing.press('Control+z'); const undone = await saveText(); assert.notEqual(undone, edited);
      await typing.focus(); await typing.press('Control+Shift+z'); assert.equal(await saveText(), edited);
      assert.deepEqual(app.files.get('file-hwp').bytes, hwpBytes);
      await page.locator('#hwp-editor-close').click();
      results.push({ surface: name, quality, checks: ['준비·원문 실패 표시와 재시도', '늦은 원문 무시', '원본 DPR 유지', '목록·입력·선택·스크롤·IME 보존', '새 원문 버전의 읽던 위치 보존', '쉼표 AND·단어별 탐색', '원본 다운로드 일치', 'HWP 편집·확대 보존·사본 저장·실행 취소·다시 실행'] });
    } catch (error) {
      await page.screenshot({ path: path.join(output, `${name}-failure.png`) }).catch(() => {});
      const state = await page.evaluate(() => ({ editorStatus: document.querySelector('#hwp-editor-status')?.textContent, editorType: document.querySelector('#hwp-editor-status')?.dataset.type, downloadDisabled: document.querySelector('#hwp-editor-download')?.disabled, editorOpen: document.querySelector('#hwp-editor-dialog')?.open })).catch(() => ({}));
      process.stdout.write(`${name}: 실패 당시 상태 ${JSON.stringify(state)}\n`);
      throw error;
    } finally {
      await context.close(); await browser.close();
      app.files.get('file-b').metadata.modifiedTime = '2026-10-10T00:00:00Z';
      await app.db.query('DELETE FROM df_documents WHERE library_id=$1 AND id=$2', [library.id, 'file-b']);
      await app.service.upsertFile(library.id, app.files.get('file-b').metadata);
      await app.db.query("UPDATE df_documents SET status='ready',pages=$3 WHERE library_id=$1 AND id=$2", [library.id, 'file-b', JSON.stringify(Array.from({ length: 24 }, (_, n) => ({ page: n + 1, text: `alpha beta handbook page ${n + 1}` })))]);
    }
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, `browser-qa${process.env.DOCFINDER_QA_BROWSER ? '-' + process.env.DOCFINDER_QA_BROWSER : ''}.json`), JSON.stringify({ results, errors }, null, 2));
  process.stdout.write(JSON.stringify({ results, errors }, null, 2));
} finally { await app.close(); }
