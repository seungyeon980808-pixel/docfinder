import * as core from "../vendor/rhwp-core/rhwp.js";
const ready = core.default({ module_or_path: new URL("../vendor/rhwp-core/rhwp_bg.wasm", import.meta.url).href });
const documents = new Map();
const pages = new Map();
let cachedBytes = 0;
const budget = 8 * 1024 * 1024;

function touch(key) {
  const document = documents.get(key);
  if (!document) throw new Error("한글 문서를 다시 열어 주세요.");
  documents.delete(key);
  documents.set(key, document);
  return document;
}

self.onmessage = async ({ data }) => {
  try {
    await ready;
    let result;
    if (data.type === "open") {
      if (!documents.has(data.key)) {
        documents.set(data.key, new core.HwpDocument(new Uint8Array(data.bytes)));
        while (documents.size > 2) {
          const key = documents.keys().next().value;
          documents.get(key).free();
          documents.delete(key);
          for (const [pageKey, page] of pages) {
            if (page.key === key) { cachedBytes -= page.size; pages.delete(pageKey); }
          }
        }
      }
      result = { pageCount: touch(data.key).pageCount() };
    } else if (data.type === "page") {
      const document = touch(data.key);
      const pageKey = `${data.key}:${data.page}`;
      let cached = pages.get(pageKey);
      if (!cached) {
        const svg = document.renderPageSvg(data.page - 1);
        const layout = JSON.parse(document.getPageTextLayout(data.page - 1));
        cached = { key: data.key, svg, layout, size: (svg.length + JSON.stringify(layout).length) * 2 };
        pages.set(pageKey, cached);
        cachedBytes += cached.size;
        while (cachedBytes > budget) {
          const oldest = pages.keys().next().value;
          cachedBytes -= pages.get(oldest).size;
          pages.delete(oldest);
        }
      } else { pages.delete(pageKey); pages.set(pageKey, cached); }
      result = { svg: cached.svg, layout: cached.layout };
    } else throw new Error("알 수 없는 한글 렌더링 요청입니다.");
    self.postMessage({ id: data.id, result });
  } catch (error) {
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  }
};
