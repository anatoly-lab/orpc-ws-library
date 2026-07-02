# `@orpc-ws/*` Library Project

Monorepo for extracting the ORPC-over-WebSocket transport from the
`anki-mcp-saas` app into reusable, framework-agnostic packages.

Source design doc (read this first):
`~/Developer/projects/ankimcp/anki-mcp-saas/docs/orpc-ws-library-design.md`

Origin code being extracted:
- Client: `~/Developer/projects/ankimcp/anki-mcp-saas/apps/web/src/lib/websocket/`
- Server: `~/Developer/projects/ankimcp/anki-mcp-saas/apps/api/src/api-gateway/websocket/`

---

## Commands

All tasks run through Turborepo from the repo root. First-time setup:
`corepack enable` (provisions the `pnpm` version pinned in the root
`package.json` `packageManager` field), then `pnpm install`.

| Task | Command | Notes |
|---|---|---|
| Build all | `pnpm build` | **tshy** (emits dual ESM/CJS into `dist/esm` + `dist/commonjs`) for the eight non-adapter library packages; plain `tsc` for the sole React adapter `@orpc-ws/react` (ESM-only — a module-level React `createContext` makes a dual ESM/CJS build a dual-package-identity hazard; see README "Module formats") and the demo apps (three self-contained apps, each contract/server/client). Topo-ordered via `^build`. |
| Typecheck all | `pnpm typecheck` | `tsc --noEmit`. **The only check the AI assistant may run.** |
| Lint all | `pnpm lint` | ESLint flat config; enforces framework-free cores. Note: `lint` `dependsOn: ["build"]` in `turbo.json` — tshy writes a temporary `package.json` mid-build that the ESLint import resolver would otherwise race (commit `edec802`). |
| Unit tests all | `pnpm test` | Vitest, per package. **User runs tests — assistant does not.** |
| Full CI gate | `pnpm ci` | lint → typecheck → test → build. |
| Clean | `pnpm clean` | wipes `dist`, `.turbo`, root `node_modules`. |

Scope to one package:
- `pnpm --filter @orpc-ws/client test` (or any script: `build`, `lint`, `typecheck`)
- `turbo run test --filter=@orpc-ws/client` (turbo, dependency-aware)

Run a single test file / case (from inside the package dir, or via `pnpm --filter`):
- `vitest run src/reconnect/__tests__/bug-01-stale-token-after-sleep.test.ts`
- `vitest run -t "storm guard"` (filter by test name)

Regression tests for the design-doc bugs are greppable by filename
(`bug-01-...`, `bug-06-...`, `bug-08-...`) — one named test per fixed bug
(see "Tests from day 0").

Demo. Three auth-model demos (two authenticated + one authless), each a
**self-contained app** under `apps/demo-<mode>/` with its own `contract/` +
`server/` + `client/` package. Each demo runs as two separate processes — a
Vite SPA (`client/`) + a single-mode NestJS server (`server/`, entry
`src/main.ts`) on its own port; **user runs these**. Each demo starts with a
SINGLE command that launches both its server and its client together (turbo
runs the two `@demo/*-server` / `@demo/*-client` packages in parallel):
- **backend-token** (server on 18082, client dev 5174): `pnpm dev:backend-token`.
- **cookie-bff** (server on 18083, client dev 5175): `pnpm dev:cookie-bff`.
- **authless** (server on 18084, client dev 5176): `pnpm dev:authless`. The
  library in `mode: "authless"` — NO IdP, NO secrets, NO auth `.env` (just an
  optional `VITE_WS_URL`, defaulted): the **simplest demo to run**.
- Build every demo package: `pnpm build:demo`. Preview a built SPA via its
  own package, e.g. `pnpm --filter @demo/cookie-bff-client preview` (4174 /
  4175 / authless 4176).
- needs **both** the SPA's `client/.env` (build-time `VITE_*` vars — every
  SPA needs `VITE_WS_URL`; the two backend modes also need
  `VITE_SERVER_ORIGIN`) and the matching `server/.env` (single-mode:
  `PORT` — defaults backend-token 18082 / cookie-bff 18083 —
  plus `OIDC_ISSUER_URL` / `OIDC_CLIENT_ID`, and SPA-origin / session-cookie
  vars for the backend modes; each server loads its OWN `.env` from its
  package dir via Node `--env-file-if-exists`) — each copied from its own
  `.env.example` — plus a running OIDC IdP. Preferred IdP is the hosted
  Keycloak at `keycloak.anatoly.dev` (`orpc-ws-demo` realm). The two backend
  modes need their callback redirect URIs
  (`http://localhost:18082/auth/callback`,
  `http://localhost:18083/auth/callback`) registered on that realm's client,
  which acts as a **public PKCE client** (no secret) for the server-side flow.

e2e (Playwright + Testcontainers Keycloak, needs Docker; **user runs these**):
- `pnpm --filter @repo/tests-e2e test:e2e` (root `pnpm test` skips it).

## Codebase map (as built)

Nine packages under `packages/` (the "Package layout (locked)" section below
states intent; this is the current tree), plus demo apps under `apps/`. Every
non-adapter package is framework-free; the boundary is lint-enforced.

- `@orpc-ws/shared` — the internal seam types with default impls
  (`Logger`, `Clock`, `Rng`), the heartbeat wire types (`HeartbeatEvent`,
  `HEARTBEAT_NAMESPACE` / `HEARTBEAT_PATH`), and — since the bidi
  feature — the framework-free socket substrate: the bidi channel codec
  (`channel.ts`: `tagFrame` / `untagFrame`, `BIDI_C2S_CHANNEL` /
  `BIDI_S2C_CHANNEL`) plus the `SocketMultiplexer` / `ChanneledSocket`
  machinery over the structural `UnderlyingSocket` seam
  (`socket-multiplexer.ts`, `channeled-socket.ts`, `socket.ts`,
  `normalize-inbound.ts`) that lays the two logical RPC channels over one
  socket. Published to npm (cores depend on it via `workspace:*`,
  rewritten to the exact version at publish — see "Monorepo tooling").
  Both cores depend on it.
- `@orpc-ws/client` — browser core. Composition root `src/index.ts` →
  `createOrpcWsClient<TContract>(opts): OrpcWsClient`. One-concept-each
  modules: `state/`, `client/`, `lifecycle/`, `reconnect/`, `heartbeat/`,
  `sleep/`, `auth/`, `upload/`, `config/`, `bidi/`. Tests in per-module
  `__tests__/`. Also exports `createDelegatingClientRouter` (`bidi/`) — the
  late-binding bridge that builds an identity-stable server→client router whose
  leaves delegate to a live handler map (so handlers can change without
  rebuilding the client); its primary consumer is `@orpc-ws/react`'s `<OrpcWs>`.
- `@orpc-ws/server` — Node core. The public construction API is the two
  factories `createOrpcWsServer` (authenticated) /
  `createAuthlessOrpcWsServer` (authless) from `composition/` — see
  "Authless mode (first-class)" under resolved decisions. `src/index.ts`
  still exports the underlying `OrpcWsServer<TUser, TContract>` class
  (`attach` / `dispose` / `closeUser`) as the advanced/internal entry.
  Modules: `composition/` (the factories + their public option/hook
  shapes in `server-options.ts`), `lifecycle/`, `router/`, `heartbeat/`,
  `state/` (incl. `no-auth.ts` — the branded uninhabited `NoAuth` type —
  and `authless-key.ts` — the per-connection unique-key factory),
  `upload/`, `config/`.
- `@orpc-ws/react` — the WS-transport React adapter; hosts the React
  bindings for the WS client core only: `useConnectionState`,
  `useWsSubscription`, `OrpcWsProvider`, `useOrpcWs`, `OrpcWs`, and
  `createServerHandlerHook` (+ types `OrpcWsProviderProps`,
  `UseWsSubscriptionOptions`, `UseWsSubscriptionResult`, `OrpcWsProps`).
  `<OrpcWs>` is a construct-and-own provider that takes the server→client
  `clientContract` VALUE (`oc.router({ … })` — bidi is on iff present;
  `TClientContract` infers from it, no explicit generic), builds the client
  once, owns connect/dispose StrictMode-safe, and renders `OrpcWsProvider`
  underneath so the existing hooks keep working — it COMPLEMENTS `OrpcWsProvider`
  (composition, not replacement; `OrpcWsProvider` stays the low-level escape
  hatch taking a pre-built client). Feature-local server→client handlers
  register from any descendant via `createServerHandlerHook<TClientContract>()`
  → a typed `useServerHandler(name, fn)` (handlers may close over hooks/state;
  register-on-mount / unregister-on-unmount, last-wins on duplicate). Among the `@orpc-ws` cores it depends only
  on `@orpc-ws/client` (it also carries ORPC *framework* runtime deps —
  `@orpc/client` for `consumeEventIterator`, `@orpc/contract` for types — a
  different axis from the core dependency; it does NOT import `@orpc/server`,
  the server→client router-build helper lives in the client core). Sole peer
  is `react`. Single `.` export, no sub-paths. Does NOT re-export the core.
  This is now the **sole** React adapter (the OIDC-auth React adapter
  `@orpc-ws/oidc-react` and the browser PKCE core `@orpc-ws/oidc-pkce` were
  removed — the browser-PKCE / localStorage-token topology was dropped on
  security grounds).
- `@orpc-ws/server-nestjs` — NestJS adapter. `OrpcWsModule.forRootAsync`
  + injectable `OrpcWsService`; wraps core lifecycle in Nest hooks.
- `@orpc-ws/oidc-verifier-jose` — Node JWT verifier (depends on `jose`). The
  server-side verifier for the backend-token / native-mobile auth path: a
  client sends a Bearer access token over the WS handshake (`?token=`) and the
  server verifies it here (discovery-driven JWKS, configurable `boundClaim`).
  Node runtime + heavy dep, so it stands as its own package, not a sub-path.
- `@orpc-ws/cookie-bff` — framework-free cookie-BFF server core (no token
  ever reaches the browser; server holds tokens in a session store, browser
  holds only an opaque httpOnly `sid`). Owns the seams a consumer plugs into:
  `SessionStore`/`SessionData` (`session-store.ts`), `PkceStore` (`oidc/`,
  in-memory default), the `Fetcher` HTTP seam, the at-rest AES-256-GCM token
  cipher (`crypto/`), the cookie WS `createCookieVerifyClient` (Origin
  allowlist + fail-closed + session-window slide, `verifier/`), server-side
  PKCE code-exchange + lazy single-flight refresh (`oidc/`), the
  transport-agnostic `/auth/*` handlers returning `AuthInstruction`
  (`handlers/`, composed by `createCookieBffCore` in `composition/`), hardened
  cookie / `oauth_state` / double-submit-CSRF helpers (`cookies/`), and
  best-effort `revokeUser` (`revoke.ts`). Depends on `@orpc-ws/server` (for
  `VerifyClient`) + `@orpc-ws/shared`. NO HTTP upload transport (uploads
  authenticate via a Bearer token cookie-BFF doesn't have). See
  `docs/cookie-bff-server-design.md`.
- `@orpc-ws/cookie-bff-nestjs` — NestJS adapter for the cookie-BFF core.
  `CookieBffModule.forRoot/forRootAsync` internally configures `OrpcWsModule`
  and hands it the cookie verifier (the verifier→WS bridge is the adapter's
  job — "Decision #23"), hosts the `/auth/*` `@Controller("auth")` (a pure
  `AuthInstruction`→express `@Res` translator), and exposes `CookieBffService`
  (`revokeUser(sub)` / `closeUser` / `getCore`). Install EXACTLY once (owns the
  single `@Global` WS transport via the internal `OrpcWsModule`); Express-only;
  `endpoints` is an inert no-op (fixed controller prefix — use
  `setGlobalPrefix` / `connection.path`). Depends on `@orpc-ws/cookie-bff` +
  `@orpc-ws/server-nestjs`; `@nestjs/*` peers.
- `@orpc-ws/cookie-bff-client` — framework-free BROWSER core for the cookie-BFF
  `/auth/*` client protocol glue, so the consumer doesn't reimplement the
  security-sensitive CSRF/cookie protocol. `createCookieBffAuthClient<TUser>({
  serverOrigin, loginPath, logoutPath, mePath, fetch? })` gives `me()` (typed GET /auth/me →
  enriched user, refreshes the in-memory synchronizer-CSRF token, null on 401),
  a CSRF-aware `mutate()` (the ONE place `X-CSRF-Token` + `credentials:"include"`
  are attached; `path` is origin-relative), `loginUrl()` (pure string), and
  `logout()` (POSTs, RETURNS `endSessionUrl` — does NOT navigate). The CSRF token
  lives ONLY in JS memory (not localStorage/cookie). Navigation (`window.location`)
  stays in the consumer; NO WS coupling (the consumer makes its own
  `createOrpcWsClient` with no `tokenProvider`). Zero runtime deps (global
  `fetch`); browser-only. See `docs/cookie-bff-server-design.md`.

Apps (under `apps/`): three **self-contained** demo apps, one per auth model
(two authenticated + one authless), each a directory `apps/demo-<mode>/`
holding its own `contract/` + `server/` + `client/` package — nine demo
packages total (`@demo/<mode>-contract`, `@demo/<mode>-server`,
`@demo/<mode>-client` for each of backend-token / cookie-bff /
authless). There is no shared `@demo/contract` or `@demo/server` anymore: the
ORPC contract is **copied per app** (`@demo/<mode>-contract`, shared only by
that app's own server + client — an intentional cross-app DRY violation, single
source within an app). Each `server/` is a **single-mode** NestJS app, entry
`src/main.ts` (built to `dist/main.js`), on its own port (backend-token 18082 /
cookie-bff 18083 / authless 18084). The library's
`OrpcWsModule` is single-instance per Nest app, so the one-mode-per-process
constraint is now satisfied **by construction** — one mode = one server package
= one app = one process. The three React + Vite SPAs (`client/`), one per auth
model:
- `@demo/backend-token-client` — custom `TokenProvider`, server-minted access
  token passed via WS `?token=` (imports only `@orpc-ws/client` +
  `@orpc-ws/react`, no oidc packages — the WS-only consumer path); dev 5174 /
  preview 4174.
- `@demo/cookie-bff-client` — httpOnly `sid` session cookie authenticates the
  WS handshake automatically, no `?token=` (imports only `@orpc-ws/client` +
  `@orpc-ws/react`, no `tokenProvider`); dev 5175 / preview 4175. Its
  `@demo/cookie-bff-server` now **consumes the library** — a single
  `CookieBffModule.forRootAsync` config block (`server/src/auth/cookie-auth.module.ts`)
  over `@orpc-ws/cookie-bff-nestjs` + a ~40-line `SessionStore` adapter +
  one revocation wire, replacing the ~1000 lines of hand-written auth it used
  to carry. No `uploadImage` procedure (cookie-BFF has no upload transport).
- `@demo/authless-client` — NO auth at all: no `?token=`, no cookie, no IdP
  (imports only `@orpc-ws/client` + `@orpc-ws/react`, no `tokenProvider`).
  Its `@demo/authless-server` runs the library in `mode: "authless"`; the
  `@demo/authless-contract` is a plain echo RPC + `increment` (shared mutable
  counter) + a `ticks` AsyncIterable. Fully self-contained — no Keycloak,
  secrets, or auth `.env` (just an optional `VITE_WS_URL`); the simplest demo
  to run. dev 5176 / preview 4176; server 18084.

`@repo/tests-e2e` is **not** under `apps/` — it is a
top-level workspace dir (`pnpm-workspace.yaml` globs: `packages/*`,
`apps/*/*`, `tests-e2e`). The Playwright + Testcontainers-Keycloak e2e suite
targets the **demo-cookie-bff** app (it was repointed there when the
browser-PKCE demo was removed).

Two cross-package mechanisms to know before editing:
- **Heartbeat is a "stealth procedure"**, not in the consumer's contract. The
  library merges its own sub-router under the reserved namespace
  `__orpc_ws_lib__.heartbeat` (`HEARTBEAT_PATH` in shared); the client calls
  it via `link.call(...)`. The consumer's `<TContract>` is untouched.
- **State vs events are separate channels**: `client.state` (tagged-record
  `ConnectionState`, for reactive UI) vs `client.onEvent` (notifications:
  `auth_failure` / `heartbeat_timeout` / `woke_from_sleep`).

Note: there is no `@orpc-ws/client/react` sub-path. The WS-transport React
bindings live in `@orpc-ws/react`, the sole React adapter (lint config no
longer exempts a `src/react/` path in the client core).

## Non-negotiable principles

These are load-bearing. Re-read before any non-trivial change.

### SOLID, applied to this project

- **Single responsibility per module.** No file does two unrelated things.
  The current 952-line gateway is the anti-pattern we are escaping.
- **Open/closed via interfaces.** `TokenProvider`, `VerifyClient`,
  `Logger`, framework adapters, reconnect strategy — all are seams the
  consumer plugs into. The library does not depend on concrete
  implementations.
- **Liskov for transport variants.** Any reconnect strategy, any
  framework adapter, any auth flow must be substitutable behind its
  interface without ripple-changing the core.
- **Interface segregation.** Consumers depend only on what they use. No
  grab-bag interfaces; split `state`, `rpc`, `lifecycle`, etc.
- **Dependency inversion.** Core depends on abstractions, never on
  concretions. Wires are joined only at the composition root
  (`createOrpcWsClient`, `OrpcWsModule.forRoot`, etc.).

### No god files

- Hard ceiling: ~300 LOC per file. Beyond that, split.
- One concept per file. The existing client layout (17 files, named
  seams: `ConnectionStateManager`, `WebSocketHolder`, `LinkFactory`,
  `ReconnectManager`, etc.) is the *floor* for granularity, not the
  ceiling.
- Composition root is the only place wires meet. Internal modules are
  pure functions or classes with constructor-injected dependencies.

### Configurable, not hardcoded

- All numeric tunables (reconnect delays, heartbeat interval, storm
  guard window, ping/pong timing, max retries, jitter range, etc.)
  live in a config object with sensible defaults.
- All side-effecting collaborators (logger, token provider, verifier,
  HTTP server, clock, randomness) are injected.
- Zero `console.log`. Zero `process.env` reads inside library code.
- Zero `Date.now()` or `Math.random()` calls outside an injected
  clock / RNG seam (needed for deterministic tests of jitter and
  storm-guard windows).

### Tests from day 0 — non-negotiable

- Every fix from §3 of the design doc becomes a named regression test
  *before* the production code lands. The 11 bugs become 11+ tests
  whose filenames are greppable (`bug-04-stale-token-loop.test.ts`).
- **Unit tests**: pure logic, fake collaborators, deterministic. If
  test setup is more complex than the production code, the seam is
  wrong — fix the seam, not the test.
- **e2e tests**: real WebSocket server (using `ws`) + real client on
  loopback, ephemeral ports. Cover full reconnect / heartbeat /
  auth-failure / session-replacement flows.
- The day-0 commit includes a green test suite, even if it's one
  smoke test. **Tests are never deferred to "phase 2."**
- Test runner: TBD (likely `vitest`); decision recorded here once made.

### Human-readable and maintainable

- Comments explain *why*, not *what*. The existing
  `lifecycle/event-handlers.ts` (30% comment density on the close
  decision tree) is the template — every non-obvious guard has a
  reason and a commit-hash or design-doc reference.
- No spaghetti. Each module's public surface fits on a screen. If a
  reader chases three files to understand one behavior, the seam is
  wrong.
- No `any`. The whole pitch of ORPC is end-to-end typing — the
  transport layer must not erode it.

---

## Workflow rules (binding on the AI assistant)

- **No commits without explicit user instruction.**
- **Do not run tests.** The user runs tests and reports failures.
  Type-check (`tsc --noEmit`) is permitted.
- **Do not run app code or examples.** The user runs them.
- **Delegate context-heavy investigation to Opus subagents.** Single-file
  reads and small targeted edits stay direct.
- **Prefer correct over fast.** If a workaround lands in a week and the
  correct fix takes three, ask before choosing. Default is correct.
- **One concern per PR.** Extraction is staged across multiple PRs
  (per §8 of design doc), never big-bang.
- **Validate before claiming a pattern is "common practice."** Use
  context7 or browse upstream docs/GitHub. If unsure, ask.
- **One chunk per response.** Don't dump multi-issue analyses; pick the
  most load-bearing point, present it, wait for direction.

---

## Reference

- Design doc: `~/Developer/projects/ankimcp/anki-mcp-saas/docs/orpc-ws-library-design.md`
- Source client tree: `~/Developer/projects/ankimcp/anki-mcp-saas/apps/web/src/lib/websocket/`
- Source server tree: `~/Developer/projects/ankimcp/anki-mcp-saas/apps/api/src/api-gateway/websocket/`
- ORPC docs: use context7 (`@orpc/contract`, `@orpc/server`) before
  making framing/contract decisions.

---

## Package layout (locked)

Day-0 packages — the minimal set that makes "framework-agnostic" real,
not aspirational:

| Package                              | Purpose                                                                   | Framework deps     |
| ------------------------------------ | ------------------------------------------------------------------------- | ------------------ |
| `@orpc-ws/client`               | **Client core.** Vanilla TS, fully framework-free. Reconnect, heartbeat, sleep detect, etc. No React sub-path. | none               |
| `@orpc-ws/react`                | **The sole React adapter** (WS-transport). Hosts the WS connection-state bindings (`useConnectionState`, `useWsSubscription`, `OrpcWsProvider`, `useOrpcWs`, plus the construct-and-own `OrpcWs` provider) only. Depends only on `@orpc-ws/client` (among the `@orpc-ws` cores). Does **not** re-export the core. No sub-paths. | `react` peer |
| `@orpc-ws/server`               | **Server core.** Pure Node + `ws` + `@orpc/server`. Verifier-pluggable.   | none               |
| `@orpc-ws/server-nestjs`        | NestJS adapter (separate package — decorator metadata can't share a sub-path with vanilla TS without bundler pain). | `@nestjs/common` peer |

**REMOVED: the OIDC React adapter `@orpc-ws/oidc-react` and the browser
PKCE core `@orpc-ws/oidc-pkce`.** The browser-PKCE / localStorage-token
topology was dropped on security grounds (access/refresh tokens sitting in
JS-readable storage). `@orpc-ws/react` is now the **sole** React adapter.
Browser auth is now served by cookie-BFF (`@orpc-ws/cookie-bff*`, httpOnly
`sid` cookie — no token in the browser); native/mobile/server clients use the
backend-token path (Bearer token over WS `?token=`, verified server-side by
`@orpc-ws/oidc-verifier-jose`). The per-core-sibling *principle* below still
holds — there is simply no longer a second (OIDC) browser core to host an
adapter for.

Future adapters (Svelte / Vue / Solid on client; Express / Fastify /
standalone Node on server) are **not** built on day 0. The contract
with future-us: any of them must be addable as a thin (~50–150 LOC)
sibling package without touching the core. If a future adapter requires
core changes, the seam is wrong — fix the seam, not the adapter.

**Framework adapters are siblings, one adapter per core, per framework
(resolved).** Each framework adapter for this library is its own
**separate sibling package — never a sub-path _of a core_** — and there
is **one adapter per core, per framework** (so the client core gets the
React adapter `@orpc-ws/react`; a second browser core, were one to exist,
would get its own React adapter). The "never a sub-path" rule protects the
*cores*: `@orpc-ws/client` never carries framework code via a sub-path
(this is why the old `@orpc-ws/client/react` sub-path was removed). It
does **not** forbid an *adapter* from exposing its own internal
sub-path: an adapter MAY surface an optional, more-heavily-coupled
framework binding behind a sub-path of *itself* (such a sub-path lives
*inside* the sibling adapter, not on a core, so it satisfies — not
violates — the "Sub-path vs separate sibling package" rule below).
`@orpc-ws/react` depends only on `@orpc-ws/client` (among the `@orpc-ws`
cores — it does also carry ORPC *framework* runtime deps, `@orpc/client` +
`@orpc/contract`, a different axis from the core dependency; it does NOT
import `@orpc/server`) and exposes the WS connection-state bindings; it does
not re-export its core — consumers import the framework-free APIs directly. (The removed `@orpc-ws/oidc-react`
adapter, with its optional `./react-router` sub-path, was the original
worked example of the per-core-sibling + internal-sub-path shape; the shape
remains the rule for any future adapter.)

**This REVERSED an earlier "one merged adapter per framework, not
one-per-core" decision** (which explicitly *rejected* per-core React
siblings). That decision rested on the premise "every consumer needs
*both* cores" — and that premise was **false**. A consumer that
authenticates with a custom `TokenProvider` (e.g. a backend token
endpoint) or cookie/BFF auth uses the WS transport but never touches
browser auth: it needs only `@orpc-ws/client` + `@orpc-ws/react`. A merged
adapter would force that consumer to (a) drag an unused browser-auth core
into `node_modules` and (b) import transport hooks from an auth-named
package — a separation-of-concerns smell. Splitting per-core makes each
adapter depend on exactly its core (ISP/DIP): the WS-only consumer gets a
clean single-package dependency. With the browser-PKCE core and its
`@orpc-ws/oidc-react` adapter since removed, **every** browser consumer is
now that clean WS-only case — `@orpc-ws/client` + `@orpc-ws/react`, no
browser auth core at all. (The since-removed auth hooks
— `useAuthState` / `useUser` / `RequireAuth` — were typed against a browser
OIDC-PKCE instance, so they were only ever usable by PKCE consumers; a
backend-delegated/cookie consumer imported *zero* from them regardless,
which is one reason dropping them cost nothing for those paths.)

Future framework adapters follow this same shape — per-core siblings,
not one merged adapter: a future `@orpc-ws/svelte` binds the client core
and is a *separate* package from any OIDC-svelte adapter, each depending
only on its own core and exposing framework bindings only. Cores stay
framework-free; adapters add only the framework glue.

**Sub-path vs separate sibling package (cores and server-side
helpers).** A sub-path adapter is appropriate when (a) it targets the
same runtime environment as the core (browser/browser, Node/Node),
AND (b) it only adds peer dependencies, doesn't drag runtime deps
into the core's `package.json`. A separate sibling package is required
when either condition fails — different runtime (e.g. a server-side
helper for a browser-only package) OR different runtime-dep set (e.g.
a helper requires a heavy library like `jose` that the core shouldn't
carry). Example today: `@orpc-ws/oidc-verifier-jose` (Node, depends on
`jose`) is its own sibling package rather than a sub-path of any
browser/client package — both the runtime (Node) and the runtime-dep set
(`jose`) differ.

### Adapter wiring convention

- **Core is pinned, framework is peer.** Each adapter depends on its one
  core via **`dependencies`** (the repo uses the `workspace:*` protocol,
  which `pnpm publish` rewrites to the exact published version; never a
  hand-pinned range or a published `^`). The framework (`react`) is the
  only `peerDependencies` entry, with a wide range (e.g. `">=18.0.0"`).
- **Adapter exposes framework bindings only; the core is imported
  directly.** The adapter does **not** re-export its core. `@orpc-ws/react`
  exports only the WS bindings: `useConnectionState`, `useWsSubscription`,
  `OrpcWsProvider`, `useOrpcWs`, `OrpcWs`, `createServerHandlerHook`
  (+ `OrpcWsProviderProps`, `UseWsSubscriptionOptions`,
  `UseWsSubscriptionResult`, `OrpcWsProps`). `<OrpcWs>` (a construct-and-own
  provider taking the server→client `clientContract` value; handler
  implementations register from descendants via `createServerHandlerHook<T>()`
  → `useServerHandler(name, fn)`) COMPLEMENTS `OrpcWsProvider` (composition, not
  replacement) — `OrpcWsProvider` stays the low-level pre-built-client escape
  hatch.
  Consumers import the framework-free APIs straight from the core. The core
  remains a regular `dependency` of its adapter (the hooks `import type` from
  it, and the emitted `.d.ts` references those types, so the dep must resolve)
  — `react` is the sole peer.
- **Optional, heavier-coupled bindings live behind an internal
  sub-path.** An adapter's main entry stays free of any router or other
  heavier framework dependency; a binding that needs more than `react` lives
  at a *second* `exports` entry point, declared as a sub-path of the adapter
  and resolving its extra (optional) peer only when imported. (The removed
  `@orpc-ws/oidc-react` exercised this with an `./react-router` sub-path that
  added `react-router` as an optional peer and reused the router-free
  `useOidcCallback` hook; `@orpc-ws/react` itself has no sub-path. The pattern
  remains the rule for any future adapter that needs it.)
- **Consumer usage:**
  ```ts
  import { createOrpcWsClient } from "@orpc-ws/client";
  import { useConnectionState } from "@orpc-ws/react";
  // createOrpcWsClient(...) from the core; WS hooks from @orpc-ws/react.
  // Browser auth is decoupled: cookie-BFF consumers pass NO tokenProvider
  // (the httpOnly `sid` cookie authenticates the handshake) and use
  // @orpc-ws/cookie-bff-client for the /auth/* glue; native/backend-token
  // consumers supply a custom tokenProvider. Either way the consumer imports
  // ONLY @orpc-ws/client + @orpc-ws/react for the transport.
  ```

Validated against TanStack / XState / Zag.js: core + per-framework
sibling, exact-pinned core dep, framework as peer, lockstep versions.
Lockstep versioning keeps adapter↔core skew unrepresentable. (We
deliberately do **not** re-export the cores the way
`@tanstack/react-query` re-exports `@tanstack/query-core` — keeping each
core the single source of its own public surface.)

### Discipline that enforces "framework-free core"

- **Lint rule** (`eslint-plugin-import/no-restricted-paths` or equivalent):
  `@orpc-ws/client` and `@orpc-ws/server` source must not
  import from `react`, `@nestjs/*`, `vue`, `svelte`, `solid-js`,
  `express`, `fastify`. CI fails on violation. The React adapter is
  also lint-scoped: `@orpc-ws/react` (browser-only, WS-transport only) is
  additionally forbidden from importing any auth core, `react-router`,
  server cores, Node-only deps, and other UI frameworks — keeping it free of
  any auth or router coupling.
- **No framework lifecycle leakage.** The server core owns its own
  lifecycle (`start`, `stop`, `attach(httpServer)`). The NestJS adapter
  *wraps* core lifecycle in `OnModuleInit` (upload middleware — before
  Nest's 404 hook lands) + `OnApplicationBootstrap` (`attach`) +
  `BeforeApplicationShutdown` (`dispose` before HTTP teardown, so clients
  get the close frame); the core itself never imports Nest interfaces.
- **State contract.** The client core exposes
  `{ getState(): T; subscribe(cb: () => void): () => void }`. That same
  shape is consumed by React's `useSyncExternalStore`, Svelte's store
  contract, Vue's `customRef`, Solid's `from()` — without modification.
  Do not add framework-specific shapes to the core.

## Resolved design decisions

The library's public surface is partially locked. Do not silently
re-open these; if a future finding contradicts one, surface it
explicitly and update this section.

### Library scope: ORPC client/server, multi-transport

The library is not "WebSocket transport." It is **the typed ORPC
client/server for this app**, with two transports underneath:

- **WS transport** — always on. Handles RPC + AsyncIterable
  subscriptions + heartbeat.
- **HTTP transport** — **opt-in.** Wired only when the consumer
  passes an `uploads` config. Carries file-bearing procedures via
  ORPC's native multipart support (`z.file()` in contract). No
  HTTP transport, no HTTP server-side route registration.

Rationale: the WS is the consumer's only authenticated channel today
(investigation finding from the source app). Adding HTTP-for-uploads
would be required regardless of where the library draws its scope
line; absorbing it into the library keeps the consumer's mental model
to one client object.

### Auth flow contract

- **`TokenProvider.refresh(): Promise<string | null>` is pure.**
  Returns the fresh token, or `null` if refresh failed. No side
  effects, no implicit WS-close, no cascading cleanup. (Earlier draft
  allowed side effects; investigation found the existing app's
  `clearAuth()` re-entry foot-gun and we explicitly chose the cleaner
  split.)
- **`onTerminalAuthFailure?()` is a separate library option.**
  Called when the library has given up on the auth flow (refresh
  returned null, or storm guard tripped without recovery). Consumer
  uses this for app-level cleanup — clearing auth state, redirecting
  to login, etc.
  - **Terminal is enforced, single-fire** (was a contract-only promise;
    made real in the Fable-review pass — see `docs/fable/`). When it
    fires the client *actually* goes terminal: the partysocket wrapper
    is closed (stopping its internal auto-retry loop), the holder/link
    are cleared, and state moves to `disconnected({ willRetry: false })`
    *before* the callback runs. It fires **at most once per client**;
    `connect()` after it is a no-op (create a new client to reconnect).
  - **Cookie-auth caveat:** the terminal path is gated on a real
    `tokenProvider` existing (`canRefresh`). With no `tokenProvider`
    (cookie auth), a `reconnect()` trigger — sleep-wake / heartbeat
    timeout — whose internal refresh yields null is a **benign no-op**,
    NOT a terminal failure. Only an actual auth-failure *close*
    (1008/4001) with no `tokenProvider` goes terminal.
- **Token-expiry enforcement on live connections is opt-in** (API-4
  fix; default OFF — no behavior change for existing consumers). The
  server validates the token once at connect; to also bound the
  *connection* lifetime, set `enforceTokenExpiry: true` and have the
  verifier surface `expiresAt` (epoch ms) on the `VerifyClientResult`
  success variant (`@orpc-ws/oidc-verifier-jose` populates it from `exp`).
  The server then schedules a `4001` close at `expiresAt` via the
  injected `Clock`; the client treats 4001 as auth-recovery →
  refresh → reconnect. For external invalidation (logout, security
  event), the consumer wires its own `session.invalidated` stream to
  `OrpcWsServer.closeUser(connectionKey, 4001, reason)` — the library
  does not build the pub/sub. Without the flag, a connection made with
  a 15-min token can outlive the token (the original API-4 defect).
- **Library owns the 30s storm guard internally.** Single window
  across all triggers (heartbeat timeout, close-code 1008/4001,
  pre-open 1000, HTTP-upload 401). The current app has *two*
  independent storm-guard timestamps; the library design *fixes*
  that drift. The `reconnect()` path (sleep/heartbeat) now shares the
  same `lastRefreshAttemptedAt` window as `tryAuthRecovery` (BUG-5
  fix): within the window it rebuilds with the current token instead
  of re-refreshing, and `tokenProvider.refresh()` is single-flighted
  so concurrent triggers never issue two refreshes (avoids
  refresh-token-rotation self-logout). Trip semantics differ by
  trigger: an auth-failure close trips to *terminal*, a
  heartbeat/sleep reconnect trips to *reconnect-with-current-token*
  (not terminal).
- **Token transport is URL query param.** `?token=` for WS,
  `Authorization: Bearer` for HTTP (when `uploads` is configured).
  `tokenProvider` is **optional** at the type level — omitting it
  means "no token, browser handles auth via cookies if any." Cookie
  auth is therefore supported without library changes; it's a
  consumer decision, not a library feature.

### Authless mode (first-class)

Authless is a **real, first-class server mode** — NOT an always-accept
`verifyClient` (that would still thread a fake `TUser` through the typed
surface). It complements, does not replace, the "Auth flow contract"
above.

- **Two named factories, authed name is the safe default.** The server
  core exposes `createOrpcWsServer<TUser, TContract>({ router,
  verifyClient, … })` (AUTHENTICATED — the everyday path, the explicit
  name for today's behavior) and `createAuthlessOrpcWsServer<TContract>({
  router, … })` (AUTHLESS). The bare `OrpcWsServer` class stays exported
  as the advanced/internal entry; the factories are the documented public
  construction API. Two named factories (not one factory with an optional
  `verifyClient`) so the everyday name carries the safe authed path and
  authless is opt-in-by-name.
- **Authless behavior:** no verifier runs (every WS upgrade accepted);
  ORPC procedure context is empty `{}` (no `user`, no `token`); NO
  uploads, NO token-expiry, NO `closeUser`. One info log line at attach
  notes authless mode. `AuthlessOrpcWsServerOptions` has no `verifyClient`
  / `uploads` / `enforceTokenExpiry`. The return type is
  `Omit<OrpcWsServer<NoAuth>, "closeUser">`.
- **Single global connection is the DEFAULT (single-session enforcement
  is ON).** *(NEW — reverses the earlier "connections coexist / no
  `onKicked`" authless default.)* All authless sockets share ONE constant
  internal registry key (`state/authless-key.ts` returns a fixed key by
  default — a deterministic constant, not `Math.random()`/`Date.now()`),
  so a NEW connection KICKS the previous one: the prior socket is closed
  with `4005` (session-replaced) and the client maps `4005` to the
  terminal `kicked` state (it does NOT reconnect). This models a
  single-GUI remote-control server where the newest tab takes over. The
  kick close code is `sessionReplacedCloseCode` (default `4005`), still
  tunable via the `connection` config overlay.
- **`allowConcurrentConnections?: boolean` opt-out (default `false`).** A
  public option on `AuthlessOrpcWsServerOptions`. Set `true` to restore
  the OLD coexist behavior: each connection gets a *unique* per-connection
  key (`state/authless-key.ts`'s monotonic counter), single-session
  enforcement is OFF, no `4005` kick, anonymous connections coexist, and
  `onKicked` never fires. (`singleConnectionPerUser` is no longer a
  warned/ignored knob in authless — it is now meaningful, controlled via
  this option.)
- **`AuthlessHooks` now HAS a user-less `onKicked`.** *(NEW — authless
  previously had no `onKicked`.)* `onKicked?: (replacedBy: WebSocket) =>
  void` carries ONLY the replacing WebSocket — there is no kicked `user`
  (authless has no principal). It fires in the default single-connection
  mode when a new connection replaces the previous; it never fires under
  `allowConcurrentConnections: true`. The other authless hooks still drop
  the `user` params.
- **No uploads in authless is deliberate** (the HTTP upload transport
  authenticates via the same Bearer token the WS uses, which authless has
  none of). Adding it later is purely additive — no public API change.
- **`NoAuth` branded type.** The "absent user" is modeled as a branded,
  structurally-uninhabited type (`state/no-auth.ts`) — not `undefined` /
  `unknown` / `any`. So an authless consumer never declares or sees a
  `TUser`, and reaching for a `.user` in authless code is a compile-time
  error, not a runtime `undefined`.
- **NestJS: discriminated union on an OPTIONAL `mode`.** `mode` absent
  (or `"authenticated"`) ⇒ the authenticated arm (existing modules
  unchanged — back-compat default); `mode: "authless"` ⇒ the authless
  arm. `OrpcWsService` reads `mode` and dispatches to the matching
  factory. Use `OrpcWsModule.forRoot/forRootAsync({ mode: "authless",
  router })`. The authless arm inherits `allowConcurrentConnections` and
  the authless `onKicked` automatically through the option type.

### Reactive auth seam — observable `@orpc-ws/oidc-pkce` (REMOVED)

**This decision is obsolete: `@orpc-ws/oidc-pkce` and its `@orpc-ws/oidc-react`
adapter were removed** (the browser-PKCE / localStorage-token topology was
dropped on security grounds). The observable-auth-state seam described here no
longer ships. Browser auth is now cookie-BFF (no token in the browser at all),
so there is no browser-side auth snapshot to observe. The text is retained as a
historical record of the design.

The (removed) `@orpc-ws/oidc-pkce` core exposed an **observable seam** alongside
its pull API:

- **`getAuthState(): AuthSnapshot`** where
  `AuthSnapshot = { status: AuthStatus; user: OidcUser | null }`, plus
  **`subscribe(listener): () => void`**.
- **Cross-tab sync** via the `window` `'storage'` event, lazy-attached
  on the first subscriber and removed on the last; only active with the
  default localStorage-backed `Storage`.
- **The snapshot was referentially stable** (id-token-keyed memoization
  of the decoded user) so it satisfied `useSyncExternalStore`'s
  `Object.is` bail-out.

Why (at the time): it was the same `{ getState/getSnapshot + subscribe }` state
contract the client core follows, so the (removed) React hooks
(`useAuthState` / `useUser`) wrapped it via `useSyncExternalStore`. That
`{ getState + subscribe }` contract remains the client core's shape — only the
browser-auth-state instance of it is gone.

### Uploads

- **v1 ships `strategy: "orpc-http"` only.** HTTP transport opt-in
  via `uploads` config. Default ORPC multipart over HTTP, auth via
  the same `TokenProvider` as a Bearer header.
- **`"presigned-url"` strategy is reserved in the type but not
  implemented.** v1 throws a clear "not implemented" if anyone
  passes it. Adding it later is purely additive — no public API
  change.
- **Public API is strategy-agnostic:**
  ```ts
  await client.upload(file, { procedure, onProgress, signal });
  ```
  Same signature for both strategies. The strategy pattern lives
  *behind* this single method.
- **Server-side contract for the future presigned strategy** is
  spec'd in the README but not implemented: consumer provides
  `presignUpload(meta) → { url, fields }` + `completeUpload(uploadId)`
  ORPC procedures; library orchestrates the 3-call sequence.
- **Out of scope for now:** WS binary streaming (option 3), resumable
  uploads (tus.io / S3 multipart-upload). Re-evaluate if/when the
  consumer use case demands them.

### Heartbeat ownership — stealth procedure pattern

D1 from the design doc (heartbeat as a procedure in the consumer's
typed contract) is **rejected**. Replaced with the stealth procedure
pattern:

- **Library owns the heartbeat procedure end-to-end** — server
  implementation, client subscription, watchdog, storm guard.
- **Consumer's `TContract` is unaffected.** No `extends HeartbeatCapable`
  constraint. No contract fragment the consumer must merge.
- **Wire location**: under a deliberately-ugly library-reserved
  namespace, e.g., `__orpc_ws_lib__.heartbeat`. Picked to minimize
  collision risk; library runtime-asserts the key is absent in the
  consumer's router before merging.
- **Server-side mechanism**: library's `forRoot({ router })` spreads
  its internal sub-router into the consumer's router, then constructs
  the `RPCHandler`. Consumer never touches the fragment.
- **Client-side mechanism**: library calls
  `link.call(["__orpc_ws_lib__", "heartbeat"], input, opts)` directly
  on the same `RPCLink` instance the consumer's typed proxy uses.
  AsyncIterable subscription is supported through the same path.
- **Middleware scoping**: the library's sub-router carries its own
  `os.use(...)` middleware so consumer-level root middleware (e.g.,
  auth) doesn't double-apply to heartbeat. Heartbeat is *pre-auth-state*
  liveness; it must run on every connection.

Rationale: D1's "your `TContract` must extend ours" coupling was the
single most invasive part of the design doc. The stealth pattern
achieves the same library-owned watchdog behavior while keeping
`<TContract>` fully generic and the consumer's wire contract stable
across library upgrades. Validated against ORPC docs — both halves
(plain-object router composition + `link.call` low-level API) are
first-class supported.

### Client lifecycle API

Two-method shape (NOT a three-method triplet):

- **`connect()`** — idempotent. Library handles all reconnect logic
  internally (storm guard, jitter, mutex, debounce). No-ops if the
  client is in a terminal state (e.g., `kicked`).
- **`dispose()`** — terminal teardown. Closes the WS, stops all timers
  and watchers, releases resources. After `dispose()`, the client
  object is dead; the caller creates a new client to reconnect.

Rationale: the existing app's `closeWebSocket()` is always
"I'm done with this connection" semantics — logout
(`Sidebar.tsx:64`) and auth-failure cleanup (`token-refresh.ts:202`).
The "session replaced from another tab" case is library-internal
(close code `4005` → terminal `kicked` state), NOT consumer-driven.
The library transitions state on its own; the consumer never calls
anything. No real use case in the codebase for "pause but resume
later." Adding `disconnect()` later is purely additive if ever
needed.

### State vs events: separate concerns

Two distinct observation channels — no overlap:

- **`state.getState()` / `state.subscribe(cb)`** — what's true *now*.
  Drives reactive UI. Tagged-record shape:
  ```ts
  type ConnectionState =
    | { status: "connecting" }
    | { status: "connected" }
    | { status: "disconnected"; code?: number; willRetry: boolean }
    | { status: "kicked"; reason: "session_replaced" };   // terminal
  ```
- **`onEvent(evt)` callback** — *things that happened* worth reacting
  to imperatively (toast, redirect, log). Notifications only:
  ```ts
  type ClientEvent =
    | { type: "auth_failure"; refreshable: boolean }
    | { type: "heartbeat_timeout" }
    | { type: "woke_from_sleep"; sleepDurationMs: number };
  ```

Rationale: state transitions and notifications are different
abstractions. State is the answer to "what's the connection?";
notifications are "the library noticed X." Emitting state changes
through *both* channels (the design doc's original
`ClientEvent` union) created two ways to learn the same thing and
forced consumers to decide which to use. The split makes the right
choice mechanical: subscribe for UI, callback for side effects.

### Context for design

- **The WS is the source app's only authenticated channel today.**
  HTTP carries no bearer header; protected work is all ORPC over WS.
  Three unauth HTTP endpoints (`/callback`, `/refresh`, `/logout`).
  Implication: the WS reconnect+refresh flow is load-bearing for the
  whole app, not one of several auth paths.
- **Cookie auth would unify HTTP + WS** if the app ever moves to a
  full BFF pattern (server holds tokens, httpOnly session cookie).
  The library is already cookie-compatible (optional `tokenProvider`),
  so no library change required. Treated as future app work, not
  library work.

### Monorepo tooling: pnpm workspaces + Turborepo

**This REVERSES the earlier "npm workspaces + Turborepo" decision.** We
migrated from npm workspaces to **pnpm workspaces** (Turborepo unchanged).
Why pnpm:

- **Native recursive dependency updates** — `pnpm update -r -i -L`
  (recursive, interactive, latest) across every workspace in one pass,
  which npm has no first-class equivalent for.
- **Cross-platform lockfile** — `pnpm-lock.yaml` records every platform's
  optional deps, eliminating the npm `@esbuild/*` "missing optional
  dependency" hazard (older npm omitted those entries and `npm ci` then
  rejected the lockfile).
- **Stricter dependency isolation** — pnpm's isolated (symlinked)
  `node_modules` prevents phantom-dependency access by construction.

Details of the setup:

- **Package manager: pnpm workspaces.** Workspace globs live in
  `pnpm-workspace.yaml` (`packages/*`, `apps/*/*`, `tests-e2e`), NOT in a
  root-`package.json` `"workspaces"` array (that field is removed). pnpm
  is provisioned via Corepack — `corepack enable`, version pinned by the
  root `package.json` `packageManager` field (`pnpm@11.6.0`). No yarn.
- **pnpm-11 config split.** As of pnpm 10→11, `.npmrc` carries **only**
  registry/auth config; all other settings move to `pnpm-workspace.yaml`
  as camelCase keys. We deleted `.npmrc` (we had no auth/registry
  overrides) and put `linkWorkspacePackages: true`, `saveExact: true`,
  `engineStrict: true` in `pnpm-workspace.yaml`.
- **Cross-dependency convention:** **all** internal `@orpc-ws/*` deps
  (and each app's private `@demo/<mode>-contract` dep) use the
  **`workspace:*`** protocol. `pnpm publish` (invoked by `changeset publish`) rewrites
  `workspace:*` → the exact just-published version, so registry metadata
  is always correct. `linkWorkspacePackages: true` is now
  belt-and-suspenders — `workspace:*` links locally regardless.
  - This **supersedes** the earlier decision to keep published cores
    exact-pinned (`"0.1.1"`) to avoid a `pnpm publish` rewrite. We moved
    to Changesets (below), which uses `pnpm publish` and rewrites
    `workspace:*` as a matter of course; the rewrite is verified-standard,
    not a risk.
- **Publishing is via Changesets `changeset publish`** (which delegates
  to `pnpm publish`), authenticated by npm OIDC trusted publishing with
  automatic provenance. See RELEASING.md.
- **Task orchestration: Turborepo** (unchanged). Dep-aware task graph,
  parallel execution, local cache, `--filter` for affected-package
  builds. `turbo.json` at the repo root.
- **Remote cache: not configured initially.** Local cache only. Add
  remote cache later if CI gets slow and the team is OK with a Vercel
  dependency (or self-host).
- **Lint still enforces no-phantom-imports:** `eslint-plugin-import` with
  `no-extraneous-dependencies`. pnpm's isolated `node_modules` already
  prevents most phantom-dep *access* at runtime, so the old "npm is
  looser, lint compensates" framing no longer applies — but the lint rule
  stays valuable: it catches a missing `package.json` declaration at lint
  time (a clearer failure than a runtime/resolution error) and keeps each
  package's declared deps honest.

Rationale: a 4-package library that may grow to 8+ as framework
adapters land. Turborepo's filter and caching pay off as soon as the
adapter count grows; pnpm's recursive update + cross-platform lockfile
pay off as the dependency surface and CI matrix grow. Corepack keeps the
entry barrier near-zero ("anyone with a recent Node can `corepack enable`
and `pnpm install`").

### Versioning & release: Changesets (local) + tag-triggered publish

**This supersedes the earlier custom-script release decision**
(`scripts/sync-version.mjs` + `scripts/publish-all.sh` + a tag-push
`npm-publish.yml` / GH-release `release.yml`, all now removed, along with
the `release:version` root script). **It also REVERSES the interim
"merge the Version Packages PR to publish" model** — publishing is no
longer coupled to merging a bot PR on `push: main`; it is now triggered
by pushing a `v*` git tag. Changesets is retained **only** as a local
tool — for the `fixed` lockstep bump and the CHANGELOGs — not for CI
publishing.

- **Tool: [Changesets](https://github.com/changesets/changesets)**
  (`@changesets/cli`, root devDep; config in `.changeset/config.json`),
  used **locally only** (versioning + changelogs).
- **Lockstep via the `fixed` group** — all nine published packages are
  listed in one `fixed` array, so any release bumps them all to the same
  version (`fixed` does **not** support globs; list each package):
  `@orpc-ws/shared`, `client`, `server`, `react`, `server-nestjs`,
  `oidc-verifier-jose`, `cookie-bff`, `cookie-bff-nestjs`,
  `cookie-bff-client` (`oidc-pkce` and `oidc-react` were removed when the
  browser-PKCE topology was dropped).
- **Internal deps are `workspace:*`** — `pnpm -r publish` rewrites them
  to the exact published version at publish time.
- **Changelog:** the bundled `@changesets/cli/changelog` (no extra dep).
- **Publish is tag-triggered.** `.github/workflows/npm-publish.yml` runs
  **only** on a pushed `v*` tag (`on: push: tags: ['v*']`) — pushing or
  merging to `main` NEVER publishes; pending `.changeset/*.md` files just
  accumulate on `main` until a release. The tagged run builds, then runs
  `pnpm -r publish --no-git-checks` (publishes every non-private package
  not yet on the registry — so re-tagging is a safe no-op — skips the
  private `@demo/*` apps). Auth is npm OIDC trusted publishing (no token
  in steady state; provenance automatic). There is **no** `changesets/action`
  and **no** "Version Packages" bot PR anymore, so the org-level "Allow
  GitHub Actions to create and approve PRs" toggle is no longer needed
  for releases.
- **DO NOT rename `npm-publish.yml`.** The npm trusted-publisher binding
  for all nine packages is keyed to repo + this exact workflow filename
  (NOT branch/ref — which is why moving the trigger from `push: main` to a
  `v*` tag authorizes identically, no re-registration).
- **Release recipe (manual, local):** `pnpm version-packages`
  (= `changeset version`, consumes `.changeset/*.md`, bumps all nine,
  rewrites `workspace:*`, writes CHANGELOGs) → commit + push the bump to
  `main` (`git commit -am "release: vX.Y.Z" && git push`) → `git tag
  vX.Y.Z && git push origin vX.Y.Z` (the tag push is what publishes).
- **Day-to-day:** `pnpm changeset` per behavior-changing PR. Root scripts:
  `changeset` / `version-packages` (`changeset version`) only — the
  `release` (`changeset publish`) script was removed (publishing is
  CI-on-tag). Full runbook in RELEASING.md.

### Test runner: vitest

- **vitest** for all three test layers (unit, integration, e2e).
- Per-package `vitest.config.ts` extends a shared root config to keep
  setup boilerplate (fake timers, DOM globals, common matchers) in one
  place.
- DOM-needing tests use `happy-dom` (lighter and faster than `jsdom`
  for our needs — pure WS / `useSyncExternalStore` work).
- Playwright is **not** added on day 0. Add it later if React-adapter
  e2e needs real browser scenarios.

Rationale: ESM-native, Jest-API-compatible, fastest cold start for
the size of test suite we'll have. Jest would require `babel-jest`
config-dance for ESM with no offsetting benefit.

## Open decisions (update as resolved)

Do not commit code that silently picks one of these without an
explicit decision recorded here.

_(All major design decisions resolved as of last update. Next item
to surface here will appear once implementation begins.)_
