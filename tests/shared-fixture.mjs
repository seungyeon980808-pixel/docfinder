import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createDatabase } from '../scripts/shared/database.mjs';
import { createSharedServer } from '../scripts/shared/server.mjs';
import { identityFromPayload } from '../scripts/shared/security.mjs';

export async function sharedFixture(port = 0, automatic = false, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'docfinder-shared-test-'));
  const db = await createDatabase(); const files = new Map(); let uploadCount = 0;
  const drive = { authUrl: () => 'https://accounts.google.com/', async files(id) { return [...files.values()].filter((file) => file.libraryId === id).map((file) => file.metadata); },
    async trash(id, documentId) { if (files.get(documentId)?.libraryId !== id) throw new Error('Not found'); files.delete(documentId); },
    async bytes(id, documentId) { const file = files.get(documentId); if (!file || file.libraryId !== id) throw new Error('Not found'); return file.bytes; },
    async upload(id, row, filename) {
      const prior = [...files.values()].find((item) => item.libraryId === id && item.metadata.appProperties.docfinderUpload === row.id);
      if (prior) return prior.metadata;
      const bytes = await fs.readFile(filename); const documentId = `fixture-${++uploadCount}`;
      const metadata = { id: documentId, name: row.name, size: bytes.length, modifiedTime: '2026-10-04T01:00:00Z', md5Checksum: createHash('md5').update(bytes).digest('hex'), appProperties: { docfinderUpload: row.id } };
      files.set(documentId, { libraryId: id, metadata, bytes }); return metadata;
    }
  };
  // Test-only dependency injection. Production startup never loads this file.
  const verify = async (credential) => {
    if (!['host', 'viewer', 'outsider', 'second-host', 'viewer-renamed'].includes(credential)) throw new Error('Invalid fixture identity');
    const id = credential === 'viewer-renamed' ? 'viewer' : credential;
    return identityFromPayload({ sub: id, email: `${credential}@gmail.com`, name: { host: '자료 관리자', viewer: '초대받은 사람' }[id] || id, email_verified: true });
  };
  // Reserve a free port first so the configured origin and Host checks match.
  if (!port) { const http = await import('node:http'); const probe = http.createServer(); await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve)); port = probe.address().port; await new Promise((resolve) => probe.close(resolve)); }
  const origin = `http://localhost:${port}`;
  const app = await createSharedServer({ db, key: randomBytes(32), origin, dataRoot: directory, verify, drive, jobs: automatic, ...options });
  await new Promise((resolve) => app.server.listen(port, '127.0.0.1', resolve));
  async function browser(identity) {
    let cookie = ''; let csrf = '';
    async function request(url, { method = 'GET', body, raw, headers = {} } = {}) {
      const response = await fetch(`${origin}${url}`, { method, headers: { Cookie: cookie, ...(method !== 'GET' ? { Origin: origin, 'X-CSRF-Token': csrf } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: raw || (body !== undefined ? JSON.stringify(body) : undefined) });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const type = response.headers.get('content-type') || '';
      const data = type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
      if (data.csrf) csrf = data.csrf;
      return { status: response.status, data, headers: response.headers };
    }
    await request('/api/session'); if (identity) await request('/api/auth/google', { method: 'POST', body: { credential: identity } });
    return { request, get cookie() { return cookie; }, get csrf() { return csrf; } };
  }
  return { ...app, db, files, origin, browser, get uploadCount() { return uploadCount; }, async close() { await app.close(); await db.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}
