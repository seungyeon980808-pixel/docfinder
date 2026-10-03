import http from "node:http";
import fs from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLocalIndex } from "./build-local-index.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supported = new Set([".pdf", ".hwp", ".hwpx"]);
const runtimeRoots = new Set(["js", "styles", "vendor", "data"]);
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".pdf": "application/pdf", ".wasm": "application/wasm",
  ".woff2": "font/woff2", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

export async function sourceFingerprint(root, relative = "") {
  const result = [];
  for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFingerprint(root, next));
    else if (entry.isFile() && supported.has(path.extname(entry.name).toLowerCase())) {
      const stat = await fs.stat(path.join(root, next), { bigint: true });
      result.push([next, String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]);
    }
  }
  return result;
}

export async function startLocalServer({ sourceRoot, outputRoot = path.join(appRoot, "private"), port = 4173, pollMs = 5000, settleMs = 750, personal = false } = {}) {
  const source = personal ? "" : await fs.realpath(sourceRoot || path.join(appRoot, "private/docs"));
  if (!personal && !(await fs.stat(source)).isDirectory()) throw new Error("문서 폴더를 지정하세요.");
  let snapshot;
  let fingerprint;
  let building = false;
  let dirty = false;
  let stopping = false;
  let timer;
  let retryAt = 0;
  let monitor;
  const generations = new Map();
  const state = { automatic: !personal, serviceInstance: process.env.DOCFINDER_SERVICE_INSTANCE || "", phase: personal ? "ready" : "indexing", revision: "", updatedAt: "", stats: {}, message: "" };

  async function rebuild() {
    if (building || stopping) { dirty = true; return; }
    building = true;
    dirty = false;
    try {
      const before = JSON.stringify(await sourceFingerprint(source));
      // Watchers may report directory creation or duplicate events after a
      // successful build. Keep its revision and retained search generations.
      if (snapshot && before === fingerprint && !snapshot.stats.failures) {
        state.phase = "ready";
        state.message = "";
        return;
      }
      state.phase = "indexing";
      await new Promise((resolve) => setTimeout(resolve, settleMs));
      if (before !== JSON.stringify(await sourceFingerprint(source))) { dirty = true; return; }
      const next = await buildLocalIndex({ sourceRoot: source, outputRoot, previous: snapshot, quiet: true });
      const after = JSON.stringify(await sourceFingerprint(source));
      if (before !== after) { dirty = true; return; }
      snapshot = next;
      fingerprint = after;
      generations.set(next.catalog.generatedAt, next);
      while (generations.size > 2) generations.delete(generations.keys().next().value);
      Object.assign(state, { phase: next.stats.failures ? "error" : "ready", revision: next.catalog.generatedAt,
        updatedAt: next.catalog.generatedAt, stats: next.stats,
        message: next.stats.failures ? `${next.stats.failures}개 문서를 검색하지 못했습니다. 암호화 여부와 파일 형식을 확인하세요.` : "" });
      retryAt = next.stats.failures ? Date.now() + 15000 : 0;
      console.log(`색인 갱신: 문서 ${next.stats.documents}, 추출 ${next.stats.indexed}, 재사용 ${next.stats.reused}, 실패 ${next.stats.failures}`);
    } catch {
      state.phase = "error";
      state.message = "문서 폴더를 읽지 못했습니다. 폴더 연결과 동기화 상태를 확인하세요.";
      retryAt = Date.now() + 15000;
      console.error(state.message);
    } finally {
      building = false;
      if (dirty && !stopping) schedule();
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => void rebuild(), settleMs);
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Robots-Tag", "noindex, nofollow");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const send = (code, value, contentType = "application/json; charset=utf-8") => {
      response.writeHead(code, { "Content-Type": contentType });
      response.end(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    };
    try {
      if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/u.test(request.headers.host || "")) return send(403, { error: "Forbidden" });
      if (!["GET", "HEAD"].includes(request.method)) return send(405, { error: "Method not allowed" });
      const url = new URL(request.url, "http://127.0.0.1");
      const rawPath = decodeURIComponent(request.url.split("?")[0]);
      if (rawPath.includes("\\") || rawPath.includes("\0") || rawPath.split("/").some((part) => part === ".." || part === ".")) return send(404, { error: "Not found" });
      const pathname = decodeURIComponent(url.pathname);
      if (personal && pathname.startsWith("/private/")) return send(404, { error: "Not found" });
      if (personal && pathname === "/data/demo-documents.js") return send(200, "export const DEMO_DOCUMENTS = [];\n", mime[".js"]);
      if (pathname === "/api/index-status") return send(200, state);
      if (pathname === "/private/catalog.json") return snapshot ? send(200, snapshot.catalog) : send(503, { error: state.message || "Indexing" });
      if (pathname === "/private/search-index.json") {
        const version = url.searchParams.get("revision");
        const selected = version ? generations.get(version) : snapshot;
        return selected ? send(200, selected.index) : send(410, { error: "Reload catalog" });
      }
      if (pathname === "/config.js") {
        const config = (await fs.readFile(path.join(appRoot, "config.js"), "utf8")).replace('profile: "private"', personal ? 'profile: "private"' : 'profile: "local"');
        return send(200, config, mime[".js"]);
      }
      let file;
      let containmentRoot = appRoot;
      if (pathname.startsWith("/private/docs/")) {
        const item = snapshot?.catalog.documents.find((document) => decodeURIComponent(new URL(document.sourceUrl, "http://localhost/").pathname) === pathname);
        if (!item) return send(404, { error: "Not found" });
        file = path.join(source, item.relativePath);
        containmentRoot = source;
      } else {
        const relative = pathname === "/" ? "index.html" : pathname.slice(1);
        if (!["index.html", "404.html", "favicon.ico"].includes(relative) && !runtimeRoots.has(relative.split("/")[0])) return send(404, { error: "Not found" });
        file = path.join(appRoot, relative);
      }
      const real = await fs.realpath(file);
      if (!real.startsWith(`${containmentRoot}${path.sep}`) || !(await fs.stat(real)).isFile()) return send(404, { error: "Not found" });
      const bytes = await fs.readFile(real);
      response.setHeader("Content-Length", bytes.length);
      send(200, request.method === "HEAD" ? "" : bytes, mime[path.extname(real)] || "application/octet-stream");
    } catch { send(404, { error: "Not found" }); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  if (personal) return { server, state, close: () => new Promise((resolve) => server.close(resolve)) };
  if (!source.split(path.sep).includes("CloudStorage")) {
    try {
      monitor = watch(source, { recursive: true }, (_event, filename) => {
        if (!filename || supported.has(path.extname(String(filename)).toLowerCase()) || !path.extname(String(filename))) schedule();
      });
      monitor.on("error", () => { monitor.close(); monitor = undefined; });
    } catch { /* Periodic scans also catch nested changes when watching is unavailable. */ }
  }
  let checking = false;
  const poll = setInterval(async () => {
    if (checking || building || stopping) return;
    checking = true;
    try {
      if (JSON.stringify(await sourceFingerprint(source)) !== fingerprint || retryAt && Date.now() >= retryAt) schedule();
    } catch { state.phase = "error"; state.message = "문서 폴더 연결을 확인하세요."; }
    finally { checking = false; }
  }, pollMs);
  await rebuild();
  return {
    server, state,
    async close() {
      stopping = true;
      clearTimeout(timer);
      clearInterval(poll);
      monitor?.close();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => "") === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const sourceRoot = args[0] && !args[0].startsWith("--") ? args.shift() : undefined;
  const portFlag = args.indexOf("--port");
  const cacheFlag = args.indexOf("--cache");
  const outputRoot = cacheFlag === -1 ? undefined : args[cacheFlag + 1];
  const port = portFlag === -1 ? 4173 : Number(args[portFlag + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("포트를 확인하세요.");
  startLocalServer({ sourceRoot, outputRoot, port, personal: args.includes("--personal") }).then((service) => {
    console.log(`DocFinder: http://127.0.0.1:${port}/ · ${args.includes("--personal") ? "개인 문서함" : "폴더 자동 감시 중"}`);
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await service.close(); process.exit(0); });
  }).catch(() => { console.error("로컬 서버를 시작하지 못했습니다. 문서 폴더 또는 사용 중인 포트를 확인하세요."); process.exitCode = 1; });
}
