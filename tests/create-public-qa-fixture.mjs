import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function syntheticPdf(pageTexts) {
  const objects = ["", "<< /Type /Catalog /Pages 2 0 R >>", ""];
  const pageIds = [];
  for (const [index, text] of pageTexts.entries()) {
    const pageId = objects.length;
    const contentId = pageId + 1;
    pageIds.push(pageId);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${pageTexts.length * 2 + 3} 0 R >> >> /Contents ${contentId} 0 R >>`);
    const stream = `BT /F1 22 Tf 72 700 Td (${text.replace(/[()\\]/gu, "\\$&")}) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(body);
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

async function copyTree(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await fs.copyFile(from, to);
  }
}

export async function createPublicQaFixture(output) {
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  for (const root of ["data", "js", "styles", "vendor"]) await copyTree(path.join(appRoot, root), path.join(output, root));
  await fs.copyFile(path.join(appRoot, "index.html"), path.join(output, "index.html"));
  const config = (await fs.readFile(path.join(appRoot, "config.js"), "utf8")).replace(/profile:\s*"private"/u, 'profile: "public"');
  await fs.writeFile(path.join(output, "config.js"), config);
  await fs.writeFile(path.join(output, "_headers"), "/library/*\n  Cache-Control: no-store\n");

  const source = syntheticPdf(["Synthetic alpha beta page one", "Synthetic second page", "Synthetic third page"]);
  const id = "doc-aaaaaaaaaaaaaaaaaaaaaaaa";
  const digest = createHash("sha256").update(source).digest("hex");
  const originalUrl = `originals/${id}.${digest.slice(0, 16)}.pdf`;
  await fs.mkdir(path.join(output, "library", "originals"), { recursive: true });
  await fs.writeFile(path.join(output, "library", originalUrl), source);
  const document = {
    id, name: "synthetic-alpha-guide.pdf", folder: "Synthetic", path: "Synthetic / synthetic-alpha-guide.pdf",
    publisher: "Synthetic", modifiedTime: "2026-01-01T00:00:00.000Z", size: source.length,
    format: "pdf", mimeType: "application/pdf", source: "public", sourceUrl: originalUrl,
    page: null, heading: "Synthetic", excerpt: "Synthetic release fixture"
  };
  await Promise.all([
    fs.writeFile(path.join(output, "library", "catalog.json"), JSON.stringify({ version: 1, sourceName: "Synthetic", generatedAt: "2026-01-01T00:00:00.000Z", documents: [document] })),
    fs.writeFile(path.join(output, "library", "search-index.json"), JSON.stringify({ version: 1, entries: [
      { id, page: 1, text: "synthetic alpha beta near" },
      { id, page: 2, text: "synthetic second page" },
      { id, page: 3, text: "synthetic third page" }
    ] })),
    fs.writeFile(path.join(output, "library", "manifest.json"), JSON.stringify({ version: 1, generatedAt: "2026-01-01T00:00:00.000Z", documents: [
      { id, format: "pdf", size: source.length, sha256: digest, extractionStatus: "ok", textlessPageCount: 0, modifiedTime: document.modifiedTime, originalUrl }
    ], delta: { added: [id], changed: [], removed: [] }, warnings: [] }))
  ]);
  return output;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output) throw new Error("usage: create-public-qa-fixture.mjs OUTPUT");
  await createPublicQaFixture(path.resolve(output));
}
