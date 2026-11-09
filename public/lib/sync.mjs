import { backoffMs, safeSyncError, uploadEvent, verifyPrivate } from "./github.mjs";

export function createWriter() {
  let locked = false;
  return {
    async run(task) {
      if (locked) return { skipped: true, reason: "busy" };
      locked = true;
      try {
        return await task();
      } finally {
        locked = false;
      }
    },
  };
}

/**
 * One successful private=true check gates the whole batch.
 * A failed privacy check performs no PUTs. Events stay queued.
 */
export function prepareManualRetry(events, outbox) {
  const queued = new Set(outbox.map((item) => item.eventId));
  return events.map((event) => (queued.has(event.eventId) ? { ...event, attempts: 0 } : { ...event }));
}

/** Copies only. Does not mutate the arrays passed in. */
export function applySyncResults(events, outbox, results, now) {
  const nextEvents = events.map((event) => ({ ...event }));
  let nextOutbox = outbox.map((item) => ({ ...item }));
  for (const result of results) {
    if (result.ack) {
      nextOutbox = nextOutbox.filter((item) => item.eventId !== result.eventId);
      const index = nextEvents.findIndex((event) => event.eventId === result.eventId);
      if (index >= 0) nextEvents[index] = { ...nextEvents[index], status: "acked" };
      continue;
    }
    const index = nextEvents.findIndex((event) => event.eventId === result.eventId);
    if (index < 0) continue;
    const current = nextEvents[index];
    const tried = result.wrote !== false && result.kind !== "backoff_wait";
    const delay = Number.isFinite(result.retryAfterMs) ? result.retryAfterMs : result.pause === "rate_limit" ? 60_000 : 5_000;
    nextEvents[index] = {
      ...current,
      attempts: tried ? (current.attempts || 0) + 1 : current.attempts || 0,
      notBefore: now + delay,
      lastKind: result.kind || result.pause || "",
    };
  }
  return { events: nextEvents, outbox: nextOutbox };
}

export async function flushOutbox({ fetchImpl, target, token, events, random = Math.random, maxAttempts = 5, manual = false }) {
  const writer = createWriter();
  return writer.run(async () => {
    const results = [];
    const privacy = await verifyPrivate(fetchImpl, target, token);
    if (!privacy.ok) {
      for (const event of events) {
        results.push({
          eventId: event.eventId,
          ack: false,
          ...safeSyncError(privacy),
          kept: true,
          wrote: false,
          retryAfterMs: privacy.retryAfterMs ?? null,
        });
      }
      return { results, pause: privacy.pause || privacy.kind || "unverified", wrote: false, retryAfterMs: privacy.retryAfterMs ?? null };
    }
    let pause = null;
    let pauseDelay = null;
    for (const event of events) {
      if (pause) {
        results.push({
          eventId: event.eventId,
          ack: false,
          pause,
          kept: true,
          wrote: false,
          retryAfterMs: pauseDelay,
        });
        continue;
      }
      const attempts = event.attempts || 0;
      if (!manual && attempts >= maxAttempts) {
        results.push({ eventId: event.eventId, ack: false, kind: "backoff_wait", kept: true, retry: true, wrote: false });
        continue;
      }
      const outcome = await uploadEvent(fetchImpl, { target, token, event, verifiedPrivate: true });
      if (outcome.kind === "public_repo" || outcome.pause === "public") {
        pause = "public";
        results.push({ eventId: event.eventId, ack: false, ...safeSyncError(outcome), kept: true, wrote: false });
        continue;
      }
      if (!outcome.ack && (outcome.pause === "auth" || outcome.pause === "permission" || outcome.pause === "rate_limit")) {
        pause = outcome.pause === "rate_limit" ? "rate_limit" : outcome.pause;
        if (outcome.pause === "rate_limit") pauseDelay = outcome.retryAfterMs ?? 60_000;
        results.push({
          eventId: event.eventId,
          ack: false,
          ...safeSyncError(outcome),
          kept: true,
          retryAfterMs: outcome.retryAfterMs ?? null,
        });
        continue;
      }
      if (outcome.ack) {
        results.push({ eventId: event.eventId, ack: true, kind: outcome.kind, kept: false });
        continue;
      }
      const retryAfterMs = outcome.retryAfterMs || backoffMs(attempts, random);
      results.push({
        eventId: event.eventId,
        ack: false,
        ...safeSyncError(outcome),
        kept: true,
        retry: Boolean(outcome.retry),
        retryAfterMs,
      });
    }
    return { results, pause };
  });
}

/** Sets first, in authored time order. A session marker waits until every referenced set is already acked. */
export function readyToUpload(events, outbox, now) {
  const pending = outbox
    .map((item) => events.find((event) => event.eventId === item.eventId))
    .filter((event) => event && event.status !== "acked" && (!event.notBefore || event.notBefore <= now));
  const acked = new Set(events.filter((event) => event.status === "acked").map((event) => event.eventId));
  const sets = pending
    .filter((event) => event.type !== "session_completed")
    .slice()
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.eventId.localeCompare(b.eventId));
  const markers = pending.filter(
    (event) => event.type === "session_completed" && (event.setEventIds || []).every((id) => acked.has(id))
  );
  return [...sets, ...markers];
}

/** Merge only this flush's metadata; preserve sets added while the network waited. */
export function mergeSyncedState(liveEvents, liveOutbox, updatedEvents, ackedIds) {
  const updates = new Map(updatedEvents.map((event) => [event.eventId, event]));
  const acked = new Set(ackedIds);
  return {
    events: liveEvents.map((event) => updates.get(event.eventId) || event),
    outbox: liveOutbox.filter((item) => !acked.has(item.eventId)),
  };
}
