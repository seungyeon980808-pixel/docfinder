import { randomUUID } from 'node:crypto';
import { opaque, emailAddress, deny, digest } from './security.mjs';
import { driveFolderId } from './folder-reader.mjs';
import { documentFormat, filterDocuments } from '../../js/search.js';
import { searchLocalIndex } from '../../js/local-index.js';
import { summarizeIndex } from '../../js/index-health.js';

export const fileVersion = (file) => JSON.stringify([file.modifiedTime, String(file.size), file.md5Checksum || '', file.sourceFolderId || '', file.name, file.relativePath || '']);
export class LibraryService {
  constructor(db, drive, maxFileBytes = 128 * 1024 * 1024) { this.db = db; this.drive = drive; this.maxFileBytes = maxFileBytes; this.cache = new Map(); }
  async register(user) {
    return this.db.transaction(async (tx) => {
      await tx.query(`INSERT INTO df_users(id,email,name) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name`, [user.id, user.email, user.name]);
      await tx.query(`INSERT INTO df_libraries(id,owner_id,name,share_id) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id) DO NOTHING`, [randomUUID(), user.id, `${user.name}의 문서함`, opaque()]);
      return user;
    });
  }
  async libraries(user) {
    return (await this.db.query(`SELECT l.id,l.name,l.share_id,CASE WHEN l.owner_id=$1 THEN 'owner' ELSE 'reader' END AS role,CASE WHEN l.owner_id=$1 THEN 'accepted' ELSE i.status END AS status
      FROM df_libraries l LEFT JOIN df_invites i ON i.library_id=l.id AND ((i.status='accepted' AND i.user_id=$1) OR (i.status='pending' AND i.email=$2))
      WHERE l.owner_id=$1 OR i.library_id IS NOT NULL ORDER BY CASE WHEN l.owner_id=$1 THEN 0 ELSE 1 END,l.name`, [user.id, user.email])).rows;
  }
  async permission(user, id, ownerOnly = false) {
    if (!user) deny(401, 'Google 로그인이 필요합니다.');
    const row = (await this.db.query(`SELECT l.*, EXISTS(SELECT 1 FROM df_invites i WHERE i.library_id=l.id AND i.user_id=$1 AND i.status='accepted') AS member FROM df_libraries l WHERE l.id=$2`, [user.id, id])).rows[0];
    if (!row || !(row.owner_id === user.id || !ownerOnly && row.member)) deny(403, '현재 계정으로 열 수 없는 문서함입니다.');
    return { ...row, role: row.owner_id === user.id ? 'owner' : 'reader' };
  }
  async sharedLibrary(user, shareId) {
    if (!user) deny(401, 'Google 로그인이 필요합니다.');
    const items = await this.libraries(user);
    const item = items.find((library) => library.share_id === shareId);
    if (!item) deny(403, '현재 계정으로 열 수 없는 문서함입니다.');
    return item;
  }
  async accept(user, id) {
    await this.db.transaction(async (tx) => {
      const invitation = (await tx.query(`SELECT * FROM df_invites WHERE library_id=$1 AND email=$2 FOR UPDATE`, [id, user.email])).rows[0];
      if (!invitation || invitation.status !== 'pending') deny(403, '유효한 초대가 없습니다.');
      await tx.query(`UPDATE df_invites SET user_id=$3,status='accepted' WHERE library_id=$1 AND email=$2`, [id, user.email, user.id]);
    });
  }
  async invite(user, id, email) {
    await this.permission(user, id, true); email = emailAddress(email);
    if (email === user.email) deny(400, '본인 계정은 이미 문서함을 관리할 수 있습니다.');
    await this.db.query(`INSERT INTO df_invites(library_id,email,status) VALUES($1,$2,'pending') ON CONFLICT(library_id,email) DO UPDATE SET status=CASE WHEN df_invites.status='accepted' THEN 'accepted' ELSE 'pending' END,user_id=CASE WHEN df_invites.status='accepted' THEN df_invites.user_id ELSE NULL END,created_at=now()`, [id, email]);
  }
  async revoke(user, id, email) {
    await this.permission(user, id, true);
    await this.db.query(`UPDATE df_invites SET status='revoked' WHERE library_id=$1 AND email=$2`, [id, emailAddress(email)]);
  }
  async invitations(user, id) {
    await this.permission(user, id, true);
    return (await this.db.query(`SELECT email,status,created_at FROM df_invites WHERE library_id=$1 ORDER BY created_at DESC`, [id])).rows;
  }
  async upsertFile(libraryId, file, tx = this.db) {
    const format = documentFormat(file.name, file.mimeType);
    if (!format || Number(file.size) > this.maxFileBytes) return;
    const version = fileVersion(file);
    const previous = (await tx.query('SELECT version,status,metadata FROM df_documents WHERE library_id=$1 AND id=$2', [libraryId, file.id])).rows[0];
    if (previous?.version === version && previous.metadata.sourceFolderId === file.sourceFolderId) return;
    if (previous && Date.parse(previous.metadata.modifiedTime) > Date.parse(file.modifiedTime)) return;
    await tx.query(`INSERT INTO df_documents(library_id,id,metadata,version) VALUES($1,$2,$3,$4) ON CONFLICT(library_id,id) DO UPDATE SET metadata=excluded.metadata,version=excluded.version,status='indexing',pages='[]'`,
      [libraryId, file.id, JSON.stringify({ name: file.name, format, size: Number(file.size), modifiedTime: file.modifiedTime, createdTime: file.createdTime, ...(file.sourceFolderId ? { sourceFolderId: file.sourceFolderId, relativePath: file.relativePath, readOnly: true } : {}) }), version]);
    await tx.query(`INSERT INTO df_jobs(id,library_id,document_id,version) VALUES($1,$2,$3,$4) ON CONFLICT(library_id,document_id,version) DO NOTHING`, [randomUUID(), libraryId, file.id, version]);
    this.cache.delete(libraryId);
  }
  async sync(libraryId) {
    const startedAt = new Date().toISOString();
    const binding = (await this.db.query('SELECT folder_id FROM df_folder_sources WHERE library_id=$1', [libraryId])).rows[0]?.folder_id;
    const files = await this.drive.files(libraryId);
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM df_libraries WHERE id=$1 FOR UPDATE', [libraryId]);
      const current = (await tx.query('SELECT folder_id FROM df_folder_sources WHERE library_id=$1', [libraryId])).rows[0]?.folder_id;
      if (binding !== current) deny(409, '폴더 연결이 바뀌었습니다. 목록을 다시 갱신합니다.');
      for (const file of files) await this.upsertFile(libraryId, file, tx);
      const ids = files.filter((file) => documentFormat(file.name, file.mimeType) && Number(file.size) <= this.maxFileBytes).map((file) => file.id);
      await tx.query(`DELETE FROM df_documents WHERE library_id=$1 AND NOT(id=ANY($2::text[])) AND COALESCE(metadata->>'createdTime', '1970-01-01T00:00:00Z')<$3`, [libraryId, ids, startedAt]);
      await tx.query('UPDATE df_connections SET synced_at=now() WHERE library_id=$1', [libraryId]);
      await tx.query('UPDATE df_folder_sources SET synced_at=now() WHERE library_id=$1', [libraryId]);
    });
    this.cache.delete(libraryId);
  }
  async corpus(user, id) {
    const library = await this.permission(user, id);
    let rows = (await this.db.query('SELECT id,metadata,version,status FROM df_documents WHERE library_id=$1 ORDER BY id', [id])).rows;
    let signature = JSON.stringify(rows.map((row) => [row.id, row.version, row.status]));
    let cached = this.cache.get(id);
    if (cached?.signature !== signature) {
      rows = (await this.db.query('SELECT * FROM df_documents WHERE library_id=$1 ORDER BY id', [id])).rows;
      signature = JSON.stringify(rows.map((row) => [row.id, row.version, row.status]));
      const documents = rows.map((row) => ({ ...row.metadata, id: row.id, libraryId: id, source: 'shared', folder: row.metadata.sourceFolderId ? '연결 폴더' : '문서함', path: row.metadata.relativePath || row.metadata.name,
        sha256: row.version, version: row.version, indexStatus: row.status, excerpt: '', heading: '원문',
        sourceUrl: `/api/libraries/${encodeURIComponent(id)}/documents/${encodeURIComponent(row.id)}/original?version=${encodeURIComponent(row.version)}` }));
      const entries = rows.flatMap((row) => row.pages.map((page) => ({ ...page, id: row.id })));
      cached = { signature, documents, entries, stats: summarizeIndex(documents, entries) };
      this.cache.delete(id); this.cache.set(id, cached);
      while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
    }
    const connection = (await this.db.query('SELECT status,synced_at FROM df_connections WHERE library_id=$1', [id])).rows[0];
    const folderSource = (await this.db.query('SELECT folder_id,name,status,synced_at,last_error FROM df_folder_sources WHERE library_id=$1', [id])).rows[0];
    return { ...cached, library, connection, folderSource };
  }
  async catalog(user, id) {
    const corpus = await this.corpus(user, id);
    return { library: { id, name: corpus.library.name, role: corpus.library.role, share_id: corpus.library.share_id }, documents: corpus.documents,
      stats: corpus.stats, revision: corpus.signature, driveConnected: corpus.connection?.status === 'ready', folderSource: corpus.folderSource, lastSync: corpus.folderSource?.synced_at || corpus.connection?.synced_at };
  }
  async folderSettings(user, id) {
    await this.permission(user, id, true);
    const reader = this.drive.folderReader;
    const source = (await this.db.query('SELECT folder_id,name,status,last_error FROM df_folder_sources WHERE library_id=$1', [id])).rows[0];
    return { configured: Boolean(reader?.configured), readerEmail: reader?.email || '', source };
  }
  async prepareFolder(user, id, url) {
    await this.permission(user, id, true); const folderId = driveFolderId(url);
    await this.db.query('DELETE FROM df_folder_requests WHERE expires_at<now()');
    const proof = opaque(); const filename = `docfinder-connect-${opaque()}.txt`;
    const contents = `DocFinder folder connection\nHost: ${user.email}\nFolder: ${folderId}\nApproval: ${proof}\n`;
    await this.db.query(`INSERT INTO df_folder_requests(library_id,folder_id,filename,proof_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour') ON CONFLICT(library_id) DO UPDATE SET folder_id=excluded.folder_id,filename=excluded.filename,proof_hash=excluded.proof_hash,expires_at=excluded.expires_at`, [id, folderId, filename, digest(contents)]);
    return { filename, contents };
  }
  async connectFolder(user, id, url) {
    await this.permission(user, id, true); const folderId = driveFolderId(url);
    const reader = this.drive.folderReader;
    if (!reader?.configured) deny(503, '운영자가 폴더 연결 설정을 준비하고 있습니다.');
    const folder = await reader.folder(folderId);
    if (!folder.owners?.some((owner) => owner.emailAddress?.toLowerCase() === user.email)) {
      const pending = (await this.db.query('SELECT * FROM df_folder_requests WHERE library_id=$1 AND folder_id=$2 AND expires_at>now()', [id, folderId])).rows[0];
      const proof = pending && (await reader.children(folderId, ` and name='${pending.filename}'`)).find((file) => Number(file.size) <= 4096);
      if (!proof || digest(await reader.bytes(folderId, proof.id, 4096)) !== pending.proof_hash) deny(403, '폴더 소유 계정으로 로그인하거나, 아래 연결 승인 파일을 해당 폴더에 넣은 뒤 연결하세요.');
    }
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM df_libraries WHERE id=$1 FOR UPDATE', [id]);
      await tx.query(`DELETE FROM df_documents WHERE library_id=$1 AND metadata ? 'sourceFolderId' AND metadata->>'sourceFolderId'<>$2`, [id, folderId]);
      await tx.query(`INSERT INTO df_folder_sources(library_id,folder_id,name,status) VALUES($1,$2,$3,'ready') ON CONFLICT(library_id) DO UPDATE SET folder_id=excluded.folder_id,name=excluded.name,status='ready',synced_at=NULL,last_error=''`, [id, folderId, folder.name]);
      await tx.query('DELETE FROM df_folder_requests WHERE library_id=$1', [id]);
    });
    this.cache.delete(id);
    // A confirmed binding is durable even if the first listing is unavailable.
    let pending = false; try { await this.sync(id); } catch { pending = true; }
    return { connected: true, pending, folderName: folder.name };
  }
  async disconnectFolder(user, id) {
    await this.permission(user, id, true);
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM df_libraries WHERE id=$1 FOR UPDATE', [id]);
      await tx.query("DELETE FROM df_documents WHERE library_id=$1 AND metadata ? 'sourceFolderId'", [id]);
      await tx.query('DELETE FROM df_folder_sources WHERE library_id=$1', [id]);
      await tx.query('DELETE FROM df_folder_requests WHERE library_id=$1', [id]);
    });
    this.cache.delete(id);
  }
  async search(user, id, query, mode) {
    if (query.length > 500) deny(400, '검색어는 500자 이내로 입력하세요.');
    const corpus = await this.corpus(user, id);
    return mode === 'name' ? filterDocuments(corpus.documents, { query, folder: '전체', mode }) : searchLocalIndex(corpus.documents, corpus.entries, query);
  }
  async document(user, id, documentId) {
    await this.permission(user, id);
    const row = (await this.db.query('SELECT * FROM df_documents WHERE library_id=$1 AND id=$2', [id, documentId])).rows[0];
    if (!row) deny(404, '문서를 찾을 수 없습니다.');
    return row;
  }
  async retry(user, id, documentId) {
    await this.permission(user, id, true);
    const document = await this.document(user, id, documentId);
    await this.db.transaction(async (tx) => {
      await tx.query(`UPDATE df_documents SET status='indexing' WHERE library_id=$1 AND id=$2`, [id, documentId]);
      await tx.query(`INSERT INTO df_jobs(id,library_id,document_id,version) VALUES($1,$2,$3,$4) ON CONFLICT(library_id,document_id,version) DO UPDATE SET status='pending',attempts=0,available_at=now(),lease_until=NULL,lease_owner=NULL`, [randomUUID(), id, documentId, document.version]);
    });
    this.cache.delete(id);
  }
}
