import assert from "node:assert/strict";

function options(values) {
  const result = { webdriver: "http://127.0.0.1:4444", url: "", expected: 0 };
  while (values.length) {
    const flag = values.shift();
    const value = values.shift();
    if (!value || !["--webdriver", "--url", "--expected"].includes(flag)) throw new Error("usage: public-release-safari-qa.mjs --url URL --expected COUNT");
    result[flag.slice(2)] = flag === "--expected" ? Number(value) : value;
  }
  if (!result.url || !Number.isSafeInteger(result.expected) || result.expected < 1) throw new Error("a URL and positive expected count are required");
  return result;
}

async function request(base, pathname, method = "GET", body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok || payload.value?.error) throw new Error(payload.value?.message || `WebDriver ${response.status}`);
  return payload.value;
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main() {
  const config = options(process.argv.slice(2));
  const session = await request(config.webdriver, "/session", "POST", { capabilities: { alwaysMatch: { browserName: "safari" } } });
  const id = session.sessionId;
  const command = (pathname, method, body) => request(config.webdriver, `/session/${id}${pathname}`, method, body);
  const execute = (script, args = []) => command("/execute/sync", "POST", { script, args });
  try {
    await command("/window/rect", "POST", { width: 1280, height: 800, x: 0, y: 0 });
    await command("/url", "POST", { url: config.url });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await execute("return document.querySelectorAll('.document-row').length") === config.expected) break;
      if (attempt === 99) throw new Error("Safari did not load the expected public corpus");
      await wait(100);
    }
    const initial = await execute(`
      const list = document.querySelector('.document-pane').getBoundingClientRect();
      const detail = document.querySelector('.detail-panel').getBoundingClientRect();
      return {
        profile: document.documentElement.dataset.profile,
        rows: document.querySelectorAll('.document-row').length,
        hiddenPrivateControls: [...document.querySelectorAll('#connect-button,#settings-button,#local-hwp-button')].every((node) => getComputedStyle(node).display === 'none'),
        bodyWidth: document.body.scrollWidth,
        viewport: innerWidth,
        ratio: list.width / (list.width + detail.width),
        pages: document.querySelectorAll('.pdf-viewer .source-page').length,
        canvases: [...document.querySelectorAll('.pdf-viewer canvas')].filter((canvas) => canvas.width > 0 && canvas.height > 0).length,
        selectedId: document.querySelector('[data-document-id][aria-current="true"]')?.dataset.documentId || ''
      }`);
    assert.equal(initial.profile, "public");
    assert.equal(initial.rows, config.expected);
    assert.equal(initial.hiddenPrivateControls, true);
    assert.ok(initial.bodyWidth <= initial.viewport);
    assert.ok(initial.ratio > 0.37 && initial.ratio < 0.43);
    assert.ok(initial.pages >= 2);
    assert.ok(initial.canvases >= 1);

    const scroll = await execute(`
      const panel = document.querySelector('#document-detail');
      const before = panel.scrollTop;
      document.querySelector('.pdf-viewer .source-page:last-child').scrollIntoView({block:'start'});
      panel.dispatchEvent(new Event('scroll'));
      return {before, after: panel.scrollTop}`);
    assert.ok(scroll.after > scroll.before);

    const searchRows = await execute(`
      const input = document.querySelector('#search-input');
      input.value = document.querySelector('.document-name')?.title || '';
      input.dispatchEvent(new Event('input', {bubbles:true}));
      return document.querySelectorAll('.document-row').length`);
    assert.equal(searchRows, 1);

    const deepLink = new URL(config.url);
    deepLink.hash = `doc=${initial.selectedId}`;
    await command("/url", "POST", { url: deepLink.href });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await execute("return document.querySelector('[data-document-id][aria-current=\"true\"]')?.dataset.documentId || ''") === initial.selectedId) break;
      if (attempt === 49) throw new Error("Safari deep link did not reopen the selected document");
      await wait(100);
    }

    await execute(`
      localStorage.setItem('5e-manual-library-settings-v1', JSON.stringify({googleClientId:'stale',rootFolderId:'stale',demoMode:true}));
      localStorage.setItem('5e-manual-library-drive-snapshot-v1', JSON.stringify({stale:'state'}));
      return true`);
    await command("/refresh", "POST", {});
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await execute("return document.querySelectorAll('.document-row').length") === config.expected) break;
      if (attempt === 49) throw new Error("Safari stale-state refresh did not recover the public corpus");
      await wait(100);
    }
    assert.equal(await execute("return document.documentElement.dataset.profile"), "public");
    process.stdout.write(`${JSON.stringify({ ok: true, browser: "Safari", browserVersion: session.capabilities.browserVersion, documentCount: config.expected, viewport: 1280, pdfPages: initial.pages, staleState: "ignored", deepLink: "reopened", screenshots: "not-captured" })}\n`);
  } finally {
    await command("", "DELETE").catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
