# SOLID / Design Review — library packages

Reviewer: Fable (architecture review, review-only). Scope: `packages/*/src`,
non-test files, measured against the repo's own CLAUDE.md "Non-negotiable
principles". Demo apps and `__tests__/` excluded.

## Summary

The codebase is in genuinely good shape against its own rules: **zero**
`console.*` / `process.env` / `: any` / `as any` violations in library source,
the `Clock` / `Rng` / `Logger` seams are used consistently throughout both WS
cores, the framework-free-core rule holds (no `react` / `@nestjs` / `express`
imports anywhere in `orpc-ws-client`, `orpc-ws-server`, or `oidc-pkce`), and
composition genuinely happens only at the three composition roots. The
violations that do exist cluster in two places: **the "no god files" ceiling is
broken by both composition roots** — `orpc-ws-client/src/index.ts` at **641
LOC** (more than 2× the ~300 ceiling, and doing four distinguishable jobs) and
`orpc-ws-server/src/index.ts` at 447 LOC — plus four files marginally at/over
the line; and **the `oidc-pkce` package quietly opts out of the seam
discipline** the WS cores follow (raw `Date.now()`, raw `sessionStorage`, raw
`window.location.href`, raw `fetch` — some documented in code comments, none
ratified in CLAUDE.md's "Resolved design decisions" as the rules require).
Beyond that, the findings are design smells, not breakages: a dead parameter
that forces an ugly cast at the client composition root, a hand-maintained
duplicate of the sleep-detector worker source with a hardcoded interval that
silently ignores the configurable `pollIntervalMs`, and two small DRY slips.

## LOC census (non-test sources, `wc -l`)

Total: 9,524 LOC across 78 files. Files at or above the ~300 ceiling flagged.

| File | LOC | Flag |
|---|---:|---|
| `packages/orpc-ws-client/src/index.ts` | 641 | **>300 — 2.1×** |
| `packages/orpc-ws-server/src/index.ts` | 447 | **>300 — 1.5×** |
| `packages/oidc-pkce/src/client.ts` | 334 | **>300** |
| `packages/orpc-ws-server/src/upload/http-handler.ts` | 325 | **>300** |
| `packages/orpc-ws-client/src/reconnect/reconnect-manager.ts` | 308 | **at ceiling (~)** |
| `packages/orpc-ws-server-nestjs/src/orpc-ws.service.ts` | 302 | **at ceiling (~), two concepts** |
| `packages/orpc-ws-client/src/sleep/sleep-detector.ts` | 297 | — |
| `packages/orpc-ws-client/src/lifecycle/event-handlers.ts` | 281 | — |
| `packages/orpc-ws-client/src/heartbeat/subscriber.ts` | 260 | — |
| `packages/orpc-ws-client/src/heartbeat/monitor.ts` | 246 | — |
| `packages/orpc-ws-client/src/reconnect/token-refresh-handler.ts` | 242 | — |
| `packages/orpc-ws-server/src/lifecycle/connection-handler.ts` | 227 | — |
| `packages/oidc-pkce/src/types.ts` | 226 | — |
| `packages/orpc-ws-client/src/lifecycle/event-normalizer.ts` | 220 | — |
| `packages/oidc-pkce/src/tokens.ts` | 215 | — |
| `packages/oidc-verifier-jose/src/client.ts` | 214 | — |
| `packages/orpc-ws-oidc-react/src/ws/use-ws-subscription.ts` | 211 | — |
| `packages/oidc-pkce/src/flow.ts` | 203 | — |
| (remaining 60 files) | ≤194 each | — |

A large share of the big files' LOC is comment density (deliberate, per
CLAUDE.md "Human-readable"), but the ceiling is stated as LOC-per-file with no
comment carve-out, and the two composition roots exceed it on *code and
concept count*, not just prose.

## Banned-construct scan (verified `file:line`)

Grep targets: `console.`, `process.env`, `Date.now(`, `Math.random(`,
`: any`, `as any`, `any>`, raw `setTimeout`/`setInterval`. Each hit manually
classified.

**Real violations (library src):**

| Construct | Location | Note |
|---|---|---|
| `Date.now()` | `packages/oidc-pkce/src/tokens.ts:69`, `:123`, `:210` | Documented in-file as intentional (`tokens.ts:7-10`), NOT ratified in CLAUDE.md — see ARCH-7 |
| `sessionStorage` (uninjected) | `packages/oidc-pkce/src/flow.ts:47-48,81-82,160-161` | PKCE verifier/state storage has no seam (tokens storage *does*) — ARCH-7 |
| `window.location.href` (uninjected) | `packages/oidc-pkce/src/flow.ts:60,202` | Hard navigation, no seam — ARCH-7 |
| `fetch` (uninjected) | `packages/oidc-pkce/src/tokens.ts:150,193`, `discovery.ts:84`; `packages/oidc-verifier-jose/src/discovery.ts:83` | Side-effecting collaborator not injected — ARCH-7 |

**NOT violations (verified):**

- `packages/orpc-ws-shared/src/clock.ts:36` (`Date.now()`) and
  `rng.ts:18` (`Math.random()`) — these ARE the injected seams; explicitly
  permitted ("the only point... where these raw APIs are touched").
- `packages/orpc-ws-shared/src/logger.ts:51-54` (`console.*`) — the opt-in
  `consoleLogger` bridge. The library never wires it by default
  (`noopLogger` is the default everywhere); consumers opt in. This is the
  documented intent of the rule.
- `packages/orpc-ws-client/src/sleep/sleep-detector.worker.ts:50` and
  `worker-source.ts:43` (`Date.now()` + `self.setInterval`) — inside the Web
  Worker's own thread, where a `Clock` seam can't reach without serializing
  fake-clock state over `postMessage`; the drift *decisions* were correctly
  moved to the main-thread `SleepDetector` behind the injected `Clock`.
  Acceptable — but the worker carries a related config violation (ARCH-8).
- All other grep hits are comments quoting the rule, or test files.
- `: any` / `as any` / `<any>`: **zero hits in library src** (comments only).
- `process.env`: **zero hits** in library src.
- Framework imports in cores: **zero hits** (`react`, `@nestjs/*`, `vue`,
  `svelte`, `solid-js`, `express`, `fastify` — none import-reachable from
  `orpc-ws-client`, `orpc-ws-server`, `oidc-pkce` src).

## Findings index

| ID | Severity | Rule | Location | One-liner |
|---|---|---|---|---|
| ARCH-1 | High | No god files | `orpc-ws-client/src/index.ts` (641 LOC) | Client composition root is 2.1× the ceiling and carries 4 jobs |
| ARCH-2 | High | No god files | `orpc-ws-server/src/index.ts` (447 LOC) | Server composition root 1.5× ceiling; barrel + types + class in one file |
| ARCH-3 | Medium | No god files / one concept | `oidc-pkce/src/client.ts` (334 LOC) | Composition root also implements default Storage + TokenProvider |
| ARCH-4 | Medium | No god files / one concept | `orpc-ws-server/src/upload/http-handler.ts` (325 LOC) | Five separable concerns in one factory |
| ARCH-5 | Medium | One concept per file | `orpc-ws-server-nestjs/src/orpc-ws.service.ts:211-302` | Express route-table introspection embedded in the Nest service |
| ARCH-6 | Medium | Zero Date.now / injected collaborators | `oidc-pkce/src/tokens.ts`, `flow.ts` | oidc-pkce opts out of the seam discipline; deviation not ratified |
| ARCH-7 | Medium | Configurable, not hardcoded | `orpc-ws-client/src/sleep/worker-source.ts:41` | Worker interval hardcoded at 5 s while `pollIntervalMs` is configurable; hand-synced duplicate source |
| ARCH-8 | Medium | Interface segregation / no `any`-shaped casts | `lifecycle/event-handlers.ts:114` + `index.ts:370` | Dead `_wrapper` param forces `{} as unknown as ReconnectingWebSocket` at the composition root |
| ARCH-9 | Low | No spaghetti / DRY | `orpc-ws-client/src/index.ts:392-406,421-437` | Terminal-auth-failure emission duplicated 2× (3× counting ReconnectManager) |
| ARCH-10 | Low | DRY / stated drift-guard | `orpc-ws-server/src/upload/http-handler.ts:141-145` | Re-inlines `extractClientIp` that `request-helpers.ts` exists to centralize |
| ARCH-11 | Low | No `any` (spirit) | `server/index.ts:287`, `upload/http-handler.ts:126`, `client/link-factory.ts:111`, `client/orpc-client.ts:74` | `as never` / `as unknown as` casts at the ORPC boundary |
| ARCH-12 | Low | Configurable, not hardcoded | `orpc-ws-client/src/index.ts:131-192` | Sleep-detector tunables unreachable from the public options object |

---

## ARCH-1 — Client composition root is a 641-LOC god file

- **Rule violated:** "Hard ceiling: ~300 LOC per file. Beyond that, split."
  and "One concept per file."
- **Severity:** High (breaks a stated non-negotiable, by 2.1×).
- **Location:** `packages/orpc-ws-client/src/index.ts` (641 LOC).
- **What & why it matters:** The file does four distinguishable jobs:
  1. **Re-export barrel** for the public surface (lines 34-105).
  2. **Public type definitions with their full contract docs** — `ClientEvent`
     (113-125), `OrpcWsClientOptions` (131-192), `OrpcWsClient` (204-253):
     ~140 lines that are pure API-shape, not wiring.
  3. **The factory/wiring proper** (`createOrpcWsClient`, 279-641) — 13
     numbered wiring steps including the forward-ref dance (351-372).
  4. **Inline behavior**, not just wiring: the terminal-auth-failure policy
     (392-406 and 421-437), the heartbeat-timeout policy (466-478), the
     wake-from-sleep policy (484-498), `connect()`/`dispose()` bodies
     (512-570), and the upload-options adapter (600-626).
  CLAUDE.md says "Composition root is the only place wires meet" — that
  justifies the *wiring* living here, but not the type definitions, the
  barrel, or the inlined policy closures. The file is now the exact shape the
  project says it is escaping ("the 952-line gateway is the anti-pattern").
  Concretely: a reader looking for "what happens on heartbeat timeout" finds
  the answer in the middle of a 360-line factory body rather than in a named
  module.
- **Proposed refactor (PROPOSAL only):**
  - `src/public-types.ts` — `ClientEvent`, `OrpcWsClientOptions`,
    `OrpcWsClient` (+ their docs). ~200 LOC.
  - `src/composition/emitters.ts` (or similar) — the `emit` wrapper and a
    single `fireTerminalAuthFailure(opts, emit, logger)` helper (also fixes
    ARCH-9).
  - `src/composition/wire-uploads.ts` — strategy selection + the
    public-opts→internal-opts adapter (572-626).
  - `index.ts` keeps: barrel re-exports + `createOrpcWsClient` calling into
    the above. Lands well under 300.
- **Confidence:** High (LOC verified by `wc -l`; concept inventory from a
  full read).

## ARCH-2 — Server composition root over the ceiling

- **Rule violated:** "Hard ceiling: ~300 LOC per file."
- **Severity:** High (stated non-negotiable; 1.5×) — though the *class* itself
  is well-factored; the overage is file composition, not class bloat.
- **Location:** `packages/orpc-ws-server/src/index.ts` (447 LOC).
- **What & why it matters:** Three concerns share the file: the public
  re-export barrel (lines 72-115), the public types `OrpcWsServerHooks` /
  `OrpcWsServerOptions` (118-179), and the `OrpcWsServer` class (189-447).
  Unlike ARCH-1, the class body is genuinely composition + thin lifecycle
  (`attach` / `closeUser` / `dispose` are each short and single-purpose, and
  the constructor is numbered wiring steps). So the violation is real but
  mechanical: the file, not the design, is too big.
- **Proposed refactor (PROPOSAL only):** Move `OrpcWsServerHooks` +
  `OrpcWsServerOptions` to `src/public-types.ts` (or `src/options.ts`) and the
  class to `src/server.ts`; `index.ts` becomes a pure barrel. No behavior
  change; every file lands < 300.
- **Confidence:** High.

## ARCH-3 — `oidc-pkce` composition root implements two collaborators inline

- **Rule violated:** "Hard ceiling: ~300 LOC" + "One concept per file" +
  "Composition root is the only place wires meet. Internal modules are pure
  functions or classes with constructor-injected dependencies."
- **Severity:** Medium (marginal LOC overage, but a real cohesion issue).
- **Location:** `packages/oidc-pkce/src/client.ts` (334 LOC) — specifically
  `defaultStorage()` at lines 127-149 and the `tokenProvider` implementation
  (in-flight dedupe + refresh write-through + emit) at lines 202-244.
- **What & why it matters:** The file is named and documented as "the ONE
  place where storage + discovery + flow + tokenProvider wire together" — but
  it also *implements* the default `Storage` (localStorage JSON blob,
  corrupt-blob recovery) and the entire `TokenProvider` (dedupe mutex,
  refresh-failure semantics, store notification). Those are concepts with
  their own invariants (the dedupe-mutex `finally` and the "getToken is
  deliberately DUMB" contract are both load-bearing for the ws-client
  reconnect flow) and deserve their own files + focused tests, leaving
  `client.ts` as wiring.
- **Proposed refactor (PROPOSAL only):** Extract `src/default-storage.ts`
  (`DEFAULT_STORAGE_KEY` + `defaultStorage` — note `auth-store.ts` already
  needs the key, so this also removes a cross-file coupling on a constant
  buried in the composition root) and `src/token-provider.ts`
  (`createTokenProvider(storage, getMetadata, config, authStore)`).
  `client.ts` drops to ~230 LOC of pure composition.
- **Confidence:** High on the facts; Medium on urgency.

## ARCH-4 — HTTP upload handler bundles five separable concerns

- **Rule violated:** "Hard ceiling: ~300 LOC" + "One concept per file."
- **Severity:** Medium (25 lines over; the concern-count is the real issue).
- **Location:** `packages/orpc-ws-server/src/upload/http-handler.ts` (325 LOC).
- **What & why it matters:** One factory closes over: (1) runtime shape-guards
  for consumer hook returns (`isWellFormedAuthResult` /
  `isWellFormedBeforeUploadResult`, lines 76-92), (2) Bearer auth via
  `runVerify` (137-169), (3) the `beforeUpload` gate (183-209), (4)
  mount-style URL normalization — the Express-vs-bare-Node
  `originalUrl`/prefix-stripping dance (259-284), and (5) the ORPC handoff +
  error/404/next() protocol (286-322). Each is individually well-commented,
  but the file is the one place in the server package where a reader must
  hold five protocols in their head at once, and each piece is independently
  unit-testable.
- **Proposed refactor (PROPOSAL only):** Extract `upload/hook-runners.ts`
  (shape-guards + `runVerify` + `runBeforeUpload` as injectable pure-ish
  functions) and `upload/url-normalizer.ts` (`stripMountPrefix(req, httpPath)`
  — the trickiest, most regression-prone logic here and the most deserving of
  its own named test file). `http-handler.ts` keeps handler assembly and the
  response protocol; lands ~150 LOC.
- **Confidence:** High.

## ARCH-5 — Express internals introspection lives inside the Nest service

- **Rule violated:** "One concept per file" / single responsibility per
  module.
- **Severity:** Medium.
- **Location:** `packages/orpc-ws-server-nestjs/src/orpc-ws.service.ts`
  (302 LOC) — `ExpressLayer` / `ExpressApp` / `isExpressApp` /
  `assertNoExpressRouteCollision` at lines 211-302.
- **What & why it matters:** The service is a lifecycle bridge
  (`onModuleInit` / `onApplicationBootstrap` / `beforeApplicationShutdown`),
  which is exactly its stated job. But a third of the file is a different
  concept entirely: structural typing of Express 4/5 router internals and a
  fail-open collision scan of `app._router.stack`. That code has its own
  risk profile (undocumented Express internals, version-sensitive shapes) and
  will be the thing that breaks on an Express major — it should be findable
  and testable on its own, not appended below a Nest `@Injectable`.
- **Proposed refactor (PROPOSAL only):** Move lines 211-302 to
  `src/express-route-introspection.ts` (exports `isExpressApp` +
  `assertNoExpressRouteCollision`). Service imports them; file drops to ~210
  LOC and is single-concept again.
- **Confidence:** High.

## ARCH-6 — `oidc-pkce` opts out of the seam discipline without a ratified decision

- **Rule violated:** "Zero `Date.now()` ... outside an injected clock / RNG
  seam" + "All side-effecting collaborators (logger, token provider,
  verifier, HTTP server, clock, randomness) are injected" + (process rule)
  "if a future finding contradicts one [resolved decision], surface it
  explicitly and update this section."
- **Severity:** Medium. These are literal breaches of a stated non-negotiable
  (which would grade High), downgraded because the `Date.now()` deviation is
  consciously documented in-file with a coherent test strategy — but the
  rules say deviations get surfaced in CLAUDE.md, and this one wasn't.
- **Location (verified):**
  - `packages/oidc-pkce/src/tokens.ts:69`, `:123`, `:210` — raw `Date.now()`
    for `expiresAt` math. In-file justification at `tokens.ts:7-10`: vitest
    `toFake: ["Date"]` fake-timers cover determinism, and threading a `Clock`
    through "would put a seam in the public API for no consumer benefit".
  - `packages/oidc-pkce/src/flow.ts:47-48`, `:81-82`, `:160-161` — raw
    `sessionStorage` for the PKCE verifier/state. Notably *inconsistent* with
    the same package's token storage, which IS behind an injectable `Storage`
    seam (`createOidcAuth(config, { storage })`). A consumer who injects
    in-memory storage for tokens still gets hard `sessionStorage` writes for
    PKCE state.
  - `packages/oidc-pkce/src/flow.ts:60`, `:202` — raw
    `window.location.href = ...` navigation.
  - `packages/oidc-pkce/src/tokens.ts:150,193`, `discovery.ts:84`,
    `packages/oidc-verifier-jose/src/discovery.ts:83` — raw global `fetch`.
- **What & why it matters:** The WS cores honor the seam rules to the letter
  (every timer goes through `Clock`, every random through `Rng`); `oidc-pkce`
  is a different regime in the same monorepo governed by the same CLAUDE.md.
  Practically: flow.ts tests require a DOM with real
  `sessionStorage`/`location`, the redirect paths are untestable without
  intercepting navigation, and a future SSR/native consumer can't substitute
  any of it. Process-wise: CLAUDE.md explicitly forbids silently re-opening
  decided rules; the in-code comments are good, but the decision lives in the
  wrong place.
- **Proposed refactor (PROPOSAL only):** Two acceptable resolutions — pick
  one explicitly:
  1. **Ratify the deviation**: add a CLAUDE.md note that `oidc-pkce` (a
     zero-dep browser core) uses ambient browser globals (`Date.now`, `fetch`,
     `sessionStorage`, `location`) by design, tested via fake timers +
     happy-dom. Cheapest; matches current reality.
  2. **Close the gap**: introduce an optional `{ fetch?, navigate?,
     ephemeralStorage?, now? }` deps bag on `createOidcAuth` (defaults =
     globals). The `sessionStorage`/navigation seams are the highest-value
     ones (testability + the Storage-seam inconsistency).
- **Confidence:** High on the facts; the High-vs-Medium severity call is a
  judgment the maintainer should make when ratifying or rejecting.

## ARCH-7 — Worker tick interval hardcoded; configurable `pollIntervalMs` silently diverges

- **Rule violated:** "All numeric tunables ... live in a config object with
  sensible defaults" — and the hand-synced duplicate violates "single source
  of truth" hygiene the codebase elsewhere insists on.
- **Severity:** Medium.
- **Location:** `packages/orpc-ws-client/src/sleep/worker-source.ts:41`
  (`var INTERVAL_MS = 5000;` inside the `WORKER_SOURCE` string) and its
  hand-maintained twin `sleep-detector.worker.ts:40` (`INTERVAL_MS = 5_000`);
  consumed by `sleep-detector.ts:127` (`pollIntervalMs?: number`).
- **What & why it matters:** `SleepDetectorDeps.pollIntervalMs` is documented
  as a CLAUDE.md-compliant tunable (`sleep-detector.ts:101-104`), but the
  default Blob-URL worker ignores it — its 5 s cadence is baked into a string
  literal. The jsdoc itself admits the trap (`sleep-detector.ts:122-125`:
  "this only affects the main thread's drift threshold. The default ...
  worker still ticks at its hard-coded 5s"). Set `pollIntervalMs: 1000`
  without a custom `workerFactory` and the wake threshold (1 s + 2 s
  tolerance = 3 s) is below the worker's real 5 s cadence → **every tick
  registers as a wake-from-sleep → spurious `woke_from_sleep` events and a
  reconnect on every tick**. A tunable whose override breaks the feature is
  hardcoding with extra steps. The "KEEP IN SYNC" duplicated worker source
  (worker-source.ts:25-29 vs sleep-detector.worker.ts:30-33) is the same
  smell: two copies of runtime logic reconciled by comment.
- **Proposed refactor (PROPOSAL only):** Make `WORKER_SOURCE` a template that
  interpolates the interval — `defaultWorkerFactory(intervalMs: number)` —
  and have `SleepDetector.start()` pass `this.pollIntervalMs` through. That
  single change makes the tunable real AND removes the need for the literal
  to agree across two files (the `.ts` worker file can then be deleted or
  generated; one source of truth). No public API change.
- **Confidence:** High (the divergence and its consequence are verifiable
  from `sleep-detector.ts:277` `threshold = pollIntervalMs +
  driftToleranceMs` vs the fixed 5 s tick).

## ARCH-8 — Dead `_wrapper` parameter forces an unsafe placeholder cast at the composition root

- **Rule violated:** Interface segregation ("Consumers depend only on what
  they use") and the spirit of "No `any`" — `{} as unknown as X` is the same
  type erosion with different syntax.
- **Severity:** Medium.
- **Location:** `packages/orpc-ws-client/src/lifecycle/event-handlers.ts:114`
  (`createHandlers(_wrapper: ReconnectingWebSocket)`) and
  `packages/orpc-ws-client/src/index.ts:360-372`, which fabricates
  `{} as unknown as ReconnectingWebSocket` to satisfy it.
- **What & why it matters:** `createHandlers`'s parameter is, by its own
  comment, "intentionally unused" — the real wrapper is closure-bound inside
  `websocket-factory.ts` and arrives via `onClose(event, w)`. The cost of
  keeping the vestigial parameter is concrete: the composition root needs a
  12-line apology comment plus a fabricated object cast whose only guarantee
  of safety is prose ("never observable, never invoked"). If a future edit
  ever dereferences `_wrapper` inside `createHandlers`, the type system will
  not catch it — the placeholder `{}` will just explode at runtime. The
  stated justification ("parallel position with the factory call site",
  "future hooks have a place to land") is speculative API symmetry — exactly
  the kind of seam CLAUDE.md says to fix rather than work around.
- **Proposed refactor (PROPOSAL only):** Delete the parameter:
  `createHandlers(): WebSocketEventHandlers`. The two call sites
  (`index.ts:369` and `websocket-factory.ts`'s handler wiring) simplify; the
  cast and both comment blocks disappear. If a per-wrapper hook is ever
  needed, add the parameter back *when it is used*.
- **Confidence:** High.

## ARCH-9 — Terminal-auth-failure emission duplicated in the client factory

- **Rule violated:** "No spaghetti ... If a reader chases three files to
  understand one behavior, the seam is wrong" / general DRY; also CLAUDE.md's
  own template praises *one* owner per behavior.
- **Severity:** Low (correct today; drift-prone tomorrow).
- **Location:** `packages/orpc-ws-client/src/index.ts:392-406`
  (ReconnectManager's `onTerminalAuthFailure` wiring) and `:421-437` (the
  no-tokenProvider branch of `onAuthRecoveryNeeded`). A third copy of the
  try/catch-the-consumer-callback pattern lives in
  `reconnect/reconnect-manager.ts:295-307` (`fireTerminalAuthFailure`).
- **What & why it matters:** The sequence "emit `{type: 'auth_failure',
  refreshable: false}` → invoke `opts.onTerminalAuthFailure` inside
  try/catch → log on throw" is the library's single most consequence-laden
  consumer contract (it's the redirect-to-login trigger), and it's
  copy-pasted. A future change (say, adding a reason field to the event) must
  be applied in two places or the two paths silently diverge.
- **Proposed refactor (PROPOSAL only):** One local
  `const fireTerminal = (): void => { emit(...); safeInvoke(opts.onTerminalAuthFailure) }`
  defined next to `emit`, used by both branches. (Falls out for free if
  ARCH-1's `emitters.ts` extraction happens.)
- **Confidence:** High.

## ARCH-10 — `extractClientIp` re-inlined in the HTTP upload path

- **Rule violated:** DRY — and specifically the drift-guard that
  `request-helpers.ts` documents as its own reason to exist ("Both call sites
  import these instead of mirroring the implementation inline",
  `request-helpers.ts:7-8`).
- **Severity:** Low.
- **Location:** `packages/orpc-ws-server/src/upload/http-handler.ts:141-145`
  duplicates `packages/orpc-ws-server/src/lifecycle/request-helpers.ts:18-25`
  (x-forwarded-for first-hop parse + socket fallback).
- **What & why it matters:** Small, but it is precisely the drift the helper
  module was created to prevent: the WS-verify log and the HTTP-upload log
  can now disagree on `clientIp` for the same proxy setup if either copy is
  patched alone. (They already differ microscopically: the helper rejects an
  empty first hop and falls back; the inline copy can yield `undefined` from
  a malformed header without falling back to the socket address.)
- **Proposed refactor (PROPOSAL only):** Import `extractClientIp` from
  `../lifecycle/request-helpers.js` in `http-handler.ts`. If the
  `lifecycle/` location feels wrong for an upload import, move
  `request-helpers.ts` up to `src/` — it is already a dependency-free leaf.
- **Confidence:** High.

## ARCH-11 — Type erosion via `as never` / `as unknown as` at the ORPC and partysocket boundaries

- **Rule violated:** "No `any`. The whole pitch of ORPC is end-to-end typing —
  the transport layer must not erode it." (Letter respected — zero `any` —
  but `as never` / double-casts are the same erosion.)
- **Severity:** Low (each is documented, localized, and names a real
  third-party typing gap).
- **Location (all verified):**
  - `packages/orpc-ws-server/src/index.ts:287` — `composedRouter as never`
    into `RPCHandler`.
  - `packages/orpc-ws-server/src/upload/http-handler.ts:126` — same cast for
    the HTTP handler.
  - `packages/orpc-ws-client/src/client/link-factory.ts:111` —
    `ws as unknown as WebSocket` (partysocket wrapper → DOM WebSocket).
  - `packages/orpc-ws-client/src/client/orpc-client.ts:74` —
    `link as unknown as Record<string | symbol, unknown>` (proxy reflection).
  - `packages/orpc-ws-client/src/index.ts:370` — covered by ARCH-8.
- **What & why it matters:** These are boundary seams against ORPC's
  `Router<any, T>` typing and partysocket's structural near-miss of the DOM
  `WebSocket` — arguably unavoidable without upstream changes, and every one
  carries a why-comment. Reported for completeness and so the count is
  tracked: five double-casts today; the rule's intent is that this number
  doesn't quietly grow.
- **Proposed refactor (PROPOSAL only):** No action required now. Optionally
  centralize each cast behind a named, single-purpose function (e.g.
  `asOrpcRouter(composed)`) so the erosion points stay greppable and the
  justification lives once.
- **Confidence:** High on locations; this is a watch-item, not a defect.

## ARCH-12 — Sleep-detector tunables unreachable from the public options

- **Rule violated:** "All numeric tunables (... ping/pong timing, max
  retries, jitter range, etc.) live in a config object with sensible
  defaults."
- **Severity:** Low (may be a deliberate scope cut; flagging so it's a
  decision, not an accident).
- **Location:** `packages/orpc-ws-client/src/index.ts:131-192`
  (`OrpcWsClientOptions`) exposes `sleepDetection?: boolean` only;
  `SleepDetectorDeps.pollIntervalMs` / `driftToleranceMs`
  (`sleep/sleep-detector.ts:127,133`) and
  `HeartbeatMonitorDeps.pollIntervalMs` (`heartbeat/monitor.ts:68`) are
  constructor-injectable but not wired through the composition root.
- **What & why it matters:** Reconnect tunables got the full treatment
  (`ReconnectConfig`, 9 fields, partial-override merge); the sleep detector's
  numeric tunables exist but no consumer can reach them — they are
  effectively hardcoded at the public surface (the heartbeat monitor case is
  defensible: its real deadline comes from the server's config event, and
  `pollIntervalMs` is genuinely a test seam). Fixing this for the sleep
  detector only makes sense **after** ARCH-7 — exposing `pollIntervalMs`
  today would hand consumers the false-wake footgun directly.
- **Proposed refactor (PROPOSAL only):** Either document "sleep detection is
  intentionally non-tunable in v1" or, post-ARCH-7, widen the option to
  `sleepDetection?: boolean | { pollIntervalMs?: number; driftToleranceMs?: number }`.
- **Confidence:** Medium (intent may be deliberate; the gap itself is
  verified).

---

## What was checked and found clean

- **`console.*`**: only in `orpc-ws-shared/src/logger.ts` (the opt-in
  `consoleLogger` bridge — permitted) and comments. Zero violations.
- **`process.env`**: zero occurrences in library src.
- **`: any` / `as any` / `<any>`**: zero occurrences in library src (comment
  mentions only).
- **`Math.random()`**: only inside `orpc-ws-shared/src/rng.ts:18` (the seam).
- **Raw timers**: only inside the worker source (justified — see ARCH-6
  "NOT violations") ; everything else goes through `Clock.setTimeout` /
  `setInterval` (verified by grep + spot-reads of `ReconnectManager`,
  `HeartbeatMonitor`, `HeartbeatPublisher`, `WsPingPong` usage sites).
- **Framework-free cores**: no `react` / `@nestjs/*` / `vue` / `svelte` /
  `solid-js` / `express` / `fastify` imports in `orpc-ws-client`,
  `orpc-ws-server`, or `oidc-pkce` src. The NestJS adapter's Express
  introspection (ARCH-5) is structural typing only — no `express` import.
- **Liskov / strategy seams**: `UploadStrategy` is cleanly substitutable;
  `PresignedUrlUploadStrategy` throwing "not implemented" is the CLAUDE.md-
  ratified v1 behavior, not a Liskov violation. `VerifyClient` is shared
  verbatim between WS and HTTP transports (good), with fail-closed runtime
  normalization of malformed consumer returns on the HTTP side. `TokenProvider`
  honors the "refresh is pure, returns token-or-null" contract
  (`oidc-pkce/src/client.ts:204-244` — storage write-through on success is the
  documented exception and is what makes recovery work).
- **State contract**: `{ getState, subscribe }` shape is identical across
  `ConnectionStateManager` and `oidc-pkce`'s auth store; the React adapter
  consumes both via `useSyncExternalStore` without core modification — as
  specified.
- **Composition-root discipline**: internal modules take constructor-injected
  deps throughout; no internal module news-up a sibling collaborator (the
  only `new` outside roots are leaf-owned resources: `WebSocketServer` in
  `attach()`, `RPCLink` inside the strategies/factories that own them, the
  `Worker` behind the injectable `workerFactory` seam).

*Review generated 2026-06-10. All `file:line` references verified against the
working tree at commit `edec802`.*
