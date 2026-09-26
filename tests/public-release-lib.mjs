import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const FORBIDDEN_SEGMENTS = new Set(["private", ".omo", "evidence", "node_modules", ".git", "tests"]);
const SAFE_ORIGINAL = /^originals\/doc-[0-9a-f]{24}\.[0-9a-f]{16}\.(?:pdf|hwp|hwpx)$/u;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function collectFiles(root, relative = "") {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`release contains symlink: ${child}`);
    if (entry.isDirectory()) files.push(...await collectFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`release contains non-regular entry: ${child}`);
  }
  return files.sort();
}

function exactIds(values, label) {
  const ids = values.map((value) => value?.id);
  if (ids.some((id) => typeof id !== "string" || !id)) throw new Error(`${label} contains an invalid id`);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate ids`);
  return [...ids].sort();
}

export function diffReleaseDocuments(previous, current) {
  const previousById = new Map(previous.map((document) => [document.id, document.sha256]));
  const currentById = new Map(current.map((document) => [document.id, document.sha256]));
  return {
    added: [...currentById.keys()].filter((id) => !previousById.has(id)).sort(),
    changed: [...currentById].filter(([id, hash]) => previousById.has(id) && previousById.get(id) !== hash).map(([id]) => id).sort(),
    removed: [...previousById.keys()].filter((id) => !currentById.has(id)).sort()
  };
}

export async function validatePublicRelease(root) {
  const resolvedRoot = path.resolve(root);
  const files = await collectFiles(resolvedRoot);
  for (const file of files) {
    const segments = file.split("/");
    if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment)) || /(?:secret|token|credential)/iu.test(file)) {
      throw new Error(`release contains forbidden path: ${file}`);
    }
  }

  const readJson = async (name) => JSON.parse(await fs.readFile(path.join(resolvedRoot, "library", name), "utf8"));
  const [catalog, index, manifest] = await Promise.all([
    readJson("catalog.json"), readJson("search-index.json"), readJson("manifest.json")
  ]);
  if (catalog.version !== 1 || index.version !== 1 || manifest.version !== 1) throw new Error("release metadata version is invalid");
  if (!Array.isArray(catalog.documents) || !Array.isArray(index.entries) || !Array.isArray(manifest.documents)) {
    throw new Error("release metadata arrays are missing");
  }

  const catalogIds = exactIds(catalog.documents, "catalog");
  const manifestIds = exactIds(manifest.documents, "manifest");
  const indexIds = [...new Set(index.entries.map((entry) => entry?.id))].sort();
  if (JSON.stringify(catalogIds) !== JSON.stringify(manifestIds)
    || JSON.stringify(catalogIds) !== JSON.stringify(indexIds)) {
    throw new Error("source, catalog, index, and original document sets differ");
  }

  const manifestById = new Map(manifest.documents.map((document) => [document.id, document]));
  const expectedOriginals = [];
  for (const document of catalog.documents) {
    if (!SAFE_ORIGINAL.test(document.sourceUrl)
      || document.sourceUrl !== manifestById.get(document.id)?.originalUrl
      || /(?:^|\/)(?:\.\.|private|tests|evidence)(?:\/|$)/u.test(document.sourceUrl)
      || /^[a-z]+:|^\//iu.test(document.sourceUrl)) {
      throw new Error("release contains an unsafe original URL");
    }
    expectedOriginals.push(`library/${document.sourceUrl}`);
  }
  const actualOriginals = files.filter((file) => file.startsWith("library/originals/"));
  if (JSON.stringify(expectedOriginals.sort()) !== JSON.stringify(actualOriginals)) {
    throw new Error("release original set differs from metadata");
  }

  for (const document of manifest.documents) {
    const bytes = await fs.readFile(path.join(resolvedRoot, "library", document.originalUrl));
    if (bytes.length !== document.size || sha256(bytes) !== document.sha256) {
      throw new Error("release original bytes differ from manifest");
    }
  }

  const serialized = JSON.stringify({ catalog, index, manifest });
  if (/drive\.google|accounts\.google|file:\/\/|private\/|oauth|client[_-]?id|folder[_-]?id/iu.test(serialized)) {
    throw new Error("release metadata contains a private or external identifier");
  }
  return Object.freeze({
    documentCount: catalog.documents.length,
    formats: Object.fromEntries([...new Set(catalog.documents.map((document) => document.format))].sort().map((format) => [format, catalog.documents.filter((document) => document.format === format).length])),
    fileCount: files.length,
    manifestSha256: sha256(await fs.readFile(path.join(resolvedRoot, "library", "manifest.json")))
  });
}
