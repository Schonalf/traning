/**
 * Progression from what was actually lifted (weight × reps), never from RIR.
 *
 * Double progression per exercise (work sets with a rep range):
 * - every work set reached the top of the range → smallest weight step up next time
 * - every work set was below the bottom of the range → one step down
 * - some set below the bottom → keep the weight
 * - otherwise → keep the weight and aim for +1 rep
 * RIR is optional, only offered on strength work sets, and never needed to progress.
 * Slow rehab sets (priority 1 with a set duration) only step up when pain ≤ 3/10.
 */

/** RIR is only meaningful on strength work sets: phase "work" with a rep range. */
export function rirApplies(step) {
  return Boolean(step && step.phase === "work" && step.reps && (step.reps.min != null || step.reps.max != null || step.reps.target != null));
}

function isRehab(step) {
  return step.priority === 1 && step.durationSeconds != null;
}

/** Smallest confirmed weight step, or null when the next weight is unknown. */
export function weightStep(equipment, kg, direction = 1) {
  if (typeof kg !== "number" || !Number.isFinite(kg)) return null;
  if (equipment === "dumbbell") {
    if (direction > 0 && kg >= 10) return 2.5;
    if (direction < 0 && kg > 10) return 2.5;
    return null; // no confirmed dumbbell grid at or below 10 kg
  }
  // barbell: small plates exist, but exact total steps per gym are unconfirmed (PROGRAM.md §4c)
  if (equipment === "lat") {
    if (direction > 0 && kg === 59) return 7;
    if (direction < 0 && kg === 66) return 7;
    return null; // only 59 and 66 kg are confirmed
  }
  return null; // machine/other: the next stack or plate step is not known
}

function kg(value) {
  return String(Math.round(value * 100) / 100).replace(".", ",");
}

/** Latest saved actual per step: a revision replaces the event it revises. */
export function effectiveSets(events, sessionId) {
  const rows = (events || []).filter((e) => e.sessionId === sessionId && (e.type === "completion" || e.type === "revision"));
  const revised = new Set(rows.filter((e) => e.revisesEventId).map((e) => e.revisesEventId));
  const byStep = new Map();
  for (const row of rows) {
    if (revised.has(row.eventId)) continue;
    byStep.set(row.stepId, row);
  }
  return byStep;
}

/**
 * Suggestions for one finished session.
 * steps: the session's plan snapshot steps; events: saved set events.
 * Returns [{ exercise, decision: "increase"|"keep"|"reduce"|"reps", text, nextKg, sets }].
 */
export function progressionForSession(steps, events, sessionId) {
  const sets = effectiveSets(events, sessionId);
  const groups = new Map();
  for (const step of steps || []) {
    if (!rirApplies(step)) continue;
    const event = sets.get(step.id);
    if (!event || event.actual?.reps == null) continue;
    const key = step.exercise;
    if (!groups.has(key)) groups.set(key, { step, rows: [] });
    groups.get(key).rows.push({ step, reps: event.actual.reps, weightKg: event.actual.weightKg });
  }
  const out = [];
  for (const [exercise, { step, rows }] of groups) {
    const min = step.reps.min ?? step.reps.target ?? null;
    const max = step.reps.max ?? step.reps.target ?? null;
    const weights = rows.map((r) => r.weightKg).filter((w) => typeof w === "number");
    const weight = weights.length ? Math.max(...weights) : null;
    const repsText = rows.map((r) => r.reps).join(", ");
    const loadText = weight != null ? `${kg(weight)} kg × ${repsText}` : `${repsText} reps`;
    const allTop = max != null && rows.every((r) => r.reps >= max);
    const allBelow = min != null && rows.every((r) => r.reps < min);
    const someBelow = min != null && rows.some((r) => r.reps < min);
    let decision;
    let text;
    let nextKg = weight;
    if (allTop) {
      decision = "increase";
      if (!step.load || weight == null) {
        text = `${loadText}: alla set nådde ${max}. Gör övningen tyngre nästa gång (vikt eller svårare variant).`;
        nextKg = null;
      } else {
        const inc = weightStep(step.equipment, weight, 1);
        if (inc == null) {
          text = `${loadText}: alla set nådde ${max}. Öka till minsta nästa vikt (steget är inte känt i appen).`;
          nextKg = null;
        } else {
          nextKg = weight + inc;
          text = `${loadText}: alla set nådde ${max}. Nästa gång ${kg(nextKg)} kg, börja på ${min ?? max} reps.`;
        }
      }
      if (isRehab(step)) text += " Rehab: höj bara om smärtan var ≤3/10 och nästa morgon är som vanligt.";
    } else if (allBelow) {
      decision = "reduce";
      const dec = weight != null ? weightStep(step.equipment, weight, -1) : null;
      if (dec != null) {
        nextKg = weight - dec;
        text = `${loadText}: alla set under ${min}. Sänk till ${kg(nextKg)} kg nästa gång.`;
      } else {
        text = `${loadText}: alla set under ${min}. Behåll eller sänk ett steg nästa gång.`;
      }
    } else if (someBelow) {
      decision = "keep";
      text = `${loadText}: något set under ${min}. Behåll vikten nästa gång.`;
    } else {
      decision = "reps";
      text = `${loadText}: inom ${min}–${max}. Behåll vikten och sikta på +1 rep.`;
    }
    out.push({ exercise, decision, text, nextKg, sets: rows.length });
  }
  return out;
}
