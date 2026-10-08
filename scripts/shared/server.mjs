import http from 'node:http';
import fs from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LibraryService } from './library-service.mjs';
import { SharedDrive } from './google-drive.mjs';
import { googleVerifier, opaque, digest, csrfFor, equal, deny, HttpError } from './security.mjs';
import { createJobs } from './jobs.mjs';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const safeId = (id) => /^[a-zA-Z0-9_-]{1,128}$/u.test(id);
const cookieToken = (request) => /(?:^|;\s*)df_session=([a-f0-9]{64})(?:;|$)/u.exec(request.headers.cookie || '')?.[1];
async function jsonBody(request) {
  if (!String(request.headers['content-type']).startsWith('application/json')) deny(415, 'JSON 요청이 필요합니다.');
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > 65536) deny(413, '요청이 너무 큽니다.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { deny(400, '요청 형식을 확인하세요.'); }
}

export async function createSharedServer({ db, key, origin, clientId = '', clientSecret = '', dataRoot, maxFileBytes = 128 * 1024 * 1024, folderCredentials, verify, drive: providedDrive, jobs: jobsEnabled = true, extract } = {}) {
  const site = new URL(origin); const secure = site.protocol === 'https:';
  if (site.origin !== origin || !['http:', 'https:'].includes(site.protocol)) throw new Error('DOCFINDER_ORIGIN must be a URL origin without a path or trailing slash');
  if (!secure && !['localhost', '127.0.0.1', '[::1]'].includes(site.hostname)) throw new Error('HTTPS origin required');
  const drive = providedDrive || new SharedDrive({ db, key, origin, clientId, clientSecret, maxFileBytes, folderCredentials });
  const service = new LibraryService(db, drive, maxFileBytes); const verifyIdentity = verify || googleVerifier(clientId);
  const uploadsRoot = path.join(dataRoot, 'uploads'); await fs.mkdir(uploadsRoot, { recursive: true, mode: 0o700 });
  const jobs = jobsEnabled ? createJobs({ db, drive, service, extract }) : null;
  const rates = new Map();
  async function session(request) {
    const token = cookieToken(request); if (!token) return;
    const row = (await db.query(`SELECT s.hash,s.expires_at,u.id,u.email,u.name FROM df_sessions s LEFT JOIN df_users u ON u.id=s.user_id WHERE s.hash=$1 AND s.expires_at>now()`, [digest(token)])).rows[0];
    return row ? { token, hash: row.hash, user: row.id ? { id: row.id, email: row.email, name: row.name } : null } : undefined;
  }
  async function newSession(response, user) {
    await db.query('DELETE FROM df_sessions WHERE expires_at<now()');
    await db.query('DELETE FROM df_oauth_states WHERE expires_at<now()');
    const token = opaque(); await db.query(`INSERT INTO df_sessions(hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')`, [digest(token), user?.id || null]);
    response.setHeader('Set-Cookie', `df_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure ? '; Secure' : ''}`);
    return { token, hash: digest(token), user: user || null };
  }
  function write(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value));
  }
  function signedIn(current) { if (!current?.user) deny(401, 'Google 로그인이 필요합니다.'); return current.user; }
  async function serve(request, response) {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Robots-Tag', 'noindex, nofollow'); response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    const host = request.headers.host;
    if (host !== site.host) deny(403, '허용되지 않은 주소입니다.');
    const ip = request.socket.remoteAddress || 'unknown'; const minute = Math.floor(Date.now() / 60000);
    const rateKey = `${ip}:${cookieToken(request) ? digest(cookieToken(request)) : 'anonymous'}`;
    const rate = rates.get(rateKey); const count = rate?.minute === minute ? rate.count + 1 : 1;
    rates.set(rateKey, { minute, count }); if (rates.size > 10000) rates.clear();
    if (count > 600) deny(429, '요청이 많습니다. 잠시 뒤 다시 시도하세요.');
    const url = new URL(request.url, origin);
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === '/healthz' && ['GET', 'HEAD'].includes(request.method)) {
      let timer;
      try {
        await Promise.race([db.query('SELECT 1'), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Database not ready')), 3000); timer.unref(); })]);
        return write(response, 200, { status: 'ready' });
      } catch { return write(response, 503, { status: 'unavailable' }); }
      finally { clearTimeout(timer); }
    }
    if (pathname === '/favicon.ico' && request.method === 'GET') { response.writeHead(204); response.end(); return; }
    if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some((part) => part === '..')) deny(404, '찾을 수 없습니다.');
    if (url.pathname.startsWith('/api/')) {
      let current = await session(request);
      if (request.method === 'GET' && pathname === '/api/session') {
        current ||= await newSession(response);
        return write(response, 200, { user: current.user, csrf: csrfFor(current.token, key), clientId, maxFileBytes, configured: Boolean(clientId), driveConfigured: Boolean(clientId && clientSecret) });
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        if (request.headers.origin !== origin || !current || !equal(request.headers['x-csrf-token'], csrfFor(current.token, key))) deny(403, '세션을 새로고침한 뒤 다시 시도하세요.');
      }
      if (request.method === 'POST' && pathname === '/api/auth/google') {
        const body = await jsonBody(request); if (typeof body.credential !== 'string') deny(400, 'Google 로그인 정보가 필요합니다.');
        const user = await verifyIdentity(body.credential); await service.register(user);
        await db.query('DELETE FROM df_sessions WHERE hash=$1', [current.hash]); current = await newSession(response, user);
        return write(response, 200, { user, csrf: csrfFor(current.token, key) });
      }
      if (request.method === 'POST' && pathname === '/api/logout') {
        await db.query('DELETE FROM df_sessions WHERE hash=$1', [current.hash]);
        current = await newSession(response); return write(response, 200, { csrf: csrfFor(current.token, key), user: null });
      }
      const user = signedIn(current);
      if (request.method === 'GET' && pathname === '/api/libraries') return write(response, 200, { libraries: await service.libraries(user) });
      const share = /^\/api\/shares\/([a-f0-9]{64})$/u.exec(pathname);
      if (share && request.method === 'GET') return write(response, 200, await service.sharedLibrary(user, share[1]));
      if (pathname === '/api/drive/callback' && request.method === 'GET') {
        const state = url.searchParams.get('state') || '';
        const row = await db.transaction(async (tx) => (await tx.query(`DELETE FROM df_oauth_states WHERE hash=$1 AND session_hash=$2 AND expires_at>now() RETURNING *`, [digest(state), current.hash])).rows[0]);
        if (!row) deny(403, 'Drive 연결 요청이 만료되었습니다. 다시 시도하세요.');
        let result = 'connected'; let reason = '';
        try {
          if (url.searchParams.has('error')) { reason = 'access_denied'; deny(400, 'Drive 연결을 취소했습니다.'); }
          const library = await service.permission(user, row.library_id, true);
          await drive.connect(url.searchParams.get('code'), library, user);
          try { await service.sync(library.id); } catch { result = 'sync-pending'; }
        } catch (error) {
          result = 'failed';
          reason ||= error.status >= 500 ? 'temporary' : error.message?.includes('접근 권한') ? 'scope_missing'
            : error.message?.includes('지속적인') ? 'refresh_missing' : error.message?.includes('같은 Google 계정') ? 'account_mismatch' : 'connection_failed';
          console.error(`DocFinder Drive connection failed: ${reason}`);
        }
        response.writeHead(303, { Location: `/?drive=${result}${reason ? `&drive_reason=${reason}` : ''}` }); response.end(); return;
      }
      const match = /^\/api\/libraries\/([a-zA-Z0-9_-]+)(?:\/(.*))?$/u.exec(pathname);
      if (!match) deny(404, '찾을 수 없습니다.');
      const id = match[1]; const action = match[2] || '';
      if (!safeId(id)) deny(400, '문서함 주소를 확인하세요.');
      if (request.method === 'POST' && action === 'accept') { await service.accept(user, id); return write(response, 200, { accepted: true }); }
      if (request.method === 'GET' && !action) return write(response, 200, await service.catalog(user, id));
      if (request.method === 'GET' && action === 'search') return write(response, 200, { documents: await service.search(user, id, url.searchParams.get('q') || '', url.searchParams.get('mode') || 'content') });
      if (request.method === 'GET' && action === 'invitations') return write(response, 200, { invitations: await service.invitations(user, id) });
      if (request.method === 'POST' && action === 'invitations') { const { email } = await jsonBody(request); await service.invite(user, id, email); return write(response, 201, { invited: true }); }
      if (request.method === 'DELETE' && action.startsWith('invitations/')) { await service.revoke(user, id, action.slice('invitations/'.length)); return write(response, 200, { revoked: true }); }
      await service.permission(user, id);
      if (action === 'folder' && request.method === 'GET') return write(response, 200, await service.folderSettings(user, id));
      if (action === 'folder' && request.method === 'POST') { const { url } = await jsonBody(request); return write(response, 200, await service.connectFolder(user, id, url)); }
      if (action === 'folder' && request.method === 'DELETE') { await service.disconnectFolder(user, id); return write(response, 200, { disconnected: true }); }
      if (action === 'folder/prepare' && request.method === 'POST') { const { url } = await jsonBody(request); return write(response, 200, await service.prepareFolder(user, id, url)); }
      if (request.method === 'POST' && action === 'drive') {
        await service.permission(user, id, true); const state = opaque(); const authUrl = drive.authUrl(state);
        await db.query(`INSERT INTO df_oauth_states(hash,session_hash,library_id,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')`, [digest(state), current.hash, id]);
        return write(response, 200, { url: authUrl });
      }
      if (request.method === 'DELETE' && action === 'drive') {
        await service.permission(user, id, true); await db.query(`UPDATE df_connections SET status='disconnected',credentials='' WHERE library_id=$1`, [id]); return write(response, 200, { disconnected: true });
      }
      if (request.method === 'POST' && action === 'sync') { await service.permission(user, id, true); await service.sync(id); return write(response, 200, { synced: true }); }
      if (request.method === 'POST' && action === 'uploads') {
        await service.permission(user, id, true); const body = await jsonBody(request);
        const name = String(body.name || '').normalize('NFKC'); const size = Number(body.size); const uploadId = body.uploadId;
        if (!/^[a-f0-9-]{36}$/u.test(uploadId || '') || !name || name.length > 255 || /[/\\\x00-\x1f]/u.test(name) || !/\.(pdf|hwp|hwpx)$/iu.test(name) || !Number.isSafeInteger(size) || size < 1 || size > maxFileBytes) deny(400, `${maxFileBytes / 1024 / 1024}MB 이하의 PDF·HWP·HWPX 파일을 선택하세요.`);
        await db.query(`INSERT INTO df_uploads(library_id,id,name,size) VALUES($1,$2,$3,$4) ON CONFLICT(library_id,id) DO NOTHING`, [id, uploadId, name, size]);
        const row = (await db.query('SELECT * FROM df_uploads WHERE library_id=$1 AND id=$2', [id, uploadId])).rows[0];
        if (row.name !== name || Number(row.size) !== size) deny(409, '같은 업로드 번호로 다른 파일을 보낼 수 없습니다.');
        return write(response, 200, { uploadId, completed: row.status === 'done' });
      }
      const upload = /^uploads\/([a-f0-9-]{36})$/u.exec(action);
      if (request.method === 'PUT' && upload) {
        await service.permission(user, id, true);
        const row = (await db.query(`UPDATE df_uploads SET status='running',lease_until=now()+interval '10 minutes' WHERE library_id=$1 AND id=$2 AND (status='pending' OR (status='running' AND lease_until<now())) RETURNING *`, [id, upload[1]])).rows[0];
        if (!row) {
          const prior = (await db.query('SELECT status FROM df_uploads WHERE library_id=$1 AND id=$2', [id, upload[1]])).rows[0];
          if (prior?.status === 'done') { request.resume(); return write(response, 200, { uploaded: true }); }
          deny(409, '업로드가 진행 중이거나 만료되었습니다. 잠시 뒤 다시 시도하세요.');
        }
        const target = path.join(uploadsRoot, `${randomUUID()}.tmp`); let received = 0;
        try {
          if (Number(request.headers['content-length']) !== Number(row.size)) deny(400, '파일 크기를 확인하세요.');
          await pipeline(request, new Transform({ transform(chunk, encoding, callback) { received += chunk.length; callback(received > Number(row.size) ? new Error('Size limit') : null, chunk); } }), createWriteStream(target, { flags: 'wx', mode: 0o600 }));
          if (received !== Number(row.size)) deny(400, '파일 전송이 끝나지 않았습니다. 다시 시도하세요.');
          const file = await drive.upload(id, row, target);
          await db.transaction(async (tx) => { await service.upsertFile(id, file, tx); await tx.query(`UPDATE df_uploads SET status='done',document_id=$3,lease_until=NULL WHERE library_id=$1 AND id=$2`, [id, row.id, file.id]); });
          return write(response, 201, { uploaded: true });
        } catch (error) { await db.query(`UPDATE df_uploads SET status='pending',lease_until=NULL WHERE library_id=$1 AND id=$2`, [id, row.id]); throw error; }
        finally { await fs.rm(target, { force: true }); }
      }
      const document = /^documents\/([a-zA-Z0-9_-]+)\/(original|retry)$/u.exec(action);
      const removal = /^documents\/([a-zA-Z0-9_-]+)$/u.exec(action);
      if (removal && request.method === 'DELETE') {
        await service.permission(user, id, true); const item = await service.document(user, id, removal[1]);
        if (item.metadata.readOnly) deny(403, '연결한 폴더의 원본은 Google Drive에서 관리하세요.');
        await drive.trash(id, removal[1]); await db.query('DELETE FROM df_documents WHERE library_id=$1 AND id=$2', [id, removal[1]]);
        service.cache.delete(id); return write(response, 200, { trashed: true });
      }
      if (document && request.method === 'POST' && document[2] === 'retry') { await service.retry(user, id, document[1]); return write(response, 202, { queued: true }); }
      if (document && request.method === 'GET' && document[2] === 'original') {
        const row = await service.document(user, id, document[1]);
        if (url.searchParams.get('version') && url.searchParams.get('version') !== row.version) deny(409, '문서가 변경되었습니다. 목록을 새로고침하세요.');
        const bytes = await drive.bytes(id, document[1]);
        await service.permission(user, id); // Permission can change while Drive is responding.
        if (row.metadata.sourceFolderId) {
          const latest = await service.document(user, id, document[1]);
          if (latest.metadata.sourceFolderId !== row.metadata.sourceFolderId) deny(409, '폴더 연결이 변경되었습니다. 목록을 갱신하세요.');
        }
        response.writeHead(200, { 'Content-Type': row.metadata.format === 'pdf' ? 'application/pdf' : 'application/octet-stream', 'Content-Length': bytes.length, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(row.metadata.name)}` }); response.end(bytes); return;
      }
      deny(404, '찾을 수 없습니다.');
    }
    if (!['GET', 'HEAD'].includes(request.method)) deny(405, '허용되지 않은 요청입니다.');
    let relative = pathname.slice(1);
    if (pathname === '/' || /^\/s\/[a-f0-9]{64}$/u.test(pathname)) relative = 'index.html';
    if (relative === 'config.js') {
      const source = await fs.readFile(path.join(appRoot, 'config.js'), 'utf8');
      response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(source.replace('profile: "private"', 'profile: "shared"')); return;
    }
    if (relative === 'data/demo-documents.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end('export const DEMO_DOCUMENTS = [];'); return; }
    if (!['index.html', '404.html', 'privacy.html', 'terms.html'].includes(relative) && !['js', 'styles', 'vendor'].includes(relative.split('/')[0])) deny(404, '찾을 수 없습니다.');
    const file = await fs.realpath(path.join(appRoot, relative)).catch(() => deny(404, '찾을 수 없습니다.'));
    if (!file.startsWith(appRoot) || !(await fs.stat(file)).isFile()) deny(404, '찾을 수 없습니다.');
    response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    if (request.method === 'HEAD') { response.end(); return; }
    if (relative === 'index.html') { response.end((await fs.readFile(file, 'utf8')).replace('<head>', '<head>\n    <base href="/" />')); return; }
    await pipeline(createReadStream(file), response);
  }
  const server = http.createServer((request, response) => {
    serve(request, response).catch((error) => {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      write(response, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : '요청을 완료하지 못했습니다. 잠시 뒤 다시 시도하세요.' });
    });
  });
  server.requestTimeout = 300000;
  return { server, service, drive, jobs, async close() { await jobs?.stop(); await new Promise((resolve) => server.close(resolve)); } };
}
