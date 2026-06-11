# Fable review — resolution status

Authoritative record of every finding from the Fable review
([bugs-review.md](./bugs-review.md), [security-review.md](./security-review.md),
[solid-review.md](./solid-review.md)) and the follow-up adversarial review,
with its final disposition.

**Summary:** the sweep is complete. All **10/10 bugs** are fixed, all
**5/5 adversarial findings (F1–F5)** are fixed, **API-4** (token-expiry
enforcement) landed opt-in with its **F4** timer-overflow follow-up fixed,
**SEC-3** and **SEC-4** are fixed, and **NFI-1 / NFI-4 / NFI-5** are fixed.
What remains open: **one decision** awaiting the maintainer (**NFI-3**
HTTP-upload-401 → storm-guard wiring); **S1** (finite `maxRetries`
semantics) is now **RESOLVED** (option (c) — finite `maxRetries` is
unsupported; warn + force back to `Infinity`). **One
won't-fix** (S2, cosmetic transient state frame), the **Info/accepted**
security items (SEC-5/6/7, plus SEC-2 which is documented rather than
code-changed), the **SOLID/architecture refactors deferred** as a separate
deliberate effort, and two minor non-blocking follow-up notes on NFI-1.

---

## Bugs (bugs-review.md) — all FIXED

| ID | Finding | Status | Commit |
|---|---|---|---|
| BUG-1 | Zombie reconnect after `dispose()` | ✅ FIXED | `89eee5f` |
| BUG-2 | `connect()` duplicate socket in retry window | ✅ FIXED | `89eee5f` |
| BUG-3 | Terminal auth failure not terminal | ✅ FIXED | `89eee5f` |
| BUG-4 | Heartbeat-timeout zombie / state stuck `connected` | ✅ FIXED | `89eee5f` |
| BUG-5 | Storm-guard window not shared with `reconnect()` path | ✅ FIXED | `89eee5f` |
| BUG-6 | No stale-wrapper guard on `open` | ✅ FIXED | `f1c4f59` |
| BUG-7 | Concurrent `subscribe()` leaks unabortable heartbeat loop | ✅ FIXED | `86dd1a9` |
| BUG-8 | HTTP upload context omits token | ✅ FIXED | `c1bb8cc` |
| BUG-9 | Early HTTP-upload reject doesn't drain request stream | ✅ FIXED | `c1bb8cc` |
| BUG-10 | Sleep-detector Blob URL never revoked | ✅ FIXED | `86dd1a9` |

## Security (security-review.md)

| ID | Finding | Status | Commit |
|---|---|---|---|
| API-4 | No token-expiry enforcement | ✅ FIXED (opt-in, default off) | `89eee5f` (+ `c1bb8cc` for F4) |
| SEC-1 | Verified claims dropped / opaque `VerifyClient` result | ✅ FIXED (via API-4 `expiresAt`) | `89eee5f` |
| SEC-2 | Token transported as `?token=` URL query param | 📄 DOCUMENTED | — |
| SEC-3 | No Origin/secure surfaced to `VerifyClient` | ✅ FIXED | `8faecb7` |
| SEC-4 | No default upload body limit | ✅ FIXED | `8faecb7` |
| SEC-5 | Default token storage is XSS-readable localStorage | ℹ️ INFO / ACCEPTED | — |
| SEC-6 | No unauthenticated-connection rate limiting | ℹ️ INFO / ACCEPTED | — |
| SEC-7 | Upload destination/filename safety is the consumer's | ℹ️ INFO / ACCEPTED | — |

Notes on the non-FIXED security items:

- **SEC-2** — the library was verified to never log the token; the residual
  risk is infrastructure access logs (reverse proxy / LB / APM). Mitigation is
  documented in the server README's new "Operational security" note. No code
  change needed: `?token=` is a deliberate design decision, and cookie-auth is
  supported by omitting `tokenProvider`.
- **SEC-3** — `origin` + `secure` are now part of `VerifyClientContext`;
  *enforcement* (e.g. an Origin allowlist) is deliberately the consumer's
  choice.
- **SEC-4** — note this is a **behavior change**: uploads now default to a
  **25 MB** body limit. Raise `bodyLimitBytes` deliberately if you need more.
- **SEC-5** — tradeoff documented in-code; the `Storage` seam is pluggable, so
  a consumer can inject an in-memory store or move to a BFF pattern. No change.
- **SEC-6** — connection rate limiting belongs at the consumer's edge
  (LB/WAF); optionally expose `maxPayload` later. No change.
- **SEC-7** — the library correctly owns nothing here; the consumer sanitizes
  destinations/filenames (README should note it). No change.

## Adversarial review findings (F1–F5) — all FIXED

| ID | Finding | Status | Commit |
|---|---|---|---|
| F1 | `kicked`-state resurrection (in-flight reconnect after 4005) | ✅ FIXED | `f1c4f59` |
| F2 | Storm guard fired terminal on transient blips (spurious forced logout) | ✅ FIXED | `8e738c7` |
| F3 | Terminal teardown incomplete (sleep detector / RM latch) | ✅ FIXED | `f1c4f59` |
| F4 | API-4 expiry `setTimeout` 32-bit overflow | ✅ FIXED | `c1bb8cc` |
| F5 | `dispose()` didn't cancel the jitter-delay timer | ✅ FIXED | `8e738c7` |

## Needs-further-investigation items (NFI)

| ID | Finding | Status | Commit |
|---|---|---|---|
| NFI-1 | Heartbeat stream failing before `config` leaves connection unmonitored | ✅ FIXED | `f52fcfd` |
| NFI-2 | (= S1, see [Suspected](#suspected-s1-s2)) | — | — |
| NFI-3 | HTTP-upload 401 not wired into client auth-recovery/storm-guard machinery | ⏳ NEEDS DECISION | — |
| NFI-4 | Server `dispose()` could hang ~30s on a dead client's close handshake | ✅ FIXED | `8faecb7` |
| NFI-5 | `reconnect()` mutex drop discarded the only recovery signal | ✅ FIXED | `f52fcfd` |

Notes:

- **NFI-1 follow-ups** (minor, not blocking): (a) defense-in-depth — bump the
  subscriber generation in `unsubscribe()`; (b) a stream that **ends cleanly**
  (`done`) before the `config` event is not retried — an unlikely server
  shape, but a silent-unmonitored edge.
- **NFI-3** — CLAUDE.md's locked storm-guard decision lists "HTTP-upload 401"
  as one trigger of the single shared window, but `orpc-http-strategy.ts` just
  rethrows. Either this is a deliberate v1 cut (record it) or a missing piece
  of the locked design. Not implemented; awaiting the maintainer's call.
- **NFI-4** — fixed with a bounded terminate-fallback
  (`shutdownGraceMs`, default `5000`).
- **NFI-5** — fixed with one trailing rerun of the dropped reconnect.

## Suspected (S1, S2)

| ID | Finding | Status |
|---|---|---|
| S1 (= NFI-2) | Finite `reconnect.maxRetries` makes `willRetry: true` a lie AND `connect()` a permanent no-op | ✅ RESOLVED — option (c) |
| S2 | Transient `willRetry: true` frame before terminal | 🚫 WON'T-FIX |

- **S1** — **RESOLVED via option (c).** The default `maxRetries` is
  `Infinity`, so stock setups are unaffected. `partysocket@1.1.19` emits
  nothing on retry exhaustion; clean detection needs its private
  `_connectLock` field. The maintainer chose **(c)**: a finite
  `maxRetries` is unsupported. `resolveReconnectConfig()`
  (`packages/orpc-ws-client/src/config/reconnect-config.ts`) detects a
  finite override, logs a `logger.warn(...)`, and forces `maxRetries`
  back to `Infinity`; documented in the client README's "Reconnect
  configuration" section. The two rejected alternatives were:
  - **(a)** read `_connectLock` (exact for the pinned version; the codebase
    already relies on partysocket internals) → set `willRetry: false` + clear
    the holder so `connect()` works again;
  - **(b)** escape-hatch only — `connect()` calls `wrapper.reconnect()` when
    `retryCount >= maxRetries` (no internals, but state keeps lying).
- **S2** — cosmetic: the transient frame lands in the same synchronous tick as
  the terminal state; the `willRetry: true` is deliberate and documented; it
  is coalesced by `useSyncExternalStore`; and fixing it would couple
  `EventHandlers` to auth-flow outcomes, which the architecture forbids.

## SOLID / architecture (solid-review.md, ARCH-1..12) — DEFERRED

Not bugs — architectural refactors. Notably, the client composition root
(`packages/orpc-ws-client/src/index.ts`) is now **~700+ LOC**, well over the
project's ~300 LOC ceiling; the `oidc-pkce` seam observations also fall here.
These need a deliberate refactor decision and are **not** part of the bug-fix
sweep. The `index.ts` god-file is the top candidate when that effort starts.
