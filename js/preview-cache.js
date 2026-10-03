export function previewSourceKey(item) {
  return JSON.stringify([item.id, item.source, item.sourceUrl, item.modifiedTime, item.localFile?.name, item.localFile?.lastModified]);
}

// Cache originals, not transferred PDF worker buffers. Consumers own a copy.
export function createByteCache(loader, budget = 48 * 1024 * 1024) {
  const entries = new Map();
  let size = 0;
  return async (item) => {
    const key = previewSourceKey(item);
    let entry = entries.get(key);
    if (!entry) {
      entry = { size: 0 };
      entry.promise = Promise.resolve().then(() => loader(item)).then((bytes) => {
        if (entries.get(key) === entry) {
          entry.size = bytes.byteLength;
          size += entry.size;
          for (const [oldKey, oldEntry] of entries) {
            if (size <= budget && entries.size <= 8) break;
            size -= oldEntry.size;
            entries.delete(oldKey);
          }
        }
        return bytes;
      }).catch((error) => { if (entries.get(key) === entry) entries.delete(key); throw error; });
      entries.set(key, entry);
    } else { entries.delete(key); entries.set(key, entry); }
    return (await entry.promise).slice(0);
  };
}
