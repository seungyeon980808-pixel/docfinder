import * as drive from "./drive-api.js";
import { documentFormat } from "./search.js?v=phrase-map-2";
import { createPersonalCache } from "./personal-cache.js?v=drive-upload-1";
import { createDocumentIndexer } from "./document-indexer.js?v=drive-upload-1";

const version = (item) => JSON.stringify([item.modifiedTime, item.size, item.checksum || ""]);
const cancelled = () => new DOMException("작업을 중단했습니다.", "AbortError");

export function createPersonalLibrary({ api = drive, cache = createPersonalCache(), indexer = createDocumentIndexer(), onChange = () => {} } = {}) {
  let generation = 0;
  let token = "";
  let libraryId = "";
  let folder;
  let user;
  let records = new Map();
  let busy = false;
  let progress = "";
  let error = "";
  let abort = new AbortController();
  const originals = new Map();
  let lastProgressAt = 0;
  function snapshot() {
    return { libraryId, connected: Boolean(token), busy, progress, error, durable: cache.durable,
      sourceName: token ? `${user?.displayName || "내 계정"} · DocFinder` : "이 컴퓨터의 파일",
      documents: [...records.values()].map((record) => ({ ...record.document, libraryId })),
      entries: [...records.values()].flatMap((record) => record.pages.map((page) => ({ ...page, id: record.document.id }))) };
  }
  const emit = () => onChange(snapshot());
  function emitProgress(final = false) {
    const now = Date.now();
    if (!final && now - lastProgressAt < 120) return;
    lastProgressAt = now; emit();
  }
  function reset() {
    generation++;
    abort.abort(); abort = new AbortController();
    indexer.cancel(); token = ""; folder = undefined; user = undefined; libraryId = "";
    records = new Map(); originals.clear(); busy = false; progress = ""; error = "";
  }
  const current = (job) => { if (job !== generation || abort.signal.aborted) throw cancelled(); };
  async function indexDocument(item, bytes, job, original) {
    current(job);
    const record = { document: { ...item, indexStatus: "indexing" }, pages: [], version: version(item), ...(original ? { original } : {}) };
    records.set(item.id, record); emit();
    try {
      record.pages = await indexer.extract(item.format, bytes, ({ page, total }) => {
        if (job !== generation) return;
        progress = `${item.name} · 색인 ${page}/${total}쪽`; emitProgress(page === total);
      });
      current(job);
      record.document.indexStatus = record.pages.some((page) => page.text.trim()) ? "ready" : "textless";
    } catch (failure) {
      current(job);
      console.warn("DocFinder document indexing failed", failure);
      record.document.indexStatus = "error";
      record.document.indexError = "업로드된 원본은 보관되어 있습니다. 암호와 파일 형식을 확인한 뒤 색인을 다시 시도하세요.";
      if (original) record.document.indexError = "암호와 파일 형식을 확인한 뒤 파일을 다시 불러오세요.";
      record.pages = [];
    }
    await cache.put(libraryId, record); current(job); emit();
  }
  async function refresh(job) {
    const items = await api.listUploadedDocuments(token, folder.id, abort.signal); current(job);
    const previous = new Map((await cache.read(libraryId)).map((record) => [record.document.id, record])); current(job);
    records = new Map(items.map((item) => {
      const record = previous.get(item.id);
      if (record?.version !== version(item)) originals.delete(item.id);
      return [item.id, record?.version === version(item) ? { ...record, document: { ...record.document, ...item } }
        : { document: { ...item, indexStatus: "indexing" }, pages: [], version: version(item) }];
    }));
    await cache.prune(libraryId, items.map((item) => item.id)); current(job); emit();
    for (const item of items) {
      if (["ready", "textless"].includes(records.get(item.id).document.indexStatus)) continue;
      progress = `${item.name} · 원문을 불러오는 중`; emit();
      try { await indexDocument(item, await api.downloadDriveFile(token, item.id, { signal: abort.signal }), job); }
      catch (failure) {
        current(job);
        if (failure.status === 401) throw failure;
        const record = records.get(item.id); record.document.indexStatus = "error"; record.document.indexError = "원문을 불러오지 못했습니다. 권한과 연결 상태를 확인하세요.";
        await cache.put(libraryId, record); current(job); emit();
      }
    }
  }
  async function run(operation) {
    if (busy) throw new Error("진행 중인 작업이 끝난 뒤 다시 시도하세요.");
    const job = generation;
    busy = true; error = ""; emit();
    try { await operation(job); }
    catch (failure) {
      if (job !== generation) return;
      if (failure.status === 401) { reset(); error = "Google 연결이 만료되었습니다. 다시 연결하세요."; emit(); }
      else if (failure.name !== "AbortError") { error = failure.message || "작업을 완료하지 못했습니다."; throw failure; }
    } finally { if (job === generation) { busy = false; progress = ""; emit(); } }
  }
  return {
    snapshot,
    disconnect() { reset(); emit(); },
    async connect(clientId) {
      reset();
      await run(async (job) => {
        progress = "Google 계정을 연결하는 중"; emit();
        const nextToken = await api.authorizeDrive(clientId); current(job);
        const nextUser = await api.getDriveUser(nextToken, abort.signal); current(job);
        const nextFolder = await api.ensureDriveLibrary(nextToken, abort.signal); current(job);
        token = nextToken; user = nextUser; folder = nextFolder;
        libraryId = `drive:${user.permissionId}:${folder.id}`;
        await refresh(job);
      });
    },
    async sync() {
      if (!token || !folder) throw new Error("Google Drive를 먼저 연결하세요.");
      await run(refresh);
    },
    async retry(item) {
      if (item.libraryId !== libraryId || !records.has(item.id)) throw new Error("문서를 다시 연결하세요.");
      await run(async (job) => {
        const original = records.get(item.id).original;
        await indexDocument(item, await this.getBytes(item), job, original);
      });
    },
    async upload(files) {
      if (!token || !folder) throw new Error("Google Drive를 먼저 연결하세요.");
      const candidates = [...files];
      if (candidates.some((file) => !documentFormat(file.name) || !file.size)) throw new Error("내용이 있는 PDF·HWP·HWPX 파일만 업로드할 수 있습니다.");
      await run(async (job) => {
        const failures = [];
        for (const [position, file] of candidates.entries()) {
          current(job);
          let uploaded;
          try {
            uploaded = await api.uploadDriveFile(token, file, folder.id, { signal: abort.signal, onProgress: ({ loaded, total }) => {
              if (job !== generation) return;
              progress = `업로드 ${position + 1}/${candidates.length} · ${file.name} ${Math.round(loaded / total * 100)}%`; emitProgress(loaded === total);
            } });
            current(job); originals.set(uploaded.id, file);
            // Persist the completed upload before extraction. A failed index or
            // closed tab must never require a duplicate upload to recover it.
            const pending = { document: { ...uploaded, indexStatus: "indexing" }, pages: [], version: version(uploaded) };
            records.set(uploaded.id, pending); await cache.put(libraryId, pending); current(job); emit();
            await indexDocument(uploaded, await file.arrayBuffer(), job);
          } catch (failure) {
            current(job);
            if (failure.status === 401) throw failure;
            failures.push(`${file.name}: ${uploaded ? "원본 업로드 완료 · 색인 재시도 필요" : "업로드 실패"}`);
          }
        }
        if (failures.length) error = failures.join(" / ");
      });
    },
    async importLocal(files) {
      if (busy) throw new Error("진행 중인 작업이 끝난 뒤 파일을 불러오세요.");
      const candidates = [...files];
      if (candidates.some((file) => !documentFormat(file.name) || !file.size)) throw new Error("내용이 있는 PDF·HWP·HWPX 파일을 선택하세요.");
      reset(); libraryId = "browser-local";
      await run(async (job) => {
        records = new Map((await cache.read(libraryId)).map((record) => [record.document.id, record])); current(job); emit();
        for (const file of candidates) {
          current(job);
          const bytes = await file.arrayBuffer();
          const digest = await crypto.subtle.digest("SHA-256", bytes); current(job);
          const id = `local-${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
          const item = { id, name: file.name, format: documentFormat(file.name), source: "browser", folder: "내 파일", path: file.name,
            size: file.size, modifiedTime: new Date(file.lastModified).toISOString(), checksum: id, excerpt: "" };
          // Safari's file-backed Blob can lose its picker access after reload.
          // Persist owned bytes before transferring the extraction buffer.
          await indexDocument(item, bytes, job, bytes.slice(0));
        }
      });
    },
    async restoreLocal() {
      if (busy || token) return;
      reset(); libraryId = "browser-local";
      const job = generation;
      const previous = await cache.read(libraryId); current(job);
      records = new Map(previous.map((record) => [record.document.id, record])); emit();
    },
    async getBytes(item) {
      if (item.libraryId !== libraryId) throw new Error("이 문서의 계정을 다시 연결하세요.");
      if (item.source === "drive") {
        if (!token) throw new Error("Google Drive를 다시 연결하세요.");
        const original = originals.get(item.id);
        return original ? original.arrayBuffer() : api.downloadDriveFile(token, item.id, { signal: abort.signal });
      }
      const original = records.get(item.id)?.original;
      if (!original) throw new Error("이 파일을 다시 불러오세요.");
      return original instanceof ArrayBuffer ? original.slice(0) : original.arrayBuffer();
    }
  };
}
