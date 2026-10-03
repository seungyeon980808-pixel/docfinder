import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const label = "local.docfinder";
const escapeXml = (value) => String(value).replace(/[<>&"']/gu, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]);

export function servicePlist({ executable, script, source, logs, workingDirectory, cache, instance }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${[executable, script, source, "--port", "4173", "--cache", cache].map((argument) => `<string>${escapeXml(argument)}</string>`).join("")}</array>
  <key>WorkingDirectory</key><string>${escapeXml(workingDirectory)}</string>
  <key>EnvironmentVariables</key><dict><key>DOCFINDER_SERVICE_INSTANCE</key><string>${escapeXml(instance)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escapeXml(path.join(logs, "server.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(logs, "error.log"))}</string>
</dict></plist>
`;
}

async function install() {
  if (process.platform !== "darwin") throw new Error("로그인 시 자동 실행은 macOS에서 지원합니다. 다른 운영체제에서는 npm start를 사용하세요.");
  const source = await fs.realpath(process.argv[2] || path.join(root, "private/docs"));
  if (!(await fs.stat(source)).isDirectory()) throw new Error("문서 폴더를 지정하세요.");
  const runtime = path.join(os.homedir(), "Library/Application Support/DocFinder");
  const installedApp = path.join(runtime, "app");
  const script = path.join(installedApp, "scripts/serve-local.mjs");
  const cache = path.join(runtime, "private");
  const agents = path.join(os.homedir(), "Library/LaunchAgents");
  const logs = path.join(os.homedir(), "Library/Logs/DocFinder");
  await fs.mkdir(agents, { recursive: true });
  await fs.mkdir(logs, { recursive: true });
  const destination = path.join(agents, `${label}.plist`);
  const existing = await fs.readFile(destination, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
  const knownScripts = [script, path.join(root, "scripts/serve-local.mjs")];
  if (existing && !knownScripts.some((known) => existing.includes(`<string>${escapeXml(known)}</string>`))) throw new Error("같은 이름의 다른 서비스가 있습니다. 기존 설정을 확인하세요.");
  const domain = `gui/${process.getuid()}`;
  const active = await run("launchctl", ["print", `${domain}/${label}`]).then(() => true, () => false);
  if (active) await run("launchctl", ["bootout", `${domain}/${label}`]);
  await fs.mkdir(runtime, { recursive: true });
  const staging = await fs.mkdtemp(path.join(runtime, "app-stage-"));
  const backup = path.join(runtime, "app-previous");
  try {
    for (const entry of ["index.html", "404.html", "config.js", "package.json", "package-lock.json", "js", "scripts", "styles", "vendor", "data", "node_modules"]) {
      await fs.cp(path.join(root, entry), path.join(staging, entry), { recursive: true });
    }
    await fs.rm(backup, { recursive: true, force: true });
    await fs.rename(installedApp, backup).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await fs.rename(staging, installedApp);
    await fs.rm(backup, { recursive: true, force: true });
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
  const brewNode = "/opt/homebrew/bin/node";
  const executable = await fs.access(brewNode).then(() => brewNode, () => process.execPath);
  const temporary = `${destination}.tmp`;
  const instance = randomUUID();
  await fs.writeFile(temporary, servicePlist({ executable, script, source, logs, cache, instance, workingDirectory: installedApp }), { mode: 0o600 });
  await run("plutil", ["-lint", temporary]);
  await fs.rename(temporary, destination);
  await run("launchctl", ["bootstrap", domain, destination]);
  let healthy = false;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:4173/api/index-status", { signal: AbortSignal.timeout(1000) });
      const status = await response.json();
      if (response.ok && status.automatic && status.serviceInstance === instance && status.revision) { healthy = true; break; }
    } catch { /* Allow startup and indexing to finish before checking again. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!healthy) {
    await run("launchctl", ["bootout", `${domain}/${label}`]).catch(() => {});
    await fs.rename(destination, `${destination}.disabled`);
    throw new Error("문서 폴더 접근을 확인하지 못해 로그인 자동 실행을 비활성화했습니다. npm start로 실행하고 폴더 접근 권한을 확인하세요.");
  }
  console.log("DocFinder 자동 색인 서비스 설치 완료: 로그인 시 시작 · http://127.0.0.1:4173/");
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => "") === fileURLToPath(import.meta.url)) {
  install().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
