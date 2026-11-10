import { demoPlan } from "./lib/demo-plan.mjs";
import { loadModeLabel, sideLabel } from "./lib/equipment.mjs";
import { buildBackup } from "./lib/export.mjs";
import { advancedAfterRest, buildActual, completionEvent, newId, sessionCompletedEvent, skippedSession } from "./lib/engine.mjs";
import { formatPlanFetchError, formatPlanFetchOk, getContentJson, planPath, validateTarget } from "./lib/github.mjs";
import { elapsedSeconds, formatClock, startRest, tickRest } from "./lib/rest.mjs";
import { decodePlanFragment, validatePlan } from "./lib/schema.mjs";
import {
  PRIORITY_LABELS,
  endSessionEarly,
  estimatedMinutes,
  prepareSessionSnapshot,
  selectSessionSteps,
  sessionEstimates,
} from "./lib/session-plan.mjs";
import { applySyncResults, flushOutbox, mergeSyncedState, prepareManualRetry, readyToUpload } from "./lib/sync.mjs";

const DB_NAME = "atlas-training-guided";
const app = document.querySelector("#app");

const state = {
  plan: null,
  planMeta: null,
  sessions: [],
  events: [],
  outbox: [],
  active: null,
  token: "",
  tokenSaved: false,
  target: { owner: "", repo: "", branch: "main" },
  view: "home",
  previousView: "home",
  preview: null,
  pause: null,
  persistError: "",
  formError: "",
  settingsError: "",
  settingsOk: "",
  saving: false,
  audio: null,
  wake: null,
  wakeNote: "",
  fragmentNote: "",
  syncing: false,
};

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, "");
    else if (value !== false && value != null) node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function text(tag, value, attrs = {}) {
  return el(tag, attrs, [value]);
}

function kgText(value) {
  if (value == null) return "okänd";
  return String(value).replace(".", ",");
}

function weightLine(step) {
  if (!step.load) return "Ingen yttre vikt";
  return `${kgText(step.load.value)} kg, ${loadModeLabel(step.load.mode)}, ${sideLabel(step.side)}`;
}

function repsLine(step) {
  if (!step.reps) return "Inga reps";
  const { min, max, target } = step.reps;
  return `Reps ${min ?? "–"}–${max ?? "–"}, mål ${target ?? "–"}`;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ["sessions", "events", "outbox", "plans", "settings"]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("idb-open"));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("persist-failed"));
    tx.onerror = () => reject(tx.error || new Error("persist-failed"));
  });
}

async function withDb(storeNames, mode, fn) {
  if (globalThis.__ATLAS_FORCE_PERSIST_FAIL && mode === "readwrite") {
    throw new Error("persist-failed");
  }
  if (globalThis.__ATLAS_FAIL_SYNC_PERSIST && mode === "readwrite" && storeNames.includes("outbox")) {
    throw new Error("persist-failed");
  }
  const db = await openDb();
  const tx = db.transaction(storeNames, mode);
  const stores = Object.fromEntries(storeNames.map((name) => [name, tx.objectStore(name)]));
  await fn(stores);
  await txDone(tx);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadAll() {
  const db = await openDb();
  const tx = db.transaction(["sessions", "events", "outbox", "plans", "settings"], "readonly");
  const [sessions, events, outbox, plans, settings] = await Promise.all([
    reqToPromise(tx.objectStore("sessions").getAll()),
    reqToPromise(tx.objectStore("events").getAll()),
    reqToPromise(tx.objectStore("outbox").getAll()),
    reqToPromise(tx.objectStore("plans").getAll()),
    reqToPromise(tx.objectStore("settings").getAll()),
  ]);
  await txDone(tx);
  state.sessions = sessions || [];
  state.events = events || [];
  state.outbox = outbox || [];
  const cached = (plans || []).find((item) => item.id === "current");
  if (cached?.plan) {
    const checked = validatePlan(cached.plan);
    if (checked.ok) {
      state.plan = checked.plan;
      state.planMeta = { validatedAt: cached.validatedAt, source: cached.source || "cache" };
    }
  }
  const tokenRow = (settings || []).find((item) => item.id === "token");
  const targetRow = (settings || []).find((item) => item.id === "target");
  if (tokenRow?.value) {
    state.token = String(tokenRow.value);
    state.tokenSaved = true;
  }
  if (targetRow?.value) state.target = { ...state.target, ...targetRow.value };
  state.active = state.sessions.find((item) => item.phase === "step" || item.phase === "rest") || null;
  if (!state.plan) {
    const demo = validatePlan(demoPlan());
    state.plan = demo.plan;
    state.planMeta = { validatedAt: null, source: "demo" };
  }
}

async function saveSession(session) {
  await withDb(["sessions"], "readwrite", async (stores) => {
    stores.sessions.put(session);
  });
  state.active = session.phase === "step" || session.phase === "rest" ? session : null;
  if (session.phase === "done") state.focusId = session.id;
  state.sessions = state.sessions.filter((item) => item.id !== session.id).concat(session);
}

async function atomicWrite(session, events) {
  const list = (Array.isArray(events) ? events : [events]).filter(Boolean);
  const records = list.map((event) => ({ ...event, id: event.eventId, status: "pending", attempts: 0, notBefore: 0 }));
  await withDb(["sessions", "events", "outbox"], "readwrite", async (stores) => {
    stores.sessions.put(session);
    for (const record of records) {
      stores.events.put(record);
      stores.outbox.put({ id: record.eventId, eventId: record.eventId, sessionId: record.sessionId });
    }
  });
  const ids = new Set(records.map((record) => record.id));
  state.events = state.events.filter((item) => !ids.has(item.id)).concat(records);
  state.outbox = state.outbox.filter((item) => !ids.has(item.id)).concat(
    records.map((record) => ({ id: record.eventId, eventId: record.eventId, sessionId: record.sessionId }))
  );
  state.sessions = state.sessions.filter((item) => item.id !== session.id).concat(session);
  state.active = session.phase === "step" || session.phase === "rest" ? session : null;
  if (session.phase === "done") state.focusId = session.id;
}

function markerForFinish(session, extraEvents) {
  if (session.phase !== "done") return null;
  if (state.events.some((item) => item.type === "session_completed" && item.sessionId === session.id)) return null;
  const eventId = session.completionMarkerId || newId();
  session.completionMarkerId = eventId;
  const completedAt = session.completedAt || new Date().toISOString();
  session.completedAt = completedAt;
  return sessionCompletedEvent({
    session,
    events: state.events.concat(extraEvents || []),
    nowIso: completedAt,
    eventId,
  });
}

function currentStep(session = state.active) {
  if (!session) return null;
  return session.planSnapshot.steps[session.stepIndex] || null;
}

function statusMessage() {
  const saved = state.events.length;
  const pending = state.outbox.length;
  const acked = state.events.filter((item) => item.status === "acked").length;
  const offline = typeof navigator !== "undefined" && navigator.onLine === false ? "Offline. Kö finns bara på telefonen. " : "";
  let pause = "";
  if (state.pause === "auth") pause = " Pausad: 401 autentisering.";
  if (state.pause === "permission") pause = " Pausad: 403 behörighet, inte hastighetsgräns.";
  if (state.pause === "public") pause = " Inga skrivningar: målet är inte ett privat repo.";
  if (state.pause === "rate") pause = " Väntar efter hastighetsgräns.";
  const note = state.syncNote ? ` ${state.syncNote}` : "";
  return `${offline}Sparat på telefonen: ${saved}. Väntar på server: ${pending}. Bekräftat av servern: ${acked}.${pause}${note}`;
}

function phaseLabel(phase) {
  return { warmup: "Uppvärmning", work: "Arbetsset", cardio: "Intervall", recovery: "Återhämtning", mobility: "Rörlighet" }[phase] || phase;
}

function equipmentLabel(equipment) {
  return { barbell: "Skivstång", dumbbell: "Hantel", lat: "Latsdrag", machine: "Maskin", bodyweight: "Kroppsvikt", other: "Annan" }[equipment] || equipment;
}

function unlockAudio() {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) {
    state.audioNote = "Ljud stöds inte. Håll koll på vilan själv. Passet fortsätter.";
    return;
  }
  try {
    if (!state.audio) state.audio = new AC();
    const pending = state.audio.resume?.();
    if (pending && typeof pending.catch === "function") {
      pending.catch(() => {
        state.audioNote = "Ljud är blockerat. Passet fortsätter. Testa ljud efter en tryckning.";
      });
    }
  } catch {
    state.audioNote = "Ljud kunde inte startas. Passet fortsätter utan pip.";
  }
}

function beep() {
  if (!state.audio) return;
  try {
    const osc = state.audio.createOscillator();
    const gain = state.audio.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, state.audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, state.audio.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, state.audio.currentTime + 0.12);
    osc.connect(gain);
    gain.connect(state.audio.destination);
    osc.start();
    osc.stop(state.audio.currentTime + 0.13);
  } catch {
    state.audioNote = "Pipet kunde inte spelas. Passet fortsätter.";
  }
}

function buzz() {
  if (typeof navigator.vibrate === "function") navigator.vibrate(80);
}

async function requestWake() {
  if (!("wakeLock" in navigator) || typeof navigator.wakeLock?.request !== "function") {
    state.wakeNote = "Skärmlås stöds inte. Håll skärmen tänd manuellt under passet.";
    return;
  }
  try {
    const sentinel = await navigator.wakeLock.request("screen");
    state.wake = sentinel;
    state.wakeNote = "";
    sentinel.addEventListener?.("release", () => {
      if (state.wake !== sentinel) return;
      state.wake = null;
      if (state.active && (state.active.phase === "step" || state.active.phase === "rest")) {
        state.wakeNote = "Skärmlåset släpptes. Håll skärmen tänd manuellt tills passet är slut.";
        const node = document.querySelector("[data-testid=wake-note]");
        if (node) node.textContent = state.wakeNote;
      }
    });
  } catch {
    state.wakeNote = "Skärmlås kunde inte begäras. Håll skärmen tänd manuellt.";
  }
}

async function releaseWake() {
  try {
    await state.wake?.release();
  } catch {
    /* already released */
  }
  state.wake = null;
}

function applyFragment() {
  const hash = location.hash || "";
  if (!hash.startsWith("#plan=")) return;
  const clean = `${location.pathname}${location.search}`;
  history.replaceState(null, "", clean);
  const decoded = decodePlanFragment(hash);
  if (!decoded.ok) {
    state.fragmentNote = "Fragmentet avvisades och togs bort.";
    return;
  }
  const checked = validatePlan(decoded.input);
  if (!checked.ok) {
    state.fragmentNote = "Fragmentet avvisades och togs bort.";
    return;
  }
  if (state.active) {
    state.fragmentNote = "Fragmentet validerades men det pågående passet är fastnålat.";
    return;
  }
  state.plan = checked.plan;
  state.planMeta = { validatedAt: new Date().toISOString(), source: "fragment" };
  state.fragmentNote = "Plan från fragment används. Den är inte en personlig rekommendation om den är märkt DEMO.";
}

async function boot() {
  try {
    await loadAll();
  } catch {
    state.persistError = "Lokal lagring gick inte att läsa. Passet kan inte återupptas säkert.";
  }
  applyFragment();
  if (state.active?.phase === "step" && !state.active.stepStartedAt) {
    state.active.stepStartedAt = Date.now();
  }
  if ("serviceWorker" in navigator) {
    const scopeUrl = new URL("./", import.meta.url);
    navigator.serviceWorker.register(new URL("sw.js", scopeUrl), { scope: scopeUrl.href }).catch(() => {});
  }
  render();
  window.addEventListener("hashchange", () => {
    applyFragment();
    if (!state.active) render();
  });
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && state.active && state.active.phase !== "done" && state.active.phase !== "abandoned") {
      await requestWake();
    }
    if (document.visibilityState === "visible") flush().catch(() => {});
    render();
  });
  window.addEventListener("online", () => {
    flush().catch(() => {});
    render();
  });
  window.addEventListener("offline", () => render());
  schedule();
  flush().catch(() => {});
}

function schedule() {
  const wait = 8000 + Math.floor(Math.random() * 1500);
  setTimeout(async () => {
    if (!document.hidden && state.outbox.length && state.pause !== "auth" && state.pause !== "permission" && state.pause !== "public") {
      await flush().catch(() => {});
    }
    schedule();
  }, wait);
}

function showPersistBanner() {
  let node = document.querySelector("[data-testid=persist-error]");
  if (!node) {
    node = text("p", state.persistError, { class: "warn", "data-testid": "persist-error" });
    app.prepend(node);
    return;
  }
  node.textContent = state.persistError;
}

function headingTitle() {
  if (state.active?.title) return state.active.title;
  if (state.view === "preview" && state.preview?.catalog?.title) return state.preview.catalog.title;
  const done = state.sessions.find((item) => item.id === state.focusId && item.phase === "done");
  if (done?.title) return done.title;
  return "Atlas träning";
}

function render() {
  clearInterval(durationTimer);
  clearInterval(restTimer);
  app.replaceChildren();
  app.append(
    el("header", { class: "top" }, [
      text("h1", headingTitle(), { "data-testid": "title" }),
      el("button", { class: "ghost", type: "button", "data-testid": "nav-settings", onclick: toggleSettings }, [
        state.view === "settings" ? "Stäng" : "Inställningar",
      ]),
    ]),
    text("p", statusMessage(), { class: "status", "data-testid": "sync-status" })
  );
  if (state.persistError) app.append(text("p", state.persistError, { class: "warn", "data-testid": "persist-error" }));
  if (state.view === "settings") return renderSettings();
  if (state.active) return renderSession();
  if (state.view === "preview" && state.preview) return renderPreview();
  if (state.focusId) {
    const done = state.sessions.find((item) => item.id === state.focusId && item.phase === "done");
    if (done) return renderDone(done);
  }
  return renderHome();
}

function toggleSettings() {
  if (state.view === "settings") {
    state.view = state.previousView || "home";
  } else {
    state.previousView = state.view;
    state.view = "settings";
  }
  render();
}

function renderHome() {
  const when = state.planMeta?.validatedAt ? new Date(state.planMeta.validatedAt).toLocaleString("sv-SE") : "inte hämtad";
  app.append(
    el("section", { class: "card" }, [
      text("p", state.plan?.disclaimer || "", { class: "demo-flag", "data-testid": "disclaimer" }),
      text("p", `Källa: ${state.planMeta?.source || "demo"}. Validerad: ${when}.`, { class: "muted", "data-testid": "plan-date" }),
      state.fragmentNote ? text("p", state.fragmentNote, { class: "muted" }) : null,
      text("p", "Låst skärm: ett pip är inte garanterat. Webbläsaren kan tysta ljud när skärmen är låst.", { class: "muted" }),
    ])
  );
  for (const session of state.plan.sessions) {
    app.append(
      el("button", {
        class: "session-btn",
        type: "button",
        "data-testid": `start-${session.id}`,
        onclick: () => openPreview(session),
      }, [text("strong", session.title), text("div", `${session.location} · ${session.steps.length} steg · tryck för att se passet`, { class: "muted" })])
    );
  }
}

let starting = false;
function openPreview(catalog) {
  if (state.active) return;
  state.preview = { catalog, mode: "base" };
  state.view = "preview";
  state.persistError = "";
  render();
}

function closePreview() {
  state.preview = null;
  state.view = "home";
  render();
}

function setPreviewMode(mode) {
  if (!state.preview) return;
  state.preview = { ...state.preview, mode };
  render();
}

function previewMode(value) {
  if (value === "base" || value === "full" || value === "quick") return value;
  return "base";
}

function stepExtraLines(step) {
  const lines = [];
  if (step.supersetGroup) {
    const part = step.supersetOrder ? ` del ${step.supersetOrder}` : "";
    lines.push(text("p", `Superset${part}. Vila enligt steget och byt inte station mitt i varvet.`, { class: "muted", "data-testid": "step-superset" }));
  }
  if (step.alternative) {
    lines.push(text("p", `Alternativ: ${step.alternative}`, { class: "muted", "data-testid": "step-alternative" }));
  }
  return lines;
}

function previewStepLines(step) {
  const rest = step.restSeconds ? `Vila ${step.restSeconds} s` : "Ingen vila";
  const duration = step.durationSeconds != null ? `Tid ${step.durationSeconds} s` : null;
  return el("div", { class: "step-line", "data-testid": `preview-step-${step.id}` }, [
    text("p", `${phaseLabel(step.phase)}: ${weightLine(step)}. ${duration || repsLine(step)}. ${rest}`),
    step.notes ? text("p", step.notes, { class: "muted" }) : null,
    ...stepExtraLines(step),
  ]);
}

function renderPreview() {
  const catalog = state.preview.catalog;
  const mode = previewMode(state.preview.mode);
  const estimates = sessionEstimates(catalog);
  const selected = selectSessionSteps(catalog, mode);
  const groups = selected.groups;
  const list = el("div", { "data-testid": "preview-exercises" });
  if (!groups.length) {
    const empty = mode === "quick"
      ? "Det äldre snabbpasset har inga kärnövningar i den här planen."
      : mode === "base"
        ? "Baspasset har inga steg med prioritet 1 eller 2."
        : "Passet har inga steg.";
    list.append(text("p", empty, { class: "warn", "data-testid": "preview-empty" }));
  }
  for (const group of groups) {
    const badge = text("span", PRIORITY_LABELS[group.priority] || PRIORITY_LABELS[2], { class: `prio prio-${group.priority}` });
    const block = el("div", { class: "exercise-block", "data-testid": `preview-exercise-${group.key}` }, [
      el("h3", {}, [group.title, badge]),
    ]);
    for (const step of group.steps) block.append(previewStepLines(step));
    list.append(block);
  }
  if ((mode === "base" || mode === "quick") && selected.omittedExercises.length) {
    const label = mode === "quick" ? "Hoppas över" : "Bara i fullpass";
    list.append(
      text(
        "p",
        `${label}: ${selected.omittedExercises.join(", ")}.`,
        { class: "muted", "data-testid": "preview-omitted" }
      )
    );
  }
  const canStart = selected.steps.length > 0;
  const startButton = canStart
    ? el("button", { class: "klar", type: "button", "data-testid": "confirm-start", onclick: () => startSession(catalog, { mode }) }, ["Start"])
    : text("p", "Välj ett läge som har steg för att kunna starta.", { class: "warn" });
  const backButton = el("button", { class: "ghost", type: "button", "data-testid": "preview-back", onclick: closePreview }, ["Tillbaka"]);
  const baseLabel = `Baspass (~${estimatedMinutes(estimates.baseSeconds)} min)`;
  const fullLabel = `Fullpass (~${estimatedMinutes(estimates.fullSeconds)} min)`;
  app.append(
    el("section", { class: "card", "data-testid": "preview-view" }, [
      text("p", `${catalog.location} · ${selected.steps.length} steg i valt läge`, { class: "muted", "data-testid": "preview-meta" }),
      text("p", "Inget pass startas förrän du trycker Start.", { class: "muted" }),
      el("div", { class: "mode-toggle", role: "group", "aria-label": "Passläge" }, [
        el("button", {
          type: "button",
          class: "ghost",
          "data-testid": "mode-base",
          "aria-pressed": mode === "base" ? "true" : "false",
          onclick: () => setPreviewMode("base"),
        }, [baseLabel]),
        el("button", {
          type: "button",
          class: "ghost",
          "data-testid": "mode-full",
          "aria-pressed": mode === "full" ? "true" : "false",
          onclick: () => setPreviewMode("full"),
        }, [fullLabel]),
      ]),
      el("div", { class: "stack preview-actions" }, [startButton, backButton]),
      list,
    ])
  );
}

async function startSession(catalog, { mode = "full" } = {}) {
  if (starting || state.active) return;
  const prepared = prepareSessionSnapshot(catalog, mode);
  if (!prepared.catalog.steps.length) {
    state.persistError = "Inga steg att starta i valt läge.";
    render();
    return;
  }
  starting = true;
  unlockAudio();
  try {
  await requestWake();
  const session = {
    id: newId(),
    catalogId: catalog.id,
    title: catalog.title,
    sessionType: catalog.type,
    planId: state.plan.id,
    planDemo: Boolean(state.plan.demo),
    planSnapshot: structuredClone(prepared.catalog),
    stepIndex: 0,
    phase: "step",
    rest: null,
    drafts: {},
    skipped: [],
    stepStartedAt: Date.now(),
    revisions: {},
    mode: prepared.mode,
    omittedExercises: prepared.omittedExercises,
  };
  try {
    await saveSession(session);
    state.persistError = "";
    state.preview = null;
    state.view = "home";
  } catch {
    state.persistError = "Kunde inte spara passet lokalt. Inget startades.";
    state.active = null;
  }
  } finally {
    starting = false;
  }
  render();
}

function renderSession() {
  const session = state.active;
  if (session.phase === "rest") return renderRest();
  const step = currentStep(session);
  if (!step) return renderDone();
  const prescribed = el("div", { "data-testid": "prescribed" }, [
    text("p", `Fas: ${phaseLabel(step.phase)}`),
    text("p", `Plats: ${step.location}`),
    text("p", `Utrustning: ${equipmentLabel(step.equipment)}`),
    text("p", weightLine(step)),
    text("p", repsLine(step)),
    text("p", `RIR: ${step.rir == null ? "valfritt" : step.rir}`),
    step.durationSeconds != null ? text("p", `Tid: ${step.durationSeconds} s`, { "data-testid": "duration-prescribed" }) : null,
    step.notes ? text("p", step.notes, { class: "muted" }) : null,
    ...stepExtraLines(step),
  ]);
  const card = el("section", { class: "card", "data-testid": "step-view" }, [
    text("p", `${session.stepIndex + 1} / ${session.planSnapshot.steps.length}`, { class: "muted" }),
    text("h2", step.exercise, { "data-testid": "exercise" }),
    prescribed,
  ]);
  if (step.durationSeconds != null) {
    card.append(text("p", liveDurationText(session, step), { class: "clock", "data-testid": "duration-clock" }));
    card.append(text("p", "Nedräkningen går inte vidare själv. Tryck Klar när du är färdig.", { class: "muted" }));
  }
  card.append(
    el("div", { class: "stack" }, [
      el("button", { class: "klar", type: "button", "data-testid": "klar", onclick: () => openDialog() }, ["Klar"]),
      el("button", { class: "ghost", type: "button", "data-testid": "skip", onclick: skipStep }, ["Hoppa över utan att markera klar"]),
      el("button", { class: "ghost", type: "button", "data-testid": "abandon", onclick: abandon }, ["Avbryt pass"]),
      el("button", { class: "ghost end-early", type: "button", "data-testid": "end-early", onclick: openEndEarlyDialog }, ["Avsluta passet nu (tidsnöd)"]),
    ])
  );
  card.append(text("p", state.wakeNote || "Om skärmlåset saknas: håll skärmen tänd manuellt.", { class: state.wakeNote ? "warn" : "muted", "data-testid": "wake-note" }));
  if (state.audioNote) card.append(text("p", state.audioNote, { class: "warn", "data-testid": "audio-note" }));
  card.append(text("p", "Låst skärm: ett pip efter vilan är inte garanterat.", { class: "muted" }));
  app.append(card);
  if (step.durationSeconds != null) armDuration();
}

let durationTimer = 0;
function armDuration() {
  clearInterval(durationTimer);
  durationTimer = setInterval(() => {
    const node = document.querySelector("[data-testid=duration-clock]");
    const step = currentStep();
    if (!node || !step || !state.active) return;
    node.textContent = liveDurationText(state.active, step);
  }, 250);
}

function liveDurationText(session, step) {
  const elapsed = elapsedSeconds(session.stepStartedAt, Date.now());
  const left = step.durationSeconds - elapsed;
  if (left >= 0) return formatClock(left * 1000);
  return `Över tid ${formatClock(-left * 1000)}`;
}

function prefill(step) {
  const revision = state.revisionOf?.step?.id === step.id ? state.revisionOf.event.actual : null;
  if (revision) {
    return {
      weight: revision.weightKg == null ? "" : kgText(revision.weightKg),
      reps: revision.reps == null ? "" : String(revision.reps),
      rir: revision.rir == null ? "" : String(revision.rir),
    };
  }
  const draft = state.active.drafts?.[step.id] || {};
  const weight = draft.weight != null ? draft.weight : step.load?.value == null ? "" : kgText(step.load.value);
  const reps = draft.reps != null ? draft.reps : step.reps?.target == null ? "" : String(step.reps.target);
  const rir = draft.rir != null ? draft.rir : step.rir == null ? "" : String(step.rir);
  return { weight, reps, rir };
}

function openDialog(forcedStep = null, forcedSession = null) {
  const step = forcedStep || currentStep();
  if (forcedSession) state.active = forcedSession;
  if (!step || state.saving) return;
  state.formError = "";
  const values = prefill(step);
  const dialog = el("dialog", { "data-testid": "klar-dialog" });
  const weight = el("input", { id: "actual-weight", "data-testid": "actual-weight", type: "text", inputmode: "decimal", value: values.weight, autocomplete: "off" });
  const reps = el("input", { id: "actual-reps", "data-testid": "actual-reps", type: "text", inputmode: "numeric", value: values.reps, autocomplete: "off" });
  const rir = el("input", { id: "actual-rir", "data-testid": "actual-rir", type: "text", inputmode: "numeric", value: values.rir, autocomplete: "off" });
  const error = text("p", "", { class: "warn", "data-testid": "form-error" });
  const elapsed = elapsedSeconds(state.active.stepStartedAt, Date.now());
  dialog.append(
    text("h2", "Utfört"),
    text("p", "Föreskrivet och utfört hålls isär. Okänd vikt är tom, inte noll. Komma fungerar som decimal.", { class: "muted" }),
    text("p", `Föreskrivet: ${weightLine(step)}. ${repsLine(step)}.`),
    step.load ? el("label", {}, ["Utförd vikt (kg)", weight]) : text("p", "Ingen vikt på det här steget."),
    step.reps ? el("label", {}, ["Utförda reps", reps]) : null,
    el("label", {}, ["Utförd RIR (tom = ingen)", rir]),
    text("p", `Förfluten tid: ${elapsed} s`, { "data-testid": "elapsed" }),
    error,
    el("button", { class: "confirm", type: "button", "data-testid": "confirm", onclick: () => confirmDialog(dialog, { weight, reps, rir }) }, ["Klar – spara dessa värden"]),
    el("button", { class: "ghost", type: "button", onclick: () => dialog.close() }, ["Stäng utan att spara"])
  );
  document.body.append(dialog);
  dialog.showModal();
  const persistDraft = () => {
    if (state.revisionOf) return;
    state.active.drafts = {
      ...state.active.drafts,
      [step.id]: { weight: weight.value, reps: reps.value, rir: rir.value },
    };
    saveSession(state.active).catch(() => {
      state.persistError = "Utkastet kunde inte sparas.";
      render();
    });
  };
  weight.addEventListener("input", persistDraft);
  reps.addEventListener("input", persistDraft);
  rir.addEventListener("input", persistDraft);
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (!state.revisionOf) return;
    state.revisionOf = null;
    state.saving = false;
    if (state.active && state.active.phase !== "step" && state.active.phase !== "rest") {
      state.focusId = state.active.id;
      state.active = null;
    }
    render();
  });
}

async function confirmDialog(dialog, fields) {
  if (state.saving) return;
  state.saving = true;
  const button = dialog.querySelector("[data-testid=confirm]");
  button.disabled = true;
  const revising = Boolean(state.revisionOf);
  const step = revising ? state.revisionOf.step : currentStep();
  const elapsed = revising ? state.revisionOf.event.actual?.elapsedSeconds || 0 : elapsedSeconds(state.active.stepStartedAt, Date.now());
  const built = buildActual(step, {
    weight: fields.weight.value,
    reps: fields.reps.value,
    rir: fields.rir.value,
    elapsedSeconds: elapsed,
  });
  if (!built.ok) {
    dialog.querySelector("[data-testid=form-error]").textContent = built.errors.join(" ");
    state.saving = false;
    button.disabled = false;
    return;
  }
  const revises = revising ? state.revisionOf.event.eventId : null;
  const event = completionEvent({
    sessionId: state.active.id,
    step,
    actual: built.actual,
    nowIso: new Date().toISOString(),
    revisesEventId: revises,
    meta: {
      sessionTitle: state.active.title,
      catalogId: state.active.catalogId,
      planId: state.active.planId,
      sessionType: state.active.sessionType,
      planDemo: state.active.planDemo,
    },
  });
  const next = state.active.stepIndex + 1;
  const hasNext = next < state.active.planSnapshot.steps.length;
  const useRest = !revising && hasNext && (step.restSeconds || 0) > 0;
  const drafts = { ...state.active.drafts };
  delete drafts[step.id];
  const session = revising
    ? { ...state.active, revisions: { ...state.active.revisions, [step.id]: event.eventId } }
    : {
        ...state.active,
        drafts,
        phase: useRest ? "rest" : hasNext ? "step" : "done",
        stepIndex: useRest ? state.active.stepIndex : hasNext ? next : state.active.stepIndex,
        rest: useRest ? startRest(Date.now(), step.restSeconds) : null,
        stepStartedAt: useRest ? state.active.stepStartedAt : Date.now(),
        revisions: { ...state.active.revisions, [step.id]: event.eventId },
      };
  const bundle = [event];
  if (!revising && session.phase === "done") {
    const marker = markerForFinish(session, [event]);
    if (marker) bundle.push(marker);
  }
  try {
    await atomicWrite(session, bundle);
    state.persistError = "";
    state.saving = false;
    state.revisionOf = null;
    if (session.phase === "done") await releaseWake();
    dialog.close();
    render();
    flush().catch(() => {});
  } catch {
    state.saving = false;
    button.disabled = false;
    state.persistError = "Sparningen misslyckades. Steget är kvar och inget räknades som klart.";
    dialog.querySelector("[data-testid=form-error]").textContent = state.persistError;
  }
}

async function skipStep() {
  if (state.saving) return;
  state.saving = true;
  const next = skippedSession(state.active, Date.now());
  try {
    if (next.phase === "done") {
      const marker = markerForFinish(next, []);
      await atomicWrite(next, marker ? [marker] : []);
      await releaseWake();
    } else {
      await saveSession(next);
    }
    state.persistError = "";
  } catch {
    state.persistError = "Kunde inte spara överhoppningen. Steget är oförändrat.";
  } finally {
    state.saving = false;
  }
  render();
}

async function abandon() {
  const next = { ...state.active, phase: "abandoned" };
  try {
    await saveSession(next);
    await releaseWake();
    state.active = null;
    state.persistError = "";
  } catch {
    state.persistError = "Kunde inte spara avbrottet. Passet är kvar.";
  }
  render();
}

function openEndEarlyDialog() {
  if (!state.active || state.saving) return;
  const dialog = el("dialog", { "data-testid": "end-early-dialog" });
  dialog.append(
    text("h2", "Avsluta passet nu?"),
    text("p", "Det räknas som tidsnöd. Utförda set sparas och resten markeras som inte utförda.", { class: "muted" }),
    el("button", { class: "end-early", type: "button", "data-testid": "confirm-end-early", onclick: () => confirmEndEarly(dialog) }, ["Avsluta nu"]),
    el("button", { class: "ghost", type: "button", "data-testid": "cancel-end-early", onclick: () => dialog.close() }, ["Fortsätt passet"])
  );
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
}

async function confirmEndEarly(dialog) {
  if (!state.active || state.saving) return;
  state.saving = true;
  const button = dialog.querySelector("[data-testid=confirm-end-early]");
  if (button) button.disabled = true;
  const next = endSessionEarly(state.active, new Date().toISOString());
  const marker = markerForFinish(next, []);
  try {
    await atomicWrite(next, marker ? [marker] : []);
    await releaseWake();
    state.persistError = "";
    state.saving = false;
    dialog.close();
    render();
    flush().catch(() => {});
  } catch {
    state.saving = false;
    if (button) button.disabled = false;
    state.persistError = "Kunde inte avsluta passet. Det är kvar.";
    render();
  }
}

let restTimer = 0;
function renderRest() {
  clearInterval(restTimer);
  const session = state.active;
  const nextStep = session.planSnapshot.steps[session.stepIndex + 1];
  const clock = text("p", "", { class: "clock", "data-testid": "rest-clock" });
  const card = el("section", { class: "card", "data-testid": "rest-view" }, [
    text("h2", "Vila"),
    text("p", "Bara nästa steg visas.", { class: "muted" }),
    text("h3", nextStep.exercise, { "data-testid": "next-exercise" }),
    text("p", `Fas: ${phaseLabel(nextStep.phase)}. Plats: ${nextStep.location}. Utrustning: ${equipmentLabel(nextStep.equipment)}.`),
    text("p", weightLine(nextStep)),
    text("p", repsLine(nextStep)),
    text("p", `RIR: ${nextStep.rir == null ? "valfritt" : nextStep.rir}`),
    nextStep.durationSeconds != null ? text("p", `Tid: ${nextStep.durationSeconds} s`) : null,
    nextStep.alternative ? text("p", `Alternativ: ${nextStep.alternative}`, { class: "muted", "data-testid": "step-alternative" }) : null,
    clock,
    text("p", "Låst skärm: pipet är inte garanterat.", { class: "muted" }),
    el("button", { class: "ghost end-early", type: "button", "data-testid": "end-early", onclick: openEndEarlyDialog }, ["Avsluta passet nu (tidsnöd)"]),
  ]);
  app.append(card);
  let restBusy = false;
  const paint = async () => {
    if (restBusy || !state.active || state.active.phase !== "rest") return;
    restBusy = true;
    try {
    if (!state.active || state.active.phase !== "rest") return;
    const before = state.active.rest;
    const decision = tickRest(before, Date.now(), { visible: document.visibilityState === "visible" });
    clock.textContent = formatClock(decision.displayMs);
    const changed = decision.state.deadline !== before.deadline || decision.state.signaled !== before.signaled;
    if (changed && !decision.advance) {
      const candidate = { ...state.active, rest: decision.state };
      try {
        await saveSession(candidate);
        if (decision.beep) {
          beep();
          buzz();
        }
      } catch {
        state.persistError = "Kunde inte spara vilan. Timern stannar tills lagringen fungerar.";
        showPersistBanner();
        return;
      }
    }
    if (decision.advance) {
      const candidate = advancedAfterRest(state.active, decision.state, Date.now());
      try {
        await saveSession(candidate);
        if (decision.beep) {
          beep();
          buzz();
        }
        clearInterval(restTimer);
      } catch {
        state.persistError = "Kunde inte gå vidare efter vilan. Steget är oförändrat.";
        showPersistBanner();
        return;
      }
      render();
    }
    } finally {
      restBusy = false;
    }
  };
  paint();
  restTimer = setInterval(paint, 200);
}

function renderDone(session) {
  const events = state.events.filter((item) => item.sessionId === session?.id && (item.type === "completion" || item.type === "revision"));
  const list = el("ul", { "data-testid": "done-list" });
  for (const event of events) {
    const item = el("li", {
      "data-testid": "event-row",
      "data-type": event.type,
      "data-step": event.stepId,
      "data-event": event.eventId,
      "data-revises": event.revisesEventId || "",
    }, [
      `${event.prescribed.exercise}: utfört ${event.actual.weightKg ?? "–"} kg / ${event.actual.reps ?? "–"} reps. Föreskrivet vikt ${event.prescribed.load?.value ?? "okänd"}.`,
    ]);
    const button = el("button", { class: "ghost", type: "button", "data-testid": `revise-${event.eventId}`, onclick: () => openRevision(event) }, ["Korrigera"]);
    item.append(button);
    list.append(item);
  }
  app.append(
    el("section", { class: "card", "data-testid": "done-view" }, [
      text("h2", "Passet är klart"),
      text("p", session?.title || ""),
      text("p", "Korrektioner sparas som nya händelser. Gamla rader ändras inte.", { class: "muted" }),
      list,
      el("button", { class: "klar", type: "button", "data-testid": "back-home", onclick: async () => { await releaseWake(); state.active = null; state.focusId = null; render(); } }, ["Tillbaka"]),
    ])
  );
}

function openRevision(previous) {
  const session = state.sessions.find((item) => item.id === previous.sessionId);
  const step = session?.planSnapshot?.steps?.find((item) => item.id === previous.stepId);
  if (!step || !session) return;
  state.revisionOf = {
    event: previous,
    step,
    stepIndex: session.stepIndex,
    phase: session.phase,
    stepStartedAt: session.stepStartedAt,
  };
  state.active = session;
  openDialog(step, session);
}

function renderSettings() {
  const owner = el("input", { "data-testid": "owner", type: "text", value: state.target.owner, autocomplete: "off" });
  const repo = el("input", { "data-testid": "repo", type: "text", value: state.target.repo, autocomplete: "off" });
  const branch = el("input", { "data-testid": "branch", type: "text", value: state.target.branch, autocomplete: "off" });
  const token = el("input", { "data-testid": "token", type: "password", value: "", autocomplete: "off", placeholder: state.token ? "Token finns, visas inte" : "Klistra in token" });
  const persist = el("input", { "data-testid": "persist-token", type: "checkbox" });
  persist.checked = state.tokenSaved;
  app.append(
    el("section", { class: "card stack", "data-testid": "settings" }, [
      text("h2", "Privat datarepo"),
      text("p", "Token skrivs bara här, av dig. Den läggs aldrig i adressen, exporten eller cachen. Standard är minnet. Att spara den lokalt ökar risken vid XSS.", { class: "muted" }),
      el("label", {}, ["Owner", owner]),
      el("label", {}, ["Repo", repo]),
      el("label", {}, ["Branch", branch]),
      el("label", {}, ["Token", token]),
      el("label", {}, [persist, "Spara token i den här webbläsaren (avstängt som standard)"]),
      state.settingsError ? text("p", state.settingsError, { class: "warn", "data-testid": "settings-error" }) : null,
      state.settingsOk ? text("p", state.settingsOk, { class: "ok", "data-testid": "settings-ok" }) : null,
      text("p", state.token ? (state.tokenSaved ? "Token sparad lokalt." : "Token finns bara i minnet.") : "Ingen token.", { "data-testid": "token-state" }),
      el("button", { class: "ghost", type: "button", "data-testid": "save-settings", onclick: () => saveSettings({ owner, repo, branch, token, persist }) }, ["Spara inställningar"]),
      el("button", { class: "ghost", type: "button", "data-testid": "forget-token", onclick: forgetToken }, ["Glöm token"]),
      el("button", { class: "ghost", type: "button", "data-testid": "fetch-plan", onclick: fetchPlan }, ["Hämta plan"]),
      el("button", { class: "ghost", type: "button", "data-testid": "sync-now", onclick: () => flush({ manual: true }) }, ["Synka kö"]),
      el("button", { class: "ghost", type: "button", "data-testid": "export", onclick: exportBackup }, ["Exportera JSON"]),
      el("button", { class: "ghost", type: "button", "data-testid": "sound", onclick: () => { unlockAudio(); beep(); } }, ["Testa ljud"]),
    ])
  );
}

async function saveSettings(fields) {
  const checked = validateTarget({ owner: fields.owner.value, repo: fields.repo.value, branch: fields.branch.value });
  if (!checked.ok) {
    state.settingsError = checked.error;
    state.settingsOk = "";
    render();
    return;
  }
  state.target = checked.target;
  if (fields.token.value.trim()) state.token = fields.token.value.trim();
  state.tokenSaved = fields.persist.checked && Boolean(state.token);
  try {
    await withDb(["settings"], "readwrite", async (stores) => {
      stores.settings.put({ id: "target", value: state.target });
      if (state.tokenSaved) stores.settings.put({ id: "token", value: state.token });
      else stores.settings.delete("token");
    });
    state.settingsError = "";
    state.settingsOk = "";
    state.pause = null;
  } catch {
    state.settingsError = "Inställningarna kunde inte sparas lokalt.";
    state.settingsOk = "";
  }
  render();
}

async function forgetToken() {
  state.token = "";
  state.tokenSaved = false;
  try {
    await withDb(["settings"], "readwrite", async (stores) => {
      stores.settings.delete("token");
    });
  } catch {
    state.settingsError = "Token kunde inte tas bort lokalt.";
  }
  render();
}

async function fetchPlan() {
  const checked = validateTarget(state.target);
  if (!checked.ok || !state.token) {
    state.settingsError = "Ange mål och token innan hämtning.";
    state.settingsOk = "";
    render();
    return;
  }
  const got = await getContentJson(fetch, { target: checked.target, token: state.token, path: planPath() });
  if (got.kind !== "ok") {
    state.settingsError = formatPlanFetchError(got);
    state.settingsOk = "";
    render();
    return;
  }
  const valid = validatePlan(got.json);
  if (!valid.ok) {
    state.settingsError = "Planen underkändes av schemat och användes inte.";
    state.settingsOk = "";
    render();
    return;
  }
  const row = { id: "current", plan: valid.plan, validatedAt: new Date().toISOString(), source: "github" };
  try {
    await withDb(["plans"], "readwrite", async (stores) => stores.plans.put(row));
  } catch {
    state.persistError = "Planen validerades men kunde inte cachas.";
  }
  state.planMeta = { validatedAt: row.validatedAt, source: "github" };
  if (!state.active) state.plan = valid.plan;
  else state.fragmentNote = "Ny plan cachad. Pågående pass är oförändrat.";
  state.settingsError = "";
  state.settingsOk = formatPlanFetchOk(valid.plan, new Date(row.validatedAt));
  render();
}

async function flush({ manual = false } = {}) {
  if (!state.token || !validateTarget(state.target).ok || state.outbox.length === 0) return;
  if (state.syncing) return;
  state.syncing = true;
  const now = Date.now();
  let events = state.events.map((event) => ({ ...event }));
  let outbox = state.outbox.map((item) => ({ ...item }));
  if (manual) events = prepareManualRetry(events, outbox);
  const pendingEvents = readyToUpload(events, outbox, now);
  try {
    const flushed = pendingEvents.length
      ? await flushOutbox({
          fetchImpl: fetch,
          target: validateTarget(state.target).target,
          token: state.token,
          events: pendingEvents,
          manual,
        })
      : { results: [], pause: state.pause === "rate" ? "rate_limit" : state.pause };
    const applied = applySyncResults(events, outbox, flushed.results || [], Date.now());
    const ackedIds = (flushed.results || []).filter((result) => result.ack).map((result) => result.eventId);
    await withDb(["events", "outbox"], "readwrite", async (stores) => {
      for (const event of applied.events) stores.events.put(event);
      // Never delete an event enqueued after this network batch began.
      for (const id of ackedIds) stores.outbox.delete(id);
    });
    const merged = mergeSyncedState(state.events, state.outbox, applied.events, ackedIds);
    state.events = merged.events;
    state.outbox = merged.outbox;
    state.pause = flushed.pause === "rate_limit" ? "rate" : flushed.pause || null;
    state.syncNote = manual ? "Manuell synk nollställde försöksgränsen. Serverns väntetid gäller fortfarande." : "";
    state.persistError = "";
  } catch {
    state.persistError = "Köstatus kunde inte sparas efter synkförsök. Händelserna ligger kvar.";
    showPersistBanner();
  } finally {
    state.syncing = false;
    const node = document.querySelector("[data-testid=sync-status]");
    if (node) node.textContent = statusMessage();
  }
}

function exportBackup() {
  const payload = buildBackup({ plan: state.plan, sessions: state.sessions, events: state.events });
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: "atlas-traning-backup.json" });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

boot().catch(() => {
  app.textContent = "Appen kunde inte starta.";
});
