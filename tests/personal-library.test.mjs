import assert from "node:assert/strict";
import test from "node:test";
import { createPersonalLibrary } from "../js/personal-library.js";
import { createPersonalCache } from "../js/personal-cache.js";

function setup() {
  let account = "one", uploaded = 0, extracted = 0, downloaded = 0, fail = false;
  const cloud = new Map([["one", []], ["two", []]]);
  const events = [];
  const cache = createPersonalCache(null);
  const api = {
    authorizeDrive: async () => account,
    getDriveUser: async (token) => ({ permissionId: token, displayName: token }),
    ensureDriveLibrary: async () => ({ id: "folder" }),
    listUploadedDocuments: async (token) => cloud.get(token),
    downloadDriveFile: async () => { downloaded++; return new ArrayBuffer(3); },
    uploadDriveFile: async (token, file, _folder, { onProgress }) => {
      uploaded++; onProgress({ loaded: file.size, total: file.size });
      const item = { id: `uploaded-${uploaded}`, name: file.name, format: "pdf", source: "drive", modifiedTime: "2026-01-01", size: file.size };
      cloud.get(token).push(item); return item;
    }
  };
  const indexer = { cancel() {}, async extract(_format, _bytes, onProgress) {
    extracted++; onProgress({ page: 1, total: 2 });
    if (fail) throw new Error("encrypted");
    return [{ page: 1, text: "alpha" }, { page: 2, text: "beta" }];
  } };
  const library = createPersonalLibrary({ api, cache, indexer, onChange: (event) => events.push(event) });
  return { library, cache, events, cloud, api, indexer,
    set account(value) { account = value; }, set fail(value) { fail = value; },
    get counts() { return { uploaded, extracted, downloaded }; } };
}
const file = () => new File(["pdf"], "fixture.pdf", { lastModified: 100 });

test("Drive upload automatically indexes the selected original and reconnect reuses its private index", async () => {
  const fixture = setup();
  await fixture.library.connect("client");
  await fixture.library.upload([file()]);
  let state = fixture.library.snapshot();
  assert.equal(state.documents[0].indexStatus, "ready");
  assert.deepEqual(state.entries.map(({ page, text }) => [page, text]), [[1, "alpha"], [2, "beta"]]);
  assert.ok(fixture.events.some((event) => /업로드/u.test(event.progress)));
  assert.ok(fixture.events.some((event) => /색인 1\/2/u.test(event.progress)));
  assert.equal((await fixture.library.getBytes(state.documents[0])).byteLength, 3);
  fixture.library.disconnect();
  await fixture.library.connect("client");
  assert.deepEqual(fixture.counts, { uploaded: 1, extracted: 1, downloaded: 0 });
  const records = await fixture.cache.read("drive:one:folder");
  assert.equal(records[0].original, undefined, "Drive originals must not be persisted");
  assert.equal(JSON.stringify(records).includes("accessToken"), false);
});

test("failed extraction can retry without creating a duplicate Drive file", async () => {
  const fixture = setup(); fixture.fail = true;
  await fixture.library.connect("client"); await fixture.library.upload([file()]);
  const item = fixture.library.snapshot().documents[0];
  assert.equal(item.indexStatus, "error"); assert.equal(fixture.library.snapshot().entries.length, 0);
  fixture.fail = false; await fixture.library.retry(item);
  assert.equal(fixture.library.snapshot().documents[0].indexStatus, "ready");
  assert.deepEqual(fixture.counts, { uploaded: 1, extracted: 2, downloaded: 0 });
});

test("changing accounts clears results and cannot read the previous account's originals", async () => {
  const fixture = setup(); await fixture.library.connect("client"); await fixture.library.upload([file()]);
  const old = fixture.library.snapshot().documents[0];
  fixture.account = "two"; await fixture.library.connect("client");
  assert.deepEqual(fixture.library.snapshot().documents, []);
  await assert.rejects(() => fixture.library.getBytes(old), /다시 연결/u);
  assert.equal(fixture.library.snapshot().libraryId, "drive:two:folder");
});

test("refresh indexes changed files and prunes removed documents", async () => {
  const fixture = setup(); await fixture.library.connect("client"); await fixture.library.upload([file()]);
  fixture.cloud.get("one")[0].modifiedTime = "2026-01-02";
  await fixture.library.sync(); assert.equal(fixture.counts.extracted, 2);
  assert.equal(fixture.counts.downloaded, 1);
  fixture.cloud.set("one", []); await fixture.library.sync();
  assert.equal(fixture.library.snapshot().entries.length, 0);
  assert.deepEqual(await fixture.cache.read("drive:one:folder"), []);
});

test("disconnect during extraction prevents an obsolete result from returning", async () => {
  const fixture = setup(); let release;
  fixture.indexer.extract = () => new Promise((resolve) => { release = resolve; });
  await fixture.library.connect("client"); const upload = fixture.library.upload([file()]);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  fixture.library.disconnect(); release([{ page: 1, text: "old secret" }]); await upload;
  assert.equal(fixture.library.snapshot().documents.length, 0);
  assert.equal(fixture.library.snapshot().connected, false);
});

test("local imports survive reopening the collection and reject unsupported files before processing", async () => {
  const fixture = setup();
  await fixture.library.importLocal([file()]);
  const old = fixture.library.snapshot().documents[0];
  assert.ok((await fixture.cache.read("browser-local"))[0].original instanceof ArrayBuffer,
    "persist owned bytes, not a Safari picker-backed File");
  fixture.library.disconnect(); await fixture.library.restoreLocal();
  assert.equal(fixture.library.snapshot().documents[0].id, old.id);
  assert.equal((await fixture.library.getBytes(fixture.library.snapshot().documents[0])).byteLength, 3);
  await fixture.library.connect("client");
  await assert.rejects(() => fixture.library.upload([new File(["x"], "note.txt")]), /PDF/u);
  assert.equal(fixture.counts.uploaded, 0);
});
