import { buildDriveContentQuery, documentFormat, isSupportedDocument, parseFolderId } from "./search.js";

const API_BASE = "https://www.googleapis.com/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
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
  const oauth2 = await waitForIdentity();
  return new Promise((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: "https://www.googleapis.com/auth/drive.readonly",
      callback(response) {
        if (response.error) reject(new DriveError(response.error_description || response.error));
        else resolve(response.access_token);
      },
      error_callback(error) {
        reject(new DriveError(error.message || "Google 계정 연결을 완료하지 못했습니다."));
      }
    });
    client.requestAccessToken({ prompt: "consent" });
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

export async function downloadDriveFile(accessToken, fileId) {
  const url = new URL(`${API_BASE}/${encodeURIComponent(fileId)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new DriveError(payload.error?.message || "Drive 원문을 내려받지 못했습니다.", response.status);
  }
  return response.arrayBuffer();
}
