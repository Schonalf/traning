import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { demoPlan } from "../public/lib/demo-plan.mjs";
import { advancedAfterRest, buildActual, commitAtomic, completionEvent, createMemoryDb, sessionCompletedEvent, skippedSession } from "../public/lib/engine.mjs";
import { dumbbellStepOk, latWeightOk } from "../public/lib/equipment.mjs";
import { buildBackup } from "../public/lib/export.mjs";
import {
  classifyStatus,
  contentsUrl,
  eventPath,
  eventsEqual,
  COMPLETE_MESSAGE,
  base64ToUtf8,
  contentPath,
  formatPlanFetchError,
  formatPlanFetchOk,
  transportPayload,
  uploadEvent,
  utf8ToBase64,
  validateTarget,
  verifyPrivate,
} from "../public/lib/github.mjs";
import { elapsedSeconds, startRest, tickRest } from "../public/lib/rest.mjs";
import { decodePlanFragment, MAX_FRAGMENT_CHARS, normalizeSteps, prescribedWeight, validatePlan } from "../public/lib/schema.mjs";
import { endSessionEarly, estimateSessionSeconds, formatEstimatedDuration, groupSteps, selectSessionSteps, sessionEstimates, stepPriority, unperformedStepIds } from "../public/lib/session-plan.mjs";
import { applySyncResults, flushOutbox, prepareManualRetry, readyToUpload } from "../public/lib/sync.mjs";

const TARGET = { owner: "demo-owner", repo: "training-data", branch: "main" };
const SID = "11111111-1111-4111-8111-111111111111";
const EID = "22222222-2222-4222-8222-222222222222";

function event(over = {}) {
  return {
    eventId: EID,
    sessionId: SID,
    type: "completion",
    stepId: "s1",
    prescribed: { exercise: "Knäböj", load: { unit: "kg", mode: "total", value: null } },
    actual: { weightKg: 0, reps: 5, rir: null, elapsedSeconds: 3 },
    createdAt: "2026-11-09T12:00:00.000Z",
    revisesEventId: null,
    ...over,
  };
}

test("demo plan validates and keeps the four Swedish titles", () => {
  const result = validatePlan(demoPlan());
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.plan.sessions.map((s) => s.title),
    [
      "Styrka 1 – Press och knäböj",
      "Styrka 2 – Rumänsk marklyft och drag",
      "Styrka 3 – Bröstvolym och bärövningar",
      "Kondition – Intervaller och rörlighet",
    ]
  );
  assert.equal(result.plan.demo, true);
  const phases = result.plan.sessions.flatMap((s) => s.steps.map((st) => st.phase));
  for (const phase of ["warmup", "work", "cardio", "recovery", "mobility"]) {
    assert.ok(phases.includes(phase), phase);
  }
  const first = result.plan.sessions[0].steps[0];
  assert.equal(first.phase, "warmup");
  const unknown = result.plan.sessions[0].steps[1];
  assert.equal(prescribedWeight(unknown).value, null);
  assert.notEqual(prescribedWeight(unknown).value, 0);
});

test("schema rejects oversized plans, bad types, and prototype settings", () => {
  const huge = demoPlan();
  huge.sessions[0].steps[0].notes = "x".repeat(90_000);
  assert.equal(validatePlan(huge).ok, false);
  const polluted = demoPlan();
  polluted.token = "should-not-survive";
  polluted.owner = "evil";
  polluted.sessions[0].steps[0].__proto__ = { admin: true };
  polluted.sessions[0].steps[0].onerror = "alert(1)";
  const ok = validatePlan(polluted);
  assert.equal(ok.ok, true);
  assert.equal(JSON.stringify(ok.plan).includes("should-not-survive"), false);
  assert.equal("token" in ok.plan, false);
  assert.equal("owner" in ok.plan, false);
  const bad = demoPlan();
  bad.sessions[0].steps[0].reps = { target: 500 };
  assert.equal(validatePlan(bad).ok, false);
  const script = demoPlan();
  script.sessions[0].steps[0].exercise = "<img src=x onerror=alert(1)>";
  const xss = validatePlan(script);
  assert.equal(xss.ok, true);
  assert.equal(xss.plan.sessions[0].steps[0].exercise.includes("<img"), true);
});

test("fragment bounds and decode errors", () => {
  const plan = demoPlan();
  const fragment = `#plan=${encodeURIComponent(JSON.stringify(plan))}`;
  const decoded = decodePlanFragment(fragment);
  assert.equal(decoded.ok, true);
  assert.equal(validatePlan(decoded.input).ok, true);
  assert.equal(decodePlanFragment(`#plan=${"a".repeat(MAX_FRAGMENT_CHARS + 1)}`).reason, "size");
  assert.equal(decodePlanFragment("#plan=%E0%A4%A").reason, "encoding");
  assert.equal(decodePlanFragment("#plan=not-json").ok, false);
});

test("equipment constraints accept only confirmed lat loads", () => {
  assert.equal(dumbbellStepOk(10), true);
  assert.equal(dumbbellStepOk(9.4), true);
  assert.equal(dumbbellStepOk(10.4), false);
  assert.equal(dumbbellStepOk(7.3), true);
  assert.equal(dumbbellStepOk(12.499), false);
  assert.equal(dumbbellStepOk(12), false);
  assert.equal(dumbbellStepOk(12.5), true);
  assert.equal(dumbbellStepOk(11), false);
  assert.equal(latWeightOk(59), true);
  assert.equal(latWeightOk(66), true);
  assert.equal(latWeightOk(60), false);
  assert.equal(latWeightOk(73), false);
  assert.equal(latWeightOk(73.5), false);
  assert.equal(latWeightOk(58), false);
  const plan = demoPlan();
  plan.sessions[1].steps[2].load.value = 60;
  assert.equal(validatePlan(plan).ok, false);
  plan.sessions[1].steps[2].load.value = 59;
  assert.equal(validatePlan(plan).ok, true);
  plan.sessions[1].steps[2].load.value = 66;
  assert.equal(validatePlan(plan).ok, true);
});

test("actuals keep zero and null apart from prescription", () => {
  const step = validatePlan(demoPlan()).plan.sessions[0].steps[1];
  const empty = buildActual(step, { weight: "", reps: "5", rir: "" });
  assert.equal(empty.ok, false);
  const zero = buildActual(step, { weight: "0", reps: "0", rir: "0", elapsedSeconds: 4 });
  assert.equal(zero.ok, true);
  assert.equal(zero.actual.weightKg, 0);
  assert.equal(zero.actual.reps, 0);
  assert.equal(zero.actual.rir, 0);
  const comma = buildActual(step, { weight: "12,5", reps: "5", rir: "" });
  assert.equal(comma.ok, true);
  assert.equal(comma.actual.weightKg, 12.5);
  assert.equal(comma.actual.rir, null);
  const saved = completionEvent({
    sessionId: SID,
    step,
    actual: zero.actual,
    nowIso: "2026-11-09T00:00:00.000Z",
    meta: { sessionTitle: "Styrka 1 – Press och knäböj", catalogId: "styrka-1", planId: "demo", sessionType: "strength", planDemo: true, token: "gho_no" },
  });
  assert.equal(saved.prescribed.load.value, null);
  assert.equal(saved.actual.weightKg, 0);
  assert.equal(saved.sessionTitle, "Styrka 1 – Press och knäböj");
  assert.equal(saved.catalogId, "styrka-1");
  assert.equal(saved.sessionType, "strength");
  assert.equal("token" in saved, false);
  assert.notEqual(saved.prescribed.load.value, saved.actual.weightKg);
});

test("explicit step order is kept, including per-exercise warmups and superset rounds", () => {
  const plan = demoPlan();
  const session = plan.sessions[0];
  session.steps = [
    { ...session.steps[0], id: "a-wu", exercise: "A uppvärmning", phase: "warmup" },
    { ...session.steps[1], id: "a-work", exercise: "A", phase: "work" },
    { ...session.steps[0], id: "b-wu", exercise: "B uppvärmning", phase: "warmup" },
    { ...session.steps[1], id: "b-work", exercise: "B", phase: "work" },
    { ...session.steps[2], id: "A1", exercise: "Press", phase: "work", supersetGroup: "runda", supersetOrder: 1 },
    { ...session.steps[2], id: "B1", exercise: "Flyes", phase: "work", supersetGroup: "runda", supersetOrder: 2 },
    { ...session.steps[2], id: "A2", exercise: "Press", phase: "work", supersetGroup: "runda", supersetOrder: 1 },
    { ...session.steps[2], id: "B2", exercise: "Flyes", phase: "work", supersetGroup: "runda", supersetOrder: 2 },
  ];
  const result = validatePlan(plan);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.plan.sessions[0].steps.map((step) => step.id),
    ["a-wu", "a-work", "b-wu", "b-work", "A1", "B1", "A2", "B2"]
  );
  const swapped = [
    { id: "B1", supersetGroup: "runda", supersetOrder: 2, phase: "work" },
    { id: "A1", supersetGroup: "runda", supersetOrder: 1, phase: "work" },
  ];
  assert.deepEqual(normalizeSteps(swapped).map((step) => step.id), ["B1", "A1"]);
  plan.sessions[0].steps[1].id = "a-wu";
  assert.equal(validatePlan(plan).ok, false);
});

test("skip and rest copies do not mutate the live session", () => {
  const session = { id: SID, stepIndex: 0, phase: "step", stepStartedAt: 5, skipped: [], rest: { deadline: 9 }, planSnapshot: { steps: [{ id: "a" }, { id: "b" }] } };
  const skipped = skippedSession(session, 50);
  assert.equal(session.stepIndex, 0);
  assert.equal(session.phase, "step");
  assert.equal(skipped.stepIndex, 1);
  assert.notEqual(skipped.skipped, session.skipped);
  const advanced = advancedAfterRest(session, { signaled: true }, 80);
  assert.equal(session.phase, "step");
  assert.equal(session.stepIndex, 0);
  assert.equal(advanced.phase, "step");
  assert.equal(advanced.stepIndex, 1);
});

test("double confirm and persist failure do not advance memory", () => {
  const db = createMemoryDb();
  const session = { id: SID, stepIndex: 0 };
  const ev = event();
  commitAtomic(db, { session: { ...session, stepIndex: 1 }, event: ev, outbox: { id: ev.eventId } });
  assert.equal(db.events.length, 1);
  assert.equal(db.sessions[0].stepIndex, 1);
  db.failNext = true;
  assert.throws(() =>
    commitAtomic(db, { session: { ...session, stepIndex: 2 }, event: event({ eventId: "33333333-3333-4333-8333-333333333333" }), outbox: { id: "x" } })
  );
  assert.equal(db.sessions[0].stepIndex, 1);
  assert.equal(db.events.length, 1);
  let locked = false;
  function confirm() {
    if (locked) return "ignored";
    locked = true;
    return "saved";
  }
  assert.equal(confirm(), "saved");
  assert.equal(confirm(), "ignored");
});

test("rest beeps once, skips stale and long suspension, guards clock", () => {
  const rest = startRest(1_000, 10);
  const mid = tickRest(rest, 4_000, { visible: true });
  assert.equal(mid.beep, false);
  assert.equal(mid.advance, false);
  const due = tickRest(mid.state, 11_000, { visible: true });
  assert.equal(due.beep, true);
  const again = tickRest(due.state, 11_200, { visible: true });
  assert.equal(again.beep, false);
  const suspended = tickRest(rest, 30_000, { visible: false });
  assert.equal(suspended.beep, false);
  assert.equal(suspended.state.signaled, true);
  const lateVisible = tickRest(rest, 20_000, { visible: true });
  assert.equal(lateVisible.beep, false);
  const back = tickRest(mid.state, 100, { visible: true });
  assert.equal(back.clockGuarded, true);
  assert.equal(back.beep, false);
});

test("mobility elapsed does not imply auto-advance", () => {
  assert.equal(elapsedSeconds(1000, 25_000), 24);
  assert.equal(elapsedSeconds(5000, 1000), 0);
  const autoAdvance = false;
  assert.equal(autoAdvance, false);
});

test("targets reject traversal and public repos get no writes", async () => {
  assert.equal(validateTarget(TARGET).ok, true);
  assert.equal(validateTarget({ owner: "a/b", repo: "r", branch: "main" }).ok, false);
  assert.equal(validateTarget({ owner: "abc", repo: "..", branch: "main" }).ok, false);
  assert.equal(validateTarget({ owner: "abc", repo: "r", branch: "main/../../x" }).ok, false);
  assert.throws(() => eventPath("../x", EID));
  assert.throws(() => contentsUrl(TARGET, "sessions/../../etc/passwd"));
  const url = contentsUrl(TARGET, eventPath(SID, EID));
  assert.equal(url.includes("access_token"), false);
  assert.equal(url.startsWith("https://api.github.com/"), true);
  let puts = 0;
  const fetchImpl = async (resource, init) => {
    if ((init?.method || "GET") === "PUT") puts += 1;
    return jsonResponse({ private: false }, 200);
  };
  const result = await uploadEvent(fetchImpl, { target: TARGET, token: "gho_secret", event: event() });
  assert.equal(result.ack, false);
  assert.equal(result.kind, "public_repo");
  assert.equal(puts, 0);
  assert.equal(JSON.stringify(result).includes("gho_secret"), false);
});

test("ack after retry, lost response, 409 match, and error classes", async () => {
  assert.equal(classifyStatus(401).pause, "auth");
  assert.equal(classifyStatus(403, {}, { message: "Resource not accessible" }).kind, "permission");
  assert.equal(classifyStatus(403, { "x-ratelimit-remaining": "0" }).kind, "rate_limit");
  assert.equal(classifyStatus(429, { "retry-after": "9" }).retryAfterMs, 9000);
  assert.equal(classifyStatus(503).retry, true);
  assert.equal(classifyStatus(409).reconcile, true);

  const body = event();
  const fetchLost = async (resource, init) => {
    const method = init?.method || "GET";
    if (method === "GET" && String(resource).endsWith("/training-data")) return jsonResponse({ private: true }, 200);
    if (method === "PUT") throw new Error("socket hang up");
    if (method === "GET") return jsonResponse({ content: utf8ToBase64(JSON.stringify(body)), sha: "abc" }, 200);
    throw new Error("unexpected");
  };
  const lost = await uploadEvent(fetchLost, { target: TARGET, token: "mem", event: body });
  assert.equal(lost.ack, true);
  assert.equal(lost.kind, "reconciled");

  let putCount = 0;
  const fetchConflict = async (resource, init) => {
    const method = init?.method || "GET";
    if (method === "GET" && String(resource).endsWith("/training-data")) return jsonResponse({ private: true }, 200);
    if (method === "PUT") {
      putCount += 1;
      return jsonResponse({ message: "conflict" }, 409);
    }
    return jsonResponse({ content: utf8ToBase64(JSON.stringify(body)) }, 200);
  };
  const conflict = await uploadEvent(fetchConflict, { target: TARGET, token: "mem", event: body });
  assert.equal(conflict.ack, true);
  assert.equal(putCount, 1);
  assert.equal(eventsEqual(body, { ...body }), true);

  const mismatch = { ...body, actual: { ...body.actual, reps: 9 } };
  const fetchMismatch = async (resource, init) => {
    const method = init?.method || "GET";
    if (String(resource).endsWith("/training-data") && method === "GET") return jsonResponse({ private: true }, 200);
    if (method === "PUT") return jsonResponse({}, 409);
    return jsonResponse({ content: utf8ToBase64(JSON.stringify(mismatch)) }, 200);
  };
  const bad = await uploadEvent(fetchMismatch, { target: TARGET, token: "mem", event: body });
  assert.equal(bad.ack, false);

  let calls = 0;
  const fetchRetry = async (resource, init) => {
    const method = init?.method || "GET";
    if (method === "GET" && String(resource).endsWith("/training-data")) return jsonResponse({ private: true }, 200);
    if (method === "PUT") {
      calls += 1;
      if (calls === 1) return jsonResponse({ message: "boom" }, 502);
      return jsonResponse({ content: {} }, 201);
    }
    return jsonResponse({}, 404);
  };
  const first = await uploadEvent(fetchRetry, { target: TARGET, token: "mem", event: body });
  assert.equal(first.ack, false);
  assert.equal(first.kind, "server");
  const second = await uploadEvent(fetchRetry, { target: TARGET, token: "mem", event: body, privateOk: true });
  assert.equal(second.ack, true);
});

test("flush pauses on 401 and never drops events", async () => {
  const fetchImpl = async (resource, init) => {
    if ((init?.method || "GET") === "GET") return jsonResponse({ message: "bad" }, 401);
    return jsonResponse({}, 201);
  };
  const flushed = await flushOutbox({
    fetchImpl,
    target: TARGET,
    token: "mem",
    events: [event(), event({ eventId: "33333333-3333-4333-8333-333333333333" })],
  });
  assert.equal(flushed.pause, "auth");
  assert.equal(flushed.results.every((item) => item.kept), true);
  assert.equal(flushed.results.some((item) => item.ack), false);
});

test("backup and service worker exclude tokens", () => {
  const backup = buildBackup({
    plan: demoPlan(),
    sessions: [{ id: "s", token: "gho_secret" }],
    events: [{ eventId: EID, authorization: "Bearer gho_secret", actual: { weightKg: 10 } }],
  });
  const text = JSON.stringify(backup);
  assert.equal(text.includes("gho_secret"), false);
  assert.equal(text.includes("Bearer"), false);
  const sw = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.equal(sw.includes("api.github.com"), false);
  assert.match(sw, /ALLOW/);
  assert.match(sw, /atlas-static-/);
  assert.match(sw, /startsWith\(CACHE_PREFIX\)/);
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /connect-src 'self' https:\/\/api\.github\.com/);
  assert.equal(html.includes("fonts.googleapis"), false);
});

test("failed privacy check writes nothing for a multi-event batch", async () => {
  let puts = 0;
  const fetchImpl = async (_resource, init) => {
    if ((init?.method || "GET") === "PUT") puts += 1;
    return jsonResponse({ message: "unavailable" }, 503);
  };
  const flushed = await flushOutbox({
    fetchImpl,
    target: TARGET,
    token: "mem",
    events: [event(), event({ eventId: "33333333-3333-4333-8333-333333333333" })],
  });
  assert.equal(puts, 0);
  assert.equal(flushed.results.length, 2);
  assert.equal(flushed.results.every((item) => item.kept && item.wrote === false && !item.ack), true);
});

test("privateOk from a caller does not skip the privacy check", async () => {
  let puts = 0;
  const fetchImpl = async (_resource, init) => {
    if ((init?.method || "GET") === "PUT") puts += 1;
    return jsonResponse({ private: false }, 200);
  };
  const result = await uploadEvent(fetchImpl, { target: TARGET, token: "mem", event: event(), privateOk: true, verifiedPrivate: false });
  assert.equal(result.ack, false);
  assert.equal(result.kind, "public_repo");
  assert.equal(puts, 0);
});

test("rate limit stops the batch and honors Retry-After", async () => {
  let puts = 0;
  const fetchImpl = async (resource, init) => {
    const method = init?.method || "GET";
    if (method === "GET" && String(resource).endsWith("/training-data")) return jsonResponse({ private: true }, 200);
    if (method === "PUT") {
      puts += 1;
      return jsonResponse({ message: "slow down" }, 429, { "retry-after": "12" });
    }
    return jsonResponse({}, 404);
  };
  const flushed = await flushOutbox({
    fetchImpl,
    target: TARGET,
    token: "mem",
    events: [event(), event({ eventId: "33333333-3333-4333-8333-333333333333" })],
  });
  assert.equal(puts, 1);
  assert.equal(flushed.pause, "rate_limit");
  assert.equal(flushed.results[1].wrote, false);
  assert.equal(flushed.results[0].retryAfterMs, 12000);
  assert.equal(flushed.results.every((item) => item.ack === false), true);
  const now = 1_700_000_000_000;
  const reset = classifyStatus(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((now + 30_000) / 1000) }, {}, now);
  assert.equal(reset.kind, "rate_limit");
  assert.equal(reset.retryAfterMs, 30_000);
});

test("409 with a missing file retries a bounded number of puts", async () => {
  let puts = 0;
  const body = event();
  const fetchImpl = async (resource, init) => {
    const method = init?.method || "GET";
    if (method === "GET" && String(resource).endsWith("/training-data")) return jsonResponse({ private: true }, 200);
    if (method === "PUT") {
      puts += 1;
      if (puts < 3) return jsonResponse({ message: "conflict" }, 409);
      return jsonResponse({}, 201);
    }
    return jsonResponse({ message: "missing" }, 404);
  };
  const result = await uploadEvent(fetchImpl, { target: TARGET, token: "mem", event: body, verifiedPrivate: true });
  assert.equal(result.ack, true);
  assert.equal(puts, 3);
  let stuckPuts = 0;
  const stuckFetch = async (resource, init) => {
    const method = init?.method || "GET";
    if (method === "PUT") {
      stuckPuts += 1;
      return jsonResponse({ message: "conflict" }, 409);
    }
    return jsonResponse({ message: "missing" }, 404);
  };
  const stuck = await uploadEvent(stuckFetch, { target: TARGET, token: "mem", event: body, verifiedPrivate: true });
  assert.equal(stuck.ack, false);
  assert.equal(stuckPuts, 3);
});

test("lost PUT still acks the same id when a later 409 returns the original payload", async () => {
  const body = event();
  const dirty = { ...body, id: body.eventId, status: "pending", attempts: 1, notBefore: 9, lastKind: "network" };
  let stored = null;
  let puts = 0;
  let contentGets = 0;
  const fetchImpl = async (resource, init) => {
    const method = init?.method || "GET";
    if (method === "GET" && String(resource).endsWith("/training-data")) return jsonResponse({ private: true }, 200);
    if (method === "PUT") {
      puts += 1;
      const sent = JSON.parse(base64ToUtf8(JSON.parse(init.body).content));
      assert.equal(sent.attempts, undefined);
      assert.equal(sent.status, undefined);
      assert.equal(sent.eventId, body.eventId);
      assert.deepEqual(sent, transportPayload(dirty));
      if (puts === 1) {
        stored = sent;
        throw new Error("lost response");
      }
      return jsonResponse({ message: "conflict" }, 409);
    }
    contentGets += 1;
    if (contentGets === 1) throw new Error("lost get");
    return jsonResponse({ content: utf8ToBase64(JSON.stringify(stored)) }, 200);
  };
  const first = await uploadEvent(fetchImpl, { target: TARGET, token: "mem", event: dirty, verifiedPrivate: true });
  assert.equal(first.ack, false);
  const reloaded = { ...dirty, attempts: 4, lastKind: "server", notBefore: 0 };
  const second = await uploadEvent(fetchImpl, { target: TARGET, token: "mem", event: reloaded, verifiedPrivate: true });
  assert.equal(second.ack, true);
  assert.equal(second.kind, "reconciled");
  assert.equal(puts, 2);
  assert.equal(stored.eventId, body.eventId);
});

test("manual retry clears the attempt budget without bypassing Retry-After", async () => {
  const row = { ...event(), attempts: 5, notBefore: Date.now() + 60_000, status: "pending" };
  const outbox = [{ id: row.eventId, eventId: row.eventId }];
  const prepared = prepareManualRetry([row], outbox);
  assert.equal(row.attempts, 5);
  assert.equal(prepared[0].attempts, 0);
  assert.ok(prepared[0].notBefore > Date.now());
  let puts = 0;
  const fetchImpl = async (resource, init) => {
    const method = init?.method || "GET";
    if (method === "GET" && String(resource).endsWith("/training-data")) return jsonResponse({ private: true }, 200);
    if (method === "PUT") {
      puts += 1;
      return jsonResponse({}, 201);
    }
    return jsonResponse({}, 404);
  };
  const blocked = await flushOutbox({ fetchImpl, target: TARGET, token: "mem", events: [row] });
  assert.equal(puts, 0);
  assert.equal(blocked.results[0].kind, "backoff_wait");
  const allowed = await flushOutbox({ fetchImpl, target: TARGET, token: "mem", events: prepared, manual: true });
  assert.equal(allowed.results[0].ack, true);
  assert.equal(puts, 1);
});

test("privacy 429 and 403 rate limit cool down every queued event and write nothing", async () => {
  let puts = 0;
  const fetch429 = async (_resource, init) => {
    if ((init?.method || "GET") === "PUT") puts += 1;
    return jsonResponse({ message: "slow" }, 429, { "retry-after": "15" });
  };
  const limited = await flushOutbox({
    fetchImpl: fetch429,
    target: TARGET,
    token: "mem",
    events: [event(), event({ eventId: "33333333-3333-4333-8333-333333333333" })],
  });
  assert.equal(puts, 0);
  assert.equal(limited.pause, "rate_limit");
  assert.equal(limited.results.every((item) => item.retryAfterMs === 15000 && item.wrote === false && item.kept), true);
  const now = Date.now();
  const applied = applySyncResults(
    [event(), event({ eventId: "33333333-3333-4333-8333-333333333333", attempts: 1 })],
    [
      { id: EID, eventId: EID },
      { id: "33333333-3333-4333-8333-333333333333", eventId: "33333333-3333-4333-8333-333333333333" },
    ],
    limited.results,
    now
  );
  assert.equal(applied.events[0].attempts || 0, 0);
  assert.equal(applied.events[1].attempts, 1);
  assert.ok(applied.events.every((item) => item.notBefore >= now + 15000));
  const resetAt = Math.floor(Date.now() / 1000) + 30;
  const fetch403 = async (_resource, init) => {
    if ((init?.method || "GET") === "PUT") puts += 1;
    return jsonResponse({ message: "rate limit" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt) });
  };
  const reset = await flushOutbox({
    fetchImpl: fetch403,
    target: TARGET,
    token: "mem",
    events: [event(), event({ eventId: "33333333-3333-4333-8333-333333333333" })],
  });
  assert.equal(puts, 0);
  assert.equal(reset.pause, "rate_limit");
  assert.ok(reset.results.every((item) => item.retryAfterMs >= 29_000 && item.retryAfterMs <= 30_000));
});

test("applySyncResults publishes nothing until the caller keeps the copy", () => {
  const events = [{ ...event(), status: "pending", attempts: 2 }];
  const outbox = [{ id: EID, eventId: EID }];
  const applied = applySyncResults(events, outbox, [{ eventId: EID, ack: true }], Date.now());
  assert.equal(events[0].status, "pending");
  assert.equal(outbox.length, 1);
  assert.equal(applied.events[0].status, "acked");
  assert.equal(applied.outbox.length, 0);
});

test("session end marker is honest, stable, and withheld until set acks", async () => {
  const done = {
    id: SID,
    phase: "done",
    title: "Styrka 1 – Press och knäböj",
    catalogId: "styrka-1",
    planId: "demo",
    sessionType: "strength",
    planDemo: true,
    skipped: ["warm"],
    completionMarkerId: EID,
    completedAt: "2026-11-09T12:00:00.000Z",
  };
  const set = event({ eventId: "33333333-3333-4333-8333-333333333333", type: "completion", stepId: "work" });
  const marker = sessionCompletedEvent({ session: done, events: [set], nowIso: done.completedAt, eventId: EID });
  assert.equal(marker.outcome, "completed_with_skips");
  assert.equal(sessionCompletedEvent({ session: { ...done, skipped: [] }, events: [set], nowIso: done.completedAt, eventId: EID }).outcome, "completed");
  assert.deepEqual(marker.setEventIds, [set.eventId]);
  assert.deepEqual(marker.skippedStepIds, ["warm"]);
  assert.equal(marker.prescribed, undefined);
  assert.equal(contentPath(marker), `sessions/${SID}/completed.json`);
  const skipsOnly = sessionCompletedEvent({ session: { ...done, skipped: ["a", "b"] }, events: [], nowIso: done.completedAt, eventId: EID });
  assert.equal(skipsOnly.outcome, "completed_with_skips");
  assert.deepEqual(skipsOnly.setEventIds, []);
  const dirty = { ...marker, token: "gho_secret", attempts: 3, status: "pending", id: EID, notBefore: 1 };
  const clean = transportPayload(dirty);
  assert.equal(clean.token, undefined);
  assert.equal(clean.attempts, undefined);
  assert.equal(clean.status, undefined);
  const pendingSet = { ...set, status: "pending", createdAt: "2026-11-09T12:00:01.000Z" };
  const earlier = { ...event(), status: "pending", createdAt: "2026-11-09T11:00:00.000Z", eventId: "44444444-4444-4444-8444-444444444444" };
  const queued = [
    { id: marker.eventId, eventId: marker.eventId },
    { id: pendingSet.eventId, eventId: pendingSet.eventId },
    { id: earlier.eventId, eventId: earlier.eventId },
  ];
  const first = readyToUpload([dirty, pendingSet, earlier], queued, Date.now());
  assert.deepEqual(first.map((item) => item.eventId), [earlier.eventId, pendingSet.eventId]);
  pendingSet.status = "acked";
  earlier.status = "acked";
  const second = readyToUpload([dirty, pendingSet, earlier], queued, Date.now());
  assert.deepEqual(second.map((item) => item.eventId), [marker.eventId]);
  let puts = 0;
  let stored = null;
  const fetchImpl = async (resource, init) => {
    const method = init?.method || "GET";
    if (method === "PUT") {
      puts += 1;
      const body = JSON.parse(init.body);
      assert.equal(body.message, COMPLETE_MESSAGE);
      const sent = JSON.parse(base64ToUtf8(body.content));
      assert.equal(sent.token, undefined);
      if (puts === 1) {
        stored = sent;
        throw new Error("lost");
      }
      return jsonResponse({ message: "conflict" }, 409);
    }
    if (String(resource).includes("/completed.json")) {
      if (!stored || puts < 2) throw new Error("lost get");
      return jsonResponse({ content: utf8ToBase64(JSON.stringify(stored)) }, 200);
    }
    return jsonResponse({ private: true }, 200);
  };
  const lost = await uploadEvent(fetchImpl, { target: TARGET, token: "mem", event: dirty, verifiedPrivate: true });
  assert.equal(lost.ack, false);
  const again = await uploadEvent(fetchImpl, { target: TARGET, token: "mem", event: { ...dirty, attempts: 4 }, verifiedPrivate: true });
  assert.equal(again.ack, true);
  assert.equal(again.kind, "reconciled");
  assert.equal(puts, 2);
  assert.equal(stored.eventId, EID);
});

test("verifyPrivate refuses a public repository", async () => {
  const res = await verifyPrivate(async () => jsonResponse({ private: false }, 200), TARGET, "mem");
  assert.equal(res.ok, false);
  assert.equal(res.kind, "public_repo");
});

test("plan fetch user messages are Swedish and status-aware", () => {
  assert.match(formatPlanFetchError({ kind: "client", status: 404 }), /404/);
  assert.match(formatPlanFetchError({ kind: "client", status: 404 }), /Owner\/Repo/);
  assert.match(formatPlanFetchError({ kind: "auth", status: 401 }), /401/);
  assert.match(formatPlanFetchError({ kind: "permission", status: 403 }), /behörighet/);
  assert.match(formatPlanFetchError({ kind: "rate_limit", status: 429 }), /rate limit/);
  assert.match(formatPlanFetchError({ kind: "server", status: 503 }), /503/);
  assert.match(formatPlanFetchError({ kind: "network", status: 0 }), /Nätverksfel/);
  assert.equal(formatPlanFetchError({ kind: "client", status: 404 }).includes("https://"), false);
  assert.equal(formatPlanFetchError({ kind: "auth", status: 401 }).includes("gho_"), false);
  const when = new Date("2026-11-09T19:40:00.000Z");
  const ok = formatPlanFetchOk({ title: "Block 1", sessions: [{}, {}, {}, {}] }, when);
  assert.match(ok, /^Planen hämtad: Block 1, 4 pass,/);
  assert.match(formatPlanFetchOk({ title: "  ", sessions: [] }, when), /utan titel, 0 pass/);
});

function jsonResponse(body, status, headers = {}) {
  return {
    status,
    headers: {
      forEach(fn) {
        for (const [key, value] of Object.entries(headers)) fn(value, key);
      },
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

test("sync publication preserves a set enqueued while the network request was pending", async () => {
  const { mergeSyncedState } = await import("../public/lib/sync.mjs");
  const first = { eventId: "first", status: "pending" };
  const later = { eventId: "later", status: "pending" };
  const liveOutbox = [{ id: "first", eventId: "first" }, { id: "later", eventId: "later" }];
  const merged = mergeSyncedState([first, later], liveOutbox, [{ ...first, status: "acked" }], ["first"]);
  assert.equal(merged.events.length, 2);
  assert.equal(merged.events[0].status, "acked");
  assert.deepEqual(merged.events[1], later);
  assert.deepEqual(merged.outbox, [liveOutbox[1]]);
  assert.equal(liveOutbox.length, 2);
});

test("a partly skipped session never claims an unqualified completed outcome", () => {
  const marker = sessionCompletedEvent({
    session: { id: SID, skipped: ["skipped-step"], title: "DEMO", planId: "demo" },
    events: [event()], nowIso: "2026-11-09T12:00:00.000Z", eventId: "33333333-3333-4333-8333-333333333333",
  });
  assert.equal(marker.outcome, "completed_with_skips");
  assert.deepEqual(marker.setEventIds, [EID]);
  assert.deepEqual(marker.skippedStepIds, ["skipped-step"]);
});

test("service-worker cache namespaces are isolated by registration scope", async () => {
  const vm = await import("node:vm");
  const worker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  const cacheAt = (scope) => vm.runInNewContext(worker + "\nCACHE;", { self: { registration: { scope }, addEventListener() {} } });
  assert.notEqual(cacheAt("https://example.test/"), cacheAt("https://example.test/traning/"));
  assert.notEqual(cacheAt("https://example.test/traning/"), cacheAt("https://example.test/other/"));
});

test("plans without priority validate and default to 2", () => {
  const plan = demoPlan();
  for (const session of plan.sessions) {
    for (const step of session.steps) delete step.priority;
  }
  const result = validatePlan(plan);
  assert.equal(result.ok, true);
  for (const step of result.plan.sessions.flatMap((session) => session.steps)) {
    assert.equal(step.priority, 2);
    assert.equal(stepPriority({}), 2);
  }
  const quick = selectSessionSteps(result.plan.sessions[0], "quick");
  assert.equal(quick.steps.length, 0);
  assert.ok(quick.omittedExercises.length > 0);
});

test("priority is accepted backward-compatibly and rejected when out of range", () => {
  const plan = demoPlan();
  plan.sessions[0].steps[0].priority = 1;
  plan.sessions[0].steps[1].priority = 3;
  assert.equal(validatePlan(plan).ok, true);
  plan.sessions[0].steps[1].priority = 4;
  assert.equal(validatePlan(plan).ok, false);
  plan.sessions[0].steps[1].priority = 0;
  assert.equal(validatePlan(plan).ok, false);
  plan.sessions[0].steps[1].priority = 1.5;
  assert.equal(validatePlan(plan).ok, false);
});

test("quick session keeps prio 1 warmups and plan order, and omits the rest", () => {
  const catalog = {
    id: "s3",
    title: "S3",
    steps: [
      { id: "press-wu", exercise: "Lutande hantelpress", phase: "warmup", priority: 1, reps: { target: 8 }, restSeconds: 60 },
      { id: "press-1", exercise: "Lutande hantelpress", phase: "work", priority: 1, reps: { target: 10 }, restSeconds: 180 },
      { id: "dips-1", exercise: "Dips", phase: "work", priority: 2, reps: { target: 8 }, restSeconds: 120 },
      { id: "calf-wu-l", exercise: "Sittande vadpress – vänster", phase: "warmup", priority: 1, reps: { target: 5 }, restSeconds: 30 },
      { id: "calf-wu-r", exercise: "Sittande vadpress – höger", phase: "warmup", priority: 1, reps: { target: 5 }, restSeconds: 30 },
      { id: "calf-1", exercise: "Sittande vadpress, ett ben – vänster", phase: "work", priority: 1, reps: { target: 12 }, restSeconds: 15 },
      { id: "flyes-1", exercise: "Lutande hantelflyes", phase: "work", priority: 3, reps: { target: 10 }, restSeconds: 90 },
      { id: "wrist-1", exercise: "Handledscurl, handflata upp", phase: "work", priority: 1, reps: { target: 8 }, restSeconds: 75 },
    ],
  };
  const missing = { id: "no-prio", exercise: "Benpress", phase: "work", reps: { target: 10 }, restSeconds: 150 };
  catalog.steps.splice(3, 0, missing);
  const full = selectSessionSteps(catalog, "full");
  assert.deepEqual(full.steps.map((step) => step.id), catalog.steps.map((step) => step.id));
  const quick = selectSessionSteps(catalog, "quick");
  assert.deepEqual(
    quick.steps.map((step) => step.id),
    ["press-wu", "press-1", "calf-wu-l", "calf-wu-r", "calf-1", "wrist-1"]
  );
  assert.ok(quick.steps.some((step) => step.phase === "warmup"));
  assert.deepEqual(quick.omittedExercises, ["Dips", "Benpress", "Lutande hantelflyes"]);
  const keys = groupSteps(catalog.steps).map((group) => group.key);
  assert.ok(keys.includes("Sittande vadpress"));
  assert.equal(groupSteps(catalog.steps).find((group) => group.key === "Sittande vadpress").priority, 1);
  const estimates = sessionEstimates(catalog);
  assert.ok(estimates.fullSeconds > estimates.quickSeconds);
  assert.match(estimates.fullLabel, /^ca \d+ min$/);
  assert.match(formatEstimatedDuration(estimateSessionSeconds(quick.steps)), /^ca \d+ min$/);
});

test("early-end payload marks time pressure and leaves the completed.json path unchanged", () => {
  const session = {
    id: SID,
    title: "Styrka 3",
    catalogId: "S3",
    planId: "plan",
    sessionType: "strength",
    planDemo: false,
    mode: "quick",
    omittedExercises: ["Dips", "Bondgång"],
    skipped: ["press-wu"],
    stepIndex: 1,
    phase: "step",
    planSnapshot: { steps: [{ id: "press-wu" }, { id: "press-1" }, { id: "calf-1" }, { id: "wrist-1" }] },
  };
  const finished = endSessionEarly(session, "2026-11-10T08:00:00.000Z");
  assert.equal(session.phase, "step");
  assert.equal(finished.phase, "done");
  assert.equal(finished.endedEarly, true);
  assert.equal(finished.endReason, "time_pressure");
  assert.deepEqual(finished.unperformedStepIds, ["press-1", "calf-1", "wrist-1"]);
  const set = event({ eventId: "33333333-3333-4333-8333-333333333333", type: "completion", stepId: "press-wu" });
  const marker = sessionCompletedEvent({ session: finished, events: [set], nowIso: finished.completedAt, eventId: EID });
  assert.equal(marker.endedEarly, true);
  assert.equal(marker.endReason, "time_pressure");
  assert.deepEqual(marker.unperformedStepIds, ["press-1", "calf-1", "wrist-1"]);
  assert.equal(marker.mode, "quick");
  assert.deepEqual(marker.omittedExercises, ["Dips", "Bondgång"]);
  assert.equal(marker.outcome, "completed_with_skips");
  assert.equal(contentPath(marker), `sessions/${SID}/completed.json`);
  const clean = transportPayload({ ...marker, token: "gho_secret", attempts: 4, status: "pending" });
  assert.equal(clean.endedEarly, true);
  assert.equal(clean.mode, "quick");
  assert.equal(clean.token, undefined);
  assert.equal(clean.attempts, undefined);
  const duringRest = unperformedStepIds({ ...session, phase: "rest", stepIndex: 1 });
  assert.deepEqual(duringRest, ["calf-1", "wrist-1"]);
  const normal = sessionCompletedEvent({
    session: { id: SID, skipped: [], title: "S1" },
    events: [set],
    nowIso: "2026-11-10T08:00:00.000Z",
    eventId: EID,
  });
  assert.equal("endedEarly" in normal, false);
  assert.equal("mode" in normal, false);
});
