const RHWP_EDITOR_URL = new URL("../vendor/rhwp-editor/index.js?v=0.8.6-1", import.meta.url).href;
const RHWP_STUDIO_URL = new URL("../vendor/rhwp-studio/index.html", import.meta.url).href;

let editorPromise;
let editor;
let currentDocument;
let dirty = false;
let changeSubscription;

function status(message, type = "") {
  const element = document.querySelector("#hwp-editor-status");
  element.textContent = message;
  element.dataset.type = type;
}

function setBusy(busy) {
  document.querySelector("#hwp-editor-download").disabled = busy;
  document.querySelector("#hwp-editor-close").disabled = false;
}

async function prepareEditor() {
  if (!editorPromise) {
    editorPromise = import(RHWP_EDITOR_URL).then(async ({ createEditor }) => {
      const instance = await createEditor("#hwp-editor-host", {
        studioUrl: RHWP_STUDIO_URL,
        renderer: "canvas2d",
        width: "100%",
        height: "100%"
      });
      changeSubscription = instance.onDocumentChanged?.(() => {
        dirty = true;
        status("편집한 내용이 있습니다. 다운로드하면 원본과 별도의 파일로 저장됩니다.", "changed");
      });
      return instance;
    }).catch((error) => {
      editorPromise = undefined;
      throw error;
    });
  }
  editor = await editorPromise;
  return editor;
}

function downloadBytes(bytes, name, mimeType) {
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

export async function openRhwpEditor(documentItem, getBytes) {
  const dialog = document.querySelector("#hwp-editor-dialog");
  currentDocument = documentItem;
  dirty = false;
  document.querySelector("#hwp-editor-title").textContent = documentItem.name;
  status("RHWP 편집기를 준비하는 중입니다.");
  setBusy(true);
  if (!dialog.open) dialog.showModal();
  try {
    const [instance, bytes] = await Promise.all([prepareEditor(), getBytes(documentItem)]);
    status("문서를 불러오는 중입니다.");
    await instance.loadFile(bytes, documentItem.name, { skipUnsavedGuard: true, suppressDialogs: true });
    dirty = false;
    status("브라우저에서 바로 편집할 수 있습니다. 저장은 원본을 덮어쓰지 않고 사본을 다운로드합니다.");
    setBusy(false);
  } catch (error) {
    status(error instanceof Error ? error.message : "한글 문서를 열지 못했습니다.", "error");
    document.querySelector("#hwp-editor-close").disabled = false;
  }
}

export function requestRhwpEditorClose() {
  const dialog = document.querySelector("#hwp-editor-dialog");
  if (dirty && !window.confirm("다운로드하지 않은 편집 내용이 있습니다. 편집기를 닫을까요?")) return;
  dialog.close();
}

export function initRhwpEditor() {
  const dialog = document.querySelector("#hwp-editor-dialog");
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    requestRhwpEditorClose();
  });
  document.querySelector("#hwp-editor-close").addEventListener("click", requestRhwpEditorClose);
  document.querySelector("#hwp-editor-download").addEventListener("click", async () => {
    if (!editor || !currentDocument) return;
    setBusy(true);
    status("편집본을 만드는 중입니다.");
    try {
      const isHwpx = currentDocument.format === "hwpx";
      const bytes = isHwpx ? await editor.exportHwpx() : await editor.exportHwp();
      downloadBytes(bytes, currentDocument.name, isHwpx ? "application/hwp+zip" : "application/x-hwp");
      await editor.notifySaved?.(currentDocument.name).catch(() => {});
      dirty = false;
      status("편집본을 다운로드했습니다. Drive 원본은 변경되지 않았습니다.");
    } catch (error) {
      status(error instanceof Error ? error.message : "편집본을 만들지 못했습니다.", "error");
    } finally {
      setBusy(false);
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

export function destroyRhwpEditor() {
  changeSubscription?.();
  editor?.destroy();
  editor = undefined;
  editorPromise = undefined;
}
