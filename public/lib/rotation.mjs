/**
 * Next-pass suggestion. Rotation order is the order of plan.sessions (cyclic),
 * e.g. S3 → K → S1 → S2 → S3. Only finished sessions (a completed marker) with at
 * least one saved set move the rotation; an empty or abandoned start does not.
 */

const SESSION_ID_RE = /^sessions\/([0-9a-f-]{36})\/completed\.json$/i;

function countsForRotation(entry) {
  return Boolean(entry && entry.catalogId && entry.completedAt && entry.setCount > 0);
}

/** History entries from this phone's IndexedDB rows. */
export function localHistory(sessions = [], events = []) {
  const out = [];
  for (const session of sessions) {
    if (!session || session.phase !== "done") continue;
    const marker = events.find((item) => item.type === "session_completed" && item.sessionId === session.id);
    const setCount = events.filter(
      (item) => item.sessionId === session.id && (item.type === "completion" || item.type === "revision")
    ).length;
    out.push({
      sessionId: session.id,
      catalogId: session.catalogId || marker?.catalogId || "",
      title: session.title || marker?.sessionTitle || "",
      completedAt: marker?.completedAt || session.completedAt || "",
      setCount,
      planDemo: Boolean(session.planDemo),
      source: "local",
    });
  }
  return out;
}

/** History entry from a sessions/<id>/completed.json marker. */
export function markerToHistory(marker) {
  if (!marker || (marker.type !== "session_completed" && typeof marker.setCount !== "number")) return null;
  return {
    sessionId: String(marker.sessionId || ""),
    catalogId: String(marker.catalogId || ""),
    title: String(marker.sessionTitle || ""),
    completedAt: String(marker.completedAt || ""),
    setCount: Array.isArray(marker.setEventIds) ? marker.setEventIds.length : Number(marker.setCount) || 0,
    planDemo: Boolean(marker.planDemo),
    source: "github",
  };
}

/** Merge local and remote history, one entry per sessionId, newest first. */
export function mergeHistory(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const entry of list || []) {
      if (!entry?.sessionId) continue;
      const prev = byId.get(entry.sessionId);
      if (!prev || (entry.setCount || 0) > (prev.setCount || 0)) byId.set(entry.sessionId, entry);
    }
  }
  return [...byId.values()].sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
}

/** Session ids that have a completed.json in a recursive git tree listing. */
export function completedPathsFromTree(tree) {
  const ids = [];
  for (const item of tree?.tree || []) {
    if (item?.type !== "blob") continue;
    const match = SESSION_ID_RE.exec(String(item.path || ""));
    if (match) ids.push(match[1].toLowerCase());
  }
  return ids;
}

/**
 * Suggest the next pass.
 * Returns { ok: true, catalog, last, reason } or { ok: false, reason, message, fallback }.
 */
export function suggestNext(plan, history, { demo = false } = {}) {
  const sessions = plan?.sessions || [];
  if (!sessions.length) return { ok: false, reason: "no_plan", message: "Ingen plan med pass är laddad." };
  const relevant = (history || []).filter((entry) => countsForRotation(entry) && Boolean(entry.planDemo) === Boolean(demo));
  const sorted = [...relevant].sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
  if (!sorted.length) {
    return {
      ok: false,
      reason: "no_history",
      message: "Kan inte räkna ut nästa pass: inget avslutat pass hittades.",
      fallback: sessions[0],
    };
  }
  const ids = sessions.map((item) => String(item.id).toUpperCase());
  for (const entry of sorted) {
    const index = ids.indexOf(String(entry.catalogId).toUpperCase());
    if (index >= 0) {
      return { ok: true, catalog: sessions[(index + 1) % sessions.length], last: entry, reason: "rotation" };
    }
  }
  return {
    ok: false,
    reason: "unknown_last",
    message: `Kan inte räkna ut nästa pass: senaste passet (${sorted[0].catalogId || "okänt"}) finns inte i nuvarande plan.`,
    fallback: sessions[0],
    last: sorted[0],
  };
}

/** Plan sessions with the suggested one first; the rest keep plan order. */
export function orderedSessions(plan, suggestion) {
  const sessions = [...(plan?.sessions || [])];
  if (!suggestion?.ok) return sessions;
  const id = suggestion.catalog.id;
  return [suggestion.catalog, ...sessions.filter((item) => item.id !== id)];
}

export function shortDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "okänt datum";
  return date.toLocaleDateString("sv-SE", { day: "numeric", month: "short", timeZone: "Europe/Stockholm" }).replace(/\.$/, "");
}
