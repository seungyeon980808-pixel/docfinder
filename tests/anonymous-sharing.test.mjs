import assert from 'node:assert/strict';
import test from 'node:test';
import { sharedFixture } from './shared-fixture.mjs';
import { syntheticPdf } from './create-public-qa-fixture.mjs';

async function setup(t) {
  const app = await sharedFixture(); t.after(() => app.close());
  const host = await app.browser('host'); const guest = await app.browser();
  const library = (await host.request('/api/libraries')).data.libraries[0];
  const base = `/api/libraries/${library.id}`;
  async function seed(id, pages, folderId) {
    const bytes = syntheticPdf(pages); const metadata = { id, name: `${id}.pdf`, size: bytes.length, modifiedTime: '2026-10-09T01:00:00Z', ...(folderId ? { sourceFolderId: folderId, relativePath: `private/path/${id}.pdf` } : {}) };
    app.files.set(id, { libraryId: library.id, metadata, bytes }); await app.service.upsertFile(library.id, metadata);
    await app.db.query("UPDATE df_documents SET status='ready',pages=$3 WHERE library_id=$1 AND id=$2", [library.id, id, JSON.stringify(pages.map((text, index) => ({ page: index + 1, text })))]);
  }
  async function create(body = {}) {
    const folderId = body.scope === 'folder' ? (await app.db.query('SELECT folder_id FROM df_folder_sources WHERE library_id=$1', [library.id])).rows[0]?.folder_id : undefined;
    const response = await host.request(`${base}/public-links`, { method: 'POST', body: { documentIds: ['shared'], folderId, ...body } });
    assert.equal(response.status, 201, JSON.stringify(response.data)); return response.data.link;
  }
  async function open(link, browser = guest) {
    return browser.request(`/api/public-links/${link.id}/session`, { method: 'POST', body: { token: link.token } });
  }
  return { app, host, guest, library, base, seed, create, open };
}

test('Cached anonymous originals revalidate scoped permissions and active link revocation', async t => {
  const f = await setup(t); await f.seed('shared', ['alpha']); await f.seed('private', ['secret']);
  const link = await f.create(); await f.open(link);
  const base = `/api/public-links/${link.id}`;
  const catalog = (await f.guest.request(base)).data;
  const source = catalog.documents[0].sourceUrl;
  assert.equal((await f.guest.request(source, { method: 'HEAD' })).status, 200);
  assert.equal((await f.guest.request(`${base}/documents/private/original`, { method: 'HEAD' })).status, 404);
  await f.host.request(`${f.base}/public-links/${link.id}`, { method: 'DELETE' });
  assert.equal((await f.guest.request(source, { method: 'HEAD' })).status, 410);
  assert.equal((await f.guest.request(`${base}/prepare`)).status, 410);
});

test('Anonymous link scopes catalog, AND search, occurrence evidence and originals without Google login', async (t) => {
  const f = await setup(t); await f.seed('shared', ['학생 자치 징계 학생 자치', '징계 처리']); await f.seed('private', ['secret private 학생 자치']);
  const link = await f.create(); const url = `/api/public-links/${link.id}`;
  assert.equal(link.scope, 'files'); assert.equal(link.includeNew, false); assert.equal(link.documentCount, 1);
  assert.ok(Date.parse(link.expiresAt) > Date.now() + 6 * 86400000);
  assert.equal((await f.guest.request(`/p/${link.id}`)).status, 200);
  assert.equal((await f.guest.request(url)).status, 401);
  assert.equal((await f.open({ ...link, token: '0'.repeat(64) })).status, 403);
  assert.equal((await f.guest.request(`${url}/session`, { method: 'POST', body: { token: link.token }, headers: { Origin: 'https://other.example' } })).status, 403);
  const opened = await f.open(link); assert.equal(opened.status, 200);
  assert.match(opened.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  assert.match(opened.headers.get('set-cookie'), new RegExp(`Path=/api/public-links/${link.id}`));
  const catalog = (await f.guest.request(url)).data;
  assert.deepEqual(catalog.documents.map((doc) => doc.id), ['shared']); assert.equal(catalog.stats.searchableDocuments, 1); assert.equal(catalog.stats.searchablePages, 2);
  assert.equal(catalog.library.role, 'guest'); assert.equal(catalog.library.id, link.id);
  for (const secret of [f.library.id, f.library.share_id, 'host@gmail.com', 'private/path', link.token, 'secret_hash']) assert.ok(!JSON.stringify(catalog).includes(secret));
  assert.ok(!('entries' in catalog)); assert.ok(!('folderSource' in catalog));
  const results = (await f.guest.request(`${url}/search?q=${encodeURIComponent('학생 자치, 징계')}`)).data.documents;
  assert.equal(results.length, 1); assert.equal(results[0].id, 'shared'); assert.ok(results[0].matchedPages.length >= 1); assert.ok(results[0].matchedPages[0].ranges.length >= 3);
  assert.deepEqual((await f.guest.request(`${url}/search?q=secret`)).data.documents, []);
  assert.deepEqual((await f.guest.request(`${url}/search?mode=name&q=private`)).data.documents, []);
  assert.equal((await f.guest.request(catalog.documents[0].sourceUrl)).status, 200);
  assert.equal((await f.guest.request(`${url}/documents/private/original`)).status, 404);
  assert.equal((await f.guest.request(`${f.base}/search?q=secret`)).status, 401);
  for (const action of ['search', 'uploads', 'sync', 'invitations', 'drive', 'documents/shared/retry']) assert.equal((await f.guest.request(`${url}/${action}`, { method: 'POST', body: {} })).status, 405);
  const row = (await f.app.db.query('SELECT secret_hash,secret_encrypted FROM df_public_links WHERE id=$1', [link.id])).rows[0];
  assert.notEqual(row.secret_hash, link.token); assert.ok(!row.secret_encrypted.includes(link.token));
  assert.equal((await f.host.request(`${f.base}/public-links`)).data.links[0].token, link.token);
});

test('Only owner can create/manage links, forged writes and cross-library file IDs are rejected', async (t) => {
  const f = await setup(t); await f.seed('shared', ['alpha']);
  const viewer = await f.app.browser('viewer'); const other = await f.app.browser('second-host');
  await f.host.request(`${f.base}/invitations`, { method: 'POST', body: { email: 'viewer@gmail.com' } });
  await viewer.request(`${f.base}/accept`, { method: 'POST', body: {} });
  for (const browser of [viewer, other]) {
    assert.equal((await browser.request(`${f.base}/public-links`)).status, 403);
    assert.equal((await browser.request(`${f.base}/public-links`, { method: 'POST', body: { documentIds: ['shared'] } })).status, 403);
  }
  assert.equal((await f.guest.request(`${f.base}/public-links`)).status, 401);
  assert.equal((await f.host.request(`${f.base}/public-links`, { method: 'POST', body: { documentIds: ['shared'] }, headers: { 'X-CSRF-Token': 'forged' } })).status, 403);
  for (const body of [{ documentIds: [] }, { documentIds: ['missing'] }, { documentIds: ['shared'], includeNew: true }, { scope: 'all' }, { expiresInDays: 1 }, { includeNew: 'false' }]) assert.equal((await f.host.request(`${f.base}/public-links`, { method: 'POST', body })).status, 400);
  const link = await f.create();
  assert.equal((await other.request(`${f.base}/public-links/${link.id}`, { method: 'DELETE' })).status, 403);
});

test('Revocation, expiration and reissue invalidate active guests and old links', async (t) => {
  const f = await setup(t); await f.seed('shared', ['alpha']);
  const link = await f.create(); const url = `/api/public-links/${link.id}`; await f.open(link); assert.equal((await f.guest.request(url)).status, 200);
  const rotated = await f.host.request(`${f.base}/public-links/${link.id}/reissue`, { method: 'POST', body: {} }); assert.equal(rotated.status, 200);
  assert.notEqual(rotated.data.token, link.token); assert.equal((await f.guest.request(url)).status, 401); assert.equal((await f.open(link)).status, 403);
  assert.equal((await f.open(rotated.data)).status, 200);
  const otherLink = await f.create({ name: '다른 링크', documentIds: ['shared'] });
  assert.equal((await f.guest.request(`/api/public-links/${otherLink.id}`)).status, 401);
  await f.host.request(`${f.base}/public-links/${link.id}`, { method: 'DELETE' });
  for (const path of ['', '/search?q=alpha', '/documents/shared/original']) assert.equal((await f.guest.request(url + path)).status, 410);
  assert.equal((await f.open(rotated.data)).status, 410);
  await f.open(otherLink); await f.app.db.query("UPDATE df_public_links SET expires_at=now()-interval '1 second' WHERE id=$1", [otherLink.id]);
  assert.equal((await f.guest.request(`/api/public-links/${otherLink.id}`)).status, 410); assert.equal((await f.open(otherLink)).status, 410);
  assert.ok((await f.host.request(`${f.base}/public-links`)).data.links.every((item) => !item.token));
});

test('Folder links snapshot current files by default and publish new files only when opted in', async (t) => {
  const f = await setup(t); const folderId = 'folder-one';
  await f.app.db.query("INSERT INTO df_folder_sources(library_id,folder_id,name) VALUES($1,$2,'연결 폴더')", [f.library.id, folderId]);
  await f.seed('shared', ['alpha'], folderId); await f.seed('upload', ['private']);
  const snapshot = await f.create({ scope: 'folder' }); const automatic = await f.create({ scope: 'folder', includeNew: true, expiresInDays: 0 });
  assert.equal(automatic.expiresAt, null); await f.seed('new-file', ['beta'], folderId);
  const stale = await f.host.request(`${f.base}/public-links`, { method: 'POST', body: { scope: 'folder', folderId: 'stale-folder', documentIds: ['shared'] } });
  assert.equal(stale.status, 409);
  const reviewed = await f.create({ scope: 'folder', documentIds: ['shared'] });
  await f.open(reviewed); assert.deepEqual((await f.guest.request(`/api/public-links/${reviewed.id}`)).data.documents.map((doc) => doc.id), ['shared']);
  await f.open(snapshot); assert.deepEqual((await f.guest.request(`/api/public-links/${snapshot.id}`)).data.documents.map((doc) => doc.id), ['shared']);
  await f.open(automatic); const catalog = (await f.guest.request(`/api/public-links/${automatic.id}`)).data;
  assert.deepEqual(catalog.documents.map((doc) => doc.id), ['new-file', 'shared']); assert.ok(!JSON.stringify(catalog).includes(folderId)); assert.ok(!JSON.stringify(catalog).includes('private/path'));
  await f.app.db.query('DELETE FROM df_documents WHERE library_id=$1 AND id=$2', [f.library.id, 'shared']);
  assert.deepEqual((await f.guest.request(`/api/public-links/${automatic.id}`)).data.documents.map((doc) => doc.id), ['new-file']);
  await f.app.service.disconnectFolder({ id: 'host', email: 'host@gmail.com' }, f.library.id);
  assert.equal((await f.guest.request(`/api/public-links/${automatic.id}`)).status, 410);
  await f.app.db.query("INSERT INTO df_folder_sources(library_id,folder_id,name) VALUES($1,$2,'재연결')", [f.library.id, folderId]); await f.seed('shared', ['replacement'], folderId);
  assert.equal((await f.open(snapshot)).status, 410); // Reconnecting must not revive revoked links.
});

test('Scoped cache never expands another link and removed or rebound files lose access', async (t) => {
  const f = await setup(t); await f.seed('shared', ['alpha']); await f.seed('private', ['beta']);
  const first = await f.create(); const second = await f.create({ documentIds: ['private'] });
  await f.open(first); assert.equal((await f.guest.request(`/api/public-links/${first.id}/search?q=alpha`)).data.documents.length, 1);
  await f.open(second); assert.equal((await f.guest.request(`/api/public-links/${second.id}/search?q=alpha`)).data.documents.length, 0);
  const firstGuest = await f.app.browser(); await f.open(first, firstGuest);
  await f.app.db.query("UPDATE df_documents SET metadata=jsonb_set(metadata,'{sourceFolderId}','\"another-folder\"') WHERE library_id=$1 AND id='shared'", [f.library.id]);
  assert.equal((await firstGuest.request(`/api/public-links/${first.id}/documents/shared/original`)).status, 404);
  assert.deepEqual((await firstGuest.request(`/api/public-links/${first.id}`)).data.documents, []);
});

test('Slow original delivery rechecks revocation and version before returning private bytes', async (t) => {
  const f = await setup(t); await f.seed('shared', ['alpha']); const link = await f.create(); await f.open(link);
  const bytes = f.app.drive.bytes; let release; let began;
  const started = new Promise((resolve) => { began = resolve; }); const held = new Promise((resolve) => { release = resolve; });
  f.app.drive.bytes = async (...args) => { began(); await held; return bytes(...args); };
  const reading = f.guest.request(`/api/public-links/${link.id}/documents/shared/original`); await started;
  await f.host.request(`${f.base}/public-links/${link.id}`, { method: 'DELETE' }); release(); assert.equal((await reading).status, 410);
});

test('Anonymous exchange rate limits cannot be bypassed by forging ordinary session cookies', async (t) => {
  const f = await setup(t); await f.seed('shared', ['alpha']); const link = await f.create();
  let response;
  for (let i = 0; i < 31; i++) response = await f.guest.request(`/api/public-links/${link.id}/session`, { method: 'POST', body: { token: '0'.repeat(64) }, headers: { Cookie: `df_session=${i.toString(16).padStart(64, '0')}` } });
  assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '60');
});

test('Original concurrency is bounded and changed or oversized files never return stale bytes', { timeout: 20000 }, async (t) => {
  const f = await setup(t); await f.seed('shared', ['alpha']); const link = await f.create(); await f.open(link);
  const url = `/api/public-links/${link.id}/documents/shared/original`; const original = f.app.drive.bytes;
  let release; let began; let count = 0;
  const held = new Promise((resolve) => { release = resolve; }); const started = new Promise((resolve) => { began = resolve; });
  f.app.drive.bytes = async (...args) => { if (++count === 2) began(); await held; return original(...args); };
  const reading = Array.from({ length: 4 }, () => f.guest.request(url));
  try { await started; await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(count, 2, 'server downloads are capped at two'); assert.equal((await f.guest.request(url)).status, 429); }
  finally { release(); }
  assert.ok((await Promise.all(reading)).every((response) => response.status === 200));
  let releaseVersion; let beganVersion;
  const changing = new Promise((resolve) => { releaseVersion = resolve; }); const versionStarted = new Promise((resolve) => { beganVersion = resolve; });
  f.app.drive.bytes = async (...args) => { beganVersion(); await changing; return original(...args); };
  const slow = f.guest.request(url); await versionStarted;
  await f.app.db.query("UPDATE df_documents SET version='changed' WHERE library_id=$1 AND id='shared'", [f.library.id]); releaseVersion();
  assert.equal((await slow).status, 409);
  f.app.drive.bytes = async () => { throw new Error('Oversized metadata must be rejected before Drive download'); };
  await f.app.db.query("UPDATE df_documents SET metadata=jsonb_set(metadata,'{size}','134217729') WHERE library_id=$1 AND id='shared'", [f.library.id]);
  assert.equal((await f.guest.request(url)).status, 413);
});

test('Active links remain manageable when more than 200 newer revoked links exist', async (t) => {
  const f = await setup(t); await f.seed('shared', ['alpha']); const link = await f.create({ expiresInDays: 0 });
  await f.app.db.query("UPDATE df_public_links SET created_at='2010-01-01' WHERE id=$1", [link.id]);
  await f.app.db.query(`INSERT INTO df_public_links(id,library_id,name,scope,secret_hash,secret_encrypted,revoked_at) SELECT lpad(n::text,64,'0'),$1,'이미 해제된 링크','files','unused','unused',now() FROM generate_series(1,210) n`, [f.library.id]);
  const response = await f.host.request(`${f.base}/public-links`);
  assert.equal(response.status, 200); assert.equal(response.data.links.length, 200); assert.equal(response.data.links[0].id, link.id); assert.equal(response.data.links[0].token, link.token);
});
