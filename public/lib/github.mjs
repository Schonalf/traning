export const API_ORIGIN = "https://api.github.com";

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,120}$/;

export function validateTarget(input) {
  const owner = String(input?.owner || "").trim();
  const repo = String(input?.repo || "").trim();
  const branch = String(input?.branch || "").trim();
  if (!OWNER_RE.test(owner)) return { ok: false, error: "Ogiltig owner." };
  if (!REPO_RE.test(repo) || repo.includes("..")) return { ok: false, error: "Ogiltigt repo." };
  if (
    !BRANCH_RE.test(branch) ||
    branch.includes("..") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("//") ||
    branch.startsWith("-")
  ) {
    return { ok: false, error: "Ogiltig branch." };
  }
  return { ok: true, target: { owner, repo, branch } };
}

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || "");
}

export function planPath() {
  return "plans/current.json";
}

export function eventPath(sessionId, eventId) {
  if (!isUuid(sessionId) || !isUuid(eventId)) {
    const error = new Error("bad-path");
    error.code = "PATH";
    throw error;
  }
  return `sessions/${sessionId}/${eventId}.json`;
}

export function contentsUrl(target, path) {
  if (typeof path !== "string" || path.startsWith("/") || path.includes("..") || path.includes("\\")) {
    const error = new Error("bad-path");
    error.code = "PATH";
    throw error;
  }
  const checked = validateTarget(target);
  if (!checked.ok) {
    const error = new Error("bad-target");
    error.code = "TARGET";
    throw error;
  }
  const { owner, repo } = checked.target;
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encoded}`;
}

export function repoUrl(target) {
  const checked = validateTarget(target);
  if (!checked.ok) throw new Error("bad-target");
  const { owner, repo } = checked.target;
  return `${API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  if (typeof btoa === "function") return btoa(bin);
  return Buffer.from(text, "utf8").toString("base64");
}

export function base64ToUtf8(b64) {
  const clean = String(b64 || "").replace(/\s/g, "");
  if (typeof atob === "function") {
    const bin = atob(clean);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(clean, "base64").toString("utf8");
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function eventsEqual(a, b) {
  return canonical(a) === canonical(b);
}

export const COMMIT_MESSAGE = "Add session event";
export const COMPLETE_MESSAGE = "Complete training session";

export function retryDelayMs(headers = {}, now = Date.now()) {
  const retryAfter = Number(headers["retry-after"] ?? headers["Retry-After"]);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1000;
  const reset = Number(headers["x-ratelimit-reset"] ?? headers["X-RateLimit-Reset"]);
  if (Number.isFinite(reset)) {
    const resetMs = reset > 1e12 ? reset : reset * 1000;
    return Math.max(0, resetMs - now);
  }
  return 60_000;
}

export function classifyStatus(status, headers = {}, body = {}, now = Date.now()) {
  const remaining = headers["x-ratelimit-remaining"] ?? headers["X-RateLimit-Remaining"];
  const message = typeof body?.message === "string" ? body.message.toLowerCase() : "";
  if (status === 401) return { kind: "auth", pause: "auth", retry: false };
  if (status === 403) {
    if (remaining === "0" || remaining === 0 || message.includes("rate limit")) {
      return { kind: "rate_limit", pause: "rate_limit", retry: true, retryAfterMs: retryDelayMs(headers, now) };
    }
    return { kind: "permission", pause: "permission", retry: false };
  }
  if (status === 429) {
    return {
      kind: "rate_limit",
      pause: "rate_limit",
      retry: true,
      retryAfterMs: retryDelayMs(headers, now),
    };
  }
  if (status === 409) return { kind: "conflict", pause: null, retry: false, reconcile: true };
  if (status >= 500 && status <= 599) return { kind: "server", pause: null, retry: true };
  if (status >= 200 && status < 300) return { kind: "ok", pause: null, retry: false };
  return { kind: "client", pause: null, retry: false };
}

export function backoffMs(attempt, random = Math.random) {
  const exp = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
  const jitter = Math.floor(random() * 250);
  return exp + jitter;
}

function authHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export async function verifyPrivate(fetchImpl, target, token, { timeoutMs = 12_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(repoUrl(target), { method: "GET", headers: authHeaders(token), signal: controller.signal });
    const body = await readJson(res);
    const classified = classifyStatus(res.status, headerMap(res), body);
    if (!classified.kind || classified.kind !== "ok") {
      return { ok: false, ...classified, status: res.status };
    }
    if (body.private !== true) return { ok: false, kind: "public_repo", pause: "public", retry: false, status: res.status };
    return { ok: true, kind: "ok" };
  } catch {
    return { ok: false, kind: "network", retry: true, pause: null, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

function headerMap(res) {
  const out = {};
  if (!res.headers) return out;
  if (typeof res.headers.forEach === "function") {
    res.headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  return { ...res.headers };
}

const TRANSPORT_KEYS = [
  "eventId",
  "sessionId",
  "type",
  "stepId",
  "prescribed",
  "actual",
  "createdAt",
  "revisesEventId",
  "schemaVersion",
  "sessionTitle",
  "catalogId",
  "planId",
  "sessionType",
  "planDemo",
  "completedAt",
  "outcome",
  "setEventIds",
  "skippedStepIds",
  "endedEarly",
  "endReason",
  "unperformedStepIds",
  "mode",
  "omittedExercises",
];

/** Immutable body. Local retry fields never travel or affect equality. */
export function transportPayload(event) {
  const payload = {};
  for (const key of TRANSPORT_KEYS) {
    if (event && Object.prototype.hasOwnProperty.call(event, key)) payload[key] = event[key];
  }
  return payload;
}

export function contentPath(event) {
  const clean = transportPayload(event);
  if (clean.type === "session_completed") {
    if (!isUuid(clean.sessionId)) {
      const error = new Error("bad-path");
      error.code = "PATH";
      throw error;
    }
    return `sessions/${clean.sessionId}/completed.json`;
  }
  return eventPath(clean.sessionId, clean.eventId);
}

export async function putEvent(fetchImpl, { target, token, event, timeoutMs = 12_000 }) {
  const clean = transportPayload(event);
  const path = contentPath(clean);
  const url = contentsUrl(target, path);
  if (!url.startsWith(`${API_ORIGIN}/`) || url.includes("access_token") || url.includes(token)) {
    throw new Error("unsafe-url");
  }
  const payload = JSON.stringify(clean);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({
        message: clean.type === "session_completed" ? COMPLETE_MESSAGE : COMMIT_MESSAGE,
        content: utf8ToBase64(payload),
        branch: target.branch,
      }),
      signal: controller.signal,
    });
    const body = await readJson(res);
    const classified = classifyStatus(res.status, headerMap(res), body);
    return { ...classified, status: res.status, url };
  } catch {
    return { kind: "network", retry: true, reconcile: true, status: 0, url };
  } finally {
    clearTimeout(timer);
  }
}

export async function getContentJson(fetchImpl, { target, token, path, timeoutMs = 12_000 }) {
  const url = `${contentsUrl(target, path)}?ref=${encodeURIComponent(target.branch)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "GET", headers: authHeaders(token), signal: controller.signal });
    const body = await readJson(res);
    const classified = classifyStatus(res.status, headerMap(res), body);
    if (classified.kind !== "ok") return { ...classified, status: res.status, url };
    if (typeof body.content !== "string") return { kind: "client", status: res.status, url };
    const json = JSON.parse(base64ToUtf8(body.content));
    return { kind: "ok", status: res.status, json, sha: body.sha || null, url };
  } catch {
    return { kind: "network", retry: true, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

export async function reconcileEvent(fetchImpl, { target, token, event }) {
  const got = await getContentJson(fetchImpl, { target, token, path: contentPath(event) });
  if (got.kind === "ok" && eventsEqual(got.json, transportPayload(event))) return { ack: true };
  if (got.status === 404) return { ack: false, missing: true };
  return { ack: false, kind: got.kind || "mismatch" };
}

const RECONCILE_PUTS = 3;

/**
 * Upload one event. Caller-supplied privateOk is ignored.
 * A batch may pass verifiedPrivate only after verifyPrivate returned ok.
 * A 409 whose file is missing is retried a bounded number of times.
 */
export async function uploadEvent(fetchImpl, { target, token, event, verifiedPrivate = false }) {
  if (verifiedPrivate !== true) {
    const privacy = await verifyPrivate(fetchImpl, target, token);
    if (!privacy.ok) return { ack: false, ...privacy, wrote: false };
  }
  for (let attempt = 1; attempt <= RECONCILE_PUTS; attempt += 1) {
    const put = await putEvent(fetchImpl, { target, token, event });
    if (put.kind === "ok") return { ack: true, wrote: true, kind: "ok" };
    if (put.reconcile || put.kind === "conflict" || put.kind === "network") {
      const recon = await reconcileEvent(fetchImpl, { target, token, event });
      if (recon.ack) return { ack: true, wrote: true, kind: "reconciled" };
      if (recon.missing && put.kind === "conflict" && attempt < RECONCILE_PUTS) continue;
    }
    return { ack: false, wrote: put.kind !== "public_repo", ...put, reconcileAttempts: attempt };
  }
  return { ack: false, wrote: true, kind: "conflict", kept: true };
}

export function safeSyncError(result) {
  return { kind: result.kind || "unknown", status: result.status || 0, pause: result.pause || null };
}

/** Swedish, status-aware fetch-plan errors. Never includes tokens or URLs. */
export function formatPlanFetchError(result = {}) {
  const status = Number(result.status) || 0;
  const kind = result.kind || "fel";
  if (kind === "network" || status === 0) {
    return "Nätverksfel: kunde inte nå GitHub. Kontrollera anslutningen och försök igen.";
  }
  if (kind === "auth" || status === 401) {
    return `GitHub svarade ${status || 401}: ogiltig eller saknad nyckel. Skapa en ny token och klistra in den igen.`;
  }
  if (kind === "permission") {
    return `GitHub svarade ${status || 403}: nyckeln saknar behörighet till arkivet. Contents behöver Read and write.`;
  }
  if (kind === "rate_limit") {
    return `GitHub svarade ${status || 429}: rate limit. Vänta och försök igen.`;
  }
  if (kind === "server") {
    return `GitHub svarade ${status}: tillfälligt serverfel. Försök igen om en stund.`;
  }
  if (status === 404 || kind === "client") {
    const code = status || 404;
    return `GitHub svarade ${code}: arkivet hittades inte eller nyckeln saknar åtkomst. Kontrollera Owner/Repo.`;
  }
  return `Planen hämtades inte (HTTP ${status || "okänd"}, ${kind}).`;
}

/** Green confirmation after a successful plan fetch. */
export function formatPlanFetchOk(plan, when = new Date()) {
  const title = typeof plan?.title === "string" && plan.title.trim() ? plan.title.trim() : "utan titel";
  const n = Array.isArray(plan?.sessions) ? plan.sessions.length : 0;
  const time =
    when instanceof Date
      ? when.toLocaleString("sv-SE")
      : new Date(when).toLocaleString("sv-SE");
  return `Planen hämtad: ${title}, ${n} pass, ${time}`;
}
