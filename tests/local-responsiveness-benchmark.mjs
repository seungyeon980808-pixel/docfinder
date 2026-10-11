// Real local DocFinder library. Record timing/counts only, never private names/text.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.DOCFINDER_PLAYWRIGHT || 'playwright');
const [url, output] = process.argv.slice(2);
if (!url || !output) throw new Error('Usage: local-responsiveness-benchmark.mjs URL OUTPUT.json');
const browser = await chromium.launch({ headless: true }); const samples = []; const errors = [];
const paint = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())))));
try {
  for (let repetition = 1; repetition <= 5; repetition++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    await context.addInitScript(() => {
      window.docfinderTiming = {};
      const painted = callback => requestAnimationFrame(() => requestAnimationFrame(callback));
      let firstScheduled = false;
      new MutationObserver(() => {
        const row = document.querySelector('[data-document-id]');
        if (!firstScheduled && row?.getBoundingClientRect().height) {
          firstScheduled = true; painted(() => { window.docfinderTiming.firstDisplayMs = performance.now(); });
        }
      }).observe(document, { childList: true, subtree: true, attributes: true });
      document.addEventListener('click', event => {
        const row = event.target.closest('[data-document-id]');
        if (event.isTrusted && row && !window.docfinderTiming.interactiveMs) painted(() => {
          if (document.querySelector(`[data-document-id="${row.dataset.documentId}"]`)?.getAttribute('aria-current') === 'true') window.docfinderTiming.interactiveMs = performance.now();
        });
      });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    for (const visit of ['cold', 'repeat']) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.docfinderTiming.firstDisplayMs > 0); const firstDisplayMs = await page.evaluate(() => window.docfinderTiming.firstDisplayMs);
      const button = page.locator('[data-document-id]').nth(1); const id = await button.getAttribute('data-document-id');
      await button.click(); await page.waitForFunction(id => document.querySelector(`[data-document-id="${id}"]`)?.getAttribute('aria-current') === 'true', id);
      await page.waitForFunction(() => window.docfinderTiming.interactiveMs > 0); const interactiveMs = await page.evaluate(() => window.docfinderTiming.interactiveMs);
      samples.push({ repetition, visit, firstDisplayMs, interactiveMs, documents: await page.locator('.document-row').count() });
      process.stdout.write(JSON.stringify(samples.at(-1)) + '\n');
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
  const summary = Object.fromEntries(['cold', 'repeat'].map(visit => [visit, Object.fromEntries(['firstDisplayMs', 'interactiveMs'].map(metric => [metric, {
    median: percentile(samples.filter(s => s.visit === visit).map(s => s[metric]), .5), p95: percentile(samples.filter(s => s.visit === visit).map(s => s[metric]), .95)
  }]))]));
  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await fs.writeFile(output, JSON.stringify({ browser: 'chromium', url, repetitions: 5, viewport: '1280x800', deviceScaleFactor: 2,
    methodology: 'Real local library, no injected delay; first list paint and trusted click reflected by selection, each followed by two animation frames; fresh context then reload', samples, summary, errors }, null, 2));
} finally { await browser.close(); }
