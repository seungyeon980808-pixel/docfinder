import assert from "node:assert/strict";
import test from "node:test";
import { downloadDriveFile, DriveError, scanDriveFolder, searchDriveContent } from "../js/drive-api.js";

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

test("Drive 루트 폴더를 재귀 탐색해 첫 하위 폴더를 분류로 만든다", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/root")) return response({ id: "root", name: "업무 매뉴얼", mimeType: "application/vnd.google-apps.folder" });
    const query = url.searchParams.get("q");
    if (query.includes("'root' in parents")) return response({ files: [{ id: "education", name: "교육행정", mimeType: "application/vnd.google-apps.folder" }] });
    if (query.includes("'education' in parents")) return response({ files: [
      { id: "pdf-1", name: "생활기록부.pdf", mimeType: "application/pdf", modifiedTime: "2026-01-01T00:00:00Z", createdTime: "2025-12-01T00:00:00Z", size: "1024", owners: [{ displayName: "교육부" }] },
      { id: "hwp-1", name: "출장신청서.hwp", mimeType: "application/octet-stream", modifiedTime: "2026-01-02T00:00:00Z", createdTime: "2025-12-02T00:00:00Z", size: "2048", owners: [{ displayName: "행정실" }] },
      { id: "ignored", name: "메모.txt", mimeType: "text/plain", modifiedTime: "2026-01-03T00:00:00Z" }
    ] });
    return response({ files: [] });
  };

  const result = await scanDriveFolder("token", "root");

  assert.equal(result.rootName, "업무 매뉴얼");
  assert.deepEqual(result.documents.map(({ id, folder, path, publisher, format }) => ({ id, folder, path, publisher, format })), [
    { id: "pdf-1", folder: "교육행정", path: "교육행정 / 생활기록부.pdf", publisher: "교육부", format: "pdf" },
    { id: "hwp-1", folder: "교육행정", path: "교육행정 / 출장신청서.hwp", publisher: "행정실", format: "hwp" }
  ]);
});

test("Drive 본문 검색 결과를 현재 루트 폴더 문서와 교차 확인한다", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => response({ files: [{ id: "inside" }, { id: "outside" }] });
  const indexed = [{ id: "inside" }, { id: "another" }];

  const result = await searchDriveContent("token", "안전", indexed);

  assert.deepEqual(result, [{ id: "inside" }]);
});

test("Drive 오류 응답을 상태 코드가 있는 오류로 변환한다", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => response({ error: { message: "권한 없음" } }, 403);

  await assert.rejects(() => scanDriveFolder("token", "root"), (error) => error instanceof DriveError && error.status === 403 && error.message === "권한 없음");
});

test("Drive 원문 다운로드는 인증 헤더와 alt=media를 사용한다", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.searchParams.get("alt"), "media");
    assert.equal(init.headers.Authorization, "Bearer token");
    return new Response(new Uint8Array([1, 2, 3]));
  };

  assert.deepEqual(new Uint8Array(await downloadDriveFile("token", "hwp-1")), new Uint8Array([1, 2, 3]));
});
