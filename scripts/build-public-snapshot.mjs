import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPublicCorpus, enumeratePublicCorpus, PublicCorpusError } from "./public-corpus.mjs";
import { assertAllowedReleasePaths, collectReleaseInventory, verifyReleaseTree } from "./release-package.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 20_000;
const runtimeRoots = new Set(["data", "js", "styles", "vendor"]);
const mimeTypes = Object.freeze({ pdf: "application/pdf", hwp: "application/x-hwp", hwpx: "application/vnd.hancom.hwpx" });

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function missingOrStat(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function copyRegular(source, destination) {
  const handle = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, await handle.readFile(), { flag: "wx" });
  } finally {
    await handle.close();
  }
}

async function previousManifest(output) {
  const outputStat = await missingOrStat(output);
  if (outputStat === null) return null;
  if (outputStat.isSymbolicLink() || !outputStat.isDirectory()) throw new Error("existing output must be a real directory");
  try {
    return JSON.parse(await fs.readFile(path.join(output, "library", "manifest.json"), "utf8"));
  } catch (error) {
    throw new PublicCorpusError("malformed previous manifest", "", error);
  }
}

function publicConfig(sourceConfig) {
  const privateMarker = /profile:\s*"private"/u;
  if (!privateMarker.test(sourceConfig) || /profile:\s*"public"/u.test(sourceConfig)) {
    throw new Error("source build profile contract is invalid");
  }
  return sourceConfig.replace(privateMarker, 'profile: "public"');
}

function publicEntries(documents, extracted) {
  const grouped = new Map();
  for (const entry of extracted) {
    if (entry.text.trim()) {
      const entries = grouped.get(entry.id) || [];
      entries.push({ id: entry.id, page: entry.page, text: entry.text });
      grouped.set(entry.id, entries);
    }
  }
  return documents.flatMap((document) => grouped.get(document.id) || [{ id: document.id, page: null, text: "​" }]);
}

function snapshotMetadata(corpus) {
  const generatedAt = new Date().toISOString();
  const catalogDocuments = corpus.manifest.documents.map((document) => {
    const segments = document.relativePath.split("/");
    const originalName = `${document.id}.${document.sha256.slice(0, 16)}.${document.format}`;
    return {
      id: document.id,
      name: segments.at(-1),
      folder: segments[0] === segments.at(-1) ? "루트 문서" : segments[0],
      path: segments.join(" / "),
      publisher: "게시 문서",
      modifiedTime: document.mtime,
      size: document.size,
      format: document.format,
      mimeType: mimeTypes[document.format],
      source: "public",
      sourceUrl: `originals/${originalName}`,
      page: null,
      heading: "원문",
      excerpt: "게시된 원문입니다."
    };
  });
  const originalById = new Map(catalogDocuments.map((document) => [document.id, document.sourceUrl]));
  const manifestDocuments = corpus.manifest.documents.map(({ relativePath: _relativePath, mtime, ...document }) => ({
    ...document,
    modifiedTime: mtime,
    originalUrl: originalById.get(document.id)
  }));
  return {
    catalog: { version: 1, sourceName: "게시 문서", generatedAt, documents: catalogDocuments },
    index: { version: 1, entries: publicEntries(corpus.manifest.documents, corpus.entries) },
    manifest: {
      version: 1,
      generatedAt,
      documents: manifestDocuments,
      delta: corpus.manifest.delta,
      warnings: corpus.manifest.warnings
    }
  };
}

async function writeJson(destination, value) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, `${JSON.stringify(value)}\n`, { flag: "wx" });
}

function exactIds(values) {
  return [...new Set(values)].sort();
}

async function validateSnapshot(staging, sourceDocuments, metadata) {
  const catalogIds = exactIds(metadata.catalog.documents.map((document) => document.id));
  const indexIds = exactIds(metadata.index.entries.map((entry) => entry.id));
  const manifestIds = exactIds(metadata.manifest.documents.map((document) => document.id));
  const sourceIds = exactIds(sourceDocuments.map((document) => document.id));
  if (JSON.stringify([catalogIds, indexIds, manifestIds]) !== JSON.stringify([sourceIds, sourceIds, sourceIds])) {
    throw new Error("snapshot document sets differ");
  }
  for (const document of metadata.manifest.documents) {
    const relative = path.posix.join("library", document.originalUrl);
    if (relative !== `library/originals/${path.posix.basename(relative)}` || relative.includes("%2f")) {
      throw new Error("snapshot original URL is unsafe");
    }
    if (sha256(await fs.readFile(path.join(staging, relative))) !== document.sha256) {
      throw new Error("snapshot original hash differs");
    }
  }
  const files = await verifyReleaseTree("deploy", staging);
  if (files.length > MAX_FILES) throw new Error("snapshot exceeds provider file limit");
  for (const relative of files) {
    if ((await fs.stat(path.join(staging, relative))).size > MAX_ASSET_BYTES) {
      throw new Error("snapshot exceeds provider asset limit");
    }
  }
  const serialized = JSON.stringify(metadata);
  if (/drive\.google|file:\/\/|private\/docs|oauth|client[_-]?id|folder[_-]?id/iu.test(serialized)) {
    throw new Error("snapshot metadata contains private identifiers");
  }
  return files;
}

async function stageSnapshot(staging, sourceDocuments, corpus, interrupted) {
  const inventory = await collectReleaseInventory("source", appRoot);
  const runtimeFiles = inventory.filter((relative) => relative === "index.html" || runtimeRoots.has(relative.split("/")[0]));
  assertAllowedReleasePaths("deploy", runtimeFiles);
  for (const relative of runtimeFiles) await copyRegular(path.join(appRoot, relative), path.join(staging, relative));
  await fs.writeFile(path.join(staging, "config.js"), publicConfig(await fs.readFile(path.join(appRoot, "config.js"), "utf8")), { flag: "wx" });
  await fs.writeFile(path.join(staging, "_headers"), [
    "/library/catalog.json", "  Cache-Control: no-store", "/library/search-index.json", "  Cache-Control: no-store",
    "/library/manifest.json", "  Cache-Control: no-store", "/library/originals/*", "  Cache-Control: public, max-age=31536000, immutable", ""
  ].join("\n"), { flag: "wx" });
  const metadata = snapshotMetadata(corpus);
  await Promise.all([
    writeJson(path.join(staging, "library", "catalog.json"), metadata.catalog),
    writeJson(path.join(staging, "library", "search-index.json"), metadata.index),
    writeJson(path.join(staging, "library", "manifest.json"), metadata.manifest)
  ]);
  const sourceById = new Map(sourceDocuments.map((document) => [document.id, document]));
  for (const document of metadata.manifest.documents) {
    const source = sourceById.get(document.id);
    await fs.mkdir(path.join(staging, "library", "originals"), { recursive: true });
    await fs.writeFile(path.join(staging, "library", document.originalUrl), source.bytes, { flag: "wx" });
  }
  if (interrupted.value) throw new Error("snapshot build interrupted");
  const files = await validateSnapshot(staging, sourceDocuments, metadata);
  return { metadata, files };
}

async function replaceOutput(staging, output, interrupted) {
  const prior = await missingOrStat(output);
  if (prior === null) {
    if (interrupted.value) throw new Error("snapshot build interrupted");
    await fs.rename(staging, output);
    return;
  }
  const backup = `${output}.previous-${process.pid}`;
  await fs.rm(backup, { recursive: true, force: true });
  await fs.rename(output, backup);
  try {
    if (interrupted.value) throw new Error("snapshot build interrupted");
    await fs.rename(staging, output);
    if (interrupted.value) throw new Error("snapshot build interrupted");
    await fs.rm(backup, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(output, { recursive: true, force: true });
    await fs.rename(backup, output);
    throw error;
  }
}

export async function buildPublicSnapshot({ source, output, interrupted = { value: false } }) {
  const resolvedOutput = path.resolve(output);
  const parent = path.dirname(resolvedOutput);
  const sourceDocuments = await enumeratePublicCorpus(source);
  if (sourceDocuments.some((document) => document.size > MAX_ASSET_BYTES)) throw new Error("source exceeds provider asset limit");
  const previous = await previousManifest(resolvedOutput);
  const corpus = await buildPublicCorpus(source, { appRoot, previousManifest: previous });
  await fs.mkdir(parent, { recursive: true });
  const staging = await fs.mkdtemp(path.join(parent, `.${path.basename(resolvedOutput)}.staging-`));
  try {
    const staged = await stageSnapshot(staging, sourceDocuments, corpus, interrupted);
    await replaceOutput(staging, resolvedOutput, interrupted);
    const manifestBytes = await fs.readFile(path.join(resolvedOutput, "library", "manifest.json"));
    return Object.freeze({
      documentCount: staged.metadata.manifest.documents.length,
      fileCount: staged.files.length,
      warningCount: staged.metadata.manifest.warnings.length,
      manifestSha256: sha256(manifestBytes)
    });
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function parseArguments(argumentsList) {
  let source = path.join(appRoot, "private", "docs");
  let output = path.join(appRoot, "dist");
  while (argumentsList.length > 0) {
    const flag = argumentsList.shift();
    const value = argumentsList.shift();
    if (!value || (flag !== "--source" && flag !== "--output")) throw new Error("usage: build-public-snapshot.mjs [--source PATH] [--output PATH]");
    if (flag === "--source") source = path.resolve(value);
    else output = path.resolve(value);
  }
  return { source, output };
}

async function main() {
  const interrupted = { value: false };
  const onSignal = () => { interrupted.value = true; };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const report = await buildPublicSnapshot({ ...parseArguments(process.argv.slice(2)), interrupted });
    console.log(JSON.stringify({ ok: true, ...report }));
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = error instanceof PublicCorpusError ? error.code : "snapshot build failed";
    console.error(code);
    process.exitCode = 1;
  });
}
