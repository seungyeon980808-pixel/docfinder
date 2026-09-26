import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(appRoot, relativePath), "utf8");

test("private source markup retains its connection controls before public-mode styling", () => {
  // Characterization baseline: the source remains capable of the private Drive workflow.
  const html = read("index.html");

  assert.match(html, /id="connect-button"/u);
  assert.match(html, /id="settings-dialog"/u);
  assert.match(html, /id="sync-button"/u);
});

test("public profile removes private setup affordances and defers GIS loading", () => {
  // Given: the staged bundle identifies itself as public before the interface renders.
  const html = read("index.html");
  const styles = read("styles/app.css");

  // When: a public build is served.
  // Then: private setup remains unreachable and no parser-discovered GIS request exists.
  assert.doesNotMatch(html, /<script\s+src="https:\/\/accounts\.google\.com\/gsi\/client"/u);
  assert.match(html, /<html lang="ko" data-profile="loading">/u);
  assert.match(html, /BUILD_PROFILE\.profile !== "public"/u);
  assert.match(styles, /html\[data-profile="loading"\]\s+#connect-button/u);
  assert.match(styles, /html\[data-profile="public"\]\s+#connect-button/u);
  assert.match(styles, /html\[data-profile="public"\]\s+#settings-dialog/u);
  assert.match(styles, /html\[data-profile="public"\]\s+\.result-menu-panel button\[data-row-action="edit"\]/u);
});
