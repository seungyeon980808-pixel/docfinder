import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoDisguisedDocument } from "./release-signature.mjs";

const sourceFiles = new Set([".gitignore", "404.html", "DESIGN.md", "README.md", "config.js", "index.html", "package-lock.json", "package.json"]);
const sourceRoots = new Set(["data", "js", "scripts", "styles", "tests", "vendor"]);
const deployFiles = new Set(["404.html", "_headers", "_redirects", "config.js", "favicon.ico", "index.html"]);
const deployRoots = new Set(["data", "js", "library", "styles", "vendor"]);
const vendorExtensions = new Set([".bcmap", ".css", ".html", ".js", ".mjs", ".pfb", ".svg", ".ttf", ".wasm", ".woff2"]);
const sourceExtensions = new Map([
  ["data", new Set([".js", ".json", ".mjs"])],
  ["js", new Set([".js", ".json", ".mjs"])],
  ["scripts", new Set([".cjs", ".js", ".mjs"])],
  ["styles", new Set([".css"])],
  ["tests", new Set([".cjs", ".css", ".html", ".hwp", ".hwpx", ".js", ".json", ".md", ".mjs", ".pdf", ".png", ".svg", ".txt", ".wasm"])],
  ["vendor", vendorExtensions]
]);
const deployExtensions = new Map([
  ["data", new Set([".js", ".json", ".mjs"])],
  ["js", new Set([".js", ".json", ".mjs"])],
  ["library", null],
  ["styles", new Set([".css"])],
  ["vendor", vendorExtensions]
]);

function releaseRules(kind) {
  if (kind === "source") return { files: sourceFiles, roots: sourceRoots, extensions: sourceExtensions };
  if (kind === "deploy") return { files: deployFiles, roots: deployRoots, extensions: deployExtensions };
  throw new Error("release kind must be source or deploy");
}

function isSecretName(name) {
  const lower = name.toLowerCase();
  return lower === ".env" || lower.startsWith(".env.") || lower === ".npmrc"
    || lower.includes("credential") || lower.includes("secret") || lower === "local.settings.json" || lower.endsWith(".key") || lower.endsWith(".pem");
}

function isAllowedFile(kind, relativePath) {
  const rules = releaseRules(kind);
  if (rules.files.has(relativePath)) return true;
  if (kind === "source" && /^LICENSE(?:\.[A-Za-z0-9_-]+)?$/u.test(relativePath)) return true;
  const [root, ...segments] = relativePath.split("/");
  if (!rules.roots.has(root) || segments.length === 0 || segments.some(isSecretName)) return false;
  if (segments.at(-1) === ".DS_Store") return false;
  if (root === "vendor" && /^LICENSE(?:[._-][A-Z0-9_-]+)?$/u.test(segments.at(-1))) return true;
  const extensions = rules.extensions.get(root);
  return extensions === null || extensions.has(path.posix.extname(segments.at(-1)).toLowerCase());
}

function assertNormalizedReleasePath(relativePath) {
  const normalized = path.posix.normalize(relativePath);
  if (!relativePath || relativePath.includes("\\") || relativePath.includes("\0")
    || path.posix.isAbsolute(relativePath) || normalized !== relativePath || normalized === "." || normalized.startsWith("../")) {
    throw new Error(`invalid release path: ${relativePath}`);
  }
}

export function assertAllowedReleasePaths(kind, relativePaths) {
  releaseRules(kind);
  for (const relativePath of relativePaths) {
    assertNormalizedReleasePath(relativePath);
    if (!isAllowedFile(kind, relativePath)) throw new Error(`release path is not allowed: ${relativePath}`);
  }
}

async function lstatOrMissing(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function collectDirectory(kind, root, relative) {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === ".DS_Store") continue;
    const next = path.posix.join(relative, entry.name);
    const stat = await fs.lstat(path.join(root, next));
    if (stat.isSymbolicLink()) throw new Error(`symbolic link is forbidden: ${next}`);
    if (stat.isDirectory()) {
      files.push(...await collectDirectory(kind, root, next));
      continue;
    }
    if (!stat.isFile()) throw new Error(`non-regular release entry is forbidden: ${next}`);
    assertAllowedReleasePaths(kind, [next]);
    await assertNoDisguisedDocument(kind, root, next);
    files.push(next);
  }
  return files;
}

async function assertReleaseRoot(root) {
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("release root must be a real directory");
}

async function assertRequiredReleaseStructure(kind, root) {
  if (kind !== "deploy") return;
  const stat = await lstatOrMissing(path.join(root, "library"));
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("deploy release requires a generated library directory");
  }
}

export async function collectReleaseInventory(kind, root) {
  const rules = releaseRules(kind);
  await assertReleaseRoot(root);
  await assertRequiredReleaseStructure(kind, root);
  const files = [];
  for (const relative of [...rules.files].sort()) {
    const stat = await lstatOrMissing(path.join(root, relative));
    if (stat === null) continue;
    if (stat.isSymbolicLink()) throw new Error(`symbolic link is forbidden: ${relative}`);
    if (!stat.isFile()) throw new Error(`non-regular release entry is forbidden: ${relative}`);
    await assertNoDisguisedDocument(kind, root, relative);
    files.push(relative);
  }
  if (kind === "source") {
    for (const entry of await fs.readdir(root)) {
      if (!/^LICENSE(?:\.[A-Za-z0-9_-]+)?$/u.test(entry)) continue;
      const stat = await fs.lstat(path.join(root, entry));
      if (stat.isSymbolicLink()) throw new Error(`symbolic link is forbidden: ${entry}`);
      if (!stat.isFile()) throw new Error(`non-regular release entry is forbidden: ${entry}`);
      await assertNoDisguisedDocument(kind, root, entry);
      files.push(entry);
    }
  }
  for (const relative of [...rules.roots].sort()) {
    const stat = await lstatOrMissing(path.join(root, relative));
    if (stat === null) continue;
    if (stat.isSymbolicLink()) throw new Error(`symbolic link is forbidden: ${relative}`);
    if (!stat.isDirectory()) throw new Error(`release root entry must be a directory: ${relative}`);
    files.push(...await collectDirectory(kind, root, relative));
  }
  const inventory = [...new Set(files)].sort();
  assertAllowedReleasePaths(kind, inventory);
  return inventory;
}

export async function verifyReleaseTree(kind, root) {
  releaseRules(kind);
  await assertReleaseRoot(root);
  await assertRequiredReleaseStructure(kind, root);
  const files = [];
  async function visit(relative = "") {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const next = path.posix.join(relative, entry.name);
      const stat = await fs.lstat(path.join(root, next));
      if (stat.isSymbolicLink()) throw new Error(`symbolic link is forbidden: ${next}`);
      const [top] = next.split("/");
      if (stat.isDirectory()) {
        if (!releaseRules(kind).roots.has(top)) throw new Error(`release directory is not allowed: ${next}`);
        await visit(next);
      } else if (stat.isFile()) {
        assertAllowedReleasePaths(kind, [next]);
        await assertNoDisguisedDocument(kind, root, next);
        files.push(next);
      } else {
        throw new Error(`non-regular release entry is forbidden: ${next}`);
      }
    }
  }
  await visit();
  return files.sort();
}

async function copyRegularFile(source, destination) {
  const sourceHandle = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, await sourceHandle.readFile(), { flag: "wx" });
  } finally {
    await sourceHandle.close();
  }
}

export async function packageRelease({ kind, source, output }) {
  const inventory = await collectReleaseInventory(kind, source);
  if (await lstatOrMissing(output)) throw new Error("release output already exists");
  const parent = path.dirname(output);
  await fs.mkdir(parent, { recursive: true });
  const staging = await fs.mkdtemp(path.join(parent, ".docfinder-release-"));
  try {
    for (const relative of inventory) {
      await copyRegularFile(path.join(source, relative), path.join(staging, relative));
    }
    await verifyReleaseTree(kind, staging);
    await fs.rename(staging, output);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze({ kind, fileCount: inventory.length });
}

async function main() {
  const [action, kind, root, output] = process.argv.slice(2);
  if (action === "package" && root && output) {
    const report = await packageRelease({ kind, source: path.resolve(root), output: path.resolve(output) });
    console.log(JSON.stringify({ ok: true, action, ...report }));
    return;
  }
  if (action === "verify" && root && output === undefined) {
    const inventory = await verifyReleaseTree(kind, path.resolve(root));
    console.log(JSON.stringify({ ok: true, action, kind, fileCount: inventory.length }));
    return;
  }
  throw new Error("usage: release-package.mjs package <source|deploy> <root> <output> | verify <source|deploy> <root>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
