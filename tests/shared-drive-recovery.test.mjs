import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { SharedDrive } from '../scripts/shared/google-drive.mjs';
import { encrypt, HttpError } from '../scripts/shared/security.mjs';
import { sharedFixture } from './shared-fixture.mjs';

function fixture(refresh) {
  const key = randomBytes(32);
  const row = { status: 'ready', credentials: encrypt({ refresh_token: 'fixture-refresh' }, key) };
  const db = { async query(sql) {
    if (sql.startsWith('UPDATE')) row.status = 'reauthorize';
    return { rows: [row] };
  } };
  const drive = new SharedDrive({ db, key, origin: 'https://fixture.example' });
  drive.client = () => ({ setCredentials() {}, credentials: {}, getAccessToken: refresh });
  return { drive, row };
}

test('Temporary refresh failure preserves authorization and the next attempt recovers', async () => {
  let attempts = 0;
  const { drive, row } = fixture(async () => {
    if (++attempts === 1) throw new Error('Network timeout with private request details');
    return { token: 'recovered-access' };
  });
  await assert.rejects(drive.token('library'), (error) => error.status === 503 && !error.message.includes('private'));
  assert.equal(row.status, 'ready');
  assert.equal(await drive.token('library'), 'recovered-access');
  assert.equal(row.status, 'ready');
});

test('Google invalid_grant requires consent again and stops further refresh attempts', async () => {
  let attempts = 0;
  const { drive, row } = fixture(async () => {
    attempts++;
    throw Object.assign(new Error('Private token details'), { response: { data: { error: 'invalid_grant' } } });
  });
  await assert.rejects(drive.token('library'), { status: 409 });
  assert.equal(row.status, 'reauthorize');
  await assert.rejects(drive.token('library'), { status: 409 });
  assert.equal(attempts, 1);
});

test('An expired access token is refreshed once without revoking the Drive connection', async (t) => {
  const { drive, row } = fixture(async () => ({ token: 'fresh-access' }));
  drive.accessTokens.set('library', { token: 'expired-access', credentials: row.credentials, expires: Date.now() + 3600000 });
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    seen.push(init.headers.Authorization);
    return new Response('{}', { status: seen.length === 1 ? 401 : 200 });
  });
  assert.equal((await drive.request('expired-access', 'https://www.googleapis.com/drive/v3/files')).status, 200);
  assert.deepEqual(seen, ['Bearer expired-access', 'Bearer fresh-access']);
  assert.equal(row.status, 'ready');
});

test('Repeated resource 401 is bounded and does not discard a valid refresh grant', async (t) => {
  const { drive, row } = fixture(async () => ({ token: 'fresh-access' }));
  drive.accessTokens.set('library', { token: 'old-access', credentials: row.credentials, expires: Date.now() + 3600000 });
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => { attempts++; return new Response('{}', { status: 401 }); });
  await assert.rejects(drive.request('old-access', 'https://www.googleapis.com/drive/v3/files'), { status: 502 });
  assert.equal(attempts, 2);
  assert.equal(row.status, 'ready');
});

test('OAuth connection remains successful when the first list sync is temporarily unavailable', async (t) => {
  const app = await sharedFixture(); t.after(() => app.close());
  const host = await app.browser('host');
  const library = (await host.request('/api/libraries')).data.libraries[0];
  app.drive.authUrl = (state) => `https://accounts.google.com/?state=${state}`;
  app.drive.connect = async (_code, item) => {
    await app.db.query("INSERT INTO df_connections(library_id,credentials,folder_id,status) VALUES($1,'fixture','folder','ready')", [item.id]);
  };
  app.service.sync = async () => { throw new Error('Temporary provider outage with private details'); };
  const next = await host.request(`/api/libraries/${library.id}/drive`, { method: 'POST', body: {} });
  const state = new URL(next.data.url).searchParams.get('state');
  const callback = await fetch(`${app.origin}/api/drive/callback?state=${state}&code=fixture-code`, { headers: { Cookie: host.cookie }, redirect: 'manual' });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('location'), '/?drive=sync-pending');
  assert.equal((await host.request(`/api/libraries/${library.id}`)).data.driveConnected, true);
});

test('OAuth callback exposes a safe reason instead of requesting the wrong account', async (t) => {
  const app = await sharedFixture(); t.after(() => app.close());
  const host = await app.browser('host');
  const library = (await host.request('/api/libraries')).data.libraries[0];
  app.drive.authUrl = (state) => `https://accounts.google.com/?state=${state}`;
  app.drive.connect = async () => { throw new HttpError(403, 'Drive 파일 접근 권한을 허용하세요.'); };
  const next = await host.request(`/api/libraries/${library.id}/drive`, { method: 'POST', body: {} });
  const state = new URL(next.data.url).searchParams.get('state');
  const callback = await fetch(`${app.origin}/api/drive/callback?state=${state}&code=fixture-code`, { headers: { Cookie: host.cookie }, redirect: 'manual' });
  assert.equal(callback.headers.get('location'), '/?drive=failed&drive_reason=scope_missing');
});
