const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const appUrl = "http://127.0.0.1:4173/manual-library/";
const evidenceDirectory = path.join(__dirname, "..", "evidence");

async function run() {
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(appUrl);
  await page.waitForSelector(".document-row");

  assert.equal(await page.locator(".document-row").count(), 9);
  assert.match(await page.locator(".document-row.is-selected").textContent(), /교내 신청서 작성 예시/);
  assert.match(await page.locator("#document-detail").textContent(), /RHWP로 열어 편집/);

  const hwpIndexResult = await page.evaluate(async () => {
    const { searchHwpContent } = await import("./js/hwp-index.js?qa=1");
    const documentItem = {
      id: "qa-hwp",
      name: "form-01.hwp",
      format: "hwp",
      modifiedTime: "2026-09-22T00:00:00Z"
    };
    const source = "https://raw.githubusercontent.com/edwardkim/rhwp/v0.8.6/samples/form-01.hwp";
    const getBytes = async () => (await fetch(source)).arrayBuffer();
    const indexed = await searchHwpContent([documentItem], "", getBytes);
    const excerpt = indexed.matches[0]?.excerpt || "";
    const term = excerpt.match(/[가-힣]{2,}/u)?.[0] || excerpt.match(/[A-Za-z]{3,}/u)?.[0] || "";
    const searched = term ? await searchHwpContent([documentItem], term, getBytes) : { matches: [] };
    return { excerpt, term, matches: searched.matches.length, failures: indexed.failures };
  });
  assert.equal(hwpIndexResult.failures.length, 0);
  assert.ok(hwpIndexResult.term.length >= 2);
  assert.equal(hwpIndexResult.matches, 1);

  await page.locator("[data-open-hwp]").click();
  await page.locator("#hwp-editor-status").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#hwp-editor-status")?.textContent?.includes("브라우저에서 바로 편집"), null, { timeout: 45000 });
  assert.equal(await page.locator("#hwp-editor-download").isEnabled(), true);
  assert.match(await page.locator("#hwp-editor-host iframe").getAttribute("src"), /vendor\/rhwp-studio\/index\.html/);
  await page.screenshot({ path: path.join(evidenceDirectory, "manual-library-hwp-editor.png"), fullPage: true });
  const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
  await page.locator("#hwp-editor-download").click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /\.hwp$/i);
  await page.locator("#hwp-editor-close").click();

  await page.locator("#search-input").fill("정보보안");
  assert.match(await page.locator("#result-summary").textContent(), /1개/);
  await page.locator("#clear-search").click();
  await page.locator("#search-mode").selectOption("content");
  await page.locator("#search-input").fill("안전");
  assert.match(await page.locator("#result-summary").textContent(), /2개/);

  await page.locator("#clear-search").click();
  await page.locator('[data-folder="교육행정"]').click();
  assert.match(await page.locator("#result-summary").textContent(), /2개/);
  await page.keyboard.press("/");
  assert.equal(await page.locator("#search-input").evaluate((element) => element === document.activeElement), true);

  await page.locator("#refresh-button").click();
  assert.match(await page.locator("#sync-title").textContent(), /다시 불러왔습니다/);
  await page.locator("#settings-button").click();
  assert.equal(await page.locator("#settings-dialog").isVisible(), true);
  assert.equal(await page.locator("#setting-pdf-editor-url").count(), 1);
  await page.locator("#setting-pdf-editor-url").fill("https://example.com/pdf-editor");
  await page.locator('#settings-form button[type="submit"]').click();

  await page.locator("#clear-search").click();
  await page.locator('[data-document-id="demo-security"]').click();
  const popupPromise = context.waitForEvent("page");
  await page.locator("[data-open-pdf-editor]").click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  const popupUrl = new URL(popup.url());
  assert.equal(popupUrl.origin + popupUrl.pathname, "https://example.com/pdf-editor");
  assert.equal(popupUrl.searchParams.get("fileId"), "demo-security");
  assert.match(popupUrl.searchParams.get("name"), /정보보안/);
  await popup.close();

  const desktopWidth = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: window.innerWidth }));
  assert.ok(desktopWidth.body <= desktopWidth.viewport);
  await page.screenshot({ path: path.join(evidenceDirectory, "manual-library-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto(appUrl);
  await page.waitForSelector(".document-row");
  const tabletWidth = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: window.innerWidth }));
  assert.ok(tabletWidth.body <= tabletWidth.viewport);
  const truncatedPublishers = await page.locator(".document-row > span:nth-child(3)").evaluateAll((elements) => elements.filter((element) => element.scrollWidth > element.clientWidth).map((element) => element.textContent));
  assert.deepEqual(truncatedPublishers, []);
  const clippedTitles = await page.locator(".document-row .document-name strong").evaluateAll((elements) => elements.filter((element) => element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight).map((element) => element.textContent));
  assert.deepEqual(clippedTitles, []);
  await page.screenshot({ path: path.join(evidenceDirectory, "manual-library-tablet.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(appUrl);
  await page.waitForSelector(".document-row");
  assert.equal(await page.locator("#detail-panel").getAttribute("aria-hidden"), "true");
  assert.equal(await page.locator("#detail-panel").getAttribute("inert"), "");
  const mobileWidth = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: window.innerWidth }));
  assert.ok(mobileWidth.body <= mobileWidth.viewport);
  const openedRow = page.locator(".document-row").nth(1);
  await openedRow.click();
  assert.equal(await page.locator("#detail-panel").evaluate((element) => element.classList.contains("is-open")), true);
  assert.equal(await page.locator("#detail-panel").getAttribute("aria-hidden"), null);
  assert.equal(await page.locator("#detail-back").evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#detail-panel").evaluate((element) => element.classList.contains("is-open")), false);
  assert.equal(await openedRow.evaluate((element) => element === document.activeElement), true);
  await page.screenshot({ path: path.join(evidenceDirectory, "manual-library-mobile.png"), fullPage: true });

  await browser.close();
  process.stdout.write(`QA passed: HWP indexed term "${hwpIndexResult.term}", RHWP rendered and downloaded .hwp, PDF editor URL handoff, desktop/tablet/mobile layout, filename/content search, folder filter, keyboard focus, demo sync, settings, detail panel\n`);
}

run().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
