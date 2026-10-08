import assert from 'node:assert/strict';
import test from 'node:test';
import { SharedDrive } from '../scripts/shared/google-drive.mjs';
import { FolderReader, driveFolderId } from '../scripts/shared/folder-reader.mjs';
import { createJobs } from '../scripts/shared/jobs.mjs';
import { sharedFixture } from './shared-fixture.mjs';
import { syntheticPdf } from './create-public-qa-fixture.mjs';

const root = 'folder-fixture-123';
const url = `https://drive.google.com/drive/folders/${root}`;

test('Folder links reject arbitrary servers, credentials, local paths and file links', () => {
  assert.equal(driveFolderId(url + '?usp=sharing'), root);
  assert.equal(driveFolderId(`https://drive.google.com/drive/u/0/folders/${root}`), root);
  for (const value of ['/private/docs', 'http://drive.google.com/drive/folders/test', 'https://evil.example/drive/folders/folder-12345', 'https://user@drive.google.com/drive/folders/folder-12345', 'https://drive.google.com/file/d/folder-12345/view']) assert.throws(() => driveFolderId(value), { status: 400 });
});

test('Reader traverses nested folders, ignores shortcuts and tags original source', async () => {
  const reader = new FolderReader(); reader.folder = async () => ({});
  reader.children = async (id) => id === root ? [
    { id: 'nested-folder-123', name: 'Nested', mimeType: 'application/vnd.google-apps.folder' },
    { id: 'document-pdf-123', name: 'one.pdf' },
    { id: 'shortcut-pdf-123', name: 'outside.pdf', mimeType: 'application/vnd.google-apps.shortcut' },
    { id: 'notes-text-12345', name: 'notes.txt' }
  ] : [{ id: 'document-hwp-123', name: 'two.hwp' }];
  const files = await reader.files(root);
  assert.deepEqual(files.map((file) => [file.name, file.relativePath, file.sourceFolderId]), [['one.pdf', 'one.pdf', root], ['two.hwp', 'Nested/two.hwp', root]]);
});

test('A moved original is blocked immediately before media is downloaded', async () => {
  const reader = new FolderReader(); reader.folder = async () => ({}); let media = 0;
  reader.metadata = async (id) => id === 'document-12345' ? { parents: ['other-root-12345'], size: '5' } : { parents: [] };
  reader.request = async () => { media++; return Buffer.from('bytes'); };
  await assert.rejects(reader.bytes(root, 'document-12345'), { status: 403 }); assert.equal(media, 0);
  reader.metadata = async (id) => id === 'document-12345' ? { parents: ['subfolder-12345'], size: '5' } : { parents: [root] };
  assert.equal((await reader.bytes(root, 'document-12345')).toString(), 'bytes'); assert.equal(media, 1);
});

test('Provider errors do not reveal credentials or URLs and transfer size is bounded', async (t) => {
  const reader = new FolderReader(undefined, 4);
  reader.client = { getAccessToken: async () => ({ token: 'fixture-token' }) };
  let rejected = true;
  t.mock.method(globalThis, 'fetch', async () => rejected ? new Response('private-provider-details', { status: 403 }) : new Response('too many bytes'));
  await assert.rejects(reader.request('document-12345'), (error) => error.status === 403 && !error.message.includes('private-provider'));
  rejected = false;
  await assert.rejects(reader.request('document-12345'), { status: 413 });
});

test('Real database folder binding, isolation, automatic index and unlink preserve originals', async (t) => {
  const app = await sharedFixture(); t.after(() => app.close());
  const host = await app.browser('host'); const outsider = await app.browser('second-host'); const viewer = await app.browser('viewer');
  const library = (await host.request('/api/libraries')).data.libraries[0]; const base = `/api/libraries/${library.id}`;
  const bytes = syntheticPdf(['alpha beta first', 'alpha second']); let owner = 'host@gmail.com'; let listingFailure = false;
  let files = [{ id: 'document-folder-123', name: 'original.pdf', size: bytes.length, modifiedTime: '2026-10-01T01:00:00Z', createdTime: '2026-10-01T01:00:00Z', sourceFolderId: root }];
  const drive = new SharedDrive({ db: app.db, maxFileBytes: 1024 * 1024 });
  drive.folderReader = { configured: true, email: 'fixture@fixture.iam.gserviceaccount.com', async folder() { return { name: 'Fixture folder', owners: [{ emailAddress: owner }] }; },
    async files() { if (listingFailure) throw new Error('Temporary'); return files; },
    async bytes(_root, id) { return id === 'proof-file-12345' ? this.proof : bytes; },
    async children() { return this.proof ? [{ id: 'proof-file-12345', size: this.proof.length }] : []; }
  };
  app.service.drive = drive;
  // Routes use the fixture object: delegate the folder interface and originals.
  app.drive.folderReader = drive.folderReader; app.drive.files = drive.files.bind(drive); app.drive.bytes = drive.bytes.bind(drive);

  await t.test('Owner-only routes and unproved cross-account binding are denied', async () => {
    await host.request(`${base}/invitations`, { method: 'POST', body: { email: 'viewer@gmail.com' } });
    await viewer.request(`${base}/accept`, { method: 'POST', body: {} });
    for (const browser of [viewer, outsider]) {
      assert.equal((await browser.request(`${base}/folder`)).status, 403);
      assert.equal((await browser.request(`${base}/folder`, { method: 'POST', body: { url } })).status, 403);
      assert.equal((await browser.request(`${base}/folder/prepare`, { method: 'POST', body: { url } })).status, 403);
    }
    owner = 'other@gmail.com';
    assert.equal((await host.request(`${base}/folder`, { method: 'POST', body: { url } })).status, 403);
    assert.equal((await app.db.query('SELECT * FROM df_folder_sources')).rows.length, 0);
  });
  await t.test('Matching owner can bind and queued originals are indexed without uploads', async () => {
    owner = 'host@gmail.com';
    assert.equal((await host.request(`${base}/folder`, { method: 'POST', body: { url } })).data.connected, true);
    const jobs = createJobs({ db: app.db, drive, service: app.service, pollMs: 86400000 }); await jobs.once(); await jobs.stop();
    const result = await viewer.request(`${base}/search?q=alpha%2Cbeta`);
    assert.equal(result.data.documents.length, 1); assert.equal(result.data.documents[0].readOnly, true);
    assert.equal((await viewer.request(`${base}/documents/document-folder-123/original`)).data.compare(bytes), 0);
    assert.equal((await host.request(`${base}/documents/document-folder-123`, { method: 'DELETE' })).status, 403);
    assert.equal(app.uploadCount, 0);
  });
  await t.test('Failed listing retains the index, later successful scan handles additions and removals', async () => {
    listingFailure = true; await assert.rejects(app.service.sync(library.id));
    assert.equal((await host.request(base)).data.documents.length, 1);
    listingFailure = false;
    files.push({ ...files[0], id: 'new-document-12345', name: 'new.hwp' }); await app.service.sync(library.id);
    assert.equal((await host.request(base)).data.documents.length, 2);
    files = [files[1]]; await app.service.sync(library.id);
    assert.equal((await host.request(base)).data.documents.length, 1);
  });
  await t.test('Cross-account approval is bound to one library and consumed, disconnect removes only folder indices', async () => {
    owner = 'other@gmail.com';
    const prepared = (await host.request(`${base}/folder/prepare`, { method: 'POST', body: { url } })).data;
    drive.folderReader.proof = Buffer.from('wrong');
    assert.equal((await host.request(`${base}/folder`, { method: 'POST', body: { url } })).status, 403);
    drive.folderReader.proof = Buffer.from(prepared.contents);
    assert.equal((await host.request(`${base}/folder`, { method: 'POST', body: { url } })).status, 200);
    assert.equal((await app.db.query('SELECT * FROM df_folder_requests')).rows.length, 0);
    assert.equal((await host.request(`${base}/folder`, { method: 'POST', body: { url } })).status, 403);
    await app.service.upsertFile(library.id, { id: 'uploaded-document-123', name: 'uploaded.pdf', size: 5, modifiedTime: '2026-10-01T01:00:00Z' });
    assert.equal((await host.request(`${base}/folder`, { method: 'DELETE' })).status, 200);
    const catalog = (await host.request(base)).data;
    assert.deepEqual(catalog.documents.map((item) => item.name), ['uploaded.pdf']); assert.equal(files.length, 1);
    assert.equal((await viewer.request(`${base}/documents/new-document-12345/original`)).status, 404);
  });
});
