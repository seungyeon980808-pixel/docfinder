import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPersonalApp } from "../scripts/build-personal-app.mjs";
import { verifyReleaseTree } from "../scripts/release-package.mjs";
import { startLocalServer } from "../scripts/serve-local.mjs";

test("개인 배포는 문서·색인·데모 없이 시작하며 비공개 문서 혼입을 거부한다", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "docfinder-personal-release-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, "app");
  const result = await buildPersonalApp({ output, clientId: "fixture.apps.googleusercontent.com" });
  assert.equal(result.googleConfigured, true);
  assert.match(await fs.readFile(path.join(output, "config.js"), "utf8"), /fixture\.apps\.googleusercontent\.com/u);
  const files = await verifyReleaseTree("personal", output);
  assert.ok(files.includes("js/document-index-worker.js"));
  assert.ok(!files.some((file) => /^(?:private|library|tests|scripts)\//u.test(file)));
  assert.equal((await fs.readFile(path.join(output, "data/demo-documents.js"), "utf8")).trim(), "export const DEMO_DOCUMENTS = [];");
  await assert.rejects(buildPersonalApp({ output }), /이미 있습니다/u);
  await fs.writeFile(path.join(output, "js", "guide.pdf"), "%PDF-1.4 private original");
  await assert.rejects(verifyReleaseTree("personal", output), /not allowed/u);
  await assert.rejects(buildPersonalApp({ output: path.join(root, "bad"), clientId: "a-secret" }), /클라이언트 ID/u);
});

test("개인 미리보기 서버는 문서 폴더 없이 실행하고 모든 비공개 색인 경로를 차단한다", async (context) => {
  const service = await startLocalServer({ personal: true, sourceRoot: "/does-not-exist", port: 0 });
  context.after(() => service.close());
  const base = `http://127.0.0.1:${service.server.address().port}`;
  assert.equal(service.state.automatic, false);
  assert.equal(service.state.phase, "ready");
  assert.match(await (await fetch(`${base}/config.js`)).text(), /profile: "private"/u);
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await (await fetch(`${base}/data/demo-documents.js`)).text()).trim(), "export const DEMO_DOCUMENTS = [];");
  assert.equal((await fetch(`${base}/js/document-index-worker.js`)).status, 200);
  for (const relative of ["/private/catalog.json", "/private/search-index.json", "/private/docs/guide.pdf", "/library/catalog.json", "/.git/config", "/README.md"]) {
    assert.equal((await fetch(`${base}${relative}`)).status, 404, relative);
  }
});
