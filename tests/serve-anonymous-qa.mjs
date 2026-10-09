import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { anonymousSharingFixture } from './anonymous-sharing-fixture.mjs';

if (process.env.DOCFINDER_QA !== '1') throw new Error('Synthetic QA only: set DOCFINDER_QA=1.');
const { app, host, library } = await anonymousSharingFixture(4177);
const { data } = await host.request(`/api/libraries/${library.id}/public-links`, { method: 'POST', body: { name: '로그인 없는 공유 · 합성 QA 자료', documentIds: ['public-alpha', 'public-beta'] } });
const url = `${app.origin}/p/${data.link.id}#k=${data.link.token}`;
await fs.writeFile(path.join(os.tmpdir(), 'docfinder-anonymous-qa.json'), JSON.stringify({ url, origin: app.origin }));
console.log(`Synthetic anonymous QA: ${url}`);
async function close() { await app.close(); process.exit(0); }
process.on('SIGINT', close); process.on('SIGTERM', close);
