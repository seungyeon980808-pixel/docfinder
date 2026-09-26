import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";

const appRoot = path.resolve(new URL("../", import.meta.url).pathname);
const builder = path.join(appRoot, "scripts", "build-public-snapshot.mjs");

function blankPdf() {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>\nendobj\n",
    "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n"
  ];
  let body = `${String.fromCharCode(37, 80, 68, 70)}-1.4\n`;
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

function runBuilder(source, output) {
  return spawnSync(process.execPath, [builder, "--source", source, "--output", output], {
    cwd: appRoot,
    encoding: "utf8",
    timeout: 20_000
  });
}

async function makeCorpus(sandbox, filename = "fixture.pdf", contents = blankPdf()) {
  const corpus = path.join(sandbox, "approved");
  await fs.mkdir(corpus, { recursive: true });
  await fs.writeFile(path.join(corpus, filename), contents);
  return corpus;
}

test("source tree remains private and uses only the approved root link", async () => {
  // Given: the checked-out application and its approved local corpus connection.
  const config = await fs.readFile(path.join(appRoot, "config.js"), "utf8");
  const docs = await fs.lstat(path.join(appRoot, "private", "docs"));

  // When: the source build profile and corpus boundary are characterized.
  const nestedEntries = await fs.readdir(path.join(appRoot, "private", "docs"), { withFileTypes: true });

  // Then: source remains private, the root may be a link, and no nested link is accepted as baseline input.
  assert.match(config, /profile:\s*"private"/u);
  assert.equal(docs.isSymbolicLink(), true);
  assert.equal(nestedEntries.some((entry) => entry.isSymbolicLink()), false);
});

test("builder publishes a nested fixture as an atomic public snapshot", async (context) => {
  // Given: an approved root link to a supported document in a nested Unicode folder.
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "docfinder-snapshot-happy-"));
  context.after(() => fsSync.rmSync(sandbox, { recursive: true, force: true }));
  const corpus = path.join(sandbox, "approved");
  const source = path.join(sandbox, "docs");
  const output = path.join(sandbox, "dist");
  await fs.mkdir(path.join(corpus, "과학 자료"), { recursive: true });
  await fs.writeFile(path.join(corpus, "과학 자료", "안내.pdf"), blankPdf());
  await fs.symlink(corpus, source, "dir");

  // When: the public snapshot CLI builds the fixture.
  const result = runBuilder(source, output);

  // Then: the deploy tree is complete, public-only, and refers to one opaque copied original.
  assert.equal(result.status, 0, result.stderr);
  const [catalog, index, manifest, config] = await Promise.all([
    fs.readFile(path.join(output, "library", "catalog.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(output, "library", "search-index.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(output, "library", "manifest.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(output, "config.js"), "utf8")
  ]);
  assert.equal(catalog.documents.length, 1);
  assert.equal(index.entries.length, 1);
  assert.equal(manifest.documents.length, 1);
  assert.match(config, /profile:\s*"public"/u);
  assert.match(catalog.documents[0].sourceUrl, /^originals\/doc-[0-9a-f]{24}\.[0-9a-f]{16}\.pdf$/u);
  const copied = await fs.readFile(path.join(output, "library", catalog.documents[0].sourceUrl));
  assert.equal(copied.toString(), blankPdf());
  assert.equal(createHash("sha256").update(copied).digest("hex"), manifest.documents[0].sha256);
  assert.deepEqual(
    [catalog.documents.map(({ id }) => id), [...new Set(index.entries.map(({ id }) => id))], manifest.documents.map(({ id }) => id)],
    [[manifest.documents[0].id], [manifest.documents[0].id], [manifest.documents[0].id]]
  );
  assert.doesNotMatch(JSON.stringify({ catalog, index, manifest }), /private\/docs|drive\.google|googleClientId|rootFolderId/u);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /안내\.pdf/u);
  assert.match(await fs.readFile(path.join(output, "_headers"), "utf8"), /catalog\.json[\s\S]*no-store[\s\S]*originals\/\*[\s\S]*immutable/u);
});

for (const [label, filename, contents, errorPattern] of [
  ["unsupported file", "notes.txt", "never publish", /unsupported regular file/u],
  ["extraction failure", "broken.pdf", "not a document", /extraction failed/u]
]) {
  test(`builder preserves a prior good snapshot on ${label}`, async (context) => {
    // Given: a valid published snapshot followed by invalid source input.
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "docfinder-snapshot-reject-"));
    context.after(() => fsSync.rmSync(sandbox, { recursive: true, force: true }));
    const source = await makeCorpus(sandbox);
    const output = path.join(sandbox, "dist");
    assert.equal(runBuilder(source, output).status, 0);
    const before = await fs.readFile(path.join(output, "library", "manifest.json"), "utf8");
    await fs.rm(path.join(source, "fixture.pdf"));
    await fs.writeFile(path.join(source, filename), contents);

    // When: the same CLI attempts to replace the good snapshot.
    const result = runBuilder(source, output);

    // Then: it reports only the failure class and leaves the prior manifest untouched.
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, errorPattern);
    assert.equal(result.stdout, "");
    assert.equal(await fs.readFile(path.join(output, "library", "manifest.json"), "utf8"), before);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(filename.replace(".", "\\."), "u"));
  });
}

test("builder rejects an oversized original before replacing a prior snapshot", async (context) => {
  // Given: a good snapshot and a supported input just over the provider's per-file limit.
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "docfinder-snapshot-oversized-"));
  context.after(() => fsSync.rmSync(sandbox, { recursive: true, force: true }));
  const source = await makeCorpus(sandbox);
  const output = path.join(sandbox, "dist");
  assert.equal(runBuilder(source, output).status, 0);
  const before = await fs.readFile(path.join(output, "library", "manifest.json"), "utf8");
  const handle = await fs.open(path.join(source, "fixture.pdf"), "r+");
  await handle.truncate(25 * 1024 * 1024 + 1);
  await handle.close();

  // When: publication is retried with the oversized asset.
  const result = runBuilder(source, output);

  // Then: validation fails without a success line or replacement.
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /snapshot build failed/u);
  assert.equal(await fs.readFile(path.join(output, "library", "manifest.json"), "utf8"), before);
});

test("builder fails closed on malformed stale state", async (context) => {
  // Given: valid source input and a pre-existing output whose manifest is malformed.
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "docfinder-snapshot-malformed-"));
  context.after(() => fsSync.rmSync(sandbox, { recursive: true, force: true }));
  const source = await makeCorpus(sandbox);
  const output = path.join(sandbox, "dist");
  await fs.mkdir(path.join(output, "library"), { recursive: true });
  await fs.writeFile(path.join(output, "library", "manifest.json"), "{malformed");

  // When: the builder reads the stale state.
  const result = runBuilder(source, output);

  // Then: it emits no misleading success and does not delete or rewrite the stale artifact.
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /malformed previous manifest/u);
  assert.equal(await fs.readFile(path.join(output, "library", "manifest.json"), "utf8"), "{malformed");
});

test("repeated process interruptions preserve the prior snapshot and clean staging", async (context) => {
  // Given: a prior good snapshot and two fresh publication attempts.
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "docfinder-snapshot-interrupt-"));
  context.after(() => fsSync.rmSync(sandbox, { recursive: true, force: true }));
  const source = await makeCorpus(sandbox);
  const output = path.join(sandbox, "dist");
  assert.equal(runBuilder(source, output).status, 0);
  const before = await fs.readFile(path.join(output, "library", "manifest.json"), "utf8");

  // When: the real CLI is interrupted twice immediately after process creation.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const child = spawn(process.execPath, [builder, "--source", source, "--output", output], {
      cwd: appRoot,
      stdio: "ignore"
    });
    await once(child, "spawn");
    child.kill("SIGTERM");
    await once(child, "close");
  }

  // Then: neither attempt replaces the good snapshot or leaves a staging directory behind.
  assert.equal(await fs.readFile(path.join(output, "library", "manifest.json"), "utf8"), before);
  assert.equal((await fs.readdir(sandbox)).some((name) => name.startsWith(".dist.staging-")), false);
});
