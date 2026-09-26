const SETTINGS_KEY = "5e-manual-library-settings-v1";
const SNAPSHOT_KEY = "5e-manual-library-drive-snapshot-v1";
const PUBLIC_DOCUMENT_FORMATS = new Set(["pdf", "hwp", "hwpx"]);

function readJson(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export function loadSettings(defaults, buildProfile = {}) {
  if (buildProfile.profile === "public") {
    return {
      ...defaults,
      ...(buildProfile.settings || {}),
      googleClientId: "",
      rootFolderId: "",
      demoMode: false
    };
  }
  return {
    ...defaults,
    ...readJson(SETTINGS_KEY, {}),
    ...(buildProfile.forceDemo ? { demoMode: true } : {})
  };
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadSnapshot() {
  return readJson(SNAPSHOT_KEY, {});
}

export function saveSnapshot(documents) {
  const snapshot = Object.fromEntries(documents.map((document) => [document.id, document.modifiedTime]));
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
}

export function compareSnapshot(documents, snapshot) {
  const added = [];
  const updated = [];
  for (const document of documents) {
    if (!snapshot[document.id]) added.push(document.id);
    else if (snapshot[document.id] !== document.modifiedTime) updated.push(document.id);
  }
  const currentIds = new Set(documents.map((document) => document.id));
  const removed = Object.keys(snapshot).filter((id) => !currentIds.has(id));
  return { added, updated, removed };
}

export function selectSnapshotDocumentId(documents, requestedId) {
  if (documents.some((document) => document.id === requestedId)) return requestedId;
  return [...documents]
    .sort((left, right) => String(right.modifiedTime).localeCompare(String(left.modifiedTime)))[0]?.id || "";
}

function resolveHostedOriginal(documentItem, catalogUrl, appBaseUrl) {
  const value = documentItem.originalUrl || documentItem.sourceUrl || documentItem.downloadUrl || documentItem.previewUrl;
  if (typeof value !== "string" || !value.trim()) throw new TypeError("Public document original URL is missing.");
  const trimmed = value.trim();
  const baseUrl = /^\.?\/?library\//u.test(trimmed) ? appBaseUrl : catalogUrl;
  const url = new URL(trimmed, baseUrl);
  const appUrl = new URL(appBaseUrl);
  const originalsUrl = new URL("./originals/", catalogUrl);
  if (!/^https?:$/u.test(url.protocol)
    || url.origin !== appUrl.origin
    || !url.pathname.startsWith(originalsUrl.pathname)
    || /(^|\.)drive\.google\.com$/u.test(url.hostname)) {
    throw new TypeError("Public document original URL must be hosted with the app.");
  }
  return url.href;
}

function parsePublicDocumentFormat(documentItem) {
  const format = documentItem.format === undefined
    ? documentItem.name.split(".").pop()?.toLocaleLowerCase("ko-KR")
    : documentItem.format;
  if (!PUBLIC_DOCUMENT_FORMATS.has(format)) throw new TypeError("Public catalog document format is invalid.");
  return format;
}

function normalizePublicDocument(documentItem, catalogUrl, appBaseUrl) {
  if (!documentItem
    || typeof documentItem.id !== "string"
    || !documentItem.id.trim()
    || typeof documentItem.name !== "string"
    || !documentItem.name.trim()) {
    throw new TypeError("Public catalog document is invalid.");
  }
  const format = parsePublicDocumentFormat(documentItem);
  const sourceUrl = resolveHostedOriginal(documentItem, catalogUrl, appBaseUrl);
  return {
    id: documentItem.id,
    name: documentItem.name,
    folder: typeof documentItem.folder === "string" ? documentItem.folder : "전체",
    path: typeof documentItem.path === "string" ? documentItem.path : documentItem.name,
    format,
    mimeType: typeof documentItem.mimeType === "string" ? documentItem.mimeType : "",
    size: Number.isFinite(documentItem.size) ? documentItem.size : 0,
    modifiedTime: typeof documentItem.modifiedTime === "string" ? documentItem.modifiedTime : "",
    createdTime: typeof documentItem.createdTime === "string" ? documentItem.createdTime : "",
    source: "public",
    sourceUrl,
    previewUrl: sourceUrl,
    downloadUrl: sourceUrl
  };
}

export async function loadPublicSnapshot(urls, appBaseUrl, fetcher = globalThis.fetch) {
  const [catalogResponse, indexResponse] = await Promise.all([
    fetcher(urls.catalog, { cache: "no-store" }),
    fetcher(urls.searchIndex, { cache: "no-store" })
  ]);
  if (!catalogResponse.ok || !indexResponse.ok) throw new Error("Published document metadata could not be loaded.");
  const [catalog, searchIndex] = await Promise.all([catalogResponse.json(), indexResponse.json()]);
  if (catalog?.version !== 1 || !Array.isArray(catalog.documents)) throw new TypeError("Public catalog is invalid.");
  if (searchIndex?.version !== 1 || !Array.isArray(searchIndex.entries)) throw new TypeError("Public search index is invalid.");

  const documentIds = new Set();
  const documents = catalog.documents.map((documentItem) => {
    const document = normalizePublicDocument(documentItem, urls.catalog, appBaseUrl);
    if (documentIds.has(document.id)) throw new TypeError("Public catalog contains duplicate document IDs.");
    documentIds.add(document.id);
    return document;
  });

  const indexEntries = searchIndex.entries.map((entry) => {
    if (!entry
      || typeof entry.id !== "string"
      || !entry.id.trim()
      || !documentIds.has(entry.id)
      || (entry.page !== null && (!Number.isSafeInteger(entry.page) || entry.page <= 0))
      || typeof entry.text !== "string"
      || !entry.text.trim()) {
      throw new TypeError("Public search index entry is invalid.");
    }
    return { id: entry.id, page: entry.page, text: entry.text };
  });

  return {
    documents,
    indexEntries,
    generatedAt: typeof catalog.generatedAt === "string" ? catalog.generatedAt : ""
  };
}

export function createStore(initialState) {
  let state = initialState;
  const listeners = new Set();
  return {
    get: () => state,
    update(patch) {
      state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
      for (const listener of listeners) listener(state);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
