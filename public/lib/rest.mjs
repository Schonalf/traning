/** Date.now rest decisions. One beep, no stale beep, clock-jump guard. */

export const STALE_MS = 3000;

export function startRest(now, restSeconds) {
  const durationMs = Math.max(0, restSeconds) * 1000;
  return {
    startedAt: now,
    durationMs,
    deadline: now + durationMs,
    signaled: false,
    lastRemainingMs: durationMs,
  };
}

export function tickRest(state, now, { visible }) {
  const next = { ...state };
  if (!state || state.durationMs <= 0) {
    return { state: next, displayMs: 0, beep: false, advance: true };
  }
  if (now < state.startedAt - 500) {
    const rem = state.lastRemainingMs ?? state.durationMs;
    next.deadline = now + rem;
    next.startedAt = now - (state.durationMs - rem);
    next.lastRemainingMs = rem;
    return { state: next, displayMs: rem, beep: false, advance: false, clockGuarded: true };
  }
  let remaining = state.deadline - now;
  if (remaining > state.durationMs + 1000) {
    remaining = state.durationMs;
    next.deadline = now + remaining;
    next.startedAt = now;
  }
  if (remaining > 0) {
    next.lastRemainingMs = remaining;
    return { state: next, displayMs: remaining, beep: false, advance: false };
  }
  next.lastRemainingMs = 0;
  let beep = false;
  if (!state.signaled) {
    const late = now - state.deadline;
    const stale = !visible || late > STALE_MS;
    next.signaled = true;
    beep = !stale;
  }
  return { state: next, displayMs: 0, beep, advance: true };
}

export function elapsedSeconds(startedAt, now) {
  if (typeof startedAt !== "number") return 0;
  if (now < startedAt) return 0;
  return Math.min(7200, Math.floor((now - startedAt) / 1000));
}

export function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
