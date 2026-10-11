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
  workspace.addEventListener("keydown", handleWorkspaceKey);
}

export function handleWorkspaceKey(event) {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    || event.target.closest('input, textarea, select, [contenteditable], dialog, [role="textbox"]')) return;
  const inPreview = event.target.closest('#detail-panel');
  const selected = () => document.querySelector('[data-document-id][aria-current="true"]');
  if (inPreview) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault(); document.querySelector('#detail-back')?.click(); selected()?.focus(); setWorkspaceActivity('documents');
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const button = document.querySelector(`#preview-controls [data-match-direction="${event.key === 'ArrowUp' ? 'previous' : 'next'}"]`);
      if (!button) return; // No indexed locations: retain ordinary scrolling.
      event.preventDefault();
      if (!button.disabled) button.click();
      setWorkspaceActivity('preview');
    }
    return;
  }
  if (!event.target.closest('[data-document-id]')) return;
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    if (window.matchMedia('(max-width: 959px)').matches) selected()?.click();
    document.querySelector('#document-detail')?.focus(); setWorkspaceActivity('preview');
  } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    const rows = [...document.querySelectorAll('[data-document-id]')];
    const current = rows.indexOf(event.target.closest('[data-document-id]'));
    const destination = rows[current + (event.key === 'ArrowUp' ? -1 : 1)];
    event.preventDefault();
    if (!destination) return;
    destination.click(); // Selection redraws rows; focus the replacement node.
    selected()?.focus(); selected()?.scrollIntoView({ block: 'nearest' });
  }
}
