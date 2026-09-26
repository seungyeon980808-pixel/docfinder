import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("RHWP iframe load listener is registered before the iframe enters the DOM", async () => {
  const source = await readFile(new URL("../vendor/rhwp-editor/index.js", import.meta.url), "utf8");
  const listenerIndex = source.indexOf("iframe.addEventListener('load'");
  const appendIndex = source.indexOf("el.appendChild(iframe)");
  assert.ok(listenerIndex >= 0, "load listener should exist");
  assert.ok(appendIndex >= 0, "iframe append should exist");
  assert.ok(listenerIndex < appendIndex, "listener must be attached before append to avoid a warm-cache race");
});

test("RHWP Studio is loaded from the vendored same-origin build", async () => {
  const source = await readFile(new URL("../js/rhwp-editor.js", import.meta.url), "utf8");
  assert.match(source, /vendor\/rhwp-studio\/index\.html/u);
  assert.match(source, /studioUrl:\s*RHWP_STUDIO_URL/u);
});
