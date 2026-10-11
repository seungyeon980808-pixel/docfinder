import assert from 'node:assert/strict';
import test from 'node:test';
import { sharedFixture } from './shared-fixture.mjs';
import { createByteCache } from '../js/preview-cache.js';
import { createIndexPreparation } from '../js/background-index.js';
import { createSearchClient } from '../js/search-client.js';
import { prepareLocalIndex, searchLocalIndex } from '../js/local-index.js';
import { loadPublicSnapshot } from '../js/store.js';
import { carryPreviewPosition, clearPreviewPositions, initialPreviewPosition, rememberPreviewPosition } from '../js/preview-position.js?v=navigation-focus-1';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('background server index preparation yields to I/O and preserves AND relevance and ranges', async () => {
  const entries = Array.from({ length: 24 }, (_, n) => ({ id: 'a', page: n + 1, text: 'alpha beta handbook '.repeat(400) }));
  const documents = [{ id: 'a', modifiedTime: '2026-10-10' }];
  const expected = searchLocalIndex(documents, structuredClone(entries), 'alpha, beta');
  let yields = 0; await prepareLocalIndex(entries, async () => { yields++; await tick(); });
  assert.ok(yields > 0); assert.deepEqual(searchLocalIndex(documents, entries, 'alpha, beta'), expected);
});

test('catalog and filename search avoid corpus loading; preparation deduplicates and bounds full reads', async t => {
  const app = await sharedFixture(); t.after(() => app.close());
  const host = await app.browser('host'); const second = await app.browser('second-host');
  const id = (await host.request('/api/libraries')).data.libraries[0].id;
  const secondId = (await second.request('/api/libraries')).data.libraries[0].id;
  for (const [libraryId, documentId] of [[id, 'file-a'], [secondId, 'file-b']]) {
    const metadata = { id: documentId, name: 'guide.pdf', size: 3, modifiedTime: '2026-10-10T00:00:00Z' };
    app.files.set(documentId, { libraryId, metadata, bytes: Buffer.from('PDF') });
    await app.service.upsertFile(libraryId, metadata);
    await app.db.query("UPDATE df_documents SET status='ready',pages=$3 WHERE library_id=$1 AND id=$2", [libraryId, documentId, JSON.stringify([{ page: 1, text: 'alpha beta' }, { page: 2, text: ' ' }])]);
  }
  const query = app.db.query.bind(app.db); let reads = 0; let active = 0; let peak = 0;
  app.db.query = async (sql, args) => {
    if (!/SELECT \* FROM df_documents WHERE library_id=\$1 ORDER BY id/u.test(sql)) return query(sql, args);
    reads++; active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 40)); return await query(sql, args); } finally { active--; }
  };
  const catalog = (await host.request(`/api/libraries/${id}`)).data;
  assert.equal(catalog.stats.searchablePages, 1); assert.equal(catalog.stats.emptyPages, 1);
  assert.equal(catalog.indexReady, false);
  assert.equal((await host.request(`/api/libraries/${id}/search?q=guide&mode=name`)).data.documents.length, 1);
  assert.equal(reads, 0, 'listing and filename search must never deserialize the full index');
  await Promise.all([host.request(`/api/libraries/${id}/prepare`), host.request(`/api/libraries/${id}/search?q=alpha`), second.request(`/api/libraries/${secondId}/prepare`)]);
  assert.equal(reads, 2, 'one corpus read per library despite concurrent preparation/search'); assert.equal(peak, 1);
  assert.equal((await host.request(`/api/libraries/${id}`)).data.indexReady, true);
  await app.db.query("INSERT INTO df_connections(library_id,credentials,folder_id,status) VALUES($1,'','folder','ready')", [id]);
  await app.service.sync(id); await host.request(`/api/libraries/${id}/prepare`);
  assert.equal(reads, 2, 'an unchanged automatic sync retains the prepared corpus');
  const url = catalog.documents[0].sourceUrl;
  assert.equal((await host.request(url, { method: 'HEAD' })).status, 200);
  app.files.get('file-a').metadata.modifiedTime = '2026-10-11T00:00:00Z';
  assert.equal((await host.request(url, { method: 'HEAD' })).status, 409, 'cached originals revalidate current Drive metadata');
  const outsider = await app.browser('outsider');
  assert.equal((await outsider.request(url, { method: 'HEAD' })).status, 403);
});

test('original cache caps downloads and cancels unneeded work while retaining another subscriber', async () => {
  let running = 0; let peak = 0; const releases = new Map(); const aborted = [];
  const load = createByteCache((item, { signal }) => new Promise((resolve, reject) => {
    running++; peak = Math.max(peak, running);
    releases.set(item.id, () => { running--; resolve(Uint8Array.from([1, 2, 3]).buffer); });
    signal.addEventListener('abort', () => { running--; aborted.push(item.id); reject(new DOMException('cancelled', 'AbortError')); }, { once: true });
  }));
  const cancel = new AbortController(); const a = load({ id: 'a' }, { signal: cancel.signal });
  await tick();
  const alsoA = load({ id: 'a' }); const b = load({ id: 'b' }); const c = load({ id: 'c' });
  await tick(); assert.equal(peak, 2);
  cancel.abort(); await assert.rejects(a, { name: 'AbortError' }); assert.deepEqual(aborted, []);
  releases.get('a')(); await alsoA; await tick(); releases.get('b')(); releases.get('c')(); await Promise.all([b, c]);
  const stop = new AbortController(); const d = load({ id: 'd' }, { signal: stop.signal });
  await tick(); stop.abort(); await assert.rejects(d, { name: 'AbortError' }); await tick();
  assert.deepEqual(aborted, ['d']); assert.equal(peak, 2);
});

test('permission failure or account reset during validation cannot expose cached private bytes', async () => {
  const validation = deferred(); let allowed = true;
  const load = createByteCache(async () => new ArrayBuffer(3), 48, { validate: async () => { await validation.promise; if (!allowed) throw new Error('revoked'); } });
  const item = { id: 'private', sourceUrl: '/private.pdf' }; await load(item);
  const pending = load(item); load.clear(); validation.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  await load(item); allowed = false;
  await assert.rejects(load(item), /revoked/);
});

test('catalog callback paints while index is still unavailable and failure remains retryable', async () => {
  const index = deferred(); const painted = deferred();
  const urls = { catalog: 'https://example.test/library/catalog.json', searchIndex: 'https://example.test/library/search-index.json' };
  const pending = loadPublicSnapshot(urls, 'https://example.test/', async url => url === urls.catalog
    ? { ok: true, json: async () => ({ version: 1, documents: [] }) } : index.promise,
  snapshot => { assert.deepEqual(snapshot.documents, []); painted.resolve(); });
  await painted.promise;
  index.resolve({ ok: false }); await assert.rejects(pending, /search index/);
});

test('late background preparation cannot replace current state; failures support explicit retry', async () => {
  const old = deferred(); let revision = 'old'; let calls = 0;
  const prep = createIndexPreparation({ isCurrent: value => value === revision, onChange() {}, request: async () => {
    calls++; if (calls === 1) return old.promise;
    if (calls === 2) throw new Error('offline'); return { ready: true, revision };
  } });
  const pending = prep.prepare('old'); await tick(); revision = 'new';
  await prep.prepare('new'); assert.equal(prep.status, 'error');
  old.resolve({ ready: true, revision: 'old' }); await pending; assert.equal(prep.status, 'error');
  await prep.prepare('new'); assert.equal(calls, 2, 'failed preparation does not retry endlessly');
  await prep.prepare('new', false, true); assert.equal(prep.status, 'ready');
});

test('stale worker responses never publish over a newer query or replacement index', async t => {
  const previous = globalThis.Worker; t.after(() => { globalThis.Worker = previous; });
  const workers = [];
  globalThis.Worker = class { constructor() { this.messages = []; workers.push(this); } postMessage(message) { this.messages.push(message); } terminate() {} };
  const client = createSearchClient(); const entries = [];
  const old = client.search([], entries, 'old').catch(error => error); const latest = client.search([], entries, 'new');
  const worker = workers[0]; worker.onmessage({ data: { id: worker.messages[0].id, result: true } }); await tick();
  assert.equal((await old).name, 'AbortError'); assert.equal(worker.messages[1].query, 'new');
  worker.onmessage({ data: { id: worker.messages[1].id, result: ['new'] } }); assert.deepEqual(await latest, ['new']);
  const stale = client.search([], entries, 'later').catch(error => error); await tick(); client.reset();
  worker.onmessage({ data: { id: worker.messages.at(-1).id, result: ['old'] } }); assert.ok(await stale instanceof Error);
});

test('automatic original replacement carries reading state only within the same file/account/query', () => {
  clearPreviewPositions();
  const old = { id: 'a', libraryId: 'host', sourceUrl: '/a?v=1' }; const next = { ...old, sourceUrl: '/a?v=2' };
  initialPreviewPosition(old, 'alpha'); rememberPreviewPosition(old, 'alpha', { page: 7, matchIndex: 2, termIndex: 0, anchor: { page: 7, fraction: .35 } });
  carryPreviewPosition(old, next, 'alpha'); assert.equal(initialPreviewPosition(next, 'alpha').page, 7);
  carryPreviewPosition(old, { ...next, libraryId: 'other' }, 'alpha'); assert.equal(initialPreviewPosition({ ...next, libraryId: 'other' }, 'alpha').page, 1);
  assert.equal(initialPreviewPosition(next, 'different query').page, 1); clearPreviewPositions();
});
