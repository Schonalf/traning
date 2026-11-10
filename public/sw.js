const ALLOW = new Set([
  "",
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
  "lib/session-plan.mjs",
]);

const CACHE_PREFIX = `atlas-static-${encodeURIComponent(self.registration.scope)}-`;
const CACHE = `${CACHE_PREFIX}v6`;

function scopePrefix() {
  const pathname = new URL(self.registration.scope).pathname;
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

function shellRel(url) {
  if (url.origin !== self.location.origin) return null;
  const prefix = scopePrefix();
  let path = url.pathname;
  if (path + "/" === prefix) path = prefix;
  if (!path.startsWith(prefix)) return null;
  const rel = path.slice(prefix.length);
  return ALLOW.has(rel) ? rel : null;
}

function shellUrl(rel) {
  const prefix = scopePrefix();
  return new URL(rel, self.location.origin + prefix).href;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([...ALLOW].map((rel) => shellUrl(rel))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (shellRel(url) == null) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreSearch: true });
      if (cached) return cached;
      const fresh = await fetch(event.request);
      if (fresh.ok) await cache.put(event.request, fresh.clone());
      return fresh;
    })
  );
});
