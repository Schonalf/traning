/** Preview, priority and early-end helpers. No I/O, no session writes. */

export const PRIORITY_DEFAULT = 2;

export const PRIORITY_LABELS = {
  1: "Kärna",
  2: "Bra att hinna",
  3: "Bonus",
};

export function stepPriority(step) {
  const value = step?.priority;
  if (value === 1 || value === 2 || value === 3) return value;
  return PRIORITY_DEFAULT;
}

export function exerciseKey(name) {
  return String(name || "")
    .replace(/\s+uppvärmning\s*$/i, "")
    .replace(/\s*[–-]\s*.*$/u, "")
    .replace(/,\s*ett ben/gi, "")
    .replace(/,\s*lätt framåtlut/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function groupSteps(steps) {
  const groups = [];
  const index = new Map();
  for (const step of steps || []) {
    const key = exerciseKey(step.exercise) || step.exercise || step.id;
    let group = index.get(key);
    if (!group) {
      group = { key, title: key, steps: [], priority: stepPriority(step) };
      index.set(key, group);
      groups.push(group);
    }
    group.steps.push(step);
    group.priority = Math.min(group.priority, stepPriority(step));
  }
  return groups;
}

function stepsForPriority(groups, include) {
  const included = [];
  const omittedExercises = [];
  for (const group of groups) {
    if (include(group.priority)) included.push(...group.steps);
    else omittedExercises.push(group.title);
  }
  return { included, omittedExercises, groups: groupSteps(included) };
}

/** full = every step. base = priority 1 and 2. quick = legacy priority-1-only. */
export function selectSessionSteps(catalog, mode = "full") {
  const steps = Array.isArray(catalog?.steps) ? catalog.steps : [];
  const groups = groupSteps(steps);
  if (mode === "quick") {
    const picked = stepsForPriority(groups, (priority) => priority === 1);
    return { mode: "quick", steps: picked.included, omittedExercises: picked.omittedExercises, groups: picked.groups };
  }
  if (mode === "base") {
    const picked = stepsForPriority(groups, (priority) => priority <= 2);
    return { mode: "base", steps: picked.included, omittedExercises: picked.omittedExercises, groups: picked.groups };
  }
  return { mode: "full", steps: steps.slice(), omittedExercises: [], groups };
}

export function estimateStepSeconds(step) {
  const rest = Number.isFinite(step?.restSeconds) ? Math.max(0, step.restSeconds) : 0;
  if (step?.durationSeconds != null) return Math.max(0, step.durationSeconds) + rest;
  const reps = step?.reps?.target ?? step?.reps?.max ?? step?.reps?.min;
  const work = Number.isInteger(reps) ? reps * 4 + 15 : 20;
  return work + rest;
}

export function estimateSessionSeconds(steps) {
  return (steps || []).reduce((sum, step) => sum + estimateStepSeconds(step), 0);
}

export function formatEstimatedDuration(seconds) {
  const minutes = Math.max(1, Math.round(Math.max(0, Number(seconds) || 0) / 60));
  return `ca ${minutes} min`;
}

export function estimatedMinutes(seconds) {
  return Math.max(1, Math.round(Math.max(0, Number(seconds) || 0) / 60));
}

export function sessionEstimates(catalog) {
  const full = selectSessionSteps(catalog, "full");
  const base = selectSessionSteps(catalog, "base");
  const quick = selectSessionSteps(catalog, "quick");
  const fullSeconds = estimateSessionSeconds(full.steps);
  const baseSeconds = estimateSessionSeconds(base.steps);
  const quickSeconds = estimateSessionSeconds(quick.steps);
  return {
    fullSeconds,
    baseSeconds,
    quickSeconds,
    fullLabel: formatEstimatedDuration(fullSeconds),
    baseLabel: formatEstimatedDuration(baseSeconds),
    quickLabel: formatEstimatedDuration(quickSeconds),
    baseCount: base.steps.length,
    quickCount: quick.steps.length,
    omittedExercises: base.omittedExercises,
  };
}

export function unperformedStepIds(session) {
  const steps = session?.planSnapshot?.steps || [];
  const start = session?.phase === "rest" ? (session.stepIndex || 0) + 1 : session.stepIndex || 0;
  return steps.slice(Math.max(0, start)).map((step) => step.id);
}

export function endSessionEarly(session, nowIso) {
  return {
    ...session,
    phase: "done",
    rest: null,
    endedEarly: true,
    endReason: "time_pressure",
    unperformedStepIds: unperformedStepIds(session),
    completedAt: nowIso,
  };
}

export function prepareSessionSnapshot(catalog, mode = "full") {
  const selected = selectSessionSteps(catalog, mode);
  return {
    catalog: { ...catalog, steps: selected.steps },
    mode: selected.mode,
    omittedExercises: selected.omittedExercises,
  };
}
