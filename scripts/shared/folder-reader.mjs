import { JWT } from 'google-auth-library';
import { deny } from './security.mjs';

const validId = (id) => /^[a-zA-Z0-9_-]{10,128}$/u.test(id || '');
const folderMime = 'application/vnd.google-apps.folder';
const fields = 'id,name,mimeType,parents,trashed,size,modifiedTime,createdTime,md5Checksum,owners(emailAddress)';

export function driveFolderId(value) {
  let url;
  try { url = new URL(value); } catch { deny(400, 'Google Drive 폴더 링크를 입력하세요.'); }
  const match = /^\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]+)\/?$/u.exec(url.pathname);
  if (url.origin !== 'https://drive.google.com' || url.username || url.password || !validId(match?.[1])) deny(400, 'Google Drive 폴더 링크를 입력하세요.');
  return match[1];
}

// This identity has no project IAM roles or domain delegation. Drive's folder
// sharing permissions determine which originals it can read.
export class FolderReader {
  constructor(credentials, maxFileBytes = 128 * 1024 * 1024) {
    this.maxFileBytes = maxFileBytes;
    if (!credentials) return;
    if (credentials.type !== 'service_account' || !/^[^@]+@[^@]+\.iam\.gserviceaccount\.com$/u.test(credentials.client_email || '') || !credentials.private_key?.startsWith('-----BEGIN PRIVATE KEY-----')) throw new Error('Invalid folder reader credentials');
    this.email = credentials.client_email;
    this.client = new JWT({ email: this.email, key: credentials.private_key, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  }
  get configured() { return Boolean(this.client); }
  async request(id, query = {}, limit = this.maxFileBytes) {
    if (!this.configured) deny(503, '운영자가 폴더 연결 설정을 준비하고 있습니다.');
    if (id && !validId(id)) deny(400, '파일 주소를 확인하세요.');
    const url = new URL(`https://www.googleapis.com/drive/v3/files${id ? `/${id}` : ''}`);
    url.search = new URLSearchParams({ supportsAllDrives: 'true', ...query });
    let response;
    try {
      const { token } = await this.client.getAccessToken();
      if (!token) throw new Error();
      response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(120000) });
    } catch { deny(503, 'Drive 폴더에 일시적으로 연결하지 못했습니다. 자동으로 다시 시도합니다.'); }
    if ([403, 404].includes(response.status)) deny(403, '폴더를 DocFinder 전용 계정에 뷰어로 공유했는지 확인하세요.');
    if (!response.ok) deny(503, 'Drive 폴더를 읽지 못했습니다. 잠시 뒤 다시 시도하세요.');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) { await response.body.cancel().catch(() => {}); deny(413, '파일이 허용 크기를 초과합니다.'); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async metadata(id) { return JSON.parse(await this.request(id, { fields }, 65536)); }
  async folder(id) {
    const item = await this.metadata(id);
    if (item.mimeType !== folderMime || item.trashed) deny(400, '사용할 수 있는 Drive 폴더를 선택하세요.');
    return item;
  }
  async children(id, extra = '') {
    const files = []; let pageToken = '';
    do {
      const data = JSON.parse(await this.request('', { q: `'${id}' in parents and trashed=false${extra}`, pageSize: '1000', fields: `nextPageToken,files(${fields})`, includeItemsFromAllDrives: 'true', ...(pageToken ? { pageToken } : {}) }, 8 * 1024 * 1024));
      files.push(...data.files || []); pageToken = data.nextPageToken || '';
      if (files.length > 5000) deny(413, '한 폴더에 연결할 수 있는 파일 수는 5,000개입니다.');
    } while (pageToken);
    return files;
  }
  async files(root) {
    await this.folder(root);
    const queue = [{ id: root, depth: 0, path: '' }]; const seen = new Set(); const files = [];
    while (queue.length) {
      const current = queue.shift(); if (seen.has(current.id)) continue; seen.add(current.id);
      if (seen.size > 1000) deny(413, '연결 폴더의 하위 폴더 수가 너무 많습니다.');
      for (const item of await this.children(current.id)) {
        if (item.mimeType === folderMime) {
          if (current.depth >= 20) deny(413, '하위 폴더는 20단계까지 연결할 수 있습니다.');
          queue.push({ id: item.id, depth: current.depth + 1, path: `${current.path}${item.name}/` });
        } else if (/\.(pdf|hwp|hwpx)$/iu.test(item.name) && item.mimeType !== 'application/vnd.google-apps.shortcut') {
          files.push({ ...item, sourceFolderId: root, relativePath: `${current.path}${item.name}` });
          if (files.length > 5000) deny(413, '연결할 수 있는 문서는 5,000개입니다.');
        }
      }
    }
    return files;
  }
  async bytes(root, id, limit = this.maxFileBytes) {
    await this.folder(root);
    const item = await this.metadata(id);
    if (item.trashed || Number(item.size) > limit) deny(404, '원문을 열 수 없습니다.');
    let parents = item.parents || []; const seen = new Set(); let inside = false;
    for (let depth = 0; parents.length && depth <= 20; depth++) {
      if (parents.includes(root)) { inside = true; break; }
      const next = [];
      for (const parent of parents) { if (seen.has(parent)) continue; seen.add(parent); next.push(...(await this.metadata(parent)).parents || []); }
      parents = next;
    }
    if (!inside) deny(403, '이 문서는 연결한 폴더 밖으로 이동했습니다. 목록을 갱신하세요.');
    return this.request(id, { alt: 'media' }, limit);
  }
}
