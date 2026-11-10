import { parseLooseNumber } from "./schema.mjs";
import { validateActualLoad } from "./equipment.mjs";

export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16)
  );
}

export function buildActual(step, form) {
  const errors = [];
  let weightKg = null;
  if (step.load) {
    const parsed = parseLooseNumber(form.weight);
    if (parsed.empty || !parsed.ok) {
      errors.push("Ange vikt. Tomt fält blir inte 0.");
    } else {
      const checked = validateActualLoad(step, parsed.value);
      if (!checked.ok) errors.push(checked.message);
      else weightKg = checked.weightKg;
    }
  }
  let reps = null;
  if (step.reps) {
    const parsed = parseLooseNumber(form.reps);
    if (parsed.empty || !parsed.ok || !Number.isInteger(parsed.value)) errors.push("Ange hela reps.");
    else if (parsed.value < 0 || parsed.value > 100) errors.push("Reps utanför 0–100.");
    else reps = parsed.value;
  }
  let rir = null;
  if (form.rir != null && String(form.rir).trim() !== "") {
    const parsed = parseLooseNumber(form.rir);
    if (!parsed.ok || !Number.isInteger(parsed.value) || parsed.value < 0 || parsed.value > 10) {
      errors.push("RIR måste vara heltal 0–10 eller tomt.");
    } else rir = parsed.value;
  }
  const elapsedSeconds = Number.isInteger(form.elapsedSeconds) ? Math.max(0, Math.min(7200, form.elapsedSeconds)) : 0;
  return {
    ok: errors.length === 0,
    errors,
    actual: { weightKg, reps, rir, elapsedSeconds },
  };
}

export function completionEvent({ sessionId, step, actual, nowIso, revisesEventId = null, meta = null }) {
  const record = {
    eventId: newId(),
    sessionId,
    type: revisesEventId ? "revision" : "completion",
    stepId: step.id,
    schemaVersion: 1,
    prescribed: {
      exercise: step.exercise,
      phase: step.phase,
      equipment: step.equipment,
      location: step.location,
      side: step.side,
      load: step.load ? { ...step.load } : null,
      reps: step.reps ? { ...step.reps } : null,
      rir: step.rir ?? null,
      durationSeconds: step.durationSeconds ?? null,
      restSeconds: step.restSeconds ?? 0,
    },
    actual: { ...actual },
    createdAt: nowIso,
    revisesEventId,
  };
  if (meta) {
    record.sessionTitle = meta.sessionTitle || "";
    record.catalogId = meta.catalogId || "";
    record.planId = meta.planId || "";
    record.sessionType = meta.sessionType || "";
    record.planDemo = Boolean(meta.planDemo);
  }
  return record;
}

/** End signal. Revisions added after this record are not written back into it. */
export function sessionCompletedEvent({ session, events, nowIso, eventId }) {
  const setEventIds = (events || [])
    .filter((item) => item.sessionId === session.id && (item.type === "completion" || item.type === "revision"))
    .map((item) => item.eventId);
  const skippedStepIds = [...(session.skipped || [])];
  const unperformed = [...(session.unperformedStepIds || [])];
  const record = {
    eventId,
    sessionId: session.id,
    type: "session_completed",
    schemaVersion: 1,
    sessionTitle: session.title || "",
    catalogId: session.catalogId || "",
    planId: session.planId || "",
    sessionType: session.sessionType || "",
    planDemo: Boolean(session.planDemo),
    completedAt: nowIso,
    outcome: skippedStepIds.length > 0 || setEventIds.length === 0 || unperformed.length > 0 ? "completed_with_skips" : "completed",
    setEventIds,
    skippedStepIds,
  };
  if (session.endedEarly) {
    record.endedEarly = true;
    record.endReason = session.endReason || "time_pressure";
    record.unperformedStepIds = unperformed;
  }
  if (session.mode === "base" || session.mode === "full" || session.mode === "quick") {
    record.mode = session.mode;
  }
  if (session.mode === "base" || session.mode === "quick") {
    record.omittedExercises = [...(session.omittedExercises || [])];
  }
  return record;

}

export function skippedSession(session, now) {
  const step = session.planSnapshot.steps[session.stepIndex];
  const next = session.stepIndex + 1;
  const done = next >= session.planSnapshot.steps.length;
  return {
    ...session,
    skipped: [...(session.skipped || []), step.id],
    phase: done ? "done" : "step",
    stepIndex: done ? session.stepIndex : next,
    stepStartedAt: done ? session.stepStartedAt : now,
    rest: null,
  };
}

export function advancedAfterRest(session, restState, now) {
  return {
    ...session,
    stepIndex: session.stepIndex + 1,
    phase: "step",
    rest: restState,
    stepStartedAt: now,
  };
}

export function nextIndex(steps, index) {
  const n = index + 1;
  return n >= steps.length ? null : n;
}

/** In-memory atomic stand-in used by the app transaction wrapper and unit tests. */
export function commitAtomic(db, { session, event, outbox }) {
  if (db.failNext) {
    db.failNext = false;
    const error = new Error("persist-failed");
    error.code = "PERSIST";
    throw error;
  }
  if (db.sessions.some((s) => s.id === session.id)) {
    db.sessions = db.sessions.map((s) => (s.id === session.id ? session : s));
  } else db.sessions.push(session);
  db.events.push(event);
  db.outbox.push(outbox);
  return { session, event, outbox };
}

export function createMemoryDb() {
  return { sessions: [], events: [], outbox: [], plans: [], settings: [], failNext: false };
}
