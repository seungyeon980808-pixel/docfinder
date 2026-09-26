import assert from "node:assert/strict";
import test from "node:test";

import { loadPublicSnapshot } from "../js/store.js";

const urls = {
  catalog: "https://example.test/library/catalog.json",
  searchIndex: "https://example.test/library/search-index.json"
};

function fetchPublicMetadata(documents) {
  return async (input) => new Response(JSON.stringify(
    String(input).endsWith("catalog.json")
      ? { version: 1, documents }
      : { version: 1, entries: documents.map((documentItem) => ({ id: documentItem.id, page: 1, text: "safe searchable text" })) }
  ));
}

function publicDocument(format) {
  return {
    id: `document-${format}`,
    name: `fixture.${format}`,
    format,
    sourceUrl: `originals/document-${format}.${format}`
  };
}

test("public snapshot preserves the supported PDF, HWP, and HWPX formats", async () => {
  const documents = ["pdf", "hwp", "hwpx"].map(publicDocument);

  const snapshot = await loadPublicSnapshot(urls, "https://example.test/", fetchPublicMetadata(documents));

  assert.deepEqual(snapshot.documents.map((documentItem) => documentItem.format), ["pdf", "hwp", "hwpx"]);
});

test("public snapshot rejects a markup-bearing format before it reaches the document renderer", async () => {
  const documents = [publicDocument('<img src=x onerror="globalThis.__publicCatalogXss = true">')];

  await assert.rejects(
    loadPublicSnapshot(urls, "https://example.test/", fetchPublicMetadata(documents)),
    /Public catalog document format is invalid/u
  );
});

test("public snapshot rejects explicit non-enum formats instead of inferring a filename extension", async () => {
  for (const format of ["", null, 0, "PDF"]) {
    const documents = [{
      id: "document-invalid-format",
      name: "fixture.pdf",
      format,
      sourceUrl: "originals/document-invalid-format.pdf"
    }];

    await assert.rejects(
      loadPublicSnapshot(urls, "https://example.test/", fetchPublicMetadata(documents)),
      /Public catalog document format is invalid/u
    );
  }
});
