import { sharedFixture } from './shared-fixture.mjs';
import { syntheticPdf } from './create-public-qa-fixture.mjs';

export async function anonymousSharingFixture(port = 0) {
  const app = await sharedFixture(port); const host = await app.browser('host');
  const library = (await host.request('/api/libraries')).data.libraries[0];
  await app.db.query("INSERT INTO df_folder_sources(library_id,folder_id,name) VALUES($1,'synthetic-folder','합성 QA 폴더')", [library.id]);
  const documents = [
    ['public-alpha', '공유 자료 A.pdf', ['alpha beta alpha beta', 'beta alpha second', 'alpha third'], true],
    ['public-beta', '공유 자료 B.pdf', ['beta second document'], true],
    ['private-file', '공유하지 않은 파일.pdf', ['private secret content'], false]
  ];
  for (const [id, name, pages, folder] of documents) {
    const bytes = syntheticPdf(pages); const metadata = { id, name, size: bytes.length, modifiedTime: '2026-10-09T01:00:00Z', ...(folder ? { sourceFolderId: 'synthetic-folder', relativePath: `개인 경로/${name}` } : {}) };
    app.files.set(id, { libraryId: library.id, metadata, bytes }); await app.service.upsertFile(library.id, metadata);
    await app.db.query("UPDATE df_documents SET status='ready',pages=$3 WHERE library_id=$1 AND id=$2", [library.id, id, JSON.stringify(pages.map((text, index) => ({ page: index + 1, text })))]);
  }
  return { app, host, library };
}
