export const DEFAULT_CONFIG = Object.freeze({
  appName: "DocFinder",
  organization: "학교 업무 공개 문서",
  googleClientId: "",
  rootFolderId: "",
  pdfEditorUrl: "",
  demoMode: false
});

export const BUILD_PROFILE = Object.freeze({
  profile: "public",
  settings: Object.freeze({})
});

export function resolvePublicSnapshotUrls(configModuleUrl = import.meta.url) {
  return {
    catalog: new URL("./library/catalog.json", configModuleUrl).href,
    searchIndex: new URL("./library/search-index.json", configModuleUrl).href
  };
}
