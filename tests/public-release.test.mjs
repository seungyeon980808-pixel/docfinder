import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { searchLocalIndex } from "../js/local-index.js";
import { diffReleaseDocuments, validatePublicRelease } from "./public-release-lib.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function makeRelease(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "docfinder-release-"));
  context.after(() => fsSync.rmSync(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "library", "originals"), { recursive: true });
  await Promise.all(["index.html", "config.js", "_headers"].map((name) => fs.writeFile(path.join(root, name), "fixture")));
  const fixtures = [
    { id: "doc-111111111111111111111111", name: "alpha-guide.pdf", format: "pdf", bytes: Buffer.from("%PDF synthetic alpha") },
    { id: "doc-222222222222222222222222", name: "beta-form.hwp", format: "hwp", bytes: Buffer.from("HWP synthetic beta") },
    { id: "doc-333333333333333333333333", name: "gamma-form.hwpx", format: "hwpx", bytes: Buffer.from("HWPX synthetic gamma") }
  ];
  const documents = [];
  const manifestDocuments = [];
  for (const fixture of fixtures) {
    const digest = hash(fixture.bytes);
    const sourceUrl = `originals/${fixture.id}.${digest.slice(0, 16)}.${fixture.format}`;
    await fs.writeFile(path.join(root, "library", sourceUrl), fixture.bytes);
    documents.push({ id: fixture.id, name: fixture.name, folder: "Synthetic", path: `Synthetic / ${fixture.name}`, format: fixture.format, size: fixture.bytes.length, sourceUrl });
    manifestDocuments.push({ id: fixture.id, format: fixture.format, size: fixture.bytes.length, sha256: digest, originalUrl: sourceUrl });
  }
  const write = (name, value) => fs.writeFile(path.join(root, "library", name), JSON.stringify(value));
  await Promise.all([
    write("catalog.json", { version: 1, documents }),
    write("search-index.json", { version: 1, entries: [
      { id: fixtures[0].id, page: 1, text: "alpha near beta" },
      { id: fixtures[1].id, page: 1, text: "alpha words separated across a much longer synthetic passage beta" },
      { id: fixtures[2].id, page: null, text: "\u200b" }
    ] }),
    write("manifest.json", { version: 1, documents: manifestDocuments, delta: { added: fixtures.map(({ id }) => id), changed: [], removed: [] }, warnings: [] })
  ]);
  return { root, documents, manifestDocuments };
}

test("staged artifact has an exact corpus, sanitized same-origin URLs, hashes, and no forbidden paths", async (context) => {
  const fixture = await makeRelease(context);
  const result = await validatePublicRelease(fixture.root);
  assert.deepEqual(result.formats, { hwp: 1, hwpx: 1, pdf: 1 });
  assert.equal(result.documentCount, 3);
  assert.match(result.manifestSha256, /^[0-9a-f]{64}$/u);
});

test("staged artifact validation fails closed for a missing original and a fake secret path", async (context) => {
  const missing = await makeRelease(context);
  await fs.rm(path.join(missing.root, "library", missing.documents[0].sourceUrl));
  await assert.rejects(validatePublicRelease(missing.root), /original set differs/u);

  const forbidden = await makeRelease(context);
  await fs.mkdir(path.join(forbidden.root, "private"));
  await fs.writeFile(path.join(forbidden.root, "private", "fake-secret.txt"), "not-a-secret");
  await assert.rejects(validatePublicRelease(forbidden.root), /forbidden path/u);
});

test("release comparison reports exact added, changed, and removed IDs", () => {
  const previous = [{ id: "kept", sha256: "same" }, { id: "changed", sha256: "old" }, { id: "removed", sha256: "gone" }];
  const current = [{ id: "added", sha256: "new" }, { id: "changed", sha256: "new" }, { id: "kept", sha256: "same" }];
  assert.deepEqual(diffReleaseDocuments(previous, current), { added: ["added"], changed: ["changed"], removed: ["removed"] });
});

test("public filename/content fixtures preserve proximity order and mark textless HWPX unsearchable", async (context) => {
  const { documents } = await makeRelease(context);
  assert.deepEqual(documents.filter((document) => document.name.includes("beta")).map(({ id }) => id), ["doc-222222222222222222222222"]);
  const entries = [
    { id: documents[0].id, page: 1, text: "alpha beta" },
    { id: documents[1].id, page: 1, text: "alpha words separated across a much longer passage beta" },
    { id: documents[2].id, page: null, text: "\u200b" }
  ];
  assert.deepEqual(searchLocalIndex(documents, entries, "alpha beta").map(({ id }) => id), [documents[0].id, documents[1].id]);
  assert.equal(searchLocalIndex(documents, entries, "unavailable-text").length, 0);
});
