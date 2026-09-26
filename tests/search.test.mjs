import assert from "node:assert/strict";
import test from "node:test";
import { buildDriveContentQuery, documentFormat, filterDocuments, isSupportedDocument, matchProximity, parseFolderId } from "../js/search.js";

const documents = [
  { id: "a", name: "학교생활기록부 기재요령.pdf", folder: "교육행정", path: "교육행정 / 생활기록부", excerpt: "객관적인 사실에 근거하여 작성한다." },
  { id: "b", name: "현장체험학습 운영 매뉴얼.pdf", folder: "학생생활", path: "학생생활 / 체험학습", excerpt: "사전 안전교육과 인솔 계획을 수립한다." },
  { id: "c", name: "학교 안전사고 예방 안내.pdf", folder: "안전·보건", path: "안전·보건 / 학교안전", excerpt: "학생의 안전을 확보한다." }
];

test("파일 이름 검색은 이름과 경로의 중간 문자열을 찾는다", () => {
  const result = filterDocuments(documents, { query: "체험", folder: "전체", mode: "name" });
  assert.deepEqual(result.map((document) => document.id), ["b"]);
});

test("데모 본문 검색은 본문 전체에서 단어를 찾는다", () => {
  const result = filterDocuments(documents, { query: "안전", folder: "전체", mode: "content" });
  assert.deepEqual(result.map((document) => document.id), ["b", "c"]);
});

test("분류 선택은 검색 결과와 함께 적용된다", () => {
  const result = filterDocuments(documents, { query: "학교", folder: "안전·보건", mode: "name" });
  assert.deepEqual(result.map((document) => document.id), ["c"]);
});

test("Drive 본문 검색어는 PDF로 제한하고 따옴표를 안전하게 이스케이프한다", () => {
  assert.equal(buildDriveContentQuery("교사의 안전"), "mimeType = 'application/pdf' and trashed = false and fullText contains '교사의' and fullText contains '안전'");
  assert.equal(buildDriveContentQuery("교사's 안내"), "mimeType = 'application/pdf' and trashed = false and fullText contains '교사\\'s' and fullText contains '안내'");
});

test("Drive 폴더 URL과 ID를 모두 설정값으로 받을 수 있다", () => {
  assert.equal(parseFolderId("https://drive.google.com/drive/folders/abc_DEF-123?usp=sharing"), "abc_DEF-123");
  assert.equal(parseFolderId("abc_DEF-123"), "abc_DEF-123");
  assert.equal(parseFolderId(""), "");
});

test("PDF와 HWP/HWPX를 확장자 또는 MIME 형식으로 식별한다", () => {
  assert.equal(documentFormat("생활기록부.PDF"), "pdf");
  assert.equal(documentFormat("업무편람.hwp", "application/octet-stream"), "hwp");
  assert.equal(documentFormat("신청서", "application/vnd.hancom.hwpx"), "hwpx");
  assert.equal(isSupportedDocument("메모.txt", "text/plain"), false);
});

test("로컬 색인이 있는 한글 문서는 본문 검색 대상에 포함된다", () => {
  const indexed = [{ id: "hwp", name: "서식.hwp", folder: "교원업무", path: "교원업무 / 서식.hwp", excerpt: "", indexedText: "출장 신청 절차" }];
  assert.deepEqual(filterDocuments(indexed, { query: "출장", folder: "전체", mode: "content" }).map((item) => item.id), ["hwp"]);
});

test("여러 단어 검색은 순서와 관계없이 모두 찾고 가까운 위치를 점수화한다", () => {
  assert.equal(filterDocuments(documents, { query: "운영 현장체험학습", folder: "전체", mode: "name" })[0].id, "b");
  assert.ok(matchProximity("안전 교육", "안전 교육").distance < matchProximity("안전 관련 여러 절차를 거친 뒤 교육", "안전 교육").distance);
  assert.equal(matchProximity("안전 안내", "안전 교육"), null);
});
