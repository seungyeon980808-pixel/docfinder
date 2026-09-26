const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const appRoot = path.resolve(__dirname, "..");
const mime = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".mjs": "text/javascript", ".pdf": "application/pdf", ".svg": "image/svg+xml", ".wasm": "application/wasm" };

function argumentsFrom(values) {
  const options = { dist: "dist", browsers: "chromium,webkit", screenshots: "" };
  while (values.length) {
    const flag = values.shift();
    const value = values.shift();
    if (!value || !["--dist", "--browsers", "--screenshots"].includes(flag)) throw new Error("usage: public-release-qa.cjs --dist PATH [--browsers chromium,webkit] [--screenshots PATH]");
    options[flag.slice(2)] = value;
  }
  return options;
}

function startServer(root) {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (!url.pathname.startsWith("/nested/")) { response.writeHead(404).end("not found"); return; }
      const encoded = url.pathname.slice("/nested/".length) || "index.html";
      let relative;
      try { relative = decodeURIComponent(encoded); } catch { response.writeHead(400).end("bad path"); return; }
      if (!relative || relative.endsWith("/")) relative += "index.html";
      const segments = relative.split("/");
      if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) { response.writeHead(404).end("not found"); return; }
      const target = path.resolve(root, ...segments);
      if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) { response.writeHead(404).end("not found"); return; }
      const stat = await fsp.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) { response.writeHead(404).end("not found"); return; }
      response.writeHead(200, { "content-type": mime[path.extname(target)] || "application/octet-stream", "content-length": stat.size });
      fs.createReadStream(target).pipe(response);
    } catch (error) {
      if (error?.code === "ENOENT") response.writeHead(404).end("not found");
      else response.writeHead(500).end("server error");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

function httpStatus(url) {
  return new Promise((resolve, reject) => http.get(url, (response) => { response.resume(); resolve(response.statusCode); }).once("error", reject));
}

async function loadPlaywright() {
  try { return require("playwright"); }
  catch { throw new Error("Playwright is required. Install it or expose the workspace runtime with NODE_PATH."); }
}

async function waitForDocuments(page, count) {
  await page.waitForFunction((expected) => document.querySelectorAll(".document-row").length === expected, count);
}

async function selectById(page, id) {
  await page.locator(`[data-document-id="${id}"]`).click();
}

async function verifyLayout(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.reload();
  await page.waitForSelector(".document-row");
  if (width === 1280 && await page.locator(".pdf-viewer").count()) {
    await page.waitForFunction(() => Boolean(document.querySelector('.pdf-viewer .source-page[data-rendered-width]')));
  }
  const geometry = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    viewport: innerWidth,
    list: document.querySelector(".document-pane").getBoundingClientRect().width,
    detail: document.querySelector(".detail-panel").getBoundingClientRect().width
  }));
  assert.ok(geometry.body <= geometry.viewport, `${width}px viewport has horizontal overflow`);
  if (width === 1280) {
    const ratio = geometry.list / (geometry.list + geometry.detail);
    assert.ok(ratio > 0.37 && ratio < 0.43, `desktop list ratio is ${ratio}`);
  }
}

async function runBrowser(browserType, label, baseUrl, release, options) {
  const browser = await browserType.launch({ headless: true });
  const consoleErrors = [];
  const forbiddenRequests = [];
  const failedResponses = [];
  const fontResponses = [];
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("response", (response) => {
      const pathname = new URL(response.url()).pathname;
      if (pathname.includes("/vendor/rhwp-studio/fonts/")) fontResponses.push(response.status());
      if (response.status() >= 400) failedResponses.push(`${response.status()} ${pathname}`);
    });
    page.on("request", (request) => {
      const url = request.url();
      if (/accounts\.google|drive\.google|googleapis\.com|\/private\//iu.test(url)) forbiddenRequests.push(url);
    });
    const metadata = JSON.parse(await fsp.readFile(path.join(options.dist, "library", "catalog.json"), "utf8"));
    const index = JSON.parse(await fsp.readFile(path.join(options.dist, "library", "search-index.json"), "utf8"));
    const first = metadata.documents[0];
    const initialPdf = metadata.documents.find((document) => document.format === "pdf");
    await page.goto(`${baseUrl}${initialPdf ? `#doc=${initialPdf.id}` : ""}`);
    await waitForDocuments(page, release.documentCount);
    assert.equal(await page.locator("html").getAttribute("data-profile"), "public");
    assert.equal(await page.locator("#connect-button:visible, #settings-button:visible, #local-hwp-button:visible").count(), 0);
    await page.locator("#search-input").fill(first.name);
    assert.equal(await page.locator(".document-row").count(), 1);
    await page.locator("#clear-search").click();

    const searchable = index.entries.find((entry) => entry.text.trim().split(/\s+/u).filter((term) => term.length >= 3).length >= 2);
    if (searchable) {
      const query = searchable.text.trim().split(/\s+/u).filter((term) => term.length >= 3).slice(0, 2).join(" ");
      await page.locator("#search-mode").selectOption("content");
      await page.locator("#search-input").fill(query);
      await page.locator("#search-submit").click();
      await page.waitForFunction(() => document.querySelectorAll(".document-row").length > 0);
    }
    await page.locator("#clear-search").click();
    await page.locator("#search-mode").selectOption("name");

    const pdfDocuments = metadata.documents.filter((document) => document.format === "pdf");
    let previewedPdf;
    for (const document of pdfDocuments) {
      await selectById(page, document.id);
      try {
        await page.waitForFunction(() => document.querySelectorAll(".pdf-viewer .source-page").length > 0, null, { timeout: 10_000 });
        previewedPdf = document;
        if (await page.locator(".pdf-viewer .source-page").count() > 1) break;
      } catch { /* try the next staged PDF */ }
    }
    assert.ok(previewedPdf, "no staged PDF produced a preview");
    const pages = await page.locator(".pdf-viewer .source-page").count();
    if (pages > 1) {
      const before = await page.locator("#document-detail").evaluate((element) => element.scrollTop);
      await page.locator(".pdf-viewer .source-page").last().scrollIntoViewIfNeeded();
      const after = await page.locator("#document-detail").evaluate((element) => element.scrollTop);
      assert.ok(after > before, "multi-page preview did not scroll");
    }

    const row = page.locator(`[data-result-id="${previewedPdf.id}"]`);
    await row.locator("summary").click();
    const downloadPromise = page.waitForEvent("download");
    await row.locator('[data-row-action="download"]').click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    const expected = await fsp.readFile(path.join(options.dist, "library", previewedPdf.sourceUrl));
    const actual = await fsp.readFile(downloadPath);
    assert.equal(createHash("sha256").update(actual).digest("hex"), createHash("sha256").update(expected).digest("hex"));

    await page.evaluate(() => { window.open = (url) => { window.__docfinderOpenedUrl = String(url); return null; }; });
    await row.locator("summary").click();
    await row.locator('[data-row-action="original"]').click();
    const openedUrl = await page.evaluate(() => window.__docfinderOpenedUrl);
    assert.equal(new URL(openedUrl).pathname, new URL(`library/${previewedPdf.sourceUrl}`, baseUrl).pathname);
    const originalHash = await page.evaluate(async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`original request failed: ${response.status}`);
      const digest = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }, openedUrl);
    assert.equal(originalHash, createHash("sha256").update(expected).digest("hex"));

    const deep = await context.newPage();
    await deep.goto(`${baseUrl}#doc=${previewedPdf.id}`);
    await deep.waitForSelector(`[data-document-id="${previewedPdf.id}"][aria-current="true"]`);
    const missing = await context.newPage();
    await missing.goto(`${baseUrl}#doc=missing-fixture-id`);
    await waitForDocuments(missing, release.documentCount);
    assert.equal(new URL(missing.url()).hash, "");
    await deep.close();
    await missing.close();

    const staleContext = await browser.newContext();
    await staleContext.addInitScript(() => {
      localStorage.setItem("5e-manual-library-settings-v1", JSON.stringify({ googleClientId: "stale", rootFolderId: "stale", demoMode: true }));
      localStorage.setItem("5e-manual-library-drive-snapshot-v1", JSON.stringify({ stale: "state" }));
    });
    const stalePage = await staleContext.newPage();
    await stalePage.goto(baseUrl);
    await waitForDocuments(stalePage, release.documentCount);
    assert.equal(await stalePage.locator("html").getAttribute("data-profile"), "public");
    await staleContext.close();

    for (const viewport of [[1280, 800], [768, 900], [375, 812]]) {
      await verifyLayout(page, viewport[0], viewport[1]);
      if (options.screenshots) await page.screenshot({ path: path.join(options.screenshots, `${label}-${viewport[0]}.png`), fullPage: false });
    }
    const hwpDocument = metadata.documents.find((document) => document.format === "hwp" || document.format === "hwpx");
    if (hwpDocument) {
      await selectById(page, hwpDocument.id);
      await page.waitForFunction(() => {
        const image = document.querySelector(".hwp-preview .source-page img");
        return image?.src?.startsWith("blob:");
      }, null, { timeout: 45_000 });
    }
    assert.deepEqual(forbiddenRequests, []);
    assert.deepEqual(failedResponses, []);
    assert.deepEqual(consoleErrors, []);
    await context.close();
    return {
      label,
      viewports: [375, 768, 1280],
      hwpPreview: Boolean(hwpDocument),
      pdfPages: pages,
      fontResponses: Object.fromEntries([...new Set(fontResponses)].sort().map((status) => [status, fontResponses.filter((value) => value === status).length])),
      failedResponses: failedResponses.length,
      consoleErrors: consoleErrors.length
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  options.dist = path.resolve(appRoot, options.dist);
  if (options.screenshots) { options.screenshots = path.resolve(appRoot, options.screenshots); await fsp.mkdir(options.screenshots, { recursive: true }); }
  const [{ validatePublicRelease }, playwright] = await Promise.all([
    import(pathToFileURL(path.join(__dirname, "public-release-lib.mjs")).href), loadPlaywright()
  ]);
  const release = await validatePublicRelease(options.dist);
  const { server, origin } = await startServer(options.dist);
  const baseUrl = `${origin}/nested/`;
  try {
    for (const forbidden of ["private/catalog.json", ".omo/state.json", "evidence/log.txt", "node_modules/pkg/index.js", ".git/config", "tests/public-release.test.mjs", "fake-secret.txt"]) {
      assert.equal(await httpStatus(new URL(forbidden, baseUrl)), 404);
    }
    const results = [];
    for (const name of options.browsers.split(",").filter(Boolean)) {
      if (!playwright[name]) throw new Error(`unsupported browser: ${name}`);
      results.push(await runBrowser(playwright[name], name, baseUrl, release, options));
    }
    process.stdout.write(`${JSON.stringify({ ok: true, documentCount: release.documentCount, formats: release.formats, browsers: results, forbiddenPaths: 7, manifestSha256: release.manifestSha256 })}\n`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
