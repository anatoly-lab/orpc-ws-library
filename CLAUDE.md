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
| Build all | `pnpm build` | **tshy** (emits dual ESM/CJS into `dist/esm` + `dist/commonjs`) for the six library cores; plain `tsc` for the two React adapters `@orpc-ws/react` and `@orpc-ws/oidc-react` (both ESM-only — a module-level React `createContext` makes a dual ESM/CJS build a dual-package-identity hazard; see README "Module formats") and the demo apps. Topo-ordered via `^build`. |
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

Demo (each demo is two separate processes — a Vite SPA + the NestJS server
run in the matching mode; **user runs these**). Three auth-model demos share
one multi-mode demo-server:
- **pkce** (server on 18081): `pnpm dev:server:pkce` + `pnpm dev:pkce`
  (or `pnpm dev:demo` for the default pair).
- **backend-token** (server on 18082): `pnpm dev:server:backend-token` +
  `pnpm dev:backend-token`.
- **cookie-bff** (server on 18083): `pnpm dev:server:cookie-bff` +
  `pnpm dev:cookie-bff`.
- Build all four demo apps: `pnpm build:demo`. Preview a built SPA:
  `pnpm preview:demo:pkce` / `:backend-token` / `:cookie-bff` (4173 / 4174 /
  4175). The bare `pnpm dev:server` aliases the pkce mode.
- needs **both** the SPA's `.env` (build-time `VITE_*` vars — every SPA needs
  `VITE_WS_URL`; the two backend modes also need `VITE_SERVER_ORIGIN`; pkce
  additionally needs `VITE_OIDC_*` + `VITE_UPLOAD_URL`) and
  `apps/demo-server/.env` (shared `OIDC_ISSUER_URL` / `OIDC_CLIENT_ID`; the
  per-mode ports `PORT_PKCE` / `PORT_BACKEND_TOKEN` / `PORT_COOKIE_BFF` and
  SPA-origin / session-cookie vars for the backend modes — loaded via Node
  `--env-file-if-exists`) — each copied from its own `.env.example` — plus a
  running OIDC IdP. Preferred IdP is the hosted Keycloak at
  `keycloak.anatoly.dev` (`orpc-ws-demo` realm). The two backend modes need
  their callback redirect URIs (`http://localhost:18082/auth/callback`,
  `http://localhost:18083/auth/callback`) registered on that realm's client,
  which acts as a **public PKCE client** (no secret) for the server-side flow.

e2e (Playwright + Testcontainers Keycloak, needs Docker; **user runs these**):
- `pnpm --filter @repo/tests-e2e test:e2e` (root `pnpm test` skips it).

## Codebase map (as built)

Eight packages under `packages/` (the "Package layout (locked)" section below
states intent; this is the current tree), plus demo apps under `apps/`. Every
non-adapter package is framework-free; the boundary is lint-enforced.

- `@orpc-ws/shared` — internal seam types only (`Logger`, `Clock`,
  `Rng`, `HeartbeatEvent`, and the `HEARTBEAT_NAMESPACE` / `HEARTBEAT_PATH`
  constants). Published to npm (cores pin it as an exact-version runtime
  dependency, `"0.1.0"` — not `workspace:*`). Both cores depend on it.
- `@orpc-ws/client` — browser core. Composition root `src/index.ts` →
  `createOrpcWsClient<TContract>(opts): OrpcWsClient`. One-concept-each
  modules: `state/`, `client/`, `lifecycle/`, `reconnect/`, `heartbeat/`,
  `sleep/`, `auth/`, `upload/`, `config/`. Tests in per-module `__tests__/`.
- `@orpc-ws/server` — Node core. `src/index.ts` exports the
  `OrpcWsServer<TUser, TContract>` class (`start` / `stop` / `attach`).
  Modules: `lifecycle/`, `router/`, `heartbeat/`, `state/`, `upload/`,
  `config/`.
- `@orpc-ws/react` — the WS-transport React adapter; hosts the React
  bindings for the WS client core only: `useConnectionState`,
  `useWsSubscription`, `OrpcWsProvider`, `useOrpcWs` (+ types
  `OrpcWsProviderProps`, `UseWsSubscriptionOptions`,
  `UseWsSubscriptionResult`). Depends only on `@orpc-ws/client`; sole peer
  is `react`. Single `.` export, no sub-paths. Does NOT re-export the core.
- `@orpc-ws/oidc-react` — the OIDC-auth React adapter; hosts the auth
  bindings only: `useAuthState`, `useUser`, `useOidcCallback`,
  `RequireAuth`. Depends only on `@orpc-ws/oidc-pkce` (no longer on the
  client core). Optional `./react-router` sub-path adds the `OidcCallback`
  `<Route>` drop-in (`react-router-dom` optional peer). Does NOT re-export
  the core — consumers import `@orpc-ws/oidc-pkce` directly.
- `@orpc-ws/server-nestjs` — NestJS adapter. `OrpcWsModule.forRootAsync`
  + injectable `OrpcWsService`; wraps core lifecycle in Nest hooks.
- `@orpc-ws/oidc-pkce` — browser OIDC/PKCE core, zero deps. Pull API
  (`hasToken` / `getAuthStatus` / `getUser`) + observable seam
  (`getAuthState` / `subscribe`) that the React hooks wrap.
- `@orpc-ws/oidc-verifier-jose` — Node JWT verifier (depends on `jose`); a
  sibling of `oidc-pkce` (Node runtime + heavy dep, so not a sub-path).

Apps (under `apps/`): `@demo/contract` (shared ORPC contract); a single
**multi-mode** NestJS `@demo/server` with three bootstraps (`main-pkce` /
`main-backend-token` / `main-cookie-bff`), each run as its **own process** on
its own port (pkce 18081 / backend-token 18082 / cookie-bff 18083) because the
library's `OrpcWsModule` is single-instance per Nest app, so one mode = one
app = one process; and three React + Vite SPAs, one per auth model:
- `@demo/pkce` — browser PKCE (imports `@orpc-ws/oidc-pkce` +
  `@orpc-ws/oidc-react` + `@orpc-ws/react`); dev 5173 / e2e preview 4173.
- `@demo/backend-token` — custom `TokenProvider`, server-minted access token
  passed via WS `?token=` (imports only `@orpc-ws/client` + `@orpc-ws/react`,
  no oidc packages — the WS-only consumer path); dev 5174 / preview 4174.
- `@demo/cookie-bff` — httpOnly `sid` session cookie authenticates the WS
  handshake automatically, no `?token=` (imports only `@orpc-ws/client` +
  `@orpc-ws/react`, no `tokenProvider`); dev 5175 / preview 4175.

`@repo/tests-e2e` is **not** under `apps/` — it is a
top-level workspace dir (`pnpm-workspace.yaml` globs: `packages/*`,
`apps/*`, `tests-e2e`).

Two cross-package mechanisms to know before editing:
- **Heartbeat is a "stealth procedure"**, not in the consumer's contract. The
  library merges its own sub-router under the reserved namespace
  `__orpc_ws_lib__.heartbeat` (`HEARTBEAT_PATH` in shared); the client calls
  it via `link.call(...)`. The consumer's `<TContract>` is untouched.
- **State vs events are separate channels**: `client.state` (tagged-record
  `ConnectionState`, for reactive UI) vs `client.onEvent` (notifications:
  `auth_failure` / `heartbeat_timeout` / `woke_from_sleep`).

Note: there is no `@orpc-ws/client/react` sub-path. The WS-transport React
bindings live in `@orpc-ws/react`, and the OIDC-auth bindings in
`@orpc-ws/oidc-react` (lint config no longer exempts a `src/react/` path in
the client core).

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
| `@orpc-ws/react`                | **WS-transport React adapter.** Hosts the WS connection-state hooks (`useConnectionState`, `useWsSubscription`, `OrpcWsProvider`, `useOrpcWs`) only. Depends only on `@orpc-ws/client`. Does **not** re-export the core. No sub-paths. | `react` peer |
| `@orpc-ws/oidc-react`           | **OIDC-auth React adapter.** Hosts the OIDC auth hooks (`useAuthState`, `useUser`, `useOidcCallback`, `RequireAuth`) only. Depends only on `@orpc-ws/oidc-pkce`. Does **not** re-export the core. Also exposes an optional `./react-router` sub-path (see prose below). | `react` peer (+ optional `react-router-dom` on the sub-path) |
| `@orpc-ws/server`               | **Server core.** Pure Node + `ws` + `@orpc/server`. Verifier-pluggable.   | none               |
| `@orpc-ws/server-nestjs`        | NestJS adapter (separate package — decorator metadata can't share a sub-path with vanilla TS without bundler pain). | `@nestjs/common` peer |

Future adapters (Svelte / Vue / Solid on client; Express / Fastify /
standalone Node on server) are **not** built on day 0. The contract
with future-us: any of them must be addable as a thin (~50–150 LOC)
sibling package without touching the core. If a future adapter requires
core changes, the seam is wrong — fix the seam, not the adapter.

**Framework adapters are siblings, one adapter per core, per framework
(resolved).** Each framework adapter for this library is its own
**separate sibling package — never a sub-path _of a core_** — and there
is **one adapter per core, per framework** (so React gets `@orpc-ws/react`
for the client core and `@orpc-ws/oidc-react` for the OIDC core). The
"never a sub-path" rule protects the *cores*: `@orpc-ws/client`
and `@orpc-ws/oidc-pkce` never carry framework code via a sub-path (this
is why the old `@orpc-ws/client/react` sub-path was removed). It
does **not** forbid an *adapter* from exposing its own internal
sub-path: an adapter MAY surface an optional, more-heavily-coupled
framework binding behind a sub-path of *itself* (see
`@orpc-ws/oidc-react/react-router` below), so that the adapter's
main entry stays free of the extra dependency. Such a sub-path lives
*inside* the sibling adapter, not on a core, so it satisfies — not
violates — the "Sub-path vs separate sibling package" rule below.
`@orpc-ws/react` depends only on `@orpc-ws/client` and exposes the WS
connection-state bindings; `@orpc-ws/oidc-react` depends only on
`@orpc-ws/oidc-pkce` and exposes the auth bindings. Neither re-exports
its core — consumers import the framework-free APIs directly from each
core.

**This REVERSES the earlier "one merged adapter per framework, not
one-per-core" decision** (which explicitly *rejected* per-core React
siblings). That decision rested on the premise "every consumer needs
*both* cores" — and that premise is **false**. A consumer that
authenticates with a custom `TokenProvider` (e.g. a backend token
endpoint) or cookie/BFF auth uses the WS transport but never touches
browser PKCE: it needs `@orpc-ws/client` + `@orpc-ws/react` and never
`@orpc-ws/oidc-pkce`. The old merged adapter forced that consumer to
(a) drag an unused `@orpc-ws/oidc-pkce` into `node_modules` and
(b) import transport hooks from an auth-named package — a
separation-of-concerns smell. Splitting per-core makes each adapter
depend on exactly its core (ISP/DIP): the WS-only consumer gets a clean
single-package dependency, while a PKCE+WS consumer (the demo) pays one
extra import line. The trade, stated honestly: the both-cores case now
imports from two packages instead of one — the deliberate cost of
decoupling the WS-only case. (Note too that the auth hooks
— `useAuthState` / `useUser` / `RequireAuth` — are typed against an
`@orpc-ws/oidc-pkce` instance, so they were only ever usable by PKCE
consumers; a backend-delegated/cookie consumer imports *zero* from
`@orpc-ws/oidc-react` regardless.)

Future framework adapters follow the **new** shape — per-core siblings,
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
carry). Example today: `@orpc-ws/oidc-pkce` (browser, zero deps) +
`@orpc-ws/oidc-verifier-jose` (Node, depends on `jose`) live as siblings
because both conditions fail.

### Adapter wiring convention

- **Core is pinned, framework is peer.** Each adapter depends on its one
  core via **`dependencies`** (the repo uses the `workspace:*` protocol,
  which `pnpm publish` rewrites to the exact published version; never a
  hand-pinned range or a published `^`). The framework (`react`) is the
  only `peerDependencies` entry, with a wide range (e.g. `">=18.0.0"`).
- **Adapter exposes framework bindings only; the core is imported
  directly.** The adapter does **not** re-export its core. `@orpc-ws/react`
  exports only the WS bindings: `useConnectionState`, `useWsSubscription`,
  `OrpcWsProvider`, `useOrpcWs` (+ `OrpcWsProviderProps`,
  `UseWsSubscriptionOptions`, `UseWsSubscriptionResult`).
  `@orpc-ws/oidc-react` exports only the auth bindings: `useAuthState`,
  `useUser`, `useOidcCallback`, `RequireAuth`. Consumers import the
  framework-free APIs straight from each core. The core remains a regular
  `dependency` of its adapter (the hooks `import type` from it, and the
  emitted `.d.ts` references those types, so the dep must resolve) —
  `react` is the sole peer.
- **Optional, heavier-coupled bindings live behind an internal
  sub-path.** The adapter's main entry stays free of any router or
  other heavier framework dependency. A binding that needs more than
  `react` lives at a *second* entry point — e.g. the `OidcCallback`
  drop-in React-Router `<Route>` component at
  `@orpc-ws/oidc-react/react-router`, which adds `react-router-dom`
  as an **optional** peer (`peerDependenciesMeta.optional: true`). The
  sub-path is declared as a second `exports` entry and built by the same
  `tsc` pass (`src/react-router/` → `dist/react-router/`).
  `react-router-dom` resolves only when a consumer imports the sub-path.
  **Why:** keeps the main entry's dependency surface minimal and the
  heavier framework-router coupling opt-in, while *reusing* the
  router-free `useOidcCallback` hook (`OidcCallback` only adds
  `useNavigate` + default UI on top of it) so there is no logic
  duplication.
- **Consumer usage:**
  ```ts
  import { createOrpcWsClient } from "@orpc-ws/client";
  import { createOidcAuth } from "@orpc-ws/oidc-pkce";
  import { useConnectionState } from "@orpc-ws/react";
  import { useAuthState } from "@orpc-ws/oidc-react";
  // createOrpcWsClient(...) ; createOidcAuth(...) from the cores;
  // WS hooks from @orpc-ws/react, auth hooks from @orpc-ws/oidc-react.
  // A WS-only consumer (custom TokenProvider / cookie auth) imports
  // ONLY from @orpc-ws/client + @orpc-ws/react and never touches the
  // OIDC packages.
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
  `express`, `fastify`. CI fails on violation. The two React adapters are
  also lint-scoped: `@orpc-ws/react` (browser-only, WS-transport only) is
  additionally forbidden from importing the OIDC auth core
  (`@orpc-ws/oidc-pkce`), `react-router-dom`, server cores, Node-only deps,
  and other UI frameworks — keeping it free of any OIDC or router coupling.
- **No framework lifecycle leakage.** The server core owns its own
  lifecycle (`start`, `stop`, `attach(httpServer)`). The NestJS adapter
  *wraps* core lifecycle in `OnApplicationBootstrap` / `OnModuleDestroy`;
  the core itself never imports Nest interfaces.
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

### Reactive auth seam — observable `@orpc-ws/oidc-pkce`

The `@orpc-ws/oidc-pkce` core now exposes an **observable seam** alongside
its existing pull API:

- **`getAuthState(): AuthSnapshot`** where
  `AuthSnapshot = { status: AuthStatus; user: OidcUser | null }`, plus
  **`subscribe(listener): () => void`**.
- **Cross-tab sync** via the `window` `'storage'` event, lazy-attached
  on the first subscriber and removed on the last; only active with the
  default localStorage-backed `Storage`.
- **The snapshot is referentially stable** (id-token-keyed memoization
  of the decoded user) so it satisfies `useSyncExternalStore`'s
  `Object.is` bail-out.

Why: this is the same `{ getState/getSnapshot + subscribe }` state
contract the client core already follows, so the React hooks
(`useAuthState` / `useUser`) wrap it via `useSyncExternalStore` and
future Svelte/Vue adapters reuse it unmodified. The pull API
(`hasToken` / `getAuthStatus` / `getUser`) is **unchanged** — the
observable seam is purely additive.

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
  `pnpm-workspace.yaml` (`packages/*`, `apps/*`, `tests-e2e`), NOT in a
  root-`package.json` `"workspaces"` array (that field is removed). pnpm
  is provisioned via Corepack — `corepack enable`, version pinned by the
  root `package.json` `packageManager` field (`pnpm@11.6.0`). No yarn.
- **pnpm-11 config split.** As of pnpm 10→11, `.npmrc` carries **only**
  registry/auth config; all other settings move to `pnpm-workspace.yaml`
  as camelCase keys. We deleted `.npmrc` (we had no auth/registry
  overrides) and put `linkWorkspacePackages: true`, `saveExact: true`,
  `engineStrict: true` in `pnpm-workspace.yaml`.
- **Cross-dependency convention:** **all** internal `@orpc-ws/*` deps
  (and the private `@demo/contract` dep) use the **`workspace:*`**
  protocol. `pnpm publish` (invoked by `changeset publish`) rewrites
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

### Versioning & release: Changesets (lockstep)

**This supersedes the earlier custom-script release decision**
(`scripts/sync-version.mjs` + `scripts/publish-all.sh` + a tag-push
`npm-publish.yml` / GH-release `release.yml`, all now removed, along with
the `release:version` root script).

- **Tool: [Changesets](https://github.com/changesets/changesets)**
  (`@changesets/cli`, root devDep; config in `.changeset/config.json`).
- **Lockstep via the `fixed` group** — all eight published packages are
  listed in one `fixed` array, so any release bumps them all to the same
  version (`fixed` does **not** support globs; list each package).
- **Internal deps are `workspace:*`** — `pnpm publish` (driven by
  `changeset publish`) rewrites them to the exact published version.
- **Changelog:** the bundled `@changesets/cli/changelog` (no extra dep).
- **CI flow:** one `changesets/action@v1` workflow on `push: main`
  (`.github/workflows/npm-publish.yml` — name fixed by the npm
  trusted-publisher binding). Push to main with pending changesets → a
  "Version Packages" PR; merge it → publish via OIDC + provenance + GH
  releases. No npm token in steady state.
- **Day-to-day:** `pnpm changeset` per behavior-changing PR. Root
  scripts: `changeset` / `version-packages` (`changeset version`) / `release`
  (`changeset publish`). Full runbook in RELEASING.md.

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
