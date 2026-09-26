import assert from "node:assert/strict";
import test from "node:test";
import { buildPdfEditorUrl } from "../js/pdf-editor.js";

const documentItem = { id: "drive-1", name: "안전 매뉴얼.pdf", webViewLink: "https://drive.google.com/file/d/drive-1/view" };

test("PDF 편집기 URL에 원문 링크와 파일 정보를 쿼리로 전달한다", () => {
  const result = new URL(buildPdfEditorUrl("https://editor.example/app", documentItem));
  assert.equal(result.searchParams.get("source"), documentItem.webViewLink);
  assert.equal(result.searchParams.get("fileId"), "drive-1");
  assert.equal(result.searchParams.get("name"), "안전 매뉴얼.pdf");
});

test("PDF 편집기 URL 자리표시자를 지원한다", () => {
  const result = buildPdfEditorUrl("https://editor.example/open/{fileId}?name={name}", documentItem);
  assert.equal(result, "https://editor.example/open/drive-1?name=%EC%95%88%EC%A0%84%20%EB%A7%A4%EB%89%B4%EC%96%BC.pdf");
});
