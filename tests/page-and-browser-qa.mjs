import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { sharedFixture } from './shared-fixture.mjs';
import { syntheticPdf } from './create-public-qa-fixture.mjs';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.DOCFINDER_PLAYWRIGHT || 'playwright');
const output = path.resolve(process.argv[2] || 'evidence/page-and-2026-10-11');
await fs.mkdir(output, { recursive: true });
const app = await sharedFixture(); const host = await app.browser('host');
const library = (await host.request('/api/libraries')).data.libraries[0]; const base = `/api/libraries/${library.id}`;
const originals = new Map();
for (const [id, texts] of [['same', ['alpha', 'alpha beta alpha', 'beta', 'alpha beta']], ['split', ['alpha', 'beta']]]) {
  const bytes = syntheticPdf(texts); originals.set(id, bytes);
  const metadata = { id, name: `${id}.pdf`, size: bytes.length, modifiedTime: '2026-10-11T00:00:00Z' };
  app.files.set(id, { libraryId: library.id, metadata, bytes }); await app.service.upsertFile(library.id, metadata);
  await app.db.query("UPDATE df_documents SET status='ready',pages=$3 WHERE library_id=$1 AND id=$2", [library.id, id, JSON.stringify(texts.map((text, i) => ({ page: i + 1, text })))]);
}
const link = (await host.request(`${base}/public-links`, { method: 'POST', body: { name: '합성 검색 검수', documentIds: ['same', 'split'] } })).data.link;
const checks = []; const errors = [];
try {
  for (const [name, engine, viewport, guest] of [
    ['chromium-desktop', chromium, { width: 1280, height: 800 }, false],
    ['webkit-desktop-guest', webkit, { width: 1280, height: 800 }, true],
    ['webkit-mobile-guest', webkit, { width: 390, height: 844 }, true]
  ]) {
    const browser = await engine.launch(); const context = await browser.newContext({ viewport, acceptDownloads: true });
    if (!guest) { const [name, value] = host.cookie.split('='); await context.addCookies([{ name, value, url: app.origin, httpOnly: true, sameSite: 'Lax' }]); }
    const page = await context.newPage(); page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
    try {
      await page.goto(guest ? `${app.origin}/p/${link.id}#k=${link.token}` : `${app.origin}/s/${library.share_id}`);
      await page.waitForSelector('[data-document-id="same"]');
      await page.selectOption('#search-mode', 'content'); await page.fill('#search-input', 'alpha, beta');
      await page.waitForFunction(() => document.querySelector('#result-summary').textContent.startsWith('검색된 문서 1개'));
      assert.equal(await page.locator('#same-page-only').isChecked(), true);
      assert.equal(await page.locator('[data-document-id="split"]').count(), 0);
      await page.locator('[data-document-id="same"]').click();
      await page.waitForFunction(() => document.querySelector('.source-page[data-page-number="2"]')?.dataset.highlightCount === '3');
      const visible = () => page.locator('.source-page:not([hidden])').evaluateAll(nodes => nodes.map(n => Number(n.dataset.pageNumber)));
      assert.deepEqual(await visible(), [2, 4]);
      assert.match(await page.locator('.preview-current-page').textContent(), /現在|현재 2쪽 \/ 전체 4쪽/);
      if (viewport.width >= 960) {
        await page.locator('[data-document-id="same"]').click(); await page.keyboard.press('ArrowRight');
        assert.equal(await page.locator('#document-detail').evaluate(node => node === document.activeElement), true);
      } else await page.locator('#document-detail').focus();
      await page.keyboard.press('ArrowDown');
      await page.waitForFunction(() => document.querySelector('.preview-match-count').textContent.includes('2 / 5곳'));
      assert.equal(await page.locator('[data-document-id="same"]').getAttribute('aria-current'), 'true');
      assert.equal(await page.locator('.workspace').getAttribute('data-active-pane'), 'preview');
      await page.keyboard.press('ArrowLeft');
      assert.equal(await page.locator('[data-document-id="same"]').evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('ArrowRight'); assert.equal(await page.locator('#document-detail').evaluate(node => node === document.activeElement), true);
      await page.locator('[data-match-term="1"]').click(); assert.match(await page.locator('.preview-match-count').textContent(), /1 \/ 2곳/);
      await page.locator('[data-match-term="-1"]').click();
      if (viewport.width < 960) await page.locator('#detail-back').click();
      await page.locator('#same-page-only').uncheck();
      await page.waitForSelector('[data-document-id="split"]'); await page.locator('[data-document-id="same"]').click();
      assert.deepEqual(await visible(), [1, 2, 3, 4]);
      if (viewport.width < 960) await page.locator('#detail-back').click();
      // The broad search is deliberately slower; its late response cannot win.
      await page.route('**/search?**', async route => { if (new URL(route.request().url()).searchParams.get('matchScope') === 'document') await new Promise(resolve => setTimeout(resolve, 600)); await route.continue().catch(() => {}); });
      await page.locator('#same-page-only').check();
      await page.waitForFunction(() => document.querySelector('#result-summary').textContent.startsWith('검색된 문서 1개'));
      await page.locator('#same-page-only').uncheck(); await page.waitForTimeout(230); await page.locator('#same-page-only').check();
      await page.waitForTimeout(900); assert.equal(await page.locator('[data-document-id="split"]').count(), 0);
      await page.locator('[data-document-id="same"]').click(); assert.deepEqual(await visible(), [2, 4]);
      await page.screenshot({ path: path.join(output, `${name}.png`) });
      if (viewport.width < 960) await page.locator('#detail-back').click();
      await page.fill('#search-input', 'alpha, absent');
      await page.waitForFunction(() => document.querySelector('#result-summary').textContent.startsWith('검색된 문서 0개'));
      assert.match(await page.locator('#document-list').textContent(), /같은 쪽에 모든 검색어가 없습니다/);
      await page.fill('#search-input', 'alpha');
      await page.waitForSelector('[data-document-id="same"]'); assert.equal(await page.locator('#multi-keyword-options').isVisible(), false);
      await page.locator('[data-document-id="same"]').click(); assert.deepEqual(await visible(), [1, 2, 3, 4]);
      if (viewport.width < 960) await page.locator('#detail-back').click();
      const row = page.locator('.document-row').filter({ has: page.locator('[data-document-id="same"]') }); await row.locator('summary').click();
      const pending = page.waitForEvent('download'); await row.locator('[data-row-action="download"]').click();
      assert.deepEqual(await fs.readFile(await (await pending).path()), originals.get('same'));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      checks.push({ name, passed: true, visibleOriginalPages: [2, 4], preservedOriginalPageCount: 4, originalDownloadExact: true });
      process.stdout.write(`${name}: passed\n`);
    } catch (error) { await page.screenshot({ path: path.join(output, `${name}-failure.png`) }); await fs.writeFile(path.join(output, `${name}-failure.txt`), await page.locator('body').innerText()); throw error; }
    finally { await browser.close(); }
  }
  assert.deepEqual(errors, []); await fs.writeFile(path.join(output, 'browser-results.json'), JSON.stringify({ checks, errors }, null, 2));
} finally { await app.close(); }
