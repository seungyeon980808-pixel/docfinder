import assert from "node:assert/strict";
import test from "node:test";

import * as buildConfig from "../config.js";
import { buildPdfEditorUrl } from "../js/pdf-editor.js";
import * as boot from "../js/store.js";

const { DEFAULT_CONFIG } = buildConfig;
const { loadSettings } = boot;

const PUBLIC_SNAPSHOT_URLS = {
  catalog: "https://example.test/apps/docfinder/library/catalog.json",
  searchIndex: "https://example.test/apps/docfinder/library/search-index.json"
};
const PUBLIC_APP_BASE_URL = "https://example.test/apps/docfinder/";

function publicMetadataFetcher(documents, entries) {
  return async (input) => new Response(JSON.stringify(
    String(input).endsWith("catalog.json")
      ? { version: 1, documents }
      : { version: 1, entries }
  ));
}

function validPublicDocument(overrides = {}) {
  return {
    id: "opaque-a",
    name: "fixture-a.pdf",
    sourceUrl: "originals/opaque-a.pdf",
    ...overrides
  };
}

async function assertPublicMetadataRejected(
  documents = [validPublicDocument()],
  entries = [{ id: "opaque-a", page: 1, text: "fixture" }]
) {
  await assert.rejects(
    boot.loadPublicSnapshot(
      PUBLIC_SNAPSHOT_URLS,
      PUBLIC_APP_BASE_URL,
      publicMetadataFetcher(documents, entries)
    ),
    (error) => error instanceof TypeError
  );
}

function useMemoryStorage(context, entries = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map(Object.entries(entries));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value))
    }
  });
  context.after(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  });
}

test("private boot keeps saved browser settings", (context) => {
  // Given: a private build and an existing browser preference.
  useMemoryStorage(context, {
    "5e-manual-library-settings-v1": JSON.stringify({ demoMode: false, rootFolderId: "saved-private-folder" })
  });

  // When: the legacy private settings are loaded.
  const settings = loadSettings(DEFAULT_CONFIG);

  // Then: the saved private preference still wins over the default.
  assert.equal(settings.demoMode, false);
  assert.equal(settings.rootFolderId, "saved-private-folder");
});

test("public boot ignores saved OAuth, folder, and demo settings", (context) => {
  // Given: stale private browser state and a hosted-public build profile.
  useMemoryStorage(context, {
    "5e-manual-library-settings-v1": JSON.stringify({
      googleClientId: "stale-oauth-client",
      rootFolderId: "stale-drive-folder",
      pdfEditorUrl: "https://stale-editor.invalid/",
      demoMode: true
    })
  });

  // When: settings are loaded for the public profile.
  const settings = loadSettings(DEFAULT_CONFIG, {
    profile: "public",
    settings: { appName: "Fixture Finder", pdfEditorUrl: "./editor/" },
    forceDemo: true
  });

  // Then: only build-supplied public settings survive.
  assert.deepEqual(settings, {
    ...DEFAULT_CONFIG,
    appName: "Fixture Finder",
    googleClientId: "",
    rootFolderId: "",
    pdfEditorUrl: "./editor/",
    demoMode: false
  });
});

test("public snapshot URLs stay below root and nested deployment paths", () => {
  // Given: the same config module hosted at two deployment depths.
  assert.equal(typeof buildConfig.resolvePublicSnapshotUrls, "function");

  // When: its public asset URLs are resolved.
  const root = buildConfig.resolvePublicSnapshotUrls("https://example.test/config.js");
  const nested = buildConfig.resolvePublicSnapshotUrls("https://example.test/apps/docfinder/config.js");

  // Then: catalog and index stay relative to each app base.
  assert.deepEqual(root, {
    catalog: "https://example.test/library/catalog.json",
    searchIndex: "https://example.test/library/search-index.json"
  });
  assert.deepEqual(nested, {
    catalog: "https://example.test/apps/docfinder/library/catalog.json",
    searchIndex: "https://example.test/apps/docfinder/library/search-index.json"
  });
});

test("public snapshot boot fetches both metadata files and strips Drive URLs", async () => {
  // Given: a catalog that contains a stale Drive field beside a hosted original.
  assert.equal(typeof boot.loadPublicSnapshot, "function");
  const requests = [];
  const fetcher = async (input) => {
    requests.push(String(input));
    if (String(input).endsWith("catalog.json")) {
      return new Response(JSON.stringify({
        version: 1,
        generatedAt: "2026-09-26T00:00:00.000Z",
        documents: [{
          id: "opaque-a",
          name: "fixture-a.pdf",
          folder: "Fixture",
          path: "Fixture / fixture-a.pdf",
          format: "pdf",
          size: 4,
          modifiedTime: "2026-09-25T00:00:00.000Z",
          sourceUrl: "originals/opaque-a.pdf",
          webViewLink: "https://drive.google.com/file/d/secret/view"
        }]
      }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      version: 1,
      entries: [{ id: "opaque-a", page: 1, text: "fixture searchable words" }]
    }), { headers: { "content-type": "application/json" } });
  };

  // When: the public profile boots beneath a nested app path.
  const snapshot = await boot.loadPublicSnapshot({
    catalog: "https://example.test/apps/docfinder/library/catalog.json",
    searchIndex: "https://example.test/apps/docfinder/library/search-index.json"
  }, "https://example.test/apps/docfinder/", fetcher);

  // Then: both files load and every file action points to the hosted original.
  assert.deepEqual(requests, [
    "https://example.test/apps/docfinder/library/catalog.json",
    "https://example.test/apps/docfinder/library/search-index.json"
  ]);
  assert.equal(snapshot.documents[0].source, "public");
  assert.equal(snapshot.documents[0].sourceUrl, "https://example.test/apps/docfinder/library/originals/opaque-a.pdf");
  assert.equal(snapshot.documents[0].previewUrl, snapshot.documents[0].sourceUrl);
  assert.equal(snapshot.documents[0].downloadUrl, snapshot.documents[0].sourceUrl);
  assert.equal("webViewLink" in snapshot.documents[0], false);
  assert.deepEqual(snapshot.indexEntries, [{ id: "opaque-a", page: 1, text: "fixture searchable words" }]);
});

test("public snapshot boot fetches metadata from an app hosted at the origin root", async () => {
  // Given: root-relative public metadata URLs and a synthetic metadata responder.
  const requests = [];
  const fetcher = async (input) => {
    requests.push(String(input));
    const payload = String(input).endsWith("catalog.json")
      ? { version: 1, documents: [] }
      : { version: 1, entries: [] };
    return new Response(JSON.stringify(payload));
  };

  // When: the root-hosted public profile boots.
  await boot.loadPublicSnapshot(
    buildConfig.resolvePublicSnapshotUrls("https://example.test/config.js"),
    "https://example.test/",
    fetcher
  );

  // Then: both requests remain under the root app's library path.
  assert.deepEqual(requests, [
    "https://example.test/library/catalog.json",
    "https://example.test/library/search-index.json"
  ]);
});

test("public snapshot boot rejects a same-origin private document URL", async () => {
  // Given: public metadata that attempts to point a document outside library/originals.
  const fetcher = async (input) => new Response(JSON.stringify(
    String(input).endsWith("catalog.json")
      ? { version: 1, documents: [{ id: "opaque-a", name: "fixture-a.pdf", sourceUrl: "../../private/docs/fixture-a.pdf" }] }
      : { version: 1, entries: [] }
  ));

  // When/Then: boot fails before the private URL can become an actionable document source.
  await assert.rejects(
    boot.loadPublicSnapshot({
      catalog: "https://example.test/apps/docfinder/library/catalog.json",
      searchIndex: "https://example.test/apps/docfinder/library/search-index.json"
    }, "https://example.test/apps/docfinder/", fetcher),
    /must be hosted with the app/u
  );
});

test("rejects malformed public metadata: catalog documents with empty or whitespace-only IDs", async () => {
  // Given: catalog documents whose IDs carry no usable identity.
  for (const id of ["", " \t"]) {
    // When/Then: the metadata boundary rejects the malformed catalog record.
    await assertPublicMetadataRejected([validPublicDocument({ id })]);
  }
});

test("rejects malformed public metadata: catalog documents with empty or whitespace-only names", async () => {
  // Given: catalog documents whose names carry no usable label.
  for (const name of ["", " \t"]) {
    // When/Then: the metadata boundary rejects the malformed catalog record.
    await assertPublicMetadataRejected([validPublicDocument({ name })]);
  }
});

test("rejects malformed public metadata: duplicate catalog document IDs", async () => {
  // Given: two catalog records claiming the same document identity.
  const documents = [
    validPublicDocument(),
    validPublicDocument({ name: "fixture-b.pdf", sourceUrl: "originals/fixture-b.pdf" })
  ];

  // When/Then: the metadata boundary rejects the duplicate identity.
  await assertPublicMetadataRejected(documents);
});

test("rejects malformed public metadata: search-index entries with missing or empty IDs", async () => {
  // Given: index entries whose IDs carry no usable identity.
  for (const entry of [
    { page: 1, text: "fixture" },
    { id: "", page: 1, text: "fixture" },
    { id: " \t", page: 1, text: "fixture" }
  ]) {
    // When/Then: the metadata boundary rejects the malformed index record.
    await assertPublicMetadataRejected(undefined, [entry]);
  }
});

test("rejects malformed public metadata: search-index entries that are not in the catalog", async () => {
  // Given: an index entry whose document identity is absent from the catalog.
  // When/Then: the metadata boundary rejects the orphaned index record.
  await assertPublicMetadataRejected(undefined, [{ id: "orphan", page: 1, text: "fixture" }]);
});

test("rejects malformed public metadata: search-index entries with invalid text", async () => {
  // Given: index entries whose searchable text is missing usable content.
  for (const text of [null, "", " \t"]) {
    // When/Then: the metadata boundary rejects the malformed index record.
    await assertPublicMetadataRejected(undefined, [{ id: "opaque-a", page: 1, text }]);
  }
});

test("rejects malformed public metadata: search-index entries with invalid pages", async () => {
  // Given: page values that are neither null nor positive safe integers.
  for (const page of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", undefined]) {
    // When/Then: the metadata boundary rejects the malformed index record.
    await assertPublicMetadataRejected(undefined, [{ id: "opaque-a", page, text: "fixture" }]);
  }
});

test("public snapshot preserves null pages for textless entries", async () => {
  // Given: a valid textless index entry with no page association.
  // When: the public profile boots.
  const snapshot = await boot.loadPublicSnapshot(
    PUBLIC_SNAPSHOT_URLS,
    PUBLIC_APP_BASE_URL,
    publicMetadataFetcher(
      [validPublicDocument()],
      [{ id: "opaque-a", page: null, text: "fixture" }]
    )
  );

  // Then: the valid null page remains null in runtime state.
  assert.deepEqual(snapshot.indexEntries, [{ id: "opaque-a", page: null, text: "fixture" }]);
});

test("public deep links select an existing ID and safely fall back for a missing ID", () => {
  // Given: two public documents ordered by update time.
  assert.equal(typeof boot.selectSnapshotDocumentId, "function");
  const documents = [
    { id: "older", modifiedTime: "2026-01-01T00:00:00.000Z" },
    { id: "newer", modifiedTime: "2026-09-01T00:00:00.000Z" }
  ];

  // When/Then: a valid ID wins, while a missing ID selects the newest document.
  assert.equal(boot.selectSnapshotDocumentId(documents, "older"), "older");
  assert.equal(boot.selectSnapshotDocumentId(documents, "missing"), "newer");
});

test("PDF editor handoff prefers the hosted original over a Drive URL", () => {
  // Given: a normalized public document with an accidentally retained Drive field.
  const documentItem = {
    id: "opaque-a",
    name: "fixture-a.pdf",
    sourceUrl: "https://example.test/apps/docfinder/library/originals/opaque-a.pdf",
    webViewLink: "https://drive.google.com/file/d/secret/view"
  };

  // When: an external editor URL is built.
  const result = new URL(buildPdfEditorUrl("https://editor.example/open", documentItem));

  // Then: the editor receives only the hosted original URL.
  assert.equal(result.searchParams.get("source"), documentItem.sourceUrl);
  assert.equal(result.href.includes("drive.google.com"), false);
});
