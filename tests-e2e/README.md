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
- Node 22+, pnpm via Corepack (same as the rest of the monorepo).
- The first run pulls `quay.io/keycloak/keycloak:26.5.5` (~600 MB).
  Allow ~3–5 min on first run, ~1–2 min on subsequent runs.

## How to run

From the repo root:

```bash
pnpm install                                 # once
pnpm --filter @repo/tests-e2e test:e2e
```

Useful variants:

```bash
# headed (watch browser)
pnpm --filter @repo/tests-e2e test:e2e:headed

# list tests without running
pnpm --filter @repo/tests-e2e test:e2e:list
```

## Default `pnpm test` is a no-op here

The root `pnpm test` (and `pnpm exec turbo run test`) deliberately do **not**
run Playwright in this workspace. Playwright requires Docker + multi-
minute setup; running it on every commit in unit-test mode would be
wrong. The default `test` script in `tests-e2e/package.json` prints a
message and exits 0. Use `test:e2e` to actually run Playwright.

## Architecture

- `setup/containers.ts` — Testcontainers wrapper around Keycloak
  26.5.5. Pins the host port to `18080` so the SPA's
  `VITE_OIDC_ISSUER_URL` (inlined at build time) and the server's
  `OIDC_ISSUER_URL` (read at process start) match a known URL. Waits
  on `/realms/orpc-ws-demo` (NOT `/health/ready`, which goes green
  before `--import-realm` finishes).
- `setup/global-setup.ts` / `global-teardown.ts` — Boot/stop the
  WHOLE stack once per run. There is no Playwright `webServer`: all
  three tiers (Keycloak + demo-server + demo-pkce SPA) come up as
  Docker containers via Testcontainers on a shared network in
  `global-setup.ts` (`startStack()` in `containers.ts`), then each
  host-facing health endpoint is polled until ready. The demo-server
  runs its containerized PKCE entry (`dist/main-pkce.js`) on `:18081`
  (the server is multi-mode — `main-pkce.ts` / `main-backend-token.ts` /
  `main-cookie-bff.ts` — but only PKCE is containerized for e2e), and
  the demo-pkce SPA is served by nginx on `:4173` from a build that
  baked the `VITE_*` issuer/client/WS/upload URLs at image-build time.
- `pages/` — Page Objects for the SPA and Keycloak login form.
- `fixtures/` — Seed test data + optional `authenticatedPage` fixture.
