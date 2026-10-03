import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs/promises';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as rhwp from '../../vendor/rhwp-core/rhwp.js';
import { readPdfTextContent } from '../../js/pdf-text-content.js';

let document; let loading;
try {
  const bytes = new Uint8Array(workerData.bytes); const pages = [];
  if (workerData.format === 'pdf') {
    loading = pdfjs.getDocument({ data: bytes, disableFontFace: true, isEvalSupported: false, verbosity: 0 });
    document = await loading.promise;
    if (document.numPages > 10000) throw new Error('Page limit');
    for (let page = 1; page <= document.numPages; page++) {
      const source = await document.getPage(page);
      try { const content = await readPdfTextContent(source); pages.push({ page, text: content.items.map((item) => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('').trim() }); }
      finally { source.cleanup(); }
    }
  } else {
    await rhwp.default({ module_or_path: await fs.readFile(new URL('../../vendor/rhwp-core/rhwp_bg.wasm', import.meta.url)) });
    document = new rhwp.HwpDocument(bytes);
    if (document.pageCount() > 10000) throw new Error('Page limit');
    for (let page = 1; page <= document.pageCount(); page++) pages.push({ page, text: JSON.parse(document.getPageText(page - 1)) });
  }
  parentPort.postMessage({ pages });
} catch { parentPort.postMessage({ error: '문서 색인에 실패했습니다. 암호와 파일 형식을 확인하세요.' }); }
finally { if (loading) await loading.destroy(); else document?.free(); }
