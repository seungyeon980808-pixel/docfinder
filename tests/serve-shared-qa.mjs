import { sharedFixture } from './shared-fixture.mjs';
import { syntheticPdf } from './create-public-qa-fixture.mjs';
import { createJobs } from '../scripts/shared/jobs.mjs';
import fs from 'node:fs/promises';
import * as rhwp from '../vendor/rhwp-core/rhwp.js';

if (process.env.DOCFINDER_QA !== '1') throw new Error('Synthetic QA only: set DOCFINDER_QA=1.');
const app = await sharedFixture(4176, true);
const host = await app.browser('host'); const library = (await host.request('/api/libraries')).data.libraries[0];
await app.db.query(`INSERT INTO df_connections(library_id,credentials,folder_id,status) VALUES($1,'','fixture-folder','ready')`, [library.id]);
const text = '학교 폭력 학생 자치 문서입니다. 학교 폭력 대응과 학생 자치 활동을 함께 확인합니다.';
await rhwp.default({ module_or_path: await fs.readFile(new URL('../vendor/rhwp-core/rhwp_bg.wasm', import.meta.url)) });
const document = rhwp.HwpDocument.createEmpty(); document.insertText(0, 0, 0, text);
const inputs = [['synthetic-alpha.pdf', syntheticPdf(['alpha beta alpha beta', 'alpha separated', 'beta elsewhere'])], ['synthetic-korean.hwp', document.exportHwp()], ['synthetic-korean.hwpx', document.exportHwpx()]];
document.free();
for (const [name, bytes] of inputs) {
  const id = name.replaceAll('.', '-'); const metadata = { id, name, size: bytes.length, modifiedTime: '2026-10-04T01:00:00Z', appProperties: {} };
  app.files.set(id, { libraryId: library.id, metadata, bytes: Buffer.from(bytes) }); await app.service.upsertFile(library.id, metadata);
}
await app.service.invite({ id: 'host', email: 'host@gmail.com' }, library.id, 'viewer@gmail.com');
console.log(`Synthetic QA only: ${app.origin}/s/${library.share_id}`);
async function close() { await app.close(); await app.db.close(); process.exit(0); }
process.on('SIGINT', close); process.on('SIGTERM', close);
