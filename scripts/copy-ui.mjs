import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(root, "ui", "dist");
const assetsDir = path.join(root, "assets");

await rm(assetsDir, { recursive: true, force: true });
await mkdir(assetsDir, { recursive: true });

const indexHtml = await readFile(path.join(distDir, "index.html"), "utf8");
await writeFile(path.join(assetsDir, "index.html"), indexHtml.replace(/\r\n/g, "\n"), "utf8");
for (const file of ["app.css", "app.js"]) {
  await copyFile(path.join(distDir, file), path.join(assetsDir, file));
}
await writeFile(path.join(assetsDir, "app-core.js"), "export {};\n", "utf8");

console.log("Copied ui/dist frontend assets to assets/");
