import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assertAllowedReleasePaths,
  collectReleaseInventory,
  packageRelease
} from "../scripts/release-package.mjs";

const appRoot = new URL("../", import.meta.url);
const run = promisify(execFile);
const requiredStudioFonts = [
  "D2Coding-Regular.woff2",
  "GowunBatang-Regular.woff2",
  "NotoSansKR-ExtraLight.woff2",
  "NotoSansKR-Regular.woff2",
  "NotoSerifKR-Bold.woff2",
  "NotoSerifKR-Regular.woff2",
  "Pretendard-Regular.woff2"
];

async function writeFixture(root, relativePath, contents = relativePath) {
  const destination = path.join(root, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, contents);
}

async function makeReleaseFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "docfinder-package-test-"));
  const files = [
    ".gitignore", "README.md", "DESIGN.md", "404.html", "index.html", "config.js", "package.json", "package-lock.json",
    "data/demo.js", "js/app.js", "styles/app.css", "vendor/runtime/app.wasm", "scripts/tool.mjs", "tests/tool.test.mjs",
    "library/catalog.json", "library/search-index.json", "library/originals/manual.pdf",
    "private/catalog.json", "evidence/screenshot.png", "node_modules/module.js", ".omo/state.json", ".git/config",
    ".env", "local.settings.json", "dist/stale.html", "source-package/stale.txt"
  ];
  await Promise.all(files.map((relativePath) => writeFixture(root, relativePath)));
  return root;
}

async function allFiles(root, relative = "") {
  const files = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const next = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await allFiles(root, next));
    else files.push(next);
  }
  return files.sort();
}

test("source inventory keeps runtime assets separate from an approved private root link", async (context) => {
  // Given: a self-contained source fixture with a private/docs link to fixture document bytes.
  const source = await makeReleaseFixture();
  context.after(async () => fs.rm(source, { recursive: true, force: true }));
  const approved = path.join(source, "approved");
  await writeFixture(approved, "fixture.pdf", "%PDF fixture bytes");
  await fs.symlink(approved, path.join(source, "private", "docs"), "dir");
  const runtimePaths = ["index.html", "config.js", "data", "js", "styles", "vendor"];

  // When: the forkable-source inventory is collected from the fixture tree.
  const inventory = await collectReleaseInventory("source", source);

  // Then: runtime inputs remain real paths while private state and its root link are excluded.
  const runtimeKinds = await Promise.all(runtimePaths.map(async (relativePath) =>
    (await fs.lstat(path.join(source, relativePath))).isSymbolicLink()));
  assert.deepEqual(runtimeKinds, runtimePaths.map(() => false));
  assert.equal((await fs.lstat(path.join(source, "private", "docs"))).isSymbolicLink(), true);
  assert.equal(inventory.some((relativePath) => relativePath === "private" || relativePath.startsWith("private/")), false);
});

test("source inventory includes every locally referenced HWP Studio font", async () => {
  // Given: the seven local webfont URLs requested by the real HWP preview runtime.
  const bundle = await fs.readFile(new URL("vendor/rhwp-studio/assets/index-SVOdqzZ-.js", appRoot), "utf8");

  // When: the forkable-source inventory and vendored font bytes are inspected.
  const inventory = await collectReleaseInventory("source", fileURLToPath(appRoot));

  // Then: every requested font is an authentic WOFF2 payload included by the release allowlist.
  for (const filename of requiredStudioFonts) {
    assert.match(bundle, new RegExp(`fonts/${filename.replace(".", "\\.")}`, "u"));
    const relative = `vendor/rhwp-studio/fonts/${filename}`;
    assert.ok(inventory.includes(relative), `${relative} is missing from the source inventory`);
    const bytes = await fs.readFile(new URL(relative, appRoot));
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "wOF2");
    assert.ok(bytes.length > 0 && bytes.length <= 25 * 1024 * 1024);
  }
  assert.ok(inventory.includes("vendor/rhwp-studio/LICENSE-FONTS"));
});

test("source env template accepts empty settings and refuses embedded server credentials", async (context) => {
  const source = await makeReleaseFixture();
  context.after(() => fs.rm(source, { recursive: true, force: true }));
  await writeFixture(source, '.env.example', 'GOOGLE_CLIENT_SECRET=\nDATABASE_URL=\nDOCFINDER_ENCRYPTION_KEY=\n');
  assert.ok((await collectReleaseInventory('source', source)).includes('.env.example'));
  for (const name of ['GOOGLE_CLIENT_SECRET', 'GOOGLE_FOLDER_SERVICE_ACCOUNT_JSON', 'DATABASE_URL', 'DOCFINDER_ENCRYPTION_KEY', 'POSTGRES_PASSWORD']) {
    await writeFixture(source, '.env.example', `${name}=fixture-sensitive-value\n`);
    await assert.rejects(collectReleaseInventory('source', source), /must not contain credentials/);
  }
});

test("source package contains only forkable source allowlist entries", async (context) => {
  // Given: app source mixed with private, generated, dependency, orchestration, and secret files.
  const source = await makeReleaseFixture();
  const output = path.join(source, "..", `${path.basename(source)}-source-output`);
  context.after(async () => fs.rm(source, { recursive: true, force: true }));
  context.after(async () => fs.rm(output, { recursive: true, force: true }));

  // When: the source package is assembled through the public packaging API.
  const report = await packageRelease({ kind: "source", source, output });

  // Then: its files exactly match the forkable-source allowlist.
  assert.deepEqual(await allFiles(output), [
    ".gitignore", "404.html", "DESIGN.md", "README.md", "config.js", "data/demo.js", "index.html", "js/app.js",
    "package-lock.json", "package.json", "scripts/tool.mjs", "styles/app.css", "tests/tool.test.mjs",
    "vendor/runtime/app.wasm"
  ]);
  assert.equal(report.fileCount, 14);
});

test("forkable source ignores dependencies installed after checkout", async (context) => {
  // Given: a real source package initialized as a standalone repository.
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "docfinder-source-ignore-test-"));
  const output = path.join(sandbox, "source");
  context.after(async () => fs.rm(sandbox, { recursive: true, force: true }));
  await packageRelease({ kind: "source", source: fileURLToPath(appRoot), output });
  await run("git", ["init", "-q"], { cwd: output });
  await writeFixture(output, "node_modules/example/index.js", "installed dependency");

  // When: Git evaluates the dependency generated by a normal install.
  const { stdout } = await run("git", ["check-ignore", "node_modules/example/index.js"], { cwd: output });

  // Then: the installed dependency is ignored and cannot be committed accidentally.
  assert.equal(stdout.trim(), "node_modules/example/index.js");
});

test("deploy package contains runtime and generated library only", async (context) => {
  // Given: the same mixed tree includes runtime, development, and generated library files.
  const source = await makeReleaseFixture();
  const output = path.join(source, "..", `${path.basename(source)}-deploy-output`);
  context.after(async () => fs.rm(source, { recursive: true, force: true }));
  context.after(async () => fs.rm(output, { recursive: true, force: true }));

  // When: the deploy package is assembled.
  await packageRelease({ kind: "deploy", source, output });

  // Then: no development-only file is present.
  assert.deepEqual(await allFiles(output), [
    "404.html", "config.js", "data/demo.js", "index.html", "js/app.js", "library/catalog.json", "library/originals/manual.pdf",
    "library/search-index.json", "styles/app.css", "vendor/runtime/app.wasm"
  ]);
});

test("deploy inventory refuses to report success without a generated library", async (context) => {
  // Given: an otherwise valid runtime tree with no generated library snapshot.
  const source = await makeReleaseFixture();
  context.after(async () => fs.rm(source, { recursive: true, force: true }));
  await fs.rm(path.join(source, "library"), { recursive: true });

  // When/Then: deploy inventory fails instead of returning a misleading partial package.
  await assert.rejects(collectReleaseInventory("deploy", source), /library/u);
});

for (const kind of ["source", "deploy"]) {
  test(`${kind} inventory rejects a document payload hidden under vendor`, async (context) => {
    // Given: an otherwise valid tree with real-document bytes under a runtime-only root.
    const source = await makeReleaseFixture();
    context.after(async () => fs.rm(source, { recursive: true, force: true }));
    await writeFixture(source, "vendor/runtime/manual.pdf", "%PDF forbidden document fixture");

    // When/Then: inventory fails rather than packaging or verifying the disguised document.
    await assert.rejects(collectReleaseInventory(kind, source), /vendor\/runtime\/manual\.pdf/u);
  });
}

for (const [kind, relativePath, contents] of [
  ["source", "vendor/runtime/manual.js", "%PDF-1.7 disguised document bytes"],
  ["deploy", "vendor/runtime/manual.js", "%PDF-1.7 disguised document bytes"],
  ["source", "vendor/runtime/manual.woff2", "%PDF-1.7 disguised document bytes"],
  ["deploy", "vendor/runtime/manual.woff2", "%PDF-1.7 disguised document bytes"],
  ["source", "js/manual.js", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
  ["deploy", "js/manual.js", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
  ["source", "data/manual.js", Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  ["deploy", "data/manual.js", Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  ["source", "tests/manual.js", "%PDF-1.7 disguised test payload"]
]) {
  test(`${kind} inventory rejects document bytes disguised as ${relativePath}`, async (context) => {
    // Given: document magic bytes renamed to an allowlisted runtime extension.
    const source = await makeReleaseFixture();
    context.after(async () => fs.rm(source, { recursive: true, force: true }));
    await writeFixture(source, relativePath, contents);

    // When/Then: content inspection rejects the payload despite its allowed path.
    await assert.rejects(collectReleaseInventory(kind, source), /document signature/u);
  });
}

test("inventory rejects symlinks inside an allowlisted source root", async (context) => {
  // Given: an allowlisted scripts directory contains a symlink to a regular file.
  const source = await makeReleaseFixture();
  context.after(async () => fs.rm(source, { recursive: true, force: true }));
  await fs.symlink(path.join(source, "README.md"), path.join(source, "scripts", "linked.mjs"));

  // When/Then: inventory fails instead of following or copying the link.
  await assert.rejects(collectReleaseInventory("source", source), /symbolic link/u);
});

test("release path validation rejects traversal and absolute paths", () => {
  // Given: paths that could escape or obscure a release root.
  const malformed = ["../secret", "/absolute", "js/../../secret", "js\\windows.js"];

  // When/Then: every malformed path is rejected at the inventory boundary.
  for (const relativePath of malformed) {
    assert.throws(() => assertAllowedReleasePaths("source", [relativePath]), /release path/u);
  }
});

test("CLI verification rejects a forbidden file injected after packaging", async (context) => {
  // Given: a valid package with a private file injected into its staging tree.
  const source = await makeReleaseFixture();
  const output = path.join(source, "..", `${path.basename(source)}-verify-output`);
  context.after(async () => fs.rm(source, { recursive: true, force: true }));
  context.after(async () => fs.rm(output, { recursive: true, force: true }));
  await packageRelease({ kind: "source", source, output });
  await writeFixture(output, "private/leak.pdf", "forbidden fixture bytes");

  // When: the packaged tree is checked through the real CLI surface.
  const invocation = run(process.execPath, ["scripts/release-package.mjs", "verify", "source", output], { cwd: new URL("..", import.meta.url) });

  // Then: verification exits nonzero and never reports success.
  await assert.rejects(invocation, (error) => {
    assert.notEqual(error.code, 0);
    assert.doesNotMatch(error.stdout, /"ok":true/u);
    return true;
  });
});

test("packaging refuses a stale output directory", async (context) => {
  // Given: a valid input and a pre-existing destination.
  const source = await makeReleaseFixture();
  const output = path.join(source, "existing-output");
  context.after(async () => fs.rm(source, { recursive: true, force: true }));
  await fs.mkdir(output);

  // When/Then: packaging fails instead of merging stale state into a success.
  await assert.rejects(packageRelease({ kind: "source", source, output }), /already exists/u);
});
