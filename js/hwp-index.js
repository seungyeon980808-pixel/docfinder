import { matchProximity } from "./search.js?v=verification-2";

const RHWP_CORE_URL = new URL("../vendor/rhwp-core/rhwp.js", import.meta.url).href;
const RHWP_WASM_URL = new URL("../vendor/rhwp-core/rhwp_bg.wasm", import.meta.url).href;
const DATABASE_NAME = "5e-manual-library-hwp-index";
const STORE_NAME = "documents";

let corePromise;
const memoryIndex = new Map();

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("ko-KR");
}

export function matchesAllTerms(text, query) {
  const normalizedText = normalize(text);
  const terms = normalize(query).trim().split(/\s+/u).filter(Boolean);
  return terms.every((term) => normalizedText.includes(term));
}

export function excerptAroundMatch(text, query, radius = 72) {
  const source = String(text ?? "").replace(/\s+/gu, " ").trim();
  const firstTerm = normalize(query).trim().split(/\s+/u).find(Boolean) || "";
  const index = normalize(source).indexOf(firstTerm);
  if (index < 0) return source.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(source.length, index + firstTerm.length + radius);
  return `${start ? "…" : ""}${source.slice(start, end)}${end < source.length ? "…" : ""}`;
}

export function parseRhwpUnicodeText(value) {
  const parsed = JSON.parse(value);
  if (typeof parsed !== "string") throw new TypeError("RHWP가 올바른 문서 텍스트를 반환하지 않았습니다.");
  return parsed;
}

async function loadCore() {
  if (!corePromise) {
    corePromise = import(RHWP_CORE_URL).then(async (core) => {
      await core.default({ module_or_path: RHWP_WASM_URL });
      return core;
    }).catch((error) => {
      corePromise = undefined;
      throw error;
    });
  }
  return corePromise;
}

async function extractPages(bytes) {
  const core = await loadCore();
  const document = new core.HwpDocument(new Uint8Array(bytes));
  try {
    return Array.from({ length: document.pageCount() }, (_, index) => ({
      page: index + 1, text: parseRhwpUnicodeText(document.getPageText(index))
    }));
  } finally {
    document.free();
  }
}

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readCachedPages(documentItem) {
  const memory = memoryIndex.get(documentItem.id);
  if (memory?.modifiedTime === documentItem.modifiedTime && Array.isArray(memory.pages)) return memory.pages;
  const database = await openDatabase().catch(() => null);
  if (!database) return null;
  const record = await new Promise((resolve) => {
    const request = database.transaction(STORE_NAME).objectStore(STORE_NAME).get(documentItem.id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  database.close();
  if (record?.modifiedTime !== documentItem.modifiedTime || !Array.isArray(record.pages)) return null;
  memoryIndex.set(documentItem.id, record);
  return record.pages;
}

async function cachePages(documentItem, pages) {
  const record = { id: documentItem.id, modifiedTime: documentItem.modifiedTime, pages };
  memoryIndex.set(documentItem.id, record);
  const database = await openDatabase().catch(() => null);
  if (!database) return;
  await new Promise((resolve) => {
    const request = database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(record);
    request.onsuccess = resolve;
    request.onerror = resolve;
  });
  database.close();
}

export function findBestHwpPage(pages, query) {
  let best = null;
  for (const entry of pages) {
    const match = matchProximity(entry.text, query);
    if (!match || best && best.distance <= match.distance) continue;
    best = { page: entry.page, text: entry.text, distance: match.distance };
  }
  return best;
}

export async function searchHwpContent(documents, query, getBytes, onProgress = () => {}) {
  const candidates = documents.filter((documentItem) => documentItem.format === "hwp" || documentItem.format === "hwpx");
  const matches = [];
  const failures = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const documentItem = candidates[index];
    onProgress({ current: index + 1, total: candidates.length, name: documentItem.name });
    try {
      let pages = await readCachedPages(documentItem);
      if (!pages) {
        pages = await extractPages(await getBytes(documentItem));
        await cachePages(documentItem, pages);
      }
      const best = findBestHwpPage(pages, query);
      if (best) {
        matches.push({ ...documentItem, page: best.page, matchDistance: best.distance,
          excerpt: excerptAroundMatch(best.text, query), heading: `${best.page}쪽 한글 문서 본문 검색 결과` });
      }
    } catch (error) {
      failures.push({ id: documentItem.id, name: documentItem.name, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { matches, failures };
}
