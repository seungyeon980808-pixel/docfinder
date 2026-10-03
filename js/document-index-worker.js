import { readPdfTextContent } from "./pdf-text-content.js?v=phrase-map-2";

const assets = new URL("../vendor/pdfjs/", import.meta.url).href;
let pdfModule;
let hwpModule;
let queue = Promise.resolve();

async function extract({ id, format, bytes }) {
  const pages = [];
  let document;
  let loading;
  let parser;
  let parserPort;
  try {
    if (format === "pdf") {
      pdfModule ||= import(`${assets}pdf.mjs`).then((module) => { module.GlobalWorkerOptions.workerSrc = `${assets}pdf.worker.mjs`; return module; });
      const module = await pdfModule;
      // PDF.js's default browser setup uses window/document. Supply the port
      // and fetch mode explicitly when its display API runs inside a worker.
      parserPort = new Worker(`${assets}pdf.worker.mjs`, { type: "module" });
      parser = new module.PDFWorker({ port: parserPort });
      loading = module.getDocument({ data: new Uint8Array(bytes), worker: parser, useWorkerFetch: true,
        disableFontFace: true, cMapUrl: `${assets}cmaps/`, cMapPacked: true,
        standardFontDataUrl: `${assets}standard_fonts/`, wasmUrl: `${assets}wasm/`, isEvalSupported: false });
      document = await loading.promise;
      for (let page = 1; page <= document.numPages; page++) {
        const source = await document.getPage(page);
        try {
          const content = await readPdfTextContent(source);
          pages.push({ page, text: content.items.map((item) => "str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "").join("").trim() });
        } finally { source.cleanup(); }
        self.postMessage({ id, progress: { page, total: document.numPages } });
      }
    } else if (format === "hwp" || format === "hwpx") {
      hwpModule ||= import("../vendor/rhwp-core/rhwp.js").then(async (module) => {
        await module.default({ module_or_path: new URL("../vendor/rhwp-core/rhwp_bg.wasm", import.meta.url).href }); return module;
      });
      const core = await hwpModule;
      document = new core.HwpDocument(new Uint8Array(bytes));
      const count = document.pageCount();
      for (let page = 1; page <= count; page++) {
        const text = JSON.parse(document.getPageText(page - 1));
        if (typeof text !== "string") throw new Error("문서 본문 형식이 올바르지 않습니다.");
        pages.push({ page, text });
        self.postMessage({ id, progress: { page, total: count } });
      }
    } else throw new Error("지원하지 않는 파일 형식입니다.");
    self.postMessage({ id, result: pages });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    if (loading) await loading.destroy().catch(() => {});
    else document?.free();
    parser?.destroy();
    parserPort?.terminate();
  }
}

self.onmessage = ({ data }) => { queue = queue.then(() => extract(data)).catch(() => {}); return queue; };
