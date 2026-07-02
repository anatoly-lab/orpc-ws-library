# `@orpc-ws/cookie-bff`

Framework-free cookie-BFF core for the ORPC-over-WebSocket transport. In the
cookie-BFF topology **no token (access or refresh) ever reaches the browser**:
the server holds the tokens in a session store ("the drawer"), the browser
holds only an opaque `httpOnly` session id ("the locker key") that rides the WS
upgrade automatically, and a cookie verifier does the door-check. This package
owns the framework-agnostic pieces — the `SessionStore` / `PkceStore` seams,
server-side OIDC code-exchange + lazy single-flight refresh, at-rest
AES-256-GCM token encryption (with key rotation), sid minting, the
transport-agnostic `/auth/*` handlers, the WS cookie verifier, best-effort
revocation, and hardened cookie / `oauth_state` / double-submit-CSRF helpers.
NestJS wiring lives in the sibling `@orpc-ws/cookie-bff-nestjs` adapter. See
[`docs/cookie-bff-server-design.md`](../../docs/cookie-bff-server-design.md)
for the full design.

## Install

```bash
npm install @orpc-ws/cookie-bff
```

Framework-free Node. Depends on [`@orpc-ws/server`](../orpc-ws-server) (for the
`VerifyClient` type the cookie verifier produces) and `@orpc-ws/shared` (the
`Clock` / `Logger` seams). It does **not** depend on `express`, `@nestjs/*`, or
any HTTP framework — the `/auth/*` handlers return transport-agnostic
instructions that an adapter applies. On NestJS, install
[`@orpc-ws/cookie-bff-nestjs`](../orpc-ws-cookie-bff-nestjs) instead — it wires
this core into Nest in one module.

## The cookie-BFF model

- **Tokens stay server-side.** The OAuth code-exchange runs on a server
  endpoint (`/auth/callback`), the resulting Keycloak tokens are encrypted at
  rest and written to your `SessionStore`. The browser never sees them.
- **The browser holds only an opaque `sid`.** A `__Host-`-prefixed `httpOnly`
  cookie. The browser attaches it automatically on the WS upgrade — there is
  **no `?token=`** query param.
- **The cookie verifier does the door-check.** On the upgrade it checks Origin,
  reads the `sid` cookie, opens the drawer (`store.get`), and authenticates
  from the server-held session — no JWT on the socket.
- **The paired client omits `tokenProvider`.** Cookie auth needs no
  client-side token plumbing; the library's WS client just connects.

## Quickstart

Without the Nest adapter you wire three seams yourself. The core never touches
your HTTP framework — an adapter translates each handler's `AuthInstruction`
(`status` / `redirect` / `setCookies` / `setClearCookies` / `body`) to its
framework's response object.

```ts
import {
  createCookieBffCore,
  createCookieVerifyClient,
  revokeUser,
} from "@orpc-ws/cookie-bff";
import { createOrpcWsServer } from "@orpc-ws/server";
import { appRouter } from "./router";
import { sessionStore } from "./session-store";

// 1. The /auth/* handlers (login / callback / me / logout). Each takes an
//    AuthRequest (cookie header + query + headers) and returns an
//    AuthInstruction the adapter applies to the HTTP response.
const core = createCookieBffCore<AppUser>({
  keycloak: {
    issuerUrl: process.env.OIDC_ISSUER_URL!,
    clientId: process.env.OIDC_CLIENT_ID!,
    redirectUri: "https://api.example.com/auth/callback", // the server's own callback
  },
  originAllowlist: ["https://app.example.com"], // exact WS upgrade Origins
  encryptionKey: process.env.SESSION_ENC_KEY!,  // 32-byte AES-256-GCM key
  sessionStore,
  spaRedirectUri: "https://app.example.com",     // where /callback 302s after login
  resolveUser: async (claims) => findOrCreateUser(claims), // enriched app user
});

// Adapter side (sketch): build an AuthRequest from your req, apply the result.
// const instruction = await core.callback({ cookieHeader, query, headers });
// res.status(instruction.status); …apply setCookies/setClearCookies; redirect or json.

// 2. The WS VerifyClient — reads the sid cookie off the upgrade and opens the
//    drawer. Hand it to the server core as its verifyClient.
const verifyClient = createCookieVerifyClient(sessionStore, {
  cookieName: "__Host-sid",
  originAllowlist: ["https://app.example.com"],
});
const wsServer = createOrpcWsServer({ router: appRouter, verifyClient });

// 3. Revocation — best-effort kick: empties the drawer for a subject and drops
//    its live socket on THIS instance.
await revokeUser(sessionStore, wsServer.closeUser, sub);
```

`createCookieBffCore` returns a `CookieBffCore` — `{ login, callback, me,
logout }`, each `(req: AuthRequest) => Promise<AuthInstruction>`. It applies
every default (cookie name `__Host-sid`, session-cookie SameSite=Strict,
oauth_state-cookie SameSite=Lax, Secure, host-prefix, 30-day session window,
global `fetch` / system clock / noop logger).

## Seams you implement

- **`SessionStore<TUser>`** — `set(sid, data, { ttlSeconds })` / `get(sid)` /
  `delete(sid)` / `deleteByUser(sub)`, plus an optional
  `touch?(sid, sessionExpiresAt, { ttlSeconds })`: an expiry-only atomic
  update (express-session precedent) the sliding window prefers, so a slide
  can never clobber a concurrent lazy refresh's freshly-rotated tokens.
  Get/set-only stores fall back to a fresh get + merged set — a narrowed but
  not eliminated race window — so implement `touch` (a one-field update on
  Redis/SQL/KV) for full safety. The **library mints the `sid`** (256-bit
  random) and is the sole writer of `SessionData`; the store only persists by
  key, never invents ids, never mutates the value, and never inspects the
  encrypted token blob. `SessionData<TUser>` carries the enriched `user`, the
  encrypted `enc` token-set, `accessTokenExpiresAt`, the sliding
  `sessionExpiresAt`, and `createdAt`. **`deleteByUser` needs a companion
  index** for opaque `sid → data` KV stores (NATS KV, Redis without a secondary
  index): they cannot scan by subject, so maintain a `sub → [sid]` index
  updated on `set`/`delete` and walk it here. SQL backends just
  `DELETE WHERE sub = ?`. A typical implementation is ~40 lines over a backend
  you already run.

- **`PkceStore`** — `set(state, verifier, { ttlSeconds })` +
  `take(state)` (atomic read-and-delete, **single-use** — a replayed callback
  finds nothing and is rejected). Persists a login's PKCE `code_verifier` keyed
  by `state` for the round-trip to the IdP. The default `InMemoryPkceStore` is
  **single-instance only** — a login landing on instance A and a callback
  load-balanced to instance B would find no verifier. Multi-instance
  deployments **must** supply a shared-store adapter (~15 lines). (A
  module-level `Map` was deliberately rejected — wrong for multi-instance and
  unsubstitutable in tests.)

- **`Fetcher`** (optional) — a minimal injectable subset of `fetch` used for
  OIDC discovery + token calls. Defaults to the global `fetch`; inject your own
  to add a timeout / proxy, or to fake it in tests.

- **`resolveUser(claims, tokens, rawClaims) => Promise<TUser>`** — the
  findOrCreateUser hook, run at `/callback` with the verified id-token `claims`
  (the typed whitelist), the token set, and `rawClaims` — the **full decoded
  id_token payload** as a `Record<string, unknown>`, so a trusted consumer can
  read **any** claim (e.g. `groups`, `realm_access`) without a library release.
  Returns your **enriched** app user (DB id, role, …) — exactly what the
  verifier attaches to the WS connection and what `/auth/me` echoes. The library
  stores **only** what you return; `rawClaims` is read-only input, never
  auto-spread into the session. `TUser` threads through `SessionStore`, the
  verifier, and the handlers. (The exported `decodeIdToken(idToken)` helper
  returns `{ claims, raw }` if you need the same split elsewhere.)

- **`authEvents`** (optional) — fire-and-forget auth-flow metrics hooks the
  `/auth/*` handlers call: `onLoginStart()` / `onCallbackSuccess(user)` /
  `onCallbackFailure(reason)` / `onLogout(sub)`. Best-effort — a throwing hook
  is logged via the injected `Logger` and **never** breaks the auth flow.

- **`keycloak.authorizeParams`** (optional) — extra query params merged into the
  authorize URL (`prompt`, `login_hint`, `max_age`, `acr_values`, …). Applied
  first; the 7 security-critical params (`response_type`, `client_id`,
  `redirect_uri`, `scope`, `state`, `code_challenge`, `code_challenge_method`)
  are set after and **always win**, so a consumer cannot clobber the
  PKCE / state / redirect / scope params.

## Multi-instance deployments: refresh is single-flighted per PROCESS

> **Warning — refresh-token rotation across instances.** The lazy refresh is
> single-flighted **per process only**: a per-`sid` in-flight promise map
> inside the refresh manager, not a distributed lock. Two app instances
> behind a load balancer can refresh the **same session concurrently** —
> and with refresh-token **rotation** enabled at the IdP (e.g. Keycloak
> `revokeRefreshToken=true`), only one rotation wins. The losing instance
> can then persist an **already-invalidated** refresh token to your
> `SessionStore`; the next refresh fails terminally and the user is
> **silently logged out**.

Where you stand:

- **Single instance** — fine. The in-process single-flight covers every
  concurrent caller; nothing to do.
- **Multiple instances, rotation OFF** — fine. Concurrent refreshes both
  succeed and the prior refresh token stays valid, so a stale write is
  harmless.
- **Multiple instances, rotation ON** — **you need your own cross-instance
  coordination.** Wrap refresh in a distributed lock keyed by `sid` (Redis
  `SET NX`, a Postgres advisory lock, …) so only one instance refreshes a
  session at a time — or turn rotation off for this client at the IdP.

The library deliberately does **not** solve this: cross-instance
coordination is the consumer's job, the same category as revocation
fan-out (§G of the design doc). Note this is a *different* race from the
slide-vs-refresh clobber that `SessionStore.touch` closes — `touch` keeps
the sliding window from rolling back a refresh's freshly-rotated tokens
within one instance; refresh-vs-refresh across instances needs the lock.

## Security notes

- **`__Host-`-prefixed session cookie.** `Secure` + `httpOnly` +
  `SameSite=Strict` by default (the `__Host-` prefix forces `Secure`, `Path=/`,
  no `Domain`). Relax via `cookies` only for localhost-http development.
- **WS Origin allowlist.** Checked first on every upgrade, fail-closed (an
  empty or absent Origin is rejected). This is load-bearing: the browser sends
  cookies on **cross-origin** WS upgrades, and the same-origin policy does
  **not** block cross-site WS hijacking — the allowlist is the only thing
  between a malicious page and a cookie-authed socket.
- **AES-256-GCM token encryption at rest.** The Keycloak tokens in
  `SessionData.enc` are always ciphertext (a self-describing `v1:<keyId>:…`
  envelope). A leaked store dump yields no usable credentials. **Key rotation**
  is supported: new sessions use `encryptionKey` (tagged with
  `encryptionKeyId`); `previousEncryptionKeys` (by id) decrypt older sessions
  during the grace window.
- **Double-submit CSRF.** A readable (non-`httpOnly`) `csrf_token` cookie is
  issued on `/auth/me` **and** `/auth/callback`; the client echoes it in the
  `x-csrf-token` header, validated constant-time on `POST /auth/logout`. A
  cross-site attacker can make the cookie ride along but cannot read it to
  populate the header.
- **`oauth_state` login-CSRF cookie.** Guards the authorization round-trip.
  Defaults to `SameSite=Lax` (decoupled from the session cookie, overridable via
  `cookies.stateSameSite`): the callback rides a top-level GET redirect back to
  `/auth/callback`, and any cross-site hop in the login chain (an
  off-registrable-domain Keycloak, or Keycloak brokering an external/social IdP)
  makes that callback cross-site-initiated, so a `Strict` cookie would be
  withheld and the browser-binding check would reject the login with HTTP 400.
  `Lax` is sent on top-level GETs but still blocks cross-site unsafe-method
  requests, so login-CSRF protection holds.
- **Sliding session window.** `sessionExpiresAt` is re-stamped on each authed
  touch (the WS upgrade and `/auth/me`) when `slideSessionOnActivity` is `true`
  (the default), so the 30-day window rolls rather than being fixed at login.
  The slide is best-effort — a store-write failure is logged and the touch
  still succeeds. It prefers the store's optional `touch` (expiry-only, cannot
  race the lazy refresh's token rotation); get/set-only stores get a
  narrowed-but-not-eliminated race window instead, so implement `touch` for
  full safety. **Known bound:** a single forever-open socket is never a
  "touch" again, so it hard-caps at the TTL from its last touch.

## `IdTokenClaims`

A **fixed whitelist**, not a passthrough: `sub`, `email`, `emailVerified`,
`name`, `givenName`, `familyName`, `preferredUsername`, `picture`. Only these
standard fields are copied out of the id-token payload into the typed `claims`
before being handed to `resolveUser` — the raw IdP JSON is never spread in
wholesale (an IdP or a tampered token could otherwise inject keys a downstream
logger mistakes for vetted claims). A consumer needing another claim no longer
edits the library: `resolveUser` also receives the **full decoded id_token
payload** as its third `rawClaims` arg, so you can read any claim (e.g.
`groups`, `realm_access`) inside `resolveUser`. The security guarantee holds —
the library stores only what `resolveUser` returns; it never auto-spreads
`rawClaims` into the session.

## Module formats

Built with [tshy](https://github.com/isaacs/tshy) — emits dual ESM/CJS into
`dist/esm` + `dist/commonjs` with one `.` export. Framework-free with no
module-level framework state, so the dual build is safe; both `import` and
`require` resolve.

## See also

- Top-level [README](../../README.md)
- [`@orpc-ws/cookie-bff-nestjs`](../orpc-ws-cookie-bff-nestjs) — NestJS adapter (one-module install)
- [`@orpc-ws/server`](../orpc-ws-server) — the WS server core the verifier plugs into
- [Cookie-BFF server design](../../docs/cookie-bff-server-design.md) — full design doc
- [src/index.ts](./src/index.ts) — full export surface
