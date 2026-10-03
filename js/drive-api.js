import { buildDriveContentQuery, documentFormat, isSupportedDocument, parseFolderId } from "./search.js";

const API_BASE = "https://www.googleapis.com/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const UPLOAD_FIELDS = "id,name,mimeType,modifiedTime,createdTime,size,webViewLink,md5Checksum";
const FILE_FIELDS = "nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,size,description,parents,webViewLink,owners(displayName))";

export class DriveError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "DriveError";
    this.status = status;
  }
}

function waitForIdentity(timeout = 8000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (globalThis.google?.accounts?.oauth2) {
        clearInterval(timer);
        resolve(globalThis.google.accounts.oauth2);
      } else if (Date.now() - startedAt > timeout) {
        clearInterval(timer);
        reject(new DriveError("Google 로그인 모듈을 불러오지 못했습니다. 네트워크 연결을 확인하세요."));
      }
    }, 50);
  });
}

export async function authorizeDrive(clientId) {
  if (!clientId) throw new DriveError("설정에서 Google OAuth 클라이언트 ID를 입력하세요.");
  // Keep the popup request in the click's user activation when GIS is ready.
  const oauth2 = globalThis.google?.accounts?.oauth2 || await waitForIdentity();
  return new Promise((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_FILE_SCOPE,
      include_granted_scopes: false,
      callback(response) {
        if (response.error) reject(new DriveError(response.error_description || response.error));
        else if (!String(response.scope || "").split(/\s+/u).includes(DRIVE_FILE_SCOPE)) reject(new DriveError("파일 접근 권한을 허용한 뒤 다시 연결하세요."));
        else resolve(response.access_token);
      },
      error_callback(error) {
        reject(new DriveError(error.message || "Google 계정 연결을 완료하지 못했습니다."));
      }
    });
    client.requestAccessToken({ prompt: "select_account" });
  });
}

async function requestJson(accessToken, parameters, fileId = "") {
  const url = new URL(fileId ? `${API_BASE}/${encodeURIComponent(fileId)}` : API_BASE);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new DriveError(payload.error?.message || "Google Drive 요청에 실패했습니다.", response.status);
  }
  return response.json();
}

async function listAll(accessToken, query) {
  const files = [];
  let pageToken = "";
  do {
    const payload = await requestJson(accessToken, {
      q: query,
      spaces: "drive",
      pageSize: 1000,
      orderBy: "name_natural",
      fields: FILE_FIELDS,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      ...(pageToken ? { pageToken } : {})
    });
    files.push(...payload.files);
    pageToken = payload.nextPageToken || "";
  } while (pageToken);
  return files;
}

function toDocument(file, folders) {
  const folder = folders[0] || "루트 문서";
  const path = [...folders, file.name].join(" / ");
  const format = documentFormat(file.name, file.mimeType);
  return {
    id: file.id,
    name: file.name,
    folder,
    path,
    publisher: file.owners?.[0]?.displayName || "Google Drive",
    modifiedTime: file.modifiedTime,
    createdTime: file.createdTime,
    size: Number(file.size || 0),
    excerpt: file.description || `Drive에 보관된 ${format.toUpperCase()} 원문입니다.`,
    heading: "Google Drive 원문",
    page: null,
    source: "drive",
    format,
    mimeType: file.mimeType,
    isNew: false,
    previewUrl: format === "pdf" ? `https://drive.google.com/file/d/${file.id}/preview` : "",
    webViewLink: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`
  };
}

export async function scanDriveFolder(accessToken, folderValue) {
  const rootId = parseFolderId(folderValue);
  if (!rootId) throw new DriveError("설정에서 Drive 루트 폴더 ID 또는 URL을 입력하세요.");
  const root = await requestJson(accessToken, { fields: "id,name,mimeType" }, rootId);
  if (root.mimeType !== FOLDER_MIME) throw new DriveError("설정한 항목이 Google Drive 폴더가 아닙니다.");
  const queue = [{ id: rootId, folders: [] }];
  const documents = [];
  while (queue.length) {
    const current = queue.shift();
    const children = await listAll(accessToken, `'${current.id}' in parents and trashed = false`);
    for (const child of children) {
      if (child.mimeType === FOLDER_MIME) queue.push({ id: child.id, folders: [...current.folders, child.name] });
      else if (isSupportedDocument(child.name, child.mimeType)) documents.push(toDocument(child, current.folders));
    }
  }
  return { rootName: root.name, documents };
}

export async function searchDriveContent(accessToken, query, indexedDocuments) {
  if (!query.trim()) return indexedDocuments;
  const matches = await listAll(accessToken, buildDriveContentQuery(query));
  const matchIds = new Set(matches.map((file) => file.id));
  return indexedDocuments.filter((document) => matchIds.has(document.id));
}

export async function downloadDriveFile(accessToken, fileId, { signal } = {}) {
  const url = new URL(`${API_BASE}/${encodeURIComponent(fileId)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  const response = await fetch(url, { signal, credentials: "omit", headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new DriveError(payload.error?.message || "Drive 원문을 내려받지 못했습니다.", response.status);
  }
  return response.arrayBuffer();
}

async function driveRequest(token, url, init = {}) {
  const response = await fetch(url, { ...init, credentials: "omit", redirect: "error",
    headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new DriveError(payload.error?.message || "Google Drive 요청에 실패했습니다.", response.status);
  }
  return response;
}

export async function getDriveUser(token, signal) {
  const response = await driveRequest(token, "https://www.googleapis.com/drive/v3/about?fields=user(permissionId,displayName)", { signal });
  const { user } = await response.json();
  if (!user?.permissionId) throw new DriveError("연결한 Google 계정을 확인하지 못했습니다.");
  return user;
}

async function listAppFiles(token, query, signal) {
  const files = [];
  let pageToken;
  do {
    const url = new URL(API_BASE);
    for (const [key, value] of Object.entries({ q: query, spaces: "drive", fields: `nextPageToken,files(${UPLOAD_FIELDS})`, pageSize: "1000", ...(pageToken ? { pageToken } : {}) })) url.searchParams.set(key, value);
    const payload = await (await driveRequest(token, url, { signal })).json();
    files.push(...payload.files || []);
    pageToken = payload.nextPageToken;
  } while (pageToken);
  return files;
}

export async function ensureDriveLibrary(token, signal) {
  const folders = await listAppFiles(token, `mimeType = '${FOLDER_MIME}' and trashed = false and appProperties has { key='docfinderLibrary' and value='1' }`, signal);
  if (folders.length) return folders.sort((a, b) => a.id.localeCompare(b.id))[0];
  const response = await driveRequest(token, `${API_BASE}?fields=id,name`, { method: "POST", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "DocFinder", mimeType: FOLDER_MIME, appProperties: { docfinderLibrary: "1" } }) });
  return response.json();
}

export function uploadedDriveDocument(file) {
  return { ...toDocument(file, ["DocFinder"]), checksum: file.md5Checksum || "", excerpt: "", heading: "내 Drive 문서" };
}

export async function listUploadedDocuments(token, folderId, signal) {
  if (!/^[\w-]+$/u.test(folderId)) throw new DriveError("업로드 폴더를 확인하세요.");
  const files = await listAppFiles(token, `'${folderId}' in parents and trashed = false and appProperties has { key='docfinderDocument' and value='1' }`, signal);
  return files.filter((file) => isSupportedDocument(file.name, file.mimeType)).map(uploadedDriveDocument);
}

export async function uploadDriveFile(token, file, folderId, { signal, onProgress = () => {} } = {}) {
  const format = documentFormat(file.name);
  if (!format || !file.size) throw new DriveError("내용이 있는 PDF·HWP·HWPX 파일을 선택하세요.");
  if (!/^[\w-]+$/u.test(folderId)) throw new DriveError("업로드 폴더를 확인하세요.");
  const mimeType = { pdf: "application/pdf", hwp: "application/x-hwp", hwpx: "application/vnd.hancom.hwpx" }[format];
  const start = await driveRequest(token, `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=${encodeURIComponent(UPLOAD_FIELDS)}`, {
    method: "POST", signal, headers: { "Content-Type": "application/json", "X-Upload-Content-Type": mimeType, "X-Upload-Content-Length": String(file.size) },
    body: JSON.stringify({ name: file.name, mimeType, parents: [folderId], appProperties: { docfinderDocument: "1" } })
  });
  const location = start.headers.get("Location");
  if (!location) throw new DriveError("Drive 업로드 주소를 받지 못했습니다. 다시 시도하세요.");
  const url = new URL(location);
  if (url.origin !== "https://www.googleapis.com" || !url.pathname.startsWith("/upload/drive/")) throw new DriveError("Drive 업로드 주소가 올바르지 않습니다.");
  let offset = 0;
  const chunkSize = 8 * 1024 * 1024;
  onProgress({ loaded: 0, total: file.size });
  while (offset < file.size) {
    const end = Math.min(file.size, offset + chunkSize);
    const response = await fetch(url, { method: "PUT", signal, credentials: "omit", redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": mimeType, "Content-Range": `bytes ${offset}-${end - 1}/${file.size}` }, body: file.slice(offset, end) });
    if (response.ok) {
      const metadata = await response.json();
      if (!metadata.id) throw new DriveError("업로드된 파일 정보를 확인하지 못했습니다.");
      onProgress({ loaded: file.size, total: file.size });
      return uploadedDriveDocument(metadata);
    }
    if (response.status === 308) {
      const range = response.headers.get("Range")?.match(/^bytes=0-(\d+)$/u);
      const next = range ? Number(range[1]) + 1 : 0;
      if (next <= offset || next > end || next >= file.size) throw new DriveError("업로드 진행 정보를 확인하지 못했습니다. 다시 시도하세요.");
      offset = next;
      onProgress({ loaded: offset, total: file.size });
    } else {
      const payload = await response.json().catch(() => ({}));
      throw new DriveError(payload.error?.message || "파일 업로드에 실패했습니다. 연결 상태를 확인하고 다시 시도하세요.", response.status);
    }
  }
  throw new DriveError("업로드 완료를 확인하지 못했습니다.");
}
