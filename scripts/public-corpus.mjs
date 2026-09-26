import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import * as rhwp from "../vendor/rhwp-core/rhwp.js";

const SUPPORTED_FORMATS = new Set(["pdf", "hwp", "hwpx"]);
const HOUSEKEEPING_FILES = new Set([".DS_Store"]);
const ID_PREFIX = "doc-";

export class PublicCorpusError extends Error {
  constructor(code, relativePath, cause) {
    super(relativePath ? `${code}: ${relativePath}` : code, cause ? { cause } : undefined);
    this.name = "PublicCorpusError";
    this.code = code;
    this.relativePath = relativePath;
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeRelative(relativePath) {
  const normalized = relativePath.split(path.sep).map((segment) => segment.normalize("NFC")).join("/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new PublicCorpusError("path traversal", relativePath);
  }
  return normalized;
}

function documentId(relativePath) {
  return `${ID_PREFIX}${createHash("sha256").update(relativePath).digest("hex").slice(0, 24)}`;
}

async function readFileMetadata(root, diskRelative, relativePath) {
  const filePath = path.join(root, diskRelative);
  const resolved = path.resolve(filePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new PublicCorpusError("path traversal", relativePath);
  }
  try {
    const [bytes, stat] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
    return {
      bytes,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  } catch (error) {
    throw new PublicCorpusError("unreadable file", relativePath, error);
  }
}

export async function enumeratePublicCorpus(sourceRoot) {
  let root;
  try {
    root = await fs.realpath(sourceRoot);
  } catch (error) {
    throw new PublicCorpusError("unreadable source root", "", error);
  }
  const rootStat = await fs.stat(root);
  if (!rootStat.isDirectory()) throw new PublicCorpusError("source root is not a directory", "");
  const documents = [];
  const normalizedPaths = new Set();
  const ids = new Set();

  async function visit(diskRelative = "") {
    let entries;
    try {
      entries = await fs.readdir(path.join(root, diskRelative), { withFileTypes: true });
    } catch (error) {
      throw new PublicCorpusError("unreadable directory", diskRelative ? normalizeRelative(diskRelative) : "", error);
    }
    entries.sort((left, right) => compareText(left.name.normalize("NFC"), right.name.normalize("NFC")));
    for (const entry of entries) {
      const nextDiskRelative = path.join(diskRelative, entry.name);
      const relativePath = normalizeRelative(nextDiskRelative);
      if (entry.isSymbolicLink()) throw new PublicCorpusError("nested symlink", relativePath);
      if (entry.isDirectory()) {
        await visit(nextDiskRelative);
        continue;
      }
      if (!entry.isFile()) throw new PublicCorpusError("unsupported filesystem entry", relativePath);
      if (HOUSEKEEPING_FILES.has(entry.name)) continue;
      const format = path.extname(entry.name).slice(1).toLowerCase();
      if (!SUPPORTED_FORMATS.has(format)) throw new PublicCorpusError("unsupported regular file", relativePath);
      if (normalizedPaths.has(relativePath)) throw new PublicCorpusError("duplicate normalized path", relativePath);
      normalizedPaths.add(relativePath);
      const id = documentId(relativePath);
      if (ids.has(id)) throw new PublicCorpusError("duplicate document id", relativePath);
      ids.add(id);
      const metadata = await readFileMetadata(root, nextDiskRelative, relativePath);
      documents.push({ id, relativePath, format, ...metadata });
    }
  }

  await visit();
  return documents.sort((left, right) => compareText(left.relativePath, right.relativePath));
}

let hwpRuntimeReady;

async function initializeHwpRuntime(appRoot) {
  if (!hwpRuntimeReady) {
    hwpRuntimeReady = rhwp.default({ module_or_path: await fs.readFile(path.join(appRoot, "vendor/rhwp-core/rhwp_bg.wasm")) });
  }
  await hwpRuntimeReady;
}

export async function extractPublicDocument(document, appRoot) {
  if (document.format === "pdf") {
    const loading = pdfjs.getDocument({
      data: new Uint8Array(document.bytes),
      useSystemFonts: true,
      disableFontFace: true,
      isEvalSupported: false,
      verbosity: pdfjs.VerbosityLevel.ERRORS
    });
    try {
      const pdf = await loading.promise;
      const pages = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items.map((item) => "str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "").join("").trim();
        pages.push({ id: document.id, page: pageNumber, text });
        page.cleanup();
      }
      return pages;
    } finally {
      await loading.destroy();
    }
  }
  await initializeHwpRuntime(appRoot);
  const hwp = new rhwp.HwpDocument(new Uint8Array(document.bytes));
  try {
    return Array.from({ length: hwp.pageCount() }, (_, index) => ({
      id: document.id,
      page: index + 1,
      text: JSON.parse(hwp.getPageText(index))
    }));
  } finally {
    hwp.free();
  }
}

function parsePrevious(previousManifest) {
  if (previousManifest === null) return [];
  if (!previousManifest || !Array.isArray(previousManifest.documents)) {
    throw new PublicCorpusError("malformed previous manifest", "");
  }
  return previousManifest.documents;
}

function manifestDelta(documents, previousDocuments) {
  const current = new Map(documents.map((document) => [document.id, document]));
  const previous = new Map(previousDocuments.map((document) => [document.id, document]));
  return {
    added: [...current.keys()].filter((id) => !previous.has(id)).sort(compareText),
    changed: [...current.keys()].filter((id) => previous.has(id) && previous.get(id).sha256 !== current.get(id).sha256).sort(compareText),
    removed: [...previous.keys()].filter((id) => !current.has(id)).sort(compareText)
  };
}

export async function buildPublicCorpus(sourceRoot, options = {}) {
  const documents = await enumeratePublicCorpus(sourceRoot);
  const extract = options.extractDocument || extractPublicDocument;
  const appRoot = options.appRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifestDocuments = [];
  const entries = [];
  const warnings = [];
  for (const document of documents) {
    let extracted;
    try {
      extracted = await extract(document, appRoot);
    } catch (error) {
      throw new PublicCorpusError("extraction failed", document.relativePath, error);
    }
    const textlessPageCount = extracted.filter((entry) => !entry.text.trim()).length;
    const extractionStatus = textlessPageCount === extracted.length ? "textless" : "indexed";
    if (textlessPageCount > 0) warnings.push({ id: document.id, code: "textless-pages", count: textlessPageCount });
    entries.push(...extracted);
    const { bytes, ...metadata } = document;
    manifestDocuments.push({ ...metadata, extractionStatus, textlessPageCount });
  }
  const previousDocuments = parsePrevious(options.previousManifest ?? null);
  return {
    manifest: {
      version: 1,
      documents: manifestDocuments,
      delta: manifestDelta(manifestDocuments, previousDocuments),
      warnings
    },
    entries
  };
}
