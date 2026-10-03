// PDF.js getTextContent uses ReadableStream async iteration, which is absent
// in some Safari versions. Reading through getReader works there as well.
export async function readPdfTextContent(page, readers = new Set()) {
  const reader = page.streamTextContent().getReader();
  readers.add(reader);
  const content = { items: [], styles: Object.create(null), lang: null };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return content;
      content.lang ??= value.lang;
      Object.assign(content.styles, value.styles);
      content.items.push(...value.items);
    }
  } finally {
    readers.delete(reader);
    reader.releaseLock();
  }
}
