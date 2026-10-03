import fs from 'node:fs/promises';
import { OAuth2Client } from 'google-auth-library';
import { encrypt, decrypt, deny, identityFromPayload, HttpError } from './security.mjs';

const scope = 'https://www.googleapis.com/auth/drive.file';
const fields = 'id,name,mimeType,modifiedTime,createdTime,size,md5Checksum,appProperties';
export class SharedDrive {
  constructor({ db, key, clientId, clientSecret, origin, maxFileBytes = 128 * 1024 * 1024 }) { Object.assign(this, { db, key, clientId, clientSecret, origin, maxFileBytes }); this.refreshes = new Map(); this.accessTokens = new Map(); }
  client() { return new OAuth2Client(this.clientId, this.clientSecret, `${this.origin}/api/drive/callback`); }
  authUrl(state) {
    if (!this.clientId || !this.clientSecret) deny(503, '운영자의 Google Drive 연결 설정이 필요합니다.');
    return this.client().generateAuthUrl({ access_type: 'offline', prompt: 'consent', state, scope: ['openid', 'email', 'profile', scope] });
  }
  async connect(code, library, user) {
    let tokens;
    try { ({ tokens } = await this.client().getToken(code)); } catch { deny(400, 'Drive 연결을 다시 시도하세요.'); }
    const ticket = await this.client().verifyIdToken({ idToken: tokens.id_token, audience: this.clientId });
    if (identityFromPayload(ticket.getPayload()).id !== user.id) deny(403, '로그인한 계정과 같은 Google 계정의 Drive를 연결하세요.');
    if (!String(tokens.scope || '').split(/\s+/u).includes(scope)) deny(403, 'Drive 파일 접근 권한을 허용하세요.');
    const previous = (await this.db.query('SELECT * FROM df_connections WHERE library_id=$1', [library.id])).rows[0];
    const old = previous?.credentials ? decrypt(previous.credentials, this.key) : {};
    const refreshToken = tokens.refresh_token || old.refresh_token;
    if (!refreshToken) deny(400, '지속적인 연결을 허용한 뒤 Drive를 다시 연결하세요.');
    const folders = await this.list(tokens.access_token, `mimeType='application/vnd.google-apps.folder' and 'me' in owners and trashed=false and appProperties has { key='docfinderLibrary' and value='1' }`);
    const folder = previous && folders.find((item) => item.id === previous.folder_id) || folders[0]
      || await this.request(tokens.access_token, 'https://www.googleapis.com/drive/v3/files?fields=id,name', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'DocFinder', mimeType: 'application/vnd.google-apps.folder', appProperties: { docfinderLibrary: '1' } })
      }).then((response) => response.json());
    await this.db.query(`INSERT INTO df_connections(library_id,credentials,folder_id,status) VALUES($1,$2,$3,'ready') ON CONFLICT(library_id) DO UPDATE SET credentials=excluded.credentials,folder_id=excluded.folder_id,status='ready'`,
      [library.id, encrypt({ refresh_token: refreshToken }, this.key), folder.id]);
  }
  async token(libraryId) {
    if (this.refreshes.has(libraryId)) return this.refreshes.get(libraryId);
    const next = (async () => {
      const row = (await this.db.query('SELECT * FROM df_connections WHERE library_id=$1', [libraryId])).rows[0];
      if (!row || row.status !== 'ready') deny(409, '호스트가 Google Drive를 다시 연결해야 합니다.');
      const cached = this.accessTokens.get(libraryId);
      if (cached?.credentials === row.credentials && cached.expires > Date.now() + 60000) return cached.token;
      const client = this.client(); client.setCredentials(decrypt(row.credentials, this.key));
      try {
        const { token } = await client.getAccessToken(); if (!token) throw new Error();
        this.accessTokens.set(libraryId, { token, credentials: row.credentials, expires: client.credentials.expiry_date || Date.now() + 1800000 });
        while (this.accessTokens.size > 100) this.accessTokens.delete(this.accessTokens.keys().next().value);
        return token;
      }
      catch {
        this.accessTokens.delete(libraryId);
        await this.db.query(`UPDATE df_connections SET status='reauthorize' WHERE library_id=$1`, [libraryId]);
        deny(409, '호스트가 Google Drive를 다시 연결해야 합니다.');
      }
    })();
    this.refreshes.set(libraryId, next);
    try { return await next; } finally { this.refreshes.delete(libraryId); }
  }
  async request(token, url, init = {}) {
    const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(120000), headers: { ...init.headers, Authorization: `Bearer ${token}` } });
    if (response.status === 401) {
      for (const [id, cached] of this.accessTokens) {
        if (cached.token !== token) continue;
        this.accessTokens.delete(id); await this.db.query(`UPDATE df_connections SET status='reauthorize' WHERE library_id=$1`, [id]);
      }
      deny(409, '호스트가 Google Drive를 다시 연결해야 합니다.');
    }
    if (!response.ok) throw new HttpError(response.status === 404 ? 404 : 502, response.status === 404 ? 'Drive 원문이 삭제되었거나 접근할 수 없습니다.' : 'Google Drive 요청을 완료하지 못했습니다. 잠시 뒤 다시 시도하세요.');
    return response;
  }
  async list(token, query) {
    const result = []; let pageToken = '';
    do {
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.search = new URLSearchParams({ q: query, pageSize: '1000', fields: `nextPageToken,files(${fields})`, ...(pageToken ? { pageToken } : {}) });
      const data = await (await this.request(token, url)).json(); result.push(...data.files || []); pageToken = data.nextPageToken || '';
    } while (pageToken);
    return result;
  }
  async files(libraryId) {
    const connection = (await this.db.query('SELECT folder_id FROM df_connections WHERE library_id=$1', [libraryId])).rows[0];
    if (!connection) deny(409, 'Google Drive를 먼저 연결하세요.');
    return this.list(await this.token(libraryId), `'${connection.folder_id.replaceAll("'", '')}' in parents and trashed=false and appProperties has { key='docfinderDocument' and value='1' }`);
  }
  async bytes(libraryId, id) {
    const response = await this.request(await this.token(libraryId), `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > this.maxFileBytes) { await response.body.cancel().catch(() => {}); deny(413, `파일은 ${this.maxFileBytes / 1024 / 1024}MB 이하로 준비하세요.`); } chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  async upload(libraryId, upload, filename) {
    const token = await this.token(libraryId);
    // Recover an upload completed in Drive before the server response was saved.
    const prior = (await this.files(libraryId)).find((file) => file.appProperties?.docfinderUpload === upload.id);
    if (prior) return prior;
    const { folder_id } = (await this.db.query('SELECT folder_id FROM df_connections WHERE library_id=$1', [libraryId])).rows[0];
    const mimeType = { pdf: 'application/pdf', hwp: 'application/x-hwp', hwpx: 'application/vnd.hancom.hwpx' }[upload.name.split('.').pop().toLowerCase()];
    const response = await this.request(token, `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=${encodeURIComponent(fields)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': mimeType, 'X-Upload-Content-Length': String(upload.size) },
      body: JSON.stringify({ name: upload.name, mimeType, parents: [folder_id], appProperties: { docfinderDocument: '1', docfinderUpload: upload.id } })
    });
    const target = new URL(response.headers.get('Location') || '');
    if (target.origin !== 'https://www.googleapis.com' || !target.pathname.startsWith('/upload/drive/')) deny(502, 'Drive 업로드 주소를 확인하지 못했습니다.');
    const file = await fs.open(filename, 'r'); let offset = 0;
    try {
      while (offset < Number(upload.size)) {
        const chunk = Buffer.alloc(Math.min(8 * 1024 * 1024, Number(upload.size) - offset));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
        if (bytesRead !== chunk.length) throw new Error('Incomplete upload');
        const end = offset + bytesRead;
        const part = await fetch(target, { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(120000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType, 'Content-Range': `bytes ${offset}-${end - 1}/${upload.size}` }, body: chunk });
        if (part.ok) return part.json();
        if (part.status !== 308) deny(502, 'Drive 업로드에 실패했습니다. 같은 파일을 다시 시도하세요.');
        const match = /^bytes=0-(\d+)$/u.exec(part.headers.get('Range') || ''); const next = match ? Number(match[1]) + 1 : offset;
        if (next <= offset || next > end || next >= Number(upload.size)) deny(502, 'Drive 업로드 진행을 확인하지 못했습니다.');
        offset = next;
      }
    } finally { await file.close(); }
    deny(502, 'Drive 업로드 완료를 확인하지 못했습니다.');
  }
  async trash(libraryId, id) {
    await this.request(await this.token(libraryId), `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true })
    });
  }
}
