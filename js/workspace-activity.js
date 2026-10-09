let selectedKey = "";

export function setWorkspaceActivity(pane) {
  const workspace = document.querySelector(".workspace");
  if (!workspace) return;
  const active = pane === "preview" && selectedKey ? "preview" : "documents";
  workspace.dataset.activePane = active;
  const label = document.querySelector("#preview-activity");
  const message = active === "preview" ? "원문 작업 중" : "선택한 문서";
  if (label && label.textContent !== message) label.textContent = message;
}

export function setWorkspaceDocument(item) {
  const header = document.querySelector("#preview-document-header");
  if (!header) return;
  const key = item ? `${item.libraryId || ""}:${item.id}` : "";
  header.hidden = !item;
  const title = document.querySelector("#preview-document-name");
  title.textContent = item?.name || "";
  title.title = item?.name || "";
  if (key !== selectedKey) {
    selectedKey = key;
    setWorkspaceActivity("documents");
  }
}

export function installWorkspaceActivity() {
  const workspace = document.querySelector(".workspace");
  if (!workspace) return;
  workspace.dataset.activePane = "documents";
  const activate = (event) => {
    if (event.target.closest("#detail-panel")) setWorkspaceActivity("preview");
    else if (event.target.closest(".document-pane")) setWorkspaceActivity("documents");
  };
  workspace.addEventListener("pointerdown", activate);
  workspace.addEventListener("focusin", activate);
  workspace.addEventListener("wheel", activate, { passive: true });
}
