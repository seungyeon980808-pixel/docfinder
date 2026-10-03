import pg from 'pg';

const schema = `
CREATE TABLE IF NOT EXISTS df_users (id text PRIMARY KEY, email text NOT NULL, name text NOT NULL);
CREATE TABLE IF NOT EXISTS df_libraries (id text PRIMARY KEY, owner_id text NOT NULL UNIQUE REFERENCES df_users(id), name text NOT NULL, share_id text NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS df_invites (library_id text REFERENCES df_libraries(id) ON DELETE CASCADE, email text NOT NULL, user_id text REFERENCES df_users(id), status text NOT NULL CHECK(status IN ('pending','accepted','revoked')), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(library_id,email));
CREATE TABLE IF NOT EXISTS df_sessions (hash text PRIMARY KEY, user_id text REFERENCES df_users(id), expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS df_oauth_states (hash text PRIMARY KEY, session_hash text NOT NULL, library_id text REFERENCES df_libraries(id), expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS df_connections (library_id text PRIMARY KEY REFERENCES df_libraries(id), credentials text NOT NULL, folder_id text NOT NULL, status text NOT NULL DEFAULT 'ready', synced_at timestamptz);
CREATE TABLE IF NOT EXISTS df_documents (library_id text REFERENCES df_libraries(id) ON DELETE CASCADE, id text NOT NULL, metadata jsonb NOT NULL, version text NOT NULL, status text NOT NULL DEFAULT 'indexing', pages jsonb NOT NULL DEFAULT '[]', PRIMARY KEY(library_id,id));
CREATE TABLE IF NOT EXISTS df_jobs (id text PRIMARY KEY, library_id text NOT NULL, document_id text NOT NULL, version text NOT NULL, status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, lease_owner text, FOREIGN KEY(library_id,document_id) REFERENCES df_documents(library_id,id) ON DELETE CASCADE, UNIQUE(library_id,document_id,version));
CREATE TABLE IF NOT EXISTS df_uploads (library_id text REFERENCES df_libraries(id), id text NOT NULL, name text NOT NULL, size bigint NOT NULL, status text NOT NULL DEFAULT 'pending', document_id text, lease_until timestamptz, PRIMARY KEY(library_id,id));
CREATE INDEX IF NOT EXISTS df_invite_user ON df_invites(user_id,status);
CREATE INDEX IF NOT EXISTS df_job_pending ON df_jobs(status,available_at);
`;

export async function createDatabase({ url, directory } = {}) {
  if (url) {
    const pool = new pg.Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
    pool.on('error', () => console.error('DocFinder database connection will retry.'));
    await pool.query(schema);
    return { query: (sql, values) => pool.query(sql, values), async transaction(fn) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }, close: () => pool.end() };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const database = new PGlite(directory);
  await database.exec(schema);
  let tail = Promise.resolve();
  const exclusive = (fn) => { const next = tail.then(fn); tail = next.catch(() => {}); return next; };
  return { query: (sql, values) => exclusive(() => database.query(sql, values)),
    transaction: (fn) => exclusive(() => database.transaction(fn)), close: () => exclusive(() => database.close()) };
}
