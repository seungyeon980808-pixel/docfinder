export function buildPdfEditorUrl(editorUrl, documentItem, baseUrl = globalThis.location?.href || "http://localhost/") {
  const configured = String(editorUrl || "").trim();
  if (!configured) return "";
  const values = {
    source: documentItem.sourceUrl || documentItem.downloadUrl || documentItem.webViewLink || documentItem.previewUrl || "",
    fileId: documentItem.id || "",
    name: documentItem.name || ""
  };
  if (/\{(?:source|fileId|name)\}/u.test(configured)) {
    return configured.replace(/\{(source|fileId|name)\}/gu, (_, key) => encodeURIComponent(values[key]));
  }
  const url = new URL(configured, baseUrl);
  for (const [key, value] of Object.entries(values)) if (value) url.searchParams.set(key, value);
  return url.href;
}

export function openPdfEditor(editorUrl, documentItem) {
  const url = buildPdfEditorUrl(editorUrl, documentItem);
  if (!url) return false;
  window.open(url, "_blank", "noopener,noreferrer");
  return true;
}
