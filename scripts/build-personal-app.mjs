import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectReleaseInventory, verifyReleaseTree } from "./release-package.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function buildPersonalApp({ source = appRoot, output, clientId = "" }) {
  if (!output || path.resolve(output) === path.resolve(source)) throw new Error("새 배포 출력 폴더를 지정하세요.");
  if (clientId && !/^[\w-]+\.apps\.googleusercontent\.com$/u.test(clientId)) throw new Error("Google OAuth 웹 클라이언트 ID를 확인하세요.");
  if (await fs.lstat(output).catch(() => null)) throw new Error("출력 폴더가 이미 있습니다. 새 경로를 지정하세요.");
  const inventory = await collectReleaseInventory("source", source);
  const parent = path.dirname(path.resolve(output));
  await fs.mkdir(parent, { recursive: true });
  const staging = await fs.mkdtemp(path.join(parent, ".docfinder-personal-"));
  try {
    for (const file of inventory.filter((file) => ["index.html", "404.html"].includes(file) || /^(js|styles|vendor)\//u.test(file))) {
      await fs.mkdir(path.dirname(path.join(staging, file)), { recursive: true });
      await fs.copyFile(path.join(source, file), path.join(staging, file));
    }
    const config = await fs.readFile(path.join(source, "config.js"), "utf8");
    if (!config.includes('profile: "private"') || !config.includes('googleClientId: ""')) throw new Error("기본 배포 설정을 확인하세요.");
    await fs.writeFile(path.join(staging, "config.js"), config.replace('googleClientId: ""', `googleClientId: ${JSON.stringify(clientId)}`));
    await fs.mkdir(path.join(staging, "data"));
    await fs.writeFile(path.join(staging, "data/demo-documents.js"), "export const DEMO_DOCUMENTS = [];\n");
    await fs.writeFile(path.join(staging, "_headers"), "/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Cache-Control: no-cache\n");
    const files = await verifyReleaseTree("personal", staging);
    await fs.rename(staging, output);
    return { fileCount: files.length, googleConfigured: Boolean(clientId) };
  } catch (error) { await fs.rm(staging, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name) => args[args.indexOf(name) + 1];
  if (!args.includes("--output")) throw new Error("--output <새-배포-폴더>를 지정하세요.");
  buildPersonalApp({ output: path.resolve(value("--output")), clientId: args.includes("--client-id") ? value("--client-id") : "" })
    .then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
