# Atlas träning

Offline-first guided session runner. The bundled plan is synthetic **DEMO** data, not a personal program and not copied from any older app.

## Run

```bash
npm install
npm test
npm run test:e2e
npm run build:pages
npm start
```

The local server listens on `127.0.0.1:4173` and serves the same shell at `/` and at `/traning/` (the project-Pages prefix). A request to `/traning` redirects to `/traning/`. End-to-end tests use Playwright Core with `/usr/bin/google-chrome` at 360×780. GitHub is mocked in tests. The app never receives a real token from this repository.

## Project Pages

Publication is branch-based GitHub Pages from the `main` branch, `/docs` folder, for `https://schonalf.github.io/traning/`. This repository does not add a GitHub Actions workflow and does not turn hosting on by itself.

`npm run build:pages` rebuilds `docs/` from an allowlist of the static shell in `public/` (`index.html`, styles, modules, manifest, icon, service worker, and `.nojekyll`). Tests, reports, dependencies, and settings stay out of `docs/`. Run the script again after changing `public/` so `docs/` matches the shell.

HTML, the manifest (`start_url`, `scope`, icons), and the service worker use paths relative to the directory they are served from. The same files work at the origin root and under `/traning/`. The worker registers with that directory as its scope, precaches only the shell inside that scope, and does not cache API responses, tokens, or fetched plans.

## Plan schema

A plan is JSON with `schemaVersion: 1`, `id`, `title`, `demo` (boolean), `disclaimer`, and `sessions`. Each session has `id`, `title`, `type` (`strength`, `conditioning`, or `mobility`), `location`, and ordered `steps`.

Each step has `id`, `phase` (`warmup`, `work`, `cardio`, `recovery`, `mobility`), `exercise`, `equipment`, `location`, `side` (`both`, `left`, `right`, `none`), optional `load` (`unit: "kg"`, `mode: "total" | "per_hand" | "stack"`, `value` number or `null`), optional `reps` (`min`, `max`, `target`), optional `rir`, `durationSeconds`, and `restSeconds`. Superset steps may share `supersetGroup` and `supersetOrder` metadata; execution always preserves the explicit array order.

`load.value: null` means the weight is unknown. The runner asks for it. It is not stored as zero. An actual `0` is allowed when you type it. The only confirmed lat loads are 59 kg and 66 kg. Any other lat load stays unknown. Dumbbells above 10 kg must fall on a 2.5 kg step. No finer rule is invented at or below 10 kg. Steps stay in the authored order, so a later exercise can have its own warmup and superset rounds stay A1, B1, A2, B2.

Unknown JSON fields are dropped. They never become the GitHub target, the token, or other settings.

Demo titles:

- Styrka 1 – Press och knäböj
- Styrka 2 – Rumänsk marklyft och drag
- Styrka 3 – Bröstvolym och bärövningar
- Kondition – Intervaller och rörlighet

## Fragment fallback

Open `#plan=` plus a URI-encoded plan. The encoded form must be at most 20 000 characters and the JSON at most 80 000. The fragment is removed on load, including when validation fails. Text is inserted with `textContent`.

Example (synthetic, truncated in spirit):

```text
#plan=%7B%22schemaVersion%22%3A1%2C%22id%22%3A%22demo%22%2C%22title%22%3A%22DEMO-plan%22%2C%22demo%22%3Atrue%2C%22disclaimer%22%3A%22DEMO%22%2C%22sessions%22%3A%5B%5D%7D
```

Replace the payload with a full valid plan. An empty `sessions` array is rejected.

## Private data repository

You create the private repository yourself. This app does not create repositories, deploy, or turn on GitHub Pages.

1. Create a **private** repository and a branch you control.
2. Add `plans/current.json` with a valid plan if you want the phone to fetch one.
3. Create a fine-grained personal access token that can read and write **contents** on that repository only.
4. In the app settings, type owner, repo, branch, and the token into the password field yourself.
5. Leave “save token” off unless you accept the extra XSS risk. The default keeps the token in memory until reload. “Glöm token” deletes a saved copy.

The only network origin is `https://api.github.com`. Paths are fixed:

- `plans/current.json`
- `sessions/<sessionUUID>/<eventUUID>.json` for each saved or revised set
- `sessions/<sessionUUID>/completed.json` once, when the session reaches the end by the last Klar or the last skip

The end file uses the commit subject `Complete training session`. It records the stable marker id, session and plan metadata, `completedAt`, the ids of set and revision events that existed at the end, and skipped step ids. Skipped steps are not listed as achieved. If every step was skipped, `outcome` is `completed_with_skips`. Abandoning a session writes no end file. A later correction is a new revision file. It does not rewrite `completed.json`. A later check can reconcile those revisions by `revisesEventId` without treating them as a new session end. The phone uploads the end file only after every referenced set event is already acknowledged, on a later flush. There is no per-set wake.

GitHub’s built-in routine listeners cover pull requests and CI, not a raw push. This app does not install a workflow, webhook, or secret. After a separate setup, a server-side verified webhook or a path-filtered Action on `sessions/**/completed.json` can notice one file per session, using secrets the owner manages. A daily check is only a slower fallback.

The app checks that the repository is private before any write and refuses a public repository. Branch names and paths that traverse (`..`) are rejected. Event writes are immutable PUTs of UTF-8 JSON as base64. Set files use `Add session event`. The end file uses `Complete training session`. A lost response or HTTP 409 is reconciled with GET, and the event is acknowledged only when the stored JSON matches exactly.

Sync status separates rows saved on the phone, the pending outbox, and rows the server has acknowledged. HTTP 401 pauses the queue. HTTP 403 distinguishes permission errors from rate limit. HTTP 429 uses `Retry-After`. HTTP 5xx and network errors stay queued and retry with backoff while the tab is visible, and again on load, `online`, and visibility. Failed events are not deleted. There is no background AI wake.

Screen Wake Lock and audio must still be checked on a real phone. Local checks cover both `/` and `/traning/`, including relative modules, the worker scope, the manifest, and an offline reload under `/traning/`.

## Privacy limits

A browser personal access token can be read by any script that runs in the origin. Saving it in IndexedDB survives reloads and raises that risk. The service worker caches only the static shell, never API responses or tokens. Exports omit token fields. Git history on the data repository still stores events after a later delete unless you rewrite history, which this app does not do. Do not put the token in the plan file, the URL, screenshots, or tickets.

Old app `localStorage` is never read or written. There is no migration.

Hosting this PWA publicly needs a separate approval. Nothing here is a go-live. The session-end file is only a detectable marker. Nothing in this repo receives it, schedules a job, or adapts the plan.

## Layout

- `public/` — shell, service worker, and modules
- `docs/` — Pages artifact produced by `npm run build:pages`
- `scripts/build-pages.mjs` — allowlisted copy into `docs/`
- `server.mjs` — local static server with a strict Content-Security-Policy, root and `/traning/`
- `test/unit.test.mjs` — schema, equipment, sync, export
- `test/e2e.mjs` — phone viewport, mocked GitHub, root and prefix, screenshots

Screenshots from the e2e run are written outside the repo to `/workspace/traning-screenshots/`.
