import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function harness({ pdf, hwp }) {
  const messages = [];
  const source = await readFile(new URL("../js/document-index-worker.js", import.meta.url), "utf8");
  const context = vm.createContext({ URL, Uint8Array, Worker: class { terminate() {} }, mockPdf: pdf, mockHwp: hwp,
    self: { postMessage: (message) => messages.push(message) },
    readPdfTextContent: async (page) => page.content });
  const prepared = source.replace(/^import .*;$/gmu, "")
    .replaceAll("import.meta.url", '"https://fixture.test/js/worker.js"')
    .replace(/^const assets =.*;$/mu, 'const assets = "https://fixture.test/vendor/";')
    .replace("let pdfModule;", "let pdfModule = Promise.resolve(mockPdf);")
    .replace("let hwpModule;", "let hwpModule = Promise.resolve(mockHwp);");
  vm.runInContext(prepared, context);
  return { messages, call: (id, format) => context.self.onmessage({ data: { id, format, bytes: new ArrayBuffer(1) } }) };
}

test("PDF 색인 worker는 쪽별 텍스트·진행을 반환하고 페이지와 파서를 정리한다", async () => {
  let cleanups = 0; let destroyed = 0;
  const worker = await harness({ pdf: { PDFWorker: class { destroy() {} }, getDocument: (options) => {
    assert.equal(options.useWorkerFetch, true, "worker setup must not evaluate document.baseURI");
    assert.ok(options.worker, "supply a port so PDF.js does not inspect window.location");
    return { destroy: async () => { destroyed++; }, promise: Promise.resolve({
    numPages: 2,
    getPage: async (number) => ({ content: { items: [{ str: `page ${number}`, hasEOL: true }, { str: "alpha" }] }, cleanup: () => { cleanups++; } })
  }) }; } } });
  await worker.call(1, "pdf");
  assert.deepEqual(JSON.parse(JSON.stringify(worker.messages)), [
    { id: 1, progress: { page: 1, total: 2 } }, { id: 1, progress: { page: 2, total: 2 } },
    { id: 1, result: [{ page: 1, text: "page 1\nalpha" }, { page: 2, text: "page 2\nalpha" }] }
  ]);
  assert.equal(cleanups, 2); assert.equal(destroyed, 1);
});

test("한글 파싱 실패 뒤에도 자원을 해제하고 다음 문서 색인을 계속한다", async () => {
  let created = 0; let freed = 0;
  const worker = await harness({ hwp: { HwpDocument: class {
    constructor() { this.number = ++created; }
    pageCount() { return 1; }
    getPageText() { return this.number === 1 ? "malformed" : JSON.stringify("학교 폭력 학생 자치"); }
    free() { freed++; }
  } } });
  await Promise.all([worker.call(1, "hwp"), worker.call(2, "hwpx")]);
  assert.ok(worker.messages.find((message) => message.id === 1).error);
  assert.equal(worker.messages.at(-1).result[0].text, "학교 폭력 학생 자치");
  assert.equal(freed, 2);
});
