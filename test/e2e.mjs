import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { demoPlan } from "../public/lib/demo-plan.mjs";

const port = 4173;
const base = `http://127.0.0.1:${port}`;
const shots = "/workspace/traning-screenshots";
const chrome = "/usr/bin/google-chrome";
const token = "gho_should_never_render";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const server = spawn(process.execPath, ["server.mjs"], {
  env: { ...process.env, PORT: String(port) },
  stdio: "inherit",
});

try {
  await waitForServer();
  await mkdir(shots, { recursive: true });
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    await runShellPaths(browser);
    await runHappy(browser);
    await runMobility(browser);
    await runOffline(browser);
    await runPersistAndFragment(browser);
    await runGithubGuard(browser);
    await runCursorGuards(browser);
    await runWakeFallback(browser);
    await runAckPersistFailure(browser);
    await runEndMarker(browser);
    await runFetchPlanFeedback(browser);
    await runPreviewAndEarlyEnd(browser);
  } finally {
    await browser.close();
  }
  console.log("e2e ok");
} finally {
  server.kill("SIGTERM");
}

async function waitForServer() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(base);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await delay(100);
  }
  throw new Error("server did not start");
}

async function newPage(browser, { audio = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 360, height: 780 } });
  await context.addInitScript(() => {
    globalThis.idbMarkers = () =>
      new Promise((resolve) => {
        const request = indexedDB.open("atlas-training-guided");
        request.onsuccess = () => {
          const tx = request.result.transaction("events").objectStore("events").getAll();
          tx.onsuccess = () => resolve(tx.result.filter((row) => row.type === "session_completed"));
        };
      });
  });
  if (audio) {
    await context.addInitScript(() => {
      globalThis.__beeps = 0;
      class FakeAudio {
        constructor() {
          this.currentTime = 0;
          this.state = "running";
          this.destination = {};
        }
        resume() {}
        createGain() {
          return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
        }
        createOscillator() {
          return {
            frequency: {},
            connect() {},
            start() {
              globalThis.__beeps += 1;
            },
            stop() {},
          };
        }
      }
      globalThis.AudioContext = FakeAudio;
    });
  }
  const page = await context.newPage();
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes(token)) throw new Error("token leaked to console");
  });
  return { context, page };
}

async function startSessionFromHome(page, id, mode = "base") {
  await page.getByTestId(`start-${id}`).click();
  await page.getByTestId("preview-view").waitFor();
  if (mode === "full") await page.getByTestId("mode-full").click();
  await page.getByTestId("confirm-start").click();
}

async function sessionCount(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.open("atlas-training-guided");
        request.onsuccess = () => {
          const tx = request.result.transaction("sessions").objectStore("sessions").getAll();
          tx.onsuccess = () => resolve(tx.result.length);
        };
      })
  );
}

async function runShellPaths(browser) {
  const rootOnly = ["/main.mjs", "/sw.js", "/styles.css", "/manifest.webmanifest", "/icon.svg", "/index.html"];
  {
    const { context, page } = await newPage(browser);
    const paths = [];
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (url.hostname === "127.0.0.1") paths.push(url.pathname);
    });
    await page.goto(`${base}/`);
    await page.getByTestId("disclaimer").waitFor();
    await page.waitForFunction(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return Boolean(reg?.active && new URL(reg.scope).pathname === "/");
    });
    const manifestHref = await page.evaluate(() => document.querySelector('link[rel="manifest"]').href);
    assert(new URL(manifestHref).pathname === "/manifest.webmanifest", "root manifest url");
    const manifest = await (await page.request.get(manifestHref)).json();
    assert(new URL(manifest.start_url, manifestHref).pathname === "/", "root start_url");
    assert(new URL(manifest.scope, manifestHref).pathname === "/", "root scope");
    assert(new URL(manifest.icons[0].src, manifestHref).pathname === "/icon.svg", "root icon");
    const moduleSrc = await page.evaluate(() => document.querySelector("script[type=module]").src);
    assert(new URL(moduleSrc).pathname === "/main.mjs", "root module");
    assert(paths.includes("/main.mjs"), "root loads main");
    assert(paths.some((item) => item.startsWith("/lib/")), "root loads relative modules");
    assert(!paths.some((item) => item.startsWith("/traning")), "root page stays off the prefix");
    await context.close();
  }

  const bare = await fetch(`${base}/traning`, { redirect: "manual" });
  assert(bare.status === 302, "prefix without slash redirects");
  assert(bare.headers.get("location") === "/traning/", "prefix redirect target");

  const { context, page } = await newPage(browser);
  const paths = [];
  const record = (req) => {
    const url = new URL(req.url());
    if (url.hostname === "127.0.0.1") paths.push(url.pathname);
  };
  page.on("request", record);
  context.on("request", record);
  await page.goto(`${base}/traning/`);
  await page.getByTestId("start-styrka-1").waitFor();
  await page.waitForFunction(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return Boolean(reg?.active && new URL(reg.scope).pathname === "/traning/");
  });
  const manifestHref = await page.evaluate(() => document.querySelector('link[rel="manifest"]').href);
  assert(new URL(manifestHref).pathname === "/traning/manifest.webmanifest", "prefix manifest url");
  const manifest = await (await page.request.get(manifestHref)).json();
  assert(new URL(manifest.start_url, manifestHref).pathname === "/traning/", "prefix start_url");
  assert(new URL(manifest.scope, manifestHref).pathname === "/traning/", "prefix manifest scope");
  assert(new URL(manifest.icons[0].src, manifestHref).pathname === "/traning/icon.svg", "prefix icon");
  const moduleSrc = await page.evaluate(() => document.querySelector("script[type=module]").src);
  assert(new URL(moduleSrc).pathname === "/traning/main.mjs", "prefix module");
  const worker = await page.evaluate(() =>
    navigator.serviceWorker.getRegistration().then((reg) => ({
      scope: new URL(reg.scope).pathname,
      script: new URL(reg.active.scriptURL).pathname,
    }))
  );
  assert(worker.scope === "/traning/", "service worker scope is the project prefix");
  assert(worker.script === "/traning/sw.js", "prefix loads the worker");
  for (const item of paths) {
    assert(!rootOnly.includes(item), `origin-root asset requested: ${item}`);
    assert(!item.startsWith("/lib/"), `origin-root module requested: ${item}`);
  }
  assert(paths.includes("/traning/main.mjs"), "prefix loads main");
  assert(paths.some((item) => item.startsWith("/traning/lib/")), "prefix loads relative modules");
  if (!(await page.evaluate(() => navigator.serviceWorker.controller))) {
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller);
  }
  await context.setOffline(true);
  await page.reload();
  await page.getByTestId("start-styrka-1").waitFor();
  await startSessionFromHome(page, "styrka-1");
  await page.getByTestId("step-view").waitFor();
  assert((await page.getByTestId("exercise").innerText()) === "Knäböj", "offline prefix session");
  await context.close();
}

async function runHappy(browser) {
  const { context, page } = await newPage(browser, { audio: true });
  await page.goto(base);
  await startSessionFromHome(page, "styrka-1");
  await page.getByTestId("step-view").waitFor();
  assert((await page.locator("h1").innerText()) === "Styrka 1 – Press och knäböj", "session title in the header");
  assert((await page.getByTestId("exercise").innerText()) === "Knäböj", "first step should be the warmup squat");
  assert((await page.locator("body").innerText()).includes("Uppvärmning"), "phase is Swedish");
  assert((await page.locator("body").innerText()).includes("Skivstång"), "equipment is Swedish");
  await page.screenshot({ path: `${shots}/set-view.png` });
  await page.getByTestId("klar").click();
  await page.getByTestId("klar-dialog").waitFor();
  assert((await page.getByTestId("actual-weight").inputValue()) === "20", "prescription prefilled");
  await page.screenshot({ path: `${shots}/klar-dialog.png` });
  await page.evaluate(() => {
    const button = document.querySelector("[data-testid=confirm]");
    button.click();
    button.click();
  });
  await page.getByTestId("rest-view").waitFor();
  assert((await page.locator("h1").innerText()) === "Styrka 1 – Press och knäböj", "rest keeps the session title");
  await page.screenshot({ path: `${shots}/rest-timer.png` });
  await page.getByText("måste anges").waitFor({ timeout: 12000 });
  assert((await page.evaluate(() => globalThis.__beeps)) === 1, "one beep");
  await delay(400);
  assert((await page.evaluate(() => globalThis.__beeps)) === 1, "no second beep");
  await page.getByTestId("klar").click();
  assert((await page.getByTestId("actual-weight").inputValue()) === "", "unknown stays empty");
  await page.getByTestId("confirm").click();
  await page.getByTestId("form-error").waitFor();
  assert((await page.getByTestId("form-error").innerText()).includes("Ange vikt"), "null is not zero");
  await page.getByTestId("actual-weight").fill("0");
  await page.getByTestId("actual-reps").fill("5");
  await page.getByTestId("actual-rir").fill("0");
  await page.getByTestId("confirm").click();
  await page.waitForFunction(() => document.querySelector("[data-testid=exercise]")?.textContent === "Bänkpress", null, { timeout: 12000 });
  await page.getByTestId("klar").click();
  await page.getByTestId("confirm").click();
  await page.getByTestId("done-view").waitFor();
  await page.getByText("Väntar på server: 4").waitFor();
  assert((await page.locator("h1").innerText()) === "Styrka 1 – Press och knäböj", "done keeps the session title");
  const first = page.locator("[data-testid=event-row]").first();
  const stepId = await first.getAttribute("data-step");
  const eventId = await first.getAttribute("data-event");
  await page.getByTestId(`revise-${eventId}`).click();
  await page.getByTestId("klar-dialog").waitFor();
  assert((await page.getByTestId("actual-reps").inputValue()) === "8", "revision prefills the saved actual");
  await page.getByTestId("actual-reps").fill("3");
  await page.getByTestId("confirm").click();
  await page.getByTestId("done-view").waitFor();
  const revision = page.locator("[data-type=revision]");
  assert((await revision.getAttribute("data-step")) === stepId, "revision targets the first step");
  assert((await revision.getAttribute("data-revises")) === eventId, "revision points at the old event");
  const original = page.locator(`[data-event="${eventId}"]`);
  assert((await original.getAttribute("data-type")) === "completion");
  assert((await original.innerText()).includes("/ 8 reps"), "old completion stays unchanged");
  assert((await revision.innerText()).includes("/ 3 reps"));
  await page.screenshot({ path: `${shots}/completed.png` });
  const body = await page.locator("body").innerText();
  assert(body.includes("utfört 0 kg"), "zero actual kept");
  assert(body.includes("Föreskrivet vikt okänd"), "prescription still unknown");
  assert(!body.includes(token), "no token on completed screen");
  assert((await page.locator("[data-type=session_completed]").count()) === 0, "end marker is not rendered as a set");
  const markers = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.open("atlas-training-guided");
        request.onsuccess = () => {
          const tx = request.result.transaction("events").objectStore("events").getAll();
          tx.onsuccess = () => resolve(tx.result.filter((row) => row.type === "session_completed"));
        };
      })
  );
  assert(markers.length === 1, "one end marker");
  assert(markers[0].outcome === "completed");
  assert(!markers[0].setEventIds.includes(await revision.getAttribute("data-event")), "later revision is not written into the marker");
  await context.close();
}

async function runMobility(browser) {
  const { context, page } = await newPage(browser);
  await page.goto(base);
  await startSessionFromHome(page, "kondition", "full");
  await page.getByTestId("duration-clock").waitFor();
  await page.screenshot({ path: `${shots}/mobility-timer.png` });
  const before = await page.getByTestId("exercise").innerText();
  await page.waitForTimeout(21000);
  const after = await page.getByTestId("exercise").innerText();
  assert(before === after, "duration did not auto-advance");
  assert((await page.getByTestId("duration-clock").innerText()).includes("Över tid"), "overrun stays on the step");
  await page.getByTestId("klar").click();
  await page.getByTestId("confirm").click();
  await page.getByText("Intervallarbete").waitFor();
  await context.close();
}

async function runOffline(browser) {
  const { context, page } = await newPage(browser);
  await page.goto(base);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await startSessionFromHome(page, "styrka-1");
  await page.getByTestId("klar").click();
  await page.getByTestId("confirm").click();
  await page.getByTestId("sync-status").waitFor();
  await page.getByText("Offline. Kö finns bara på telefonen.").waitFor();
  await page.getByText("Väntar på server: 1").waitFor();
  await page.screenshot({ path: `${shots}/offline-queue.png` });
  await page.reload();
  await page.getByText("Väntar på server: 1").waitFor();
  await page.getByTestId("rest-view").waitFor();
  await context.close();
}

async function runPersistAndFragment(browser) {
  const { context, page } = await newPage(browser);
  await page.goto(base);
  await startSessionFromHome(page, "styrka-1");
  await page.getByTestId("klar").click();
  await page.evaluate(() => {
    globalThis.__ATLAS_FORCE_PERSIST_FAIL = true;
  });
  await page.getByTestId("confirm").click();
  await page.getByText("Sparningen misslyckades").waitFor();
  assert((await page.getByTestId("exercise").innerText()) === "Knäböj", "error did not advance");
  const attack = demoPlan();
  attack.id = "fragment-demo";
  attack.sessions[0].steps[0].exercise = "<img src=x onerror=alert(1)>";
  await page.goto(`${base}/#plan=${encodeURIComponent(JSON.stringify(attack))}`);
  await page.getByTestId("exercise").waitFor();
  assert((await page.evaluate(() => location.hash)) === "", "fragment removed");
  assert((await page.locator("img").count()) === 0, "xss stayed text");
  assert((await page.getByTestId("exercise").innerText()) === "Knäböj", "active plan stayed pinned");
  await context.close();

  const fresh = await newPage(browser);
  const big = `#plan=${"a".repeat(20001)}`;
  await fresh.page.goto(base + big);
  await fresh.page.getByText("Fragmentet avvisades").waitFor();
  assert((await fresh.page.evaluate(() => location.hash)) === "", "bad fragment removed");
  await fresh.context.close();
}

async function runGithubGuard(browser) {
  const { context, page } = await newPage(browser);
  let puts = 0;
  await page.route("https://api.github.com/**", async (route) => {
    const method = route.request().method();
    if (method === "PUT") puts += 1;
    const url = route.request().url();
    assert(!url.includes(token), "token must not be in the URL");
    if (url.endsWith("/training-data") || url.includes("/repos/demo-owner/training-data?")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ private: false }) });
      return;
    }
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "bad" }) });
  });
  await page.goto(base);
  await startSessionFromHome(page, "styrka-1");
  await page.getByTestId("klar").click();
  await page.getByTestId("confirm").click();
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("owner").fill("demo-owner");
  await page.getByTestId("repo").fill("training-data");
  await page.getByTestId("branch").fill("main");
  await page.getByTestId("token").fill(token);
  await page.getByTestId("save-settings").click();
  await page.getByTestId("sync-now").click();
  await page.getByText("inte ett privat repo").waitFor({ timeout: 8000 });
  assert(puts === 0, "public repo must not be written");
  const body = await page.locator("body").innerText();
  assert(!body.includes(token), "token not echoed");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export").click()]);
  const exported = await readFile(await download.path(), "utf8");
  assert(!exported.includes(token), "export is token-free");
  assert(!exported.includes("Bearer"), "export has no authorization");
  await context.close();
}

async function runCursorGuards(browser) {
  const { context, page } = await newPage(browser);
  await page.goto(base);
  await page.getByTestId("start-styrka-1").waitFor();
  await page.getByTestId("start-styrka-1").click();
  await page.getByTestId("preview-view").waitFor();
  await page.evaluate(() => {
    const button = document.querySelector("[data-testid=confirm-start]");
    button.click();
    button.click();
  });
  await page.getByTestId("step-view").waitFor();
  const count = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.open("atlas-training-guided");
        request.onsuccess = () => {
          const tx = request.result.transaction("sessions").objectStore("sessions").getAll();
          tx.onsuccess = () => resolve(tx.result.length);
        };
      })
  );
  assert(count === 1, "double start created " + count);
  await page.evaluate(() => {
    globalThis.__ATLAS_FORCE_PERSIST_FAIL = true;
  });
  await page.getByTestId("skip").click();
  assert((await page.getByTestId("exercise").innerText()) === "Knäböj", "failed skip stays");
  await page.evaluate(() => {
    globalThis.__ATLAS_FORCE_PERSIST_FAIL = false;
  });
  await page.getByTestId("klar").click();
  await page.getByTestId("klar-dialog").waitFor();
  await page.getByTestId("confirm").click();
  try {
    await page.getByTestId("rest-view").waitFor({ timeout: 8000 });
  } catch (error) {
    throw new Error(`${error.message}\n${await page.locator("body").innerText()}`);
  }
  await page.evaluate(() => {
    globalThis.__ATLAS_FORCE_PERSIST_FAIL = true;
  });
  await page.waitForTimeout(9000);
  await page.getByTestId("rest-view").waitFor();
  assert((await page.getByTestId("exercise").count()) === 0, "failed rest did not advance");
  await context.close();
}

async function runWakeFallback(browser) {
  const context = await browser.newContext({ viewport: { width: 360, height: 780 } });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "wakeLock", { configurable: true, get() { return undefined; } });
    class Blocked {
      constructor() {
        this.state = "suspended";
        this.destination = {};
        this.currentTime = 0;
      }
      resume() {
        return Promise.reject(new Error("blocked"));
      }
    }
    globalThis.AudioContext = Blocked;
  });
  const page = await context.newPage();
  await page.goto(base);
  await startSessionFromHome(page, "styrka-1");
  await page.getByText("Skärmlås stöds inte").waitFor();
  await page.getByTestId("audio-note").waitFor();
  await page.getByTestId("step-view").waitFor();
  await context.close();
}

async function runAckPersistFailure(browser) {
  const { context, page } = await newPage(browser);
  let stored = null;
  let puts = 0;
  await page.route("https://api.github.com/**", async (route) => {
    const method = route.request().method();
    const url = route.request().url();
    if (url.endsWith("/training-data")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ private: true }) });
      return;
    }
    if (method === "PUT") {
      puts += 1;
      const sent = JSON.parse(Buffer.from(JSON.parse(route.request().postData()).content, "base64").toString("utf8"));
      assert(sent.attempts === undefined, "retry metadata must not be uploaded");
      if (!stored) {
        stored = sent;
        await route.fulfill({ status: 201, contentType: "application/json", body: "{}" });
        return;
      }
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: "conflict" }) });
      return;
    }
    if (!stored) {
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ content: Buffer.from(JSON.stringify(stored), "utf8").toString("base64") }),
    });
  });
  await page.goto(base);
  await startSessionFromHome(page, "styrka-1");
  await page.getByTestId("klar").click();
  await page.getByTestId("confirm").click();
  await page.getByText("Väntar på server: 1").waitFor();
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("owner").fill("demo-owner");
  await page.getByTestId("repo").fill("training-data");
  await page.getByTestId("branch").fill("main");
  await page.getByTestId("token").fill(token);
  await page.getByTestId("save-settings").click();
  await page.evaluate(() => {
    globalThis.__ATLAS_FAIL_SYNC_PERSIST = true;
  });
  await page.getByTestId("sync-now").click();
  await page.getByText("Köstatus kunde inte sparas").waitFor();
  assert((await page.getByTestId("sync-status").innerText()).includes("Väntar på server: 1"));
  assert((await page.getByTestId("sync-status").innerText()).includes("Bekräftat av servern: 0"));
  await page.evaluate(() => {
    globalThis.__ATLAS_FAIL_SYNC_PERSIST = false;
  });
  await page.getByTestId("sync-now").click();
  await page.getByText("Bekräftat av servern: 1").waitFor();
  await page.getByText("Väntar på server: 0").waitFor();
  const rows = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.open("atlas-training-guided");
        request.onsuccess = () => {
          const tx = request.result.transaction("events").objectStore("events").getAll();
          tx.onsuccess = () => resolve(tx.result.map((row) => ({ id: row.eventId, status: row.status })));
        };
      })
  );
  assert(rows.length === 1, "no duplicate event");
  assert(rows[0].status === "acked");
  assert(puts === 2, "one create and one 409 reconcile, puts=" + puts);
  await context.close();
}

async function runEndMarker(browser) {
  const { context, page } = await newPage(browser);
  await page.goto(base);
  await startSessionFromHome(page, "styrka-1");
  await page.getByTestId("skip").click();
  await page.getByTestId("skip").click();
  await page.evaluate(() => {
    globalThis.__ATLAS_FORCE_PERSIST_FAIL = true;
  });
  await page.getByTestId("skip").click();
  await page.getByText("Steget är oförändrat").waitFor();
  assert((await page.getByTestId("exercise").innerText()) === "Bänkpress");
  const blocked = await page.evaluate(() => idbMarkers());
  assert(blocked.length === 0, "failed final skip stores no marker");
  await page.evaluate(() => {
    globalThis.__ATLAS_FORCE_PERSIST_FAIL = false;
  });
  await page.getByTestId("skip").click();
  await page.getByTestId("done-view").waitFor();
  const markerId = await page.evaluate(async () => (await idbMarkers())[0].eventId);
  await page.reload();
  await page.getByTestId("start-styrka-1").waitFor();
  const reloaded = await page.evaluate(async () => (await idbMarkers())[0].eventId);
  assert(markerId === reloaded, "marker id stable across reload");
  const marker = await page.evaluate(async () => (await idbMarkers())[0]);
  assert(marker.outcome === "completed_with_skips");
  assert(marker.setEventIds.length === 0);
  assert(marker.skippedStepIds.length === 3);
  await startSessionFromHome(page, "styrka-2");
  await page.getByTestId("abandon").click();
  const afterAbandon = await page.evaluate(async () => (await idbMarkers()).length);
  assert(afterAbandon === 1, "abandon adds no marker");
  await context.close();
}

async function runFetchPlanFeedback(browser) {
  const { context, page } = await newPage(browser);
  const plan = demoPlan();
  await page.route("https://api.github.com/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/contents/plans/current.json")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ content: Buffer.from(JSON.stringify(plan), "utf8").toString("base64"), sha: "plan" }),
      });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "Not Found" }) });
  });
  await page.goto(base);
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("owner").fill("demo-owner");
  await page.getByTestId("repo").fill("training-data");
  await page.getByTestId("branch").fill("main");
  await page.getByTestId("token").fill(token);
  await page.getByTestId("save-settings").click();
  await page.getByTestId("fetch-plan").click();
  const ok = await page.getByTestId("settings-ok").innerText();
  assert(ok.startsWith("Planen hämtad:"), "missing success message: " + ok);
  assert(ok.includes("pass"), "success should mention pass count: " + ok);
  await page.getByTestId("repo").fill("bad-repo");
  await page.getByTestId("save-settings").click();
  await page.unroute("https://api.github.com/**");
  await page.route("https://api.github.com/**", async (route) => {
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "Not Found" }) });
  });
  await page.getByTestId("fetch-plan").click();
  const err = await page.getByTestId("settings-error").innerText();
  assert(err.includes("404"), "error should include status: " + err);
  assert(err.includes("Owner/Repo") || err.includes("arkivet"), "error should be actionable: " + err);
  await context.close();
}

async function runPreviewAndEarlyEnd(browser) {
  const { context, page } = await newPage(browser);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await page.getByTestId("start-styrka-3").click();
  await page.getByTestId("preview-view").waitFor();
  assert((await sessionCount(page)) === 0, "preview must not create a session");
  const baseText = await page.getByTestId("mode-base").innerText();
  const fullText = await page.getByTestId("mode-full").innerText();
  assert(/^Baspass \(~\d+ min\)$/.test(baseText), "base choice: " + baseText);
  assert(/^Fullpass \(~\d+ min\)$/.test(fullText), "full choice: " + fullText);
  assert((await page.getByTestId("mode-base").getAttribute("aria-pressed")) === "true", "base is the default");
  const body = await page.locator("body").innerText();
  assert(body.includes("Sittande vadpress"), "preview lists calf work");
  assert(body.includes("Uppvärmning") || body.includes("Arbetsset"), "preview lists phases");
  assert(body.includes("Alternativ:"), "preview shows an equipment alternative");
  assert((await page.getByTestId("confirm-start").innerText()) === "Start", "start button visible");
  assert((await page.getByTestId("preview-back").innerText()) === "Tillbaka", "back button visible");
  await page.screenshot({ path: `${shots}/preview-v7.png` });
  await page.screenshot({ path: `${shots}/preview.png` });
  const omitted = await page.getByTestId("preview-omitted").innerText();
  assert(omitted.includes("Hantelflyes") || omitted.includes("Farmarbärning"), "base mode lists full-only work: " + omitted);
  await page.getByTestId("mode-full").click();
  assert((await page.getByTestId("mode-full").getAttribute("aria-pressed")) === "true", "full selected");
  assert((await page.getByTestId("preview-omitted").count()) === 0, "full pass omits nothing");
  assert((await sessionCount(page)) === 0, "mode toggle must not create a session");
  await page.getByTestId("preview-back").click();
  await page.getByTestId("start-styrka-3").waitFor();
  assert((await sessionCount(page)) === 0, "back from preview leaves no session");

  await page.getByTestId("start-styrka-3").click();
  await page.getByTestId("mode-base").click();
  await page.getByTestId("confirm-start").click();
  await page.getByTestId("step-view").waitFor();
  assert((await sessionCount(page)) === 1, "start from preview creates one session");
  await page.getByTestId("end-early").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/end-early.png` });
  await page.getByTestId("end-early").click();
  await page.getByTestId("end-early-dialog").waitFor();
  await page.getByTestId("confirm-end-early").click();
  await page.getByTestId("done-view").waitFor();
  const marker = await page.evaluate(async () => (await idbMarkers())[0]);
  assert(marker, "early end writes completed marker");
  assert(marker.endedEarly === true, "endedEarly");
  assert(marker.endReason === "time_pressure", "endReason");
  assert(Array.isArray(marker.unperformedStepIds) && marker.unperformedStepIds.length > 0, "unperformed steps");
  assert(marker.mode === "base", "base mode recorded");
  assert(Array.isArray(marker.omittedExercises), "omitted exercises recorded");
  await context.close();
}
