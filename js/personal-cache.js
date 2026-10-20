// Only document metadata, extracted text and explicitly imported local files are
// persisted. OAuth credentials and Drive originals never enter this database.
export function createPersonalCache(databaseFactory = globalThis.indexedDB) {
  const memory = new Map();
  let durable = Boolean(databaseFactory);
  let database;
  const key = (library, id) => JSON.stringify([library, id]);
  async function open() {
    if (!durable) return null;
    database ||= new Promise((resolve, reject) => {
      const request = databaseFactory.open("docfinder-personal-v1", 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("records", { keyPath: "key" });
        store.createIndex("library", "library");
      };
      request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); durable = false; }; resolve(request.result); };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("브라우저 저장소를 열지 못했습니다."));
    });
    return database;
  }
  async function io(mode, operation) {
    try {
      const db = await open();
      if (!db) return null;
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction("records", mode);
        const request = operation(transaction.objectStore("records"));
        transaction.oncomplete = () => resolve(request?.result);
        transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error("브라우저 저장 실패"));
      });
    } catch { durable = false; return null; }
  }
  return {
    get durable() { return durable; },
    async read(library) {
      const records = await io("readonly", (store) => store.index("library").getAll(library));
      if (records) for (const record of records) memory.set(record.key, record);
      return [...memory.values()].filter((record) => record.library === library);
    },
    async put(library, record) {
      const value = { ...record, library, key: key(library, record.document.id) };
      memory.set(value.key, value);
      await io("readwrite", (store) => store.put(value));
    },
    async prune(library, ids) {
      const retained = new Set(ids);
      for (const record of await this.read(library)) {
        if (retained.has(record.document.id)) continue;
        memory.delete(record.key);
        await io("readwrite", (store) => store.delete(record.key));
      }
    }
  };
}
