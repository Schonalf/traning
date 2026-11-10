/** Generic training-plan schema. Unknown keys never become settings. */

import { equipmentLoadOk } from "./equipment.mjs";

export const SCHEMA_VERSION = 1;
export const MAX_PLAN_CHARS = 80_000;
export const MAX_FRAGMENT_CHARS = 20_000;
export const MAX_SESSIONS = 14;
export const MAX_STEPS = 60;
export const MAX_STRING = 180;

const SESSION_TYPES = new Set(["strength", "conditioning", "mobility"]);
const PHASES = new Set(["warmup", "work", "cardio", "recovery", "mobility"]);
const EQUIPMENT = new Set(["barbell", "dumbbell", "lat", "machine", "bodyweight", "other"]);
const SIDES = new Set(["both", "left", "right", "none"]);
const LOAD_MODES = new Set(["total", "per_hand", "stack"]);
const PHASE_RANK = { warmup: 0, work: 1, cardio: 2, recovery: 3, mobility: 4 };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

function fail(errors, path, message) {
  errors.push({ path, message });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value, path, errors, { required = true } = {}) {
  if (value == null && !required) return null;
  if (typeof value !== "string") {
    fail(errors, path, "måste vara text");
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed && required) fail(errors, path, "får inte vara tom");
  if (trimmed.length > MAX_STRING) fail(errors, path, "för lång");
  return trimmed;
}

function optionalNumber(value, path, errors, { min, max, integer = false, allowNull = true } = {}) {
  if (value == null) {
    if (!allowNull) fail(errors, path, "saknas");
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(errors, path, "ogiltigt tal");
    return null;
  }
  if (integer && !Number.isInteger(value)) fail(errors, path, "måste vara heltal");
  if (value < min || value > max) fail(errors, path, "utanför intervall");
  return value;
}

export function parseLooseNumber(raw) {
  if (raw == null) return { ok: false, empty: true };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { ok: false };
    return { ok: true, value: raw };
  }
  const text = String(raw).trim();
  if (!text) return { ok: false, empty: true };
  const normalized = text.replace(/\s/g, "").replace(",", ".");
  if (!/^[+-]?\d+(\.\d+)?$/.test(normalized)) return { ok: false };
  const value = Number(normalized);
  if (!Number.isFinite(value)) return { ok: false };
  return { ok: true, value };
}

function sanitizeLoad(load, path, errors) {
  if (load == null) return null;
  if (!isPlainObject(load)) {
    fail(errors, path, "ogiltig belastning");
    return null;
  }
  const unit = load.unit === "kg" ? "kg" : null;
  if (!unit) fail(errors, path + ".unit", "endast kg");
  const mode = LOAD_MODES.has(load.mode) ? load.mode : null;
  if (!mode) fail(errors, path + ".mode", "ogiltigt läge");
  const value = optionalNumber(load.value, path + ".value", errors, { min: 0, max: 500, allowNull: true });
  return { unit: unit || "kg", mode: mode || "total", value };
}

function sanitizeReps(reps, path, errors) {
  if (reps == null) return null;
  if (!isPlainObject(reps)) {
    fail(errors, path, "ogiltiga reps");
    return null;
  }
  const min = optionalNumber(reps.min, path + ".min", errors, { min: 0, max: 100, integer: true });
  const max = optionalNumber(reps.max, path + ".max", errors, { min: 0, max: 100, integer: true });
  const target = optionalNumber(reps.target, path + ".target", errors, { min: 0, max: 100, integer: true });
  if (min != null && max != null && min > max) fail(errors, path, "min större än max");
  return { min, max, target };
}

function sanitizeStep(step, index, errors) {
  const path = `steps[${index}]`;
  if (!isPlainObject(step)) {
    fail(errors, path, "ogiltigt steg");
    return null;
  }
  const id = stringField(step.id, path + ".id", errors);
  const phase = PHASES.has(step.phase) ? step.phase : null;
  if (!phase) fail(errors, path + ".phase", "ogiltig fas");
  const exercise = stringField(step.exercise, path + ".exercise", errors);
  const equipment = EQUIPMENT.has(step.equipment) ? step.equipment : null;
  if (!equipment) fail(errors, path + ".equipment", "ogiltig utrustning");
  const location = stringField(step.location, path + ".location", errors);
  const side = SIDES.has(step.side) ? step.side : null;
  if (!side) fail(errors, path + ".side", "ogiltig sida");
  const load = sanitizeLoad(step.load, path + ".load", errors);
  const reps = sanitizeReps(step.reps, path + ".reps", errors);
  const rir = optionalNumber(step.rir, path + ".rir", errors, { min: 0, max: 10, integer: true, allowNull: true });
  const durationSeconds = optionalNumber(step.durationSeconds, path + ".durationSeconds", errors, {
    min: 0,
    max: 7200,
    integer: true,
    allowNull: true,
  });
  const restSeconds = optionalNumber(step.restSeconds, path + ".restSeconds", errors, {
    min: 0,
    max: 900,
    integer: true,
    allowNull: true,
  });
  const notes = step.notes == null ? "" : stringField(step.notes, path + ".notes", errors, { required: false }) || "";
  let priority = 2;
  if (step.priority != null) {
    priority = optionalNumber(step.priority, path + ".priority", errors, { min: 1, max: 3, integer: true, allowNull: false });
    if (priority == null) priority = 2;
  }
  let supersetGroup = null;
  if (step.supersetGroup != null) {
    supersetGroup = stringField(step.supersetGroup, path + ".supersetGroup", errors);
  }
  const supersetOrder =
    step.supersetOrder == null
      ? null
      : optionalNumber(step.supersetOrder, path + ".supersetOrder", errors, { min: 1, max: 12, integer: true, allowNull: false });
  if (load && load.value != null && equipment && !equipmentLoadOk(equipment, load.value)) {
    fail(errors, path + ".load.value", equipment === "lat" ? "lat endast 59 eller 66 kg" : "ogiltig vikt för utrustningen");
  }
  return {
    id: id || `step-${index}`,
    phase: phase || "work",
    exercise: exercise || "",
    equipment: equipment || "other",
    location: location || "",
    side,
    load,
    reps,
    rir,
    durationSeconds,
    restSeconds: restSeconds == null ? 0 : restSeconds,
    notes,
    priority,
    supersetGroup,
    supersetOrder,
  };
}

/** Keep the author's order, including superset rounds and per-exercise warmups. */
export function normalizeSteps(steps) {
  return steps.slice();
}

export function validatePlan(input) {
  const errors = [];
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: "", message: "planen måste vara ett objekt" }] };
  let raw = input;
  try {
    const encoded = JSON.stringify(input);
    if (encoded.length > MAX_PLAN_CHARS) {
      return { ok: false, errors: [{ path: "", message: "planen är för stor" }] };
    }
    raw = JSON.parse(encoded);
  } catch {
    return { ok: false, errors: [{ path: "", message: "planen kan inte serialiseras" }] };
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) fail(errors, "schemaVersion", "stöds inte");
  const id = stringField(raw.id, "id", errors);
  const title = stringField(raw.title, "title", errors);
  if (typeof raw.demo !== "boolean") fail(errors, "demo", "måste vara boolean");
  const disclaimer = stringField(raw.disclaimer, "disclaimer", errors);
  if (!Array.isArray(raw.sessions)) fail(errors, "sessions", "måste vara en lista");
  const sessionsIn = Array.isArray(raw.sessions) ? raw.sessions : [];
  if (sessionsIn.length < 1 || sessionsIn.length > MAX_SESSIONS) fail(errors, "sessions", "fel antal pass");
  const sessions = [];
  const seenSessions = new Set();
  sessionsIn.forEach((session, sIndex) => {
    const sp = `sessions[${sIndex}]`;
    if (!isPlainObject(session)) {
      fail(errors, sp, "ogiltigt pass");
      return;
    }
    const sid = stringField(session.id, sp + ".id", errors);
    if (sid && seenSessions.has(sid)) fail(errors, sp + ".id", "dubblett");
    if (sid) seenSessions.add(sid);
    const stitle = stringField(session.title, sp + ".title", errors);
    const type = SESSION_TYPES.has(session.type) ? session.type : null;
    if (!type) fail(errors, sp + ".type", "ogiltig passtyp");
    const location = stringField(session.location, sp + ".location", errors);
    if (!Array.isArray(session.steps)) fail(errors, sp + ".steps", "steg saknas");
    const stepsIn = Array.isArray(session.steps) ? session.steps : [];
    if (stepsIn.length < 1 || stepsIn.length > MAX_STEPS) fail(errors, sp + ".steps", "fel antal steg");
    const steps = [];
    const seenStepIds = new Set();
    stepsIn.forEach((step, i) => {
      const clean = sanitizeStep(step, i, errors);
      if (!clean) return;
      if (seenStepIds.has(clean.id)) fail(errors, `${sp}.steps[${i}].id`, "dubblett");
      seenStepIds.add(clean.id);
      steps.push(clean);
    });
    sessions.push({
      id: sid || `session-${sIndex}`,
      title: stitle || "",
      type: type || "strength",
      location: location || "",
      steps: normalizeSteps(steps),
    });
  });
  if (errors.length) return { ok: false, errors };
  const plan = {
    schemaVersion: SCHEMA_VERSION,
    id,
    title,
    demo: raw.demo,
    disclaimer,
    sessions,
  };
  return { ok: true, plan };
}

export function decodePlanFragment(hash) {
  const text = String(hash || "");
  if (!text.startsWith("#plan=")) return { ok: false, reason: "missing" };
  const encoded = text.slice("#plan=".length);
  if (!encoded || encoded.length > MAX_FRAGMENT_CHARS) return { ok: false, reason: "size" };
  let json;
  try {
    json = decodeURIComponent(encoded);
  } catch {
    return { ok: false, reason: "encoding" };
  }
  if (json.length > MAX_PLAN_CHARS) return { ok: false, reason: "size" };
  try {
    return { ok: true, input: JSON.parse(json) };
  } catch {
    return { ok: false, reason: "json" };
  }
}

export function phaseRank(phase) {
  return PHASE_RANK[phase] ?? 9;
}

export function prescribedWeight(step) {
  if (!step || !step.load) return { present: false, value: null };
  return { present: true, value: step.load.value };
}
