import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

export function extractPages(format, bytes, timeoutMs = 180000) {
  const memoryMB = Number(process.env.DOCFINDER_INDEX_MEMORY_MB || 512);
  if (!Number.isInteger(memoryMB) || memoryMB < 64 || memoryMB > 512) throw new Error('DOCFINDER_INDEX_MEMORY_MB must be an integer from 64 to 512.');
  return new Promise((resolve, reject) => {
    const owned = new Uint8Array(bytes).buffer;
    const worker = new Worker(new URL('./extract-worker.mjs', import.meta.url), { workerData: { format, bytes: owned }, transferList: [owned], resourceLimits: { maxOldGenerationSizeMb: memoryMB } });
    let done = false;
    const finish = (error, pages) => { if (done) return; done = true; clearTimeout(timer); worker.terminate(); error ? reject(error) : resolve(pages); };
    const timer = setTimeout(() => finish(new Error('Index timeout')), timeoutMs);
    worker.once('message', (value) => finish(value.error ? new Error(value.error) : null, value.pages));
    worker.once('error', (error) => finish(error));
    worker.once('exit', () => { if (!done) finish(new Error('Index worker exited')); });
  });
}

export function createJobs({ db, drive, service, extract = extractPages, pollMs = 1000, syncMs = 60000 }) {
  const owner = randomUUID(); let stopped = false; let busy = false; let syncing = false; let lastSync = 0; let running = Promise.resolve();
  async function claim() {
    return db.transaction(async (tx) => {
      const job = (await tx.query(`SELECT * FROM df_jobs WHERE (status='pending' AND available_at<=now()) OR (status='running' AND lease_until<now()) ORDER BY available_at LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
      if (!job) return;
      const row = (await tx.query(`UPDATE df_jobs SET status='running',attempts=attempts+1,lease_owner=$2,lease_until=now()+interval '10 minutes' WHERE id=$1 RETURNING *`, [job.id, owner])).rows[0];
      return row;
    });
  }
  async function once() {
    const job = await claim(); if (!job) return false;
    try {
      const row = (await db.query('SELECT * FROM df_documents WHERE library_id=$1 AND id=$2', [job.library_id, job.document_id])).rows[0];
      if (!row || row.version !== job.version) throw new Error('Stale job');
      const pages = await extract(row.metadata.format, await drive.bytes(job.library_id, job.document_id));
      await db.transaction(async (tx) => {
        const current = (await tx.query('SELECT status,lease_owner FROM df_jobs WHERE id=$1 FOR UPDATE', [job.id])).rows[0];
        if (current?.status !== 'running' || current.lease_owner !== owner) return;
        await tx.query(`UPDATE df_documents SET pages=$4,status=$5 WHERE library_id=$1 AND id=$2 AND version=$3`, [job.library_id, job.document_id, job.version, JSON.stringify(pages), pages.some((page) => page.text.trim()) ? 'ready' : 'textless']);
        await tx.query(`UPDATE df_jobs SET status='done',lease_until=NULL WHERE id=$1`, [job.id]);
      });
    } catch {
      await db.transaction(async (tx) => {
        const current = (await tx.query('SELECT status,lease_owner FROM df_jobs WHERE id=$1 FOR UPDATE', [job.id])).rows[0];
        if (current?.status !== 'running' || current.lease_owner !== owner) return;
        await tx.query(`UPDATE df_documents SET status='error' WHERE library_id=$1 AND id=$2 AND version=$3`, [job.library_id, job.document_id, job.version]);
        await tx.query(`UPDATE df_jobs SET status=$2,available_at=now()+interval '30 seconds',lease_until=NULL WHERE id=$1`, [job.id, job.attempts >= 3 ? 'failed' : 'pending']);
      });
    }
    service.cache.delete(job.library_id); return true;
  }
  async function sync() {
    if (syncing) return; syncing = true;
    try {
      const connections = (await db.query(`SELECT library_id FROM df_connections WHERE status='ready' UNION SELECT library_id FROM df_folder_sources`)).rows;
      for (const row of connections) { if (stopped) break; await service.sync(row.library_id).catch(() => {}); }
    } finally { syncing = false; }
  }
  async function tick() {
    if (busy || stopped) return; busy = true;
    try { await once(); if (Date.now() - lastSync > syncMs) { lastSync = Date.now(); await sync(); } }
    catch { console.error('DocFinder background job will retry.'); }
    finally { busy = false; }
  }
  const timer = setInterval(() => { if (!busy && !stopped) running = tick(); }, pollMs); timer.unref();
  return { once, sync, async stop() { stopped = true; clearInterval(timer); await running; } };
}
