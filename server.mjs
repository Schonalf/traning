import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./public/", import.meta.url));
const port = Number(process.env.PORT || 4173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json; charset=utf-8",
};
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://api.github.com; font-src 'self'; media-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

const PREFIX = "/traning";

function mapPath(pathname) {
  if (pathname === PREFIX) return { redirect: `${PREFIX}/` };
  let raw = pathname;
  if (raw.startsWith(`${PREFIX}/`)) raw = raw.slice(PREFIX.length) || "/";
  if (raw === "/") raw = "/index.html";
  const path = normalize(raw).replace(/^(\.\.[/\\])+/, "");
  if (!path.startsWith("/") || path.includes("..")) return { error: 400 };
  const file = join(root, path);
  if (!file.startsWith(root)) return { error: 400 };
  return { file, path };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const mapped = mapPath(url.pathname);
  if (mapped.redirect) {
    res.writeHead(302, { Location: mapped.redirect, "Cache-Control": "no-store" });
    res.end();
    return;
  }
  if (mapped.error) {
    res.writeHead(mapped.error);
    res.end("bad path");
    return;
  }
  const { file, path } = mapped;
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": types[extname(path)] || "application/octet-stream",
      "Content-Security-Policy": csp,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Security-Policy": csp });
    res.end("missing");
  }
});

server.listen(port, "127.0.0.1");
