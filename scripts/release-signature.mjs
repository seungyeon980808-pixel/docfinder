import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const pdfHeader = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
const oleHeader = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function startsWith(buffer, signature) {
  return buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature);
}

export async function assertNoDisguisedDocument(kind, root, relativePath) {
  if (kind === "deploy" && relativePath.startsWith("library/")) return;
  const handle = await fs.open(path.join(root, relativePath), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const contents = header.subarray(0, bytesRead);
    if (contents.indexOf(pdfHeader) >= 0 || startsWith(contents, oleHeader) || startsWith(contents, zipHeader)) {
      throw new Error(`document signature is forbidden outside an approved document root: ${relativePath}`);
    }
  } finally {
    await handle.close();
  }
}
