# `@repo/tests-e2e`

Playwright E2E suite for the `orpc-ws-*` library family. Drives the
**cookie-BFF** demo SPA + demo NestJS server against a real Keycloak
(via Testcontainers).

In the cookie-BFF model the **server** runs the whole OAuth flow and
holds all tokens server-side; the browser only ever holds an opaque
httpOnly `sid` session cookie, which authenticates both the `/auth/*`
HTTP calls and the WS handshake (there is **no** `?token=`).

## What it covers

- `workflows/smoke.spec.ts` — server-side OIDC login → `sid` cookie →
  WS connect (cookie rides the upgrade) → ORPC ping → ORPC echo with
  the cookie-derived auth context. The single non-negotiable gate.
- `workflows/auth.spec.ts` — login → logout → re-login. Asserts the
  `sid` cookie is cleared from the browser context (via
  `context.cookies()`) AND that Keycloak's session was ended (a fresh
  signin lands back on the login form, not a silent SSO bypass).

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

All three tiers come up as Docker containers via Testcontainers on a
shared network in `global-setup.ts` (`startStack()` in `containers.ts`).
There is no Playwright `webServer`.

- `setup/containers.ts` — Testcontainers orchestration of Keycloak +
  the cookie-BFF server + the cookie-BFF SPA. Pins the host ports
  (Keycloak `18080`, server `18083`, SPA `4173`) so the SPA's baked
  `VITE_*` URLs and the server's registered redirect URI line up with
  known fixed URLs. Implements the **single-issuer model**: the BROWSER
  is redirected to Keycloak at the PUBLIC url
  (`http://localhost:18080/realms/orpc-ws-demo`), while the SERVER
  reaches Keycloak for discovery / JWKS / the server-side code exchange
  over the docker net (`http://keycloak:8080/...`). Keycloak pins its
  hostname so the issuer it stamps and advertises is the PUBLIC url from
  both paths. Waits on `/realms/orpc-ws-demo` (NOT `/health/ready`,
  which goes green before `--import-realm` finishes).
  - **Server runtime env** (injected by `containers.ts`, read at process
    start): `PORT`, `HOST`, `OIDC_ISSUER_URL` (public issuer),
    `OIDC_DISCOVERY_URL` (internal docker-net host),
    `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI`
    (`http://localhost:18083/auth/callback` — Keycloak redirects the
    browser here), `SPA_ORIGIN_COOKIE_BFF` (`http://localhost:4173` — the
    post-callback + post-logout redirect target AND the CORS / WS Origin
    allowlist), `SESSION_COOKIE_NAME=sid`, and `SESSION_ENC_KEY` (a fixed
    demo key — fine for an ephemeral run).
  - **SPA build args** (baked at `vite build` time): `VITE_WS_URL`
    (`ws://localhost:18083/ws`) and `VITE_SERVER_ORIGIN`
    (`http://localhost:18083`). No OIDC / upload args — the cookie-BFF SPA
    holds no token.
- `setup/global-setup.ts` / `global-teardown.ts` — Boot/stop the whole
  stack once per run, then poll each host-facing health endpoint
  (`/health/live` on the server, `/health` on the SPA's nginx) until
  ready.
- `setup/keycloak/orpc-ws-demo-realm.json` — the imported realm. The
  `orpc-ws-demo-spa` client is a PUBLIC PKCE client (no secret); the
  server runs its server-side code exchange against it. Registered
  redirect URIs include the SERVER callback
  `http://localhost:18083/auth/callback`; post-logout redirect URIs
  include the SPA root `http://localhost:4173/*`.
- `pages/` — Page Objects for the SPA (signed-out + signed-in branches)
  and the Keycloak login form.
- `fixtures/` — Seed test data + optional `authenticatedPage` fixture.
