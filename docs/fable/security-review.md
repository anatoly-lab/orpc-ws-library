# Security review — `@orpc-ws/*` library

_Review date: 2026-06-10 · Reviewer: Fable model (security review pass) · Scope: `packages/*` library cores + adapters; demo apps consulted only as reference consumers. Review-only — no source changed._

## Summary

The library's connection-time auth path is solid: auth runs **pre-101** in `ws`'s `verifyClient` (closing the first-message race), the JOSE verifier validates signature/`exp`/`nbf`/issuer in one `jwtVerify` step and binds the token to a client via `azp`/`aud`, discovery is cached with fail-eviction, and the HTTP upload transport fails closed (auth → optional gate → handler, with runtime normalization of malformed consumer returns). No token is written to any log by library code. The dominant gap is exactly the seed finding: once a WebSocket is **open**, the library never re-checks the token, never reads `exp`, and never schedules a close at expiry — a 15-minute token yields an effectively unbounded session because the heartbeat keeps the socket alive indefinitely.

**API-4 verdict: REPRODUCED (PARTIAL severity — Medium for the library).** The "validate once at connect, never again" behavior reproduces verbatim. One mitigating factor the source app lacked: the library *does* expose a per-user force-disconnect seam (`OrpcWsServer.closeUser(connectionKey, code, reason)`), so consequence (2) — forced disconnect on external invalidation — is *wireable* by the consumer today. But consequence (1) — `exp` is ignored for the life of the socket — has **no** library-side mitigation and **cannot** be built by the consumer either, because the verified `exp` is never surfaced out of the `VerifyClient` result. That makes it a genuine library defect, not a "left to the consumer" choice.

## Findings

| ID | Severity | Title | Location |
|----|----------|-------|----------|
| API-4 | Medium | No token-expiry enforcement on a live WS connection | `orpc-ws-server/src/index.ts`, `lifecycle/*`, `oidc-verifier-jose/src/client.ts` |
| SEC-1 | Low | Verified `exp`/claims are dropped — `VerifyClientResult` is opaque | `orpc-ws-server/src/lifecycle/verify-client-orchestrator.ts:69`, `oidc-verifier-jose/src/client.ts:152` |
| SEC-2 | Low | Token-in-URL-query for WS (residual exposure via proxy/access logs) | `orpc-ws-client/src/config/url-builder.ts:57`, `orpc-ws-server/src/lifecycle/request-helpers.ts:33` |
| SEC-3 | Low | No Origin check / surfacing on the WS upgrade | `orpc-ws-server/src/lifecycle/verify-client-orchestrator.ts:136` |
| SEC-4 | Low | Upload transport has no body limit by default | `orpc-ws-server/src/upload/http-config.ts:162`, `http-handler.ts:116` |
| SEC-5 | Info | Default token storage is XSS-readable `localStorage` | `oidc-pkce/src/client.ts:127` |
| SEC-6 | Info | No unauthenticated-connection rate/count limiting | `orpc-ws-server/src/index.ts:342` |
| SEC-7 | Info | Upload destination/filename safety is 100% consumer responsibility | `orpc-ws-server/src/upload/http-handler.ts`, `apps/demo-server/src/router.ts:103` |

---

### API-4 — No token-expiry enforcement on a live WS connection

> **✅ RESOLVED** (verified + fixed, opt-in/non-breaking). Added optional
> `expiresAt?` (epoch ms) to `VerifyClientResult`; `@orpc-ws/oidc-verifier-jose`
> populates it from `exp`. New `enforceTokenExpiry` server config (default
> **false**) schedules a `4001` close at `expiresAt` via the injected `Clock`,
> cleared on connection close. `closeUser()` documented as the
> `session.invalidated` force-disconnect hook. Default-off ⇒ no behavior change
> for existing consumers. Test: `api-4-token-expiry-enforced.test.ts`. Tests
> pass. (Open alt: a dedicated `4401` close code instead of reusing `4001` —
> deferred; would need client close-decision changes.)

**Severity: Medium** (for a library that markets itself as "the typed ORPC client/server for this app" and owns the reconnect+refresh flow). Not Critical because (a) exploitation requires an already-issued valid token, and (b) the kill-switch half is wireable; but the time-bound-session guarantee that `exp` is supposed to provide is silently void, which is a real auth-lifetime weakening.

**Trace (confirms the pre-scan):**

1. WS upgrade → `VerifyClientOrchestrator.buildWsVerifyClient()` runs the consumer's `verify` once, pre-101, and on success stores the result in a `WeakMap<IncomingMessage, VerifyClientResult>` then calls `callback(true)` (`verify-client-orchestrator.ts:136-164`). This is the **only** time auth runs for the life of the socket.
2. `'connection'` fires → `ConnectionHandler.handle()` pulls the stashed result, registers the socket, calls `rpcHandler.upgrade(...)`, wires ping/pong + close/error handlers (`connection-handler.ts:104-209`). **No timer is scheduled against the token's `exp`.** I read every line of this handler — there is no `exp`, `setTimeout`, or scheduled close.
3. After that, the only recurring server-side timers are `HeartbeatPublisher` (ORPC liveness event) and `WsPingPong` (`ws-ping-pong.ts:154`). The ping/pong watchdog's sole disconnect path is the **zombie** branch (`alive === false → ws.terminate()`); it has no notion of token validity. The heartbeat actively *keeps the socket open* past `exp`.
4. `grep` for `exp`/`expir` across `orpc-ws-server/src` and `oidc-verifier-jose/src` returns **zero** runtime reads of a token `exp` claim outside jose's internal `jwtVerify` (confirmed). No scheduled close anywhere.

So a connection opened with a 15-minute token stays authenticated for hours/days as long as pongs flow. The client's own refresh path (`token-refresh-handler.ts`) only fires on *reconnect*, and the server never forces a reconnect at `exp`.

**Force-disconnect seam (consequence 2):** `OrpcWsServer.closeUser(connectionKey, code?, reason?)` exists (`index.ts:398-411`) and looks the socket up by the same `connectionKey` the verifier returns (`oidc-verifier-jose/src/client.ts:160` sets `connectionKey: payload.sub`). A consumer subscribed to their own `session.invalidated` stream *can* call `closeUser(sub, 4001, "session invalidated")` today. So consequence (2) is mitigatable — but the library ships **no** built-in subscription and **no** documentation pointing consumers at this as the invalidation hook. Worth surfacing in the README as the canonical pattern.

**Exploitability / impact:** An attacker (or just a careless deployment) who captures or retains a short-lived access token gets a session that outlives the token's intended lifetime by an unbounded margin. Revocation/logout/security-event invalidation does not propagate to live dashboard sockets unless the consumer wires `closeUser` themselves. This is precisely the "validated once, never re-checked" flaw from the source app, extracted faithfully.

**Proposed fix (library responsibility for the `exp` half):**

1. **Surface `exp`.** Add an optional `expiresAt?: number` (epoch ms) to the `{ ok: true }` branch of `VerifyClientResult` (`verify-client-orchestrator.ts:69`), and have `createOidcVerifyClient` populate it from the verified `payload.exp` (`client.ts:152` — `exp` is right there in the validated payload, currently discarded). Purely additive; existing consumers unaffected.
2. **Opt-in expiry watchdog.** Add `connection.enforceTokenExpiry?: boolean` (default `false` for back-compat, but recommend `true`). When on and the verify result carries `expiresAt`, `ConnectionHandler.handle()` schedules `clock.setTimeout(() => ws.close(authFailedCloseCode /* 4001, or a dedicated 4401 */, "token expired"), expiresAt - clock.now())`, cleared in the `'close'` handler. Use the already-injected `Clock` seam so it stays deterministically testable (a `bug-*-token-expiry` regression test fits the "tests from day 0" rule). The client already treats 4001 as "trigger auth-recovery/refresh," so the reconnect-with-fresh-token path closes the loop with no client change.
3. **Document `closeUser` as the invalidation hook** for consequence (2). The seam exists; it just needs to be the blessed pattern in the server README, ideally with a tiny `disconnectUser(sub)` alias for discoverability.

**Confidence: High** on the behavior (read the full connection path); **High** that `exp` is never read at runtime (grep + manual read); **High** that `closeUser` is the existing partial mitigation.

---

### SEC-1 — Verified claims are dropped; the `VerifyClient` result is opaque to the core

**Severity: Low** (enabler for API-4; not independently exploitable).

`VerifyClientResult<TUser>` is `{ ok: true; user; connectionKey? } | { ok: false; code; reason }` (`verify-client-orchestrator.ts:69-71`). The JOSE verifier validates the full payload then projects it to `OidcUser` and returns only `user` + `connectionKey` (`client.ts:152-161`); `exp`, `iat`, `jti`, scopes — everything else is discarded at the seam. The core therefore *cannot* implement any time-bound or claim-bound runtime policy even if it wanted to. This is the structural reason API-4's `exp` half can't be solved consumer-side.

**Proposed fix:** the additive `expiresAt?` field from API-4 fix #1. Optionally a generic `claims?: Record<string, unknown>` escape hatch if future policies (scope downgrade, `jti` denylist) are anticipated — but `expiresAt` alone unblocks the headline finding. **Library responsibility.** **Confidence: High.**

---

### SEC-2 — Token transported as `?token=` URL query parameter (WS)

**Severity: Low.** This is a *resolved design decision* in CLAUDE.md ("Token transport is URL query param"), and the WS scheme (`wss://`) encrypts the URL on the wire, so it's not a network-sniff issue. The residual risk is the well-known query-string token exposure surface: reverse-proxy/LB access logs, APM traces, and any server that logs request URLs will capture the JWT.

`createUrlBuilder` appends `url.searchParams.set("token", token)` (`url-builder.ts:57`) and the server re-parses it from `req.url` (`request-helpers.ts:33`). I verified the **library** itself never logs the URL or token — the orchestrator logs only `clientIp`/`code`/`reason` (`verify-client-orchestrator.ts:149`), and connect logs use `connectionKey` (the `sub`), not the token. So the library is clean; the exposure is in whatever infra sits in front of it.

**Proposed fix:** none required in code (the design is deliberate and cookie-auth is already supported by omitting `tokenProvider`). **Documentation responsibility:** the server README should warn operators to scrub `?token=` from access logs / disable query-string logging on the `/ws` path, and note the `Sec-WebSocket-Protocol` subprotocol-header alternative as a future option if a consumer needs to avoid query strings entirely. **Confidence: High** (verified no library-side logging of the token).

---

### SEC-3 — No Origin validation on the WS upgrade

**Severity: Low.** `ws` hands `verifyClient` an `info.origin` (the type is declared at `verify-client-orchestrator.ts:87`), but the orchestrator passes only `{ req, token, clientIp }` to the consumer's `VerifyClient` (`:142`) — `origin` is dropped. WebSocket upgrades are **not** subject to the same-origin policy / CORS preflight, so a token-bearing connection from a malicious origin is only stopped by token validity, not by origin. For a query-param-token design this is mostly fine (the attacker would need the token), but cross-site WebSocket hijacking is a recognized class and the library gives the consumer no easy lever.

**Proposed fix:** add `origin` (and `secure`) to `VerifyClientContext` so a consumer can enforce an allowlist inside their `verifyClient` without reaching into `req.headers.origin` manually. Cheap, additive, no default behavior change. Enforcement stays a **consumer responsibility**, but the library should *surface* the value. **Confidence: High** (the value is available and currently not forwarded).

---

### SEC-4 — Upload HTTP transport applies no body-size limit by default

**Severity: Low.** `DEFAULT_UPLOAD_HTTP_CONFIG` omits `bodyLimitBytes` (`http-config.ts:162-165`), and the handler installs `BodyLimitPlugin` only when it's set (`http-handler.ts:116-119`). So a consumer who enables uploads without setting a limit accepts unbounded request bodies — a resource-exhaustion vector. The config jsdoc *does* warn about this (`http-config.ts:104-108`), and the `beforeUpload` hook can reject on `content-length` before buffering, so the mitigations exist; the issue is the insecure-by-default posture once `enabled: true`.

**Proposed fix:** ship a conservative default `bodyLimitBytes` (e.g. 10 MB, matching what the demo picks) when uploads are enabled, forcing consumers to *raise* it deliberately rather than discover the absence. Alternatively, log a `warn` at construction when `uploads.enabled && bodyLimitBytes === undefined`. **Library responsibility** (defaults). **Confidence: High.**

---

### SEC-5 — Default token storage is XSS-readable `localStorage`

**Severity: Info.** `defaultStorage()` persists the full token bundle (access + refresh + id token) as a JSON blob in `localStorage` (`oidc-pkce/src/client.ts:127-149`). Any XSS on the origin reads all three. This is explicitly acknowledged in-code ("Security note: localStorage is XSS-readable", `:123`) and the `Storage` seam is pluggable, so it's a documented tradeoff, not a defect — flagged for completeness. PKCE state correctly uses `sessionStorage` and is non-pluggable by design (`flow.ts:20`, types jsdoc), which is the right call. **Proposed fix:** none beyond the existing README note; consumers with stricter needs inject a custom `Storage` (in-memory + BFF cookie). **Consumer responsibility.** **Confidence: High.**

---

### SEC-6 — No unauthenticated-connection rate/count limiting

**Severity: Info.** The `WebSocketServer` is created with `{ server, path, verifyClient }` and nothing else (`index.ts:342-346`); there's no cap on concurrent unauthenticated upgrades, no per-IP throttle, and the registry grows one entry per authenticated user with no ceiling (`connection-registry.ts:56`). The verify path does real crypto (`jwtVerify`) per upgrade, so a connection flood forces JWKS-backed verification work. For a library this is arguably correct to leave to the consumer's edge (LB / WAF / `ws` `maxPayload`), but there's no knob and no guidance. **Proposed fix:** document that connection-rate limiting belongs at the consumer's edge; optionally expose `maxPayload` / a `verifyClient` pre-throttle hook. **Mostly consumer responsibility.** **Confidence: Med** (no DoS test performed; assessment is from reading the construction path).

---

### SEC-7 — Upload destination & filename safety is entirely the consumer's

**Severity: Info.** The library's upload handler hands the decoded `File` to the consumer's ORPC procedure and owns nothing about where bytes land (`http-handler.ts` — it only does auth, the `beforeUpload` gate, URL normalization, and `rpcHandler.handle`). The demo consumer writes to `<cwd>/uploads` and sanitizes the supplied name with `replace(/[^\w.-]/g, "_")` plus a `Date.now()` prefix (`apps/demo-server/src/router.ts:103-109`), which is a correct anti-traversal pattern. No path-traversal or destination control exists *in the library* to get wrong — confirming the library draws the line correctly. Flagged only so the README makes explicit that filename sanitization / destination confinement is on the consumer, since the library's `File` hand-off gives no traversal protection itself. **Consumer responsibility.** **Confidence: High.**

---

## Things checked and found OK (no finding)

- **Verifier algorithm safety.** `jwtVerify(token, createRemoteJWKSet(...), { issuer })` (`client.ts:119`) resolves the verification key from the IdP's JWKS, so `alg: none` and HMAC-vs-RSA confusion are not exploitable — jose rejects a token whose alg doesn't match the JWKS key type, and there's no static secret an attacker could re-sign with. Issuer is bound (`issuer: metadata.issuer`), `sub` presence is enforced (`:123`), and client binding via `azp`/`aud` is mandatory unless the consumer explicitly opts out with `boundClaim: false` (factory throws if `expectedClientId` is missing for `azp`/`aud`, `:87`). Good posture.
- **Discovery cache poisoning.** Failed discovery fetches are evicted before re-throw (`discovery.ts:68-73`), so a transient failure can't poison the cache for the process lifetime; issuer-claim equality is checked against the configured issuer (`:149`).
- **Upload fail-closed.** Malformed consumer `verifyClient` / `beforeUpload` *returns* (not just throws) are normalized to a 500 reject (`http-handler.ts:76-92, 155-168, 198-208`) — a genuinely good hardening detail that prevents a hung-request DoS from a plain-JS consumer bug.
- **Bearer extraction strictness.** `extractBearerToken` requires exactly `Bearer <token>` and treats empty as missing (`http-verify.ts:28-40`). Fine.
- **Session replacement (4005 "kicked").** The `register` → close-old-before-overwrite ordering plus `unregisterIfSame` identity check (`connection-registry.ts:82-127`) correctly avoids the late-close-wipes-new-entry race; no auth bypass — the new connection went through the same `verifyClient`.
- **No token logging by library code.** Confirmed via grep: the only token-adjacent logs are `clientIp`/`code`/`reason`/`connectionKey`, never the token or full URL.

## Needs further investigation (could not fully verify in this pass)

- **`@orpc/server` multipart parsing limits.** SEC-4 covers the missing *body* limit, but I did not audit ORPC's own multipart decoder for per-part count limits, filename handling, or zip-bomb-style decompression. If a consumer relies on ORPC's `z.file()` decoding, that decoder's resource bounds are worth a dedicated look.
- **`partysocket` reconnect storm behavior** under a server that 4001s at every connect (post-API-4-fix). The client storm guard is referenced in CLAUDE.md but I did not trace `reconnect-manager.ts` deeply for whether a server-forced 4001-at-exp loop could trip the storm guard into a terminal state prematurely. Recommend verifying the expiry-watchdog fix end-to-end against the client storm guard before shipping.
- **e2e coverage gap (observation, not a vuln):** the Playwright suite (`tests-e2e/workflows/`) has `smoke` + `auth` specs but **no** upload auth-rejection or expiry test. If API-4's fix lands, it needs a new regression spec; today there's no e2e asserting the server even 401s an unauthenticated upload.
