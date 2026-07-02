# Design — `@orpc-ws/cookie-bff` (core) + `@orpc-ws/cookie-bff-nestjs` (adapter)

> ✅ **STATUS: IMPLEMENTED (Phases 1–2) on branch `feat/cookie-bff`.** Both
> packages — `@orpc-ws/cookie-bff` (core) and `@orpc-ws/cookie-bff-nestjs`
> (adapter) — are built and reviewed, and `apps/demo-cookie-bff` has been
> rewired onto them (the demo's hand-written auth is gone). **Phase 3 (the
> consumer `anki-mcp-saas` migration, §K′) remains PENDING** and is out of
> scope of this build. This document stays the design record: it has been
> reconciled to the SHIPPED API where the implementation deliberately diverged
> from the pre-implementation sketch (see the "As built" notes in §D, the
> `setClearCookies` / `spaRedirectUri` / `Fetcher` / `PkceStore` /
> `IdTokenClaims` / session-sliding / CSRF reconciliations below, and the §K′
> config-sketch fix). Divergence callouts are tagged **AS BUILT**.

**Supersedes:** [`oidc-bff-design.md`](./oidc-bff-design.md) (the browser-bearer
plan). **Source of truth for decisions:** the Decision Ledger (§0) + `CLAUDE.md`
(repo root). **Motivating consumer:** `~/Developer/projects/ankimcp/anki-mcp-saas`
(`apps/api` server-side + `apps/web` client-side).
**Reference implementation to learn from (and to outgrow):**
`apps/demo-cookie-bff` in this repo. **Pattern to mirror:**
`@orpc-ws/server` (framework-agnostic core) + `@orpc-ws/server-nestjs` (thin
NestJS adapter).

---

## 0. Decision Ledger

All 23 decisions are **CLOSED**. This ledger is the authoritative summary; the
sections below expand on the load-bearing ones.

| #  | Decision | Final choice | |
|----|----------|--------------|---|
| 1  | Security model | **No token ever in the browser** — tokens live server-side; browser holds only an opaque `sid`. Driver: app hosts sandboxed/untrusted JS. | ✅ |
| 2  | WS auth mechanism | **Cookie-on-upgrade** — browser auto-sends `sid` cookie on the WS upgrade; verifier looks up the session. Client uses `createOrpcWsClient` with **no `tokenProvider`**. | ✅ |
| 3  | `connectionKey` | **`sub`** (Keycloak subject). | ✅ |
| 4  | Token exchange | **Server-side PKCE** at `/auth/callback`; server swaps the one-time code for **both** access + refresh tokens. | ✅ |
| 5  | OAuth callback location | **Moves to the API** — Keycloak `redirect_uri` becomes `api.ankimcp.ai/auth/callback` (a server endpoint). **DELETE the SPA callback page.** (Keycloak redirect-URI config change.) | ✅ |
| 6  | Session cookie | **`__Host-sid`** — host-only, `Secure`, `httpOnly`, `SameSite=Strict`, `Path=/`. **PERSISTENT** (`Max-Age` = 30d), slid on activity. NOT a browser-session cookie. | ✅ |
| 7  | `SameSite` (session `sid` cookie) | **`Strict`** — viable because web/api/auth are all subdomains of `ankimcp.ai` (same registrable site). Applies to the SESSION cookie only (see Decision #8 for the state cookie). | ✅ |
| 8  | Login-state cookie | **`oauth_state`**, **`SameSite=Lax`** (DECOUPLED from Decision #7 — its own `cookies.stateSameSite` knob, default `lax`), short `Max-Age` (~10 min), httpOnly. **REVISED:** was `Strict`; any cross-site hop in the login redirect chain (off-registrable-domain Keycloak OR a brokered external/social IdP) makes the top-level GET back to `/auth/callback` cross-site-initiated, so a `Strict` cookie is withheld and the browser-binding check 400s. `Lax` is the correct standard default for an OAuth state/callback cookie (sent on top-level GETs, still blocks cross-site unsafe methods). Override to `strict` only for a verified strictly-same-registrable-site topology. | ✅ |
| 9  | CSRF for authed mutating POSTs | **Synchronizer-token CSRF** — token minted at /callback, stored in the session, returned in the /auth/me body, echoed in X-CSRF-Token, validated header-vs-session (constant-time). | ✅ |
| 10 | WS Origin check | **Origin allowlist in the verifier** — same-origin policy does NOT cover WS. | ✅ |
| 11 | Session lifetime | **30 days**, mirroring Keycloak's Remember-Me SSO session exactly (`ssoSessionMaxLifespanRememberMe = ssoSessionIdleTimeoutRememberMe = 2,592,000s`). Idle == max → 30-day rolling window capped at 30 days from login. | ✅ |
| 12 | Lifetime is config, not hardcoded | **`sessionTtlSeconds` / `cookieMaxAge` (default 30d)** — one knob to retune if Keycloak changes. Do NOT mirror the **dev/E2E** realm (10h SSO / 7d RememberMe). | ✅ |
| 13 | Not offline tokens | **SSO Remember-Me session**, scope `"openid profile email"` only. Keycloak stays the AUTHORITY — when its session ends, the next refresh fails terminally → our session ends. | ✅ |
| 14 | **Package shape** | **THREE packages**: `@orpc-ws/cookie-bff` (framework-agnostic core) + `@orpc-ws/cookie-bff-nestjs` (thin adapter) + `@orpc-ws/cookie-bff-client` (framework-free browser client core), mirroring `@orpc-ws/server` + `-nestjs`. (client core added later — reverses §K′ "client glue lives in the consumer", see §C/§K′.) | ✅ |
| 15 | Connection lifetime | **WS connection follows the SESSION, not the access token.** Access-token expiry mid-connection is a **non-event**. Verifier `expiresAt` = session window. `enforceTokenExpiry` **off**. | ✅ |
| 16 | Refresh strategy | **Lazy + event-driven**, single-flighted. Refresh only on-demand if a downstream call needs the user's Keycloak token (rare — API uses `USERS_SERVICE_SECRET`). `enforce-expiry` documented as an **opt-in fallback only**. | ✅ |
| 17 | Revocation kick | **Best-effort** — `deleteByUser(sub)` + `closeUser(sub)` locally. Reconnect race ACCEPTED (no connect-time double-check, no kick-wins). | ✅ |
| 18 | Cross-instance fan-out | **Consumer's job** via their own event bus — library MUST NOT hardcode NATS. Library provides `revokeUser(sub)`. **Net-new API-side `SESSIONS` consumer required** (today only Tunnel consumes `session.invalidated`). | ✅ |
| 19 | Two tabs/devices | **Last-wins** — new connection kicks previous. Free from `singleConnectionPerUser` keyed on `connectionKey=sub` + `onKicked`. | ✅ |
| 20 | `SessionStore` interface location | **In the CORE** (`@orpc-ws/cookie-bff`) — NO separate interface-only micro-package. (Extract-only-if-needed rejected in favour of the core/adapter split; future consumers may be non-NestJS.) | ✅ |
| 21 | Store-unavailable on connect | **Fail closed** — refuse the upgrade, signal client to retry, never hang. | ✅ |
| 22 | Enriched user + tokens at rest | **Enriched user** (DB id, role, email, name, avatar) stored in the session at `/callback` (via `findOrCreateUser`); read back by `/auth/me` and the verifier. **Tokens encrypted at rest** with a consumer-provided key (encryption seam in the core). | ✅ |
| 23 | Code consolidation | Single init file per side — client `lib/auth.ts`, server `cookie-auth.module.ts`; adapters + router imported, not scattered. Library adapter owns the verifier→WS bridge so it can't re-scatter. | ✅ |

---

## A. Why this doc exists, and where cookie-BFF sits

### A.1 Why we abandoned browser-bearer

The predecessor design ([`oidc-bff-design.md`](./oidc-bff-design.md)) kept both
the access **and** refresh token in the browser (`localStorage`), with a
client-side package doing the refresh dance and feeding a `tokenProvider` into
the WS client. That model is now **superseded by a hard requirement**: the
consumer app will later host **sandboxed / untrusted JavaScript** in the same
page. If any token is reachable from JavaScript, that untrusted code can read it.
Therefore **no token — access or refresh — may ever enter the browser** (Decision #1).

That single requirement forces the cookie-BFF model: tokens live **server-side**;
the browser holds only an **opaque session id** in an `httpOnly` cookie it cannot
read; the server does the OIDC dance, the cookie does the WS door-check.

### A.2 The three topologies (and where cookie-BFF sits)

The library supports three auth topologies on the same WS transport. They differ
only in *who holds the token* and *what rides the WS upgrade*:

| Topology | Token lives | WS upgrade carries | `tokenProvider` | Demo |
| --- | --- | --- | --- | --- |
| **Backend-token / JWT-over-WS** | Client (native / mobile / server) | `?token=<access JWT>` | yes (client refreshes) | `demo-backend-token` |
| **Authless** | — | nothing | no | `demo-authless` |
| **Cookie-BFF** ← *this doc* | **Server** (session store) | **`Cookie: sid`** (auto-sent) | **no** | `demo-cookie-bff` |

Cookie-BFF is the only topology where JavaScript never touches a token. It is the
**most secure and the most stateful**: the cost of "no token in the browser" is a
server-side session store ("the drawer") and a server-side OIDC client. These
packages' job is to make that cost a ~config-block + ~40-line adapter, not the
~1,000 lines the demo hand-writes.

### A.3 The goal: a clean abstraction boundary

The app should declare **WHAT** and the library should do **HOW**:

- **App declares (WHAT):** its Keycloak config, its endpoint paths, *where its
  session store lives*, *where revocation events come from*, its cookie/Origin
  policy, its token-encryption key.
- **Library does (HOW):** the OIDC authorization-code+PKCE dance, cookie
  minting/parsing/hardening, the WS door-check verifier, lazy token renewal, the
  kick.

Target footprint in the consumer: a **config block** + a **~40-line `SessionStore`
adapter** + **one wire** for revocation (`session.invalidated → revokeUser(sub)`).
Compare to `apps/demo-cookie-bff`, which hand-writes the controller, the PKCE
exchange, the cookie helpers, the state cookie, and the in-memory store — and
still skips refresh, revocation, CSRF hardening, and a shared store.

---

## B. The model — plain terms, then precise terms

### B.1 Plain terms (the cloakroom metaphor)

- **The tickets** = the user's Keycloak **access + refresh tokens**. Valuable;
  must never leave the building.
- **The drawer** = the server-side **session store**. The tickets go in a drawer.
- **The locker number** = the **`sid`** — a 256-bit random opaque id. It tells the
  server which drawer to open. It is worthless on its own.
- **The locker key** = the **`httpOnly` cookie** carrying the `sid`. The browser
  holds it but cannot read it (JS can't see `httpOnly` cookies); it auto-presents
  it on every request to the origin, including the WS upgrade.
- **The door-check** = the **cookie verifier** on the WS upgrade: read the locker
  number from the cookie, open the drawer, confirm the session is live, attach the
  user, open the door.

JavaScript only ever has the *locker key it can't read*. The *tickets* stay in the
drawer behind the counter.

### B.2 Precise terms — end-to-end flow

```
LOGIN
  browser → GET api.ankimcp.ai/auth/login
  server  → mint state + PKCE verifier (store server-side, e.g. NATS KV oauth_states)
          → Set-Cookie: oauth_state=<state>   (httpOnly, Secure, SameSite=Lax, ~10min — login-CSRF binding)
          → 302 to Keycloak authorize endpoint (code_challenge S256, scope "openid profile email")

CALLBACK  (← NOW ON THE API, not the SPA — Decision #5)
  browser → GET api.ankimcp.ai/auth/callback?code=…&state=…   (cookie oauth_state auto-sent)
  server  → verify state (server-side verifier + constant-time cookie match)
          → exchange code → { accessToken, refreshToken, idToken, expiresIn }  (server-side, PKCE)
          → findOrCreateUser(...) → ENRICHED user (DB id + role + email + name + avatar)
          → mint sid (256-bit random, library-minted)
          → encrypt(accessToken, refreshToken, idToken) with consumer key
          → sessionStore.set(sid, { user, enc, accessTokenExpiresAt, sessionExpiresAt }, { ttlSeconds })
          → Set-Cookie: __Host-sid=<sid>   (httpOnly, Secure, SameSite=Strict, Path=/, Max-Age = 30d)
          → clear oauth_state cookie
          → 302 back to the SPA (web.ankimcp.ai)   ← auth code NEVER touches JavaScript

WS UPGRADE
  browser → wss://api.ankimcp.ai/ws        (cookie __Host-sid auto-sent; NO ?token=)
  server  → verifier reads ctx.req.headers.cookie → sid → sessionStore.get(sid)
          → check Origin allowlist (cross-site WS hijack defense)
          → fail closed if store unreachable; reject if missing/expired (4001)
          → { ok, user: <enriched>, connectionKey: sub, expiresAt: SESSION window (up to 30d) }
          → door opens

MID-CONNECTION
  access token expires (prod ~1h / dev ~5m)  →  NON-EVENT. Pipe is not policed by
                                     the access token. expiresAt is the SESSION window.
  downstream call needs user's token  →  library refreshes LAZILY (single-flight)
                                          using the stored refresh token, updates drawer,
                                          slides the SSO idle window.

KICK (revocation / tier downgrade)
  app event session.invalidated arrives on EACH api instance →
    consumer's NET-NEW SESSIONS consumer calls revokeUser(sub):
      sessionStore.deleteByUser(sub)   (future connects/refreshes fail)
      OrpcWsService.closeUser(sub)     (drop the live socket on THIS instance)
  cross-instance fan-out = consumer's event bus (NATS), NOT the library. BEST-EFFORT.
```

---

## C. Package shape — core + adapter (Decision #14)

Three packages, mirroring `@orpc-ws/server` + `@orpc-ws/server-nestjs`. The core is
framework-free; the NestJS adapter is thin and is the **only** package that may
import `@nestjs/*`. Future `-fastify` / `-express` adapters would wire the **same
core**. The third package, `@orpc-ws/cookie-bff-client`, is the framework-free
**browser** client core owning the SPA-side `/auth/*` protocol glue — a browser
core sibling of the server-side cookie-BFF pieces.

### C.1 What lives where

| Symbol / concern | `@orpc-ws/cookie-bff` (CORE) | `@orpc-ws/cookie-bff-nestjs` (ADAPTER) |
| --- | --- | --- |
| `SessionStore<TUser>` interface + `SessionData<TUser>` (Decision #20) | ✅ owns | re-exports |
| Cookie verifier (a `VerifyClient` from `@orpc-ws/server`) | ✅ `createCookieVerifyClient(...)` | re-exports |
| Server-side PKCE / OIDC code exchange | ✅ | — |
| Lazy single-flight refresh logic | ✅ | — |
| `revokeUser(sub)` core impl (delete + close hook) | ✅ as a function over a `closeUser` callback | wires it to `OrpcWsService.closeUser` |
| sid minting + cookie-attribute construction (`__Host-`, Strict, Max-Age) | ✅ | — |
| CSRF helpers (synchronizer-token), `oauth_state` helpers | ✅ | — |
| Token-encryption seam (AES-256-GCM, key-id prefix) | ✅ | — |
| Framework-agnostic `/auth/*` **handlers** (login/callback/me/logout returning "set this cookie / redirect here" instructions) | ✅ | maps instructions → Nest `@Res()` |
| `CookieBffModule.forRootAsync` + DI + `@Controller`s | — | ✅ owns |
| `CookieBffService` (composes `OrpcWsService`) | — | ✅ owns |

The core's `/auth/*` handlers are **transport-agnostic**: each returns an
instruction object (e.g. `{ setCookies: CookieSpec[], setClearCookies: CookieSpec[], redirect?: string, body?: unknown, status: number }` — **AS BUILT** the field is `setClearCookies: CookieSpec[]` of pre-serialized clearing cookies, see §D.4)
that an adapter translates to its HTTP framework. That is the seam that lets a
future Fastify/Express adapter reuse 100% of the auth logic.

The SPA-side client glue (`me` / `mutate` / the in-memory synchronizer-CSRF
token / `loginUrl` / `logout`) lives in a THIRD package,
`@orpc-ws/cookie-bff-client` (browser core). Navigation / `window.location` is
NOT in the library — it stays in the consumer app.

### C.2 Where they sit in the monorepo

```
packages/
  orpc-ws-cookie-bff/             ← CORE (framework-free)
    src/
      index.ts                    ← public surface
      session-store.ts            ← SessionStore + SessionData (Decision #20)
      verifier/cookie-verify.ts   ← createCookieVerifyClient (a VerifyClient)
      oidc/code-exchange.ts       ← server-side PKCE exchange
      oidc/refresh.ts             ← lazy single-flight refresh
      cookies/                    ← __Host- attrs, oauth_state, CSRF synchronizer-token
      crypto/token-cipher.ts      ← AES-256-GCM at-rest, key-id prefix
      handlers/                   ← login/callback/me/logout (instruction-returning)
      revoke.ts                   ← revokeUser(store, closeUser, sub)
    package.json  tsconfig.build.json  tshy …
  orpc-ws-cookie-bff-nestjs/      ← ADAPTER (thin)
    src/
      index.ts
      cookie-bff.module.ts        ← forRoot / forRootAsync
      cookie-bff.service.ts       ← composes OrpcWsService; revokeUser
      auth.controller.ts          ← maps core handler instructions → @Res()
    package.json  tsconfig.build.json  tshy …
  orpc-ws-cookie-bff-client/      ← BROWSER CLIENT CORE (framework-free)
    src/
      index.ts
      auth-client.ts              ← createCookieBffAuthClient (me/mutate/loginUrl/logout)
    package.json  tsconfig.build.json  tshy …
```

Both join the existing `packages/*` workspace glob.

### C.3 Dependencies & build

**`@orpc-ws/cookie-bff` (CORE):**

- **Runtime deps:** `@orpc-ws/server` (`workspace:*`) for `VerifyClient` /
  `VerifyClientContext` / `VerifyClientResult`; `@orpc-ws/shared` (`workspace:*`)
  for the `Logger` seam. The core owns its own server-side PKCE code-exchange
  primitive (`oidc/`); it does not depend on any browser auth package.
- **Crypto:** Node `crypto` (`randomBytes` for the sid; AES-256-GCM for token
  at-rest). No third-party crypto dep.
- **NO `@nestjs/*`, NO express.** Framework-free, like `@orpc-ws/server`.

**`@orpc-ws/cookie-bff-nestjs` (ADAPTER):**

- **Runtime deps:** `@orpc-ws/cookie-bff` (`workspace:*`), `@orpc-ws/server-nestjs`
  (`workspace:*`) for `OrpcWsModule` / `OrpcWsService`, `@orpc-ws/shared`
  (`workspace:*`).
- **Peer deps:** `@nestjs/common >=10`, `@nestjs/core >=10`, `reflect-metadata >=0.2`
  (mirror `@orpc-ws/server-nestjs`'s peer ranges exactly). The `/auth/*`
  controller needs an HTTP layer — express is the assumed adapter (the demo uses
  `@Req`/`@Res` express types).

**Build (BOTH):** `tshy`, dual CJS+ESM, mirroring
`packages/orpc-ws-server*/package.json` verbatim:

```jsonc
"type": "module",
"tshy": {
  "exports": { ".": "./src/index.ts" },
  "project": "./tsconfig.build.json",
  "exclude": ["src/**/*.test.ts", "src/**/__tests__/**"]
},
"exports": {
  ".": {
    "import":  { "types": "./dist/esm/index.d.ts",      "default": "./dist/esm/index.js" },
    "require": { "types": "./dist/commonjs/index.d.ts", "default": "./dist/commonjs/index.js" }
  }
},
"main": "./dist/commonjs/index.js",
"types": "./dist/commonjs/index.d.ts",
"module": "./dist/esm/index.js"
```

### C.4 Versioning — the `.changeset` fixed group

`.changeset/config.json` has a single `fixed` group. **AS BUILT** all THREE
cookie-bff packages are now appended, so the group lists **11** `@orpc-ws/*`
packages (was 8) — `@orpc-ws/cookie-bff`, `@orpc-ws/cookie-bff-nestjs`, and
`@orpc-ws/cookie-bff-client` version in lockstep with `@orpc-ws/server` /
`-nestjs` (which they depend on). Publishing bumps the whole library to the
next minor.

---

## D. Public API (concrete TS signatures)

> Types mirror what `@orpc-ws/server` already exports (`VerifyClient`,
> `VerifyClientContext`, `VerifyClientResult`).

### D.1 CORE — `SessionStore` interface (seam 1, Decision #20)

```ts
// from @orpc-ws/cookie-bff
export interface SessionStore<TUser> {
  /** Persist by key. The library MINTS the sid; the store only stores. */
  set(sid: string, data: SessionData<TUser>, opts: { ttlSeconds: number }): Promise<void>;
  /**
   * OPTIONAL expiry-only re-stamp (express-session `Store.touch` precedent).
   * Updates ONLY `sessionExpiresAt` (+ native TTL); no-op on an absent sid.
   * Exists so the window slide cannot clobber a concurrent lazy refresh's
   * rotated tokens (see the AS-BUILT slide note in §E.1). Implementation-
   * defined atomicity — a single-field update on Redis/SQL/NATS-KV.
   */
  touch?(sid: string, sessionExpiresAt: number, opts: { ttlSeconds: number }): Promise<void>;
  get(sid: string): Promise<SessionData<TUser> | null>;
  delete(sid: string): Promise<void>;
  /** Revocation primitive — drop EVERY session for a subject. */
  deleteByUser(sub: string): Promise<void>;
}
```

### D.2 CORE — `SessionData` shape (the enriched user lives here)

```ts
// from @orpc-ws/cookie-bff
export interface SessionData<TUser> {
  sub: string;                          // Keycloak subject — connectionKey + deleteByUser key
  user: TUser;                          // ENRICHED app user (DB id, role, email, name, avatar)
  enc: {                                // tokens encrypted at rest — NEVER plaintext in the store
    accessToken: string;                // ciphertext
    refreshToken: string | null;        // ciphertext or null
    idToken: string | null;             // kept for RP-initiated logout id_token_hint
  };
  accessTokenExpiresAt: number;         // epoch ms — informs lazy refresh, NOT the WS lifetime
  sessionExpiresAt: number;             // epoch ms — the SESSION sliding window (this is verifier.expiresAt)
  createdAt: number;
}
```

### D.3 CORE — the cookie verifier

Returns `expiresAt = sessionExpiresAt` (the **session window**, not the
access-token exp), fails closed on store outage, and checks the Origin allowlist.

```ts
// from @orpc-ws/cookie-bff
export function createCookieVerifyClient<TUser>(
  store: SessionStore<TUser>,
  opts: { cookieName: string; originAllowlist: string[] },
): VerifyClient<TUser>;

// behavior sketch:
async (ctx) => {
  if (!originAllowed(ctx.origin, opts.originAllowlist))
    return { ok: false, code: 4001, reason: "Origin not allowed" };

  const sid = parseCookie(ctx.req.headers.cookie, opts.cookieName);
  if (!sid) return { ok: false, code: 4001, reason: "No session cookie" };

  let session: SessionData<TUser> | null;
  try {
    session = await store.get(sid);
  } catch {
    return { ok: false, code: 4001, reason: "Session store unavailable" }; // FAIL CLOSED — client retries
  }
  if (!session) return { ok: false, code: 4001, reason: "Unknown session" };
  if (session.sessionExpiresAt <= Date.now())
    return { ok: false, code: 4001, reason: "Session expired" };

  return {
    ok: true,
    user: session.user,                  // ENRICHED — DB id + role available WS-side
    connectionKey: session.sub,          // last-wins single-connection-per-user
    expiresAt: session.sessionExpiresAt, // ← SESSION window, NOT access-token exp
  };
}
```

> **Close codes.** The library has **no `WS_CLOSE_CODES` enum** — the codes are
> numeric configurable fields on `ConnectionConfig` (`authFailedCloseCode`
> default **4001**, `sessionReplacedCloseCode` default **4005**,
> `shutdownCloseCode` default **4009**). The verifier reject path uses
> `authFailedCloseCode` (4001). There is **no public `cookieAuthProvider`
> export** — the client simply omits `tokenProvider`.

> **AS BUILT — the verifier slides the session window on a successful upgrade.**
> Before returning `ok: true`, the success path re-stamps
> `sessionExpiresAt = now + ttl` and re-`set`s the store (best-effort, see the
> session-sliding note in §E.1/§L), gated on `slideSessionOnActivity` (default
> `true`). The WS upgrade is one of the **two** library-owned authed touch points
> that roll the 30-day window (the other is `/auth/me`). A slide-write failure is
> logged and the upgrade STILL succeeds — the slide never fails the door-check.
> The verifier `opts` accordingly carry `slideSessionOnActivity?`,
> `sessionTtlSeconds?`, `clock?`, `logger?` beyond the `cookieName` /
> `originAllowlist` shown in the sketch above, plus an optional
> `authFailedCloseCode?` (default 4001).

### D.4 CORE — framework-agnostic `/auth/*` handlers

Transport-agnostic: each returns an instruction object an adapter applies.

```ts
// from @orpc-ws/cookie-bff — AS BUILT
export interface CookieSpec {
  value: string;               // a ready-to-emit `Set-Cookie` header value
}

export interface AuthInstruction {
  status: number;
  redirect?: string;
  setCookies?: CookieSpec[];      // each a pre-serialized Set-Cookie (sid; no CSRF cookie — synchronizer-token lives in the session + /me body)
  setClearCookies?: CookieSpec[]; // each a pre-serialized CLEARING Set-Cookie
  body?: unknown;
}

export interface CookieBffCore {
  login(req: AuthRequest): Promise<AuthInstruction>;    // mint state+PKCE, Set-Cookie oauth_state, 302 → Keycloak
  callback(req: AuthRequest): Promise<AuthInstruction>; // verify state, exchange code, resolveUser, set __Host-sid (mint+store CSRF token in session), 302 → SPA
  me(req: AuthRequest): Promise<AuthInstruction>;       // read sid → { user, csrfToken } body (or 401); slide window
  logout(req: AuthRequest): Promise<AuthInstruction>;   // CSRF-checked (X-CSRF-Token vs session-stored token); delete session, clear cookie, RP-initiated logout
}

export function createCookieBffCore<TUser>(opts: CookieBffOptions<TUser>): CookieBffCore;
```

> **AS BUILT — clear-cookies are pre-serialized (`setClearCookies: CookieSpec[]`,
> NOT `clearCookies: string[]`).** The pre-implementation sketch had the
> instruction carry bare cookie *names* (`clearCookies: string[]`) and left the
> adapter to build the clearing `Set-Cookie`. We reversed that: the **core owns
> all cookie serialization** (set *and* clear), so each `setClearCookies` entry
> is already a full `Set-Cookie` value with the right `Max-Age=0` /
> `__Host-`/Secure/SameSite attributes. The adapter stays a **dumb translator** —
> it `res.append("Set-Cookie", c.value)` for every entry in both arrays and never
> reasons about cookie attributes. (The adapter applies `setCookies` and
> `setClearCookies` identically; the two arrays exist only to keep the core's
> intent legible, e.g. callback returns the sid + csrf in `setCookies` and the
> single-use `oauth_state` clear in `setClearCookies` on the same response.)

> **AS BUILT — the synchronizer-token CSRF token is minted by the CORE at
> `/auth/callback` and stored in the session.** The callback handler mints a
> fresh CSRF token (`mintCsrfToken`, see §J) and persists it on the session
> (`SessionData.csrfToken`); `GET /auth/me` returns it in the response **body**
> (`{ user, csrfToken }`), where the SPA holds it in JS memory and echoes it back
> in the `X-CSRF-Token` header. `POST /auth/logout` validates that header against
> the session-stored token (constant-time, header-vs-session) before mutating.
> **No CSRF cookie is set** — the token never rides a `Set-Cookie`. This still
> closes the CSRF loop **inside the core**: the SPA learns the token only from
> `/auth/me`'s body (a core handler), never wiring CSRF itself, and logout's
> check can only pass against the session value the core minted.

> **AS BUILT — `CookieBffCore` is not generic; `createCookieBffCore<TUser>` is.**
> The returned `CookieBffCore` carries no `TUser` (the handlers traffic only in
> `AuthRequest`/`AuthInstruction`); `TUser` lives on the factory and its
> `CookieBffOptions<TUser>` (`resolveUser`, `sessionStore`). The options type is
> the `CookieBffOptions<TUser>` of §D.7, not a separate `CookieBffCoreOptions`.

### D.5 CORE — `revokeUser`

```ts
// from @orpc-ws/cookie-bff
export async function revokeUser<TUser>(
  store: SessionStore<TUser>,
  closeUser: (connectionKey: string, code?: number, reason?: string) => void,
  sub: string,
  logger: Logger = noopLogger,                          // optional; kick-failure log sink
): Promise<void> {
  try {
    await store.deleteByUser(sub);                      // future connects/refreshes fail
  } finally {
    try {
      closeUser(sub, 4001, "session invalidated");      // drop live pipe (this instance)
    } catch (err) {
      // never mask a deleteByUser rejection with a kick failure
      logger.warn("[cookie-bff] revocation kick (closeUser) failed", ...);
    }
  }
}
```

`OrpcWsService.closeUser(connectionKey, code?, reason?)` already exists in
`@orpc-ws/server-nestjs`. There is **no `broadcast` method** on `OrpcWsService` —
`revokeUser` uses `closeUser`. `revokeUser` is **local only**; cross-instance
fan-out is the consumer's job (Decision #18, §G).

> **AS BUILT — the kick is guaranteed even when the store delete rejects.**
> The `finally` above is load-bearing: a store outage must not leave a
> just-revoked user's live authenticated socket up (the kick is the more
> urgent of the two actions). Delete stays FIRST (kick-first would let the
> kicked client reconnect against a still-populated store). A delete failure
> still **rejects after the kick** — "best-effort" (Decision #17) describes
> the local kick, not a swallowed store outage: the consumer's revocation
> event handler needs the rejection to retry/redeliver, or the sessions
> silently survive until their TTL. The as-built kick inside the `finally` is
> additionally wrapped in its own try/catch (with an optional injected
> `Logger`, noop default, as a 4th parameter): a throw escaping a `finally`
> would MASK the delete rejection (JS semantics), so a throwing
> consumer-supplied `closeUser` is logged instead of propagated (the
> library's own core `closeUser` never throws).

### D.6 ADAPTER — Nest module wiring (`CookieBffModule.forRootAsync`)

The module composes with `OrpcWsModule`: it owns the `/auth/*` controller, the
session store, the code-exchange client, and it *produces* the cookie
`VerifyClient` handed to `OrpcWsModule`. Recommended shape:
`CookieBffModule` imports & configures `OrpcWsModule` internally; the consumer
wires one module; `enforceTokenExpiry` stays **off** by default (§F).

> **LIBRARY-SIDE CONSTRAINT (Decision #23 — the verifier→WS bridge is the
> adapter's job, not the app's).** The adapter **MUST** wire the cookie verifier
> into `OrpcWsModule` **internally** — `CookieBffModule` configures
> `OrpcWsModule` itself and hands it the `createCookieVerifyClient(...)` result.
> It must **NOT** merely export the verifier for the app to bind. If it did, the
> consumer would re-create a separate `websocket/verify-client.ts` (and re-import
> `OrpcWsModule` by hand) to bind it — exactly the scattering Decision #23
> forbids. Owning the verifier→WS bridge is therefore a **requirement on the
> adapter**: the app configures cookie-bff **once** and never touches the WS
> verifier wiring. (The low-magic escape hatch below is the explicit opt-out for
> advanced consumers who accept owning that wiring themselves.)

```ts
@Module({
  imports: [
    CookieBffModule.forRootAsync<EnrichedUser>({
      inject: [SESSION_STORE, APP_CONFIG],
      useFactory: (store: SessionStore<EnrichedUser>, cfg: AppConfig) => ({
        router: appRouter,                          // forwarded to OrpcWsModule
        keycloak: {
          issuerUrl: cfg.keycloak.issuerUrl,        // public iss (token-bound)
          discoveryUrl: cfg.keycloak.internalUrl,   // internal JWKS/discovery
          clientId: cfg.keycloak.clientId,
          clientSecret: cfg.keycloak.clientSecret,  // optional (confidential client)
          redirectUri: cfg.keycloak.redirectUri,    // api.ankimcp.ai/auth/callback — trusted, NOT Host-derived
          scope: "openid profile email",            // NOT offline_access (Decision #13)
        },
        endpoints: { basePath: "/auth", ws: "/ws" },
        cookies: {
          sessionCookieName: "__Host-sid",
          sameSite: "strict",                       // Decision #7 — same-site topology
          secure: true,
          hostPrefix: true,                          // enforce __Host- invariants
          cookieMaxAge: 60 * 60 * 24 * 30,           // 30d persistent (Decision #6/#12)
        },
        originAllowlist: cfg.spaOrigins,             // WS Origin check (Decision #10)
        sessionStore: store,                         // ← seam 1
        encryptionKey: cfg.sessionEncKey,            // 32-byte key (§E.3)
        sessionTtlSeconds: 60 * 60 * 24 * 30,        // 30d window, slid on activity (Decision #11/#12)
        refresh: { strategy: "lazy" },               // §F (default)
        hooks: {                                      // WS connection-lifecycle hooks, forwarded to OrpcWsModule (F1a)
          onKicked: ({ user }) => metrics.sessionReplaced(user.id),
        },
        resolveUser: (claims, tokens) =>             // = findOrCreateUser → ENRICHED user
          usersClient.findOrCreateUser(claims),
      }),
    }),
  ],
})
export class AppAuthModule {}
```

A lower-magic escape hatch — `createCookieBffCore(...)` + `createCookieVerifyClient(...)`
factories from the core, leaving the consumer to wire `OrpcWsModule` themselves —
stays exported for advanced use.

> **AS BUILT — `CookieBffModuleOptions<TUser>` adds `hooks?: AuthenticatedHooks<TUser>`.**
> Alongside `router` and the WS passthroughs (`connection` / `heartbeat` /
> `interceptors` / `rootInterceptors` / `logger`), the adapter options accept
> optional WS connection-lifecycle hooks
> (`onConnected` / `onDisconnected` / `onKicked` / `onZombieTerminated`),
> forwarded verbatim to the internal `OrpcWsModule` (F1a). The core's
> `authEvents` (the `/auth/*`-flow metrics hooks of §D.7) flows through
> automatically — it is part of the resolved `CookieBffOptions` the adapter
> passes straight to `createCookieBffCore`.

> **AS BUILT — `endpoints.basePath` / `endpoints.ws` are inert no-ops in this
> adapter.** The `/auth/*` controller is mounted under a **FIXED**
> `@Controller("auth")` prefix: Nest reads the controller prefix from decorator
> metadata at class-eval time, *before* any DI/config runs, so it cannot be
> driven from the resolved options. The WS path likewise comes from the WS
> server's `connection.path`, not `endpoints.ws`. The `endpoints` field is kept
> only to match the core option shape; a consumer wanting a different auth base
> uses Nest's `setGlobalPrefix(...)` (or mounts the controller under a prefixed
> module), and sets the WS path via `connection: { path: "..." }`. This is a
> documented limitation of the NestJS arm — a future Fastify/Express adapter
> over the same core could honor `basePath` at route-registration time.

> **AS BUILT — install `CookieBffModule` exactly once (app root).** It owns the
> single `@Global` WS transport via its internal `OrpcWsModule`. Importing it
> twice — or importing `OrpcWsModule` separately *alongside* it — attaches two
> WS servers to the same path (a last-wins / double-listen footgun). This is the
> same implicit single-install constraint `OrpcWsModule` already carries; the
> adapter deliberately adds **no** runtime guard (it would false-positive across
> tests / legitimate teardown-and-recreate).

> **AS BUILT — no HTTP upload transport.** Cookie-BFF does **not** wire ORPC's
> opt-in HTTP upload route. The upload transport authenticates with the same
> Bearer token the WS would carry — which cookie-BFF, by construction, does not
> have (the browser holds only the `sid` cookie, never a token). The adapter
> never sets `uploads` on the internal `OrpcWsModule`, and the rewired
> `demo-cookie-bff` dropped its former `uploadImage` procedure accordingly.
> Adding uploads later (e.g. a presigned-URL strategy that doesn't need a Bearer
> token) would be purely additive.

### D.7 ADAPTER / CORE — the config object

```ts
// from @orpc-ws/cookie-bff — AS BUILT (the CORE option shape).
// NOTE: `router` is NOT on the core options — it lives on the ADAPTER's
// `CookieBffModuleOptions<TUser>` (= this shape + router + WS passthroughs),
// because only the adapter forwards a router to OrpcWsModule.
export interface CookieBffOptions<TUser> {
  keycloak: {
    issuerUrl: string;                              // public issuer (matches token iss)
    discoveryUrl?: string;                          // internal discovery/JWKS base (defaults to issuerUrl)
    clientId: string;
    clientSecret?: string;                          // present ⇒ confidential client
    redirectUri: string;                            // api.ankimcp.ai/auth/callback — trusted absolute URI
    scope?: string;                                 // default "openid profile email"
    authorizeParams?: Record<string, string>;       // extra authorize params (prompt/login_hint/…); CANNOT clobber the 7 security params (§F3)
    postLogoutRedirectUri?: string;                 // defaults to spaRedirectUri (AS BUILT)
  };

  endpoints?: { basePath?: string; ws?: string };   // FORWARDED-CONFIG placeholder; NO-OP in the Nest adapter (§D.6)

  cookies?: {
    sessionCookieName?: string;                     // default "__Host-sid"
    sameSite?: "lax" | "strict";                    // SESSION cookie; default "strict" (Decision #7)
    stateSameSite?: "lax" | "strict";               // oauth_state cookie; default "lax" (Decision #8, revised) — DECOUPLED from `sameSite`
    secure?: boolean;                               // default true
    hostPrefix?: boolean;                           // default true; enforces __Host- rules
    cookieMaxAge?: number;                          // seconds; default = sessionTtlSeconds (default 30d)
  };

  originAllowlist: string[];                         // exact Origins allowed on WS upgrade (Decision #10)

  encryptionKey: CipherKeyInput;                     // 32 bytes / base64 — at-rest token encryption (§E.3)
  previousEncryptionKeys?: Record<string, CipherKeyInput>;  // retired keys (by id) for rotation grace (§E.3)
  encryptionKeyId?: string;                          // stable id embedded in new ciphertext

  sessionTtlSeconds?: number;                        // default 60*60*24*30 (30d) — slid on activity (Decision #11/#12)
  slideSessionOnActivity?: boolean;                  // AS BUILT — default TRUE; re-stamp window on each authed touch (§L)

  sessionStore: SessionStore<TUser>;                // ← seam 1 (§E.1)
  pkceStore?: PkceStore;                            // AS BUILT — state→verifier seam; default InMemoryPkceStore (§E.4)

  refresh?: RefreshPolicy;                          // §F; default { strategy: "lazy" }

  authEvents?: AuthEvents<TUser>;                    // fire-and-forget auth-flow metrics hooks (onLoginStart/onCallbackSuccess/onCallbackFailure/onLogout); best-effort, never break the flow

  resolveUser: (claims: IdTokenClaims, tokens: OidcTokenSet, rawClaims: Record<string, unknown>)
    => Promise<TUser>;                              // findOrCreateUser hook; rawClaims = full id_token payload (read any claim); returns ENRICHED user (Decision #22)

  spaRedirectUri: string;                            // AS BUILT — REQUIRED. Where /callback 302s after setting the cookie;
                                                     //   also the default postLogoutRedirectUri.

  fetcher?: Fetcher;                                 // AS BUILT — injectable HTTP seam (discovery/token); default global fetch
  clock?: Clock;                                     // injected clock seam (no raw Date.now)
  logger?: Logger;                                   // injected logger seam; default noop
}

export type RefreshPolicy =
  | { strategy: "lazy" }                            // default: refresh only on-demand (Decision #16)
  | { strategy: "enforce-expiry" };                 // opt-in fallback only (§F.3)
```

> **AS BUILT — `spaRedirectUri` is a required top-level option.** The
> pre-implementation sketch had no explicit "where does `/callback` send the
> browser?" field. The shipped core makes `spaRedirectUri` **required**: it is
> the SPA origin the `/auth/callback` handler 302s back to once the `__Host-sid`
> cookie is set, and `keycloak.postLogoutRedirectUri` **defaults to it** when not
> given.

> **AS BUILT — `Fetcher` is an injectable HTTP seam.** Discovery + token-endpoint
> calls go through a minimal `Fetcher` (the `fetch` subset this package uses:
> `(input, init?) => Promise<{ ok, status, statusText, text(), json() }>`),
> **defaulting to the global `fetch`**. Injected so a consumer can add a
> timeout/proxy and tests can drive discovery/exchange with a fake — no real
> network in unit tests.

> **AS BUILT — `clock` / `logger` are injected seams**, defaulting to
> `systemClock` / `noopLogger` from `@orpc-ws/shared` (consistent with the rest
> of the library: no raw `Date.now()`, no `console.log` in core code). The
> `logger` surfaces the best-effort slide-write warning (§L).

> **AS BUILT — `authEvents` (fire-and-forget auth-flow hooks) + `keycloak.authorizeParams`.**
> `authEvents?` carries optional `onLoginStart` / `onCallbackSuccess(user)` /
> `onCallbackFailure(reason)` / `onLogout(sub)` metrics hooks the `/auth/*`
> handlers call on each path. Every call is wrapped in try/catch and a throw is
> logged via the injected `Logger` — a consumer hook NEVER breaks the auth flow
> (same defensive contract as the session-slide). `keycloak.authorizeParams`
> merges extra query params (`prompt`, `login_hint`, `max_age`, …) into the
> authorize URL; they are applied FIRST and the 7 security-critical params
> (`response_type`, `client_id`, `redirect_uri`, `scope`, `state`,
> `code_challenge`, `code_challenge_method`) are set AFTER and always win, so a
> consumer CANNOT clobber the PKCE / state / redirect / scope params (§F3).

> `resolveUser` runs at `/callback` (server-side), receives the verified id-token
> claims + the token set, and returns the app's **enriched** user (DB id, role,
> …). Whatever it returns is stored and is what the verifier attaches and
> `/auth/me` reads back — resolving the "role/id aren't in the id_token" problem
> (Decision #22). **Lifetime is a single config value** (`sessionTtlSeconds` /
> `cookieMaxAge`, default 30d) — retuning Keycloak is one knob (Decision #12).

> **AS BUILT — `IdTokenClaims` is a FIXED WHITELIST, no index signature /
> passthrough.** The claims handed to `resolveUser` are exactly:
> `sub`, `email`, `emailVerified`, `name`, `givenName`, `familyName`,
> `preferredUsername`, `picture`. The decoder copies only these out of the
> (untrusted) id_token payload and **deliberately does not spread the raw JSON
> in** — an IdP (or a tampered token) could otherwise inject arbitrary keys that
> `resolveUser` or a downstream logger mistakes for vetted claims. The typed
> whitelist is still the SAFE set, but a consumer needing another claim is no
> longer forced to edit the library: `resolveUser` now ALSO receives the full
> decoded raw id_token payload as a third `rawClaims` arg (F2), and the exported
> `decodeIdToken(idToken)` helper returns `{ claims, raw }` — so a TRUSTED
> consumer can read ANY claim (e.g. `groups`, `realm_access`) WITHOUT a library
> release by picking it off `rawClaims` inside `resolveUser`. The security
> guarantee is unchanged: the library stores ONLY what `resolveUser` returns; it
> never auto-spreads `rawClaims` into the session. The explicit-allowlist-over-
> open-map spirit still governs the TYPED set.

---

## E. The two seams (+ the encryption seam)

### E.1 Seam 1 — `SessionStore` (lives in the CORE)

The core **mints the sid** (256-bit `randomBytes(32).toString("hex")`); the store
only persists by key. Requirements the adapter must honor:

- **TTL** = the **30-day session window** (`sessionTtlSeconds`), **slid** on each
  authed touch / refresh. Backends with native TTL (NATS KV, Redis) set it on
  write; SQL backends store an `expires_at` column and sweep.
- **`deleteByUser(sub)`** is the revocation primitive. Opaque `sid → data` stores
  (KV) need a **companion `sub → [sid]` index** (a second KV key holding the sid
  list per subject); SQL stores just `DELETE WHERE sub = ?`.

Consumer adapter is **~40 lines**. **The store backend is the consumer's choice
via the seam.** For *this* app the owner will **start with DB and reconsider
(e.g. NATS KV) later**. The architectural tension to flag (the library is
agnostic — it just needs a `SessionStore` impl):

- **Users-service Postgres** respects "Users owns the data," gives transactional
  `deleteByUser`, and survives NATS restarts — BUT `apps/api` is the **stateless
  gateway with no DB**, so it would call a new Users-service internal ORPC
  endpoint per upgrade, adding **a hop on every WS upgrade** and breaking the
  no-DB invariant.
- **NATS KV** (a `sessions` bucket beside the existing `oauth_states` bucket
  `apps/api` already uses) keeps the store inside the gateway's reach (no new
  endpoints, no extra hop), has native per-key TTL, is multi-replica shared, and
  fits the "operational KV owned by the producer" rule — BUT makes `apps/api`
  hold operational session state.

Leave the choice to the consumer; the library does not care.

> **AS BUILT — how "slid on each authed touch" (Decisions #6/#11) is realized.**
> The 30-day window is a ROLLING window, slid on each authed touch — but the
> sketch never said *which* touches. The shipped library slides on the two touch
> points it actually owns and that fire regularly: the **WS-upgrade verifier**
> (§D.3) and **`GET /auth/me`** (§D.4). Each re-stamps
> `sessionExpiresAt = now + sessionTtlSeconds` and re-`set`s the store, gated on
> `slideSessionOnActivity` (default `true`). The lazy `RefreshManager` also
> slides when a refresh actually runs, but refresh is "often never" invoked in
> this app (§F), so without the verifier/`/me` slide the window would effectively
> be **fixed from login** — which is the bug a review pass caught and fixed (the
> MAJOR finding). The slide is **best-effort**: a store-write failure is logged
> via the injected `Logger` and the upgrade / `/me` still succeeds (it awaits the
> write so behavior is deterministic and testable, but never throws to the
> caller).
>
> **AS BUILT — the slide write prefers `store.touch` (expiry-only), NOT a full
> `set`.** The slide can run concurrently with the lazy refresh
> (`RefreshManager`, its own get→modify→set) for the same sid; a slide
> implemented as a full `set` from the caller's stale snapshot could land after
> the refresh's write and roll back the freshly-rotated `enc` +
> `accessTokenExpiresAt` — under refresh-token rotation the rolled-back refresh
> token is dead → the next refresh fails terminal → premature self-logout. So
> `SessionStore` gained the OPTIONAL `touch(sid, sessionExpiresAt, {ttlSeconds})`
> (§D.1, express-session `Store.touch` precedent): an expiry-only re-stamp that
> cannot clobber any other field, a no-op on an absent sid. When a store does
> not implement `touch`, the slide falls back to a **fresh `get` immediately
> before a merged `set`** — that narrows the race window (from "since the
> caller's read" to the get→set gap) and refuses to resurrect a
> deleted/revoked session, but **cannot eliminate** the race; store adapters
> wanting full safety implement `touch` (a one-field update on Redis/SQL/KV).
>
> **KNOWN BOUND (accepted):** a single socket that stays continuously
> connected, never reconnects, and never lazily-refreshes has no touch point
> after its initial upgrade, so it still hard-caps at `ttl` from that last
> touch — a forever-open idle socket is not an observable touch. This matches the
> design's framing of the window.

### E.2 Seam 2 — the revocation wire

The consumer calls `revokeUser(sub)` from **its own event handler** when its
revocation event arrives **on each instance**. The library must **not** hardcode
NATS. For this app the trigger is the `session.invalidated` JetStream event
(stream `SESSIONS`, subject `session.invalidated`), Users-owned. See §G for the
multi-instance shape and the net-new-consumer reality.

### E.3 The token-encryption seam (in the CORE)

The core **encrypts the access + refresh (+ id) tokens at rest** with a
consumer-provided `encryptionKey` (32-byte AES-256-GCM key) before handing them
to `SessionStore.set`, and decrypts on read (Decision #22). A compromised store
(leaked KV dump, stolen DB) must not leak usable Keycloak tokens. The `sid`
itself stays plaintext (it's the lookup key and is already opaque). Key rotation:
a key-id prefix on the ciphertext so a rotated key can still decrypt old sessions
during a grace window.

> **AS BUILT — key rotation is a self-describing `v1:<keyId>:…` envelope.** The
> at-rest cipher prefixes each ciphertext with a version + key-id, so on decrypt
> the library knows which key to use. New sessions always encrypt with the
> primary `encryptionKey` (id = `encryptionKeyId`); `previousEncryptionKeys`
> (a `Record<keyId, CipherKeyInput>`) holds retired keys that **only decrypt**
> older sessions during the rotation grace window. `CipherKeyInput` accepts raw
> 32 bytes or a base64 string.

### E.4 Seam 3 — `PkceStore` (the pending-login state → verifier seam)

> **AS BUILT — a new injectable seam the sketch was silent on.** The login flow
> must stash each login's PKCE `code_verifier` keyed by its `state` so `/callback`
> can complete the exchange. The demo kept this in a **module-level `Map`**, which
> is wrong for the library on two counts: (1) **multi-instance** — a login that
> lands on instance A and a callback that load-balances to instance B would find
> no verifier and fail; (2) **testability** — a module-level singleton can't be
> substituted in a unit test. So the shipped library makes it an **injectable
> seam**, mirroring `SessionStore` (Decision #20's "store is the consumer's
> choice"):
>
> ```ts
> export interface PkceStore {
>   set(state: string, codeVerifier: string, opts: { ttlSeconds: number }): Promise<void>;
>   /** Atomic read-AND-delete. Single-use: a replayed callback finds nothing. */
>   take(state: string): Promise<string | null>;
> }
> ```
>
> `take` is an **atomic read-delete** so a replayed `/callback` is rejected. The
> default `InMemoryPkceStore` (single-instance only; sweeps expired entries on
> each `set`/`take` via the injected `Clock`) ships as the `pkceStore` default; a
> multi-instance consumer supplies a ~15-line shared-store adapter (NATS KV /
> Redis), exactly as it does for `SessionStore`. The TTL only has to survive the
> round-trip to the IdP.

---

## F. Refresh strategy — lazy + event-driven (Decision #15/#16)

### F.1 The load-bearing reframe: the pipe follows the SESSION, not the access token

The access token expiring mid-connection is a **non-event**. We deliberately do
**not** tie the WS pipe to the access-token `exp` (prod 3600s/1h, dev 300s/5m).
The verifier returns `expiresAt = sessionExpiresAt` (the session's sliding window,
up to 30 days), so `enforceTokenExpiry` is **off** and never closes a live socket
on access-token expiry.

**Why this is correct for *this* app:** `apps/api` calls its downstream services
(Users service) with a **service secret** (`USERS_SERVICE_SECRET`), **not** the
user's Keycloak access token. So after the WS upgrade, the user's access token is
**rarely (often never) needed**. Policing the pipe on a token nothing downstream
consumes would cause pointless reconnect churn at scale.

### F.2 Lazy + event-driven (the default)

- **Keep the session alive** on the 30-day sliding window (idle == max == 30d,
  mirroring Keycloak — Decision #11).
- **Refresh the access token LAZILY** — only on-demand, if/when a downstream call
  actually needs the user's Keycloak token. The core owns the
  refresh-via-stored-refresh-token logic and **single-flights** it (concurrent
  callers for the same `sid` share one in-flight refresh). `revokeRefreshToken=false`
  in the realm (no strict rotation), so each refresh **slides the SSO idle
  window**. The demo's `refreshTokens()` exists but cookie-bff never calls it —
  this package wires it.
- **Revocation is detected via EVENTS** (§G), not by polling Keycloak. No
  introspection heartbeat.

**Keycloak stays the AUTHORITY (Decision #13):** the app's refresh token is
SSO-scoped (not offline), so when Keycloak's session truly ends, the next refresh
**FAILS terminally** → our session ends. We cannot outlive or undercut Keycloak.

> **AS BUILT — single-flight is per PROCESS, not per deployment.** The
> single-flight lives in `oidc/refresh.ts` (`RefreshManager`) as a per-`sid`
> in-flight promise map — an in-memory structure, not a distributed lock. Two
> app instances behind a load balancer can therefore refresh the **same
> session concurrently**, and with refresh-token **rotation** enabled at the
> IdP the losing instance's write can persist an **already-invalidated**
> refresh token → the next refresh fails terminal → premature silent logout.
> (This is refresh-vs-refresh **across instances** — a different race from
> the slide-vs-refresh clobber that `SessionStore.touch` closes in §E.1.)
> This is **deliberately NOT fixed** in the core: cross-instance coordination
> is the consumer's job, the same category as the revocation fan-out
> transport in §G. For this app's realm it is moot anyway
> (`revokeRefreshToken=false`, no rotation — see F.2). A consumer that runs
> multi-instance **with** rotation must wrap refresh in its own distributed
> lock keyed by `sid` (or turn rotation off); if a consumer ever needs it,
> the natural library evolution is an **optional injectable lock seam**
> around `RefreshManager.refresh` — purely additive, no public-API break.

### F.3 Documented fallback (NOT chosen) — `enforce-expiry`

For completeness only: an app that **does** need to forward the user's access
token downstream **continuously** can opt into
`refresh: { strategy: "enforce-expiry" }`, which turns on the library's
`enforceTokenExpiry` watchdog + relies on client **auto-reconnect**. On reconnect
the browser re-sends the still-valid `sid` cookie → the verifier returns a fresh
window. This is **opt-in, not the default**, and is the wrong choice for this app.

---

## G. Revocation — best-effort kick (Decision #17/#18)

A **kick** is two local actions, run on every instance that receives the event:

1. `sessionStore.deleteByUser(sub)` — future connects **and** future lazy
   refreshes fail (the drawer is empty).
2. `OrpcWsService.closeUser(sub)` — drop the **live** socket on the **local**
   instance.

`revokeUser(sub)` (§D.5) does both locally. **Cross-instance fan-out is the
consumer's job** — every instance subscribes to the app's revocation event and
calls `revokeUser(sub)` locally. The library **must not** hardcode NATS.

**EXPLICITLY DECIDED: the kick is BEST-EFFORT.** There is a rare race where a
just-revoked user reconnecting at the same instant could linger on an open pipe.
The owner **accepts this** — **no** connect-time double-check, **no** "kick-wins"
race handling. Rationale: this is not a bank, signup is free, and the real
trigger is a subscription **tier downgrade** (handled by the existing subscription
flow), not a security ban — so an immediate hard kick is not required.

**Net-new API-side consumer required (confirmed in code).** The `session.invalidated`
event is published by the Users service (`apps/users/.../internal.router.ts`) and
**today consumed only by the Tunnel service** (`apps/tunnel/src/nats/nats-consumer.service.ts`
+ `handlers/user-event-handlers.ts`). The **API/dashboard side has NO consumer.**
The migration must add a **net-new API-side `SESSIONS` consumer** that maps the
event to `sub` (= `keycloakId`) and calls `revokeUser(sub)` on every instance.
The library's `connectionKey` / `deleteByUser` key is `sub` (the Keycloak
subject), which lines up with `keycloakId` — good — but the new consumer is
**not a one-liner on existing plumbing.**

---

## H. Decided behaviors

| Behavior | Decision | Source |
| --- | --- | --- |
| Two tabs / two devices | **Last-wins** — new connection kicks the previous (4005). Stays current behavior. | `singleConnectionPerUser` (default `true`) keyed on `connectionKey=sub` + `onKicked` — **free** from `@orpc-ws/server`. Decision #19. |
| Session store unreachable on connect | **Fail closed** — refuse the upgrade (4001), signal client to retry. Never hang. | Verifier `catch` → `{ ok:false, code:4001 }` (§D.3). Decision #21. |
| User object (role + DB id) | **Enriched user stored in the session** at `/callback` via `resolveUser` (= `findOrCreateUser`). Verifier + `/auth/me` read it back. No data lost. | §D.2, §D.7. Decision #22. |
| Tokens at rest | **Encrypted** (AES-256-GCM) with consumer key. | §E.3. Decision #22. |
| Kick | **Best-effort** — `deleteByUser` + `closeUser` + consumer broadcast. Accepted reconnect race; no kick-wins handling. | §G. Decision #17/#18. |
| Access token expiry mid-connection | **Non-event** — pipe follows the session window; `enforceTokenExpiry` off. | §F. Decision #15. |

---

## I. Gaps `demo-cookie-bff` leaves open that THESE packages must close

The demo is a teaching reference; confirmed gaps (all verified in the demo source):

1. **No refresh over a long-lived WS.** Demo has **no `/auth/refresh`**, never
   calls `store.update()`, and an expired access token just forces re-login. The
   core owns **lazy single-flight refresh** (§F).
2. **In-memory store only.** Demo's `SessionStore` is a `Map` ("DEMO ONLY" —
   lost on restart, not shared across replicas). The core defines the
   **persistent/shared store seam** (§E.1) and the consumer ships a DB / NATS-KV
   adapter.
3. **Weak cookie/CSRF hardening.** Demo sets `SameSite=Lax`, `httpOnly`, but **no
   `Secure`, no `__Host-` prefix** (it runs over http), no `Strict`, and no CSRF
   on the authed `POST /auth/logout`. These packages own the **`__Host-` + Secure
   + `SameSite=Strict` + Origin allowlist + synchronizer-token CSRF** hardening (§J).
4. **No force-revocation.** Demo's only session end is `/auth/logout` or natural
   expiry — no event-driven revocation, no `deleteByUser`. The core owns
   **`revokeUser` / `deleteByUser`** (§G).
5. **Single-instance only.** Demo has no multi-instance story. `revokeUser` + the
   consumer's event broadcast give the **multi-instance kick** (§G).
6. **Browser-side callback.** Demo (and today's `anki-mcp-saas`) routes the OAuth
   callback through a SPA page. These packages move it to a **server endpoint on
   the API** (Decision #5); the auth code never flows through JavaScript.
7. *(minor)* Demo derives the callback redirect URI from the `Host` header
   (DEMO-ONLY). These packages take a **trusted `redirectUri` from config**.

---

## J. Cookie & CSRF hardening (the core owns it)

- **`sid` cookie (Decision #6/#7):** `__Host-sid`, `httpOnly`, `Secure`,
  **`SameSite=Strict`**, `Path=/`, no `Domain` (host-only), **persistent**
  `Max-Age = cookieMaxAge` (default 30d), **re-stamped (slid)** on activity. NOT
  a browser-session cookie — the demo's session cookie would log users out on
  browser close; explicitly avoid that.
- **Why `Strict` is viable:** web.ankimcp.ai (SPA), api.ankimcp.ai (auth + WS),
  and auth.ankimcp.ai (Keycloak) are all subdomains of `ankimcp.ai` → **same
  registrable site**. The IdP→`/callback` redirect is therefore same-site and
  `Strict` does not withhold the cookie.
- **Login CSRF cookie (Decision #8, REVISED):** `oauth_state`, `httpOnly`,
  `Secure`, **`SameSite=Lax` by default** (its own `cookies.stateSameSite` knob,
  DECOUPLED from the `sid` cookie's `cookies.sameSite`), short `Max-Age`
  (~10 min), constant-time compare — additive to the server-side
  `state → verifier` check (RFC 9700 §4.7 defense-in-depth). **Why Lax, not
  Strict:** this cookie has to ride a **top-level GET** redirect back to
  `/auth/callback`, and ANY cross-site hop in the login redirect chain makes that
  callback cross-site-initiated — not only an off-registrable-domain Keycloak,
  but also Keycloak **brokering an external/social IdP** (Google, GitHub, …),
  where the final redirect originates off-site. A `Strict` cookie is withheld on
  such a navigation → the cookie is absent and the browser-binding check rejects
  with HTTP 400. `Lax` is the correct standard default for an OAuth
  state/callback cookie: sent on top-level GET navigations yet still blocked on
  cross-site unsafe-method requests, so the login-CSRF protection is fully
  preserved. Override to `strict` only for a verified strictly-same-registrable-
  site topology with no external brokering.
- **Authed mutating POSTs (Decision #9)** (e.g. `POST /auth/logout`, any future
  authed POST): a **synchronizer-token CSRF** pattern. **AS BUILT:** a 256-bit
  CSRF token is minted server-side at `GET /auth/callback` and **stored in the
  session** (`SessionData.csrfToken`, plaintext — it is only meaningful paired
  with the session, so it is NOT a secret like the refresh token and is not
  encrypted). `GET /auth/me` returns it in the **response BODY**
  (`{ user, csrfToken }`), **not** as a `Set-Cookie`; the SPA holds it in **JS
  memory** (per-origin isolated). On `POST /auth/logout` the SPA echoes it in the
  `X-CSRF-Token` header; the server looks up the session via the `sid` cookie and
  validates the header against the **session-stored** token in **constant time**
  (`crypto/compare.ts`). Missing or mismatched → `403`. **NO CSRF cookie is
  emitted anywhere.**
  **Why synchronizer-token over double-submit:** in the cross-subdomain topology
  (web / api / auth are subdomains of one registrable site), a readable
  double-submit cookie is either **host-only** (unreadable by the SPA's different
  subdomain → logout 403s) or **`Domain`-scoped to the parent** (readable by
  EVERY sibling subdomain → a compromised sibling, e.g. a sandboxed-JS subdomain,
  could read it and forge the header). The synchronizer token lives only in the
  SPA-origin's JS memory, so **per-origin isolation** prevents a sibling
  subdomain from reading it.
  **Consumer CORS requirement:** the API must allow `credentials` + the
  `X-CSRF-Token` request header (`Access-Control-Allow-Headers`) from the SPA
  origin, else the browser blocks the cross-origin credentialed logout.
- **WS Origin allowlist (Decision #10):** the verifier **must** check `ctx.origin`
  against an allowlist — **cross-site WebSocket hijacking is NOT blocked by
  same-origin policy** (the browser sends cookies on cross-origin WS upgrades).
  An empty/absent Origin fails closed.

> ✅ **RESOLVED (§J / Decision #9 reopened and re-decided: synchronizer-token
> (option b).** The earlier double-submit *cookie* is replaced. The CSRF token is
> minted at /callback, stored in the session, returned in the /auth/me response
> BODY, held in the SPA's JS memory, echoed in X-CSRF-Token, and validated
> header-vs-session (constant-time). Chosen over double-submit (option a, a
> `csrfCookieDomain`-scoped cookie) because a parent-domain-scoped readable cookie
> is readable by every sibling subdomain (weakening subdomain isolation), whereas
> the in-memory token can't be read by a sibling subdomain's JS. NO CSRF cookie is
> emitted. (The `sid` and `oauth_state` cookies are unaffected.)

---

## K. Phased rollout & risks

> **Reminder: this is a PLAN. No implementation is authorized yet.**

**Phase 0 — decisions.** ✅ DONE (Decision Ledger §0 — all 22 closed).

**Phase 1 — the library packages.** Build `@orpc-ws/cookie-bff` (core) +
`@orpc-ws/cookie-bff-nestjs` (adapter): the `SessionStore` interface +
`SessionData`, the cookie verifier (session-window `expiresAt`, fail-closed,
Origin check), server-side PKCE exchange, lazy single-flight refresh,
framework-agnostic `/auth/*` handlers, `revokeUser`, cookie/CSRF hardening
(`__Host-`/Strict/persistent-30d/synchronizer-token CSRF), token-at-rest encryption, then
the Nest module/controller/service wiring. Append **both** packages to the
`.changeset` `fixed` group. **No consumer changes yet.**

**Phase 2 — a production-leaning cookie-BFF demo.** Evolve (or add beside)
`apps/demo-cookie-bff` to exercise what the current demo skips: a persistent store
adapter, lazy refresh, event-driven revocation, `__Host-`/Strict/CSRF/Origin
hardening, server-side callback — plus tests (verifier fail-closed, last-wins
kick, deleteByUser race acceptance, refresh single-flight, Origin rejection).

**Phase 3 — consumer migration (separate effort).** Migrate `anki-mcp-saas`
(§K′). Bigger and riskier than Phases 1–2 because it changes the
**transport-level auth model**, the **`/api/auth/*` response shapes** (tokens stop
being returned to the browser), the **Keycloak redirect-URI config**, and adds a
**net-new API-side `SESSIONS` consumer**.

**Risks:**

- **Per-upgrade store latency / fail-closed storms.** A flaky store makes every
  WS upgrade fail closed → reconnect storms. Mitigate: native-TTL store, tight
  timeouts, client backoff.
- **`deleteByUser` index drift** (KV companion `sub → [sid]` index getting out of
  sync) — a leaked-but-orphaned sid lingering until TTL. Bounded by the 30-day
  window.
- **Encryption-key management** — losing/rotating the key invalidates sessions;
  needs the key-id grace-window scheme (§E.3).
- **Transport change underestimated** — see §K′.
- **Net-new SESSIONS consumer** — new API-side NATS plumbing, not a one-liner (§G).

---

## K′. Consumer migration — `anki-mcp-saas`

### What `apps/api` GAINS

- The `CookieBffModule` (config block) wired into the API.
- A **~40-line `SessionStore` adapter** — owner will **start with DB** (Users-service
  Postgres via a new internal ORPC endpoint) and may move to **NATS KV** (a
  `sessions` bucket beside the existing `oauth_states`) later (§E.1 — consumer's
  call; library agnostic).
- A `resolveUser` hook that calls the existing `usersClient.findOrCreateUser(...)`
  (already returns the enriched `User` with DB `id`, `role`, `email`, `name`,
  `avatar`).
- **One wire**: a **net-new API-side `SESSIONS` consumer** for `session.invalidated`
  → `revokeUser(sub)` (does NOT exist today — §G).
- The server-side PKCE + `oauth_states` KV logic in `auth.service.ts` is largely
  **replaced** by the core's code-exchange path.
- **A Keycloak config change:** `redirect_uri` moves from
  `web.ankimcp.ai/auth/callback` to `api.ankimcp.ai/auth/callback` (Decision #5).

### What `apps/web` LOSES entirely

Deleted (browser holds no token; auth state comes from `GET /auth/me`):

| File (`apps/web/src/lib/`) | Why it dies |
| --- | --- |
| `auth.ts` | `authStorage` facade + `refreshAccessToken` — no tokens in JS. |
| `secure-storage.ts` | `localStorage` token read/write — gone. |
| `jwt-utils.ts` | client-side JWT decode — nothing to decode. |
| `auth-events.ts` | auth-state pub/sub — replaced by `/auth/me`. |
| `auth-failure.ts` | `handleAuthFailure` (clear+redirect) — co-deleted/rewritten. |
| **the SPA `/auth/callback` page** | callback moves to the API (Decision #5). |
| `websocket/index.ts` `tokenProvider` | the WS client connects with **no `tokenProvider`** — the `httpOnly` `sid` cookie rides the upgrade automatically. |

The WS client becomes simply:

```ts
export const wsClient = createOrpcWsClient<typeof appContract>({ url: getWsUrl() });
// no tokenProvider; auth state via /auth/me
```

### Before / after of the auth surface

| | Before (today) | After (cookie-BFF) |
| --- | --- | --- |
| Token location | browser `localStorage` (access+refresh+id) | server session store only (encrypted) |
| OAuth callback | SPA page → POSTs code to `/api/auth/callback` | **server endpoint** `api.ankimcp.ai/auth/callback`; 302 to SPA |
| `/api/auth/callback` returns | **tokens + user** to browser | **only sets `__Host-sid` cookie**, 302; no tokens in body |
| `/api/auth/refresh` | browser calls it with refresh token | **removed** (server refreshes lazily) |
| WS auth | `?token=<access JWT>`, verified offline against JWKS | `Cookie: __Host-sid`, verified by session lookup |
| WS identity | Keycloak claims only (no DB id at WS layer) | **enriched user** (DB id + role) from session |
| Session lifetime | tied to token lifetimes | **30-day window mirroring Keycloak Remember-Me** |
| Revocation (dashboard) | token expiry + kick-on-newer-connection only | event-driven `revokeUser` (net-new consumer) + last-wins kick |

### Why this is a BIGGER change than the superseded browser-bearer plan

The browser-bearer plan was **client-side only** (a `tokenProvider`-shaped
package). Cookie-BFF is **server-side**: it touches `apps/api` (new module, store
adapter, net-new `SESSIONS` consumer), **changes the `/api/auth/*` response
shapes** (tokens stop being returned), **moves the OAuth callback + Keycloak
redirect-URI**, and **changes the WS transport auth** from a stateless `?token=`
JWT verified offline to a stateful cookie→session lookup. Scope it as a transport
+ API + IdP-config change, not a "delete client storage files" change.

### Code organization — consolidated wiring (Decision #23)

**The principle.** Today's auth is **scattered** across many small files — on the
client: `secure-storage.ts`, `jwt-utils.ts`, `auth-events.ts`, `useAuth.ts`, the
SPA `/auth/callback` page; on the server: a separate `websocket/verify-client.ts`
that binds the token verifier to the WS layer by hand. This migration
**naturally de-scatters** because most of those files are **deleted** — their
logic moves into the library (§K′ "What `apps/web` LOSES entirely"). Decision #23
is the rule that **keeps it that way**: after the migration there is **ONE client
file + ONE server module**; the `SessionStore` adapter, the `SESSIONS` consumer,
and the ORPC router are **imported** into those single entry points, never
re-inlined or re-scattered back across the app.

**Client — one file (`apps/web/src/lib/auth.ts`).** The WS client (no
`tokenProvider`), the ORPC client, and thin **navigation-policy** wrappers all
live here; the security-sensitive protocol glue is delegated to
`@orpc-ws/cookie-bff-client`. Everything else reads auth state via `me()`:

```ts
import { createOrpcWsClient } from "@orpc-ws/client";
import { createCookieBffAuthClient } from "@orpc-ws/cookie-bff-client";
import { getWsUrl, getApiBaseUrl } from "./config";

// WS transport — separate concern, no tokenProvider (cookie authenticates the handshake).
export const wsClient   = createOrpcWsClient<AppContract>({ url: getWsUrl() });
export const orpcClient = wsClient.rpc;

// Protocol glue (typed /auth/me, in-memory synchronizer-CSRF token, CSRF-aware mutate)
// now lives in the library — the app keeps ONLY navigation policy.
const authClient = createCookieBffAuthClient<User>({
  serverOrigin: getApiBaseUrl(),
  loginPath: "/api/auth/login",
  logoutPath: "/api/auth/logout",
  mePath: "/api/auth/me",
});
export const auth = {
  me:     () => authClient.me(),
  login:  () => { window.location.href = authClient.loginUrl(); },
  logout: async () => {
    const { endSessionUrl } = await authClient.logout();
    window.location.href = endSessionUrl ?? "/";
  },
};
```

This **reverses** the original "client glue lives in the consumer" stance of this
section: the protocol glue (typed `/auth/me`, the in-memory synchronizer-CSRF
token, the CSRF-aware `mutate`) is now the library's `@orpc-ws/cookie-bff-client`,
so the consumer doesn't reimplement the security-sensitive CSRF/cookie protocol.
The client takes **explicit** endpoint paths (`loginPath` / `logoutPath` / `mePath`,
shown here under `/api/auth/*`) — there is no hidden `/auth` convention, which
decouples the client from the server's path layout.
Only navigation (`window.location`) stays app-side. The WS client line above
(`createOrpcWsClient` with no `tokenProvider`) is unchanged — it is a separate
concern from the `/auth/*` glue.

**Server — one module (`apps/api/src/auth/cookie-auth.module.ts`).** A single
module configures cookie-bff once; the `SessionStore` impl and the `SESSIONS`
consumer live in **their own files** but are **imported and wired here**, not
spread across `AppModule`:

```ts
@Module({
  imports: [
    CookieBffModule.forRootAsync({
      inject: [UsersClientService],
      useFactory: (users) => ({
        router:        appRouter,                      // forwarded to OrpcWsModule (adapter option)
        keycloak:      { issuerUrl, clientId, redirectUri: ".../api/auth/callback" },
        originAllowlist: cfg.spaOrigins,               // WS Origin check (Decision #10)
        sessionStore:  dbSessionStore,                 // imported adapter
        resolveUser:   (claims) => users.findOrCreateUser(claims),
        spaRedirectUri: cfg.spaOrigin,                 // AS BUILT — required (where /callback 302s)
        // CANONICAL §D.7 `cookies` shape (NOT the stale `cookie: { maxAgeSeconds }`):
        cookies:       { sameSite: "strict", cookieMaxAge: 2_592_000 /* + sessionCookieName?/secure?/hostPrefix? */ },
        encryptionKey: process.env.SESSION_ENC_KEY,
      }),
    }),
  ],
  providers: [SessionInvalidatedConsumer],             // imported SESSIONS consumer
})
export class CookieAuthModule {}
```

`AppModule` then just does `imports: [CookieAuthModule]` — nothing else auth-shaped
leaks into it. The adapters (the `SessionStore` impl) and the net-new `SESSIONS`
consumer (§G) stay in their **own** files, but they are imported/wired **inside
this one module**, never inline-scattered.

**This depends on the library holding up its end.** The consolidation only stays
consolidated because the `@orpc-ws/cookie-bff-nestjs` adapter wires the cookie
verifier into `OrpcWsModule` **internally** (§D.6). If the adapter only exposed
the verifier for the app to bind itself, the consumer would be forced to re-create
a separate `websocket/verify-client.ts` (and re-import `OrpcWsModule` by hand) to
bind it — re-scattering the wiring this rule exists to prevent. So owning the
verifier→WS bridge is a **requirement on the adapter**, and the app just configures
cookie-bff once here.

---

## L. Lifetime authority — the 30-day number

- **Source:** `anki-mcp-infrastructure/argocd/apps/keycloak/realm-ankimcp.json:31-32`
  — `ssoSessionMaxLifespanRememberMe = ssoSessionIdleTimeoutRememberMe =
  2,592,000s = 30 DAYS`. Idle == max → a 30-day rolling window capped at 30 days
  from login.
- **It is NOT offline tokens.** Scope is `"openid profile email"` only. The long
  session is Keycloak's **Remember-Me SSO session**, forced for ALL logins (incl.
  social) via a custom `remember-me-authenticator` SPI.
- **Mirror exactly, no regression:** `__Host-sid` `Max-Age` = 30d; drawer TTL =
  30d idle (slid on each refresh). Both are the **`sessionTtlSeconds` /
  `cookieMaxAge` config value (default 30d)** so retuning Keycloak is one knob.
- **Do NOT mirror dev/E2E** (10h SSO / 7d RememberMe) — that would regress to
  weekly logout.
- **Caveat:** the repo realm JSON is declarative; confirm against the live
  Keycloak admin if 100% certainty is needed.

---

## M. As built — key decisions → shipped files (branch `feat/cookie-bff`)

Where the load-bearing decisions actually live, for a reader navigating the code.

### CORE — `packages/orpc-ws-cookie-bff/src/`

| Concern (Decision) | File |
| --- | --- |
| Public surface | `index.ts` |
| Composition root — builds collaborators, applies defaults, returns the 4 handlers (§D.4/D.6) | `composition/cookie-bff-core.ts` |
| Config shape `CookieBffOptions<TUser>` (§D.7) | `composition/options.ts` |
| `SessionStore<TUser>` + `SessionData` seam (Decision #20) | `session-store.ts` |
| Cookie WS verifier — Origin allowlist, fail-closed, slide (Decision #2/#10/#21) | `verifier/cookie-verify.ts` |
| Session-window sliding, best-effort (Decision #6/#11, the review's MAJOR fix; §E.1/§L) | `session-slide.ts` |
| `/auth/*` handlers — transport-agnostic `AuthInstruction` (§D.4) | `handlers/login.ts`, `handlers/callback.ts`, `handlers/me.ts`, `handlers/logout.ts` |
| Instruction I/O — `AuthInstruction` (`setClearCookies`), `CookieSpec`, `AuthRequest` | `handlers/instruction.ts` |
| Server-side PKCE code-exchange + discovery + lazy single-flight refresh (Decision #4/#16) | `oidc/code-exchange.ts`, `oidc/discovery.ts` (`Fetcher`), `oidc/refresh.ts` |
| `PkceStore` seam + in-memory default (§E.4) | `oidc/pkce-store.ts` |
| `IdTokenClaims` fixed whitelist + decoder (§D.7 AS BUILT) | `oidc/claims.ts` |
| At-rest token cipher (AES-256-GCM, `v1:<keyId>:…` envelope, rotation) (§E.3) | `crypto/token-cipher.ts`, `crypto/sid.ts`, `crypto/compare.ts` |
| Hardened cookie serialize/parse/clear, `oauth_state`, synchronizer-token CSRF (§J) | `cookies/serialize.ts`, `cookies/oauth-state.ts`, `cookies/csrf.ts` |
| `revokeUser(store, closeUser, sub)` best-effort kick (Decision #17/#18, §G) | `revoke.ts` |

### ADAPTER — `packages/orpc-ws-cookie-bff-nestjs/src/`

| Concern (Decision) | File |
| --- | --- |
| `CookieBffModule.forRoot/forRootAsync` — the verifier→WS bridge over `OrpcWsModule` (Decision #23, §D.6); install-once | `cookie-bff.module.ts` |
| `CookieBffModuleOptions<TUser>` = core options + `router` + WS passthroughs; `endpoints` no-op | `cookie-bff.options.ts` |
| `/auth/*` controller — pure `AuthInstruction` → express `@Res` translator; fixed `@Controller("auth")` | `auth.controller.ts` |
| `CookieBffService` — `revokeUser(sub)` / `closeUser(...)` / `getCore()` | `cookie-bff.service.ts` |

### CLIENT CORE — `packages/orpc-ws-cookie-bff-client/src/`

| Concern | File |
| --- | --- |
| Public surface | `index.ts` |
| `createCookieBffAuthClient` — `me()` / CSRF-aware `mutate()` / in-memory synchronizer-CSRF token / `loginUrl()` / navigation-free `logout()` (reverses §K′ "client glue in the consumer") | `auth-client.ts` |

### DEMO — `apps/demo-cookie-bff/`

The demo now **consumes the library** instead of hand-writing ~1000 lines of
auth. Its footprint is exactly what §A.3 targets: one config block + a ~40-line
store adapter + one revocation wire.

| Concern | File |
| --- | --- |
| One config block — `CookieBffModule.forRootAsync<DemoUser>(...)` (localhost-relaxed cookies) | `server/src/auth/cookie-auth.module.ts` |
| ~40-line `SessionStore` adapter (in-memory + companion `sub→[sid]` index) | `server/src/auth/session-store.ts` |
| Revocation wire → `CookieBffService.revokeUser` | `server/src/auth/dev-revoke.controller.ts` |

The demo client's `lib/auth.ts` now consumes `@orpc-ws/cookie-bff-client` and is
navigation-only (it keeps just the `window.location` wrappers; the protocol glue
moved into the library — §K′).

No HTTP upload transport (the former `uploadImage` procedure was dropped — §D.6
AS BUILT).
