import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createDatabase } from './shared/database.mjs';
import { createSharedServer } from './shared/server.mjs';

const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 4175);
const origin = process.env.DOCFINDER_ORIGIN || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
const maxFileMB = Number(process.env.DOCFINDER_MAX_FILE_MB || 128);
if (!Number.isInteger(maxFileMB) || maxFileMB < 1 || maxFileMB > 128) throw new Error('DOCFINDER_MAX_FILE_MB must be an integer from 1 to 128.');
const indexMemoryMB = Number(process.env.DOCFINDER_INDEX_MEMORY_MB || 512);
if (!Number.isInteger(indexMemoryMB) || indexMemoryMB < 64 || indexMemoryMB > 512) throw new Error('DOCFINDER_INDEX_MEMORY_MB must be an integer from 64 to 512.');
const dataRoot = path.resolve(process.env.DOCFINDER_DATA_DIR || '.docfinder-data');
await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
let key;
if (process.env.DOCFINDER_ENCRYPTION_KEY) key = Buffer.from(process.env.DOCFINDER_ENCRYPTION_KEY, 'hex');
else if (!production) {
  const filename = path.join(dataRoot, 'encryption.key');
  try { key = await fs.readFile(filename); }
  catch (error) { if (error.code !== 'ENOENT') throw error; key = randomBytes(32); await fs.writeFile(filename, key, { flag: 'wx', mode: 0o600 }); }
}
if (key?.length !== 32) throw new Error('Set DOCFINDER_ENCRYPTION_KEY to 64 hexadecimal characters.');
if (production && (!process.env.DATABASE_URL || !origin.startsWith('https://') || !process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET)) throw new Error('Production requires DATABASE_URL, HTTPS DOCFINDER_ORIGIN, GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
const db = await createDatabase({ url: process.env.DATABASE_URL, directory: path.join(dataRoot, 'postgres') });
let folderCredentials;
try { folderCredentials = process.env.GOOGLE_FOLDER_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GOOGLE_FOLDER_SERVICE_ACCOUNT_JSON) : undefined; }
catch { throw new Error('GOOGLE_FOLDER_SERVICE_ACCOUNT_JSON must be a valid service account JSON.'); }
const app = await createSharedServer({ db, key, origin, dataRoot, folderCredentials, maxFileBytes: maxFileMB * 1024 * 1024, clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET });
app.server.listen(port, production ? '0.0.0.0' : '127.0.0.1', () => console.log(`DocFinder shared: ${origin} · ${process.env.GOOGLE_CLIENT_ID ? 'Google configured' : 'Google setup required'}`));
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await app.close(); await db.close(); process.exit(0); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
