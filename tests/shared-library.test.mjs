import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as rhwp from '../vendor/rhwp-core/rhwp.js';
import { createDatabase } from '../scripts/shared/database.mjs';
import { LibraryService } from '../scripts/shared/library-service.mjs';
import { googleVerifier } from '../scripts/shared/security.mjs';
import { sharedFixture } from './shared-fixture.mjs';
import { syntheticPdf } from './create-public-qa-fixture.mjs';
import { createJobs, extractPages } from '../scripts/shared/jobs.mjs';
import { encrypt, decrypt, identityFromPayload } from '../scripts/shared/security.mjs';

test('Google identity authority and encrypted credentials', () => {
  assert.throws(() => identityFromPayload({ sub: 'x', email: 'user@example.com', email_verified: true }), /Workspace/);
  assert.throws(() => identityFromPayload({ sub: 'x', email: 'user@gmail.com', email_verified: false }));
  assert.equal(identityFromPayload({ sub: 'school', email: 'user@school.example', hd: 'school.example', email_verified: true }).id, 'school');
  const key = randomBytes(32); const ciphertext = encrypt({ refresh_token: 'fixture-token' }, key);
  assert.ok(!ciphertext.includes('fixture-token')); assert.equal(decrypt(ciphertext, key).refresh_token, 'fixture-token');
  assert.throws(() => decrypt(ciphertext, randomBytes(32)));
});

test('Free hosting health checks do not create sessions and configured size caps protect upload and indexing', async (t) => {
  const app = await sharedFixture(0, false, { maxFileBytes: 2048 }); t.after(() => app.close());
  const ready = await fetch(`${app.origin}/healthz`);
  assert.equal(ready.status, 200); assert.deepEqual(await ready.json(), { status: 'ready' });
  assert.equal(ready.headers.get('set-cookie'), null);
  assert.equal((await app.db.query('SELECT count(*) AS count FROM df_sessions')).rows[0].count, 0);
  const head = await fetch(`${app.origin}/healthz`, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  const query = app.db.query;
  try {
    app.db.query = async () => { throw new Error('Private database connection details'); };
    const failed = await fetch(`${app.origin}/healthz`);
    assert.equal(failed.status, 503); assert.deepEqual(await failed.json(), { status: 'unavailable' });
  } finally { app.db.query = query; }
  const host = await app.browser('host');
  assert.equal((await host.request('/api/session')).data.maxFileBytes, 2048);
  const id = (await host.request('/api/libraries')).data.libraries[0].id;
  assert.equal((await host.request(`/api/libraries/${id}/uploads`, { method: 'POST', body: { uploadId: randomUUID(), name: 'too-large.pdf', size: 2049 } })).status, 400);
  assert.equal(app.uploadCount, 0);
  await app.service.upsertFile(id, { id: 'too-large', name: 'large.pdf', size: 2049, modifiedTime: '2026-10-04T01:00:00Z' });
  await app.service.upsertFile(id, { id: 'within-cap', name: 'small.pdf', size: 2048, modifiedTime: '2026-10-04T01:00:00Z' });
  assert.deepEqual((await host.request(`/api/libraries/${id}`)).data.documents.map((doc) => doc.id), ['within-cap']);
  assert.equal((await app.db.query('SELECT count(*) AS count FROM df_jobs')).rows[0].count, 1);
});

test('Shared library HTTP: invitations, tenant isolation, jobs, revocation and upload recovery', { timeout: 30000 }, async (t) => {
  const app = await sharedFixture(); t.after(() => app.close());
  const host = await app.browser('host'); const viewer = await app.browser('viewer'); const outsider = await app.browser('outsider'); const anonymous = await app.browser();
  const library = (await host.request('/api/libraries')).data.libraries[0]; const id = library.id;
  const base = `/api/libraries/${id}`;
  const pdf = syntheticPdf(['alpha beta alpha beta', 'alpha separated', 'beta elsewhere']);
  const uploadId = randomUUID();
  await t.test('No public corpus, server files, anonymous search or forged write', async () => {
    assert.equal((await anonymous.request(`${base}/search?q=alpha`)).status, 401);
    for (const url of ['/private/search-index.json', '/library/catalog.json', '/scripts/shared/server.mjs', '/.env', '/.docfinder-data/encryption.key', '/node_modules/pg/package.json']) assert.equal((await anonymous.request(url)).status, 404);
    assert.match((await anonymous.request(`/s/${library.share_id}`)).data.toString(), /base href="\/"/);
    assert.equal((await host.request(`${base}/invitations`, { method: 'POST', body: { email: 'viewer@gmail.com' }, headers: { Origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await host.request(`${base}/invitations`, { method: 'POST', body: { email: 'viewer@gmail.com' }, headers: { 'X-CSRF-Token': 'forged' } })).status, 403);
  });
  await t.test('Pending invite requires matching account and explicit acceptance', async () => {
    assert.equal((await host.request(`${base}/invitations`, { method: 'POST', body: { email: 'VIEWER@gmail.com' } })).status, 201);
    assert.equal((await viewer.request(`/api/shares/${library.share_id}`)).data.status, 'pending');
    assert.equal((await viewer.request(base)).status, 403);
    assert.equal((await outsider.request(`${base}/accept`, { method: 'POST', body: {} })).status, 403);
    assert.equal((await outsider.request(`/api/shares/${library.share_id}`)).status, 403);
    assert.equal((await viewer.request(`${base}/accept`, { method: 'POST', body: {} })).status, 200);
    assert.equal((await viewer.request(base)).data.library.role, 'reader');
    for (const action of ['sync', 'drive', 'invitations', 'uploads']) assert.equal((await viewer.request(`${base}/${action}`, { method: 'POST', body: { email: 'outsider@gmail.com' } })).status, 403);
  });
  await t.test('Upload is persisted, same ID retries do not upload twice', async () => {
    const payload = { uploadId, name: 'synthetic.pdf', size: pdf.length };
    assert.equal((await host.request(`${base}/uploads`, { method: 'POST', body: payload })).status, 200);
    assert.equal((await host.request(`${base}/uploads/${uploadId}`, { method: 'PUT', raw: pdf, headers: { 'Content-Length': String(pdf.length) } })).status, 201);
    assert.equal((await host.request(`${base}/uploads`, { method: 'POST', body: payload })).data.completed, true);
    assert.equal((await host.request(`${base}/uploads/${uploadId}`, { method: 'PUT', raw: pdf })).status, 200);
    assert.equal(app.uploadCount, 1);
    assert.equal((await host.request(base)).data.documents[0].indexStatus, 'indexing');
  });
  const documentId = (await host.request(base)).data.documents[0].id;
  await t.test('Server indexes after owner logout and retains AND/page navigation evidence', async () => {
    await host.request('/api/logout', { method: 'POST', body: {} });
    const jobs = createJobs({ db: app.db, drive: app.drive, service: app.service, pollMs: 86400000 });
    await jobs.once(); await jobs.stop();
    const result = await viewer.request(`${base}/search?q=alpha%2C%20beta`);
    assert.equal(result.status, 200); assert.equal(result.data.documents.length, 1);
    assert.equal(result.data.documents[0].matchedPages.length, 3);
    assert.equal(result.data.documents[0].matchedPages[0].ranges.length, 4);
    const catalog = (await viewer.request(base)).data; assert.equal(catalog.stats.searchablePages, 3);
    assert.ok(!('entries' in catalog)); assert.ok(!JSON.stringify(catalog).includes('alpha separated'));
    assert.equal((await viewer.request(`${base}/documents/${documentId}/original`)).data.compare(pdf), 0);
  });
  await t.test('Stable Google subject survives email change and other owner cannot read', async () => {
    const renamed = await app.browser('viewer-renamed'); assert.equal((await renamed.request(base)).status, 200);
    const otherHost = await app.browser('second-host'); assert.equal((await otherHost.request(base)).status, 403);
    assert.equal((await otherHost.request(`${base}/documents/${documentId}/original`)).status, 403);
    assert.equal((await otherHost.request(`${base}/search?q=alpha`)).status, 403);
  });
  await t.test('Revocation blocks active session and cannot be accepted again', async () => {
    const owner = await app.browser('host');
    assert.equal((await owner.request(`${base}/invitations/viewer@gmail.com`, { method: 'DELETE' })).status, 200);
    for (const url of [base, `${base}/search?q=alpha`, `${base}/documents/${documentId}/original`]) assert.equal((await viewer.request(url)).status, 403);
    assert.equal((await viewer.request(`${base}/accept`, { method: 'POST', body: {} })).status, 403);
    assert.equal((await owner.request(base)).status, 200);
  });
  await t.test('Re-invite binds again and failed index can retry without file duplication', async () => {
    const owner = await app.browser('host');
    await viewer.request('/api/auth/google', { method: 'POST', body: { credential: 'viewer' } });
    await owner.request(`${base}/invitations`, { method: 'POST', body: { email: 'viewer@gmail.com' } });
    assert.equal((await viewer.request(`${base}/accept`, { method: 'POST', body: {} })).status, 200);
    await owner.request(`${base}/documents/${documentId}/retry`, { method: 'POST', body: {} });
    const failing = createJobs({ db: app.db, drive: app.drive, service: app.service, extract: async () => { throw new Error('Damaged'); }, pollMs: 86400000 });
    await failing.once(); await failing.stop();
    assert.equal((await owner.request(base)).data.documents[0].indexStatus, 'error');
    await owner.request(`${base}/documents/${documentId}/retry`, { method: 'POST', body: {} });
    const retry = createJobs({ db: app.db, drive: app.drive, service: app.service, pollMs: 86400000 }); await retry.once(); await retry.stop();
    assert.equal((await owner.request(base)).data.documents[0].indexStatus, 'ready'); assert.equal(app.uploadCount, 1);
  });
  await t.test('Permission is rechecked after slow Drive response', async () => {
    const owner = await app.browser('host'); const original = app.drive.bytes;
    let release; let began; const started = new Promise((resolve) => { began = resolve; }); const held = new Promise((resolve) => { release = resolve; });
    app.drive.bytes = async (...args) => { began(); await held; return original(...args); };
    const request = viewer.request(`${base}/documents/${documentId}/original`); await started;
    await owner.request(`${base}/invitations/viewer@gmail.com`, { method: 'DELETE' }); release();
    assert.equal((await request).status, 403); app.drive.bytes = original;
  });
  await t.test('Only owner can move document to Drive trash and remove its index', async () => {
    const owner = await app.browser('host');
    assert.equal((await outsider.request(`${base}/documents/${documentId}`, { method: 'DELETE' })).status, 403);
    assert.equal((await owner.request(`${base}/documents/${documentId}`, { method: 'DELETE' })).status, 200);
    assert.equal((await owner.request(`${base}/search?q=alpha`)).data.documents.length, 0);
    assert.equal((await owner.request(`${base}/documents/${documentId}/original`)).status, 404);
  });
});

test('Actual server extraction rejects damaged PDF and indexes PDF pages', async () => {
  assert.equal((await extractPages('pdf', syntheticPdf(['phrase one', 'phrase two']))).length, 2);
  await assert.rejects(extractPages('pdf', Buffer.from('not a pdf')));
});

test('Production Google verifier has no fixture sign-in fallback', async () => {
  await assert.rejects(googleVerifier('')('host'), (error) => error.status === 503);
});

test('Server extracts real synthetic HWP and HWPX with Korean phrases', async () => {
  await rhwp.default({ module_or_path: await fs.readFile(new URL('../vendor/rhwp-core/rhwp_bg.wasm', import.meta.url)) });
  const document = rhwp.HwpDocument.createEmpty(); document.insertText(0, 0, 0, '학교 폭력 대응 및 학생 자치 활동');
  try {
    for (const [format, bytes] of [['hwp', document.exportHwp()], ['hwpx', document.exportHwpx()]]) {
      const pages = await extractPages(format, bytes); assert.equal(pages.length, 1); assert.match(pages[0].text, /학교 폭력.*학생 자치/);
    }
  } finally { document.free(); }
});

test('Persistent database restores session, invitation and unfinished job after reopening', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'docfinder-persistence-test-'));
  let db = await createDatabase({ directory }); const service = new LibraryService(db, {});
  await service.register({ id: 'persist-owner', email: 'persist@gmail.com', name: 'Persist' });
  const library = (await service.libraries({ id: 'persist-owner', email: 'persist@gmail.com' }))[0];
  await service.invite({ id: 'persist-owner', email: 'persist@gmail.com' }, library.id, 'viewer@gmail.com');
  await service.upsertFile(library.id, { id: 'persist-doc', name: 'fixture.pdf', size: 5, modifiedTime: '2026-10-04T01:00:00Z' });
  await db.query(`INSERT INTO df_sessions(hash,user_id,expires_at) VALUES('fixture-session','persist-owner',now()+interval '1 day')`);
  await db.close(); db = await createDatabase({ directory });
  try {
    assert.equal((await db.query('SELECT * FROM df_sessions')).rows.length, 1);
    assert.equal((await db.query('SELECT * FROM df_invites')).rows[0].status, 'pending');
    assert.equal((await db.query('SELECT * FROM df_jobs')).rows[0].status, 'pending');
  } finally { await db.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('Expired worker lease is recovered and stale version cannot replace current pages', async (t) => {
  const app = await sharedFixture(); t.after(() => app.close());
  const user = { id: 'lease-owner', email: 'lease@gmail.com', name: 'Lease' }; await app.service.register(user);
  const library = (await app.service.libraries(user))[0]; const file = { id: 'lease-doc', name: 'fixture.pdf', size: 10, modifiedTime: '2026-10-04T01:00:00Z' };
  await app.service.upsertFile(library.id, file);
  await app.db.query(`UPDATE df_jobs SET status='running',lease_until=now()-interval '1 second',lease_owner='terminated-process'`);
  app.drive.bytes = async () => Buffer.from('fixture');
  const recover = createJobs({ db: app.db, drive: app.drive, service: app.service, pollMs: 86400000, extract: async () => [{ page: 1, text: 'restored' }] });
  assert.equal(await recover.once(), true); await recover.stop();
  assert.equal((await app.service.search(user, library.id, 'restored', 'content')).length, 1);
  await app.service.retry(user, library.id, file.id);
  const stale = createJobs({ db: app.db, drive: app.drive, service: app.service, pollMs: 86400000, extract: async () => {
    await app.service.upsertFile(library.id, { ...file, modifiedTime: '2026-10-04T02:00:00Z' }); return [{ page: 1, text: 'stale' }];
  } });
  await stale.once(); await stale.stop();
  assert.equal((await app.service.search(user, library.id, 'stale', 'content')).length, 0);
  assert.equal((await app.service.catalog(user, library.id)).documents[0].indexStatus, 'indexing');
});

test('Graceful shutdown waits for the active indexing job despite later timer ticks', { timeout: 10000 }, async (t) => {
  const app = await sharedFixture(); t.after(() => app.close());
  const user = { id: 'shutdown-owner', email: 'shutdown@gmail.com', name: 'Shutdown' }; await app.service.register(user);
  const library = (await app.service.libraries(user))[0];
  await app.service.upsertFile(library.id, { id: 'shutdown-doc', name: 'fixture.pdf', size: 1, modifiedTime: '2026-10-04T01:00:00Z' });
  app.drive.bytes = async () => Buffer.from('fixture');
  let release; let began; let stopped = false;
  const started = new Promise((resolve) => { began = resolve; }); const held = new Promise((resolve) => { release = resolve; });
  const jobs = createJobs({ db: app.db, drive: app.drive, service: app.service, pollMs: 5,
    extract: async () => { began(); await held; return [{ page: 1, text: 'completed' }]; } });
  t.after(() => jobs.stop());
  await started; await new Promise((resolve) => setTimeout(resolve, 30));
  const stopping = jobs.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(stopped, false);
  release(); await stopping;
  assert.equal((await app.service.search(user, library.id, 'completed', 'content')).length, 1);
});
