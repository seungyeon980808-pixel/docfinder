import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import * as rhwp from "../vendor/rhwp-core/rhwp.js";
import { buildPublicCorpus, PublicCorpusError } from "./public-corpus.mjs";

const run = promisify(execFile);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateRoot = path.join(appRoot, "private");
const supported = new Set([".pdf", ".hwp", ".hwpx"]);

async function filesIn(folder, relative = "") {
  const files = [];
  for (const entry of await fs.readdir(path.join(folder, relative), { withFileTypes: true })) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(folder, next));
    else if (entry.isFile() && supported.has(path.extname(entry.name).toLowerCase())) files.push(next);
  }
  return files.sort((left, right) => left.localeCompare(right, "ko"));
}

async function driveId(filePath) {
  if (process.platform !== "darwin") return "";
  try {
    const { stdout } = await run("xattr", ["-p", "com.google.drivefs.item-id#S", filePath]);
    return stdout.trim();
  } catch {
    return "";
  }
}

async function readPrevious(filename, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(privateRoot, filename), "utf8"));
  } catch {
    return fallback;
  }
}

async function pdfPages(filePath, id) {
  const loading = pdfjs.getDocument({
    data: new Uint8Array(await fs.readFile(filePath)),
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS
  });
  try {
    const pdf = await loading.promise;
    const entries = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => "str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "").join("").trim();
      entries.push({ id, page: pageNumber, text });
      page.cleanup();
    }
    return entries;
  } finally {
    await loading.destroy();
  }
}

async function hwpText(filePath, id) {
  const document = new rhwp.HwpDocument(new Uint8Array(await fs.readFile(filePath)));
  try {
    return Array.from({ length: document.pageCount() }, (_, index) => ({
      id, page: index + 1, text: JSON.parse(document.getPageText(index))
    }));
  } finally {
    document.free();
  }
}

async function writeJson(filename, value) {
  const destination = path.join(privateRoot, filename);
  const temporary = `${destination}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value));
  await fs.rename(temporary, destination);
}

async function buildLocalIndex() {
  const folderArgument = process.argv[2];
  if (!folderArgument) throw new Error("사용법: npm run index:local -- '/Google Drive 동기화 폴더 경로'");
  const folder = await fs.realpath(folderArgument);
  if (!(await fs.stat(folder)).isDirectory()) throw new Error("문서 폴더를 지정하세요.");
  await fs.mkdir(privateRoot, { recursive: true });
  const docsLink = path.join(privateRoot, "docs");
  try {
    const linked = await fs.realpath(docsLink);
    if (linked !== folder) throw new Error("이미 다른 문서 폴더가 연결되어 있습니다. private/docs 연결을 확인하세요.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.symlink(folder, docsLink, "dir");
  }

  const previousCatalog = await readPrevious("catalog.json", { documents: [] });
  const previousIndex = await readPrevious("search-index.json", { entries: [] });
  const previousById = new Map(previousCatalog.documents.map((item) => [item.id, item]));
  const previousEntries = new Map();
  for (const entry of previousIndex.entries) {
    const group = previousEntries.get(entry.id) || [];
    group.push(entry);
    previousEntries.set(entry.id, group);
  }

  const documents = [];
  const entries = [];
  let indexed = 0;
  let failures = 0;
  let reused = 0;
  let hwpReady = false;
  for (const relative of await filesIn(folder)) {
    const filePath = path.join(folder, relative);
    const stat = await fs.stat(filePath);
    const format = path.extname(relative).slice(1).toLowerCase();
    const id = await driveId(filePath) || `local-${createHash("sha256").update(relative).digest("hex").slice(0, 20)}`;
    const segments = relative.split(path.sep);
    const sourceUrl = `private/docs/${segments.map(encodeURIComponent).join("/")}`;
    const folders = segments.slice(0, -1);
    const previous = previousById.get(id);
    const documentItem = {
      id, name: path.basename(relative), folder: folders[0] || "루트 문서",
      path: segments.join(" / "), publisher: "Google Drive 동기화 폴더",
      modifiedTime: stat.mtime.toISOString(), size: stat.size, format,
      source: "local", sourceUrl, previewUrl: format === "pdf" ? sourceUrl : "",
      webViewLink: id.startsWith("local-") ? "" : `https://drive.google.com/file/d/${id}/view`,
      page: null, heading: "원문", excerpt: "로컬 색인으로 검색할 수 있는 원문입니다.",
      ...(format === "pdf" ? {} : { textIndexVersion: 2 })
    };
    documents.push(documentItem);
    if (previous?.modifiedTime === documentItem.modifiedTime && previous.size === stat.size && previousEntries.has(id)
      && (format === "pdf" || previous.textIndexVersion === 2
        && previousEntries.get(id).every((entry) => Number.isSafeInteger(entry.page) && entry.page > 0))) {
      const reusedEntries = previousEntries.get(id);
      entries.push(...reusedEntries);
      reused += 1;
      continue;
    }
    try {
      if (format !== "pdf" && !hwpReady) {
        await rhwp.default({ module_or_path: await fs.readFile(path.join(appRoot, "vendor/rhwp-core/rhwp_bg.wasm")) });
        hwpReady = true;
      }
      const extracted = format === "pdf" ? await pdfPages(filePath, id) : await hwpText(filePath, id);
      entries.push(...extracted);
      indexed += 1;
    } catch (error) {
      failures += 1;
      console.error(`색인 실패: ${relative} (${error.message})`);
    }
  }
  await writeJson("search-index.json", { version: 1, entries });
  await writeJson("catalog.json", { version: 1, sourceName: path.basename(folder), generatedAt: new Date().toISOString(), documents });
  const emptyPages = entries.filter((entry) => entry.page !== null && !entry.text).length;
  console.log(`문서 ${documents.length}개, 신규·변경 색인 ${indexed}개, 재사용 ${reused}개, 실패 ${failures}개, 텍스트 없는 PDF 페이지 ${emptyPages}개`);
}

async function buildPublicIndex() {
  const args = process.argv.slice(3);
  const folderArgument = args.shift();
  let outputPath = "";
  let previousPath = "";
  while (args.length > 0) {
    const flag = args.shift();
    const value = args.shift();
    if (!value || (flag !== "--manifest" && flag !== "--previous")) {
      throw new PublicCorpusError("usage: --public SOURCE --manifest OUTPUT [--previous MANIFEST]", "");
    }
    if (flag === "--manifest") outputPath = value;
    else previousPath = value;
  }
  if (!folderArgument || !outputPath) {
    throw new PublicCorpusError("usage: --public SOURCE --manifest OUTPUT [--previous MANIFEST]", "");
  }
  const resolvedOutput = path.resolve(outputPath);
  const temporary = `${resolvedOutput}.tmp-${process.pid}`;
  await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });
  await fs.rm(resolvedOutput, { force: true });
  await fs.rm(temporary, { force: true });
  try {
    let previousManifest = null;
    if (previousPath) {
      try {
        const previousArtifact = JSON.parse(await fs.readFile(previousPath, "utf8"));
        previousManifest = previousArtifact.manifest || previousArtifact;
      } catch (error) {
        throw new PublicCorpusError("malformed previous manifest", "", error);
      }
    }
    const result = await buildPublicCorpus(folderArgument, { appRoot, previousManifest });
    await fs.writeFile(temporary, `${JSON.stringify(result)}\n`, { flag: "wx" });
    await fs.rename(temporary, resolvedOutput);
    const warningPages = result.manifest.warnings.reduce((count, warning) => count + warning.count, 0);
    console.log(`public corpus: documents=${result.manifest.documents.length} entries=${result.entries.length} textlessPages=${warningPages}`);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    await fs.rm(resolvedOutput, { force: true });
    throw error;
  }
}

const main = process.argv[2] === "--public" ? buildPublicIndex : buildLocalIndex;
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
