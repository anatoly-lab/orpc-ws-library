# `@repo/tests-e2e`

Playwright E2E suite for the `orpc-ws-*` library family. Drives the
demo SPA + demo NestJS server against a real Keycloak (via
Testcontainers).

## What it covers

- `workflows/smoke.spec.ts` — PKCE login → WS connect → ORPC ping →
  ORPC echo. The single non-negotiable gate.
- `workflows/auth.spec.ts` — login → logout (incl. KC end-session) →
  re-login. Verifies token AND session cookie are killed.

## Requirements

- **Docker** running locally (Keycloak runs as a container).
- Node 22+, npm 10+ (same as the rest of the monorepo).
- The first run pulls `quay.io/keycloak/keycloak:26.5.5` (~600 MB).
  Allow ~3–5 min on first run, ~1–2 min on subsequent runs.

## How to run

From the repo root:

```bash
npm install                          # once
npm run test:e2e --workspace=@repo/tests-e2e
```

Useful variants:

```bash
# headed (watch browser)
npm test --workspace=@repo/tests-e2e -- --headed

# list tests without running
npm test --workspace=@repo/tests-e2e -- --list
```

## Default `npm test` is a no-op here

The root `npm test` (and `npx turbo run test`) deliberately do **not**
run Playwright in this workspace. Playwright requires Docker + multi-
minute setup; running it on every commit in unit-test mode would be
wrong. The default `test` script in `tests-e2e/package.json` prints a
message and exits 0. Use `test:e2e` to actually run Playwright.

## Architecture

- `setup/containers.ts` — Testcontainers wrapper around Keycloak
  26.5.5. Waits on `/realms/orpc-ws-demo` (NOT `/health/ready`,
  which goes green before `--import-realm` finishes).
- `setup/demo-process.ts` — Spawns the built demo server as a child
  process. Pipes stdout/stderr into a ring buffer so green runs stay
  clean; flushed on failure.
- `setup/global-setup.ts` / `global-teardown.ts` — Boot/stop the
  Keycloak container + demo server child process once per run.
- `pages/` — Page Objects for the SPA and Keycloak login form.
- `fixtures/` — Seed test data + optional `authenticatedPage` fixture.
