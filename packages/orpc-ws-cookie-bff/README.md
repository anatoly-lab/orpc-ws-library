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
every default (cookie name `__Host-sid`, SameSite=Strict, Secure, host-prefix,
30-day session window, global `fetch` / system clock / noop logger).

## Seams you implement

- **`SessionStore<TUser>`** — `set(sid, data, { ttlSeconds })` / `get(sid)` /
  `delete(sid)` / `deleteByUser(sub)`. The **library mints the `sid`** (256-bit
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

- **`resolveUser(claims, tokens) => Promise<TUser>`** — the findOrCreateUser
  hook, run at `/callback` with the verified id-token claims and the token set.
  Returns your **enriched** app user (DB id, role, …) — exactly what the
  verifier attaches to the WS connection and what `/auth/me` echoes. `TUser`
  threads through `SessionStore`, the verifier, and the handlers.

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
- **Sliding session window.** `sessionExpiresAt` is re-stamped on each authed
  touch (the WS upgrade and `/auth/me`) when `slideSessionOnActivity` is `true`
  (the default), so the 30-day window rolls rather than being fixed at login.
  The slide is best-effort — a store-write failure is logged and the touch
  still succeeds. **Known bound:** a single forever-open socket is never a
  "touch" again, so it hard-caps at the TTL from its last touch.

## `IdTokenClaims`

A **fixed whitelist**, not a passthrough: `sub`, `email`, `emailVerified`,
`name`, `givenName`, `familyName`, `preferredUsername`. Only these standard
fields are copied out of the id-token payload before being handed to
`resolveUser` — the raw IdP JSON is never spread in wholesale (an IdP or a
tampered token could otherwise inject keys a downstream logger mistakes for
vetted claims). A consumer needing another claim adds it explicitly to this
whitelist in the library — there is no config knob for it.

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
