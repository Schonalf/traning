import { demoPlan } from "./lib/demo-plan.mjs";
import { loadModeLabel, sideLabel } from "./lib/equipment.mjs";
import { buildBackup } from "./lib/export.mjs";
import { COUNTDOWN_MS, advancedAfterRest, buildActual, completionEvent, countdownLeft, newId, sessionCompletedEvent, skippedSession, stepStartTime, timerKind, workSecondsLeft } from "./lib/engine.mjs";
import { fetchCompletedMarkers, formatPlanFetchError, formatPlanFetchOk, getContentJson, planPath, validateTarget } from "./lib/github.mjs";
import { progressionForSession, rirApplies } from "./lib/progression.mjs";
import { localHistory, markerToHistory, mergeHistory, orderedSessions, shortDate, suggestNext } from "./lib/rotation.mjs";
import { elapsedSeconds, formatClock, startRest, tickRest } from "./lib/rest.mjs";
import { DEFAULT_SIGNAL, MUSIC_LABELS, VIBRATE, VOLUME_LABELS, VOLUME_LEVELS, alarmSamples, alarmSeconds, encodeWav, goSamples, normalizeSignal, preBeepFor, preBeepSamples, workEndIsFresh } from "./lib/signal.mjs";
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
  signal: { ...DEFAULT_SIGNAL },
  signalOk: "",
  wake: null,
  wakeNote: "",
  fragmentNote: "",
  syncing: false,
  remote: { markers: {}, fetchedAt: null, targetKey: "" },
  remoteStatus: "idle",
};

const APP_VERSION = "2026-11-18-tydlig-signal-pausar-musik";

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
  const signalRow = (settings || []).find((item) => item.id === "signal");
  state.signal = normalizeSignal(signalRow?.value);
  const remoteRow = (settings || []).find((item) => item.id === "remoteHistory");
  if (remoteRow?.value?.markers && remoteRow.value.targetKey === targetKey()) state.remote = remoteRow.value;
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

function rirLine(step) {
  if (!rirApplies(step)) return null;
  return text("p", `RIR (valfritt): ${step.rir == null ? "–" : step.rir}`, { class: "muted small", "data-testid": "rir-line" });
}

function phaseLabel(phase) {
  return { warmup: "Uppvärmning", work: "Arbetsset", cardio: "Intervall", recovery: "Återhämtning", mobility: "Rörlighet" }[phase] || phase;
}

function equipmentLabel(equipment) {
  return { barbell: "Skivstång", dumbbell: "Hantel", lat: "Latsdrag", machine: "Maskin", bodyweight: "Kroppsvikt", other: "Annan" }[equipment] || equipment;
}

/*
 * Signals. Sounds are played through <audio> elements (see lib/signal.mjs for
 * why): on Android Chrome/Brave that takes audio focus, so the alarm pauses
 * (or ducks) Spotify instead of being mixed quietly underneath it. Web Audio
 * is only a fallback when an <audio> element cannot play.
 */
const sounds = { urls: {}, players: {}, primed: false };
const ALARM_AUDIBLE_SECONDS = 3.9;

function soundKey(kind) {
  return kind === "alarm" ? `alarm-${state.signal.music}` : kind;
}

function soundUrl(kind) {
  const key = soundKey(kind);
  if (!sounds.urls[key]) {
    const samples = kind === "alarm" ? alarmSamples(alarmSeconds(state.signal.music)) : kind === "go" ? goSamples() : preBeepSamples();
    sounds.urls[key] = URL.createObjectURL(new Blob([encodeWav(samples)], { type: "audio/wav" }));
  }
  return sounds.urls[key];
}

function player(kind) {
  if (typeof globalThis.Audio !== "function" || typeof URL.createObjectURL !== "function") return null;
  let node = sounds.players[kind];
  if (!node) {
    node = new Audio();
    node.preload = "auto";
    sounds.players[kind] = node;
  }
  const key = soundKey(kind);
  if (node.dataset.sound !== key) {
    node.src = soundUrl(kind);
    node.dataset.sound = key;
  }
  return node;
}

function unlockAudio() {
  if (!sounds.primed) {
    sounds.primed = true;
    for (const kind of ["alarm", "tick", "go"]) {
      try {
        player(kind)?.load();
      } catch {
        /* fallback below */
      }
    }
    // Prime playback inside the user gesture with a muted short clip only, so
    // starting a pass never takes audio focus from the music.
    const tick = player("tick");
    if (tick) {
      tick.muted = true;
      const pending = tick.play?.();
      if (pending && typeof pending.then === "function") {
        pending.then(() => { tick.pause(); tick.currentTime = 0; tick.muted = false; state.audioNote = ""; }).catch(() => {
          tick.muted = false;
          sounds.primed = false;
          showAudioNote("Webbläsaren blockerar ljud. Passet fortsätter. Tryck på skärmen, eller Testa signal i Inställningar.");
        });
      } else {
        tick.muted = false;
      }
    }
  }
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return;
  try {
    if (!state.audio) state.audio = new AC();
    state.audio.resume?.()?.catch?.(() => {});
  } catch {
    /* Web Audio is only the fallback */
  }
}

function showAudioNote(message) {
  state.audioNote = message;
  const note = document.querySelector("[data-testid=audio-note]");
  if (note) note.textContent = message;
  else document.querySelector("[data-testid=step-view]")?.append(text("p", message, { class: "warn", "data-testid": "audio-note" }));
}

function webAudioBeep(frequency = 1046, seconds = 0.4) {
  if (!state.audio) return;
  try {
    state.audio.resume?.()?.catch?.(() => {});
    const osc = state.audio.createOscillator();
    const gain = state.audio.createGain();
    osc.type = "square";
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, state.audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.6, state.audio.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, state.audio.currentTime + seconds);
    osc.connect(gain);
    gain.connect(state.audio.destination);
    osc.start();
    osc.stop(state.audio.currentTime + seconds + 0.01);
  } catch {
    /* nothing more to try */
  }
}

function alarmAudible() {
  const node = sounds.players.alarm;
  return Boolean(node && !node.paused && node.currentTime < ALARM_AUDIBLE_SECONDS);
}

function setAlarmMetadata(title) {
  try {
    if (globalThis.MediaMetadata && navigator.mediaSession) {
      navigator.mediaSession.metadata = new MediaMetadata({ title, artist: "Atlas träning" });
    }
  } catch {
    /* optional */
  }
}

/** kind: "alarm" | "tick" | "go". Resolves true when the <audio> path played. */
function playSound(kind, title = "") {
  if (!state.signal.enabled) return Promise.resolve(false);
  const node = player(kind);
  const fallback = () => {
    if (kind === "alarm") {
      webAudioBeep(1400, 0.4);
      setTimeout(() => webAudioBeep(1900, 0.4), 500);
      setTimeout(() => webAudioBeep(1400, 0.4), 1000);
    } else {
      webAudioBeep(kind === "go" ? 1800 : 1200, kind === "go" ? 0.4 : 0.12);
    }
  };
  if (!node) {
    fallback();
    return Promise.resolve(false);
  }
  try {
    node.muted = false;
    node.volume = VOLUME_LEVELS[state.signal.volume] ?? 1;
    node.currentTime = 0;
    if (kind === "alarm") setAlarmMetadata(title || "Tiden är slut");
    const pending = node.play();
    if (!pending || typeof pending.then !== "function") return Promise.resolve(true);
    return pending.then(() => true).catch(() => {
      showAudioNote("Webbläsaren stoppade larmljudet. Tryck på skärmen en gång, eller Testa signal i Inställningar.");
      fallback();
      return false;
    });
  } catch {
    fallback();
    return Promise.resolve(false);
  }
}

function vibrate(pattern) {
  try {
    if (typeof navigator.vibrate === "function") navigator.vibrate(pattern);
  } catch {
    /* unsupported */
  }
}

/** The ring: loud alarm through the media path plus a long vibration. */
function ringAlarm(title) {
  globalThis.__signalLog?.push({ kind: "alarm", title, at: Date.now() });
  vibrate(VIBRATE.alarm);
  return playSound("alarm", title);
}

function stopAlarm() {
  const node = sounds.players.alarm;
  if (node && !node.paused) {
    node.pause();
    try {
      node.currentTime = 0;
    } catch {
      /* ignore */
    }
    vibrate(0);
  }
}

function tickSignal(kind) {
  globalThis.__signalLog?.push({ kind, at: Date.now() });
  if (kind === "tick" && alarmAudible()) return;
  vibrate(kind === "go" ? VIBRATE.go : VIBRATE.tick);
  playSound(kind);
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
  // Any tap silences a ringing alarm (Klar included) and keeps audio unlocked,
  // also after a reload in the middle of a pass.
  document.addEventListener("pointerdown", () => {
    stopAlarm();
    unlockAudio();
  }, { capture: true });
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
  refreshRemoteHistory().catch(() => {});
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

function targetKey() {
  const t = state.target || {};
  return `${t.owner || ""}/${t.repo || ""}@${t.branch || ""}`;
}

function currentHistory() {
  const remote = Object.values(state.remote?.markers || {}).map(markerToHistory).filter(Boolean);
  return mergeHistory(localHistory(state.sessions, state.events), remote);
}

function currentSuggestion() {
  return suggestNext(state.plan, currentHistory(), { demo: Boolean(state.plan?.demo) });
}

/** Read finished-session markers from the data repo (read-only) and cache them on the phone. */
async function refreshRemoteHistory() {
  if (!state.token || !validateTarget(state.target).ok) return;
  if (state.remoteStatus === "loading") return;
  state.remoteStatus = "loading";
  const key = targetKey();
  const known = state.remote?.targetKey === key ? state.remote.markers || {} : {};
  const got = await fetchCompletedMarkers(fetch, { target: validateTarget(state.target).target, token: state.token, known });
  if (got.kind !== "ok") {
    state.remoteStatus = got.kind === "network" ? "network" : `fel-${got.status || got.kind}`;
  } else {
    state.remote = { markers: got.markers, fetchedAt: new Date().toISOString(), targetKey: key };
    state.remoteStatus = got.failed ? "partial" : "ok";
    try {
      await withDb(["settings"], "readwrite", async (stores) => stores.settings.put({ id: "remoteHistory", value: state.remote }));
    } catch {
      /* cache is optional */
    }
  }
  if (!state.active && state.view === "home" && !state.focusId && !document.querySelector("dialog[open]")) render();
}

function remoteNote() {
  const connected = state.token && validateTarget(state.target).ok;
  const when = state.remote?.fetchedAt ? shortDate(state.remote.fetchedAt) : null;
  if (state.remoteStatus === "loading") return { warn: false, text: "Läser avslutade pass från GitHub …" };
  if (state.remoteStatus === "network") return { warn: true, text: `GitHub nåddes inte. Förslaget bygger på telefonens historik${when ? ` och GitHub-läsning ${when}` : ""}.` };
  if (state.remoteStatus.startsWith("fel-")) return { warn: true, text: `GitHub-historiken kunde inte läsas (${state.remoteStatus.slice(4)}). Förslaget bygger på telefonens historik.` };
  if (state.remoteStatus === "partial") return { warn: true, text: "Några avslutade pass på GitHub kunde inte läsas. Förslaget kan vara fel." };
  if (!connected && !when) return { warn: false, text: "Bygger på telefonens historik. Lägg in token under Inställningar för att även läsa GitHub." };
  if (!connected) return { warn: false, text: `Bygger på telefonens historik och GitHub-läsning ${when}.` };
  return { warn: false, text: `Bygger på telefonens historik och GitHub${when ? ` (läst ${when})` : ""}.` };
}

function renderNextHero(suggestion) {
  const note = remoteNote();
  const demoWarn = state.planMeta?.source === "demo"
    ? text("p", "Obs: DEMO-planen visas. Hämta din riktiga plan under Inställningar.", { class: "warn", "data-testid": "next-demo-warn" })
    : null;
  if (!suggestion.ok) {
    return el("section", { class: "card next-hero next-missing", "data-testid": "next-hero" }, [
      text("p", "Nästa pass", { class: "next-label" }),
      text("p", suggestion.message, { class: "warn", "data-testid": "next-warning" }),
      text("p", "Välj själv i listan nedan. Rotationen är planens ordning.", { class: "muted" }),
      demoWarn,
      text("p", note.text, { class: note.warn ? "warn" : "muted", "data-testid": "next-source" }),
    ]);
  }
  const { catalog, last } = suggestion;
  return el("section", { class: "card next-hero", "data-testid": "next-hero", "data-next": catalog.id }, [
    text("p", "Nästa pass", { class: "next-label" }),
    el("h2", { class: "next-title", "data-testid": "next-title" }, [text("span", catalog.id, { class: "next-id" }), ` ${catalog.title}`]),
    text("p", `Senast avslutat: ${last.title || last.catalogId}, ${shortDate(last.completedAt).replace(/\.$/, "")}.`, { class: "muted", "data-testid": "next-last" }),
    el("button", { class: "klar next-start", type: "button", "data-testid": "next-start", onclick: () => openPreview(catalog) }, [`Starta ${catalog.id}`]),
    text("p", "Öppnar passet. Inget startas förrän du trycker Start.", { class: "muted" }),
    demoWarn,
    note.warn ? text("p", note.text, { class: "warn", "data-testid": "next-source" }) : text("p", note.text, { class: "muted small", "data-testid": "next-source" }),
  ]);
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
  const suggestion = currentSuggestion();
  app.append(renderNextHero(suggestion));
  app.append(
    el("section", { class: "card" }, [
      text("p", state.plan?.disclaimer || "", { class: "demo-flag", "data-testid": "disclaimer" }),
      text("p", `Källa: ${state.planMeta?.source || "demo"}. Validerad: ${when}.`, { class: "muted", "data-testid": "plan-date" }),
      state.fragmentNote ? text("p", state.fragmentNote, { class: "muted" }) : null,
      text("p", "Låst skärm: ett pip är inte garanterat. Webbläsaren kan tysta ljud när skärmen är låst.", { class: "muted" }),
    ])
  );
  app.append(text("h3", suggestion.ok ? "Alla pass (nästa först)" : "Alla pass", { class: "list-heading" }));
  for (const session of orderedSessions(state.plan, suggestion)) {
    const isNext = suggestion.ok && suggestion.catalog.id === session.id;
    app.append(
      el("button", {
        class: isNext ? "session-btn is-next" : "session-btn is-other",
        type: "button",
        "data-testid": `start-${session.id}`,
        "data-next": isNext ? "true" : "false",
        onclick: () => openPreview(session),
      }, [
        el("strong", {}, [
          isNext ? text("span", "Nästa", { class: "next-badge", "data-testid": "next-badge" }) : null,
          session.title,
        ]),
        text("div", `${session.location} · ${session.steps.length} steg · ${isNext ? "tryck för att se passet" : "inte på tur"}`, { class: "muted" }),
      ])
    );
  }
  app.append(text("p", `Version ${APP_VERSION}`, { class: "muted small", "data-testid": "app-version" }));
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

function previewNextLine(catalog) {
  const suggestion = currentSuggestion();
  if (suggestion.ok && suggestion.catalog.id === catalog.id) {
    return text("p", "Nästa pass i rotationen ✓", { class: "ok", "data-testid": "preview-is-next" });
  }
  if (suggestion.ok) {
    return text("p", `Obs: inte nästa pass. Nästa på tur är ${suggestion.catalog.id} ${suggestion.catalog.title}.`, { class: "warn", "data-testid": "preview-not-next" });
  }
  return null;
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
      previewNextLine(catalog),
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
    stepStartedAt: stepStartTime(prepared.catalog.steps[0], Date.now()),
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
    rirLine(step),
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
    const left = countdownLeft(session, step, Date.now());
    if (!left) countdownShown = 0;
    card.insertBefore(text("p", left ? "Gör dig redo – tiden startar om" : "Tiden går", { class: left ? "countdown-label" : "countdown-label running", "data-testid": "countdown-label" }), prescribed);
    card.insertBefore(text("p", left ? String(left) : liveDurationText(session, step), { class: left ? "clock countdown" : "clock", "data-testid": "duration-clock", "data-countdown": String(left) }), prescribed);
    const kind = timerKind(step);
    const hint = kind === "overtime"
      ? "Stretch: tiden får gå över om du vill förlänga. Tryck Klar när du är färdig."
      : kind === "auto"
        ? "Vid noll piper appen, sparar steget och går vidare själv. Klar avslutar tidigare."
        : "Tiden stannar på noll. Tryck Klar och fyll i reps.";
    card.append(text("p", hint, { class: "muted", "data-testid": "timer-hint", "data-kind": kind }));
    card.append(el("button", { class: "ghost", type: "button", "data-testid": "restart-countdown", onclick: restartCountdown }, ["Starta om tiden (5 s nedräkning)"]));
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
  card.append(text("p", SIGNAL_HINT, { class: "muted", "data-testid": "signal-hint" }));
  app.append(card);
  if (step.durationSeconds != null) armDuration();
}

const SIGNAL_HINT = "Larmet ringer när tiden är slut och pausar musiken. Ha appen öppen med skärmen tänd; med låst skärm eller appen i bakgrunden kan det komma sent eller utebli.";

let durationTimer = 0;
let countdownShown = 0;
function armDuration() {
  clearInterval(durationTimer);
  durationTimer = setInterval(() => {
    const node = document.querySelector("[data-testid=duration-clock]");
    const label = document.querySelector("[data-testid=countdown-label]");
    const step = currentStep();
    if (!node || !step || !state.active || state.active.phase !== "step") return;
    const left = countdownLeft(state.active, step, Date.now());
    if (left !== countdownShown) {
      const previous = countdownShown;
      countdownShown = left;
      if (left > 0 && preBeepFor(left) && previous > left) {
        tickSignal("tick");
      } else if (left === 0 && previous > 0) {
        tickSignal("go");
      }
    }
    node.dataset.countdown = String(left);
    node.className = left ? "clock countdown" : "clock";
    node.textContent = left ? String(left) : liveDurationText(state.active, step);
    const remaining = left ? null : workSecondsLeft(state.active, step, Date.now());
    if (remaining != null && remaining <= 0) {
      node.dataset.ended = "true";
      onWorkTimerZero(state.active, step);
      return;
    }
    if (label) {
      label.textContent = left ? "Gör dig redo – tiden startar om" : "Tiden går";
      label.className = left ? "countdown-label" : "countdown-label running";
    }
  }, 100);
}

async function restartCountdown() {
  if (!state.active || state.active.phase !== "step") return;
  unlockAudio();
  const session = { ...state.active, stepStartedAt: Date.now() + COUNTDOWN_MS };
  try {
    await saveSession(session);
  } catch {
    state.persistError = "Kunde inte spara omstarten. Tiden är oförändrad.";
  }
  render();
}

function liveDurationText(session, step) {
  const left = workSecondsLeft(session, step, Date.now());
  if (left >= 0) return formatClock(left * 1000);
  return `Över tid ${formatClock(-left * 1000)}`;
}

let endSignaledFor = "";
function timerEndKey(session) {
  return `${session.id}:${session.stepIndex}:${session.stepStartedAt}`;
}

/** Called by the step timer once the work time reaches zero. */
function onWorkTimerZero(session, step) {
  const key = timerEndKey(session);
  if (endSignaledFor === key) return;
  endSignaledFor = key;
  const kind = timerKind(step);
  if (workEndIsFresh(workSecondsLeft(session, step, Date.now()))) {
    ringAlarm(kind === "auto" ? "Tiden är slut – går vidare" : kind === "stop" ? "Tiden är slut – tryck Klar" : "Tiden är nådd");
  }
  const label = document.querySelector("[data-testid=countdown-label]");
  if (kind === "auto") {
    if (label) label.textContent = "Tiden är slut – går vidare";
    autoCompleteTimed(step).catch(() => {});
  } else if (kind === "stop") {
    if (label) {
      label.textContent = "Tiden är slut – tryck Klar";
      label.className = "countdown-label done";
    }
  } else if (label) {
    label.textContent = "Övertid – förläng gärna stretchen";
  }
}

/** Save an auto-ending timed step (no weight, no reps) and move on, like Klar. */
async function autoCompleteTimed(step) {
  if (state.saving || !state.active || state.active.phase !== "step" || currentStep() !== step) return;
  if (document.querySelector("dialog[open]")) return; // the Klar dialog wins
  state.saving = true;
  const built = buildActual(step, { weight: "", reps: "", rir: "", elapsedSeconds: step.durationSeconds });
  if (!built.ok) {
    state.saving = false;
    return;
  }
  const event = completionEvent({
    sessionId: state.active.id,
    step,
    actual: built.actual,
    nowIso: new Date().toISOString(),
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
  const useRest = hasNext && (step.restSeconds || 0) > 0;
  const session = {
    ...state.active,
    phase: useRest ? "rest" : hasNext ? "step" : "done",
    stepIndex: useRest ? state.active.stepIndex : hasNext ? next : state.active.stepIndex,
    rest: useRest ? startRest(Date.now(), step.restSeconds) : null,
    stepStartedAt: useRest ? state.active.stepStartedAt : hasNext ? stepStartTime(state.active.planSnapshot.steps[next], Date.now()) : Date.now(),
    revisions: { ...state.active.revisions, [step.id]: event.eventId },
  };
  const bundle = [event];
  if (session.phase === "done") {
    const marker = markerForFinish(session, [event]);
    if (marker) bundle.push(marker);
  }
  try {
    await atomicWrite(session, bundle);
    state.persistError = "";
    if (session.phase === "done") await releaseWake();
  } catch {
    state.persistError = "Steget kunde inte sparas automatiskt. Tryck Klar.";
  } finally {
    state.saving = false;
  }
  render();
  flush().catch(() => {});
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
  // RIR is never prefilled from the plan: an empty field means "not estimated".
  const rir = draft.rir != null ? draft.rir : "";
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
    rirApplies(step)
      ? el("details", { class: "rir-details", "data-testid": "rir-details" }, [
          text("summary", "RIR (valfritt, behövs inte)"),
          el("label", {}, ["Utförd RIR", rir]),
        ])
      : null,
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
        stepStartedAt: useRest ? state.active.stepStartedAt : hasNext ? stepStartTime(state.active.planSnapshot.steps[next], Date.now()) : Date.now(),
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
    rirLine(nextStep),
    nextStep.durationSeconds != null ? text("p", `Tid: ${nextStep.durationSeconds} s`) : null,
    nextStep.alternative ? text("p", `Alternativ: ${nextStep.alternative}`, { class: "muted", "data-testid": "step-alternative" }) : null,
    clock,
    text("p", SIGNAL_HINT, { class: "muted", "data-testid": "signal-hint" }),
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
        if (decision.beep) ringAlarm("Vilan är slut");
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
        if (decision.beep) ringAlarm("Vilan är slut");
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

function doneNextLine() {
  const suggestion = currentSuggestion();
  if (!suggestion.ok) return null;
  return text("p", `Nästa gång: ${suggestion.catalog.id} ${suggestion.catalog.title}`, { class: "ok", "data-testid": "done-next" });
}

function progressionBlock(session) {
  if (!session?.planSnapshot) return null;
  const items = progressionForSession(session.planSnapshot.steps, state.events, session.id);
  if (!items.length) return null;
  const list = el("ul", { "data-testid": "progression-list" });
  for (const item of items) {
    list.append(el("li", { "data-decision": item.decision, "data-testid": "progression-row" }, [text("strong", item.exercise), ` – ${item.text}`]));
  }
  return el("div", { class: "progression", "data-testid": "progression" }, [
    text("h3", "Nästa gång (efter vikt × reps)"),
    text("p", "Bygger på utförda reps och vikt, inte på RIR.", { class: "muted small" }),
    list,
  ]);
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
      doneNextLine(),
      progressionBlock(session),
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
    renderSignalSettings(),
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
    ])
  );
}

function renderSignalSettings() {
  const enabled = el("input", { "data-testid": "signal-enabled", type: "checkbox" });
  enabled.checked = state.signal.enabled;
  const volume = el("select", { "data-testid": "signal-volume" }, Object.entries(VOLUME_LABELS).map(([value, label]) => el("option", { value }, [label])));
  volume.value = state.signal.volume;
  const music = el("select", { "data-testid": "signal-music" }, Object.entries(MUSIC_LABELS).map(([value, label]) => el("option", { value }, [label])));
  music.value = state.signal.music;
  const save = () => saveSignal({ enabled: enabled.checked, volume: volume.value, music: music.value });
  enabled.addEventListener("change", save);
  volume.addEventListener("change", save);
  music.addEventListener("change", save);
  return el("section", { class: "card stack", "data-testid": "signal-settings" }, [
    text("h2", "Signal när tiden är slut"),
    text("p", "Larmet spelas som media, så Android pausar eller sänker musik från t.ex. Spotify medan det ringer. Telefonen vibrerar också. Tryck var som helst för att tysta. Volymen följer telefonens medievolym.", { class: "muted" }),
    el("label", {}, [enabled, "Ljudsignal på"]),
    el("label", {}, ["Volym", volume]),
    el("label", {}, ["Musik vid larm", music]),
    text("p", state.signal.music === "pause"
      ? "Pausa: musiken stannar och startar oftast inte av sig själv. Tryck play i hörlurarna eller Spotify när du vill fortsätta."
      : "Sänk: musiken går ner under larmet och kommer tillbaka av sig själv. Lättare att missa.", { class: "muted small", "data-testid": "signal-music-note" }),
    el("button", { class: "ghost", type: "button", "data-testid": "test-signal", onclick: () => { unlockAudio(); ringAlarm("Testsignal"); } }, ["Testa signal"]),
    state.signalOk ? text("p", state.signalOk, { class: "ok", "data-testid": "signal-ok" }) : null,
  ]);
}

async function saveSignal(raw) {
  state.signal = normalizeSignal(raw);
  try {
    await withDb(["settings"], "readwrite", async (stores) => stores.settings.put({ id: "signal", value: state.signal }));
    state.signalOk = "Signalinställningen är sparad.";
  } catch {
    state.signalOk = "";
    state.settingsError = "Signalinställningen kunde inte sparas lokalt. Den gäller tills appen stängs.";
  }
  render();
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
  if (state.remote?.targetKey !== targetKey()) state.remote = { markers: {}, fetchedAt: null, targetKey: "" };
  refreshRemoteHistory().catch(() => {});
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
  refreshRemoteHistory().catch(() => {});
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
