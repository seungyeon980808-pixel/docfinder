import assert from "node:assert/strict";
import test from "node:test";
import { authorizeDrive, DRIVE_FILE_SCOPE, ensureDriveLibrary, listUploadedDocuments, uploadDriveFile } from "../js/drive-api.js";

const json = (value, init) => new Response(JSON.stringify(value), init);

test("authorization requests only per-file scope and rejects a missing grant", async (context) => {
  const old = globalThis.google; context.after(() => { globalThis.google = old; });
  let granted = true, config;
  globalThis.google = { accounts: { oauth2: { initTokenClient(value) {
    config = value;
    return { requestAccessToken() { value.callback({ access_token: "token", scope: granted ? DRIVE_FILE_SCOPE : "" }); } };
  } } } };
  assert.equal(await authorizeDrive("client"), "token");
  assert.equal(config.scope, DRIVE_FILE_SCOPE); assert.equal(config.include_granted_scopes, false);
  granted = false; await assert.rejects(() => authorizeDrive("client"), /권한/u);
});

test("folder and document discovery use app-private tags and paginate", async (context) => {
  const old = globalThis.fetch; context.after(() => { globalThis.fetch = old; });
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input); calls.push({ url, init });
    assert.equal(init.headers.Authorization, "Bearer token");
    if (init.method === "POST") return json({ id: "folder", name: "DocFinder" });
    const q = url.searchParams.get("q");
    if (q.includes("docfinderLibrary")) return json({ files: [] });
    assert.match(q, /docfinderDocument/); assert.match(q, /'folder' in parents/);
    return url.searchParams.get("pageToken") ? json({ files: [{ id: "b", name: "second.hwpx" }] })
      : json({ files: [{ id: "a", name: "first.pdf" }, { id: "no", name: "note.txt" }], nextPageToken: "next" });
  };
  assert.equal((await ensureDriveLibrary("token")).id, "folder");
  assert.deepEqual((await listUploadedDocuments("token", "folder")).map((item) => item.id), ["a", "b"]);
  const create = JSON.parse(calls.find(({ init }) => init.method === "POST").init.body);
  assert.deepEqual(create.appProperties, { docfinderLibrary: "1" });
});

test("resumable upload sends file metadata and ordered chunks and returns completion", async (context) => {
  const old = globalThis.fetch; context.after(() => { globalThis.fetch = old; });
  const file = new File([new Uint8Array(8 * 1024 * 1024 + 3)], "large.pdf");
  const calls = [], progress = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    if (init.method === "POST") {
      assert.deepEqual(JSON.parse(init.body).parents, ["folder"]);
      assert.deepEqual(JSON.parse(init.body).appProperties, { docfinderDocument: "1" });
      return new Response(null, { headers: { Location: "https://www.googleapis.com/upload/drive/v3/files?upload_id=session" } });
    }
    assert.equal(init.headers.Authorization, "Bearer token");
    if (calls.length === 2) return new Response(null, { status: 308, headers: { Range: "bytes=0-8388607" } });
    return json({ id: "uploaded", name: file.name, size: String(file.size), mimeType: "application/pdf" });
  };
  const item = await uploadDriveFile("token", file, "folder", { onProgress: (value) => progress.push(value.loaded) });
  assert.equal(item.id, "uploaded");
  assert.deepEqual(calls.slice(1).map(({ init }) => init.headers["Content-Range"]), ["bytes 0-8388607/8388611", "bytes 8388608-8388610/8388611"]);
  assert.deepEqual(calls.slice(1).map(({ init }) => init.body.size), [8388608, 3]);
  assert.deepEqual(progress, [0, 8388608, 8388611]);
});

test("invalid upload destinations and stalled sessions never receive additional credentialed writes", async (context) => {
  const old = globalThis.fetch; context.after(() => { globalThis.fetch = old; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(null, { headers: { Location: "https://outside.example/upload" } }); };
  await assert.rejects(() => uploadDriveFile("token", new File(["x"], "a.pdf"), "folder"), /올바르지/u);
  assert.equal(calls, 1);
  calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? new Response(null, { headers: { Location: "https://www.googleapis.com/upload/drive/v3/files" } })
    : new Response(null, { status: 308 });
  await assert.rejects(() => uploadDriveFile("token", new File(["x"], "a.pdf"), "folder"), /진행/u);
  assert.equal(calls, 2);
});
