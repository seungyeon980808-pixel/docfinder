import assert from "node:assert/strict";
import test from "node:test";
import { readPdfTextContent } from "../js/pdf-text-content.js";

test("PDF text is collected from a stream without async iteration (Safari)", async () => {
  const chunks = [
    { items: [{ str: "학생" }], styles: { first: { fontFamily: "sans-serif" } }, lang: "ko" },
    { items: [{ str: "자치" }], styles: { second: { fontFamily: "serif" } }, lang: "en" }
  ];
  const readers = new Set();
  let released = false;
  const page = { getTextContent() { throw new Error("async iteration is unavailable"); },
    streamTextContent: () => ({ getReader: () => ({
      async read() { assert.equal(readers.size, 1); return chunks.length ? { value: chunks.shift(), done: false } : { done: true }; },
      releaseLock() { released = true; }
    }) }) };
  const content = await readPdfTextContent(page, readers);
  assert.deepEqual(content.items.map((item) => item.str), ["학생", "자치"]);
  assert.equal(content.lang, "ko");
  assert.deepEqual(Object.keys(content.styles), ["first", "second"]);
  assert.equal(readers.size, 0);
  assert.equal(released, true);
});

test("PDF text readers are released on read failure", async () => {
  const readers = new Set();
  let released = false;
  const page = { streamTextContent: () => ({ getReader: () => ({
    async read() { throw new Error("fixture read failed"); },
    releaseLock() { released = true; }
  }) }) };
  await assert.rejects(readPdfTextContent(page, readers), /fixture read failed/);
  assert.equal(readers.size, 0);
  assert.equal(released, true);
});
