import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { selectSnapshotDocumentId } from "../js/store.js";

test("automatic catalog refresh retains the selected search result until fresh search completes", async () => {
  const source = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  const functions = source.slice(source.indexOf("async function loadLocalCatalog()"), source.indexOf("function openSettings()"));
  const documents = [{ id: "a", sourceUrl: "a.pdf?v=new", page: null, excerpt: "catalog" },
    { id: "b", sourceUrl: "b.pdf?v=new", page: null, excerpt: "catalog" }, { id: "c", sourceUrl: "c.pdf?v=new" }];
  let state = { selectedId: "b", contentMatches: [{ id: "a", page: 3, excerpt: "first match" },
    { id: "b", sourceUrl: "b.pdf?v=old", page: 84, excerpt: "selected match", matchedPages: [{ page: 84 }] }] };
  const context = vm.createContext({
    fetch: async () => ({ ok: true, json: async () => ({ version: 1, generatedAt: "new-revision", documents }) }),
    store: { get: () => state, update: (updater) => { state = updater(state); } },
    visibleDocuments: (next) => next.contentMatches || [],
    selectSnapshotDocumentId,
    searchClient: { reset() {} },
    localIndexPromise: undefined,
    localRevision: "old-revision",
    deepLinkedId: "",
    localProfile: true
  });
  vm.runInContext(functions, context);
  await context.loadLocalCatalog();
  assert.equal(state.selectedId, "b");
  assert.deepEqual(Array.from(state.results, (item) => item.id), ["a", "b"]);
  assert.equal(state.results[1].sourceUrl, "b.pdf?v=new");
  assert.equal(state.results[1].page, 84);
  assert.equal(state.results[1].excerpt, "selected match");
  assert.equal(state.documents.length, 3);
  assert.equal(context.localRevision, "new-revision");
});
