import assert from "node:assert/strict";
import test from "node:test";
import { excerptAroundMatch, findBestHwpPage, matchesAllTerms, parseRhwpUnicodeText } from "../js/hwp-index.js";

test("한글 본문 검색은 공백으로 나눈 모든 단어를 포함해야 한다", () => {
  assert.equal(matchesAllTerms("교외 체험학습 신청과 안전교육", "체험학습 안전"), true);
  assert.equal(matchesAllTerms("교외 체험학습 신청", "체험학습 안전"), false);
});

test("본문 발췌는 검색어 주변을 표시한다", () => {
  const excerpt = excerptAroundMatch(`${"가".repeat(100)}안전교육${"나".repeat(100)}`, "안전", 12);
  assert.match(excerpt, /….*안전교육.*…/u);
});

test("RHWP Unicode JSON 문자열을 일반 문자열로 변환한다", () => {
  assert.equal(parseRhwpUnicodeText('"학교 업무 매뉴얼"'), "학교 업무 매뉴얼");
  assert.throws(() => parseRhwpUnicodeText('{"text":"잘못된 형식"}'), TypeError);
});

test("한글 검색은 여러 단어가 가장 가까운 원문 쪽을 반환한다", () => {
  const pages = [
    { page: 1, text: "제출 대상자 안내" },
    { page: 2, text: `제출 ${"기타 안내 ".repeat(20)} 절차` },
    { page: 3, text: "제출 절차 확인" }
  ];
  assert.equal(findBestHwpPage(pages, "제출 절차")?.page, 3);
  assert.equal(findBestHwpPage(pages, "없는 단어"), null);
});
