import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await mkdir(path.join(root, "public"), { recursive: true });
await copyFile(path.join(root, "ui", "dist", "index.html"), path.join(root, "public", "index.html"));
console.log("Copied ui/dist/index.html to public/index.html");
