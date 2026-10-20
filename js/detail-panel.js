export function createDetailPanelController() {
  const panel = document.querySelector("#detail-panel");
  const compactLayout = window.matchMedia("(max-width: 959px)");
  let returnDocumentId = "";

  function syncAccessibility() {
    const isClosedOverlay = compactLayout.matches && !panel.classList.contains("is-open");
    panel.inert = isClosedOverlay;
    if (isClosedOverlay) panel.setAttribute("aria-hidden", "true");
    else panel.removeAttribute("aria-hidden");
  }

  function open(documentId) {
    returnDocumentId = documentId;
    if (!compactLayout.matches) return;
    panel.classList.add("is-open");
    syncAccessibility();
    if (compactLayout.matches) document.querySelector("#detail-back").focus();
  }

  function close() {
    if (!panel.classList.contains("is-open")) return;
    panel.classList.remove("is-open");
    syncAccessibility();
    if (returnDocumentId) document.querySelector(`[data-document-id="${CSS.escape(returnDocumentId)}"]`)?.focus();
  }

  compactLayout.addEventListener("change", syncAccessibility);
  syncAccessibility();
  return { open, close };
}
