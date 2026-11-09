import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const docs = join(root, "docs");
const files = [
  "index.html",
  "styles.css",
  "main.mjs",
  "manifest.webmanifest",
  "icon.svg",
  "sw.js",
  "lib/schema.mjs",
  "lib/equipment.mjs",
  "lib/engine.mjs",
  "lib/rest.mjs",
  "lib/github.mjs",
  "lib/export.mjs",
  "lib/demo-plan.mjs",
  "lib/sync.mjs",
];

await rm(docs, { recursive: true, force: true });
await mkdir(docs, { recursive: true });
for (const rel of files) {
  const dest = join(docs, rel);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(join(root, "public", rel), dest);
}
await writeFile(join(docs, ".nojekyll"), "");
console.log(`docs: ${files.length} files + .nojekyll`);
