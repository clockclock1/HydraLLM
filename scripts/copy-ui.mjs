import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(root, "ui", "dist");
const assetsDir = path.join(root, "assets");

await rm(assetsDir, { recursive: true, force: true });
await mkdir(assetsDir, { recursive: true });

const indexHtml = await readFile(path.join(distDir, "index.html"), "utf8");
await writeFile(path.join(assetsDir, "index.html"), indexHtml.replace(/\r\n/g, "\n"), "utf8");

async function copyDir(from, to) {
  await mkdir(to, { recursive: true });
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyDir(source, target);
    } else if (entry.name !== "index.html") {
      await copyFile(source, target);
    }
  }
}

await copyDir(distDir, assetsDir);

console.log("Copied ui/dist frontend assets to assets/");
