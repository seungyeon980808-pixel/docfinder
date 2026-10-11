// Local, synthetic DocFinder measurement. Never connects to Google or Render.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { sharedFixture } from './shared-fixture.mjs';
import { syntheticPdf } from './create-public-qa-fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium, webkit } = require(process.env.DOCFINDER_PLAYWRIGHT || 'playwright');
const output = process.argv[2];
if (!output) throw new Error('Usage: responsiveness-benchmark.mjs OUTPUT.json');
const repeats = Number(process.env.DOCFINDER_BENCH_REPEATS || 5);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const app = await sharedFixture();
const host = await app.browser('host');
const library = (await host.request('/api/libraries')).data.libraries[0];
await app.db.query("INSERT INTO df_connections(library_id,credentials,folder_id,status) VALUES($1,'','benchmark-folder','ready')", [library.id]);
const indexedText = 'alpha beta school handbook '.repeat(600);
const pdf = syntheticPdf(Array.from({ length: 24 }, (_, i) => `alpha beta handbook page ${i + 1}`));
for (let i = 0; i < 16; i++) {
  const id = `bench-${String(i).padStart(2, '0')}`;
  const metadata = { id, name: `guide-${String(i).padStart(2, '0')}.pdf`, size: pdf.length, modifiedTime: '2026-10-10T00:00:00Z', md5Checksum: createHash('md5').update(pdf).digest('hex') };
  app.files.set(id, { libraryId: library.id, metadata, bytes: pdf });
  await app.service.upsertFile(library.id, metadata);
  await app.db.query("UPDATE df_documents SET status='ready',pages=$3 WHERE library_id=$1 AND id=$2", [library.id, id, JSON.stringify(Array.from({ length: 24 }, (_, n) => ({ page: n + 1, text: indexedText })))]);
}
let originalReads = 0; let activeOriginals = 0; let maxOriginals = 0; let fullCorpusReads = 0;
const original = app.drive.bytes.bind(app.drive);
app.drive.bytes = async (...args) => {
  originalReads++; activeOriginals++; maxOriginals = Math.max(maxOriginals, activeOriginals);
  try { await sleep(1000); return await original(...args); } finally { activeOriginals--; }
};
const query = app.db.query.bind(app.db);
app.db.query = async (sql, args) => {
  if (/SELECT \* FROM df_documents WHERE library_id=\$1 ORDER BY id/u.test(sql)) { fullCorpusReads++; await sleep(600); }
  return query(sql, args);
};
const handlers = app.server.listeners('request');
app.server.removeAllListeners('request');
app.server.on('request', async (request, response) => {
  if (request.url.startsWith('/api/')) await sleep(150);
  for (const handler of handlers) handler.call(app.server, request, response);
});
const browser = await (process.env.DOCFINDER_BENCH_BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true });
const samples = []; const errors = [];
const paint = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())))));
const cookie = host.cookie.split('=');
try {
  for (let repetition = 0; repetition < repeats; repetition++) {
    app.service.cache.clear();
    app.service.manifests?.clear();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    await context.addInitScript(() => {
      window.docfinderTiming = {};
      const painted = callback => requestAnimationFrame(() => requestAnimationFrame(callback));
      let firstScheduled = false; let nameScheduled = false;
      new MutationObserver(() => {
        const row = document.querySelector('[data-document-id="bench-00"]');
        if (!firstScheduled && row?.getBoundingClientRect().height) {
          firstScheduled = true; painted(() => { window.docfinderTiming.firstDisplayMs = performance.now(); });
        }
        if (!nameScheduled && window.docfinderTiming.inputStart && document.querySelector('#search-input')?.value === 'guide-01'
          && document.querySelectorAll('.document-row').length === 1 && document.querySelector('[data-document-id="bench-01"]')) {
          nameScheduled = true; painted(() => { window.docfinderTiming.nameFeedbackMs = performance.now() - window.docfinderTiming.inputStart; });
        }
      }).observe(document, { childList: true, subtree: true, attributes: true });
      document.addEventListener('click', event => {
        if (event.isTrusted && !window.docfinderTiming.interactiveMs && event.target.closest('[data-document-id="bench-01"]')) {
          painted(() => { if (document.querySelector('[data-document-id="bench-01"]')?.getAttribute('aria-current') === 'true') window.docfinderTiming.interactiveMs = performance.now(); });
        }
      });
      document.addEventListener('input', event => {
        if (event.target.id === 'search-input' && event.target.value === 'guide-01') window.docfinderTiming.inputStart = performance.now();
      }, true);
    });
    await context.addCookies([{ name: cookie[0], value: cookie[1], url: app.origin, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    for (const visit of ['cold', 'repeat']) {
      const readStart = originalReads; const corpusStart = fullCorpusReads;
      await page.goto(app.origin, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.docfinderTiming.firstDisplayMs > 0);
      const firstDisplayMs = await page.evaluate(() => window.docfinderTiming.firstDisplayMs);
      await page.locator('[data-document-id="bench-01"]').click();
      await page.waitForSelector('[data-document-id="bench-01"][aria-current="true"]');
      await page.waitForFunction(() => window.docfinderTiming.interactiveMs > 0);
      const interactiveMs = await page.evaluate(() => window.docfinderTiming.interactiveMs);
      await page.waitForFunction(() => Number(document.querySelector('.pdf-viewer')?.dataset.firstPageMs) > 0);
      const originalDisplayMs = await paint(page);
      let originalQualityDisplayMs;
      if (await page.evaluate(() => Boolean(document.querySelector('.source-page')?.dataset.quality))) {
        await page.waitForFunction(() => Number(document.querySelector('.pdf-viewer')?.dataset.originalQualityMs) > 0);
        originalQualityDisplayMs = await paint(page);
      }
      await page.locator('#search-input').fill('guide-01');
      await page.waitForFunction(() => window.docfinderTiming.nameFeedbackMs > 0).catch(async error => {
        process.stderr.write(JSON.stringify(await page.evaluate(() => ({ timing: window.docfinderTiming, query: document.querySelector('#search-input')?.value,
          rows: document.querySelectorAll('.document-row').length, ids: [...document.querySelectorAll('[data-document-id]')].map(row => row.dataset.documentId) }))) + '\n');
        throw error;
      });
      const nameFeedbackMs = await page.evaluate(() => window.docfinderTiming.nameFeedbackMs);
      await page.locator('#clear-search').click();
      await page.waitForSelector('[data-document-id="bench-00"]');
      await page.locator('[data-document-id="bench-00"]').click();
      await page.waitForFunction(() => document.querySelector('#document-detail')?.dataset.sourceKey?.includes('bench-00') && Number(document.querySelector('.pdf-viewer')?.dataset.firstPageMs) > 0);
      await page.locator('[data-document-id="bench-01"]').click();
      await page.waitForFunction(() => document.querySelector('#document-detail')?.dataset.sourceKey?.includes('bench-01') && Number(document.querySelector('.pdf-viewer')?.dataset.firstPageMs) > 0);
      const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => ({ path: new URL(entry.name).pathname, duration: entry.duration, bytes: entry.transferSize })));
      samples.push({ repetition: repetition + 1, visit, firstDisplayMs, interactiveMs, originalDisplayMs, originalQualityDisplayMs, nameFeedbackMs, originalReads: originalReads - readStart, fullCorpusReads: fullCorpusReads - corpusStart, resources });
      process.stdout.write(JSON.stringify({ repetition: repetition + 1, visit, firstDisplayMs: Math.round(firstDisplayMs), interactiveMs: Math.round(interactiveMs), originalDisplayMs: Math.round(originalDisplayMs), nameFeedbackMs: Math.round(nameFeedbackMs) }) + '\n');
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
  const summary = Object.fromEntries(['cold', 'repeat'].map(visit => [visit, Object.fromEntries(['firstDisplayMs', 'interactiveMs', 'originalDisplayMs', 'nameFeedbackMs'].map(metric => [metric, { median: percentile(samples.filter(s => s.visit === visit).map(s => s[metric]), .5), p95: percentile(samples.filter(s => s.visit === visit).map(s => s[metric]), .95) }]))]));
  const sources = {};
  for (const name of ['js/app.js', 'js/render.js', 'js/pdf-preview.js', 'js/shared-library.js', 'scripts/shared/library-service.mjs']) sources[name] = createHash('sha256').update(await fs.readFile(new URL('../' + name, import.meta.url))).digest('hex');
  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await fs.writeFile(output, JSON.stringify({ browser: process.env.DOCFINDER_BENCH_BROWSER || 'chromium', repeats, fixture: { documents: 16, pagesPerDocument: 24, indexCharacters: 16 * 24 * indexedText.length, originalBytes: pdf.length, apiDelayMs: 150, fullCorpusDelayMs: 600, originalDelayMs: 1000, viewport: '1280x800', deviceScaleFactor: 2 }, methodology: { firstDisplayMs: 'navigation to painted document list (two animation frames)', interactiveMs: 'navigation to trusted document click reflected by selected state and two animation frames', originalDisplayMs: 'navigation to painted original canvas after selecting document 01', nameFeedbackMs: 'trusted input fill to matching document list and two animation frames', visits: 'cold = fresh browser context and empty corpus cache; repeat = reload same context, warm corpus/assets', limitations: 'local synthetic API/Drive delay, not production or 5E; rendering and PGlite database are real' }, sources, samples, summary, errors, maxOriginals }, null, 2));
} finally { await browser.close(); await app.close(); }
