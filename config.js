export const DEFAULT_CONFIG = Object.freeze({
  appName: "DocFinder",
  organization: "내 문서함",
  googleClientId: "",
  rootFolderId: "",
  pdfEditorUrl: "",
  demoMode: false
});

export const BUILD_PROFILE = Object.freeze({
  profile: "private",
  settings: Object.freeze({})
});

export function resolvePublicSnapshotUrls(configModuleUrl = import.meta.url) {
  return {
    catalog: new URL("./library/catalog.json", configModuleUrl).href,
    searchIndex: new URL("./library/search-index.json", configModuleUrl).href
  };
}
