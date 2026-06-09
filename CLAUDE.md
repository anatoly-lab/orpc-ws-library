# `@repo/orpc-ws-*` Library Project

Monorepo for extracting the ORPC-over-WebSocket transport from the
`anki-mcp-saas` app into reusable, framework-agnostic packages.

Source design doc (read this first):
`~/Developer/projects/ankimcp/anki-mcp-saas/docs/orpc-ws-library-design.md`

Origin code being extracted:
- Client: `~/Developer/projects/ankimcp/anki-mcp-saas/apps/web/src/lib/websocket/`
- Server: `~/Developer/projects/ankimcp/anki-mcp-saas/apps/api/src/api-gateway/websocket/`

---

## Commands

All tasks run through Turborepo from the repo root (`npm install` first).

| Task | Command | Notes |
|---|---|---|
| Build all | `npm run build` | `tsc` per package; topo-ordered via `^build`. |
| Typecheck all | `npm run typecheck` | `tsc --noEmit`. **The only check the AI assistant may run.** |
| Lint all | `npm run lint` | ESLint flat config; enforces framework-free cores. |
| Unit tests all | `npm run test` | Vitest, per package. **User runs tests — assistant does not.** |
| Full CI gate | `npm run ci` | lint → typecheck → test → build. |
| Clean | `npm run clean` | wipes `dist`, `.turbo`, root `node_modules`. |

Scope to one package:
- `npm run test -w @repo/orpc-ws-client` (or any script: `build`, `lint`, `typecheck`)
- `turbo run test --filter=@repo/orpc-ws-client` (turbo, dependency-aware)

Run a single test file / case (from inside the package dir, or via `-w`):
- `vitest run src/reconnect/__tests__/bug-01-stale-token-after-sleep.test.ts`
- `vitest run -t "storm guard"` (filter by test name)

Regression tests for the design-doc bugs are greppable by filename
(`bug-01-...`, `bug-06-...`, `bug-08-...`) — one named test per fixed bug
(see "Tests from day 0").

Demo (two separate processes — Vite SPA + NestJS server; **user runs these**):
- `npm run dev:demo` (both), or `npm run dev:server` / `npm run dev:spa`
- needs `apps/demo-spa/.env` (copy from `.env.example`) and a running OIDC
  IdP. Preferred IdP is the hosted Keycloak at `keycloak.anatoly.dev`
  (`orpc-ws-demo` realm).

e2e (Playwright + Testcontainers Keycloak, needs Docker; **user runs these**):
- `npm run test:e2e -w @repo/tests-e2e` (root `npm test` skips it).

## Codebase map (as built)

Seven packages under `packages/` (the "Package layout (locked)" section below
states intent; this is the current tree), plus demo apps under `apps/`. Every
non-adapter package is framework-free; the boundary is lint-enforced.

- `@repo/orpc-ws-shared` — internal seam types only (`Logger`, `Clock`,
  `Rng`, `HeartbeatEvent`, and the `HEARTBEAT_NAMESPACE` / `HEARTBEAT_PATH`
  constants). Not published. Both cores depend on it.
- `@repo/orpc-ws-client` — browser core. Composition root `src/index.ts` →
  `createOrpcWsClient<TContract>(opts): OrpcWsClient`. One-concept-each
  modules: `state/`, `client/`, `lifecycle/`, `reconnect/`, `heartbeat/`,
  `sleep/`, `auth/`, `upload/`, `config/`. Tests in per-module `__tests__/`.
- `@repo/orpc-ws-server` — Node core. `src/index.ts` exports the
  `OrpcWsServer<TUser, TContract>` class (`start` / `stop` / `attach`).
  Modules: `lifecycle/`, `router/`, `heartbeat/`, `state/`, `upload/`,
  `config/`.
- `@repo/orpc-ws-oidc-react` — the single React adapter; hosts React bindings
  for BOTH cores. `ws/`: `useConnectionState`, `useWsSubscription`,
  `OrpcWsProvider`, `useOrpcWs`. `oidc/`: `useAuthState`, `useUser`,
  `useOidcCallback`, `RequireAuth`. Optional `./react-router` sub-path adds
  the `OidcCallback` `<Route>` drop-in (`react-router-dom` optional peer).
  Does NOT re-export the cores — consumers import each core directly.
- `@repo/orpc-ws-server-nestjs` — NestJS adapter. `OrpcWsModule.forRootAsync`
  + injectable `OrpcWsService`; wraps core lifecycle in Nest hooks.
- `@repo/oidc-pkce` — browser OIDC/PKCE core, zero deps. Pull API
  (`hasToken` / `getAuthStatus` / `getUser`) + observable seam
  (`getAuthState` / `subscribe`) that the React hooks wrap.
- `@repo/oidc-verifier-jose` — Node JWT verifier (depends on `jose`); a
  sibling of `oidc-pkce` (Node runtime + heavy dep, so not a sub-path).

Apps: `@demo/contract` (shared ORPC contract), `@demo/server` (NestJS,
port 18081), `@demo/spa` (React + Vite, port 5173), `@repo/tests-e2e`.

Two cross-package mechanisms to know before editing:
- **Heartbeat is a "stealth procedure"**, not in the consumer's contract. The
  library merges its own sub-router under the reserved namespace
  `__orpc_ws_lib__.heartbeat` (`HEARTBEAT_PATH` in shared); the client calls
  it via `link.call(...)`. The consumer's `<TContract>` is untouched.
- **State vs events are separate channels**: `client.state` (tagged-record
  `ConnectionState`, for reactive UI) vs `client.onEvent` (notifications:
  `auth_failure` / `heartbeat_timeout` / `woke_from_sleep`).

Note: `README.md` still mentions a `@repo/orpc-ws-client/react` sub-path — that
is stale. React bindings live in `@repo/orpc-ws-oidc-react` (lint config no
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
| `@repo/orpc-ws-client`               | **Client core.** Vanilla TS, fully framework-free. Reconnect, heartbeat, sleep detect, etc. No React sub-path. | none               |
| `@repo/orpc-ws-oidc-react`           | **The library's single React adapter.** Hosts the React bindings for both cores (WS connection-state hooks + OIDC auth hooks) only. Does **not** re-export the cores — consumers import the framework-free APIs directly from `@repo/orpc-ws-client` / `@repo/oidc-pkce`. Also exposes an optional `./react-router` sub-path (see prose below). | `react` peer (+ optional `react-router-dom` on the sub-path) |
| `@repo/orpc-ws-server`               | **Server core.** Pure Node + `ws` + `@orpc/server`. Verifier-pluggable.   | none               |
| `@repo/orpc-ws-server-nestjs`        | NestJS adapter (separate package — decorator metadata can't share a sub-path with vanilla TS without bundler pain). | `@nestjs/common` peer |

Future adapters (Svelte / Vue / Solid on client; Express / Fastify /
standalone Node on server) are **not** built on day 0. The contract
with future-us: any of them must be addable as a thin (~50–150 LOC)
sibling package without touching the core. If a future adapter requires
core changes, the seam is wrong — fix the seam, not the adapter.

**Framework adapters are siblings, one merged adapter per framework
(resolved).** Each framework adapter for this library is its own
**separate sibling package — never a sub-path _of a core_** — and there
is **one merged adapter per framework, not one-per-core**. The
"never a sub-path" rule protects the *cores*: `@repo/orpc-ws-client`
and `@repo/oidc-pkce` never carry framework code via a sub-path (this
is why the old `@repo/orpc-ws-client/react` sub-path was removed). It
does **not** forbid an *adapter* from exposing its own internal
sub-path: an adapter MAY surface an optional, more-heavily-coupled
framework binding behind a sub-path of *itself* (see
`@repo/orpc-ws-oidc-react/react-router` below), so that the adapter's
main entry stays free of the extra dependency. Such a sub-path lives
*inside* the sibling adapter, not on a core, so it satisfies — not
violates — the "Sub-path vs separate sibling package" rule below. The
first instance is `@repo/orpc-ws-oidc-react`, which depends on *both*
cores (`@repo/orpc-ws-client` + `@repo/oidc-pkce`) and exposes the
React bindings for both. It does **not** re-export the cores —
consumers import the framework-free APIs directly from each core.

Why merged, not per-core: the library's scope is "browser↔server WS
connection using OIDC" as a unit — every consumer needs *both* cores,
so a single merged React adapter (rather than a separate WS-react and
OIDC-react) keeps the React glue in one place. Per-core React siblings
(e.g. a standalone OIDC-react) were explicitly **rejected**: auth-only,
non-WS reuse of an OIDC-react package is out of scope. Future framework
adapters follow the same shape — one `@repo/orpc-ws-oidc-svelte`, one
`@repo/orpc-ws-oidc-vue`, each depending on both cores and exposing
framework bindings only. Cores stay framework-free; adapters add only
the framework glue.

**Sub-path vs separate sibling package (cores and server-side
helpers).** A sub-path adapter is appropriate when (a) it targets the
same runtime environment as the core (browser/browser, Node/Node),
AND (b) it only adds peer dependencies, doesn't drag runtime deps
into the core's `package.json`. A separate sibling package is required
when either condition fails — different runtime (e.g. a server-side
helper for a browser-only package) OR different runtime-dep set (e.g.
a helper requires a heavy library like `jose` that the core shouldn't
carry). Example today: `@repo/oidc-pkce` (browser, zero deps) +
`@repo/oidc-verifier-jose` (Node, depends on `jose`) live as siblings
because both conditions fail.

### Adapter wiring convention

- **Cores are pinned, framework is peer.** The adapter depends on each
  core via **exact-version `dependencies`** (e.g. `"0.1.0"`, consistent
  with the repo's `save-exact=true`; never `workspace:*`). The
  framework (`react`) is the only `peerDependencies` entry, with a wide
  range (e.g. `">=18.0.0"`).
- **Adapter exposes framework bindings only; cores are imported
  directly.** The adapter does **not** re-export the cores. It exports
  only its React bindings: `useConnectionState`, `useWsSubscription`,
  `OrpcWsProvider`, `useOrpcWs`, `OrpcWsProviderProps`, `useAuthState`,
  `useUser`, `useOidcCallback`, `RequireAuth`. Consumers import the framework-free APIs straight
  from each core. The cores remain regular `dependencies` of the adapter
  (the hooks `import type` from them, and the emitted `.d.ts` references
  those types, so the dep must resolve) — `react` is the sole peer.
- **Optional, heavier-coupled bindings live behind an internal
  sub-path.** The adapter's main entry stays free of any router or
  other heavier framework dependency. A binding that needs more than
  `react` lives at a *second* entry point — e.g. the `OidcCallback`
  drop-in React-Router `<Route>` component at
  `@repo/orpc-ws-oidc-react/react-router`, which adds `react-router-dom`
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
  import { createOrpcWsClient } from "@repo/orpc-ws-client";
  import { createOidcAuth } from "@repo/oidc-pkce";
  import { useConnectionState, useAuthState }
    from "@repo/orpc-ws-oidc-react";
  // createOrpcWsClient(...) ; createOidcAuth(...) from the cores;
  // hooks from the adapter.
  ```

Validated against TanStack / XState / Zag.js: core + per-framework
sibling, exact-pinned core dep, framework as peer, lockstep versions.
Lockstep versioning keeps adapter↔core skew unrepresentable. (We
deliberately do **not** re-export the cores the way
`@tanstack/react-query` re-exports `@tanstack/query-core` — keeping each
core the single source of its own public surface.)

### Discipline that enforces "framework-free core"

- **Lint rule** (`eslint-plugin-import/no-restricted-paths` or equivalent):
  `@repo/orpc-ws-client` and `@repo/orpc-ws-server` source must not
  import from `react`, `@nestjs/*`, `vue`, `svelte`, `solid-js`,
  `express`, `fastify`. CI fails on violation.
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
- **Library owns the 30s storm guard internally.** Single window
  across all triggers (heartbeat timeout, close-code 1008/4001,
  pre-open 1000, HTTP-upload 401). The current app has *two*
  independent storm-guard timestamps; the library design *fixes*
  that drift.
- **Token transport is URL query param.** `?token=` for WS,
  `Authorization: Bearer` for HTTP (when `uploads` is configured).
  `tokenProvider` is **optional** at the type level — omitting it
  means "no token, browser handles auth via cookies if any." Cookie
  auth is therefore supported without library changes; it's a
  consumer decision, not a library feature.

### Reactive auth seam — observable `@repo/oidc-pkce`

The `@repo/oidc-pkce` core now exposes an **observable seam** alongside
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

### Monorepo tooling: npm workspaces + Turborepo

- **Package manager: npm workspaces** (built-in since npm v7). Root
  `package.json` declares `"workspaces": ["packages/*"]`. No pnpm,
  no yarn. Anyone with a recent Node + npm can clone and `npm install`.
- **Task orchestration: Turborepo.** Provides dep-aware task graph,
  parallel execution, local cache, and `--filter` for affected-package
  builds. `turbo.json` lives at the repo root.
- **Remote cache: not configured initially.** Local cache only. Add
  remote cache later if CI gets slow and the team is OK with a Vercel
  dependency (or self-host).
- **Lint compensation for npm-workspaces' looser strictness:**
  `eslint-plugin-import` with `no-extraneous-dependencies` to catch
  accidental phantom imports (pnpm would have prevented these natively;
  with npm we enforce via lint).

Rationale: a 4-package library that may grow to 8+ as framework
adapters land. Turborepo's filter and caching pay off as soon as the
adapter count grows; npm workspaces keeps the entry barrier zero
("anyone with Node can clone and run").

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
