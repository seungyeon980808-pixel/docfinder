import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexCli = path.join(appRoot, "scripts", "build-local-index.mjs");

function runPublic(source, output, previous) {
  const argumentsList = [indexCli, "--public", source, "--manifest", output];
  if (previous) argumentsList.push("--previous", previous);
  return spawnSync(process.execPath, argumentsList, { encoding: "utf8" });
}

function blankPdf() {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>\nendobj\n",
    "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n"
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body));
    body += object;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return body;
}

test("local indexing keeps its legacy behavior of ignoring unsupported regular files", async (context) => {
  // Given: an isolated copy of the local CLI and a folder containing only an unsupported file.
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "docfinder-local-characterization-"));
  context.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const isolatedApp = path.join(sandbox, "app");
  const source = path.join(sandbox, "source");
  await mkdir(path.join(isolatedApp, "scripts"), { recursive: true });
  await mkdir(path.join(isolatedApp, "private"), { recursive: true });
  await mkdir(source);
  await writeFile(path.join(source, "notes.txt"), "legacy local-only fixture");
  await writeFile(
    path.join(isolatedApp, "scripts", "build-local-index.mjs"),
    await readFile(path.join(appRoot, "scripts", "build-local-index.mjs"))
  );
  await writeFile(
    path.join(isolatedApp, "scripts", "public-corpus.mjs"),
    await readFile(path.join(appRoot, "scripts", "public-corpus.mjs"))
  );
  await symlink(path.join(appRoot, "node_modules"), path.join(isolatedApp, "node_modules"), "dir");
  await symlink(path.join(appRoot, "vendor"), path.join(isolatedApp, "vendor"), "dir");

  // When: the unchanged local index CLI runs against that folder.
  const result = spawnSync(process.execPath, [path.join(isolatedApp, "scripts", "build-local-index.mjs"), source], {
    encoding: "utf8"
  });

  // Then: it succeeds and emits an empty local catalog, preserving the pre-publication behavior.
  assert.equal(result.status, 0, result.stderr);
  const catalog = JSON.parse(await readFile(path.join(isolatedApp, "private", "catalog.json"), "utf8"));
  assert.deepEqual(catalog.documents, []);
});

test("public indexing rejects an unsupported regular file without publishing an artifact", async (context) => {
  // Given: an otherwise empty source folder containing a regular file outside the publication allowlist.
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "docfinder-public-unsupported-"));
  context.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const source = path.join(sandbox, "source");
  const output = path.join(sandbox, "manifest.json");
  await mkdir(source);
  await writeFile(path.join(source, "notes.txt"), "must never be silently omitted");
  await writeFile(output, "stale publication state");

  // When: publication-safe indexing is requested.
  const result = runPublic(source, output);

  // Then: the CLI identifies the unsupported-file boundary and leaves no artifact behind.
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported regular file/u);
  assert.doesNotMatch(result.stderr, /must never be silently omitted/u);
  assert.equal(result.stdout, "");
  assert.equal(fs.existsSync(output), false);
});

test("public indexing accepts the approved root symlink and reports a nested Unicode textless PDF", async (context) => {
  // Given: a root symlink to a nested Unicode corpus containing a valid scanned-style PDF and OS housekeeping.
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "docfinder-public-unicode-"));
  context.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const actualRoot = path.join(sandbox, "approved");
  const sourceLink = path.join(sandbox, "docs");
  const output = path.join(sandbox, "manifest.json");
  await mkdir(path.join(actualRoot, "과학 자료"), { recursive: true });
  await writeFile(path.join(actualRoot, "과학 자료", "안내.pdf"), blankPdf());
  await writeFile(path.join(actualRoot, ".DS_Store"), "ignored housekeeping");
  await symlink(actualRoot, sourceLink, "dir");

  // When: the actual publication CLI indexes the symlinked root.
  const result = runPublic(sourceLink, output);

  // Then: one deterministic metadata record is produced and the missing text is explicitly warned about.
  assert.equal(result.status, 0, result.stderr);
  const first = JSON.parse(await readFile(output, "utf8"));
  assert.equal(first.manifest.documents.length, 1);
  assert.deepEqual(first.manifest.delta, { added: [first.manifest.documents[0].id], changed: [], removed: [] });
  assert.match(first.manifest.documents[0].id, /^doc-[0-9a-f]{24}$/u);
  assert.equal(first.manifest.documents[0].relativePath, "과학 자료/안내.pdf");
  assert.equal(first.manifest.documents[0].format, "pdf");
  assert.match(first.manifest.documents[0].sha256, /^[0-9a-f]{64}$/u);
  assert.equal(first.manifest.documents[0].extractionStatus, "textless");
  assert.equal(first.manifest.documents[0].textlessPageCount, 1);
  assert.deepEqual(first.manifest.warnings, [{ id: first.manifest.documents[0].id, code: "textless-pages", count: 1 }]);
  assert.equal(first.entries[0].text, "");
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /ignored housekeeping/u);

  const secondOutput = path.join(sandbox, "manifest-second.json");
  const secondResult = runPublic(sourceLink, secondOutput);
  assert.equal(secondResult.status, 0, secondResult.stderr);
  assert.deepEqual(JSON.parse(await readFile(secondOutput, "utf8")), first);
});

test("public indexing compares exact IDs for added changed and removed originals", async (context) => {
  // Given: an initial two-document snapshot.
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "docfinder-public-delta-"));
  context.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const source = path.join(sandbox, "source");
  const previous = path.join(sandbox, "previous.json");
  const output = path.join(sandbox, "next.json");
  await mkdir(source);
  await writeFile(path.join(source, "keep.pdf"), blankPdf());
  await writeFile(path.join(source, "remove.pdf"), blankPdf());
  assert.equal(runPublic(source, previous).status, 0);
  const before = JSON.parse(await readFile(previous, "utf8"));
  const keepId = before.manifest.documents.find((document) => document.relativePath === "keep.pdf").id;
  const removeId = before.manifest.documents.find((document) => document.relativePath === "remove.pdf").id;
  await writeFile(path.join(source, "keep.pdf"), `${blankPdf()}\n`);
  await rm(path.join(source, "remove.pdf"));
  await writeFile(path.join(source, "added.pdf"), blankPdf());

  // When: the next snapshot is built against the prior generated manifest.
  const result = runPublic(source, output, previous);

  // Then: the delta identifies each exact stable ID without retaining stale entries.
  assert.equal(result.status, 0, result.stderr);
  const after = JSON.parse(await readFile(output, "utf8"));
  const addedId = after.manifest.documents.find((document) => document.relativePath === "added.pdf").id;
  assert.deepEqual(after.manifest.delta, { added: [addedId], changed: [keepId], removed: [removeId] });
  assert.equal(after.manifest.documents.some((document) => document.id === removeId), false);
});

test("public indexing rejects an out-of-root nested symlink", async (context) => {
  // Given: a source tree with a nested link to a supported file outside the approved root.
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "docfinder-public-symlink-"));
  context.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const source = path.join(sandbox, "source");
  const outside = path.join(sandbox, "outside.pdf");
  const output = path.join(sandbox, "manifest.json");
  await mkdir(source);
  await writeFile(outside, blankPdf());
  await symlink(outside, path.join(source, "linked.pdf"));

  // When: public indexing inspects the tree.
  const result = runPublic(source, output);

  // Then: nested links are rejected before extraction and no artifact is produced.
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /nested symlink/u);
  assert.equal(fs.existsSync(output), false);
});

test("public indexing makes extraction failures fatal", async (context) => {
  // Given: a supported extension whose bytes cannot be parsed as that document type.
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "docfinder-public-extraction-"));
  context.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const source = path.join(sandbox, "source");
  const output = path.join(sandbox, "manifest.json");
  await mkdir(source);
  await writeFile(path.join(source, "broken.pdf"), "not a PDF");

  // When: publication indexing attempts extraction.
  const result = runPublic(source, output);

  // Then: it fails closed without an artifact or a misleading success line.
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /extraction failed/u);
  assert.equal(result.stdout, "");
  assert.equal(fs.existsSync(output), false);
});

test("public indexing rejects malformed previous state and removes stale output", async (context) => {
  // Given: valid source input but malformed prior state and a stale destination artifact.
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "docfinder-public-stale-"));
  context.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const source = path.join(sandbox, "source");
  const previous = path.join(sandbox, "previous.json");
  const output = path.join(sandbox, "manifest.json");
  await mkdir(source);
  await writeFile(path.join(source, "valid.pdf"), blankPdf());
  await writeFile(previous, "{invalid");
  await writeFile(output, "stale");

  // When: the CLI is asked to compare with malformed state.
  const result = runPublic(source, output, previous);

  // Then: it fails closed and stale state cannot masquerade as the new artifact.
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /malformed previous manifest/u);
  assert.equal(result.stdout, "");
  assert.equal(fs.existsSync(output), false);
});
