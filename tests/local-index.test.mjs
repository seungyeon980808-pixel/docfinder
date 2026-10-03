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
  const result = searchLocalIndex(documents, entries, "출장, 절차");
  assert.equal(result.length, 1);
  assert.equal(result[0].page, null);
});

test("쪽별 한글 색인은 일치한 원문 쪽을 반환한다", () => {
  const documents = [{ id: "hwp-b", name: "양식.hwp", format: "hwp" }];
  const entries = [{ id: "hwp-b", page: 1, text: "표지" }, { id: "hwp-b", page: 4, text: "출장 신청 절차" }];
  const result = searchLocalIndex(documents, entries, "출장, 절차");
  assert.equal(result[0].page, 4);
});

test("본문 검색은 첫 일치가 아니라 단어가 가장 가까운 페이지를 우선한다", () => {
  const documents = [{ id: "a", modifiedTime: "2026-01-01" }, { id: "b", modifiedTime: "2026-09-01" }];
  const entries = [
    { id: "a", page: 1, text: `안전 ${"다른 내용 ".repeat(40)} 교육` },
    { id: "b", page: 1, text: `안전 ${"다른 내용 ".repeat(10)} 교육` },
    { id: "a", page: 2, text: "안전 교육" }
  ];
  const result = searchLocalIndex(documents, entries, "안전, 교육");
  assert.equal(result[0].id, "a");
  assert.equal(result[0].page, 2);
  assert.ok(result[0].matchDistance < result[1].matchDistance);
});

test("한글 띄어쓰기·줄바꿈·분해된 유니코드 차이를 원문 쪽 안에서 처리한다", () => {
  const documents = [{ id: "a", name: "안내.pdf" }];
  const entries = [{ id: "a", page: 3, text: "학교\n폭력 처리 절차".normalize("NFD") }];
  const [result] = searchLocalIndex(documents, entries, "학교폭력, 절차");
  assert.equal(result.page, 3);
  assert.match(result.excerpt, /학교\n폭력/u);
});

test("정확한 구절을 우선하고 영문 단어를 공백 너머로 합치지 않는다", () => {
  const documents = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const entries = [{ id: "a", page: 1, text: "학교의 절차에 따라 폭력 사안 처리" },
    { id: "b", page: 2, text: "학교 폭력 사안 처리" }, { id: "c", page: 1, text: "the rapist" }];
  assert.equal(searchLocalIndex(documents, entries, "학교 폭력")[0].id, "b");
  assert.deepEqual(searchLocalIndex(documents, entries, "therapist"), []);
});

test("검색 후보에서 우연히 같은 글자쌍을 가진 다른 단어를 제외한다", () => {
  const documents = [{ id: "a" }, { id: "b" }];
  const entries = [{ id: "a", page: 1, text: "abcd 안내" }, { id: "b", page: 1, text: "ab bc cd 안내" }];
  assert.deepEqual(searchLocalIndex(documents, entries, "abcd").map((item) => item.id), ["a"]);
});

test("한 글자·반복 단어 검색과 다른 색인으로 교체한 검색을 지원한다", () => {
  const documents = [{ id: "a" }];
  assert.equal(searchLocalIndex(documents, [{ id: "a", page: 2, text: "폭력 처리" }], "폭, 폭")[0].page, 2);
  assert.deepEqual(searchLocalIndex(documents, [{ id: "a", page: 1, text: "급식" }], "폭력"), []);
});

test("대표 쪽의 관련도 순위를 유지하면서 전체 일치 쪽과 위치를 보존한다", () => {
  const documents = [{ id: "a", name: "안내.pdf" }];
  const entries = [{ id: "a", page: 8, text: "학생 자치 활동 안내" },
    { id: "a", page: 3, text: "학생자치 활동 학생자치 활동" },
    { id: "a", page: 1, text: "표지" }];
  const [result] = searchLocalIndex(documents, entries, "학생자치");
  assert.equal(result.page, 3);
  assert.deepEqual(result.matchedPages.map((match) => match.page), [3, 8]);
  assert.equal(result.matchedPages[0].ranges.length, 2);
  assert.equal(result.matchedPages[1].ranges[0].end - result.matchedPages[1].ranges[0].start, 5);
});

test("쉼표 AND 검색은 같은 파일의 다른 쪽을 허용하고 같은 쪽을 우선한다", () => {
  const documents = [{ id: "same" }, { id: "split" }, { id: "missing" }];
  const entries = [{ id: "same", page: 4, text: "학교 폭력과 학생 자치" },
    { id: "split", page: 1, text: "학교 폭력" }, { id: "split", page: 9, text: "학생 자치" },
    { id: "missing", page: 1, text: "학교 폭력" }];
  const results = searchLocalIndex(documents, entries, "학교 폭력, 학생 자치");
  assert.deepEqual(results.map((item) => item.id), ["same", "split"]);
  assert.equal(results[0].samePage, true);
  assert.equal(results[1].samePage, false);
  assert.deepEqual(results[1].matchedPages.map((entry) => [entry.page, entry.ranges[0].termIndex]), [[1, 0], [9, 1]]);
  assert.deepEqual(searchLocalIndex(documents, entries, "학교 폭력 학생 자치"), []);
});

test("띄어쓰기 있는 구절과 붙은 한글은 같고 떨어진 단어는 다른 구절이다", () => {
  const documents = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const entries = [{ id: "a", page: 1, text: "학생\n자치 활동".normalize("NFD") },
    { id: "b", page: 1, text: "학생자치 활동" }, { id: "c", page: 1, text: "학생들의 참여로 운영되는 자치 활동" }];
  assert.deepEqual(new Set(searchLocalIndex(documents, entries, "학생 자치").map((item) => item.id)), new Set(["a", "b"]));
  assert.equal(searchLocalIndex(documents, entries, "학생, 자치").length, 3);
});
