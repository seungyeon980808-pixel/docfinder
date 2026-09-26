import assert from "node:assert/strict";
import test from "node:test";
import { searchLocalIndex } from "../js/local-index.js";

test("본문 검색은 모든 단어가 같은 PDF 페이지에 있는 위치를 반환한다", () => {
  const documents = [{ id: "pdf-a", name: "안전.pdf", format: "pdf", sourceUrl: "private/docs/a.pdf", previewUrl: "private/docs/a.pdf" }];
  const entries = [
    { id: "pdf-a", page: 1, text: "사전 안전 교육을 실시한다." },
    { id: "pdf-a", page: 2, text: "인솔 담당자를 지정한다." }
  ];
  const result = searchLocalIndex(documents, entries, "안전 교육");
  assert.equal(result.length, 1);
  assert.equal(result[0].page, 1);
  assert.match(result[0].excerpt, /안전 교육/u);
});

test("서로 다른 페이지에 흩어진 단어는 원문 위치로 잘못 제시하지 않는다", () => {
  const documents = [{ id: "pdf-a", name: "안전.pdf", format: "pdf" }];
  const entries = [{ id: "pdf-a", page: 1, text: "안전" }, { id: "pdf-a", page: 2, text: "교육" }];
  assert.deepEqual(searchLocalIndex(documents, entries, "안전 교육"), []);
});

test("한글 문서는 추출된 본문을 검색하되 PDF 페이지를 꾸며내지 않는다", () => {
  const documents = [{ id: "hwp-a", name: "양식.hwp", format: "hwp" }];
  const entries = [{ id: "hwp-a", page: null, text: "출장 신청 절차" }];
  const result = searchLocalIndex(documents, entries, "출장 절차");
  assert.equal(result.length, 1);
  assert.equal(result[0].page, null);
});

test("쪽별 한글 색인은 일치한 원문 쪽을 반환한다", () => {
  const documents = [{ id: "hwp-b", name: "양식.hwp", format: "hwp" }];
  const entries = [{ id: "hwp-b", page: 1, text: "표지" }, { id: "hwp-b", page: 4, text: "출장 신청 절차" }];
  const result = searchLocalIndex(documents, entries, "출장 절차");
  assert.equal(result[0].page, 4);
});

test("본문 검색은 첫 일치가 아니라 단어가 가장 가까운 페이지를 우선한다", () => {
  const documents = [{ id: "a", modifiedTime: "2026-01-01" }, { id: "b", modifiedTime: "2026-09-01" }];
  const entries = [
    { id: "a", page: 1, text: `안전 ${"다른 내용 ".repeat(40)} 교육` },
    { id: "b", page: 1, text: `안전 ${"다른 내용 ".repeat(10)} 교육` },
    { id: "a", page: 2, text: "안전 교육" }
  ];
  const result = searchLocalIndex(documents, entries, "안전 교육");
  assert.equal(result[0].id, "a");
  assert.equal(result[0].page, 2);
  assert.ok(result[0].matchDistance < result[1].matchDistance);
});
