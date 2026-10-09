import { opaque, digest, equal, encrypt, decrypt, deny } from './security.mjs';
import { filterDocuments } from '../../js/search.js';
import { searchLocalIndex } from '../../js/local-index.js';
import { summarizeIndex } from '../../js/index-health.js';

const unavailable = () => deny(410, '공유 링크가 만료되었거나 해제되었습니다. 호스트에게 새 링크를 요청하세요.');
const validSecret = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

// Public readers never become library members. Every read stays within this grant.
export class PublicLinks {
  constructor({ db, service, key }) { this.db = db; this.service = service; this.key = key; this.cache = new Map(); }
  async create(user, libraryId, body) {
    await this.service.permission(user, libraryId, true);
    const scope = body.scope || 'files'; const days = body.expiresInDays ?? 7;
    const includeNew = body.includeNew ?? false;
    const name = String(body.name || '공유 자료').trim();
    if (!['files', 'folder'].includes(scope) || ![0, 7, 30].includes(days) || typeof includeNew !== 'boolean' || !name || name.length > 100 || (scope === 'files' && includeNew)) deny(400, '공유 범위와 만료일을 확인하세요.');
    if (!includeNew && (!Array.isArray(body.documentIds) || !body.documentIds.length || body.documentIds.length > 1000 || body.documentIds.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(id)))) deny(400, '공유할 파일을 1개 이상, 1,000개 이하로 선택하세요.');
    const id = opaque(); const token = opaque();
    await this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM df_libraries WHERE id=$1 FOR UPDATE', [libraryId]);
      const count = (await tx.query('SELECT count(*) AS count FROM df_public_links WHERE library_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())', [libraryId])).rows[0].count;
      if (Number(count) >= 100) deny(409, '활성 공유 링크는 100개까지 만들 수 있습니다. 사용하지 않는 링크를 해제하세요.');
      const folder = scope === 'folder' ? (await tx.query("SELECT folder_id FROM df_folder_sources WHERE library_id=$1 AND status='ready'", [libraryId])).rows[0] : null;
      if (scope === 'folder' && (!folder || body.folderId !== folder.folder_id)) deny(409, '연결된 폴더가 변경되었습니다. 공유 창을 다시 열어 확인하세요.');
      const ids = !includeNew ? [...new Set(body.documentIds)] : [];
      const rows = (await tx.query(`SELECT id,metadata FROM df_documents WHERE library_id=$1 AND ($2::boolean OR id=ANY($3::text[])) AND ($4::text IS NULL OR metadata->>'sourceFolderId'=$4)`, [libraryId, includeNew, ids, folder?.folder_id || null])).rows;
      if (!includeNew && rows.length !== ids.length) deny(400, '선택한 파일이 변경되었습니다. 공유 창을 다시 열어 확인하세요.');
      if (!rows.length && !includeNew) deny(400, '공유할 파일이 없습니다.');
      await tx.query(`INSERT INTO df_public_links(id,library_id,name,scope,folder_id,include_new,secret_hash,secret_encrypted,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $9::int=0 THEN NULL ELSE now()+$9::int*interval '1 day' END)`,
        [id, libraryId, name, scope, folder?.folder_id || null, includeNew, digest(token), encrypt(token, this.key), days]);
      // Snapshot membership when automatic publication is off; pin each file's source.
      if (!includeNew) for (const row of rows) await tx.query('INSERT INTO df_public_link_documents(link_id,library_id,document_id,source_folder_id) VALUES($1,$2,$3,$4)', [id, libraryId, row.id, row.metadata.sourceFolderId || '']);
    });
    return (await this.list(user, libraryId)).find((item) => item.id === id);
  }
  async list(user, libraryId) {
    await this.service.permission(user, libraryId, true);
    const rows = (await this.db.query(`SELECT p.*, CASE WHEN p.include_new THEN (SELECT count(*) FROM df_documents d WHERE d.library_id=p.library_id AND d.metadata->>'sourceFolderId'=p.folder_id) ELSE (SELECT count(*) FROM df_public_link_documents s JOIN df_documents d ON d.library_id=s.library_id AND d.id=s.document_id WHERE s.link_id=p.id AND COALESCE(d.metadata->>'sourceFolderId','')=s.source_folder_id) END AS document_count FROM df_public_links p WHERE p.library_id=$1 ORDER BY (p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>now())) DESC,p.created_at DESC LIMIT 200`, [libraryId])).rows;
    return rows.map((row) => ({ id: row.id, name: row.name, scope: row.scope, includeNew: row.include_new, documentCount: Number(row.document_count), createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at,
      ...(row.revoked_at || row.expires_at && Date.parse(row.expires_at) <= Date.now() ? {} : { token: decrypt(row.secret_encrypted, this.key) }) }));
  }
  async revoke(user, libraryId, id) {
    await this.service.permission(user, libraryId, true);
    await this.db.transaction(async (tx) => {
      const row = (await tx.query('UPDATE df_public_links SET revoked_at=COALESCE(revoked_at,now()) WHERE library_id=$1 AND id=$2 RETURNING id', [libraryId, id])).rows[0];
      if (!row) deny(404, '공유 링크를 찾을 수 없습니다.');
      await tx.query('DELETE FROM df_guest_sessions WHERE link_id=$1', [id]);
    });
    this.cache.delete(id);
  }
  async rotate(user, libraryId, id) {
    await this.service.permission(user, libraryId, true); const token = opaque();
    await this.db.transaction(async (tx) => {
      const row = (await tx.query('UPDATE df_public_links SET secret_hash=$3,secret_encrypted=$4 WHERE library_id=$1 AND id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) RETURNING id', [libraryId, id, digest(token), encrypt(token, this.key)])).rows[0];
      if (!row) unavailable();
      await tx.query('DELETE FROM df_guest_sessions WHERE link_id=$1', [id]);
    });
    return { id, token };
  }
  async active(id, tx = this.db) {
    const row = (await tx.query(`SELECT p.* FROM df_public_links p WHERE p.id=$1 AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>now())`, [id])).rows[0];
    if (!row) unavailable();
    if (row.scope === 'folder' && !(await tx.query('SELECT 1 FROM df_folder_sources WHERE library_id=$1 AND folder_id=$2', [row.library_id, row.folder_id])).rows.length) unavailable();
    return row;
  }
  async exchange(id, token) {
    if (!validSecret(token)) deny(403, '공유 링크 전체를 열어 주세요.');
    const guestToken = opaque();
    await this.db.transaction(async (tx) => {
      // Serialize with revocation/reissue so an obsolete token cannot mint a session.
      await tx.query('SELECT id FROM df_public_links WHERE id=$1 FOR UPDATE', [id]);
      const link = await this.active(id, tx);
      if (!equal(link.secret_hash, digest(token))) deny(403, '유효하지 않은 공유 링크입니다. 호스트에게 새 링크를 요청하세요.');
      await tx.query('DELETE FROM df_guest_sessions WHERE expires_at<now()');
      await tx.query(`INSERT INTO df_guest_sessions(hash,link_id,expires_at) VALUES($1,$2,now()+interval '1 hour')`, [digest(guestToken), id]);
    });
    return guestToken;
  }
  async permission(id, token) {
    const link = await this.active(id);
    if (!validSecret(token) || !(await this.db.query('SELECT 1 FROM df_guest_sessions WHERE hash=$1 AND link_id=$2 AND expires_at>now()', [digest(token), id])).rows.length) deny(401, '공유 링크 전체를 다시 열어 주세요.');
    return link;
  }
  async rows(link, withPages = false, documentId) {
    return (await this.db.query(`SELECT d.id,d.metadata,d.version,d.status${withPages ? ',d.pages' : ''} FROM df_documents d WHERE d.library_id=$1 AND
      ((EXISTS(SELECT 1 FROM df_public_link_documents s WHERE s.link_id=$2 AND s.library_id=d.library_id AND s.document_id=d.id AND s.source_folder_id=COALESCE(d.metadata->>'sourceFolderId',''))) OR ($3::boolean AND d.metadata->>'sourceFolderId'=$4))
      AND (NOT(d.metadata ? 'sourceFolderId') OR EXISTS(SELECT 1 FROM df_folder_sources f WHERE f.library_id=d.library_id AND f.folder_id=d.metadata->>'sourceFolderId'))
      ${documentId ? 'AND d.id=$5' : ''} ORDER BY d.id`, [link.library_id, link.id, link.include_new, link.folder_id, ...(documentId ? [documentId] : [])])).rows;
  }
  async corpus(id, token) {
    const link = await this.permission(id, token);
    let rows = await this.rows(link); let revision = digest(JSON.stringify(rows.map((row) => [row.id, row.version, row.status])));
    let cached = this.cache.get(id);
    if (cached?.revision !== revision) {
      rows = await this.rows(link, true); revision = digest(JSON.stringify(rows.map((row) => [row.id, row.version, row.status])));
      const documents = rows.map((row) => ({ id: row.id, name: row.metadata.name, format: row.metadata.format, size: row.metadata.size, modifiedTime: row.metadata.modifiedTime,
        libraryId: id, source: 'shared', folder: '공유 자료', path: row.metadata.name, readOnly: true, version: digest(row.version), sha256: digest(row.version), indexStatus: row.status, excerpt: '', heading: '원문',
        sourceUrl: `/api/public-links/${id}/documents/${encodeURIComponent(row.id)}/original?version=${digest(row.version)}` }));
      const entries = rows.flatMap((row) => row.pages.map((page) => ({ ...page, id: row.id })));
      cached = { revision, documents, entries, stats: summarizeIndex(documents, entries) }; this.cache.delete(id); this.cache.set(id, cached);
      while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
    }
    await this.permission(id, token); // Reads and searches can race with link revocation.
    return { ...cached, link };
  }
  async catalog(id, token) {
    const corpus = await this.corpus(id, token);
    return { library: { id, name: corpus.link.name, role: 'guest' }, documents: corpus.documents, revision: corpus.revision, stats: corpus.stats,
      publicLink: { scope: corpus.link.scope, includeNew: corpus.link.include_new, expiresAt: corpus.link.expires_at } };
  }
  async search(id, token, query, mode) {
    if (query.length > 500) deny(400, '검색어는 500자 이내로 입력하세요.');
    const corpus = await this.corpus(id, token);
    const result = mode === 'name' ? filterDocuments(corpus.documents, { query, folder: '전체', mode }) : searchLocalIndex(corpus.documents, corpus.entries, query);
    await this.permission(id, token); return result;
  }
  async document(id, token, documentId) {
    const link = await this.permission(id, token); const row = (await this.rows(link, false, documentId))[0];
    if (!row) deny(404, '공유되지 않은 문서이거나 삭제된 문서입니다.');
    return { ...row, libraryId: link.library_id };
  }
}
