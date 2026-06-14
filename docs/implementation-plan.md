# Implementation Plan — `@orpc-ws/*` Library

**Status: draft, v2.** Revised after a 4-agent review (architecture/SOLID,
test strategy + migration realism, DX/public API, ORPC/NestJS
integration). All sign-off-blocker findings folded in; remaining
open items live at the bottom under §"Open for discussion".

**Source of truth for decisions:** `CLAUDE.md` (repo root).
**Source of truth for behavior to preserve:**
`~/Developer/projects/ankimcp/anki-mcp-saas/docs/orpc-ws-library-design.md`.

---

## Phase 0 — Repo skeleton (1 PR, ~1 day)

**Goal:** green CI on a fresh clone; packages compile + lint + smoke-test pass.

### Files
- `package.json` (root, private) + `pnpm-workspace.yaml` (workspace globs: `packages/*`)
- `turbo.json` (pipelines: `build`, `lint`, `typecheck`, `test`; `outputs: ["dist/**"]`)
- `tsconfig.base.json` — `strict`, `noUncheckedIndexedAccess`, ES2022, ESM
- `.eslintrc.cjs` — `import/no-extraneous-dependencies` + `import/no-restricted-paths` (framework-free guard, see below)
- `vitest.base.ts` — shared config (fake timers, happy-dom, common matchers)
- `.gitignore`, `pnpm-workspace.yaml` settings (`engineStrict: true`, `saveExact: true`, `linkWorkspacePackages: true`)
- `.github/workflows/ci.yml` — `turbo run lint typecheck test build` + turbo cache

### Shared types pinned in Phase 0
Defined once in `packages/orpc-ws-shared` (a workspace-internal helper, not published; pure TS types only) and consumed by all packages:

- **`Logger` interface** — minimal Pino-compatible shape, structured-arg-friendly:
  ```ts
  export interface Logger {
    debug(msg: string, meta?: Record<string, unknown>): void;
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  }
  export const noopLogger: Logger; // default
  ```
- **`Clock` interface** — `now(): number`; `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval` proxies. Constructor-injected; tests inject fake.
- **`Rng` interface** — `next(): number` returning `[0, 1)`. Constructor-injected; tests inject seeded.

### Framework-free lint guard
```js
// .eslintrc.cjs
"import/no-restricted-paths": ["error", {
  zones: [
    // Client core: no framework imports except inside src/react/
    { target: "packages/orpc-ws-client/src",
      except: ["./react/**"],
      from: ["node_modules/react", "node_modules/react-dom",
             "node_modules/vue", "node_modules/svelte", "node_modules/solid-js",
             "node_modules/@nestjs", "node_modules/reflect-metadata"],
      message: "Client core must remain framework-free; framework code lives in adapters." },
    // React sub-path: no reaching into unstable internals
    { target: "packages/orpc-ws-client/src/react",
      from: ["packages/orpc-ws-client/src"],
      except: ["../index.ts", "../state/connection-state.ts"],
      message: "React adapter consumes the public composition root only." },
    // Server core: no framework imports at all
    { target: "packages/orpc-ws-server/src",
      from: ["node_modules/@nestjs", "node_modules/express", "node_modules/fastify",
             "node_modules/reflect-metadata"],
      message: "Server core must remain framework-free." },
  ]
}]
```

### Package layout
```
packages/
  orpc-ws-shared/             # workspace-internal: Logger/Clock/Rng + shared types
    src/index.ts
  orpc-ws-client/             # browser core (vanilla TS)
    src/index.ts              # createOrpcWsClient export
    src/react/index.ts        # sub-path React adapter
    package.json              # "exports": {".": "./dist/index.js", "./react": "./dist/react/index.js"}
    src/__tests__/smoke.test.ts
  orpc-ws-server/             # server core (vanilla Node + ws + @orpc/server)
    src/index.ts              # OrpcWsServer class
    src/__tests__/smoke.test.ts
  orpc-ws-server-nestjs/      # NestJS adapter (separate package — decorator metadata)
    src/orpc-ws.module.ts
    src/index.ts
    package.json              # @nestjs/common, @nestjs/core as peerDep
    src/__tests__/smoke.test.ts
```

### Definition of done
- `pnpm install` from root succeeds
- `turbo run typecheck lint test build` passes on CI
- One smoke test per package
- No production code beyond `index.ts` placeholders + smoke tests

---

## Phase 1 — Client core: per-module test-gated lift (several PRs, ~9 days)

**Goal:** existing 17-file client tree lives in `@orpc-ws/client` with no app-specific imports, no module-level singletons, and **every behavioral change covered by a regression test in the same PR** that introduces it.

### Discipline (non-negotiable)
- **Each file is lifted only when its regression test is green** in the same PR (or stacked PR pair).
- **Module-level singletons are forbidden.** The existing code exports `connectionStateManager`, `websocketHolder`, `heartbeatMonitor`, `heartbeatSubscriber`, `websocketFactory`, `linkFactory` as module-level instances. ALL of these convert to plain class exports. The composition root (`createOrpcWsClient`) instantiates them.
- **Storm guard state** moves from module-level (`lastWsAuthRefreshAttemptedAt`) into a `ReconnectManager` instance field.

### Sub-phases (each a PR)

| # | Sub-phase | Files lifted | Regression test(s) shipped same-PR |
|---|---|---|---|
| 1.1 | `state/` | `connection-state.ts`, `websocket-holder.ts` | Bug 7 (no immediate-callback in subscribe); Bug 10 (`currentAttemptOpened` lifecycle) |
| 1.2 | `lifecycle/` + normalizer | `websocket-factory.ts`, `event-handlers.ts`, **new** `event-normalizer.ts`, **new** `close-decision.ts` | D3 normalizer contract (synthetic partysocket@1.1.19 close shapes); close-decision tree (1000+!opened / 1000+opened / 1008 / 4005); Bug 4 (auth-failure stale-token); Bug 9 (stale-WS close clobbering) |
| 1.3 | `reconnect/` | `reconnect-manager.ts`, `token-refresh-handler.ts` **(kept — NOT dead code)** | Storm guard within 30s window; debounce + jitter determinism (seeded RNG); mutex serialization; Bug 1 (stale-token-after-sleep — URL provider re-reads token) |
| 1.4 | `client/` + `auth/` | `link-factory.ts`, `orpc-client.ts`, **new** `auth/token-provider.ts` (interface) | Lazy link creation; raw `link` is package-internal (test: `OrpcWsClient` does not expose `link`) |
| 1.5 | `heartbeat/` | `monitor.ts`, `subscriber.ts` (refactored to `link.call(["__orpc_ws_lib__","heartbeat"], …)`) | Bug 8 (heartbeat through ORPC framing, not raw `ws.send`); monitor watchdog with fake clock |
| 1.6 | `sleep/` | `sleep-detector.ts`, `sleep-detector.worker.ts` | Drift detection with fake clock (unit); honest note that "real device sleep" needs E2E (Phase 7) |
| 1.7 | `config/` + composition root | `reconnect-config.ts`, `url-builder.ts` (handles "no token → no `?token=` param" — cookie-auth-ready), `src/index.ts` (`createOrpcWsClient` factory) | Factory wires all classes; smoke test connects to stub `ws` server end-to-end |

### Source structure (after Phase 1)
```
packages/orpc-ws-client/src/
  state/
    connection-state.ts        # class ConnectionStateManager
    websocket-holder.ts        # class WebSocketHolder
  lifecycle/
    websocket-factory.ts       # class WebSocketFactory
    event-handlers.ts          # class EventHandlers — orchestration only
    event-normalizer.ts        # NEW — D3 anti-corruption layer
    close-decision.ts          # NEW — pure function (NormalizedCloseEvent, holderState) → CloseDecision
  client/
    link-factory.ts            # class LinkFactory
    orpc-client.ts             # exposes typed proxy; raw link is package-internal (NOT on public OrpcWsClient)
  heartbeat/
    monitor.ts                 # class HeartbeatMonitor
    subscriber.ts              # uses link.call(["__orpc_ws_lib__","heartbeat"], undefined, {signal})
  reconnect/
    reconnect-manager.ts       # class ReconnectManager — owns storm-guard window
    token-refresh-handler.ts   # class — NOT dead; kept, de-app-ified. Used by ReconnectManager.
  sleep/
    sleep-detector.ts
    sleep-detector.worker.ts
  config/
    reconnect-config.ts
    url-builder.ts
  auth/
    token-provider.ts          # TokenProvider interface
    types.ts                   # onTerminalAuthFailure callback type
  internals/
    clock.ts                   # Clock interface + default Date-backed impl
    rng.ts                     # Rng interface + default Math.random-backed impl
  upload/                      # Phase 6 placeholder
  index.ts                     # createOrpcWsClient composition root
```

### Files explicitly NOT migrating
- `apps/web/src/lib/auth.ts` → stays in consumer
- `apps/web/src/lib/auth-failure.ts` → stays in consumer
- `checkWebSocketTokenValidity` (in current `public-api.ts`) — reaches into `tokenStorage` (consumer-side); consumer reimplements if needed using `TokenProvider.getToken()` + their own expiry decoding

### Definition of done (Phase 1 as a whole)
- Zero `@/...` or `@repo/...` consumer-app imports anywhere in `src/`
- Zero module-level singletons
- 10 regression tests passing (Bug 7 deferred to Phase 2 — needs React)
- Lint, typecheck, build green

---

## Phase 2 — React adapter (1 PR, ~2 days)

### Files
- `src/react/use-connection-state.ts` — one-liner over `useSyncExternalStore`
- `src/react/provider.tsx` — optional `OrpcWsProvider` + `useOrpcWs()`
- `src/react/index.ts` — barrel
- `package.json` — `exports` map adds `./react`; `react` as peerDep
- `tests/integration/bug-07-strictmode-double-mount.test.tsx` — `@testing-library/react` + `<StrictMode>`

### Adapter docs (in `README.md`)
One-liner consumer adapter examples for each future-supported framework — confirms the state contract is generic, without shipping the adapters:
```ts
// Svelte (needs adapter — store contract expects immediate callback;
// library's subscribe does NOT immediately callback per Bug 7 fix):
function toSvelteStore(state) {
  return { subscribe(cb) { cb(state.getState()); return state.subscribe(() => cb(state.getState())); } };
}
// Vue customRef, Solid from(), etc. similarly noted.
```

### Definition of done
- `import { useConnectionState } from "@orpc-ws/client/react"` works in a consumer app
- Bug 7 (StrictMode double-mount) regression passes
- `.d.ts` correctly typed for the sub-path

---

## Phase 3 — Server core + stealth heartbeat (3 PRs, ~6 days)

**Merged from old Phase 4 + Phase 7.** Server core cannot stand without the heartbeat being wired (Phase 4 alone has heartbeat files but no path to test them end-to-end). Doing both together keeps invariants honest.

### Files
```
packages/orpc-ws-server/src/
  lifecycle/
    verify-client-orchestrator.ts   # pre-101 auth; calls consumer's verifyClient
    connection-handler.ts           # sync until rpcHandler.upgrade()
  state/
    connection-registry.ts          # userConnections Map, atomic delete-if-same
  heartbeat/
    publisher.ts                    # MemoryPublisher for __orpc_ws_lib__.heartbeat
    ws-ping-pong.ts                 # WS ping/pong + WeakMap aliveness + zombie terminate
    system-router.ts                # Internal ORPC router fragment:
                                    #   __orpc_ws_lib__: { heartbeat: os.handler(...).output(z.custom<AsyncIterable<HeartbeatEvent>>()) }
                                    # NO .input() (or .input(z.void())); NO auth middleware (empty context)
  router/
    router-composer.ts              # Spread system router into consumer router;
                                    # collision-assert AT forRoot/constructor time (NOT at attach)
  config/
    heartbeat-config.ts
    connection-config.ts
  internals/
    clock.ts, rng.ts                # same interfaces as client
  index.ts                          # OrpcWsServer class (start, attach, broadcast, closeUser, dispose)
```

### Key invariants (preserve verbatim from existing gateway)
- `verifyClient` runs BEFORE 101 response (Bug 5 fix)
- `'connection'` handler is sync until `rpcHandler.upgrade()` completes
- `userConnections.delete(sub)` is atomic with "is this still the same WS?" check (close-clobbering prevention)
- Dual heartbeat (ORPC publisher + WS-protocol ping/pong)
- Heartbeat collision check happens **eagerly** in the `OrpcWsServer` constructor (so consumers see startup errors immediately, not on first connection)

### Sub-phases
| # | Sub-phase | Test (same PR) |
|---|---|---|
| 3.1 | `state/connection-registry.ts` + `lifecycle/connection-handler.ts` | atomic delete-if-same; Bug 5 (message-after-open race); Bug 9 server-side equivalent |
| 3.2 | `heartbeat/publisher.ts` + `ws-ping-pong.ts` + `system-router.ts` + `router-composer.ts` | router collision throws at constructor; publisher single timer N subscribers; Bug 8 (heartbeat over ORPC, not raw `ws.send`) |
| 3.3 | Composition root + `OrpcWsServer.start/attach/dispose` | full happy-path integration (ORPC call works); failed `verifyClient` → no 101; `dispose()` closes all with 4009 |

### Definition of done
- Zero `@nestjs/*` imports
- Zero `reflect-metadata` imports
- Three sub-phase integration tests + unit tests passing
- Consumer's `TContract` does not need any library-owned shape merged in

---

## Phase 4 — Server tests (1 PR, ~3 days)

Backfill anything not covered alongside Phase 3 lifts:
- Bug 6 server side: real WS ping/pong over 5s without messages, frames flow
- `BeforeApplicationShutdown` ordering: dispose runs before HTTP server stops, clients receive 4009 before TCP RST
- Hooks (`onConnected`, `onDisconnected`, `onKicked`, `onZombieTerminated`) fire with correct args

### Explicitly consumer-owned tests (NOT in library)
- `azp` JWT claim verification (consumer's `verifyClient`)
- `metricsMiddleware` integration (consumer's ORPC middleware)
- `EventBusService` fanout (consumer-owned procedure)

---

## Phase 5 — NestJS adapter (1 PR, ~2 days)

### Pattern
Use **`ConfigurableModuleBuilder`** (Nest 10/11 idiomatic) — gets `forRoot` + `forRootAsync` for free.

```ts
export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<OrpcWsServerOptions>()
    .setClassMethodName("forRoot")
    .build();
```

### Files
```
packages/orpc-ws-server-nestjs/src/
  orpc-ws.module.ts        # extends ConfigurableModuleClass; provides OrpcWsService
  orpc-ws.service.ts       # @Injectable.
                           # OnApplicationBootstrap → attach(HttpAdapterHost.httpAdapter.getHttpServer())
                           # BeforeApplicationShutdown → dispose() (graceful — runs before HTTP server stops in Nest 11)
  index.ts
```

### Primary documented usage — `forRootAsync` (NOT `forRoot`)
Reality check: 100% of real Nest consumers need `forRootAsync` because `verifyClient` depends on `AuthService` / `ConfigService`. README leads with this:

```ts
OrpcWsModule.forRootAsync({
  inject: [AuthService, MetricsService],
  useFactory: (auth: AuthService, metrics: MetricsService) => ({
    router: appRouter,
    verifyClient: async (ctx) => auth.verifyWsToken(ctx),  // <-- consumer's existing service
    hooks: { onConnected: (u) => metrics.recordConnection(u) },
  }),
});
```

`verifyClient`'s discriminated-union return (`{ ok, user } | { ok: false, code, reason }`) — **documented rationale**: `verifyClient` runs inside `ws`'s upgrade callback, BEFORE Nest's request pipeline exists. There's no exception filter to translate thrown errors; throwing here forces the library to catch + map. The discriminated union is the simpler, more honest shape. (Counter-pattern to `UnauthorizedException` is intentional.)

### HTTP-adapter neutrality scope (v1)
- **Express only on v1.** `httpAdapter.getHttpServer()` returns Node's `http.Server`; `new WebSocketServer({ server })` attaches cleanly.
- **Fastify TBD** — Fastify intercepts HTTP upgrade; would need `noServer: true` + manual `httpServer.on('upgrade', …)` wiring. Documented in README as unsupported on v1 with a tracking issue.

### Definition of done
- Nest integration test bootstraps `forRootAsync`, opens WS, runs ORPC call, shuts down gracefully (no leaked connections)
- `OrpcWsServer` injectable for advanced consumers (broadcast, closeUser)
- README primary example uses `forRootAsync`

---

## Phase 6 — Upload: HTTP transport, `orpc-http` strategy (2 PRs, ~3 days)

### Client side
- `src/upload/strategy.ts` — `UploadStrategy` interface; strategy-specific options via discriminated union:
  ```ts
  type UploadOptions<TContract> =
    | { strategy: "orpc-http"; procedure: Path<TContract>; onProgress?: (p: Progress) => void; signal?: AbortSignal }
    | { strategy: "presigned-url"; /* reserved */ };
  ```
- `src/upload/orpc-http-strategy.ts` — uses ORPC's HTTP `RPCLink` with native multipart
- **Public API surface**: `client.upload(file, opts)` is exposed **only when `uploads` config is present** (TypeScript narrowing via discriminated union on the client return type — `UploadCapable` sub-interface). Consumers who don't upload never see the method.

### `procedure` is typed, NOT `string`
`Path<TContract>` is a tuple type derived from the contract's nested keys. Compile error if the procedure is renamed in the contract. This is the entire point of using ORPC; the day-0 plan's string-typed field would have silently broken on rename.

### Server side (NestJS adapter)
- `forRoot` gains `uploads?: { httpPath: string; bodyLimitBytes?: number }`
- When configured, the NestJS adapter constructs a **second `RPCHandler`** from the **same** composed router — one handler per transport:
  - WS: `new RPCHandler` from `@orpc/server/ws`
  - HTTP: `new RPCHandler` from `@orpc/server/fetch` (or `/node`, TBD per Nest http adapter)
- Both handlers share the consumer's router + the library's system router. (The plan v1 said "same `RPCHandler`" — that was wrong; ORPC has separate handler classes per transport. Same *router*, two *handlers*.)
- HTTP route runs the same `verifyClient` for symmetric auth (token from `Authorization: Bearer` header)
- **Startup assertion**: at `forRoot`, library checks if `httpPath` collides with any existing Nest controller route (via `app.getHttpAdapter().getInstance()` route registry). Throws on collision.

### Body limits
ORPC's HTTP path has a ceiling; for files >10 MB, apply ORPC's body-limit plugin (exact name TBD at implementation time — `BodyLimitPlugin` per recent docs, configured on the HTTP `RPCHandler`).

### Strategy reservation
- `"presigned-url"` declared in the type union but throws `Not implemented` at runtime
- Adding it later is purely additive — same `client.upload(file, opts)` public API

### Definition of done
- `client.upload(file, ...)` works end-to-end against the NestJS adapter
- Rename test: rename a contract procedure → compile error from `Path<TContract>` (not runtime error)
- Same `TokenProvider` consulted on HTTP and WS
- Path collision detected at startup

---

## Phase 7 — E2E (1 PR, ~3 days, **NEW**)

The previous plan put bugs 1 (token across tab sleep), 6 (K8s proxy idle drop), 11 (tab sleep undetected) in "integration tests" that, on inspection, can't actually simulate the failure mode without real infrastructure. These move to E2E:

### Tests against real services
- `tests-e2e/bug-01-token-across-real-sleep.test.ts` — uses Playwright with `page.evaluate` to simulate clock jump + storage swap; assert real reconnect uses new token.
- `tests-e2e/bug-06-k8s-30s-idle.test.ts` — spin up a local Traefik / nginx proxy with low idle timeout; assert connection survives via WS ping/pong (or document this as a manual / CI-environment-specific test).
- `tests-e2e/bug-11-real-device-sleep.test.ts` — Playwright with `Page.emulateNetworkIdle` + fake timing skew; assert sleep detection fires and reconnect happens.
- `tests-e2e/heartbeat-end-to-end.test.ts` — confirms stealth path is reachable from a real client against a real server.
- `tests-e2e/upload-end-to-end.test.ts` — full upload through the NestJS adapter (Phase 6).

### Integration vs unit-smoke (relabeled)
- `bug-06-keepalive-through-proxy.test.ts` in Phase 3 is renamed `bug-06-pingpong-mitigation.test.ts` — it asserts the *mitigation* (ping/pong frames flow) on loopback, NOT the real failure mode. The real failure mode is covered in `tests-e2e/`.
- Same relabel for `bug-11-sleep-detector-drift-unit.test.ts`.

### Definition of done
- E2E tests run in a separate CI job (slower); not blocking PR merges by default
- README documents how to run E2E locally

---

## Phase 8 — Documentation (1 PR, ~1 day)

- `README.md` per package: install, quickstart, API, common gotchas, framework-adapter snippets (Svelte/Vue/Solid one-liners)
- Top-level `README.md`: project intro, links
- Migration guide for `anki-mcp-saas`: exact import-swap recipe per consumer file
- Sequence diagrams: connect, auth-fail reconnect, heartbeat tick, kicked (4005), upload

---

## Migration into source app — separate work, separate repo

Per design doc §8:
- `apps/web` shim at `apps/web/src/lib/websocket/index.ts` re-exports the existing 8 public names backed by `createOrpcWsClient()`. **Exception**: `checkWebSocketTokenValidity` does NOT migrate — consumer reimplements it locally if still needed (it reaches into consumer-side `tokenStorage`).
- `apps/api` swaps `WebSocketModule` for `OrpcWsModule.forRootAsync({...})`. Gateway shrinks from 952 → **~350-400 LOC** (revised from original 250 estimate — the gateway carries substantial consumer-domain router code that stays).
- Library v0.x stays unstable until source-app migration shakes out the API gaps.

---

## Cross-cutting concerns

### Type safety
- All packages: `"strict": true`, `noImplicitAny`, `noUncheckedIndexedAccess`
- Public API surface in each `index.ts` is fully typed
- No `any`; if a third-party type forces it, isolated in a named adapter file

### Logging
- Each package accepts a `logger: Logger` option (interface in `@orpc-ws/shared`)
- Default: `noopLogger`
- Library code uses `logger.debug|info|warn|error`. Never `console.*`.

### Clock + RNG
- `src/internals/clock.ts` and `src/internals/rng.ts` per package
- Constructor-injected into `ReconnectManager`, `HeartbeatMonitor`, `SleepDetector`
- Tests inject fake clock + seeded RNG for jitter + storm-guard determinism

### Public-surface review checklist (every phase)
- ✅ Sub-interface for upload (no leak when uploads not configured)
- ✅ `state` shape only exposes `{ getState, subscribe }` (no extras until a framework needs them)
- ✅ Raw `RPCLink` is package-internal; not on `OrpcWsClient`
- ✅ `broadcast<TPath extends Path<TContract>>(path, payload: PayloadOf<TContract, TPath>)` — typed, not `any`

### Versioning
- All packages start at `0.1.0`. Coupled releases until 1.0.
- Source-app migration drives the gap-finding pass before 1.0.

---

## Revised calendar

| Phase | Description | Calendar |
|------:|-------------|---------:|
| 0 | Skeleton | 1 day |
| 1 | Client core (per-module test-gated lift) | 9 days |
| 2 | React adapter | 2 days |
| 3 | Server core + stealth heartbeat | 6 days |
| 4 | Server tests backfill | 3 days |
| 5 | NestJS adapter | 2 days |
| 6 | Upload (HTTP transport) | 3 days |
| 7 | E2E | 3 days |
| 8 | Docs | 1 day |

**Total: ~30 working days (~6 weeks).** Within the same ballpark as the v1 plan's 28 days — the merges (1+2, old-4+old-7) save a couple days but the new E2E phase adds them back, and Bug 7 / Phase 2 grew to a realistic 2 days.

---

## Out of scope (explicit non-goals for v1)

- WS binary streaming uploads
- Resumable uploads (tus.io / S3 multipart)
- `presigned-url` upload strategy implementation (reserved in API)
- Framework adapters beyond React + NestJS
- Fastify HTTP adapter under Nest (TBD)
- Header auth (cookie auth works automatically via optional `tokenProvider`)
- Cookie-based BFF migration (consumer-app concern)
- Remote Turborepo cache

---

## Resolved API shape

All public-surface decisions are now locked. See `CLAUDE.md` for the full text.

- **Client lifecycle: `connect()` + `dispose()` only.** No `disconnect()` / `reconnect()` triplet. Library-internal terminal-state handling for cases like session replacement (close `4005`).
- **State vs events split.** `state.getState() / state.subscribe(cb)` carries connection state (tagged record with `disconnected.{code, willRetry}` and `kicked.reason`). `onEvent` callback carries notifications only (`auth_failure`, `heartbeat_timeout`, `woke_from_sleep`). No overlap.
