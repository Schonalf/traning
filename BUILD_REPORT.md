# Build report

Generic offline-first Swedish training PWA. Synthetic DEMO plan only. Personal plans stay in a separate private data repository that this app does not create. This snapshot is a fresh public tree. It publishes for GitHub project Pages from the `main` branch `/docs` folder. It does not add a GitHub Actions workflow, webhook, or deployment step.

## Checks

- `npm test` — 27 unit tests, all passing. Covers schema, equipment, sync, privacy, the session-end marker, and the service worker allowlist (static shell only; no API host in the worker).
- `npm run test:e2e` — Playwright Core headless Chrome at `/usr/bin/google-chrome`, 360×780, mocked GitHub only. Keeps the session, rest, offline queue, fragment, guard, wake, ack, and end-marker flows. Adds root and `/traning/` checks: relative modules and assets, no origin-root shell requests on the prefix, manifest `start_url`/`scope`/icon resolved against the manifest URL, service worker scope `/traning/`, and an offline reload that still starts a session inside that prefix.
- `npm run build:pages` — copies the allowlisted `public/` shell into `docs/` and writes `.nojekyll`. Output matches `public/` for those files.

Screenshots (synthetic UI, no token): `/workspace/traning-screenshots/`.

## Pages

Site URL when Pages is enabled for this project: `https://schonalf.github.io/traning/`. Enable branch publishing yourself (`main` / `docs`). The local server still serves `/` and `/traning/` from `public/` so both layouts can be tested before that.

The worker scope is the directory of `sw.js`. It caches only that shell. It does not cache GitHub responses, tokens, or a fetched plan.

## Limits

Browser PAT storage is XSS-sensitive. Git history on a data repo keeps events. Screen-locked beeps are not guaranteed. The end file is only a marker. GitHub’s built-in routine listeners do not fire on a raw push, so this repo does not promise a native push listener. A future verified webhook or path-filtered Action would need a separate setup and user-managed secrets. A daily check would be a slower fallback. No such receiver is implemented.
