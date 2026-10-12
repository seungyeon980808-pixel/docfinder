import assert from "node:assert/strict";
import test from "node:test";
import { readHwpPageText, HWP_TEXT_INDEX_VERSION } from "../js/hwp-page-text.js";
import { joinTextRuns, findSearchMatches } from "../js/search-matches.js";
import { searchLocalIndex } from "../js/local-index.js";
import { sharedFixture } from "./shared-fixture.mjs";
import { createJobs, queueHwpIndexRefresh } from "../scripts/shared/jobs.mjs";

// A paragraph extractor misses two chair labels in a diagram, just as the
// production document did. Original-page layout includes all three runs.
test("도식 글자를 포함한 한글 색인과 원문 강조의 위치 수·검색어 순서가 같다", () => {
  const runs = [{ text: "학생자치 회장" }, { text: "회  장" }, { text: "부 회 장" }];
  const document = { getPageTextLayout: () => JSON.stringify({ runs }), getPageText: () => JSON.stringify("학생자치 회장") };
  const text = readHwpPageText(document, 0);
  const [result] = searchLocalIndex([{ id: "drawing" }], [{ id: "drawing", page: 1, text }], "학생자치, 회장", "page");
  const highlights = findSearchMatches(joinTextRuns(runs).text, "학생자치, 회장");
  assert.equal(result.matchedPages[0].ranges.length, 4);
  assert.deepEqual(result.matchedPages[0].ranges.map(range => range.termIndex), highlights.map(range => range.termIndex));
  assert.throws(() => readHwpPageText({ getPageTextLayout: () => '{"runs":[{"text":3}]}' }, 0), TypeError);
});

test("기존 한글만 재색인하고 원문·이전 검색·공유 범위를 유지하며 새 색인 revision을 알린다", async t => {
  const app = await sharedFixture(); t.after(() => app.close());
  const host = await app.browser("host"); const library = (await host.request("/api/libraries")).data.libraries[0];
  const base = `/api/libraries/${library.id}`;
  for (const [id, format] of [["old", "hwp"], ["current", "hwpx"], ["pdf", "pdf"], ["leased", "hwp"]]) {
    const file = { id, name: `${id}.${format}`, size: 1, modifiedTime: "2026-10-12T00:00:00Z" };
    app.files.set(id, { libraryId: library.id, metadata: file, bytes: Buffer.from("original") });
    await app.service.upsertFile(library.id, file);
    await app.db.query("UPDATE df_documents SET pages=$2,status='ready' WHERE id=$1", [id, JSON.stringify([{ page: 1, text: "학생자치 회장" }])]);
    await app.db.query("UPDATE df_jobs SET status='done' WHERE document_id=$1", [id]);
  }
  await app.db.query("UPDATE df_documents SET metadata=metadata || $1::jsonb WHERE id='current'", [JSON.stringify({ textIndexVersion: HWP_TEXT_INDEX_VERSION })]);
  await app.db.query("UPDATE df_jobs SET status='running',lease_owner='other',lease_until=now()+interval '10 minutes' WHERE document_id='leased'");
  const publicLink = (await host.request(`${base}/public-links`, { method: "POST", body: { name: "검수", documentIds: ["old"] } })).data.link;
  const guest = await app.browser(); const publicBase = `/api/public-links/${publicLink.id}`;
  await guest.request(`${publicBase}/session`, { method: "POST", body: { token: publicLink.token } });
  const revision = (await host.request(base)).data.revision; const guestRevision = (await guest.request(publicBase)).data.revision;
  const query = "/search?q=" + encodeURIComponent("학생자치, 회장") + "&mode=content&matchScope=page";
  assert.equal((await guest.request(publicBase + query)).data.documents[0].matchedPages[0].ranges.length, 2);
  await queueHwpIndexRefresh(app.db); await queueHwpIndexRefresh(app.db);
  const jobs = (await app.db.query("SELECT document_id,status,lease_owner FROM df_jobs ORDER BY document_id")).rows;
  assert.equal(jobs.find(job => job.document_id === "old").status, "pending");
  assert.equal(jobs.find(job => job.document_id === "pdf").status, "done");
  assert.equal(jobs.find(job => job.document_id === "current").status, "done");
  assert.equal(jobs.find(job => job.document_id === "leased").lease_owner, "other");
  assert.equal((await host.request(base + query)).data.documents.find(doc => doc.id === "old").matchedPages[0].ranges.length, 2, "교체 전에도 기존 검색은 가능하다");
  const runner = createJobs({ db: app.db, drive: app.drive, service: app.service, pollMs: 86400000,
    extract: async () => [{ page: 1, text: "학생자치 회장 회  장 부 회 장" }] }); t.after(() => runner.stop());
  await runner.once();
  assert.notEqual((await host.request(base)).data.revision, revision);
  assert.notEqual((await guest.request(publicBase)).data.revision, guestRevision);
  assert.equal((await guest.request(publicBase + query)).data.documents[0].matchedPages[0].ranges.length, 4, "공유 검색 캐시도 교체된다");
  assert.equal((await host.request(base + query)).data.documents.find(doc => doc.id === "old").matchedPages[0].ranges.length, 4);
  assert.equal((await app.db.query("SELECT metadata FROM df_documents WHERE id='old'")).rows[0].metadata.textIndexVersion, HWP_TEXT_INDEX_VERSION);
  assert.equal((await host.request(`${base}/documents/old/original`)).data.toString(), "original");
  await queueHwpIndexRefresh(app.db);
  assert.equal((await app.db.query("SELECT status FROM df_jobs WHERE document_id='old'")).rows[0].status, "done", "새 색인은 다시 예약하지 않는다");
});
