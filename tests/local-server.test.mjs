import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildLocalIndex } from "../scripts/build-local-index.mjs";
import { startLocalServer } from "../scripts/serve-local.mjs";
import { syntheticPdf } from "./create-public-qa-fixture.mjs";

async function sandbox(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "docfinder-watch-test-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const outputRoot = path.join(root, "private");
  await fs.mkdir(sourceRoot);
  return { root, sourceRoot, outputRoot };
}

test("내용 해시는 크기와 수정 시각이 같은 파일 교체도 감지하고 미변경 쪽은 재사용한다", async (context) => {
  const options = await sandbox(context);
  const file = path.join(options.sourceRoot, "guide.pdf");
  await fs.writeFile(file, syntheticPdf(["alpha"]));
  const first = await buildLocalIndex({ ...options, quiet: true });
  const stat = await fs.stat(file);
  const reused = await buildLocalIndex({ ...options, quiet: true, previous: first });
  assert.equal(reused.stats.reused, 1);
  assert.equal(reused.stats.indexed, 0);
  await fs.writeFile(file, syntheticPdf(["bravo"]));
  await fs.utimes(file, stat.atime, stat.mtime);
  assert.equal((await fs.stat(file)).size, stat.size);
  const replaced = await buildLocalIndex({ ...options, quiet: true, previous: reused });
  assert.equal(replaced.stats.indexed, 1);
  assert.match(replaced.index.entries[0].text, /bravo/u);
  assert.notEqual(replaced.catalog.documents[0].sourceUrl, first.catalog.documents[0].sourceUrl);
});

test("실제 폴더 추가·수정·이름 변경·삭제가 자동 색인과 HTTP 검색 데이터에 반영된다", async (context) => {
  const options = await sandbox(context);
  const service = await startLocalServer({ ...options, port: 0, pollMs: 80, settleMs: 25 });
  context.after(() => service.close());
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const get = async (relative) => (await fetch(`${base}${relative}`)).json();
  async function until(predicate) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const status = await get("/api/index-status");
      const catalog = await get("/private/catalog.json");
      if (status.phase === "ready" && predicate(catalog)) return catalog;
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
    assert.fail("자동 색인 갱신 시간 초과");
  }
  await fs.mkdir(path.join(options.sourceRoot, "nested"));
  const file = path.join(options.sourceRoot, "nested", "guide.pdf");
  await fs.writeFile(file, syntheticPdf(["alpha search"]));
  const added = await until((catalog) => catalog.documents.length === 1);
  const oldRevision = added.generatedAt;
  let index = await get(`/private/search-index.json?revision=${encodeURIComponent(oldRevision)}`);
  assert.match(index.entries[0].text, /alpha search/u);
  assert.equal((await fetch(`${base}/${added.documents[0].sourceUrl}`)).status, 200);
  await fs.mkdir(path.join(options.sourceRoot, "empty"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await get("/private/catalog.json")).generatedAt, oldRevision,
    "empty directory notifications must not replace an unchanged search index");
  await fs.writeFile(file, syntheticPdf(["bravo search"]));
  const changed = await until((catalog) => catalog.generatedAt !== oldRevision);
  index = await get(`/private/search-index.json?revision=${encodeURIComponent(changed.generatedAt)}`);
  assert.match(index.entries[0].text, /bravo search/u);
  const oldIndex = await get(`/private/search-index.json?revision=${encodeURIComponent(oldRevision)}`);
  assert.match(oldIndex.entries[0].text, /alpha search/u);
  await fs.rename(file, path.join(options.sourceRoot, "nested", "renamed.pdf"));
  await until((catalog) => catalog.documents[0]?.name === "renamed.pdf");
  await fs.unlink(path.join(options.sourceRoot, "nested", "renamed.pdf"));
  await until((catalog) => catalog.documents.length === 0);
  assert.equal((await get("/private/search-index.json")).entries.length, 0);
  for (const forbidden of ["/.git/config", "/scripts/serve-local.mjs", "/private/docs/notes.txt", "/private/docs/%2e%2e/package.json", "/README.md"]) {
    assert.equal((await fetch(`${base}${forbidden}`)).status, 404, forbidden);
  }
  assert.equal((await fetch(`${base}/api/index-status`, { method: "POST" })).status, 405);
  assert.match(await (await fetch(`${base}/config.js`)).text(), /profile: "local"/u);
});

test("추출 실패가 나면 검색 성공으로 표시하지 않고 원문 열기는 유지한다", async (context) => {
  const options = await sandbox(context);
  await fs.writeFile(path.join(options.sourceRoot, "damaged.pdf"), "not a PDF");
  const service = await startLocalServer({ ...options, port: 0, pollMs: 100, settleMs: 10 });
  context.after(() => service.close());
  assert.equal(service.state.phase, "error");
  assert.equal(service.state.stats.failures, 1);
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const catalog = await (await fetch(`${base}/private/catalog.json`)).json();
  assert.equal(catalog.documents[0].indexStatus, "error");
  assert.equal((await fetch(`${base}/${catalog.documents[0].sourceUrl}`)).status, 200);
});

test("CloudStorage 폴더는 파일 감시 없이 주기적 확인만으로 추가·삭제를 반영한다", async (context) => {
  const options = await sandbox(context);
  options.sourceRoot = path.join(options.root, "CloudStorage", "source");
  await fs.mkdir(options.sourceRoot, { recursive: true });
  const service = await startLocalServer({ ...options, port: 0, pollMs: 60, settleMs: 15 });
  context.after(() => service.close());
  const file = path.join(options.sourceRoot, "guide.pdf");
  await fs.writeFile(file, syntheticPdf(["automatic folder index"]));
  async function waitForCount(count) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (service.state.phase === "ready" && service.state.stats.documents === count) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.fail("주기적 폴더 확인 실패");
  }
  await waitForCount(1);
  await fs.unlink(file);
  await waitForCount(0);
});
